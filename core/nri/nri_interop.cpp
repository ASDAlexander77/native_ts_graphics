// A flat C API over NRI (NVIDIA Rendering Interface) and NRIFramework, for TypeScript: the Nri_*
// functions core/nri/nri_interop.d.ts declares. Built into nri_interop's shared library with NRI and
// NRIFramework (see core/nri/CMakeLists.txt), which exports these and nothing else.
//
// The application is NRIFramework's SampleBase: TsSample derives from it and forwards its virtual
// methods (Initialize, LatencySleep, RenderFrame) to TypeScript callbacks, so the window, the command
// line and the render loop are NRIFramework's, and the TypeScript code makes the NRI calls, one
// Nri_* function each, their descs taken apart into arguments.
//
// NRI's functions are reached through interface tables (nri::CoreInterface, ...) filled for a device:
// Nri_CreateDevice fills the one table here, so there is one device at a time.

#if defined(_WIN32)
// Before GLFW's header (in NRIFramework.h), which defines APIENTRY otherwise; without its ERROR
// macro, which nri::Message::ERROR would be.
#include <windows.h>
#undef ERROR
#endif

#include "NRIFramework.h"

#if defined(__ANDROID__)
// glfwSetAndroidApp, of GLFW's Android platform (patches/glfw-android-platform.patch)
#include "GLFW/glfw3native.h"
#endif

#include <cstdio>
#include <cstring>
#include <unordered_map>

#if defined(_WIN32)
#define NRI_INTEROP_API __declspec(dllexport)
#else
#include <dlfcn.h>
#define NRI_INTEROP_API __attribute__((visibility("default")))
#endif

namespace
{
    template <typename Fn>
    struct Callback
    {
        Fn method = nullptr;
        void* thisVal = nullptr;

        explicit operator bool() const { return method != nullptr; }
    };

    using InitializeFn = int (*)(void* thisVal, int graphicsAPI);
    using FrameFn = void (*)(void* thisVal, int frameIndex);

    // The interfaces of the device Nri_CreateDevice made last. MeshShaderInterface's functions are
    // null on a device without mesh shaders.
    struct Interfaces : nri::CoreInterface, nri::HelperInterface, nri::SwapChainInterface, nri::MeshShaderInterface
    {
    };
    Interfaces NRI = {};

    // The memory Nri_CreateReadbackBuffer bound to each buffer, freed with it.
    std::unordered_map<nri::Buffer*, std::vector<nri::Memory*>> g_BufferMemory;

    // Where the shaders are instead of next to this library, if Nri_SetDataDirectory was called.
    std::string g_DataDirectory;

    // The directory of this library (bin/, where the shaders are), with a separator at the end.
    std::string LibraryDirectory()
    {
        if (!g_DataDirectory.empty())
            return g_DataDirectory;
#if defined(_WIN32)
        HMODULE module = nullptr;
        GetModuleHandleExA(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
            reinterpret_cast<LPCSTR>(&LibraryDirectory), &module);
        char path[MAX_PATH] = {};
        GetModuleFileNameA(module, path, MAX_PATH);
        std::string directory = path;
        return directory.substr(0, directory.find_last_of("\\/") + 1);
#else
        Dl_info info = {};
        dladdr(reinterpret_cast<void*>(&LibraryDirectory), &info);
        std::string directory = info.dli_fname ? info.dli_fname : "";
        size_t slash = directory.find_last_of('/');
        return slash == std::string::npos ? std::string("./") : directory.substr(0, slash + 1);
#endif
    }

    bool ReadFile(const std::string& path, std::vector<uint8_t>& data)
    {
        FILE* file = fopen(path.c_str(), "rb");
        if (!file)
        {
            printf("ERROR: cannot open %s\n", path.c_str());
            return false;
        }
        fseek(file, 0, SEEK_END);
        data.resize((size_t)ftell(file));
        fseek(file, 0, SEEK_SET);
        bool read = fread(data.data(), 1, data.size(), file) == data.size();
        fclose(file);
        return read && !data.empty();
    }

    // NRI's messages (its validation layer's and the graphics API's) on the standard output, errors
    // with "ERROR" in them, as the tests look for.
    void NRI_CALL MessageCallback(nri::Message messageType, const char* file, uint32_t line, const char* message, void*)
    {
        const char* kind = messageType == nri::Message::ERROR ? "ERROR" : messageType == nri::Message::WARNING ? "WARNING" : "INFO";
        printf("NRI %s: %s (%s:%u)\n", kind, message, file, line);
        fflush(stdout);
    }

    // The states the examples' barriers move a texture between (Nri_CmdTextureBarrier). Values of
    // NriTextureState in nri_interop.d.ts.
    nri::AccessLayoutStage TextureState(int state)
    {
        switch (state)
        {
        case 1:
            return { nri::AccessBits::COLOR_ATTACHMENT, nri::Layout::COLOR_ATTACHMENT, nri::StageBits::COLOR_ATTACHMENT };
        case 2:
            return { nri::AccessBits::COPY_SOURCE, nri::Layout::COPY_SOURCE, nri::StageBits::COPY };
        case 3:
            return { nri::AccessBits::NONE, nri::Layout::PRESENT, nri::StageBits::NONE };
        default:
            return { nri::AccessBits::NONE, nri::Layout::UNDEFINED, nri::StageBits::NONE };
        }
    }

    // A pipeline whose shaders are read from their paths, under LibraryDirectory(): the task shader
    // (if taskPath isn't null), the first shader (firstStage: the vertex or the mesh shader) and the
    // pixel shader. See Nri_CreateGraphicsPipeline.
    nri::Pipeline* CreateGraphicsPipeline(nri::Device* device, nri::PipelineLayout* pipelineLayout, const char* taskPath, const char* taskEntry,
        nri::StageBits firstStage, const char* firstPath, const char* firstEntry, const char* psPath, const char* psEntry, int colorFormat)
    {
        std::string directory = LibraryDirectory();
        std::vector<uint8_t> task, first, ps;
        if ((taskPath && !ReadFile(directory + taskPath, task)) || !ReadFile(directory + firstPath, first) || !ReadFile(directory + psPath, ps))
            return nullptr;

        std::vector<nri::ShaderDesc> shaders;
        if (taskPath)
            shaders.push_back({ nri::StageBits::TASK_SHADER, task.data(), task.size(), taskEntry });
        shaders.push_back({ firstStage, first.data(), first.size(), firstEntry });
        shaders.push_back({ nri::StageBits::FRAGMENT_SHADER, ps.data(), ps.size(), psEntry });

        nri::ColorAttachmentDesc color = {};
        color.format = (nri::Format)colorFormat;
        color.colorWriteMask = nri::ColorWriteBits::RGBA;

        nri::GraphicsPipelineDesc desc = {};
        desc.pipelineLayout = pipelineLayout;
        desc.inputAssembly.topology = nri::Topology::TRIANGLE_LIST;
        desc.rasterization.fillMode = nri::FillMode::SOLID;
        desc.rasterization.cullMode = nri::CullMode::NONE;
        desc.outputMerger.colors = &color;
        desc.outputMerger.colorNum = 1;
        desc.shaders = shaders.data();
        desc.shaderNum = (uint32_t)shaders.size();

        nri::Pipeline* pipeline = nullptr;
        if (NRI.CreateGraphicsPipeline(*device, desc, pipeline) != nri::Result::SUCCESS)
            return nullptr;
        return pipeline;
    }
}

// NRIFramework's application, its virtual methods calling TypeScript.
class TsSample : public SampleBase
{
public:
    Callback<InitializeFn> m_Initialize;
    Callback<FrameFn> m_LatencySleep;
    Callback<FrameFn> m_RenderFrame;
    bool m_Test = false;

    bool Initialize(nri::GraphicsAPI graphicsAPI, bool) override
    {
        return m_Initialize && m_Initialize.method(m_Initialize.thisVal, (int)graphicsAPI) != 0;
    }

    void LatencySleep(uint32_t frameIndex) override
    {
        if (m_LatencySleep)
            m_LatencySleep.method(m_LatencySleep.thisVal, (int)frameIndex);
    }

    void RenderFrame(uint32_t frameIndex) override
    {
        if (m_RenderFrame)
            m_RenderFrame.method(m_RenderFrame.thisVal, (int)frameIndex);
    }

    nri::AllocationCallbacks& AllocationCallbacks() { return m_AllocationCallbacks; }
    uint32_t AdapterIndex() const { return m_AdapterIndex; }
    bool DebugAPI() const { return m_DebugAPI; }
    bool DebugNRI() const { return m_DebugNRI; }
    bool Vsync() const { return m_Vsync; }
};

extern "C"
{
    // --- The application ------------------------------------------------------------------------

    NRI_INTEROP_API TsSample* Nri_CreateSample()
    {
        return new TsSample();
    }

    // Destroys the window; after the objects made on the device and the device are.
    NRI_INTEROP_API void Nri_DestroySample(TsSample* sample)
    {
        delete sample;
    }

    // The folder the shaders are read from (Nri_CreateGraphicsPipeline), instead of this library's:
    // on Android, where the APK's assets are extracted to (core/android_main.cpp).
    NRI_INTEROP_API void Nri_SetDataDirectory(const char* directory)
    {
        g_DataDirectory = directory;
        if (!g_DataDirectory.empty() && g_DataDirectory.back() != '/')
            g_DataDirectory += '/';
    }

#if defined(__ANDROID__)
    // The NativeActivity's android_app (android_native_app_glue's), which GLFW's Android platform
    // takes the window and the input from; before Nri_RunSample, on android_main's thread.
    NRI_INTEROP_API void Nri_SetAndroidApp(struct android_app* app)
    {
        glfwSetAndroidApp(app);
    }
#endif

    // Called by Nri_RunSample once the window is made: makes the device and what the frames need,
    // returns 0 on failure (then Nri_RunSample returns 1 without rendering).
    NRI_INTEROP_API void Nri_SetInitializeCallback(TsSample* sample, InitializeFn method, void* thisVal)
    {
        sample->m_Initialize = { method, thisVal };
    }

    // Called at the start of each frame, before the input is read: waits for the frame's resources.
    NRI_INTEROP_API void Nri_SetLatencySleepCallback(TsSample* sample, FrameFn method, void* thisVal)
    {
        sample->m_LatencySleep = { method, thisVal };
    }

    NRI_INTEROP_API void Nri_SetRenderFrameCallback(TsSample* sample, FrameFn method, void* thisVal)
    {
        sample->m_RenderFrame = { method, thisVal };
    }

    // Parses the command line, makes the window (calling the Initialize callback) and renders until
    // it's closed. Returns 0, or 1 if the command line or the initialization failed.
    // The command line is NRIFramework's (--api=D3D12, --debugAPI, --frameNum=<n>, --help, ...), with
    // the examples' options translated to it: -dx11, -dx12, -vk (--api), -debug (--debugAPI
    // --debugNRI), -test (renders testFrames frames, unfocused too, see Nri_IsTest). V-sync is on, as
    // in the Donut examples.
    NRI_INTEROP_API int Nri_RunSample(TsSample* sample, int argc, const char* const* argv, const char* title, int testFrames)
    {
        std::vector<std::string> args = { argc > 0 ? argv[0] : "nri" , "--vsync", "--width=1280", "--height=720" };
        for (int i = 1; i < argc; i++)
        {
            std::string arg = argv[i];
            if (arg == "-dx11")
                args.push_back("--api=D3D11");
            else if (arg == "-dx12")
                args.push_back("--api=D3D12");
            else if (arg == "-vk")
                args.push_back("--api=VULKAN");
            else if (arg == "-debug")
            {
                args.push_back("--debugAPI");
                args.push_back("--debugNRI");
            }
            else if (arg == "-test" && testFrames > 0)
            {
                sample->m_Test = true;
                args.push_back("--frameNum=" + std::to_string(testFrames));
                args.push_back("--alwaysActive");
            }
            // a separator the JIT launchers leave in (run_jitd.bat x.ts -- -test passes -test -- -dx12),
            // which NRIFramework's parser rejects
            else if (arg != "--")
                args.push_back(arg);
        }

        std::vector<char*> pointers;
        for (std::string& arg : args)
            pointers.push_back(arg.data());

        // NRIFramework prints the command line's errors and usage with printf: flushed here, as this
        // library's output isn't flushed with the executable's.
        bool created = sample->Create((int32_t)pointers.size(), pointers.data(), title);
        fflush(stdout);
        if (!created)
            return 1;
        sample->RenderLoop();
        fflush(stdout);
        return 0;
    }

    // -test was given: Nri_RunSample rendered the test's frames.
    NRI_INTEROP_API int Nri_IsTest(TsSample* sample)
    {
        return sample->m_Test ? 1 : 0;
    }

    NRI_INTEROP_API int Nri_GetOutputWidth(TsSample* sample)
    {
        return (int)sample->GetOutputResolution().x;
    }

    NRI_INTEROP_API int Nri_GetOutputHeight(TsSample* sample)
    {
        return (int)sample->GetOutputResolution().y;
    }

    // The frames in flight (2 with v-sync).
    NRI_INTEROP_API int Nri_GetQueuedFrameNum(TsSample* sample)
    {
        return sample->GetQueuedFrameNum();
    }

    // --- The device -----------------------------------------------------------------------------

    // The device of the adapter and with the validation the command line chose, null on failure.
    NRI_INTEROP_API nri::Device* Nri_CreateDevice(TsSample* sample, int graphicsAPI)
    {
        nri::AdapterDesc adapterDescs[2] = {};
        uint32_t adapterDescNum = helper::GetCountOf(adapterDescs);
        if (nri::nriEnumerateAdapters(adapterDescs, adapterDescNum) != nri::Result::SUCCESS || adapterDescNum == 0)
            return nullptr;

        nri::DeviceCreationDesc desc = {};
        desc.graphicsAPI = (nri::GraphicsAPI)graphicsAPI;
        desc.enableGraphicsAPIValidation = sample->DebugAPI();
        desc.enableNRIValidation = sample->DebugNRI();
        desc.enableD3D11CommandBufferEmulation = D3D11_ENABLE_COMMAND_BUFFER_EMULATION;
        desc.disableD3D12EnhancedBarriers = D3D12_DISABLE_ENHANCED_BARRIERS;
        desc.vkBindingOffsets = VK_BINDING_OFFSETS;
        desc.adapterDesc = &adapterDescs[std::min(sample->AdapterIndex(), adapterDescNum - 1)];
        desc.allocationCallbacks = sample->AllocationCallbacks();
        desc.callbackInterface.MessageCallback = MessageCallback;

        nri::Device* device = nullptr;
        if (nri::nriCreateDevice(desc, device) != nri::Result::SUCCESS)
            return nullptr;

        NRI = {};
        if (nri::nriGetInterface(*device, NRI_INTERFACE(nri::CoreInterface), (nri::CoreInterface*)&NRI) != nri::Result::SUCCESS
            || nri::nriGetInterface(*device, NRI_INTERFACE(nri::HelperInterface), (nri::HelperInterface*)&NRI) != nri::Result::SUCCESS
            || nri::nriGetInterface(*device, NRI_INTERFACE(nri::SwapChainInterface), (nri::SwapChainInterface*)&NRI) != nri::Result::SUCCESS)
        {
            nri::nriDestroyDevice(device);
            return nullptr;
        }
        if (NRI.GetDeviceDesc(*device).features.meshShader)
            nri::nriGetInterface(*device, NRI_INTERFACE(nri::MeshShaderInterface), (nri::MeshShaderInterface*)&NRI);
        return device;
    }

    // Whether the device has an NriFeature (nri_interop.d.ts): 1 or 0.
    NRI_INTEROP_API int Nri_IsFeatureSupported(nri::Device* device, int feature)
    {
        const nri::DeviceDesc& desc = NRI.GetDeviceDesc(*device);
        switch (feature)
        {
        case 0:
            return desc.features.meshShader ? 1 : 0;
        default:
            return 0;
        }
    }

    NRI_INTEROP_API void Nri_DestroyDevice(nri::Device* device)
    {
        nri::nriDestroyDevice(device);
    }

    NRI_INTEROP_API void Nri_DeviceWaitIdle(nri::Device* device)
    {
        NRI.DeviceWaitIdle(device);
    }

    // "D3D12", "VK", ...
    NRI_INTEROP_API const char* Nri_GetGraphicsAPIString(int graphicsAPI)
    {
        return nri::nriGetGraphicsAPIString((nri::GraphicsAPI)graphicsAPI);
    }

    NRI_INTEROP_API const char* Nri_GetAdapterName(nri::Device* device)
    {
        return NRI.GetDeviceDesc(*device).adapterDesc.name;
    }

    // The alignment of the rows of a texture read back into a buffer.
    NRI_INTEROP_API int Nri_GetUploadBufferTextureRowAlignment(nri::Device* device)
    {
        return (int)NRI.GetDeviceDesc(*device).memoryAlignment.uploadBufferTextureRow;
    }

    NRI_INTEROP_API nri::Queue* Nri_GetGraphicsQueue(nri::Device* device)
    {
        nri::Queue* queue = nullptr;
        NRI.GetQueue(*device, nri::QueueType::GRAPHICS, 0, queue);
        return queue;
    }

    // --- Synchronization ------------------------------------------------------------------------

    NRI_INTEROP_API nri::Fence* Nri_CreateFence(nri::Device* device, int initialValue)
    {
        nri::Fence* fence = nullptr;
        NRI.CreateFence(*device, (uint64_t)initialValue, fence);
        return fence;
    }

    // A fence for a swap chain's acquire and release (nri::SWAPCHAIN_SEMAPHORE).
    NRI_INTEROP_API nri::Fence* Nri_CreateSwapChainSemaphore(nri::Device* device)
    {
        nri::Fence* fence = nullptr;
        NRI.CreateFence(*device, nri::SWAPCHAIN_SEMAPHORE, fence);
        return fence;
    }

    NRI_INTEROP_API void Nri_DestroyFence(nri::Fence* fence)
    {
        NRI.DestroyFence(fence);
    }

    // Waits on the CPU until the fence reaches value.
    NRI_INTEROP_API void Nri_Wait(nri::Fence* fence, int value)
    {
        NRI.Wait(*fence, (uint64_t)value);
    }

    // --- The swap chain -------------------------------------------------------------------------

    // Over the sample's window, its size, v-sync as the command line chose; textureNum textures.
    NRI_INTEROP_API nri::SwapChain* Nri_CreateSwapChain(TsSample* sample, nri::Device* device, nri::Queue* queue, int textureNum)
    {
        nri::SwapChainDesc desc = {};
        desc.window = sample->GetWindow();
        desc.queue = queue;
        desc.format = nri::SwapChainFormat::BT709_G22_8BIT;
        desc.flags = (sample->Vsync() ? nri::SwapChainBits::VSYNC : nri::SwapChainBits::NONE) | nri::SwapChainBits::ALLOW_TEARING;
        desc.width = (nri::Dim_t)sample->GetOutputResolution().x;
        desc.height = (nri::Dim_t)sample->GetOutputResolution().y;
        desc.textureNum = (uint8_t)textureNum;
        desc.queuedFrameNum = sample->GetQueuedFrameNum();

        nri::SwapChain* swapChain = nullptr;
        NRI.CreateSwapChain(*device, desc, swapChain);
        return swapChain;
    }

    NRI_INTEROP_API void Nri_DestroySwapChain(nri::SwapChain* swapChain)
    {
        NRI.DestroySwapChain(swapChain);
    }

    NRI_INTEROP_API int Nri_GetSwapChainTextureNum(nri::SwapChain* swapChain)
    {
        uint32_t textureNum = 0;
        NRI.GetSwapChainTextures(*swapChain, textureNum);
        return (int)textureNum;
    }

    NRI_INTEROP_API nri::Texture* Nri_GetSwapChainTexture(nri::SwapChain* swapChain, int index)
    {
        uint32_t textureNum = 0;
        nri::Texture* const* textures = NRI.GetSwapChainTextures(*swapChain, textureNum);
        return textures[index];
    }

    // The index of the next texture to render into, once acquireSemaphore is signaled; -1 on failure.
    NRI_INTEROP_API int Nri_AcquireNextTexture(nri::SwapChain* swapChain, nri::Fence* acquireSemaphore)
    {
        uint32_t index = 0;
        if (NRI.AcquireNextTexture(*swapChain, *acquireSemaphore, index) != nri::Result::SUCCESS)
            return -1;
        return (int)index;
    }

    // Presents once releaseSemaphore is signaled; 0 on failure.
    NRI_INTEROP_API int Nri_QueuePresent(nri::SwapChain* swapChain, nri::Fence* releaseSemaphore)
    {
        return NRI.QueuePresent(*swapChain, *releaseSemaphore) == nri::Result::SUCCESS ? 1 : 0;
    }

    // --- Textures and views ---------------------------------------------------------------------

    // The texture's nri::Format.
    NRI_INTEROP_API int Nri_GetTextureFormat(nri::Texture* texture)
    {
        return (int)NRI.GetTextureDesc(*texture).format;
    }

    NRI_INTEROP_API const char* Nri_GetFormatName(int format)
    {
        return nri::nriGetFormatProps((nri::Format)format)->name;
    }

    // The sRGB format of an 8-bit RGBA or BGRA UNORM format (the swap chain's, whose views may be
    // sRGB), else the format itself.
    NRI_INTEROP_API int Nri_GetSrgbFormat(int format)
    {
        switch ((nri::Format)format)
        {
        case nri::Format::RGBA8_UNORM:
            return (int)nri::Format::RGBA8_SRGB;
        case nri::Format::BGRA8_UNORM:
            return (int)nri::Format::BGRA8_SRGB;
        default:
            return format;
        }
    }

    NRI_INTEROP_API nri::Descriptor* Nri_CreateColorAttachmentView(nri::Texture* texture, int format)
    {
        nri::Texture2DViewDesc desc = { texture, nri::Texture2DViewType::COLOR_ATTACHMENT, (nri::Format)format };
        nri::Descriptor* view = nullptr;
        NRI.CreateTexture2DView(desc, view);
        return view;
    }

    NRI_INTEROP_API void Nri_DestroyDescriptor(nri::Descriptor* descriptor)
    {
        NRI.DestroyDescriptor(descriptor);
    }

    // --- Buffers --------------------------------------------------------------------------------

    // A buffer of byteSize bytes in memory the CPU reads, bound to its memory.
    NRI_INTEROP_API nri::Buffer* Nri_CreateReadbackBuffer(nri::Device* device, int byteSize)
    {
        nri::BufferDesc bufferDesc = {};
        bufferDesc.size = (uint64_t)byteSize;
        nri::Buffer* buffer = nullptr;
        if (NRI.CreateBuffer(*device, bufferDesc, buffer) != nri::Result::SUCCESS)
            return nullptr;

        nri::ResourceGroupDesc group = {};
        group.memoryLocation = nri::MemoryLocation::HOST_READBACK;
        group.bufferNum = 1;
        group.buffers = &buffer;
        std::vector<nri::Memory*> memory(NRI.CalculateAllocationNumber(*device, group), nullptr);
        if (NRI.AllocateAndBindMemory(*device, group, memory.data()) != nri::Result::SUCCESS)
        {
            NRI.DestroyBuffer(buffer);
            return nullptr;
        }
        g_BufferMemory[buffer] = std::move(memory);
        return buffer;
    }

    // Destroys the buffer and frees its memory.
    NRI_INTEROP_API void Nri_DestroyBuffer(nri::Buffer* buffer)
    {
        NRI.DestroyBuffer(buffer);
        auto memory = g_BufferMemory.find(buffer);
        if (memory != g_BufferMemory.end())
        {
            for (nri::Memory* allocation : memory->second)
                NRI.FreeMemory(allocation);
            g_BufferMemory.erase(memory);
        }
    }

    // The pixels of an 8-bit RGBA or BGRA texture read back into the buffer (rowPitch bytes a row),
    // one int each with red in the low byte (0xAABBGGRR; BGRA swapped), row by row into dst
    // (pixelCount ints). 0 if the buffer can't be mapped or the format isn't one of those.
    NRI_INTEROP_API int Nri_ReadBufferRGBA8(nri::Buffer* buffer, int rowPitch, int width, int height, int format, int* dst, int pixelCount)
    {
        const nri::FormatProps* props = nri::nriGetFormatProps((nri::Format)format);
        if (props->stride != 4 || props->redBits != 8 || props->blueBits != 8 || pixelCount < width * height)
            return 0;
        const uint8_t* data = (const uint8_t*)NRI.MapBuffer(*buffer, 0, nri::WHOLE_SIZE);
        if (!data)
            return 0;
        for (int y = 0; y < height; y++)
        {
            const uint32_t* row = (const uint32_t*)(data + (size_t)y * rowPitch);
            for (int x = 0; x < width; x++)
            {
                uint32_t p = row[x];
                if (props->isBgr)
                    p = (p & 0xFF00FF00) | ((p & 0xFF) << 16) | ((p >> 16) & 0xFF);
                dst[y * width + x] = (int)p;
            }
        }
        NRI.UnmapBuffer(*buffer);
        return 1;
    }

    // --- Commands -------------------------------------------------------------------------------

    NRI_INTEROP_API nri::CommandAllocator* Nri_CreateCommandAllocator(nri::Queue* queue)
    {
        nri::CommandAllocator* allocator = nullptr;
        NRI.CreateCommandAllocator(*queue, allocator);
        return allocator;
    }

    NRI_INTEROP_API void Nri_DestroyCommandAllocator(nri::CommandAllocator* allocator)
    {
        NRI.DestroyCommandAllocator(allocator);
    }

    NRI_INTEROP_API void Nri_ResetCommandAllocator(nri::CommandAllocator* allocator)
    {
        NRI.ResetCommandAllocator(*allocator);
    }

    NRI_INTEROP_API nri::CommandBuffer* Nri_CreateCommandBuffer(nri::CommandAllocator* allocator)
    {
        nri::CommandBuffer* commandBuffer = nullptr;
        NRI.CreateCommandBuffer(*allocator, commandBuffer);
        return commandBuffer;
    }

    NRI_INTEROP_API void Nri_DestroyCommandBuffer(nri::CommandBuffer* commandBuffer)
    {
        NRI.DestroyCommandBuffer(commandBuffer);
    }

    // Without a descriptor pool (the examples bind no descriptor sets).
    NRI_INTEROP_API void Nri_BeginCommandBuffer(nri::CommandBuffer* commandBuffer)
    {
        NRI.BeginCommandBuffer(*commandBuffer, nullptr);
    }

    NRI_INTEROP_API void Nri_EndCommandBuffer(nri::CommandBuffer* commandBuffer)
    {
        NRI.EndCommandBuffer(*commandBuffer);
    }

    // Moves the whole texture from one NriTextureState to another.
    NRI_INTEROP_API void Nri_CmdTextureBarrier(nri::CommandBuffer* commandBuffer, nri::Texture* texture, int before, int after)
    {
        nri::TextureBarrierDesc textureBarrier = {};
        textureBarrier.texture = texture;
        textureBarrier.before = TextureState(before);
        textureBarrier.after = TextureState(after);

        nri::BarrierDesc barrierDesc = {};
        barrierDesc.textures = &textureBarrier;
        barrierDesc.textureNum = 1;
        NRI.CmdBarrier(*commandBuffer, barrierDesc);
    }

    // Renders into one color attachment, a view Nri_CreateColorAttachmentView made.
    NRI_INTEROP_API void Nri_CmdBeginRendering(nri::CommandBuffer* commandBuffer, nri::Descriptor* colorAttachment)
    {
        nri::AttachmentsDesc desc = {};
        desc.colors = &colorAttachment;
        desc.colorNum = 1;
        NRI.CmdBeginRendering(*commandBuffer, desc);
    }

    NRI_INTEROP_API void Nri_CmdEndRendering(nri::CommandBuffer* commandBuffer)
    {
        NRI.CmdEndRendering(*commandBuffer);
    }

    // Clears the whole color attachment (between Nri_CmdBeginRendering and Nri_CmdEndRendering).
    NRI_INTEROP_API void Nri_CmdClearColor(nri::CommandBuffer* commandBuffer, float r, float g, float b, float a)
    {
        nri::ClearDesc clearDesc = {};
        clearDesc.planes = nri::PlaneBits::COLOR;
        clearDesc.value.color.f = { r, g, b, a };
        NRI.CmdClearAttachments(*commandBuffer, &clearDesc, 1, nullptr, 0);
    }

    NRI_INTEROP_API void Nri_CmdSetViewport(nri::CommandBuffer* commandBuffer, float x, float y, float width, float height)
    {
        nri::Viewport viewport = { x, y, width, height, 0.0f, 1.0f };
        NRI.CmdSetViewports(*commandBuffer, &viewport, 1);
    }

    NRI_INTEROP_API void Nri_CmdSetScissor(nri::CommandBuffer* commandBuffer, int x, int y, int width, int height)
    {
        nri::Rect rect = { (int16_t)x, (int16_t)y, (nri::Dim_t)width, (nri::Dim_t)height };
        NRI.CmdSetScissors(*commandBuffer, &rect, 1);
    }

    NRI_INTEROP_API void Nri_CmdSetPipelineLayout(nri::CommandBuffer* commandBuffer, nri::PipelineLayout* pipelineLayout)
    {
        NRI.CmdSetPipelineLayout(*commandBuffer, nri::BindPoint::GRAPHICS, *pipelineLayout);
    }

    NRI_INTEROP_API void Nri_CmdSetPipeline(nri::CommandBuffer* commandBuffer, nri::Pipeline* pipeline)
    {
        NRI.CmdSetPipeline(*commandBuffer, *pipeline);
    }

    NRI_INTEROP_API void Nri_CmdDraw(nri::CommandBuffer* commandBuffer, int vertexNum, int instanceNum, int baseVertex, int baseInstance)
    {
        NRI.CmdDraw(*commandBuffer, { (uint32_t)vertexNum, (uint32_t)instanceNum, (uint32_t)baseVertex, (uint32_t)baseInstance });
    }

    // Dispatches x * y * z mesh shader workgroups (a device with NriFeature.MeshShader).
    NRI_INTEROP_API void Nri_CmdDrawMeshTasks(nri::CommandBuffer* commandBuffer, int x, int y, int z)
    {
        NRI.CmdDrawMeshTasks(*commandBuffer, { (uint32_t)x, (uint32_t)y, (uint32_t)z });
    }

    // Copies the texture's top left width x height pixels (mip 0, layer 0), in NriTextureState.CopySource,
    // into the buffer, rows rowPitch bytes apart (a multiple of Nri_GetUploadBufferTextureRowAlignment).
    NRI_INTEROP_API void Nri_CmdReadbackTextureToBuffer(nri::CommandBuffer* commandBuffer, nri::Buffer* buffer, int rowPitch,
        nri::Texture* texture, int width, int height)
    {
        nri::TextureDataLayoutDesc layout = {};
        layout.rowPitch = (uint32_t)rowPitch;
        nri::TextureRegionDesc region = {};
        region.width = (nri::Dim_t)width;
        region.height = (nri::Dim_t)height;
        region.depth = 1;
        region.planes = nri::PlaneBits::COLOR;
        NRI.CmdReadbackTextureToBuffer(*commandBuffer, *buffer, layout, *texture, region);
    }

    // --- Submission -----------------------------------------------------------------------------

    // Runs the command buffer once waitSemaphore (a swap chain's acquire) is signaled, the color
    // attachment stage waiting; signals signalSemaphore (the swap chain's release) when done.
    NRI_INTEROP_API void Nri_QueueSubmit(nri::Queue* queue, nri::CommandBuffer* commandBuffer, nri::Fence* waitSemaphore, nri::Fence* signalSemaphore)
    {
        nri::FenceSubmitDesc wait = {};
        wait.fence = waitSemaphore;
        wait.stages = nri::StageBits::COLOR_ATTACHMENT;
        nri::FenceSubmitDesc signal = {};
        signal.fence = signalSemaphore;

        nri::QueueSubmitDesc desc = {};
        desc.waitFences = &wait;
        desc.waitFenceNum = 1;
        desc.commandBuffers = &commandBuffer;
        desc.commandBufferNum = 1;
        desc.signalFences = &signal;
        desc.signalFenceNum = 1;
        NRI.QueueSubmit(*queue, desc);
    }

    // Signals the fence with value once the work submitted before is done.
    NRI_INTEROP_API void Nri_QueueSignal(nri::Queue* queue, nri::Fence* fence, int value)
    {
        nri::FenceSubmitDesc signal = {};
        signal.fence = fence;
        signal.value = (uint64_t)value;

        nri::QueueSubmitDesc desc = {};
        desc.signalFences = &signal;
        desc.signalFenceNum = 1;
        NRI.QueueSubmit(*queue, desc);
    }

    // --- Pipelines ------------------------------------------------------------------------------

    // A layout binding nothing, for the graphics stages (vertex or mesh, fragment).
    NRI_INTEROP_API nri::PipelineLayout* Nri_CreatePipelineLayout(nri::Device* device)
    {
        nri::PipelineLayoutDesc desc = {};
        desc.shaderStages = nri::StageBits::GRAPHICS_SHADERS;
        nri::PipelineLayout* pipelineLayout = nullptr;
        NRI.CreatePipelineLayout(*device, desc, pipelineLayout);
        return pipelineLayout;
    }

    NRI_INTEROP_API void Nri_DestroyPipelineLayout(nri::PipelineLayout* pipelineLayout)
    {
        NRI.DestroyPipelineLayout(pipelineLayout);
    }

    // A pipeline drawing triangles from no vertex buffer (the vertex shader makes the vertices), not
    // culled, into one color attachment of colorFormat, unblended. The shaders' bytecode is read from
    // vsPath and psPath, relative to the directory of the executable (of nri_interop's library under
    // the JIT: bin/), their entry points vsEntry and psEntry. Null on failure.
    NRI_INTEROP_API nri::Pipeline* Nri_CreateGraphicsPipeline(nri::Device* device, nri::PipelineLayout* pipelineLayout,
        const char* vsPath, const char* vsEntry, const char* psPath, const char* psEntry, int colorFormat)
    {
        return CreateGraphicsPipeline(device, pipelineLayout, nullptr, nullptr, nri::StageBits::VERTEX_SHADER, vsPath, vsEntry,
            psPath, psEntry, colorFormat);
    }

    // As Nri_CreateGraphicsPipeline, with a mesh shader (msPath, msEntry) making the triangles instead
    // of a vertex shader: no input assembly. Needs NriFeature.MeshShader.
    NRI_INTEROP_API nri::Pipeline* Nri_CreateMeshPipeline(nri::Device* device, nri::PipelineLayout* pipelineLayout,
        const char* msPath, const char* msEntry, const char* psPath, const char* psEntry, int colorFormat)
    {
        return CreateGraphicsPipeline(device, pipelineLayout, nullptr, nullptr, nri::StageBits::MESH_SHADER, msPath, msEntry,
            psPath, psEntry, colorFormat);
    }

    // As Nri_CreateMeshPipeline, with a task (amplification) shader (taskPath, taskEntry) launching
    // the mesh shader's workgroups.
    NRI_INTEROP_API nri::Pipeline* Nri_CreateTaskMeshPipeline(nri::Device* device, nri::PipelineLayout* pipelineLayout,
        const char* taskPath, const char* taskEntry, const char* msPath, const char* msEntry, const char* psPath, const char* psEntry,
        int colorFormat)
    {
        return CreateGraphicsPipeline(device, pipelineLayout, taskPath, taskEntry, nri::StageBits::MESH_SHADER, msPath, msEntry,
            psPath, psEntry, colorFormat);
    }

    NRI_INTEROP_API void Nri_DestroyPipeline(nri::Pipeline* pipeline)
    {
        NRI.DestroyPipeline(pipeline);
    }
}
