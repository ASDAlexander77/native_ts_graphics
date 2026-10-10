// The Xbox ATG VideoTexturePC12 sample's MediaEnginePlayer for TypeScript (video_texture links it;
// see CMakeLists.txt): Media Foundation's Media Engine playing a video file on a D3D11 device of its
// own (on the app's GPU), its frames transferred into a texture shared with the app's device
// (Donut_CreateSharedTexture) as the sample does, or into memory for APIs that can't share
// textures with D3D11 here (Vulkan). Windows only. Functions of no Donut object, so donut.ts doesn't
// wrap them and other examples don't link them.
//
// mfplat.dll is delay-loaded: Windows N editions lack it without the Media Feature Pack, and then
// Donut_CreateVideoPlayer says so instead of the example not starting.

#include <windows.h>
#include <d3d11_1.h>
#include <dxgi1_4.h>
#include <mfapi.h>
#include <mfmediaengine.h>
#include <wrl/client.h>

#include <atomic>
#include <chrono>
#include <cstdio>
#include <filesystem>
#include <string>
#include <thread>
#include <vector>

#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "dxgi.lib")
#pragma comment(lib, "mfplat.lib")
#pragma comment(lib, "mfuuid.lib")

using Microsoft::WRL::ComPtr;

namespace
{
    // The sample's MediaEngineNotify: Media Engine events to the player.
    class VideoPlayer;

    class MediaEngineNotify : public IMFMediaEngineNotify
    {
        long m_cRef = 1;
        VideoPlayer* m_pCB = nullptr;

    public:
        STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override
        {
            if (__uuidof(IMFMediaEngineNotify) == riid)
            {
                *ppv = static_cast<IMFMediaEngineNotify*>(this);
            }
            else
            {
                *ppv = nullptr;
                return E_NOINTERFACE;
            }
            AddRef();
            return S_OK;
        }

        STDMETHODIMP_(ULONG) AddRef() override
        {
            return InterlockedIncrement(&m_cRef);
        }

        STDMETHODIMP_(ULONG) Release() override
        {
            LONG cRef = InterlockedDecrement(&m_cRef);
            if (cRef == 0)
            {
                delete this;
            }
            return cRef;
        }

        void SetCallback(VideoPlayer* pCB)
        {
            m_pCB = pCB;
        }

        STDMETHODIMP EventNotify(DWORD meEvent, DWORD_PTR param1, DWORD) override;
    };

    class VideoPlayer
    {
    public:
        ComPtr<ID3D11Device1> device;
        ComPtr<ID3D11DeviceContext> context;
        ComPtr<IMFMediaEngine> mediaEngine;
        ComPtr<MediaEngineNotify> notify;
        MFARGB bkgColor = {};
        std::atomic<bool> isPlaying{ false };
        std::atomic<bool> isInfoReady{ false };
        std::atomic<bool> isFinished{ false };
        std::atomic<bool> hasError{ false };
        BSTR source = nullptr;
        DWORD width = 0;
        DWORD height = 0;
        // Frames into memory: a render target the Media Engine draws into, a staging copy, the bytes.
        ComPtr<ID3D11Texture2D> frameTexture;
        ComPtr<ID3D11Texture2D> stagingTexture;
        std::vector<uint8_t> frameData;
        int frameRowPitch = 0;

        ~VideoPlayer()
        {
            if (mediaEngine)
                mediaEngine->Shutdown();
            mediaEngine.Reset();
            if (notify)
                notify->SetCallback(nullptr);
            if (source)
                CoTaskMemFree(source);
        }

        void Play()
        {
            if (isPlaying)
                return;
            if (mediaEngine && SUCCEEDED(mediaEngine->Play()))
            {
                isPlaying = true;
                isFinished = false;
            }
        }

        // The sample's OnMediaEngineEvent.
        void OnMediaEngineEvent(uint32_t meEvent)
        {
            switch (meEvent)
            {
            case MF_MEDIA_ENGINE_EVENT_LOADEDMETADATA:
                isInfoReady = true;
                break;
            case MF_MEDIA_ENGINE_EVENT_CANPLAY:
                // Here we auto-play when ready...
                Play();
                break;
            case MF_MEDIA_ENGINE_EVENT_ENDED:
                isFinished = true;
                break;
            case MF_MEDIA_ENGINE_EVENT_ERROR:
                hasError = true;
                if (mediaEngine)
                {
                    ComPtr<IMFMediaError> error;
                    if (SUCCEEDED(mediaEngine->GetError(&error)))
                    {
                        fprintf(stderr, "ERROR: Media Foundation Event Error %u (%08X)\n", unsigned(error->GetErrorCode()),
                            static_cast<unsigned int>(error->GetExtendedErrorCode()));
                    }
                }
                break;
            default:
                break;
            }
        }
    };

    STDMETHODIMP MediaEngineNotify::EventNotify(DWORD meEvent, DWORD_PTR param1, DWORD)
    {
        if (meEvent == MF_MEDIA_ENGINE_EVENT_NOTIFYSTABLESTATE)
        {
            SetEvent(reinterpret_cast<HANDLE>(param1));
        }
        else if (m_pCB)
        {
            m_pCB->OnMediaEngineEvent(meEvent);
        }
        return S_OK;
    }

    std::filesystem::path ExecutableDirectory()
    {
        wchar_t path[MAX_PATH] = {};
        GetModuleFileNameW(nullptr, path, MAX_PATH);
        return std::filesystem::path(path).parent_path();
    }

    bool g_MediaFoundationStarted = false;
}

extern "C"
{
    // The sample's MediaEnginePlayer::Initialize and SetSource: a player of the video file at path
    // (relative to the executable's directory) on a D3D11 device of the adapter whose LUID is
    // (luidLow, luidHigh) (Donut_GetAdapterLuid; any adapter if both 0), decoding to BGRA8, muted if
    // asked; it waits for the video's metadata (its size), and starts playing when it can. Null
    // (after printing why) on failure.
    VideoPlayer* Donut_CreateVideoPlayer(const char* path, int luidLow, int luidHigh, int muted)
    {
        // mfplat.dll is delay-loaded (Windows N editions lack it without the Media Feature Pack).
        if (!LoadLibraryExW(L"mfplat.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32))
        {
            fprintf(stderr, "Media Foundation isn't available (on Windows N editions, install the Media Feature Pack)\n");
            return nullptr;
        }
        const HRESULT coHr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
        (void)coHr; // S_FALSE or RPC_E_CHANGED_MODE: COM is initialized on this thread already
        if (!g_MediaFoundationStarted)
        {
            if (FAILED(MFStartup(MF_VERSION)))
            {
                fprintf(stderr, "Donut_CreateVideoPlayer: MFStartup failed\n");
                return nullptr;
            }
            g_MediaFoundationStarted = true;
        }

        auto player = new VideoPlayer;

        // Create our own device to avoid threading issues
        ComPtr<IDXGIFactory1> dxgiFactory;
        ComPtr<IDXGIAdapter1> adapter;
        if (SUCCEEDED(CreateDXGIFactory1(IID_PPV_ARGS(&dxgiFactory))) && (luidLow != 0 || luidHigh != 0))
        {
            for (UINT adapterIndex = 0; dxgiFactory->EnumAdapters1(adapterIndex, adapter.ReleaseAndGetAddressOf()) != DXGI_ERROR_NOT_FOUND;
                ++adapterIndex)
            {
                DXGI_ADAPTER_DESC1 desc;
                if (SUCCEEDED(adapter->GetDesc1(&desc)) && desc.AdapterLuid.LowPart == DWORD(luidLow)
                    && desc.AdapterLuid.HighPart == LONG(luidHigh))
                {
                    // Found the same adapter as our device
                    break;
                }
            }
        }

        ComPtr<ID3D11Device> baseDevice;
        ComPtr<ID3D10Multithread> multithreaded;
        ComPtr<IMFDXGIDeviceManager> dxgiManager;
        UINT resetToken = 0;
        if (FAILED(D3D11CreateDevice(adapter.Get(), adapter ? D3D_DRIVER_TYPE_UNKNOWN : D3D_DRIVER_TYPE_HARDWARE, nullptr,
                D3D11_CREATE_DEVICE_VIDEO_SUPPORT | D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0, D3D11_SDK_VERSION,
                baseDevice.GetAddressOf(), nullptr, player->context.GetAddressOf()))
            || FAILED(baseDevice.As(&multithreaded))
            || FAILED(baseDevice.As(&player->device))
            || FAILED(MFCreateDXGIDeviceManager(&resetToken, dxgiManager.GetAddressOf()))
            || FAILED(dxgiManager->ResetDevice(player->device.Get(), resetToken)))
        {
            fprintf(stderr, "Donut_CreateVideoPlayer: cannot create the video's D3D11 device\n");
            delete player;
            return nullptr;
        }
        multithreaded->SetMultithreadProtected(TRUE);

        // Setup Media Engine: our event callback object, the configuration attributes.
        player->notify.Attach(new MediaEngineNotify());
        player->notify->SetCallback(player);
        ComPtr<IMFAttributes> attributes;
        ComPtr<IMFMediaEngineClassFactory> mfFactory;
        if (FAILED(MFCreateAttributes(attributes.GetAddressOf(), 1))
            || FAILED(attributes->SetUnknown(MF_MEDIA_ENGINE_DXGI_MANAGER, dxgiManager.Get()))
            || FAILED(attributes->SetUnknown(MF_MEDIA_ENGINE_CALLBACK, player->notify.Get()))
            || FAILED(attributes->SetUINT32(MF_MEDIA_ENGINE_VIDEO_OUTPUT_FORMAT, DXGI_FORMAT_B8G8R8A8_UNORM))
            || FAILED(CoCreateInstance(CLSID_MFMediaEngineClassFactory, nullptr, CLSCTX_ALL, IID_PPV_ARGS(mfFactory.GetAddressOf())))
            || FAILED(mfFactory->CreateInstance(0, attributes.Get(), player->mediaEngine.ReleaseAndGetAddressOf())))
        {
            fprintf(stderr, "Donut_CreateVideoPlayer: cannot create the Media Engine\n");
            delete player;
            return nullptr;
        }
        player->mediaEngine->SetMuted(muted != 0);

        const std::wstring sourceUri = (ExecutableDirectory() / std::filesystem::u8path(path)).wstring();
        const size_t cchAllocationSize = 1 + sourceUri.size();
        player->source = reinterpret_cast<BSTR>(CoTaskMemAlloc(sizeof(wchar_t) * cchAllocationSize));
        wcscpy_s(player->source, cchAllocationSize, sourceUri.c_str());
        if (FAILED(player->mediaEngine->SetSource(player->source)))
        {
            fprintf(stderr, "Donut_CreateVideoPlayer: cannot open %s\n", path);
            delete player;
            return nullptr;
        }

        // The sample waits for the video's size before making its texture.
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(10);
        while (!player->isInfoReady && !player->hasError && std::chrono::steady_clock::now() < deadline)
        {
            SwitchToThread();
        }
        if (!player->isInfoReady || FAILED(player->mediaEngine->GetNativeVideoSize(&player->width, &player->height)))
        {
            fprintf(stderr, "Donut_CreateVideoPlayer: cannot read %s\n", path);
            delete player;
            return nullptr;
        }
        return player;
    }

    int Donut_GetVideoWidth(VideoPlayer* videoPlayer)
    {
        return static_cast<int>(videoPlayer->width);
    }

    int Donut_GetVideoHeight(VideoPlayer* videoPlayer)
    {
        return static_cast<int>(videoPlayer->height);
    }

    // Non-zero once the video has played to its end.
    int Donut_IsVideoFinished(VideoPlayer* videoPlayer)
    {
        return videoPlayer->isFinished ? 1 : 0;
    }

    // The sample's TransferFrame: the video's current frame, if there is a new one, into a texture
    // shared with this device through an NT handle (Donut_GetSharedTextureHandle), the whole video
    // into its top-left corner. Returns 1 if it drew one.
    int Donut_TransferVideoFrame(VideoPlayer* videoPlayer, void* sharedHandle)
    {
        auto* player = videoPlayer;
        if (!player->mediaEngine || !player->isPlaying)
            return 0;
        LONGLONG pts;
        if (player->mediaEngine->OnVideoStreamTick(&pts) != S_OK)
            return 0;
        ComPtr<ID3D11Texture2D> mediaTexture;
        if (FAILED(player->device->OpenSharedResource1(static_cast<HANDLE>(sharedHandle), IID_PPV_ARGS(mediaTexture.GetAddressOf()))))
            return 0;
        RECT r = { 0, 0, LONG(player->width), LONG(player->height) };
        MFVideoNormalizedRect rect = { 0.0f, 0.0f, 1.0f, 1.0f };
        return player->mediaEngine->TransferVideoFrame(mediaTexture.Get(), &rect, &r, &player->bkgColor) == S_OK ? 1 : 0;
    }

    // The same into memory (for APIs that can't share textures with D3D11 here): BGRA8 rows,
    // Donut_GetVideoFrameData / Donut_GetVideoFrameRowPitch, valid until the next transfer. Returns 1
    // if there was a new frame.
    int Donut_TransferVideoFrameToMemory(VideoPlayer* videoPlayer)
    {
        auto* player = videoPlayer;
        if (!player->mediaEngine || !player->isPlaying)
            return 0;
        LONGLONG pts;
        if (player->mediaEngine->OnVideoStreamTick(&pts) != S_OK)
            return 0;
        if (!player->frameTexture)
        {
            D3D11_TEXTURE2D_DESC desc = {};
            desc.Width = player->width;
            desc.Height = player->height;
            desc.MipLevels = 1;
            desc.ArraySize = 1;
            desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
            desc.SampleDesc.Count = 1;
            desc.Usage = D3D11_USAGE_DEFAULT;
            desc.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
            if (FAILED(player->device->CreateTexture2D(&desc, nullptr, player->frameTexture.GetAddressOf())))
                return 0;
            desc.Usage = D3D11_USAGE_STAGING;
            desc.BindFlags = 0;
            desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
            if (FAILED(player->device->CreateTexture2D(&desc, nullptr, player->stagingTexture.GetAddressOf())))
                return 0;
            player->frameRowPitch = int(player->width * 4);
            player->frameData.resize(size_t(player->frameRowPitch) * player->height);
        }
        RECT r = { 0, 0, LONG(player->width), LONG(player->height) };
        MFVideoNormalizedRect rect = { 0.0f, 0.0f, 1.0f, 1.0f };
        if (player->mediaEngine->TransferVideoFrame(player->frameTexture.Get(), &rect, &r, &player->bkgColor) != S_OK)
            return 0;
        player->context->CopyResource(player->stagingTexture.Get(), player->frameTexture.Get());
        D3D11_MAPPED_SUBRESOURCE mapped = {};
        if (FAILED(player->context->Map(player->stagingTexture.Get(), 0, D3D11_MAP_READ, 0, &mapped)))
            return 0;
        for (DWORD row = 0; row < player->height; ++row)
        {
            memcpy(player->frameData.data() + size_t(row) * player->frameRowPitch,
                static_cast<const uint8_t*>(mapped.pData) + size_t(row) * mapped.RowPitch, size_t(player->frameRowPitch));
        }
        player->context->Unmap(player->stagingTexture.Get(), 0);
        return 1;
    }

    const void* Donut_GetVideoFrameData(VideoPlayer* videoPlayer)
    {
        return videoPlayer->frameData.data();
    }

    int Donut_GetVideoFrameRowPitch(VideoPlayer* videoPlayer)
    {
        return videoPlayer->frameRowPitch;
    }

    // Moves playback to `seconds` into the video (IMFMediaEngine::SetCurrentTime).
    void Donut_SetVideoTime(VideoPlayer* videoPlayer, double seconds)
    {
        auto* player = videoPlayer;
        if (player->mediaEngine)
            player->mediaEngine->SetCurrentTime(seconds);
    }

    void Donut_DestroyVideoPlayer(VideoPlayer* videoPlayer)
    {
        delete videoPlayer;
    }
}
