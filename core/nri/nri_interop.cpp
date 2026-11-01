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

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <deque>
#include <mutex>
#include <random>
#include <thread>
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

    // Held around every queue submission and present: the async compute loops' worker threads
    // (AsyncComputeLoop) submit to the compute queue while the render thread submits to the graphics
    // one.
    std::mutex g_QueueMutex;

    // The memory Nri_CreateReadbackBuffer and Nri_CreateUploadedBuffer bound to each buffer, freed
    // with it; Nri_CreateDepthTexture's to each texture.
    std::unordered_map<nri::Buffer*, std::vector<nri::Memory*>> g_BufferMemory;
    std::unordered_map<nri::Texture*, std::vector<nri::Memory*>> g_TextureMemory;

    // The values of nri_interop.d.ts' enums (NriFormat, NriCompareOp, NriTopology, ...).
    static_assert((int)nri::Format::BGRA8_UNORM == 9 && (int)nri::Format::BGRA8_SRGB == 10);
    static_assert((int)nri::Format::RGBA8_UNORM == 11 && (int)nri::Format::RGBA8_SRGB == 12);
    static_assert((int)nri::Format::R32_SFLOAT == 33 && (int)nri::Format::RG32_SFLOAT == 36);
    static_assert((int)nri::Format::RGB32_SFLOAT == 39 && (int)nri::Format::RGBA32_SFLOAT == 42);
    static_assert((int)nri::Format::D32_SFLOAT == 66 && (int)nri::Format::BC1_RGBA_UNORM == 50);
    static_assert((int)nri::CompareOp::NONE == 0 && (int)nri::CompareOp::ALWAYS == 1 && (int)nri::CompareOp::NEVER == 2);
    static_assert((int)nri::CompareOp::LESS == 5 && (int)nri::CompareOp::GREATER_EQUAL == 8);
    static_assert((int)nri::Topology::TRIANGLE_LIST == 3 && (int)nri::Topology::TRIANGLE_STRIP == 4);
    static_assert((int)nri::DescriptorType::SAMPLER == 0 && (int)nri::DescriptorType::CONSTANT_BUFFER == 1
        && (int)nri::DescriptorType::TEXTURE == 2);
    static_assert((int)nri::DescriptorType::STRUCTURED_BUFFER == 6 && (int)nri::DescriptorType::STORAGE_STRUCTURED_BUFFER == 7);
    static_assert((int)nri::StageBits::VERTEX_SHADER == 2 && (int)nri::StageBits::FRAGMENT_SHADER == 128);
    static_assert((int)nri::Filter::NEAREST == 0 && (int)nri::Filter::LINEAR == 1);
    static_assert((int)nri::AddressMode::REPEAT == 0 && (int)nri::AddressMode::CLAMP_TO_BORDER == 3);
    static_assert((int)Key::Space == 32);
    static_assert((int)nri::DescriptorRangeBits::PARTIALLY_BOUND == 1 && (int)nri::DescriptorRangeBits::ARRAY == 2
        && (int)nri::DescriptorRangeBits::VARIABLE_SIZED_ARRAY == 4 && (int)nri::DescriptorRangeBits::ALLOW_UPDATE_AFTER_SET == 8);
    static_assert((int)nri::IndexType::UINT16 == 0 && (int)nri::IndexType::UINT32 == 1);
    static_assert((int)nri::CullMode::NONE == 0 && (int)nri::CullMode::FRONT == 1 && (int)nri::CullMode::BACK == 2);
    static_assert((int)nri::StageBits::COMPUTE_SHADER == 1024 && (int)nri::DescriptorType::STORAGE_TEXTURE == 3);

    // What Nri_CreatePipelineFromDesc makes a graphics pipeline from: the shaders' bytecode and the
    // states the Nri_PipelineDesc* functions set.
    struct PipelineDesc
    {
        struct Shader
        {
            nri::StageBits stage;
            std::vector<uint8_t> bytecode;
            std::string entry;
        };
        std::vector<Shader> shaders;
        // The attributes' semantic names (their D3D names) are kept here.
        std::vector<std::string> semantics;
        // The vertex attributes, if any, each of its stream (bound to the slot of its number; the
        // stride is Nri_CmdSetVertexBuffer's).
        std::vector<nri::VertexAttributeDesc> attributes;
        nri::ColorAttachmentDesc color = { nri::Format::UNKNOWN, {}, {}, nri::ColorWriteBits::RGBA, false };
        nri::DepthAttachmentDesc depth = {};
        nri::Format depthFormat = nri::Format::UNKNOWN;
        nri::CullMode cullMode = nri::CullMode::NONE;
        nri::Topology topology = nri::Topology::TRIANGLE_LIST;
    };

    // What Nri_CreatePipelineLayoutFromDesc makes a layout from: descriptor sets 0, 1, ..., each
    // with its ranges, in the order Nri_PipelineLayoutDescAddRange added them.
    struct PipelineLayoutDesc
    {
        struct Set
        {
            uint32_t registerSpace = 0;
            std::vector<nri::DescriptorRangeDesc> ranges;
        };
        std::vector<Set> sets;
        // In register space 0 (NRI's rootRegisterSpace; on Vulkan, set 0).
        std::vector<nri::RootConstantDesc> rootConstants;
        std::vector<nri::RootDescriptorDesc> rootDescriptors;
        std::vector<nri::RootSamplerDesc> rootSamplers;
    };

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

    // A shader's bytecode, read from path: the file, or the one permutation in it when it's a
    // ShaderMake permutation blob ("NVSP", then per permutation its sizes, its defines and its
    // bytecode), as a .cfg line with -D compiles, for that line's defines.
    bool ReadShader(const std::string& path, std::vector<uint8_t>& data)
    {
        if (!ReadFile(path, data))
            return false;
        if (data.size() < 4 || memcmp(data.data(), "NVSP", 4) != 0)
            return true;
        struct Entry
        {
            uint32_t permutationSize;
            uint32_t dataSize;
        };
        size_t offset = 4;
        if (data.size() < offset + sizeof(Entry))
            return false;
        Entry entry;
        memcpy(&entry, data.data() + offset, sizeof(Entry));
        size_t start = offset + sizeof(Entry) + entry.permutationSize;
        if (data.size() < start + entry.dataSize || start + entry.dataSize != data.size())
        {
            printf("ERROR: %s holds more than one permutation\n", path.c_str());
            return false;
        }
        data = std::vector<uint8_t>(data.begin() + (ptrdiff_t)start, data.end());
        return true;
    }

    // NRI's messages (its validation layer's and the graphics API's) on the standard output, errors
    // with "ERROR" in them, as the tests look for.
    void NRI_CALL MessageCallback(nri::Message messageType, const char* file, uint32_t line, const char* message, void*)
    {
        const char* kind = messageType == nri::Message::ERROR ? "ERROR" : messageType == nri::Message::WARNING ? "WARNING" : "INFO";
        printf("NRI %s: %s (%s:%u)\n", kind, message, file, line);
        fflush(stdout);
    }

    // The states the examples' barriers move a buffer between (Nri_CmdBufferBarrier). Values of
    // NriBufferState in nri_interop.d.ts.
    nri::AccessStage BufferState(int state)
    {
        switch (state)
        {
        case 1:
            return { nri::AccessBits::SHADER_RESOURCE, nri::StageBits::VERTEX_SHADER };
        case 2:
            return { nri::AccessBits::COPY_SOURCE, nri::StageBits::COPY };
        default:
            return { nri::AccessBits::SHADER_RESOURCE_STORAGE, nri::StageBits::COMPUTE_SHADER };
        }
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
        case 4:
            // the write access alone (it reads too): D3D12's legacy barriers (no Agility SDK) take
            // read and write as DEPTH_READ | DEPTH_WRITE, an invalid combination
            return { nri::AccessBits::DEPTH_STENCIL_ATTACHMENT_WRITE, nri::Layout::DEPTH_STENCIL_ATTACHMENT,
                nri::StageBits::DEPTH_STENCIL_ATTACHMENT };
        case 5:
            return { nri::AccessBits::SHADER_RESOURCE, nri::Layout::SHADER_RESOURCE, nri::StageBits::FRAGMENT_SHADER };
        case 6:
            return { nri::AccessBits::SHADER_RESOURCE_STORAGE, nri::Layout::SHADER_RESOURCE_STORAGE, nri::StageBits::COMPUTE_SHADER };
        case 7:
            return { nri::AccessBits::SHADER_RESOURCE, nri::Layout::SHADER_RESOURCE,
                nri::StageBits::FRAGMENT_SHADER | nri::StageBits::COMPUTE_SHADER };
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
        if ((taskPath && !ReadShader(directory + taskPath, task)) || !ReadShader(directory + firstPath, first) || !ReadShader(directory + psPath, ps))
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

    // A width x height 2D texture (one mip) shaders read.
    nri::TextureDesc ShaderResourceTextureDesc(int width, int height, int format)
    {
        nri::TextureDesc desc = {};
        desc.type = nri::TextureType::TEXTURE_2D;
        desc.usage = nri::TextureUsageBits::SHADER_RESOURCE;
        desc.format = (nri::Format)format;
        desc.width = (nri::Dim_t)width;
        desc.height = (nri::Dim_t)height;
        return desc;
    }

    // The memory such a texture needs in device memory (from a texture made and destroyed).
    bool GetTextureMemoryDesc(nri::Device* device, int width, int height, int format, nri::MemoryDesc& memoryDesc)
    {
        nri::Texture* texture = nullptr;
        if (NRI.CreateTexture(*device, ShaderResourceTextureDesc(width, height, format), texture) != nri::Result::SUCCESS)
            return false;
        NRI.GetTextureMemoryDesc(*texture, nri::MemoryLocation::DEVICE, memoryDesc);
        NRI.DestroyTexture(texture);
        return true;
    }
}

namespace
{
    // A C++ worker thread that, at a fixed rate, takes a free texture, runs a compute pipeline over it
    // on the compute queue, and hands it to the render thread; the render thread hands back the
    // texture it stops showing (Nri_*AsyncCompute*). The compute queue waits for the graphics frame
    // that last used a texture, the graphics queue for the run that wrote it. Only C++ runs on the
    // worker: tslang code can't run on threads its GC doesn't know about. Textures stay in
    // NriTextureState.Storage while the compute queue has them; the render thread's command buffers
    // move them to ShaderResource and back.
    struct AsyncComputeLoop
    {
        struct Texture
        {
            int index = 0;
            nri::DescriptorSet* descriptorSet = nullptr;
            // The fence value of its last use (by the other queue).
            uint64_t lastUse = 0;
        };

        nri::Device* device = nullptr;
        nri::Queue* queue = nullptr;
        nri::Fence* graphicsFence = nullptr;
        nri::PipelineLayout* pipelineLayout = nullptr;
        nri::Pipeline* pipeline = nullptr;
        nri::DescriptorPool* descriptorPool = nullptr;
        uint32_t groupsX = 0;
        uint32_t groupsY = 0;
        std::chrono::microseconds interval{};

        nri::CommandAllocator* commandAllocator = nullptr;
        nri::CommandBuffer* commandBuffer = nullptr;
        // Signaled with the run count as each run finishes.
        nri::Fence* fence = nullptr;
        uint64_t fenceValue = 0;

        std::vector<nri::DescriptorSet*> descriptorSets;
        std::mutex mutex;
        std::deque<Texture> renderToCompute;
        std::deque<Texture> computeToRender;

        std::thread thread;
        std::atomic_bool terminate = false;

        ~AsyncComputeLoop()
        {
            Stop();
            // The graphics queue may wait on the fence too (Nri_AcquireAsyncComputeTexture).
            if (device)
                NRI.DeviceWaitIdle(device);
            if (commandBuffer)
                NRI.DestroyCommandBuffer(commandBuffer);
            if (commandAllocator)
                NRI.DestroyCommandAllocator(commandAllocator);
            if (fence)
                NRI.DestroyFence(fence);
        }

        void Stop()
        {
            terminate = true;
            if (thread.joinable())
                thread.join();
        }

        bool TryPop(std::deque<Texture>& queue, Texture& texture)
        {
            std::lock_guard lock(mutex);
            if (queue.empty())
                return false;
            texture = queue.front();
            queue.pop_front();
            return true;
        }

        void Push(std::deque<Texture>& queue, const Texture& texture)
        {
            std::lock_guard lock(mutex);
            queue.push_back(texture);
        }

        void ThreadProc()
        {
            uint32_t counter = 0;
            while (!terminate)
            {
                const auto nextTimePoint = std::chrono::steady_clock::now() + interval;

                Texture texture;
                while (!terminate && !TryPop(renderToCompute, texture))
                    std::this_thread::yield();
                if (terminate)
                    break;

                // The one command buffer: after the last run is done with it.
                NRI.Wait(*fence, fenceValue);
                NRI.ResetCommandAllocator(*commandAllocator);
                NRI.BeginCommandBuffer(*commandBuffer, descriptorPool);
                NRI.CmdSetPipelineLayout(*commandBuffer, nri::BindPoint::COMPUTE, *pipelineLayout);
                NRI.CmdSetPipeline(*commandBuffer, *pipeline);
                NRI.CmdSetDescriptorSet(*commandBuffer, { 0, texture.descriptorSet, nri::BindPoint::COMPUTE });
                NRI.CmdSetRootConstants(*commandBuffer, { 0, &counter, sizeof(counter), 0, nri::BindPoint::COMPUTE });
                NRI.CmdDispatch(*commandBuffer, { groupsX, groupsY, 1 });
                NRI.EndCommandBuffer(*commandBuffer);

                nri::FenceSubmitDesc wait = { graphicsFence, texture.lastUse, nri::StageBits::COMPUTE_SHADER };
                nri::FenceSubmitDesc signal = { fence, fenceValue + 1, nri::StageBits::ALL };
                nri::QueueSubmitDesc desc = {};
                desc.waitFences = &wait;
                desc.waitFenceNum = texture.lastUse > 0 ? 1 : 0;
                desc.commandBuffers = &commandBuffer;
                desc.commandBufferNum = 1;
                desc.signalFences = &signal;
                desc.signalFenceNum = 1;
                {
                    std::lock_guard lock(g_QueueMutex);
                    NRI.QueueSubmit(*queue, desc);
                }
                fenceValue++;

                texture.lastUse = fenceValue;
                Push(computeToRender, texture);

                counter++;
                std::this_thread::sleep_until(nextTimePoint);
            }
        }
    };
}

// NRIFramework's application, its virtual methods calling TypeScript.
class TsSample : public SampleBase
{
public:
    Callback<InitializeFn> m_Initialize;
    Callback<FrameFn> m_LatencySleep;
    Callback<FrameFn> m_RenderFrame;
    bool m_Test = false;
    // The example's own options (Nri_AddExampleOption), which NRIFramework's parser isn't given.
    std::vector<std::string> m_ExampleOptions;

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
    GLFWwindow* Window() const { return m_Window; }
    float FrameTime() const { return m_Timer.GetFrameTime(); }
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
            // which NRIFramework's parser rejects, and the example's options
            else if (arg != "--" && std::find(sample->m_ExampleOptions.begin(), sample->m_ExampleOptions.end(), arg) == sample->m_ExampleOptions.end())
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

    // An option of the example's (a flag it reads with Nri_GetArg), which Nri_RunSample leaves out of
    // NRIFramework's command line; before Nri_RunSample.
    NRI_INTEROP_API void Nri_AddExampleOption(TsSample* sample, const char* option)
    {
        sample->m_ExampleOptions.push_back(option);
    }

    // The command line's argument index (main's argv), "" past its end.
    NRI_INTEROP_API const char* Nri_GetArg(int argc, const char* const* argv, int index)
    {
        return index >= 0 && index < argc ? argv[index] : "";
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
    // 1 if the key (an NriKey: GLFW's key code) was pressed since the last call, else 0.
    NRI_INTEROP_API int Nri_IsKeyToggled(TsSample* sample, int key)
    {
        return key >= 0 && key < (int)Key::NUM && sample->IsKeyToggled((Key)key) ? 1 : 0;
    }

    // The last frame's duration, in seconds (NRIFramework's timer).
    NRI_INTEROP_API double Nri_GetFrameTime(TsSample* sample)
    {
        return sample->FrameTime() / 1000.0;
    }

    // 1 if the mouse button (0 left, 1 right, 2 middle) is down, else 0.
    NRI_INTEROP_API int Nri_IsButtonPressed(TsSample* sample, int button)
    {
        return button >= 0 && button < (int)Button::NUM && sample->IsButtonPressed((Button)button) ? 1 : 0;
    }

    // How far the mouse moved since the last frame, in pixels (x right, y down).
    NRI_INTEROP_API double Nri_GetMouseDeltaX(TsSample* sample)
    {
        return sample->GetMouseDelta().x;
    }

    NRI_INTEROP_API double Nri_GetMouseDeltaY(TsSample* sample)
    {
        return sample->GetMouseDelta().y;
    }

    // The mouse wheel's turn this frame.
    NRI_INTEROP_API double Nri_GetMouseWheel(TsSample* sample)
    {
        return sample->GetMouseWheel();
    }

    // 1 if the key (a GLFW key code: NriKey, or Donut's Key) is down, else 0.
    NRI_INTEROP_API int Nri_IsKeyPressed(TsSample* sample, int key)
    {
        return key >= 0 && key < (int)Key::NUM && sample->IsKeyPressed((Key)key) ? 1 : 0;
    }

    NRI_INTEROP_API void Nri_SetWindowTitle(TsSample* sample, const char* title)
    {
        if (sample->Window())
            glfwSetWindowTitle(sample->Window(), title);
    }

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
        // The register shifts the examples' SPIR-V is compiled with (Donut's compileshaders.cmake:
        // t 0, s 128, b 256, u 384), not NRIFramework's.
        desc.vkBindingOffsets = { 128, 0, 256, 384 };
        desc.adapterDesc = &adapterDescs[std::min(sample->AdapterIndex(), adapterDescNum - 1)];
        desc.allocationCallbacks = sample->AllocationCallbacks();
        desc.callbackInterface.MessageCallback = MessageCallback;
        // A graphics queue and a compute queue (Nri_GetComputeQueue).
        nri::QueueFamilyDesc queueFamilies[] = { { nullptr, 1, nri::QueueType::GRAPHICS }, { nullptr, 1, nri::QueueType::COMPUTE } };
        desc.queueFamilies = queueFamilies;
        desc.queueFamilyNum = helper::GetCountOf(queueFamilies);

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
        case 1:
            return desc.features.depthBoundsTest ? 1 : 0;
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

    // The device's compute queue, null if it has none.
    NRI_INTEROP_API nri::Queue* Nri_GetComputeQueue(nri::Device* device)
    {
        nri::Queue* queue = nullptr;
        if (NRI.GetQueue(*device, nri::QueueType::COMPUTE, 0, queue) != nri::Result::SUCCESS)
            return nullptr;
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
        std::lock_guard lock(g_QueueMutex);
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

    NRI_INTEROP_API nri::Descriptor* Nri_CreateDepthAttachmentView(nri::Texture* texture, int format)
    {
        nri::Texture2DViewDesc desc = { texture, nri::Texture2DViewType::DEPTH_STENCIL_ATTACHMENT, (nri::Format)format };
        nri::Descriptor* view = nullptr;
        NRI.CreateTexture2DView(desc, view);
        return view;
    }

    NRI_INTEROP_API void Nri_DestroyDescriptor(nri::Descriptor* descriptor)
    {
        NRI.DestroyDescriptor(descriptor);
    }

    NRI_INTEROP_API void Nri_DestroyTexture(nri::Texture* texture);

    // A width x height depth texture in device memory, bound to it and moved on the queue (which
    // this waits for) to NriTextureState.DepthAttachment, where it stays; null on failure.
    NRI_INTEROP_API nri::Texture* Nri_CreateDepthTexture(nri::Device* device, nri::Queue* queue, int width, int height, int format)
    {
        nri::TextureDesc textureDesc = {};
        textureDesc.type = nri::TextureType::TEXTURE_2D;
        textureDesc.usage = nri::TextureUsageBits::DEPTH_STENCIL_ATTACHMENT;
        textureDesc.format = (nri::Format)format;
        textureDesc.width = (nri::Dim_t)width;
        textureDesc.height = (nri::Dim_t)height;
        nri::Texture* texture = nullptr;
        if (NRI.CreateTexture(*device, textureDesc, texture) != nri::Result::SUCCESS)
            return nullptr;

        nri::ResourceGroupDesc group = {};
        group.memoryLocation = nri::MemoryLocation::DEVICE;
        group.textureNum = 1;
        group.textures = &texture;
        std::vector<nri::Memory*> memory(NRI.CalculateAllocationNumber(*device, group), nullptr);
        if (NRI.AllocateAndBindMemory(*device, group, memory.data()) != nri::Result::SUCCESS)
        {
            NRI.DestroyTexture(texture);
            return nullptr;
        }
        g_TextureMemory[texture] = std::move(memory);

        // No data: the layout alone (as NRISamples do), which D3D12's legacy barriers track from
        // the texture's initial state.
        nri::TextureUploadDesc upload = {};
        upload.texture = texture;
        upload.after = TextureState(4);
        upload.planes = nri::PlaneBits::DEPTH;
        if (NRI.UploadData(*queue, &upload, 1, nullptr, 0) != nri::Result::SUCCESS)
        {
            Nri_DestroyTexture(texture);
            return nullptr;
        }
        return texture;
    }

    // Destroys a texture Nri_CreateDepthTexture made and frees its memory.
    NRI_INTEROP_API void Nri_DestroyTexture(nri::Texture* texture)
    {
        NRI.DestroyTexture(texture);
        auto memory = g_TextureMemory.find(texture);
        if (memory != g_TextureMemory.end())
        {
            for (nri::Memory* allocation : memory->second)
                NRI.FreeMemory(allocation);
            g_TextureMemory.erase(memory);
        }
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

    NRI_INTEROP_API void Nri_DestroyBuffer(nri::Buffer* buffer);

    // A buffer of byteSize bytes in device memory, filled with data (byteSize bytes) on the queue
    // (waiting until it's done) and left in the state of usage, an NriBufferUsage: 0, a vertex
    // buffer; 1, an index buffer. Null on failure.
    NRI_INTEROP_API nri::Buffer* Nri_CreateUploadedBuffer(nri::Device* device, nri::Queue* queue, const void* data, int byteSize, int usage)
    {
        nri::BufferDesc bufferDesc = {};
        bufferDesc.size = (uint64_t)byteSize;
        nri::AccessStage after = {};
        switch (usage)
        {
        case 0:
            bufferDesc.usage = nri::BufferUsageBits::VERTEX_BUFFER;
            after = { nri::AccessBits::VERTEX_BUFFER, nri::StageBits::VERTEX_SHADER };
            break;
        case 1:
            bufferDesc.usage = nri::BufferUsageBits::INDEX_BUFFER;
            after = { nri::AccessBits::INDEX_BUFFER, nri::StageBits::INDEX_INPUT };
            break;
        default:
            return nullptr;
        }
        nri::Buffer* buffer = nullptr;
        if (NRI.CreateBuffer(*device, bufferDesc, buffer) != nri::Result::SUCCESS)
            return nullptr;

        nri::ResourceGroupDesc group = {};
        group.memoryLocation = nri::MemoryLocation::DEVICE;
        group.bufferNum = 1;
        group.buffers = &buffer;
        std::vector<nri::Memory*> memory(NRI.CalculateAllocationNumber(*device, group), nullptr);
        if (NRI.AllocateAndBindMemory(*device, group, memory.data()) != nri::Result::SUCCESS)
        {
            NRI.DestroyBuffer(buffer);
            return nullptr;
        }
        g_BufferMemory[buffer] = std::move(memory);

        nri::BufferUploadDesc upload = { data, buffer, after };
        if (NRI.UploadData(*queue, nullptr, 0, &upload, 1) != nri::Result::SUCCESS)
        {
            Nri_DestroyBuffer(buffer);
            return nullptr;
        }
        return buffer;
    }

    // Nri_CreateUploadedBuffer from ints (index data).
    NRI_INTEROP_API nri::Buffer* Nri_CreateUploadedBufferFromInts(nri::Device* device, nri::Queue* queue, const int* data, int byteSize, int usage)
    {
        return Nri_CreateUploadedBuffer(device, queue, data, byteSize, usage);
    }

    // A buffer of byteSize bytes in memory the CPU writes (Nri_WriteBuffer) and the GPU reads, for
    // usage (an NriBufferUsage: 2, constant buffers); null on failure.
    NRI_INTEROP_API nri::Buffer* Nri_CreateHostBuffer(nri::Device* device, int byteSize, int usage)
    {
        nri::BufferDesc bufferDesc = {};
        bufferDesc.size = (uint64_t)byteSize;
        switch (usage)
        {
        case 2:
            bufferDesc.usage = nri::BufferUsageBits::CONSTANT_BUFFER;
            break;
        default:
            return nullptr;
        }
        nri::Buffer* buffer = nullptr;
        if (NRI.CreateBuffer(*device, bufferDesc, buffer) != nri::Result::SUCCESS)
            return nullptr;

        nri::ResourceGroupDesc group = {};
        group.memoryLocation = nri::MemoryLocation::HOST_UPLOAD;
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

    // Copies byteSize bytes of data into the buffer (Nri_CreateHostBuffer's) at offset; 0 if it can't
    // be mapped.
    NRI_INTEROP_API int Nri_WriteBuffer(nri::Buffer* buffer, int offset, const void* data, int byteSize)
    {
        void* mapped = NRI.MapBuffer(*buffer, (uint64_t)offset, (uint64_t)byteSize);
        if (!mapped)
            return 0;
        memcpy(mapped, data, (size_t)byteSize);
        NRI.UnmapBuffer(*buffer);
        return 1;
    }

    // A buffer of byteSize bytes of structures stride bytes each in device memory, which compute
    // shaders write (RWStructuredBuffer) and shaders read (StructuredBuffer), with data uploaded on
    // the queue (which this waits for), then in NriBufferState.Storage; null on failure.
    NRI_INTEROP_API nri::Buffer* Nri_CreateStorageBuffer(nri::Device* device, nri::Queue* queue, const void* data, int byteSize, int stride)
    {
        nri::BufferDesc bufferDesc = {};
        bufferDesc.size = (uint64_t)byteSize;
        bufferDesc.structureStride = (uint32_t)stride;
        bufferDesc.usage = nri::BufferUsageBits::SHADER_RESOURCE | nri::BufferUsageBits::SHADER_RESOURCE_STORAGE;
        nri::Buffer* buffer = nullptr;
        if (NRI.CreateBuffer(*device, bufferDesc, buffer) != nri::Result::SUCCESS)
            return nullptr;

        nri::ResourceGroupDesc group = {};
        group.memoryLocation = nri::MemoryLocation::DEVICE;
        group.bufferNum = 1;
        group.buffers = &buffer;
        std::vector<nri::Memory*> memory(NRI.CalculateAllocationNumber(*device, group), nullptr);
        if (NRI.AllocateAndBindMemory(*device, group, memory.data()) != nri::Result::SUCCESS)
        {
            NRI.DestroyBuffer(buffer);
            return nullptr;
        }
        g_BufferMemory[buffer] = std::move(memory);

        nri::BufferUploadDesc upload = { data, buffer, BufferState(0) };
        if (NRI.UploadData(*queue, nullptr, 0, &upload, 1) != nri::Result::SUCCESS)
        {
            Nri_DestroyBuffer(buffer);
            return nullptr;
        }
        return buffer;
    }

    // A view of the whole buffer (Nri_CreateStorageBuffer's) as structures: written by compute
    // shaders (storage, 1: RWStructuredBuffer) or read (0: StructuredBuffer); null on failure.
    NRI_INTEROP_API nri::Descriptor* Nri_CreateStructuredBufferView(nri::Buffer* buffer, int storage)
    {
        nri::BufferViewDesc desc = {};
        desc.buffer = buffer;
        desc.viewType = storage != 0 ? nri::BufferViewType::SHADER_RESOURCE_STORAGE : nri::BufferViewType::SHADER_RESOURCE;
        // the size and stride given (NRI's D3D11 views take neither WHOLE_SIZE nor the buffer's stride)
        const nri::BufferDesc& bufferDesc = NRI.GetBufferDesc(*buffer);
        desc.size = bufferDesc.size;
        desc.structureStride = bufferDesc.structureStride;
        nri::Descriptor* view = nullptr;
        if (NRI.CreateBufferView(desc, view) != nri::Result::SUCCESS)
            return nullptr;
        return view;
    }

    // A view of byteSize bytes of the buffer from offset, as a constant buffer.
    NRI_INTEROP_API nri::Descriptor* Nri_CreateConstantBufferView(nri::Buffer* buffer, int offset, int byteSize)
    {
        nri::BufferViewDesc desc = {};
        desc.buffer = buffer;
        desc.viewType = nri::BufferViewType::CONSTANT;
        desc.offset = (uint64_t)offset;
        desc.size = (uint64_t)byteSize;
        nri::Descriptor* view = nullptr;
        if (NRI.CreateBufferView(desc, view) != nri::Result::SUCCESS)
            return nullptr;
        return view;
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
    // Copies count floats from the start of the buffer (a readback buffer, after the GPU wrote it)
    // to dst; 1, or 0 if it can't be read.
    NRI_INTEROP_API int Nri_ReadBufferFloats(nri::Buffer* buffer, float* dst, int count)
    {
        const float* data = (const float*)NRI.MapBuffer(*buffer, 0, nri::WHOLE_SIZE);
        if (!data)
            return 0;
        memcpy(dst, data, (size_t)count * sizeof(float));
        NRI.UnmapBuffer(*buffer);
        return 1;
    }

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
    // Copies byteSize bytes from the start of src (in NriBufferState.CopySource) to the start of dst
    // (e.g. a readback buffer).
    NRI_INTEROP_API void Nri_CmdCopyBuffer(nri::CommandBuffer* commandBuffer, nri::Buffer* dst, nri::Buffer* src, int byteSize)
    {
        NRI.CmdCopyBuffer(*commandBuffer, *dst, 0, *src, 0, (uint64_t)byteSize);
    }

    // A barrier moving the buffer from the state before to after (NriBufferState values); from
    // Storage to Storage, the writes before are seen by the accesses after.
    NRI_INTEROP_API void Nri_CmdBufferBarrier(nri::CommandBuffer* commandBuffer, nri::Buffer* buffer, int before, int after)
    {
        nri::BufferBarrierDesc bufferBarrier = {};
        bufferBarrier.buffer = buffer;
        bufferBarrier.before = BufferState(before);
        bufferBarrier.after = BufferState(after);

        nri::BarrierDesc barrierDesc = {};
        barrierDesc.buffers = &bufferBarrier;
        barrierDesc.bufferNum = 1;
        NRI.CmdBarrier(*commandBuffer, barrierDesc);
    }

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

    // Renders into one color attachment and a depth attachment (a view Nri_CreateDepthAttachmentView
    // made).
    NRI_INTEROP_API void Nri_CmdBeginRenderingWithDepth(nri::CommandBuffer* commandBuffer, nri::Descriptor* colorAttachment,
        nri::Descriptor* depthAttachment)
    {
        nri::AttachmentsDesc desc = {};
        desc.colors = &colorAttachment;
        desc.colorNum = 1;
        desc.depthStencil = depthAttachment;
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

    // Clears the whole depth attachment to depth (after Nri_CmdBeginRenderingWithDepth).
    NRI_INTEROP_API void Nri_CmdClearDepth(nri::CommandBuffer* commandBuffer, float depth)
    {
        nri::ClearDesc clearDesc = {};
        clearDesc.planes = nri::PlaneBits::DEPTH;
        clearDesc.value.depthStencil.depth = depth;
        NRI.CmdClearAttachments(*commandBuffer, &clearDesc, 1, nullptr, 0);
    }

    // Binds a vertex buffer from offset bytes in, its vertices stride bytes apart, to stream slot.
    NRI_INTEROP_API void Nri_CmdSetVertexBuffer(nri::CommandBuffer* commandBuffer, int slot, nri::Buffer* buffer, int offset, int stride)
    {
        nri::VertexBufferDesc desc = { buffer, (uint64_t)offset, (uint32_t)stride };
        NRI.CmdSetVertexBuffers(*commandBuffer, (uint32_t)slot, &desc, 1);
    }

    // The depth bounds test's range (NriFeature.DepthBoundsTest; a pipeline with the test on).
    NRI_INTEROP_API void Nri_CmdSetDepthBounds(nri::CommandBuffer* commandBuffer, float boundsMin, float boundsMax)
    {
        NRI.CmdSetDepthBounds(*commandBuffer, boundsMin, boundsMax);
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

    // The descriptor pool the command buffer's descriptor sets come from.
    NRI_INTEROP_API void Nri_CmdSetDescriptorPool(nri::CommandBuffer* commandBuffer, nri::DescriptorPool* descriptorPool)
    {
        NRI.CmdSetDescriptorPool(*commandBuffer, *descriptorPool);
    }

    // Binds a descriptor set (of the graphics pipeline layout's set setIndex) as set setIndex.
    NRI_INTEROP_API void Nri_CmdSetDescriptorSet(nri::CommandBuffer* commandBuffer, int setIndex, nri::DescriptorSet* descriptorSet)
    {
        nri::SetDescriptorSetDesc desc = { (uint32_t)setIndex, descriptorSet, nri::BindPoint::GRAPHICS };
        NRI.CmdSetDescriptorSet(*commandBuffer, desc);
    }

    NRI_INTEROP_API void Nri_CmdSetPipeline(nri::CommandBuffer* commandBuffer, nri::Pipeline* pipeline)
    {
        NRI.CmdSetPipeline(*commandBuffer, *pipeline);
    }

    NRI_INTEROP_API void Nri_CmdDraw(nri::CommandBuffer* commandBuffer, int vertexNum, int instanceNum, int baseVertex, int baseInstance)
    {
        NRI.CmdDraw(*commandBuffer, { (uint32_t)vertexNum, (uint32_t)instanceNum, (uint32_t)baseVertex, (uint32_t)baseInstance });
    }

    // The compute bind point's Nri_CmdSetPipelineLayout, Nri_CmdSetDescriptorSet,
    // Nri_CmdSetRootDescriptor (no offset) and Nri_CmdSetRootConstants (for Nri_CmdDispatch).
    NRI_INTEROP_API void Nri_CmdSetComputePipelineLayout(nri::CommandBuffer* commandBuffer, nri::PipelineLayout* pipelineLayout)
    {
        NRI.CmdSetPipelineLayout(*commandBuffer, nri::BindPoint::COMPUTE, *pipelineLayout);
    }

    NRI_INTEROP_API void Nri_CmdSetComputeDescriptorSet(nri::CommandBuffer* commandBuffer, int setIndex, nri::DescriptorSet* descriptorSet)
    {
        nri::SetDescriptorSetDesc desc = { (uint32_t)setIndex, descriptorSet, nri::BindPoint::COMPUTE };
        NRI.CmdSetDescriptorSet(*commandBuffer, desc);
    }

    NRI_INTEROP_API void Nri_CmdSetComputeRootDescriptor(nri::CommandBuffer* commandBuffer, int rootDescriptorIndex, nri::Descriptor* descriptor)
    {
        nri::SetRootDescriptorDesc desc = { (uint32_t)rootDescriptorIndex, descriptor, 0, nri::BindPoint::COMPUTE };
        NRI.CmdSetRootDescriptor(*commandBuffer, desc);
    }

    NRI_INTEROP_API void Nri_CmdSetComputeRootConstants(nri::CommandBuffer* commandBuffer, int rootConstantIndex, const void* data, int size)
    {
        nri::SetRootConstantsDesc desc = { (uint32_t)rootConstantIndex, data, (uint32_t)size, 0, nri::BindPoint::COMPUTE };
        NRI.CmdSetRootConstants(*commandBuffer, desc);
    }

    // Dispatches x * y * z groups of the compute pipeline set.
    NRI_INTEROP_API void Nri_CmdDispatch(nri::CommandBuffer* commandBuffer, int x, int y, int z)
    {
        NRI.CmdDispatch(*commandBuffer, { (uint32_t)x, (uint32_t)y, (uint32_t)z });
    }

    // Binds an index buffer from offset bytes in, of 16- or 32-bit indices (an NriIndexType).
    NRI_INTEROP_API void Nri_CmdSetIndexBuffer(nri::CommandBuffer* commandBuffer, nri::Buffer* buffer, int offset, int indexType)
    {
        NRI.CmdSetIndexBuffer(*commandBuffer, *buffer, (uint64_t)offset, (nri::IndexType)indexType);
    }

    NRI_INTEROP_API void Nri_CmdDrawIndexed(nri::CommandBuffer* commandBuffer, int indexNum, int instanceNum, int baseIndex, int baseVertex,
        int baseInstance)
    {
        NRI.CmdDrawIndexed(*commandBuffer, { (uint32_t)indexNum, (uint32_t)instanceNum, (uint32_t)baseIndex, (int32_t)baseVertex,
            (uint32_t)baseInstance });
    }

    // Sets the graphics layout's root constants rootConstantIndex (in the order the layout added
    // them) to size bytes of data.
    NRI_INTEROP_API void Nri_CmdSetRootConstants(nri::CommandBuffer* commandBuffer, int rootConstantIndex, const void* data, int size)
    {
        nri::SetRootConstantsDesc desc = { (uint32_t)rootConstantIndex, data, (uint32_t)size, 0, nri::BindPoint::GRAPHICS };
        NRI.CmdSetRootConstants(*commandBuffer, desc);
    }

    // Binds a view (Nri_CreateConstantBufferView's) as the graphics layout's root descriptor
    // rootDescriptorIndex (in the order the layout added them), offset bytes further into its buffer
    // (a multiple of 256).
    NRI_INTEROP_API void Nri_CmdSetRootDescriptor(nri::CommandBuffer* commandBuffer, int rootDescriptorIndex, nri::Descriptor* descriptor,
        int offset)
    {
        nri::SetRootDescriptorDesc desc = { (uint32_t)rootDescriptorIndex, descriptor, (uint32_t)offset, nri::BindPoint::GRAPHICS };
        NRI.CmdSetRootDescriptor(*commandBuffer, desc);
    }

    // Stores value's bits in a float slot (Ref of an f32 array element): an int field of root
    // constants kept in an f32 array.
    NRI_INTEROP_API void Nri_StoreInt32(float* dst, int value)
    {
        memcpy(dst, &value, sizeof(value));
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
        std::lock_guard lock(g_QueueMutex);
        NRI.QueueSubmit(*queue, desc);
    }

    // Makes the work submitted to the queue from now on wait until the fence reaches value (on the
    // GPU; e.g. another queue's).
    NRI_INTEROP_API void Nri_QueueWait(nri::Queue* queue, nri::Fence* fence, int value)
    {
        nri::FenceSubmitDesc wait = {};
        wait.fence = fence;
        wait.value = (uint64_t)value;
        wait.stages = nri::StageBits::ALL;

        nri::QueueSubmitDesc desc = {};
        desc.waitFences = &wait;
        desc.waitFenceNum = 1;
        std::lock_guard lock(g_QueueMutex);
        NRI.QueueSubmit(*queue, desc);
    }

    // Runs the command buffer once waitFence (if not null) reaches waitValue (e.g. another queue's
    // timeline), and signals signalFence with signalValue when done: one submission.
    NRI_INTEROP_API void Nri_QueueSubmitWithFences(nri::Queue* queue, nri::CommandBuffer* commandBuffer, nri::Fence* waitFence, int waitValue,
        nri::Fence* signalFence, int signalValue)
    {
        nri::FenceSubmitDesc wait = {};
        wait.fence = waitFence;
        wait.value = (uint64_t)waitValue;
        wait.stages = nri::StageBits::ALL;
        nri::FenceSubmitDesc signal = {};
        signal.fence = signalFence;
        signal.value = (uint64_t)signalValue;

        nri::QueueSubmitDesc desc = {};
        desc.waitFences = &wait;
        desc.waitFenceNum = waitFence ? 1 : 0;
        desc.commandBuffers = &commandBuffer;
        desc.commandBufferNum = 1;
        desc.signalFences = &signal;
        desc.signalFenceNum = 1;
        std::lock_guard lock(g_QueueMutex);
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
        std::lock_guard lock(g_QueueMutex);
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

    // --- Pipeline descs: a graphics pipeline's shaders and states, set one by one ----------------

    // Triangles, not culled, no vertex input, no color attachment, no depth: what the setters change.
    NRI_INTEROP_API PipelineDesc* Nri_CreatePipelineDesc()
    {
        return new PipelineDesc();
    }

    NRI_INTEROP_API void Nri_DestroyPipelineDesc(PipelineDesc* desc)
    {
        delete desc;
    }

    // Adds the shader of stage (an NriShaderStage) read from path (as Nri_CreateGraphicsPipeline's);
    // 0 if it can't be read.
    NRI_INTEROP_API int Nri_PipelineDescAddShader(PipelineDesc* desc, int stage, const char* path, const char* entry)
    {
        static const nri::StageBits stages[] = { nri::StageBits::VERTEX_SHADER, nri::StageBits::FRAGMENT_SHADER,
            nri::StageBits::MESH_SHADER, nri::StageBits::TASK_SHADER };
        if (stage < 0 || stage >= (int)helper::GetCountOf(stages))
            return 0;
        PipelineDesc::Shader shader = { stages[stage], {}, entry };
        if (!ReadShader(LibraryDirectory() + path, shader.bytecode))
            return 0;
        desc->shaders.push_back(std::move(shader));
        return 1;
    }

    // An attribute of stream's vertices (the vertex buffer bound to slot stream): semantic (index
    // 0) on D3D, the next location on Vulkan (as DXC numbers the vertex shader's inputs), format at
    // offset bytes in the vertex.
    NRI_INTEROP_API void Nri_PipelineDescAddVertexAttributeFromStream(PipelineDesc* desc, const char* semantic, int format, int offset,
        int stream)
    {
        nri::VertexAttributeDesc attribute = {};
        attribute.vk.location = (uint32_t)desc->attributes.size();
        attribute.offset = (uint32_t)offset;
        attribute.format = (nri::Format)format;
        attribute.streamIndex = (uint16_t)stream;
        desc->semantics.push_back(semantic);
        desc->attributes.push_back(attribute);
    }

    // An attribute of stream 0's vertices (Nri_PipelineDescAddVertexAttributeFromStream).
    NRI_INTEROP_API void Nri_PipelineDescAddVertexAttribute(PipelineDesc* desc, const char* semantic, int format, int offset)
    {
        Nri_PipelineDescAddVertexAttributeFromStream(desc, semantic, format, offset, 0);
    }

    // The faces culled (an NriCullMode; NONE by default), clockwise ones the front.
    NRI_INTEROP_API void Nri_PipelineDescSetCullMode(PipelineDesc* desc, int cullMode)
    {
        desc->cullMode = (nri::CullMode)cullMode;
    }

    // The color attachment's format and the channels written (NriColorWrite bits).
    NRI_INTEROP_API void Nri_PipelineDescSetColor(PipelineDesc* desc, int format, int writeMask)
    {
        desc->color.format = (nri::Format)format;
        desc->color.colorWriteMask = (nri::ColorWriteBits)writeMask;
    }

    // Additive blending into the color attachment, as Donut's BlendMode.Additive: color one + one,
    // alpha srcAlpha + dstAlpha.
    NRI_INTEROP_API void Nri_PipelineDescSetAdditiveBlend(PipelineDesc* desc)
    {
        desc->color.blendEnabled = true;
        desc->color.colorBlend = { nri::BlendFactor::ONE, nri::BlendFactor::ONE, nri::BlendOp::ADD };
        desc->color.alphaBlend = { nri::BlendFactor::SRC_ALPHA, nri::BlendFactor::DST_ALPHA, nri::BlendOp::ADD };
    }

    // The depth attachment's format and its test (an NriCompareOp, NONE: off), whether it's written,
    // and whether the depth bounds test is on (NriFeature.DepthBoundsTest, Nri_CmdSetDepthBounds).
    NRI_INTEROP_API void Nri_PipelineDescSetDepth(PipelineDesc* desc, int format, int compareOp, int write, int boundsTest)
    {
        desc->depthFormat = (nri::Format)format;
        desc->depth.compareOp = (nri::CompareOp)compareOp;
        desc->depth.write = write != 0;
        desc->depth.boundsTest = boundsTest != 0;
    }

    // The primitive topology (an NriTopology).
    NRI_INTEROP_API void Nri_PipelineDescSetTopology(PipelineDesc* desc, int topology)
    {
        desc->topology = (nri::Topology)topology;
    }

    // The pipeline the desc describes, with the layout; null on failure.
    NRI_INTEROP_API nri::Pipeline* Nri_CreatePipelineFromDesc(nri::Device* device, nri::PipelineLayout* pipelineLayout, PipelineDesc* desc)
    {
        std::vector<nri::ShaderDesc> shaders;
        for (const PipelineDesc::Shader& shader : desc->shaders)
            shaders.push_back({ shader.stage, shader.bytecode.data(), shader.bytecode.size(), shader.entry.c_str() });

        // Streams 0 to the attributes' last, stream i bound to slot i.
        uint16_t streamNum = 1;
        for (size_t i = 0; i < desc->attributes.size(); i++)
        {
            desc->attributes[i].d3d.semanticName = desc->semantics[i].c_str();
            streamNum = std::max(streamNum, (uint16_t)(desc->attributes[i].streamIndex + 1));
        }
        std::vector<nri::VertexStreamDesc> streams;
        for (uint16_t i = 0; i < streamNum; i++)
            streams.push_back({ i, nri::VertexStreamStepRate::PER_VERTEX });
        nri::VertexInputDesc vertexInput = {};
        vertexInput.attributes = desc->attributes.data();
        vertexInput.attributeNum = (uint8_t)desc->attributes.size();
        vertexInput.streams = streams.data();
        vertexInput.streamNum = (uint8_t)streams.size();

        nri::GraphicsPipelineDesc pipelineDesc = {};
        pipelineDesc.pipelineLayout = pipelineLayout;
        if (!desc->attributes.empty())
            pipelineDesc.vertexInput = &vertexInput;
        pipelineDesc.inputAssembly.topology = desc->topology;
        pipelineDesc.rasterization.fillMode = nri::FillMode::SOLID;
        pipelineDesc.rasterization.cullMode = desc->cullMode;
        if (desc->color.format != nri::Format::UNKNOWN)
        {
            pipelineDesc.outputMerger.colors = &desc->color;
            pipelineDesc.outputMerger.colorNum = 1;
        }
        pipelineDesc.outputMerger.depth = desc->depth;
        pipelineDesc.outputMerger.depthStencilFormat = desc->depthFormat;
        pipelineDesc.shaders = shaders.data();
        pipelineDesc.shaderNum = (uint32_t)shaders.size();

        nri::Pipeline* pipeline = nullptr;
        if (NRI.CreateGraphicsPipeline(*device, pipelineDesc, pipeline) != nri::Result::SUCCESS)
            return nullptr;
        return pipeline;
    }

    // --- Pipeline layouts with descriptor sets -----------------------------------------------------

    NRI_INTEROP_API PipelineLayoutDesc* Nri_CreatePipelineLayoutDesc()
    {
        return new PipelineLayoutDesc();
    }

    NRI_INTEROP_API void Nri_DestroyPipelineLayoutDesc(PipelineLayoutDesc* desc)
    {
        delete desc;
    }

    // The set setIndex, made (in register space setIndex) if it isn't yet.
    PipelineLayoutDesc::Set* LayoutSet(PipelineLayoutDesc* desc, int setIndex)
    {
        if (setIndex < 0)
            return nullptr;
        while ((size_t)setIndex >= desc->sets.size())
        {
            desc->sets.emplace_back();
            desc->sets.back().registerSpace = (uint32_t)desc->sets.size() - 1;
        }
        return &desc->sets[(size_t)setIndex];
    }

    // A range of descriptorNum descriptors of type (an NriDescriptorType) from register baseRegister
    // (t, s, b or u by type) in set setIndex (register space setIndex unless
    // Nri_PipelineLayoutDescSetRegisterSpace says otherwise), seen by the shader stages (NriStage
    // bits); flags: NriRangeFlags (bindless arrays, updates after binding).
    NRI_INTEROP_API void Nri_PipelineLayoutDescAddRange(PipelineLayoutDesc* desc, int setIndex, int baseRegister, int descriptorNum,
        int type, int stages, int flags)
    {
        PipelineLayoutDesc::Set* set = LayoutSet(desc, setIndex);
        if (!set)
            return;
        nri::DescriptorRangeDesc range = {};
        range.baseRegisterIndex = (uint32_t)baseRegister;
        range.descriptorNum = (uint32_t)descriptorNum;
        range.descriptorType = (nri::DescriptorType)type;
        range.shaderStages = (nri::StageBits)stages;
        range.flags = (nri::DescriptorRangeBits)flags;
        set->ranges.push_back(range);
    }

    // The register space of set setIndex (on Vulkan, its set number).
    NRI_INTEROP_API void Nri_PipelineLayoutDescSetRegisterSpace(PipelineLayoutDesc* desc, int setIndex, int registerSpace)
    {
        PipelineLayoutDesc::Set* set = LayoutSet(desc, setIndex);
        if (set)
            set->registerSpace = (uint32_t)registerSpace;
    }

    // size bytes of root constants (push constants) at register b<registerIndex>, space 0, for the
    // stages (NriStage bits).
    NRI_INTEROP_API void Nri_PipelineLayoutDescAddRootConstants(PipelineLayoutDesc* desc, int registerIndex, int size, int stages)
    {
        desc->rootConstants.push_back({ (uint32_t)registerIndex, (uint32_t)size, (nri::StageBits)stages });
    }

    // A root descriptor (push descriptor) of type (an NriDescriptorType: a constant buffer, or a
    // structured buffer) at register b, t or u<registerIndex> (by type), space 0, for the stages:
    // bound per draw with an offset (Nri_CmdSetRootDescriptor), as a dynamic uniform buffer is, or
    // per dispatch.
    NRI_INTEROP_API void Nri_PipelineLayoutDescAddRootDescriptor(PipelineLayoutDesc* desc, int registerIndex, int type, int stages)
    {
        desc->rootDescriptors.push_back({ (uint32_t)registerIndex, (nri::DescriptorType)type, (nri::StageBits)stages });
    }

    // An immutable (static) sampler at register s<registerIndex>, space 0: filter for minification
    // and magnification, mipFilter for mips (NriFilter), addressMode on all axes, for the stages.
    NRI_INTEROP_API void Nri_PipelineLayoutDescAddRootSampler(PipelineLayoutDesc* desc, int registerIndex, int filter, int mipFilter,
        int addressMode, int stages)
    {
        nri::RootSamplerDesc sampler = {};
        sampler.registerIndex = (uint32_t)registerIndex;
        sampler.desc.filters = { (nri::Filter)filter, (nri::Filter)filter, (nri::Filter)mipFilter };
        sampler.desc.mipMax = 1000.0f;
        sampler.desc.addressModes = { (nri::AddressMode)addressMode, (nri::AddressMode)addressMode, (nri::AddressMode)addressMode };
        sampler.shaderStages = (nri::StageBits)stages;
        desc->rootSamplers.push_back(sampler);
    }

    // The layout the desc describes, for the graphics stages; null on failure.
    NRI_INTEROP_API nri::PipelineLayout* Nri_CreatePipelineLayoutFromDesc(nri::Device* device, PipelineLayoutDesc* desc)
    {
        std::vector<nri::DescriptorSetDesc> sets;
        for (const PipelineLayoutDesc::Set& set : desc->sets)
        {
            // A set with a range updated after binding is one too.
            nri::DescriptorSetBits flags = nri::DescriptorSetBits::NONE;
            for (const nri::DescriptorRangeDesc& range : set.ranges)
                if (range.flags & nri::DescriptorRangeBits::ALLOW_UPDATE_AFTER_SET)
                    flags = nri::DescriptorSetBits::ALLOW_UPDATE_AFTER_SET;
            sets.push_back({ set.registerSpace, set.ranges.data(), (uint32_t)set.ranges.size(), flags });
        }

        nri::PipelineLayoutDesc layoutDesc = {};
        layoutDesc.descriptorSets = sets.data();
        layoutDesc.descriptorSetNum = (uint32_t)sets.size();
        layoutDesc.rootConstants = desc->rootConstants.data();
        layoutDesc.rootConstantNum = (uint32_t)desc->rootConstants.size();
        layoutDesc.rootDescriptors = desc->rootDescriptors.data();
        layoutDesc.rootDescriptorNum = (uint32_t)desc->rootDescriptors.size();
        layoutDesc.rootSamplers = desc->rootSamplers.data();
        layoutDesc.rootSamplerNum = (uint32_t)desc->rootSamplers.size();
        // The pipelines it's for: graphics (all their stages) if anything is bound for a graphics
        // stage, or nothing is; compute if anything is bound for it.
        nri::StageBits stages = nri::StageBits::NONE;
        auto addStages = [&stages](nri::StageBits more) { stages = stages == nri::StageBits::NONE ? more : stages | more; };
        for (const PipelineLayoutDesc::Set& set : desc->sets)
            for (const nri::DescriptorRangeDesc& range : set.ranges)
                addStages(range.shaderStages);
        for (const nri::RootConstantDesc& rootConstants : desc->rootConstants)
            addStages(rootConstants.shaderStages);
        for (const nri::RootDescriptorDesc& rootDescriptor : desc->rootDescriptors)
            addStages(rootDescriptor.shaderStages);
        for (const nri::RootSamplerDesc& rootSampler : desc->rootSamplers)
            addStages(rootSampler.shaderStages);
        const bool compute = stages != nri::StageBits::NONE && (stages & nri::StageBits::COMPUTE_SHADER);
        const bool graphics = stages == nri::StageBits::NONE || (stages & nri::StageBits::GRAPHICS_SHADERS);
        layoutDesc.shaderStages = graphics && compute ? nri::StageBits::GRAPHICS_SHADERS | nri::StageBits::COMPUTE_SHADER
                                  : compute         ? nri::StageBits::COMPUTE_SHADER
                                                    : nri::StageBits::GRAPHICS_SHADERS;
        nri::PipelineLayout* pipelineLayout = nullptr;
        if (NRI.CreatePipelineLayout(*device, layoutDesc, pipelineLayout) != nri::Result::SUCCESS)
            return nullptr;
        return pipelineLayout;
    }

    // --- Descriptor pools and sets ----------------------------------------------------------------

    // A pool of setMaxNum descriptor sets holding at most samplerMaxNum samplers, constantBufferMaxNum
    // constant buffers, textureMaxNum textures and storageTextureMaxNum storage textures in all;
    // updateAfterSet (1): for sets with ranges
    // updated after binding (NriRangeFlags.UpdateAfterSet). Null on failure.
    NRI_INTEROP_API nri::DescriptorPool* Nri_CreateDescriptorPool(nri::Device* device, int setMaxNum, int samplerMaxNum,
        int constantBufferMaxNum, int textureMaxNum, int storageTextureMaxNum, int updateAfterSet)
    {
        nri::DescriptorPoolDesc desc = {};
        desc.flags = updateAfterSet ? nri::DescriptorPoolBits::ALLOW_UPDATE_AFTER_SET : nri::DescriptorPoolBits::NONE;
        desc.descriptorSetMaxNum = (uint32_t)setMaxNum;
        desc.samplerMaxNum = (uint32_t)samplerMaxNum;
        desc.constantBufferMaxNum = (uint32_t)constantBufferMaxNum;
        desc.textureMaxNum = (uint32_t)textureMaxNum;
        desc.storageTextureMaxNum = (uint32_t)storageTextureMaxNum;
        nri::DescriptorPool* descriptorPool = nullptr;
        if (NRI.CreateDescriptorPool(*device, desc, descriptorPool) != nri::Result::SUCCESS)
            return nullptr;
        return descriptorPool;
    }

    // Destroys the pool and the sets allocated from it.
    NRI_INTEROP_API void Nri_DestroyDescriptorPool(nri::DescriptorPool* descriptorPool)
    {
        NRI.DestroyDescriptorPool(descriptorPool);
    }

    // Forgets the sets allocated from the pool, which may allocate as many again.
    NRI_INTEROP_API void Nri_ResetDescriptorPool(nri::DescriptorPool* descriptorPool)
    {
        NRI.ResetDescriptorPool(*descriptorPool);
    }

    // A descriptor set for the layout's set setIndex, from the pool, its variable-sized array (if it
    // has one) variableDescriptorNum long; null on failure.
    NRI_INTEROP_API nri::DescriptorSet* Nri_AllocateDescriptorSet(nri::DescriptorPool* descriptorPool, nri::PipelineLayout* pipelineLayout,
        int setIndex, int variableDescriptorNum)
    {
        nri::DescriptorSet* descriptorSet = nullptr;
        if (NRI.AllocateDescriptorSets(*descriptorPool, *pipelineLayout, (uint32_t)setIndex, &descriptorSet, 1,
            (uint32_t)variableDescriptorNum) != nri::Result::SUCCESS)
            return nullptr;
        return descriptorSet;
    }

    // Puts the descriptor in the set's range rangeIndex (in the order the layout added them), at
    // element element.
    NRI_INTEROP_API void Nri_UpdateDescriptor(nri::DescriptorSet* descriptorSet, int rangeIndex, int element, nri::Descriptor* descriptor)
    {
        nri::UpdateDescriptorRangeDesc desc = { descriptorSet, (uint32_t)rangeIndex, (uint32_t)element, &descriptor, 1 };
        NRI.UpdateDescriptorRanges(&desc, 1);
    }

    // A sampler: filter (an NriFilter) for minification, magnification and mips, addressMode (an
    // NriAddressMode) on all axes, anisotropy (its maximum; 1: none); null on failure.
    NRI_INTEROP_API nri::Descriptor* Nri_CreateSampler(nri::Device* device, int filter, int addressMode, int anisotropy)
    {
        nri::SamplerDesc desc = {};
        desc.filters = { (nri::Filter)filter, (nri::Filter)filter, (nri::Filter)filter };
        desc.anisotropy = (uint8_t)anisotropy;
        desc.mipMax = 16.0f;
        desc.addressModes = { (nri::AddressMode)addressMode, (nri::AddressMode)addressMode, (nri::AddressMode)addressMode };
        nri::Descriptor* sampler = nullptr;
        if (NRI.CreateSampler(*device, desc, sampler) != nri::Result::SUCCESS)
            return nullptr;
        return sampler;
    }

    // A view of a 2D texture's mips for shaders to read.
    NRI_INTEROP_API nri::Descriptor* Nri_CreateTextureView(nri::Texture* texture, int format)
    {
        nri::Texture2DViewDesc desc = { texture, nri::Texture2DViewType::SHADER_RESOURCE_2D, (nri::Format)format };
        nri::Descriptor* view = nullptr;
        NRI.CreateTexture2DView(desc, view);
        return view;
    }

    // --- Textures shaders read: committed, or placed in memory ----------------------------------

    // A width x height texture (one mip) of NRI's choosing (D3D12: a committed resource) in device
    // memory; null on failure.
    NRI_INTEROP_API nri::Texture* Nri_CreateCommittedTexture(nri::Device* device, int width, int height, int format)
    {
        nri::Texture* texture = nullptr;
        if (NRI.CreateCommittedTexture(*device, nri::MemoryLocation::DEVICE, 0.0f, ShaderResourceTextureDesc(width, height, format), texture)
            != nri::Result::SUCCESS)
            return nullptr;
        return texture;
    }

    // The bytes a width x height texture (one mip) takes placed in memory, rounded up to its
    // alignment (D3D12: 4 KB for a small one); 0 on failure.
    NRI_INTEROP_API double Nri_GetPlacedTextureSize(nri::Device* device, int width, int height, int format)
    {
        nri::MemoryDesc memoryDesc = {};
        if (!GetTextureMemoryDesc(device, width, height, format, memoryDesc))
            return 0.0;
        uint64_t alignment = memoryDesc.alignment ? memoryDesc.alignment : 1;
        return (double)((memoryDesc.size + alignment - 1) / alignment * alignment);
    }

    // byteSize bytes of device memory for width x height textures of format to be placed in
    // (Nri_CreatePlacedTexture); null on failure.
    NRI_INTEROP_API nri::Memory* Nri_AllocateTextureMemory(nri::Device* device, double byteSize, int width, int height, int format)
    {
        nri::MemoryDesc memoryDesc = {};
        if (!GetTextureMemoryDesc(device, width, height, format, memoryDesc))
            return nullptr;
        nri::AllocateMemoryDesc desc = {};
        desc.size = (uint64_t)byteSize;
        desc.type = memoryDesc.type;
        nri::Memory* memory = nullptr;
        if (NRI.AllocateMemory(*device, desc, memory) != nri::Result::SUCCESS)
            return nullptr;
        return memory;
    }

    // Frees memory Nri_AllocateTextureMemory allocated, once the textures placed in it are destroyed.
    NRI_INTEROP_API void Nri_FreeMemory(nri::Memory* memory)
    {
        NRI.FreeMemory(memory);
    }

    // A width x height texture (one mip) placed in memory at offset bytes; null on failure.
    NRI_INTEROP_API nri::Texture* Nri_CreatePlacedTexture(nri::Device* device, nri::Memory* memory, double offset, int width, int height,
        int format)
    {
        nri::Texture* texture = nullptr;
        if (NRI.CreatePlacedTexture(*device, memory, (uint64_t)offset, ShaderResourceTextureDesc(width, height, format), texture)
            != nri::Result::SUCCESS)
            return nullptr;
        return texture;
    }

    // Fills the texture's mip 0 (one layer) with data, rows (of blocks, for a block-compressed format)
    // rowPitch bytes apart, on the queue (which this waits for), and leaves it in
    // NriTextureState.ShaderResource; 0 on failure.
    NRI_INTEROP_API int Nri_UploadTexture(nri::Queue* queue, nri::Texture* texture, const void* data, int rowPitch)
    {
        const nri::TextureDesc& textureDesc = NRI.GetTextureDesc(*texture);
        const uint32_t blockHeight = nri::nriGetFormatProps(textureDesc.format)->blockHeight;
        const uint32_t rows = (textureDesc.height + blockHeight - 1) / blockHeight;
        nri::TextureSubresourceUploadDesc subresource = { data, 1, (uint32_t)rowPitch, (uint32_t)rowPitch * rows };
        nri::TextureUploadDesc upload = {};
        upload.subresources = &subresource;
        upload.texture = texture;
        upload.after = TextureState(5);
        upload.planes = nri::PlaneBits::ALL;
        return NRI.UploadData(*queue, &upload, 1, nullptr, 0) == nri::Result::SUCCESS ? 1 : 0;
    }

    // The application's device memory in use (QueryVideoMemoryInfo's usage), in bytes.
    NRI_INTEROP_API double Nri_GetDeviceMemoryUsage(nri::Device* device)
    {
        nri::VideoMemoryInfo info = {};
        if (NRI.QueryVideoMemoryInfo(*device, nri::MemoryLocation::DEVICE, info) != nri::Result::SUCCESS)
            return 0.0;
        return (double)info.usageSize;
    }

    // --- Random numbers, as the samples' C++ draws them -------------------------------------------

    // A std::default_random_engine seeded with seed: the same numbers as the samples' (and as
    // Donut_CreateRandomEngine's); a negative seed takes one from std::random_device (different
    // every run).
    NRI_INTEROP_API std::default_random_engine* Nri_CreateRandomEngine(int seed)
    {
        return new std::default_random_engine(seed >= 0 ? (std::default_random_engine::result_type)seed
                                                        : (std::default_random_engine::result_type)std::random_device()());
    }

    // count numbers from one std::normal_distribution<float>(mean, stddev) over the engine, into dst
    // (Ref of an f32 array element): one distribution object, as the samples keep it (MSVC's makes
    // values in pairs and keeps the second).
    NRI_INTEROP_API void Nri_RandomNormalFloats(std::default_random_engine* randomEngine, double mean, double stddev, int count, float* dst)
    {
        std::normal_distribution<float> distribution((float)mean, (float)stddev);
        for (int i = 0; i < count; i++)
            dst[i] = distribution(*randomEngine);
    }

    NRI_INTEROP_API void Nri_DestroyRandomEngine(std::default_random_engine* randomEngine)
    {
        delete randomEngine;
    }

    // The engine's next number from std::uniform_real_distribution<float>(a, b) (a and b rounded to
    // float as the samples' literals are).
    NRI_INTEROP_API double Nri_RandomUniformFloat(std::default_random_engine* randomEngine, double a, double b)
    {
        return std::uniform_real_distribution<float>((float)a, (float)b)(*randomEngine);
    }

    // --- Files ----------------------------------------------------------------------------------

    // A file's bytes, read whole from path (relative to LibraryDirectory(), as the shaders); null if
    // it can't be read.
    NRI_INTEROP_API std::vector<uint8_t>* Nri_LoadFile(const char* path)
    {
        auto* data = new std::vector<uint8_t>();
        if (!ReadFile(LibraryDirectory() + path, *data))
        {
            delete data;
            return nullptr;
        }
        return data;
    }

    NRI_INTEROP_API void Nri_DestroyFile(std::vector<uint8_t>* file)
    {
        delete file;
    }

    // Nri_CreateUploadedBuffer from byteSize bytes of the file at offset; null if they're past its end.
    NRI_INTEROP_API nri::Buffer* Nri_CreateUploadedBufferFromFile(nri::Device* device, nri::Queue* queue, const std::vector<uint8_t>* file,
        int offset, int byteSize, int usage)
    {
        if (offset < 0 || byteSize <= 0 || (size_t)offset + (size_t)byteSize > file->size())
            return nullptr;
        return Nri_CreateUploadedBuffer(device, queue, file->data() + offset, byteSize, usage);
    }

    // Nri_UploadTexture from the file at offset; 0 if the texture's data would run past its end.
    NRI_INTEROP_API int Nri_UploadTextureFromFile(nri::Queue* queue, nri::Texture* texture, const std::vector<uint8_t>* file, int offset,
        int rowPitch)
    {
        const nri::TextureDesc& textureDesc = NRI.GetTextureDesc(*texture);
        const uint32_t blockHeight = nri::nriGetFormatProps(textureDesc.format)->blockHeight;
        const size_t size = (size_t)rowPitch * ((textureDesc.height + blockHeight - 1) / blockHeight);
        if (offset < 0 || (size_t)offset + size > file->size())
            return 0;
        return Nri_UploadTexture(queue, texture, file->data() + offset, rowPitch);
    }

    // An image file's texture (PNG, JPEG, ... through stb_image, as NRIFramework's
    // LoadTextureFromMemory reads them): its mip 0, RGBA8 (sRGB: 1, RGBA8_SRGB, as Donut's sRGB
    // loads), in device memory, uploaded on the queue (which this waits for) and left in
    // NriTextureState.ShaderResource; null if it can't be read.
    NRI_INTEROP_API nri::Texture* Nri_LoadImageTexture(nri::Device* device, nri::Queue* queue, const char* path, int sRGB)
    {
        std::vector<uint8_t> data;
        if (!ReadFile(LibraryDirectory() + path, data))
            return nullptr;
        utils::Texture image;
        if (!utils::LoadTextureFromMemory(path, data.data(), (int)data.size(), image, false))
            return nullptr;
        nri::Format format = sRGB ? nri::Format::RGBA8_SRGB : nri::Format::RGBA8_UNORM;
        nri::Texture* texture = Nri_CreateCommittedTexture(device, image.GetWidth(), image.GetHeight(), (int)format);
        if (!texture)
            return nullptr;

        nri::TextureSubresourceUploadDesc subresource = {};
        image.GetSubresource(subresource, 0);
        nri::TextureUploadDesc upload = {};
        upload.subresources = &subresource;
        upload.texture = texture;
        upload.after = TextureState(5);
        upload.planes = nri::PlaneBits::ALL;
        if (NRI.UploadData(*queue, &upload, 1, nullptr, 0) != nri::Result::SUCCESS)
        {
            Nri_DestroyTexture(texture);
            return nullptr;
        }
        return texture;
    }

    // --- Compute ------------------------------------------------------------------------------

    // A compute pipeline of the shader read from path (as Nri_CreateGraphicsPipeline's), entry; null
    // on failure.
    NRI_INTEROP_API nri::Pipeline* Nri_CreateComputePipeline(nri::Device* device, nri::PipelineLayout* pipelineLayout, const char* path,
        const char* entry)
    {
        std::vector<uint8_t> bytecode;
        if (!ReadShader(LibraryDirectory() + path, bytecode))
            return nullptr;
        nri::ComputePipelineDesc desc = {};
        desc.pipelineLayout = pipelineLayout;
        desc.shader = { nri::StageBits::COMPUTE_SHADER, bytecode.data(), bytecode.size(), entry };
        nri::Pipeline* pipeline = nullptr;
        if (NRI.CreateComputePipeline(*device, desc, pipeline) != nri::Result::SUCCESS)
            return nullptr;
        return pipeline;
    }

    // A width x height texture (one mip) compute shaders write (RWTexture2D) and pixel shaders read,
    // in device memory, shared by the queues, moved on the queue (which this waits for) to
    // NriTextureState.Storage; null on failure.
    NRI_INTEROP_API nri::Texture* Nri_CreateStorageTexture(nri::Device* device, nri::Queue* queue, int width, int height, int format)
    {
        nri::TextureDesc desc = ShaderResourceTextureDesc(width, height, format);
        desc.usage = nri::TextureUsageBits::SHADER_RESOURCE | nri::TextureUsageBits::SHADER_RESOURCE_STORAGE;
        desc.sharingMode = nri::SharingMode::CONCURRENT;
        nri::Texture* texture = nullptr;
        if (NRI.CreateCommittedTexture(*device, nri::MemoryLocation::DEVICE, 0.0f, desc, texture) != nri::Result::SUCCESS)
            return nullptr;

        nri::TextureUploadDesc upload = {};
        upload.texture = texture;
        upload.after = TextureState(6);
        upload.planes = nri::PlaneBits::ALL;
        if (NRI.UploadData(*queue, &upload, 1, nullptr, 0) != nri::Result::SUCCESS)
        {
            NRI.DestroyTexture(texture);
            return nullptr;
        }
        return texture;
    }

    // A view of a 2D texture's mip 0 for compute shaders to write (RWTexture2D).
    NRI_INTEROP_API nri::Descriptor* Nri_CreateStorageTextureView(nri::Texture* texture, int format)
    {
        nri::Texture2DViewDesc desc = { texture, nri::Texture2DViewType::SHADER_RESOURCE_STORAGE_2D, (nri::Format)format, 0, 1 };
        nri::Descriptor* view = nullptr;
        NRI.CreateTexture2DView(desc, view);
        return view;
    }

    // --- Async compute ------------------------------------------------------------------------

    // A loop that, every intervalMicroseconds, dispatches groupsX x groupsY groups of the compute
    // pipeline on the compute queue (Nri_GetComputeQueue's), on a C++ worker thread. Each run writes
    // one texture, bound by its descriptor set (Nri_AddAsyncComputeTexture) as set 0 of the layout,
    // with the run's index (a uint, counting from 0) as root constants 0; the sets come from the
    // descriptor pool, which only the worker uses then. The graphics queue signals graphicsFence with
    // the values Nri_ReleaseAsyncComputeTexture gives. Null on failure.
    NRI_INTEROP_API AsyncComputeLoop* Nri_CreateAsyncComputeLoop(nri::Queue* computeQueue, nri::Device* device, nri::Fence* graphicsFence,
        nri::PipelineLayout* pipelineLayout, nri::Pipeline* pipeline, nri::DescriptorPool* descriptorPool, int groupsX, int groupsY,
        int intervalMicroseconds)
    {
        auto* loop = new AsyncComputeLoop();
        loop->device = device;
        loop->queue = computeQueue;
        loop->graphicsFence = graphicsFence;
        loop->pipelineLayout = pipelineLayout;
        loop->pipeline = pipeline;
        loop->descriptorPool = descriptorPool;
        loop->groupsX = (uint32_t)groupsX;
        loop->groupsY = (uint32_t)groupsY;
        loop->interval = std::chrono::microseconds(intervalMicroseconds);
        if (NRI.CreateCommandAllocator(*computeQueue, loop->commandAllocator) != nri::Result::SUCCESS
            || NRI.CreateCommandBuffer(*loop->commandAllocator, loop->commandBuffer) != nri::Result::SUCCESS
            || NRI.CreateFence(*device, 0, loop->fence) != nri::Result::SUCCESS)
        {
            delete loop;
            return nullptr;
        }
        return loop;
    }

    // Adds a texture for the loop to write, by its descriptor set (its storage view at u0); call
    // before starting it. The textures are numbered from 0 in the order they're added.
    NRI_INTEROP_API void Nri_AddAsyncComputeTexture(AsyncComputeLoop* loop, nri::DescriptorSet* descriptorSet)
    {
        AsyncComputeLoop::Texture texture;
        texture.index = (int)loop->descriptorSets.size();
        texture.descriptorSet = descriptorSet;
        loop->descriptorSets.push_back(descriptorSet);
        loop->Push(loop->renderToCompute, texture);
    }

    NRI_INTEROP_API void Nri_StartAsyncComputeLoop(AsyncComputeLoop* loop)
    {
        loop->thread = std::thread([loop]() { loop->ThreadProc(); });
    }

    // Stops and joins the worker thread, waits for the device to be idle, and destroys the loop (not
    // the pipeline, layout, pool and textures it was given).
    NRI_INTEROP_API void Nri_DestroyAsyncComputeLoop(AsyncComputeLoop* loop)
    {
        delete loop;
    }

    // On the render thread: the number of the next texture the loop finished (in NriTextureState.
    // Storage), making the work submitted to graphicsQueue from now on wait for its run; -1 if none
    // is finished since.
    NRI_INTEROP_API int Nri_AcquireAsyncComputeTexture(AsyncComputeLoop* loop, nri::Queue* graphicsQueue)
    {
        AsyncComputeLoop::Texture texture;
        if (!loop->TryPop(loop->computeToRender, texture))
            return -1;
        nri::FenceSubmitDesc wait = { loop->fence, texture.lastUse, nri::StageBits::ALL };
        nri::QueueSubmitDesc desc = {};
        desc.waitFences = &wait;
        desc.waitFenceNum = 1;
        {
            std::lock_guard lock(g_QueueMutex);
            NRI.QueueSubmit(*graphicsQueue, desc);
        }
        return texture.index;
    }

    // On the render thread: gives the texture numbered index back to the loop, back in
    // NriTextureState.Storage once the graphics queue signals graphicsFence with lastUse.
    NRI_INTEROP_API void Nri_ReleaseAsyncComputeTexture(AsyncComputeLoop* loop, int index, int lastUse)
    {
        if (index < 0 || index >= (int)loop->descriptorSets.size())
            return;
        AsyncComputeLoop::Texture texture;
        texture.index = index;
        texture.descriptorSet = loop->descriptorSets[(size_t)index];
        texture.lastUse = (uint64_t)lastUse;
        loop->Push(loop->renderToCompute, texture);
    }
}
