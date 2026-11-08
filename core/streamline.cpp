// NVIDIA Streamline (github.com/NVIDIA-RTX/Streamline, SDK 2.12.0, MIT; its plugins and NGX DLLs are under
// NVIDIA's own licenses and are fetched into the build, never committed) for the streamline_demo example: the
// C API core/interop/streamline.d.ts declares.
//
// Streamline_Init loads sl.interposer.dll by its full path (bin/streamline/ by default: under tslang's JIT the
// process is tslang.exe, whose folder has no Streamline, so nothing may be found by name), checks its
// signature, takes its exports with GetProcAddress (sl.interposer.lib isn't linked: a load-time import would
// not be found under the JIT either) and starts it with manual hooking (sl_hooks.h) and frame-based resource
// tagging. It then has Donut_CreateAppWithOptions' AppOptions.Streamline make the device through it
// (g_StreamlineConfigureDevice): on D3D12 the interposer's D3D12CreateDevice and CreateDXGIFactory2
// (DeviceCreationParameters::d3d12CreateDevice and createDxgiFactory2, patches/Donut-streamline-device-hooks.patch)
// make the device and factory, NVRHI gets the proxy device and Streamline the native one (slSetD3DDevice); on
// Vulkan the interposer is the Vulkan loader (vulkanLibraryName, and GLFW's for a window's surface), so its
// vkCreateInstance and vkCreateDevice add what the plugins need (no slSetVulkanInfo).
//
// Per frame: the app's device manager gets frame callbacks (g_StreamlineAppCreated) that take the frame's
// token and run Reflex's sleep before it and set PCL markers around its animation, rendering and present;
// the demo then sets the camera's constants, tags its motion vectors, depth and color without the UI, and
// has DLSS-SR or DLSS-RR upscale and DeepDVC change the final color (slSetTagForFrame and slEvaluateFeature: frame-based tagging). Textures go to
// Streamline in a state NVRHI has committed (COMMON on D3D12, GENERAL on Vulkan), which its own barriers
// return them to.

#include <donut/app/DeviceManager.h>
#include <donut/core/log.h>
#include <donut/core/math/math.h>
#include <donut/engine/View.h>
#include <nvrhi/nvrhi.h>
#include <nvrhi/vulkan.h>

#include <cfloat>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <functional>
#include <map>
#include <set>
#include <string>
#include <vector>

#include "donut_api.h"

#include <windows.h>

#include <sl.h>
#include <sl_consts.h>
#include <sl_helpers.h>
#include <sl_security.h>
#include <sl_dlss.h>
#include <sl_dlss_d.h>
#include <sl_deepdvc.h>
#include <sl_pcl.h>
#include <sl_reflex.h>

// The hooks Donut_CreateAppWithOptions calls with AppOptions.Streamline (core/donut_interop.cpp): on the
// device's parameters, then on the new app's device manager.
namespace donut_interop
{
    extern std::function<void(nvrhi::GraphicsAPI, donut::app::DeviceCreationParameters&)> g_StreamlineConfigureDevice;
    extern std::function<void(donut::app::DeviceManager&)> g_StreamlineAppCreated;
}

// core/donut_interop.cpp's app and its NVRHI device.
struct App;
extern "C" void* Donut_GetNvrhiDevice(App* app);

namespace
{
    // The sample's (and its NGX) application id.
    constexpr uint32_t kApplicationId = 231313132;

    // The sample's camera planes for Streamline's constants (the far plane only there: the projection is
    // reverse-Z with an infinite far plane).
    constexpr float kCameraNear = 0.01f;
    constexpr float kCameraFar = 200.f;

    // The one viewport the demo renders.
    const sl::ViewportHandle kViewport(0);

    using PFunD3D12CreateDevice = HRESULT WINAPI(IUnknown* adapter, D3D_FEATURE_LEVEL minimumFeatureLevel, REFIID riid, void** device);
    using PFunCreateDXGIFactory2 = HRESULT WINAPI(UINT flags, REFIID riid, void** factory);

    // Streamline once started: the interposer (kept loaded for good: the device NVRHI holds on D3D12 is its proxy,
    // and Vulkan's loader) and its functions.
    struct Streamline
    {
        HMODULE interposer = nullptr;
        bool initialized = false;
        nvrhi::GraphicsAPI api = nvrhi::GraphicsAPI::D3D12;
        std::string interposerPath; // UTF-8, as Donut's vulkanLibraryName takes it
        bool log = false;

        SL_FUN_DECL(slInit);
        SL_FUN_DECL(slShutdown);
        SL_FUN_DECL(slIsFeatureSupported);
        SL_FUN_DECL(slSetFeatureLoaded);
        SL_FUN_DECL(slGetNativeInterface);
        SL_FUN_DECL(slSetD3DDevice);
        SL_FUN_DECL(slGetFeatureFunction);
        SL_FUN_DECL(slGetNewFrameToken);
        SL_FUN_DECL(slSetConstants);
        SL_FUN_DECL(slSetTagForFrame);
        SL_FUN_DECL(slEvaluateFeature);
        SL_FUN_DECL(slFreeResources);
        // The plugins' functions (slGetFeatureFunction, once the device exists: FeatureFunctions).
        SL_FUN_DECL(slDLSSGetOptimalSettings);
        SL_FUN_DECL(slDLSSSetOptions);
        SL_FUN_DECL(slDLSSDGetOptimalSettings);
        SL_FUN_DECL(slDLSSDSetOptions);
        SL_FUN_DECL(slDeepDVCSetOptions);
        SL_FUN_DECL(slReflexSleep);
        SL_FUN_DECL(slReflexSetOptions);
        SL_FUN_DECL(slReflexGetState);
        SL_FUN_DECL(slPCLSetMarker);
        bool featureFunctionsQueried = false;
        PFunD3D12CreateDevice* d3d12CreateDevice = nullptr;
        PFunCreateDXGIFactory2* createDxgiFactory2 = nullptr;
        PFN_vkGetInstanceProcAddr vkGetInstanceProcAddr = nullptr;

        // Streamline_FeatureStatusText's: by feature, what Streamline_IsFeatureSupported found last.
        std::map<uint32_t, std::string> status;
        // The features Streamline_IsFeatureSupported found supported: the others' functions aren't called.
        std::set<uint32_t> supported;

        // This frame's token (Streamline_BeginFrame's), which constants, tags and evaluations are for.
        sl::FrameToken* frame = nullptr;
        // Whether a resource is tagged (then Streamline_ClearTags has tags to drop).
        bool tagged = false;
        // No Reflex sleep: on a headless Vulkan device (no swap chain) under the validation layer, where it
        // crashes (InstallFrameCallbacks).
        bool skipReflexSleep = false;

        bool IsSupported(sl::Feature feature) const { return supported.count(static_cast<uint32_t>(feature)) != 0; }
    };

    Streamline g_Streamline;

    // The folder of the module holding this code: the executable, or donut_interop_shared.dll under the JIT.
    std::filesystem::path ModuleDirectory()
    {
        HMODULE module = nullptr;
        GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
            reinterpret_cast<LPCWSTR>(&ModuleDirectory), &module);
        wchar_t path[MAX_PATH] = {};
        GetModuleFileNameW(module, path, MAX_PATH);
        return std::filesystem::path(path).parent_path();
    }

    // Streamline's log, through Donut's. Its errors go out as warnings: a feature this GPU or driver hasn't is
    // one, and the tests fail on an error line; with `log` (Streamline_Init's) its information too.
    void LogMessage(sl::LogType type, const char* message)
    {
        std::string text = message ? message : "";
        while (!text.empty() && (text.back() == '\n' || text.back() == '\r'))
            text.pop_back();
        if (type == sl::LogType::eInfo)
        {
            if (g_Streamline.log)
                donut::log::info("Streamline: %s", text.c_str());
        }
        else
            donut::log::warning("Streamline: %s", text.c_str());
    }

    template <typename T>
    bool GetExport(T*& function, const char* name)
    {
        function = reinterpret_cast<T*>(GetProcAddress(g_Streamline.interposer, name));
        if (!function)
            donut::log::error("Streamline: sl.interposer.dll doesn't export %s", name);
        return function != nullptr;
    }

    // Logs a failed Streamline call (as a warning: see LogMessage).
    bool Check(sl::Result result, const char* what)
    {
        if (result != sl::Result::eOk)
            donut::log::warning("Streamline: %s: %s", what, sl::getResultAsStr(result));
        return result == sl::Result::eOk;
    }

    template <typename T>
    void GetFeatureFunction(sl::Feature feature, T*& function, const char* name)
    {
        void* address = nullptr;
        if (g_Streamline.slGetFeatureFunction(feature, name, address) == sl::Result::eOk)
            function = reinterpret_cast<T*>(address);
        else
            donut::log::warning("Streamline: no %s", name);
    }

    // The plugins' functions, the first time one is needed (their plugins load with the device), of the
    // features found supported.
    void FeatureFunctions()
    {
        if (g_Streamline.featureFunctionsQueried)
            return;
        g_Streamline.featureFunctionsQueried = true;
        if (g_Streamline.IsSupported(sl::kFeatureDLSS))
        {
            GetFeatureFunction(sl::kFeatureDLSS, g_Streamline.slDLSSGetOptimalSettings, "slDLSSGetOptimalSettings");
            GetFeatureFunction(sl::kFeatureDLSS, g_Streamline.slDLSSSetOptions, "slDLSSSetOptions");
        }
        if (g_Streamline.IsSupported(sl::kFeatureDLSS_RR))
        {
            GetFeatureFunction(sl::kFeatureDLSS_RR, g_Streamline.slDLSSDGetOptimalSettings, "slDLSSDGetOptimalSettings");
            GetFeatureFunction(sl::kFeatureDLSS_RR, g_Streamline.slDLSSDSetOptions, "slDLSSDSetOptions");
        }
        if (g_Streamline.IsSupported(sl::kFeatureDeepDVC))
            GetFeatureFunction(sl::kFeatureDeepDVC, g_Streamline.slDeepDVCSetOptions, "slDeepDVCSetOptions");
        if (g_Streamline.IsSupported(sl::kFeatureReflex))
        {
            GetFeatureFunction(sl::kFeatureReflex, g_Streamline.slReflexSleep, "slReflexSleep");
            GetFeatureFunction(sl::kFeatureReflex, g_Streamline.slReflexSetOptions, "slReflexSetOptions");
            GetFeatureFunction(sl::kFeatureReflex, g_Streamline.slReflexGetState, "slReflexGetState");
        }
        if (g_Streamline.IsSupported(sl::kFeaturePCL))
            GetFeatureFunction(sl::kFeaturePCL, g_Streamline.slPCLSetMarker, "slPCLSetMarker");
    }

    // The frame's start: a new frame token (for frameIndex, or Streamline's next frame), then Reflex's sleep.
    int BeginFrame(const uint32_t* frameIndex)
    {
        if (!g_Streamline.initialized)
            return -1;
        FeatureFunctions();
        if (!Check(g_Streamline.slGetNewFrameToken(g_Streamline.frame, frameIndex), "slGetNewFrameToken"))
        {
            g_Streamline.frame = nullptr;
            return -1;
        }
        if (g_Streamline.slReflexSleep && !g_Streamline.skipReflexSleep)
            Check(g_Streamline.slReflexSleep(*g_Streamline.frame), "slReflexSleep");
        return static_cast<int>(static_cast<uint32_t>(*g_Streamline.frame));
    }

    void PclMarker(sl::PCLMarker marker)
    {
        if (g_Streamline.initialized && g_Streamline.frame && g_Streamline.slPCLSetMarker)
            Check(g_Streamline.slPCLSetMarker(marker, *g_Streamline.frame), "slPCLSetMarker");
    }

    // The frame's token and the PCL markers around its simulation, rendering and present, through the device
    // manager's frame callbacks (Donut_RunApp calls them in test mode too, where nothing presents).
    void InstallFrameCallbacks(donut::app::DeviceManager& deviceManager)
    {
        // Observed: on Vulkan, a headless device (test mode, no swap chain) under the validation layer crashes in
        // Reflex's sleep; with the layer and a swap chain (the Streamline Sample's own run) it doesn't. Only that
        // combination skips it (a windowed Vulkan -debug run still sleeps; to verify with Task 8's windowed run).
        g_Streamline.skipReflexSleep = g_Streamline.api == nvrhi::GraphicsAPI::VULKAN
            && deviceManager.GetDeviceParams().headlessDevice
            && deviceManager.IsVulkanLayerEnabled("VK_LAYER_KHRONOS_validation");
        if (g_Streamline.skipReflexSleep)
            donut::log::info("Reflex: no sleep on a headless Vulkan device under the validation layer (it crashes there)");
        auto& callbacks = deviceManager.m_callbacks;
        callbacks.beforeFrame = [](donut::app::DeviceManager&, uint32_t frameIndex) { BeginFrame(&frameIndex); };
        callbacks.beforeAnimate = [](donut::app::DeviceManager&, uint32_t) { PclMarker(sl::PCLMarker::eSimulationStart); };
        callbacks.afterAnimate = [](donut::app::DeviceManager&, uint32_t) { PclMarker(sl::PCLMarker::eSimulationEnd); };
        callbacks.beforeRender = [](donut::app::DeviceManager&, uint32_t) { PclMarker(sl::PCLMarker::eRenderSubmitStart); };
        callbacks.afterRender = [](donut::app::DeviceManager&, uint32_t) { PclMarker(sl::PCLMarker::eRenderSubmitEnd); };
        callbacks.beforePresent = [](donut::app::DeviceManager&, uint32_t) { PclMarker(sl::PCLMarker::ePresentStart); };
        callbacks.afterPresent = [](donut::app::DeviceManager&, uint32_t) { PclMarker(sl::PCLMarker::ePresentEnd); };
    }

    sl::float4x4 ToSl(const dm::float4x4& m)
    {
        sl::float4x4 result;
        result.setRow(0, sl::float4{ m.row0.x, m.row0.y, m.row0.z, m.row0.w });
        result.setRow(1, sl::float4{ m.row1.x, m.row1.y, m.row1.z, m.row1.w });
        result.setRow(2, sl::float4{ m.row2.x, m.row2.y, m.row2.z, m.row2.w });
        result.setRow(3, sl::float4{ m.row3.x, m.row3.y, m.row3.z, m.row3.w });
        return result;
    }

    // 16 floats, row-major (row vectors, as Donut's).
    sl::float4x4 ToSl16(const float* m)
    {
        sl::float4x4 result;
        for (int row = 0; row < 4; row++)
            result.setRow(row, sl::float4{ m[row * 4], m[row * 4 + 1], m[row * 4 + 2], m[row * 4 + 3] });
        return result;
    }

    sl::float3 ToSl3(const float* v)
    {
        return sl::float3{ v[0], v[1], v[2] };
    }

    // A texture as Streamline takes it, put in a known state first: Streamline transitions it with its own
    // barriers from the state its tag gives, and back. On D3D12 COMMON (its legacy barriers are allowed on
    // an enhanced-barrier resource in that layout only), on Vulkan GENERAL (UnorderedAccess), as Donut's
    // own Streamline integration does.
    sl::Resource ToSl(nvrhi::ICommandList* commandList, nvrhi::ITexture* texture)
    {
        const nvrhi::TextureDesc& desc = texture->getDesc();
        if (g_Streamline.api == nvrhi::GraphicsAPI::D3D12)
        {
            commandList->setTextureState(texture, nvrhi::AllSubresources, nvrhi::ResourceStates::Common);
            commandList->commitBarriers();
            return sl::Resource{ sl::ResourceType::eTex2d, texture->getNativeObject(nvrhi::ObjectTypes::D3D12_Resource).pointer,
                nullptr, nullptr, static_cast<uint32_t>(D3D12_RESOURCE_STATE_COMMON) };
        }
        commandList->setTextureState(texture, nvrhi::AllSubresources, nvrhi::ResourceStates::UnorderedAccess);
        commandList->commitBarriers();
        const auto* imageInfo = static_cast<const VkImageCreateInfo*>(
            texture->getNativeObject(nvrhi::ObjectTypes::VK_ImageCreateInfo).pointer);
        sl::Resource resource{ sl::ResourceType::eTex2d, texture->getNativeObject(nvrhi::ObjectTypes::VK_Image).pointer,
            texture->getNativeObject(nvrhi::ObjectTypes::VK_DeviceMemory).pointer,
            texture->getNativeView(nvrhi::ObjectTypes::VK_ImageView, desc.format, nvrhi::TextureSubresourceSet(0, 1, 0, 1)).pointer,
            static_cast<uint32_t>(VK_IMAGE_LAYOUT_GENERAL) };
        resource.width = desc.width;
        resource.height = desc.height;
        resource.nativeFormat = static_cast<uint32_t>(nvrhi::vulkan::convertFormat(desc.format));
        resource.mipLevels = desc.mipLevels;
        resource.arrayLayers = imageInfo ? imageInfo->arrayLayers : 1;
        resource.flags = imageInfo ? static_cast<uint32_t>(imageInfo->flags) : 0;
        resource.usage = imageInfo ? static_cast<uint32_t>(imageInfo->usage) : 0;
        return resource;
    }

    sl::CommandBuffer* NativeCommandList(nvrhi::ICommandList* commandList)
    {
        return static_cast<sl::CommandBuffer*>(commandList->getNativeObject(g_Streamline.api == nvrhi::GraphicsAPI::D3D12
            ? nvrhi::ObjectTypes::D3D12_GraphicsCommandList : nvrhi::ObjectTypes::VK_CommandBuffer).pointer);
    }

    // A texture to tag for this frame, over its top-left width x height.
    struct Tag
    {
        nvrhi::ITexture* texture;
        sl::BufferType type;
        sl::ResourceLifecycle lifecycle;
        uint32_t width;
        uint32_t height;
    };

    constexpr size_t kMaxTags = 6;

    bool SetTags(nvrhi::ICommandList* commandList, const Tag* tags, size_t count, const char* what)
    {
        if (!g_Streamline.initialized || !g_Streamline.frame)
            return false;
        if (count > kMaxTags)
        {
            donut::log::warning("Streamline: %s: %zu tags, at most %zu", what, count, kMaxTags);
            return false;
        }
        sl::Resource resources[kMaxTags];
        sl::Extent extents[kMaxTags];
        sl::ResourceTag slTags[kMaxTags];
        for (size_t i = 0; i < count; i++)
        {
            resources[i] = ToSl(commandList, tags[i].texture);
            extents[i] = sl::Extent{ 0, 0, tags[i].width, tags[i].height };
            slTags[i] = sl::ResourceTag{ &resources[i], tags[i].type, tags[i].lifecycle, &extents[i] };
        }
        g_Streamline.tagged = true;
        return Check(g_Streamline.slSetTagForFrame(*g_Streamline.frame, kViewport, slTags, static_cast<uint32_t>(count),
            NativeCommandList(commandList)), what);
    }

    sl::DLSSOptions DlssOptions(int mode, uint32_t outputWidth, uint32_t outputHeight)
    {
        sl::DLSSOptions options{};
        options.mode = static_cast<sl::DLSSMode>(mode);
        options.outputWidth = outputWidth;
        options.outputHeight = outputHeight;
        // HDR color in; the exposure is the demo's (tone mapping comes after DLSS).
        options.colorBuffersHDR = sl::Boolean::eTrue;
        options.useAutoExposure = sl::Boolean::eFalse;
        return options;
    }

    // DLSS-RR's options: as DLSS's, with the normals' roughness in their w (packed) and the camera's
    // world-to-view matrix and its inverse (16 floats each, or none).
    sl::DLSSDOptions DlssRROptions(int mode, uint32_t outputWidth, uint32_t outputHeight, const float* worldToView,
        const float* viewToWorld)
    {
        sl::DLSSDOptions options{};
        options.mode = static_cast<sl::DLSSMode>(mode);
        options.outputWidth = outputWidth;
        options.outputHeight = outputHeight;
        options.colorBuffersHDR = sl::Boolean::eTrue;
        options.normalRoughnessMode = sl::DLSSDNormalRoughnessMode::ePacked;
        if (worldToView && viewToWorld)
        {
            options.worldToCameraView = ToSl16(worldToView);
            options.cameraViewToWorld = ToSl16(viewToWorld);
        }
        return options;
    }

    // What AppOptions.Streamline does to the device's parameters.
    void ConfigureDevice(nvrhi::GraphicsAPI api, donut::app::DeviceCreationParameters& params)
    {
        if (api != g_Streamline.api)
        {
            donut::log::warning("Streamline: started for another graphics API; the device is made without it");
            return;
        }
        if (api == nvrhi::GraphicsAPI::D3D12)
        {
            params.createDxgiFactory2 = [](UINT flags, REFIID riid, void** factory)
            {
                return g_Streamline.createDxgiFactory2(flags, riid, factory);
            };
            // The interposer's device is a proxy, which NVRHI gets; Streamline its native device.
            params.d3d12CreateDevice = [](IUnknown* adapter, D3D_FEATURE_LEVEL featureLevel, REFIID riid, void** device)
            {
                HRESULT hr = g_Streamline.d3d12CreateDevice(adapter, featureLevel, riid, device);
                if (FAILED(hr))
                    return hr;
                void* native = nullptr;
                sl::Result result = g_Streamline.slGetNativeInterface(*device, &native);
                if (result != sl::Result::eOk || !native)
                {
                    donut::log::warning("Streamline: slGetNativeInterface: %s", sl::getResultAsStr(result));
                    native = *device;
                }
                result = g_Streamline.slSetD3DDevice(native);
                if (result != sl::Result::eOk)
                    donut::log::warning("Streamline: slSetD3DDevice: %s", sl::getResultAsStr(result));
                return hr;
            };
        }
        else if (api == nvrhi::GraphicsAPI::VULKAN)
        {
            params.vulkanLibraryName = g_Streamline.interposerPath;
            // GLFW's surface (a window's device) through the same loader; before glfwInit, which the window's
            // creation calls.
            glfwInitVulkanLoader(g_Streamline.vkGetInstanceProcAddr);
            // Those of the plugins' (DLSS-G's) the interposer's vkCreateDevice doesn't add itself.
            for (const char* extension : { "VK_NVX_binary_import", "VK_NVX_image_view_handle",
                "VK_KHR_buffer_device_address", "VK_KHR_push_descriptor" })
                params.optionalVulkanDeviceExtensions.push_back(extension);
        }
    }
}

extern "C"
{
    // Starts Streamline (see streamline.d.ts). Non-zero on success.
    DONUT_API int Streamline_Init(int api, const char* pluginDir, int latewarp, int log)
    {
        // Console app: log to the console instead of Donut's default modal MessageBox on errors.
        donut::log::ConsoleApplicationMode();

        if (g_Streamline.initialized)
        {
            donut::log::warning("Streamline: already started");
            return 1;
        }
        if (latewarp != 0)
        {
            // sl.latewarp.dll and sl_latewarp.h aren't in the public 2.12.0 release (STREAMLINE_HAS_LATEWARP).
            donut::log::warning("Latewarp: not in Streamline 2.12.0");
            return 0;
        }
        const auto graphicsApi = static_cast<nvrhi::GraphicsAPI>(api);
        if (graphicsApi != nvrhi::GraphicsAPI::D3D12 && graphicsApi != nvrhi::GraphicsAPI::VULKAN)
        {
            donut::log::warning("Streamline: D3D12 and Vulkan only");
            return 0;
        }
        g_Streamline.api = graphicsApi;
        g_Streamline.log = log != 0;

        const std::filesystem::path directory = pluginDir && *pluginDir
            ? std::filesystem::u8path(pluginDir) : ModuleDirectory() / "streamline";
        const std::filesystem::path interposerPath = directory / "sl.interposer.dll";
        if (!std::filesystem::exists(interposerPath))
        {
            donut::log::error("Streamline: no %s (build copy_streamline_binaries)", interposerPath.u8string().c_str());
            return 0;
        }
        // The release's interposer is signed: one that isn't (or whose signature can't be checked) isn't loaded.
        if (!sl::security::verifyEmbeddedSignature(interposerPath.c_str()))
        {
            donut::log::error("Streamline: the signature of %s doesn't verify", interposerPath.u8string().c_str());
            return 0;
        }
        g_Streamline.interposer = LoadLibraryW(interposerPath.c_str());
        if (!g_Streamline.interposer)
        {
            donut::log::error("Streamline: cannot load %s (error %lu)", interposerPath.u8string().c_str(), GetLastError());
            return 0;
        }
        g_Streamline.interposerPath = interposerPath.u8string();

        bool found = GetExport(g_Streamline.slInit, "slInit") && GetExport(g_Streamline.slShutdown, "slShutdown")
            && GetExport(g_Streamline.slIsFeatureSupported, "slIsFeatureSupported")
            && GetExport(g_Streamline.slSetFeatureLoaded, "slSetFeatureLoaded")
            && GetExport(g_Streamline.slGetFeatureFunction, "slGetFeatureFunction")
            && GetExport(g_Streamline.slGetNewFrameToken, "slGetNewFrameToken")
            && GetExport(g_Streamline.slSetConstants, "slSetConstants")
            && GetExport(g_Streamline.slSetTagForFrame, "slSetTagForFrame")
            && GetExport(g_Streamline.slEvaluateFeature, "slEvaluateFeature")
            && GetExport(g_Streamline.slFreeResources, "slFreeResources");
        if (graphicsApi == nvrhi::GraphicsAPI::D3D12)
            found = found && GetExport(g_Streamline.slGetNativeInterface, "slGetNativeInterface")
                && GetExport(g_Streamline.slSetD3DDevice, "slSetD3DDevice")
                && GetExport(g_Streamline.d3d12CreateDevice, "D3D12CreateDevice")
                && GetExport(g_Streamline.createDxgiFactory2, "CreateDXGIFactory2");
        else
            found = found && GetExport(g_Streamline.vkGetInstanceProcAddr, "vkGetInstanceProcAddr");
        if (!found)
            return 0;

        // DLSS-G or Latewarp (only one of them loads, by latewarp; Latewarp returned above).
        const sl::Feature features[] = { sl::kFeatureDLSS, sl::kFeatureDLSS_RR, sl::kFeatureDeepDVC,
            sl::kFeatureReflex, sl::kFeaturePCL, sl::kFeatureDLSS_G };
        const std::wstring pluginPath = directory.wstring();
        const wchar_t* pluginPaths[] = { pluginPath.c_str() };

        sl::Preferences preferences{};
        preferences.showConsole = false;
        preferences.logLevel = g_Streamline.log ? sl::LogLevel::eVerbose : sl::LogLevel::eDefault;
        preferences.logMessageCallback = &LogMessage;
        preferences.pathsToPlugins = pluginPaths;
        preferences.numPathsToPlugins = 1;
        // Not the defaults' eAllowOTA and eLoadDownloadedPlugins: the plugins are bin/streamline's, nothing is
        // downloaded. eDisableCLStateTracking (a default) stays: the caller restores its command list's state
        // after an evaluation (NVRHI's clearState).
        preferences.flags = sl::PreferenceFlags::eDisableCLStateTracking | sl::PreferenceFlags::eUseManualHooking
            | sl::PreferenceFlags::eUseFrameBasedResourceTagging;
        preferences.featuresToLoad = features;
        preferences.numFeaturesToLoad = static_cast<uint32_t>(std::size(features));
        preferences.applicationId = kApplicationId;
        preferences.engine = sl::EngineType::eCustom;
        preferences.renderAPI = graphicsApi == nvrhi::GraphicsAPI::D3D12 ? sl::RenderAPI::eD3D12 : sl::RenderAPI::eVulkan;

        const sl::Result result = g_Streamline.slInit(preferences, sl::kSDKVersion);
        if (result != sl::Result::eOk)
        {
            donut::log::error("Streamline: slInit: %s", sl::getResultAsStr(result));
            return 0;
        }
        g_Streamline.initialized = true;

        // On D3D12 DLSS-G stays unloaded until it's turned on (it then needs the swap chain made again).
        if (graphicsApi == nvrhi::GraphicsAPI::D3D12)
            g_Streamline.slSetFeatureLoaded(sl::kFeatureDLSS_G, false);

        donut_interop::g_StreamlineConfigureDevice = &ConfigureDevice;
        donut_interop::g_StreamlineAppCreated = &InstallFrameCallbacks;
        donut::log::info("Streamline: started, plugins from %s", directory.u8string().c_str());
        return 1;
    }

    // Non-zero if the app's adapter supports the feature (see streamline.d.ts).
    DONUT_API int Streamline_IsFeatureSupported(App* app, int feature)
    {
        std::string& status = g_Streamline.status[static_cast<uint32_t>(feature)];
        if (!g_Streamline.initialized)
        {
            status = "Streamline is not initialized";
            return 0;
        }
        nvrhi::IDevice* device = app ? static_cast<nvrhi::IDevice*>(Donut_GetNvrhiDevice(app)) : nullptr;
        if (!device)
        {
            status = "no device";
            return 0;
        }

        sl::AdapterInfo adapter{};
        LUID luid{};
        if (g_Streamline.api == nvrhi::GraphicsAPI::D3D12)
        {
            auto d3dDevice = static_cast<ID3D12Device*>(device->getNativeObject(nvrhi::ObjectTypes::D3D12_Device).pointer);
            if (!d3dDevice)
            {
                status = "not a D3D12 device";
                return 0;
            }
            luid = d3dDevice->GetAdapterLuid();
            adapter.deviceLUID = reinterpret_cast<uint8_t*>(&luid);
            adapter.deviceLUIDSizeInBytes = sizeof(luid);
        }
        else
            adapter.vkPhysicalDevice = device->getNativeObject(nvrhi::ObjectTypes::VK_PhysicalDevice).pointer;

        const sl::Result result = g_Streamline.slIsFeatureSupported(static_cast<sl::Feature>(feature), adapter);
        status = result == sl::Result::eOk ? "supported" : sl::getResultAsStr(result);
        if (result == sl::Result::eOk)
            g_Streamline.supported.insert(static_cast<uint32_t>(feature));
        else
            g_Streamline.supported.erase(static_cast<uint32_t>(feature));
        return result == sl::Result::eOk ? 1 : 0;
    }

    // Why Streamline_IsFeatureSupported said what it did for the feature (tslang copies the string).
    DONUT_API const char* Streamline_FeatureStatusText(int feature)
    {
        auto it = g_Streamline.status.find(static_cast<uint32_t>(feature));
        return it != g_Streamline.status.end() ? it->second.c_str() : "not queried";
    }

    // A new frame (see streamline.d.ts): its token, -1 without one.
    DONUT_API int Streamline_BeginFrame()
    {
        return BeginFrame(nullptr);
    }

    // A PCL marker (sl::PCLMarker) for this frame, if PCL is supported.
    DONUT_API void Streamline_PclMarker(int marker)
    {
        PclMarker(static_cast<sl::PCLMarker>(marker));
    }

    // Reflex's mode (sl::ReflexMode) and frame rate cap (0: none), if Reflex is supported.
    DONUT_API void Streamline_SetReflex(int mode, int fpsCap)
    {
        if (!g_Streamline.initialized)
            return;
        FeatureFunctions();
        if (!g_Streamline.slReflexSetOptions)
            return;
        sl::ReflexOptions options{};
        options.mode = static_cast<sl::ReflexMode>(mode);
        options.frameLimitUs = fpsCap > 0 ? static_cast<uint32_t>(1000000.0 / fpsCap) : 0;
        options.useMarkersToOptimize = true;
        // The key the PC latency ping is sent with.
        options.virtualKey = VK_F13;
        Check(g_Streamline.slReflexSetOptions(options), "slReflexSetOptions");
    }

    // Reflex's latest latency report: the simulation's start to the GPU's end of rendering, in milliseconds;
    // -1 without a report (no Reflex, or no frame presented yet).
    DONUT_API double Streamline_ReflexLatencyMs()
    {
        if (!g_Streamline.initialized)
            return -1.0;
        FeatureFunctions();
        if (!g_Streamline.slReflexGetState)
            return -1.0;
        sl::ReflexState state{};
        if (!Check(g_Streamline.slReflexGetState(state), "slReflexGetState") || !state.latencyReportAvailable)
            return -1.0;
        const sl::ReflexReport& report = state.frameReport[63];
        if (report.gpuRenderEndTime == 0 || report.gpuRenderEndTime < report.simStartTime)
            return -1.0;
        return double(report.gpuRenderEndTime - report.simStartTime) / 1000.0;
    }

    // This frame's camera for Streamline (see streamline.d.ts).
    DONUT_API void Streamline_SetConstants(donut::engine::IView* view, donut::engine::IView* prevView, const float* cameraPos,
        const float* cameraFwd, const float* cameraUp, const float* cameraRight, int renderWidth, int renderHeight, int reset)
    {
        if (!g_Streamline.initialized || !g_Streamline.frame || !view || !prevView)
            return;
        const dm::float4x4 projection = view->GetProjectionMatrix(false);
        // This frame's clip space to the previous frame's: through world space (this view's inverse, the
        // previous view), both projections without jitter.
        const dm::affine3 viewReprojection = view->GetInverseViewMatrix() * prevView->GetViewMatrix();
        const dm::float4x4 reprojection = dm::inverse(projection) * dm::affineToHomogeneous(viewReprojection)
            * prevView->GetProjectionMatrix(false);

        sl::Constants constants{};
        constants.cameraAspectRatio = float(renderWidth) / float(renderHeight);
        // The projection's vertical field of view (its y scale is 1 / tan(fov / 2)).
        constants.cameraFOV = 2.f * std::atan(1.f / projection.row1.y);
        constants.cameraNear = kCameraNear;
        constants.cameraFar = kCameraFar;
        constants.cameraMotionIncluded = sl::Boolean::eTrue;
        constants.cameraPinholeOffset = { 0.f, 0.f };
        constants.cameraPos = ToSl3(cameraPos);
        constants.cameraFwd = ToSl3(cameraFwd);
        constants.cameraUp = ToSl3(cameraUp);
        constants.cameraRight = ToSl3(cameraRight);
        constants.cameraViewToClip = ToSl(projection);
        constants.clipToCameraView = ToSl(dm::inverse(projection));
        constants.clipToPrevClip = ToSl(reprojection);
        constants.prevClipToClip = ToSl(dm::inverse(reprojection));
        constants.depthInverted = view->IsReverseDepth() ? sl::Boolean::eTrue : sl::Boolean::eFalse;
        const dm::float2 jitter = view->GetPixelOffset();
        constants.jitterOffset = { jitter.x, jitter.y };
        // Donut's motion vectors are in pixels, Streamline's normalized.
        constants.mvecScale = { 1.f / float(renderWidth), 1.f / float(renderHeight) };
        constants.reset = reset != 0 ? sl::Boolean::eTrue : sl::Boolean::eFalse;
        constants.motionVectors3D = sl::Boolean::eFalse;
        constants.motionVectorsInvalidValue = FLT_MIN;
        Check(g_Streamline.slSetConstants(constants, *g_Streamline.frame, kViewport), "slSetConstants");
    }

    // Tags this frame's motion vectors and depth (whole: they're at the render size) and its color without
    // the UI (see streamline.d.ts).
    DONUT_API void Streamline_TagCommon(nvrhi::ICommandList* commandList, nvrhi::ITexture* motionVectors, nvrhi::ITexture* depth,
        nvrhi::ITexture* hudless)
    {
        if (!commandList || !motionVectors || !depth || !hudless)
            return;
        const Tag tags[] = {
            { motionVectors, sl::kBufferTypeMotionVectors, sl::ResourceLifecycle::eValidUntilPresent,
                motionVectors->getDesc().width, motionVectors->getDesc().height },
            // Valid until present (nothing draws into depth after this; the next frame clears it), as Donut's
            // own integration tags it. The sample tags it eOnlyValidNow, which has Streamline copy it into an
            // image of its own that it then uses (on Vulkan) without moving it out of the undefined layout.
            { depth, sl::kBufferTypeDepth, sl::ResourceLifecycle::eValidUntilPresent, depth->getDesc().width, depth->getDesc().height },
            { hudless, sl::kBufferTypeHUDLessColor, sl::ResourceLifecycle::eValidUntilPresent,
                hudless->getDesc().width, hudless->getDesc().height },
        };
        SetTags(commandList, tags, std::size(tags), "slSetTagForFrame (common)");
    }

    // DLSS's render size for the mode at the display size (see streamline.d.ts).
    DONUT_API int Streamline_DlssOptimalRenderSize(int mode, int displayWidth, int displayHeight)
    {
        if (!g_Streamline.initialized)
            return 0;
        FeatureFunctions();
        if (!g_Streamline.slDLSSGetOptimalSettings || !g_Streamline.slDLSSSetOptions)
            return 0;
        const sl::DLSSOptions options = DlssOptions(mode, uint32_t(displayWidth), uint32_t(displayHeight));
        if (mode == 0)
        {
            Check(g_Streamline.slDLSSSetOptions(kViewport, options), "slDLSSSetOptions");
            // Fails if DLSS never ran on the viewport: then there's nothing to free.
            g_Streamline.slFreeResources(sl::kFeatureDLSS, kViewport);
            return displayWidth | displayHeight << 16;
        }
        sl::DLSSOptimalSettings settings{};
        if (!Check(g_Streamline.slDLSSGetOptimalSettings(options, settings), "slDLSSGetOptimalSettings")
            || settings.optimalRenderWidth == 0 || settings.optimalRenderHeight == 0)
            return 0;
        return int(settings.optimalRenderWidth) | int(settings.optimalRenderHeight) << 16;
    }

    // DLSS's upscaling of input into output (see streamline.d.ts).
    DONUT_API void Streamline_EvaluateDlss(nvrhi::ICommandList* commandList, int mode, nvrhi::ITexture* input, nvrhi::ITexture* output,
        int renderWidth, int renderHeight)
    {
        if (!g_Streamline.initialized || !g_Streamline.frame || !commandList || !input || !output)
            return;
        FeatureFunctions();
        if (!g_Streamline.slDLSSSetOptions)
            return;
        const nvrhi::TextureDesc& outputDesc = output->getDesc();
        if (!Check(g_Streamline.slDLSSSetOptions(kViewport, DlssOptions(mode, outputDesc.width, outputDesc.height)), "slDLSSSetOptions"))
            return;
        const Tag tags[] = {
            { input, sl::kBufferTypeScalingInputColor, sl::ResourceLifecycle::eValidUntilPresent, uint32_t(renderWidth), uint32_t(renderHeight) },
            { output, sl::kBufferTypeScalingOutputColor, sl::ResourceLifecycle::eValidUntilPresent, outputDesc.width, outputDesc.height },
        };
        if (!SetTags(commandList, tags, std::size(tags), "slSetTagForFrame (DLSS)"))
            return;
        const sl::BaseStructure* inputs[] = { &kViewport };
        Check(g_Streamline.slEvaluateFeature(sl::kFeatureDLSS, *g_Streamline.frame, inputs, 1, NativeCommandList(commandList)),
            "slEvaluateFeature (DLSS)");
        // Streamline bound its own pipelines and resources (eDisableCLStateTracking: it doesn't restore them).
        commandList->clearState();
    }

    // DLSS-RR's render size for the mode at the display size (see streamline.d.ts).
    DONUT_API int Streamline_DlssRROptimalRenderSize(int mode, int displayWidth, int displayHeight)
    {
        if (!g_Streamline.initialized)
            return 0;
        FeatureFunctions();
        if (!g_Streamline.slDLSSDGetOptimalSettings || !g_Streamline.slDLSSDSetOptions)
            return 0;
        const sl::DLSSDOptions options = DlssRROptions(mode, uint32_t(displayWidth), uint32_t(displayHeight), nullptr, nullptr);
        if (mode == 0)
        {
            Check(g_Streamline.slDLSSDSetOptions(kViewport, options), "slDLSSDSetOptions");
            // Fails if DLSS-RR never ran on the viewport: then there's nothing to free.
            g_Streamline.slFreeResources(sl::kFeatureDLSS_RR, kViewport);
            return displayWidth | displayHeight << 16;
        }
        sl::DLSSDOptimalSettings settings{};
        if (!Check(g_Streamline.slDLSSDGetOptimalSettings(options, settings), "slDLSSDGetOptimalSettings")
            || settings.optimalRenderWidth == 0 || settings.optimalRenderHeight == 0)
            return 0;
        return int(settings.optimalRenderWidth) | int(settings.optimalRenderHeight) << 16;
    }

    // DLSS-RR's denoising and upscaling of input into output with its guides (see streamline.d.ts).
    DONUT_API void Streamline_EvaluateDlssRR(nvrhi::ICommandList* commandList, int mode, nvrhi::ITexture* input,
        nvrhi::ITexture* output, nvrhi::ITexture* diffuseAlbedo, nvrhi::ITexture* specularAlbedo, nvrhi::ITexture* normalRoughness,
        nvrhi::ITexture* specularHitDistance, const float* worldToView, const float* viewToWorld)
    {
        if (!g_Streamline.initialized || !g_Streamline.frame || !commandList || !input || !output || !diffuseAlbedo
            || !specularAlbedo || !normalRoughness || !specularHitDistance || !worldToView || !viewToWorld)
            return;
        FeatureFunctions();
        if (!g_Streamline.slDLSSDSetOptions)
            return;
        const nvrhi::TextureDesc& outputDesc = output->getDesc();
        if (!Check(g_Streamline.slDLSSDSetOptions(kViewport, DlssRROptions(mode, outputDesc.width, outputDesc.height, worldToView,
            viewToWorld)), "slDLSSDSetOptions"))
            return;
        // The input is at the render size; the guides are read over as much of them (they may be larger).
        const uint32_t renderWidth = input->getDesc().width;
        const uint32_t renderHeight = input->getDesc().height;
        const auto lifecycle = sl::ResourceLifecycle::eValidUntilPresent;
        const Tag tags[] = {
            { input, sl::kBufferTypeScalingInputColor, lifecycle, renderWidth, renderHeight },
            { diffuseAlbedo, sl::kBufferTypeAlbedo, lifecycle, renderWidth, renderHeight },
            { specularAlbedo, sl::kBufferTypeSpecularAlbedo, lifecycle, renderWidth, renderHeight },
            { normalRoughness, sl::kBufferTypeNormalRoughness, lifecycle, renderWidth, renderHeight },
            { specularHitDistance, sl::kBufferTypeSpecularHitDistance, lifecycle, renderWidth, renderHeight },
            { output, sl::kBufferTypeScalingOutputColor, lifecycle, outputDesc.width, outputDesc.height },
        };
        if (!SetTags(commandList, tags, std::size(tags), "slSetTagForFrame (DLSS-RR)"))
            return;
        const sl::BaseStructure* inputs[] = { &kViewport };
        Check(g_Streamline.slEvaluateFeature(sl::kFeatureDLSS_RR, *g_Streamline.frame, inputs, 1, NativeCommandList(commandList)),
            "slEvaluateFeature (DLSS-RR)");
        // Streamline bound its own pipelines and resources (eDisableCLStateTracking: it doesn't restore them).
        commandList->clearState();
    }

    // DeepDVC on color, in place (see streamline.d.ts).
    DONUT_API void Streamline_EvaluateDeepDvc(nvrhi::ICommandList* commandList, nvrhi::ITexture* color, double intensity,
        double saturationBoost)
    {
        if (!g_Streamline.initialized || !g_Streamline.frame || !commandList || !color)
            return;
        FeatureFunctions();
        if (!g_Streamline.slDeepDVCSetOptions)
            return;
        sl::DeepDVCOptions options{};
        options.mode = sl::DeepDVCMode::eOn;
        options.intensity = float(intensity);
        options.saturationBoost = float(saturationBoost);
        if (!Check(g_Streamline.slDeepDVCSetOptions(kViewport, options), "slDeepDVCSetOptions"))
            return;
        // DeepDVC reads and writes the one texture, tagged as the output color.
        const nvrhi::TextureDesc& desc = color->getDesc();
        const Tag tags[] = {
            { color, sl::kBufferTypeScalingOutputColor, sl::ResourceLifecycle::eValidUntilPresent, desc.width, desc.height },
        };
        if (!SetTags(commandList, tags, std::size(tags), "slSetTagForFrame (DeepDVC)"))
            return;
        const sl::BaseStructure* inputs[] = { &kViewport };
        Check(g_Streamline.slEvaluateFeature(sl::kFeatureDeepDVC, *g_Streamline.frame, inputs, 1, NativeCommandList(commandList)),
            "slEvaluateFeature (DeepDVC)");
        // Streamline bound its own pipelines and resources (eDisableCLStateTracking: it doesn't restore them).
        commandList->clearState();
    }

    // Drops every tag: before the tagged resources are released (Streamline holds them until then).
    DONUT_API void Streamline_ClearTags()
    {
        if (!g_Streamline.initialized || !g_Streamline.frame || !g_Streamline.tagged)
            return;
        const sl::BufferType types[] = { sl::kBufferTypeDepth, sl::kBufferTypeMotionVectors, sl::kBufferTypeHUDLessColor,
            sl::kBufferTypeScalingInputColor, sl::kBufferTypeScalingOutputColor, sl::kBufferTypeAlbedo, sl::kBufferTypeSpecularAlbedo,
            sl::kBufferTypeNormalRoughness, sl::kBufferTypeSpecularHitDistance };
        sl::ResourceTag tags[std::size(types)];
        for (size_t i = 0; i < std::size(types); i++)
            tags[i] = sl::ResourceTag{ nullptr, types[i], sl::ResourceLifecycle::eValidUntilPresent };
        Check(g_Streamline.slSetTagForFrame(*g_Streamline.frame, kViewport, tags, uint32_t(std::size(tags)), nullptr),
            "slSetTagForFrame (clear)");
        g_Streamline.tagged = false;
    }

    // Shuts Streamline down, before the app's device is destroyed (see streamline.d.ts).
    DONUT_API void Streamline_Shutdown()
    {
        if (!g_Streamline.initialized)
            return;
        Streamline_ClearTags();
        const sl::Result result = g_Streamline.slShutdown();
        if (result != sl::Result::eOk)
            donut::log::warning("Streamline: slShutdown: %s", sl::getResultAsStr(result));
        g_Streamline.initialized = false;
        g_Streamline.frame = nullptr;
        g_Streamline.supported.clear();
        g_Streamline.featureFunctionsQueried = false;
        g_Streamline.slDLSSGetOptimalSettings = nullptr;
        g_Streamline.slDLSSSetOptions = nullptr;
        g_Streamline.slDLSSDGetOptimalSettings = nullptr;
        g_Streamline.slDLSSDSetOptions = nullptr;
        g_Streamline.slDeepDVCSetOptions = nullptr;
        g_Streamline.slReflexSleep = nullptr;
        g_Streamline.slReflexSetOptions = nullptr;
        g_Streamline.slReflexGetState = nullptr;
        g_Streamline.slPCLSetMarker = nullptr;
        donut_interop::g_StreamlineConfigureDevice = nullptr;
        donut_interop::g_StreamlineAppCreated = nullptr;
        // The interposer stays loaded: the app's D3D12 device is its proxy until Donut_DestroyApp. So do the
        // device manager's frame callbacks, which do nothing from now on.
    }
}
