// Flat C API over Donut for mycode.ts.
//
// TSLANG's `declare function` binds by literal symbol name only (no C++ name mangling),
// and it can't express virtual overrides, smart pointers or STL types, so everything the
// TypeScript side needs goes through the extern "C" functions below, using opaque handles
// and plain scalars.
//
// C++ owns the application (device manager, window, message loop, teardown order) and every
// GPU resource handed to TypeScript; TypeScript supplies render passes, as objects whose
// methods are the callbacks.
//
// Callbacks: a TypeScript method passed as a callback (`this.onRender`) arrives here as
// two arguments: a function pointer taking `this` first, then the `this` value itself
// (the same lowering tslang's Win32 sample relies on). The TypeScript object is referenced
// only from C++ heap memory here, which the GC does not scan, so the TypeScript side must
// keep it alive (e.g. in a module-level variable) until Donut_DestroyApp.

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

#include <donut/app/ApplicationBase.h>
#include <donut/app/Camera.h>
#include <donut/app/DeviceManager.h>
#include <donut/app/UserInterfaceUtils.h>
#include <donut/app/imgui_renderer.h>
#include <imgui.h>
#include <donut/core/log.h>
#include <donut/core/vfs/VFS.h>
#include <donut/engine/BindingCache.h>
#include <donut/engine/CommonRenderPasses.h>
#include <donut/engine/DescriptorTableManager.h>
#include <donut/engine/ShaderFactory.h>
#include <donut/engine/DDSFile.h>
#include <donut/engine/TextureCache.h>
#include <donut/engine/FramebufferFactory.h>
#include <donut/engine/Scene.h>
#include <donut/engine/ThreadPool.h>
#include <donut/engine/View.h>
#include <donut/render/BloomPass.h>
#include <donut/render/CascadedShadowMap.h>
#include <donut/render/DeferredLightingPass.h>
#include <donut/render/DepthPass.h>
#include <donut/render/DLSS.h>
#include <donut/render/DrawStrategy.h>
#include <donut/render/EnvironmentMapPass.h>
#include <donut/render/ForwardShadingPass.h>
#include <donut/render/GBuffer.h>
#include <donut/render/GBufferFillPass.h>
#include <donut/render/GeometryPasses.h>
#include <donut/render/LightProbeProcessingPass.h>
#include <donut/render/MipMapGenPass.h>
#include <donut/render/PixelReadbackPass.h>
#include <donut/render/PlanarShadowMap.h>
#include <donut/render/SkyPass.h>
#include <donut/render/SsaoPass.h>
#include <donut/render/TemporalAntiAliasingPass.h>
#include <donut/render/ToneMappingPasses.h>
#include <nvrhi/common/misc.h>
#include <nvrhi/utils.h>

#if DONUT_WITH_VULKAN
#include <donut/app/DeviceManager_VK.h>
#endif

#if DONUT_WITH_DX11 || DONUT_WITH_DX12
// IDXGIAdapter3::QueryVideoMemoryInfo (Donut_QueryMemoryBudget).
#include <dxgi1_4.h>
#endif
#ifdef _WIN32
// IDXGIOutput6::GetDesc1, whether the window's display is in HDR mode (Donut_IsDisplayHdr), and
// the window's HWND.
#include <dxgi1_6.h>
#pragma comment(lib, "dxgi.lib")
#endif
#if DONUT_WITH_DX11
#include <d3d11_2.h>
#include <nvrhi/d3d11.h>
#endif
#if DONUT_WITH_DX12
#include <d3d12.h>
#include <nvrhi/d3d12.h>
// From the Agility SDK (see CMakeLists.txt), for the work graph state object.
#include <d3dx12/d3dx12.h>
#include <wrl/client.h>
#endif

// Shared with HLSL, so they use the math types unqualified (as Donut's own sources include them).
using namespace donut::math;
#include <donut/shaders/bindless.h>
#include <donut/shaders/light_cb.h>
#include <donut/shaders/material_cb.h>
#include <donut/shaders/view_cb.h>

#include <GLFW/glfw3.h>
#ifdef _WIN32
#define GLFW_EXPOSE_NATIVE_WIN32
#include <GLFW/glfw3native.h>
#endif
// Its implementation is compiled into donut_engine (GltfImporter.cpp).
#include <cgltf.h>

#include <atomic>
#include <chrono>
#include <cstring>
#include <map>
#include <memory>
#include <mutex>
#include <queue>
#include <thread>
#include <unordered_map>
#include <random>
#include <vector>

using donut::app::DeviceManager;

namespace
{
    template <typename Fn>
    struct Callback
    {
        Fn method = nullptr;
        void* thisVal = nullptr;

        explicit operator bool() const { return method != nullptr; }
    };

    struct FrameContext;

    using VoidFn = void (*)(void* thisVal);
    using RenderFn = void (*)(void* thisVal, FrameContext* frame);
    using AnimateFn = void (*)(void* thisVal, double elapsedSeconds);
    using KeyboardFn = int (*)(void* thisVal, int key, int scancode, int action, int mods);
    using MousePosFn = int (*)(void* thisVal, double x, double y);
    using MouseButtonFn = int (*)(void* thisVal, int button, int action, int mods);
    using MouseScrollFn = int (*)(void* thisVal, double xOffset, double yOffset);

    // Passed to the TypeScript render callback; only valid for the duration of that call.
    struct FrameContext
    {
        nvrhi::ICommandList* commandList;
        nvrhi::IFramebuffer* framebuffer;
        // What executeCommandList returned for this pass's previous frame (0 before the first).
        uint64_t previousSubmission;
        // Built up by Donut_BeginDraw / Donut_Draw* and used by Donut_DrawIndexed / Donut_DrawVertices.
        nvrhi::GraphicsState draw;
        // Donut_BeginMeshDraw's pipeline: Donut_DrawMeshTasks takes the rest from `draw`.
        nvrhi::IMeshletPipeline* meshletPipeline = nullptr;
    };

    // What Donut_CreateGraphicsPipelineDesc and Donut_CreateMeshletPipelineDesc return: a graphics
    // pipeline description, plus the amplification and mesh shaders of a meshlet pipeline.
    struct PipelineDesc : nvrhi::GraphicsPipelineDesc
    {
        nvrhi::ShaderHandle AS;
        nvrhi::ShaderHandle MS;
    };

    class TsRenderPass : public donut::app::IRenderPass
    {
    public:
        explicit TsRenderPass(DeviceManager* deviceManager)
            : IRenderPass(deviceManager)
        {
            m_CommandList = GetDevice()->createCommandList();
        }

        void Render(nvrhi::IFramebuffer* framebuffer) override
        {
            m_CommandList->open();

            if (m_Render)
            {
                FrameContext frame{ m_CommandList, framebuffer, m_LastSubmission };
                m_Render.method(m_Render.thisVal, &frame);
            }

            m_CommandList->close();
            m_LastSubmission = GetDevice()->executeCommandList(m_CommandList);
        }

        void Animate(float elapsedTimeSeconds) override
        {
            if (m_Animate)
                m_Animate.method(m_Animate.thisVal, elapsedTimeSeconds);
        }

        void BackBufferResizing() override
        {
            if (m_BackBufferResizing)
                m_BackBufferResizing.method(m_BackBufferResizing.thisVal);
        }

        bool KeyboardUpdate(int key, int scancode, int action, int mods) override
        {
            return m_Keyboard && m_Keyboard.method(m_Keyboard.thisVal, key, scancode, action, mods) != 0;
        }

        bool MousePosUpdate(double x, double y) override
        {
            return m_MousePos && m_MousePos.method(m_MousePos.thisVal, x, y) != 0;
        }

        bool MouseButtonUpdate(int button, int action, int mods) override
        {
            return m_MouseButton && m_MouseButton.method(m_MouseButton.thisVal, button, action, mods) != 0;
        }

        bool MouseScrollUpdate(double xOffset, double yOffset) override
        {
            return m_MouseScroll && m_MouseScroll.method(m_MouseScroll.thisVal, xOffset, yOffset) != 0;
        }

        bool ShouldAnimateUnfocused() override { return m_RunWhenUnfocused; }
        bool ShouldRenderUnfocused() override { return m_RunWhenUnfocused; }

        bool m_RunWhenUnfocused = false;
        Callback<RenderFn> m_Render;
        Callback<AnimateFn> m_Animate;
        Callback<VoidFn> m_BackBufferResizing;
        Callback<KeyboardFn> m_Keyboard;
        Callback<MousePosFn> m_MousePos;
        Callback<MouseButtonFn> m_MouseButton;
        Callback<MouseScrollFn> m_MouseScroll;

    private:
        nvrhi::CommandListHandle m_CommandList;
        uint64_t m_LastSubmission = 0;
    };

    // Donut's ImGui renderer, with the UI built by a TypeScript callback (using the Donut_ImGui*
    // functions) every frame.
    class TsImGuiPass : public donut::app::ImGui_Renderer
    {
    public:
        explicit TsImGuiPass(DeviceManager* deviceManager)
            : ImGui_Renderer(deviceManager)
        {
            ImGui::GetIO().IniFilename = nullptr;
        }

        Callback<VoidFn> m_BuildUI;
        // Where the UI is drawn instead of the back buffer (Donut_SetImGuiPassFramebuffer), if set.
        nvrhi::FramebufferHandle m_Framebuffer;

        void Render(nvrhi::IFramebuffer* framebuffer) override
        {
            ImGui_Renderer::Render(m_Framebuffer ? m_Framebuffer.Get() : framebuffer);
        }

        // For the Donut_ImGui* functions; the base class keeps these protected.
        using ImGui_Renderer::BeginFullScreenWindow;
        using ImGui_Renderer::DrawScreenCenteredText;
        using ImGui_Renderer::EndFullScreenWindow;

    protected:
        void buildUI() override
        {
            if (m_BuildUI)
                m_BuildUI.method(m_BuildUI.thisVal);
        }
    };

    // Bits of Donut_GetMemoryHeapFlags: Vulkan's VkMemoryHeapFlags.
    enum MemoryHeapFlag
    {
        MemoryHeapFlag_DeviceLocal = 1,
        MemoryHeapFlag_MultiInstance = 2,
    };

    // A memory heap's state (Donut_QueryMemoryBudget): this process's usage and its budget, in bytes,
    // and the heap's MemoryHeapFlag bits.
    struct MemoryHeap
    {
        double usage = 0.0;
        double budget = 0.0;
        int flags = 0;
    };

    struct App
    {
        std::unique_ptr<DeviceManager> deviceManager;
        // Sees the example's shaders under "app/" and Donut's framework shaders under "donut/".
        std::shared_ptr<donut::engine::ShaderFactory> shaderFactory;
        std::vector<std::unique_ptr<TsRenderPass>> passes;
        // GPU resources handed to TypeScript as raw pointers; the app holds the reference.
        std::unordered_map<nvrhi::IResource*, nvrhi::RefCountPtr<nvrhi::IResource>> resources;
        // Other C++ objects handed to TypeScript as raw pointers (scenes, cameras, ...).
        std::unordered_map<void*, std::shared_ptr<void>> objects;
        // Passes that aren't TsRenderPass (e.g. the ImGui one).
        std::vector<std::unique_ptr<donut::app::IRenderPass>> otherPasses;
        // Texture caches that register their textures in a descriptor table, by its manager.
        std::unordered_map<void*, std::shared_ptr<donut::engine::TextureCache>> bindlessTextureCaches;
        // IndirectDrawSupport bits (Donut_GetIndirectDrawSupport).
        int indirectDrawSupport = 0;
        // Whether pixel shaders can write to and do atomics on UAVs (Donut_HasFragmentStoresAndAtomics).
        bool fragmentStoresAndAtomics = false;
        // Whether 2D textures can be tiled, with residency queries in shaders (Donut_HasSparseResidency).
        bool sparseResidency = false;
        // Vulkan's pipelineStatisticsQuery feature, enabled (Donut_CreateMeshPipelineStatistics).
        bool pipelineStatisticsQuery = false;
        // Whether draws can be skipped by a value in a buffer (Donut_HasConditionalRendering).
        bool conditionalRendering = false;
        // Whether pixel shaders can use rasterizer ordered views (Donut_HasRasterizerOrderedViews).
        bool rasterizerOrderedViews = false;
        // Whether pixel shaders can read barycentrics and per-vertex attributes (Donut_HasBarycentrics).
        bool barycentrics = false;
        // ComputeDerivatives bits: derivatives in compute shaders (Donut_GetComputeShaderDerivatives).
        int computeShaderDerivatives = 0;
        // Whether blend states can do logic operations (Donut_HasLogicOps).
        bool logicOps = false;
        // Whether pipelines can test the depth target against bounds (Donut_HasDepthBoundsTest).
        bool depthBoundsTest = false;
        // ShaderExecutionReordering value (Donut_GetShaderExecutionReordering).
        int shaderExecutionReordering = 0;
        // Whether shaders can compute with 16-bit types and read them from buffers
        // (Donut_HasNative16BitShaderOps), and from push constants too (Donut_HasNative16BitConstants).
        bool native16Bit = false;
        bool native16BitConstants = false;
        // AdvancedBlend bits (Donut_GetAdvancedBlendOperations).
        int advancedBlendOperations = 0;
        // Whether pixel shaders can ask for full quads (Donut_HasShaderQuadControl).
        bool shaderQuadControl = false;
        // The memory heaps as Donut_QueryMemoryBudget last found them.
        std::vector<MemoryHeap> memoryHeaps;
        // LineRasterization bits (Donut_GetLineRasterizationModes) and the widest line
        // (Donut_GetMaxLineWidth).
        int lineRasterizationModes = 0;
        float maxLineWidth = 1.f;

        nvrhi::IDevice* device() const { return deviceManager->GetDevice(); }

        // Executes a command list (Donut_ExecuteCommandList) and holds it until the GPU has
        // finished it: its upload and scratch memory (texture uploads, acceleration structure
        // builds) belongs to the command list, not to the submission, so TypeScript releasing it
        // right after executing it would free memory the GPU still reads.
        void ExecuteCommandList(nvrhi::ICommandList* commandList)
        {
            RetireCommandLists();
            device()->executeCommandList(commandList);
            nvrhi::EventQueryHandle finished = device()->createEventQuery();
            device()->setEventQuery(finished, nvrhi::CommandQueue::Graphics);
            m_PendingCommandLists.push_back({ commandList, finished });
        }

        // Releases the held command lists the GPU has finished (every frame, and on execution).
        void RetireCommandLists()
        {
            m_PendingCommandLists.erase(std::remove_if(m_PendingCommandLists.begin(), m_PendingCommandLists.end(),
                [this](const PendingCommandList& pending) { return device()->pollEventQuery(pending.finished); }),
                m_PendingCommandLists.end());
        }

        template <typename T>
        T* OwnObject(std::shared_ptr<T> object)
        {
            T* raw = object.get();
            if (raw)
                objects.emplace(raw, std::move(object));
            return raw;
        }

        // The shared_ptr of an object handed out by OwnObject, for C++ objects that reference it.
        template <typename T>
        std::shared_ptr<T> SharedObject(void* object) const
        {
            auto it = objects.find(object);
            return it != objects.end() ? std::static_pointer_cast<T>(it->second) : nullptr;
        }

        // Worker threads for C++ tasks; tslang code must not run on them (the GC doesn't know them).
        donut::engine::ThreadPool* threadPool()
        {
            if (!m_ThreadPool)
                m_ThreadPool = std::make_unique<donut::engine::ThreadPool>();
            return m_ThreadPool.get();
        }

        // Created on first use: they load Donut's framework shaders, which most examples don't need.
        donut::engine::CommonRenderPasses* commonPasses()
        {
            return sharedCommonPasses().get();
        }

        const std::shared_ptr<donut::engine::CommonRenderPasses>& sharedCommonPasses()
        {
            if (!m_CommonPasses)
                m_CommonPasses = std::make_shared<donut::engine::CommonRenderPasses>(device(), shaderFactory);
            return m_CommonPasses;
        }

        // Loads files relative to the executable's directory.
        const std::shared_ptr<donut::engine::TextureCache>& textureCache()
        {
            if (!m_TextureCache)
                m_TextureCache = std::make_shared<donut::engine::TextureCache>(
                    device(), std::make_shared<donut::vfs::NativeFileSystem>(), nullptr);
            return m_TextureCache;
        }

        donut::engine::BindingCache* bindingCache()
        {
            if (!m_BindingCache)
                m_BindingCache = std::make_unique<donut::engine::BindingCache>(device());
            return m_BindingCache.get();
        }

        // Holds a reference to a GPU resource handed to TypeScript as a raw pointer, returned
        // with its own type (Donut_ReleaseResource drops the reference).
        template <typename T>
        T* Own(T* resource)
        {
            if (!resource)
                return nullptr;
            resources.emplace(resource, resource);
            return resource;
        }

        template <typename T>
        T* Own(const nvrhi::RefCountPtr<T>& resource)
        {
            return Own(resource.Get());
        }

        ~App()
        {
            // Tasks may still be recording commands with the objects below.
            if (m_ThreadPool)
                m_ThreadPool->WaitForTasks();
            m_ThreadPool.reset();

            // Everything created on the device goes before the device itself.
            device()->waitForIdle();
            m_PendingCommandLists.clear();

            for (auto& pass : otherPasses)
                deviceManager->RemoveRenderPass(pass.get());
            otherPasses.clear();
            for (auto& pass : passes)
                deviceManager->RemoveRenderPass(pass.get());
            passes.clear();
            bindlessTextureCaches.clear();
            objects.clear();
            resources.clear();
            m_BindingCache.reset();
            m_TextureCache.reset();
            m_CommonPasses.reset();
            shaderFactory.reset();

            deviceManager->Shutdown();
        }

    private:
        struct PendingCommandList
        {
            nvrhi::CommandListHandle commandList;
            nvrhi::EventQueryHandle finished;
        };
        std::vector<PendingCommandList> m_PendingCommandLists;
        std::shared_ptr<donut::engine::CommonRenderPasses> m_CommonPasses;
        std::unique_ptr<donut::engine::BindingCache> m_BindingCache;
        std::shared_ptr<donut::engine::TextureCache> m_TextureCache;
        std::unique_ptr<donut::engine::ThreadPool> m_ThreadPool;
    };

    // Set by Donut_SetExecutablePath; empty means the module's own path (below).
    std::filesystem::path g_ExecutablePath;

    // The module this code is linked into: the example executable, or donut_interop.dll when a
    // TypeScript file runs under tslang's JIT (where the process is tslang.exe, far from bin/).
    // Shaders and media are looked up next to it.
    std::filesystem::path GetExecutablePath()
    {
        if (!g_ExecutablePath.empty())
            return g_ExecutablePath;
#ifdef _WIN32
        HMODULE module = nullptr;
        GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
            reinterpret_cast<LPCWSTR>(&GetExecutablePath), &module);
        wchar_t path[MAX_PATH] = {};
        GetModuleFileNameW(module, path, MAX_PATH);
        return std::filesystem::path(path);
#else
        return std::filesystem::read_symlink("/proc/self/exe");
#endif
    }

    // Set by Donut_SetAppName; empty means the executable's name.
    std::string g_AppName;

    // Each example executable loads its shaders from bin/shaders/<executable name>/<api>, and
    // Donut's own from bin/shaders/framework/<api> (DONUT_SHADERS_OUTPUT_DIR in CMakeLists.txt).
    // Releases the app's finished command lists every frame (App::RetireCommandLists).
    class RetireCommandListsPass : public donut::app::IRenderPass
    {
    public:
        RetireCommandListsPass(DeviceManager* deviceManager, App* app)
            : IRenderPass(deviceManager)
            , m_App(app)
        { }

        void Animate(float fElapsedTimeSeconds) override { m_App->RetireCommandLists(); }

    private:
        App* m_App;
    };

    App* MakeApp(std::unique_ptr<DeviceManager> deviceManager, nvrhi::GraphicsAPI api)
    {
        const std::filesystem::path exe = GetExecutablePath();
        const std::filesystem::path shaders = exe.parent_path() / "shaders";
        const char* shaderType = donut::app::GetShaderTypeName(api);
        const std::filesystem::path appName = g_AppName.empty() ? exe.stem() : std::filesystem::path(g_AppName);

        auto rootFS = std::make_shared<donut::vfs::RootFileSystem>();
        rootFS->mount("/shaders/donut", shaders / "framework" / shaderType);
        rootFS->mount("/shaders/app", shaders / appName / shaderType);

        auto* app = new App();
        app->deviceManager = std::move(deviceManager);
        app->shaderFactory = std::make_shared<donut::engine::ShaderFactory>(app->device(), rootFS, "/shaders");

        auto retirePass = std::make_unique<RetireCommandListsPass>(app->deviceManager.get(), app);
        app->deviceManager->AddRenderPassToBack(retirePass.get());
        app->otherPasses.push_back(std::move(retirePass));
        return app;
    }

    // Adapters of one graphics API. Holds the device manager whose instance enumerated them;
    // no device is ever created on it.
    struct AdapterList
    {
        std::unique_ptr<DeviceManager> deviceManager;
        std::vector<donut::app::AdapterInfo> adapters;
    };

    // Cameras are handed to TypeScript as BaseCamera pointers, whatever their type.
    donut::app::BaseCamera* AsCamera(void* camera) { return static_cast<donut::app::BaseCamera*>(camera); }
    donut::app::ThirdPersonCamera* AsThirdPersonCamera(void* camera)
    {
        return static_cast<donut::app::ThirdPersonCamera*>(AsCamera(camera));
    }

    // A cube map render target (color + depth, one array slice per face) and the view that
    // renders into it.
    struct CubemapTarget
    {
        nvrhi::TextureHandle colorBuffer;
        nvrhi::TextureHandle depthBuffer;
        std::unique_ptr<donut::engine::FramebufferFactory> framebuffer;
        donut::engine::CubemapView view;
    };

    // Records the scene, as seen by one face of the cube map view, into a command list (opens
    // and closes it). Only touches C++ objects, so it can run on worker threads.
    void RenderCubemapFace(CubemapTarget* target, int face, nvrhi::ICommandList* commandList,
        donut::engine::Scene* scene, donut::render::ForwardShadingPass* forwardPass)
    {
        const donut::engine::IView* faceView = target->view.GetChildView(donut::engine::ViewType::PLANAR, face);

        commandList->open();
        commandList->clearDepthStencilTexture(target->depthBuffer, faceView->GetSubresources(), true, 0.f, false, 0);
        commandList->clearTextureFloat(target->colorBuffer, faceView->GetSubresources(), nvrhi::Color(0.f));

        donut::render::ForwardShadingPass::Context context;
        forwardPass->PrepareLights(context, commandList, {}, 1.0f, 0.3f, {});

        commandList->setEnableAutomaticBarriers(false);
        commandList->setResourceStatesForFramebuffer(target->framebuffer->GetFramebuffer(*faceView));
        commandList->commitBarriers();

        donut::render::InstancedOpaqueDrawStrategy strategy;

        donut::render::RenderCompositeView(commandList, faceView, faceView, *target->framebuffer,
            scene->GetSceneGraph()->GetRootNode(), strategy, *forwardPass, context);

        commandList->setEnableAutomaticBarriers(true);

        commandList->close();
    }

    // G-buffer plus the texture the deferred lighting pass (or a compute / ray tracing shader)
    // writes the shaded image to, which forward passes can then draw over, depth-tested against
    // the G-buffer depth, through ShadedFramebuffer.
    struct GBufferTargets : donut::render::GBufferRenderTargets
    {
        nvrhi::TextureHandle ShadedColor;
        std::shared_ptr<donut::engine::FramebufferFactory> ShadedFramebuffer;

        void Init(nvrhi::IDevice* device, dm::uint2 size, dm::uint sampleCount,
            bool enableMotionVectors, bool useReverseProjection) override
        {
            GBufferRenderTargets::Init(device, size, sampleCount, enableMotionVectors, useReverseProjection);

            nvrhi::TextureDesc textureDesc;
            textureDesc.dimension = nvrhi::TextureDimension::Texture2D;
            textureDesc.initialState = nvrhi::ResourceStates::UnorderedAccess;
            textureDesc.keepInitialState = true;
            textureDesc.debugName = "ShadedColor";
            textureDesc.isUAV = true;
            textureDesc.isRenderTarget = true;
            textureDesc.format = nvrhi::Format::RGBA16_FLOAT;
            textureDesc.width = size.x;
            textureDesc.height = size.y;
            textureDesc.sampleCount = sampleCount;
            ShadedColor = device->createTexture(textureDesc);

            ShadedFramebuffer = std::make_shared<donut::engine::FramebufferFactory>(device);
            ShadedFramebuffer->RenderTargets = { ShadedColor };
            ShadedFramebuffer->DepthTarget = Depth;
        }
    };

    // Forward rendering targets with what temporal anti-aliasing needs: HDR color and depth
    // (rendered to through `framebuffer`), motion vectors, the resolved color and two feedback
    // textures.
    struct TemporalTargets
    {
        nvrhi::TextureHandle depth;
        nvrhi::TextureHandle hdrColor;
        nvrhi::TextureHandle resolvedColor;
        nvrhi::TextureHandle feedback1;
        nvrhi::TextureHandle feedback2;
        nvrhi::TextureHandle motionVectors;
        std::shared_ptr<donut::engine::FramebufferFactory> framebuffer;
    };

    // Render targets of Donut's full renderer (Donut-Samples' feature_demo RenderTargets): the
    // G-buffer (with motion vectors, reverse-Z depth), HDR color and material IDs (all with the
    // sample count), then single-sample resolved color (with mips, to test MipMapGenPass), TAA
    // feedback, LDR color and ambient occlusion; placed in one heap where virtual resources are
    // supported.
    struct SceneRenderTargets : donut::render::GBufferRenderTargets
    {
        nvrhi::TextureHandle HdrColor;
        nvrhi::TextureHandle LdrColor;
        nvrhi::TextureHandle MaterialIDs;
        nvrhi::TextureHandle ResolvedColor;
        nvrhi::TextureHandle TemporalFeedback1;
        nvrhi::TextureHandle TemporalFeedback2;
        nvrhi::TextureHandle AmbientOcclusion;

        nvrhi::HeapHandle Heap;

        std::shared_ptr<donut::engine::FramebufferFactory> ForwardFramebuffer;
        std::shared_ptr<donut::engine::FramebufferFactory> HdrFramebuffer;
        std::shared_ptr<donut::engine::FramebufferFactory> LdrFramebuffer;
        std::shared_ptr<donut::engine::FramebufferFactory> ResolvedFramebuffer;
        std::shared_ptr<donut::engine::FramebufferFactory> MaterialIDFramebuffer;

        void Init(nvrhi::IDevice* device, dm::uint2 size, dm::uint sampleCount,
            bool enableMotionVectors, bool useReverseProjection) override
        {
            GBufferRenderTargets::Init(device, size, sampleCount, enableMotionVectors, useReverseProjection);

            nvrhi::TextureDesc desc;
            desc.width = size.x;
            desc.height = size.y;
            desc.isRenderTarget = true;
            desc.useClearValue = true;
            desc.clearValue = nvrhi::Color(1.f);
            desc.sampleCount = sampleCount;
            desc.dimension = sampleCount > 1 ? nvrhi::TextureDimension::Texture2DMS : nvrhi::TextureDimension::Texture2D;
            desc.keepInitialState = true;
            desc.isVirtual = device->queryFeatureSupport(nvrhi::Feature::VirtualResources);

            desc.clearValue = nvrhi::Color(0.f);
            desc.isTypeless = false;
            desc.isUAV = sampleCount == 1;
            desc.format = nvrhi::Format::RGBA16_FLOAT;
            desc.initialState = nvrhi::ResourceStates::RenderTarget;
            desc.debugName = "HdrColor";
            HdrColor = device->createTexture(desc);

            desc.format = nvrhi::Format::RG16_UINT;
            desc.isUAV = false;
            desc.debugName = "MaterialIDs";
            MaterialIDs = device->createTexture(desc);

            // The render targets below this point are non-MSAA
            desc.sampleCount = 1;
            desc.dimension = nvrhi::TextureDimension::Texture2D;

            desc.format = nvrhi::Format::RGBA16_FLOAT;
            desc.isUAV = true;
            desc.mipLevels = uint32_t(floorf(::log2f(float(std::max(desc.width, desc.height)))) + 1.f);
            desc.debugName = "ResolvedColor";
            ResolvedColor = device->createTexture(desc);

            desc.format = nvrhi::Format::RGBA16_SNORM;
            desc.mipLevels = 1;
            desc.debugName = "TemporalFeedback1";
            TemporalFeedback1 = device->createTexture(desc);
            desc.debugName = "TemporalFeedback2";
            TemporalFeedback2 = device->createTexture(desc);

            desc.format = nvrhi::Format::SRGBA8_UNORM;
            desc.isUAV = false;
            desc.debugName = "LdrColor";
            LdrColor = device->createTexture(desc);

            desc.format = nvrhi::Format::R8_UNORM;
            desc.isUAV = true;
            desc.debugName = "AmbientOcclusion";
            AmbientOcclusion = device->createTexture(desc);

            if (desc.isVirtual)
            {
                uint64_t heapSize = 0;
                nvrhi::ITexture* const textures[] = {
                    HdrColor, MaterialIDs, ResolvedColor, TemporalFeedback1, TemporalFeedback2, LdrColor, AmbientOcclusion
                };

                for (auto texture : textures)
                {
                    nvrhi::MemoryRequirements memReq = device->getTextureMemoryRequirements(texture);
                    heapSize = nvrhi::align(heapSize, memReq.alignment);
                    heapSize += memReq.size;
                }

                nvrhi::HeapDesc heapDesc;
                heapDesc.type = nvrhi::HeapType::DeviceLocal;
                heapDesc.capacity = heapSize;
                heapDesc.debugName = "RenderTargetHeap";

                Heap = device->createHeap(heapDesc);

                uint64_t offset = 0;
                for (auto texture : textures)
                {
                    nvrhi::MemoryRequirements memReq = device->getTextureMemoryRequirements(texture);
                    offset = nvrhi::align(offset, memReq.alignment);

                    device->bindTextureMemory(texture, Heap, offset);

                    offset += memReq.size;
                }
            }

            ForwardFramebuffer = std::make_shared<donut::engine::FramebufferFactory>(device);
            ForwardFramebuffer->RenderTargets = { HdrColor };
            ForwardFramebuffer->DepthTarget = Depth;

            HdrFramebuffer = std::make_shared<donut::engine::FramebufferFactory>(device);
            HdrFramebuffer->RenderTargets = { HdrColor };

            LdrFramebuffer = std::make_shared<donut::engine::FramebufferFactory>(device);
            LdrFramebuffer->RenderTargets = { LdrColor };

            ResolvedFramebuffer = std::make_shared<donut::engine::FramebufferFactory>(device);
            ResolvedFramebuffer->RenderTargets = { ResolvedColor };

            MaterialIDFramebuffer = std::make_shared<donut::engine::FramebufferFactory>(device);
            MaterialIDFramebuffer->RenderTargets = { MaterialIDs };
            MaterialIDFramebuffer->DepthTarget = Depth;
        }

        void Clear(nvrhi::ICommandList* commandList) override
        {
            GBufferRenderTargets::Clear(commandList);

            commandList->clearTextureFloat(HdrColor, nvrhi::AllSubresources, nvrhi::Color(0.f));
            commandList->clearTextureFloat(LdrColor, nvrhi::AllSubresources, nvrhi::Color(0.f));
            commandList->clearTextureFloat(ResolvedColor, nvrhi::AllSubresources, nvrhi::Color(0.f));
        }
    };

    // A cascaded shadow map and the framebuffer its depth pass renders into.
    // A cascaded or a planar shadow map (one of the two set), and a framebuffer over its texture.
    struct ShadowMapTarget
    {
        std::shared_ptr<donut::render::CascadedShadowMap> cascaded;
        std::shared_ptr<donut::render::PlanarShadowMap> planar;
        std::shared_ptr<donut::engine::FramebufferFactory> framebuffer;

        std::shared_ptr<donut::engine::IShadowMap> shadowMap() const
        {
            if (cascaded)
                return cascaded;
            return planar;
        }
    };

    // Light probes sharing one diffuse and one specular cube map array (a cube per probe).
    struct LightProbeSet
    {
        nvrhi::TextureHandle diffuseTexture;
        nvrhi::TextureHandle specularTexture;
        std::vector<std::shared_ptr<donut::engine::LightProbe>> probes;

        std::vector<std::shared_ptr<donut::engine::LightProbe>> EnabledProbes() const
        {
            std::vector<std::shared_ptr<donut::engine::LightProbe>> enabled;
            for (const auto& probe : probes)
                if (probe->enabled)
                    enabled.push_back(probe);
            return enabled;
        }
    };

    // The environment cube map (color with mips, depth) a light probe is rendered from, and the
    // cube map view that renders it.
    struct LightProbeCapture
    {
        nvrhi::TextureHandle colorTexture;
        nvrhi::TextureHandle depthTexture;
        std::shared_ptr<donut::engine::FramebufferFactory> framebuffer;
        donut::engine::CubemapView view;
        uint32_t mipLevels = 1;
    };

    // Loads scenes on a thread and finishes them on the render thread, as
    // donut::app::ApplicationBase does with asynchronous loading enabled.
    struct SceneLoader
    {
        App* app = nullptr;
        // The scene last loaded, if any.
        std::shared_ptr<donut::engine::Scene> scene;
        // Written by the loading thread; picked up once it has finished.
        std::shared_ptr<donut::engine::Scene> loadedScene;
        std::unique_ptr<std::thread> thread;
        std::atomic<bool> sceneLoaded = false;
        bool allTexturesFinalized = false;

        ~SceneLoader()
        {
            if (thread)
                thread->join();
        }
    };

    donut::engine::IView* AsView(void* view) { return static_cast<donut::engine::IView*>(view); }
    donut::engine::SceneGraph* AsSceneGraph(void* sceneGraph) { return static_cast<donut::engine::SceneGraph*>(sceneGraph); }
    SceneRenderTargets* AsSceneRenderTargets(void* targets) { return static_cast<SceneRenderTargets*>(targets); }

    // Returned strings that aren't stored in a Donut object stay valid until the next call of the
    // same function.
    const char* ReturnString(std::string& storage, std::string value)
    {
        storage = std::move(value);
        return storage.c_str();
    }

    // Depth formats usable for shadow maps and light probe depth, in order of preference.
    nvrhi::Format ChooseDepthFormat(nvrhi::IDevice* device)
    {
        const nvrhi::Format formats[] = { nvrhi::Format::D24S8, nvrhi::Format::D32, nvrhi::Format::D16, nvrhi::Format::D32S8 };
        const nvrhi::FormatSupport features = nvrhi::FormatSupport::Texture | nvrhi::FormatSupport::DepthStencil
            | nvrhi::FormatSupport::ShaderLoad;
        return nvrhi::utils::ChooseFormat(device, features, formats, std::size(formats));
    }

    // Textures passed between the render thread and the async compute thread, each with the
    // submission (on the other queue) that last used it.
    class TextureQueue
    {
    public:
        void Push(nvrhi::TextureHandle texture, uint64_t lastUse)
        {
            std::lock_guard lock(m_Mutex);
            m_Queue.emplace(std::move(texture), lastUse);
        }

        bool TryPop(nvrhi::TextureHandle& outTexture, uint64_t& outLastUse)
        {
            std::lock_guard lock(m_Mutex);
            if (m_Queue.empty())
                return false;

            outTexture = std::move(m_Queue.front().first);
            outLastUse = m_Queue.front().second;
            m_Queue.pop();
            return true;
        }

    private:
        std::queue<std::pair<nvrhi::TextureHandle, uint64_t>> m_Queue;
        std::mutex m_Mutex;
    };

    // A C++ worker thread that, at a fixed rate, takes a free texture, runs a compute shader over
    // it on the compute queue, and hands it to the render thread; the render thread hands back the
    // texture it stops showing. Cross-queue waits keep each texture used by one queue at a time.
    // Only C++ runs on the worker: tslang code can't run on threads its GC doesn't know about.
    struct AsyncComputeLoop
    {
        nvrhi::DeviceHandle device;
        nvrhi::ComputePipelineHandle pipeline;
        nvrhi::BindingLayoutHandle bindingLayout;
        uint32_t groupsX = 0;
        uint32_t groupsY = 0;
        std::chrono::microseconds interval{};

        nvrhi::CommandListLifetimeTrackerHandle lifetimeTracker;
        nvrhi::CommandListHandle commandList;
        std::unique_ptr<donut::engine::BindingCache> bindings;

        TextureQueue renderToCompute;
        TextureQueue computeToRender;
        // Only touched by the render thread.
        nvrhi::TextureHandle current;

        // Binding sets the app made for its textures (Donut_AddAsyncComputeTextureWithBindingSet),
        // used instead of the loop's own; set before the thread starts.
        std::unordered_map<nvrhi::ITexture*, nvrhi::BindingSetHandle> textureBindingSets;
        // Push constants the app set (Donut_SetAsyncComputePushConstants), sent instead of the run
        // index when not empty; the latest values go with each run.
        std::vector<uint8_t> pushConstants;
        std::mutex pushConstantsMutex;

        std::thread thread;
        std::atomic_bool terminate = false;
        std::atomic_bool paused = false;
        std::atomic<uint32_t> runCount = 0;

        ~AsyncComputeLoop() { Stop(); }

        void Stop()
        {
            terminate = true;
            if (thread.joinable())
                thread.join();
        }

        void ThreadProc()
        {
            uint32_t counter = 0;

            while (!terminate)
            {
                const auto nextTimePoint = std::chrono::steady_clock::now() + interval;
                lifetimeTracker->runGarbageCollection();

                nvrhi::TextureHandle texture;
                uint64_t textureLastUse = 0;
                while (!terminate && (paused || !renderToCompute.TryPop(texture, textureLastUse)))
                    std::this_thread::yield();

                if (terminate)
                    break;

                commandList->open();

                nvrhi::BindingSetHandle bindingSet;
                if (auto it = textureBindingSets.find(texture.Get()); it != textureBindingSets.end())
                {
                    bindingSet = it->second;
                }
                else
                {
                    nvrhi::BindingSetDesc bindingDesc;
                    bindingDesc.addItem(nvrhi::BindingSetItem::Texture_UAV(0, texture));
                    bindingDesc.addItem(nvrhi::BindingSetItem::PushConstants(0, sizeof(uint32_t)));
                    bindingSet = bindings->GetOrCreateBindingSet(bindingDesc, bindingLayout);
                }

                nvrhi::ComputeState state;
                state.pipeline = pipeline;
                state.bindings = { bindingSet };
                commandList->setComputeState(state);
                {
                    std::lock_guard lock(pushConstantsMutex);
                    if (pushConstants.empty())
                        commandList->setPushConstants(&counter, sizeof(counter));
                    else
                        commandList->setPushConstants(pushConstants.data(), pushConstants.size());
                }
                commandList->dispatch(groupsX, groupsY);

                commandList->close();

                if (textureLastUse > 0)
                    device->queueWaitForCommandList(nvrhi::CommandQueue::Compute, nvrhi::CommandQueue::Graphics, textureLastUse);
                textureLastUse = device->executeCommandList(commandList, nvrhi::CommandQueue::Compute);

                computeToRender.Push(std::move(texture), textureLastUse);

                counter++;
                runCount++;
                std::this_thread::sleep_until(nextTimePoint);
            }
        }
    };

    // A top-level acceleration structure over a scene's mesh instances, and the bottom-level ones
    // (one per mesh) it instantiates. Only NVRHI's D3D12 backend keeps a BLAS alive from a TLAS,
    // so they're held here.
    struct SceneAccelStructs
    {
        std::unordered_map<std::shared_ptr<donut::engine::MeshInfo>, nvrhi::rt::AccelStructHandle> meshes;
        nvrhi::rt::AccelStructHandle topLevel;
        // Instances for the next Donut_BuildTopLevelAS (Donut_CreateTopLevelAS ones).
        std::vector<nvrhi::rt::InstanceDesc> pendingInstances;
        // Instances in the TLAS's last build (Donut_UpdateTopLevelAS refits only to the same
        // count), -1 before the first.
        int builtInstanceCount = -1;
    };

    // A mesh of one geometry whose vertices and indices change every frame (e.g. particle
    // billboards), with room for maxVertices / maxIndices; its BLAS is sized for those.
    struct DynamicMesh
    {
        std::shared_ptr<donut::engine::BufferGroup> buffers;
        std::shared_ptr<donut::engine::Material> material;
        std::shared_ptr<donut::engine::MeshGeometry> geometry;
        std::shared_ptr<donut::engine::MeshInfo> mesh;
        std::shared_ptr<donut::engine::MeshInstance> instance;
    };

    // BLAS description of a scene mesh: opaque triangles, except alpha-tested geometries (for any-hit
    // shaders); compactable unless the mesh is skinned and rebuilt every frame.
    // onlyOpaqueDomainIsOpaque: instead, every geometry whose material isn't in the Opaque domain
    // is non-opaque (e.g. alpha-blended particles for ray queries), and nothing is compacted.
    nvrhi::rt::AccelStructDesc GetMeshBlasDesc(const donut::engine::MeshInfo& mesh, bool onlyOpaqueDomainIsOpaque = false)
    {
        nvrhi::rt::AccelStructDesc blasDesc;
        blasDesc.isTopLevel = false;
        blasDesc.debugName = mesh.name;

        for (const auto& geometry : mesh.geometries)
        {
            nvrhi::rt::GeometryDesc geometryDesc;
            auto& triangles = geometryDesc.geometryData.triangles;
            triangles.indexBuffer = mesh.buffers->indexBuffer;
            triangles.indexOffset = (mesh.indexOffset + geometry->indexOffsetInMesh) * sizeof(uint32_t);
            triangles.indexFormat = nvrhi::Format::R32_UINT;
            triangles.indexCount = geometry->numIndices;
            triangles.vertexBuffer = mesh.buffers->vertexBuffer;
            triangles.vertexOffset = (mesh.vertexOffset + geometry->vertexOffsetInMesh) * sizeof(dm::float3)
                + mesh.buffers->getVertexBufferRange(donut::engine::VertexAttribute::Position).byteOffset;
            triangles.vertexFormat = nvrhi::Format::RGB32_FLOAT;
            triangles.vertexStride = sizeof(dm::float3);
            triangles.vertexCount = geometry->numVertices;
            geometryDesc.geometryType = nvrhi::rt::GeometryType::Triangles;
            const bool opaque = onlyOpaqueDomainIsOpaque
                ? geometry->material->domain == donut::engine::MaterialDomain::Opaque
                : geometry->material->domain != donut::engine::MaterialDomain::AlphaTested;
            geometryDesc.flags = opaque ? nvrhi::rt::GeometryFlags::Opaque : nvrhi::rt::GeometryFlags::None;
            blasDesc.bottomLevelGeometries.push_back(geometryDesc);
        }

        const bool compact = !onlyOpaqueDomainIsOpaque && !mesh.skinPrototype;
        blasDesc.buildFlags = compact
            ? nvrhi::rt::AccelStructBuildFlags::PreferFastTrace | nvrhi::rt::AccelStructBuildFlags::AllowCompaction
            : nvrhi::rt::AccelStructBuildFlags::PreferFastTrace;
        return blasDesc;
    }

    // A scene geometry and the mesh it belongs to.
    struct SceneGeometry
    {
        donut::engine::MeshInfo* mesh = nullptr;
        donut::engine::MeshGeometry* geometry = nullptr;
    };

    // The geometry of a loaded scene with this globalGeometryIndex (null members if none).
    SceneGeometry FindSceneGeometry(void* scene, int globalGeometryIndex)
    {
        for (const auto& mesh : static_cast<donut::engine::Scene*>(scene)->GetSceneGraph()->GetMeshes())
            for (const auto& geometry : mesh->geometries)
                if (geometry->globalGeometryIndex == globalGeometryIndex)
                    return { mesh.get(), geometry.get() };
        return {};
    }

    // Builds a TLAS over a scene's mesh instances, whose meshes have their BLAS in accelStruct,
    // into an open command list. Each instance's hit group index starts at the global index of
    // its mesh's first geometry times hitGroupStride (0: all instances use the same entries).
    nvrhi::rt::AccelStructHandle BuildSceneTLAS(nvrhi::IDevice* device, nvrhi::ICommandList* commandList,
        const donut::engine::SceneGraph& sceneGraph, uint32_t hitGroupStride)
    {
        std::vector<nvrhi::rt::InstanceDesc> instances;
        for (const auto& instance : sceneGraph.GetMeshInstances())
        {
            const auto& mesh = instance->GetMesh();

            nvrhi::rt::InstanceDesc instanceDesc;
            instanceDesc.bottomLevelAS = mesh->accelStruct;
            instanceDesc.instanceMask = 1;
            instanceDesc.instanceContributionToHitGroupIndex = mesh->geometries[0]->globalGeometryIndex * hitGroupStride;
            dm::affineToColumnMajor(instance->GetNode()->GetLocalToWorldTransformFloat(), instanceDesc.transform);
            instances.push_back(instanceDesc);
        }

        nvrhi::rt::AccelStructDesc tlasDesc;
        tlasDesc.isTopLevel = true;
        tlasDesc.topLevelMaxInstances = instances.size();
        nvrhi::rt::AccelStructHandle tlas = device->createAccelStruct(tlasDesc);
        commandList->buildTopLevelAccelStruct(tlas, instances.data(), instances.size());
        return tlas;
    }

    // Buffer of a mesh's BufferGroup, with data (if any) uploaded by an open command list.
    nvrhi::BufferHandle CreateGeometryBuffer(nvrhi::IDevice* device, nvrhi::ICommandList* commandList,
        const char* debugName, const void* data, uint64_t dataSize, bool isVertexBuffer, bool isInstanceBuffer)
    {
        // The G-buffer fill pass accesses instance buffers as structured on DX12 and Vulkan, and as raw on DX11.
        const bool needStructuredBuffer = isInstanceBuffer && device->getGraphicsAPI() != nvrhi::GraphicsAPI::D3D11;

        nvrhi::BufferDesc desc;
        desc.byteSize = dataSize;
        desc.isIndexBuffer = !isVertexBuffer && !isInstanceBuffer;
        desc.canHaveRawViews = isVertexBuffer || isInstanceBuffer;
        desc.structStride = needStructuredBuffer ? sizeof(InstanceData) : 0;
        desc.debugName = debugName;
        desc.initialState = nvrhi::ResourceStates::CopyDest;
        nvrhi::BufferHandle buffer = device->createBuffer(desc);

        if (data)
        {
            commandList->beginTrackingBufferState(buffer, nvrhi::ResourceStates::CopyDest);
            commandList->writeBuffer(buffer, data, dataSize);
            commandList->setPermanentBufferState(buffer, (isVertexBuffer || isInstanceBuffer)
                ? nvrhi::ResourceStates::ShaderResource
                : nvrhi::ResourceStates::IndexBuffer);
        }

        return buffer;
    }

    // A 4x4 row-major float matrix from TypeScript (16 floats, row-vector convention).
    dm::float4x4 LoadMatrix(const float* m)
    {
        dm::float4x4 result;
        memcpy(&result, m, sizeof(result));
        return result;
    }

    // Loads a scene (path relative to the executable's directory, or absolute) on the app's thread
    // pool into textureCache, and descriptorTable if given, then finishes uploading its textures.
    void* LoadScene(App* a, const char* path, const std::shared_ptr<donut::engine::TextureCache>& textureCache,
        const std::shared_ptr<donut::engine::DescriptorTableManager>& descriptorTable)
    {
        auto nativeFS = std::make_shared<donut::vfs::NativeFileSystem>();
        auto scene = std::make_shared<donut::engine::Scene>(a->device(), *a->shaderFactory, nativeFS,
            textureCache, descriptorTable, nullptr);

        if (!scene->LoadWithThreadPool(GetExecutablePath().parent_path() / path, a->threadPool()))
            return nullptr;

        // What ApplicationBase::SceneLoaded does after a synchronous load.
        textureCache->ProcessRenderingThreadCommands(*a->commonPasses(), 0.f);
        textureCache->LoadingFinished();

        scene->FinishedLoading(a->deviceManager->GetFrameIndex());
        return a->OwnObject(scene);
    }

    // Buffer uploaded once by an open command list, then kept in permanentState.
    nvrhi::IBuffer* CreateStaticBuffer(App* a, nvrhi::ICommandList* commandList, nvrhi::BufferDesc desc,
        nvrhi::ResourceStates permanentState, const void* data, int byteSize)
    {
        desc.byteSize = static_cast<uint64_t>(byteSize);
        desc.initialState = nvrhi::ResourceStates::CopyDest;
        nvrhi::BufferHandle buffer = a->device()->createBuffer(desc);
        if (!buffer)
            return nullptr;

        commandList->beginTrackingBufferState(buffer, nvrhi::ResourceStates::CopyDest);
        commandList->writeBuffer(buffer, data, static_cast<size_t>(byteSize));
        commandList->setPermanentBufferState(buffer, permanentState);
        return a->Own(buffer);
    }

    // A glTF file (path relative to the executable's directory) with its buffers loaded.
    struct GltfFile
    {
        std::string fileName;
        std::shared_ptr<donut::vfs::IBlob> blob;
        cgltf_data* data = nullptr;

        ~GltfFile()
        {
            if (data)
                cgltf_free(data);
        }

        // Returns false (after logging why) on failure.
        bool Read(const char* path)
        {
            const std::filesystem::path filePath = GetExecutablePath().parent_path() / path;
            fileName = filePath.generic_string();
            donut::vfs::NativeFileSystem fs;
            blob = fs.readFile(filePath);
            if (!blob)
            {
                donut::log::error("Cannot read %s", fileName.c_str());
                return false;
            }

            // The buffers can be files next to the glTF or data URIs.
            cgltf_options options{};
            cgltf_result result = cgltf_parse(&options, blob->data(), blob->size(), &data);
            if (result == cgltf_result_success)
                result = cgltf_load_buffers(&options, data, fileName.c_str());
            if (result != cgltf_result_success)
            {
                donut::log::error("Cannot parse %s", fileName.c_str());
                return false;
            }
            return true;
        }
    };

    // A glTF primitive as the Vulkan-Samples framework reads one: positions, normals and texture
    // coordinates interleaved (8 floats per vertex, zeros for missing attributes), 32-bit
    // indices. Returns false if it has no positions, or no indices and requireIndices.
    bool ReadGltfPrimitive(const cgltf_primitive& primitive, std::vector<float>& vertices, std::vector<uint32_t>& indices,
        bool requireIndices = true)
    {
        const cgltf_accessor* positions = nullptr;
        const cgltf_accessor* normals = nullptr;
        const cgltf_accessor* texCoords = nullptr;
        for (size_t i = 0; i < primitive.attributes_count; i++)
        {
            const cgltf_attribute& attribute = primitive.attributes[i];
            if (attribute.type == cgltf_attribute_type_position)
                positions = attribute.data;
            else if (attribute.type == cgltf_attribute_type_normal)
                normals = attribute.data;
            else if (attribute.type == cgltf_attribute_type_texcoord && attribute.index == 0)
                texCoords = attribute.data;
        }
        if (!positions || (!primitive.indices && requireIndices))
            return false;

        constexpr size_t vertexFloats = 8;
        vertices.assign(positions->count * vertexFloats, 0.f);
        for (size_t v = 0; v < positions->count; v++)
        {
            float* vertex = &vertices[v * vertexFloats];
            cgltf_accessor_read_float(positions, v, vertex, 3);
            if (normals)
                cgltf_accessor_read_float(normals, v, vertex + 3, 3);
            if (texCoords)
                cgltf_accessor_read_float(texCoords, v, vertex + 6, 2);
        }
        indices.resize(primitive.indices ? primitive.indices->count : 0);
        for (size_t i = 0; i < indices.size(); i++)
            indices[i] = static_cast<uint32_t>(cgltf_accessor_read_index(primitive.indices, i));
        return true;
    }

    // A glTF mesh primitive as the Vulkan-Samples framework loads one (Donut_LoadGltfMesh).
    struct GltfMesh
    {
        // float3 position, float3 normal, float2 texture coordinates.
        nvrhi::BufferHandle vertexBuffer;
        // R32_UINT.
        nvrhi::BufferHandle indexBuffer;
        int indexCount = 0;
    };

    // Every mesh primitive of a glTF file, kept on the CPU (Donut_LoadGltfModel).
    struct GltfModel
    {
        struct Primitive
        {
            // float3 position, float3 normal, float2 texture coordinates.
            std::vector<float> vertices;
            std::vector<uint32_t> indices;
            // The URI of the material's base color image ("" if none).
            std::string baseColorImage;
            // The name of the primitive's mesh ("" if none).
            std::string meshName;
            // The index of the primitive's mesh.
            int mesh = 0;
            // Its material's alpha mode: 0 opaque, 1 mask, 2 blend.
            int alphaMode = 0;
            // Its material's base color factor.
            float baseColorFactor[4] = { 1.f, 1.f, 1.f, 1.f };
            // Its material's metallic and roughness factors, and its textures (indices into the
            // file's textures; -1 if none): base color, normal, metallic-roughness.
            float metallicFactor = 1.f;
            float roughnessFactor = 1.f;
            int materialTextures[3] = { -1, -1, -1 };
            // Every vertex attribute, by its name in the file (POSITION, COLOR_0, an extension's
            // "KHR_gaussian_splatting:SCALE"...), as floats (normalized integers converted).
            struct Attribute
            {
                int components = 0;
                std::vector<float> data;
            };
            std::map<std::string, Attribute> attributes;
        };
        std::vector<Primitive> primitives;
        // The file's textures' image URIs ("" if none), in texture order.
        std::vector<std::string> textureImages;

        // The nodes that instantiate meshes, in node order.
        struct Node
        {
            int mesh = 0;
            // World transform, column-major (glm's layout).
            float transform[16] = {};
        };
        std::vector<Node> nodes;
    };

    // A bottom-level acceleration structure of one triangle geometry, with the description it's
    // rebuilt from (Donut_CreateTriangleBlas).
    struct TriangleBlas
    {
        nvrhi::rt::AccelStructDesc desc;
        nvrhi::rt::AccelStructHandle accelStruct;
        // The opacity micromap arrays its geometries use (Donut_SetTriangleBlasGeometryOpacityMicromap),
        // kept for as long as the BLAS, and their usage counts, which the geometries point to.
        std::vector<nvrhi::rt::OpacityMicromapHandle> opacityMicromaps;
        std::vector<std::unique_ptr<std::vector<nvrhi::rt::OpacityMicromapUsageCount>>> ommUsageCounts;
    };

#if DONUT_WITH_DX12
    // A D3D12 work graph program (Donut_CreateD3D12WorkGraph) and its backing memory.
    struct D3D12WorkGraph
    {
        Microsoft::WRL::ComPtr<ID3D12StateObject> stateObject;
        D3D12_PROGRAM_IDENTIFIER programIdentifier = {};
        // Null if the graph needs none.
        nvrhi::BufferHandle backingMemory;
    };

    std::wstring Widen(const char* text)
    {
        const int length = MultiByteToWideChar(CP_UTF8, 0, text, -1, nullptr, 0);
        std::wstring wide(length > 0 ? length - 1 : 0, L'\0');
        if (length > 1)
            MultiByteToWideChar(CP_UTF8, 0, text, -1, wide.data(), length);
        return wide;
    }
#endif
}

namespace
{
    // Bits of Donut_GetIndirectDrawSupport.
    enum IndirectDrawSupport
    {
        IndirectDraw_MultiDraw = 1, // one indirect draw call issues several draws
        IndirectDraw_FirstInstance = 2, // indirect draws can start at an instance other than 0
        IndirectDraw_BufferDeviceAddress = 4, // shaders can write buffers through their addresses (Vulkan)
    };

    // Donut_GetShaderExecutionReordering's values.
    enum ShaderExecutionReordering
    {
        ShaderExecutionReordering_None = 0,
        ShaderExecutionReordering_HitObjects = 1, // hit objects, reordering perhaps a no-op
        ShaderExecutionReordering_Reorders = 2, // and the GPU says it reorders
    };

    // Bits of Donut_GetAdvancedBlendOperations: what Vulkan's VK_EXT_blend_operation_advanced has
    // (BlendState::advancedBlendOp), with coherent operations (no barriers between draws).
    enum AdvancedBlend
    {
        AdvancedBlend_Available = 1, // the blend equation advanced operations, at least
        AdvancedBlend_AllOperations = 2, // all of them (advancedBlendAllOperations)
        AdvancedBlend_NonPremultipliedSrc = 4, // sources that aren't premultiplied by their alpha
        AdvancedBlend_NonPremultipliedDst = 8, // destinations that aren't either
        AdvancedBlend_CorrelatedOverlap = 16, // correlated overlap
    };

    // Bits of Donut_GetLineRasterizationModes: the line rasterization modes pipelines can have
    // (RasterState::lineRasterizationMode), plain and stippled.
    enum LineRasterization
    {
        LineRasterization_Rectangular = 1,
        LineRasterization_Bresenham = 2,
        LineRasterization_Smooth = 4,
        LineRasterization_StippledRectangular = 8,
        LineRasterization_StippledBresenham = 16,
        LineRasterization_StippledSmooth = 32,
    };

    // Bits of Donut_GetComputeShaderDerivatives: compute shaders can take derivatives (ddx, ddy,
    // implicit-LOD samples; shader model 6.6) with their threads in...
    enum ComputeDerivatives
    {
        ComputeDerivatives_Quads = 1, // quads of 2 x 2 (thread groups of an even width and height)
        ComputeDerivatives_Linear = 2, // 4 consecutive threads (one-dimensional thread groups)
    };

#if DONUT_WITH_VULKAN
    // The physical device a Vulkan device manager picked: a protected member, reached through a
    // pointer to member named from a derived class.
    struct DeviceManagerVKAccess : DeviceManager_VK
    {
        static vk::PhysicalDevice PhysicalDevice(DeviceManager_VK* deviceManager)
        {
            return deviceManager->*(&DeviceManagerVKAccess::m_VulkanPhysicalDevice);
        }

        static int GraphicsQueueFamily(DeviceManager_VK* deviceManager)
        {
            return deviceManager->*(&DeviceManagerVKAccess::m_GraphicsQueueFamily);
        }
    };

    // The core features of a Vulkan device that Donut's device manager leaves off and the examples
    // need (indirect draws, pixel shader stores), and what that makes of them.
    struct VulkanCoreFeatures
    {
        // What the device is created with (its VkDeviceCreateInfo points here).
        VkPhysicalDeviceFeatures features{};
        // IndirectDrawSupport bits.
        int support = 0;
        // Chained into the device's creation when VK_EXT_conditional_rendering is enabled.
        VkPhysicalDeviceConditionalRenderingFeaturesEXT conditionalRendering{
            VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_CONDITIONAL_RENDERING_FEATURES_EXT };
        // Fragment shader pixel interlock (rasterizer ordered views), enabled.
        bool fragmentShaderPixelInterlock = false;
        // Fragment shader barycentrics, enabled.
        bool fragmentShaderBarycentric = false;
        // 16-bit floats and integers in shaders and storage buffers, enabled.
        bool native16Bit = false;
        // With 16-bit values in push constants and uniform buffers too.
        bool native16BitConstants = false;
        // Chained into the device's creation when VK_KHR_compute_shader_derivatives is enabled.
        VkPhysicalDeviceComputeShaderDerivativesFeaturesKHR computeShaderDerivatives{
            VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_COMPUTE_SHADER_DERIVATIVES_FEATURES_KHR };
        // Chained into the device's creation when VK_NV_ray_tracing_invocation_reorder is enabled.
        VkPhysicalDeviceRayTracingInvocationReorderFeaturesNV invocationReorder{
            VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_RAY_TRACING_INVOCATION_REORDER_FEATURES_NV };
        // Chained into the device's creation when VK_EXT_blend_operation_advanced is enabled.
        VkPhysicalDeviceBlendOperationAdvancedFeaturesEXT blendOperationAdvanced{
            VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_BLEND_OPERATION_ADVANCED_FEATURES_EXT };
        // Chained when VK_KHR_shader_quad_control and VK_KHR_shader_maximal_reconvergence (which it
        // needs) are both enabled.
        VkPhysicalDeviceShaderQuadControlFeaturesKHR quadControl{
            VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_SHADER_QUAD_CONTROL_FEATURES_KHR };
        VkPhysicalDeviceShaderMaximalReconvergenceFeaturesKHR maximalReconvergence{
            VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_SHADER_MAXIMAL_RECONVERGENCE_FEATURES_KHR };
        // Chained into the device's creation when VK_EXT_line_rasterization is enabled.
        VkPhysicalDeviceLineRasterizationFeaturesEXT lineRasterization{
            VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_LINE_RASTERIZATION_FEATURES_EXT };
        // Chained into the device's creation when VK_EXT_opacity_micromap is enabled.
        VkPhysicalDeviceOpacityMicromapFeaturesEXT opacityMicromap{
            VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_OPACITY_MICROMAP_FEATURES_EXT };
    };

    // Device creation callback: enables multi-draw indirect, a first instance in indirect draws,
    // dynamically uniform indexing of sampled image arrays, stores and atomics in pixel shaders,
    // sparse 2D images with residency queries in shaders, pipeline statistics queries, conditional
    // rendering, fragment shader pixel interlock and fragment shader barycentrics (with their
    // extensions), 16-bit floats in shaders and 16-bit values in uniform buffers and push constants,
    // derivatives in compute shaders (with its extension), logic operations, shader execution
    // reordering, coherent advanced blend operations, shader quad control and line rasterization
    // modes (with their extensions), wide lines, and clip and cull distances, when the GPU has them.
    void EnableCoreFeatures(DeviceManager_VK* deviceManager, VkDeviceCreateInfo& info, VulkanCoreFeatures& result)
    {
        VkPhysicalDeviceFeatures available{};
        VULKAN_HPP_DEFAULT_DISPATCHER.vkGetPhysicalDeviceFeatures(
            DeviceManagerVKAccess::PhysicalDevice(deviceManager), &available);

        VkPhysicalDeviceFeatures& features = result.features;
        features = info.pEnabledFeatures ? *info.pEnabledFeatures : VkPhysicalDeviceFeatures{};
        features.multiDrawIndirect = available.multiDrawIndirect;
        features.drawIndirectFirstInstance = available.drawIndirectFirstInstance;
        features.shaderSampledImageArrayDynamicIndexing = available.shaderSampledImageArrayDynamicIndexing;
        features.fragmentStoresAndAtomics = available.fragmentStoresAndAtomics;
        features.sparseBinding = available.sparseBinding;
        features.sparseResidencyImage2D = available.sparseResidencyImage2D;
        features.shaderResourceResidency = available.shaderResourceResidency;
        features.pipelineStatisticsQuery = available.pipelineStatisticsQuery;
        features.logicOp = available.logicOp;
        features.depthBounds = available.depthBounds;
        features.wideLines = available.wideLines;
        // SV_ClipDistance and SV_CullDistance.
        features.shaderClipDistance = available.shaderClipDistance;
        features.shaderCullDistance = available.shaderCullDistance;
        // Several viewports per draw (SV_ViewportArrayIndex from geometry shaders).
        features.multiViewport = available.multiViewport;
        info.pEnabledFeatures = &features;

        result.support = (features.multiDrawIndirect ? IndirectDraw_MultiDraw : 0)
            | (features.drawIndirectFirstInstance ? IndirectDraw_FirstInstance : 0);
        for (auto* next = static_cast<const VkBaseInStructure*>(info.pNext); next; next = next->pNext)
        {
            if (next->sType == VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_2_FEATURES
                && reinterpret_cast<const VkPhysicalDeviceVulkan12Features*>(next)->bufferDeviceAddress)
                result.support |= IndirectDraw_BufferDeviceAddress;
        }

        // Donut chains the Vulkan 1.1 and 1.2 features, with 16-bit storage buffer access and
        // 16-bit integers on (and its own chain: VkPhysicalDeviceFeatures2 doesn't take 1.x structs
        // from other chains, so query them alone).
        VkPhysicalDeviceVulkan11Features available11{ VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_1_FEATURES };
        VkPhysicalDeviceVulkan12Features available12{ VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_2_FEATURES };
        {
            available11.pNext = &available12;
            VkPhysicalDeviceFeatures2 features2{ VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FEATURES_2 };
            features2.pNext = &available11;
            VULKAN_HPP_DEFAULT_DISPATCHER.vkGetPhysicalDeviceFeatures2(
                DeviceManagerVKAccess::PhysicalDevice(deviceManager), &features2);
        }
        VkPhysicalDeviceVulkan11Features* features11 = nullptr;
        VkPhysicalDeviceVulkan12Features* features12 = nullptr;
        for (auto* next = static_cast<const VkBaseInStructure*>(info.pNext); next; next = next->pNext)
        {
            if (next->sType == VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_1_FEATURES)
                features11 = reinterpret_cast<VkPhysicalDeviceVulkan11Features*>(const_cast<VkBaseInStructure*>(next));
            else if (next->sType == VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_2_FEATURES)
                features12 = reinterpret_cast<VkPhysicalDeviceVulkan12Features*>(const_cast<VkBaseInStructure*>(next));
        }
        if (features11 && features12)
        {
            features12->shaderFloat16 = available12.shaderFloat16;
            features11->uniformAndStorageBuffer16BitAccess = available11.uniformAndStorageBuffer16BitAccess;
            features11->storagePushConstant16 = available11.storagePushConstant16;
            result.native16Bit = features.shaderInt16 && features12->shaderFloat16 && features11->storageBuffer16BitAccess;
            result.native16BitConstants = result.native16Bit && features11->uniformAndStorageBuffer16BitAccess
                && features11->storagePushConstant16;
        }

        // Out-of-bounds image accesses as on D3D (reads return zero, writes are dropped), for
        // shaders written against D3D's rules (the ATG samples' SSAO dispatches past the edges):
        // Vulkan 1.3's robustImageAccess, in the 1.3 features Donut chains.
        for (auto* next = static_cast<const VkBaseInStructure*>(info.pNext); next; next = next->pNext)
        {
            if (next->sType == VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_3_FEATURES)
            {
                VkPhysicalDeviceVulkan13Features available13{ VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_3_FEATURES };
                VkPhysicalDeviceFeatures2 features2{ VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FEATURES_2 };
                features2.pNext = &available13;
                VULKAN_HPP_DEFAULT_DISPATCHER.vkGetPhysicalDeviceFeatures2(
                    DeviceManagerVKAccess::PhysicalDevice(deviceManager), &features2);
                reinterpret_cast<VkPhysicalDeviceVulkan13Features*>(const_cast<VkBaseInStructure*>(next))->robustImageAccess =
                    available13.robustImageAccess;
            }
        }

        // Donut chains the interlock and barycentric features itself with their extensions, the
        // features on: keep them to what the GPU has.
        for (auto* next = static_cast<const VkBaseInStructure*>(info.pNext); next; next = next->pNext)
        {
            if (next->sType == VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FRAGMENT_SHADER_INTERLOCK_FEATURES_EXT)
            {
                VkPhysicalDeviceFragmentShaderInterlockFeaturesEXT available2{
                    VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FRAGMENT_SHADER_INTERLOCK_FEATURES_EXT };
                VkPhysicalDeviceFeatures2 features2{ VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FEATURES_2 };
                features2.pNext = &available2;
                VULKAN_HPP_DEFAULT_DISPATCHER.vkGetPhysicalDeviceFeatures2(
                    DeviceManagerVKAccess::PhysicalDevice(deviceManager), &features2);
                auto* interlock = reinterpret_cast<VkPhysicalDeviceFragmentShaderInterlockFeaturesEXT*>(const_cast<VkBaseInStructure*>(next));
                interlock->fragmentShaderPixelInterlock = available2.fragmentShaderPixelInterlock;
                result.fragmentShaderPixelInterlock = available2.fragmentShaderPixelInterlock == VK_TRUE;
            }
            else if (next->sType == VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FRAGMENT_SHADER_BARYCENTRIC_FEATURES_KHR)
            {
                VkPhysicalDeviceFragmentShaderBarycentricFeaturesKHR available2{
                    VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FRAGMENT_SHADER_BARYCENTRIC_FEATURES_KHR };
                VkPhysicalDeviceFeatures2 features2{ VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FEATURES_2 };
                features2.pNext = &available2;
                VULKAN_HPP_DEFAULT_DISPATCHER.vkGetPhysicalDeviceFeatures2(
                    DeviceManagerVKAccess::PhysicalDevice(deviceManager), &features2);
                auto* barycentric = reinterpret_cast<VkPhysicalDeviceFragmentShaderBarycentricFeaturesKHR*>(const_cast<VkBaseInStructure*>(next));
                barycentric->fragmentShaderBarycentric = available2.fragmentShaderBarycentric;
                result.fragmentShaderBarycentric = available2.fragmentShaderBarycentric == VK_TRUE;
            }
        }

        // Quad control needs maximal reconvergence: both extensions, both features.
        bool quadControlExtension = false;
        bool maximalReconvergenceExtension = false;
        for (uint32_t i = 0; i < info.enabledExtensionCount; i++)
        {
            quadControlExtension |= strcmp(info.ppEnabledExtensionNames[i], VK_KHR_SHADER_QUAD_CONTROL_EXTENSION_NAME) == 0;
            maximalReconvergenceExtension |= strcmp(info.ppEnabledExtensionNames[i], VK_KHR_SHADER_MAXIMAL_RECONVERGENCE_EXTENSION_NAME) == 0;
        }
        if (quadControlExtension && maximalReconvergenceExtension)
        {
            VkPhysicalDeviceShaderQuadControlFeaturesKHR quadControl{
                VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_SHADER_QUAD_CONTROL_FEATURES_KHR };
            VkPhysicalDeviceShaderMaximalReconvergenceFeaturesKHR maximalReconvergence{
                VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_SHADER_MAXIMAL_RECONVERGENCE_FEATURES_KHR };
            quadControl.pNext = &maximalReconvergence;
            VkPhysicalDeviceFeatures2 features2{ VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FEATURES_2 };
            features2.pNext = &quadControl;
            VULKAN_HPP_DEFAULT_DISPATCHER.vkGetPhysicalDeviceFeatures2(
                DeviceManagerVKAccess::PhysicalDevice(deviceManager), &features2);
            if (quadControl.shaderQuadControl && maximalReconvergence.shaderMaximalReconvergence)
            {
                result.quadControl.shaderQuadControl = VK_TRUE;
                result.maximalReconvergence.shaderMaximalReconvergence = VK_TRUE;
                result.quadControl.pNext = &result.maximalReconvergence;
                result.maximalReconvergence.pNext = const_cast<void*>(info.pNext);
                info.pNext = &result.quadControl;
            }
        }

        // Donut enables the optional extensions the GPU has; the features go with them.
        for (uint32_t i = 0; i < info.enabledExtensionCount; i++)
        {
            if (strcmp(info.ppEnabledExtensionNames[i], VK_NV_RAY_TRACING_INVOCATION_REORDER_EXTENSION_NAME) == 0)
            {
                VkPhysicalDeviceRayTracingInvocationReorderFeaturesNV available2{
                    VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_RAY_TRACING_INVOCATION_REORDER_FEATURES_NV };
                VkPhysicalDeviceFeatures2 features2{ VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FEATURES_2 };
                features2.pNext = &available2;
                VULKAN_HPP_DEFAULT_DISPATCHER.vkGetPhysicalDeviceFeatures2(
                    DeviceManagerVKAccess::PhysicalDevice(deviceManager), &features2);
                if (available2.rayTracingInvocationReorder)
                {
                    result.invocationReorder.rayTracingInvocationReorder = VK_TRUE;
                    result.invocationReorder.pNext = const_cast<void*>(info.pNext);
                    info.pNext = &result.invocationReorder;
                }
                continue;
            }
            if (strcmp(info.ppEnabledExtensionNames[i], VK_KHR_COMPUTE_SHADER_DERIVATIVES_EXTENSION_NAME) == 0)
            {
                VkPhysicalDeviceComputeShaderDerivativesFeaturesKHR available2{
                    VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_COMPUTE_SHADER_DERIVATIVES_FEATURES_KHR };
                VkPhysicalDeviceFeatures2 features2{ VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FEATURES_2 };
                features2.pNext = &available2;
                VULKAN_HPP_DEFAULT_DISPATCHER.vkGetPhysicalDeviceFeatures2(
                    DeviceManagerVKAccess::PhysicalDevice(deviceManager), &features2);
                if (available2.computeDerivativeGroupQuads || available2.computeDerivativeGroupLinear)
                {
                    result.computeShaderDerivatives.computeDerivativeGroupQuads = available2.computeDerivativeGroupQuads;
                    result.computeShaderDerivatives.computeDerivativeGroupLinear = available2.computeDerivativeGroupLinear;
                    result.computeShaderDerivatives.pNext = const_cast<void*>(info.pNext);
                    info.pNext = &result.computeShaderDerivatives;
                }
                continue;
            }
            if (strcmp(info.ppEnabledExtensionNames[i], VK_EXT_OPACITY_MICROMAP_EXTENSION_NAME) == 0)
            {
                VkPhysicalDeviceOpacityMicromapFeaturesEXT available2{
                    VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_OPACITY_MICROMAP_FEATURES_EXT };
                VkPhysicalDeviceFeatures2 features2{ VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FEATURES_2 };
                features2.pNext = &available2;
                VULKAN_HPP_DEFAULT_DISPATCHER.vkGetPhysicalDeviceFeatures2(
                    DeviceManagerVKAccess::PhysicalDevice(deviceManager), &features2);
                if (available2.micromap)
                {
                    result.opacityMicromap.micromap = VK_TRUE;
                    result.opacityMicromap.pNext = const_cast<void*>(info.pNext);
                    info.pNext = &result.opacityMicromap;
                }
                continue;
            }
            if (strcmp(info.ppEnabledExtensionNames[i], VK_EXT_LINE_RASTERIZATION_EXTENSION_NAME) == 0)
            {
                VkPhysicalDeviceLineRasterizationFeaturesEXT available2{
                    VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_LINE_RASTERIZATION_FEATURES_EXT };
                VkPhysicalDeviceFeatures2 features2{ VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FEATURES_2 };
                features2.pNext = &available2;
                VULKAN_HPP_DEFAULT_DISPATCHER.vkGetPhysicalDeviceFeatures2(
                    DeviceManagerVKAccess::PhysicalDevice(deviceManager), &features2);
                VkPhysicalDeviceLineRasterizationFeaturesEXT& lines = result.lineRasterization;
                lines.rectangularLines = available2.rectangularLines;
                lines.bresenhamLines = available2.bresenhamLines;
                lines.smoothLines = available2.smoothLines;
                lines.stippledRectangularLines = available2.stippledRectangularLines;
                lines.stippledBresenhamLines = available2.stippledBresenhamLines;
                lines.stippledSmoothLines = available2.stippledSmoothLines;
                lines.pNext = const_cast<void*>(info.pNext);
                info.pNext = &lines;
                continue;
            }
            if (strcmp(info.ppEnabledExtensionNames[i], VK_EXT_BLEND_OPERATION_ADVANCED_EXTENSION_NAME) == 0)
            {
                VkPhysicalDeviceBlendOperationAdvancedFeaturesEXT available2{
                    VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_BLEND_OPERATION_ADVANCED_FEATURES_EXT };
                VkPhysicalDeviceFeatures2 features2{ VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FEATURES_2 };
                features2.pNext = &available2;
                VULKAN_HPP_DEFAULT_DISPATCHER.vkGetPhysicalDeviceFeatures2(
                    DeviceManagerVKAccess::PhysicalDevice(deviceManager), &features2);
                if (available2.advancedBlendCoherentOperations)
                {
                    result.blendOperationAdvanced.advancedBlendCoherentOperations = VK_TRUE;
                    result.blendOperationAdvanced.pNext = const_cast<void*>(info.pNext);
                    info.pNext = &result.blendOperationAdvanced;
                }
                continue;
            }
            if (strcmp(info.ppEnabledExtensionNames[i], VK_EXT_CONDITIONAL_RENDERING_EXTENSION_NAME) != 0)
                continue;
            VkPhysicalDeviceConditionalRenderingFeaturesEXT available2{
                VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_CONDITIONAL_RENDERING_FEATURES_EXT };
            VkPhysicalDeviceFeatures2 features2{ VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FEATURES_2 };
            features2.pNext = &available2;
            VULKAN_HPP_DEFAULT_DISPATCHER.vkGetPhysicalDeviceFeatures2(
                DeviceManagerVKAccess::PhysicalDevice(deviceManager), &features2);
            if (available2.conditionalRendering)
            {
                result.conditionalRendering.conditionalRendering = VK_TRUE;
                result.conditionalRendering.pNext = const_cast<void*>(info.pNext);
                info.pNext = &result.conditionalRendering;
            }
        }
    }
#endif
}

// donut_interop.d.ts mirrors these enum values as plain numbers.
static_assert(int(nvrhi::GraphicsAPI::D3D11) == 0 && int(nvrhi::GraphicsAPI::D3D12) == 1 && int(nvrhi::GraphicsAPI::VULKAN) == 2);
static_assert(int(nvrhi::Feature::Meshlets) == 9 && int(nvrhi::Feature::RayTracingPipeline) == 14
    && int(nvrhi::Feature::ShaderSpecializations) == 18 && int(nvrhi::Feature::VariableRateShading) == 21
    && int(nvrhi::Feature::RayQuery) == 10);
static_assert(int(nvrhi::ShaderType::Vertex) == 0x1 && int(nvrhi::ShaderType::Hull) == 0x2
    && int(nvrhi::ShaderType::Domain) == 0x4 && int(nvrhi::ShaderType::Geometry) == 0x8
    && int(nvrhi::ShaderType::Pixel) == 0x10
    && int(nvrhi::ShaderType::Compute) == 0x20 && int(nvrhi::ShaderType::Amplification) == 0x40
    && int(nvrhi::ShaderType::Mesh) == 0x80 && int(nvrhi::ShaderType::All) == 0x3FFF);
static_assert(int(nvrhi::PrimitiveType::PointList) == 0 && int(nvrhi::PrimitiveType::LineList) == 1
    && int(nvrhi::PrimitiveType::LineStrip) == 2 && int(nvrhi::PrimitiveType::TriangleList) == 3 && int(nvrhi::PrimitiveType::TriangleStrip) == 4
    && int(nvrhi::PrimitiveType::PatchList) == 8);
static_assert(int(nvrhi::Format::UNKNOWN) == 0 && int(nvrhi::Format::R16_UINT) == 9);
static_assert(int(nvrhi::Format::RGBA8_UINT) == 17 && int(nvrhi::Format::R32_UINT) == 33 && int(nvrhi::Format::RGBA16_FLOAT) == 38
    && int(nvrhi::Format::RG32_FLOAT) == 43 && int(nvrhi::Format::RGB32_FLOAT) == 46
    && int(nvrhi::Format::RGBA8_UNORM) == 19 && int(nvrhi::Format::RGBA16_UINT) == 36 && int(nvrhi::Format::D32) == 53
    && int(nvrhi::Format::RGBA32_FLOAT) == 49 && int(nvrhi::Format::SRGBA8_UNORM) == 23
    && int(nvrhi::Format::BGRA8_UNORM) == 21 && int(nvrhi::Format::SBGRA8_UNORM) == 24);
static_assert(int(nvrhi::ResolveMode::None) == 0 && int(nvrhi::ResolveMode::SampleZero) == 1
    && int(nvrhi::ResolveMode::Average) == 2 && int(nvrhi::ResolveMode::Min) == 3 && int(nvrhi::ResolveMode::Max) == 4);
static_assert(int(nvrhi::BlendFactor::Zero) == 1 && int(nvrhi::BlendFactor::SrcAlphaSaturate) == 11
    && int(nvrhi::BlendFactor::ConstantColor) == 14 && int(nvrhi::BlendFactor::InvConstantColor) == 15);
static_assert(int(nvrhi::BlendOp::Add) == 1 && int(nvrhi::BlendOp::Max) == 5);
static_assert(int(nvrhi::LineRasterizationMode::Default) == 0 && int(nvrhi::LineRasterizationMode::Smooth) == 3);
static_assert(int(nvrhi::rt::AccelStructBuildFlags::PreferFastTrace) == 4
    && int(nvrhi::rt::AccelStructBuildFlags::AllowDataAccess) == 0x40);
static_assert(int(nvrhi::Feature::RayTracingPositionFetch) == 15);
static_assert(int(nvrhi::VariableShadingRate::e1x1) == 0 && int(nvrhi::VariableShadingRate::e4x4) == 6
    && int(nvrhi::ShadingRateCombiner::Passthrough) == 0 && int(nvrhi::ShadingRateCombiner::Override) == 1
    && int(nvrhi::ShadingRateCombiner::ApplyRelative) == 4);
static_assert(int(nvrhi::Format::R8_UINT) == 1 && int(nvrhi::Format::RG8_UINT) == 5);
static_assert(int(nvrhi::Format::BC3_UNORM_SRGB) == 61 && int(nvrhi::Format::BC7_UNORM_SRGB) == 69);
static_assert(int(nvrhi::Format::RG32_UINT) == 41 && int(nvrhi::Format::RGBA32_UINT) == 47
    && int(nvrhi::Format::BC1_UNORM) == 56 && int(nvrhi::Format::BC3_UNORM) == 60
    && int(nvrhi::Format::BC5_UNORM) == 64 && int(nvrhi::Format::BC7_UNORM) == 68);
static_assert(int(nvrhi::SamplerAddressMode::Clamp) == 0 && int(nvrhi::SamplerAddressMode::Wrap) == 1
    && int(nvrhi::SamplerAddressMode::Border) == 2 && int(nvrhi::SamplerAddressMode::Mirror) == 3
    && int(nvrhi::SamplerAddressMode::MirrorOnce) == 4);
static_assert(int(nvrhi::LogicOp::Clear) == 0 && int(nvrhi::LogicOp::Copy) == 3 && int(nvrhi::LogicOp::Xor) == 6
    && int(nvrhi::LogicOp::Set) == 15);
static_assert(int(donut::log::Severity::None) == 0 && int(donut::log::Severity::Fatal) == 5);
// LoadMatrix copies 16 floats from TypeScript straight into these.
static_assert(sizeof(dm::float4x4) == 16 * sizeof(float));
// TypeScript lays these out in its own constant buffers, which only works if HLSL doesn't pad them.
static_assert(sizeof(LightConstants) % 16 == 0 && sizeof(PlanarViewConstants) % 16 == 0);

namespace
{
    // Names for the C++ types handed to TypeScript as handles that have none of their own;
    // tools/check_interop_types.py maps handle types by these names.
    using InputLayoutDesc = std::vector<nvrhi::VertexAttributeDesc>;
    using StringList = std::vector<std::string>;
    using RandomEngine = std::default_random_engine;
    using FramebufferFactoryRef = std::shared_ptr<donut::engine::FramebufferFactory>;
}

extern "C"
{
    // --- Application -----------------------------------------------------------------------

    // Values of the `options` bit mask of Donut_CreateAppWithOptions.
    enum AppOptions
    {
        AppOption_RayTracing = 1, // enables the Vulkan ray tracing extensions (D3D12 has them built in)
        AppOption_ComputeQueue = 2, // creates a separate compute queue (nvrhi::CommandQueue::Compute)
        AppOption_DebugRuntime = 4, // enables the graphics API's debug layer and NVRHI's validation layer
        AppOption_Fullscreen = 8, // starts in fullscreen at the monitor's native resolution
        AppOption_NoVsync = 16, // starts with vertical sync off
        AppOption_PerMonitorDpi = 32, // DPI aware, with ImGui scaled explicitly (as Donut's feature demo)
        AppOption_Dlss = 64, // with Vulkan, enables the extensions DLSS needs (when built with DONUT_WITH_DLSS)
        AppOption_UnormBackBuffer = 128, // UNORM back buffers instead of sRGB ones
        AppOption_HdrBackBuffer = 256, // R10G10B10A2_UNORM back buffers, for HDR10 (Donut_SetSwapChainColorSpace)
    };

    // Creates the device and window for graphicsApi (an nvrhi::GraphicsAPI value), with the
    // AppOptions bits in options. Returns null on failure.
    App* Donut_CreateAppWithOptions(int graphicsApi, const char* title, int width, int height, int options)
    {
        // Console app: log to the console instead of Donut's default modal MessageBox on errors.
        donut::log::ConsoleApplicationMode();

        const auto api = static_cast<nvrhi::GraphicsAPI>(graphicsApi);
        std::unique_ptr<DeviceManager> deviceManager(DeviceManager::Create(api));
        if (!deviceManager)
            return nullptr;

        donut::app::DeviceCreationParameters params;
        params.backBufferWidth = static_cast<uint32_t>(width);
        params.backBufferHeight = static_cast<uint32_t>(height);
        params.vsyncEnabled = (options & AppOption_NoVsync) == 0;
        params.startFullscreen = (options & AppOption_Fullscreen) != 0;
        params.enablePerMonitorDPI = (options & AppOption_PerMonitorDpi) != 0;
        params.supportExplicitDisplayScaling = (options & AppOption_PerMonitorDpi) != 0;
        params.enableRayTracingExtensions = (options & AppOption_RayTracing) != 0;
        params.enableComputeQueue = (options & AppOption_ComputeQueue) != 0;
        params.enableDebugRuntime = (options & AppOption_DebugRuntime) != 0;
        params.enableNvrhiValidationLayer = (options & AppOption_DebugRuntime) != 0;
        // Donut's Vulkan device manager turns it into BGRA8_UNORM.
        if ((options & AppOption_UnormBackBuffer) != 0)
            params.swapChainFormat = nvrhi::Format::RGBA8_UNORM;
        // 10 bits per channel, in sRGB until Donut_SetSwapChainColorSpace asks for HDR10 (which
        // Vulkan has through VK_EXT_swapchain_colorspace).
        if ((options & AppOption_HdrBackBuffer) != 0)
        {
            params.swapChainFormat = nvrhi::Format::R10G10B10A2_UNORM;
            params.optionalVulkanInstanceExtensions.push_back("VK_EXT_swapchain_colorspace");
        }
        // Conservative rasterization where the GPU has it (Feature.ConservativeRasterization).
        params.optionalVulkanDeviceExtensions.push_back("VK_EXT_conservative_rasterization");
        // Conditional rendering (Donut_HasConditionalRendering).
        params.optionalVulkanDeviceExtensions.push_back("VK_EXT_conditional_rendering");
        // Rasterizer ordered views (Donut_HasRasterizerOrderedViews).
        params.optionalVulkanDeviceExtensions.push_back("VK_EXT_fragment_shader_interlock");
        // Barycentrics in pixel shaders (Donut_HasBarycentrics).
        params.optionalVulkanDeviceExtensions.push_back("VK_KHR_fragment_shader_barycentric");
        // Derivatives in compute shaders (Donut_GetComputeShaderDerivatives).
        params.optionalVulkanDeviceExtensions.push_back("VK_KHR_compute_shader_derivatives");
        // Shader execution reordering in ray tracing pipelines (Donut_GetShaderExecutionReordering):
        // the NV extension, whose SPIR-V instructions DXC emits as inline SPIR-V.
        if ((options & AppOption_RayTracing) != 0)
            params.optionalVulkanDeviceExtensions.push_back("VK_NV_ray_tracing_invocation_reorder");
        // The vertex positions of the triangles hit shaders hit (Feature.RayTracingPositionFetch;
        // Donut chains its feature, on).
        if ((options & AppOption_RayTracing) != 0)
            params.optionalVulkanDeviceExtensions.push_back("VK_KHR_ray_tracing_position_fetch");
        // Opacity micromaps in BLASes (Feature.RayTracingOpacityMicromap; its feature chained by
        // EnableCoreFeatures).
        if ((options & AppOption_RayTracing) != 0)
            params.optionalVulkanDeviceExtensions.push_back("VK_EXT_opacity_micromap");
        // Advanced blend operations (Donut_GetAdvancedBlendOperations).
        params.optionalVulkanDeviceExtensions.push_back("VK_EXT_blend_operation_advanced");
        // Quad control in shaders (Donut_HasShaderQuadControl), which needs maximal reconvergence.
        params.optionalVulkanDeviceExtensions.push_back("VK_KHR_shader_quad_control");
        params.optionalVulkanDeviceExtensions.push_back("VK_KHR_shader_maximal_reconvergence");
        // Line rasterization modes and stipple (Donut_GetLineRasterizationModes).
        params.optionalVulkanDeviceExtensions.push_back("VK_EXT_line_rasterization");
        // Memory heaps' usage and budget (Donut_QueryMemoryBudget).
        params.optionalVulkanDeviceExtensions.push_back("VK_EXT_memory_budget");

#if DONUT_WITH_DLSS && DONUT_WITH_VULKAN
        if ((options & AppOption_Dlss) != 0 && api == nvrhi::GraphicsAPI::VULKAN)
        {
            donut::render::DLSS::GetRequiredVulkanExtensions(
                params.optionalVulkanInstanceExtensions,
                params.optionalVulkanDeviceExtensions);
        }
#endif

        // D3D12's ExecuteIndirect does all of it but buffer addresses; D3D11 has single indirect draws.
        int indirectDrawSupport = api == nvrhi::GraphicsAPI::D3D12 ? IndirectDraw_MultiDraw | IndirectDraw_FirstInstance
            : api == nvrhi::GraphicsAPI::D3D11 ? IndirectDraw_FirstInstance : 0;
#if DONUT_WITH_VULKAN
        // Shared with the device manager's copy of the parameters.
        auto vulkanFeatures = std::make_shared<VulkanCoreFeatures>();
        if (api == nvrhi::GraphicsAPI::VULKAN)
        {
            auto* vulkanDeviceManager = static_cast<DeviceManager_VK*>(deviceManager.get());
            params.deviceCreateInfoCallback = [vulkanDeviceManager, vulkanFeatures](VkDeviceCreateInfo& info)
            {
                EnableCoreFeatures(vulkanDeviceManager, info, *vulkanFeatures);
            };
        }
#endif

        if (!deviceManager->CreateWindowDeviceAndSwapChain(params, title))
        {
            donut::log::error("cannot initialize the graphics device");
            return nullptr;
        }
        // D3D11 and D3D12 have UAVs in pixel shaders at every feature level Donut runs on.
        bool fragmentStoresAndAtomics = api != nvrhi::GraphicsAPI::VULKAN;
        // NVRHI has no tiled resources on D3D11. D3D12 reports residency in shaders from tiled
        // resources tier 2 on; Vulkan needs the features and sparse binding on the graphics queue,
        // which NVRHI binds on.
        bool sparseResidency = false;
#if DONUT_WITH_DX12
        if (api == nvrhi::GraphicsAPI::D3D12)
        {
            D3D12_FEATURE_DATA_D3D12_OPTIONS options = {};
            ID3D12Device* d3dDevice = deviceManager->GetDevice()->getNativeObject(nvrhi::ObjectTypes::D3D12_Device);
            sparseResidency = SUCCEEDED(d3dDevice->CheckFeatureSupport(D3D12_FEATURE_D3D12_OPTIONS, &options, sizeof(options)))
                && options.TiledResourcesTier >= D3D12_TILED_RESOURCES_TIER_2;
        }
#endif
#if DONUT_WITH_VULKAN
        if (api == nvrhi::GraphicsAPI::VULKAN)
        {
            indirectDrawSupport = vulkanFeatures->support;
            fragmentStoresAndAtomics = vulkanFeatures->features.fragmentStoresAndAtomics == VK_TRUE;

            auto* vulkanDeviceManager = static_cast<DeviceManager_VK*>(deviceManager.get());
            const vk::PhysicalDevice physicalDevice = DeviceManagerVKAccess::PhysicalDevice(vulkanDeviceManager);
            const int graphicsFamily = DeviceManagerVKAccess::GraphicsQueueFamily(vulkanDeviceManager);
            const auto families = physicalDevice.getQueueFamilyProperties();
            const VkPhysicalDeviceFeatures& features = vulkanFeatures->features;
            sparseResidency = features.sparseBinding && features.sparseResidencyImage2D && features.shaderResourceResidency
                && graphicsFamily >= 0 && size_t(graphicsFamily) < families.size()
                && (families[graphicsFamily].queueFlags & vk::QueueFlagBits::eSparseBinding);
        }
#endif

        App* app = MakeApp(std::move(deviceManager), api);
        // D3D12 runs pixel shaders in whole quads, helper lanes taking part in quad operations.
        app->shaderQuadControl = api == nvrhi::GraphicsAPI::D3D12;
        // D3D's line algorithms (Donut_GraphicsPipelineSetLineRasterization): quadrilateral lines
        // with multisampling on, aliased ones without, alpha antialiased ones; no stipple.
        if (api != nvrhi::GraphicsAPI::VULKAN)
            app->lineRasterizationModes = LineRasterization_Rectangular | LineRasterization_Bresenham | LineRasterization_Smooth;
        app->indirectDrawSupport = indirectDrawSupport;
        app->fragmentStoresAndAtomics = fragmentStoresAndAtomics;
        app->sparseResidency = sparseResidency;
        // D3D12 has predication from a buffer built in.
        app->conditionalRendering = api == nvrhi::GraphicsAPI::D3D12;
#if DONUT_WITH_DX11
        if (api == nvrhi::GraphicsAPI::D3D11)
        {
            D3D11_FEATURE_DATA_D3D11_OPTIONS2 options = {};
            ID3D11Device* d3dDevice = app->device()->getNativeObject(nvrhi::ObjectTypes::D3D11_Device);
            app->rasterizerOrderedViews = SUCCEEDED(d3dDevice->CheckFeatureSupport(D3D11_FEATURE_D3D11_OPTIONS2, &options, sizeof(options)))
                && options.ROVsSupported;
            D3D11_FEATURE_DATA_D3D11_OPTIONS options0 = {};
            app->logicOps = SUCCEEDED(d3dDevice->CheckFeatureSupport(D3D11_FEATURE_D3D11_OPTIONS, &options0, sizeof(options0)))
                && options0.OutputMergerLogicOp;
        }
#endif
#if DONUT_WITH_DX12
        if (api == nvrhi::GraphicsAPI::D3D12)
        {
            D3D12_FEATURE_DATA_D3D12_OPTIONS options = {};
            ID3D12Device* d3dDevice = app->device()->getNativeObject(nvrhi::ObjectTypes::D3D12_Device);
            app->rasterizerOrderedViews = SUCCEEDED(d3dDevice->CheckFeatureSupport(D3D12_FEATURE_D3D12_OPTIONS, &options, sizeof(options)))
                && options.ROVsSupported;
            app->logicOps = options.OutputMergerLogicOp != FALSE;
            D3D12_FEATURE_DATA_D3D12_OPTIONS2 options2 = {};
            app->depthBoundsTest = SUCCEEDED(d3dDevice->CheckFeatureSupport(D3D12_FEATURE_D3D12_OPTIONS2, &options2, sizeof(options2)))
                && options2.DepthBoundsTestSupported;
            D3D12_FEATURE_DATA_D3D12_OPTIONS3 options3 = {};
            app->barycentrics = SUCCEEDED(d3dDevice->CheckFeatureSupport(D3D12_FEATURE_D3D12_OPTIONS3, &options3, sizeof(options3)))
                && options3.BarycentricsSupported;
            // Shader model 6.2's native 16-bit types: anywhere, root constants included.
            D3D12_FEATURE_DATA_D3D12_OPTIONS4 options4 = {};
            app->native16Bit = SUCCEEDED(d3dDevice->CheckFeatureSupport(D3D12_FEATURE_D3D12_OPTIONS4, &options4, sizeof(options4)))
                && options4.Native16BitShaderOpsSupported;
            app->native16BitConstants = app->native16Bit;
            // Hit objects and MaybeReorderThread: shader model 6.9 with raytracing tier 1.2 (DXR
            // 1.2). D3D12 doesn't tell whether the GPU actually reorders.
            D3D12_FEATURE_DATA_D3D12_OPTIONS5 options5 = {};
            D3D12_FEATURE_DATA_SHADER_MODEL shaderModel69 = { D3D_SHADER_MODEL_6_9 };
            if (SUCCEEDED(d3dDevice->CheckFeatureSupport(D3D12_FEATURE_D3D12_OPTIONS5, &options5, sizeof(options5)))
                && options5.RaytracingTier >= D3D12_RAYTRACING_TIER_1_2
                && SUCCEEDED(d3dDevice->CheckFeatureSupport(D3D12_FEATURE_SHADER_MODEL, &shaderModel69, sizeof(shaderModel69)))
                && shaderModel69.HighestShaderModel >= D3D_SHADER_MODEL_6_9)
                app->shaderExecutionReordering = ShaderExecutionReordering_HitObjects;
            // Shader model 6.6 has derivatives in compute shaders, quads for 2D thread groups and
            // linear for 1D ones.
            D3D12_FEATURE_DATA_SHADER_MODEL shaderModel = { D3D_SHADER_MODEL_6_6 };
            if (SUCCEEDED(d3dDevice->CheckFeatureSupport(D3D12_FEATURE_SHADER_MODEL, &shaderModel, sizeof(shaderModel)))
                && shaderModel.HighestShaderModel >= D3D_SHADER_MODEL_6_6)
                app->computeShaderDerivatives = ComputeDerivatives_Quads | ComputeDerivatives_Linear;
        }
#endif
#if DONUT_WITH_VULKAN
        app->pipelineStatisticsQuery = api == nvrhi::GraphicsAPI::VULKAN && vulkanFeatures->features.pipelineStatisticsQuery;
        if (api == nvrhi::GraphicsAPI::VULKAN)
            app->logicOps = vulkanFeatures->features.logicOp == VK_TRUE;
        if (api == nvrhi::GraphicsAPI::VULKAN)
            app->depthBoundsTest = vulkanFeatures->features.depthBounds == VK_TRUE;
        if (api == nvrhi::GraphicsAPI::VULKAN)
        {
            app->conditionalRendering = vulkanFeatures->conditionalRendering.conditionalRendering == VK_TRUE;
            app->rasterizerOrderedViews = vulkanFeatures->fragmentShaderPixelInterlock;
            app->barycentrics = vulkanFeatures->fragmentShaderBarycentric;
            app->native16Bit = vulkanFeatures->native16Bit;
            app->native16BitConstants = vulkanFeatures->native16BitConstants;
            app->shaderQuadControl = vulkanFeatures->quadControl.shaderQuadControl == VK_TRUE;
            const VkPhysicalDeviceLineRasterizationFeaturesEXT& lines = vulkanFeatures->lineRasterization;
            app->lineRasterizationModes = (lines.rectangularLines ? LineRasterization_Rectangular : 0)
                | (lines.bresenhamLines ? LineRasterization_Bresenham : 0)
                | (lines.smoothLines ? LineRasterization_Smooth : 0)
                | (lines.stippledRectangularLines ? LineRasterization_StippledRectangular : 0)
                | (lines.stippledBresenhamLines ? LineRasterization_StippledBresenham : 0)
                | (lines.stippledSmoothLines ? LineRasterization_StippledSmooth : 0);
            if (vulkanFeatures->features.wideLines)
            {
                auto* vulkanDeviceManager = static_cast<DeviceManager_VK*>(app->deviceManager.get());
                VkPhysicalDeviceProperties properties{};
                VULKAN_HPP_DEFAULT_DISPATCHER.vkGetPhysicalDeviceProperties(
                    DeviceManagerVKAccess::PhysicalDevice(vulkanDeviceManager), &properties);
                app->maxLineWidth = properties.limits.lineWidthRange[1];
            }
            if (vulkanFeatures->blendOperationAdvanced.advancedBlendCoherentOperations)
            {
                auto* vulkanDeviceManager = static_cast<DeviceManager_VK*>(app->deviceManager.get());
                VkPhysicalDeviceBlendOperationAdvancedPropertiesEXT advanced{
                    VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_BLEND_OPERATION_ADVANCED_PROPERTIES_EXT };
                VkPhysicalDeviceProperties2 properties2{ VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_PROPERTIES_2 };
                properties2.pNext = &advanced;
                VULKAN_HPP_DEFAULT_DISPATCHER.vkGetPhysicalDeviceProperties2(
                    DeviceManagerVKAccess::PhysicalDevice(vulkanDeviceManager), &properties2);
                app->advancedBlendOperations = AdvancedBlend_Available
                    | (advanced.advancedBlendAllOperations ? AdvancedBlend_AllOperations : 0)
                    | (advanced.advancedBlendNonPremultipliedSrcColor ? AdvancedBlend_NonPremultipliedSrc : 0)
                    | (advanced.advancedBlendNonPremultipliedDstColor ? AdvancedBlend_NonPremultipliedDst : 0)
                    | (advanced.advancedBlendCorrelatedOverlap ? AdvancedBlend_CorrelatedOverlap : 0);
            }
            app->computeShaderDerivatives =
                (vulkanFeatures->computeShaderDerivatives.computeDerivativeGroupQuads ? ComputeDerivatives_Quads : 0)
                | (vulkanFeatures->computeShaderDerivatives.computeDerivativeGroupLinear ? ComputeDerivatives_Linear : 0);
            if (vulkanFeatures->invocationReorder.rayTracingInvocationReorder)
            {
                auto* vulkanDeviceManager = static_cast<DeviceManager_VK*>(app->deviceManager.get());
                VkPhysicalDeviceRayTracingInvocationReorderPropertiesNV reorder{
                    VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_RAY_TRACING_INVOCATION_REORDER_PROPERTIES_NV };
                VkPhysicalDeviceProperties2 properties2{ VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_PROPERTIES_2 };
                properties2.pNext = &reorder;
                VULKAN_HPP_DEFAULT_DISPATCHER.vkGetPhysicalDeviceProperties2(
                    DeviceManagerVKAccess::PhysicalDevice(vulkanDeviceManager), &properties2);
                app->shaderExecutionReordering =
                    reorder.rayTracingInvocationReorderReorderingHint == VK_RAY_TRACING_INVOCATION_REORDER_MODE_REORDER_NV
                    ? ShaderExecutionReordering_Reorders : ShaderExecutionReordering_HitObjects;
            }
        }
#endif
        return app;
    }

    // IndirectDrawSupport bits: what the app's device does with indirect draws (0 for headless apps).
    int Donut_GetIndirectDrawSupport(App* app)
    {
        return app->indirectDrawSupport;
    }

    // Non-zero if pixel shaders can write to UAVs and do atomics on them (Vulkan's
    // fragmentStoresAndAtomics; always on D3D11 and D3D12; 0 for headless apps).
    int Donut_HasFragmentStoresAndAtomics(App* app)
    {
        return app->fragmentStoresAndAtomics ? 1 : 0;
    }

    // Vulkan's conservative rasterization properties (VkPhysicalDeviceConservativeRasterizationPropertiesEXT)
    // into dst (Ref of a `let` f32 array of 9): primitiveOverestimationSize,
    // maxExtraPrimitiveOverestimationSize, extraPrimitiveOverestimationSizeGranularity, then 1 or 0
    // for primitiveUnderestimation, conservativePointAndLineRasterization,
    // degenerateTrianglesRasterized, degenerateLinesRasterized,
    // fullyCoveredFragmentShaderInputVariable, conservativeRasterizationPostDepthCoverage. Returns 0
    // (dst untouched) on other graphics APIs or without the extension.
    int Donut_GetVulkanConservativeRasterizationProperties(App* app, float* dst)
    {
#if DONUT_WITH_VULKAN
        App* a = app;
        if (a->device()->getGraphicsAPI() != nvrhi::GraphicsAPI::VULKAN
            || !a->device()->queryFeatureSupport(nvrhi::Feature::ConservativeRasterization))
            return 0;
        const vk::PhysicalDevice physicalDevice = DeviceManagerVKAccess::PhysicalDevice(
            static_cast<DeviceManager_VK*>(a->deviceManager.get()));
        auto properties = vk::PhysicalDeviceConservativeRasterizationPropertiesEXT();
        vk::PhysicalDeviceProperties2 properties2;
        properties2.pNext = &properties;
        physicalDevice.getProperties2(&properties2);
        dst[0] = properties.primitiveOverestimationSize;
        dst[1] = properties.maxExtraPrimitiveOverestimationSize;
        dst[2] = properties.extraPrimitiveOverestimationSizeGranularity;
        dst[3] = properties.primitiveUnderestimation ? 1.f : 0.f;
        dst[4] = properties.conservativePointAndLineRasterization ? 1.f : 0.f;
        dst[5] = properties.degenerateTrianglesRasterized ? 1.f : 0.f;
        dst[6] = properties.degenerateLinesRasterized ? 1.f : 0.f;
        dst[7] = properties.fullyCoveredFragmentShaderInputVariable ? 1.f : 0.f;
        dst[8] = properties.conservativeRasterizationPostDepthCoverage ? 1.f : 0.f;
        return 1;
#else
        return 0;
#endif
    }

    // D3D12's conservative rasterization tier (D3D12_CONSERVATIVE_RASTERIZATION_TIER, 0 for none);
    // 0 on other graphics APIs.
    int Donut_GetD3D12ConservativeRasterizationTier(App* app)
    {
#if DONUT_WITH_DX12
        nvrhi::IDevice* device = app->device();
        if (device->getGraphicsAPI() == nvrhi::GraphicsAPI::D3D12)
        {
            D3D12_FEATURE_DATA_D3D12_OPTIONS options = {};
            ID3D12Device* d3dDevice = device->getNativeObject(nvrhi::ObjectTypes::D3D12_Device);
            if (SUCCEEDED(d3dDevice->CheckFeatureSupport(D3D12_FEATURE_D3D12_OPTIONS, &options, sizeof(options))))
                return static_cast<int>(options.ConservativeRasterizationTier);
        }
#endif
        return 0;
    }

    // Non-zero if 2D textures can be tiled (Donut_CreateTiledTexture) and shaders can tell whether
    // what they sample is mapped (CheckAccessFullyMapped): D3D12 with tiled resources tier 2, Vulkan
    // with sparse residency of 2D images, shaderResourceResidency and sparse binding on the graphics
    // queue; never D3D11 or headless apps.
    int Donut_HasSparseResidency(App* app)
    {
        return app->sparseResidency ? 1 : 0;
    }

    // Same, without options.
    App* Donut_CreateAppForAPI(int graphicsApi, const char* title, int width, int height)
    {
        return Donut_CreateAppWithOptions(graphicsApi, title, width, height, 0);
    }

    // Same, with the graphics API picked from the command line (-d3d11, -d3d12, -vk; D3D12 by
    // default on Windows).
    App* Donut_CreateApp(int argc, const char* const* argv, const char* title, int width, int height)
    {
        const nvrhi::GraphicsAPI api = donut::app::GetGraphicsAPIFromCommandLine(argc, argv);
        return Donut_CreateAppForAPI(static_cast<int>(api), title, width, height);
    }

    // Creates a device without a window or swap chain, for compute work; adapterIndex -1 picks
    // the default adapter. Such an app has no passes: run work with Donut_*CommandList. Of the
    // AppOptions bits, the device's apply (ray tracing, compute queue, debug runtime). Returns
    // null on failure.
    App* Donut_CreateHeadlessAppWithOptions(int graphicsApi, int adapterIndex, int options)
    {
        donut::log::ConsoleApplicationMode();

        const auto api = static_cast<nvrhi::GraphicsAPI>(graphicsApi);
        std::unique_ptr<DeviceManager> deviceManager(DeviceManager::Create(api));
        if (!deviceManager)
            return nullptr;

        donut::app::DeviceCreationParameters params;
        params.adapterIndex = adapterIndex;
        params.enableRayTracingExtensions = (options & AppOption_RayTracing) != 0;
        params.enableComputeQueue = (options & AppOption_ComputeQueue) != 0;
        params.enableDebugRuntime = (options & AppOption_DebugRuntime) != 0;
        params.enableNvrhiValidationLayer = (options & AppOption_DebugRuntime) != 0;

        if (!deviceManager->CreateHeadlessDevice(params))
            return nullptr;

        return MakeApp(std::move(deviceManager), api);
    }

    // Same, with no options.
    App* Donut_CreateHeadlessApp(int graphicsApi, int adapterIndex)
    {
        return Donut_CreateHeadlessAppWithOptions(graphicsApi, adapterIndex, 0);
    }

    // Lists the adapters for graphicsApi. Returns null (after logging why) on failure.
    AdapterList* Donut_EnumerateAdapters(int graphicsApi)
    {
        donut::log::ConsoleApplicationMode();

        const auto api = static_cast<nvrhi::GraphicsAPI>(graphicsApi);
        auto list = std::make_unique<AdapterList>();
        list->deviceManager.reset(DeviceManager::Create(api));

        donut::app::DeviceCreationParameters params;
        if (!list->deviceManager || !list->deviceManager->CreateInstance(params))
        {
            donut::log::error("Cannot initialize a %s subsystem.", nvrhi::utils::GraphicsAPIToString(api));
            return nullptr;
        }

        if (!list->deviceManager->EnumerateAdapters(list->adapters))
        {
            donut::log::error("Cannot enumerate graphics adapters.");
            return nullptr;
        }

        return list.release();
    }

    int Donut_GetAdapterCount(AdapterList* list)
    {
        return static_cast<int>(list->adapters.size());
    }

    const char* Donut_GetAdapterName(AdapterList* list, int index)
    {
        return list->adapters[index].name.c_str();
    }

    int Donut_GetAdapterMemoryMB(AdapterList* list, int index)
    {
        return static_cast<int>(list->adapters[index].dedicatedVideoMemory / (1024 * 1024));
    }

    // Names returned by Donut_GetAdapterName are invalid afterwards.
    void Donut_DestroyAdapterList(AdapterList* list)
    {
        delete list;
    }

    const char* Donut_GraphicsAPIToString(int graphicsApi)
    {
        return nvrhi::utils::GraphicsAPIToString(static_cast<nvrhi::GraphicsAPI>(graphicsApi));
    }

    int Donut_GetGraphicsAPIFromCommandLine(int argc, const char* const* argv)
    {
        return static_cast<int>(donut::app::GetGraphicsAPIFromCommandLine(argc, argv));
    }

    // argv[index] of the argv passed to main.
    const char* Donut_GetArg(const char* const* argv, int index)
    {
        return argv[index];
    }

    // Names the folder the next app loads its shaders from (bin/shaders/<name>/<api>) in place
    // of the executable's name, which under the JIT is donut_interop. Call before creating the app.
    void Donut_SetAppName(const char* name)
    {
        g_AppName = name ? name : "";
    }

    // The path the executable is taken to have: shaders and media are looked up next to it, and
    // its name is the app's unless Donut_SetAppName gave one. For an Android app, whose process is
    // the system's app_process: core/android_main.cpp extracts the APK's shaders and media and
    // points this into that folder. Call before creating the app.
    void Donut_SetExecutablePath(const char* path)
    {
        g_ExecutablePath = path ? path : "";
    }

    // severity is a donut::log::Severity value; messages below it are dropped.
    void Donut_SetLogMinSeverity(int severity)
    {
        donut::log::SetMinSeverity(static_cast<donut::log::Severity>(severity));
    }

    // Blocks until the window is closed.
    void Donut_RunApp(App* app)
    {
        app->deviceManager->RunMessageLoop();
    }

    // Destroys the app with all its passes and resources; their handles are invalid afterwards.
    void Donut_DestroyApp(App* app)
    {
        delete app;
    }

    // feature is an nvrhi::Feature value.
    int Donut_IsFeatureSupported(App* app, int feature)
    {
        return app->device()->queryFeatureSupport(static_cast<nvrhi::Feature>(feature)) ? 1 : 0;
    }

    // The fewest and most lanes a wave (subgroup) has (D3D12's WaveLaneCountMin / Max; Vulkan's one
    // subgroupSize for both); 0 without wave intrinsics (D3D11).
    static nvrhi::WaveLaneCountMinMaxFeatureInfo GetWaveLaneCounts(App* app)
    {
        nvrhi::WaveLaneCountMinMaxFeatureInfo info{};
        if (!app->device()->queryFeatureSupport(nvrhi::Feature::WaveLaneCountMinMax, &info, sizeof(info)))
            return {};
        return info;
    }

    int Donut_GetWaveLaneCountMin(App* app)
    {
        return static_cast<int>(GetWaveLaneCounts(app).minWaveLaneCount);
    }

    int Donut_GetWaveLaneCountMax(App* app)
    {
        return static_cast<int>(GetWaveLaneCounts(app).maxWaveLaneCount);
    }

    const char* Donut_GetRendererString(App* app)
    {
        return app->deviceManager->GetRendererString();
    }

    void Donut_SetWindowTitle(App* app, const char* title)
    {
        app->deviceManager->SetWindowTitle(title);
    }

    // Sets "<title> (<graphics API>, <fps> FPS)"; cheap enough to call every frame.
    void Donut_SetInformativeWindowTitle(App* app, const char* title)
    {
        app->deviceManager->SetInformativeWindowTitle(title);
    }

    // Same, with extraInfo appended.
    void Donut_SetInformativeWindowTitleWithInfo(App* app, const char* title, const char* extraInfo)
    {
        app->deviceManager->SetInformativeWindowTitle(title, true, extraInfo);
    }

    // Apps start with vsync on. The change takes effect at the start of the next frame; on
    // Vulkan it recreates the swap chain, so the passes get onBackBufferResizing.
    void Donut_SetVsyncEnabled(App* app, int enabled)
    {
        app->deviceManager->SetVsyncEnabled(enabled != 0);
    }

    // Lags Donut_SetVsyncEnabled by up to a frame.
    int Donut_IsVsyncEnabled(App* app)
    {
        return app->deviceManager->IsVsyncEnabled() ? 1 : 0;
    }

    // Makes Donut_RunApp return after the current frame.
    void Donut_CloseWindow(App* app)
    {
        glfwSetWindowShouldClose(app->deviceManager->GetWindow(), GLFW_TRUE);
    }

    // The mouse cursor's mode (CursorMode): shown, hidden over the window, or hidden and captured
    // (GLFW_CURSOR_DISABLED: the mouse callback then gets unbounded virtual positions, from raw
    // mouse motion where the system has it).
    void Donut_SetCursorMode(App* app, int mode)
    {
        GLFWwindow* window = app->deviceManager->GetWindow();
        const int modes[] = { GLFW_CURSOR_NORMAL, GLFW_CURSOR_HIDDEN, GLFW_CURSOR_DISABLED };
        glfwSetInputMode(window, GLFW_CURSOR, modes[std::clamp(mode, 0, 2)]);
        if (glfwRawMouseMotionSupported())
            glfwSetInputMode(window, GLFW_RAW_MOUSE_MOTION, mode == 2 ? GLFW_TRUE : GLFW_FALSE);
    }

    // Moves the mouse cursor to (x, y) in the mouse callback's coordinates.
    void Donut_SetCursorPosition(App* app, double x, double y)
    {
        donut::app::DeviceManager* deviceManager = app->deviceManager.get();
        // The inverse of DeviceManager::MousePosUpdate's scaling.
        if (!deviceManager->GetDeviceParams().supportExplicitDisplayScaling)
        {
            float scaleX = 1.f, scaleY = 1.f;
            deviceManager->GetDPIScaleInfo(scaleX, scaleY);
            x *= scaleX;
            y *= scaleY;
        }
        glfwSetCursorPos(deviceManager->GetWindow(), x, y);
    }

    // Non-zero while the window has the keyboard focus.
    int Donut_IsWindowFocused(App* app)
    {
        return glfwGetWindowAttrib(app->deviceManager->GetWindow(), GLFW_FOCUSED);
    }

    // --- Resources (owned by the app until released or the app is destroyed) ---------------

    // Loads a shader compiled from the example's shaders/<example>.cfg. shaderType is an
    // nvrhi::ShaderType value. Returns null on failure.
    nvrhi::IShader* Donut_CreateShader(App* app, const char* fileName, const char* entryName, int shaderType)
    {
        App* a = app;
        const std::string path = std::string("app/") + fileName;
        nvrhi::ShaderHandle shader = a->shaderFactory->CreateShader(
            path.c_str(), entryName, nullptr, static_cast<nvrhi::ShaderType>(shaderType));
        return a->Own(shader);
    }

    // Same, for the permutation compiled with -D defineName=defineValue in the .cfg.
    nvrhi::IShader* Donut_CreateShaderWithDefine(App* app, const char* fileName, const char* entryName, int shaderType,
        const char* defineName, const char* defineValue)
    {
        App* a = app;
        const std::string path = std::string("app/") + fileName;
        const std::vector<donut::engine::ShaderMacro> defines = { { defineName, defineValue } };
        nvrhi::ShaderHandle shader = a->shaderFactory->CreateShader(
            path.c_str(), entryName, &defines, static_cast<nvrhi::ShaderType>(shaderType));
        return a->Own(shader);
    }

    // Shader library permutation compiled with -T lib -D defineName=defineValue. Returns null on failure.
    nvrhi::IShaderLibrary* Donut_CreateShaderLibraryWithDefine(App* app, const char* fileName, const char* defineName, const char* defineValue)
    {
        App* a = app;
        const std::string path = std::string("app/") + fileName;
        const std::vector<donut::engine::ShaderMacro> defines = { { defineName, defineValue } };
        return a->Own(a->shaderFactory->CreateShaderLibrary(path.c_str(), &defines));
    }

    // Loads a shader library (compiled with -T lib) from the example's shaders/<example>.cfg.
    // Returns null on failure.
    nvrhi::IShaderLibrary* Donut_CreateShaderLibrary(App* app, const char* fileName)
    {
        App* a = app;
        const std::string path = std::string("app/") + fileName;
        return a->Own(a->shaderFactory->CreateShaderLibrary(path.c_str(), nullptr));
    }

    // Ray tracing pipeline with one ray generation shader, one miss shader and one triangle hit
    // group made of a closest-hit shader (none if closestHitEntry is empty), all exported from
    // shaderLibrary by entry name, and one global binding layout. Returns null on failure.
    nvrhi::rt::IPipeline* Donut_CreateRayTracingPipeline(App* app, nvrhi::IShaderLibrary* shaderLibrary, nvrhi::IBindingLayout* bindingLayout,
        const char* rayGenEntry, const char* missEntry, const char* hitGroupName, const char* closestHitEntry,
        int maxPayloadSize)
    {
        auto* library = shaderLibrary;

        nvrhi::rt::PipelineDesc desc;
        desc.globalBindingLayouts = { bindingLayout };
        desc.shaders = {
            { "", library->getShader(rayGenEntry, nvrhi::ShaderType::RayGeneration), nullptr },
            { "", library->getShader(missEntry, nvrhi::ShaderType::Miss), nullptr }
        };
        desc.hitGroups = { nvrhi::rt::PipelineHitGroupDesc()
            .setExportName(hitGroupName)
            .setClosestHitShader(closestHitEntry && *closestHitEntry
                ? library->getShader(closestHitEntry, nvrhi::ShaderType::ClosestHit)
                : nullptr) };
        desc.maxPayloadSize = static_cast<uint32_t>(maxPayloadSize);

        App* a = app;
        return a->Own(a->device()->createRayTracingPipeline(desc));
    }

    // Same, with a closest-hit and an any-hit shader in the hit group (either may be ""), and a
    // second global binding layout (e.g. a bindless layout; null for none).
    nvrhi::rt::IPipeline* Donut_CreateRayTracingPipelineWithLayouts(App* app, nvrhi::IShaderLibrary* shaderLibrary, nvrhi::IBindingLayout* bindingLayout, nvrhi::IBindingLayout* secondBindingLayout,
        const char* rayGenEntry, const char* missEntry, const char* hitGroupName, const char* closestHitEntry,
        const char* anyHitEntry, int maxPayloadSize)
    {
        auto* library = shaderLibrary;
        auto entryShader = [library](const char* entry, nvrhi::ShaderType type) -> nvrhi::ShaderHandle {
            return entry && *entry ? library->getShader(entry, type) : nullptr;
        };

        nvrhi::rt::PipelineDesc desc;
        desc.globalBindingLayouts = { bindingLayout };
        if (secondBindingLayout)
            desc.globalBindingLayouts.push_back(secondBindingLayout);
        desc.shaders = {
            { "", library->getShader(rayGenEntry, nvrhi::ShaderType::RayGeneration), nullptr },
            { "", library->getShader(missEntry, nvrhi::ShaderType::Miss), nullptr }
        };
        desc.hitGroups = { nvrhi::rt::PipelineHitGroupDesc()
            .setExportName(hitGroupName)
            .setClosestHitShader(entryShader(closestHitEntry, nvrhi::ShaderType::ClosestHit))
            .setAnyHitShader(entryShader(anyHitEntry, nvrhi::ShaderType::AnyHit)) };
        desc.maxPayloadSize = static_cast<uint32_t>(maxPayloadSize);

        App* a = app;
        return a->Own(a->device()->createRayTracingPipeline(desc));
    }

    // Ray tracing pipelines of any shape: a description built up with the Donut_RtPipeline*
    // functions below, then consumed (freed) by Donut_CreateRayTracingPipelineFromDesc.
    // maxRecursionDepth: how deeply hit shaders may trace further rays (1 = no recursion).
    nvrhi::rt::PipelineDesc* Donut_CreateRayTracingPipelineDesc(int maxPayloadSize, int maxRecursionDepth)
    {
        auto* desc = new nvrhi::rt::PipelineDesc();
        desc->maxPayloadSize = static_cast<uint32_t>(maxPayloadSize);
        desc->maxRecursionDepth = static_cast<uint32_t>(maxRecursionDepth);
        return desc;
    }

    void Donut_RtPipelineAddGlobalBindingLayout(nvrhi::rt::PipelineDesc* pipelineDesc, nvrhi::IBindingLayout* bindingLayout)
    {
        pipelineDesc->globalBindingLayouts.push_back(
            bindingLayout);
    }

    // A ray generation, miss or callable shader (shaderType), exported by its entry name.
    void Donut_RtPipelineAddShader(nvrhi::rt::PipelineDesc* pipelineDesc, nvrhi::IShaderLibrary* shaderLibrary, const char* entryName, int shaderType)
    {
        pipelineDesc->shaders.push_back({ "",
            shaderLibrary->getShader(entryName, static_cast<nvrhi::ShaderType>(shaderType)),
            nullptr });
    }

    // A triangle hit group: closest-hit and any-hit shaders by entry name ("" for none), and an
    // optional local binding layout (D3D12 only; null for none) whose binding sets are given per
    // shader table entry.
    void Donut_RtPipelineAddHitGroup(nvrhi::rt::PipelineDesc* pipelineDesc, nvrhi::IShaderLibrary* shaderLibrary, const char* exportName,
        const char* closestHitEntry, const char* anyHitEntry, nvrhi::IBindingLayout* localBindingLayout)
    {
        auto* library = shaderLibrary;
        auto entryShader = [library](const char* entry, nvrhi::ShaderType type) -> nvrhi::ShaderHandle {
            return entry && *entry ? library->getShader(entry, type) : nullptr;
        };

        pipelineDesc->hitGroups.push_back(nvrhi::rt::PipelineHitGroupDesc()
            .setExportName(exportName)
            .setClosestHitShader(entryShader(closestHitEntry, nvrhi::ShaderType::ClosestHit))
            .setAnyHitShader(entryShader(anyHitEntry, nvrhi::ShaderType::AnyHit))
            .setBindingLayout(localBindingLayout));
    }

    // A procedural primitive hit group, for AABB geometries: intersection, closest-hit and any-hit
    // shaders by entry name ("" for no closest-hit / any-hit shader), and an optional local binding
    // layout as above.
    void Donut_RtPipelineAddProceduralHitGroup(nvrhi::rt::PipelineDesc* pipelineDesc, nvrhi::IShaderLibrary* shaderLibrary, const char* exportName,
        const char* intersectionEntry, const char* closestHitEntry, const char* anyHitEntry, nvrhi::IBindingLayout* localBindingLayout)
    {
        auto* library = shaderLibrary;
        auto entryShader = [library](const char* entry, nvrhi::ShaderType type) -> nvrhi::ShaderHandle {
            return entry && *entry ? library->getShader(entry, type) : nullptr;
        };

        pipelineDesc->hitGroups.push_back(nvrhi::rt::PipelineHitGroupDesc()
            .setExportName(exportName)
            .setIntersectionShader(entryShader(intersectionEntry, nvrhi::ShaderType::Intersection))
            .setClosestHitShader(entryShader(closestHitEntry, nvrhi::ShaderType::ClosestHit))
            .setAnyHitShader(entryShader(anyHitEntry, nvrhi::ShaderType::AnyHit))
            .setBindingLayout(localBindingLayout)
            .setIsProceduralPrimitive(true));
    }

    // The largest hit attribute structure the shaders report (D3D12's MaxAttributeSizeInBytes;
    // NVRHI's default is 8 bytes, two floats of triangle barycentrics).
    void Donut_RtPipelineSetMaxAttributeSize(nvrhi::rt::PipelineDesc* pipelineDesc, int byteSize)
    {
        pipelineDesc->maxAttributeSize = static_cast<uint32_t>(byteSize);
    }

    // Whether the pipeline's rays see the opacity micromaps of the BLASes they trace (D3D12's
    // D3D12_RAYTRACING_PIPELINE_FLAG_ALLOW_OPACITY_MICROMAPS, Vulkan's
    // VK_PIPELINE_CREATE_RAY_TRACING_OPACITY_MICROMAP_BIT_EXT); off by default.
    void Donut_RtPipelineSetAllowOpacityMicromaps(nvrhi::rt::PipelineDesc* pipelineDesc, int allow)
    {
        pipelineDesc->allowOpacityMicromaps = allow != 0;
    }

    // Returns null on failure.
    nvrhi::rt::IPipeline* Donut_CreateRayTracingPipelineFromDesc(App* app, nvrhi::rt::PipelineDesc* pipelineDesc)
    {
        std::unique_ptr<nvrhi::rt::PipelineDesc> desc(pipelineDesc);
        App* a = app;
        return a->Own(a->device()->createRayTracingPipeline(*desc));
    }

    // An empty shader table of a pipeline, filled with the Donut_ShaderTable* functions below.
    // It keeps the pipeline alive. Returns null on failure.
    nvrhi::rt::IShaderTable* Donut_CreateEmptyShaderTable(App* app, nvrhi::rt::IPipeline* rayTracingPipeline)
    {
        return app->Own(rayTracingPipeline->createShaderTable());
    }

    void Donut_ShaderTableSetRayGeneration(nvrhi::rt::IShaderTable* shaderTable, const char* exportName)
    {
        shaderTable->setRayGenerationShader(exportName);
    }

    // Returns the miss shader's index (TraceRay's MissShaderIndex).
    int Donut_ShaderTableAddMiss(nvrhi::rt::IShaderTable* shaderTable, const char* exportName)
    {
        return shaderTable->addMissShader(exportName);
    }

    // Adds an entry for a hit group, with a binding set for its local binding layout (null for
    // none). Returns the entry's index.
    int Donut_ShaderTableAddHitGroup(nvrhi::rt::IShaderTable* shaderTable, const char* exportName, nvrhi::IBindingSet* localBindingSet)
    {
        return shaderTable->addHitGroup(exportName,
            localBindingSet);
    }

    // Same as Donut_CreateShaderTable, with caching: NVRHI keeps up to maxCachedVersions copies
    // of the table in GPU memory, instead of re-uploading it every time it's used.
    nvrhi::rt::IShaderTable* Donut_CreateCachedShaderTable(App* app, nvrhi::rt::IPipeline* rayTracingPipeline, const char* rayGenExport,
        const char* hitGroupExport, const char* missExport, int maxCachedVersions, const char* debugName)
    {
        nvrhi::rt::ShaderTableHandle table = rayTracingPipeline->createShaderTable(
            nvrhi::rt::ShaderTableDesc().enableCaching(static_cast<uint32_t>(maxCachedVersions)).setDebugName(debugName));
        if (!table)
            return nullptr;
        table->setRayGenerationShader(rayGenExport);
        table->addHitGroup(hitGroupExport);
        table->addMissShader(missExport);
        return app->Own(table);
    }

    // Shader table of a ray tracing pipeline, with one ray generation shader, one hit group and
    // one miss shader, named by their export names. It keeps the pipeline alive.
    nvrhi::rt::IShaderTable* Donut_CreateShaderTable(App* app, nvrhi::rt::IPipeline* rayTracingPipeline, const char* rayGenExport,
        const char* hitGroupExport, const char* missExport)
    {
        nvrhi::rt::ShaderTableHandle table = rayTracingPipeline->createShaderTable();
        table->setRayGenerationShader(rayGenExport);
        table->addHitGroup(hitGroupExport);
        table->addMissShader(missExport);
        return app->Own(table);
    }

    // Buffer that acceleration structures are built from (vertex or index data), filled with
    // Donut_WriteBuffer. Returns null on failure.
    nvrhi::IBuffer* Donut_CreateAccelStructInputBuffer(App* app, int byteSize, const char* debugName)
    {
        auto desc = nvrhi::BufferDesc()
            .setByteSize(static_cast<uint64_t>(byteSize))
            .setIsAccelStructBuildInput(true)
            .setDebugName(debugName)
            .setInitialState(nvrhi::ResourceStates::ShaderResource)
            .setKeepInitialState(true);

        App* a = app;
        return a->Own(a->device()->createBuffer(desc));
    }

    // Same, that shaders also read as a ByteAddressBuffer (Donut_BindRawBufferSRV).
    nvrhi::IBuffer* Donut_CreateAccelStructInputRawBuffer(App* app, int byteSize, const char* debugName)
    {
        auto desc = nvrhi::BufferDesc()
            .setByteSize(static_cast<uint64_t>(byteSize))
            .setCanHaveRawViews(true)
            .setIsAccelStructBuildInput(true)
            .setDebugName(debugName)
            .setInitialState(nvrhi::ResourceStates::ShaderResource | nvrhi::ResourceStates::AccelStructBuildInput)
            .setKeepInitialState(true);

        App* a = app;
        return a->Own(a->device()->createBuffer(desc));
    }

    // Same, that shaders also read as a StructuredBuffer of `count` elements of `stride` bytes.
    nvrhi::IBuffer* Donut_CreateAccelStructInputStructuredBuffer(App* app, int stride, int count, const char* debugName)
    {
        auto desc = nvrhi::BufferDesc()
            .setByteSize(uint64_t(stride) * uint64_t(count))
            .setStructStride(static_cast<uint32_t>(stride))
            .setIsAccelStructBuildInput(true)
            .setDebugName(debugName)
            .setInitialState(nvrhi::ResourceStates::ShaderResource | nvrhi::ResourceStates::AccelStructBuildInput)
            .setKeepInitialState(true);

        App* a = app;
        return a->Own(a->device()->createBuffer(desc));
    }

    // A bottom-level acceleration structure of one opaque triangle geometry: indexCount R32_UINT
    // indices from byte indexByteOffset of indexBuffer, into vertexCount RGB32_FLOAT positions
    // every vertexStride bytes from byte vertexByteOffset of vertexBuffer (e.g. the first member
    // of interleaved vertices). Its build is recorded into an open command list, preferring fast
    // tracing, or if updatable != 0 fast builds and updates (Donut_UpdateTriangleBlas). Returns
    // null on failure.
    TriangleBlas* Donut_CreateTriangleBlas(App* app, nvrhi::ICommandList* commandList, nvrhi::IBuffer* indexBuffer, int indexByteOffset, int indexCount,
        nvrhi::IBuffer* vertexBuffer, int vertexByteOffset, int vertexCount, int vertexStride, int updatable, const char* debugName)
    {
        auto triangles = nvrhi::rt::GeometryTriangles()
            .setIndexBuffer(indexBuffer)
            .setIndexOffset(static_cast<uint64_t>(indexByteOffset))
            .setIndexFormat(nvrhi::Format::R32_UINT)
            .setIndexCount(static_cast<uint32_t>(indexCount))
            .setVertexBuffer(vertexBuffer)
            .setVertexOffset(static_cast<uint64_t>(vertexByteOffset))
            .setVertexFormat(nvrhi::Format::RGB32_FLOAT)
            .setVertexStride(static_cast<uint32_t>(vertexStride))
            .setVertexCount(static_cast<uint32_t>(vertexCount));

        auto blas = std::make_shared<TriangleBlas>();
        blas->desc.isTopLevel = false;
        blas->desc.debugName = debugName;
        blas->desc.buildFlags = updatable
            ? nvrhi::rt::AccelStructBuildFlags::PreferFastBuild | nvrhi::rt::AccelStructBuildFlags::AllowUpdate
            : nvrhi::rt::AccelStructBuildFlags::PreferFastTrace;
        blas->desc.addBottomLevelGeometry(nvrhi::rt::GeometryDesc()
            .setTriangles(triangles)
            .setFlags(nvrhi::rt::GeometryFlags::Opaque));

        App* a = app;
        blas->accelStruct = a->device()->createAccelStruct(blas->desc);
        if (!blas->accelStruct)
            return nullptr;
        nvrhi::utils::BuildBottomLevelAccelStruct(commandList, blas->accelStruct, blas->desc);
        return a->OwnObject(blas);
    }

    // Updates an updatable Donut_CreateTriangleBlas BLAS in place from its buffers' current
    // contents (the vertices may move, the counts stay), into an open command list.
    void Donut_UpdateTriangleBlas(TriangleBlas* triangleBlas, nvrhi::ICommandList* commandList)
    {
        auto* blas = triangleBlas;
        const nvrhi::rt::GeometryDesc& geometry = blas->desc.bottomLevelGeometries[0];
        commandList->buildBottomLevelAccelStruct(blas->accelStruct, &geometry, 1,
            blas->desc.buildFlags | nvrhi::rt::AccelStructBuildFlags::PerformUpdate);
    }

    // A bottom-level acceleration structure of several geometries, built up with
    // Donut_AddTriangleBlasGeometry and then built with Donut_BuildTriangleBlas.
    TriangleBlas* Donut_CreateEmptyTriangleBlas(App* app, const char* debugName)
    {
        auto blas = std::make_shared<TriangleBlas>();
        blas->desc.isTopLevel = false;
        blas->desc.debugName = debugName;
        return app->OwnObject(blas);
    }

    // Adds opaque triangles to an unbuilt BLAS: indexCount R32_UINT indices at indexByteOffset of
    // indexBuffer, vertexCount RGB32_FLOAT positions vertexStride bytes apart at vertexByteOffset of
    // vertexBuffer (both created for acceleration structure builds), with transform (12 floats, 3
    // rows of 4: a VkTransformMatrixKHR) applied to the positions, or none (null).
    void Donut_AddTriangleBlasGeometry(TriangleBlas* triangleBlas, nvrhi::IBuffer* indexBuffer, int indexByteOffset, int indexCount,
        nvrhi::IBuffer* vertexBuffer, int vertexByteOffset, int vertexCount, int vertexStride, const float* transform)
    {
        auto triangles = nvrhi::rt::GeometryTriangles()
            .setIndexBuffer(indexBuffer)
            .setIndexOffset(static_cast<uint64_t>(indexByteOffset))
            .setIndexFormat(nvrhi::Format::R32_UINT)
            .setIndexCount(static_cast<uint32_t>(indexCount))
            .setVertexBuffer(vertexBuffer)
            .setVertexOffset(static_cast<uint64_t>(vertexByteOffset))
            .setVertexFormat(nvrhi::Format::RGB32_FLOAT)
            .setVertexStride(static_cast<uint32_t>(vertexStride))
            .setVertexCount(static_cast<uint32_t>(vertexCount));
        auto geometry = nvrhi::rt::GeometryDesc()
            .setTriangles(triangles)
            .setFlags(nvrhi::rt::GeometryFlags::Opaque);
        if (transform)
        {
            nvrhi::rt::AffineTransform affine;
            memcpy(affine, transform, sizeof(affine));
            geometry.setTransform(affine);
        }
        triangleBlas->desc.addBottomLevelGeometry(geometry);
    }

    // Adds opaque procedural primitives to an unbuilt BLAS instead: aabbCount boxes
    // (nvrhi::rt::GeometryAABB: min x y z, max x y z) aabbStride bytes apart from byteOffset of
    // aabbBuffer (created for acceleration structure builds). A BLAS holds triangles or AABBs, not
    // both.
    void Donut_AddTriangleBlasAabbGeometry(TriangleBlas* triangleBlas, nvrhi::IBuffer* aabbBuffer, int byteOffset, int aabbCount,
        int aabbStride)
    {
        auto aabbs = nvrhi::rt::GeometryAABBs()
            .setBuffer(aabbBuffer)
            .setOffset(static_cast<uint64_t>(byteOffset))
            .setCount(static_cast<uint32_t>(aabbCount))
            .setStride(static_cast<uint32_t>(aabbStride));
        triangleBlas->desc.addBottomLevelGeometry(nvrhi::rt::GeometryDesc()
            .setAABBs(aabbs)
            .setFlags(nvrhi::rt::GeometryFlags::Opaque));
    }

    // An unbuilt BLAS's geometryIndex-th geometry's nvrhi::rt::GeometryFlags (1 opaque, the default;
    // 0 for any-hit shaders to run; 2 no duplicate any-hit invocations).
    void Donut_SetTriangleBlasGeometryFlags(TriangleBlas* triangleBlas, int geometryIndex, int flags)
    {
        auto& geometries = triangleBlas->desc.bottomLevelGeometries;
        if (geometryIndex < 0 || size_t(geometryIndex) >= geometries.size())
            return;
        geometries[geometryIndex].setFlags(static_cast<nvrhi::rt::GeometryFlags>(flags));
    }

    // Links an unbuilt BLAS's geometryIndex-th (triangle) geometry to an opacity micromap array
    // (Donut_CreateOpacityMicromap): an OMM index per triangle, ommIndexFormat (R16_UINT or
    // R32_UINT) values at ommIndexOffset of ommIndexBuffer (an acceleration structure input
    // buffer); usageCounts (Ref of an int array) holds numUsageCounts entries of three ints, how
    // many triangles use OMMs of a subdivision level and format (Donut_CountOpacityMicromapUsage).
    // The BLAS keeps the array alive.
    void Donut_SetTriangleBlasGeometryOpacityMicromap(TriangleBlas* triangleBlas, int geometryIndex, nvrhi::rt::IOpacityMicromap* opacityMicromap,
        nvrhi::IBuffer* ommIndexBuffer, int ommIndexOffset, int ommIndexFormat, const int* usageCounts, int numUsageCounts)
    {
        auto* blas = triangleBlas;
        auto& geometries = blas->desc.bottomLevelGeometries;
        if (geometryIndex < 0 || size_t(geometryIndex) >= geometries.size()
            || geometries[geometryIndex].geometryType != nvrhi::rt::GeometryType::Triangles)
            return;

        auto counts = std::make_unique<std::vector<nvrhi::rt::OpacityMicromapUsageCount>>();
        for (int i = 0; i < numUsageCounts; i++)
        {
            nvrhi::rt::OpacityMicromapUsageCount count{};
            count.count = uint32_t(usageCounts[i * 3]);
            count.subdivisionLevel = uint32_t(usageCounts[i * 3 + 1]);
            count.format = static_cast<nvrhi::rt::OpacityMicromapFormat>(usageCounts[i * 3 + 2]);
            counts->push_back(count);
        }

        auto* omm = opacityMicromap;
        geometries[geometryIndex].geometryData.triangles
            .setOpacityMicromap(omm)
            .setOmmIndexBuffer(ommIndexBuffer)
            .setOmmIndexBufferOffset(uint64_t(ommIndexOffset))
            .setOmmIndexFormat(static_cast<nvrhi::Format>(ommIndexFormat))
            .setPOmmUsageCounts(counts->data())
            .setNumOmmUsageCounts(uint32_t(counts->size()));
        blas->opacityMicromaps.push_back(omm);
        blas->ommUsageCounts.push_back(std::move(counts));
    }

    // An opacity micromap array (requires Feature.RayTracingOpacityMicromap), built into an open
    // command list from inputBuffer's raw OMM data at inputOffset and perOmmDescs' descs at
    // descsOffset (both acceleration structure input buffers; the descs as
    // Donut_CountOpacityMicromapUsage reads them); usageCounts (Ref of an int array) holds
    // numUsageCounts entries of three ints, how many OMMs the array has of a subdivision level and
    // format (D3D12's histogram). buildFlags: nvrhi::rt::OpacityMicromapBuildFlags bits (1 fast
    // trace, 2 fast build). Returns null on failure.
    nvrhi::rt::IOpacityMicromap* Donut_CreateOpacityMicromap(App* app, nvrhi::ICommandList* commandList, nvrhi::IBuffer* inputBuffer, int inputOffset,
        nvrhi::IBuffer* perOmmDescs, int descsOffset, const int* usageCounts, int numUsageCounts, int buildFlags,
        const char* debugName)
    {
        nvrhi::rt::OpacityMicromapDesc desc;
        desc.setDebugName(debugName)
            .setFlags(static_cast<nvrhi::rt::OpacityMicromapBuildFlags>(buildFlags))
            .setInputBuffer(inputBuffer)
            .setInputBufferOffset(uint64_t(inputOffset))
            .setPerOmmDescs(perOmmDescs)
            .setPerOmmDescsOffset(uint64_t(descsOffset));
        for (int i = 0; i < numUsageCounts; i++)
        {
            nvrhi::rt::OpacityMicromapUsageCount count{};
            count.count = uint32_t(usageCounts[i * 3]);
            count.subdivisionLevel = uint32_t(usageCounts[i * 3 + 1]);
            count.format = static_cast<nvrhi::rt::OpacityMicromapFormat>(usageCounts[i * 3 + 2]);
            desc.counts.push_back(count);
        }

        App* a = app;
        nvrhi::rt::OpacityMicromapHandle omm = a->device()->createOpacityMicromap(desc);
        if (!omm)
            return nullptr;
        commandList->buildOpacityMicromap(omm, desc);
        return a->Own(omm);
    }

    // Builds a Donut_CreateOpacityMicromap array again, in place, from its inputs' current contents,
    // into an open command list.
    void Donut_BuildOpacityMicromap(nvrhi::ICommandList* commandList, nvrhi::rt::IOpacityMicromap* opacityMicromap)
    {
        auto* omm = opacityMicromap;
        commandList->buildOpacityMicromap(omm, omm->getDesc());
    }

    // Creates the BLAS of the geometries added (AccelStructBuildFlags bits: e.g. PreferFastTrace,
    // AllowDataAccess for hit shaders to read its vertex positions) and records its build into an
    // open command list. Returns 0 on failure.
    int Donut_BuildTriangleBlas(TriangleBlas* triangleBlas, App* app, nvrhi::ICommandList* commandList, int buildFlags)
    {
        auto* blas = triangleBlas;
        blas->desc.buildFlags = static_cast<nvrhi::rt::AccelStructBuildFlags>(buildFlags);
        blas->accelStruct = app->device()->createAccelStruct(blas->desc);
        if (!blas->accelStruct)
            return 0;
        nvrhi::utils::BuildBottomLevelAccelStruct(commandList, blas->accelStruct, blas->desc);
        return 1;
    }

    // Builds a Donut_BuildTriangleBlas BLAS again, in place (not an update), from its geometries'
    // current contents, into an open command list.
    void Donut_RebuildTriangleBlas(TriangleBlas* triangleBlas, nvrhi::ICommandList* commandList)
    {
        auto* blas = triangleBlas;
        if (blas->accelStruct)
            nvrhi::utils::BuildBottomLevelAccelStruct(commandList, blas->accelStruct, blas->desc);
    }

    // For Donut_AddTopLevelASInstanceWithTransform; valid as long as the BLAS.
    nvrhi::rt::IAccelStruct* Donut_GetTriangleBlasAccelStruct(TriangleBlas* triangleBlas)
    {
        return triangleBlas->accelStruct.Get();
    }

    // Creates a bottom-level acceleration structure of opaque triangles (R32_UINT indices,
    // RGB32_FLOAT vertices) and records its build into an open command list.
    nvrhi::rt::IAccelStruct* Donut_BuildTriangleBLAS(App* app, nvrhi::ICommandList* commandList, nvrhi::IBuffer* indexBuffer, int indexCount,
        nvrhi::IBuffer* vertexBuffer, int vertexCount)
    {
        nvrhi::rt::GeometryDesc geometry;
        auto& triangles = geometry.geometryData.triangles;
        triangles.indexBuffer = indexBuffer;
        triangles.vertexBuffer = vertexBuffer;
        triangles.indexFormat = nvrhi::Format::R32_UINT;
        triangles.indexCount = static_cast<uint32_t>(indexCount);
        triangles.vertexFormat = nvrhi::Format::RGB32_FLOAT;
        triangles.vertexStride = sizeof(float) * 3;
        triangles.vertexCount = static_cast<uint32_t>(vertexCount);
        geometry.geometryType = nvrhi::rt::GeometryType::Triangles;
        geometry.flags = nvrhi::rt::GeometryFlags::Opaque;

        nvrhi::rt::AccelStructDesc desc;
        desc.isTopLevel = false;
        desc.bottomLevelGeometries.push_back(geometry);

        App* a = app;
        nvrhi::rt::AccelStructHandle blas = a->device()->createAccelStruct(desc);
        if (!blas)
            return nullptr;
        nvrhi::utils::BuildBottomLevelAccelStruct(commandList, blas, desc);
        return a->Own(blas);
    }

    // Creates a top-level acceleration structure holding one instance of bottomLevelAS (identity
    // transform, mask 1, counter-clockwise front faces) and records its build into an open
    // command list.
    nvrhi::rt::IAccelStruct* Donut_BuildSingleInstanceTLAS(App* app, nvrhi::ICommandList* commandList, nvrhi::rt::IAccelStruct* bottomLevelAS)
    {
        nvrhi::rt::AccelStructDesc desc;
        desc.isTopLevel = true;
        desc.topLevelMaxInstances = 1;

        App* a = app;
        nvrhi::rt::AccelStructHandle tlas = a->device()->createAccelStruct(desc);
        if (!tlas)
            return nullptr;

        nvrhi::rt::InstanceDesc instance;
        instance.bottomLevelAS = bottomLevelAS;
        instance.instanceMask = 1;
        instance.flags = nvrhi::rt::InstanceFlags::TriangleFrontCounterclockwise;
        const float identity[12] = { 1, 0, 0, 0,   0, 1, 0, 0,   0, 0, 1, 0 };
        memcpy(instance.transform, identity, sizeof(identity));

        commandList->buildTopLevelAccelStruct(tlas, &instance, 1);
        return a->Own(tlas);
    }

    // RGBA8_UNORM texture of the frame's size that shaders write as RWTexture2D<float4>; show
    // it with Donut_BlitTexture. Returns null on failure.
    nvrhi::ITexture* Donut_CreateUAVTextureForFrameWithFormat(App* app, FrameContext* frame, const char* debugName, int format);

    nvrhi::ITexture* Donut_CreateUAVTextureForFrame(App* app, FrameContext* frame, const char* debugName)
    {
        return Donut_CreateUAVTextureForFrameWithFormat(app, frame, debugName, static_cast<int>(nvrhi::Format::RGBA8_UNORM));
    }

    // Same, in `format` (an nvrhi::Format value).
    nvrhi::ITexture* Donut_CreateUAVTextureForFrameWithFormat(App* app, FrameContext* frame, const char* debugName, int format)
    {
        nvrhi::TextureDesc desc = frame->framebuffer->getDesc().colorAttachments[0].texture->getDesc();
        desc.isUAV = true;
        desc.isRenderTarget = false;
        desc.initialState = nvrhi::ResourceStates::UnorderedAccess;
        desc.keepInitialState = true;
        desc.format = static_cast<nvrhi::Format>(format);
        desc.debugName = debugName;

        App* a = app;
        return a->Own(a->device()->createTexture(desc));
    }

    // Same, in the back buffer's format without sRGB (RGBA8_UNORM with D3D12, BGRA8_UNORM with
    // Vulkan): Donut_CopyTextureToFrame copies it to the back buffer bit for bit.
    nvrhi::ITexture* Donut_CreateUAVTextureForFrameCopy(App* app, FrameContext* frame, const char* debugName)
    {
        nvrhi::Format format = frame->framebuffer->getDesc().colorAttachments[0].texture->getDesc().format;
        if (format == nvrhi::Format::SRGBA8_UNORM)
            format = nvrhi::Format::RGBA8_UNORM;
        else if (format == nvrhi::Format::SBGRA8_UNORM)
            format = nvrhi::Format::BGRA8_UNORM;
        return Donut_CreateUAVTextureForFrameWithFormat(app, frame, debugName, static_cast<int>(format));
    }

    // Triangle-list pipeline without depth test, for the frame's framebuffer layout; recreate it
    // after the back buffer is resized. Returns null on failure.
    nvrhi::IGraphicsPipeline* Donut_CreateGraphicsPipeline(App* app, FrameContext* frame, nvrhi::IShader* vertexShader, nvrhi::IShader* pixelShader)
    {
        nvrhi::GraphicsPipelineDesc desc;
        desc.VS = vertexShader;
        desc.PS = pixelShader;
        desc.primType = nvrhi::PrimitiveType::TriangleList;
        desc.renderState.depthStencilState.depthTestEnable = false;

        App* a = app;
        nvrhi::GraphicsPipelineHandle pipeline = a->device()->createGraphicsPipeline(
            desc, frame->framebuffer->getFramebufferInfo());
        return a->Own(pipeline);
    }

    // Specializes one constant ([[vk::constant_id(constantId)]] in HLSL) of a SPIR-V shader;
    // requires nvrhi::Feature::ShaderSpecializations (Vulkan only). Returns null on failure.
    nvrhi::IShader* Donut_SpecializeShaderFloat(App* app, nvrhi::IShader* shader, int constantId, double value)
    {
        const nvrhi::ShaderSpecialization constant =
            nvrhi::ShaderSpecialization::Float(static_cast<uint32_t>(constantId), float(value));
        App* a = app;
        nvrhi::ShaderHandle specialized = a->device()->createShaderSpecialization(
            shader, &constant, 1);
        return a->Own(specialized);
    }

    // As above, for a uint constant; value's bits are used as-is.
    nvrhi::IShader* Donut_SpecializeShaderUInt(App* app, nvrhi::IShader* shader, int constantId, int value)
    {
        const nvrhi::ShaderSpecialization constant =
            nvrhi::ShaderSpecialization::UInt32(static_cast<uint32_t>(constantId), static_cast<uint32_t>(value));
        App* a = app;
        nvrhi::ShaderHandle specialized = a->device()->createShaderSpecialization(
            shader, &constant, 1);
        return a->Own(specialized);
    }

    // Amplification + mesh + pixel shader pipeline (triangle list, no depth test) for the frame's
    // framebuffer layout; recreate it after the back buffer is resized. Requires
    // nvrhi::Feature::Meshlets. Returns null on failure.
    nvrhi::IMeshletPipeline* Donut_CreateMeshletPipeline(App* app, FrameContext* frame, nvrhi::IShader* amplificationShader, nvrhi::IShader* meshShader, nvrhi::IShader* pixelShader)
    {
        nvrhi::MeshletPipelineDesc desc;
        desc.AS = amplificationShader;
        desc.MS = meshShader;
        desc.PS = pixelShader;
        desc.primType = nvrhi::PrimitiveType::TriangleList;
        desc.renderState.depthStencilState.depthTestEnable = false;

        App* a = app;
        nvrhi::MeshletPipelineHandle pipeline = a->device()->createMeshletPipeline(
            desc, frame->framebuffer->getFramebufferInfo());
        return a->Own(pipeline);
    }

    // Safe to call while the GPU may still use the resource: the command lists using it hold it
    // until the GPU has finished them (executed ones through the app, Donut_ExecuteCommandList).
    void Donut_ReleaseResource(App* app, nvrhi::IResource* resource)
    {
        app->resources.erase(resource);
    }

    // Typed buffer of elementCount R32_UINT values. writable != 0: a UAV the GPU writes to;
    // otherwise shader-readable only, filled with Donut_WriteBuffer. Returns null on failure.
    nvrhi::IBuffer* Donut_CreateUIntBuffer(App* app, int elementCount, int writable, const char* debugName)
    {
        auto desc = nvrhi::BufferDesc()
            .setByteSize(sizeof(uint32_t) * static_cast<uint64_t>(elementCount))
            .setCanHaveTypedViews(true)
            .setCanHaveUAVs(writable != 0)
            .setFormat(nvrhi::Format::R32_UINT)
            .setDebugName(debugName)
            .setInitialState(writable ? nvrhi::ResourceStates::UnorderedAccess : nvrhi::ResourceStates::CopyDest)
            .setKeepInitialState(true);

        App* a = app;
        return a->Own(a->device()->createBuffer(desc));
    }

    // CPU-readable buffer to copy GPU results into; read it with Donut_ReadBuffer. Returns null
    // on failure.
    nvrhi::IBuffer* Donut_CreateReadbackBuffer(App* app, int byteSize, const char* debugName)
    {
        auto desc = nvrhi::BufferDesc()
            .setByteSize(static_cast<uint64_t>(byteSize))
            .setCpuAccess(nvrhi::CpuAccessMode::Read)
            .setDebugName(debugName)
            .setInitialState(nvrhi::ResourceStates::CopyDest)
            .setKeepInitialState(true);

        App* a = app;
        return a->Own(a->device()->createBuffer(desc));
    }

    // Copies byteSize bytes of a readback buffer to dst, after the GPU work writing it has
    // finished (see Donut_WaitForIdle). Returns 0 if the buffer can't be mapped.
    int Donut_ReadBuffer(App* app, nvrhi::IBuffer* readbackBuffer, void* dst, int byteSize)
    {
        nvrhi::IDevice* device = app->device();
        const void* data = device->mapBuffer(readbackBuffer, nvrhi::CpuAccessMode::Read);
        if (!data)
            return 0;
        memcpy(dst, data, static_cast<size_t>(byteSize));
        device->unmapBuffer(readbackBuffer);
        return 1;
    }

    // Copies a level of a texture to dst (at most byteSize bytes), its rows (of 4 x 4 blocks for
    // block-compressed formats) packed, through a staging texture and a command list of its own
    // that it waits for: call it while no other immediate command list is open. Not for the
    // texture cache's textures (permanently shader resources). Returns the bytes copied, 0 on
    // failure.
    int Donut_ReadTextureLevel(App* app, nvrhi::ITexture* texture, int mipLevel, void* dst, int byteSize)
    {
        nvrhi::IDevice* device = app->device();
        auto* source = texture;
        const nvrhi::TextureDesc& sourceDesc = source->getDesc();

        const nvrhi::FormatInfo& info = nvrhi::getFormatInfo(sourceDesc.format);
        const uint32_t blockSize = std::max<uint32_t>(info.blockSize, 1);
        const uint32_t levelWidth = std::max(sourceDesc.width >> mipLevel, 1u);
        const uint32_t levelHeight = std::max(sourceDesc.height >> mipLevel, 1u);

        // A staging texture of the whole texture, the level copied into the same level: D3D12 and
        // D3D11 can't describe a block-compressed texture smaller than a block (2x2, 1x1) on its own.
        nvrhi::TextureDesc stagingDesc = sourceDesc;
        stagingDesc.isRenderTarget = false;
        stagingDesc.isUAV = false;
        stagingDesc.isTypeless = false;
        stagingDesc.initialState = nvrhi::ResourceStates::CopyDest;
        stagingDesc.keepInitialState = true;
        stagingDesc.debugName = "ReadTextureLevel";
        nvrhi::StagingTextureHandle staging = device->createStagingTexture(stagingDesc, nvrhi::CpuAccessMode::Read);
        if (!staging)
            return 0;

        nvrhi::TextureSlice slice;
        slice.mipLevel = static_cast<uint32_t>(mipLevel);
        // D3D copies block-compressed levels in whole blocks (a 2x2 box of a 2x2 level removed the
        // D3D12 device, and copied nothing on D3D11); Vulkan wants the level's own size.
        if (device->getGraphicsAPI() != nvrhi::GraphicsAPI::VULKAN)
        {
            slice.width = (levelWidth + blockSize - 1) / blockSize * blockSize;
            slice.height = (levelHeight + blockSize - 1) / blockSize * blockSize;
        }
        nvrhi::CommandListHandle commandList = device->createCommandList();
        commandList->open();
        commandList->copyTexture(staging, slice, source, slice);
        commandList->close();
        device->executeCommandList(commandList);
        device->waitForIdle();

        size_t rowPitch = 0;
        const auto* data = static_cast<const uint8_t*>(device->mapStagingTexture(staging, slice,
            nvrhi::CpuAccessMode::Read, &rowPitch));
        if (!data)
            return 0;

        // Rows of texels, or of blocks.
        const uint32_t rows = (levelHeight + blockSize - 1) / blockSize;
        const size_t rowBytes = size_t((levelWidth + blockSize - 1) / blockSize) * info.bytesPerBlock;
        size_t copied = 0;
        for (uint32_t row = 0; row < rows && copied + rowBytes <= size_t(byteSize); ++row)
        {
            memcpy(static_cast<uint8_t*>(dst) + copied, data + row * rowPitch, rowBytes);
            copied += rowBytes;
        }
        device->unmapStagingTexture(staging);
        return static_cast<int>(copied);
    }

    // Binding set descriptions are built up with the Donut_Bind* functions below and then
    // consumed (freed) by Donut_CreateBindingSet.
    nvrhi::BindingSetDesc* Donut_CreateBindingSetDesc()
    {
        return new nvrhi::BindingSetDesc();
    }

    // Buffer created by Donut_CreateUIntBuffer, read by the shader as Buffer<uint> at t<slot>.
    void Donut_BindTypedBufferSRV(nvrhi::BindingSetDesc* bindingSetDesc, int slot, nvrhi::IBuffer* buffer)
    {
        bindingSetDesc->addItem(
            nvrhi::BindingSetItem::TypedBuffer_SRV(static_cast<uint32_t>(slot), buffer));
    }

    // Writable buffer created by Donut_CreateUIntBuffer, written by the shader as RWBuffer<uint>
    // at u<slot>.
    void Donut_BindTypedBufferUAV(nvrhi::BindingSetDesc* bindingSetDesc, int slot, nvrhi::IBuffer* buffer)
    {
        bindingSetDesc->addItem(
            nvrhi::BindingSetItem::TypedBuffer_UAV(static_cast<uint32_t>(slot), buffer));
    }

    // Creates a binding set, and a matching layout (in register space 0) visible to the stages
    // in shaderType (nvrhi::ShaderType bits), from a description, which it frees. Returns null
    // on failure.
    nvrhi::IBindingSet* Donut_CreateBindingSet(App* app, nvrhi::BindingSetDesc* bindingSetDesc, int shaderType)
    {
        std::unique_ptr<nvrhi::BindingSetDesc> desc(bindingSetDesc);

        nvrhi::BindingLayoutHandle layout;
        nvrhi::BindingSetHandle bindingSet;
        App* a = app;
        if (!nvrhi::utils::CreateBindingSetAndLayout(a->device(), static_cast<nvrhi::ShaderType>(shaderType),
                0, *desc, layout, bindingSet))
            return nullptr;

        // The binding set keeps its layout alive; pipelines get it from the set.
        return a->Own(bindingSet);
    }

    // Texture created by Donut_CreateUAVTextureForFrame, written by the shader as
    // RWTexture2D<float4> at u<slot>.
    void Donut_BindTextureUAV(nvrhi::BindingSetDesc* bindingSetDesc, int slot, nvrhi::ITexture* texture)
    {
        bindingSetDesc->addItem(
            nvrhi::BindingSetItem::Texture_UAV(static_cast<uint32_t>(slot), texture));
    }

    // Top-level acceleration structure, read by the shader as RaytracingAccelerationStructure
    // at t<slot>.
    void Donut_BindAccelStruct(nvrhi::BindingSetDesc* bindingSetDesc, int slot, nvrhi::rt::IAccelStruct* accelStruct)
    {
        bindingSetDesc->addItem(
            nvrhi::BindingSetItem::RayTracingAccelStruct(static_cast<uint32_t>(slot),
                accelStruct));
    }

    // Creates a binding set for an existing layout (see Donut_CreateBindingLayout) from a
    // description, which it frees. Returns null on failure.
    nvrhi::IBindingSet* Donut_CreateBindingSetForLayout(App* app, nvrhi::BindingSetDesc* bindingSetDesc, nvrhi::IBindingLayout* bindingLayout)
    {
        std::unique_ptr<nvrhi::BindingSetDesc> desc(bindingSetDesc);
        App* a = app;
        return a->Own(a->device()->createBindingSet(*desc, bindingLayout));
    }

    // Binding layout descriptions, for when the layout is needed before the resources exist
    // (e.g. to create a pipeline); built up with the Donut_Layout* functions below, then
    // consumed (freed) by Donut_CreateBindingLayout.
    nvrhi::BindingLayoutDesc* Donut_CreateBindingLayoutDesc()
    {
        return new nvrhi::BindingLayoutDesc();
    }

    void Donut_LayoutTextureUAV(nvrhi::BindingLayoutDesc* bindingLayoutDesc, int slot)
    {
        bindingLayoutDesc->addItem(
            nvrhi::BindingLayoutItem::Texture_UAV(static_cast<uint32_t>(slot)));
    }

    void Donut_LayoutAccelStruct(nvrhi::BindingLayoutDesc* bindingLayoutDesc, int slot)
    {
        bindingLayoutDesc->addItem(
            nvrhi::BindingLayoutItem::RayTracingAccelStruct(static_cast<uint32_t>(slot)));
    }

    void Donut_LayoutTextureSRV(nvrhi::BindingLayoutDesc* bindingLayoutDesc, int slot)
    {
        bindingLayoutDesc->addItem(
            nvrhi::BindingLayoutItem::Texture_SRV(static_cast<uint32_t>(slot)));
    }

    void Donut_LayoutStructuredBufferSRV(nvrhi::BindingLayoutDesc* bindingLayoutDesc, int slot)
    {
        bindingLayoutDesc->addItem(
            nvrhi::BindingLayoutItem::StructuredBuffer_SRV(static_cast<uint32_t>(slot)));
    }

    void Donut_LayoutSampler(nvrhi::BindingLayoutDesc* bindingLayoutDesc, int slot)
    {
        bindingLayoutDesc->addItem(
            nvrhi::BindingLayoutItem::Sampler(static_cast<uint32_t>(slot)));
    }

    // byteSize bytes of push constants (DECLARE_PUSH_CONSTANTS in HLSL) at b<slot>.
    void Donut_LayoutPushConstants(nvrhi::BindingLayoutDesc* bindingLayoutDesc, int slot, int byteSize)
    {
        bindingLayoutDesc->addItem(
            nvrhi::BindingLayoutItem::PushConstants(static_cast<uint32_t>(slot), static_cast<uint32_t>(byteSize)));
    }

    // For a buffer from Donut_CreateVolatileConstantBuffer.
    void Donut_LayoutVolatileConstantBuffer(nvrhi::BindingLayoutDesc* bindingLayoutDesc, int slot)
    {
        bindingLayoutDesc->addItem(
            nvrhi::BindingLayoutItem::VolatileConstantBuffer(static_cast<uint32_t>(slot)));
    }

    // Register space of the layout's items (D3D12 only; 0 by default).
    void Donut_SetBindingLayoutRegisterSpace(nvrhi::BindingLayoutDesc* bindingLayoutDesc, int space)
    {
        bindingLayoutDesc->registerSpace = static_cast<uint32_t>(space);
    }

    // Buffer<T> at t<slot>.
    void Donut_LayoutTypedBufferSRV(nvrhi::BindingLayoutDesc* bindingLayoutDesc, int slot)
    {
        bindingLayoutDesc->addItem(
            nvrhi::BindingLayoutItem::TypedBuffer_SRV(static_cast<uint32_t>(slot)));
    }

    // A non-volatile cbuffer at b<slot>.
    void Donut_LayoutConstantBuffer(nvrhi::BindingLayoutDesc* bindingLayoutDesc, int slot)
    {
        bindingLayoutDesc->addItem(
            nvrhi::BindingLayoutItem::ConstantBuffer(static_cast<uint32_t>(slot)));
    }

    // RWStructuredBuffer at u<slot>.
    void Donut_LayoutStructuredBufferUAV(nvrhi::BindingLayoutDesc* bindingLayoutDesc, int slot)
    {
        bindingLayoutDesc->addItem(
            nvrhi::BindingLayoutItem::StructuredBuffer_UAV(static_cast<uint32_t>(slot)));
    }

    // ByteAddressBuffer at t<slot>.
    void Donut_LayoutRawBufferSRV(nvrhi::BindingLayoutDesc* bindingLayoutDesc, int slot)
    {
        bindingLayoutDesc->addItem(
            nvrhi::BindingLayoutItem::RawBuffer_SRV(static_cast<uint32_t>(slot)));
    }

    // RWByteAddressBuffer at u<slot>.
    void Donut_LayoutRawBufferUAV(nvrhi::BindingLayoutDesc* bindingLayoutDesc, int slot)
    {
        bindingLayoutDesc->addItem(
            nvrhi::BindingLayoutItem::RawBuffer_UAV(static_cast<uint32_t>(slot)));
    }

    // An array of `count` Texture2D at t<slot> (t<slot> .. t<slot + count - 1> on D3D12, one
    // binding on Vulkan); not on D3D11.
    void Donut_LayoutTextureSRVArray(nvrhi::BindingLayoutDesc* bindingLayoutDesc, int slot, int count)
    {
        bindingLayoutDesc->addItem(
            nvrhi::BindingLayoutItem::Texture_SRV(static_cast<uint32_t>(slot)).setSize(static_cast<uint32_t>(count)));
    }

    // Layout visible to the stages in shaderType (nvrhi::ShaderType bits), in register space 0
    // unless set with Donut_SetBindingLayoutRegisterSpace. Returns null on failure.
    nvrhi::IBindingLayout* Donut_CreateBindingLayout(App* app, nvrhi::BindingLayoutDesc* bindingLayoutDesc, int shaderType)
    {
        std::unique_ptr<nvrhi::BindingLayoutDesc> desc(bindingLayoutDesc);
        desc->visibility = static_cast<nvrhi::ShaderType>(shaderType);
        App* a = app;
        return a->Own(a->device()->createBindingLayout(*desc));
    }

    // Compute pipeline with one binding layout (Donut_CreateBindingLayout). Returns null on failure.
    nvrhi::IComputePipeline* Donut_CreateComputePipelineWithLayout(App* app, nvrhi::IShader* computeShader, nvrhi::IBindingLayout* bindingLayout)
    {
        auto desc = nvrhi::ComputePipelineDesc()
            .setComputeShader(computeShader)
            .addBindingLayout(bindingLayout);

        App* a = app;
        return a->Own(a->device()->createComputePipeline(desc));
    }

    // Same, with a second binding layout (e.g. a bindless layout; null for none).
    nvrhi::IComputePipeline* Donut_CreateComputePipelineWithLayouts(App* app, nvrhi::IShader* computeShader, nvrhi::IBindingLayout* bindingLayout, nvrhi::IBindingLayout* secondBindingLayout)
    {
        auto desc = nvrhi::ComputePipelineDesc()
            .setComputeShader(computeShader)
            .addBindingLayout(bindingLayout);
        if (secondBindingLayout)
            desc.addBindingLayout(secondBindingLayout);

        App* a = app;
        return a->Own(a->device()->createComputePipeline(desc));
    }

    // Compute pipeline using the layout of bindingSet. Returns null on failure.
    nvrhi::IComputePipeline* Donut_CreateComputePipeline(App* app, nvrhi::IShader* computeShader, nvrhi::IBindingSet* bindingSet)
    {
        auto desc = nvrhi::ComputePipelineDesc()
            .setComputeShader(computeShader)
            .addBindingLayout(bindingSet->getLayout());

        App* a = app;
        return a->Own(a->device()->createComputePipeline(desc));
    }

    // Constant buffer for cbuffers, written with Donut_WriteBuffer. Bind slices of it (offsets
    // and sizes in multiples of 256 bytes) with Donut_BindConstantBuffer. Returns null on failure.
    nvrhi::IBuffer* Donut_CreateConstantBuffer(App* app, int byteSize, const char* debugName)
    {
        auto desc = nvrhi::utils::CreateStaticConstantBufferDesc(static_cast<uint32_t>(byteSize), debugName)
            .setInitialState(nvrhi::ResourceStates::ConstantBuffer)
            .setKeepInitialState(true);

        App* a = app;
        return a->Own(a->device()->createBuffer(desc));
    }

    // Constant buffer rewritten (with Donut_WriteBuffer) every time it's used, up to
    // c_MaxRenderPassConstantBufferVersions times per frame; bind it with
    // Donut_BindEntireConstantBuffer and Donut_LayoutVolatileConstantBuffer. Returns null on failure.
    nvrhi::IBuffer* Donut_CreateVolatileConstantBuffer(App* app, int byteSize, const char* debugName)
    {
        App* a = app;
        return a->Own(a->device()->createBuffer(nvrhi::utils::CreateVolatileConstantBufferDesc(
            static_cast<uint32_t>(byteSize), debugName, donut::engine::c_MaxRenderPassConstantBufferVersions)));
    }

    // StructuredBuffer of `count` elements of `stride` bytes, for shaders to read (t registers),
    // filled with Donut_WriteBuffer. Returns null on failure.
    nvrhi::IBuffer* Donut_CreateStructuredBuffer(App* app, int stride, int count, const char* debugName)
    {
        auto desc = nvrhi::BufferDesc()
            .setByteSize(uint64_t(stride) * uint64_t(count))
            .setStructStride(static_cast<uint32_t>(stride))
            .setDebugName(debugName)
            .setInitialState(nvrhi::ResourceStates::ShaderResource)
            .setKeepInitialState(true);

        App* a = app;
        return a->Own(a->device()->createBuffer(desc));
    }

    // Same, that shaders can also write (RWStructuredBuffer, u registers).
    nvrhi::IBuffer* Donut_CreateRWStructuredBuffer(App* app, int stride, int count, const char* debugName)
    {
        auto desc = nvrhi::BufferDesc()
            .setByteSize(uint64_t(stride) * uint64_t(count))
            .setStructStride(static_cast<uint32_t>(stride))
            .setCanHaveUAVs(true)
            .setDebugName(debugName)
            .setInitialState(nvrhi::ResourceStates::UnorderedAccess)
            .setKeepInitialState(true);

        App* a = app;
        return a->Own(a->device()->createBuffer(desc));
    }

    // The arguments of `count` indexed indirect draws (nvrhi::DrawIndexedIndirectArguments, 20 bytes
    // each: index count, instance count, first index, vertex offset, first instance), filled with
    // Donut_WriteBuffer, that shaders can also write as a RWByteAddressBuffer (u registers).
    // Returns null on failure.
    nvrhi::IBuffer* Donut_CreateDrawIndexedIndirectBuffer(App* app, int count, const char* debugName)
    {
        auto desc = nvrhi::BufferDesc()
            .setByteSize(uint64_t(count) * sizeof(nvrhi::DrawIndexedIndirectArguments))
            .setIsDrawIndirectArgs(true)
            .setCanHaveUAVs(true)
            .setCanHaveRawViews(true)
            .setDebugName(debugName)
            .setInitialState(nvrhi::ResourceStates::IndirectArgument)
            .setKeepInitialState(true);

        App* a = app;
        return a->Own(a->device()->createBuffer(desc));
    }

    // Stores a buffer's GPU address (8 bytes; its device address on Vulkan) at dst, e.g. Ref of an
    // f32 array element, for shaders that write it through the address. 0 if it has none.
    void Donut_StoreBufferDeviceAddress(void* dst, nvrhi::IBuffer* buffer)
    {
        const uint64_t address = buffer->getGpuVirtualAddress();
        memcpy(dst, &address, sizeof(address));
    }

    // Before a dispatch whose shaders write a buffer through its device address, which NVRHI can't
    // see: marks the buffer as written by shaders (unordered access), so that its next use waits
    // for the writes, and the writes for its previous use.
    void Donut_SetBufferWrittenByShaders(nvrhi::ICommandList* commandList, nvrhi::IBuffer* buffer)
    {
        nvrhi::ICommandList* cl = commandList;
        cl->setBufferState(buffer, nvrhi::ResourceStates::UnorderedAccess);
        cl->commitBarriers();
    }

    // Stores an int's bits at dst (e.g. Ref of an f32 array element), for int / uint fields of
    // structures that TypeScript lays out as f32 arrays.
    void Donut_StoreInt32(void* dst, int value)
    {
        memcpy(dst, &value, sizeof(value));
    }

    // Vertex buffer with byteSize bytes of data (copied during the call), uploaded by an open
    // command list; the contents can't change afterwards. Returns null on failure.
    nvrhi::IBuffer* Donut_CreateStaticVertexBuffer(App* app, nvrhi::ICommandList* commandList, const void* data, int byteSize, const char* debugName)
    {
        return CreateStaticBuffer(app, commandList,
            nvrhi::BufferDesc().setIsVertexBuffer(true).setDebugName(debugName),
            nvrhi::ResourceStates::VertexBuffer, data, byteSize);
    }

    // A vertex buffer of byteSize bytes to write (Donut_WriteBuffer) as often as needed, e.g. per
    // frame. Returns null on failure.
    nvrhi::IBuffer* Donut_CreateDynamicVertexBuffer(App* app, int byteSize, const char* debugName)
    {
        auto desc = nvrhi::BufferDesc()
            .setByteSize(static_cast<uint64_t>(byteSize))
            .setIsVertexBuffer(true)
            .setInitialState(nvrhi::ResourceStates::VertexBuffer)
            .setKeepInitialState(true)
            .setDebugName(debugName);
        App* a = app;
        return a->Own(a->device()->createBuffer(desc));
    }

    // Same, that shaders can also read as a ByteAddressBuffer (t registers).
    nvrhi::IBuffer* Donut_CreateStaticRawVertexBuffer(App* app, nvrhi::ICommandList* commandList, const void* data, int byteSize, const char* debugName)
    {
        return CreateStaticBuffer(app, commandList,
            nvrhi::BufferDesc().setIsVertexBuffer(true).setCanHaveRawViews(true).setDebugName(debugName),
            nvrhi::ResourceStates::VertexBuffer | nvrhi::ResourceStates::ShaderResource, data, byteSize);
    }

    // A static vertex buffer (or index buffer if isIndexBuffer != 0) that shaders also read as a
    // ByteAddressBuffer and acceleration structure builds take as input: one copy of a mesh for
    // rasterization and ray tracing.
    nvrhi::IBuffer* Donut_CreateStaticGeometryBuffer(App* app, nvrhi::ICommandList* commandList, const void* data, int byteSize, int isIndexBuffer,
        const char* debugName)
    {
        auto desc = nvrhi::BufferDesc().setCanHaveRawViews(true).setIsAccelStructBuildInput(true).setDebugName(debugName);
        if (isIndexBuffer)
            desc.setIsIndexBuffer(true);
        else
            desc.setIsVertexBuffer(true);
        const nvrhi::ResourceStates state = (isIndexBuffer ? nvrhi::ResourceStates::IndexBuffer : nvrhi::ResourceStates::VertexBuffer)
            | nvrhi::ResourceStates::ShaderResource | nvrhi::ResourceStates::AccelStructBuildInput;
        return CreateStaticBuffer(app, commandList, desc, state, data, byteSize);
    }

    // Same, for an index buffer.
    nvrhi::IBuffer* Donut_CreateStaticIndexBuffer(App* app, nvrhi::ICommandList* commandList, const void* data, int byteSize, const char* debugName)
    {
        return CreateStaticBuffer(app, commandList,
            nvrhi::BufferDesc().setIsIndexBuffer(true).setDebugName(debugName),
            nvrhi::ResourceStates::IndexBuffer, data, byteSize);
    }

    // The first primitive of a glTF file's first mesh (path relative to the executable's
    // directory), as the Vulkan-Samples framework's load_model reads it: positions, normals and
    // texture coordinates interleaved, 32-bit indices, the nodes' transforms ignored. Uploaded by
    // an open command list. Returns null (after logging why) on failure.
    void* Donut_LoadGltfMesh(App* app, nvrhi::ICommandList* commandList, const char* path)
    {
        GltfFile file;
        if (!file.Read(path))
            return nullptr;
        const std::string& fileNameString = file.fileName;

        std::vector<float> vertices;
        std::vector<uint32_t> indices;
        if (file.data->meshes_count == 0 || file.data->meshes[0].primitives_count == 0
            || !ReadGltfPrimitive(file.data->meshes[0].primitives[0], vertices, indices))
        {
            donut::log::error("Cannot load an indexed mesh from %s", fileNameString.c_str());
            return nullptr;
        }

        App* a = app;
        auto mesh = std::make_shared<GltfMesh>();
        mesh->vertexBuffer = CreateStaticBuffer(a, commandList,
            nvrhi::BufferDesc().setIsVertexBuffer(true).setDebugName(fileNameString + " vertices"),
            nvrhi::ResourceStates::VertexBuffer, vertices.data(), static_cast<int>(vertices.size() * sizeof(float)));
        mesh->indexBuffer = CreateStaticBuffer(a, commandList,
            nvrhi::BufferDesc().setIsIndexBuffer(true).setDebugName(fileNameString + " indices"),
            nvrhi::ResourceStates::IndexBuffer, indices.data(), static_cast<int>(indices.size() * sizeof(uint32_t)));
        mesh->indexCount = static_cast<int>(indices.size());
        if (!mesh->vertexBuffer || !mesh->indexBuffer)
        {
            donut::log::error("Cannot create the buffers of %s", fileNameString.c_str());
            return nullptr;
        }
        return a->OwnObject(mesh);
    }

    // Valid as long as the mesh.
    nvrhi::IBuffer* Donut_GetGltfMeshVertexBuffer(void* gltfMesh)
    {
        return static_cast<GltfMesh*>(gltfMesh)->vertexBuffer.Get();
    }

    nvrhi::IBuffer* Donut_GetGltfMeshIndexBuffer(void* gltfMesh)
    {
        return static_cast<GltfMesh*>(gltfMesh)->indexBuffer.Get();
    }

    int Donut_GetGltfMeshIndexCount(void* gltfMesh)
    {
        return static_cast<GltfMesh*>(gltfMesh)->indexCount;
    }

    // A file's bytes (Donut_LoadBinaryFile).
    struct BinaryFile
    {
        std::vector<uint8_t> bytes;
    };

    // A file read whole (path relative to the executable's directory), for TypeScript to parse
    // (Donut_CopyBinaryFileBytes). Returns null (after logging why) on failure.
    void* Donut_LoadBinaryFile(App* app, const char* path)
    {
        const std::filesystem::path filePath = GetExecutablePath().parent_path() / path;
        donut::vfs::NativeFileSystem fs;
        std::shared_ptr<donut::vfs::IBlob> blob = fs.readFile(filePath);
        if (!blob)
        {
            donut::log::error("Cannot read %s", filePath.generic_string().c_str());
            return nullptr;
        }
        auto file = std::make_shared<BinaryFile>();
        const auto* data = static_cast<const uint8_t*>(blob->data());
        file->bytes.assign(data, data + blob->size());
        return app->OwnObject(file);
    }

    // The file's bytes, valid as long as the file, e.g. for Donut_TranscodeKtx2.
    const void* Donut_GetBinaryFileData(void* binaryFile)
    {
        return static_cast<BinaryFile*>(binaryFile)->bytes.data();
    }

    int Donut_GetBinaryFileSize(void* binaryFile)
    {
        return static_cast<int>(static_cast<BinaryFile*>(binaryFile)->bytes.size());
    }

    // Bytes [offset, offset + count) into dst, one int (0..255) each, e.g. Ref of an int array
    // element; those past the end of the file as 0.
    void Donut_CopyBinaryFileBytes(void* binaryFile, int offset, int count, int* dst)
    {
        const std::vector<uint8_t>& bytes = static_cast<BinaryFile*>(binaryFile)->bytes;
        for (int i = 0; i < count; i++)
        {
            const size_t index = size_t(offset) + size_t(i);
            dst[i] = index < bytes.size() ? bytes[index] : 0;
        }
    }

    // count little-endian 32-bit values from byte offset into dst (Ref of an int array element),
    // as ints; those past the end of the file as 0.
    void Donut_CopyBinaryFileUInts(void* binaryFile, int offset, int count, int* dst)
    {
        const std::vector<uint8_t>& bytes = static_cast<BinaryFile*>(binaryFile)->bytes;
        for (int i = 0; i < count; i++)
        {
            const size_t index = size_t(offset) + size_t(i) * 4;
            uint32_t value = 0;
            if (index + 4 <= bytes.size())
                memcpy(&value, &bytes[index], 4);
            dst[i] = static_cast<int>(value);
        }
    }

    // byteSize bytes of the file from fileOffset into a buffer at bufferOffset, copied during the
    // call into an open command list (e.g. a model's vertices from the middle of its file).
    void Donut_WriteBufferFromBinaryFile(void* binaryFile, nvrhi::ICommandList* commandList, nvrhi::IBuffer* buffer, int bufferOffset,
        int fileOffset, int byteSize)
    {
        const std::vector<uint8_t>& bytes = static_cast<BinaryFile*>(binaryFile)->bytes;
        if (fileOffset < 0 || byteSize < 0 || size_t(fileOffset) + size_t(byteSize) > bytes.size())
        {
            donut::log::error("Donut_WriteBufferFromBinaryFile: bytes %d..%d are past the end of the file (%d bytes)",
                fileOffset, fileOffset + byteSize, int(bytes.size()));
            return;
        }
        commandList->writeBuffer(buffer, bytes.data() + fileOffset, size_t(byteSize),
            uint64_t(bufferOffset));
    }

    // The usage counts of an opacity micromap array by the triangles of a geometry
    // (Donut_SetTriangleBlasGeometryOpacityMicromap; Vulkan's BLAS builds need them): indexCount
    // OMM indices (indexFormat R16_UINT or R32_UINT; one per triangle, negative ones the special
    // fully opaque / transparent indices) at indexOffset of the file, indexing descCount per-OMM
    // descs (D3D12_RAYTRACING_OPACITY_MICROMAP_DESC, VkMicromapTriangleEXT: 32-bit data offset,
    // 16-bit subdivision level, 16-bit format) at descOffset. Writes up to maxEntries entries of
    // three ints (count, subdivision level, format) into dst; returns how many there are.
    int Donut_CountOpacityMicromapUsage(void* binaryFile, int indexOffset, int indexCount, int indexFormat,
        int descOffset, int descCount, int* dst, int maxEntries)
    {
        const std::vector<uint8_t>& bytes = static_cast<BinaryFile*>(binaryFile)->bytes;
        const bool index16 = static_cast<nvrhi::Format>(indexFormat) == nvrhi::Format::R16_UINT;
        const size_t indexSize = index16 ? 2 : 4;
        if (size_t(indexOffset) + size_t(indexCount) * indexSize > bytes.size()
            || size_t(descOffset) + size_t(descCount) * 8 > bytes.size())
        {
            donut::log::error("Donut_CountOpacityMicromapUsage: the indices or descs are past the end of the file");
            return 0;
        }
        std::map<std::pair<uint32_t, uint32_t>, uint32_t> counts;
        for (int i = 0; i < indexCount; i++)
        {
            int32_t index;
            if (index16)
            {
                int16_t value;
                memcpy(&value, &bytes[size_t(indexOffset) + size_t(i) * 2], 2);
                index = value;
            }
            else
            {
                memcpy(&index, &bytes[size_t(indexOffset) + size_t(i) * 4], 4);
            }
            if (index < 0 || index >= descCount)
                continue;
            uint16_t levelAndFormat[2];
            memcpy(levelAndFormat, &bytes[size_t(descOffset) + size_t(index) * 8 + 4], 4);
            counts[{ levelAndFormat[0], levelAndFormat[1] }]++;
        }
        int entries = 0;
        for (const auto& [key, count] : counts)
        {
            if (entries < maxEntries)
            {
                dst[entries * 3] = int(count);
                dst[entries * 3 + 1] = int(key.first);
                dst[entries * 3 + 2] = int(key.second);
            }
            entries++;
        }
        return entries;
    }

    // Writes byteSize bytes of data to a file (path as given: absolute, or relative to the current
    // directory). Returns 1 on success, 0 (after logging why) on failure.
    int Donut_WriteBinaryFile(const char* path, const void* data, int byteSize)
    {
        FILE* file = fopen(path, "wb");
        if (!file)
        {
            donut::log::error("Cannot write %s", path);
            return 0;
        }
        const size_t written = fwrite(data, 1, static_cast<size_t>(byteSize), file);
        fclose(file);
        return written == static_cast<size_t>(byteSize) ? 1 : 0;
    }

    // Every primitive of a glTF file's meshes (path relative to the executable's directory), in
    // mesh and primitive order, as the Vulkan-Samples framework's scene loader reads them into
    // submeshes: vertices as Donut_LoadGltfMesh's (in mesh space, the nodes' transforms
    // ignored), indices, and the base color image's URI. Kept on the CPU, to copy out with the
    // functions below. Returns null (after logging why) on failure.
    void* Donut_LoadGltfModel(App* app, const char* path)
    {
        GltfFile file;
        if (!file.Read(path))
            return nullptr;

        auto model = std::make_shared<GltfModel>();
        for (size_t m = 0; m < file.data->meshes_count; m++)
        {
            const cgltf_mesh& mesh = file.data->meshes[m];
            for (size_t p = 0; p < mesh.primitives_count; p++)
            {
                GltfModel::Primitive primitive;
                if (!ReadGltfPrimitive(mesh.primitives[p], primitive.vertices, primitive.indices, false))
                {
                    donut::log::error("Mesh %zu of %s has a primitive without positions", m, file.fileName.c_str());
                    return nullptr;
                }
                for (size_t a = 0; a < mesh.primitives[p].attributes_count; a++)
                {
                    const cgltf_attribute& attribute = mesh.primitives[p].attributes[a];
                    if (!attribute.name || !attribute.data)
                        continue;
                    GltfModel::Primitive::Attribute& dst = primitive.attributes[attribute.name];
                    dst.components = static_cast<int>(cgltf_num_components(attribute.data->type));
                    dst.data.resize(attribute.data->count * size_t(dst.components));
                    cgltf_accessor_unpack_floats(attribute.data, dst.data.data(), dst.data.size());
                }
                const cgltf_material* material = mesh.primitives[p].material;
                const cgltf_texture* texture = material ? material->pbr_metallic_roughness.base_color_texture.texture : nullptr;
                if (texture && texture->image && texture->image->uri)
                    primitive.baseColorImage = texture->image->uri;
                if (mesh.name)
                    primitive.meshName = mesh.name;
                if (material && material->has_pbr_metallic_roughness)
                {
                    memcpy(primitive.baseColorFactor, material->pbr_metallic_roughness.base_color_factor, sizeof(primitive.baseColorFactor));
                    primitive.metallicFactor = material->pbr_metallic_roughness.metallic_factor;
                    primitive.roughnessFactor = material->pbr_metallic_roughness.roughness_factor;
                }
                if (material)
                {
                    const cgltf_texture* textures[3] = { material->pbr_metallic_roughness.base_color_texture.texture,
                        material->normal_texture.texture, material->pbr_metallic_roughness.metallic_roughness_texture.texture };
                    for (int t = 0; t < 3; t++)
                        primitive.materialTextures[t] = textures[t] ? static_cast<int>(cgltf_texture_index(file.data, textures[t])) : -1;
                }
                primitive.mesh = static_cast<int>(m);
                if (material && material->alpha_mode == cgltf_alpha_mode_mask)
                    primitive.alphaMode = 1;
                else if (material && material->alpha_mode == cgltf_alpha_mode_blend)
                    primitive.alphaMode = 2;
                model->primitives.push_back(std::move(primitive));
            }
        }
        for (size_t t = 0; t < file.data->textures_count; t++)
        {
            const cgltf_texture& texture = file.data->textures[t];
            model->textureImages.push_back(texture.image && texture.image->uri ? texture.image->uri : "");
        }
        for (size_t n = 0; n < file.data->nodes_count; n++)
        {
            const cgltf_node& node = file.data->nodes[n];
            if (!node.mesh)
                continue;
            GltfModel::Node modelNode;
            modelNode.mesh = static_cast<int>(node.mesh - file.data->meshes);
            cgltf_node_transform_world(&node, modelNode.transform);
            model->nodes.push_back(modelNode);
        }
        return app->OwnObject(model);
    }

    int Donut_GetGltfModelPrimitiveCount(void* gltfModel)
    {
        return static_cast<int>(static_cast<GltfModel*>(gltfModel)->primitives.size());
    }

    int Donut_GetGltfModelVertexCount(void* gltfModel, int primitive)
    {
        return static_cast<int>(static_cast<GltfModel*>(gltfModel)->primitives[primitive].vertices.size() / 8);
    }

    int Donut_GetGltfModelIndexCount(void* gltfModel, int primitive)
    {
        return static_cast<int>(static_cast<GltfModel*>(gltfModel)->primitives[primitive].indices.size());
    }

    // The elements of a primitive's vertex attribute named `name` (as in the file: "COLOR_0",
    // "KHR_gaussian_splatting:ROTATION"...); 0 if it has none.
    int Donut_GetGltfModelAttributeCount(void* gltfModel, int primitive, const char* name)
    {
        const auto& attributes = static_cast<GltfModel*>(gltfModel)->primitives[primitive].attributes;
        auto it = attributes.find(name);
        return it == attributes.end() || it->second.components == 0 ? 0
            : static_cast<int>(it->second.data.size() / size_t(it->second.components));
    }

    // Its floats per element (1 for SCALAR, 3 for VEC3...); 0 if it has none.
    int Donut_GetGltfModelAttributeComponents(void* gltfModel, int primitive, const char* name)
    {
        const auto& attributes = static_cast<GltfModel*>(gltfModel)->primitives[primitive].attributes;
        auto it = attributes.find(name);
        return it == attributes.end() ? 0 : it->second.components;
    }

    // Its elements as floats (normalized integers converted) into dst, e.g. Ref of an f32 array
    // element: count * components of them.
    void Donut_CopyGltfModelAttribute(void* gltfModel, int primitive, const char* name, float* dst)
    {
        const auto& attributes = static_cast<GltfModel*>(gltfModel)->primitives[primitive].attributes;
        auto it = attributes.find(name);
        if (it != attributes.end())
            memcpy(dst, it->second.data.data(), it->second.data.size() * sizeof(float));
    }

    // A primitive's vertices (8 floats each) into dst, e.g. Ref of an f32 array element.
    void Donut_CopyGltfModelVertices(void* gltfModel, int primitive, void* dst)
    {
        const std::vector<float>& vertices = static_cast<GltfModel*>(gltfModel)->primitives[primitive].vertices;
        memcpy(dst, vertices.data(), vertices.size() * sizeof(float));
    }

    // A primitive's indices into dst, e.g. Ref of an int array element.
    void Donut_CopyGltfModelIndices(void* gltfModel, int primitive, void* dst)
    {
        const std::vector<uint32_t>& indices = static_cast<GltfModel*>(gltfModel)->primitives[primitive].indices;
        memcpy(dst, indices.data(), indices.size() * sizeof(uint32_t));
    }

    // Valid as long as the model.
    const char* Donut_GetGltfModelBaseColorImage(void* gltfModel, int primitive)
    {
        return static_cast<GltfModel*>(gltfModel)->primitives[primitive].baseColorImage.c_str();
    }

    // A primitive's material's base color factor (RGBA) into dst (Ref of a `let` f32 array of 4).
    void Donut_CopyGltfModelBaseColorFactor(void* gltfModel, int primitive, float* dst)
    {
        memcpy(dst, static_cast<GltfModel*>(gltfModel)->primitives[primitive].baseColorFactor, 4 * sizeof(float));
    }

    // The name of a primitive's mesh ("" if it has none); valid as long as the model.
    const char* Donut_GetGltfModelMeshName(void* gltfModel, int primitive)
    {
        return static_cast<GltfModel*>(gltfModel)->primitives[primitive].meshName.c_str();
    }

    // The index of a primitive's mesh.
    int Donut_GetGltfModelPrimitiveMesh(void* gltfModel, int primitive)
    {
        return static_cast<GltfModel*>(gltfModel)->primitives[primitive].mesh;
    }

    // The alpha mode of a primitive's material: 0 opaque (also without a material), 1 mask, 2 blend.
    int Donut_GetGltfModelPrimitiveAlphaMode(void* gltfModel, int primitive)
    {
        return static_cast<GltfModel*>(gltfModel)->primitives[primitive].alphaMode;
    }

    // The nodes that instantiate meshes, in node order.
    // A primitive's material's texture (0 base color, 1 normal, 2 metallic-roughness) as an index
    // into the file's textures; -1 if it has none.
    int Donut_GetGltfModelMaterialTexture(void* gltfModel, int primitive, int which)
    {
        return static_cast<GltfModel*>(gltfModel)->primitives[primitive].materialTextures[which];
    }

    // A primitive's material's metallic (which 0) or roughness (1) factor.
    double Donut_GetGltfModelMaterialFactor(void* gltfModel, int primitive, int which)
    {
        const GltfModel::Primitive& p = static_cast<GltfModel*>(gltfModel)->primitives[primitive];
        return which == 0 ? p.metallicFactor : p.roughnessFactor;
    }

    // The file's textures, and a texture's image URI ("" if none).
    int Donut_GetGltfModelTextureCount(void* gltfModel)
    {
        return static_cast<int>(static_cast<GltfModel*>(gltfModel)->textureImages.size());
    }

    const char* Donut_GetGltfModelTextureImage(void* gltfModel, int texture)
    {
        return static_cast<GltfModel*>(gltfModel)->textureImages[texture].c_str();
    }

    int Donut_GetGltfModelNodeCount(void* gltfModel)
    {
        return static_cast<int>(static_cast<GltfModel*>(gltfModel)->nodes.size());
    }

    // The index of a node's mesh.
    int Donut_GetGltfModelNodeMesh(void* gltfModel, int node)
    {
        return static_cast<GltfModel*>(gltfModel)->nodes[node].mesh;
    }

    // A node's world transform (16 floats, column-major as glm) into dst, e.g. Ref of an f32 array
    // element.
    void Donut_CopyGltfModelNodeTransform(void* gltfModel, int node, void* dst)
    {
        memcpy(dst, static_cast<GltfModel*>(gltfModel)->nodes[node].transform, sizeof(float) * 16);
    }

    // Input layout descriptions are built up with Donut_AddVertexAttribute and then consumed
    // (freed) by Donut_CreateInputLayout.
    InputLayoutDesc* Donut_CreateInputLayoutDesc()
    {
        return new std::vector<nvrhi::VertexAttributeDesc>();
    }

    // A vertex shader input with semantic `name`, read from vertex buffer slot bufferIndex at
    // byte offset `offset` of each elementStride-byte element. format is an nvrhi::Format value.
    void Donut_AddVertexAttribute(InputLayoutDesc* inputLayoutDesc, const char* name, int format, int offset, int bufferIndex, int elementStride)
    {
        inputLayoutDesc->push_back(nvrhi::VertexAttributeDesc()
            .setName(name)
            .setFormat(static_cast<nvrhi::Format>(format))
            .setOffset(static_cast<uint32_t>(offset))
            .setBufferIndex(static_cast<uint32_t>(bufferIndex))
            .setElementStride(static_cast<uint32_t>(elementStride)));
    }

    // Same, read once per instance instead of once per vertex.
    void Donut_AddInstanceVertexAttribute(InputLayoutDesc* inputLayoutDesc, const char* name, int format, int offset, int bufferIndex, int elementStride)
    {
        inputLayoutDesc->push_back(nvrhi::VertexAttributeDesc()
            .setName(name)
            .setFormat(static_cast<nvrhi::Format>(format))
            .setOffset(static_cast<uint32_t>(offset))
            .setBufferIndex(static_cast<uint32_t>(bufferIndex))
            .setElementStride(static_cast<uint32_t>(elementStride))
            .setIsInstanced(true));
    }

    // Returns null on failure.
    nvrhi::IInputLayout* Donut_CreateInputLayout(App* app, InputLayoutDesc* inputLayoutDesc, nvrhi::IShader* vertexShader)
    {
        std::unique_ptr<std::vector<nvrhi::VertexAttributeDesc>> attributes(
            inputLayoutDesc);
        App* a = app;
        return a->Own(a->device()->createInputLayout(attributes->data(), static_cast<uint32_t>(attributes->size()),
            vertexShader));
    }

    // Loads an image file (path relative to the executable's directory) and records its upload
    // into an open command list; sRGB != 0 treats the data as sRGB. Returns null (after logging
    // why) if the file can't be loaded.
    nvrhi::ITexture* Donut_LoadTexture(App* app, nvrhi::ICommandList* commandList, const char* path, int sRGB)
    {
        App* a = app;
        donut::engine::TextureLoadOptions options;
        options.sRGBMode = donut::engine::SRGBModeFromBool(sRGB != 0);

        std::shared_ptr<donut::engine::LoadedTexture> texture = a->textureCache()->LoadTextureFromFile(
            GetExecutablePath().parent_path() / path, options, nullptr, commandList);
        if (!texture || !texture->texture)
            return nullptr;
        return a->Own(texture->texture);
    }

    // Samplers shared through Donut's CommonRenderPasses (values of `which`).
    enum CommonSampler
    {
        CommonSampler_PointClamp = 0,
        CommonSampler_LinearClamp = 1,
        CommonSampler_LinearWrap = 2,
        CommonSampler_AnisotropicWrap = 3,
    };

    nvrhi::ISampler* Donut_GetCommonSampler(App* app, int which)
    {
        App* a = app;
        donut::engine::CommonRenderPasses* passes = a->commonPasses();
        switch (which)
        {
        case CommonSampler_PointClamp: return a->Own(passes->m_PointClampSampler);
        case CommonSampler_LinearClamp: return a->Own(passes->m_LinearClampSampler);
        case CommonSampler_LinearWrap: return a->Own(passes->m_LinearWrapSampler);
        case CommonSampler_AnisotropicWrap: return a->Own(passes->m_AnisotropicWrapSampler);
        default: return nullptr;
        }
    }

    // A sampler: linearFilter / linearMipFilter non-zero for linear filtering within / between
    // levels (point otherwise), wrap non-zero to repeat (clamp otherwise). Returns null on failure.
    nvrhi::ISampler* Donut_CreateSampler(App* app, int linearFilter, int linearMipFilter, int wrap)
    {
        auto desc = nvrhi::SamplerDesc()
            .setMinFilter(linearFilter != 0)
            .setMagFilter(linearFilter != 0)
            .setMipFilter(linearMipFilter != 0)
            .setAllAddressModes(wrap != 0 ? nvrhi::SamplerAddressMode::Wrap : nvrhi::SamplerAddressMode::Clamp);

        App* a = app;
        return a->Own(a->device()->createSampler(desc));
    }

    // A sampler by its whole description: linear (non-zero) or point filtering when minifying,
    // magnifying and between levels; the address mode of all coordinates (an
    // nvrhi::SamplerAddressMode value); a bias added to the level of detail, the range it's clamped
    // to (maxLod 0: level 0 only), and anisotropic filtering up to maxAnisotropy samples (1: off;
    // see Donut_GetMaxSamplerAnisotropy). Returns null on failure.
    nvrhi::ISampler* Donut_CreateSamplerWithDesc(App* app, int linearMin, int linearMag, int linearMip, int addressMode,
        double mipBias, double minLod, double maxLod, double maxAnisotropy)
    {
        auto desc = nvrhi::SamplerDesc()
            .setMinFilter(linearMin != 0)
            .setMagFilter(linearMag != 0)
            .setMipFilter(linearMip != 0)
            .setAllAddressModes(static_cast<nvrhi::SamplerAddressMode>(addressMode))
            .setMipBias(float(mipBias))
            .setLodRange(float(minLod), float(maxLod))
            .setMaxAnisotropy(float(maxAnisotropy));

        App* a = app;
        return a->Own(a->device()->createSampler(desc));
    }

    // A sampler whose coordinates outside [0, 1] read a border color (r, g, b, a): linear (non-zero)
    // or point filtering when minifying, magnifying and between levels, every level.
    nvrhi::ISampler* Donut_CreateBorderSampler(App* app, int linearMin, int linearMag, int linearMip, double r, double g,
        double b, double a)
    {
        auto desc = nvrhi::SamplerDesc()
            .setMinFilter(linearMin != 0)
            .setMagFilter(linearMag != 0)
            .setMipFilter(linearMip != 0)
            .setAllAddressModes(nvrhi::SamplerAddressMode::Border)
            .setBorderColor(nvrhi::Color(float(r), float(g), float(b), float(a)));

        App* owner = app;
        return owner->Own(owner->device()->createSampler(desc));
    }

    // The most samples anisotropic filtering can take: Vulkan's maxSamplerAnisotropy where the
    // device has samplerAnisotropy (1 without), 16 on D3D.
    double Donut_GetMaxSamplerAnisotropy(App* app)
    {
#if DONUT_WITH_VULKAN
        App* a = app;
        if (a->device()->getGraphicsAPI() == nvrhi::GraphicsAPI::VULKAN)
        {
            const vk::PhysicalDevice physicalDevice = DeviceManagerVKAccess::PhysicalDevice(
                static_cast<DeviceManager_VK*>(a->deviceManager.get()));
            if (!physicalDevice.getFeatures().samplerAnisotropy)
                return 1.0;
            return physicalDevice.getProperties().limits.maxSamplerAnisotropy;
        }
#endif
        (void)app;
        return 16.0;
    }

    // A comparison sampler (SamplerComparisonState) for depth textures: bilinear, clamped to the
    // edges. NVRHI fixes its comparison at "less": SampleCmp returns the filtered fraction of texels
    // whose depth is greater than the reference. Returns null on failure.
    nvrhi::ISampler* Donut_CreateComparisonSampler(App* app)
    {
        auto desc = nvrhi::SamplerDesc()
            .setAllFilters(true)
            .setAllAddressModes(nvrhi::SamplerAddressMode::Clamp)
            .setReductionType(nvrhi::SamplerReductionType::Comparison);

        App* a = app;
        return a->Own(a->device()->createSampler(desc));
    }

    // cbuffer at b<slot>: byteSize bytes of a constant buffer starting at byteOffset (both
    // multiples of 256).
    void Donut_BindConstantBuffer(nvrhi::BindingSetDesc* bindingSetDesc, int slot, nvrhi::IBuffer* constantBuffer, int byteOffset, int byteSize)
    {
        bindingSetDesc->addItem(nvrhi::BindingSetItem::ConstantBuffer(
            static_cast<uint32_t>(slot), constantBuffer,
            nvrhi::BufferRange(static_cast<uint64_t>(byteOffset), static_cast<uint64_t>(byteSize))));
    }

    // StructuredBuffer at t<slot> (e.g. from Donut_GetSceneBuffer).
    void Donut_BindStructuredBufferSRV(nvrhi::BindingSetDesc* bindingSetDesc, int slot, nvrhi::IBuffer* buffer)
    {
        bindingSetDesc->addItem(
            nvrhi::BindingSetItem::StructuredBuffer_SRV(static_cast<uint32_t>(slot), buffer));
    }

    // A buffer from Donut_CreateRWStructuredBuffer, as RWStructuredBuffer at u<slot>.
    void Donut_BindStructuredBufferUAV(nvrhi::BindingSetDesc* bindingSetDesc, int slot, nvrhi::IBuffer* buffer)
    {
        bindingSetDesc->addItem(
            nvrhi::BindingSetItem::StructuredBuffer_UAV(static_cast<uint32_t>(slot), buffer));
    }

    // ByteAddressBuffer at t<slot>; the buffer must allow raw views.
    void Donut_BindRawBufferSRV(nvrhi::BindingSetDesc* bindingSetDesc, int slot, nvrhi::IBuffer* buffer)
    {
        bindingSetDesc->addItem(
            nvrhi::BindingSetItem::RawBuffer_SRV(static_cast<uint32_t>(slot), buffer));
    }

    // RWByteAddressBuffer at u<slot>; the buffer must allow raw views and UAVs.
    void Donut_BindRawBufferUAV(nvrhi::BindingSetDesc* bindingSetDesc, int slot, nvrhi::IBuffer* buffer)
    {
        bindingSetDesc->addItem(
            nvrhi::BindingSetItem::RawBuffer_UAV(static_cast<uint32_t>(slot), buffer));
    }

    // Element arrayElement of a Donut_LayoutTextureSRVArray array at t<slot>.
    void Donut_BindTextureSRVArrayElement(nvrhi::BindingSetDesc* bindingSetDesc, int slot, int arrayElement, nvrhi::ITexture* texture)
    {
        bindingSetDesc->addItem(
            nvrhi::BindingSetItem::Texture_SRV(static_cast<uint32_t>(slot), texture)
                .setArrayElement(static_cast<uint32_t>(arrayElement)));
    }

    // The push constants of a Donut_LayoutPushConstants item: byteSize bytes at b<slot>, whose
    // values are given when dispatching or drawing (Donut_DispatchWithPushConstants,
    // Donut_DrawIndexedWithPushConstants).
    void Donut_BindPushConstants(nvrhi::BindingSetDesc* bindingSetDesc, int slot, int byteSize)
    {
        bindingSetDesc->addItem(
            nvrhi::BindingSetItem::PushConstants(static_cast<uint32_t>(slot), static_cast<uint32_t>(byteSize)));
    }

    // cbuffer at b<slot>: the whole of a constant buffer (required for volatile ones).
    void Donut_BindEntireConstantBuffer(nvrhi::BindingSetDesc* bindingSetDesc, int slot, nvrhi::IBuffer* constantBuffer)
    {
        bindingSetDesc->addItem(
            nvrhi::BindingSetItem::ConstantBuffer(static_cast<uint32_t>(slot), constantBuffer));
    }

    // Texture2D at t<slot>.
    void Donut_BindTextureSRV(nvrhi::BindingSetDesc* bindingSetDesc, int slot, nvrhi::ITexture* texture)
    {
        bindingSetDesc->addItem(
            nvrhi::BindingSetItem::Texture_SRV(static_cast<uint32_t>(slot), texture));
    }

    // Same, one level of the texture only (e.g. the level above the one a pass draws into).
    void Donut_BindTextureSRVMip(nvrhi::BindingSetDesc* bindingSetDesc, int slot, nvrhi::ITexture* texture, int mipLevel)
    {
        bindingSetDesc->addItem(nvrhi::BindingSetItem::Texture_SRV(
            static_cast<uint32_t>(slot), texture, nvrhi::Format::UNKNOWN,
            nvrhi::TextureSubresourceSet(uint32_t(mipLevel), 1, 0, 1)));
    }

    // Same, mipCount levels from firstMip on (the shader's level 0 is firstMip).
    void Donut_BindTextureSRVMips(nvrhi::BindingSetDesc* bindingSetDesc, int slot, nvrhi::ITexture* texture, int firstMip, int mipCount)
    {
        bindingSetDesc->addItem(nvrhi::BindingSetItem::Texture_SRV(
            static_cast<uint32_t>(slot), texture, nvrhi::Format::UNKNOWN,
            nvrhi::TextureSubresourceSet(uint32_t(firstMip), uint32_t(mipCount), 0, 1)));
    }

    // SamplerState at s<slot>.
    void Donut_BindSampler(nvrhi::BindingSetDesc* bindingSetDesc, int slot, nvrhi::ISampler* sampler)
    {
        bindingSetDesc->addItem(
            nvrhi::BindingSetItem::Sampler(static_cast<uint32_t>(slot), sampler));
    }

    // The layout a binding set was created with; valid as long as the binding set. Use it for
    // more binding sets (Donut_CreateBindingSetForLayout) and pipelines.
    nvrhi::IBindingLayout* Donut_GetBindingLayout(nvrhi::IBindingSet* bindingSet)
    {
        return bindingSet->getLayout();
    }

    // Triangle list, no depth test, for the frame's framebuffer layout, with an input layout
    // and one binding layout. Returns null on failure.
    nvrhi::IGraphicsPipeline* Donut_CreateGraphicsPipelineWithLayouts(App* app, FrameContext* frame, nvrhi::IShader* vertexShader, nvrhi::IShader* pixelShader,
        nvrhi::IInputLayout* inputLayout, nvrhi::IBindingLayout* bindingLayout)
    {
        nvrhi::GraphicsPipelineDesc desc;
        desc.VS = vertexShader;
        desc.PS = pixelShader;
        desc.inputLayout = inputLayout;
        desc.bindingLayouts = { bindingLayout };
        desc.primType = nvrhi::PrimitiveType::TriangleList;
        desc.renderState.depthStencilState.depthTestEnable = false;

        App* a = app;
        return a->Own(a->device()->createGraphicsPipeline(desc, frame->framebuffer->getFramebufferInfo()));
    }

    // Pipeline without depth test for the frame's framebuffer layout, drawing primitiveType (an
    // nvrhi::PrimitiveType value), with an optional input layout and an optional binding layout
    // (null for either means none). Returns null on failure.
    nvrhi::IGraphicsPipeline* Donut_CreateGraphicsPipelineWithTopology(App* app, FrameContext* frame, nvrhi::IShader* vertexShader, nvrhi::IShader* pixelShader,
        nvrhi::IInputLayout* inputLayout, nvrhi::IBindingLayout* bindingLayout, int primitiveType)
    {
        nvrhi::GraphicsPipelineDesc desc;
        desc.VS = vertexShader;
        desc.PS = pixelShader;
        desc.inputLayout = inputLayout;
        if (bindingLayout)
            desc.bindingLayouts = { bindingLayout };
        desc.primType = static_cast<nvrhi::PrimitiveType>(primitiveType);
        desc.renderState.depthStencilState.depthTestEnable = false;

        App* a = app;
        return a->Own(a->device()->createGraphicsPipeline(desc, frame->framebuffer->getFramebufferInfo()));
    }

    // blendMode, a BlendMode value: 1 is additive (color One + One, alpha SrcAlpha + DstAlpha), 2
    // alpha blending (color SrcAlpha + InvSrcAlpha, alpha InvSrcAlpha + Zero), 3 alpha blending
    // "over" (color SrcAlpha + InvSrcAlpha, alpha One + InvSrcAlpha), 4 premultiplied alpha
    // (color and alpha One + InvSrcAlpha), 0 none.
    static void SetBlendMode(nvrhi::BlendState::RenderTarget& target, int blendMode)
    {
        if (blendMode == 4)
        {
            target
                .enableBlend()
                .setSrcBlend(nvrhi::BlendFactor::One)
                .setDestBlend(nvrhi::BlendFactor::InvSrcAlpha)
                .setBlendOp(nvrhi::BlendOp::Add)
                .setSrcBlendAlpha(nvrhi::BlendFactor::One)
                .setDestBlendAlpha(nvrhi::BlendFactor::InvSrcAlpha)
                .setBlendOpAlpha(nvrhi::BlendOp::Add);
            return;
        }
        if (blendMode == 1)
        {
            target
                .enableBlend()
                .setSrcBlend(nvrhi::BlendFactor::One)
                .setDestBlend(nvrhi::BlendFactor::One)
                .setBlendOp(nvrhi::BlendOp::Add)
                .setSrcBlendAlpha(nvrhi::BlendFactor::SrcAlpha)
                .setDestBlendAlpha(nvrhi::BlendFactor::DstAlpha)
                .setBlendOpAlpha(nvrhi::BlendOp::Add);
        }
        else if (blendMode == 3)
        {
            target
                .enableBlend()
                .setSrcBlend(nvrhi::BlendFactor::SrcAlpha)
                .setDestBlend(nvrhi::BlendFactor::InvSrcAlpha)
                .setBlendOp(nvrhi::BlendOp::Add)
                .setSrcBlendAlpha(nvrhi::BlendFactor::One)
                .setDestBlendAlpha(nvrhi::BlendFactor::InvSrcAlpha)
                .setBlendOpAlpha(nvrhi::BlendOp::Add);
        }
        else if (blendMode == 2)
        {
            target
                .enableBlend()
                .setSrcBlend(nvrhi::BlendFactor::SrcAlpha)
                .setDestBlend(nvrhi::BlendFactor::InvSrcAlpha)
                .setBlendOp(nvrhi::BlendOp::Add)
                .setSrcBlendAlpha(nvrhi::BlendFactor::InvSrcAlpha)
                .setDestBlendAlpha(nvrhi::BlendFactor::Zero)
                .setBlendOpAlpha(nvrhi::BlendOp::Add);
        }
        else
        {
            target.disableBlend();
        }
    }

    // Same, blending into the framebuffer with blendMode (a BlendMode value, see SetBlendMode).
    // Returns null on failure.
    nvrhi::IGraphicsPipeline* Donut_CreateGraphicsPipelineWithBlend(App* app, FrameContext* frame, nvrhi::IShader* vertexShader, nvrhi::IShader* pixelShader,
        nvrhi::IInputLayout* inputLayout, nvrhi::IBindingLayout* bindingLayout, int primitiveType, int blendMode)
    {
        nvrhi::GraphicsPipelineDesc desc;
        desc.VS = vertexShader;
        desc.PS = pixelShader;
        desc.inputLayout = inputLayout;
        if (bindingLayout)
            desc.bindingLayouts = { bindingLayout };
        desc.primType = static_cast<nvrhi::PrimitiveType>(primitiveType);
        desc.renderState.depthStencilState.depthTestEnable = false;
        SetBlendMode(desc.renderState.blendState.targets[0], blendMode);

        App* a = app;
        return a->Own(a->device()->createGraphicsPipeline(desc, frame->framebuffer->getFramebufferInfo()));
    }

    // RGBA8_UNORM texture of width x height that compute shaders write as RWTexture2D<float4> and
    // pixel shaders read; NVRHI tracks its state, which rests at NonPixelShaderResource. Returns
    // null on failure.
    nvrhi::ITexture* Donut_CreateUAVTexture(App* app, int width, int height, const char* debugName)
    {
        auto desc = nvrhi::TextureDesc()
            .setFormat(nvrhi::Format::RGBA8_UNORM)
            .setWidth(static_cast<uint32_t>(width))
            .setHeight(static_cast<uint32_t>(height))
            .setIsUAV(true)
            .setDebugName(debugName)
            .enableAutomaticStateTracking(nvrhi::ResourceStates::NonPixelShaderResource);

        App* a = app;
        return a->Own(a->device()->createTexture(desc));
    }

    // Render target (for Donut_CreateFramebuffer) of width x height in `format` (an nvrhi::Format
    // value) that shaders can also read; resting at ShaderResource. A depth format makes a depth
    // buffer, cleared to 1 by default, whose shader view reads the depth. Returns null on failure.
    nvrhi::ITexture* Donut_CreateRenderTargetTexture(App* app, int width, int height, int format, const char* debugName);

    // Same, typeless: framebuffers can see it in other formats of its family
    // (Donut_CreateFramebufferWithColorFormat), e.g. an SRGBA8_UNORM texture as RGBA8_UNORM (stored
    // without sRGB encoding) or RGBA8_UINT (for logic operations, which D3D12 has on UINT targets
    // only); shaders read it in `format`.
    nvrhi::ITexture* Donut_CreateTypelessRenderTargetTexture(App* app, int width, int height, int format, const char* debugName)
    {
        auto desc = nvrhi::TextureDesc()
            .setFormat(static_cast<nvrhi::Format>(format))
            .setWidth(static_cast<uint32_t>(width))
            .setHeight(static_cast<uint32_t>(height))
            .setIsRenderTarget(true)
            .setIsTypeless(true)
            .setDebugName(debugName)
            .setInitialState(nvrhi::ResourceStates::ShaderResource)
            .setKeepInitialState(true);

        App* a = app;
        return a->Own(a->device()->createTexture(desc));
    }

    // Render target of width x height with mipLevels levels (draw into one with
    // Donut_CreateFramebufferForMip, read another with Donut_BindTextureSRVMip) in `format`, that
    // shaders read with all its levels; typeless, so that copies from textures of other formats of
    // its family land (e.g. RGBA8_UNORM data into SRGBA8_UNORM). Resting at ShaderResource. Returns
    // null on failure.
    nvrhi::ITexture* Donut_CreateMipmappedRenderTarget(App* app, int width, int height, int mipLevels, int format,
        const char* debugName)
    {
        auto desc = nvrhi::TextureDesc()
            .setFormat(static_cast<nvrhi::Format>(format))
            .setWidth(static_cast<uint32_t>(width))
            .setHeight(static_cast<uint32_t>(height))
            .setMipLevels(static_cast<uint32_t>(mipLevels))
            .setIsRenderTarget(true)
            .setIsTypeless(true)
            .setDebugName(debugName)
            .setInitialState(nvrhi::ResourceStates::ShaderResource)
            .setKeepInitialState(true);

        App* a = app;
        return a->Own(a->device()->createTexture(desc));
    }

    // Texture of width x height with mipLevels levels in `format` (block-compressed formats too) for
    // shaders to read, its levels written with Donut_WriteTextureLevel; resting at ShaderResource.
    // Returns null on failure.
    nvrhi::ITexture* Donut_CreateTextureWithLevels(App* app, int width, int height, int mipLevels, int format, const char* debugName)
    {
        auto desc = nvrhi::TextureDesc()
            .setFormat(static_cast<nvrhi::Format>(format))
            .setWidth(static_cast<uint32_t>(width))
            .setHeight(static_cast<uint32_t>(height))
            .setMipLevels(static_cast<uint32_t>(mipLevels))
            .setDebugName(debugName)
            .setInitialState(nvrhi::ResourceStates::ShaderResource)
            .setKeepInitialState(true);

        App* a = app;
        return a->Own(a->device()->createTexture(desc));
    }

    // Uploads a level of a texture from data, its rows (of 4 x 4 blocks for block-compressed
    // formats) rowPitch bytes apart, copied during the call, recorded into an open command list.
    void Donut_WriteTextureLevel(nvrhi::ICommandList* commandList, nvrhi::ITexture* texture, int mipLevel, const void* data, int rowPitch)
    {
        commandList->writeTexture(texture, 0, static_cast<uint32_t>(mipLevel),
            data, static_cast<size_t>(rowPitch));
    }

    // Render target of width x height in `format` that shaders also read and write as a UAV
    // (RWTexture2D<...>), e.g. one pass's output another's compute shaders read; resting at
    // UnorderedAccess. Returns null on failure.
    nvrhi::ITexture* Donut_CreateRenderTargetUAVTexture(App* app, int width, int height, int format, const char* debugName)
    {
        auto desc = nvrhi::TextureDesc()
            .setFormat(static_cast<nvrhi::Format>(format))
            .setWidth(static_cast<uint32_t>(width))
            .setHeight(static_cast<uint32_t>(height))
            .setIsRenderTarget(true)
            .setIsUAV(true)
            .setDebugName(debugName)
            .setInitialState(nvrhi::ResourceStates::UnorderedAccess)
            .setKeepInitialState(true);

        App* a = app;
        return a->Own(a->device()->createTexture(desc));
    }

    nvrhi::ITexture* Donut_CreateRenderTargetTexture(App* app, int width, int height, int format, const char* debugName)
    {
        const auto textureFormat = static_cast<nvrhi::Format>(format);
        auto desc = nvrhi::TextureDesc()
            .setFormat(textureFormat)
            .setWidth(static_cast<uint32_t>(width))
            .setHeight(static_cast<uint32_t>(height))
            .setIsRenderTarget(true)
            .setDebugName(debugName)
            .setInitialState(nvrhi::ResourceStates::ShaderResource)
            .setKeepInitialState(true);
        if (nvrhi::getFormatInfo(textureFormat).hasDepth)
        {
            // Typeless, for the depth-stencil view and the shader resource view to differ in format.
            desc.setIsTypeless(true).setClearValue(nvrhi::Color(1.f));
        }

        App* a = app;
        return a->Own(a->device()->createTexture(desc));
    }

    // Depth buffer of width x height in `format` (a depth nvrhi::Format value), optimized for
    // clears to clearDepth (e.g. 0 for reversed depth), that shaders can also read (resting at
    // ShaderResource). Returns null on failure.
    nvrhi::ITexture* Donut_CreateDepthTexture(App* app, int width, int height, int format, double clearDepth, const char* debugName)
    {
        auto desc = nvrhi::TextureDesc()
            .setFormat(static_cast<nvrhi::Format>(format))
            .setWidth(static_cast<uint32_t>(width))
            .setHeight(static_cast<uint32_t>(height))
            .setIsRenderTarget(true)
            .setIsTypeless(true)
            .setClearValue(nvrhi::Color(float(clearDepth)))
            .setDebugName(debugName)
            .setInitialState(nvrhi::ResourceStates::ShaderResource)
            .setKeepInitialState(true);

        App* a = app;
        return a->Own(a->device()->createTexture(desc));
    }

    // Texture of width x height in `format` (an nvrhi::Format value) that shaders write and read as
    // a UAV (RWTexture2D<...>), resting at UnorderedAccess; clear it with Donut_ClearTextureUInt or
    // Donut_ClearTextureFloat. Returns null on failure.
    nvrhi::ITexture* Donut_CreateUAVTextureWithFormat(App* app, int width, int height, int format, const char* debugName)
    {
        auto desc = nvrhi::TextureDesc()
            .setFormat(static_cast<nvrhi::Format>(format))
            .setWidth(static_cast<uint32_t>(width))
            .setHeight(static_cast<uint32_t>(height))
            .setIsUAV(true)
            .setDebugName(debugName)
            .setInitialState(nvrhi::ResourceStates::UnorderedAccess)
            .setKeepInitialState(true);

        App* a = app;
        return a->Own(a->device()->createTexture(desc));
    }

    // Same, an array of arraySize slices (RWTexture2DArray<...>; Texture2DArray when read).
    nvrhi::ITexture* Donut_CreateUAVTextureArray(App* app, int width, int height, int arraySize, int format, const char* debugName)
    {
        auto desc = nvrhi::TextureDesc()
            .setDimension(nvrhi::TextureDimension::Texture2DArray)
            .setFormat(static_cast<nvrhi::Format>(format))
            .setWidth(static_cast<uint32_t>(width))
            .setHeight(static_cast<uint32_t>(height))
            .setArraySize(static_cast<uint32_t>(arraySize))
            .setIsUAV(true)
            .setDebugName(debugName)
            .setInitialState(nvrhi::ResourceStates::UnorderedAccess)
            .setKeepInitialState(true);

        App* a = app;
        return a->Own(a->device()->createTexture(desc));
    }

    // Textures for compute shaders on the compute queue (as well as the graphics queue): they rest
    // at NonPixelShaderResource between command lists, as D3D12 compute queues can't make or undo
    // transitions to pixel shader states.

    // Render target of width x height in `format` (an nvrhi::Format value) that shaders read.
    // Returns null on failure.
    nvrhi::ITexture* Donut_CreateComputeReadableRenderTarget(App* app, int width, int height, int format, const char* debugName)
    {
        auto desc = nvrhi::TextureDesc()
            .setFormat(static_cast<nvrhi::Format>(format))
            .setWidth(static_cast<uint32_t>(width))
            .setHeight(static_cast<uint32_t>(height))
            .setIsRenderTarget(true)
            .setDebugName(debugName)
            .setInitialState(nvrhi::ResourceStates::NonPixelShaderResource)
            .setKeepInitialState(true);

        App* a = app;
        return a->Own(a->device()->createTexture(desc));
    }

    // Texture of width x height in `format` that compute shaders write (RWTexture2D<float4>) and
    // shaders read. Returns null on failure.
    nvrhi::ITexture* Donut_CreateComputeTexture(App* app, int width, int height, int format, const char* debugName)
    {
        auto desc = nvrhi::TextureDesc()
            .setFormat(static_cast<nvrhi::Format>(format))
            .setWidth(static_cast<uint32_t>(width))
            .setHeight(static_cast<uint32_t>(height))
            .setIsUAV(true)
            .setDebugName(debugName)
            .setInitialState(nvrhi::ResourceStates::NonPixelShaderResource)
            .setKeepInitialState(true);

        App* a = app;
        return a->Own(a->device()->createTexture(desc));
    }

    // Framebuffer of one color target and an optional depth target (null for none), textures from
    // Donut_CreateRenderTargetTexture. Draw into it with Donut_BeginDrawToFramebuffer. Returns null
    // on failure.
    nvrhi::IFramebuffer* Donut_CreateFramebuffer(App* app, nvrhi::ITexture* colorTexture, nvrhi::ITexture* depthTexture)
    {
        auto desc = nvrhi::FramebufferDesc().addColorAttachment(colorTexture);
        if (depthTexture)
            desc.setDepthAttachment(depthTexture);

        App* a = app;
        return a->Own(a->device()->createFramebuffer(desc));
    }

    // Same, the color target seen in colorFormat (an nvrhi::Format value of the texture's family:
    // e.g. RGBA8_UINT or RGBA8_UNORM for a typeless SRGBA8_UNORM texture,
    // Donut_CreateTypelessRenderTargetTexture).
    nvrhi::IFramebuffer* Donut_CreateFramebufferWithColorFormat(App* app, nvrhi::ITexture* colorTexture, int colorFormat, nvrhi::ITexture* depthTexture)
    {
        auto desc = nvrhi::FramebufferDesc().addColorAttachment(nvrhi::FramebufferAttachment()
            .setTexture(colorTexture)
            .setFormat(static_cast<nvrhi::Format>(colorFormat)));
        if (depthTexture)
            desc.setDepthAttachment(depthTexture);

        App* a = app;
        return a->Own(a->device()->createFramebuffer(desc));
    }

    // Framebuffer of a depth target alone (e.g. a shadow map). Returns null on failure.
    nvrhi::IFramebuffer* Donut_CreateDepthFramebuffer(App* app, nvrhi::ITexture* depthTexture)
    {
        auto desc = nvrhi::FramebufferDesc().setDepthAttachment(depthTexture);

        App* a = app;
        return a->Own(a->device()->createFramebuffer(desc));
    }

    // Same, with two color targets (SV_Target0 and SV_Target1).
    nvrhi::IFramebuffer* Donut_CreateFramebufferWithTwoTargets(App* app, nvrhi::ITexture* colorTexture0, nvrhi::ITexture* colorTexture1, nvrhi::ITexture* depthTexture)
    {
        auto desc = nvrhi::FramebufferDesc()
            .addColorAttachment(colorTexture0)
            .addColorAttachment(colorTexture1);
        if (depthTexture)
            desc.setDepthAttachment(depthTexture);

        App* a = app;
        return a->Own(a->device()->createFramebuffer(desc));
    }

    // Same, with three color targets (SV_Target0 to SV_Target2).
    nvrhi::IFramebuffer* Donut_CreateFramebufferWithThreeTargets(App* app, nvrhi::ITexture* colorTexture0, nvrhi::ITexture* colorTexture1, nvrhi::ITexture* colorTexture2,
        nvrhi::ITexture* depthTexture)
    {
        auto desc = nvrhi::FramebufferDesc()
            .addColorAttachment(colorTexture0)
            .addColorAttachment(colorTexture1)
            .addColorAttachment(colorTexture2);
        if (depthTexture)
            desc.setDepthAttachment(depthTexture);

        App* a = app;
        return a->Own(a->device()->createFramebuffer(desc));
    }

    // Framebuffer of one level of a color target (e.g. of Donut_CreateTiledTexture), to draw into
    // while sampling another level (Donut_BindTextureSRVMip). Returns null on failure.
    nvrhi::IFramebuffer* Donut_CreateFramebufferForMip(App* app, nvrhi::ITexture* colorTexture, int mipLevel)
    {
        auto desc = nvrhi::FramebufferDesc().addColorAttachment(nvrhi::FramebufferAttachment()
            .setTexture(colorTexture)
            .setSubresources(nvrhi::TextureSubresourceSet(uint32_t(mipLevel), 1, 0, 1)));

        App* a = app;
        return a->Own(a->device()->createFramebuffer(desc));
    }

    // --- Tiled textures ----------------------------------------------------------------------

    // A 2D texture of width x height and mipLevels levels in `format` whose memory is mapped tile by
    // tile (Donut_ApplyTileMappings), from heaps of Donut_CreateTileHeap: unmapped tiles read as
    // zeros, and shaders can tell (CheckAccessFullyMapped). It rests as a shader resource, and is a
    // copy source and destination and a render target (e.g. to fill a level from the one above it).
    // Requires Donut_HasSparseResidency. Returns null on failure.
    nvrhi::ITexture* Donut_CreateTiledTexture(App* app, int width, int height, int mipLevels, int format, const char* debugName)
    {
        nvrhi::TextureDesc desc;
        desc.width = static_cast<uint32_t>(width);
        desc.height = static_cast<uint32_t>(height);
        desc.mipLevels = static_cast<uint32_t>(mipLevels);
        desc.format = static_cast<nvrhi::Format>(format);
        desc.dimension = nvrhi::TextureDimension::Texture2D;
        desc.isTiled = true;
        desc.isRenderTarget = true;
        desc.initialState = nvrhi::ResourceStates::ShaderResource;
        desc.keepInitialState = true;
        desc.debugName = debugName;

        App* a = app;
        return a->Own(a->device()->createTexture(desc));
    }

    // A tiled texture's tiling, into dst (Ref of a `let` int array of 4): the tile's width and
    // height in texels, the number of levels made of whole tiles, and the number of levels packed
    // into the mip tail after them.
    void Donut_GetTextureTiling(App* app, nvrhi::ITexture* texture, int* dst)
    {
        uint32_t numTiles = 0;
        nvrhi::PackedMipDesc packedMips;
        nvrhi::TileShape tileShape;
        uint32_t subresourceTilingsNum = 0;
        app->device()->getTextureTiling(texture, &numTiles, &packedMips, &tileShape,
            &subresourceTilingsNum, nullptr);
        dst[0] = static_cast<int>(tileShape.widthInTexels);
        dst[1] = static_cast<int>(tileShape.heightInTexels);
        dst[2] = static_cast<int>(packedMips.numStandardMips);
        dst[3] = static_cast<int>(packedMips.numPackedMips);
    }

    // Device memory to map tiles of tiled textures into: byteSize bytes, a multiple of the 64 KiB
    // tile. Release it (Donut_ReleaseResource) once no tile is mapped to it any more and the GPU is
    // done with what used it. Returns null on failure.
    nvrhi::IHeap* Donut_CreateTileHeap(App* app, double byteSize, const char* debugName)
    {
        nvrhi::HeapDesc desc;
        desc.capacity = static_cast<uint64_t>(byteSize);
        desc.type = nvrhi::HeapType::DeviceLocal;
        desc.debugName = debugName;

        App* a = app;
        return a->Own(a->device()->createHeap(desc));
    }

    // A heap that textures are placed in (Donut_CreatePlacedTexture): D3D12's own ID3D12Heap (NVRHI
    // creates its heaps for MSAA alignment and places textures at the default 64 KB one), NVRHI's
    // heap on Vulkan.
    struct TextureHeap
    {
        nvrhi::GraphicsAPI api = nvrhi::GraphicsAPI::D3D12;
        uint64_t capacity = 0;
#if DONUT_WITH_DX12
        Microsoft::WRL::ComPtr<ID3D12Heap> d3dHeap;
#endif
        nvrhi::HeapHandle heap;
    };

    // (Filled in place: a function in the extern "C" block can't return a C++ type.)
    static void PlacedTextureDesc(nvrhi::TextureDesc& desc, int width, int height, int format, const char* debugName)
    {
        desc = nvrhi::TextureDesc()
            .setWidth(uint32_t(width))
            .setHeight(uint32_t(height))
            .setFormat(static_cast<nvrhi::Format>(format))
            .setDebugName(debugName)
            .setInitialState(nvrhi::ResourceStates::ShaderResource)
            .setKeepInitialState(true);
    }

#if DONUT_WITH_DX12
    // The D3D12 resource desc of a placed texture, and its allocation: small textures (whose most
    // detailed level fits in 64 KB) at the 4 KB small resource alignment when the device grants it.
    static D3D12_RESOURCE_DESC PlacedTextureD3D12Desc(ID3D12Device* device, int width, int height, int format,
        D3D12_RESOURCE_ALLOCATION_INFO& info)
    {
        D3D12_RESOURCE_DESC desc = {};
        desc.Dimension = D3D12_RESOURCE_DIMENSION_TEXTURE2D;
        desc.Alignment = D3D12_SMALL_RESOURCE_PLACEMENT_ALIGNMENT;
        desc.Width = UINT64(width);
        desc.Height = UINT(height);
        desc.DepthOrArraySize = 1;
        desc.MipLevels = 1;
        desc.Format = nvrhi::d3d12::convertFormat(static_cast<nvrhi::Format>(format));
        desc.SampleDesc.Count = 1;
        info = device->GetResourceAllocationInfo(0, 1, &desc);
        if (info.Alignment != D3D12_SMALL_RESOURCE_PLACEMENT_ALIGNMENT)
        {
            // Not granted: the alignment D3D12 picks.
            desc.Alignment = 0;
            info = device->GetResourceAllocationInfo(0, 1, &desc);
        }
        return desc;
    }
#endif

    // The bytes a width x height, one level texture of `format` takes in a texture heap
    // (Donut_CreatePlacedTexture), its alignment included: D3D12's small resource alignment (4 KB)
    // where it's granted, Vulkan's memory requirements.
    double Donut_GetPlacedTextureSize(App* app, int width, int height, int format)
    {
        App* a = app;
        nvrhi::IDevice* device = a->device();
#if DONUT_WITH_DX12
        if (device->getGraphicsAPI() == nvrhi::GraphicsAPI::D3D12)
        {
            D3D12_RESOURCE_ALLOCATION_INFO info;
            PlacedTextureD3D12Desc(device->getNativeObject(nvrhi::ObjectTypes::D3D12_Device), width, height, format, info);
            return double(info.SizeInBytes);
        }
#endif
        nvrhi::TextureDesc desc;
        PlacedTextureDesc(desc, width, height, format, "PlacedTextureSize");
        desc.isVirtual = true;
        nvrhi::TextureHandle texture = device->createTexture(desc);
        if (!texture)
            return 0.0;
        const nvrhi::MemoryRequirements requirements = device->getTextureMemoryRequirements(texture);
        const uint64_t alignment = requirements.alignment ? requirements.alignment : 1;
        return double((requirements.size + alignment - 1) / alignment * alignment);
    }

    // A heap of byteSize bytes of device memory for textures (Donut_CreatePlacedTexture); null on
    // failure. D3D11 has none.
    void* Donut_CreateTextureHeap(App* app, double byteSize, const char* debugName)
    {
        App* a = app;
        nvrhi::IDevice* device = a->device();
        auto heap = std::make_shared<TextureHeap>();
        heap->api = device->getGraphicsAPI();
        heap->capacity = uint64_t(byteSize);
#if DONUT_WITH_DX12
        if (heap->api == nvrhi::GraphicsAPI::D3D12)
        {
            ID3D12Device* d3dDevice = device->getNativeObject(nvrhi::ObjectTypes::D3D12_Device);
            D3D12_HEAP_DESC heapDesc = {};
            heapDesc.SizeInBytes = heap->capacity;
            heapDesc.Properties.Type = D3D12_HEAP_TYPE_DEFAULT;
            heapDesc.Alignment = D3D12_DEFAULT_RESOURCE_PLACEMENT_ALIGNMENT;
            heapDesc.Flags = D3D12_HEAP_FLAG_DENY_BUFFERS | D3D12_HEAP_FLAG_DENY_RT_DS_TEXTURES;
            if (FAILED(d3dDevice->CreateHeap(&heapDesc, IID_PPV_ARGS(&heap->d3dHeap))))
                return nullptr;
            if (debugName)
                heap->d3dHeap->SetName(Widen(debugName).c_str());
            return a->OwnObject(heap);
        }
#endif
        if (heap->api != nvrhi::GraphicsAPI::VULKAN)
            return nullptr;
        nvrhi::HeapDesc desc;
        desc.capacity = heap->capacity;
        desc.type = nvrhi::HeapType::DeviceLocal;
        desc.debugName = debugName;
        heap->heap = device->createHeap(desc);
        if (!heap->heap)
            return nullptr;
        return a->OwnObject(heap);
    }

    // A width x height, one level texture of `format` that shaders read, placed in a texture heap
    // at byteOffset (a multiple of Donut_GetPlacedTextureSize's size); its first use recorded into an
    // open command list (D3D12's aliasing barrier). Fill it with Donut_WriteTextureLevel. Null on
    // failure.
    nvrhi::ITexture* Donut_CreatePlacedTexture(App* app, nvrhi::ICommandList* commandList, void* textureHeap, double byteOffset, int width, int height,
        int format, const char* debugName)
    {
        App* a = app;
        nvrhi::IDevice* device = a->device();
        auto* heap = static_cast<TextureHeap*>(textureHeap);
        nvrhi::TextureDesc desc;
        PlacedTextureDesc(desc, width, height, format, debugName);
#if DONUT_WITH_DX12
        if (heap->api == nvrhi::GraphicsAPI::D3D12)
        {
            ID3D12Device* d3dDevice = device->getNativeObject(nvrhi::ObjectTypes::D3D12_Device);
            D3D12_RESOURCE_ALLOCATION_INFO info;
            const D3D12_RESOURCE_DESC resourceDesc = PlacedTextureD3D12Desc(d3dDevice, width, height, format, info);
            if (uint64_t(byteOffset) + info.SizeInBytes > heap->capacity)
                return nullptr;
            Microsoft::WRL::ComPtr<ID3D12Resource> resource;
            if (FAILED(d3dDevice->CreatePlacedResource(heap->d3dHeap.Get(), uint64_t(byteOffset), &resourceDesc,
                    D3D12_RESOURCE_STATE_ALL_SHADER_RESOURCE, nullptr, IID_PPV_ARGS(&resource))))
                return nullptr;
            if (debugName)
                resource->SetName(Widen(debugName).c_str());
            // The heap lives as long as the textures in it (as NVRHI's Vulkan textures keep theirs).
            static const GUID heapReference = { 0x6c1f3a52, 0x8d2e, 0x4b7a, { 0x9e, 0x31, 0x5f, 0x0c, 0x7d, 0x42, 0xa8, 0x19 } };
            resource->SetPrivateDataInterface(heapReference, heap->d3dHeap.Get());
            // The resource takes over its memory in the heap.
            ID3D12GraphicsCommandList* d3dCommandList = commandList->getNativeObject(
                nvrhi::ObjectTypes::D3D12_GraphicsCommandList);
            D3D12_RESOURCE_BARRIER barrier = {};
            barrier.Type = D3D12_RESOURCE_BARRIER_TYPE_ALIASING;
            barrier.Aliasing.pResourceAfter = resource.Get();
            d3dCommandList->ResourceBarrier(1, &barrier);
            return a->Own(device->createHandleForNativeTexture(nvrhi::ObjectTypes::D3D12_Resource,
                nvrhi::Object(resource.Get()), desc));
        }
#endif
        nvrhi::TextureDesc virtualDesc = desc;
        virtualDesc.isVirtual = true;
        nvrhi::TextureHandle texture = device->createTexture(virtualDesc);
        if (!texture || !heap->heap || !device->bindTextureMemory(texture, heap->heap, uint64_t(byteOffset)))
            return nullptr;
        return a->Own(texture);
    }

    // Tile mappings to apply in one go (Donut_ApplyTileMappings).
    struct TileMappings
    {
        struct Tile
        {
            nvrhi::IHeap* heap;
            nvrhi::TiledTextureCoordinate coordinate;
            uint64_t byteOffset;
        };
        std::vector<Tile> tiles;
    };

    void* Donut_CreateTileMappings()
    {
        return new TileMappings();
    }

    // Maps the tile at column x, row y of level mipLevel to byteOffset (a multiple of 64 KiB) in a
    // heap, or unmaps it (heap null).
    void Donut_TileMappingsAdd(void* tileMappings, int mipLevel, int x, int y, nvrhi::IHeap* heap, double byteOffset)
    {
        TileMappings::Tile tile;
        tile.heap = heap;
        tile.coordinate.mipLevel = static_cast<uint16_t>(mipLevel);
        tile.coordinate.x = static_cast<uint32_t>(x);
        tile.coordinate.y = static_cast<uint32_t>(y);
        tile.byteOffset = static_cast<uint64_t>(byteOffset);
        static_cast<TileMappings*>(tileMappings)->tiles.push_back(tile);
    }

    // Applies the mappings to a tiled texture, on the graphics queue, after the work submitted to
    // it before; frees them. Vulkan's sparse binding isn't ordered with the queue's other work: there
    // the device is idle before and after.
    void Donut_ApplyTileMappings(App* app, nvrhi::ITexture* texture, void* tileMappings)
    {
        std::unique_ptr<TileMappings> mappings(static_cast<TileMappings*>(tileMappings));
        nvrhi::IDevice* device = app->device();

        // A mapping per heap (and one for the tiles to unmap), in the order the tiles came.
        std::vector<nvrhi::IHeap*> heaps;
        std::vector<std::vector<size_t>> heapTiles;
        for (size_t i = 0; i < mappings->tiles.size(); i++)
        {
            const auto found = std::find(heaps.begin(), heaps.end(), mappings->tiles[i].heap);
            if (found == heaps.end())
            {
                heaps.push_back(mappings->tiles[i].heap);
                heapTiles.push_back({ i });
            }
            else
                heapTiles[found - heaps.begin()].push_back(i);
        }

        // One tile per region: D3D12 reads the region's size in texels (rounded up to tiles), Vulkan
        // in tiles.
        std::vector<std::vector<nvrhi::TiledTextureCoordinate>> coordinates(heaps.size());
        std::vector<std::vector<nvrhi::TiledTextureRegion>> regions(heaps.size());
        std::vector<std::vector<uint64_t>> byteOffsets(heaps.size());
        std::vector<nvrhi::TextureTilesMapping> tilesMappings(heaps.size());
        for (size_t h = 0; h < heaps.size(); h++)
        {
            for (size_t i : heapTiles[h])
            {
                coordinates[h].push_back(mappings->tiles[i].coordinate);
                nvrhi::TiledTextureRegion region;
                region.width = 1;
                region.height = 1;
                region.depth = 1;
                regions[h].push_back(region);
                byteOffsets[h].push_back(mappings->tiles[i].byteOffset);
            }
            tilesMappings[h].tiledTextureCoordinates = coordinates[h].data();
            tilesMappings[h].tiledTextureRegions = regions[h].data();
            tilesMappings[h].byteOffsets = byteOffsets[h].data();
            tilesMappings[h].numTextureRegions = static_cast<uint32_t>(coordinates[h].size());
            tilesMappings[h].heap = heaps[h];
        }

        const bool vulkan = device->getGraphicsAPI() == nvrhi::GraphicsAPI::VULKAN;
        if (vulkan)
            device->waitForIdle();
        device->updateTextureTileMappings(texture, tilesMappings.data(),
            static_cast<uint32_t>(tilesMappings.size()));
        if (vulkan)
            device->waitForIdle();
    }

    // The first level of a DDS file (path relative to the executable's directory) in a staging
    // texture: memory on the CPU's side that the GPU copies from (Donut_CopyStagingTextureRegion).
    // Null (after logging why) on failure.
    nvrhi::IStagingTexture* Donut_LoadStagingTexture(App* app, const char* path)
    {
        const std::filesystem::path filePath = GetExecutablePath().parent_path() / path;
        donut::vfs::NativeFileSystem fs;
        donut::engine::TextureData texture;
        texture.data = fs.readFile(filePath);
        if (!texture.data || !donut::engine::LoadDDSTextureFromMemory(texture) || texture.dataLayout.empty()
            || texture.dataLayout[0].empty())
        {
            donut::log::error("Cannot read %s", filePath.generic_string().c_str());
            return nullptr;
        }

        nvrhi::TextureDesc desc;
        desc.width = texture.width;
        desc.height = texture.height;
        desc.format = texture.format;
        desc.dimension = nvrhi::TextureDimension::Texture2D;
        desc.debugName = path;

        App* a = app;
        nvrhi::StagingTextureHandle staging = a->device()->createStagingTexture(desc, nvrhi::CpuAccessMode::Write);
        if (!staging)
            return nullptr;

        size_t rowPitch = 0;
        auto* mapped = static_cast<uint8_t*>(a->device()->mapStagingTexture(staging, nvrhi::TextureSlice(),
            nvrhi::CpuAccessMode::Write, &rowPitch));
        if (!mapped)
            return nullptr;
        const donut::engine::TextureSubresourceData& level = texture.dataLayout[0][0];
        const auto* source = static_cast<const uint8_t*>(texture.data->data()) + level.dataOffset;
        const size_t rowBytes = std::min(rowPitch, level.rowPitch);
        for (uint32_t row = 0; row < texture.height; row++)
            memcpy(mapped + row * rowPitch, source + row * level.rowPitch, rowBytes);
        a->device()->unmapStagingTexture(staging);
        return a->Own(staging);
    }

    int Donut_GetStagingTextureWidth(nvrhi::IStagingTexture* stagingTexture)
    {
        return static_cast<int>(stagingTexture->getDesc().width);
    }

    int Donut_GetStagingTextureHeight(nvrhi::IStagingTexture* stagingTexture)
    {
        return static_cast<int>(stagingTexture->getDesc().height);
    }

    // Copies width x height texels at (srcX, srcY) of a staging texture's first level to (dstX, dstY)
    // of level dstMip of a texture.
    void Donut_CopyStagingTextureRegion(nvrhi::ICommandList* commandList, nvrhi::ITexture* dstTexture, int dstMip, int dstX, int dstY,
        nvrhi::IStagingTexture* stagingTexture, int srcX, int srcY, int width, int height)
    {
        nvrhi::TextureSlice dst;
        dst.x = static_cast<uint32_t>(dstX);
        dst.y = static_cast<uint32_t>(dstY);
        dst.width = static_cast<uint32_t>(width);
        dst.height = static_cast<uint32_t>(height);
        dst.depth = 1;
        dst.mipLevel = static_cast<uint32_t>(dstMip);
        nvrhi::TextureSlice src = dst;
        src.x = static_cast<uint32_t>(srcX);
        src.y = static_cast<uint32_t>(srcY);
        src.mipLevel = 0;
        commandList->copyTexture(dstTexture, dst,
            stagingTexture, src);
    }

    // Same, between levels of textures (the same texture's other levels too).
    void Donut_CopyTextureRegion(nvrhi::ICommandList* commandList, nvrhi::ITexture* dstTexture, int dstMip, int dstX, int dstY,
        nvrhi::ITexture* srcTexture, int srcMip, int srcX, int srcY, int width, int height)
    {
        nvrhi::TextureSlice dst;
        dst.x = static_cast<uint32_t>(dstX);
        dst.y = static_cast<uint32_t>(dstY);
        dst.width = static_cast<uint32_t>(width);
        dst.height = static_cast<uint32_t>(height);
        dst.depth = 1;
        dst.mipLevel = static_cast<uint32_t>(dstMip);
        nvrhi::TextureSlice src = dst;
        src.x = static_cast<uint32_t>(srcX);
        src.y = static_cast<uint32_t>(srcY);
        src.mipLevel = static_cast<uint32_t>(srcMip);
        commandList->copyTexture(dstTexture, dst,
            srcTexture, src);
    }

    // Triangle-list pipeline for a framebuffer's layout (Donut_CreateFramebuffer), with an input
    // layout and one binding layout, and NVRHI's default render state: depth test (less) and
    // depth writes on, back faces culled (clockwise triangles are front faces). Returns null on
    // failure.
    nvrhi::IGraphicsPipeline* Donut_CreateGraphicsPipelineForFramebuffer(App* app, nvrhi::IFramebuffer* framebuffer, nvrhi::IShader* vertexShader, nvrhi::IShader* pixelShader,
        nvrhi::IInputLayout* inputLayout, nvrhi::IBindingLayout* bindingLayout)
    {
        nvrhi::GraphicsPipelineDesc desc;
        desc.VS = vertexShader;
        desc.PS = pixelShader;
        desc.inputLayout = inputLayout;
        desc.bindingLayouts = { bindingLayout };
        desc.primType = nvrhi::PrimitiveType::TriangleList;

        App* a = app;
        return a->Own(a->device()->createGraphicsPipeline(desc,
            framebuffer->getFramebufferInfo()));
    }

    // Graphics pipelines of any shape: a description built up with the Donut_GraphicsPipeline*
    // functions below, then consumed (freed) by Donut_CreateGraphicsPipelineFromDesc. It starts as
    // a triangle list with NVRHI's default render state: depth test (less) and depth writes on,
    // back faces culled (clockwise triangles are front faces), solid fill, no blending.
    PipelineDesc* Donut_CreateGraphicsPipelineDesc(nvrhi::IShader* vertexShader, nvrhi::IShader* pixelShader)
    {
        auto* desc = new PipelineDesc();
        desc->VS = vertexShader;
        desc->PS = pixelShader;
        desc->primType = nvrhi::PrimitiveType::TriangleList;
        return desc;
    }

    // Same, for a meshlet pipeline (Donut_CreateMeshletPipelineFromDesc): amplification (optional),
    // mesh and pixel shaders, the rest set with the same functions. Its primitive type is what the
    // mesh shader outputs (its outputtopology).
    PipelineDesc* Donut_CreateMeshletPipelineDesc(nvrhi::IShader* amplificationShader, nvrhi::IShader* meshShader, nvrhi::IShader* pixelShader)
    {
        auto* desc = new PipelineDesc();
        desc->AS = amplificationShader;
        desc->MS = meshShader;
        desc->PS = pixelShader;
        desc->primType = nvrhi::PrimitiveType::TriangleList;
        return desc;
    }

    // A geometry shader between the vertex (or domain) shader and the rasterizer.
    void Donut_GraphicsPipelineSetGeometryShader(PipelineDesc* graphicsPipelineDesc, nvrhi::IShader* geometryShader)
    {
        graphicsPipelineDesc->GS = geometryShader;
    }

    void Donut_GraphicsPipelineAddBindingLayout(PipelineDesc* graphicsPipelineDesc, nvrhi::IBindingLayout* bindingLayout)
    {
        graphicsPipelineDesc->bindingLayouts.push_back(
            bindingLayout);
    }

    void Donut_GraphicsPipelineSetInputLayout(PipelineDesc* graphicsPipelineDesc, nvrhi::IInputLayout* inputLayout)
    {
        graphicsPipelineDesc->inputLayout = inputLayout;
    }

    // primitiveType: an nvrhi::PrimitiveType value.
    void Donut_GraphicsPipelineSetPrimitiveType(PipelineDesc* graphicsPipelineDesc, int primitiveType)
    {
        graphicsPipelineDesc->primType = static_cast<nvrhi::PrimitiveType>(primitiveType);
    }

    // Hull and domain shaders, drawing patches of controlPoints vertices.
    void Donut_GraphicsPipelineSetTessellation(PipelineDesc* graphicsPipelineDesc, nvrhi::IShader* hullShader, nvrhi::IShader* domainShader,
        int controlPoints)
    {
        PipelineDesc* desc = graphicsPipelineDesc;
        desc->HS =hullShader;
        desc->DS = domainShader;
        desc->primType = nvrhi::PrimitiveType::PatchList;
        desc->patchControlPoints = static_cast<uint32_t>(controlPoints);
    }

    static_assert(int(nvrhi::ComparisonFunc::Never) == 1 && int(nvrhi::ComparisonFunc::Greater) == 5
        && int(nvrhi::ComparisonFunc::Always) == 8);

    // depthFunc: an nvrhi::ComparisonFunc value.
    void Donut_GraphicsPipelineSetDepthState(PipelineDesc* graphicsPipelineDesc, int testEnable, int writeEnable, int depthFunc)
    {
        nvrhi::DepthStencilState& state = graphicsPipelineDesc->renderState.depthStencilState;
        state.depthTestEnable = testEnable != 0;
        state.depthWriteEnable = writeEnable != 0;
        state.depthFunc = static_cast<nvrhi::ComparisonFunc>(depthFunc);
    }

    // The depth bounds test: pixels whose depth target value is outside the draw's bounds
    // (Donut_DrawSetDepthBounds) are discarded. Requires Donut_HasDepthBoundsTest.
    void Donut_GraphicsPipelineSetDepthBoundsTest(PipelineDesc* graphicsPipelineDesc, int enable)
    {
        graphicsPipelineDesc->renderState.depthStencilState.depthBoundsTestEnable = enable != 0;
    }

    static_assert(int(nvrhi::RasterCullMode::Back) == 0 && int(nvrhi::RasterCullMode::Front) == 1
        && int(nvrhi::RasterCullMode::None) == 2);
    static_assert(int(nvrhi::RasterFillMode::Solid) == 0 && int(nvrhi::RasterFillMode::Wireframe) == 1);

    // cullMode, fillMode: nvrhi::RasterCullMode and nvrhi::RasterFillMode values.
    void Donut_GraphicsPipelineSetRasterState(PipelineDesc* graphicsPipelineDesc, int cullMode, int fillMode,
        int frontCounterClockwise)
    {
        nvrhi::RasterState& state = graphicsPipelineDesc->renderState.rasterState;
        state.cullMode = static_cast<nvrhi::RasterCullMode>(cullMode);
        state.fillMode = static_cast<nvrhi::RasterFillMode>(fillMode);
        state.frontCounterClockwise = frontCounterClockwise != 0;
    }

    // Whether primitives are clipped at the near and far planes (Vulkan's default, as without
    // VK_EXT_depth_clip_enable) or not (NVRHI's default: on D3D, depth beyond them is clamped and
    // what's between the eye and the near plane drawn). Off by default.
    void Donut_GraphicsPipelineSetDepthClip(PipelineDesc* graphicsPipelineDesc, int enable)
    {
        graphicsPipelineDesc->renderState.rasterState.depthClipEnable = enable != 0;
    }

    // Depth bias: depthBias units of the depth format's resolution, plus slopeScaledDepthBias times
    // the triangle's depth slope, clamped to depthBiasClamp in magnitude (0 for no clamp).
    void Donut_GraphicsPipelineSetDepthBias(PipelineDesc* graphicsPipelineDesc, int depthBias, double depthBiasClamp,
        double slopeScaledDepthBias)
    {
        nvrhi::RasterState& state = graphicsPipelineDesc->renderState.rasterState;
        state.depthBias = depthBias;
        state.depthBiasClamp = float(depthBiasClamp);
        state.slopeScaledDepthBias = float(slopeScaledDepthBias);
    }

    // Conservative rasterization (enable non-zero; requires Feature.ConservativeRasterization): every
    // pixel a triangle touches at all is drawn. extraOverestimation enlarges the triangles further,
    // in pixels, on Vulkan (extraPrimitiveOverestimationSize, clamped to the device's maximum); D3D
    // has no such setting.
    void Donut_GraphicsPipelineSetConservativeRaster(PipelineDesc* graphicsPipelineDesc, int enable, double extraOverestimation)
    {
        nvrhi::RasterState& state = graphicsPipelineDesc->renderState.rasterState;
        state.conservativeRasterEnable = enable != 0;
        state.conservativeRasterExtraOverestimation = float(extraOverestimation);
    }

    // Primitive restart: strips restart at the largest index of indexFormat (Format R16_UINT:
    // 0xFFFF, R32_UINT: 0xFFFFFFFF; UNKNOWN for none), the format of the index buffers the pipeline
    // draws with (D3D12 needs it; D3D11 always restarts strips).
    void Donut_GraphicsPipelineSetPrimitiveRestart(PipelineDesc* graphicsPipelineDesc, int indexFormat)
    {
        graphicsPipelineDesc->primitiveRestartIndexFormat = static_cast<nvrhi::Format>(indexFormat);
    }

    // How lines are drawn: their rasterization mode (LineRasterizationMode: 0 default, 1
    // rectangular, 2 Bresenham, 3 smooth; Donut_GetLineRasterizationModes tells which the device
    // has), width (up to Donut_GetMaxLineWidth) and stipple (stippleEnable non-zero: each bit of the
    // 16-bit pattern, from the lowest, a run of stippleFactor pixels drawn if set). D3D draws
    // rectangular lines as quadrilateral lines (multisampling on), Bresenham ones aliased, smooth ones
    // alpha antialiased; it has no width or stipple.
    void Donut_GraphicsPipelineSetLineRasterization(PipelineDesc* graphicsPipelineDesc, int mode, double width, int stippleEnable,
        int stippleFactor, int stipplePattern)
    {
        nvrhi::RasterState& state = graphicsPipelineDesc->renderState.rasterState;
        state.lineRasterizationMode = static_cast<nvrhi::LineRasterizationMode>(mode);
        state.lineWidth = float(width);
        state.setLineStipple(stippleEnable != 0, uint32_t(stippleFactor), uint16_t(stipplePattern));
        state.multisampleEnable = state.lineRasterizationMode == nvrhi::LineRasterizationMode::Rectangular;
        state.antialiasedLineEnable = state.lineRasterizationMode == nvrhi::LineRasterizationMode::Smooth;
    }

    // Which channels every color target writes: ColorMask bits (red 1, green 2, blue 4, alpha 8; 0 for
    // none, e.g. for a pass whose pixel shader only writes UAVs).
    void Donut_GraphicsPipelineSetColorWriteMask(PipelineDesc* graphicsPipelineDesc, int mask)
    {
        for (nvrhi::BlendState::RenderTarget& target : graphicsPipelineDesc->renderState.blendState.targets)
            target.setColorWriteMask(static_cast<nvrhi::ColorMask>(mask));
    }

    // The channels one render target (SV_Target<target>) is written in (ColorMask bits; 0 writes
    // nothing to it).
    void Donut_GraphicsPipelineSetTargetColorWriteMask(PipelineDesc* graphicsPipelineDesc, int target, int mask)
    {
        graphicsPipelineDesc->renderState.blendState.targets[target]
            .setColorWriteMask(static_cast<nvrhi::ColorMask>(mask));
    }

    // A logic operation (a LogicOp value: nvrhi::LogicOp, Vulkan's order) between the pixel shader's
    // output and the targets' bits, instead of blending (Donut_HasLogicOps; UINT and UNORM targets).
    void Donut_GraphicsPipelineSetLogicOp(PipelineDesc* graphicsPipelineDesc, int enable, int logicOp)
    {
        nvrhi::BlendState& state = graphicsPipelineDesc->renderState.blendState;
        state.logicOpEnable = enable != 0;
        state.logicOp = static_cast<nvrhi::LogicOp>(logicOp);
    }

    // Blending of every color target with blendMode (a BlendMode value, see SetBlendMode).
    void Donut_GraphicsPipelineSetBlendMode(PipelineDesc* graphicsPipelineDesc, int blendMode)
    {
        for (nvrhi::BlendState::RenderTarget& target : graphicsPipelineDesc->renderState.blendState.targets)
            SetBlendMode(target, blendMode);
    }

    // Blending of every color target, on or off (enable), by blend factors (nvrhi::BlendFactor
    // values) and operations (nvrhi::BlendOp values) of the color and of the alpha. The color
    // write mask stays.
    void Donut_GraphicsPipelineSetBlendState(PipelineDesc* graphicsPipelineDesc, int enable, int srcBlend, int destBlend,
        int blendOp, int srcBlendAlpha, int destBlendAlpha, int blendOpAlpha)
    {
        for (nvrhi::BlendState::RenderTarget& target : graphicsPipelineDesc->renderState.blendState.targets)
        {
            target
                .setBlendEnable(enable != 0)
                .setSrcBlend(static_cast<nvrhi::BlendFactor>(srcBlend))
                .setDestBlend(static_cast<nvrhi::BlendFactor>(destBlend))
                .setBlendOp(static_cast<nvrhi::BlendOp>(blendOp))
                .setSrcBlendAlpha(static_cast<nvrhi::BlendFactor>(srcBlendAlpha))
                .setDestBlendAlpha(static_cast<nvrhi::BlendFactor>(destBlendAlpha))
                .setBlendOpAlpha(static_cast<nvrhi::BlendOp>(blendOpAlpha));
        }
    }

    // An advanced blend operation for the targets that blend, instead of their factors and
    // operations (Vulkan with Donut_GetAdvancedBlendOperations): its number from
    // VK_BLEND_OP_ZERO_EXT (0 Zero, 1 Src, ... 45 Blue; -1 for none), whether the source and the
    // destination colors are premultiplied by their alpha, and their overlap (VkBlendOverlapEXT:
    // 0 uncorrelated, 1 disjoint, 2 conjoint).
    void Donut_GraphicsPipelineSetAdvancedBlendOp(PipelineDesc* graphicsPipelineDesc, int advancedBlendOp, int srcPremultiplied,
        int dstPremultiplied, int overlap)
    {
        graphicsPipelineDesc->renderState.blendState.setAdvancedBlendOp(
            static_cast<int8_t>(advancedBlendOp), srcPremultiplied != 0, dstPremultiplied != 0, static_cast<uint8_t>(overlap));
    }

    // For a framebuffer's layout (Donut_CreateFramebuffer); frees the description. Returns null on
    // failure.
    nvrhi::IGraphicsPipeline* Donut_CreateGraphicsPipelineFromDesc(App* app, PipelineDesc* graphicsPipelineDesc, nvrhi::IFramebuffer* framebuffer)
    {
        std::unique_ptr<PipelineDesc> desc(graphicsPipelineDesc);
        App* a = app;
        return a->Own(a->device()->createGraphicsPipeline(*desc,
            framebuffer->getFramebufferInfo()));
    }

    // Same, for the frame's framebuffer (the back buffer's layout); frees the description. Returns
    // null on failure.
    nvrhi::IGraphicsPipeline* Donut_CreateGraphicsPipelineFromDescForFrame(App* app, PipelineDesc* graphicsPipelineDesc, FrameContext* frame)
    {
        std::unique_ptr<PipelineDesc> desc(graphicsPipelineDesc);
        App* a = app;
        return a->Own(a->device()->createGraphicsPipeline(*desc, frame->framebuffer->getFramebufferInfo()));
    }

    // Owned by the app; null on failure.
    static nvrhi::IMeshletPipeline* CreateMeshletPipeline(App* a, const PipelineDesc& desc, const nvrhi::FramebufferInfo& framebufferInfo)
    {
        nvrhi::MeshletPipelineDesc meshletDesc;
        meshletDesc.primType = desc.primType;
        meshletDesc.AS = desc.AS;
        meshletDesc.MS = desc.MS;
        meshletDesc.PS = desc.PS;
        meshletDesc.renderState = desc.renderState;
        meshletDesc.bindingLayouts = desc.bindingLayouts;
        return a->Own(a->device()->createMeshletPipeline(meshletDesc, framebufferInfo));
    }

    // A meshlet pipeline from a Donut_CreateMeshletPipelineDesc description (which it frees), for a
    // framebuffer's layout; requires nvrhi::Feature::Meshlets. Returns null on failure.
    nvrhi::IMeshletPipeline* Donut_CreateMeshletPipelineFromDesc(App* app, PipelineDesc* graphicsPipelineDesc, nvrhi::IFramebuffer* framebuffer)
    {
        std::unique_ptr<PipelineDesc> desc(graphicsPipelineDesc);
        return CreateMeshletPipeline(app, *desc, framebuffer->getFramebufferInfo());
    }

    // Same, for the frame's framebuffer (the back buffer's layout).
    nvrhi::IMeshletPipeline* Donut_CreateMeshletPipelineFromDescForFrame(App* app, PipelineDesc* graphicsPipelineDesc, FrameContext* frame)
    {
        std::unique_ptr<PipelineDesc> desc(graphicsPipelineDesc);
        return CreateMeshletPipeline(app, *desc, frame->framebuffer->getFramebufferInfo());
    }

    // A binding set for a description (which it frees) from the app's binding cache: created on
    // the first request, reused for identical ones after. Valid until Donut_ClearBindingCache.
    nvrhi::IBindingSet* Donut_GetCachedBindingSet(App* app, nvrhi::BindingSetDesc* bindingSetDesc, nvrhi::IBindingLayout* bindingLayout)
    {
        std::unique_ptr<nvrhi::BindingSetDesc> desc(bindingSetDesc);
        return app->bindingCache()->GetOrCreateBindingSet(*desc, bindingLayout).Get();
    }

    // --- Async compute -----------------------------------------------------------------------

    // A loop that, every intervalMicroseconds, dispatches groupsX x groupsY groups of a compute
    // pipeline on the compute queue (the app needs AppOptions.ComputeQueue), on a C++ worker thread.
    // Each run writes one texture, bound as RWTexture2D at u0, with the run's index (a uint,
    // counting from 0) as push constants at b0; the binding layout must hold exactly those two.
    // Give it textures with Donut_AddAsyncComputeTexture, then start it. Returns null if the
    // device has no compute queue.
    void* Donut_CreateAsyncComputeLoop(App* app, nvrhi::IComputePipeline* computePipeline, nvrhi::IBindingLayout* bindingLayout,
        int groupsX, int groupsY, int intervalMicroseconds)
    {
        App* a = app;
        nvrhi::IDevice* device = a->device();
        if (!device->queryFeatureSupport(nvrhi::Feature::ComputeQueue))
            return nullptr;

        auto loop = std::make_shared<AsyncComputeLoop>();
        loop->device = device;
        loop->pipeline = computePipeline;
        loop->bindingLayout = bindingLayout;
        loop->groupsX = static_cast<uint32_t>(groupsX);
        loop->groupsY = static_cast<uint32_t>(groupsY);
        loop->interval = std::chrono::microseconds(intervalMicroseconds);
        loop->bindings = std::make_unique<donut::engine::BindingCache>(device);
        loop->lifetimeTracker = device->createCommandListLifetimeTracker(nvrhi::CommandQueue::Compute);
        loop->commandList = device->createCommandList(nvrhi::CommandListParameters()
            .setEnableImmediateExecution(false)
            .setQueueType(nvrhi::CommandQueue::Compute)
            .setLifetimeTracker(loop->lifetimeTracker));

        return a->OwnObject(loop);
    }

    // Adds a texture (e.g. from Donut_CreateUAVTexture) for the loop to write; call before starting it.
    void Donut_AddAsyncComputeTexture(void* asyncComputeLoop, nvrhi::ITexture* texture)
    {
        static_cast<AsyncComputeLoop*>(asyncComputeLoop)->renderToCompute.Push(texture, 0);
    }

    // Same, with the binding set (from the loop's binding layout) to run the compute pipeline with
    // when writing it: the texture's UAV at u0, the push constants at b0, and anything else the
    // shader reads (e.g. a color map), instead of the loop's own set of the first two.
    void Donut_AddAsyncComputeTextureWithBindingSet(void* asyncComputeLoop, nvrhi::ITexture* texture, nvrhi::IBindingSet* bindingSet)
    {
        auto* loop = static_cast<AsyncComputeLoop*>(asyncComputeLoop);
        loop->textureBindingSets[texture] = bindingSet;
        loop->renderToCompute.Push(texture, 0);
    }

    // The push constants of the runs from now on (byteSize bytes from data, copied during the call;
    // the binding layout's push constants must be that size), instead of the run index.
    void Donut_SetAsyncComputePushConstants(void* asyncComputeLoop, const void* data, int byteSize)
    {
        auto* loop = static_cast<AsyncComputeLoop*>(asyncComputeLoop);
        std::lock_guard lock(loop->pushConstantsMutex);
        loop->pushConstants.assign(static_cast<const uint8_t*>(data), static_cast<const uint8_t*>(data) + byteSize);
    }

    // Non-zero: the worker starts no more runs until resumed (the run under way finishes).
    void Donut_SetAsyncComputeLoopPaused(void* asyncComputeLoop, int paused)
    {
        static_cast<AsyncComputeLoop*>(asyncComputeLoop)->paused = paused != 0;
    }

    // Runs the worker has submitted so far.
    int Donut_GetAsyncComputeRunCount(void* asyncComputeLoop)
    {
        return static_cast<int>(static_cast<AsyncComputeLoop*>(asyncComputeLoop)->runCount.load());
    }

    void Donut_StartAsyncComputeLoop(void* asyncComputeLoop)
    {
        auto* loop = static_cast<AsyncComputeLoop*>(asyncComputeLoop);
        loop->thread = std::thread([loop]() { loop->ThreadProc(); });
    }

    // Stops and joins the worker thread; call it before Donut_DestroyApp (releasing or destroying
    // the loop also does).
    void Donut_StopAsyncComputeLoop(void* asyncComputeLoop)
    {
        static_cast<AsyncComputeLoop*>(asyncComputeLoop)->Stop();
    }

    // Inside a render callback: if the loop finished a texture, switches to it (making the frame's
    // command list wait for the compute queue) and returns the texture shown until then to the
    // loop. Returns the texture to show this frame, null until the first one is ready.
    nvrhi::ITexture* Donut_AcquireAsyncComputeTexture(void* asyncComputeLoop, FrameContext* frame)
    {
        auto* loop = static_cast<AsyncComputeLoop*>(asyncComputeLoop);

        nvrhi::TextureHandle newTexture;
        uint64_t newTextureLastUse = 0;
        if (loop->computeToRender.TryPop(newTexture, newTextureLastUse))
        {
            loop->current.Swap(newTexture);
            // The previous frame was the last to use the texture shown until now.
            if (newTexture)
                loop->renderToCompute.Push(std::move(newTexture), frame->previousSubmission);

            loop->device->queueWaitForCommandList(nvrhi::CommandQueue::Graphics, nvrhi::CommandQueue::Compute, newTextureLastUse);
        }

        return loop->current.Get();
    }

    // --- Command lists (for work outside render passes, e.g. in a headless app) --------------

    nvrhi::ICommandList* Donut_CreateCommandList(App* app)
    {
        App* a = app;
        return a->Own(a->device()->createCommandList());
    }

    void Donut_OpenCommandList(nvrhi::ICommandList* commandList)
    {
        commandList->open();
    }

    void Donut_CloseCommandList(nvrhi::ICommandList* commandList)
    {
        commandList->close();
    }

    // The app holds the command list until the GPU has finished it (App::ExecuteCommandList), so
    // it can be released right after.
    void Donut_ExecuteCommandList(App* app, nvrhi::ICommandList* commandList)
    {
        app->ExecuteCommandList(commandList);
    }

    // Draws vertexCount vertices (no vertex buffers, e.g. a triangle over the target from
    // SV_VertexID) with a graphics pipeline into a framebuffer, all of it, with one binding set:
    // for drawing outside the frames, e.g. into a texture's levels at load time.
    void Donut_CommandListDraw(nvrhi::ICommandList* commandList, nvrhi::IGraphicsPipeline* pipeline, nvrhi::IFramebuffer* framebuffer, nvrhi::IBindingSet* bindingSet, int vertexCount)
    {
        auto* fb = framebuffer;
        nvrhi::GraphicsState state;
        state.pipeline = pipeline;
        state.framebuffer = fb;
        state.viewport.addViewportAndScissorRect(fb->getFramebufferInfo().getViewport());
        if (bindingSet)
            state.bindings = { bindingSet };
        nvrhi::ICommandList* list = commandList;
        list->setGraphicsState(state);
        list->draw(nvrhi::DrawArguments().setVertexCount(static_cast<uint32_t>(vertexCount)));
    }

    // A command list for the compute queue (the app needs AppOptions.ComputeQueue), to record each
    // frame and run with Donut_ExecuteFrameComputeWork. Returns null if there's no compute queue.
    nvrhi::ICommandList* Donut_CreateComputeQueueCommandList(App* app)
    {
        App* a = app;
        nvrhi::IDevice* device = a->device();
        if (!device->queryFeatureSupport(nvrhi::Feature::ComputeQueue))
            return nullptr;
        return a->Own(device->createCommandList(nvrhi::CommandListParameters()
            .setEnableImmediateExecution(false)
            .setQueueType(nvrhi::CommandQueue::Compute)));
    }

    // Blocks the CPU until the GPU has finished all submitted work.
    void Donut_WaitForIdle(App* app)
    {
        App* a = app;
        a->device()->waitForIdle();
        a->RetireCommandLists();
    }

    // Uploads byteSize bytes from data (copied during the call) into buffer.
    void Donut_WriteBuffer(nvrhi::ICommandList* commandList, nvrhi::IBuffer* buffer, const void* data, int byteSize)
    {
        commandList->writeBuffer(buffer, data, static_cast<size_t>(byteSize));
    }

    // byteSize bytes of data into a (non-volatile) buffer at byteOffset, e.g. a constant buffer's
    // uints after its floats.
    void Donut_WriteBufferAt(nvrhi::ICommandList* commandList, nvrhi::IBuffer* buffer, int byteOffset, const void* data, int byteSize)
    {
        commandList->writeBuffer(buffer, data, static_cast<size_t>(byteSize),
            static_cast<uint64_t>(byteOffset));
    }

    void Donut_CopyBuffer(nvrhi::ICommandList* commandList, nvrhi::IBuffer* dst, int dstOffset, nvrhi::IBuffer* src, int srcOffset, int byteSize)
    {
        commandList->copyBuffer(dst, static_cast<uint64_t>(dstOffset),
            src, static_cast<uint64_t>(srcOffset), static_cast<uint64_t>(byteSize));
    }

    // Same as Donut_Dispatch, with a descriptor table (Donut_GetDescriptorTable) bound after the
    // binding set, for pipelines with a bindless layout second.
    void Donut_DispatchWithDescriptorTable(nvrhi::ICommandList* commandList, nvrhi::IComputePipeline* computePipeline, nvrhi::IBindingSet* bindingSet, nvrhi::IDescriptorTable* descriptorTable,
        int groupsX, int groupsY, int groupsZ)
    {
        auto state = nvrhi::ComputeState()
            .setPipeline(computePipeline)
            .addBindingSet(bindingSet)
            .addBindingSet(descriptorTable);

        nvrhi::ICommandList* cl = commandList;
        cl->setComputeState(state);
        cl->dispatch(static_cast<uint32_t>(groupsX), static_cast<uint32_t>(groupsY), static_cast<uint32_t>(groupsZ));
    }

    void Donut_Dispatch(nvrhi::ICommandList* commandList, nvrhi::IComputePipeline* computePipeline, nvrhi::IBindingSet* bindingSet, int groupsX, int groupsY, int groupsZ)
    {
        auto state = nvrhi::ComputeState()
            .setPipeline(computePipeline)
            .addBindingSet(bindingSet);

        nvrhi::ICommandList* cl = commandList;
        cl->setComputeState(state);
        cl->dispatch(static_cast<uint32_t>(groupsX), static_cast<uint32_t>(groupsY), static_cast<uint32_t>(groupsZ));
    }

    // Same, with byteSize bytes of push constants from data (the binding set's
    // Donut_BindPushConstants item).
    void Donut_DispatchWithPushConstants(nvrhi::ICommandList* commandList, nvrhi::IComputePipeline* computePipeline, nvrhi::IBindingSet* bindingSet,
        const void* data, int byteSize, int groupsX, int groupsY, int groupsZ)
    {
        auto state = nvrhi::ComputeState()
            .setPipeline(computePipeline)
            .addBindingSet(bindingSet);

        nvrhi::ICommandList* cl = commandList;
        cl->setComputeState(state);
        cl->setPushConstants(data, static_cast<size_t>(byteSize));
        cl->dispatch(static_cast<uint32_t>(groupsX), static_cast<uint32_t>(groupsY), static_cast<uint32_t>(groupsZ));
    }

    // Fills a depth texture (Donut_CreateRenderTargetTexture) with `depth`.
    void Donut_ClearDepth(nvrhi::ICommandList* commandList, nvrhi::ITexture* depthTexture, double depth)
    {
        commandList->clearDepthStencilTexture(depthTexture,
            nvrhi::AllSubresources, true, float(depth), false, 0);
    }

    // Fills a color texture (Donut_CreateRenderTargetTexture) with r, g, b, a.
    void Donut_ClearTextureFloat(nvrhi::ICommandList* commandList, nvrhi::ITexture* texture, double r, double g, double b, double a)
    {
        commandList->clearTextureFloat(texture, nvrhi::AllSubresources,
            nvrhi::Color(float(r), float(g), float(b), float(a)));
    }

    // Names the commands recorded until the matching Donut_EndMarker, for GPU debuggers and profilers.
    void Donut_BeginMarker(nvrhi::ICommandList* commandList, const char* name)
    {
        commandList->beginMarker(name);
    }

    void Donut_EndMarker(nvrhi::ICommandList* commandList)
    {
        commandList->endMarker();
    }

    // --- GPU timer queries ---------------------------------------------------------------------

    // Measures the GPU time between Donut_BeginTimerQuery and Donut_EndTimerQuery. Returns null on
    // failure.
    void* Donut_CreateTimerQuery(App* app)
    {
        App* a = app;
        return a->Own(a->device()->createTimerQuery());
    }

    // Makes a query that has been read (or never used) ready to measure again.
    void Donut_ResetTimerQuery(App* app, void* timerQuery)
    {
        app->device()->resetTimerQuery(static_cast<nvrhi::ITimerQuery*>(timerQuery));
    }

    void Donut_BeginTimerQuery(nvrhi::ICommandList* commandList, void* timerQuery)
    {
        commandList->beginTimerQuery(static_cast<nvrhi::ITimerQuery*>(timerQuery));
    }

    void Donut_EndTimerQuery(nvrhi::ICommandList* commandList, void* timerQuery)
    {
        commandList->endTimerQuery(static_cast<nvrhi::ITimerQuery*>(timerQuery));
    }

    // Non-zero once the GPU has finished the measured commands.
    int Donut_PollTimerQuery(App* app, void* timerQuery)
    {
        return app->device()->pollTimerQuery(static_cast<nvrhi::ITimerQuery*>(timerQuery)) ? 1 : 0;
    }

    // The measured time in seconds; waits for the GPU unless Donut_PollTimerQuery returned non-zero.
    double Donut_GetTimerQueryTime(App* app, void* timerQuery)
    {
        return app->device()->getTimerQueryTime(static_cast<nvrhi::ITimerQuery*>(timerQuery));
    }

    // --- Render passes -----------------------------------------------------------------------

    // Adds a pass drawn after the previously added ones. The app owns it; set its callbacks
    // with the functions below.
    TsRenderPass* Donut_AddPass(App* app)
    {
        App* a = app;
        a->passes.push_back(std::make_unique<TsRenderPass>(a->deviceManager.get()));
        TsRenderPass* pass = a->passes.back().get();
        a->deviceManager->AddRenderPassToBack(pass);
        return pass;
    }

    // By default (as in Donut) animation and rendering pause while the window is unfocused.
    void Donut_SetRunWhenUnfocused(TsRenderPass* pass, int enabled)
    {
        pass->m_RunWhenUnfocused = enabled != 0;
    }

    void Donut_SetRenderCallback(TsRenderPass* pass, RenderFn method, void* thisVal)
    {
        pass->m_Render = { method, thisVal };
    }

    void Donut_SetAnimateCallback(TsRenderPass* pass, AnimateFn method, void* thisVal)
    {
        pass->m_Animate = { method, thisVal };
    }

    // Called before the swap chain is resized; release framebuffer-dependent resources here.
    void Donut_SetBackBufferResizingCallback(TsRenderPass* pass, VoidFn method, void* thisVal)
    {
        pass->m_BackBufferResizing = { method, thisVal };
    }

    // Keys go to the most recently added pass first; the callback returns non-zero if it
    // handled the key, and then passes added before it don't see it.
    void Donut_SetKeyboardCallback(TsRenderPass* pass, KeyboardFn method, void* thisVal)
    {
        pass->m_Keyboard = { method, thisVal };
    }

    // Mouse position in window pixels; same return convention as the keyboard callback.
    void Donut_SetMousePosCallback(TsRenderPass* pass, MousePosFn method, void* thisVal)
    {
        pass->m_MousePos = { method, thisVal };
    }

    // GLFW mouse button and action values; same return convention as the keyboard callback.
    void Donut_SetMouseButtonCallback(TsRenderPass* pass, MouseButtonFn method, void* thisVal)
    {
        pass->m_MouseButton = { method, thisVal };
    }

    // Scroll offsets; same return convention as the keyboard callback.
    void Donut_SetMouseScrollCallback(TsRenderPass* pass, MouseScrollFn method, void* thisVal)
    {
        pass->m_MouseScroll = { method, thisVal };
    }

    // --- ImGui --------------------------------------------------------------------------------

    // Adds Donut's ImGui renderer as a pass drawn after the previously added ones (on top), which
    // sees input before them; buildUI is called every frame to build the UI with the Donut_ImGui*
    // functions below. Returns null if the renderer can't be initialized.
    void* Donut_AddImGuiPass(App* app, VoidFn buildUI, void* thisVal)
    {
        App* a = app;
        auto pass = std::make_unique<TsImGuiPass>(a->deviceManager.get());
        if (!pass->Init(a->shaderFactory))
            return nullptr;
        pass->m_BuildUI = { buildUI, thisVal };

        TsImGuiPass* raw = pass.get();
        a->otherPasses.push_back(std::move(pass));
        a->deviceManager->AddRenderPassToBack(raw);
        return raw;
    }

    // Draws the UI into framebuffer (e.g. an HDR scene's, Donut_CreateFramebuffer) instead of the
    // back buffer, from the next frame on; null: the back buffer again. Passes added after the
    // ImGui pass draw after it (e.g. one that takes that framebuffer's texture to the back buffer).
    void Donut_SetImGuiPassFramebuffer(void* imguiPass, nvrhi::IFramebuffer* framebuffer)
    {
        static_cast<TsImGuiPass*>(imguiPass)->m_Framebuffer = framebuffer;
    }

    // Keyboard navigation of the ImGui windows (Tab, arrows, Enter or Space to activate, Escape),
    // as ImGuiConfigFlags_NavEnableKeyboard; after Donut_AddImGuiPass (which creates the context).
    // ImGui then takes the keyboard while one of its windows has the focus.
    void Donut_ImGuiSetKeyboardNavigation(int enable)
    {
        ImGuiIO& io = ImGui::GetIO();
        if (enable)
            io.ConfigFlags |= ImGuiConfigFlags_NavEnableKeyboard;
        else
            io.ConfigFlags &= ~ImGuiConfigFlags_NavEnableKeyboard;
    }

    // Only inside the buildUI callback.
    void Donut_ImGuiSetNextWindowPos(double x, double y)
    {
        ImGui::SetNextWindowPos(ImVec2(float(x), float(y)), 0);
    }

    // autoResize != 0: the window fits its contents. Always pair with Donut_ImGuiEnd.
    void Donut_ImGuiBegin(const char* title, int autoResize)
    {
        ImGui::Begin(title, nullptr, autoResize ? ImGuiWindowFlags_AlwaysAutoResize : 0);
    }

    void Donut_ImGuiEnd()
    {
        ImGui::End();
    }

    void Donut_ImGuiText(const char* text)
    {
        ImGui::TextUnformatted(text);
    }

    void Donut_ImGuiSeparator()
    {
        ImGui::Separator();
    }

    void Donut_ImGuiIndent()
    {
        ImGui::Indent();
    }

    void Donut_ImGuiUnindent()
    {
        ImGui::Unindent();
    }

    void Donut_ImGuiPushItemWidth(double width)
    {
        ImGui::PushItemWidth(float(width));
    }

    void Donut_ImGuiPopItemWidth()
    {
        ImGui::PopItemWidth();
    }

    // Returns the checkbox's new state (value, unless it was clicked).
    int Donut_ImGuiCheckbox(const char* label, int value)
    {
        bool checked = value != 0;
        ImGui::Checkbox(label, &checked);
        return checked ? 1 : 0;
    }

    // Returns non-zero if the button was clicked.
    int Donut_ImGuiButton(const char* label)
    {
        return ImGui::Button(label) ? 1 : 0;
    }

    // A combo box of '|'-separated items; returns the new selection (current, unless changed).
    int Donut_ImGuiCombo(const char* label, int current, const char* items)
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

    // A combo box with custom items: returns non-zero while its list is open; then add
    // Donut_ImGuiSelectable items and call Donut_ImGuiEndCombo.
    int Donut_ImGuiBeginCombo(const char* label, const char* preview)
    {
        return ImGui::BeginCombo(label, preview) ? 1 : 0;
    }

    // A color editor of 4 floats at values (RGBA, edited as floats), width pixels wide (0 for the
    // default); returns non-zero if they changed.
    int Donut_ImGuiColorEdit4(const char* label, float* values, double width)
    {
        ImGui::PushItemWidth(float(width));
        const bool changed = ImGui::ColorEdit4(label, values, ImGuiColorEditFlags_Float);
        ImGui::PopItemWidth();
        return changed ? 1 : 0;
    }

    // A color picker of 3 floats (RGB, unbounded: HDR) without previews, as Vulkan-Samples'
    // Drawer::color_op<Pick>; non-zero when changed.
    int Donut_ImGuiColorPicker3(const char* label, float* values, double width)
    {
        ImGui::PushItemWidth(float(width));
        const bool changed = ImGui::ColorPicker3(label, values, ImGuiColorEditFlags_NoSidePreview
            | ImGuiColorEditFlags_NoSmallPreview | ImGuiColorEditFlags_Float | ImGuiColorEditFlags_HDR);
        ImGui::PopItemWidth();
        return changed ? 1 : 0;
    }

    // Scopes the IDs of the widgets that follow (ones with the same labels apart) until the
    // matching Donut_ImGuiPopID.
    void Donut_ImGuiPushID(int id)
    {
        ImGui::PushID(id);
    }

    void Donut_ImGuiPopID()
    {
        ImGui::PopID();
    }

    // A radio button shown selected when active is non-zero; returns non-zero if it was clicked.
    int Donut_ImGuiRadioButton(const char* label, int active)
    {
        return ImGui::RadioButton(label, active != 0) ? 1 : 0;
    }

    // Returns non-zero if the item was clicked.
    int Donut_ImGuiSelectable(const char* label, int selected)
    {
        return ImGui::Selectable(label, selected != 0) ? 1 : 0;
    }

    void Donut_ImGuiEndCombo()
    {
        ImGui::EndCombo();
    }

    // Edits 3 floats at values (Ref of a `let` f32 array element) by dragging; returns non-zero
    // if they changed.
    int Donut_ImGuiDragFloat3(const char* label, void* values, double speed)
    {
        return ImGui::DragFloat3(label, static_cast<float*>(values), float(speed)) ? 1 : 0;
    }

    // Places the next window with its pivot (0..1 of its size; 1, 0 = top right corner) at x, y.
    void Donut_ImGuiSetNextWindowPosPivot(double x, double y, double pivotX, double pivotY)
    {
        ImGui::SetNextWindowPos(ImVec2(float(x), float(y)), 0, ImVec2(float(pivotX), float(pivotY)));
    }

    // A slider; returns the new value (value, unless it was moved).
    double Donut_ImGuiSliderFloat(const char* label, double value, double min, double max)
    {
        float v = float(value);
        ImGui::SliderFloat(label, &v, float(min), float(max));
        return v;
    }

    int Donut_ImGuiSliderInt(const char* label, int value, int min, int max)
    {
        ImGui::SliderInt(label, &value, min, max);
        return value;
    }

    // ImGui::SameLine(offsetFromStartX): the next item on this line, offsetFromStartX pixels from
    // the window's left (0: right after the previous item).
    void Donut_ImGuiSameLineAt(double offsetFromStartX)
    {
        ImGui::SameLine(float(offsetFromStartX));
    }

    // The text color of the items that follow, until Donut_ImGuiPopStyleColor.
    void Donut_ImGuiPushTextColor(double r, double g, double b, double a)
    {
        ImGui::PushStyleColor(ImGuiCol_Text, ImVec4(float(r), float(g), float(b), float(a)));
    }

    void Donut_ImGuiPopStyleColor()
    {
        ImGui::PopStyleColor();
    }

    // A window drawn over the scene at (x, y), width x height: no title bar, background or
    // scrollbars, not movable, ignoring the mouse (an overlay graph). Pair with Donut_ImGuiEnd.
    void Donut_ImGuiBeginOverlay(const char* title, double x, double y, double width, double height)
    {
        ImGui::SetNextWindowPos(ImVec2(float(x), float(y)), ImGuiCond_Always);
        ImGui::SetNextWindowSize(ImVec2(float(width), float(height)), ImGuiCond_Always);
        ImGui::PushStyleColor(ImGuiCol_WindowBg, 0);
        ImGui::PushStyleVar(ImGuiStyleVar_WindowBorderSize, 0.0f);
        ImGui::Begin(title, nullptr, ImGuiWindowFlags_NoMove | ImGuiWindowFlags_NoDecoration | ImGuiWindowFlags_NoInputs);
        ImGui::PopStyleVar();
        ImGui::PopStyleColor();
    }

    // count values (Ref of a `let` f32 array element) as a line graph, starting at valuesOffset
    // (wrapping around), scaleMin at the bottom and scaleMax at the top, width x height pixels;
    // frameBackground 0: without the frame's background.
    void Donut_ImGuiPlotLines(const char* label, const float* values, int count, int valuesOffset, double scaleMin,
        double scaleMax, double width, double height, int frameBackground)
    {
        if (!frameBackground)
            ImGui::PushStyleColor(ImGuiCol_FrameBg, 0);
        ImGui::PlotLines(label, values, count, valuesOffset, nullptr, float(scaleMin), float(scaleMax),
            ImVec2(float(width), float(height)));
        if (!frameBackground)
            ImGui::PopStyleColor();
    }

    // A value edited by dragging (speed per pixel), clamped to min .. max; returns the new value.
    double Donut_ImGuiDragFloat(const char* label, double value, double speed, double min, double max)
    {
        float v = float(value);
        ImGui::DragFloat(label, &v, float(speed), float(min), float(max));
        return v;
    }

    // A number field with - and + buttons that step it by `step`, shown with a printf format
    // ("%.3f"); returns the new value.
    double Donut_ImGuiInputFloat(const char* label, double value, double step, const char* format)
    {
        float v = float(value);
        ImGui::InputFloat(label, &v, float(step), 0.f, format);
        return v;
    }

    // Returns non-zero while the header is expanded (show its contents then).
    int Donut_ImGuiCollapsingHeader(const char* label)
    {
        return ImGui::CollapsingHeader(label) ? 1 : 0;
    }

    // Same, expanded until the user collapses it.
    int Donut_ImGuiCollapsingHeaderDefaultOpen(const char* label)
    {
        return ImGui::CollapsingHeader(label, ImGuiTreeNodeFlags_DefaultOpen) ? 1 : 0;
    }

    // The next item goes on the same line as the previous one.
    void Donut_ImGuiSameLine()
    {
        ImGui::SameLine();
    }

    // Ends the line: the next item starts on a new one (after Donut_ImGuiSameLine, an empty line).
    void Donut_ImGuiNewLine()
    {
        ImGui::NewLine();
    }

    // A scrolling region of width x height pixels (0: the rest of the window); end it with
    // Donut_ImGuiEndChild whatever this returns.
    int Donut_ImGuiBeginChild(const char* id, double width, double height, int border)
    {
        return ImGui::BeginChild(id, ImVec2(float(width), float(height)),
            border != 0 ? ImGuiChildFlags_Borders : ImGuiChildFlags_None) ? 1 : 0;
    }

    void Donut_ImGuiEndChild()
    {
        ImGui::EndChild();
    }

    // Inside a combo box: scrolls to the last item when the list opens.
    void Donut_ImGuiSetItemDefaultFocus()
    {
        ImGui::SetItemDefaultFocus();
    }

    // Height of the current font in pixels.
    double Donut_ImGuiGetFontSize()
    {
        return ImGui::GetFontSize();
    }

    // Loads a TrueType font (path relative to the executable's directory) at a size in pixels,
    // for Donut_ImGuiPushFont. Call right after Donut_AddImGuiPass, before the first frame.
    // Returns null if the file can't be read.
    void* Donut_ImGuiCreateFont(void* imguiPass, const char* path, double size)
    {
        donut::vfs::NativeFileSystem fs;
        auto font = static_cast<TsImGuiPass*>(imguiPass)->CreateFontFromFile(fs, GetExecutablePath().parent_path() / path, float(size));
        return font.get();
    }

    // Draws with a font from Donut_ImGuiCreateFont until Donut_ImGuiPopFont.
    void Donut_ImGuiPushFont(void* font)
    {
        ImGui::PushFont(static_cast<donut::app::RegisteredFont*>(font)->GetScaledFont());
    }

    void Donut_ImGuiPopFont()
    {
        ImGui::PopFont();
    }

    // Text at (x, y) in UI coordinates (its top-left corner, or with alignRight its top-right one) in
    // the current font and color (r, g, b, a), on the background draw list: behind the windows, no
    // window needed.
    void Donut_ImGuiDrawText(double x, double y, const char* text, double r, double g, double b, double a, int alignRight)
    {
        ImVec2 position{ float(x), float(y) };
        if (alignRight)
            position.x -= ImGui::CalcTextSize(text).x;
        ImGui::GetBackgroundDrawList()->AddText(ImGui::GetFont(), ImGui::GetFontSize(), position,
            ImGui::GetColorU32(ImVec4(float(r), float(g), float(b), float(a))), text);
    }

    // A filled rectangle from (x0, y0) to (x1, y1) in UI coordinates, behind the windows and over
    // what was drawn behind them before (e.g. a box under Donut_ImGuiDrawText's text).
    void Donut_ImGuiDrawRect(double x0, double y0, double x1, double y1, double r, double g, double b, double a)
    {
        ImGui::GetBackgroundDrawList()->AddRectFilled(ImVec2(float(x0), float(y0)), ImVec2(float(x1), float(y1)),
            ImGui::GetColorU32(ImVec4(float(r), float(g), float(b), float(a))));
    }

    // The width of a line of text in the current font, in UI coordinates.
    double Donut_ImGuiCalcTextWidth(const char* text)
    {
        return ImGui::CalcTextSize(text).x;
    }

    // A borderless window covering the screen, e.g. for a loading message; pair with
    // Donut_ImGuiEndFullScreenWindow.
    void Donut_ImGuiBeginFullScreenWindow(void* imguiPass)
    {
        static_cast<TsImGuiPass*>(imguiPass)->BeginFullScreenWindow();
    }

    // Text (may span lines) centered on the screen, inside the full-screen window.
    void Donut_ImGuiDrawScreenCenteredText(void* imguiPass, const char* text)
    {
        static_cast<TsImGuiPass*>(imguiPass)->DrawScreenCenteredText(text);
    }

    void Donut_ImGuiEndFullScreenWindow(void* imguiPass)
    {
        static_cast<TsImGuiPass*>(imguiPass)->EndFullScreenWindow();
    }

    // Donut's material editor widgets, for a scene material; allowDomainChanges != 0 lets it
    // change the domain (opaque, alpha tested, ...). Returns non-zero if the material changed.
    int Donut_ImGuiMaterialEditor(void* material, int allowDomainChanges)
    {
        return donut::app::MaterialEditor(static_cast<donut::engine::Material*>(material), allowDomainChanges != 0) ? 1 : 0;
    }

    // Donut's light editor widgets, for a scene light. Returns non-zero if the light changed.
    int Donut_ImGuiLightEditor(void* light)
    {
        return donut::app::LightEditor(*static_cast<donut::engine::Light*>(light)) ? 1 : 0;
    }

    // The system's open (open != 0) or save file dialog, with '|'-separated filter pairs like
    // "BMP files|*.bmp|All files|*.*". Returns the chosen path, or "" if cancelled; valid until
    // the next call.
    const char* Donut_FileDialog(int open, const char* filters)
    {
        // Windows wants the pairs separated by NULs, with an extra NUL at the end.
        std::string zeroSeparated(filters);
        for (char& c : zeroSeparated)
            if (c == '|')
                c = '\0';
        zeroSeparated.push_back('\0');
        zeroSeparated.push_back('\0');

        static std::string storage;
        std::string fileName;
        return ReturnString(storage, donut::app::FileDialog(open != 0, zeroSeparated.c_str(), fileName) ? fileName : std::string());
    }

    // --- C++ objects (owned by the app until released or the app is destroyed) -------------

    void Donut_ReleaseObject(App* app, void* object)
    {
        app->objects.erase(object);
    }

    // Loads a scene (glTF or Donut's .scene.json; path relative to the executable's directory,
    // or absolute) on the app's thread pool, then finishes uploading its textures. Returns null
    // (after logging why) on failure.
    void* Donut_LoadScene(App* app, const char* path)
    {
        App* a = app;
        return LoadScene(a, path, a->textureCache(), nullptr);
    }

    // Bindless ray tracing: a bindless layout (register spaces added with the two functions
    // below), consumed (freed) by Donut_CreateBindlessLayout.
    nvrhi::BindlessLayoutDesc* Donut_CreateBindlessLayoutDesc(int firstSlot, int maxCapacity, int shaderType)
    {
        auto* desc = new nvrhi::BindlessLayoutDesc();
        desc->visibility = static_cast<nvrhi::ShaderType>(shaderType);
        desc->firstSlot = static_cast<uint32_t>(firstSlot);
        desc->maxCapacity = static_cast<uint32_t>(maxCapacity);
        return desc;
    }

    // ByteAddressBuffer[] in register space `space`.
    void Donut_BindlessLayoutAddRawBuffers(nvrhi::BindlessLayoutDesc* bindlessLayoutDesc, int space)
    {
        bindlessLayoutDesc->registerSpaces.push_back(
            nvrhi::BindingLayoutItem::RawBuffer_SRV(static_cast<uint32_t>(space)));
    }

    // Texture2D[] in register space `space`.
    void Donut_BindlessLayoutAddTextures(nvrhi::BindlessLayoutDesc* bindlessLayoutDesc, int space)
    {
        bindlessLayoutDesc->registerSpaces.push_back(
            nvrhi::BindingLayoutItem::Texture_SRV(static_cast<uint32_t>(space)));
    }

    // Returns null on failure.
    nvrhi::IBindingLayout* Donut_CreateBindlessLayout(App* app, nvrhi::BindlessLayoutDesc* bindlessLayoutDesc)
    {
        std::unique_ptr<nvrhi::BindlessLayoutDesc> desc(bindlessLayoutDesc);
        App* a = app;
        return a->Own(a->device()->createBindlessLayout(*desc));
    }

    // Donut's DescriptorTableManager: a descriptor table of a bindless layout that scenes loaded
    // with Donut_LoadSceneWithDescriptorTable put their buffers and textures in.
    donut::engine::DescriptorTableManager* Donut_CreateDescriptorTableManager(App* app, nvrhi::IBindingLayout* bindlessLayout)
    {
        App* a = app;
        return a->OwnObject(std::make_shared<donut::engine::DescriptorTableManager>(
            a->device(), bindlessLayout));
    }

    // The table itself, to bind next to a binding set; valid as long as the manager.
    nvrhi::IDescriptorTable* Donut_GetDescriptorTable(donut::engine::DescriptorTableManager* descriptorTableManager)
    {
        return descriptorTableManager->GetDescriptorTable();
    }

    // A descriptor table of a bindless layout without a manager: room for `capacity` descriptors
    // in each of its arrays, written slot by slot with Donut_WriteDescriptorTableTexture.
    nvrhi::IDescriptorTable* Donut_CreateDescriptorTable(App* app, nvrhi::IBindingLayout* bindlessLayout, int capacity)
    {
        App* a = app;
        nvrhi::DescriptorTableHandle table = a->device()->createDescriptorTable(bindlessLayout);
        if (!table)
            return nullptr;
        a->device()->resizeDescriptorTable(table, static_cast<uint32_t>(capacity), false);
        return a->Own(table);
    }

    // Writes a texture's descriptor into slot `slot` of a descriptor table's Texture2D array, at
    // once (also into a table bound by command lists still recording or running: the bindless
    // layouts are update-after-bind on Vulkan). 0 if the slot is past the table's capacity.
    int Donut_WriteDescriptorTableTexture(App* app, nvrhi::IDescriptorTable* descriptorTable, int slot, nvrhi::ITexture* texture)
    {
        return app->device()->writeDescriptorTable(descriptorTable,
            nvrhi::BindingSetItem::Texture_SRV(static_cast<uint32_t>(slot), texture)) ? 1 : 0;
    }

    // A C++ std::default_random_engine (std::mt19937 with MSVC's library), for data that samples
    // make with one: the same seed gives the same numbers; a negative seed takes one from
    // std::random_device (different every run).
    void* Donut_CreateRandomEngine(App* app, int seed)
    {
        const auto value = seed >= 0 ? static_cast<std::default_random_engine::result_type>(seed)
                                     : static_cast<std::default_random_engine::result_type>(std::random_device()());
        return app->OwnObject(std::make_shared<std::default_random_engine>(value));
    }

    // count numbers from one std::normal_distribution<float>(mean, stddev) over the engine, into dst
    // (Ref of a `let` f32 array element): one distribution object, as the samples keep it (MSVC's
    // makes values in pairs and keeps the second).
    void Donut_RandomNormalFloats(void* randomEngine, double mean, double stddev, int count, float* dst)
    {
        std::normal_distribution<float> distribution(static_cast<float>(mean), static_cast<float>(stddev));
        auto& engine = *static_cast<std::default_random_engine*>(randomEngine);
        for (int i = 0; i < count; i++)
            dst[i] = distribution(engine);
    }

    // The engine's next number from std::uniform_real_distribution<float>(a, b) (a and b rounded to
    // float as the sample's literals are).
    double Donut_RandomUniformFloat(void* randomEngine, double a, double b)
    {
        return std::uniform_real_distribution<float>(static_cast<float>(a), static_cast<float>(b))(
            *static_cast<std::default_random_engine*>(randomEngine));
    }

    // The engine's next number from std::uniform_int_distribution<int>(a, b) (a fresh distribution
    // object per call, as samples that make one per use).
    int Donut_RandomUniformInt(void* randomEngine, int a, int b)
    {
        return std::uniform_int_distribution<int>(a, b)(*static_cast<std::default_random_engine*>(randomEngine));
    }

    // Same as Donut_LoadScene, also registering the scene's vertex / index buffers and textures in
    // a descriptor table (Donut_CreateDescriptorTableManager), where the scene's geometry and
    // material buffers refer to them by index. Returns null (after logging why) on failure.
    void* Donut_LoadSceneWithDescriptorTable(App* app, const char* path, donut::engine::DescriptorTableManager* descriptorTableManager)
    {
        App* a = app;
        auto descriptorTable = a->SharedObject<donut::engine::DescriptorTableManager>(descriptorTableManager);
        auto textureCache = std::make_shared<donut::engine::TextureCache>(
            a->device(), std::make_shared<donut::vfs::NativeFileSystem>(), descriptorTable);
        return LoadScene(a, path, textureCache, descriptorTable);
    }

    // Values of `which` for Donut_GetSceneBuffer.
    enum SceneBuffer
    {
        SceneBuffer_Instances = 0,
        SceneBuffer_Geometries = 1,
        SceneBuffer_Materials = 2,
    };

    // A loaded scene's structured buffer of InstanceData, GeometryData or MaterialConstants
    // (donut/shaders/bindless.h, material_cb.h); valid as long as the scene.
    nvrhi::IBuffer* Donut_GetSceneBuffer(void* scene, int which)
    {
        auto* s = static_cast<donut::engine::Scene*>(scene);
        switch (which)
        {
        case SceneBuffer_Instances: return s->GetInstanceBuffer();
        case SceneBuffer_Geometries: return s->GetGeometryBuffer();
        case SceneBuffer_Materials: return s->GetMaterialBuffer();
        default: return nullptr;
        }
    }

    // Geometries of a loaded scene, addressed by globalGeometryIndex (0 .. count - 1), e.g. to
    // lay out one shader table entry per geometry in that order.
    int Donut_GetSceneGeometryCount(void* scene)
    {
        int count = 0;
        for (const auto& mesh : static_cast<donut::engine::Scene*>(scene)->GetSceneGraph()->GetMeshes())
            count += static_cast<int>(mesh->geometries.size());
        return count;
    }

    // Buffer<uint> at t<slot>: the geometry's indices (relative to its first vertex).
    void Donut_BindGeometryIndexBuffer(nvrhi::BindingSetDesc* bindingSetDesc, int slot, void* scene, int globalGeometryIndex)
    {
        const SceneGeometry g = FindSceneGeometry(scene, globalGeometryIndex);
        bindingSetDesc->addItem(nvrhi::BindingSetItem::TypedBuffer_SRV(
            static_cast<uint32_t>(slot), g.mesh->buffers->indexBuffer, nvrhi::Format::R32_UINT,
            nvrhi::BufferRange((g.mesh->indexOffset + g.geometry->indexOffsetInMesh) * sizeof(uint32_t),
                g.geometry->numIndices * sizeof(uint32_t))));
    }

    // Values of `attribute` for Donut_BindGeometryVertexAttribute, with the buffer element types.
    enum GeometryAttribute
    {
        GeometryAttribute_Position = 0,  // Buffer<float3>
        GeometryAttribute_TexCoord1 = 1, // Buffer<float2>
        GeometryAttribute_Normal = 2,    // Buffer<float4> (RGBA8_SNORM)
        GeometryAttribute_Tangent = 3,   // Buffer<float4> (RGBA8_SNORM)
    };

    // Buffer<...> at t<slot>: one vertex attribute of the geometry's vertices.
    void Donut_BindGeometryVertexAttribute(nvrhi::BindingSetDesc* bindingSetDesc, int slot, void* scene, int globalGeometryIndex, int attribute)
    {
        using donut::engine::VertexAttribute;
        VertexAttribute vertexAttribute = VertexAttribute::Position;
        nvrhi::Format format = nvrhi::Format::RGB32_FLOAT;
        uint32_t elementSize = sizeof(dm::float3);
        switch (attribute)
        {
        case GeometryAttribute_TexCoord1:
            vertexAttribute = VertexAttribute::TexCoord1; format = nvrhi::Format::RG32_FLOAT; elementSize = sizeof(dm::float2); break;
        case GeometryAttribute_Normal:
            vertexAttribute = VertexAttribute::Normal; format = nvrhi::Format::RGBA8_SNORM; elementSize = sizeof(uint32_t); break;
        case GeometryAttribute_Tangent:
            vertexAttribute = VertexAttribute::Tangent; format = nvrhi::Format::RGBA8_SNORM; elementSize = sizeof(uint32_t); break;
        default:
            break;
        }

        const SceneGeometry g = FindSceneGeometry(scene, globalGeometryIndex);
        const uint64_t firstVertex = g.mesh->vertexOffset + g.geometry->vertexOffsetInMesh;
        bindingSetDesc->addItem(nvrhi::BindingSetItem::TypedBuffer_SRV(
            static_cast<uint32_t>(slot), g.mesh->buffers->vertexBuffer, format,
            nvrhi::BufferRange(firstVertex * elementSize + g.mesh->buffers->getVertexBufferRange(vertexAttribute).byteOffset,
                g.geometry->numVertices * elementSize)));
    }

    // Values of `which` and `fallback` for Donut_BindGeometryMaterialTexture.
    enum MaterialTexture
    {
        MaterialTexture_BaseOrDiffuse = 0,
        MaterialTexture_MetalRoughOrSpecular = 1,
        MaterialTexture_Normal = 2,
        MaterialTexture_Emissive = 3,
        MaterialTexture_Occlusion = 4,
        MaterialTexture_Transmission = 5,
        MaterialTexture_Opacity = 6,
    };

    enum FallbackTexture
    {
        FallbackTexture_White = 0,
        FallbackTexture_Black = 1,
    };

    // Texture2D at t<slot>: one of the geometry's material textures, or Donut's white or black
    // texture if the material has none.
    void Donut_BindGeometryMaterialTexture(App* app, nvrhi::BindingSetDesc* bindingSetDesc, int slot, void* scene, int globalGeometryIndex,
        int which, int fallback)
    {
        const donut::engine::Material& material = *FindSceneGeometry(scene, globalGeometryIndex).geometry->material;
        const std::shared_ptr<donut::engine::LoadedTexture>* textures[] = {
            &material.baseOrDiffuseTexture, &material.metalRoughOrSpecularTexture, &material.normalTexture,
            &material.emissiveTexture, &material.occlusionTexture, &material.transmissionTexture, &material.opacityTexture,
        };
        const std::shared_ptr<donut::engine::LoadedTexture>& texture = *textures[which];

        donut::engine::CommonRenderPasses* passes = app->commonPasses();
        nvrhi::ITexture* bound = texture && texture->texture ? texture->texture.Get()
            : fallback == FallbackTexture_Black ? passes->m_BlackTexture.Get() : passes->m_WhiteTexture.Get();

        bindingSetDesc->addItem(
            nvrhi::BindingSetItem::Texture_SRV(static_cast<uint32_t>(slot), bound));
    }

    // cbuffer at b<slot>: the geometry's MaterialConstants (donut/shaders/material_cb.h).
    void Donut_BindGeometryMaterialConstants(nvrhi::BindingSetDesc* bindingSetDesc, int slot, void* scene, int globalGeometryIndex)
    {
        bindingSetDesc->addItem(nvrhi::BindingSetItem::ConstantBuffer(
            static_cast<uint32_t>(slot), FindSceneGeometry(scene, globalGeometryIndex).geometry->material->materialConstants));
    }

    // Like Donut_BuildSceneAccelStructs (opaque triangles; BLASes kept in the meshes), for shader
    // tables with hitGroupStride entries per geometry, laid out by globalGeometryIndex: each
    // instance's hit groups start at its mesh's first geometry index times hitGroupStride.
    SceneAccelStructs* Donut_BuildSceneAccelStructsWithHitGroupStride(App* app, nvrhi::ICommandList* commandList, void* scene, int hitGroupStride)
    {
        App* a = app;
        nvrhi::ICommandList* cl = commandList;
        const auto& sceneGraph = static_cast<donut::engine::Scene*>(scene)->GetSceneGraph();

        for (const auto& mesh : sceneGraph->GetMeshes())
        {
            nvrhi::rt::AccelStructDesc blasDesc = GetMeshBlasDesc(*mesh);
            blasDesc.buildFlags = nvrhi::rt::AccelStructBuildFlags::None;
            for (auto& geometryDesc : blasDesc.bottomLevelGeometries)
                geometryDesc.flags = nvrhi::rt::GeometryFlags::Opaque;

            nvrhi::rt::AccelStructHandle blas = a->device()->createAccelStruct(blasDesc);
            nvrhi::utils::BuildBottomLevelAccelStruct(cl, blas, blasDesc);
            mesh->accelStruct = blas;
        }

        auto accelStructs = std::make_shared<SceneAccelStructs>();
        accelStructs->topLevel = BuildSceneTLAS(a->device(), cl, *sceneGraph, static_cast<uint32_t>(hitGroupStride));
        return a->OwnObject(accelStructs);
    }

    // A texture file (relative to the executable's directory) loaded and uploaded (with mipmaps
    // generated if the file has none), and registered in a descriptor table
    // (Donut_CreateDescriptorTableManager) for bindless access. It submits its own command list,
    // so call it while no other command list is open. Returns the texture object, or null (after
    // logging why) on failure.
    void* Donut_LoadBindlessTexture(App* app, donut::engine::DescriptorTableManager* descriptorTableManager, const char* path, int sRGB)
    {
        App* a = app;
        std::shared_ptr<donut::engine::TextureCache>& cache = a->bindlessTextureCaches[descriptorTableManager];
        if (!cache)
            cache = std::make_shared<donut::engine::TextureCache>(a->device(), std::make_shared<donut::vfs::NativeFileSystem>(),
                a->SharedObject<donut::engine::DescriptorTableManager>(descriptorTableManager));

        // Deferred, then finished right away, as the sample does: the upload and mipmap generation
        // run on the cache's own command list. (The common passes are created first: creating them
        // opens a command list of their own.)
        donut::engine::CommonRenderPasses& passes = *a->commonPasses();
        std::shared_ptr<donut::engine::LoadedTexture> texture = cache->LoadTextureFromFileDeferred(
            GetExecutablePath().parent_path() / path, sRGB != 0);
        cache->ProcessRenderingThreadCommands(passes, 0.f);
        cache->LoadingFinished();

        if (!texture || !texture->texture)
            return nullptr;
        return a->OwnObject(texture);
    }

    // Index of a Donut_LoadBindlessTexture texture in its descriptor table (the shaders' array index).
    int Donut_GetTextureDescriptorIndex(void* loadedTexture)
    {
        return static_cast<donut::engine::LoadedTexture*>(loadedTexture)->bindlessDescriptor.Get();
    }

    // Loaded scene queries: the number of mesh instances (e.g. to size a TLAS), and a node's
    // world-space position (3 floats into dst; path like "/Emitter"). The latter returns 0 if
    // there's no such node.
    int Donut_GetSceneInstanceCount(void* scene)
    {
        return static_cast<int>(static_cast<donut::engine::Scene*>(scene)->GetSceneGraph()->GetMeshInstances().size());
    }

    int Donut_GetSceneNodePosition(void* scene, const char* path, void* dst)
    {
        auto node = static_cast<donut::engine::Scene*>(scene)->GetSceneGraph()->FindNode(path);
        if (!node)
            return 0;
        const dm::float3 position = node->GetLocalToWorldTransformFloat().m_translation;
        memcpy(dst, &position, sizeof(position));
        return 1;
    }

    // A mesh of one geometry whose vertices (positions + texture coordinates) and indices are
    // replaced every frame with Donut_UpdateDynamicMesh, e.g. particle billboards; room for
    // maxVertices / maxIndices. Its buffers are registered in a descriptor table (for bindless
    // shaders), its material is alpha-blended, and its BLAS is created (not built) at full size.
    // Add it to a scene with Donut_AttachDynamicMesh.
    void* Donut_CreateDynamicMesh(App* app, donut::engine::DescriptorTableManager* descriptorTableManager, int maxVertices, int maxIndices, const char* name)
    {
        using namespace donut::engine;

        App* a = app;
        nvrhi::IDevice* device = a->device();
        auto descriptorTable = a->SharedObject<DescriptorTableManager>(descriptorTableManager);
        auto dynamicMesh = std::make_shared<DynamicMesh>();

        dynamicMesh->buffers = std::make_shared<BufferGroup>();
        BufferGroup& buffers = *dynamicMesh->buffers;

        auto& positionRange = buffers.getVertexBufferRange(VertexAttribute::Position);
        auto& texcoordRange = buffers.getVertexBufferRange(VertexAttribute::TexCoord1);
        positionRange.byteOffset = 0;
        positionRange.byteSize = uint64_t(maxVertices) * sizeof(dm::float3);
        texcoordRange.byteOffset = positionRange.byteOffset + positionRange.byteSize;
        texcoordRange.byteSize = uint64_t(maxVertices) * sizeof(dm::float2);

        nvrhi::BufferDesc bufferDesc;
        bufferDesc.byteSize = uint64_t(maxIndices) * sizeof(uint32_t);
        bufferDesc.debugName = std::string(name) + " Indices";
        bufferDesc.canHaveRawViews = true;
        bufferDesc.initialState = nvrhi::ResourceStates::ShaderResource | nvrhi::ResourceStates::AccelStructBuildInput;
        bufferDesc.keepInitialState = true;
        bufferDesc.isAccelStructBuildInput = true;
        buffers.indexBuffer = device->createBuffer(bufferDesc);

        bufferDesc.byteSize = texcoordRange.byteOffset + texcoordRange.byteSize;
        bufferDesc.debugName = std::string(name) + " Vertices";
        buffers.vertexBuffer = device->createBuffer(bufferDesc);

        buffers.indexBufferDescriptor = std::make_shared<DescriptorHandle>(
            descriptorTable->CreateDescriptorHandle(nvrhi::BindingSetItem::RawBuffer_SRV(0, buffers.indexBuffer)));
        buffers.vertexBufferDescriptor = std::make_shared<DescriptorHandle>(
            descriptorTable->CreateDescriptorHandle(nvrhi::BindingSetItem::RawBuffer_SRV(0, buffers.vertexBuffer)));

        dynamicMesh->material = std::make_shared<Material>();
        dynamicMesh->material->name = std::string(name) + " Material";
        dynamicMesh->material->domain = MaterialDomain::AlphaBlended;

        dynamicMesh->geometry = std::make_shared<MeshGeometry>();
        dynamicMesh->geometry->material = dynamicMesh->material;
        // Full size, so that the BLAS created below fits every later update.
        dynamicMesh->geometry->numVertices = static_cast<uint32_t>(maxVertices);
        dynamicMesh->geometry->numIndices = static_cast<uint32_t>(maxIndices);
        // The scene sizes its own bookkeeping from these, as for loaded meshes.
        buffers.indexData.resize(maxIndices);
        buffers.positionData.resize(maxVertices);
        buffers.texcoord1Data.resize(maxVertices);

        dynamicMesh->mesh = std::make_shared<MeshInfo>();
        dynamicMesh->mesh->name = name;
        dynamicMesh->mesh->buffers = dynamicMesh->buffers;
        dynamicMesh->mesh->geometries = { dynamicMesh->geometry };
        dynamicMesh->mesh->accelStruct = device->createAccelStruct(GetMeshBlasDesc(*dynamicMesh->mesh, true));

        dynamicMesh->instance = std::make_shared<MeshInstance>(dynamicMesh->mesh);

        return a->OwnObject(dynamicMesh);
    }

    // Adds an instance of a dynamic mesh under a loaded scene's root and updates the scene's
    // buffers for it (waiting for the GPU); do it before creating binding sets of those buffers.
    void Donut_AttachDynamicMesh(App* app, void* scene, void* dynamicMesh)
    {
        App* a = app;
        auto* s = static_cast<donut::engine::Scene*>(scene);
        s->GetSceneGraph()->AttachLeafNode(s->GetSceneGraph()->GetRootNode(), static_cast<DynamicMesh*>(dynamicMesh)->instance);

        nvrhi::CommandListHandle commandList = a->device()->createCommandList();
        commandList->open();
        s->Refresh(commandList, a->deviceManager->GetFrameIndex());
        commandList->close();
        a->device()->executeCommandList(commandList);
        a->device()->waitForIdle();
    }

    // The dynamic mesh's diffuse texture (a Donut_LoadBindlessTexture one); the scene's material
    // buffer picks it up at the next Donut_RefreshScene.
    void Donut_SetDynamicMeshTexture(App* app, void* dynamicMesh, void* loadedTexture)
    {
        auto* m = static_cast<DynamicMesh*>(dynamicMesh);
        m->material->baseOrDiffuseTexture = app->SharedObject<donut::engine::LoadedTexture>(loadedTexture);
        m->material->dirty = true;
    }

    // Inside a render callback: replaces the dynamic mesh's contents with vertexCount vertices
    // (positions: 3 floats each, texCoords: 2 floats each) and indexCount uint indices (at most the
    // sizes it was created with), and rebuilds its BLAS.
    void Donut_UpdateDynamicMesh(FrameContext* frame, void* dynamicMesh, const void* positions, const void* texCoords, int vertexCount,
        const void* indices, int indexCount)
    {
        using donut::engine::VertexAttribute;

        auto* m = static_cast<DynamicMesh*>(dynamicMesh);
        nvrhi::ICommandList* cl = frame->commandList;
        donut::engine::BufferGroup& buffers = *m->buffers;

        m->geometry->numVertices = static_cast<uint32_t>(vertexCount);
        m->geometry->numIndices = static_cast<uint32_t>(indexCount);

        if (indexCount > 0)
        {
            cl->writeBuffer(buffers.indexBuffer, indices, size_t(indexCount) * sizeof(uint32_t));
            cl->writeBuffer(buffers.vertexBuffer, positions, size_t(vertexCount) * sizeof(dm::float3),
                buffers.getVertexBufferRange(VertexAttribute::Position).byteOffset);
            cl->writeBuffer(buffers.vertexBuffer, texCoords, size_t(vertexCount) * sizeof(dm::float2),
                buffers.getVertexBufferRange(VertexAttribute::TexCoord1).byteOffset);
        }

        nvrhi::utils::BuildBottomLevelAccelStruct(cl, m->mesh->accelStruct, GetMeshBlasDesc(*m->mesh, true));
    }

    // Builds a BLAS (kept in the mesh's accelStruct) for every mesh of a loaded scene that doesn't
    // have one yet (e.g. not dynamic meshes), into an open command list: geometries not in the
    // Opaque material domain are non-opaque, for ray queries to see as candidates.
    void Donut_BuildSceneBLASes(App* app, nvrhi::ICommandList* commandList, void* scene)
    {
        App* a = app;
        for (const auto& mesh : static_cast<donut::engine::Scene*>(scene)->GetSceneGraph()->GetMeshes())
        {
            if (mesh->accelStruct)
                continue;

            const nvrhi::rt::AccelStructDesc blasDesc = GetMeshBlasDesc(*mesh, true);
            mesh->accelStruct = a->device()->createAccelStruct(blasDesc);
            nvrhi::utils::BuildBottomLevelAccelStruct(commandList, mesh->accelStruct, blasDesc);
        }
    }

    // A BLAS of one procedural AABB, (-1, -1, -1) .. (1, 1, 1), built into an open command list;
    // instance it scaled and moved (Donut_AddTopLevelASInstance) for intersection-shader or ray
    // query primitives.
    nvrhi::rt::IAccelStruct* Donut_CreateUnitAABBBlas(App* app, nvrhi::ICommandList* commandList, const char* debugName)
    {
        App* a = app;
        nvrhi::ICommandList* cl = commandList;

        nvrhi::BufferDesc aabbBufferDesc;
        aabbBufferDesc.byteSize = sizeof(nvrhi::rt::GeometryAABB);
        aabbBufferDesc.initialState = nvrhi::ResourceStates::CopyDest;
        aabbBufferDesc.keepInitialState = true;
        aabbBufferDesc.isAccelStructBuildInput = true;
        nvrhi::BufferHandle aabbBuffer = a->device()->createBuffer(aabbBufferDesc);

        const nvrhi::rt::GeometryAABB aabb = { -1.f, -1.f, -1.f, 1.f, 1.f, 1.f };
        cl->writeBuffer(aabbBuffer, &aabb, sizeof(aabb));

        nvrhi::rt::AccelStructDesc blasDesc;
        blasDesc.isTopLevel = false;
        blasDesc.debugName = debugName;
        blasDesc.addBottomLevelGeometry(nvrhi::rt::GeometryDesc().setAABBs(
            nvrhi::rt::GeometryAABBs().setBuffer(aabbBuffer).setCount(1)));

        nvrhi::rt::AccelStructHandle blas = a->device()->createAccelStruct(blasDesc);
        nvrhi::utils::BuildBottomLevelAccelStruct(cl, blas, blasDesc);
        return a->Own(blas);
    }

    // A TLAS of up to maxInstances instances, rebuilt from instances added with the functions
    // below by Donut_BuildTopLevelAS. Get the TLAS with Donut_GetSceneTopLevelAS.
    SceneAccelStructs* Donut_CreateTopLevelAS(App* app, int maxInstances)
    {
        App* a = app;
        auto accelStructs = std::make_shared<SceneAccelStructs>();
        nvrhi::rt::AccelStructDesc tlasDesc;
        tlasDesc.isTopLevel = true;
        tlasDesc.topLevelMaxInstances = static_cast<size_t>(maxInstances);
        accelStructs->topLevel = a->device()->createAccelStruct(tlasDesc);
        return a->OwnObject(accelStructs);
    }

    // Same, built with buildFlags (AccelStructBuildFlags bits, e.g. AllowUpdate for
    // Donut_UpdateTopLevelAS, PreferFastBuild).
    SceneAccelStructs* Donut_CreateTopLevelASWithFlags(App* app, int maxInstances, int buildFlags)
    {
        App* a = app;
        auto accelStructs = std::make_shared<SceneAccelStructs>();
        nvrhi::rt::AccelStructDesc tlasDesc;
        tlasDesc.isTopLevel = true;
        tlasDesc.topLevelMaxInstances = static_cast<size_t>(maxInstances);
        tlasDesc.buildFlags = static_cast<nvrhi::rt::AccelStructBuildFlags>(buildFlags);
        tlasDesc.debugName = "TopLevelAS";
        accelStructs->topLevel = a->device()->createAccelStruct(tlasDesc);
        return a->OwnObject(accelStructs);
    }

    // Adds all mesh instances of a loaded scene (instance ID = instance index; meshes' BLASes from
    // Donut_BuildSceneBLASes), with instanceMask, except dynamicMesh's (if not null) with
    // dynamicMeshMask.
    void Donut_AddSceneTopLevelASInstances(SceneAccelStructs* sceneAccelStructs, void* scene, int instanceMask,
        void* dynamicMesh, int dynamicMeshMask)
    {
        auto* accelStructs = sceneAccelStructs;
        const donut::engine::MeshInfo* special = dynamicMesh ? static_cast<DynamicMesh*>(dynamicMesh)->mesh.get() : nullptr;

        for (const auto& instance : static_cast<donut::engine::Scene*>(scene)->GetSceneGraph()->GetMeshInstances())
        {
            nvrhi::rt::InstanceDesc instanceDesc;
            instanceDesc.bottomLevelAS = instance->GetMesh()->accelStruct;
            instanceDesc.instanceMask = static_cast<uint32_t>(instance->GetMesh().get() == special ? dynamicMeshMask : instanceMask);
            instanceDesc.instanceID = instance->GetInstanceIndex();
            dm::affineToColumnMajor(instance->GetNode()->GetLocalToWorldTransformFloat(), instanceDesc.transform);
            accelStructs->pendingInstances.push_back(instanceDesc);
        }
    }

    // Adds an instance of a BLAS, uniformly scaled by `scale`, then moved to (x, y, z).
    void Donut_AddTopLevelASInstance(SceneAccelStructs* sceneAccelStructs, nvrhi::rt::IAccelStruct* bottomLevelAS, int instanceMask, int instanceID,
        double scale, double x, double y, double z)
    {
        nvrhi::rt::InstanceDesc instanceDesc;
        instanceDesc.bottomLevelAS = bottomLevelAS;
        instanceDesc.instanceMask = static_cast<uint32_t>(instanceMask);
        instanceDesc.instanceID = static_cast<uint32_t>(instanceID);
        const dm::affine3 transform = dm::scaling(dm::float3(float(scale))) * dm::translation(dm::float3(float(x), float(y), float(z)));
        dm::affineToColumnMajor(transform, instanceDesc.transform);
        sceneAccelStructs->pendingInstances.push_back(instanceDesc);
    }

    // Adds an instance of a BLAS with a transform (12 floats: a row-major 3x4 matrix, the
    // translation in the last column, as Vulkan's VkTransformMatrixKHR) and instance flags
    // (nvrhi::rt::InstanceFlags bits, e.g. 1 = no triangle culling).
    void Donut_AddTopLevelASInstanceWithTransform(SceneAccelStructs* sceneAccelStructs, nvrhi::rt::IAccelStruct* bottomLevelAS, int instanceMask, int instanceID,
        int flags, const void* transform)
    {
        nvrhi::rt::InstanceDesc instanceDesc;
        instanceDesc.bottomLevelAS = bottomLevelAS;
        instanceDesc.instanceMask = static_cast<uint32_t>(instanceMask);
        instanceDesc.instanceID = static_cast<uint32_t>(instanceID);
        instanceDesc.flags = static_cast<nvrhi::rt::InstanceFlags>(flags);
        memcpy(instanceDesc.transform, transform, sizeof(instanceDesc.transform));
        sceneAccelStructs->pendingInstances.push_back(instanceDesc);
    }

    // Same, with the instance's hit group index offset (instanceContributionToHitGroupIndex, Vulkan's
    // instanceShaderBindingTableRecordOffset): which of the shader table's hit groups its hits run.
    void Donut_AddTopLevelASInstanceWithHitGroup(SceneAccelStructs* sceneAccelStructs, nvrhi::rt::IAccelStruct* bottomLevelAS, int instanceMask, int instanceID,
        int hitGroupIndex, int flags, const void* transform)
    {
        Donut_AddTopLevelASInstanceWithTransform(sceneAccelStructs, bottomLevelAS, instanceMask, instanceID, flags, transform);
        sceneAccelStructs->pendingInstances.back().instanceContributionToHitGroupIndex =
            static_cast<uint32_t>(hitGroupIndex);
    }

    // Inside a render callback: builds the TLAS from the instances added since the last build.
    void Donut_BuildTopLevelAS(FrameContext* frame, SceneAccelStructs* sceneAccelStructs)
    {
        auto* accelStructs = sceneAccelStructs;
        nvrhi::ICommandList* cl = frame->commandList;
        // The flags it was created with (NVRHI adds AllowUpdate itself): an update must use the
        // same ones as the build it refits.
        const nvrhi::rt::AccelStructBuildFlags buildFlags = accelStructs->topLevel->getDesc().buildFlags;
        cl->beginMarker("TLAS Update");
        cl->buildTopLevelAccelStruct(accelStructs->topLevel, accelStructs->pendingInstances.data(),
            accelStructs->pendingInstances.size(), buildFlags);
        cl->endMarker();
        accelStructs->builtInstanceCount = static_cast<int>(accelStructs->pendingInstances.size());
        accelStructs->pendingInstances.clear();
    }

    // Inside a render callback: refits the TLAS in place to the instances added since the last
    // build (new transforms, same instance count), instead of building it anew. Needs a TLAS
    // created with AllowUpdate; builds it instead before its first build or when the instance
    // count changed. Returns 1 if it refitted, 0 if it built.
    int Donut_UpdateTopLevelAS(FrameContext* frame, SceneAccelStructs* sceneAccelStructs)
    {
        auto* accelStructs = sceneAccelStructs;
        const nvrhi::rt::AccelStructBuildFlags buildFlags = accelStructs->topLevel->getDesc().buildFlags;
        if ((buildFlags & nvrhi::rt::AccelStructBuildFlags::AllowUpdate) == 0)
        {
            donut::log::error("Donut_UpdateTopLevelAS: the TLAS wasn't created with AllowUpdate; building it instead");
        }
        if ((buildFlags & nvrhi::rt::AccelStructBuildFlags::AllowUpdate) == 0 ||
            accelStructs->builtInstanceCount != static_cast<int>(accelStructs->pendingInstances.size()))
        {
            Donut_BuildTopLevelAS(frame, sceneAccelStructs);
            return 0;
        }

        nvrhi::ICommandList* cl = frame->commandList;
        cl->beginMarker("TLAS Refit");
        cl->buildTopLevelAccelStruct(accelStructs->topLevel, accelStructs->pendingInstances.data(),
            accelStructs->pendingInstances.size(), buildFlags | nvrhi::rt::AccelStructBuildFlags::PerformUpdate);
        cl->endMarker();
        accelStructs->pendingInstances.clear();
        return 1;
    }

    // Scene animations (e.g. glTF skeletal animations), in the scene graph's order.
    int Donut_GetSceneAnimationCount(void* scene)
    {
        return static_cast<int>(static_cast<donut::engine::Scene*>(scene)->GetSceneGraph()->GetAnimations().size());
    }

    // In seconds.
    double Donut_GetSceneAnimationDuration(void* scene, int index)
    {
        return static_cast<donut::engine::Scene*>(scene)->GetSceneGraph()->GetAnimations()[index]->GetDuration();
    }

    // Poses the animated nodes at `time` seconds into the animation; call Donut_RefreshScene after.
    void Donut_ApplySceneAnimation(void* scene, int index, double time)
    {
        (void)static_cast<donut::engine::Scene*>(scene)->GetSceneGraph()->GetAnimations()[index]->Apply(float(time));
    }

    // Inside a render callback: updates the scene graph and its GPU buffers (transforms, skinning)
    // after animations or other changes.
    void Donut_RefreshScene(App* app, FrameContext* frame, void* scene)
    {
        static_cast<donut::engine::Scene*>(scene)->Refresh(frame->commandList,
            app->deviceManager->GetFrameIndex());
    }

    // Acceleration structures for an animated scene: builds one BLAS per mesh (kept in the
    // mesh's accelStruct; alpha-tested geometries non-opaque, static ones compacted later) into
    // an open command list, and creates a TLAS for Donut_UpdateSceneAccelStructs to build every
    // frame. Get the TLAS with Donut_GetSceneTopLevelAS.
    SceneAccelStructs* Donut_CreateAnimatedSceneAccelStructs(App* app, nvrhi::ICommandList* commandList, void* scene)
    {
        App* a = app;
        nvrhi::ICommandList* cl = commandList;
        const auto& sceneGraph = static_cast<donut::engine::Scene*>(scene)->GetSceneGraph();

        for (const auto& mesh : sceneGraph->GetMeshes())
        {
            if (mesh->isSkinPrototype)
                continue;

            const nvrhi::rt::AccelStructDesc blasDesc = GetMeshBlasDesc(*mesh);
            nvrhi::rt::AccelStructHandle blas = a->device()->createAccelStruct(blasDesc);

            // Skinned meshes are built by Donut_UpdateSceneAccelStructs once they're posed.
            if (!mesh->skinPrototype)
                nvrhi::utils::BuildBottomLevelAccelStruct(cl, blas, blasDesc);

            mesh->accelStruct = blas;
        }

        auto accelStructs = std::make_shared<SceneAccelStructs>();
        nvrhi::rt::AccelStructDesc tlasDesc;
        tlasDesc.isTopLevel = true;
        tlasDesc.topLevelMaxInstances = sceneGraph->GetMeshInstances().size();
        accelStructs->topLevel = a->device()->createAccelStruct(tlasDesc);

        return a->OwnObject(accelStructs);
    }

    // Inside a render callback, after Donut_RefreshScene: rebuilds the BLAS of the skinned mesh
    // instances updated this frame, compacts the static BLASes whose builds have finished, and
    // builds the TLAS from the instances' current transforms (instance IDs = instance indices).
    void Donut_UpdateSceneAccelStructs(App* app, FrameContext* frame, SceneAccelStructs* sceneAccelStructs, void* scene)
    {
        nvrhi::ICommandList* cl = frame->commandList;
        const uint32_t frameIndex = app->deviceManager->GetFrameIndex();
        const auto& sceneGraph = static_cast<donut::engine::Scene*>(scene)->GetSceneGraph();

        cl->beginMarker("Skinned BLAS Updates");

        // Transition all the buffers first, so that the BLAS builds can be batched.
        for (const auto& skinnedInstance : sceneGraph->GetSkinnedMeshInstances())
        {
            if (skinnedInstance->GetLastUpdateFrameIndex() < frameIndex)
                continue;

            cl->setAccelStructState(skinnedInstance->GetMesh()->accelStruct, nvrhi::ResourceStates::AccelStructWrite);
            cl->setBufferState(skinnedInstance->GetMesh()->buffers->vertexBuffer, nvrhi::ResourceStates::AccelStructBuildInput);
        }
        cl->commitBarriers();

        for (const auto& skinnedInstance : sceneGraph->GetSkinnedMeshInstances())
        {
            if (skinnedInstance->GetLastUpdateFrameIndex() < frameIndex)
                continue;

            nvrhi::utils::BuildBottomLevelAccelStruct(cl, skinnedInstance->GetMesh()->accelStruct,
                GetMeshBlasDesc(*skinnedInstance->GetMesh()));
        }
        cl->endMarker();

        std::vector<nvrhi::rt::InstanceDesc> instances;
        for (const auto& instance : sceneGraph->GetMeshInstances())
        {
            nvrhi::rt::InstanceDesc instanceDesc;
            instanceDesc.bottomLevelAS = instance->GetMesh()->accelStruct;
            instanceDesc.instanceMask = 1;
            instanceDesc.instanceID = instance->GetInstanceIndex();
            dm::affineToColumnMajor(instance->GetNode()->GetLocalToWorldTransformFloat(), instanceDesc.transform);
            instances.push_back(instanceDesc);
        }

        cl->compactBottomLevelAccelStructs();

        cl->beginMarker("TLAS Update");
        cl->buildTopLevelAccelStruct(sceneAccelStructs->topLevel,
            instances.data(), instances.size());
        cl->endMarker();
    }

    // Donut's forward shading pass; numConstantBufferVersions bounds how many views it can
    // render per frame.
    void* Donut_CreateForwardShadingPass(App* app, int numConstantBufferVersions)
    {
        App* a = app;
        auto pass = std::make_shared<donut::render::ForwardShadingPass>(a->device(), a->sharedCommonPasses());
        donut::render::ForwardShadingPass::CreateParameters params;
        params.numConstantBufferVersions = static_cast<uint32_t>(numConstantBufferVersions);
        pass->Init(*a->shaderFactory, params);
        return a->OwnObject(pass);
    }

    // Cube map render target of resolution x resolution faces: SRGBA8 color, D32 depth.
    void* Donut_CreateCubemapTarget(App* app, int resolution)
    {
        App* a = app;
        auto target = std::make_shared<CubemapTarget>();

        auto textureDesc = nvrhi::TextureDesc()
            .setDimension(nvrhi::TextureDimension::TextureCube)
            .setArraySize(6)
            .setWidth(static_cast<uint32_t>(resolution))
            .setHeight(static_cast<uint32_t>(resolution))
            .setClearValue(nvrhi::Color(0.f))
            .setIsRenderTarget(true)
            .setKeepInitialState(true);

        target->colorBuffer = a->device()->createTexture(textureDesc
            .setDebugName("ColorBuffer")
            .setFormat(nvrhi::Format::SRGBA8_UNORM)
            .setInitialState(nvrhi::ResourceStates::RenderTarget));

        target->depthBuffer = a->device()->createTexture(textureDesc
            .setDebugName("DepthBuffer")
            .setFormat(nvrhi::Format::D32)
            .setInitialState(nvrhi::ResourceStates::DepthWrite));

        target->view.SetArrayViewports(resolution, 0);

        target->framebuffer = std::make_unique<donut::engine::FramebufferFactory>(a->device());
        target->framebuffer->RenderTargets.push_back(target->colorBuffer);
        target->framebuffer->DepthTarget = target->depthBuffer;

        return a->OwnObject(target);
    }

    // The color texture, one array slice per face; valid as long as the target.
    nvrhi::ITexture* Donut_GetCubemapColorTexture(void* cubemapTarget)
    {
        return static_cast<CubemapTarget*>(cubemapTarget)->colorBuffer.Get();
    }

    // Places the cube map view at the camera, looking along its axes.
    void Donut_SetCubemapViewFromCamera(void* cubemapTarget, void* camera, double zNear, double cullDistance)
    {
        auto* target = static_cast<CubemapTarget*>(cubemapTarget);
        target->view.SetTransform(AsCamera(camera)->GetWorldToViewMatrix(),
            float(zNear), float(cullDistance));
        target->view.UpdateCache();
    }

    // Command list for recording on another thread and executing later; see Donut_RenderCubemapFaceAsync.
    nvrhi::ICommandList* Donut_CreateDeferredCommandList(App* app)
    {
        App* a = app;
        return a->Own(a->device()->createCommandList(nvrhi::CommandListParameters().setEnableImmediateExecution(false)));
    }

    // Records the scene as seen by one cube map face (0..5) into commandList (opening and closing
    // it), with the forward shading pass and ambient lighting only.
    void Donut_RenderCubemapFace(void* cubemapTarget, int face, nvrhi::ICommandList* commandList, void* scene, void* forwardShadingPass)
    {
        RenderCubemapFace(static_cast<CubemapTarget*>(cubemapTarget), face, commandList,
            static_cast<donut::engine::Scene*>(scene), static_cast<donut::render::ForwardShadingPass*>(forwardShadingPass));
    }

    // Same, as a task on the app's thread pool; call Donut_WaitForTasks before executing the
    // command list. Each concurrent task needs its own command list.
    void Donut_RenderCubemapFaceAsync(App* app, void* cubemapTarget, int face, nvrhi::ICommandList* commandList, void* scene, void* forwardShadingPass)
    {
        auto* target = static_cast<CubemapTarget*>(cubemapTarget);
        auto* cl = commandList;
        auto* sc = static_cast<donut::engine::Scene*>(scene);
        auto* fwd = static_cast<donut::render::ForwardShadingPass*>(forwardShadingPass);
        app->threadPool()->AddTask([=]() { RenderCubemapFace(target, face, cl, sc, fwd); });
    }

    // Blocks until all tasks queued on the app's thread pool have finished.
    void Donut_WaitForTasks(App* app)
    {
        app->threadPool()->WaitForTasks();
    }

    // Donut's first person camera: WASD/arrow keys move, dragging with the left button looks around.
    void* Donut_CreateFirstPersonCamera(App* app)
    {
        donut::app::BaseCamera* camera = app->OwnObject(std::make_shared<donut::app::FirstPersonCamera>());
        return camera;
    }

    // Donut's third person (orbit) camera around a target: dragging with the left button orbits,
    // the mouse wheel zooms, WASD / arrows move the target.
    void* Donut_CreateThirdPersonCamera(App* app)
    {
        donut::app::BaseCamera* camera = app->OwnObject(std::make_shared<donut::app::ThirdPersonCamera>());
        return camera;
    }

    void Donut_ThirdPersonCameraSetTarget(void* camera, double x, double y, double z)
    {
        AsThirdPersonCamera(camera)->SetTargetPosition(dm::float3(float(x), float(y), float(z)));
    }

    void Donut_ThirdPersonCameraSetDistance(void* camera, double distance)
    {
        AsThirdPersonCamera(camera)->SetDistance(float(distance));
    }

    // In radians.
    void Donut_ThirdPersonCameraSetRotation(void* camera, double yaw, double pitch)
    {
        AsThirdPersonCamera(camera)->SetRotation(float(yaw), float(pitch));
    }

    // Orbits cameraTarget from cameraPos. Through LookTo: ThirdPersonCamera::LookAt gets the pitch's
    // sign wrong (it takes the angles of the direction to the target, LookTo of the opposite one).
    void Donut_ThirdPersonCameraLookAt(void* camera, double posX, double posY, double posZ, double targetX, double targetY, double targetZ)
    {
        const dm::float3 position{ float(posX), float(posY), float(posZ) };
        const dm::float3 direction = dm::float3(float(targetX), float(targetY), float(targetZ)) - position;
        AsThirdPersonCamera(camera)->LookTo(position, direction, dm::length(direction));
    }

    // The camera needs the view it renders (after Donut_SetPlanarView), every frame.
    void Donut_ThirdPersonCameraSetView(void* camera, void* view)
    {
        AsThirdPersonCamera(camera)->SetView(*static_cast<donut::engine::PlanarView*>(view));
    }

    // The camera's forward / up direction, as 3 floats into dst.
    void Donut_GetCameraDirection(void* camera, void* dst)
    {
        memcpy(dst, &AsCamera(camera)->GetDir(), sizeof(dm::float3));
    }

    void Donut_GetCameraUp(void* camera, void* dst)
    {
        memcpy(dst, &AsCamera(camera)->GetUp(), sizeof(dm::float3));
    }

    // First person cameras only.
    void Donut_CameraLookAt(void* camera, double posX, double posY, double posZ, double targetX, double targetY, double targetZ)
    {
        static_cast<donut::app::FirstPersonCamera*>(AsCamera(camera))->LookAt(
            dm::float3(float(posX), float(posY), float(posZ)), dm::float3(float(targetX), float(targetY), float(targetZ)));
    }

    // In units per second.
    void Donut_CameraSetMoveSpeed(void* camera, double speed)
    {
        AsCamera(camera)->SetMoveSpeed(float(speed));
    }

    // Mouse sensitivity, in radians per pixel.
    void Donut_CameraSetRotateSpeed(void* camera, double speed)
    {
        AsCamera(camera)->SetRotateSpeed(float(speed));
    }

    // Forward the pass input callbacks' arguments to these.
    void Donut_CameraKeyboardUpdate(void* camera, int key, int scancode, int action, int mods)
    {
        AsCamera(camera)->KeyboardUpdate(key, scancode, action, mods);
    }

    void Donut_CameraMousePosUpdate(void* camera, double x, double y)
    {
        AsCamera(camera)->MousePosUpdate(x, y);
    }

    void Donut_CameraMouseButtonUpdate(void* camera, int button, int action, int mods)
    {
        AsCamera(camera)->MouseButtonUpdate(button, action, mods);
    }

    void Donut_CameraMouseScrollUpdate(void* camera, double xOffset, double yOffset)
    {
        AsCamera(camera)->MouseScrollUpdate(xOffset, yOffset);
    }

    void Donut_CameraAnimate(void* camera, double elapsedSeconds)
    {
        AsCamera(camera)->Animate(float(elapsedSeconds));
    }

    // Writes the camera's world-to-view matrix to dst: 16 floats, row-major, row-vector convention.
    void Donut_GetCameraWorldToView(void* camera, void* dst)
    {
        const dm::float4x4 m = dm::affineToHomogeneous(AsCamera(camera)->GetWorldToViewMatrix());
        memcpy(dst, &m, sizeof(m));
    }

    // The scene graph of a scene from Donut_LoadScene; valid as long as the scene.
    void* Donut_GetSceneGraph(void* scene)
    {
        return static_cast<donut::engine::Scene*>(scene)->GetSceneGraph().get();
    }

    void* Donut_GetRootNode(void* sceneGraph)
    {
        return static_cast<donut::engine::SceneGraph*>(sceneGraph)->GetRootNode().get();
    }

    // Builds one bottom-level acceleration structure per mesh of a scene from Donut_LoadScene (its
    // opaque triangles), and a top-level one over its mesh instances, recording the builds into an
    // open command list. Get the top-level one with Donut_GetSceneTopLevelAS.
    SceneAccelStructs* Donut_BuildSceneAccelStructs(App* app, nvrhi::ICommandList* commandList, void* scene)
    {
        App* a = app;
        nvrhi::ICommandList* cl = commandList;
        const auto& sceneGraph = static_cast<donut::engine::Scene*>(scene)->GetSceneGraph();
        auto accelStructs = std::make_shared<SceneAccelStructs>();

        for (const auto& mesh : sceneGraph->GetMeshes())
        {
            nvrhi::rt::AccelStructDesc blasDesc;
            blasDesc.isTopLevel = false;

            for (const auto& geometry : mesh->geometries)
            {
                nvrhi::rt::GeometryDesc geometryDesc;
                auto& triangles = geometryDesc.geometryData.triangles;
                triangles.indexBuffer = mesh->buffers->indexBuffer;
                triangles.indexOffset = (mesh->indexOffset + geometry->indexOffsetInMesh) * sizeof(uint32_t);
                triangles.indexFormat = nvrhi::Format::R32_UINT;
                triangles.indexCount = geometry->numIndices;
                triangles.vertexBuffer = mesh->buffers->vertexBuffer;
                triangles.vertexOffset = (mesh->vertexOffset + geometry->vertexOffsetInMesh) * sizeof(dm::float3)
                    + mesh->buffers->getVertexBufferRange(donut::engine::VertexAttribute::Position).byteOffset;
                triangles.vertexFormat = nvrhi::Format::RGB32_FLOAT;
                triangles.vertexStride = sizeof(dm::float3);
                triangles.vertexCount = geometry->numVertices;
                geometryDesc.geometryType = nvrhi::rt::GeometryType::Triangles;
                geometryDesc.flags = nvrhi::rt::GeometryFlags::Opaque;
                blasDesc.bottomLevelGeometries.push_back(geometryDesc);
            }

            nvrhi::rt::AccelStructHandle blas = a->device()->createAccelStruct(blasDesc);
            nvrhi::utils::BuildBottomLevelAccelStruct(cl, blas, blasDesc);
            accelStructs->meshes[mesh] = blas;
        }

        std::vector<nvrhi::rt::InstanceDesc> instances;
        for (const auto& instance : sceneGraph->GetMeshInstances())
        {
            nvrhi::rt::InstanceDesc instanceDesc;
            instanceDesc.bottomLevelAS = accelStructs->meshes[instance->GetMesh()];
            instanceDesc.instanceMask = 1;
            dm::affineToColumnMajor(instance->GetNode()->GetLocalToWorldTransformFloat(), instanceDesc.transform);
            instances.push_back(instanceDesc);
        }

        nvrhi::rt::AccelStructDesc tlasDesc;
        tlasDesc.isTopLevel = true;
        tlasDesc.topLevelMaxInstances = instances.size();
        accelStructs->topLevel = a->device()->createAccelStruct(tlasDesc);
        cl->buildTopLevelAccelStruct(accelStructs->topLevel, instances.data(), instances.size());

        return a->OwnObject(accelStructs);
    }

    // For Donut_BindAccelStruct; valid as long as the acceleration structures.
    nvrhi::rt::IAccelStruct* Donut_GetSceneTopLevelAS(SceneAccelStructs* sceneAccelStructs)
    {
        return sceneAccelStructs->topLevel.Get();
    }

    // --- Scenes built in code ----------------------------------------------------------------

    // Material with a diffuse texture (path relative to the executable's directory, sRGB);
    // records the texture and constant buffer uploads into an open command list. specularGloss
    // != 0 selects the specular-glossiness model. Returns null (after logging why) if the
    // texture can't be loaded.
    void* Donut_CreateTexturedMaterial(App* app, nvrhi::ICommandList* commandList, const char* name, const char* diffuseTexturePath,
        int specularGloss)
    {
        App* a = app;
        nvrhi::ICommandList* cl = commandList;

        auto material = std::make_shared<donut::engine::Material>();
        material->name = name;
        material->useSpecularGlossModel = specularGloss != 0;
        material->enableBaseOrDiffuseTexture = true;
        material->baseOrDiffuseTexture = a->textureCache()->LoadTextureFromFile(
            GetExecutablePath().parent_path() / diffuseTexturePath, true, nullptr, cl);
        if (!material->baseOrDiffuseTexture || !material->baseOrDiffuseTexture->texture)
            return nullptr;

        nvrhi::BufferDesc bufferDesc;
        bufferDesc.byteSize = sizeof(MaterialConstants);
        bufferDesc.debugName = material->name;
        bufferDesc.isConstantBuffer = true;
        bufferDesc.initialState = nvrhi::ResourceStates::ConstantBuffer;
        bufferDesc.keepInitialState = true;
        material->materialConstants = a->device()->createBuffer(bufferDesc);

        MaterialConstants constants;
        material->FillConstantBuffer(constants);
        cl->writeBuffer(material->materialConstants, &constants, sizeof(constants));

        return a->OwnObject(material);
    }

    // Mesh of one geometry with a material from Donut_CreateTexturedMaterial, and an identity
    // instance transform. Per vertex: a position (3 floats), texture coordinates (2 floats), and
    // a normal and a tangent (uint each, snorm8-packed as by donut::math::vectorToSnorm8); then
    // indexCount uint indices. Records the uploads into an open command list.
    void* Donut_CreateMesh(App* app, nvrhi::ICommandList* commandList, const char* name, void* material,
        const void* positions, const void* texCoords, const void* normals, const void* tangents, int vertexCount,
        const void* indices, int indexCount)
    {
        using namespace donut::engine;

        App* a = app;
        nvrhi::IDevice* device = a->device();
        nvrhi::ICommandList* cl = commandList;

        auto buffers = std::make_shared<BufferGroup>();
        buffers->indexBuffer = CreateGeometryBuffer(device, cl, "IndexBuffer", indices,
            sizeof(uint32_t) * uint64_t(indexCount), false, false);

        const struct { VertexAttribute attribute; const void* data; uint64_t size; } streams[] = {
            { VertexAttribute::Position, positions, sizeof(dm::float3) * uint64_t(vertexCount) },
            { VertexAttribute::TexCoord1, texCoords, sizeof(dm::float2) * uint64_t(vertexCount) },
            { VertexAttribute::Normal, normals, sizeof(uint32_t) * uint64_t(vertexCount) },
            { VertexAttribute::Tangent, tangents, sizeof(uint32_t) * uint64_t(vertexCount) },
        };

        uint64_t vertexBufferSize = 0;
        for (const auto& stream : streams)
        {
            buffers->getVertexBufferRange(stream.attribute).setByteOffset(vertexBufferSize).setByteSize(stream.size);
            vertexBufferSize += stream.size;
        }
        buffers->vertexBuffer = CreateGeometryBuffer(device, cl, "VertexBuffer", nullptr, vertexBufferSize, true, false);

        cl->beginTrackingBufferState(buffers->vertexBuffer, nvrhi::ResourceStates::CopyDest);
        for (const auto& stream : streams)
            cl->writeBuffer(buffers->vertexBuffer, stream.data, stream.size,
                buffers->getVertexBufferRange(stream.attribute).byteOffset);
        cl->setPermanentBufferState(buffers->vertexBuffer, nvrhi::ResourceStates::ShaderResource);

        InstanceData instance{};
        instance.transform = dm::float3x4(transpose(dm::affineToHomogeneous(dm::affine3::identity())));
        instance.prevTransform = instance.transform;
        buffers->instanceBuffer = CreateGeometryBuffer(device, cl, "VertexBufferTransform", &instance,
            sizeof(instance), false, true);

        auto geometry = std::make_shared<MeshGeometry>();
        geometry->material = a->SharedObject<Material>(material);
        geometry->numIndices = static_cast<uint32_t>(indexCount);
        geometry->numVertices = static_cast<uint32_t>(vertexCount);

        dm::box3 bounds = dm::box3::empty();
        const auto* vertexPositions = static_cast<const dm::float3*>(positions);
        for (int i = 0; i < vertexCount; i++)
            bounds |= vertexPositions[i];

        auto mesh = std::make_shared<MeshInfo>();
        mesh->name = name;
        mesh->buffers = buffers;
        mesh->objectSpaceBounds = bounds;
        mesh->totalIndices = geometry->numIndices;
        mesh->totalVertices = geometry->numVertices;
        mesh->geometries.push_back(geometry);

        return a->OwnObject(mesh);
    }

    // An empty scene graph; add nodes with the functions below.
    void* Donut_CreateSceneGraph(App* app)
    {
        return app->OwnObject(std::make_shared<donut::engine::SceneGraph>());
    }

    // Adds a node holding an instance of a mesh from Donut_CreateMesh, under parentNode, or as the
    // root node if parentNode is null. Returns the node, valid as long as the scene graph.
    void* Donut_AddMeshNode(App* app, void* sceneGraph, void* parentNode, void* mesh, const char* name)
    {
        App* a = app;
        auto* graph = static_cast<donut::engine::SceneGraph*>(sceneGraph);

        auto node = std::make_shared<donut::engine::SceneGraphNode>();
        node->SetLeaf(std::make_shared<donut::engine::MeshInstance>(a->SharedObject<donut::engine::MeshInfo>(mesh)));
        node->SetName(name);

        if (parentNode)
            graph->Attach(static_cast<donut::engine::SceneGraphNode*>(parentNode)->shared_from_this(), node);
        else
            graph->SetRootNode(node);

        return node.get();
    }

    // Adds a directional light in a new node under parentNode, shining along (dirX, dirY, dirZ);
    // angularSize is in degrees. Returns the light, valid as long as the scene graph; call
    // Donut_RefreshSceneGraph before using it.
    void* Donut_AddDirectionalLight(void* sceneGraph, void* parentNode, const char* name,
        double dirX, double dirY, double dirZ, double angularSize, double irradiance)
    {
        auto light = std::make_shared<donut::engine::DirectionalLight>();
        static_cast<donut::engine::SceneGraph*>(sceneGraph)->AttachLeafNode(
            static_cast<donut::engine::SceneGraphNode*>(parentNode)->shared_from_this(), light);

        // After attaching: the direction is stored in the light's node.
        light->SetDirection(dm::double3(dirX, dirY, dirZ));
        light->angularSize = float(angularSize);
        light->irradiance = float(irradiance);
        light->SetName(name);
        return static_cast<donut::engine::Light*>(light.get());
    }

    // sizeof(LightConstants) (donut/shaders/light_cb.h), a multiple of 16.
    int Donut_GetLightConstantsSize()
    {
        return static_cast<int>(sizeof(LightConstants));
    }

    // Writes a light's LightConstants to dst.
    void Donut_FillLightConstants(void* light, void* dst)
    {
        LightConstants constants = {};
        static_cast<donut::engine::Light*>(light)->FillLightConstants(constants);
        memcpy(dst, &constants, sizeof(constants));
    }

    // Updates the transforms, bounds and instance indices after nodes were added or changed.
    void Donut_RefreshSceneGraph(App* app, void* sceneGraph)
    {
        static_cast<donut::engine::SceneGraph*>(sceneGraph)->Refresh(app->deviceManager->GetFrameIndex());
    }

    // Logs the node tree.
    void Donut_PrintSceneGraph(void* sceneGraph)
    {
        donut::engine::PrintSceneGraph(static_cast<donut::engine::SceneGraph*>(sceneGraph)->GetRootNode());
    }

    // --- Deferred shading --------------------------------------------------------------------

    // G-buffer (depth, diffuse, specular, normals, emissive) of width x height pixels, plus an
    // RGBA16_FLOAT texture for the lit result; create a new one when the frame size changes.
    // reverseDepth != 0: depth is cleared to 0, for reverse-Z projections.
    void* Donut_CreateGBufferTargets(App* app, int width, int height, int reverseDepth)
    {
        App* a = app;
        auto targets = std::make_shared<GBufferTargets>();
        targets->Init(a->device(), dm::uint2(uint32_t(width), uint32_t(height)), 1, false, reverseDepth != 0);
        return a->OwnObject(targets);
    }

    // Values of `which` for Donut_GetGBufferTexture.
    enum GBufferTexture
    {
        GBufferTexture_Depth = 0,
        GBufferTexture_Diffuse = 1,
        GBufferTexture_Specular = 2,
        GBufferTexture_Normals = 3,
        GBufferTexture_Emissive = 4,
    };

    // One of the G-buffer textures, e.g. for binding to a shader that decodes the G-buffer;
    // valid as long as the targets.
    nvrhi::ITexture* Donut_GetGBufferTexture(void* gbufferTargets, int which)
    {
        auto* targets = static_cast<GBufferTargets*>(gbufferTargets);
        switch (which)
        {
        case GBufferTexture_Depth: return targets->Depth.Get();
        case GBufferTexture_Diffuse: return targets->GBufferDiffuse.Get();
        case GBufferTexture_Specular: return targets->GBufferSpecular.Get();
        case GBufferTexture_Normals: return targets->GBufferNormals.Get();
        case GBufferTexture_Emissive: return targets->GBufferEmissive.Get();
        default: return nullptr;
        }
    }

    // The lit result, for Donut_BlitTexture; valid as long as the targets.
    nvrhi::ITexture* Donut_GetGBufferShadedColor(void* gbufferTargets)
    {
        return static_cast<GBufferTargets*>(gbufferTargets)->ShadedColor.Get();
    }

    // Donut's G-buffer fill pass; its pipelines depend on the targets' formats and sample count.
    void* Donut_CreateGBufferFillPass(App* app)
    {
        App* a = app;
        auto pass = std::make_shared<donut::render::GBufferFillPass>(a->device(), a->sharedCommonPasses());
        pass->Init(*a->shaderFactory, donut::render::GBufferFillPass::CreateParameters());
        return a->OwnObject(pass);
    }

    // Donut's deferred lighting pass (a compute shader reading the G-buffer).
    void* Donut_CreateDeferredLightingPass(App* app)
    {
        App* a = app;
        auto pass = std::make_shared<donut::render::DeferredLightingPass>(a->device(), a->sharedCommonPasses());
        pass->Init(a->shaderFactory);
        return a->OwnObject(pass);
    }

    // Drops the binding sets the pass cached, and with them their references to G-buffer textures.
    void Donut_ResetDeferredLightingBindingCache(void* deferredLightingPass)
    {
        static_cast<donut::render::DeferredLightingPass*>(deferredLightingPass)->ResetBindingCache();
    }

    // A single view (camera) for the passes above.
    void* Donut_CreatePlanarView(App* app)
    {
        return app->OwnObject(std::make_shared<donut::engine::PlanarView>());
    }

    // Sets the view's world-to-view and projection matrices (16 floats each, row-major, row-vector
    // convention, as donut::math builds them) and its viewport of width x height pixels.
    void Donut_SetPlanarView(void* view, const void* viewMatrix, const void* projMatrix, int width, int height)
    {
        auto* planarView = static_cast<donut::engine::PlanarView*>(view);
        planarView->SetViewport(nvrhi::Viewport(float(width), float(height)));
        planarView->SetMatrices(dm::homogeneousToAffine(LoadMatrix(static_cast<const float*>(viewMatrix))),
            LoadMatrix(static_cast<const float*>(projMatrix)));
        planarView->UpdateCache();
    }

    // sizeof(PlanarViewConstants) (donut/shaders/view_cb.h), a multiple of 16.
    int Donut_GetPlanarViewConstantsSize()
    {
        return static_cast<int>(sizeof(PlanarViewConstants));
    }

    // Writes the view's PlanarViewConstants (as of its last Donut_SetPlanarView) to dst.
    void Donut_FillPlanarViewConstants(void* view, void* dst)
    {
        PlanarViewConstants constants = {};
        static_cast<donut::engine::PlanarView*>(view)->FillPlanarViewConstants(constants);
        memcpy(dst, &constants, sizeof(constants));
    }

    // Clears all the G-buffer textures.
    void Donut_ClearGBuffer(FrameContext* frame, void* gbufferTargets)
    {
        static_cast<GBufferTargets*>(gbufferTargets)->Clear(frame->commandList);
    }

    // Draws the mesh instance of a node from Donut_AddMeshNode (all its geometries, back faces
    // culled) into the G-buffer, as seen by view.
    void Donut_RenderMeshNodeToGBuffer(FrameContext* frame, void* gbufferFillPass, void* view, void* gbufferTargets, void* meshNode)
    {
        auto* node = static_cast<donut::engine::SceneGraphNode*>(meshNode);
        auto* instance = dynamic_cast<donut::engine::MeshInstance*>(node->GetLeaf().get());
        if (!instance)
            return;

        const donut::engine::MeshInfo* mesh = instance->GetMesh().get();
        std::vector<donut::render::DrawItem> drawItems;
        for (const auto& geometry : mesh->geometries)
        {
            donut::render::DrawItem& item = drawItems.emplace_back();
            item.instance = instance;
            item.mesh = mesh;
            item.geometry = geometry.get();
            item.material = geometry->material.get();
            item.buffers = mesh->buffers.get();
            item.distanceToCamera = 0;
            item.cullMode = nvrhi::RasterCullMode::Back;
        }

        donut::render::PassthroughDrawStrategy drawStrategy;
        drawStrategy.SetData(drawItems.data(), drawItems.size());

        auto* planarView = static_cast<donut::engine::PlanarView*>(view);
        donut::render::GBufferFillPass::Context context;
        donut::render::RenderView(frame->commandList, planarView, planarView,
            static_cast<GBufferTargets*>(gbufferTargets)->GBufferFramebuffer->GetFramebuffer(*planarView),
            drawStrategy, *static_cast<donut::render::GBufferFillPass*>(gbufferFillPass), context, false);
    }

    // Draws the opaque meshes of a scene from Donut_LoadScene into the G-buffer, as seen by view.
    void Donut_RenderSceneToGBuffer(FrameContext* frame, void* gbufferFillPass, void* view, void* gbufferTargets, void* scene)
    {
        auto* planarView = static_cast<donut::engine::PlanarView*>(view);
        donut::render::InstancedOpaqueDrawStrategy drawStrategy;
        donut::render::GBufferFillPass::Context context;
        donut::render::RenderCompositeView(frame->commandList, planarView, planarView,
            *static_cast<GBufferTargets*>(gbufferTargets)->GBufferFramebuffer,
            static_cast<donut::engine::Scene*>(scene)->GetSceneGraph()->GetRootNode(),
            drawStrategy, *static_cast<donut::render::GBufferFillPass*>(gbufferFillPass), context);
    }

    // Draws the transparent meshes of a loaded scene with a forward shading pass
    // (Donut_CreateForwardShadingPass) over the targets' shaded color, depth-tested against the
    // G-buffer depth, lit by the scene graph's lights plus a top / bottom ambient term.
    void Donut_RenderSceneTransparentOverGBuffer(FrameContext* frame, void* forwardShadingPass, void* view, void* gbufferTargets,
        void* scene, double topR, double topG, double topB, double bottomR, double bottomG, double bottomB)
    {
        nvrhi::ICommandList* cl = frame->commandList;
        auto* forwardPass = static_cast<donut::render::ForwardShadingPass*>(forwardShadingPass);
        auto* planarView = static_cast<donut::engine::PlanarView*>(view);
        const auto& sceneGraph = static_cast<donut::engine::Scene*>(scene)->GetSceneGraph();

        donut::render::ForwardShadingPass::Context context;
        forwardPass->PrepareLights(context, cl, sceneGraph->GetLights(),
            dm::float3(float(topR), float(topG), float(topB)), dm::float3(float(bottomR), float(bottomG), float(bottomB)), {});

        donut::render::TransparentDrawStrategy transparentStrategy;
        donut::render::RenderCompositeView(cl, planarView, planarView,
            *static_cast<GBufferTargets*>(gbufferTargets)->ShadedFramebuffer, sceneGraph->GetRootNode(),
            transparentStrategy, *forwardPass, context);
    }

    // Lights the G-buffer with the scene graph's lights plus a hemispherical ambient term (top
    // and bottom colors), writing the result into the targets' shaded color texture.
    void Donut_RenderDeferredLighting(FrameContext* frame, void* deferredLightingPass, void* view, void* gbufferTargets,
        void* sceneGraph, double topR, double topG, double topB, double bottomR, double bottomG, double bottomB)
    {
        auto* targets = static_cast<GBufferTargets*>(gbufferTargets);

        donut::render::DeferredLightingPass::Inputs inputs;
        inputs.SetGBuffer(*targets);
        inputs.ambientColorTop = dm::float3(float(topR), float(topG), float(topB));
        inputs.ambientColorBottom = dm::float3(float(bottomR), float(bottomG), float(bottomB));
        inputs.lights = &static_cast<donut::engine::SceneGraph*>(sceneGraph)->GetLights();
        inputs.output = targets->ShadedColor;

        static_cast<donut::render::DeferredLightingPass*>(deferredLightingPass)->Render(
            frame->commandList, *static_cast<donut::engine::PlanarView*>(view), inputs);
    }

    // Copies a view's viewport, matrices and derived state, e.g. to keep the previous frame's view.
    void Donut_CopyPlanarView(void* dstView, void* srcView)
    {
        *static_cast<donut::engine::PlanarView*>(dstView) = *static_cast<donut::engine::PlanarView*>(srcView);
    }

    // --- Forward shading with temporal anti-aliasing ----------------------------------------

    // Targets of width x height pixels: RGBA16_FLOAT HDR color and D24S8 depth (cleared for reverse Z)
    // to render into, RG16_FLOAT motion vectors, and the TAA resolved color and feedback textures.
    // Create new ones when the frame size changes.
    void* Donut_CreateTemporalTargets(App* app, int width, int height)
    {
        App* a = app;
        nvrhi::IDevice* device = a->device();
        auto targets = std::make_shared<TemporalTargets>();

        nvrhi::TextureDesc desc;
        desc.width = static_cast<uint32_t>(width);
        desc.height = static_cast<uint32_t>(height);
        desc.isRenderTarget = true;
        desc.useClearValue = true;
        desc.clearValue = nvrhi::Color(0.f);
        desc.keepInitialState = true;

        desc.isTypeless = true;
        desc.format = nvrhi::Format::D24S8;
        desc.initialState = nvrhi::ResourceStates::DepthWrite;
        desc.debugName = "DepthBuffer";
        targets->depth = device->createTexture(desc);

        desc.isTypeless = false;
        desc.format = nvrhi::Format::RGBA16_FLOAT;
        desc.initialState = nvrhi::ResourceStates::RenderTarget;
        desc.isUAV = true;
        desc.debugName = "HdrColor";
        targets->hdrColor = device->createTexture(desc);
        desc.debugName = "ResolvedColor";
        targets->resolvedColor = device->createTexture(desc);

        desc.format = nvrhi::Format::RGBA16_SNORM;
        desc.debugName = "TemporalFeedback1";
        targets->feedback1 = device->createTexture(desc);
        desc.debugName = "TemporalFeedback2";
        targets->feedback2 = device->createTexture(desc);

        desc.format = nvrhi::Format::RG16_FLOAT;
        desc.debugName = "MotionVectors";
        targets->motionVectors = device->createTexture(desc);

        targets->framebuffer = std::make_shared<donut::engine::FramebufferFactory>(device);
        targets->framebuffer->RenderTargets = { targets->hdrColor };
        targets->framebuffer->DepthTarget = targets->depth;

        return a->OwnObject(targets);
    }

    // Values of `which` for Donut_GetTemporalTargetsTexture.
    enum TemporalTexture
    {
        TemporalTexture_Depth = 0,
        TemporalTexture_HdrColor = 1,
        TemporalTexture_ResolvedColor = 2,
        TemporalTexture_MotionVectors = 3,
    };

    // One of the targets' textures; valid as long as the targets.
    nvrhi::ITexture* Donut_GetTemporalTargetsTexture(void* temporalTargets, int which)
    {
        auto* targets = static_cast<TemporalTargets*>(temporalTargets);
        switch (which)
        {
        case TemporalTexture_Depth: return targets->depth.Get();
        case TemporalTexture_HdrColor: return targets->hdrColor.Get();
        case TemporalTexture_ResolvedColor: return targets->resolvedColor.Get();
        case TemporalTexture_MotionVectors: return targets->motionVectors.Get();
        default: return nullptr;
        }
    }

    // Makes rendering into the targets use a shading rate surface (Donut_CreateShadingRateSurface)
    // whenever the view enables variable rate shading. Call it before the first draw into them.
    void Donut_SetTemporalTargetsShadingRateSurface(void* temporalTargets, nvrhi::ITexture* shadingRateSurface)
    {
        static_cast<TemporalTargets*>(temporalTargets)->framebuffer->ShadingRateSurface =
            shadingRateSurface;
    }

    // Clears depth (to 0, for reverse Z) and HDR color.
    void Donut_ClearTemporalTargets(FrameContext* frame, void* temporalTargets)
    {
        auto* targets = static_cast<TemporalTargets*>(temporalTargets);
        nvrhi::ICommandList* cl = frame->commandList;
        cl->clearDepthStencilTexture(targets->depth, nvrhi::AllSubresources, true, 0.f, true, 0);
        cl->clearTextureFloat(targets->hdrColor, nvrhi::AllSubresources, nvrhi::Color(0.f));
    }

    // Draws a loaded scene, opaque then transparent meshes, into the targets' HDR color and depth
    // with a forward shading pass (Donut_CreateForwardShadingPass), lit by the scene graph's
    // lights plus a top / bottom ambient term.
    void Donut_RenderSceneForward(FrameContext* frame, void* forwardShadingPass, void* view, void* temporalTargets, void* scene,
        double topR, double topG, double topB, double bottomR, double bottomG, double bottomB)
    {
        nvrhi::ICommandList* cl = frame->commandList;
        auto* forwardPass = static_cast<donut::render::ForwardShadingPass*>(forwardShadingPass);
        auto* planarView = static_cast<donut::engine::PlanarView*>(view);
        auto* framebuffer = static_cast<TemporalTargets*>(temporalTargets)->framebuffer.get();
        const auto& sceneGraph = static_cast<donut::engine::Scene*>(scene)->GetSceneGraph();

        donut::render::ForwardShadingPass::Context context;
        forwardPass->PrepareLights(context, cl, sceneGraph->GetLights(),
            dm::float3(float(topR), float(topG), float(topB)), dm::float3(float(bottomR), float(bottomG), float(bottomB)), {});

        donut::render::InstancedOpaqueDrawStrategy opaqueStrategy;
        donut::render::RenderCompositeView(cl, planarView, planarView, *framebuffer, sceneGraph->GetRootNode(),
            opaqueStrategy, *forwardPass, context);

        donut::render::TransparentDrawStrategy transparentStrategy;
        donut::render::RenderCompositeView(cl, planarView, planarView, *framebuffer, sceneGraph->GetRootNode(),
            transparentStrategy, *forwardPass, context);
    }

    // Donut's TAA pass over the targets (Catmull-Rom filter, motion vectors where the stencil has
    // bit 0 set), for views like `view`; create a new one with new targets.
    void* Donut_CreateTemporalAntiAliasingPass(App* app, void* view, void* temporalTargets)
    {
        App* a = app;
        auto* targets = static_cast<TemporalTargets*>(temporalTargets);

        donut::render::TemporalAntiAliasingPass::CreateParameters params;
        params.sourceDepth = targets->depth;
        params.motionVectors = targets->motionVectors;
        params.unresolvedColor = targets->hdrColor;
        params.resolvedColor = targets->resolvedColor;
        params.feedback1 = targets->feedback1;
        params.feedback2 = targets->feedback2;
        params.motionVectorStencilMask = 0x01;
        params.useCatmullRomFilter = true;

        return a->OwnObject(std::make_shared<donut::render::TemporalAntiAliasingPass>(a->device(), a->shaderFactory,
            a->sharedCommonPasses(), *static_cast<donut::engine::PlanarView*>(view), params));
    }

    // Writes the targets' motion vectors, from the camera's movement between the two views.
    void Donut_RenderMotionVectors(FrameContext* frame, void* temporalAntiAliasingPass, void* view, void* previousView)
    {
        static_cast<donut::render::TemporalAntiAliasingPass*>(temporalAntiAliasingPass)->RenderMotionVectors(
            frame->commandList, *static_cast<donut::engine::PlanarView*>(view),
            *static_cast<donut::engine::PlanarView*>(previousView));
    }

    // Resolves the HDR color into the resolved color with default TAA parameters;
    // feedbackIsValid == 0 on the first frame, when there's no history yet.
    void Donut_TemporalResolve(FrameContext* frame, void* temporalAntiAliasingPass, void* view, int feedbackIsValid)
    {
        auto* planarView = static_cast<donut::engine::PlanarView*>(view);
        static_cast<donut::render::TemporalAntiAliasingPass*>(temporalAntiAliasingPass)->TemporalResolve(
            frame->commandList, donut::render::TemporalAntiAliasingParameters(), feedbackIsValid != 0,
            *planarView, *planarView);
    }

    // --- Variable rate shading ----------------------------------------------------------------

    // Pixels per shading rate surface texel in each dimension, as NVRHI reports it (0 without
    // nvrhi::Feature::VariableRateShading).
    int Donut_GetShadingRateTileSize(App* app)
    {
        nvrhi::VariableRateShadingFeatureInfo info = {};
        app->device()->queryFeatureSupport(nvrhi::Feature::VariableRateShading, &info, sizeof(info));
        return static_cast<int>(info.shadingRateImageTileSize);
    }

    // Same, straight from D3D12 (D3D12_FEATURE_D3D12_OPTIONS6); 0 on other graphics APIs.
    int Donut_GetD3D12ShadingRateTileSize(App* app)
    {
#if DONUT_WITH_DX12
        nvrhi::IDevice* device = app->device();
        if (device->getGraphicsAPI() == nvrhi::GraphicsAPI::D3D12)
        {
            D3D12_FEATURE_DATA_D3D12_OPTIONS6 options = {};
            ID3D12Device* d3dDevice = device->getNativeObject(nvrhi::ObjectTypes::D3D12_Device);
            if (SUCCEEDED(d3dDevice->CheckFeatureSupport(D3D12_FEATURE_D3D12_OPTIONS6, &options, sizeof(options))))
                return static_cast<int>(options.ShadingRateImageTileSize);
        }
#endif
        return 0;
    }

    // The fragment sizes (shading rates) the device has, as width, height pairs into dst (Ref of a
    // `let` int array of 2 x 16), in Vulkan's order: largest first (vkGetPhysicalDeviceFragmentShadingRatesKHR;
    // on D3D12 the rates of its tier: 2x4, 4x2 and 4x4 with AdditionalShadingRatesSupported). Returns
    // their count, 0 without variable rate shading.
    int Donut_GetFragmentShadingRates(App* app, int* dst)
    {
        App* a = app;
        nvrhi::IDevice* device = a->device();
        if (!device->queryFeatureSupport(nvrhi::Feature::VariableRateShading))
            return 0;
        int count = 0;
#if DONUT_WITH_VULKAN
        if (device->getGraphicsAPI() == nvrhi::GraphicsAPI::VULKAN)
        {
            const vk::PhysicalDevice physicalDevice = DeviceManagerVKAccess::PhysicalDevice(
                static_cast<DeviceManager_VK*>(a->deviceManager.get()));
            const auto rates = physicalDevice.getFragmentShadingRatesKHR();
            for (const vk::PhysicalDeviceFragmentShadingRateKHR& rate : rates)
            {
                if (count == 16)
                    break;
                dst[count * 2] = static_cast<int>(rate.fragmentSize.width);
                dst[count * 2 + 1] = static_cast<int>(rate.fragmentSize.height);
                count++;
            }
            return count;
        }
#endif
#if DONUT_WITH_DX12
        if (device->getGraphicsAPI() == nvrhi::GraphicsAPI::D3D12)
        {
            D3D12_FEATURE_DATA_D3D12_OPTIONS6 options = {};
            ID3D12Device* d3dDevice = device->getNativeObject(nvrhi::ObjectTypes::D3D12_Device);
            if (FAILED(d3dDevice->CheckFeatureSupport(D3D12_FEATURE_D3D12_OPTIONS6, &options, sizeof(options))))
                return 0;
            const int additional[] = { 4, 4, 4, 2, 2, 4 };
            const int base[] = { 2, 2, 2, 1, 1, 2, 1, 1 };
            if (options.AdditionalShadingRatesSupported)
            {
                for (int i = 0; i < 6; i++)
                    dst[count * 2 + i] = additional[i];
                count += 3;
            }
            for (int i = 0; i < 8; i++)
                dst[count * 2 + i] = base[i];
            count += 4;
            return count;
        }
#endif
        (void)dst;
        return 0;
    }

    // Variable rate shading in a graphics pipeline (Feature::VariableRateShading): its draws take
    // their shading rate from the draw state (Donut_DrawSetVariableRateShading), combined with a
    // framebuffer's shading rate surface.
    void Donut_GraphicsPipelineSetVariableRateShading(PipelineDesc* graphicsPipelineDesc, int enabled)
    {
        graphicsPipelineDesc->shadingRateState.setEnabled(enabled != 0);
    }

    // The draw state's shading rate (after Donut_BeginDraw*; its pipeline needs
    // Donut_GraphicsPipelineSetVariableRateShading): the per-draw rate (an nvrhi::VariableShadingRate),
    // combined with the primitives' rate by primitiveCombiner, then with the framebuffer's shading
    // rate surface by imageCombiner (nvrhi::ShadingRateCombiner values: Passthrough keeps the rate so
    // far, Override takes the new one).
    // The depth bounds of the draw (after Donut_BeginDraw) for a pipeline with the depth bounds test:
    // depth target values from minDepth to maxDepth pass (0 to 1 by default).
    void Donut_DrawSetDepthBounds(FrameContext* frame, double minDepth, double maxDepth)
    {
        frame->draw.setDepthBounds(float(minDepth), float(maxDepth));
    }

    void Donut_DrawSetVariableRateShading(FrameContext* frame, int enabled, int shadingRate, int primitiveCombiner,
        int imageCombiner)
    {
        frame->draw.shadingRateState = nvrhi::VariableRateShadingState()
            .setEnabled(enabled != 0)
            .setShadingRate(static_cast<nvrhi::VariableShadingRate>(shadingRate))
            .setPipelinePrimitiveCombiner(static_cast<nvrhi::ShadingRateCombiner>(primitiveCombiner))
            .setImageCombiner(static_cast<nvrhi::ShadingRateCombiner>(imageCombiner));
    }

    // Framebuffer of one or two color targets (colorTexture1 null for one) and a depth buffer (null
    // for none) whose draws can take their shading rates from shadingRateSurface
    // (Donut_CreateShadingRateSurface, a texel per Donut_GetShadingRateTileSize square of pixels).
    // Returns null on failure.
    nvrhi::IFramebuffer* Donut_CreateFramebufferWithShadingRate(App* app, nvrhi::ITexture* colorTexture0, nvrhi::ITexture* colorTexture1, nvrhi::ITexture* depthTexture,
        nvrhi::ITexture* shadingRateSurface)
    {
        auto desc = nvrhi::FramebufferDesc().addColorAttachment(colorTexture0);
        if (colorTexture1)
            desc.addColorAttachment(colorTexture1);
        if (depthTexture)
            desc.setDepthAttachment(depthTexture);
        if (shadingRateSurface)
            desc.setShadingRateAttachment(shadingRateSurface);

        App* a = app;
        return a->Own(a->device()->createFramebuffer(desc));
    }

    // R8_UINT shading rate surface of width x height tiles, written by compute shaders as
    // RWTexture2D<uint> (D3D12_SHADING_RATE values). Returns null on failure.
    nvrhi::ITexture* Donut_CreateShadingRateSurface(App* app, int width, int height)
    {
        nvrhi::TextureDesc desc;
        desc.debugName = "ShadingRateTexture";
        desc.width = static_cast<uint32_t>(width);
        desc.height = static_cast<uint32_t>(height);
        desc.dimension = nvrhi::TextureDimension::Texture2D;
        desc.keepInitialState = true;
        desc.isUAV = true;
        desc.isShadingRateSurface = true;
        desc.initialState = nvrhi::ResourceStates::UnorderedAccess;
        desc.format = nvrhi::Format::R8_UINT;

        App* a = app;
        return a->Own(a->device()->createTexture(desc));
    }

    // enabled != 0: draws with the view use its framebuffer's shading rate surface alone (1x1
    // per-draw rate, the surface overriding it); 0: full rate.
    void Donut_SetViewVariableRateShading(void* view, int enabled)
    {
        static_cast<donut::engine::PlanarView*>(view)->SetVariableRateShadingState(enabled
            ? nvrhi::VariableRateShadingState().setEnabled(true).setShadingRate(nvrhi::VariableShadingRate::e1x1)
                .setImageCombiner(nvrhi::ShadingRateCombiner::Override)
            : nvrhi::VariableRateShadingState().setEnabled(false));
    }

    // The same through the D3D12 API directly (D3D12 only), bypassing NVRHI: transitions the
    // surface to D3D12_RESOURCE_STATE_SHADING_RATE_SOURCE and binds it, with every combiner at
    // MAX and a 1x1 per-draw rate. Use it instead of Donut_SetTemporalTargetsShadingRateSurface
    // and Donut_SetViewVariableRateShading, and pair it with Donut_EndD3D12ShadingRateImage.
    void Donut_BeginD3D12ShadingRateImage(FrameContext* frame, nvrhi::ITexture* shadingRateSurface)
    {
#if DONUT_WITH_DX12
        ID3D12GraphicsCommandList* d3dCommandList = frame->commandList->getNativeObject(
            nvrhi::ObjectTypes::D3D12_GraphicsCommandList);
        ID3D12GraphicsCommandList5* vrsCommandList = nullptr;
        if (!d3dCommandList || FAILED(d3dCommandList->QueryInterface(IID_PPV_ARGS(&vrsCommandList))))
            return;
        ID3D12Resource* vrsResource = shadingRateSurface->getNativeObject(
            nvrhi::ObjectTypes::D3D12_Resource);

        D3D12_RESOURCE_BARRIER barrier = {};
        barrier.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
        barrier.Transition.pResource = vrsResource;
        barrier.Transition.Subresource = 0;
        barrier.Transition.StateBefore = D3D12_RESOURCE_STATE_UNORDERED_ACCESS;
        barrier.Transition.StateAfter = D3D12_RESOURCE_STATE_SHADING_RATE_SOURCE;
        vrsCommandList->ResourceBarrier(1, &barrier);

        vrsCommandList->RSSetShadingRateImage(vrsResource);
        D3D12_SHADING_RATE_COMBINER combiners[D3D12_RS_SET_SHADING_RATE_COMBINER_COUNT];
        for (auto& combiner : combiners)
            combiner = D3D12_SHADING_RATE_COMBINER_MAX;
        vrsCommandList->RSSetShadingRate(D3D12_SHADING_RATE_1X1, combiners);
        vrsCommandList->Release();
#endif
    }

    // Undoes Donut_BeginD3D12ShadingRateImage: full rate, no surface, surface back to UAV state.
    void Donut_EndD3D12ShadingRateImage(FrameContext* frame, nvrhi::ITexture* shadingRateSurface)
    {
#if DONUT_WITH_DX12
        ID3D12GraphicsCommandList* d3dCommandList = frame->commandList->getNativeObject(
            nvrhi::ObjectTypes::D3D12_GraphicsCommandList);
        ID3D12GraphicsCommandList5* vrsCommandList = nullptr;
        if (!d3dCommandList || FAILED(d3dCommandList->QueryInterface(IID_PPV_ARGS(&vrsCommandList))))
            return;
        ID3D12Resource* vrsResource = shadingRateSurface->getNativeObject(
            nvrhi::ObjectTypes::D3D12_Resource);

        D3D12_RESOURCE_BARRIER barrier = {};
        barrier.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
        barrier.Transition.pResource = vrsResource;
        barrier.Transition.Subresource = 0;
        barrier.Transition.StateBefore = D3D12_RESOURCE_STATE_SHADING_RATE_SOURCE;
        barrier.Transition.StateAfter = D3D12_RESOURCE_STATE_UNORDERED_ACCESS;
        vrsCommandList->ResourceBarrier(1, &barrier);

        vrsCommandList->RSSetShadingRate(D3D12_SHADING_RATE_1X1, nullptr);
        vrsCommandList->RSSetShadingRateImage(nullptr);
        vrsCommandList->Release();
#endif
    }

    // --- D3D12 work graphs (through the D3D12 API directly; NVRHI has no work graphs) -------
    //
    // They need a D3D12 runtime from Agility SDK 1.613 or later, so an executable using them must
    // export D3D12SDKVersion and D3D12SDKPath (d3d12_agility_sdk.cpp in CMakeLists.txt).

    // The device's D3D12_WORK_GRAPHS_TIER (D3D12_FEATURE_D3D12_OPTIONS21): 0 when work graphs are
    // unsupported, 10 for tier 1.0, 11 for tier 1.1. Also 0 on other graphics APIs.
    int Donut_GetD3D12WorkGraphsTier(App* app)
    {
#if DONUT_WITH_DX12
        nvrhi::IDevice* device = app->device();
        if (device->getGraphicsAPI() == nvrhi::GraphicsAPI::D3D12)
        {
            D3D12_FEATURE_DATA_D3D12_OPTIONS21 options = {};
            ID3D12Device* d3dDevice = device->getNativeObject(nvrhi::ObjectTypes::D3D12_Device);
            if (SUCCEEDED(d3dDevice->CheckFeatureSupport(D3D12_FEATURE_D3D12_OPTIONS21, &options, sizeof(options))))
                return static_cast<int>(options.WorkGraphsTier);
        }
#endif
        return 0;
    }

    // A work graph program named programName holding all the nodes of a shader library
    // (Donut_CreateShaderLibrary, compiled for lib_6_8), with the root signature of computePipeline
    // (whose binding layout the nodes' registers must match), and the [NodeDispatchGrid] of its
    // broadcasting entry node entryNodeName overridden with gridX x gridY x gridZ. Creates its
    // backing memory too. Release it with Donut_ReleaseObject. Returns null (after logging why) on
    // failure.
    void* Donut_CreateD3D12WorkGraph(App* app, nvrhi::IShaderLibrary* shaderLibrary, nvrhi::IComputePipeline* computePipeline, const char* programName,
        const char* entryNodeName, int gridX, int gridY, int gridZ)
    {
#if DONUT_WITH_DX12
        App* a = app;
        nvrhi::IDevice* device = a->device();
        if (device->getGraphicsAPI() != nvrhi::GraphicsAPI::D3D12)
        {
            donut::log::error("Work graphs need D3D12");
            return nullptr;
        }

        ID3D12Device* d3dDevice = device->getNativeObject(nvrhi::ObjectTypes::D3D12_Device);
        Microsoft::WRL::ComPtr<ID3D12Device5> device5;
        if (FAILED(d3dDevice->QueryInterface(IID_PPV_ARGS(&device5))))
        {
            donut::log::error("Could not access the D3D12 device interface for work graphs");
            return nullptr;
        }

        const std::wstring program = Widen(programName);
        const std::wstring entryNode = Widen(entryNodeName);
        D3D12_SHADER_BYTECODE libraryCode = {};
        shaderLibrary->getBytecode(&libraryCode.pShaderBytecode, &libraryCode.BytecodeLength);
        ID3D12RootSignature* rootSignature = computePipeline->getNativeObject(
            nvrhi::ObjectTypes::D3D12_RootSignature);

        // The state object: the library, the graph (every node in the library), and the root
        // signature shared with the other shaders.
        CD3DX12_STATE_OBJECT_DESC stateObjectDesc(D3D12_STATE_OBJECT_TYPE_EXECUTABLE);
        auto* library = stateObjectDesc.CreateSubobject<CD3DX12_DXIL_LIBRARY_SUBOBJECT>();
        library->SetDXILLibrary(&libraryCode);
        auto* graph = stateObjectDesc.CreateSubobject<CD3DX12_WORK_GRAPH_SUBOBJECT>();
        graph->SetProgramName(program.c_str());
        graph->IncludeAllAvailableNodes();
        auto* globalRootSignature = stateObjectDesc.CreateSubobject<CD3DX12_GLOBAL_ROOT_SIGNATURE_SUBOBJECT>();
        globalRootSignature->SetRootSignature(rootSignature);
        // Overriding the grid size in the state object costs nothing at launch, unlike a
        // SV_DispatchGrid in the entry record.
        auto* entryOverrides = graph->CreateBroadcastingLaunchNodeOverrides(entryNode.c_str());
        entryOverrides->DispatchGrid(static_cast<UINT>(gridX), static_cast<UINT>(gridY), static_cast<UINT>(gridZ));

        auto workGraph = std::make_shared<D3D12WorkGraph>();
        if (FAILED(device5->CreateStateObject(stateObjectDesc, IID_PPV_ARGS(&workGraph->stateObject))))
        {
            donut::log::error("Cannot create the work graph state object for %s", programName);
            return nullptr;
        }

        Microsoft::WRL::ComPtr<ID3D12StateObjectProperties1> properties;
        Microsoft::WRL::ComPtr<ID3D12WorkGraphProperties> graphProperties;
        if (FAILED(workGraph->stateObject.As(&properties)) || FAILED(workGraph->stateObject.As(&graphProperties)))
        {
            donut::log::error("Cannot query the work graph properties of %s", programName);
            return nullptr;
        }
        workGraph->programIdentifier = properties->GetProgramIdentifier(program.c_str());

        // Backing memory of the largest size the graph asks for, the fastest.
        D3D12_WORK_GRAPH_MEMORY_REQUIREMENTS memoryRequirements = {};
        graphProperties->GetWorkGraphMemoryRequirements(graphProperties->GetWorkGraphIndex(program.c_str()), &memoryRequirements);
        if (memoryRequirements.MaxSizeInBytes > 0)
        {
            workGraph->backingMemory = device->createBuffer(nvrhi::BufferDesc()
                .setByteSize(memoryRequirements.MaxSizeInBytes)
                .setCanHaveUAVs(true)
                .setDebugName("WorkGraphBackingMemory")
                .setInitialState(nvrhi::ResourceStates::UnorderedAccess)
                .setKeepInitialState(true));
            if (!workGraph->backingMemory)
                return nullptr;
        }

        return a->OwnObject(workGraph);
#else
        donut::log::error("Work graphs need D3D12");
        return nullptr;
#endif
    }

    // Launches a work graph (Donut_CreateD3D12WorkGraph) with one empty input record for its entry
    // node, with bindingSet and byteSize bytes of push constants from data as its root arguments.
    // computePipeline, one with the graph's root signature, only serves to set those through NVRHI;
    // record no more dispatches with it after the graph in the command list (NVRHI believes it is
    // still bound). initializeBackingMemory: non-zero the first time the graph's backing memory is
    // used, or after another graph used it.
    void Donut_DispatchD3D12WorkGraph(nvrhi::ICommandList* commandList, void* workGraph, nvrhi::IComputePipeline* computePipeline, nvrhi::IBindingSet* bindingSet,
        const void* data, int byteSize, int initializeBackingMemory)
    {
#if DONUT_WITH_DX12
        const auto* graph = static_cast<D3D12WorkGraph*>(workGraph);
        nvrhi::ICommandList* cl = commandList;

        // Bindings (and the barriers they need) through NVRHI.
        cl->setComputeState(nvrhi::ComputeState()
            .setPipeline(computePipeline)
            .addBindingSet(bindingSet));
        if (byteSize > 0)
            cl->setPushConstants(data, static_cast<size_t>(byteSize));

        ID3D12GraphicsCommandList* d3dCommandList = cl->getNativeObject(nvrhi::ObjectTypes::D3D12_GraphicsCommandList);
        Microsoft::WRL::ComPtr<ID3D12GraphicsCommandList10> graphCommandList;
        if (!d3dCommandList || FAILED(d3dCommandList->QueryInterface(IID_PPV_ARGS(&graphCommandList))))
            return;

        D3D12_SET_PROGRAM_DESC setProgram = {};
        setProgram.Type = D3D12_PROGRAM_TYPE_WORK_GRAPH;
        setProgram.WorkGraph.ProgramIdentifier = graph->programIdentifier;
        setProgram.WorkGraph.Flags = initializeBackingMemory ? D3D12_SET_WORK_GRAPH_FLAG_INITIALIZE : D3D12_SET_WORK_GRAPH_FLAG_NONE;
        if (graph->backingMemory)
        {
            setProgram.WorkGraph.BackingMemory.StartAddress = graph->backingMemory->getGpuVirtualAddress();
            setProgram.WorkGraph.BackingMemory.SizeInBytes = graph->backingMemory->getDesc().byteSize;
        }
        graphCommandList->SetProgram(&setProgram);

        // The entry record has no data, so none is passed.
        D3D12_DISPATCH_GRAPH_DESC dispatchGraph = {};
        dispatchGraph.Mode = D3D12_DISPATCH_MODE_NODE_CPU_INPUT;
        dispatchGraph.NodeCPUInput.EntrypointIndex = 0;
        dispatchGraph.NodeCPUInput.NumRecords = 1;
        dispatchGraph.NodeCPUInput.pRecords = nullptr;
        dispatchGraph.NodeCPUInput.RecordStrideInBytes = 0;
        graphCommandList->DispatchGraph(&dispatchGraph);
#endif
    }

    // --- Full renderer (Donut-Samples' feature_demo) ------------------------------------------
    //
    // The pieces of Donut's renderer that feature_demo drives. Functions taking a `view` accept a
    // planar view (Donut_CreatePlanarView) or a stereo one (Donut_CreateStereoView) alike: both
    // derive from donut::engine::IView alone, so their handles are IView pointers too. They
    // record into `commandList`: the frame's (Donut_GetFrameCommandList) or one opened with
    // Donut_OpenCommandList. Framebuffer handles (Donut_GetSceneRenderTargetsFramebuffer,
    // Donut_GetLightProbeCaptureFramebuffer) are valid as long as the object they came from.

    // The directory of the executable (of donut_interop.dll under the JIT), '/'-separated, where
    // the media folder is.
    const char* Donut_GetExecutableDirectory()
    {
        static std::string storage;
        return ReturnString(storage, GetExecutablePath().parent_path().generic_string());
    }

    // Seconds per frame averaged over the last half second or so; 0 until measured.
    double Donut_GetAverageFrameTime(App* app)
    {
        return app->deviceManager->GetAverageFrameTimeSeconds();
    }

    // Window size in pixels, e.g. for placing ImGui windows.
    int Donut_GetWindowWidth(App* app)
    {
        int width = 0, height = 0;
        app->deviceManager->GetWindowDimensions(width, height);
        return width;
    }

    int Donut_GetWindowHeight(App* app)
    {
        int width = 0, height = 0;
        app->deviceManager->GetWindowDimensions(width, height);
        return height;
    }

    // Drops the compiled shaders the app's shader factory cached, so that passes created after
    // this load them from disk again (e.g. after recompiling them).
    void Donut_ClearShaderCache(App* app)
    {
        app->shaderFactory->ClearCache();
    }

    // Destroys resources released since the GPU last finished with them; after Donut_WaitForIdle.
    void Donut_RunGarbageCollection(App* app)
    {
        app->device()->runGarbageCollection();
    }

    // nvrhi::Format values 0 .. count-1, with their names and nvrhi::FormatSupport bits.
    int Donut_GetFormatCount()
    {
        return static_cast<int>(nvrhi::Format::COUNT);
    }

    const char* Donut_GetFormatName(int format)
    {
        return nvrhi::getFormatInfo(static_cast<nvrhi::Format>(format)).name;
    }

    int Donut_QueryFormatSupport(App* app, int format)
    {
        return static_cast<int>(app->device()->queryFormatSupport(static_cast<nvrhi::Format>(format)));
    }

    // --- Scene loading ------------------------------------------------------------------------

    // A scene loader: loads one scene at a time on a thread (Donut_BeginLoadingScene); poll it
    // with Donut_UpdateSceneLoader every frame. Its scenes use the app's texture cache.
    void* Donut_CreateSceneLoader(App* app)
    {
        auto loader = std::make_shared<SceneLoader>();
        loader->app = app;
        return app->OwnObject(loader);
    }

    // Non-zero once a scene has loaded, until the next Donut_BeginLoadingScene; unload what
    // references it (the passes' binding caches) before starting another load.
    int Donut_IsSceneLoaded(void* sceneLoader)
    {
        return static_cast<SceneLoader*>(sceneLoader)->sceneLoaded ? 1 : 0;
    }

    // Non-zero while the loading thread runs (until Donut_UpdateSceneLoader returns 1).
    int Donut_IsSceneLoading(void* sceneLoader)
    {
        return static_cast<SceneLoader*>(sceneLoader)->thread ? 1 : 0;
    }

    // Starts loading a scene file (glTF or .scene.json; absolute, or relative to the executable's
    // directory) on a thread, dropping the current scene: its handle is invalid afterwards.
    void Donut_BeginLoadingScene(void* sceneLoader, const char* path)
    {
        auto* loader = static_cast<SceneLoader*>(sceneLoader);
        App* a = loader->app;

        if (loader->thread)
        {
            loader->thread->join();
            loader->thread.reset();
        }

        loader->sceneLoaded = false;
        loader->allTexturesFinalized = false;

        a->textureCache()->Reset();
        a->device()->waitForIdle();
        loader->scene.reset();
        loader->loadedScene.reset();
        a->device()->runGarbageCollection();

        const std::filesystem::path fileName = GetExecutablePath().parent_path() / path;
        loader->thread = std::make_unique<std::thread>([loader, a, fileName]() {
            auto scene = std::make_shared<donut::engine::Scene>(a->device(), *a->shaderFactory,
                std::make_shared<donut::vfs::NativeFileSystem>(), a->textureCache(), nullptr, nullptr);

            const auto startTime = std::chrono::high_resolution_clock::now();
            if (scene->Load(fileName))
            {
                const auto duration = std::chrono::duration_cast<std::chrono::milliseconds>(
                    std::chrono::high_resolution_clock::now() - startTime).count();
                donut::log::info("Scene loading time: %llu ms", static_cast<unsigned long long>(duration));

                loader->loadedScene = std::move(scene);
                loader->sceneLoaded = true;
            }
        });
    }

    // Values returned by Donut_UpdateSceneLoader.
    enum SceneLoaderState
    {
        SceneLoaderState_Loading = 0, // no scene to render yet: draw a splash screen
        SceneLoaderState_Loaded = 1, // the scene has just finished loading, this frame
        SceneLoaderState_Ready = 2,
    };

    // Inside a render callback, every frame, first thing: uploads the textures loaded so far, and
    // finishes the scene once it and all its textures have loaded. A scene that fails to load
    // stays Loading. The uploads use their own command list, so this submits what the frame has
    // recorded so far (NVRHI allows one open immediate command list at a time).
    int Donut_UpdateSceneLoader(void* sceneLoader, FrameContext* frame)
    {
        auto* loader = static_cast<SceneLoader*>(sceneLoader);
        App* a = loader->app;
        FrameContext* ctx = frame;
        ctx->commandList->close();
        a->device()->executeCommandList(ctx->commandList);
        struct Reopen { nvrhi::ICommandList* cl; ~Reopen() { cl->open(); } } reopen{ ctx->commandList };

        const bool anyTexturesProcessed = a->textureCache()->ProcessRenderingThreadCommands(*a->commonPasses(), 20.f);
        if (loader->sceneLoaded && !anyTexturesProcessed)
            loader->allTexturesFinalized = true;

        if (!loader->sceneLoaded || !loader->allTexturesFinalized)
            return SceneLoaderState_Loading;

        if (loader->thread)
        {
            loader->thread->join();
            loader->thread.reset();

            a->textureCache()->ProcessRenderingThreadCommands(*a->commonPasses(), 0.f);
            a->textureCache()->LoadingFinished();

            loader->scene = std::move(loader->loadedScene);
            loader->scene->FinishedLoading(a->deviceManager->GetFrameIndex());
            return SceneLoaderState_Loaded;
        }

        return SceneLoaderState_Ready;
    }

    // The loaded scene (for the Donut_*Scene* functions), or null; valid until the next
    // Donut_BeginLoadingScene.
    void* Donut_GetLoadedScene(void* sceneLoader)
    {
        return static_cast<SceneLoader*>(sceneLoader)->scene.get();
    }

    // Loading progress as 4 ints into dst: objects loaded, objects total, textures loaded,
    // textures requested.
    void Donut_GetSceneLoadingStats(void* sceneLoader, void* dst)
    {
        App* a = static_cast<SceneLoader*>(sceneLoader)->app;
        const auto& stats = donut::engine::Scene::GetLoadingStats();
        const int values[4] = {
            int(stats.ObjectsLoaded.load()), int(stats.ObjectsTotal.load()),
            int(a->textureCache()->GetNumberOfLoadedTextures()), int(a->textureCache()->GetNumberOfRequestedTextures())
        };
        memcpy(dst, values, sizeof(values));
    }

    // The scene files (glTF and .scene.json) under a directory, recursively, as a string list.
    void* Donut_FindScenes(App* app, const char* directory)
    {
        donut::vfs::NativeFileSystem fs;
        return app->OwnObject(std::make_shared<std::vector<std::string>>(donut::app::FindScenes(fs, directory)));
    }

    int Donut_GetStringListCount(void* stringList)
    {
        return static_cast<int>(static_cast<std::vector<std::string>*>(stringList)->size());
    }

    // Valid as long as the list.
    const char* Donut_GetStringListItem(void* stringList, int index)
    {
        return (*static_cast<std::vector<std::string>*>(stringList))[index].c_str();
    }

    // --- Scene graph queries ------------------------------------------------------------------
    // Handles to lights, cameras, materials and nodes are valid as long as their scene.

    int Donut_GetSceneGraphLightCount(void* sceneGraph)
    {
        return static_cast<int>(AsSceneGraph(sceneGraph)->GetLights().size());
    }

    void* Donut_GetSceneGraphLight(void* sceneGraph, int index)
    {
        return AsSceneGraph(sceneGraph)->GetLights()[index].get();
    }

    // A LightType_* value (light_types.h): 1 directional, 2 spot, 3 point.
    int Donut_GetLightType(void* light)
    {
        return static_cast<donut::engine::Light*>(light)->GetLightType();
    }

    const char* Donut_GetLightName(void* light)
    {
        return static_cast<donut::engine::Light*>(light)->GetName().c_str();
    }

    // Directional lights only.
    double Donut_GetDirectionalLightIrradiance(void* light)
    {
        return static_cast<donut::engine::DirectionalLight*>(static_cast<donut::engine::Light*>(light))->irradiance;
    }

    void Donut_SetDirectionalLightIrradiance(void* light, double irradiance)
    {
        static_cast<donut::engine::DirectionalLight*>(static_cast<donut::engine::Light*>(light))->irradiance = float(irradiance);
    }

    // The shadow map the light casts shadows with in the forward and deferred passes, or none (null).
    void Donut_SetLightShadowMap(void* light, void* shadowMapTarget)
    {
        static_cast<donut::engine::Light*>(light)->shadowMap = shadowMapTarget
            ? static_cast<ShadowMapTarget*>(shadowMapTarget)->shadowMap() : nullptr;
    }

    // Cameras defined in the scene file.
    int Donut_GetSceneGraphCameraCount(void* sceneGraph)
    {
        return static_cast<int>(AsSceneGraph(sceneGraph)->GetCameras().size());
    }

    void* Donut_GetSceneGraphCamera(void* sceneGraph, int index)
    {
        return AsSceneGraph(sceneGraph)->GetCameras()[index].get();
    }

    const char* Donut_GetSceneCameraName(void* sceneCamera)
    {
        return static_cast<donut::engine::SceneCamera*>(sceneCamera)->GetName().c_str();
    }

    // The camera's world-to-view / view-to-world matrix: 16 floats into dst (row-major,
    // row-vector convention).
    void Donut_GetSceneCameraWorldToView(void* sceneCamera, void* dst)
    {
        const dm::float4x4 m = dm::affineToHomogeneous(static_cast<donut::engine::SceneCamera*>(sceneCamera)->GetWorldToViewMatrix());
        memcpy(dst, &m, sizeof(m));
    }

    void Donut_GetSceneCameraViewToWorld(void* sceneCamera, void* dst)
    {
        const dm::float4x4 m = dm::affineToHomogeneous(static_cast<donut::engine::SceneCamera*>(sceneCamera)->GetViewToWorldMatrix());
        memcpy(dst, &m, sizeof(m));
    }

    // Vertical field of view in radians of a perspective camera, or a negative value for other cameras.
    double Donut_GetSceneCameraVerticalFov(void* sceneCamera)
    {
        auto* perspective = dynamic_cast<donut::engine::PerspectiveCamera*>(static_cast<donut::engine::SceneCamera*>(sceneCamera));
        return perspective ? perspective->verticalFov : -1.0;
    }

    // Near plane distance of a perspective camera, or a negative value for other cameras.
    double Donut_GetSceneCameraZNear(void* sceneCamera)
    {
        auto* perspective = dynamic_cast<donut::engine::PerspectiveCamera*>(static_cast<donut::engine::SceneCamera*>(sceneCamera));
        return perspective ? perspective->zNear : -1.0;
    }

    // World-space bounds of a node and its children, as 6 floats into dst: min x, y, z, max x, y, z.
    void Donut_GetNodeBoundingBox(void* node, void* dst)
    {
        const dm::box3& bounds = static_cast<donut::engine::SceneGraphNode*>(node)->GetGlobalBoundingBox();
        const float values[6] = { bounds.m_mins.x, bounds.m_mins.y, bounds.m_mins.z, bounds.m_maxs.x, bounds.m_maxs.y, bounds.m_maxs.z };
        memcpy(dst, values, sizeof(values));
    }

    // Like "/Sponza/Mesh_12".
    const char* Donut_GetNodePath(void* node)
    {
        static std::string storage;
        return ReturnString(storage, static_cast<donut::engine::SceneGraphNode*>(node)->GetPath().generic_string());
    }

    // Makes the scene re-sort the node's content, e.g. after a material changes domain.
    void Donut_InvalidateNodeContent(void* node)
    {
        static_cast<donut::engine::SceneGraphNode*>(node)->InvalidateContent();
    }

    int Donut_GetSceneGraphMaterialCount(void* sceneGraph)
    {
        // ResourceTracker's iterator is forward-only, without iterator_traits for std::distance.
        int count = 0;
        for (const auto& material : AsSceneGraph(sceneGraph)->GetMaterials())
        {
            (void)material;
            count++;
        }
        return count;
    }

    void* Donut_GetSceneGraphMaterial(void* sceneGraph, int index)
    {
        for (const auto& material : AsSceneGraph(sceneGraph)->GetMaterials())
        {
            if (index-- == 0)
                return material.get();
        }
        return nullptr;
    }

    int Donut_GetMaterialID(void* material)
    {
        return static_cast<donut::engine::Material*>(material)->materialID;
    }

    const char* Donut_GetMaterialName(void* material)
    {
        return static_cast<donut::engine::Material*>(material)->name.c_str();
    }

    // A donut::engine::MaterialDomain value.
    int Donut_GetMaterialDomain(void* material)
    {
        return static_cast<int>(static_cast<donut::engine::Material*>(material)->domain);
    }

    // Marks the material for re-upload of its constants (what the material editor returns).
    void Donut_SetMaterialDirty(void* material, int dirty)
    {
        static_cast<donut::engine::Material*>(material)->dirty = dirty != 0;
    }

    int Donut_GetSceneGraphMeshInstanceCount(void* sceneGraph)
    {
        return static_cast<int>(AsSceneGraph(sceneGraph)->GetMeshInstances().size());
    }

    // The instance index (what material ID passes write) of the index-th mesh instance.
    int Donut_GetMeshInstanceIndex(void* sceneGraph, int index)
    {
        return AsSceneGraph(sceneGraph)->GetMeshInstances()[index]->GetInstanceIndex();
    }

    void* Donut_GetMeshInstanceNode(void* sceneGraph, int index)
    {
        return AsSceneGraph(sceneGraph)->GetMeshInstances()[index]->GetNode();
    }

    // The geometries of the index-th mesh instance's mesh, and how many indices one of them has:
    // what drawing them from the scene's bindless buffers takes (GeometryData::numIndices).
    int Donut_GetMeshInstanceGeometryCount(void* sceneGraph, int index)
    {
        return static_cast<int>(AsSceneGraph(sceneGraph)->GetMeshInstances()[index]->GetMesh()->geometries.size());
    }

    int Donut_GetMeshInstanceGeometryIndexCount(void* sceneGraph, int index, int geometry)
    {
        return static_cast<int>(AsSceneGraph(sceneGraph)->GetMeshInstances()[index]->GetMesh()->geometries[geometry]->numIndices);
    }

    // --- Views ----------------------------------------------------------------------------------

    // Two planar views side by side, left and right eye, rendered as one.
    void* Donut_CreateStereoView(App* app)
    {
        donut::engine::IView* view = app->OwnObject(std::make_shared<donut::engine::StereoPlanarView>());
        return view;
    }

    // Donut_SetPlanarView with the projection offset by a sub-pixel jitter (for temporal
    // anti-aliasing), in pixels.
    void Donut_SetPlanarViewJittered(void* view, const void* viewMatrix, const void* projMatrix, int width, int height,
        double pixelOffsetX, double pixelOffsetY)
    {
        auto* planarView = static_cast<donut::engine::PlanarView*>(view);
        planarView->SetViewport(nvrhi::Viewport(float(width), float(height)));
        planarView->SetPixelOffset(dm::float2(float(pixelOffsetX), float(pixelOffsetY)));
        planarView->SetMatrices(dm::homogeneousToAffine(LoadMatrix(static_cast<const float*>(viewMatrix))),
            LoadMatrix(static_cast<const float*>(projMatrix)));
        planarView->UpdateCache();
    }

    // Sets a stereo view over width x height pixels: the left eye in the left half, the right
    // eye in the right half, sharing one projection (matrices as for Donut_SetPlanarView).
    void Donut_SetStereoView(void* view, const void* leftViewMatrix, const void* rightViewMatrix, const void* projMatrix,
        int width, int height, double pixelOffsetX, double pixelOffsetY)
    {
        auto* stereoView = static_cast<donut::engine::StereoPlanarView*>(AsView(view));
        const float w = float(width);
        const float h = float(height);
        const dm::float2 pixelOffset = dm::float2(float(pixelOffsetX), float(pixelOffsetY));
        const dm::float4x4 projection = LoadMatrix(static_cast<const float*>(projMatrix));

        stereoView->LeftView.SetViewport(nvrhi::Viewport(w * 0.5f, h));
        stereoView->LeftView.SetPixelOffset(pixelOffset);
        stereoView->LeftView.SetMatrices(dm::homogeneousToAffine(LoadMatrix(static_cast<const float*>(leftViewMatrix))), projection);
        stereoView->LeftView.UpdateCache();

        stereoView->RightView.SetViewport(nvrhi::Viewport(w * 0.5f, w, 0.f, h, 0.f, 1.f));
        stereoView->RightView.SetPixelOffset(pixelOffset);
        stereoView->RightView.SetMatrices(dm::homogeneousToAffine(LoadMatrix(static_cast<const float*>(rightViewMatrix))), projection);
        stereoView->RightView.UpdateCache();
    }

    void Donut_CopyStereoView(void* dstView, void* srcView)
    {
        *static_cast<donut::engine::StereoPlanarView*>(AsView(dstView)) = *static_cast<donut::engine::StereoPlanarView*>(AsView(srcView));
    }

    // The left eye's planar view, e.g. for Donut_ThirdPersonCameraSetView.
    void* Donut_GetStereoLeftView(void* view)
    {
        return &static_cast<donut::engine::StereoPlanarView*>(AsView(view))->LeftView;
    }

    // First person cameras only: Donut_CameraLookAt with an up direction.
    void Donut_CameraLookAtWithUp(void* camera, double posX, double posY, double posZ,
        double targetX, double targetY, double targetZ, double upX, double upY, double upZ)
    {
        static_cast<donut::app::FirstPersonCamera*>(AsCamera(camera))->LookAt(
            dm::float3(float(posX), float(posY), float(posZ)), dm::float3(float(targetX), float(targetY), float(targetZ)),
            dm::float3(float(upX), float(upY), float(upZ)));
    }

    // The camera's position, as 3 floats into dst.
    void Donut_GetCameraPosition(void* camera, void* dst)
    {
        memcpy(dst, &AsCamera(camera)->GetPosition(), sizeof(dm::float3));
    }

    // --- Render targets -------------------------------------------------------------------------

    // Render targets of width x height pixels, multisampled with sampleCount > 1; create new ones
    // when the size or sample count changes.
    void* Donut_CreateSceneRenderTargets(App* app, int width, int height, int sampleCount)
    {
        App* a = app;
        auto targets = std::make_shared<SceneRenderTargets>();
        targets->Init(a->device(), dm::uint2(uint32_t(width), uint32_t(height)), uint32_t(sampleCount), true, true);
        return a->OwnObject(targets);
    }

    // Clears the G-buffer (depth to 0, for reverse Z), HDR, LDR and resolved color.
    void Donut_ClearSceneRenderTargets(nvrhi::ICommandList* commandList, void* sceneRenderTargets)
    {
        AsSceneRenderTargets(sceneRenderTargets)->Clear(commandList);
    }

    // Values of `which` for Donut_GetSceneRenderTargetsTexture.
    enum SceneTexture
    {
        SceneTexture_Depth = 0,
        SceneTexture_HdrColor = 1,
        SceneTexture_LdrColor = 2,
        SceneTexture_MaterialIDs = 3,
        SceneTexture_ResolvedColor = 4,
        SceneTexture_AmbientOcclusion = 5,
        SceneTexture_MotionVectors = 6,
    };

    // Valid as long as the targets.
    nvrhi::ITexture* Donut_GetSceneRenderTargetsTexture(void* sceneRenderTargets, int which)
    {
        auto* targets = AsSceneRenderTargets(sceneRenderTargets);
        switch (which)
        {
        case SceneTexture_Depth: return targets->Depth.Get();
        case SceneTexture_HdrColor: return targets->HdrColor.Get();
        case SceneTexture_LdrColor: return targets->LdrColor.Get();
        case SceneTexture_MaterialIDs: return targets->MaterialIDs.Get();
        case SceneTexture_ResolvedColor: return targets->ResolvedColor.Get();
        case SceneTexture_AmbientOcclusion: return targets->AmbientOcclusion.Get();
        case SceneTexture_MotionVectors: return targets->MotionVectors.Get();
        default: return nullptr;
        }
    }

    // Values of `which` for Donut_GetSceneRenderTargetsFramebuffer.
    enum SceneFramebuffer
    {
        SceneFramebuffer_GBuffer = 0, // G-buffer textures and depth
        SceneFramebuffer_Forward = 1, // HDR color and depth
        SceneFramebuffer_Hdr = 2,
        SceneFramebuffer_Ldr = 3,
        SceneFramebuffer_Resolved = 4,
        SceneFramebuffer_MaterialIDs = 5, // material IDs and depth
    };

    FramebufferFactoryRef* Donut_GetSceneRenderTargetsFramebuffer(void* sceneRenderTargets, int which)
    {
        auto* targets = AsSceneRenderTargets(sceneRenderTargets);
        switch (which)
        {
        case SceneFramebuffer_GBuffer: return &targets->GBufferFramebuffer;
        case SceneFramebuffer_Forward: return &targets->ForwardFramebuffer;
        case SceneFramebuffer_Hdr: return &targets->HdrFramebuffer;
        case SceneFramebuffer_Ldr: return &targets->LdrFramebuffer;
        case SceneFramebuffer_Resolved: return &targets->ResolvedFramebuffer;
        case SceneFramebuffer_MaterialIDs: return &targets->MaterialIDFramebuffer;
        default: return nullptr;
        }
    }

    // Resolves mip 0 / slice 0 of a multisampled texture into a single-sample one.
    void Donut_ResolveTexture(nvrhi::ICommandList* commandList, nvrhi::ITexture* dstTexture, nvrhi::ITexture* srcTexture)
    {
        const auto subresources = nvrhi::TextureSubresourceSet(0, 1, 0, 1);
        commandList->resolveTexture(dstTexture, subresources,
            srcTexture, subresources);
    }

    // Clears all of an integer texture to value.
    void Donut_ClearTextureUInt(nvrhi::ICommandList* commandList, nvrhi::ITexture* texture, int value)
    {
        commandList->clearTextureUInt(texture, nvrhi::AllSubresources,
            static_cast<uint32_t>(value));
    }

    // --- Multisampling ------------------------------------------------------------------------

    // The sample counts that a color target in colorFormat and a depth buffer in depthFormat
    // (nvrhi::Format values) can both have, as bits (bit n for n samples: 0x1 | 0x2 | 0x4 ...). On
    // Vulkan, the device's framebufferColorSampleCounts & framebufferDepthSampleCounts (as the
    // Vulkan-Samples framework reads them, whatever the formats); on D3D, the counts with
    // multisample quality levels for both formats.
    int Donut_GetSupportedSampleCounts(App* app, int colorFormat, int depthFormat)
    {
        nvrhi::IDevice* device = app->device();
        int counts = 1;
#if DONUT_WITH_VULKAN
        if (device->getGraphicsAPI() == nvrhi::GraphicsAPI::VULKAN)
        {
            const vk::PhysicalDevice physicalDevice = DeviceManagerVKAccess::PhysicalDevice(
                static_cast<DeviceManager_VK*>(app->deviceManager.get()));
            const vk::PhysicalDeviceLimits limits = physicalDevice.getProperties().limits;
            return static_cast<int>(static_cast<uint32_t>(limits.framebufferColorSampleCounts & limits.framebufferDepthSampleCounts));
        }
#endif
#if DONUT_WITH_DX12
        if (device->getGraphicsAPI() == nvrhi::GraphicsAPI::D3D12)
        {
            ID3D12Device* d3dDevice = device->getNativeObject(nvrhi::ObjectTypes::D3D12_Device);
            for (UINT count = 2; count <= D3D12_MAX_MULTISAMPLE_SAMPLE_COUNT; count *= 2)
            {
                bool supported = true;
                for (int format : { colorFormat, depthFormat })
                {
                    D3D12_FEATURE_DATA_MULTISAMPLE_QUALITY_LEVELS levels = {};
                    levels.Format = nvrhi::d3d12::convertFormat(static_cast<nvrhi::Format>(format));
                    levels.SampleCount = count;
                    supported = supported && SUCCEEDED(d3dDevice->CheckFeatureSupport(D3D12_FEATURE_MULTISAMPLE_QUALITY_LEVELS,
                        &levels, sizeof(levels))) && levels.NumQualityLevels > 0;
                }
                if (supported)
                    counts |= static_cast<int>(count);
            }
        }
#endif
#if DONUT_WITH_DX11
        if (device->getGraphicsAPI() == nvrhi::GraphicsAPI::D3D11)
        {
            ID3D11Device* d3dDevice = device->getNativeObject(nvrhi::ObjectTypes::D3D11_Device);
            for (UINT count = 2; count <= D3D11_MAX_MULTISAMPLE_SAMPLE_COUNT; count *= 2)
            {
                bool supported = true;
                for (int format : { colorFormat, depthFormat })
                {
                    UINT levels = 0;
                    supported = supported && SUCCEEDED(d3dDevice->CheckMultisampleQualityLevels(
                        nvrhi::d3d11::convertFormat(static_cast<nvrhi::Format>(format)), count, &levels)) && levels > 0;
                }
                if (supported)
                    counts |= static_cast<int>(count);
            }
        }
#endif
        (void)colorFormat;
        (void)depthFormat;
        return counts;
    }

    // Non-zero if render passes resolve multisampled targets into single-sampled ones as they end
    // (Donut_CreateResolveFramebuffer): Vulkan's dynamic rendering. NVRHI runs D3D11 and D3D12
    // without render passes; resolve there with Donut_ResolveTexture.
    int Donut_HasRenderPassResolve(App* app)
    {
        return app->device()->getGraphicsAPI() == nvrhi::GraphicsAPI::VULKAN ? 1 : 0;
    }

    // The ways render passes can resolve a multisampled depth buffer (Donut_CreateResolveFramebuffer),
    // as bits 1 << ResolveMode (SampleZero 1, Average 2, Min 3, Max 4): Vulkan's
    // supportedDepthResolveModes. 0 without render pass resolves (Donut_HasRenderPassResolve).
    int Donut_GetDepthResolveModes(App* app)
    {
#if DONUT_WITH_VULKAN
        App* a = app;
        if (a->device()->getGraphicsAPI() == nvrhi::GraphicsAPI::VULKAN)
        {
            const vk::PhysicalDevice physicalDevice = DeviceManagerVKAccess::PhysicalDevice(
                static_cast<DeviceManager_VK*>(a->deviceManager.get()));
            auto resolveProperties = vk::PhysicalDeviceDepthStencilResolveProperties();
            vk::PhysicalDeviceProperties2 properties2;
            properties2.pNext = &resolveProperties;
            physicalDevice.getProperties2(&properties2);
            const vk::ResolveModeFlags modes = resolveProperties.supportedDepthResolveModes;
            int bits = 0;
            if (modes & vk::ResolveModeFlagBits::eSampleZero)
                bits |= 1 << int(nvrhi::ResolveMode::SampleZero);
            if (modes & vk::ResolveModeFlagBits::eAverage)
                bits |= 1 << int(nvrhi::ResolveMode::Average);
            if (modes & vk::ResolveModeFlagBits::eMin)
                bits |= 1 << int(nvrhi::ResolveMode::Min);
            if (modes & vk::ResolveModeFlagBits::eMax)
                bits |= 1 << int(nvrhi::ResolveMode::Max);
            return bits;
        }
#endif
        (void)app;
        return 0;
    }

    // Render target (a color format) or depth buffer (a depth format, cleared to clearDepth) of
    // width x height with sampleCount samples (a Texture2DMS when more than 1), that shaders can
    // also read (Texture2DMS<...> there) and that can be resolved; resting at ShaderResource.
    // Returns null on failure.
    nvrhi::ITexture* Donut_CreateMultisampledTexture(App* app, int width, int height, int format, int sampleCount,
        double clearDepth, const char* debugName)
    {
        const auto textureFormat = static_cast<nvrhi::Format>(format);
        auto desc = nvrhi::TextureDesc()
            .setFormat(textureFormat)
            .setWidth(static_cast<uint32_t>(width))
            .setHeight(static_cast<uint32_t>(height))
            .setSampleCount(static_cast<uint32_t>(sampleCount))
            .setDimension(sampleCount > 1 ? nvrhi::TextureDimension::Texture2DMS : nvrhi::TextureDimension::Texture2D)
            .setIsRenderTarget(true)
            .setDebugName(debugName)
            .setInitialState(nvrhi::ResourceStates::ShaderResource)
            .setKeepInitialState(true);
        if (nvrhi::getFormatInfo(textureFormat).hasDepth)
        {
            // Typeless, for the depth-stencil view and the shader resource view to differ in format.
            desc.setIsTypeless(true).setClearValue(nvrhi::Color(float(clearDepth)));
        }

        App* a = app;
        return a->Own(a->device()->createTexture(desc));
    }

    // Framebuffer drawing into colorTexture and depthTexture (either null for none) whose render
    // passes, as they end, resolve the multisampled color into colorResolveTexture and the depth
    // into depthResolveTexture by depthResolveMode (an nvrhi::ResolveMode, one of
    // Donut_GetDepthResolveModes) where those aren't null. Needs Donut_HasRenderPassResolve; NVRHI
    // ends a render pass at every barrier, so a pass with several may resolve several times, with
    // the same result. Returns null on failure.
    nvrhi::IFramebuffer* Donut_CreateResolveFramebuffer(App* app, nvrhi::ITexture* colorTexture, nvrhi::ITexture* colorResolveTexture, nvrhi::ITexture* depthTexture,
        nvrhi::ITexture* depthResolveTexture, int depthResolveMode)
    {
        auto desc = nvrhi::FramebufferDesc();
        if (colorTexture)
        {
            desc.addColorAttachment(colorTexture);
            if (colorResolveTexture)
                desc.addColorResolveAttachment(colorResolveTexture);
        }
        if (depthTexture)
        {
            desc.setDepthAttachment(depthTexture);
            if (depthResolveTexture)
            {
                desc.setDepthResolveAttachment(depthResolveTexture,
                    static_cast<nvrhi::ResolveMode>(depthResolveMode));
            }
        }

        App* a = app;
        return a->Own(a->device()->createFramebuffer(desc));
    }

    // The swap chain's back buffers: their count, and the one at index (valid until the back
    // buffers are resized: recreate what refers to them in the back buffer resizing callback).
    int Donut_GetBackBufferCount(App* app)
    {
        return static_cast<int>(app->deviceManager->GetBackBufferCount());
    }

    nvrhi::ITexture* Donut_GetBackBuffer(App* app, int index)
    {
        return app->deviceManager->GetBackBuffer(static_cast<uint32_t>(index));
    }

    // The index of the back buffer the current frame renders into (in a render callback).
    int Donut_GetCurrentBackBufferIndex(App* app)
    {
        return static_cast<int>(app->deviceManager->GetCurrentBackBufferIndex());
    }

    // The back buffers' format, an nvrhi::Format value (SRGBA8_UNORM with D3D, SBGRA8_UNORM with
    // Vulkan).
    int Donut_GetBackBufferFormat(App* app)
    {
        return static_cast<int>(app->deviceManager->GetBackBuffer(0)->getDesc().format);
    }

#ifdef _WIN32
    // A texture another D3D11 device writes and this one's shaders read (e.g. Media Foundation's
    // video frames, Donut_TransferVideoFrame), as the ATG VideoTexture samples make it: a render
    // target, shared through an NT handle; on D3D12 also D3D12_RESOURCE_FLAG_ALLOW_SIMULTANEOUS_ACCESS
    // and D3D12_HEAP_FLAG_SHARED. Resting at ShaderResource.
    struct SharedTexture
    {
        nvrhi::TextureHandle texture;
        HANDLE handle = nullptr;
        ~SharedTexture()
        {
            if (handle)
                CloseHandle(handle);
        }
    };

    // D3D12 and D3D11 only: null with other APIs, and (after logging why) on failure.
    void* Donut_CreateSharedTexture(App* app, int width, int height, int format, const char* debugName)
    {
        App* a = app;
        nvrhi::IDevice* device = a->device();
        auto textureDesc = nvrhi::TextureDesc()
            .setWidth(static_cast<uint32_t>(width))
            .setHeight(static_cast<uint32_t>(height))
            .setFormat(static_cast<nvrhi::Format>(format))
            .setIsRenderTarget(true)
            .setDebugName(debugName)
            .setInitialState(nvrhi::ResourceStates::ShaderResource)
            .setKeepInitialState(true);
        auto shared = std::make_shared<SharedTexture>();
#if DONUT_WITH_DX12
        if (device->getGraphicsAPI() == nvrhi::GraphicsAPI::D3D12)
        {
            ID3D12Device* d3dDevice = device->getNativeObject(nvrhi::ObjectTypes::D3D12_Device);
            D3D12_RESOURCE_DESC desc = {};
            desc.Dimension = D3D12_RESOURCE_DIMENSION_TEXTURE2D;
            desc.Width = UINT64(width);
            desc.Height = UINT(height);
            desc.DepthOrArraySize = 1;
            desc.MipLevels = 1;
            desc.Format = nvrhi::d3d12::convertFormat(textureDesc.format);
            desc.SampleDesc.Count = 1;
            desc.Flags = D3D12_RESOURCE_FLAG_ALLOW_RENDER_TARGET | D3D12_RESOURCE_FLAG_ALLOW_SIMULTANEOUS_ACCESS;
            D3D12_HEAP_PROPERTIES heap = {};
            heap.Type = D3D12_HEAP_TYPE_DEFAULT;
            Microsoft::WRL::ComPtr<ID3D12Resource> resource;
            if (FAILED(d3dDevice->CreateCommittedResource(&heap, D3D12_HEAP_FLAG_SHARED, &desc,
                    D3D12_RESOURCE_STATE_PIXEL_SHADER_RESOURCE, nullptr, IID_PPV_ARGS(&resource)))
                || FAILED(d3dDevice->CreateSharedHandle(resource.Get(), nullptr, GENERIC_ALL, nullptr, &shared->handle)))
            {
                donut::log::error("Donut_CreateSharedTexture: cannot create a shared D3D12 texture");
                return nullptr;
            }
            shared->texture = device->createHandleForNativeTexture(nvrhi::ObjectTypes::D3D12_Resource,
                nvrhi::Object(resource.Get()), textureDesc);
        }
#endif
#if DONUT_WITH_DX11
        if (device->getGraphicsAPI() == nvrhi::GraphicsAPI::D3D11)
        {
            ID3D11Device* d3dDevice = device->getNativeObject(nvrhi::ObjectTypes::D3D11_Device);
            D3D11_TEXTURE2D_DESC desc = {};
            desc.Width = UINT(width);
            desc.Height = UINT(height);
            desc.MipLevels = 1;
            desc.ArraySize = 1;
            desc.Format = nvrhi::d3d11::convertFormat(textureDesc.format);
            desc.SampleDesc.Count = 1;
            desc.Usage = D3D11_USAGE_DEFAULT;
            desc.BindFlags = D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET;
            desc.MiscFlags = D3D11_RESOURCE_MISC_SHARED | D3D11_RESOURCE_MISC_SHARED_NTHANDLE;
            Microsoft::WRL::ComPtr<ID3D11Texture2D> texture;
            Microsoft::WRL::ComPtr<IDXGIResource1> dxgiResource;
            if (FAILED(d3dDevice->CreateTexture2D(&desc, nullptr, &texture))
                || FAILED(texture.As(&dxgiResource))
                || FAILED(dxgiResource->CreateSharedHandle(nullptr, DXGI_SHARED_RESOURCE_READ | DXGI_SHARED_RESOURCE_WRITE,
                    nullptr, &shared->handle)))
            {
                donut::log::error("Donut_CreateSharedTexture: cannot create a shared D3D11 texture");
                return nullptr;
            }
            shared->texture = device->createHandleForNativeTexture(nvrhi::ObjectTypes::D3D11_Resource,
                nvrhi::Object(texture.Get()), textureDesc);
        }
#endif
        // Other APIs: none (the caller takes another way).
        if (!shared->texture)
            return nullptr;
        return a->OwnObject(shared);
    }

    // The texture, for bindings; valid as long as the shared texture.
    nvrhi::ITexture* Donut_GetSharedTexture(void* sharedTexture)
    {
        return static_cast<SharedTexture*>(sharedTexture)->texture.Get();
    }

    // Its NT handle, for the other device's OpenSharedResource1.
    void* Donut_GetSharedTextureHandle(void* sharedTexture)
    {
        return static_cast<SharedTexture*>(sharedTexture)->handle;
    }

    // The LUID of the device's adapter into dst (2 ints: low, high part), e.g. for another API's
    // device on the same GPU. Returns 0 if the API doesn't give it.
    int Donut_GetAdapterLuid(App* app, int* dst)
    {
        nvrhi::IDevice* device = app->device();
        LUID luid = {};
        bool found = false;
#if DONUT_WITH_DX12
        if (device->getGraphicsAPI() == nvrhi::GraphicsAPI::D3D12)
        {
            ID3D12Device* d3dDevice = device->getNativeObject(nvrhi::ObjectTypes::D3D12_Device);
            luid = d3dDevice->GetAdapterLuid();
            found = true;
        }
#endif
#if DONUT_WITH_DX11
        if (device->getGraphicsAPI() == nvrhi::GraphicsAPI::D3D11)
        {
            ID3D11Device* d3dDevice = device->getNativeObject(nvrhi::ObjectTypes::D3D11_Device);
            Microsoft::WRL::ComPtr<IDXGIDevice> dxgiDevice;
            Microsoft::WRL::ComPtr<IDXGIAdapter> adapter;
            DXGI_ADAPTER_DESC desc;
            if (SUCCEEDED(d3dDevice->QueryInterface(IID_PPV_ARGS(&dxgiDevice))) && SUCCEEDED(dxgiDevice->GetAdapter(&adapter))
                && SUCCEEDED(adapter->GetDesc(&desc)))
            {
                luid = desc.AdapterLuid;
                found = true;
            }
        }
#endif
#if DONUT_WITH_VULKAN
        if (device->getGraphicsAPI() == nvrhi::GraphicsAPI::VULKAN)
        {
            auto* vulkanDeviceManager = static_cast<DeviceManager_VK*>(app->deviceManager.get());
            const auto properties = DeviceManagerVKAccess::PhysicalDevice(vulkanDeviceManager).getProperties2<
                vk::PhysicalDeviceProperties2, vk::PhysicalDeviceIDProperties>();
            const auto& id = properties.get<vk::PhysicalDeviceIDProperties>();
            if (id.deviceLUIDValid)
            {
                memcpy(&luid, id.deviceLUID.data(), sizeof(luid));
                found = true;
            }
        }
#endif
        dst[0] = static_cast<int>(luid.LowPart);
        dst[1] = static_cast<int>(luid.HighPart);
        return found ? 1 : 0;
    }
#endif

    // The color space of what the back buffers hold, a donut::app::SwapChainColorSpace value (0 sRGB,
    // 1 HDR10, 2 scRGB).
    int Donut_GetSwapChainColorSpace(App* app)
    {
        return static_cast<int>(app->deviceManager->GetSwapChainColorSpace());
    }

    // Asks for another color space of the back buffers, from the next frame on (as a resize: the
    // passes' back buffer resizing callbacks run). Returns 0 (and changes nothing) if the swap chain
    // can't present it with its format and display.
    int Donut_SetSwapChainColorSpace(App* app, int colorSpace)
    {
        DeviceManager* deviceManager = app->deviceManager.get();
        const auto value = static_cast<donut::app::SwapChainColorSpace>(colorSpace);
        if (!deviceManager->IsSwapChainColorSpaceSupported(value))
            return 0;
        deviceManager->SetSwapChainColorSpace(value);
        return 1;
    }

    // Whether the display the window is mostly on is in HDR mode (Windows' HDR / advanced color on,
    // an HDR10 output: DXGI_COLOR_SPACE_RGB_FULL_G2084_NONE_P2020), as the ATG samples'
    // DeviceResources::UpdateColorSpace finds it. 0 elsewhere than on Windows.
    int Donut_IsDisplayHdr(App* app)
    {
#ifdef _WIN32
        HWND hwnd = glfwGetWin32Window(app->deviceManager->GetWindow());
        RECT window;
        if (!hwnd || !GetWindowRect(hwnd, &window))
            return 0;

        IDXGIFactory1* factory = nullptr;
        if (FAILED(CreateDXGIFactory1(IID_PPV_ARGS(&factory))))
            return 0;

        // The output with the largest intersection with the window.
        IDXGIOutput* bestOutput = nullptr;
        long bestArea = -1;
        IDXGIAdapter1* adapter = nullptr;
        for (UINT a = 0; factory->EnumAdapters1(a, &adapter) != DXGI_ERROR_NOT_FOUND; ++a)
        {
            IDXGIOutput* output = nullptr;
            for (UINT o = 0; adapter->EnumOutputs(o, &output) != DXGI_ERROR_NOT_FOUND; ++o)
            {
                DXGI_OUTPUT_DESC desc;
                output->GetDesc(&desc);
                const RECT& r = desc.DesktopCoordinates;
                const long width = std::max(0L, std::min(window.right, r.right) - std::max(window.left, r.left));
                const long height = std::max(0L, std::min(window.bottom, r.bottom) - std::max(window.top, r.top));
                if (width * height > bestArea)
                {
                    if (bestOutput)
                        bestOutput->Release();
                    bestOutput = output;
                    bestArea = width * height;
                }
                else
                {
                    output->Release();
                }
            }
            adapter->Release();
        }
        factory->Release();

        int hdr = 0;
        IDXGIOutput6* output6 = nullptr;
        if (bestOutput && SUCCEEDED(bestOutput->QueryInterface(IID_PPV_ARGS(&output6))))
        {
            DXGI_OUTPUT_DESC1 desc1;
            if (SUCCEEDED(output6->GetDesc1(&desc1)) && desc1.ColorSpace == DXGI_COLOR_SPACE_RGB_FULL_G2084_NONE_P2020)
                hdr = 1;
            output6->Release();
        }
        if (bestOutput)
            bestOutput->Release();
        return hdr;
#else
        (void)app;
        return 0;
#endif
    }

    // --- Shadows ------------------------------------------------------------------------------

    // A cascaded shadow map of numCascades resolution x resolution cascades.
    void* Donut_CreateCascadedShadowMap(App* app, int resolution, int numCascades)
    {
        App* a = app;
        auto target = std::make_shared<ShadowMapTarget>();
        target->cascaded = std::make_shared<donut::render::CascadedShadowMap>(a->device(), resolution, numCascades, 0,
            ChooseDepthFormat(a->device()));
        target->cascaded->SetupProxyViews();

        target->framebuffer = std::make_shared<donut::engine::FramebufferFactory>(a->device());
        target->framebuffer->DepthTarget = target->cascaded->GetTexture();
        return a->OwnObject(target);
    }

    // A planar shadow map of resolution x resolution: one orthographic view for a directional
    // light (Donut_SetupPlanarShadowMapForScene), no cascades. Works wherever a cascaded one does,
    // except the Donut_SetupShadowMapFor* fitting functions, which leave it unchanged.
    void* Donut_CreatePlanarShadowMap(App* app, int resolution)
    {
        App* a = app;
        auto target = std::make_shared<ShadowMapTarget>();
        target->planar = std::make_shared<donut::render::PlanarShadowMap>(a->device(), resolution,
            ChooseDepthFormat(a->device()));
        target->planar->SetupProxyView();

        target->framebuffer = std::make_shared<donut::engine::FramebufferFactory>(a->device());
        target->framebuffer->DepthTarget = target->planar->GetTexture();
        return a->OwnObject(target);
    }

    // Fits a planar shadow map's view to a directional light and the whole scene graph's bounds;
    // shadows fade out over fadeRangeWorld (world units) at its edges. Returns 1 if the view
    // changed (the shadow map needs rendering again), 0 if not or for a cascaded shadow map.
    // (patches/Donut-planar-shadow-map-whole-scene-depth-range.patch fixes its depth range.) The
    // bounds grow by 1% of their diagonal first, so that geometry on them (Sponza's flat roofs) isn't
    // on the light's near or far plane: D3D clamps depth there, Vulkan clips (NVRHI turns depth
    // clipping off only with VK_EXT_depth_clip_enable, which the app doesn't enable).
    int Donut_SetupPlanarShadowMapForScene(void* shadowMapTarget, void* light, void* sceneGraph, double fadeRangeWorld)
    {
        auto* target = static_cast<ShadowMapTarget*>(shadowMapTarget);
        if (!target->planar)
            return 0;
        dm::box3 bounds = AsSceneGraph(sceneGraph)->GetRootNode()->GetGlobalBoundingBox();
        bounds = bounds.grow(dm::float3(0.01f * dm::length(bounds.diagonal())));
        return target->planar->SetupWholeSceneDirectionalLightView(
            *static_cast<donut::engine::DirectionalLight*>(static_cast<donut::engine::Light*>(light)),
            bounds, float(fadeRangeWorld)) ? 1 : 0;
    }

    // The depth texture, one array slice per cascade (one for a planar shadow map).
    nvrhi::ITexture* Donut_GetShadowMapTexture(void* shadowMapTarget)
    {
        return static_cast<ShadowMapTarget*>(shadowMapTarget)->shadowMap()->GetTexture();
    }

    // Fits the cascades to a directional light and the first planar view of `view`, out to
    // maxShadowDistance, with cascade split exponent `exponent` (stable: they don't shimmer
    // when the camera moves).
    void Donut_SetupShadowMapForView(void* shadowMapTarget, void* light, void* view, double maxShadowDistance,
        double zRange, double exponent)
    {
        auto* target = static_cast<ShadowMapTarget*>(shadowMapTarget);
        if (!target->cascaded)
            return;
        donut::engine::IView* v = AsView(view);
        const dm::affine3 viewMatrixInv = v->GetChildView(donut::engine::ViewType::PLANAR, 0)->GetInverseViewMatrix();
        target->cascaded->SetupForPlanarViewStable(
            *static_cast<donut::engine::DirectionalLight*>(static_cast<donut::engine::Light*>(light)),
            v->GetProjectionFrustum(), viewMatrixInv, float(maxShadowDistance), float(zRange), float(zRange), float(exponent));
    }

    void Donut_ClearShadowMap(nvrhi::ICommandList* commandList, void* shadowMapTarget)
    {
        auto* target = static_cast<ShadowMapTarget*>(shadowMapTarget);
        if (target->cascaded)
            target->cascaded->Clear(commandList);
        else
            target->planar->Clear(commandList);
    }

    // Donut's depth-only pass, with depth biases for shadow maps.
    void* Donut_CreateShadowDepthPass(App* app, int depthBias, double slopeScaledDepthBias)
    {
        App* a = app;
        donut::render::DepthPass::CreateParameters params;
        params.depthBias = depthBias;
        params.slopeScaledDepthBias = float(slopeScaledDepthBias);
        auto pass = std::make_shared<donut::render::DepthPass>(a->device(), a->sharedCommonPasses());
        pass->Init(*a->shaderFactory, params);
        return a->OwnObject(pass);
    }

    void Donut_ResetDepthPassBindingCache(void* depthPass)
    {
        static_cast<donut::render::DepthPass*>(depthPass)->ResetBindingCache();
    }

    // Draws the opaque meshes of a scene graph into all the shadow map's cascades.
    // materialEvents != 0: one GPU marker per material.
    void Donut_RenderShadowDepth(nvrhi::ICommandList* commandList, void* depthPass, void* shadowMapTarget, void* sceneGraph, int materialEvents)
    {
        auto* target = static_cast<ShadowMapTarget*>(shadowMapTarget);
        donut::render::InstancedOpaqueDrawStrategy strategy;
        donut::render::DepthPass::Context context;
        donut::render::RenderCompositeView(commandList, &target->shadowMap()->GetView(), nullptr,
            *target->framebuffer, AsSceneGraph(sceneGraph)->GetRootNode(), strategy,
            *static_cast<donut::render::DepthPass*>(depthPass), context, "ShadowMap", materialEvents != 0);
    }

    // --- Geometry passes ------------------------------------------------------------------------

    // Donut_CreateForwardShadingPass with options: singlePassCubemap != 0 renders all six faces
    // of a cube map view at once (needs nvrhi::Feature::FastGeometryShader); trackLiveness == 0
    // skips resource liveness tracking.
    void* Donut_CreateForwardShadingPassWithOptions(App* app, int singlePassCubemap, int trackLiveness)
    {
        App* a = app;
        donut::render::ForwardShadingPass::CreateParameters params;
        params.singlePassCubemap = singlePassCubemap != 0;
        params.trackLiveness = trackLiveness != 0;
        auto pass = std::make_shared<donut::render::ForwardShadingPass>(a->device(), a->sharedCommonPasses());
        pass->Init(*a->shaderFactory, params);
        return a->OwnObject(pass);
    }

    void Donut_ResetForwardShadingBindingCache(void* forwardShadingPass)
    {
        static_cast<donut::render::ForwardShadingPass*>(forwardShadingPass)->ResetBindingCache();
    }

    // The lights a forward shading pass renders with (Donut_PrepareForwardLights), kept between
    // its draws.
    void* Donut_CreateForwardShadingContext(App* app)
    {
        return app->OwnObject(std::make_shared<donut::render::ForwardShadingPass::Context>());
    }

    // Uploads a scene graph's lights, a top / bottom ambient term and the enabled probes of a
    // light probe set (or none: null) for Donut_RenderForward with the same context.
    void Donut_PrepareForwardLights(nvrhi::ICommandList* commandList, void* forwardShadingPass, void* forwardShadingContext, void* sceneGraph,
        double topR, double topG, double topB, double bottomR, double bottomG, double bottomB, void* lightProbeSet)
    {
        std::vector<std::shared_ptr<donut::engine::LightProbe>> lightProbes;
        if (lightProbeSet)
            lightProbes = static_cast<LightProbeSet*>(lightProbeSet)->EnabledProbes();

        static_cast<donut::render::ForwardShadingPass*>(forwardShadingPass)->PrepareLights(
            *static_cast<donut::render::ForwardShadingPass::Context*>(forwardShadingContext), commandList,
            AsSceneGraph(sceneGraph)->GetLights(), dm::float3(float(topR), float(topG), float(topB)),
            dm::float3(float(bottomR), float(bottomG), float(bottomB)), lightProbes);
    }

    // Draws a scene graph's opaque (transparent == 0) or transparent meshes with a forward shading
    // pass into a framebuffer, as seen by view; previousView (or null) is for motion vectors.
    // `name` labels the GPU marker; materialEvents != 0 adds one per material.
    void Donut_RenderForward(nvrhi::ICommandList* commandList, void* forwardShadingPass, void* forwardShadingContext, void* view,
        void* previousView, FramebufferFactoryRef* framebuffer, void* sceneGraph, int transparent, const char* name, int materialEvents)
    {
        donut::render::InstancedOpaqueDrawStrategy opaqueStrategy;
        donut::render::TransparentDrawStrategy transparentStrategy;
        donut::render::IDrawStrategy& strategy = transparent
            ? static_cast<donut::render::IDrawStrategy&>(transparentStrategy) : opaqueStrategy;

        donut::render::RenderCompositeView(commandList, AsView(view),
            previousView ? AsView(previousView) : nullptr, **framebuffer,
            AsSceneGraph(sceneGraph)->GetRootNode(), strategy, *static_cast<donut::render::ForwardShadingPass*>(forwardShadingPass),
            *static_cast<donut::render::ForwardShadingPass::Context*>(forwardShadingContext), name, materialEvents != 0);
    }

    // Donut_CreateGBufferFillPass with options: enableMotionVectors != 0 writes motion vectors
    // (and stencilWriteMask into the stencil where it does, for TAA).
    void* Donut_CreateGBufferFillPassWithOptions(App* app, int enableMotionVectors, int stencilWriteMask)
    {
        App* a = app;
        donut::render::GBufferFillPass::CreateParameters params;
        params.enableMotionVectors = enableMotionVectors != 0;
        params.stencilWriteMask = static_cast<uint8_t>(stencilWriteMask);
        auto pass = std::make_shared<donut::render::GBufferFillPass>(a->device(), a->sharedCommonPasses());
        pass->Init(*a->shaderFactory, params);
        return a->OwnObject(pass);
    }

    void Donut_ResetGBufferFillBindingCache(void* gbufferFillPass)
    {
        static_cast<donut::render::GBufferFillPass*>(gbufferFillPass)->ResetBindingCache();
    }

    // Draws a scene graph's opaque meshes into the targets' G-buffer, as seen by view (and, for
    // motion vectors, previousView).
    void Donut_RenderGBufferFill(nvrhi::ICommandList* commandList, void* gbufferFillPass, void* view, void* previousView,
        void* sceneRenderTargets, void* sceneGraph, int materialEvents)
    {
        donut::render::InstancedOpaqueDrawStrategy strategy;
        donut::render::GBufferFillPass::Context context;
        donut::render::RenderCompositeView(commandList, AsView(view), AsView(previousView),
            *AsSceneRenderTargets(sceneRenderTargets)->GBufferFramebuffer, AsSceneGraph(sceneGraph)->GetRootNode(), strategy,
            *static_cast<donut::render::GBufferFillPass*>(gbufferFillPass), context, "GBufferFill", materialEvents != 0);
    }

    // Donut's material ID pass: writes each pixel's material ID and instance index (RG16_UINT).
    void* Donut_CreateMaterialIDPass(App* app, int stencilWriteMask)
    {
        App* a = app;
        donut::render::GBufferFillPass::CreateParameters params;
        params.enableMotionVectors = false;
        params.stencilWriteMask = static_cast<uint8_t>(stencilWriteMask);
        auto pass = std::make_shared<donut::render::MaterialIDPass>(a->device(), a->sharedCommonPasses());
        pass->Init(*a->shaderFactory, params);
        return a->OwnObject(pass);
    }

    // Draws a scene graph's opaque (transparent == 0) or transparent meshes into the targets'
    // material IDs.
    void Donut_RenderMaterialIDs(nvrhi::ICommandList* commandList, void* materialIdPass, void* view, void* previousView,
        void* sceneRenderTargets, void* sceneGraph, int transparent)
    {
        donut::render::InstancedOpaqueDrawStrategy opaqueStrategy;
        donut::render::TransparentDrawStrategy transparentStrategy;
        donut::render::IDrawStrategy& strategy = transparent
            ? static_cast<donut::render::IDrawStrategy&>(transparentStrategy) : opaqueStrategy;

        donut::render::MaterialIDPass::Context context;
        donut::render::RenderCompositeView(commandList, AsView(view), AsView(previousView),
            *AsSceneRenderTargets(sceneRenderTargets)->MaterialIDFramebuffer, AsSceneGraph(sceneGraph)->GetRootNode(), strategy,
            *static_cast<donut::render::MaterialIDPass*>(materialIdPass), context,
            transparent ? "MaterialID - Translucent" : "MaterialID");
    }

    // Lights the targets' G-buffer into their HDR color with a scene graph's lights, a top /
    // bottom ambient term, the targets' ambient occlusion (useAmbientOcclusion != 0) and a light
    // probe set (or none: null).
    void Donut_RenderDeferredLightingToHdr(nvrhi::ICommandList* commandList, void* deferredLightingPass, void* view, void* sceneRenderTargets,
        void* sceneGraph, int useAmbientOcclusion, double topR, double topG, double topB,
        double bottomR, double bottomG, double bottomB, void* lightProbeSet)
    {
        auto* targets = AsSceneRenderTargets(sceneRenderTargets);

        donut::render::DeferredLightingPass::Inputs inputs;
        inputs.SetGBuffer(*targets);
        inputs.ambientOcclusion = useAmbientOcclusion ? targets->AmbientOcclusion.Get() : nullptr;
        inputs.ambientColorTop = dm::float3(float(topR), float(topG), float(topB));
        inputs.ambientColorBottom = dm::float3(float(bottomR), float(bottomG), float(bottomB));
        inputs.lights = &AsSceneGraph(sceneGraph)->GetLights();
        inputs.lightProbes = lightProbeSet ? &static_cast<LightProbeSet*>(lightProbeSet)->probes : nullptr;
        inputs.output = targets->HdrColor;

        static_cast<donut::render::DeferredLightingPass*>(deferredLightingPass)->Render(
            commandList, *AsView(view), inputs);
    }

    // --- Post-processing and other passes -----------------------------------------------------

    // Donut's SSAO over the targets' depth and G-buffer normals, into their ambient occlusion.
    // Single-sample targets only.
    void* Donut_CreateSsaoPass(App* app, void* sceneRenderTargets)
    {
        App* a = app;
        auto* targets = AsSceneRenderTargets(sceneRenderTargets);
        return a->OwnObject(std::make_shared<donut::render::SsaoPass>(a->device(), a->shaderFactory, a->sharedCommonPasses(),
            targets->Depth, targets->GBufferNormals, targets->AmbientOcclusion));
    }

    // With default parameters.
    void Donut_RenderSsao(nvrhi::ICommandList* commandList, void* ssaoPass, void* view)
    {
        static_cast<donut::render::SsaoPass*>(ssaoPass)->Render(commandList,
            donut::render::SsaoParameters(), *AsView(view));
    }

    // Donut's procedural sky, drawn where the framebuffer's depth is still clear.
    void* Donut_CreateSkyPass(App* app, FramebufferFactoryRef* framebuffer, void* view)
    {
        App* a = app;
        return a->OwnObject(std::make_shared<donut::render::SkyPass>(a->device(), a->shaderFactory, a->sharedCommonPasses(),
            *framebuffer, *AsView(view)));
    }

    // Donut's environment map background: a lat-long (2D) or cube map texture drawn where the
    // framebuffer's depth is still clear. The view must be set up first (its depth direction picks
    // the pipeline).
    void* Donut_CreateEnvironmentMapPass(App* app, FramebufferFactoryRef* framebuffer, void* view, nvrhi::ITexture* environmentMap)
    {
        App* a = app;
        return a->OwnObject(std::make_shared<donut::render::EnvironmentMapPass>(a->device(), a->shaderFactory,
            a->sharedCommonPasses(), *framebuffer, *AsView(view),
            environmentMap));
    }

    void Donut_RenderEnvironmentMap(nvrhi::ICommandList* commandList, void* environmentMapPass, void* view)
    {
        static_cast<donut::render::EnvironmentMapPass*>(environmentMapPass)->Render(commandList, *AsView(view));
    }

    // Draws the sky around a directional light; the SkyParameters not given keep their defaults.
    void Donut_RenderSky(nvrhi::ICommandList* commandList, void* skyPass, void* view, void* light, double brightness,
        double glowSize, double glowSharpness, double glowIntensity, double horizonSize)
    {
        donut::render::SkyParameters params;
        params.brightness = float(brightness);
        params.glowSize = float(glowSize);
        params.glowSharpness = float(glowSharpness);
        params.glowIntensity = float(glowIntensity);
        params.horizonSize = float(horizonSize);
        static_cast<donut::render::SkyPass*>(skyPass)->Render(commandList, *AsView(view),
            *static_cast<donut::engine::DirectionalLight*>(static_cast<donut::engine::Light*>(light)), params);
    }

    // Donut's TAA over the targets: resolves HDR color into resolved color with Catmull-Rom
    // filtering, using motion vectors where the stencil has motionVectorStencilMask set.
    void* Donut_CreateSceneTemporalAntiAliasingPass(App* app, void* view, void* sceneRenderTargets, int motionVectorStencilMask)
    {
        App* a = app;
        auto* targets = AsSceneRenderTargets(sceneRenderTargets);

        donut::render::TemporalAntiAliasingPass::CreateParameters params;
        params.sourceDepth = targets->Depth;
        params.motionVectors = targets->MotionVectors;
        params.unresolvedColor = targets->HdrColor;
        params.resolvedColor = targets->ResolvedColor;
        params.feedback1 = targets->TemporalFeedback1;
        params.feedback2 = targets->TemporalFeedback2;
        params.motionVectorStencilMask = static_cast<uint32_t>(motionVectorStencilMask);
        params.useCatmullRomFilter = true;

        return a->OwnObject(std::make_shared<donut::render::TemporalAntiAliasingPass>(a->device(), a->shaderFactory,
            a->sharedCommonPasses(), *AsView(view), params));
    }

    // A donut::render::TemporalAntiAliasingJitter value: 0 MSAA, 1 Halton, 2 R2, 3 white noise.
    void Donut_SetTemporalJitter(void* temporalAntiAliasingPass, int jitter)
    {
        static_cast<donut::render::TemporalAntiAliasingPass*>(temporalAntiAliasingPass)->SetJitter(
            static_cast<donut::render::TemporalAntiAliasingJitter>(jitter));
    }

    // This frame's sub-pixel jitter, as 2 floats into dst (for Donut_SetPlanarViewJittered).
    void Donut_GetTemporalPixelOffset(void* temporalAntiAliasingPass, void* dst)
    {
        const dm::float2 offset = static_cast<donut::render::TemporalAntiAliasingPass*>(temporalAntiAliasingPass)->GetCurrentPixelOffset();
        memcpy(dst, &offset, sizeof(offset));
    }

    // Donut_RenderMotionVectors for any view.
    void Donut_RenderViewMotionVectors(nvrhi::ICommandList* commandList, void* temporalAntiAliasingPass, void* view, void* previousView)
    {
        static_cast<donut::render::TemporalAntiAliasingPass*>(temporalAntiAliasingPass)->RenderMotionVectors(
            commandList, *AsView(view), *AsView(previousView));
    }

    // Donut_TemporalResolve for any view, with history clamping on or off.
    void Donut_TemporalResolveView(nvrhi::ICommandList* commandList, void* temporalAntiAliasingPass, void* view, int feedbackIsValid,
        int enableHistoryClamping)
    {
        donut::render::TemporalAntiAliasingParameters params;
        params.enableHistoryClamping = enableHistoryClamping != 0;
        static_cast<donut::render::TemporalAntiAliasingPass*>(temporalAntiAliasingPass)->TemporalResolve(
            commandList, params, feedbackIsValid != 0, *AsView(view), *AsView(view));
    }

    // Moves on to the next jitter offset; once per frame.
    void Donut_AdvanceTemporalFrame(void* temporalAntiAliasingPass)
    {
        static_cast<donut::render::TemporalAntiAliasingPass*>(temporalAntiAliasingPass)->AdvanceFrame();
    }

    // Donut's tone mapping with eye adaptation, into a framebuffer. Pass the tone mapping pass
    // this one replaces (or null) to keep its adapted exposure.
    void* Donut_CreateToneMappingPass(App* app, FramebufferFactoryRef* framebuffer, void* view, void* previousToneMappingPass)
    {
        App* a = app;
        donut::render::ToneMappingPass::CreateParameters params;
        if (previousToneMappingPass)
            params.exposureBufferOverride = static_cast<donut::render::ToneMappingPass*>(previousToneMappingPass)->GetExposureBuffer();
        return a->OwnObject(std::make_shared<donut::render::ToneMappingPass>(a->device(), a->shaderFactory,
            a->sharedCommonPasses(), *framebuffer, *AsView(view), params));
    }

    // Once per frame, with the frame time in seconds (for eye adaptation).
    void Donut_AdvanceToneMappingFrame(void* toneMappingPass, double elapsedSeconds)
    {
        static_cast<donut::render::ToneMappingPass*>(toneMappingPass)->AdvanceFrame(float(elapsedSeconds));
    }

    void Donut_ResetExposure(nvrhi::ICommandList* commandList, void* toneMappingPass, double initialExposure)
    {
        static_cast<donut::render::ToneMappingPass*>(toneMappingPass)->ResetExposure(commandList, float(initialExposure));
    }

    // Tone maps an HDR texture with default parameters. instantAdaptation != 0 sets the exposure
    // to this frame's at once (eye adaptation speeds 0, as Donut's feature demo does right after
    // Donut_ResetExposure); otherwise it adapts at the default speeds over the frame time of
    // Donut_AdvanceToneMappingFrame, and stays as it is while that is 0 (never advanced).
    void Donut_RenderToneMapping(nvrhi::ICommandList* commandList, void* toneMappingPass, void* view, nvrhi::ITexture* sourceTexture, int instantAdaptation)
    {
        donut::render::ToneMappingParameters params;
        if (instantAdaptation)
        {
            params.eyeAdaptationSpeedUp = 0.f;
            params.eyeAdaptationSpeedDown = 0.f;
        }
        static_cast<donut::render::ToneMappingPass*>(toneMappingPass)->SimpleRender(commandList, params,
            *AsView(view), sourceTexture);
    }

    // Donut's bloom, blended into a framebuffer's color.
    void* Donut_CreateBloomPass(App* app, FramebufferFactoryRef* framebuffer, void* view)
    {
        App* a = app;
        return a->OwnObject(std::make_shared<donut::render::BloomPass>(a->device(), a->shaderFactory, a->sharedCommonPasses(),
            *framebuffer, *AsView(view)));
    }

    // Blurs sourceTexture (Gaussian sigma in pixels) and adds it to the framebuffer, weighted by alpha.
    void Donut_RenderBloom(nvrhi::ICommandList* commandList, void* bloomPass, FramebufferFactoryRef* framebuffer, void* view, nvrhi::ITexture* sourceTexture,
        double sigma, double alpha)
    {
        static_cast<donut::render::BloomPass*>(bloomPass)->Render(commandList, *framebuffer,
            *AsView(view), sourceTexture, float(sigma), float(alpha));
    }

    // NVIDIA DLSS, loading nvngx_dlss.dll from the executable's directory (donut_interop.dll's under
    // the JIT). Null when Donut was built without DONUT_WITH_DLSS, or the device can't create it.
    void* Donut_CreateDlss(App* app)
    {
#if DONUT_WITH_DLSS
        App* a = app;
        std::shared_ptr<donut::render::DLSS> dlss = donut::render::DLSS::Create(a->device(), *a->shaderFactory,
            GetExecutablePath().parent_path().generic_string());
        return a->OwnObject(dlss);
#else
        (void)app;
        return nullptr;
#endif
    }

    // Sets DLSS up for inputWidth x inputHeight images upscaled to outputWidth x outputHeight
    // (again whenever the sizes change). Returns non-zero if DLSS is ready to use.
    int Donut_InitDlss(void* dlss, int inputWidth, int inputHeight, int outputWidth, int outputHeight)
    {
#if DONUT_WITH_DLSS
        donut::render::DLSS::InitParameters params;
        params.inputWidth = uint32_t(inputWidth);
        params.inputHeight = uint32_t(inputHeight);
        params.outputWidth = uint32_t(outputWidth);
        params.outputHeight = uint32_t(outputHeight);
        auto* d = static_cast<donut::render::DLSS*>(dlss);
        d->Init(params);
        return d->IsDlssInitialized() ? 1 : 0;
#else
        (void)dlss; (void)inputWidth; (void)inputHeight; (void)outputWidth; (void)outputHeight;
        return 0;
#endif
    }

    int Donut_IsDlssInitialized(void* dlss)
    {
#if DONUT_WITH_DLSS
        return static_cast<donut::render::DLSS*>(dlss)->IsDlssInitialized() ? 1 : 0;
#else
        (void)dlss;
        return 0;
#endif
    }

    // Anti-aliases the targets' HDR color into their resolved color (instead of TAA), from their
    // depth and motion vectors, with the tone mapping pass's exposure. Planar views only.
    void Donut_EvaluateDlss(nvrhi::ICommandList* commandList, void* dlss, void* view, void* sceneRenderTargets, void* toneMappingPass)
    {
#if DONUT_WITH_DLSS
        auto* targets = AsSceneRenderTargets(sceneRenderTargets);
        donut::render::DLSS::EvaluateParameters params;
        params.depthTexture = targets->Depth;
        params.motionVectorsTexture = targets->MotionVectors;
        params.inputColorTexture = targets->HdrColor;
        params.outputColorTexture = targets->ResolvedColor;
        params.exposureBuffer = static_cast<donut::render::ToneMappingPass*>(toneMappingPass)->GetExposureBuffer();
        static_cast<donut::render::DLSS*>(dlss)->Evaluate(commandList, params,
            *static_cast<donut::engine::PlanarView*>(view));
#else
        (void)commandList; (void)dlss; (void)view; (void)sceneRenderTargets; (void)toneMappingPass;
#endif
    }

    // Reads back one pixel of a texture (as RGBA32_UINT): Donut_CapturePixel, execute the command
    // list, then Donut_ReadPixelUInts.
    void* Donut_CreatePixelReadbackPass(App* app, nvrhi::ITexture* texture)
    {
        App* a = app;
        return a->OwnObject(std::make_shared<donut::render::PixelReadbackPass>(a->device(), a->shaderFactory,
            texture, nvrhi::Format::RGBA32_UINT));
    }

    void Donut_CapturePixel(nvrhi::ICommandList* commandList, void* pixelReadbackPass, int x, int y)
    {
        static_cast<donut::render::PixelReadbackPass*>(pixelReadbackPass)->Capture(commandList,
            dm::uint2(uint32_t(x), uint32_t(y)));
    }

    // The captured pixel as 4 ints into dst; waits for the GPU if needed.
    void Donut_ReadPixelUInts(void* pixelReadbackPass, void* dst)
    {
        const dm::uint4 value = static_cast<donut::render::PixelReadbackPass*>(pixelReadbackPass)->ReadUInts();
        memcpy(dst, &value, sizeof(value));
    }

    // Donut's mip generation (compute) for a color texture with mips.
    void* Donut_CreateMipMapGenPass(App* app, nvrhi::ITexture* texture)
    {
        App* a = app;
        return a->OwnObject(std::make_shared<donut::render::MipMapGenPass>(a->device(), a->shaderFactory,
            texture, donut::render::MipMapGenPass::MODE_COLOR));
    }

    void Donut_DispatchMipMapGen(nvrhi::ICommandList* commandList, void* mipMapGenPass)
    {
        static_cast<donut::render::MipMapGenPass*>(mipMapGenPass)->Dispatch(commandList);
    }

    // Inside a render callback: draws the texture's mips over the frame.
    void Donut_DisplayMipMapGen(App* app, FrameContext* frame, void* mipMapGenPass)
    {
        static_cast<donut::render::MipMapGenPass*>(mipMapGenPass)->Display(app->sharedCommonPasses(),
            frame->commandList, frame->framebuffer);
    }

    // --- Light probes -------------------------------------------------------------------------

    // numProbes light probes (named "1", "2", ...), disabled until rendered: 256x256 diffuse and
    // 512x512 specular (8 mips) RGBA16_FLOAT cube maps.
    void* Donut_CreateLightProbeSet(App* app, int numProbes)
    {
        App* a = app;
        auto set = std::make_shared<LightProbeSet>();

        nvrhi::TextureDesc cubemapDesc;
        cubemapDesc.arraySize = 6 * uint32_t(numProbes);
        cubemapDesc.dimension = nvrhi::TextureDimension::TextureCubeArray;
        cubemapDesc.isRenderTarget = true;
        cubemapDesc.format = nvrhi::Format::RGBA16_FLOAT;
        cubemapDesc.initialState = nvrhi::ResourceStates::ShaderResource;
        cubemapDesc.keepInitialState = true;

        cubemapDesc.width = 256;
        cubemapDesc.height = 256;
        cubemapDesc.mipLevels = 1;
        set->diffuseTexture = a->device()->createTexture(cubemapDesc);

        cubemapDesc.width = 512;
        cubemapDesc.height = 512;
        cubemapDesc.mipLevels = 8;
        set->specularTexture = a->device()->createTexture(cubemapDesc);

        for (int i = 0; i < numProbes; i++)
        {
            auto probe = std::make_shared<donut::engine::LightProbe>();
            probe->name = std::to_string(i + 1);
            probe->diffuseMap = set->diffuseTexture;
            probe->specularMap = set->specularTexture;
            probe->diffuseArrayIndex = uint32_t(i);
            probe->specularArrayIndex = uint32_t(i);
            probe->bounds = dm::frustum::empty();
            probe->enabled = false;
            set->probes.push_back(probe);
        }

        return a->OwnObject(set);
    }

    int Donut_GetLightProbeCount(void* lightProbeSet)
    {
        return static_cast<int>(static_cast<LightProbeSet*>(lightProbeSet)->probes.size());
    }

    const char* Donut_GetLightProbeName(void* lightProbeSet, int index)
    {
        return static_cast<LightProbeSet*>(lightProbeSet)->probes[index]->name.c_str();
    }

    int Donut_IsLightProbeEnabled(void* lightProbeSet, int index)
    {
        return static_cast<LightProbeSet*>(lightProbeSet)->probes[index]->enabled ? 1 : 0;
    }

    void Donut_SetLightProbeEnabled(void* lightProbeSet, int index, int enabled)
    {
        static_cast<LightProbeSet*>(lightProbeSet)->probes[index]->enabled = enabled != 0;
    }

    void Donut_SetLightProbeScales(void* lightProbeSet, int index, double diffuseScale, double specularScale)
    {
        auto& probe = *static_cast<LightProbeSet*>(lightProbeSet)->probes[index];
        probe.diffuseScale = float(diffuseScale);
        probe.specularScale = float(specularScale);
    }

    // Mips of the probes' specular maps, one per roughness level.
    int Donut_GetLightProbeSpecularMipLevels(void* lightProbeSet)
    {
        return static_cast<int>(static_cast<LightProbeSet*>(lightProbeSet)->specularTexture->getDesc().mipLevels);
    }

    // Donut's light probe processing: environment map mips, diffuse and specular maps, BRDF table.
    void* Donut_CreateLightProbeProcessingPass(App* app)
    {
        App* a = app;
        return a->OwnObject(std::make_shared<donut::render::LightProbeProcessingPass>(a->device(), a->shaderFactory,
            a->sharedCommonPasses()));
    }

    void Donut_ResetLightProbeProcessingCaches(void* lightProbeProcessingPass)
    {
        static_cast<donut::render::LightProbeProcessingPass*>(lightProbeProcessingPass)->ResetCaches();
    }

    // An environment cube map of size x size faces (RGBA16_FLOAT, mipLevels mips) with a depth
    // buffer, and the cube map view that renders it. Place it with Donut_SetLightProbeCaptureTransform.
    void* Donut_CreateLightProbeCapture(App* app, int size, int mipLevels)
    {
        App* a = app;
        auto capture = std::make_shared<LightProbeCapture>();
        capture->mipLevels = uint32_t(mipLevels);

        nvrhi::TextureDesc cubemapDesc;
        cubemapDesc.arraySize = 6;
        cubemapDesc.width = uint32_t(size);
        cubemapDesc.height = uint32_t(size);
        cubemapDesc.mipLevels = uint32_t(mipLevels);
        cubemapDesc.dimension = nvrhi::TextureDimension::TextureCube;
        cubemapDesc.isRenderTarget = true;
        cubemapDesc.format = nvrhi::Format::RGBA16_FLOAT;
        cubemapDesc.initialState = nvrhi::ResourceStates::RenderTarget;
        cubemapDesc.keepInitialState = true;
        cubemapDesc.clearValue = nvrhi::Color(0.f);
        cubemapDesc.useClearValue = true;
        capture->colorTexture = a->device()->createTexture(cubemapDesc);

        cubemapDesc.mipLevels = 1;
        cubemapDesc.format = ChooseDepthFormat(a->device());
        cubemapDesc.isTypeless = true;
        cubemapDesc.initialState = nvrhi::ResourceStates::DepthWrite;
        capture->depthTexture = a->device()->createTexture(cubemapDesc);

        capture->framebuffer = std::make_shared<donut::engine::FramebufferFactory>(a->device());
        capture->framebuffer->RenderTargets = { capture->colorTexture };
        capture->framebuffer->DepthTarget = capture->depthTexture;

        capture->view.SetArrayViewports(size, 0);
        return a->OwnObject(capture);
    }

    // Centers the cube map view at a world position, rendering from zNear out to cullDistance.
    void Donut_SetLightProbeCaptureTransform(void* lightProbeCapture, double x, double y, double z, double zNear, double cullDistance)
    {
        auto* capture = static_cast<LightProbeCapture*>(lightProbeCapture);
        capture->view.SetTransform(dm::translation(-dm::float3(float(x), float(y), float(z))), float(zNear), float(cullDistance));
        capture->view.UpdateCache();
    }

    // The cube map view (for the view functions) and framebuffer.
    void* Donut_GetLightProbeCaptureView(void* lightProbeCapture)
    {
        donut::engine::IView* view = &static_cast<LightProbeCapture*>(lightProbeCapture)->view;
        return view;
    }

    FramebufferFactoryRef* Donut_GetLightProbeCaptureFramebuffer(void* lightProbeCapture)
    {
        return &static_cast<LightProbeCapture*>(lightProbeCapture)->framebuffer;
    }

    // Clears color to black and depth to 0 (reverse Z).
    void Donut_ClearLightProbeCapture(nvrhi::ICommandList* commandList, void* lightProbeCapture)
    {
        auto* capture = static_cast<LightProbeCapture*>(lightProbeCapture);
        nvrhi::ICommandList* cl = commandList;
        cl->clearTextureFloat(capture->colorTexture, nvrhi::AllSubresources, nvrhi::Color(0.f));
        const nvrhi::FormatInfo& depthFormatInfo = nvrhi::getFormatInfo(capture->depthTexture->getDesc().format);
        cl->clearDepthStencilTexture(capture->depthTexture, nvrhi::AllSubresources, true, 0.f, depthFormatInfo.hasStencil, 0);
    }

    // Fits the shadow map's cascades to a directional light and the capture's cube map view.
    void Donut_SetupShadowMapForLightProbeCapture(void* shadowMapTarget, void* light, void* lightProbeCapture,
        double cullDistance, double zRange, double exponent)
    {
        auto* capture = static_cast<LightProbeCapture*>(lightProbeCapture);
        auto* target = static_cast<ShadowMapTarget*>(shadowMapTarget);
        if (!target->cascaded)
            return;
        target->cascaded->SetupForCubemapView(
            *static_cast<donut::engine::DirectionalLight*>(static_cast<donut::engine::Light*>(light)),
            capture->view.GetViewOrigin(), float(cullDistance), float(zRange), float(zRange), float(exponent));
    }

    // Fills the capture's environment map mips from mip 0.
    void Donut_GenerateLightProbeCaptureMips(nvrhi::ICommandList* commandList, void* lightProbeProcessingPass, void* lightProbeCapture)
    {
        auto* capture = static_cast<LightProbeCapture*>(lightProbeCapture);
        static_cast<donut::render::LightProbeProcessingPass*>(lightProbeProcessingPass)->GenerateCubemapMips(
            commandList, capture->colorTexture, 0, 0, capture->mipLevels - 1);
    }

    // Convolves the capture into a probe's diffuse map.
    void Donut_RenderLightProbeDiffuse(nvrhi::ICommandList* commandList, void* lightProbeProcessingPass, void* lightProbeCapture,
        void* lightProbeSet, int index)
    {
        auto& probe = *static_cast<LightProbeSet*>(lightProbeSet)->probes[index];
        static_cast<donut::render::LightProbeProcessingPass*>(lightProbeProcessingPass)->RenderDiffuseMap(
            commandList, static_cast<LightProbeCapture*>(lightProbeCapture)->colorTexture, nvrhi::AllSubresources,
            probe.diffuseMap, probe.diffuseArrayIndex * 6, 0);
    }

    // Prefilters the capture for a roughness into one mip of a probe's specular map.
    void Donut_RenderLightProbeSpecular(nvrhi::ICommandList* commandList, void* lightProbeProcessingPass, void* lightProbeCapture,
        void* lightProbeSet, int index, double roughness, int mipLevel)
    {
        auto& probe = *static_cast<LightProbeSet*>(lightProbeSet)->probes[index];
        static_cast<donut::render::LightProbeProcessingPass*>(lightProbeProcessingPass)->RenderSpecularMap(
            commandList, float(roughness), static_cast<LightProbeCapture*>(lightProbeCapture)->colorTexture,
            nvrhi::AllSubresources, probe.specularMap, probe.specularArrayIndex * 6, uint32_t(mipLevel));
    }

    // Renders the environment BRDF lookup table the probes share (once is enough).
    void Donut_RenderEnvironmentBrdf(nvrhi::ICommandList* commandList, void* lightProbeProcessingPass)
    {
        static_cast<donut::render::LightProbeProcessingPass*>(lightProbeProcessingPass)->RenderEnvironmentBrdfTexture(
            commandList);
    }

    // After its maps are rendered (and the GPU is done): enables a probe, affecting everything
    // within 10 units of the position it was rendered from.
    void Donut_FinishLightProbe(void* lightProbeSet, int index, void* lightProbeProcessingPass, double x, double y, double z)
    {
        auto& probe = *static_cast<LightProbeSet*>(lightProbeSet)->probes[index];
        probe.environmentBrdf = static_cast<donut::render::LightProbeProcessingPass*>(lightProbeProcessingPass)->GetEnvironmentBrdfTexture();
        const dm::float3 position = dm::float3(float(x), float(y), float(z));
        probe.bounds = dm::frustum::fromBox(dm::box3(position, position).grow(10.f));
        probe.enabled = true;
    }

    // --- Frame commands (valid only inside the render callback) ----------------------------

    // Submits what the frame has recorded so far, and goes on recording into the same command
    // list: work after it (e.g. Donut_ReadPixelUInts) sees the GPU results.
    void Donut_FlushFrameCommandList(App* app, FrameContext* frame)
    {
        FrameContext* ctx = frame;
        ctx->commandList->close();
        app->device()->executeCommandList(ctx->commandList);
        ctx->commandList->open();
    }

    // Async compute in the frame: submits what the frame has recorded so far to the graphics queue,
    // then a closed command list of Donut_CreateComputeQueueCommandList to the compute queue,
    // which waits for the graphics work; the frame goes on recording into the same command list,
    // whose work waits for the compute work. The waits are GPU-side (semaphores / fences).
    void Donut_ExecuteFrameComputeWork(App* app, FrameContext* frame, nvrhi::ICommandList* computeCommandList)
    {
        nvrhi::IDevice* device = app->device();
        FrameContext* ctx = frame;
        ctx->commandList->close();
        const uint64_t graphicsWork = device->executeCommandList(ctx->commandList, nvrhi::CommandQueue::Graphics);
        device->queueWaitForCommandList(nvrhi::CommandQueue::Compute, nvrhi::CommandQueue::Graphics, graphicsWork);
        const uint64_t computeWork = device->executeCommandList(computeCommandList, nvrhi::CommandQueue::Compute);
        device->queueWaitForCommandList(nvrhi::CommandQueue::Graphics, nvrhi::CommandQueue::Compute, computeWork);
        ctx->commandList->open();
    }

    // Saves the frame's color (as recorded so far, which it submits) to an image file: BMP, PNG,
    // JPG or TGA, by the extension. Returns non-zero on success.
    int Donut_SaveFrameToFile(App* app, FrameContext* frame, const char* path)
    {
        App* a = app;
        FrameContext* ctx = frame;
        ctx->commandList->close();
        a->device()->executeCommandList(ctx->commandList);

        // No immediate command list may be open while it runs.
        const bool saved = donut::engine::SaveTextureToFile(a->device(), a->commonPasses(),
            ctx->framebuffer->getDesc().colorAttachments[0].texture, nvrhi::ResourceStates::RenderTarget, path);

        ctx->commandList->open();
        return saved ? 1 : 0;
    }

    void Donut_ClearColor(FrameContext* frame, double r, double g, double b, double a)
    {
        FrameContext* ctx = frame;
        nvrhi::utils::ClearColorAttachment(ctx->commandList, ctx->framebuffer, 0,
            nvrhi::Color(float(r), float(g), float(b), float(a)));
    }

    // Draws vertexCount vertices with no vertex buffers, over the whole framebuffer.
    void Donut_Draw(FrameContext* frame, nvrhi::IGraphicsPipeline* pipeline, int vertexCount)
    {
        FrameContext* ctx = frame;

        nvrhi::GraphicsState state;
        state.pipeline = pipeline;
        state.framebuffer = ctx->framebuffer;
        state.viewport.addViewportAndScissorRect(ctx->framebuffer->getFramebufferInfo().getViewport());
        ctx->commandList->setGraphicsState(state);

        nvrhi::DrawArguments args;
        args.vertexCount = static_cast<uint32_t>(vertexCount);
        ctx->commandList->draw(args);
    }

    // Launches groupsX amplification-shader groups of a meshlet pipeline, over the whole framebuffer.
    void Donut_DispatchMesh(FrameContext* frame, nvrhi::IMeshletPipeline* meshletPipeline, int groupsX)
    {
        FrameContext* ctx = frame;

        nvrhi::MeshletState state;
        state.pipeline = meshletPipeline;
        state.framebuffer = ctx->framebuffer;
        state.viewport.addViewportAndScissorRect(ctx->framebuffer->getFramebufferInfo().getViewport());
        ctx->commandList->setMeshletState(state);

        ctx->commandList->dispatchMesh(static_cast<uint32_t>(groupsX));
    }

    // Traces width x height rays with a shader table, with bindingSet as its global bindings.
    void Donut_DispatchRays(FrameContext* frame, nvrhi::rt::IShaderTable* shaderTable, nvrhi::IBindingSet* bindingSet, int width, int height)
    {
        FrameContext* ctx = frame;

        nvrhi::rt::State state;
        state.shaderTable = shaderTable;
        state.bindings = { bindingSet };
        ctx->commandList->setRayTracingState(state);

        nvrhi::rt::DispatchRaysArguments args;
        args.width = static_cast<uint32_t>(width);
        args.height = static_cast<uint32_t>(height);
        ctx->commandList->dispatchRays(args);
    }

    // Same as Donut_DispatchRays, with a descriptor table (Donut_GetDescriptorTable) bound after
    // the binding set, for pipelines with a bindless layout second.
    void Donut_DispatchRaysWithDescriptorTable(FrameContext* frame, nvrhi::rt::IShaderTable* shaderTable, nvrhi::IBindingSet* bindingSet, nvrhi::IDescriptorTable* descriptorTable,
        int width, int height)
    {
        FrameContext* ctx = frame;

        nvrhi::rt::State state;
        state.shaderTable = shaderTable;
        state.bindings = { bindingSet, descriptorTable };
        ctx->commandList->setRayTracingState(state);

        nvrhi::rt::DispatchRaysArguments args;
        args.width = static_cast<uint32_t>(width);
        args.height = static_cast<uint32_t>(height);
        ctx->commandList->dispatchRays(args);
    }

    // Copies a texture over the whole framebuffer, stretched, with Donut's CommonRenderPasses.
    // Call Donut_ClearBindingCache when textures blitted before are released.
    void Donut_BlitTexture(App* app, FrameContext* frame, nvrhi::ITexture* texture)
    {
        App* a = app;
        FrameContext* ctx = frame;
        a->commonPasses()->BlitTexture(ctx->commandList, ctx->framebuffer,
            texture, a->bindingCache());
    }

    // Copies one array slice of a texture, stretched, into a rectangle of the framebuffer (pixels).
    void Donut_BlitTextureSlice(App* app, FrameContext* frame, nvrhi::ITexture* texture, int arraySlice,
        double left, double top, double width, double height)
    {
        App* a = app;
        FrameContext* ctx = frame;

        donut::engine::BlitParameters params;
        params.targetFramebuffer = ctx->framebuffer;
        params.targetViewport = nvrhi::Viewport(float(left), float(left + width), float(top), float(top + height), 0.f, 1.f);
        params.sourceTexture = texture;
        params.sourceArraySlice = static_cast<uint32_t>(arraySlice);
        a->commonPasses()->BlitTexture(ctx->commandList, params, a->bindingCache());
    }

    // Drops the binding sets Donut_BlitTexture cached, and with them their references to the
    // blitted textures.
    void Donut_ClearBindingCache(App* app)
    {
        app->bindingCache()->Clear();
    }

    // The frame's open command list, for the command list functions (e.g. Donut_WriteBuffer).
    // Don't open, close or execute it: the pass does.
    nvrhi::ICommandList* Donut_GetFrameCommandList(FrameContext* frame)
    {
        return frame->commandList;
    }

    // Starts describing a draw with a graphics pipeline, over the whole framebuffer; add to it
    // with the Donut_Draw* functions, then issue it with Donut_DrawIndexed.
    void Donut_BeginDraw(FrameContext* frame, nvrhi::IGraphicsPipeline* pipeline)
    {
        FrameContext* ctx = frame;
        ctx->draw = nvrhi::GraphicsState();
        ctx->draw.pipeline = pipeline;
        ctx->draw.framebuffer = ctx->framebuffer;
    }

    // Same, into another framebuffer (Donut_CreateFramebuffer; the pipeline must be for its layout).
    void Donut_BeginDrawToFramebuffer(FrameContext* frame, nvrhi::IGraphicsPipeline* pipeline, nvrhi::IFramebuffer* framebuffer)
    {
        FrameContext* ctx = frame;
        ctx->draw = nvrhi::GraphicsState();
        ctx->draw.pipeline = pipeline;
        ctx->draw.framebuffer = framebuffer;
    }

    void Donut_DrawAddBindingSet(FrameContext* frame, nvrhi::IBindingSet* bindingSet)
    {
        frame->draw.bindings.push_back(bindingSet);
    }

    // A descriptor table (Donut_CreateDescriptorTable, Donut_GetDescriptorTable) for the draw, in
    // the pipeline's binding layout order as Donut_DrawAddBindingSet.
    void Donut_DrawAddDescriptorTable(FrameContext* frame, nvrhi::IDescriptorTable* descriptorTable)
    {
        frame->draw.bindings.push_back(descriptorTable);
    }

    // R32_UINT indices.
    void Donut_DrawSetIndexBuffer(FrameContext* frame, nvrhi::IBuffer* indexBuffer)
    {
        frame->draw.indexBuffer = { indexBuffer, nvrhi::Format::R32_UINT, 0 };
    }

    // R16_UINT indices.
    void Donut_DrawSetIndexBuffer16(FrameContext* frame, nvrhi::IBuffer* indexBuffer)
    {
        frame->draw.indexBuffer = { indexBuffer, nvrhi::Format::R16_UINT, 0 };
    }

    // Binds a vertex buffer, starting at byteOffset, to the input layout's slot.
    void Donut_DrawAddVertexBuffer(FrameContext* frame, nvrhi::IBuffer* vertexBuffer, int slot, int byteOffset)
    {
        frame->draw.vertexBuffers.push_back(
            { vertexBuffer, static_cast<uint32_t>(slot), static_cast<uint64_t>(byteOffset) });
    }

    // Draws into this rectangle of the framebuffer (in pixels) instead of all of it.
    void Donut_DrawSetViewport(FrameContext* frame, double left, double top, double width, double height)
    {
        const nvrhi::Viewport viewport(float(left), float(left + width), float(top), float(top + height), 0.f, 1.f);
        frame->draw.viewport = nvrhi::ViewportState().addViewportAndScissorRect(viewport);
    }

    // One more viewport (with its scissor rectangle) for the draw, after those set or added before:
    // geometry shaders pick one per primitive (SV_ViewportArrayIndex).
    void Donut_DrawAddViewport(FrameContext* frame, double left, double top, double width, double height)
    {
        const nvrhi::Viewport viewport(float(left), float(left + width), float(top), float(top + height), 0.f, 1.f);
        frame->draw.viewport.addViewportAndScissorRect(viewport);
    }

    void Donut_DrawIndexed(FrameContext* frame, int indexCount)
    {
        FrameContext* ctx = frame;
        if (ctx->draw.viewport.viewports.empty())
            ctx->draw.viewport.addViewportAndScissorRect(ctx->draw.framebuffer->getFramebufferInfo().getViewport());
        ctx->commandList->setGraphicsState(ctx->draw);

        nvrhi::DrawArguments args;
        args.vertexCount = static_cast<uint32_t>(indexCount);
        ctx->commandList->drawIndexed(args);
    }

    // Same, instanceCount times (instance attributes advance per instance).
    void Donut_DrawIndexedInstanced(FrameContext* frame, int indexCount, int instanceCount)
    {
        FrameContext* ctx = frame;
        if (ctx->draw.viewport.viewports.empty())
            ctx->draw.viewport.addViewportAndScissorRect(ctx->draw.framebuffer->getFramebufferInfo().getViewport());
        ctx->commandList->setGraphicsState(ctx->draw);

        nvrhi::DrawArguments args;
        args.vertexCount = static_cast<uint32_t>(indexCount);
        args.instanceCount = static_cast<uint32_t>(instanceCount);
        ctx->commandList->drawIndexed(args);
    }

    // Same, with byteSize bytes of push constants from data (the binding set's
    // Donut_BindPushConstants item). The draw described stays, so this can repeat with other
    // push constants.
    void Donut_DrawIndexedWithPushConstants(FrameContext* frame, int indexCount, const void* data, int byteSize)
    {
        FrameContext* ctx = frame;
        if (ctx->draw.viewport.viewports.empty())
            ctx->draw.viewport.addViewportAndScissorRect(ctx->draw.framebuffer->getFramebufferInfo().getViewport());
        // NVRHI skips the parts of the state that haven't changed since the previous draw.
        ctx->commandList->setGraphicsState(ctx->draw);
        ctx->commandList->setPushConstants(data, static_cast<size_t>(byteSize));

        nvrhi::DrawArguments args;
        args.vertexCount = static_cast<uint32_t>(indexCount);
        ctx->commandList->drawIndexed(args);
    }

    // Same, instanceCount times.
    void Donut_DrawIndexedInstancedWithPushConstants(FrameContext* frame, int indexCount, int instanceCount, const void* data, int byteSize)
    {
        FrameContext* ctx = frame;
        if (ctx->draw.viewport.viewports.empty())
            ctx->draw.viewport.addViewportAndScissorRect(ctx->draw.framebuffer->getFramebufferInfo().getViewport());
        ctx->commandList->setGraphicsState(ctx->draw);
        ctx->commandList->setPushConstants(data, static_cast<size_t>(byteSize));

        nvrhi::DrawArguments args;
        args.vertexCount = static_cast<uint32_t>(indexCount);
        args.instanceCount = static_cast<uint32_t>(instanceCount);
        ctx->commandList->drawIndexed(args);
    }

    // Same, drawing indexCount indices from startIndex of the index buffer, added to baseVertex.
    // indexCount indices from startIndex, offset by baseVertex, in the current draw state.
    void Donut_DrawIndexedRange(FrameContext* frame, int indexCount, int startIndex, int baseVertex)
    {
        FrameContext* ctx = frame;
        if (ctx->draw.viewport.viewports.empty())
            ctx->draw.viewport.addViewportAndScissorRect(ctx->draw.framebuffer->getFramebufferInfo().getViewport());
        ctx->commandList->setGraphicsState(ctx->draw);

        nvrhi::DrawArguments args;
        args.vertexCount = static_cast<uint32_t>(indexCount);
        args.startIndexLocation = static_cast<uint32_t>(startIndex);
        args.startVertexLocation = static_cast<uint32_t>(baseVertex);
        ctx->commandList->drawIndexed(args);
    }

    void Donut_DrawIndexedRangeWithPushConstants(FrameContext* frame, int indexCount, int startIndex, int baseVertex,
        const void* data, int byteSize)
    {
        FrameContext* ctx = frame;
        if (ctx->draw.viewport.viewports.empty())
            ctx->draw.viewport.addViewportAndScissorRect(ctx->draw.framebuffer->getFramebufferInfo().getViewport());
        ctx->commandList->setGraphicsState(ctx->draw);
        ctx->commandList->setPushConstants(data, static_cast<size_t>(byteSize));

        nvrhi::DrawArguments args;
        args.vertexCount = static_cast<uint32_t>(indexCount);
        args.startIndexLocation = static_cast<uint32_t>(startIndex);
        args.startVertexLocation = static_cast<uint32_t>(baseVertex);
        ctx->commandList->drawIndexed(args);
    }

    // Values that decide whether draws happen: D3D12 predication, Vulkan conditional rendering.
    // NVRHI has neither: a native buffer the CPU writes (upload heap / host-visible, mapped all
    // along), which the GPU reads when it executes the draws. 8 bytes per value: D3D12 reads 64
    // bits, Vulkan the low 32.
    struct PredicationBuffer
    {
        nvrhi::GraphicsAPI api = nvrhi::GraphicsAPI::D3D12;
        uint64_t* values = nullptr;
        uint32_t count = 0;
#if DONUT_WITH_DX12
        Microsoft::WRL::ComPtr<ID3D12Resource> resource;
#endif
#if DONUT_WITH_VULKAN
        VkDevice device = VK_NULL_HANDLE;
        VkBuffer buffer = VK_NULL_HANDLE;
        VkDeviceMemory memory = VK_NULL_HANDLE;
#endif

        ~PredicationBuffer()
        {
#if DONUT_WITH_VULKAN
            if (buffer != VK_NULL_HANDLE)
                VULKAN_HPP_DEFAULT_DISPATCHER.vkDestroyBuffer(device, buffer, nullptr);
            if (memory != VK_NULL_HANDLE)
                VULKAN_HPP_DEFAULT_DISPATCHER.vkFreeMemory(device, memory, nullptr);
#endif
        }
    };

    // Non-zero if pixel shaders can use rasterizer ordered views (HLSL's RasterizerOrderedTexture2D
    // and the like): accesses to them from overlapping pixels happen in the order of the
    // primitives drawn. D3D11 and D3D12 with ROVsSupported, Vulkan with fragment shader pixel
    // interlock (VK_EXT_fragment_shader_interlock; DXC compiles them to that).
    int Donut_HasRasterizerOrderedViews(App* app)
    {
        return app->rasterizerOrderedViews ? 1 : 0;
    }

    // Non-zero if pixel shaders can read the barycentric coordinates of their pixel in its triangle
    // (SV_Barycentrics) and the attributes of the triangle's vertices (GetAttributeAtVertex on
    // nointerpolation inputs): D3D12 with BarycentricsSupported (shader model 6.1), Vulkan with
    // VK_KHR_fragment_shader_barycentric; not D3D11.
    int Donut_HasBarycentrics(App* app)
    {
        return app->barycentrics ? 1 : 0;
    }

    // A ShaderExecutionReordering value: whether ray generation shaders can trace rays into hit
    // objects, reorder their threads by them (MaybeReorderThread) and then invoke their hit or miss
    // shaders. D3D12: shader model 6.9 with raytracing tier 1.2 (HitObjects: D3D12 doesn't say
    // whether the GPU reorders). Vulkan: VK_NV_ray_tracing_invocation_reorder (ray tracing apps
    // only; Reorders if the GPU reorders, from rayTracingInvocationReorderReorderingHint). None on
    // D3D11.
    int Donut_GetShaderExecutionReordering(App* app)
    {
        return app->shaderExecutionReordering;
    }

    // ComputeDerivatives bits: D3D12 with shader model 6.6 has both; Vulkan with
    // VK_KHR_compute_shader_derivatives what the GPU has; 0 on D3D11.
    int Donut_GetComputeShaderDerivatives(App* app)
    {
        return app->computeShaderDerivatives;
    }

    // Non-zero if blend states can do logic operations (Donut_GraphicsPipelineSetLogicOp): D3D11 and
    // D3D12 with OutputMergerLogicOp, Vulkan with the logicOp feature.
    int Donut_HasLogicOps(App* app)
    {
        return app->logicOps ? 1 : 0;
    }

    int Donut_HasDepthBoundsTest(App* app)
    {
        return app->depthBoundsTest ? 1 : 0;
    }

    // The device's memory heaps now (their count): this process's usage of each and its budget, the
    // memory it can use before the system has to page or fail allocations. Vulkan's memory heaps,
    // with VK_EXT_memory_budget (without it the usage is 0 and the budget the heap's size); D3D's
    // local (video) and non-local (system) memory segment groups, from DXGI. Read back by
    // Donut_GetMemoryHeapUsage, Donut_GetMemoryHeapBudget and Donut_GetMemoryHeapFlags.
    int Donut_QueryMemoryBudget(App* app)
    {
        App* a = app;
        a->memoryHeaps.clear();
        nvrhi::IDevice* device = a->device();
#if DONUT_WITH_VULKAN
        if (device->getGraphicsAPI() == nvrhi::GraphicsAPI::VULKAN)
        {
            const vk::PhysicalDevice physicalDevice = DeviceManagerVKAccess::PhysicalDevice(
                static_cast<DeviceManager_VK*>(a->deviceManager.get()));
            const bool budgetExtension = a->deviceManager->IsVulkanDeviceExtensionEnabled(VK_EXT_MEMORY_BUDGET_EXTENSION_NAME);
            VkPhysicalDeviceMemoryBudgetPropertiesEXT budget{ VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_MEMORY_BUDGET_PROPERTIES_EXT };
            VkPhysicalDeviceMemoryProperties2 properties{ VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_MEMORY_PROPERTIES_2 };
            if (budgetExtension)
                properties.pNext = &budget;
            VULKAN_HPP_DEFAULT_DISPATCHER.vkGetPhysicalDeviceMemoryProperties2(physicalDevice, &properties);
            for (uint32_t i = 0; i < properties.memoryProperties.memoryHeapCount; i++)
            {
                const VkMemoryHeap& heap = properties.memoryProperties.memoryHeaps[i];
                MemoryHeap h;
                h.usage = budgetExtension ? double(budget.heapUsage[i]) : 0.0;
                h.budget = budgetExtension ? double(budget.heapBudget[i]) : double(heap.size);
                h.flags = ((heap.flags & VK_MEMORY_HEAP_DEVICE_LOCAL_BIT) ? MemoryHeapFlag_DeviceLocal : 0)
                    | ((heap.flags & VK_MEMORY_HEAP_MULTI_INSTANCE_BIT) ? MemoryHeapFlag_MultiInstance : 0);
                a->memoryHeaps.push_back(h);
            }
            return int(a->memoryHeaps.size());
        }
#endif
#if DONUT_WITH_DX11 || DONUT_WITH_DX12
        Microsoft::WRL::ComPtr<IDXGIAdapter3> adapter;
#if DONUT_WITH_DX12
        if (device->getGraphicsAPI() == nvrhi::GraphicsAPI::D3D12)
        {
            ID3D12Device* d3dDevice = device->getNativeObject(nvrhi::ObjectTypes::D3D12_Device);
            Microsoft::WRL::ComPtr<IDXGIFactory4> factory;
            if (SUCCEEDED(CreateDXGIFactory2(0, IID_PPV_ARGS(&factory))))
                factory->EnumAdapterByLuid(d3dDevice->GetAdapterLuid(), IID_PPV_ARGS(&adapter));
        }
#endif
#if DONUT_WITH_DX11
        if (device->getGraphicsAPI() == nvrhi::GraphicsAPI::D3D11)
        {
            ID3D11Device* d3dDevice = device->getNativeObject(nvrhi::ObjectTypes::D3D11_Device);
            Microsoft::WRL::ComPtr<IDXGIDevice> dxgiDevice;
            Microsoft::WRL::ComPtr<IDXGIAdapter> dxgiAdapter;
            if (SUCCEEDED(d3dDevice->QueryInterface(IID_PPV_ARGS(&dxgiDevice))) && SUCCEEDED(dxgiDevice->GetAdapter(&dxgiAdapter)))
                dxgiAdapter.As(&adapter);
        }
#endif
        if (adapter)
        {
            const DXGI_MEMORY_SEGMENT_GROUP groups[] = { DXGI_MEMORY_SEGMENT_GROUP_LOCAL, DXGI_MEMORY_SEGMENT_GROUP_NON_LOCAL };
            for (DXGI_MEMORY_SEGMENT_GROUP group : groups)
            {
                DXGI_QUERY_VIDEO_MEMORY_INFO info = {};
                if (FAILED(adapter->QueryVideoMemoryInfo(0, group, &info)))
                    continue;
                MemoryHeap h;
                h.usage = double(info.CurrentUsage);
                h.budget = double(info.Budget);
                h.flags = group == DXGI_MEMORY_SEGMENT_GROUP_LOCAL ? MemoryHeapFlag_DeviceLocal : 0;
                a->memoryHeaps.push_back(h);
            }
        }
#endif
        return int(a->memoryHeaps.size());
    }

    // A memory heap's usage and budget in bytes, and its MemoryHeapFlag bits, as
    // Donut_QueryMemoryBudget last found them.
    double Donut_GetMemoryHeapUsage(App* app, int heap)
    {
        const App* a = app;
        return heap >= 0 && size_t(heap) < a->memoryHeaps.size() ? a->memoryHeaps[heap].usage : 0.0;
    }

    double Donut_GetMemoryHeapBudget(App* app, int heap)
    {
        const App* a = app;
        return heap >= 0 && size_t(heap) < a->memoryHeaps.size() ? a->memoryHeaps[heap].budget : 0.0;
    }

    int Donut_GetMemoryHeapFlags(App* app, int heap)
    {
        const App* a = app;
        return heap >= 0 && size_t(heap) < a->memoryHeaps.size() ? a->memoryHeaps[heap].flags : 0;
    }

    // LineRasterization bits: the line rasterization modes pipelines can have
    // (Donut_GraphicsPipelineSetLineRasterization): Vulkan's with VK_EXT_line_rasterization's
    // features, plain and stippled; D3D's rectangular (quadrilateral), Bresenham (aliased) and smooth
    // (alpha antialiased) lines, unstippled.
    int Donut_GetLineRasterizationModes(App* app)
    {
        return app->lineRasterizationModes;
    }

    // The widest lines can be: Vulkan's lineWidthRange with the wideLines feature, else 1.
    double Donut_GetMaxLineWidth(App* app)
    {
        return app->maxLineWidth;
    }

    // Non-zero if pixel shaders can run in full quads, helper invocations taking part in quad
    // operations (QuadReadLaneAt...): Vulkan with VK_KHR_shader_quad_control (SPIR-V's
    // RequireFullQuadsKHR and QuadDerivativesKHR execution modes), D3D12 always.
    int Donut_HasShaderQuadControl(App* app)
    {
        return app->shaderQuadControl ? 1 : 0;
    }

    // AdvancedBlend bits: the advanced blend operations blend states can do
    // (Donut_GraphicsPipelineSetAdvancedBlendOp): Vulkan with VK_EXT_blend_operation_advanced and
    // its coherent operations; 0 elsewhere.
    int Donut_GetAdvancedBlendOperations(App* app)
    {
        return app->advancedBlendOperations;
    }

    // Non-zero if shaders can compute with native 16-bit types (float16_t, int16_t, uint16_t; the
    // shaders are compiled with -enable-16bit-types, as ShaderMake does from shader model 6.2) and
    // read them from structured buffers: D3D12 with Native16BitShaderOpsSupported, Vulkan with
    // shaderFloat16, shaderInt16 and storageBuffer16BitAccess; not D3D11.
    int Donut_HasNative16BitShaderOps(App* app)
    {
        return app->native16Bit ? 1 : 0;
    }

    // Non-zero if, besides, push constants and constant buffers can hold 16-bit values: D3D12 with
    // native 16-bit shader ops, Vulkan with storagePushConstant16 and
    // uniformAndStorageBuffer16BitAccess too.
    int Donut_HasNative16BitConstants(App* app)
    {
        return app->native16BitConstants ? 1 : 0;
    }

    // A barrier between the draws or dispatches before and after that write and read a UAV
    // texture: NVRHI only places one where the texture is bound anew.
    void Donut_UavBarrier(nvrhi::ICommandList* commandList, nvrhi::ITexture* texture)
    {
        nvrhi::ICommandList* cl = commandList;
        cl->setTextureState(texture, nvrhi::AllSubresources, nvrhi::ResourceStates::UnorderedAccess);
        cl->commitBarriers();
    }

    // Non-zero if draws can be skipped by a value in a buffer (Donut_CreatePredicationBuffer):
    // D3D12's predication, Vulkan's VK_EXT_conditional_rendering; not D3D11 (whose predicates are
    // queries) or headless apps.
    int Donut_HasConditionalRendering(App* app)
    {
        return app->conditionalRendering ? 1 : 0;
    }

    // count values, each 0 (skip) or not (draw), all 1 at first. Requires
    // Donut_HasConditionalRendering. Returns null on failure.
    void* Donut_CreatePredicationBuffer(App* app, int count)
    {
        App* a = app;
        if (!a->conditionalRendering || count <= 0)
            return nullptr;
        nvrhi::IDevice* device = a->device();
        auto predication = std::make_shared<PredicationBuffer>();
        predication->api = device->getGraphicsAPI();
        predication->count = static_cast<uint32_t>(count);
        const uint64_t byteSize = sizeof(uint64_t) * predication->count;
        void* mapped = nullptr;
#if DONUT_WITH_DX12
        if (predication->api == nvrhi::GraphicsAPI::D3D12)
        {
            ID3D12Device* d3dDevice = device->getNativeObject(nvrhi::ObjectTypes::D3D12_Device);
            D3D12_HEAP_PROPERTIES heapProperties = {};
            heapProperties.Type = D3D12_HEAP_TYPE_UPLOAD;
            D3D12_RESOURCE_DESC bufferDesc = {};
            bufferDesc.Dimension = D3D12_RESOURCE_DIMENSION_BUFFER;
            bufferDesc.Width = byteSize;
            bufferDesc.Height = 1;
            bufferDesc.DepthOrArraySize = 1;
            bufferDesc.MipLevels = 1;
            bufferDesc.SampleDesc.Count = 1;
            bufferDesc.Layout = D3D12_TEXTURE_LAYOUT_ROW_MAJOR;
            // GENERIC_READ includes PREDICATION.
            if (FAILED(d3dDevice->CreateCommittedResource(&heapProperties, D3D12_HEAP_FLAG_NONE, &bufferDesc,
                    D3D12_RESOURCE_STATE_GENERIC_READ, nullptr, IID_PPV_ARGS(&predication->resource)))
                || FAILED(predication->resource->Map(0, nullptr, &mapped)))
                return nullptr;
        }
#endif
#if DONUT_WITH_VULKAN
        if (predication->api == nvrhi::GraphicsAPI::VULKAN)
        {
            predication->device = device->getNativeObject(nvrhi::ObjectTypes::VK_Device);
            VkBufferCreateInfo bufferInfo = { VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO };
            bufferInfo.size = byteSize;
            bufferInfo.usage = VK_BUFFER_USAGE_CONDITIONAL_RENDERING_BIT_EXT;
            bufferInfo.sharingMode = VK_SHARING_MODE_EXCLUSIVE;
            if (VULKAN_HPP_DEFAULT_DISPATCHER.vkCreateBuffer(predication->device, &bufferInfo, nullptr, &predication->buffer) != VK_SUCCESS)
                return nullptr;
            VkMemoryRequirements requirements;
            VULKAN_HPP_DEFAULT_DISPATCHER.vkGetBufferMemoryRequirements(predication->device, predication->buffer, &requirements);
            VkPhysicalDeviceMemoryProperties memoryProperties;
            VULKAN_HPP_DEFAULT_DISPATCHER.vkGetPhysicalDeviceMemoryProperties(
                DeviceManagerVKAccess::PhysicalDevice(static_cast<DeviceManager_VK*>(a->deviceManager.get())), &memoryProperties);
            const VkMemoryPropertyFlags wanted = VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT;
            uint32_t memoryType = UINT32_MAX;
            for (uint32_t i = 0; i < memoryProperties.memoryTypeCount && memoryType == UINT32_MAX; i++)
            {
                if ((requirements.memoryTypeBits & (1u << i)) && (memoryProperties.memoryTypes[i].propertyFlags & wanted) == wanted)
                    memoryType = i;
            }
            VkMemoryAllocateInfo allocateInfo = { VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO };
            allocateInfo.allocationSize = requirements.size;
            allocateInfo.memoryTypeIndex = memoryType;
            if (memoryType == UINT32_MAX
                || VULKAN_HPP_DEFAULT_DISPATCHER.vkAllocateMemory(predication->device, &allocateInfo, nullptr, &predication->memory) != VK_SUCCESS
                || VULKAN_HPP_DEFAULT_DISPATCHER.vkBindBufferMemory(predication->device, predication->buffer, predication->memory, 0) != VK_SUCCESS
                || VULKAN_HPP_DEFAULT_DISPATCHER.vkMapMemory(predication->device, predication->memory, 0, VK_WHOLE_SIZE, 0, &mapped) != VK_SUCCESS)
                return nullptr;
        }
#endif
        if (!mapped)
            return nullptr;
        predication->values = static_cast<uint64_t*>(mapped);
        for (uint32_t i = 0; i < predication->count; i++)
            predication->values[i] = 1;
        return a->OwnObject(predication);
    }

    // Value `index`: 0 skips the draws it decides, anything else lets them happen. Seen by the GPU
    // when it executes the draws (not when they are recorded).
    void Donut_SetPredicationValue(void* predicationBuffer, int index, int value)
    {
        auto* predication = static_cast<PredicationBuffer*>(predicationBuffer);
        if (index >= 0 && uint32_t(index) < predication->count)
            predication->values[index] = value != 0 ? 1 : 0;
    }

    // Donut_DrawIndexedRangeWithPushConstants, drawn only if value `index` of a predication buffer
    // isn't 0 when the GPU gets to it.
    void Donut_DrawIndexedRangeWithPushConstantsPredicated(FrameContext* frame, int indexCount, int startIndex, int baseVertex,
        const void* data, int byteSize, void* predicationBuffer, int index)
    {
        auto* predication = static_cast<PredicationBuffer*>(predicationBuffer);
        FrameContext* ctx = frame;
        if (ctx->draw.viewport.viewports.empty())
            ctx->draw.viewport.addViewportAndScissorRect(ctx->draw.framebuffer->getFramebufferInfo().getViewport());
        // On Vulkan this begins the render pass: the conditional block lies within it.
        ctx->commandList->setGraphicsState(ctx->draw);
        ctx->commandList->setPushConstants(data, static_cast<size_t>(byteSize));

        nvrhi::DrawArguments args;
        args.vertexCount = static_cast<uint32_t>(indexCount);
        args.startIndexLocation = static_cast<uint32_t>(startIndex);
        args.startVertexLocation = static_cast<uint32_t>(baseVertex);
        const uint64_t offset = sizeof(uint64_t) * static_cast<uint64_t>(index);
#if DONUT_WITH_DX12
        if (predication->api == nvrhi::GraphicsAPI::D3D12)
        {
            ID3D12GraphicsCommandList* d3dCommandList = ctx->commandList->getNativeObject(nvrhi::ObjectTypes::D3D12_GraphicsCommandList);
            // "Equal zero": the draw is skipped when the value is 0.
            d3dCommandList->SetPredication(predication->resource.Get(), offset, D3D12_PREDICATION_OP_EQUAL_ZERO);
            ctx->commandList->drawIndexed(args);
            d3dCommandList->SetPredication(nullptr, 0, D3D12_PREDICATION_OP_EQUAL_ZERO);
            return;
        }
#endif
#if DONUT_WITH_VULKAN
        if (predication->api == nvrhi::GraphicsAPI::VULKAN)
        {
            VkCommandBuffer commandBuffer = ctx->commandList->getNativeObject(nvrhi::ObjectTypes::VK_CommandBuffer);
            VkConditionalRenderingBeginInfoEXT beginInfo = { VK_STRUCTURE_TYPE_CONDITIONAL_RENDERING_BEGIN_INFO_EXT };
            beginInfo.buffer = predication->buffer;
            beginInfo.offset = offset;
            VULKAN_HPP_DEFAULT_DISPATCHER.vkCmdBeginConditionalRenderingEXT(commandBuffer, &beginInfo);
            ctx->commandList->drawIndexed(args);
            VULKAN_HPP_DEFAULT_DISPATCHER.vkCmdEndConditionalRenderingEXT(commandBuffer);
            return;
        }
#endif
        ctx->commandList->drawIndexed(args);
    }

    // Binary occlusion queries resolved on the GPU into values that predicate draws
    // (Donut_CreateOcclusionPredication): D3D12's occlusion query heap resolved into a predication
    // buffer, Vulkan's occlusion query pool copied into a conditional rendering buffer.
    struct OcclusionPredication
    {
        nvrhi::GraphicsAPI api = nvrhi::GraphicsAPI::D3D12;
        uint32_t count = 0;
#if DONUT_WITH_DX12
        Microsoft::WRL::ComPtr<ID3D12QueryHeap> queryHeap;
        Microsoft::WRL::ComPtr<ID3D12Resource> resource;
#endif
#if DONUT_WITH_VULKAN
        VkDevice device = VK_NULL_HANDLE;
        VkQueryPool queryPool = VK_NULL_HANDLE;
        VkBuffer buffer = VK_NULL_HANDLE;
        VkDeviceMemory memory = VK_NULL_HANDLE;
        // Its values are zeroed by the first command list that uses it.
        bool cleared = false;
#endif

        ~OcclusionPredication()
        {
#if DONUT_WITH_VULKAN
            if (queryPool != VK_NULL_HANDLE)
                VULKAN_HPP_DEFAULT_DISPATCHER.vkDestroyQueryPool(device, queryPool, nullptr);
            if (buffer != VK_NULL_HANDLE)
                VULKAN_HPP_DEFAULT_DISPATCHER.vkDestroyBuffer(device, buffer, nullptr);
            if (memory != VK_NULL_HANDLE)
                VULKAN_HPP_DEFAULT_DISPATCHER.vkFreeMemory(device, memory, nullptr);
#endif
        }
    };

    // count binary occlusion queries (Donut_DrawVerticesWithOcclusionQuery) and their resolved
    // results (Donut_ResolveOcclusionQueries), which predicate draws
    // (Donut_DrawVerticesOcclusionPredicated); every result starts as 0, occluded. Requires
    // Donut_HasConditionalRendering; null otherwise or on failure.
    void* Donut_CreateOcclusionPredication(App* app, int count)
    {
        App* a = app;
        if (!a->conditionalRendering || count <= 0)
            return nullptr;
        nvrhi::IDevice* device = a->device();
        auto occlusion = std::make_shared<OcclusionPredication>();
        occlusion->api = device->getGraphicsAPI();
        occlusion->count = static_cast<uint32_t>(count);
        const uint64_t byteSize = sizeof(uint64_t) * occlusion->count;
#if DONUT_WITH_DX12
        if (occlusion->api == nvrhi::GraphicsAPI::D3D12)
        {
            ID3D12Device* d3dDevice = device->getNativeObject(nvrhi::ObjectTypes::D3D12_Device);
            D3D12_QUERY_HEAP_DESC heapDesc = {};
            heapDesc.Type = D3D12_QUERY_HEAP_TYPE_OCCLUSION;
            heapDesc.Count = occlusion->count;
            D3D12_HEAP_PROPERTIES heapProperties = {};
            heapProperties.Type = D3D12_HEAP_TYPE_DEFAULT;
            D3D12_RESOURCE_DESC bufferDesc = {};
            bufferDesc.Dimension = D3D12_RESOURCE_DIMENSION_BUFFER;
            bufferDesc.Width = byteSize;
            bufferDesc.Height = 1;
            bufferDesc.DepthOrArraySize = 1;
            bufferDesc.MipLevels = 1;
            bufferDesc.SampleDesc.Count = 1;
            bufferDesc.Layout = D3D12_TEXTURE_LAYOUT_ROW_MAJOR;
            // A committed resource's memory starts zeroed.
            if (FAILED(d3dDevice->CreateQueryHeap(&heapDesc, IID_PPV_ARGS(&occlusion->queryHeap)))
                || FAILED(d3dDevice->CreateCommittedResource(&heapProperties, D3D12_HEAP_FLAG_NONE, &bufferDesc,
                    D3D12_RESOURCE_STATE_PREDICATION, nullptr, IID_PPV_ARGS(&occlusion->resource))))
                return nullptr;
        }
#endif
#if DONUT_WITH_VULKAN
        if (occlusion->api == nvrhi::GraphicsAPI::VULKAN)
        {
            occlusion->device = device->getNativeObject(nvrhi::ObjectTypes::VK_Device);
            VkQueryPoolCreateInfo poolInfo = { VK_STRUCTURE_TYPE_QUERY_POOL_CREATE_INFO };
            poolInfo.queryType = VK_QUERY_TYPE_OCCLUSION;
            poolInfo.queryCount = occlusion->count;
            if (VULKAN_HPP_DEFAULT_DISPATCHER.vkCreateQueryPool(occlusion->device, &poolInfo, nullptr, &occlusion->queryPool) != VK_SUCCESS)
                return nullptr;
            VkBufferCreateInfo bufferInfo = { VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO };
            bufferInfo.size = byteSize;
            bufferInfo.usage = VK_BUFFER_USAGE_CONDITIONAL_RENDERING_BIT_EXT | VK_BUFFER_USAGE_TRANSFER_DST_BIT;
            bufferInfo.sharingMode = VK_SHARING_MODE_EXCLUSIVE;
            if (VULKAN_HPP_DEFAULT_DISPATCHER.vkCreateBuffer(occlusion->device, &bufferInfo, nullptr, &occlusion->buffer) != VK_SUCCESS)
                return nullptr;
            VkMemoryRequirements requirements;
            VULKAN_HPP_DEFAULT_DISPATCHER.vkGetBufferMemoryRequirements(occlusion->device, occlusion->buffer, &requirements);
            VkPhysicalDeviceMemoryProperties memoryProperties;
            VULKAN_HPP_DEFAULT_DISPATCHER.vkGetPhysicalDeviceMemoryProperties(
                DeviceManagerVKAccess::PhysicalDevice(static_cast<DeviceManager_VK*>(a->deviceManager.get())), &memoryProperties);
            uint32_t memoryType = UINT32_MAX;
            for (uint32_t i = 0; i < memoryProperties.memoryTypeCount && memoryType == UINT32_MAX; i++)
            {
                if ((requirements.memoryTypeBits & (1u << i))
                    && (memoryProperties.memoryTypes[i].propertyFlags & VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT))
                    memoryType = i;
            }
            VkMemoryAllocateInfo allocateInfo = { VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO };
            allocateInfo.allocationSize = requirements.size;
            allocateInfo.memoryTypeIndex = memoryType;
            if (memoryType == UINT32_MAX
                || VULKAN_HPP_DEFAULT_DISPATCHER.vkAllocateMemory(occlusion->device, &allocateInfo, nullptr, &occlusion->memory) != VK_SUCCESS
                || VULKAN_HPP_DEFAULT_DISPATCHER.vkBindBufferMemory(occlusion->device, occlusion->buffer, occlusion->memory, 0) != VK_SUCCESS)
                return nullptr;
        }
#endif
        return a->OwnObject(occlusion);
    }

#if DONUT_WITH_VULKAN
    // Ends NVRHI's render pass (its next draw begins another, loading the targets) for commands
    // Vulkan takes outside render passes only, and zeroes the results the first time.
    static VkCommandBuffer BeginOcclusionCommands(FrameContext* ctx, OcclusionPredication* occlusion)
    {
        ctx->commandList->clearState();
        VkCommandBuffer commandBuffer = ctx->commandList->getNativeObject(nvrhi::ObjectTypes::VK_CommandBuffer);
        if (!occlusion->cleared)
        {
            VULKAN_HPP_DEFAULT_DISPATCHER.vkCmdFillBuffer(commandBuffer, occlusion->buffer, 0, VK_WHOLE_SIZE, 0);
            VkMemoryBarrier barrier = { VK_STRUCTURE_TYPE_MEMORY_BARRIER };
            barrier.srcAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT;
            barrier.dstAccessMask = VK_ACCESS_CONDITIONAL_RENDERING_READ_BIT_EXT | VK_ACCESS_TRANSFER_WRITE_BIT;
            VULKAN_HPP_DEFAULT_DISPATCHER.vkCmdPipelineBarrier(commandBuffer, VK_PIPELINE_STAGE_TRANSFER_BIT,
                VK_PIPELINE_STAGE_CONDITIONAL_RENDERING_BIT_EXT | VK_PIPELINE_STAGE_TRANSFER_BIT, 0, 1, &barrier, 0, nullptr, 0, nullptr);
            occlusion->cleared = true;
        }
        return commandBuffer;
    }
#endif

    // Draws vertexCount vertices (Donut_DrawVertices) inside binary occlusion query `index`: its
    // result says whether any of their samples passed the depth and stencil tests.
    void Donut_DrawVerticesWithOcclusionQuery(FrameContext* frame, int vertexCount, void* occlusionPredication, int index)
    {
        auto* occlusion = static_cast<OcclusionPredication*>(occlusionPredication);
        FrameContext* ctx = frame;
        if (index < 0 || uint32_t(index) >= occlusion->count)
            return;
        if (ctx->draw.viewport.viewports.empty())
            ctx->draw.viewport.addViewportAndScissorRect(ctx->draw.framebuffer->getFramebufferInfo().getViewport());
        nvrhi::DrawArguments args;
        args.vertexCount = static_cast<uint32_t>(vertexCount);
#if DONUT_WITH_DX12
        if (occlusion->api == nvrhi::GraphicsAPI::D3D12)
        {
            ctx->commandList->setGraphicsState(ctx->draw);
            ID3D12GraphicsCommandList* d3dCommandList = ctx->commandList->getNativeObject(nvrhi::ObjectTypes::D3D12_GraphicsCommandList);
            d3dCommandList->BeginQuery(occlusion->queryHeap.Get(), D3D12_QUERY_TYPE_BINARY_OCCLUSION, UINT(index));
            ctx->commandList->draw(args);
            d3dCommandList->EndQuery(occlusion->queryHeap.Get(), D3D12_QUERY_TYPE_BINARY_OCCLUSION, UINT(index));
            return;
        }
#endif
#if DONUT_WITH_VULKAN
        if (occlusion->api == nvrhi::GraphicsAPI::VULKAN)
        {
            // Reset outside the render pass, then the query within the one the draw begins.
            VkCommandBuffer commandBuffer = BeginOcclusionCommands(ctx, occlusion);
            VULKAN_HPP_DEFAULT_DISPATCHER.vkCmdResetQueryPool(commandBuffer, occlusion->queryPool, uint32_t(index), 1);
            ctx->commandList->setGraphicsState(ctx->draw);
            VULKAN_HPP_DEFAULT_DISPATCHER.vkCmdBeginQuery(commandBuffer, occlusion->queryPool, uint32_t(index), 0);
            ctx->commandList->draw(args);
            VULKAN_HPP_DEFAULT_DISPATCHER.vkCmdEndQuery(commandBuffer, occlusion->queryPool, uint32_t(index));
            return;
        }
#endif
    }

    // Resolves the queries into the predication values for the draws after it: 1 where samples
    // passed, 0 where none did (the GPU waits for the queries).
    void Donut_ResolveOcclusionQueries(FrameContext* frame, void* occlusionPredication)
    {
        auto* occlusion = static_cast<OcclusionPredication*>(occlusionPredication);
        FrameContext* ctx = frame;
#if DONUT_WITH_DX12
        if (occlusion->api == nvrhi::GraphicsAPI::D3D12)
        {
            ID3D12GraphicsCommandList* d3dCommandList = ctx->commandList->getNativeObject(nvrhi::ObjectTypes::D3D12_GraphicsCommandList);
            D3D12_RESOURCE_BARRIER barrier = {};
            barrier.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
            barrier.Transition.pResource = occlusion->resource.Get();
            barrier.Transition.Subresource = D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
            barrier.Transition.StateBefore = D3D12_RESOURCE_STATE_PREDICATION;
            barrier.Transition.StateAfter = D3D12_RESOURCE_STATE_COPY_DEST;
            d3dCommandList->ResourceBarrier(1, &barrier);
            d3dCommandList->ResolveQueryData(occlusion->queryHeap.Get(), D3D12_QUERY_TYPE_BINARY_OCCLUSION, 0,
                occlusion->count, occlusion->resource.Get(), 0);
            std::swap(barrier.Transition.StateBefore, barrier.Transition.StateAfter);
            d3dCommandList->ResourceBarrier(1, &barrier);
            return;
        }
#endif
#if DONUT_WITH_VULKAN
        if (occlusion->api == nvrhi::GraphicsAPI::VULKAN)
        {
            VkCommandBuffer commandBuffer = BeginOcclusionCommands(ctx, occlusion);
            // After the predicated draws that read the old values.
            VkMemoryBarrier before = { VK_STRUCTURE_TYPE_MEMORY_BARRIER };
            before.srcAccessMask = VK_ACCESS_CONDITIONAL_RENDERING_READ_BIT_EXT;
            before.dstAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT;
            VULKAN_HPP_DEFAULT_DISPATCHER.vkCmdPipelineBarrier(commandBuffer, VK_PIPELINE_STAGE_CONDITIONAL_RENDERING_BIT_EXT,
                VK_PIPELINE_STAGE_TRANSFER_BIT, 0, 1, &before, 0, nullptr, 0, nullptr);
            // 32-bit results 8 bytes apart, as D3D12's; conditional rendering reads 32 bits.
            VULKAN_HPP_DEFAULT_DISPATCHER.vkCmdCopyQueryPoolResults(commandBuffer, occlusion->queryPool, 0, occlusion->count,
                occlusion->buffer, 0, sizeof(uint64_t), VK_QUERY_RESULT_WAIT_BIT);
            VkMemoryBarrier after = { VK_STRUCTURE_TYPE_MEMORY_BARRIER };
            after.srcAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT;
            after.dstAccessMask = VK_ACCESS_CONDITIONAL_RENDERING_READ_BIT_EXT;
            VULKAN_HPP_DEFAULT_DISPATCHER.vkCmdPipelineBarrier(commandBuffer, VK_PIPELINE_STAGE_TRANSFER_BIT,
                VK_PIPELINE_STAGE_CONDITIONAL_RENDERING_BIT_EXT, 0, 1, &after, 0, nullptr, 0, nullptr);
            return;
        }
#endif
    }

    // Draws vertexCount vertices (Donut_DrawVertices) only if resolved result `index` isn't 0 when
    // the GPU gets to it.
    void Donut_DrawVerticesOcclusionPredicated(FrameContext* frame, int vertexCount, void* occlusionPredication, int index)
    {
        auto* occlusion = static_cast<OcclusionPredication*>(occlusionPredication);
        FrameContext* ctx = frame;
        if (index < 0 || uint32_t(index) >= occlusion->count)
            return;
        if (ctx->draw.viewport.viewports.empty())
            ctx->draw.viewport.addViewportAndScissorRect(ctx->draw.framebuffer->getFramebufferInfo().getViewport());
#if DONUT_WITH_VULKAN
        // Zeroed outside the render pass the draw begins.
        if (occlusion->api == nvrhi::GraphicsAPI::VULKAN && !occlusion->cleared)
            BeginOcclusionCommands(ctx, occlusion);
#endif
        ctx->commandList->setGraphicsState(ctx->draw);
        nvrhi::DrawArguments args;
        args.vertexCount = static_cast<uint32_t>(vertexCount);
        const uint64_t offset = sizeof(uint64_t) * static_cast<uint64_t>(index);
#if DONUT_WITH_DX12
        if (occlusion->api == nvrhi::GraphicsAPI::D3D12)
        {
            ID3D12GraphicsCommandList* d3dCommandList = ctx->commandList->getNativeObject(nvrhi::ObjectTypes::D3D12_GraphicsCommandList);
            d3dCommandList->SetPredication(occlusion->resource.Get(), offset, D3D12_PREDICATION_OP_EQUAL_ZERO);
            ctx->commandList->draw(args);
            d3dCommandList->SetPredication(nullptr, 0, D3D12_PREDICATION_OP_EQUAL_ZERO);
            return;
        }
#endif
#if DONUT_WITH_VULKAN
        if (occlusion->api == nvrhi::GraphicsAPI::VULKAN)
        {
            VkCommandBuffer commandBuffer = ctx->commandList->getNativeObject(nvrhi::ObjectTypes::VK_CommandBuffer);
            VkConditionalRenderingBeginInfoEXT beginInfo = { VK_STRUCTURE_TYPE_CONDITIONAL_RENDERING_BEGIN_INFO_EXT };
            beginInfo.buffer = occlusion->buffer;
            beginInfo.offset = offset;
            VULKAN_HPP_DEFAULT_DISPATCHER.vkCmdBeginConditionalRenderingEXT(commandBuffer, &beginInfo);
            ctx->commandList->draw(args);
            VULKAN_HPP_DEFAULT_DISPATCHER.vkCmdEndConditionalRenderingEXT(commandBuffer);
            return;
        }
#endif
    }

    // The buffer indirect draws read their arguments from (Donut_CreateDrawIndexedIndirectBuffer).
    void Donut_DrawSetIndirectBuffer(FrameContext* frame, nvrhi::IBuffer* indirectBuffer)
    {
        frame->draw.indirectParams = indirectBuffer;
    }

    // drawCount indexed draws, their arguments read from the indirect buffer from offsetBytes on
    // (20 bytes each). The draw described stays, so this can repeat with other offsets.
    void Donut_DrawIndexedIndirect(FrameContext* frame, int offsetBytes, int drawCount)
    {
        FrameContext* ctx = frame;
        if (ctx->draw.viewport.viewports.empty())
            ctx->draw.viewport.addViewportAndScissorRect(ctx->draw.framebuffer->getFramebufferInfo().getViewport());
        // NVRHI skips the parts of the state that haven't changed since the previous draw.
        ctx->commandList->setGraphicsState(ctx->draw);
        ctx->commandList->drawIndexedIndirect(static_cast<uint32_t>(offsetBytes), static_cast<uint32_t>(drawCount));
    }

    // Copies a texture of the back buffer's size and a compatible format (e.g. RGBA8_UNORM) into
    // the back buffer, without conversion.
    void Donut_CopyTextureToFrame(FrameContext* frame, nvrhi::ITexture* texture)
    {
        FrameContext* ctx = frame;
        ctx->commandList->copyTexture(ctx->framebuffer->getDesc().colorAttachments[0].texture, nvrhi::TextureSlice(),
            texture, nvrhi::TextureSlice());
    }

    // Same as Donut_DrawIndexed, without an index buffer: vertexCount vertices.
    void Donut_DrawVertices(FrameContext* frame, int vertexCount)
    {
        FrameContext* ctx = frame;
        if (ctx->draw.viewport.viewports.empty())
            ctx->draw.viewport.addViewportAndScissorRect(ctx->draw.framebuffer->getFramebufferInfo().getViewport());
        ctx->commandList->setGraphicsState(ctx->draw);

        nvrhi::DrawArguments args;
        args.vertexCount = static_cast<uint32_t>(vertexCount);
        ctx->commandList->draw(args);
    }

    // Same, with byteSize bytes of push constants from data; the draw described stays.
    void Donut_DrawVerticesWithPushConstants(FrameContext* frame, int vertexCount, const void* data, int byteSize)
    {
        FrameContext* ctx = frame;
        if (ctx->draw.viewport.viewports.empty())
            ctx->draw.viewport.addViewportAndScissorRect(ctx->draw.framebuffer->getFramebufferInfo().getViewport());
        ctx->commandList->setGraphicsState(ctx->draw);
        ctx->commandList->setPushConstants(data, static_cast<size_t>(byteSize));

        nvrhi::DrawArguments args;
        args.vertexCount = static_cast<uint32_t>(vertexCount);
        ctx->commandList->draw(args);
    }

    // Executes what the frame's command list holds so far, and reopens it for the rest of the frame:
    // e.g. so that copies out of a tiled texture run before Donut_ApplyTileMappings remaps it.
    void Donut_SubmitFrameCommandList(App* app, FrameContext* frame)
    {
        FrameContext* ctx = frame;
        ctx->commandList->close();
        app->device()->executeCommandList(ctx->commandList);
        ctx->commandList->open();
    }

    // Starts describing a mesh shader draw with a meshlet pipeline, over the whole framebuffer; add
    // binding sets and a viewport with the Donut_Draw* functions, then issue it with
    // Donut_DrawMeshTasks.
    void Donut_BeginMeshDraw(FrameContext* frame, nvrhi::IMeshletPipeline* meshletPipeline)
    {
        FrameContext* ctx = frame;
        ctx->draw = nvrhi::GraphicsState();
        ctx->draw.framebuffer = ctx->framebuffer;
        ctx->meshletPipeline = meshletPipeline;
    }

    // Same, into another framebuffer (the pipeline must be for its layout).
    void Donut_BeginMeshDrawToFramebuffer(FrameContext* frame, nvrhi::IMeshletPipeline* meshletPipeline, nvrhi::IFramebuffer* framebuffer)
    {
        FrameContext* ctx = frame;
        ctx->draw = nvrhi::GraphicsState();
        ctx->draw.framebuffer = framebuffer;
        ctx->meshletPipeline = meshletPipeline;
    }

    // Launches groupsX x 1 x 1 groups of the draw's first shader (amplification, or mesh without one).
    void Donut_DrawMeshTasks(FrameContext* frame, int groupsX)
    {
        FrameContext* ctx = frame;
        if (ctx->draw.viewport.viewports.empty())
            ctx->draw.viewport.addViewportAndScissorRect(ctx->draw.framebuffer->getFramebufferInfo().getViewport());

        nvrhi::MeshletState state;
        state.pipeline = ctx->meshletPipeline;
        state.framebuffer = ctx->draw.framebuffer;
        state.viewport = ctx->draw.viewport;
        state.bindings = ctx->draw.bindings;
        ctx->commandList->setMeshletState(state);
        ctx->commandList->dispatchMesh(static_cast<uint32_t>(groupsX));
    }

    // Same as Donut_DrawMeshTasks, launching groupsX x groupsY groups.
    void Donut_DrawMeshTasks2D(FrameContext* frame, int groupsX, int groupsY)
    {
        FrameContext* ctx = frame;
        if (ctx->draw.viewport.viewports.empty())
            ctx->draw.viewport.addViewportAndScissorRect(ctx->draw.framebuffer->getFramebufferInfo().getViewport());

        nvrhi::MeshletState state;
        state.pipeline = ctx->meshletPipeline;
        state.framebuffer = ctx->draw.framebuffer;
        state.viewport = ctx->draw.viewport;
        state.bindings = ctx->draw.bindings;
        ctx->commandList->setMeshletState(state);
        ctx->commandList->dispatchMesh(static_cast<uint32_t>(groupsX), static_cast<uint32_t>(groupsY));
    }

    // Pipeline statistics of mesh shader draws: the pixel, amplification (task) and mesh shader
    // invocations. NVRHI has no such queries: native D3D12 query heaps and Vulkan query pools, a ring
    // of them, each read back when it comes round again (a few frames later, without waiting).
    struct MeshPipelineStatistics
    {
        static constexpr uint32_t Slots = 4;
        nvrhi::GraphicsAPI api = nvrhi::GraphicsAPI::D3D12;
        uint32_t slot = 0;
        bool slotUsed[Slots] = {};
        // Pixel, amplification and mesh shader invocations, the latest read back.
        uint64_t values[3] = {};
#if DONUT_WITH_DX12
        Microsoft::WRL::ComPtr<ID3D12QueryHeap> queryHeap;
        Microsoft::WRL::ComPtr<ID3D12Resource> readback;
#endif
#if DONUT_WITH_VULKAN
        VkDevice device = VK_NULL_HANDLE;
        VkQueryPool queryPool = VK_NULL_HANDLE;
#endif

        ~MeshPipelineStatistics()
        {
#if DONUT_WITH_VULKAN
            if (queryPool != VK_NULL_HANDLE)
                VULKAN_HPP_DEFAULT_DISPATCHER.vkDestroyQueryPool(device, queryPool, nullptr);
#endif
        }
    };

    // Null when the device can't count mesh shader work: D3D11, D3D12 without
    // MeshShaderPipelineStatsSupported, Vulkan without pipelineStatisticsQuery and meshShaderQueries
    // (or without mesh shaders).
    void* Donut_CreateMeshPipelineStatistics(App* app)
    {
        App* a = app;
        nvrhi::IDevice* device = a->device();
        if (!device->queryFeatureSupport(nvrhi::Feature::Meshlets))
            return nullptr;

        auto stats = std::make_shared<MeshPipelineStatistics>();
        stats->api = device->getGraphicsAPI();
#if DONUT_WITH_DX12
        if (stats->api == nvrhi::GraphicsAPI::D3D12)
        {
            ID3D12Device* d3dDevice = device->getNativeObject(nvrhi::ObjectTypes::D3D12_Device);
            D3D12_FEATURE_DATA_D3D12_OPTIONS9 options = {};
            if (FAILED(d3dDevice->CheckFeatureSupport(D3D12_FEATURE_D3D12_OPTIONS9, &options, sizeof(options)))
                || !options.MeshShaderPipelineStatsSupported)
                return nullptr;

            D3D12_QUERY_HEAP_DESC heapDesc = {};
            heapDesc.Type = D3D12_QUERY_HEAP_TYPE_PIPELINE_STATISTICS1;
            heapDesc.Count = MeshPipelineStatistics::Slots;
            if (FAILED(d3dDevice->CreateQueryHeap(&heapDesc, IID_PPV_ARGS(&stats->queryHeap))))
                return nullptr;

            D3D12_HEAP_PROPERTIES heapProperties = {};
            heapProperties.Type = D3D12_HEAP_TYPE_READBACK;
            D3D12_RESOURCE_DESC bufferDesc = {};
            bufferDesc.Dimension = D3D12_RESOURCE_DIMENSION_BUFFER;
            bufferDesc.Width = sizeof(D3D12_QUERY_DATA_PIPELINE_STATISTICS1) * MeshPipelineStatistics::Slots;
            bufferDesc.Height = 1;
            bufferDesc.DepthOrArraySize = 1;
            bufferDesc.MipLevels = 1;
            bufferDesc.SampleDesc.Count = 1;
            bufferDesc.Layout = D3D12_TEXTURE_LAYOUT_ROW_MAJOR;
            if (FAILED(d3dDevice->CreateCommittedResource(&heapProperties, D3D12_HEAP_FLAG_NONE, &bufferDesc,
                    D3D12_RESOURCE_STATE_COPY_DEST, nullptr, IID_PPV_ARGS(&stats->readback))))
                return nullptr;
            return a->OwnObject(stats);
        }
#endif
#if DONUT_WITH_VULKAN
        if (stats->api == nvrhi::GraphicsAPI::VULKAN)
        {
            if (!a->pipelineStatisticsQuery)
                return nullptr;
            const vk::PhysicalDevice physicalDevice = DeviceManagerVKAccess::PhysicalDevice(
                static_cast<DeviceManager_VK*>(a->deviceManager.get()));
            // Donut enables the mesh shader features the GPU has.
            auto meshShaderFeatures = vk::PhysicalDeviceMeshShaderFeaturesEXT();
            auto features2 = vk::PhysicalDeviceFeatures2().setPNext(&meshShaderFeatures);
            physicalDevice.getFeatures2(&features2);
            if (!meshShaderFeatures.meshShaderQueries)
                return nullptr;

            stats->device = device->getNativeObject(nvrhi::ObjectTypes::VK_Device);
            VkQueryPoolCreateInfo poolInfo = { VK_STRUCTURE_TYPE_QUERY_POOL_CREATE_INFO };
            poolInfo.queryType = VK_QUERY_TYPE_PIPELINE_STATISTICS;
            poolInfo.queryCount = MeshPipelineStatistics::Slots;
            // Results in bit order: pixel, task, mesh shader invocations.
            poolInfo.pipelineStatistics = VK_QUERY_PIPELINE_STATISTIC_FRAGMENT_SHADER_INVOCATIONS_BIT
                | VK_QUERY_PIPELINE_STATISTIC_TASK_SHADER_INVOCATIONS_BIT_EXT
                | VK_QUERY_PIPELINE_STATISTIC_MESH_SHADER_INVOCATIONS_BIT_EXT;
            if (VULKAN_HPP_DEFAULT_DISPATCHER.vkCreateQueryPool(stats->device, &poolInfo, nullptr, &stats->queryPool) != VK_SUCCESS)
                return nullptr;
            return a->OwnObject(stats);
        }
#endif
        return nullptr;
    }

    // Starts the frame's statistics, before the frame's first draw (Vulkan resets queries outside
    // render passes): reads back the results of the query this frame reuses, if it was used.
    void Donut_BeginMeshPipelineStatisticsFrame(FrameContext* frame, void* meshPipelineStatistics)
    {
        auto* stats = static_cast<MeshPipelineStatistics*>(meshPipelineStatistics);
        nvrhi::ICommandList* commandList = frame->commandList;
        stats->slot = (stats->slot + 1) % MeshPipelineStatistics::Slots;
        const uint32_t slot = stats->slot;
#if DONUT_WITH_DX12
        if (stats->api == nvrhi::GraphicsAPI::D3D12 && stats->slotUsed[slot])
        {
            const SIZE_T offset = sizeof(D3D12_QUERY_DATA_PIPELINE_STATISTICS1) * slot;
            const D3D12_RANGE range = { offset, offset + sizeof(D3D12_QUERY_DATA_PIPELINE_STATISTICS1) };
            void* mapped = nullptr;
            if (SUCCEEDED(stats->readback->Map(0, &range, &mapped)))
            {
                D3D12_QUERY_DATA_PIPELINE_STATISTICS1 data;
                memcpy(&data, static_cast<uint8_t*>(mapped) + offset, sizeof(data));
                const D3D12_RANGE written = { 0, 0 };
                stats->readback->Unmap(0, &written);
                stats->values[0] = data.PSInvocations;
                stats->values[1] = data.ASInvocations;
                stats->values[2] = data.MSInvocations;
            }
        }
#endif
#if DONUT_WITH_VULKAN
        if (stats->api == nvrhi::GraphicsAPI::VULKAN)
        {
            if (stats->slotUsed[slot])
            {
                uint64_t values[3];
                if (VULKAN_HPP_DEFAULT_DISPATCHER.vkGetQueryPoolResults(stats->device, stats->queryPool, slot, 1,
                        sizeof(values), values, sizeof(uint64_t), VK_QUERY_RESULT_64_BIT) == VK_SUCCESS)
                    memcpy(stats->values, values, sizeof(values));
            }
            VkCommandBuffer commandBuffer = commandList->getNativeObject(nvrhi::ObjectTypes::VK_CommandBuffer);
            VULKAN_HPP_DEFAULT_DISPATCHER.vkCmdResetQueryPool(commandBuffer, stats->queryPool, slot, 1);
        }
#endif
        stats->slotUsed[slot] = false;
    }

    // Same as Donut_DrawMeshTasks2D, counted by the frame's statistics.
    void Donut_DrawMeshTasksWithStatistics(FrameContext* frame, int groupsX, int groupsY, void* meshPipelineStatistics)
    {
        auto* stats = static_cast<MeshPipelineStatistics*>(meshPipelineStatistics);
        FrameContext* ctx = frame;
        if (ctx->draw.viewport.viewports.empty())
            ctx->draw.viewport.addViewportAndScissorRect(ctx->draw.framebuffer->getFramebufferInfo().getViewport());

        nvrhi::MeshletState state;
        state.pipeline = ctx->meshletPipeline;
        state.framebuffer = ctx->draw.framebuffer;
        state.viewport = ctx->draw.viewport;
        state.bindings = ctx->draw.bindings;
        // On Vulkan this begins the render pass: the query lies within it.
        ctx->commandList->setMeshletState(state);

        const uint32_t slot = stats->slot;
#if DONUT_WITH_DX12
        if (stats->api == nvrhi::GraphicsAPI::D3D12)
        {
            ID3D12GraphicsCommandList* d3dCommandList = ctx->commandList->getNativeObject(nvrhi::ObjectTypes::D3D12_GraphicsCommandList);
            d3dCommandList->BeginQuery(stats->queryHeap.Get(), D3D12_QUERY_TYPE_PIPELINE_STATISTICS1, slot);
            ctx->commandList->dispatchMesh(static_cast<uint32_t>(groupsX), static_cast<uint32_t>(groupsY));
            d3dCommandList->EndQuery(stats->queryHeap.Get(), D3D12_QUERY_TYPE_PIPELINE_STATISTICS1, slot);
            d3dCommandList->ResolveQueryData(stats->queryHeap.Get(), D3D12_QUERY_TYPE_PIPELINE_STATISTICS1, slot, 1,
                stats->readback.Get(), sizeof(D3D12_QUERY_DATA_PIPELINE_STATISTICS1) * slot);
        }
#endif
#if DONUT_WITH_VULKAN
        if (stats->api == nvrhi::GraphicsAPI::VULKAN)
        {
            VkCommandBuffer commandBuffer = ctx->commandList->getNativeObject(nvrhi::ObjectTypes::VK_CommandBuffer);
            VULKAN_HPP_DEFAULT_DISPATCHER.vkCmdBeginQuery(commandBuffer, stats->queryPool, slot, 0);
            ctx->commandList->dispatchMesh(static_cast<uint32_t>(groupsX), static_cast<uint32_t>(groupsY));
            VULKAN_HPP_DEFAULT_DISPATCHER.vkCmdEndQuery(commandBuffer, stats->queryPool, slot);
        }
#endif
        stats->slotUsed[slot] = true;
    }

    // The latest results read back: which 0 for pixel shader invocations, 1 for amplification
    // (task) shader invocations, 2 for mesh shader invocations.
    double Donut_GetMeshPipelineStatistic(void* meshPipelineStatistics, int which)
    {
        auto* stats = static_cast<MeshPipelineStatistics*>(meshPipelineStatistics);
        return which >= 0 && which < 3 ? double(stats->values[which]) : 0.0;
    }

    int Donut_GetFrameWidth(FrameContext* frame)
    {
        return static_cast<int>(frame->framebuffer->getFramebufferInfo().width);
    }

    int Donut_GetFrameHeight(FrameContext* frame)
    {
        return static_cast<int>(frame->framebuffer->getFramebufferInfo().height);
    }
}
