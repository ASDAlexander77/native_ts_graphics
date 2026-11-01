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
#include "Extensions/NRIWrapperVK.h"
// Its implementation is compiled into NRIFramework (Utils.cpp).
#include "cgltf.h"
#include "../vulkan_samples_gltf.h"

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
    static_assert((int)nri::Format::R32_UINT == 31);
    static_assert((int)nri::Format::R32_SFLOAT == 33 && (int)nri::Format::RG32_SFLOAT == 36);
    static_assert((int)nri::Format::RGB32_SFLOAT == 39 && (int)nri::Format::RGBA32_SFLOAT == 42);
    static_assert((int)nri::Format::D32_SFLOAT == 66 && (int)nri::Format::BC1_RGBA_UNORM == 50);
    static_assert((int)nri::Format::RGBA16_SNORM == 27 && (int)nri::Format::D24_UNORM_S8_UINT == 65
        && (int)nri::Format::R24_UNORM_X8 == 68);
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
    static_assert((int)nri::Format::RGBA16_SFLOAT == 30 && (int)nri::Topology::POINT_LIST == 0);
    static_assert((int)nri::StageBits::GEOMETRY_SHADER == 16 && (int)nri::StageBits::TASK_SHADER == 32);
    static_assert((int)nri::BlendFactor::SRC_ALPHA == 6 && (int)nri::BlendOp::ADD == 0);    static_assert((int)nri::BlendFactor::SRC_ALPHA_SATURATE == 14 && (int)nri::BlendOp::MAX == 4);
    static_assert((int)nri::Topology::LINE_LIST == 1 && (int)nri::Topology::LINE_STRIP == 2 && (int)nri::Topology::PATCH_LIST == 9);
    static_assert((int)nri::StageBits::TESS_CONTROL_SHADER == 4 && (int)nri::StageBits::TESS_EVALUATION_SHADER == 8);
    static_assert((int)nri::Format::R16_UNORM != 0);
    static_assert((int)nri::StageBits::MESH_SHADER == 64 && (int)nri::StageBits::GRAPHICS_SHADERS == 254);

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
        // The color attachments: the first (Nri_PipelineDescSetColor), then the others
        // (Nri_PipelineDescAddColor). None while the first's format is UNKNOWN.
        nri::ColorAttachmentDesc color = { nri::Format::UNKNOWN, {}, {}, nri::ColorWriteBits::RGBA, false };
        std::vector<nri::ColorAttachmentDesc> moreColors;
        nri::DepthAttachmentDesc depth = {};
        nri::Format depthFormat = nri::Format::UNKNOWN;
        nri::CullMode cullMode = nri::CullMode::NONE;
        nri::FillMode fillMode = nri::FillMode::SOLID;
        bool frontCounterClockwise = false;
        // Patches' control points (Nri_PipelineDescSetPatchControlPoints), with NriTopology.PatchList.
        uint8_t tessControlPointNum = 0;
        // Nri_PipelineDescSetDepthClip: -1 NRI's default (rasterization.depthClamp false), else
        // whether primitives are clipped at the near and far planes.
        int depthClip = -1;
        // Nri_PipelineDescSetSampleCount: the attachments' samples (1: not multisampled).
        uint8_t sampleNum = 1;
        // Nri_PipelineDescSetLogicOp: the color attachment's logic operation (NONE: blending).
        nri::LogicOp logicOp = nri::LogicOp::NONE;
        // Nri_PipelineDescSetShadingRate: the draws' shading rate from Nri_CmdSetShadingRate (and the
        // shading rate attachment).
        bool shadingRate = false;
        // Nri_PipelineDescSetDepthBias: the depth bias (none while constant and slope are 0).
        nri::DepthBiasDesc depthBias = {};
        nri::Topology topology = nri::Topology::TRIANGLE_LIST;
        nri::PrimitiveRestart primitiveRestart = nri::PrimitiveRestart::DISABLED;
        // The streams stepped per instance (Nri_PipelineDescSetInstanceStream), not per vertex.
        std::vector<uint16_t> instanceStreams;
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
        // In register space rootRegisterSpace (on Vulkan, that set: no descriptor set may use it).
        uint32_t rootRegisterSpace = 0;
        std::vector<nri::RootConstantDesc> rootConstants;
        std::vector<nri::RootDescriptorDesc> rootDescriptors;
        std::vector<nri::RootSamplerDesc> rootSamplers;
    };

    // Where the shaders are instead of next to this library, if Nri_SetDataDirectory was called.
    std::string g_DataDirectory;

    // -testOutput <file>: where Nri_ReadBufferRGBA8 saves the frame it reads (the test's), as PNG.
    std::string g_TestOutput;

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

    // A shader's bytecode, read from path: the file, or a permutation in it when it's a ShaderMake
    // permutation blob ("NVSP", then per permutation its sizes, its defines and its bytecode), as a
    // .cfg line with -D compiles, for that line's defines: the one whose defines are permutation
    // ("NAME=VALUE", as ShaderMake writes them), or the only one when permutation is empty.
    bool ReadShader(const std::string& path, std::vector<uint8_t>& data, const std::string& permutation = std::string())
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
        size_t entryNum = 0;
        while (offset + sizeof(Entry) <= data.size())
        {
            Entry entry;
            memcpy(&entry, data.data() + offset, sizeof(Entry));
            size_t start = offset + sizeof(Entry) + entry.permutationSize;
            if (start + entry.dataSize > data.size())
                break;
            std::string defines((const char*)data.data() + offset + sizeof(Entry), entry.permutationSize);
            bool last = start + entry.dataSize == data.size();
            if (permutation.empty() ? (entryNum == 0 && last) : defines == permutation)
            {
                data = std::vector<uint8_t>(data.begin() + (ptrdiff_t)start, data.begin() + (ptrdiff_t)(start + entry.dataSize));
                return true;
            }
            entryNum++;
            offset = start + entry.dataSize;
        }
        if (permutation.empty())
            printf("ERROR: %s holds more than one permutation\n", path.c_str());
        else
            printf("ERROR: %s has no permutation %s\n", path.c_str(), permutation.c_str());
        return false;
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
        case 3:
            return { nri::AccessBits::COPY_DESTINATION, nri::StageBits::COPY };
        case 4:
            return { nri::AccessBits::ARGUMENT_BUFFER, nri::StageBits::INDIRECT };
        case 5:
            return { nri::AccessBits::ARGUMENT_BUFFER | nri::AccessBits::SHADER_RESOURCE, nri::StageBits::INDIRECT | nri::StageBits::COMPUTE_SHADER };
        case 6:
            return { nri::AccessBits::SHADER_RESOURCE, nri::StageBits::VERTEX_SHADER | nri::StageBits::COMPUTE_SHADER };
        case 7:
            // read and written by pixel shaders (RWStructuredBuffer in a draw's pixel shader)
            return { nri::AccessBits::SHADER_RESOURCE_STORAGE, nri::StageBits::FRAGMENT_SHADER };
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
        case 8:
            // read and written by pixel shaders (RWTexture2D in a draw's pixel shader)
            return { nri::AccessBits::SHADER_RESOURCE_STORAGE, nri::Layout::SHADER_RESOURCE_STORAGE, nri::StageBits::FRAGMENT_SHADER };
        case 9:
            // a shading rate attachment's (Nri_CreateShadingRateTexture's, from the start); all stages:
            // Vulkan reads it at its own stage (FRAGMENT_SHADING_RATE_ATTACHMENT), which NRI has no bit for
            return { nri::AccessBits::SHADING_RATE_ATTACHMENT, nri::Layout::SHADING_RATE_ATTACHMENT, nri::StageBits::ALL };
        case 12:
            // read by compute shaders only: what the compute queue can read (D3D12's
            // NON_PIXEL_SHADER_RESOURCE; AllShaderResource's pixel bit isn't a compute queue state)
            return { nri::AccessBits::SHADER_RESOURCE, nri::Layout::SHADER_RESOURCE, nri::StageBits::COMPUTE_SHADER };
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
        // Root constants the app set (Nri_SetAsyncComputeConstants), sent instead of the run index
        // when not empty; the latest values go with each run.
        std::vector<uint8_t> constants;
        std::mutex constantsMutex;
        // Nri_SetAsyncComputePaused: no run starts while set (the one under way finishes).
        std::atomic_bool paused = false;
        // Runs submitted so far (Nri_GetAsyncComputeRunCount).
        std::atomic<int> runCount = 0;

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
                while (!terminate && (paused || !TryPop(renderToCompute, texture)))
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
                {
                    std::lock_guard lock(constantsMutex);
                    if (constants.empty())
                        NRI.CmdSetRootConstants(*commandBuffer, { 0, &counter, sizeof(counter), 0, nri::BindPoint::COMPUTE });
                    else
                        NRI.CmdSetRootConstants(*commandBuffer, { 0, constants.data(), (uint32_t)constants.size(), 0, nri::BindPoint::COMPUTE });
                }
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
                runCount++;
                std::this_thread::sleep_until(nextTimePoint);
            }
        }
    };
}

// NRIFramework's application, its virtual methods calling TypeScript.
// stb_image_write's, compiled into NRIFramework's detex library.
extern "C" int stbi_write_png(char const* filename, int w, int h, int comp, const void* data, int stride_in_bytes);

class TsSample : public SampleBase
{
public:
    Callback<InitializeFn> m_Initialize;
    Callback<FrameFn> m_LatencySleep;
    Callback<FrameFn> m_RenderFrame;
    bool m_Test = false;
    // The example's own options (Nri_AddExampleOption), which NRIFramework's parser isn't given,
    // and the values each takes after it.
    std::vector<std::string> m_ExampleOptions;
    std::vector<int> m_ExampleOptionValueNums;
    // Nri_UseImgui was called: the device is made for ImGui (see Nri_CreateDevice).
    bool m_UsesImgui = false;
    // Nri_InitImgui's streamer, which uploads ImGui's geometry.
    nri::StreamerInterface m_StreamerInterface = {};
    nri::Streamer* m_Streamer = nullptr;

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
            else if (arg == "-testOutput" && i + 1 < argc)
                g_TestOutput = argv[++i];
            else if (arg == "-test" && testFrames > 0)
            {
                sample->m_Test = true;
                args.push_back("--frameNum=" + std::to_string(testFrames));
                args.push_back("--alwaysActive");
            }
            // a separator the JIT launchers leave in (run_jitd.bat x.ts -- -test passes -test -- -dx12),
            // which NRIFramework's parser rejects, and the example's options
            else if (arg != "--")
            {
                auto option = std::find(sample->m_ExampleOptions.begin(), sample->m_ExampleOptions.end(), arg);
                if (option == sample->m_ExampleOptions.end())
                    args.push_back(arg);
                else
                    i += sample->m_ExampleOptionValueNums[option - sample->m_ExampleOptions.begin()];
            }
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
        sample->m_ExampleOptionValueNums.push_back(0);
    }

    // As Nri_AddExampleOption, an option followed by valueNum values, left out too.
    NRI_INTEROP_API void Nri_AddExampleOptionWithValues(TsSample* sample, const char* option, int valueNum)
    {
        sample->m_ExampleOptions.push_back(option);
        sample->m_ExampleOptionValueNums.push_back(valueNum);
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

    // The cursor's position in the window, in pixels from its top left corner (x right, y down), as
    // GLFW last reported it.
    NRI_INTEROP_API double Nri_GetMouseX(TsSample* sample)
    {
        return sample->m_MousePosPrev.x;
    }

    NRI_INTEROP_API double Nri_GetMouseY(TsSample* sample)
    {
        return sample->m_MousePosPrev.y;
    }

    // Non-zero: the cursor is hidden and captured (GLFW_CURSOR_DISABLED: relative mouse movement);
    // zero: normal.
    NRI_INTEROP_API void Nri_SetCursorDisabled(TsSample* sample, int disabled)
    {
        if (sample->Window())
            glfwSetInputMode(sample->Window(), GLFW_CURSOR, disabled ? GLFW_CURSOR_DISABLED : GLFW_CURSOR_NORMAL);
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
        // D3D11, for an example that draws ImGui (Nri_UseImgui): command buffers replayed on the
        // immediate context, not deferred contexts (NRIFramework's default with NVAPI): from a
        // deferred context the ImGui geometry the streamer writes into a DYNAMIC buffer
        // (Nri_InitImgui) is drawn as nothing. Not for the others: NRI's emulation breaks the
        // examples using the compute queue.
        desc.enableD3D11CommandBufferEmulation = sample->m_UsesImgui || D3D11_ENABLE_COMMAND_BUFFER_EMULATION;
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

    // A Vulkan feature struct (sType, pNext, then VkBool32 members, the first boolNum of them at
    // bools) as vkGetPhysicalDeviceFeatures2 fills it for the device's physical device: NRI enables
    // whatever its structs say the device has, the patched-in VK_KHR_shader_quad_control's too, but
    // doesn't say. False if it can't be queried (not Vulkan).
    bool QueryVulkanFeatures(nri::Device* device, int32_t sType, uint32_t* bools, uint32_t boolNum)
    {
        if (NRI.GetDeviceDesc(*device).graphicsAPI != nri::GraphicsAPI::VK)
            return false;
        nri::WrapperVKInterface wrapper = {};
        if (nri::nriGetInterface(*device, NRI_INTERFACE(nri::WrapperVKInterface), &wrapper) != nri::Result::SUCCESS)
            return false;
        // VkPhysicalDeviceFeatures2 (VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FEATURES_2): the 55 VkBool32s of
        // VkPhysicalDeviceFeatures after sType and pNext. The queried struct likewise, 32 at most.
        struct Features
        {
            int32_t sType;
            void* pNext;
            uint32_t bools[55];
        };
        typedef void* (*GetInstanceProcAddr)(void* instance, const char* name);
        typedef void (*GetPhysicalDeviceFeatures2)(void* physicalDevice, Features* features);
        void* instance = (void*)wrapper.GetInstanceVK(*device);
        auto getInstanceProcAddr = (GetInstanceProcAddr)wrapper.GetInstanceProcAddrVK(*device);
        auto getFeatures2 = getInstanceProcAddr ? (GetPhysicalDeviceFeatures2)getInstanceProcAddr(instance, "vkGetPhysicalDeviceFeatures2")
            : nullptr;
        if (!getFeatures2 || boolNum > 32)
            return false;
        Features queried = { sType, nullptr, {} };
        Features features2 = { 1000059000, &queried, {} };
        getFeatures2((void*)wrapper.GetPhysicalDeviceVK(*device), &features2);
        memcpy(bools, queried.bools, boolNum * sizeof(uint32_t));
        return true;
    }

    // Whether the device has an NriFeature (nri_interop.d.ts): 1 or 0.
    NRI_INTEROP_API int Nri_IsFeatureSupported(nri::Device* device, int feature)
    {
        const nri::DeviceDesc& desc = NRI.GetDeviceDesc(*device);
        bool d3d12 = desc.graphicsAPI == nri::GraphicsAPI::D3D12;
        // VkPhysicalDeviceVulkan11Features (VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_1_FEATURES):
        // storageBuffer16BitAccess, uniformAndStorageBuffer16BitAccess, storagePushConstant16, ...
        uint32_t features11[3] = {};
        // VkPhysicalDeviceShaderQuadControlFeaturesKHR and
        // VkPhysicalDeviceShaderMaximalReconvergenceFeaturesKHR: one VkBool32 each.
        uint32_t quadControl = 0;
        uint32_t maximalReconvergence = 0;
        switch (feature)
        {
        case 0:
            return desc.features.meshShader ? 1 : 0;
        case 1:
            return desc.features.depthBoundsTest ? 1 : 0;
        case 2:
            return desc.features.drawIndirectCount ? 1 : 0;
        case 3:
            return (desc.wave.derivativeOpsStages & nri::StageBits::COMPUTE_SHADER) ? 1 : 0;
        case 4:
            // Shader model 6.2's 16-bit types on D3D12 (anywhere); Vulkan's in storage buffers too,
            // as Donut checks.
            if (!desc.shaderFeatures.nativeF16 || !desc.shaderFeatures.nativeI16)
                return 0;
            return d3d12 || (QueryVulkanFeatures(device, 49, features11, 3) && features11[0]) ? 1 : 0;
        case 5:
            if (!Nri_IsFeatureSupported(device, 4))
                return 0;
            return d3d12 || (QueryVulkanFeatures(device, 49, features11, 3) && features11[1] && features11[2]) ? 1 : 0;
        case 6:
            // D3D12 runs pixel shaders in whole quads, helper lanes taking part in quad operations.
            if (d3d12)
                return 1;
            return QueryVulkanFeatures(device, 1000235000, &quadControl, 1) && quadControl
                && QueryVulkanFeatures(device, 1000434000, &maximalReconvergence, 1) && maximalReconvergence ? 1 : 0;
        case 7:
            // SV_Barycentrics: D3D12 shader model 6.1's, Vulkan's VK_KHR_fragment_shader_barycentric
            return desc.shaderFeatures.barycentric ? 1 : 0;
        case 8:
            // Logic operations in the output merger (D3D's OutputMergerLogicOp, Vulkan's logicOp)
            return desc.features.logicOp ? 1 : 0;
        case 11:
            // Variable rate shading with shading rate attachments (D3D12 tier 2, Vulkan's
            // VK_KHR_fragment_shading_rate with attachment and primitive rates): NVRHI's
            // Feature::VariableRateShading
            return desc.tiers.shadingRate >= 2 ? 1 : 0;
        case 23:
            // Rasterizer ordered views in pixel shaders (D3D's ROVsSupported, Vulkan's fragment shader
            // pixel and sample interlock, which NRI enables where the device has them)
            return desc.shaderFeatures.rasterizedOrderedView ? 1 : 0;
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

    // The texture's size (its first level's) and mip levels.
    NRI_INTEROP_API int Nri_GetTextureWidth(nri::Texture* texture)
    {
        return (int)NRI.GetTextureDesc(*texture).width;
    }

    NRI_INTEROP_API int Nri_GetTextureHeight(nri::Texture* texture)
    {
        return (int)NRI.GetTextureDesc(*texture).height;
    }

    NRI_INTEROP_API int Nri_GetTextureMipNum(nri::Texture* texture)
    {
        return (int)NRI.GetTextureDesc(*texture).mipNum;
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

    // A color attachment view of one mip level of the texture (rendered into, e.g. a mip chain
    // generated level by level).
    NRI_INTEROP_API nri::Descriptor* Nri_CreateColorAttachmentMipView(nri::Texture* texture, int format, int mip)
    {
        nri::Texture2DViewDesc desc = { texture, nri::Texture2DViewType::COLOR_ATTACHMENT, (nri::Format)format, (nri::Dim_t)mip, 1 };
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

    // A width x height depth texture in device memory (read by shaders too if sampled), bound to it
    // and moved on the queue (which this waits for) to state; null on failure.
    nri::Texture* CreateDepthTexture(nri::Device* device, nri::Queue* queue, int width, int height, int format, bool sampled, int state,
        int sampleNum = 1)
    {
        nri::TextureDesc textureDesc = {};
        textureDesc.type = nri::TextureType::TEXTURE_2D;
        textureDesc.usage = nri::TextureUsageBits::DEPTH_STENCIL_ATTACHMENT;
        if (sampled)
            textureDesc.usage |= nri::TextureUsageBits::SHADER_RESOURCE;
        textureDesc.format = (nri::Format)format;
        textureDesc.width = (nri::Dim_t)width;
        textureDesc.height = (nri::Dim_t)height;
        textureDesc.sampleNum = (nri::Sample_t)sampleNum;
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
        upload.after = TextureState(state);
        // (Both planes of a depth-stencil format: Vulkan moves their layouts together.)
        const bool stencil = (nri::Format)format == nri::Format::D24_UNORM_S8_UINT || (nri::Format)format == nri::Format::D32_SFLOAT_S8_UINT_X24;
        upload.planes = stencil ? nri::PlaneBits::ALL : nri::PlaneBits::DEPTH;
        if (NRI.UploadData(*queue, &upload, 1, nullptr, 0) != nri::Result::SUCCESS)
        {
            Nri_DestroyTexture(texture);
            return nullptr;
        }
        return texture;
    }

    // A width x height depth texture in device memory, bound to it and moved on the queue (which
    // this waits for) to NriTextureState.DepthAttachment, where it stays; null on failure.
    NRI_INTEROP_API nri::Texture* Nri_CreateDepthTexture(nri::Device* device, nri::Queue* queue, int width, int height, int format)
    {
        return CreateDepthTexture(device, queue, width, height, format, false, 4);
    }

    // As Nri_CreateDepthTexture, but shaders read it too (a view of it: Nri_CreateTextureView with
    // the depth format), and it's left in NriTextureState.ShaderResource: barriers move it to
    // DepthAttachment for the passes that render into it, and back.
    NRI_INTEROP_API nri::Texture* Nri_CreateSampledDepthTexture(nri::Device* device, nri::Queue* queue, int width, int height, int format)
    {
        return CreateDepthTexture(device, queue, width, height, format, true, 5);
    }

    // As Nri_CreateDepthTexture, with sampleNum samples per pixel (Nri_GetSupportedSampleCounts').
    NRI_INTEROP_API nri::Texture* Nri_CreateMultisampledDepthTexture(nri::Device* device, nri::Queue* queue, int width, int height, int format,
        int sampleNum)
    {
        return CreateDepthTexture(device, queue, width, height, format, false, 4, sampleNum);
    }

    // As Nri_CreateMultisampledDepthTexture, but shaders read it too (Nri_CreateTextureView with the
    // depth format: Texture2DMS<float> with samples, Texture2D<float> without), and it's left in
    // NriTextureState.ShaderResource, as Nri_CreateSampledDepthTexture's.
    NRI_INTEROP_API nri::Texture* Nri_CreateSampledMultisampledDepthTexture(nri::Device* device, nri::Queue* queue, int width, int height,
        int format, int sampleNum)
    {
        return CreateDepthTexture(device, queue, width, height, format, true, 5, sampleNum);
    }

    // A width x height color attachment with sampleNum samples per pixel (a view of it:
    // Nri_CreateColorAttachmentView), in device memory, moved on the queue (which this waits for) to
    // NriTextureState.ColorAttachment; shaders read it too (Nri_CreateTextureView: Texture2DMS), as
    // shaders/nri_msaa_resolve.hlsl resolves it. Null on failure; destroyed with Nri_DestroyTexture.
    NRI_INTEROP_API nri::Texture* Nri_CreateMultisampledRenderTarget(nri::Device* device, nri::Queue* queue, int width, int height, int format,
        int sampleNum)
    {
        nri::TextureDesc desc = ShaderResourceTextureDesc(width, height, format);
        desc.usage = nri::TextureUsageBits::COLOR_ATTACHMENT | nri::TextureUsageBits::SHADER_RESOURCE;
        desc.sampleNum = (nri::Sample_t)sampleNum;
        nri::Texture* texture = nullptr;
        if (NRI.CreateCommittedTexture(*device, nri::MemoryLocation::DEVICE, 0.0f, desc, texture) != nri::Result::SUCCESS)
            return nullptr;

        nri::TextureUploadDesc upload = {};
        upload.texture = texture;
        upload.after = TextureState(1);
        upload.planes = nri::PlaneBits::ALL;
        if (NRI.UploadData(*queue, &upload, 1, nullptr, 0) != nri::Result::SUCCESS)
        {
            NRI.DestroyTexture(texture);
            return nullptr;
        }
        return texture;
    }

    // The sample counts both formats can be rendered with (as color and depth attachments), as bits
    // (1 | 2 | 4 | 8: NRI's format support goes up to 8): Donut_GetSupportedSampleCounts'.
    NRI_INTEROP_API int Nri_GetSupportedSampleCounts(nri::Device* device, int colorFormat, int depthFormat)
    {
        const uint32_t color = (uint32_t)NRI.GetFormatSupport(*device, (nri::Format)colorFormat);
        const uint32_t depth = (uint32_t)NRI.GetFormatSupport(*device, (nri::Format)depthFormat);
        int counts = 1;
        for (int i = 0; i < 3; i++)
        {
            const uint32_t bit = (uint32_t)nri::FormatSupportBits::MULTISAMPLE_2X << i;
            if ((color & bit) != 0 && (depth & bit) != 0)
                counts |= 2 << i;
        }
        return counts;
    }

    // The ways Vulkan's render passes can resolve a multisampled depth buffer
    // (VkPhysicalDeviceDepthStencilResolveProperties::supportedDepthResolveModes), as Donut's
    // Donut_GetDepthResolveModes gives them: bits 1 << mode, mode as Donut's ResolveMode (SampleZero 1,
    // Average 2, Min 3, Max 4); 0 on D3D, where Donut's render passes don't resolve. NRI's render
    // passes don't either: the NRI examples resolve with shaders/nri_msaa_resolve.hlsl as Donut's
    // Vulkan render pass would.
    NRI_INTEROP_API int Nri_GetDepthResolveModes(nri::Device* device)
    {
        if (NRI.GetDeviceDesc(*device).graphicsAPI != nri::GraphicsAPI::VK)
            return 0;
        nri::WrapperVKInterface wrapper = {};
        if (nri::nriGetInterface(*device, NRI_INTERFACE(nri::WrapperVKInterface), &wrapper) != nri::Result::SUCCESS)
            return 0;
        // VkPhysicalDeviceDepthStencilResolveProperties
        // (VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_DEPTH_STENCIL_RESOLVE_PROPERTIES), chained to
        // VkPhysicalDeviceProperties2 (VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_PROPERTIES_2), whose
        // VkPhysicalDeviceProperties (824 bytes) is given room enough.
        struct DepthStencilResolveProperties
        {
            int32_t sType;
            void* pNext;
            uint32_t supportedDepthResolveModes;
            uint32_t supportedStencilResolveModes;
            uint32_t independentResolveNone;
            uint32_t independentResolve;
        };
        struct Properties2
        {
            int32_t sType;
            void* pNext;
            alignas(8) uint8_t properties[2048];
        };
        typedef void* (*GetInstanceProcAddr)(void* instance, const char* name);
        typedef void (*GetPhysicalDeviceProperties2)(void* physicalDevice, Properties2* properties);
        void* instance = (void*)wrapper.GetInstanceVK(*device);
        auto getInstanceProcAddr = (GetInstanceProcAddr)wrapper.GetInstanceProcAddrVK(*device);
        auto getProperties2 = getInstanceProcAddr
            ? (GetPhysicalDeviceProperties2)getInstanceProcAddr(instance, "vkGetPhysicalDeviceProperties2") : nullptr;
        if (!getProperties2)
            return 0;
        DepthStencilResolveProperties resolve = { 1000199000, nullptr, 0, 0, 0, 0 };
        Properties2 properties2 = {};
        properties2.sType = 1000059001;
        properties2.pNext = &resolve;
        getProperties2((void*)wrapper.GetPhysicalDeviceVK(*device), &properties2);
        // VkResolveModeFlagBits: SAMPLE_ZERO 1, AVERAGE 2, MIN 4, MAX 8.
        const uint32_t modes = resolve.supportedDepthResolveModes;
        int bits = 0;
        if (modes & 1)
            bits |= 1 << 1;
        if (modes & 2)
            bits |= 1 << 2;
        if (modes & 4)
            bits |= 1 << 3;
        if (modes & 8)
            bits |= 1 << 4;
        return bits;
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

    // A buffer of byteSize bytes in device memory holding data, structures stride bytes each that
    // shaders read (StructuredBuffer), uploaded on the queue (which this waits for) and left
    // readable by every shader stage; null on failure. Destroyed with Nri_DestroyBuffer.
    NRI_INTEROP_API nri::Buffer* Nri_CreateUploadedStructuredBuffer(nri::Device* device, nri::Queue* queue, const void* data, int byteSize,
        int stride)
    {
        nri::BufferDesc bufferDesc = {};
        bufferDesc.size = (uint64_t)byteSize;
        bufferDesc.structureStride = (uint32_t)stride;
        bufferDesc.usage = nri::BufferUsageBits::SHADER_RESOURCE;
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

        nri::BufferUploadDesc upload = { data, buffer,
            { nri::AccessBits::SHADER_RESOURCE, nri::StageBits::GRAPHICS_SHADERS | nri::StageBits::COMPUTE_SHADER } };
        if (NRI.UploadData(*queue, nullptr, 0, &upload, 1) != nri::Result::SUCCESS)
        {
            Nri_DestroyBuffer(buffer);
            return nullptr;
        }
        return buffer;
    }

    // Nri_CreateUploadedStructuredBuffer from ints.
    NRI_INTEROP_API nri::Buffer* Nri_CreateUploadedStructuredBufferFromInts(nri::Device* device, nri::Queue* queue, const int* data,
        int byteSize, int stride)
    {
        return Nri_CreateUploadedStructuredBuffer(device, queue, data, byteSize, stride);
    }

    // Nri_CreateUploadedStructuredBuffer from data some other library holds (an Opaque pointer: e.g.
    // MeshletModel.getData's).
    NRI_INTEROP_API nri::Buffer* Nri_CreateUploadedStructuredBufferFromPointer(nri::Device* device, nri::Queue* queue, const void* data,
        int byteSize, int stride)
    {
        return Nri_CreateUploadedStructuredBuffer(device, queue, data, byteSize, stride);
    }

    // Nri_CreateUploadedBuffer from ints (index data).
    NRI_INTEROP_API nri::Buffer* Nri_CreateUploadedBufferFromInts(nri::Device* device, nri::Queue* queue, const int* data, int byteSize, int usage)
    {
        return Nri_CreateUploadedBuffer(device, queue, data, byteSize, usage);
    }

    // A buffer of byteSize bytes in memory the CPU writes (Nri_WriteBuffer) and the GPU reads, for
    // usage (an NriBufferUsage: 0, vertex buffers; 2, constant buffers; 3, structures stride bytes each, read by
    // shaders: StructuredBuffer); null on failure.
    NRI_INTEROP_API nri::Buffer* Nri_CreateHostBufferWithStride(nri::Device* device, int byteSize, int usage, int stride)
    {
        nri::BufferDesc bufferDesc = {};
        bufferDesc.size = (uint64_t)byteSize;
        switch (usage)
        {
        case 0:
            bufferDesc.usage = nri::BufferUsageBits::VERTEX_BUFFER;
            break;
        case 2:
            bufferDesc.usage = nri::BufferUsageBits::CONSTANT_BUFFER;
            break;
        case 3:
            bufferDesc.usage = nri::BufferUsageBits::SHADER_RESOURCE;
            bufferDesc.structureStride = (uint32_t)stride;
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

    // Nri_CreateHostBufferWithStride's buffer for a constant buffer (usage 2).
    NRI_INTEROP_API nri::Buffer* Nri_CreateHostBuffer(nri::Device* device, int byteSize, int usage)
    {
        return Nri_CreateHostBufferWithStride(device, byteSize, usage, 0);
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

    // A buffer of byteSize bytes of structures stride bytes each (4: raw, a ByteAddressBuffer's) in
    // device memory, which compute shaders write (RWStructuredBuffer) and shaders read
    // (StructuredBuffer), with data uploaded on the queue (which this waits for), then in state (an
    // NriBufferState); indirect draws can take their arguments from it if that state is one of
    // theirs (D3D11 doesn't take structured buffers with indirect arguments). Null on failure.
    NRI_INTEROP_API nri::Buffer* Nri_CreateStorageBufferInState(nri::Device* device, nri::Queue* queue, const void* data, int byteSize, int stride,
        int state)
    {
        nri::BufferDesc bufferDesc = {};
        bufferDesc.size = (uint64_t)byteSize;
        bufferDesc.structureStride = (uint32_t)stride;
        bufferDesc.usage = nri::BufferUsageBits::SHADER_RESOURCE | nri::BufferUsageBits::SHADER_RESOURCE_STORAGE;
        if (state == 4 || state == 5)
            bufferDesc.usage |= nri::BufferUsageBits::ARGUMENT_BUFFER;
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

        nri::BufferUploadDesc upload = { data, buffer, BufferState(state) };
        if (NRI.UploadData(*queue, nullptr, 0, &upload, 1) != nri::Result::SUCCESS)
        {
            Nri_DestroyBuffer(buffer);
            return nullptr;
        }
        return buffer;
    }

    // Nri_CreateStorageBufferInState's buffer, in NriBufferState.Storage.
    NRI_INTEROP_API nri::Buffer* Nri_CreateStorageBuffer(nri::Device* device, nri::Queue* queue, const void* data, int byteSize, int stride)
    {
        return Nri_CreateStorageBufferInState(device, queue, data, byteSize, stride, 0);
    }

    // Nri_CreateStorageBufferInState's buffer from ints (Ref of an int array element).
    NRI_INTEROP_API nri::Buffer* Nri_CreateStorageBufferFromInts(nri::Device* device, nri::Queue* queue, const void* data, int byteSize,
        int stride, int state)
    {
        return Nri_CreateStorageBufferInState(device, queue, data, byteSize, stride, state);
    }

    // Nri_CreateStorageBufferInState's buffer without data (its contents undefined): moved to state.
    NRI_INTEROP_API nri::Buffer* Nri_CreateUninitializedStorageBuffer(nri::Device* device, nri::Queue* queue, int byteSize, int stride, int state)
    {
        return Nri_CreateStorageBufferInState(device, queue, nullptr, byteSize, stride, state);
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

    // Copies count 32-bit ints from the start of the buffer (a readback buffer, after the GPU wrote
    // it) to dst; 1, or 0 if it can't be read.
    NRI_INTEROP_API int Nri_ReadBufferInts(nri::Buffer* buffer, int* dst, int count)
    {
        const int* data = (const int*)NRI.MapBuffer(*buffer, 0, nri::WHOLE_SIZE);
        if (!data)
            return 0;
        memcpy(dst, data, (size_t)count * sizeof(int));
        NRI.UnmapBuffer(*buffer);
        return 1;
    }

    // --- Timestamp queries ------------------------------------------------------------------------

    // A pool of capacity timestamp queries (QueryType::TIMESTAMP: the graphics queue's); null on
    // failure.
    NRI_INTEROP_API nri::QueryPool* Nri_CreateTimestampQueryPool(nri::Device* device, int capacity)
    {
        nri::QueryPoolDesc desc = { nri::QueryType::TIMESTAMP, (uint32_t)capacity };
        nri::QueryPool* queryPool = nullptr;
        if (NRI.CreateQueryPool(*device, desc, queryPool) != nri::Result::SUCCESS)
            return nullptr;
        return queryPool;
    }

    NRI_INTEROP_API void Nri_DestroyQueryPool(nri::QueryPool* queryPool)
    {
        NRI.DestroyQueryPool(queryPool);
    }

    // The bytes a query's result takes in a buffer Nri_CmdCopyQueries copies into (8: a uint64_t
    // timestamp).
    NRI_INTEROP_API int Nri_GetQuerySize(nri::QueryPool* queryPool)
    {
        return (int)NRI.GetQuerySize(*queryPool);
    }

    // Resets num queries from offset, before they're written again (Vulkan's vkCmdResetQueryPool; a
    // no-op on D3D); outside rendering.
    NRI_INTEROP_API void Nri_CmdResetQueries(nri::CommandBuffer* commandBuffer, nri::QueryPool* queryPool, int offset, int num)
    {
        NRI.CmdResetQueries(*commandBuffer, *queryPool, (uint32_t)offset, (uint32_t)num);
    }

    // Writes the GPU's timestamp into query offset once the commands before have completed (NRI's
    // CmdEndQuery of a timestamp query).
    NRI_INTEROP_API void Nri_CmdWriteTimestamp(nri::CommandBuffer* commandBuffer, nri::QueryPool* queryPool, int offset)
    {
        NRI.CmdEndQuery(*commandBuffer, *queryPool, (uint32_t)offset);
    }

    // Copies num written queries' results from offset into buffer (a readback buffer) at dstOffset
    // bytes. On D3D11 the copy happens when the buffer is mapped, and a buffer remembers only its
    // last copy: one copy per buffer between reads.
    NRI_INTEROP_API void Nri_CmdCopyQueries(nri::CommandBuffer* commandBuffer, nri::QueryPool* queryPool, int offset, int num,
        nri::Buffer* buffer, int dstOffset)
    {
        NRI.CmdCopyQueries(*commandBuffer, *queryPool, (uint32_t)offset, (uint32_t)num, *buffer, (uint64_t)dstOffset);
    }

    // The milliseconds between two timestamps a readback buffer holds (uint64_t ticks at byte
    // offsets begin and end), at the device's timestamp frequency; -1 if the buffer can't be read.
    NRI_INTEROP_API double Nri_ReadTimestampIntervalMs(nri::Device* device, nri::Buffer* buffer, int begin, int end)
    {
        const uint8_t* data = (const uint8_t*)NRI.MapBuffer(*buffer, 0, nri::WHOLE_SIZE);
        if (!data)
            return -1.0;
        uint64_t beginTicks = 0;
        uint64_t endTicks = 0;
        memcpy(&beginTicks, data + begin, sizeof(beginTicks));
        memcpy(&endTicks, data + end, sizeof(endTicks));
        NRI.UnmapBuffer(*buffer);
        const uint64_t frequency = NRI.GetDeviceDesc(*device).other.timestampFrequencyHz;
        if (frequency == 0 || endTicks < beginTicks)
            return 0.0;
        return double(endTicks - beginTicks) * 1000.0 / double(frequency);
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
        if (!g_TestOutput.empty())
        {
            // RGBA bytes, opaque, as Donut's -testOutput saves the back buffer.
            std::vector<uint32_t> opaque(dst, dst + (size_t)width * height);
            for (uint32_t& p : opaque)
                p |= 0xFF000000;
            if (stbi_write_png(g_TestOutput.c_str(), width, height, 4, opaque.data(), width * 4) == 0)
                printf("ERROR: cannot write %s\n", g_TestOutput.c_str());
        }
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
    // The buffer's device address (a GPU pointer; Vulkan's vkGetBufferDeviceAddress: NRI has no
    // call for it, its Vulkan wrapper gives vkGetDeviceProcAddr) as two 32-bit halves at dst; 1, or
    // 0 without one (not Vulkan, or no bufferDeviceAddress).
    NRI_INTEROP_API int Nri_GetBufferDeviceAddress(nri::Device* device, nri::Buffer* buffer, void* dst)
    {
        if (NRI.GetDeviceDesc(*device).graphicsAPI != nri::GraphicsAPI::VK)
            return 0;
        nri::WrapperVKInterface wrapper = {};
        if (nri::nriGetInterface(*device, NRI_INTERFACE(nri::WrapperVKInterface), &wrapper) != nri::Result::SUCCESS)
            return 0;
        // VkBufferDeviceAddressInfo, VK_STRUCTURE_TYPE_BUFFER_DEVICE_ADDRESS_INFO
        struct BufferDeviceAddressInfo
        {
            int32_t sType;
            const void* pNext;
            uint64_t buffer;
        };
        typedef void* (*GetDeviceProcAddr)(void* device, const char* name);
        typedef uint64_t (*GetBufferDeviceAddress)(void* device, const BufferDeviceAddressInfo* info);
        void* vkDevice = NRI.GetDeviceNativeObject(device);
        auto getDeviceProcAddr = (GetDeviceProcAddr)wrapper.GetDeviceProcAddrVK(*device);
        auto getBufferDeviceAddress = getDeviceProcAddr ? (GetBufferDeviceAddress)getDeviceProcAddr(vkDevice, "vkGetBufferDeviceAddress") : nullptr;
        if (!getBufferDeviceAddress)
            return 0;
        BufferDeviceAddressInfo info = { 1000244001, nullptr, NRI.GetBufferNativeObject(buffer) };
        uint64_t address = getBufferDeviceAddress(vkDevice, &info);
        if (address == 0)
            return 0;
        memcpy(dst, &address, sizeof(address));
        return 1;
    }

    // Zeroes the whole buffer (in NriBufferState.CopyDestination).
    NRI_INTEROP_API void Nri_CmdZeroBuffer(nri::CommandBuffer* commandBuffer, nri::Buffer* buffer)
    {
        NRI.CmdZeroBuffer(*commandBuffer, *buffer, 0, nri::WHOLE_SIZE);
    }

    // drawNum indexed draws whose arguments (5 uints: DrawIndexedDesc, D3D12_DRAW_INDEXED_ARGUMENTS)
    // are in buffer from offset, stride bytes apart (in NriBufferState.IndirectArgument); with a
    // countBuffer (NriFeature.DrawIndirectCount), the uint at its countOffset, at most drawNum.
    NRI_INTEROP_API void Nri_CmdDrawIndexedIndirect(nri::CommandBuffer* commandBuffer, nri::Buffer* buffer, int offset, int drawNum, int stride,
        nri::Buffer* countBuffer, int countOffset)
    {
        NRI.CmdDrawIndexedIndirect(*commandBuffer, *buffer, (uint64_t)offset, (uint32_t)drawNum, (uint32_t)stride, countBuffer,
            (uint64_t)countOffset);
    }

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

    // Nri_CmdTextureBarrier for one mip level of the texture.
    NRI_INTEROP_API void Nri_CmdTextureMipBarrier(nri::CommandBuffer* commandBuffer, nri::Texture* texture, int mip, int before, int after)
    {
        nri::TextureBarrierDesc textureBarrier = {};
        textureBarrier.texture = texture;
        textureBarrier.before = TextureState(before);
        textureBarrier.after = TextureState(after);
        textureBarrier.mipOffset = (nri::Dim_t)mip;
        textureBarrier.mipNum = 1;

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

    // Renders into a depth attachment alone (Nri_CreateDepthAttachmentView's), e.g. a shadow map.
    NRI_INTEROP_API void Nri_CmdBeginRenderingDepthOnly(nri::CommandBuffer* commandBuffer, nri::Descriptor* depthAttachment)
    {
        nri::AttachmentsDesc desc = {};
        desc.depthStencil = depthAttachment;
        NRI.CmdBeginRendering(*commandBuffer, desc);
    }

    NRI_INTEROP_API void Nri_CmdEndRendering(nri::CommandBuffer* commandBuffer)
    {
        NRI.CmdEndRendering(*commandBuffer);
    }

    // Renders into one or two color attachments (color1 null for one), a depth attachment (null for
    // none) and a shading rate attachment (Nri_CreateShadingRateAttachmentView's; null for none).
    NRI_INTEROP_API void Nri_CmdBeginRenderingWithShadingRate(nri::CommandBuffer* commandBuffer, nri::Descriptor* color0,
        nri::Descriptor* color1, nri::Descriptor* depthAttachment, nri::Descriptor* shadingRateAttachment)
    {
        nri::Descriptor* colors[] = { color0, color1 };
        nri::AttachmentsDesc desc = {};
        desc.colors = colors;
        desc.colorNum = color1 ? 2 : 1;
        desc.depthStencil = depthAttachment;
        desc.shadingRate = shadingRateAttachment;
        NRI.CmdBeginRendering(*commandBuffer, desc);
    }

    // Clears color attachment index (of those rendered into) within the rectangle (x, y, width,
    // height) to (r, g, b, a) (a UINT attachment: their bits).
    NRI_INTEROP_API void Nri_CmdClearColorAttachmentRect(nri::CommandBuffer* commandBuffer, int index, int x, int y, int width, int height,
        float r, float g, float b, float a)
    {
        nri::ClearDesc clearDesc = {};
        clearDesc.planes = nri::PlaneBits::COLOR;
        clearDesc.colorAttachmentIndex = (uint32_t)index;
        clearDesc.value.color.f = { r, g, b, a };
        nri::Rect rect = { (int16_t)x, (int16_t)y, (nri::Dim_t)width, (nri::Dim_t)height };
        NRI.CmdClearAttachments(*commandBuffer, &clearDesc, 1, &rect, 1);
    }

    // Clears the depth attachment within the rectangle (x, y, width, height) to depth.
    NRI_INTEROP_API void Nri_CmdClearDepthRect(nri::CommandBuffer* commandBuffer, int x, int y, int width, int height, float depth)
    {
        nri::ClearDesc clearDesc = {};
        clearDesc.planes = nri::PlaneBits::DEPTH;
        clearDesc.value.depthStencil.depth = depth;
        nri::Rect rect = { (int16_t)x, (int16_t)y, (nri::Dim_t)width, (nri::Dim_t)height };
        NRI.CmdClearAttachments(*commandBuffer, &clearDesc, 1, &rect, 1);
    }

    // The draws' shading rate from now on (an nri::ShadingRate: 0 1x1, 1 1x2, 2 2x1, 3 2x2, 4 2x4,
    // 5 4x2, 6 4x4), combined with the primitives' rate by primitiveCombiner, then with the shading
    // rate attachment's by attachmentCombiner (nri::ShadingRateCombiner: 0 KEEP the rate so far,
    // NVRHI's Passthrough; 1 REPLACE it, NVRHI's Override; 2 MIN, 3 MAX, 4 SUM). For pipelines with
    // Nri_PipelineDescSetShadingRate.
    NRI_INTEROP_API void Nri_CmdSetShadingRate(nri::CommandBuffer* commandBuffer, int shadingRate, int primitiveCombiner, int attachmentCombiner)
    {
        nri::ShadingRateDesc desc = { (nri::ShadingRate)shadingRate, (nri::ShadingRateCombiner)primitiveCombiner,
            (nri::ShadingRateCombiner)attachmentCombiner };
        NRI.CmdSetShadingRate(*commandBuffer, desc);
    }

    // Renders into three color attachments (SV_Target0 to 2), views Nri_CreateColorAttachmentView
    // made.
    NRI_INTEROP_API void Nri_CmdBeginRenderingWithThreeColors(nri::CommandBuffer* commandBuffer, nri::Descriptor* color0,
        nri::Descriptor* color1, nri::Descriptor* color2)
    {
        nri::Descriptor* colors[] = { color0, color1, color2 };
        nri::AttachmentsDesc desc = {};
        desc.colors = colors;
        desc.colorNum = 3;
        NRI.CmdBeginRendering(*commandBuffer, desc);
    }

    // Renders into two color attachments (SV_Target0 and 1, Nri_CreateColorAttachmentView's views)
    // and a depth attachment (Nri_CreateDepthAttachmentView's).
    NRI_INTEROP_API void Nri_CmdBeginRenderingWithTwoColorsAndDepth(nri::CommandBuffer* commandBuffer, nri::Descriptor* color0,
        nri::Descriptor* color1, nri::Descriptor* depthAttachment)
    {
        nri::Descriptor* colors[] = { color0, color1 };
        nri::AttachmentsDesc desc = {};
        desc.colors = colors;
        desc.colorNum = 2;
        desc.depthStencil = depthAttachment;
        NRI.CmdBeginRendering(*commandBuffer, desc);
    }

    // Renders into three color attachments (SV_Target0 to 2, Nri_CreateColorAttachmentView's views)
    // and a depth attachment (Nri_CreateDepthAttachmentView's): a G-buffer.
    NRI_INTEROP_API void Nri_CmdBeginRenderingWithThreeColorsAndDepth(nri::CommandBuffer* commandBuffer, nri::Descriptor* color0,
        nri::Descriptor* color1, nri::Descriptor* color2, nri::Descriptor* depthAttachment)
    {
        nri::Descriptor* colors[] = { color0, color1, color2 };
        nri::AttachmentsDesc desc = {};
        desc.colors = colors;
        desc.colorNum = 3;
        desc.depthStencil = depthAttachment;
        NRI.CmdBeginRendering(*commandBuffer, desc);
    }

    // Clears the whole color attachment (between Nri_CmdBeginRendering and Nri_CmdEndRendering).
    NRI_INTEROP_API void Nri_CmdClearColor(nri::CommandBuffer* commandBuffer, float r, float g, float b, float a)
    {
        nri::ClearDesc clearDesc = {};
        clearDesc.planes = nri::PlaneBits::COLOR;
        clearDesc.value.color.f = { r, g, b, a };
        NRI.CmdClearAttachments(*commandBuffer, &clearDesc, 1, nullptr, 0);
    }

    // The blend constants (NriBlendFactor.ConstantColor's, ConstantAlpha's).
    NRI_INTEROP_API void Nri_CmdSetBlendConstants(nri::CommandBuffer* commandBuffer, float r, float g, float b, float a)
    {
        nri::Color32f color = { r, g, b, a };
        NRI.CmdSetBlendConstants(*commandBuffer, color);
    }

    // Renders into four color attachments (SV_Target0 to 3) and a depth attachment: Donut's G-buffer.
    NRI_INTEROP_API void Nri_CmdBeginRenderingWithFourColorsAndDepth(nri::CommandBuffer* commandBuffer, nri::Descriptor* color0,
        nri::Descriptor* color1, nri::Descriptor* color2, nri::Descriptor* color3, nri::Descriptor* depthAttachment)
    {
        nri::Descriptor* colors[] = { color0, color1, color2, color3 };
        nri::AttachmentsDesc desc = {};
        desc.colors = colors;
        desc.colorNum = 4;
        desc.depthStencil = depthAttachment;
        NRI.CmdBeginRendering(*commandBuffer, desc);
    }

    // Clears the whole color attachment index (of those a multi-color Nri_CmdBeginRendering* renders
    // into).
    NRI_INTEROP_API void Nri_CmdClearColorAttachment(nri::CommandBuffer* commandBuffer, int index, float r, float g, float b, float a)
    {
        nri::ClearDesc clearDesc = {};
        clearDesc.planes = nri::PlaneBits::COLOR;
        clearDesc.colorAttachmentIndex = (uint32_t)index;
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
    // 0 if it can't be read. With permutation ("NAME=VALUE"), the permutation of a ShaderMake
    // permutation blob with those defines.
    NRI_INTEROP_API int Nri_PipelineDescAddShaderPermutation(PipelineDesc* desc, int stage, const char* path, const char* entry,
        const char* permutation)
    {
        static const nri::StageBits stages[] = { nri::StageBits::VERTEX_SHADER, nri::StageBits::FRAGMENT_SHADER,
            nri::StageBits::MESH_SHADER, nri::StageBits::TASK_SHADER, nri::StageBits::GEOMETRY_SHADER, nri::StageBits::TESS_CONTROL_SHADER,
            nri::StageBits::TESS_EVALUATION_SHADER };
        if (stage < 0 || stage >= (int)helper::GetCountOf(stages))
            return 0;
        PipelineDesc::Shader shader = { stages[stage], {}, entry };
        if (!ReadShader(LibraryDirectory() + path, shader.bytecode, permutation))
            return 0;
        desc->shaders.push_back(std::move(shader));
        return 1;
    }

    NRI_INTEROP_API int Nri_PipelineDescAddShader(PipelineDesc* desc, int stage, const char* path, const char* entry)
    {
        return Nri_PipelineDescAddShaderPermutation(desc, stage, path, entry, "");
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

    // Primitive restart for an NriIndexType's indices (0xFFFF or 0xFFFFFFFF end a strip).
    NRI_INTEROP_API void Nri_PipelineDescSetPrimitiveRestart(PipelineDesc* desc, int indexType)
    {
        desc->primitiveRestart = indexType == 0 ? nri::PrimitiveRestart::INDICES_UINT16 : nri::PrimitiveRestart::INDICES_UINT32;
    }

    // The stream's attributes advance per instance (Nri_CmdDraw*'s instances), not per vertex.
    NRI_INTEROP_API void Nri_PipelineDescSetInstanceStream(PipelineDesc* desc, int stream)
    {
        desc->instanceStreams.push_back((uint16_t)stream);
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

    // Another color attachment after the first (Nri_PipelineDescSetColor): its format and the
    // channels written (NriColorWrite bits).
    NRI_INTEROP_API void Nri_PipelineDescAddColor(PipelineDesc* desc, int format, int writeMask)
    {
        desc->moreColors.push_back({ (nri::Format)format, {}, {}, (nri::ColorWriteBits)writeMask, false });
    }

    // Blending into the first color attachment: color srcColor * source op dstColor * destination,
    // alpha likewise (NriBlendFactor and NriBlendOp values).
    NRI_INTEROP_API void Nri_PipelineDescSetBlend(PipelineDesc* desc, int srcColor, int dstColor, int colorOp, int srcAlpha, int dstAlpha,
        int alphaOp)
    {
        desc->color.blendEnabled = true;
        desc->color.colorBlend = { (nri::BlendFactor)srcColor, (nri::BlendFactor)dstColor, (nri::BlendOp)colorOp };
        desc->color.alphaBlend = { (nri::BlendFactor)srcAlpha, (nri::BlendFactor)dstAlpha, (nri::BlendOp)alphaOp };
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

    // Patches of controlPointNum control points (NriTopology.PatchList: hull and domain shaders).
    NRI_INTEROP_API void Nri_PipelineDescSetPatchControlPoints(PipelineDesc* desc, int controlPointNum)
    {
        desc->tessControlPointNum = (uint8_t)controlPointNum;
    }

    // Triangles drawn as their edges (1) or filled (0, the default).
    NRI_INTEROP_API void Nri_PipelineDescSetWireframe(PipelineDesc* desc, int wireframe)
    {
        desc->fillMode = wireframe ? nri::FillMode::WIREFRAME : nri::FillMode::SOLID;
    }

    // Counter-clockwise triangles are the front faces (1), or clockwise ones (0, the default).
    NRI_INTEROP_API void Nri_PipelineDescSetFrontCounterClockwise(PipelineDesc* desc, int counterClockwise)
    {
        desc->frontCounterClockwise = counterClockwise != 0;
    }

    // Whether primitives are clipped at the near and far planes (1; Vulkan's default) or not (0: depth
    // clamped instead, NVRHI's default and Donut's GraphicsPipelineDesc.setDepthClip(false)). NRI's
    // own default (unset) differs by API: clipped on Vulkan, not on D3D.
    NRI_INTEROP_API void Nri_PipelineDescSetDepthClip(PipelineDesc* desc, int clip)
    {
        desc->depthClip = clip != 0 ? 1 : 0;
    }

    // The color and depth attachments' samples (Nri_GetSupportedSampleCounts'; 1 by default). NRI has
    // no dynamic sample count: a pipeline per count.
    NRI_INTEROP_API void Nri_PipelineDescSetSampleCount(PipelineDesc* desc, int sampleNum)
    {
        desc->sampleNum = (uint8_t)sampleNum;
    }

    // The color attachment's logic operation instead of blending (NriFeature.LogicOp; a UNORM or UINT
    // attachment, UINT on D3D12), in Vulkan's VkLogicOp order (0 CLEAR, 3 COPY, 5 NO_OP, 6 XOR ... 15
    // SET), as Vulkan-Samples' logic_op_dynamic_state picks it. NRI has no NO_OP: the attachment's
    // color writes are turned off instead, which leaves it as unchanged.
    NRI_INTEROP_API void Nri_PipelineDescSetLogicOp(PipelineDesc* desc, int vkLogicOp)
    {
        if (vkLogicOp == 5)
        {
            desc->logicOp = nri::LogicOp::NONE;
            desc->color.colorWriteMask = nri::ColorWriteBits::NONE;
            return;
        }
        // nri::LogicOp: NONE, then Vulkan's order without NO_OP.
        desc->logicOp = (nri::LogicOp)(vkLogicOp < 5 ? vkLogicOp + 1 : vkLogicOp);
    }

    // Variable rate shading (NriFeature.VariableRateShading): the draws' shading rate is the one
    // Nri_CmdSetShadingRate sets, combined with the shading rate attachment's (Vulkan: dynamic state).
    NRI_INTEROP_API void Nri_PipelineDescSetShadingRate(PipelineDesc* desc, int enabled)
    {
        desc->shadingRate = enabled != 0;
    }

    // The depth bias added to the depth of the triangles drawn: constant (D3D's integer DepthBias,
    // in units of the depth format's resolution), clamped to clamp (0: not clamped), plus slope times
    // the triangle's depth slope, as NVRHI's RasterState::setDepthBias (none by default).
    NRI_INTEROP_API void Nri_PipelineDescSetDepthBias(PipelineDesc* desc, double constant, double clamp, double slope)
    {
        desc->depthBias = { (float)constant, (float)clamp, (float)slope };
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
        {
            bool perInstance = std::find(desc->instanceStreams.begin(), desc->instanceStreams.end(), i) != desc->instanceStreams.end();
            streams.push_back({ i, perInstance ? nri::VertexStreamStepRate::PER_INSTANCE : nri::VertexStreamStepRate::PER_VERTEX });
        }
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
        pipelineDesc.inputAssembly.primitiveRestart = desc->primitiveRestart;
        pipelineDesc.rasterization.fillMode = desc->fillMode;
        pipelineDesc.rasterization.frontCounterClockwise = desc->frontCounterClockwise;
        // NRI's depthClamp is D3D's DepthClipEnable on D3D11 and D3D12 but Vulkan's depthClampEnable
        // (the opposite: no clipping): set it for what the API takes it as.
        if (desc->depthClip >= 0)
            pipelineDesc.rasterization.depthClamp = NRI.GetDeviceDesc(*device).graphicsAPI == nri::GraphicsAPI::VK ? desc->depthClip == 0
                                                                                                                 : desc->depthClip != 0;
        pipelineDesc.inputAssembly.tessControlPointNum = desc->tessControlPointNum;
        pipelineDesc.rasterization.cullMode = desc->cullMode;
        std::vector<nri::ColorAttachmentDesc> colors;
        if (desc->color.format != nri::Format::UNKNOWN)
        {
            colors.push_back(desc->color);
            colors.insert(colors.end(), desc->moreColors.begin(), desc->moreColors.end());
            pipelineDesc.outputMerger.colors = colors.data();
            pipelineDesc.outputMerger.colorNum = (uint32_t)colors.size();
        }
        pipelineDesc.outputMerger.depth = desc->depth;
        pipelineDesc.outputMerger.depthStencilFormat = desc->depthFormat;
        pipelineDesc.outputMerger.logicOp = desc->logicOp;
        pipelineDesc.rasterization.shadingRate = desc->shadingRate;
        pipelineDesc.rasterization.depthBias = desc->depthBias;
        // Multisampled attachments: every sample written, no alpha to coverage.
        nri::MultisampleDesc multisample = {};
        multisample.sampleMask = nri::ALL;
        multisample.sampleNum = desc->sampleNum;
        if (desc->sampleNum > 1)
            pipelineDesc.multisample = &multisample;
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

    // The register space of the root constants, descriptors and samplers below (0 unless this says
    // otherwise; on Vulkan, the set of the root descriptors): one no descriptor set uses.
    NRI_INTEROP_API void Nri_PipelineLayoutDescSetRootRegisterSpace(PipelineLayoutDesc* desc, int registerSpace)
    {
        desc->rootRegisterSpace = (uint32_t)registerSpace;
    }

    // size bytes of root constants (push constants) at register b<registerIndex>, in the root
    // register space, for the stages (NriStage bits).
    NRI_INTEROP_API void Nri_PipelineLayoutDescAddRootConstants(PipelineLayoutDesc* desc, int registerIndex, int size, int stages)
    {
        desc->rootConstants.push_back({ (uint32_t)registerIndex, (uint32_t)size, (nri::StageBits)stages });
    }

    // A root descriptor (push descriptor) of type (an NriDescriptorType: a constant buffer, or a
    // structured buffer) at register b, t or u<registerIndex> (by type), in the root register space,
    // for the stages: bound per draw with an offset (Nri_CmdSetRootDescriptor), as a dynamic uniform
    // buffer is, or per dispatch.
    NRI_INTEROP_API void Nri_PipelineLayoutDescAddRootDescriptor(PipelineLayoutDesc* desc, int registerIndex, int type, int stages)
    {
        desc->rootDescriptors.push_back({ (uint32_t)registerIndex, (nri::DescriptorType)type, (nri::StageBits)stages });
    }

    // An immutable (static) sampler at register s<registerIndex>, in the root register space: filter
    // for minification and magnification, mipFilter for mips (NriFilter), addressMode on all axes,
    // for the stages.
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
        layoutDesc.rootRegisterSpace = desc->rootRegisterSpace;
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

    // As Nri_CreateDescriptorPool, with room for structuredBufferMaxNum structured buffers and
    // storageStructuredBufferMaxNum storage ones too.
    NRI_INTEROP_API nri::DescriptorPool* Nri_CreateDescriptorPoolWithBuffers(nri::Device* device, int setMaxNum, int samplerMaxNum,
        int constantBufferMaxNum, int textureMaxNum, int storageTextureMaxNum, int structuredBufferMaxNum, int storageStructuredBufferMaxNum,
        int updateAfterSet)
    {
        nri::DescriptorPoolDesc desc = {};
        desc.flags = updateAfterSet ? nri::DescriptorPoolBits::ALLOW_UPDATE_AFTER_SET : nri::DescriptorPoolBits::NONE;
        desc.descriptorSetMaxNum = (uint32_t)setMaxNum;
        desc.samplerMaxNum = (uint32_t)samplerMaxNum;
        desc.constantBufferMaxNum = (uint32_t)constantBufferMaxNum;
        desc.textureMaxNum = (uint32_t)textureMaxNum;
        desc.storageTextureMaxNum = (uint32_t)storageTextureMaxNum;
        desc.structuredBufferMaxNum = (uint32_t)structuredBufferMaxNum;
        desc.storageStructuredBufferMaxNum = (uint32_t)storageStructuredBufferMaxNum;
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
    NRI_INTEROP_API nri::Descriptor* Nri_CreateSamplerWithMipFilter(nri::Device* device, int filter, int mipFilter, int addressMode,
        int anisotropy)
    {
        nri::SamplerDesc desc = {};
        desc.filters = { (nri::Filter)filter, (nri::Filter)filter, (nri::Filter)mipFilter };
        desc.anisotropy = (uint8_t)anisotropy;
        desc.mipMax = 16.0f;
        desc.addressModes = { (nri::AddressMode)addressMode, (nri::AddressMode)addressMode, (nri::AddressMode)addressMode };
        nri::Descriptor* sampler = nullptr;
        if (NRI.CreateSampler(*device, desc, sampler) != nri::Result::SUCCESS)
            return nullptr;
        return sampler;
    }

    // As Nri_CreateSamplerWithMipFilter, the levels of detail sampled clamped to [mipMin, mipMax]
    // (mipMax 0: level 0 only), as Donut's SamplerDesc minLod and maxLod.
    NRI_INTEROP_API nri::Descriptor* Nri_CreateSamplerWithLodRange(nri::Device* device, int filter, int mipFilter, int addressMode,
        int anisotropy, double mipMin, double mipMax)
    {
        nri::SamplerDesc desc = {};
        desc.filters = { (nri::Filter)filter, (nri::Filter)filter, (nri::Filter)mipFilter };
        desc.anisotropy = (uint8_t)anisotropy;
        desc.mipMin = (float)mipMin;
        desc.mipMax = (float)mipMax;
        desc.addressModes = { (nri::AddressMode)addressMode, (nri::AddressMode)addressMode, (nri::AddressMode)addressMode };
        nri::Descriptor* sampler = nullptr;
        if (NRI.CreateSampler(*device, desc, sampler) != nri::Result::SUCCESS)
            return nullptr;
        return sampler;
    }

    // A comparison sampler (SamplerComparisonState: SampleCmp), linear, clamped, comparing with
    // compareOp (an NriCompareOp), as Donut's createComparisonSampler (NVRHI's comparison reduction:
    // Less); null on failure.
    NRI_INTEROP_API nri::Descriptor* Nri_CreateComparisonSampler(nri::Device* device, int compareOp)
    {
        nri::SamplerDesc desc = {};
        desc.filters = { nri::Filter::LINEAR, nri::Filter::LINEAR, nri::Filter::LINEAR };
        desc.anisotropy = 1;
        desc.mipMax = 16.0f;
        desc.addressModes = { nri::AddressMode::CLAMP_TO_EDGE, nri::AddressMode::CLAMP_TO_EDGE, nri::AddressMode::CLAMP_TO_EDGE };
        desc.compareOp = (nri::CompareOp)compareOp;
        nri::Descriptor* sampler = nullptr;
        if (NRI.CreateSampler(*device, desc, sampler) != nri::Result::SUCCESS)
            return nullptr;
        return sampler;
    }

    // A sampler filtering with filter for minification, magnification and mips (as
    // Nri_CreateSamplerWithMipFilter's).
    NRI_INTEROP_API nri::Descriptor* Nri_CreateSampler(nri::Device* device, int filter, int addressMode, int anisotropy)
    {
        return Nri_CreateSamplerWithMipFilter(device, filter, filter, addressMode, anisotropy);
    }

    // The device's widest anisotropic filtering (16 on most).
    NRI_INTEROP_API int Nri_GetMaxSamplerAnisotropy(nri::Device* device)
    {
        return (int)NRI.GetDeviceDesc(*device).other.samplerAnisotropyMax;
    }

    // The most draws one indirect draw call takes (DeviceDesc::other.drawIndirectMaxNum): above 1,
    // multi-draw indirect (D3D12's ExecuteIndirect always; Vulkan's multiDrawIndirect feature).
    NRI_INTEROP_API int Nri_GetDrawIndirectMaxNum(nri::Device* device)
    {
        const uint32_t num = NRI.GetDeviceDesc(*device).other.drawIndirectMaxNum;
        return num > 0x7FFFFFFF ? 0x7FFFFFFF : (int)num;
    }

    // Pixels per shading rate attachment texel in each dimension (DeviceDesc::other's
    // shadingRateAttachmentTileSize, as NVRHI's shadingRateImageTileSize); 0 without shading rate
    // attachments (NriFeature.VariableRateShading).
    NRI_INTEROP_API int Nri_GetShadingRateTileSize(nri::Device* device)
    {
        const nri::DeviceDesc& desc = NRI.GetDeviceDesc(*device);
        return desc.tiers.shadingRate >= 2 ? (int)desc.other.shadingRateAttachmentTileSize : 0;
    }

    // The fragment sizes (shading rates) the device has, as width, height pairs into dst (32 ints at
    // least), as Donut_GetFragmentShadingRates gives them: Vulkan's
    // (vkGetPhysicalDeviceFragmentShadingRatesKHR's, largest first, 16 at most), D3D12's those of its
    // tier (2x4, 4x2 and 4x4 first with additional shading rates, then 2x2, 2x1, 1x2, 1x1). Their
    // count, 0 without shading rate attachments.
    NRI_INTEROP_API int Nri_GetFragmentShadingRates(nri::Device* device, int* dst)
    {
        const nri::DeviceDesc& desc = NRI.GetDeviceDesc(*device);
        if (desc.tiers.shadingRate < 2)
            return 0;
        int count = 0;
        if (desc.graphicsAPI == nri::GraphicsAPI::D3D12)
        {
            const int additional[] = { 4, 4, 4, 2, 2, 4 };
            const int base[] = { 2, 2, 2, 1, 1, 2, 1, 1 };
            if (desc.features.additionalShadingRates)
            {
                for (int i = 0; i < 6; i++)
                    dst[count * 2 + i] = additional[i];
                count += 3;
            }
            for (int i = 0; i < 8; i++)
                dst[count * 2 + i] = base[i];
            return count + 4;
        }
        if (desc.graphicsAPI != nri::GraphicsAPI::VK)
            return 0;
        nri::WrapperVKInterface wrapper = {};
        if (nri::nriGetInterface(*device, NRI_INTERFACE(nri::WrapperVKInterface), &wrapper) != nri::Result::SUCCESS)
            return 0;
        // VkPhysicalDeviceFragmentShadingRateKHR (VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FRAGMENT_SHADING_RATE_KHR).
        struct FragmentShadingRate
        {
            int32_t sType;
            void* pNext;
            uint32_t sampleCounts;
            uint32_t width;
            uint32_t height;
        };
        typedef void* (*GetInstanceProcAddr)(void* instance, const char* name);
        typedef int32_t (*GetPhysicalDeviceFragmentShadingRates)(void* physicalDevice, uint32_t* count, FragmentShadingRate* rates);
        void* instance = (void*)wrapper.GetInstanceVK(*device);
        auto getInstanceProcAddr = (GetInstanceProcAddr)wrapper.GetInstanceProcAddrVK(*device);
        auto getRates = getInstanceProcAddr
            ? (GetPhysicalDeviceFragmentShadingRates)getInstanceProcAddr(instance, "vkGetPhysicalDeviceFragmentShadingRatesKHR") : nullptr;
        if (!getRates)
            return 0;
        void* physicalDevice = (void*)wrapper.GetPhysicalDeviceVK(*device);
        uint32_t rateNum = 0;
        if (getRates(physicalDevice, &rateNum, nullptr) != 0)
            return 0;
        std::vector<FragmentShadingRate> rates(rateNum, { 1000226004, nullptr, 0, 0, 0 });
        if (getRates(physicalDevice, &rateNum, rates.data()) < 0)
            return 0;
        for (uint32_t i = 0; i < rateNum && count < 16; i++)
        {
            dst[count * 2] = (int)rates[i].width;
            dst[count * 2 + 1] = (int)rates[i].height;
            count++;
        }
        return count;
    }

    // The most root descriptors a pipeline layout can have (DeviceDesc::pipelineLayout's
    // rootDescriptorMaxNum): on Vulkan the device's maxPushDescriptors (root descriptors are push
    // descriptors there), 0 without VK_KHR_push_descriptor.
    NRI_INTEROP_API int Nri_GetRootDescriptorMaxNum(nri::Device* device)
    {
        return (int)NRI.GetDeviceDesc(*device).pipelineLayout.rootDescriptorMaxNum;
    }

    // A view of a 2D texture's mips for shaders to read.
    NRI_INTEROP_API nri::Descriptor* Nri_CreateTextureView(nri::Texture* texture, int format)
    {
        nri::Texture2DViewDesc desc = { texture, nri::Texture2DViewType::SHADER_RESOURCE_2D, (nri::Format)format };
        nri::Descriptor* view = nullptr;
        NRI.CreateTexture2DView(desc, view);
        return view;
    }

    // A view of one mip level of a 2D texture for shaders to read (e.g. the level above the one a
    // mip chain generation draws into).
    NRI_INTEROP_API nri::Descriptor* Nri_CreateTextureMipView(nri::Texture* texture, int format, int mip)
    {
        nri::Texture2DViewDesc desc = { texture, nri::Texture2DViewType::SHADER_RESOURCE_2D, (nri::Format)format, (nri::Dim_t)mip, 1 };
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

    // A width x height texture (one mip) of format filled with data (rows rowPitch bytes apart), read
    // by compute shaders on either queue: shared by the queues, uploaded on the queue (which this
    // waits for) and left as a shader resource of compute shaders (D3D12: NON_PIXEL_SHADER_RESOURCE,
    // which the compute queue can use). Null on failure; destroyed with Nri_DestroyTexture.
    NRI_INTEROP_API nri::Texture* Nri_CreateUploadedComputeTexture(nri::Device* device, nri::Queue* queue, int width, int height, int format,
        const void* data, int rowPitch)
    {
        nri::TextureDesc desc = ShaderResourceTextureDesc(width, height, format);
        desc.sharingMode = nri::SharingMode::CONCURRENT;
        nri::Texture* texture = nullptr;
        if (NRI.CreateCommittedTexture(*device, nri::MemoryLocation::DEVICE, 0.0f, desc, texture) != nri::Result::SUCCESS)
            return nullptr;

        const uint32_t blockHeight = nri::nriGetFormatProps((nri::Format)format)->blockHeight;
        const uint32_t rows = ((uint32_t)height + blockHeight - 1) / blockHeight;
        nri::TextureSubresourceUploadDesc subresource = { data, 1, (uint32_t)rowPitch, (uint32_t)rowPitch * rows };
        nri::TextureUploadDesc upload = {};
        upload.subresources = &subresource;
        upload.texture = texture;
        upload.after = { nri::AccessBits::SHADER_RESOURCE, nri::Layout::SHADER_RESOURCE, nri::StageBits::COMPUTE_SHADER };
        upload.planes = nri::PlaneBits::ALL;
        if (NRI.UploadData(*queue, &upload, 1, nullptr, 0) != nri::Result::SUCCESS)
        {
            NRI.DestroyTexture(texture);
            return nullptr;
        }
        return texture;
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

    // The bytes of a file Nri_LoadFile read (valid until Nri_DestroyFile), e.g. for a loader taking
    // them (MeshletModel.load), and their count.
    NRI_INTEROP_API const void* Nri_GetFileData(const std::vector<uint8_t>* file)
    {
        return file->data();
    }

    NRI_INTEROP_API int Nri_GetFileSize(const std::vector<uint8_t>* file)
    {
        return (int)file->size();
    }

    // count bytes of a file Nri_LoadFile read, from offset, one per int at dst (0 past its end), as
    // Donut_CopyBinaryFileBytes: for parsers in TypeScript (mobile_nerf_nri's mlp.json).
    NRI_INTEROP_API void Nri_CopyFileBytes(const std::vector<uint8_t>* file, int offset, int count, int* dst)
    {
        for (int i = 0; i < count; i++)
        {
            const size_t index = size_t(offset) + size_t(i);
            dst[i] = index < file->size() ? (*file)[index] : 0;
        }
    }

    // Nri_CreateUploadedBuffer from byteSize bytes of the file at offset; null if they're past its end.
    NRI_INTEROP_API nri::Buffer* Nri_CreateUploadedBufferFromFile(nri::Device* device, nri::Queue* queue, const std::vector<uint8_t>* file,
        int offset, int byteSize, int usage)
    {
        if (offset < 0 || byteSize <= 0 || (size_t)offset + (size_t)byteSize > file->size())
            return nullptr;
        return Nri_CreateUploadedBuffer(device, queue, file->data() + offset, byteSize, usage);
    }

    // Nri_CreateUploadedStructuredBuffer from byteSize bytes of the file at offset; null if they run
    // past its end.
    NRI_INTEROP_API nri::Buffer* Nri_CreateUploadedStructuredBufferFromFile(nri::Device* device, nri::Queue* queue,
        const std::vector<uint8_t>* file, int offset, int byteSize, int stride)
    {
        if (offset < 0 || byteSize <= 0 || (size_t)offset + (size_t)byteSize > file->size())
            return nullptr;
        return Nri_CreateUploadedStructuredBuffer(device, queue, file->data() + offset, byteSize, stride);
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
    // A texture file (DDS, KTX, ... as NRIFramework's utils::LoadTexture reads them, through detex)
    // with all its mip levels, in its format (sRGB: 1, the format's sRGB variant for RGBA8 and BGRA8,
    // as Donut's sRGB loads), in device memory, uploaded on the queue (which this waits for) and left
    // in NriTextureState.ShaderResource; null if it can't be read.
    NRI_INTEROP_API nri::Texture* Nri_LoadTexture(nri::Device* device, nri::Queue* queue, const char* path, int sRGB)
    {
        utils::Texture image;
        if (!utils::LoadTexture(LibraryDirectory() + path, image, false))
            return nullptr;
        int format = (int)image.GetFormat();
        if (sRGB)
            format = Nri_GetSrgbFormat(format);
        nri::TextureDesc desc = ShaderResourceTextureDesc(image.GetWidth(), image.GetHeight(), format);
        desc.mipNum = image.GetMipNum();
        nri::Texture* texture = nullptr;
        if (NRI.CreateCommittedTexture(*device, nri::MemoryLocation::DEVICE, 0.0f, desc, texture) != nri::Result::SUCCESS)
            return nullptr;

        std::vector<nri::TextureSubresourceUploadDesc> subresources(image.GetMipNum());
        for (uint32_t mip = 0; mip < image.GetMipNum(); mip++)
            image.GetSubresource(subresources[mip], mip);
        nri::TextureUploadDesc upload = {};
        upload.subresources = subresources.data();
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

    // A DDS file with a DX10 header (as tools/ktx_to_dds.py writes them), read whole: its header's
    // and DX10 header's fields, the texels after them.
    struct DdsFile
    {
        // "DDS ", the 124-byte header, the 20-byte DX10 header.
        static constexpr size_t headerSize = 4 + 124 + 20;
        std::vector<uint8_t> data;
        uint32_t header[31] = {};
        uint32_t dx10[5] = {};

        // path relative to this library's folder; false (after printing why) on failure.
        bool Read(const char* path)
        {
            if (!ReadFile(LibraryDirectory() + path, data))
                return false;
            if (data.size() < headerSize || memcmp(data.data(), "DDS ", 4) != 0 || memcmp(data.data() + 84, "DX10", 4) != 0)
            {
                printf("ERROR: %s isn't a DDS file with a DX10 header\n", path);
                return false;
            }
            memcpy(header, data.data() + 4, sizeof(header));
            memcpy(dx10, data.data() + 128, sizeof(dx10));
            return true;
        }
    };

    // A DDS file as tools/ktx_to_dds.py writes them (a DX10 header; 2D textures and 2D texture
    // arrays, each layer with all its mips, rows packed) in device memory with all its layers and
    // mips, uploaded on the queue (which this waits for) and left in NriTextureState.ShaderResource;
    // null if it can't be read. RGBA8 (sRGB: 1, its sRGB variant, as Donut's sRGB loads), R16_UNORM
    // and RGBA16F, which NRIFramework's loader (detex) reads one layer of at most.
    NRI_INTEROP_API nri::Texture* Nri_LoadDdsTexture(nri::Device* device, nri::Queue* queue, const char* path, int sRGB)
    {
        DdsFile file;
        if (!file.Read(path))
            return nullptr;
        const std::vector<uint8_t>& data = file.data;
        const uint32_t* header = file.header;
        const uint32_t* dx10 = file.dx10;
        const size_t headerSize = DdsFile::headerSize;
        const uint32_t height = header[2];
        const uint32_t width = header[3];
        const uint32_t mipNum = std::max(header[6], 1u);
        const uint32_t layerNum = std::max(dx10[3], 1u);
        nri::Format format = nri::Format::UNKNOWN;
        uint32_t texelSize = 0;
        switch (dx10[0])
        {
        case 28: // DXGI_FORMAT_R8G8B8A8_UNORM
            format = sRGB ? nri::Format::RGBA8_SRGB : nri::Format::RGBA8_UNORM;
            texelSize = 4;
            break;
        case 29: // DXGI_FORMAT_R8G8B8A8_UNORM_SRGB
            format = nri::Format::RGBA8_SRGB;
            texelSize = 4;
            break;
        case 56: // DXGI_FORMAT_R16_UNORM
            format = nri::Format::R16_UNORM;
            texelSize = 2;
            break;
        case 10: // DXGI_FORMAT_R16G16B16A16_FLOAT
            format = nri::Format::RGBA16_SFLOAT;
            texelSize = 8;
            break;
        default:
            printf("ERROR: %s has an unsupported format (DXGI %u)\n", path, dx10[0]);
            return nullptr;
        }
        if (dx10[1] != 3)
        {
            printf("ERROR: %s isn't a 2D texture, texture array or cubemap\n", path);
            return nullptr;
        }
        // A cubemap (DDS_RESOURCE_MISC_TEXTURECUBE): six faces per array element, +X, -X, +Y, -Y,
        // +Z, -Z, as NRI's layers.
        const uint32_t layers = (dx10[2] & 0x4) != 0 ? layerNum * 6 : layerNum;

        // The subresources, layer by layer, each with its mips (NRI's order too).
        std::vector<nri::TextureSubresourceUploadDesc> subresources;
        size_t offset = headerSize;
        for (uint32_t layer = 0; layer < layers; layer++)
        {
            for (uint32_t mip = 0; mip < mipNum; mip++)
            {
                const uint32_t mipWidth = std::max(width >> mip, 1u);
                const uint32_t mipHeight = std::max(height >> mip, 1u);
                const uint32_t rowPitch = mipWidth * texelSize;
                const uint32_t slicePitch = rowPitch * mipHeight;
                if (offset + slicePitch > data.size())
                {
                    printf("ERROR: %s is shorter than its header says\n", path);
                    return nullptr;
                }
                subresources.push_back({ data.data() + offset, 1, rowPitch, slicePitch });
                offset += slicePitch;
            }
        }

        nri::TextureDesc desc = ShaderResourceTextureDesc((int)width, (int)height, (int)format);
        desc.mipNum = (nri::Dim_t)mipNum;
        desc.layerNum = (nri::Dim_t)layers;
        nri::Texture* texture = nullptr;
        if (NRI.CreateCommittedTexture(*device, nri::MemoryLocation::DEVICE, 0.0f, desc, texture) != nri::Result::SUCCESS)
            return nullptr;

        nri::TextureUploadDesc upload = {};
        upload.subresources = subresources.data();
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

    // The first level of an RGBA8 2D DDS file (as tools/ktx_to_dds.py writes them: a DX10 header,
    // rows packed) in a texture with the whole mip chain below it (1 + floor(log2(max(width,
    // height))) levels; sRGB: 1, RGBA8_SRGB), the other levels zeroed, rendered into later (a color
    // attachment of each level: Nri_CreateColorAttachmentMipView); in device memory, uploaded on the
    // queue (which this waits for) and left in NriTextureState.ShaderResource. As Donut's
    // loadStagingTexture and createMipmappedRenderTarget with the first level copied in. Null (after
    // printing why) on failure.
    NRI_INTEROP_API nri::Texture* Nri_LoadDdsTextureWithMipChain(nri::Device* device, nri::Queue* queue, const char* path, int sRGB)
    {
        DdsFile file;
        if (!file.Read(path))
            return nullptr;
        const std::vector<uint8_t>& data = file.data;
        const uint32_t* header = file.header;
        const uint32_t* dx10 = file.dx10;
        const size_t headerSize = DdsFile::headerSize;
        const uint32_t height = header[2];
        const uint32_t width = header[3];
        // DXGI_FORMAT_R8G8B8A8_UNORM (28) or _SRGB (29), a 2D texture.
        if ((dx10[0] != 28 && dx10[0] != 29) || dx10[1] != 3 || width == 0 || height == 0)
        {
            printf("ERROR: %s isn't an RGBA8 2D texture\n", path);
            return nullptr;
        }
        const uint32_t rowPitch = width * 4;
        if (headerSize + (size_t)rowPitch * height > data.size())
        {
            printf("ERROR: %s is shorter than its header says\n", path);
            return nullptr;
        }
        uint32_t mipNum = 1;
        while ((std::max(width, height) >> mipNum) > 0)
            mipNum++;

        nri::Format format = sRGB || dx10[0] == 29 ? nri::Format::RGBA8_SRGB : nri::Format::RGBA8_UNORM;
        nri::TextureDesc desc = ShaderResourceTextureDesc((int)width, (int)height, (int)format);
        desc.usage = nri::TextureUsageBits::SHADER_RESOURCE | nri::TextureUsageBits::COLOR_ATTACHMENT;
        desc.mipNum = (nri::Dim_t)mipNum;
        nri::Texture* texture = nullptr;
        if (NRI.CreateCommittedTexture(*device, nri::MemoryLocation::DEVICE, 0.0f, desc, texture) != nri::Result::SUCCESS)
            return nullptr;

        // The first level from the file; the others zeros (which also initializes them, as D3D12
        // wants of render targets before they're read).
        std::vector<uint8_t> zeros((size_t)rowPitch * height, 0);
        std::vector<nri::TextureSubresourceUploadDesc> subresources(mipNum);
        for (uint32_t mip = 0; mip < mipNum; mip++)
        {
            const uint32_t mipRowPitch = std::max(width >> mip, 1u) * 4;
            const uint32_t mipSlicePitch = mipRowPitch * std::max(height >> mip, 1u);
            subresources[mip] = { mip == 0 ? data.data() + headerSize : zeros.data(), 1, mipRowPitch, mipSlicePitch };
        }
        nri::TextureUploadDesc upload = {};
        upload.subresources = subresources.data();
        upload.texture = texture;
        upload.after = TextureState(5);
        upload.planes = nri::PlaneBits::ALL;
        if (NRI.UploadData(*queue, &upload, 1, nullptr, 0) != nri::Result::SUCCESS)
        {
            NRI.DestroyTexture(texture);
            return nullptr;
        }
        return texture;
    }

    // A glTF file (path relative to this library's folder) parsed with its buffers, which can be
    // files next to it or data URIs; data null (after printing why) on failure.
    struct GltfFile
    {
        std::string fileName;
        cgltf_data* data = nullptr;

        explicit GltfFile(const char* path)
            : fileName(LibraryDirectory() + path)
        {
            std::vector<uint8_t> file;
            if (!ReadFile(fileName, file))
                return;
            cgltf_options options{};
            cgltf_result result = cgltf_parse(&options, file.data(), file.size(), &data);
            if (result == cgltf_result_success)
                result = cgltf_load_buffers(&options, data, fileName.c_str());
            if (result != cgltf_result_success)
            {
                printf("ERROR: cannot parse %s\n", fileName.c_str());
                if (data)
                    cgltf_free(data);
                data = nullptr;
            }
        }

        ~GltfFile()
        {
            if (data)
                cgltf_free(data);
        }
    };

    // A glTF mesh primitive as the Vulkan-Samples framework loads one (Nri_LoadGltfMesh).
    struct GltfMesh
    {
        // float3 position, float3 normal, float2 texture coordinates (32 bytes a vertex).
        nri::Buffer* vertexBuffer = nullptr;
        // 32-bit indices.
        nri::Buffer* indexBuffer = nullptr;
        int indexCount = 0;
    };

    NRI_INTEROP_API void Nri_DestroyGltfMesh(GltfMesh* mesh)
    {
        if (mesh->vertexBuffer)
            Nri_DestroyBuffer(mesh->vertexBuffer);
        if (mesh->indexBuffer)
            Nri_DestroyBuffer(mesh->indexBuffer);
        delete mesh;
    }

    // The first primitive of a glTF file's first mesh (path relative to this library's folder), as
    // Donut_LoadGltfMesh reads it (core/vulkan_samples_gltf.h: positions, normals and texture
    // coordinates interleaved, 32-bit indices, the nodes' transforms ignored), uploaded on the queue
    // (which this waits for) into a vertex and an index buffer; null (after printing why) on failure.
    NRI_INTEROP_API GltfMesh* Nri_LoadGltfMesh(nri::Device* device, nri::Queue* queue, const char* path)
    {
        GltfFile file(path);
        if (!file.data)
            return nullptr;
        const cgltf_data* data = file.data;
        std::vector<float> vertices;
        std::vector<uint32_t> indices;
        if (data->meshes_count == 0 || data->meshes[0].primitives_count == 0
            || !ReadGltfPrimitive(data->meshes[0].primitives[0], vertices, indices))
        {
            printf("ERROR: cannot load an indexed mesh from %s\n", file.fileName.c_str());
            return nullptr;
        }

        GltfMesh* mesh = new GltfMesh();
        mesh->vertexBuffer = Nri_CreateUploadedBuffer(device, queue, vertices.data(), (int)(vertices.size() * sizeof(float)), 0);
        mesh->indexBuffer = Nri_CreateUploadedBuffer(device, queue, indices.data(), (int)(indices.size() * sizeof(uint32_t)), 1);
        mesh->indexCount = (int)indices.size();
        if (!mesh->vertexBuffer || !mesh->indexBuffer)
        {
            printf("ERROR: cannot create the buffers of %s\n", file.fileName.c_str());
            Nri_DestroyGltfMesh(mesh);
            return nullptr;
        }
        return mesh;
    }

    // Valid as long as the mesh.
    NRI_INTEROP_API nri::Buffer* Nri_GetGltfMeshVertexBuffer(GltfMesh* mesh)
    {
        return mesh->vertexBuffer;
    }

    NRI_INTEROP_API nri::Buffer* Nri_GetGltfMeshIndexBuffer(GltfMesh* mesh)
    {
        return mesh->indexBuffer;
    }

    NRI_INTEROP_API int Nri_GetGltfMeshIndexCount(GltfMesh* mesh)
    {
        return mesh->indexCount;
    }

    // Every primitive of a glTF file's meshes (path relative to this library's folder) with its
    // material, the file's textures and the nodes that instantiate meshes, as Donut_LoadGltfModel
    // reads them (core/vulkan_samples_gltf.h's ReadGltfModel), kept on the CPU to copy out with the
    // functions below; null (after printing why) on failure. Destroyed with Nri_DestroyGltfModel.
    NRI_INTEROP_API GltfModel* Nri_LoadGltfModel(const char* path)
    {
        GltfFile file(path);
        if (!file.data)
            return nullptr;
        GltfModel* model = new GltfModel();
        std::string error;
        if (!ReadGltfModel(file.data, *model, error))
        {
            printf("ERROR: %s in %s\n", error.c_str(), file.fileName.c_str());
            delete model;
            return nullptr;
        }
        return model;
    }

    NRI_INTEROP_API void Nri_DestroyGltfModel(GltfModel* model)
    {
        delete model;
    }

    NRI_INTEROP_API int Nri_GetGltfModelPrimitiveCount(GltfModel* model)
    {
        return (int)model->primitives.size();
    }

    NRI_INTEROP_API int Nri_GetGltfModelVertexCount(GltfModel* model, int primitive)
    {
        return (int)(model->primitives[primitive].vertices.size() / 8);
    }

    NRI_INTEROP_API int Nri_GetGltfModelIndexCount(GltfModel* model, int primitive)
    {
        return (int)model->primitives[primitive].indices.size();
    }

    // A primitive's vertices (8 floats each: float3 position, float3 normal, float2 texture
    // coordinates) into dst.
    NRI_INTEROP_API void Nri_CopyGltfModelVertices(GltfModel* model, int primitive, float* dst)
    {
        const std::vector<float>& vertices = model->primitives[primitive].vertices;
        memcpy(dst, vertices.data(), vertices.size() * sizeof(float));
    }

    // A primitive's indices into dst.
    NRI_INTEROP_API void Nri_CopyGltfModelIndices(GltfModel* model, int primitive, int* dst)
    {
        const std::vector<uint32_t>& indices = model->primitives[primitive].indices;
        memcpy(dst, indices.data(), indices.size() * sizeof(uint32_t));
    }

    // The elements of a primitive's vertex attribute by its name in the file ("COLOR_0"...; 0 if it
    // has none), its floats per element, and the floats (normalized integers converted) into dst.
    NRI_INTEROP_API int Nri_GetGltfModelAttributeCount(GltfModel* model, int primitive, const char* name)
    {
        const auto& attributes = model->primitives[primitive].attributes;
        auto it = attributes.find(name);
        return it == attributes.end() || it->second.components == 0 ? 0 : (int)(it->second.data.size() / size_t(it->second.components));
    }

    NRI_INTEROP_API int Nri_GetGltfModelAttributeComponents(GltfModel* model, int primitive, const char* name)
    {
        const auto& attributes = model->primitives[primitive].attributes;
        auto it = attributes.find(name);
        return it == attributes.end() ? 0 : it->second.components;
    }

    NRI_INTEROP_API void Nri_CopyGltfModelAttribute(GltfModel* model, int primitive, const char* name, float* dst)
    {
        const auto& attributes = model->primitives[primitive].attributes;
        auto it = attributes.find(name);
        if (it != attributes.end())
            memcpy(dst, it->second.data.data(), it->second.data.size() * sizeof(float));
    }

    // Valid as long as the model.
    NRI_INTEROP_API const char* Nri_GetGltfModelBaseColorImage(GltfModel* model, int primitive)
    {
        return model->primitives[primitive].baseColorImage.c_str();
    }

    NRI_INTEROP_API void Nri_CopyGltfModelBaseColorFactor(GltfModel* model, int primitive, float* dst)
    {
        memcpy(dst, model->primitives[primitive].baseColorFactor, 4 * sizeof(float));
    }

    // Valid as long as the model.
    NRI_INTEROP_API const char* Nri_GetGltfModelMeshName(GltfModel* model, int primitive)
    {
        return model->primitives[primitive].meshName.c_str();
    }

    NRI_INTEROP_API int Nri_GetGltfModelPrimitiveMesh(GltfModel* model, int primitive)
    {
        return model->primitives[primitive].mesh;
    }

    NRI_INTEROP_API int Nri_GetGltfModelPrimitiveAlphaMode(GltfModel* model, int primitive)
    {
        return model->primitives[primitive].alphaMode;
    }

    NRI_INTEROP_API int Nri_GetGltfModelMaterialTexture(GltfModel* model, int primitive, int which)
    {
        return model->primitives[primitive].materialTextures[which];
    }

    NRI_INTEROP_API double Nri_GetGltfModelMaterialFactor(GltfModel* model, int primitive, int which)
    {
        const GltfModel::Primitive& p = model->primitives[primitive];
        return which == 0 ? p.metallicFactor : p.roughnessFactor;
    }

    NRI_INTEROP_API int Nri_GetGltfModelTextureCount(GltfModel* model)
    {
        return (int)model->textureImages.size();
    }

    // Valid as long as the model.
    NRI_INTEROP_API const char* Nri_GetGltfModelTextureImage(GltfModel* model, int texture)
    {
        return model->textureImages[texture].c_str();
    }

    NRI_INTEROP_API int Nri_GetGltfModelNodeCount(GltfModel* model)
    {
        return (int)model->nodes.size();
    }

    NRI_INTEROP_API int Nri_GetGltfModelNodeMesh(GltfModel* model, int node)
    {
        return model->nodes[node].mesh;
    }

    // A node's world transform (16 floats, column-major as glm) into dst.
    NRI_INTEROP_API void Nri_CopyGltfModelNodeTransform(GltfModel* model, int node, float* dst)
    {
        memcpy(dst, model->nodes[node].transform, sizeof(float) * 16);
    }

    // A view of a cubemap's six faces and all its mips for shaders to read (TextureCube).
    NRI_INTEROP_API nri::Descriptor* Nri_CreateTextureCubeView(nri::Texture* texture, int format)
    {
        nri::Texture2DViewDesc desc = { texture, nri::Texture2DViewType::SHADER_RESOURCE_CUBE, (nri::Format)format, 0, nri::REMAINING,
            0, 6 };
        nri::Descriptor* view = nullptr;
        NRI.CreateTexture2DView(desc, view);
        return view;
    }

    // A view of a texture's layers (six per cube) and all its mips as an array of cubemaps for
    // shaders to read (TextureCubeArray).
    NRI_INTEROP_API nri::Descriptor* Nri_CreateTextureCubeArrayView(nri::Texture* texture, int format)
    {
        // The layers counted (NRI's D3D11 views make 0 cubes of REMAINING layers).
        nri::Texture2DViewDesc desc = { texture, nri::Texture2DViewType::SHADER_RESOURCE_CUBE_ARRAY, (nri::Format)format, 0,
            nri::REMAINING, 0, NRI.GetTextureDesc(*texture).layerNum };
        nri::Descriptor* view = nullptr;
        NRI.CreateTexture2DView(desc, view);
        return view;
    }

    // A view of all the layers and mips of a 2D texture array for shaders to read (Texture2DArray).
    NRI_INTEROP_API nri::Descriptor* Nri_CreateTextureArrayView(nri::Texture* texture, int format)
    {
        nri::Texture2DViewDesc desc = { texture, nri::Texture2DViewType::SHADER_RESOURCE_2D_ARRAY, (nri::Format)format, 0, nri::REMAINING,
            0, nri::REMAINING };
        nri::Descriptor* view = nullptr;
        NRI.CreateTexture2DView(desc, view);
        return view;
    }

    // --- ImGui (NRIFramework's, drawn by NRI's Imgui extension) ---------------------------------
    // A frame: Nri_ImguiNewFrame, the widgets, Nri_ImguiRender (before recording);
    // Nri_CmdCopyImguiData outside a render pass, Nri_CmdDrawImgui inside one; Nri_ImguiEndFrame after
    // the frame's submission. The window's input reaches ImGui through NRIFramework.

    // The example draws ImGui: before Nri_RunSample (the device is made for it).
    NRI_INTEROP_API void Nri_UseImgui(TsSample* sample)
    {
        sample->m_UsesImgui = true;
    }

    // ImGui and its renderer for the device (after Nri_UseImgui), and the streamer that uploads its
    // geometry; 1, or 0 on failure. Destroyed with Nri_DestroyImgui, before the device.
    NRI_INTEROP_API int Nri_InitImgui(TsSample* sample, nri::Device* device)
    {
        nri::StreamerInterface streamer = {};
        if (nri::nriGetInterface(*device, NRI_INTERFACE(nri::StreamerInterface), &streamer) != nri::Result::SUCCESS)
            return 0;
        nri::StreamerDesc streamerDesc = {};
        streamerDesc.dynamicBufferMemoryLocation = nri::MemoryLocation::HOST_UPLOAD;
        streamerDesc.dynamicBufferDesc = { 0, 0, nri::BufferUsageBits::VERTEX_BUFFER | nri::BufferUsageBits::INDEX_BUFFER };
        streamerDesc.constantBufferMemoryLocation = nri::MemoryLocation::HOST_UPLOAD;
        streamerDesc.queuedFrameNum = sample->GetQueuedFrameNum();
        if (streamer.CreateStreamer(*device, streamerDesc, sample->m_Streamer) != nri::Result::SUCCESS)
            return 0;
        sample->m_StreamerInterface = streamer;
        return sample->InitImgui(*device) ? 1 : 0;
    }

    NRI_INTEROP_API void Nri_DestroyImgui(TsSample* sample)
    {
        sample->DestroyImgui();
        if (sample->m_Streamer)
            sample->m_StreamerInterface.DestroyStreamer(sample->m_Streamer);
        sample->m_Streamer = nullptr;
    }

    NRI_INTEROP_API void Nri_ImguiNewFrame(TsSample*)
    {
        ImGui::NewFrame();
    }

    NRI_INTEROP_API void Nri_ImguiRender(TsSample*)
    {
        ImGui::EndFrame();
        ImGui::Render();
    }

    NRI_INTEROP_API void Nri_CmdCopyImguiData(TsSample* sample, nri::CommandBuffer* commandBuffer)
    {
        if (sample->m_Streamer)
            sample->CmdCopyImguiData(*commandBuffer, *sample->m_Streamer);
    }

    // Draws the UI into the render pass's color attachment, of attachmentFormat (sRGB or not).
    NRI_INTEROP_API void Nri_CmdDrawImgui(TsSample* sample, nri::CommandBuffer* commandBuffer, int attachmentFormat)
    {
        const nri::FormatProps* props = nri::nriGetFormatProps((nri::Format)attachmentFormat);
        sample->CmdDrawImgui(*commandBuffer, (nri::Format)attachmentFormat, 1.0f, props->isSrgb);
    }

    NRI_INTEROP_API void Nri_ImguiEndFrame(TsSample* sample)
    {
        if (sample->m_Streamer)
            sample->m_StreamerInterface.EndStreamerFrame(*sample->m_Streamer);
    }

    // ImGui uses the mouse (it's over a window, or dragging a widget): the example shouldn't.
    NRI_INTEROP_API int Nri_ImguiWantsMouse()
    {
        return ImGui::GetCurrentContext() && ImGui::GetIO().WantCaptureMouse ? 1 : 0;
    }

    // The widgets, as Donut's (donut_interop's Donut_ImGui*).
    NRI_INTEROP_API void Nri_ImguiSetNextWindowPos(double x, double y)
    {
        ImGui::SetNextWindowPos(ImVec2(float(x), float(y)), 0);
    }

    // autoResize != 0: the window fits its contents. Always pair with Nri_ImguiEnd.
    NRI_INTEROP_API void Nri_ImguiBegin(const char* title, int autoResize)
    {
        ImGui::Begin(title, nullptr, autoResize ? ImGuiWindowFlags_AlwaysAutoResize : 0);
    }

    NRI_INTEROP_API void Nri_ImguiEnd()
    {
        ImGui::End();
    }

    NRI_INTEROP_API void Nri_ImguiText(const char* text)
    {
        ImGui::TextUnformatted(text);
    }

    NRI_INTEROP_API void Nri_ImguiPushItemWidth(double width)
    {
        ImGui::PushItemWidth(float(width));
    }

    NRI_INTEROP_API void Nri_ImguiPopItemWidth()
    {
        ImGui::PopItemWidth();
    }

    // Expanded until the user collapses it (defaultOpen != 0); 1 while expanded.
    NRI_INTEROP_API int Nri_ImguiCollapsingHeader(const char* label, int defaultOpen)
    {
        return ImGui::CollapsingHeader(label, defaultOpen ? ImGuiTreeNodeFlags_DefaultOpen : 0) ? 1 : 0;
    }

    // The checkbox's new state (value, unless it was clicked).
    NRI_INTEROP_API int Nri_ImguiCheckbox(const char* label, int value)
    {
        bool checked = value != 0;
        ImGui::Checkbox(label, &checked);
        return checked ? 1 : 0;
    }

    // The selection among items (separated by '|').
    NRI_INTEROP_API int Nri_ImguiCombo(const char* label, int current, const char* items)
    {
        // ImGui wants the items separated by NULs, with an extra NUL at the end.
        std::string zeroSeparated(items);
        for (char& c : zeroSeparated)
            if (c == '|')
                c = '\0';
        zeroSeparated.push_back('\0');
        int selection = current;
        ImGui::Combo(label, &selection, zeroSeparated.c_str());
        return selection;
    }

    NRI_INTEROP_API double Nri_ImguiSliderFloat(const char* label, double value, double min, double max)
    {
        float v = float(value);
        ImGui::SliderFloat(label, &v, float(min), float(max));
        return v;
    }

    // ImGui::InputFloat with +/- buttons of step (as Donut_ImGuiInputFloat: no fast step), the value
    // shown in format ("%.3f").
    NRI_INTEROP_API double Nri_ImguiInputFloat(const char* label, double value, double step, const char* format)
    {
        float v = float(value);
        ImGui::InputFloat(label, &v, float(step), 0.f, format);
        return v;
    }

    NRI_INTEROP_API int Nri_ImguiSliderInt(const char* label, int value, int min, int max)
    {
        ImGui::SliderInt(label, &value, min, max);
        return value;
    }

    // 1 if the button was clicked.
    NRI_INTEROP_API int Nri_ImguiButton(const char* label)
    {
        return ImGui::Button(label) ? 1 : 0;
    }

    // A radio button shown selected when active is non-zero; 1 if it was clicked.
    NRI_INTEROP_API int Nri_ImguiRadioButton(const char* label, int active)
    {
        return ImGui::RadioButton(label, active != 0) ? 1 : 0;
    }

    // Scopes the IDs of the widgets that follow (ones with the same labels apart) until the
    // matching Nri_ImguiPopID.
    NRI_INTEROP_API void Nri_ImguiPushID(int id)
    {
        ImGui::PushID(id);
    }

    NRI_INTEROP_API void Nri_ImguiPopID()
    {
        ImGui::PopID();
    }

    // The next item on the same line as the last.
    NRI_INTEROP_API void Nri_ImguiSameLine()
    {
        ImGui::SameLine();
    }

    // Places the next window with its pivot (0..1 of its size; 1, 0 = top right corner) at x, y.
    NRI_INTEROP_API void Nri_ImguiSetNextWindowPosPivot(double x, double y, double pivotX, double pivotY)
    {
        ImGui::SetNextWindowPos(ImVec2(float(x), float(y)), 0, ImVec2(float(pivotX), float(pivotY)));
    }

    // A value dragged by speed per pixel, within min and max; the new value.
    NRI_INTEROP_API double Nri_ImguiDragFloat(const char* label, double value, double speed, double min, double max)
    {
        float v = float(value);
        ImGui::DragFloat(label, &v, float(speed), float(min), float(max));
        return v;
    }

    // A color edit of the 4 floats at values (RGBA), width wide; 1 when changed.
    NRI_INTEROP_API int Nri_ImguiColorEdit4(const char* label, float* values, double width)
    {
        ImGui::PushItemWidth(float(width));
        bool changed = ImGui::ColorEdit4(label, values, ImGuiColorEditFlags_Float);
        ImGui::PopItemWidth();
        return changed ? 1 : 0;
    }

    // Text at (x, y) in UI coordinates (its top-left corner, or with alignRight its top-right one) in
    // the default font and color (r, g, b, a), on the background draw list: behind the windows, no
    // window needed (between Nri_ImguiNewFrame and Nri_ImguiRender).
    NRI_INTEROP_API void Nri_ImguiDrawText(double x, double y, const char* text, double r, double g, double b, double a, int alignRight)
    {
        ImVec2 position{ float(x), float(y) };
        if (alignRight)
            position.x -= ImGui::CalcTextSize(text).x;
        ImGui::GetBackgroundDrawList()->AddText(ImGui::GetFont(), ImGui::GetFontSize(), position,
            ImGui::GetColorU32(ImVec4(float(r), float(g), float(b), float(a))), text);
    }

    // A filled rectangle from (x0, y0) to (x1, y1) in UI coordinates, on the background draw list (e.g.
    // a box under Nri_ImguiDrawText's text).
    NRI_INTEROP_API void Nri_ImguiDrawRect(double x0, double y0, double x1, double y1, double r, double g, double b, double a)
    {
        ImGui::GetBackgroundDrawList()->AddRectFilled(ImVec2(float(x0), float(y0)), ImVec2(float(x1), float(y1)),
            ImGui::GetColorU32(ImVec4(float(r), float(g), float(b), float(a))));
    }

    // The width of a line of text in the default font, in UI coordinates.
    NRI_INTEROP_API double Nri_ImguiCalcTextWidth(const char* text)
    {
        return ImGui::CalcTextSize(text).x;
    }

    // The height of a line of text in the default font, in UI coordinates.
    NRI_INTEROP_API double Nri_ImguiGetFontSize()
    {
        return ImGui::GetFontSize();
    }

    // A color picker of the 3 floats (RGB, unbounded: HDR) at values, width wide, without previews,
    // as Vulkan-Samples' Drawer::color_op<Pick>; 1 when changed.
    NRI_INTEROP_API int Nri_ImguiColorPicker3(const char* label, float* values, double width)
    {
        ImGui::PushItemWidth(float(width));
        bool changed = ImGui::ColorPicker3(label, values, ImGuiColorEditFlags_NoSidePreview | ImGuiColorEditFlags_NoSmallPreview
            | ImGuiColorEditFlags_Float | ImGuiColorEditFlags_HDR);
        ImGui::PopItemWidth();
        return changed ? 1 : 0;
    }

    // --- Compute ------------------------------------------------------------------------------

    // A compute pipeline of the shader read from path (as Nri_CreateGraphicsPipeline's), entry: of a
    // ShaderMake permutation blob, the permutation whose defines are permutation ("NAME=VALUE", or
    // "" for a blob of one); null on failure.
    NRI_INTEROP_API nri::Pipeline* Nri_CreateComputePipelinePermutation(nri::Device* device, nri::PipelineLayout* pipelineLayout,
        const char* path, const char* entry, const char* permutation)
    {
        std::vector<uint8_t> bytecode;
        if (!ReadShader(LibraryDirectory() + path, bytecode, permutation))
            return nullptr;
        nri::ComputePipelineDesc desc = {};
        desc.pipelineLayout = pipelineLayout;
        desc.shader = { nri::StageBits::COMPUTE_SHADER, bytecode.data(), bytecode.size(), entry };
        nri::Pipeline* pipeline = nullptr;
        if (NRI.CreateComputePipeline(*device, desc, pipeline) != nri::Result::SUCCESS)
            return nullptr;
        return pipeline;
    }

    // A compute pipeline of the shader read from path, entry; null on failure.
    NRI_INTEROP_API nri::Pipeline* Nri_CreateComputePipeline(nri::Device* device, nri::PipelineLayout* pipelineLayout, const char* path,
        const char* entry)
    {
        return Nri_CreateComputePipelinePermutation(device, pipelineLayout, path, entry, "");
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

    // As Nri_CreateStorageTexture, filled with data (rows rowPitch bytes apart) and left in state (an
    // NriTextureState: Storage, or PixelStorage for pixel shaders' RWTexture2D); null on failure.
    NRI_INTEROP_API nri::Texture* Nri_CreateStorageTextureWithData(nri::Device* device, nri::Queue* queue, int width, int height, int format,
        const void* data, int rowPitch, int state)
    {
        nri::TextureDesc desc = ShaderResourceTextureDesc(width, height, format);
        desc.usage = nri::TextureUsageBits::SHADER_RESOURCE | nri::TextureUsageBits::SHADER_RESOURCE_STORAGE;
        nri::Texture* texture = nullptr;
        if (NRI.CreateCommittedTexture(*device, nri::MemoryLocation::DEVICE, 0.0f, desc, texture) != nri::Result::SUCCESS)
            return nullptr;

        const uint32_t blockHeight = nri::nriGetFormatProps((nri::Format)format)->blockHeight;
        const uint32_t rows = ((uint32_t)height + blockHeight - 1) / blockHeight;
        nri::TextureSubresourceUploadDesc subresource = { data, 1, (uint32_t)rowPitch, (uint32_t)rowPitch * rows };
        nri::TextureUploadDesc upload = {};
        upload.subresources = &subresource;
        upload.texture = texture;
        upload.after = TextureState(state);
        upload.planes = nri::PlaneBits::ALL;
        if (NRI.UploadData(*queue, &upload, 1, nullptr, 0) != nri::Result::SUCCESS)
        {
            NRI.DestroyTexture(texture);
            return nullptr;
        }
        return texture;
    }

    // A 1 x 1 RGBA8_UNORM texture of layerNum layers (6 or more: views of cubemaps too), every texel
    // rgba (0xAABBGGRR), left in state: Donut's CommonRenderPasses black and white textures, which
    // its passes bind for the inputs they're not given. Null on failure.
    NRI_INTEROP_API nri::Texture* Nri_CreateSolidTexture(nri::Device* device, nri::Queue* queue, int layerNum, int rgba, int state)
    {
        nri::TextureDesc desc = ShaderResourceTextureDesc(1, 1, (int)nri::Format::RGBA8_UNORM);
        desc.layerNum = (nri::Dim_t)layerNum;
        nri::Texture* texture = nullptr;
        if (NRI.CreateCommittedTexture(*device, nri::MemoryLocation::DEVICE, 0.0f, desc, texture) != nri::Result::SUCCESS)
            return nullptr;

        const uint32_t texel = (uint32_t)rgba;
        std::vector<nri::TextureSubresourceUploadDesc> subresources((size_t)layerNum, { &texel, 1, 4, 4 });
        nri::TextureUploadDesc upload = {};
        upload.subresources = subresources.data();
        upload.texture = texture;
        upload.after = TextureState(state);
        upload.planes = nri::PlaneBits::ALL;
        if (NRI.UploadData(*queue, &upload, 1, nullptr, 0) != nri::Result::SUCCESS)
        {
            NRI.DestroyTexture(texture);
            return nullptr;
        }
        return texture;
    }

    // A width x height texture (one mip) rendered into (a color attachment, Nri_CreateColorAttachmentView)
    // and read by pixel shaders, in device memory, moved on the queue (which this waits for) to
    // NriTextureState.ShaderResource; null on failure.
    NRI_INTEROP_API nri::Texture* Nri_CreateRenderTargetTexture(nri::Device* device, nri::Queue* queue, int width, int height, int format)
    {
        nri::TextureDesc desc = ShaderResourceTextureDesc(width, height, format);
        desc.usage = nri::TextureUsageBits::SHADER_RESOURCE | nri::TextureUsageBits::COLOR_ATTACHMENT;
        nri::Texture* texture = nullptr;
        if (NRI.CreateCommittedTexture(*device, nri::MemoryLocation::DEVICE, 0.0f, desc, texture) != nri::Result::SUCCESS)
            return nullptr;

        nri::TextureUploadDesc upload = {};
        upload.texture = texture;
        upload.after = TextureState(5);
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

    // A width x height R8_UINT shading rate attachment (a texel per Nri_GetShadingRateTileSize square
    // of pixels; D3D12_SHADING_RATE values, which Vulkan's are too: log2(width) << 2 | log2(height)),
    // filled with data (rows rowPitch bytes apart), written by compute shaders too if storage (its
    // view: Nri_CreateStorageTextureView with R8_UINT), left in NriTextureState.ShadingRateAttachment;
    // null on failure. Destroyed with Nri_DestroyTexture.
    NRI_INTEROP_API nri::Texture* Nri_CreateShadingRateTexture(nri::Device* device, nri::Queue* queue, int width, int height,
        const void* data, int rowPitch, int storage)
    {
        nri::TextureDesc desc = ShaderResourceTextureDesc(width, height, (int)nri::Format::R8_UINT);
        desc.usage = nri::TextureUsageBits::SHADING_RATE_ATTACHMENT;
        if (storage != 0)
            desc.usage |= nri::TextureUsageBits::SHADER_RESOURCE_STORAGE;
        nri::Texture* texture = nullptr;
        if (NRI.CreateCommittedTexture(*device, nri::MemoryLocation::DEVICE, 0.0f, desc, texture) != nri::Result::SUCCESS)
            return nullptr;

        nri::TextureSubresourceUploadDesc subresource = { data, 1, (uint32_t)rowPitch, (uint32_t)rowPitch * (uint32_t)height };
        nri::TextureUploadDesc upload = {};
        upload.subresources = &subresource;
        upload.texture = texture;
        upload.after = TextureState(9);
        upload.planes = nri::PlaneBits::ALL;
        if (NRI.UploadData(*queue, &upload, 1, nullptr, 0) != nri::Result::SUCCESS)
        {
            NRI.DestroyTexture(texture);
            return nullptr;
        }
        return texture;
    }

    // The view a shading rate attachment is rendered with (Nri_CmdBeginRenderingWithShadingRate).
    NRI_INTEROP_API nri::Descriptor* Nri_CreateShadingRateAttachmentView(nri::Texture* texture)
    {
        nri::Texture2DViewDesc desc = { texture, nri::Texture2DViewType::SHADING_RATE_ATTACHMENT, nri::Format::R8_UINT, 0, 1 };
        nri::Descriptor* view = nullptr;
        NRI.CreateTexture2DView(desc, view);
        return view;
    }

    // A width x height texture (one mip) rendered into (a color attachment) and read and written by
    // shaders (RWTexture2D: Nri_CreateStorageTextureView), in device memory, moved on the queue (which
    // this waits for) to state (an NriTextureState); null on failure. Like any render target, D3D12
    // wants it cleared (as a color attachment) before shaders use it.
    NRI_INTEROP_API nri::Texture* Nri_CreateRenderTargetStorageTexture(nri::Device* device, nri::Queue* queue, int width, int height, int format,
        int state)
    {
        nri::TextureDesc desc = ShaderResourceTextureDesc(width, height, format);
        desc.usage = nri::TextureUsageBits::SHADER_RESOURCE_STORAGE | nri::TextureUsageBits::COLOR_ATTACHMENT;
        nri::Texture* texture = nullptr;
        if (NRI.CreateCommittedTexture(*device, nri::MemoryLocation::DEVICE, 0.0f, desc, texture) != nri::Result::SUCCESS)
            return nullptr;

        nri::TextureUploadDesc upload = {};
        upload.texture = texture;
        upload.after = TextureState(state);
        upload.planes = nri::PlaneBits::ALL;
        if (NRI.UploadData(*queue, &upload, 1, nullptr, 0) != nri::Result::SUCCESS)
        {
            NRI.DestroyTexture(texture);
            return nullptr;
        }
        return texture;
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

    // The root constants of the runs from now on (byteSize bytes from data, copied; the layout's
    // root constants must be that size), instead of the run index.
    NRI_INTEROP_API void Nri_SetAsyncComputeConstants(AsyncComputeLoop* loop, const void* data, int byteSize)
    {
        std::lock_guard lock(loop->constantsMutex);
        loop->constants.assign((const uint8_t*)data, (const uint8_t*)data + byteSize);
    }

    // Non-zero: the worker starts no more runs until resumed (the run under way finishes).
    NRI_INTEROP_API void Nri_SetAsyncComputePaused(AsyncComputeLoop* loop, int paused)
    {
        loop->paused = paused != 0;
    }

    // Runs the worker has submitted so far.
    NRI_INTEROP_API int Nri_GetAsyncComputeRunCount(AsyncComputeLoop* loop)
    {
        return loop->runCount.load();
    }
}
