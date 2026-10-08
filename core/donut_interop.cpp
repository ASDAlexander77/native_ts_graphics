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
#include <donut/render/ForwardShadingPass.h>
#include <donut/render/GBuffer.h>
#include <donut/render/GBufferFillPass.h>
#include <donut/render/GeometryPasses.h>
#include <donut/render/LightProbeProcessingPass.h>
#include <donut/render/MipMapGenPass.h>
#include <donut/render/PixelReadbackPass.h>
#include <donut/render/SkyPass.h>
#include <donut/render/SsaoPass.h>
#include <donut/render/TemporalAntiAliasingPass.h>
#include <donut/render/ToneMappingPasses.h>
#include <nvrhi/common/misc.h>
#include <nvrhi/utils.h>

#if DONUT_WITH_DX12
#include <d3d12.h>
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
// Its implementation is compiled into donut_engine (GltfImporter.cpp).
#include <cgltf.h>

#include <atomic>
#include <chrono>
#include <cstring>
#include <memory>
#include <mutex>
#include <queue>
#include <thread>
#include <unordered_map>
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

    using VoidFn = void (*)(void* thisVal);
    using RenderFn = void (*)(void* thisVal, void* frame);
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

        nvrhi::IDevice* device() const { return deviceManager->GetDevice(); }

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

        void* Own(nvrhi::IResource* resource)
        {
            if (!resource)
                return nullptr;
            resources.emplace(resource, resource);
            return resource;
        }

        ~App()
        {
            // Tasks may still be recording commands with the objects below.
            if (m_ThreadPool)
                m_ThreadPool->WaitForTasks();
            m_ThreadPool.reset();

            // Everything created on the device goes before the device itself.
            device()->waitForIdle();

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
        return app;
    }

    // Adapters of one graphics API. Holds the device manager whose instance enumerated them;
    // no device is ever created on it.
    struct AdapterList
    {
        std::unique_ptr<DeviceManager> deviceManager;
        std::vector<donut::app::AdapterInfo> adapters;
    };

    App* AsApp(void* app) { return static_cast<App*>(app); }
    TsRenderPass* AsPass(void* pass) { return static_cast<TsRenderPass*>(pass); }
    FrameContext* AsFrame(void* frame) { return static_cast<FrameContext*>(frame); }
    AdapterList* AsAdapterList(void* list) { return static_cast<AdapterList*>(list); }
    nvrhi::ICommandList* AsCommandList(void* commandList) { return static_cast<nvrhi::ICommandList*>(commandList); }
    nvrhi::IBuffer* AsBuffer(void* buffer) { return static_cast<nvrhi::IBuffer*>(buffer); }
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
    struct ShadowMapTarget
    {
        std::shared_ptr<donut::render::CascadedShadowMap> shadowMap;
        std::shared_ptr<donut::engine::FramebufferFactory> framebuffer;
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
    const std::shared_ptr<donut::engine::FramebufferFactory>& AsFramebufferFactory(void* framebuffer)
    {
        return *static_cast<std::shared_ptr<donut::engine::FramebufferFactory>*>(framebuffer);
    }

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

        std::thread thread;
        std::atomic_bool terminate = false;

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
                while (!terminate && !renderToCompute.TryPop(texture, textureLastUse))
                {}

                if (terminate)
                    break;

                commandList->open();

                nvrhi::BindingSetDesc bindingDesc;
                bindingDesc.addItem(nvrhi::BindingSetItem::Texture_UAV(0, texture));
                bindingDesc.addItem(nvrhi::BindingSetItem::PushConstants(0, sizeof(uint32_t)));
                nvrhi::BindingSetHandle bindingSet = bindings->GetOrCreateBindingSet(bindingDesc, bindingLayout);

                nvrhi::ComputeState state;
                state.pipeline = pipeline;
                state.bindings = { bindingSet };
                commandList->setComputeState(state);
                commandList->setPushConstants(&counter, sizeof(counter));
                commandList->dispatch(groupsX, groupsY);

                commandList->close();

                if (textureLastUse > 0)
                    device->queueWaitForCommandList(nvrhi::CommandQueue::Compute, nvrhi::CommandQueue::Graphics, textureLastUse);
                textureLastUse = device->executeCommandList(commandList, nvrhi::CommandQueue::Compute);

                computeToRender.Push(std::move(texture), textureLastUse);

                counter++;
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
    void* CreateStaticBuffer(App* a, nvrhi::ICommandList* commandList, nvrhi::BufferDesc desc,
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

    // A glTF mesh primitive as the Vulkan-Samples framework loads one (Donut_LoadGltfMesh).
    struct GltfMesh
    {
        // float3 position, float3 normal, float2 texture coordinates.
        nvrhi::BufferHandle vertexBuffer;
        // R32_UINT.
        nvrhi::BufferHandle indexBuffer;
        int indexCount = 0;
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

// donut_interop.d.ts mirrors these enum values as plain numbers.
static_assert(int(nvrhi::GraphicsAPI::D3D11) == 0 && int(nvrhi::GraphicsAPI::D3D12) == 1 && int(nvrhi::GraphicsAPI::VULKAN) == 2);
static_assert(int(nvrhi::Feature::Meshlets) == 9 && int(nvrhi::Feature::RayTracingPipeline) == 14
    && int(nvrhi::Feature::ShaderSpecializations) == 18 && int(nvrhi::Feature::VariableRateShading) == 21
    && int(nvrhi::Feature::RayQuery) == 10);
static_assert(int(nvrhi::ShaderType::Vertex) == 0x1 && int(nvrhi::ShaderType::Hull) == 0x2
    && int(nvrhi::ShaderType::Domain) == 0x4 && int(nvrhi::ShaderType::Pixel) == 0x10
    && int(nvrhi::ShaderType::Compute) == 0x20 && int(nvrhi::ShaderType::Amplification) == 0x40
    && int(nvrhi::ShaderType::Mesh) == 0x80 && int(nvrhi::ShaderType::All) == 0x3FFF);
static_assert(int(nvrhi::PrimitiveType::TriangleList) == 3 && int(nvrhi::PrimitiveType::TriangleStrip) == 4
    && int(nvrhi::PrimitiveType::PatchList) == 8);
static_assert(int(nvrhi::Format::R32_UINT) == 33 && int(nvrhi::Format::RGBA16_FLOAT) == 38
    && int(nvrhi::Format::RG32_FLOAT) == 43 && int(nvrhi::Format::RGB32_FLOAT) == 46
    && int(nvrhi::Format::RGBA8_UNORM) == 19 && int(nvrhi::Format::RGBA16_UINT) == 36 && int(nvrhi::Format::D32) == 53);
static_assert(int(donut::log::Severity::None) == 0 && int(donut::log::Severity::Fatal) == 5);
// LoadMatrix copies 16 floats from TypeScript straight into these.
static_assert(sizeof(dm::float4x4) == 16 * sizeof(float));
// TypeScript lays these out in its own constant buffers, which only works if HLSL doesn't pad them.
static_assert(sizeof(LightConstants) % 16 == 0 && sizeof(PlanarViewConstants) % 16 == 0);

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
    };

    // Creates the device and window for graphicsApi (an nvrhi::GraphicsAPI value), with the
    // AppOptions bits in options. Returns null on failure.
    void* Donut_CreateAppWithOptions(int graphicsApi, const char* title, int width, int height, int options)
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

#if DONUT_WITH_DLSS && DONUT_WITH_VULKAN
        if ((options & AppOption_Dlss) != 0 && api == nvrhi::GraphicsAPI::VULKAN)
        {
            donut::render::DLSS::GetRequiredVulkanExtensions(
                params.optionalVulkanInstanceExtensions,
                params.optionalVulkanDeviceExtensions);
        }
#endif

        if (!deviceManager->CreateWindowDeviceAndSwapChain(params, title))
        {
            donut::log::error("cannot initialize the graphics device");
            return nullptr;
        }

        return MakeApp(std::move(deviceManager), api);
    }

    // Same, without options.
    void* Donut_CreateAppForAPI(int graphicsApi, const char* title, int width, int height)
    {
        return Donut_CreateAppWithOptions(graphicsApi, title, width, height, 0);
    }

    // Same, with the graphics API picked from the command line (-d3d11, -d3d12, -vk; D3D12 by
    // default on Windows).
    void* Donut_CreateApp(int argc, const char* const* argv, const char* title, int width, int height)
    {
        const nvrhi::GraphicsAPI api = donut::app::GetGraphicsAPIFromCommandLine(argc, argv);
        return Donut_CreateAppForAPI(static_cast<int>(api), title, width, height);
    }

    // Creates a device without a window or swap chain, for compute work; adapterIndex -1 picks
    // the default adapter. Such an app has no passes: run work with Donut_*CommandList. Returns
    // null on failure.
    void* Donut_CreateHeadlessApp(int graphicsApi, int adapterIndex)
    {
        donut::log::ConsoleApplicationMode();

        const auto api = static_cast<nvrhi::GraphicsAPI>(graphicsApi);
        std::unique_ptr<DeviceManager> deviceManager(DeviceManager::Create(api));
        if (!deviceManager)
            return nullptr;

        donut::app::DeviceCreationParameters params;
        params.adapterIndex = adapterIndex;

        if (!deviceManager->CreateHeadlessDevice(params))
            return nullptr;

        return MakeApp(std::move(deviceManager), api);
    }

    // Lists the adapters for graphicsApi. Returns null (after logging why) on failure.
    void* Donut_EnumerateAdapters(int graphicsApi)
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

    int Donut_GetAdapterCount(void* list)
    {
        return static_cast<int>(AsAdapterList(list)->adapters.size());
    }

    const char* Donut_GetAdapterName(void* list, int index)
    {
        return AsAdapterList(list)->adapters[index].name.c_str();
    }

    int Donut_GetAdapterMemoryMB(void* list, int index)
    {
        return static_cast<int>(AsAdapterList(list)->adapters[index].dedicatedVideoMemory / (1024 * 1024));
    }

    // Names returned by Donut_GetAdapterName are invalid afterwards.
    void Donut_DestroyAdapterList(void* list)
    {
        delete AsAdapterList(list);
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
    void Donut_RunApp(void* app)
    {
        AsApp(app)->deviceManager->RunMessageLoop();
    }

    // Destroys the app with all its passes and resources; their handles are invalid afterwards.
    void Donut_DestroyApp(void* app)
    {
        delete AsApp(app);
    }

    // feature is an nvrhi::Feature value.
    int Donut_IsFeatureSupported(void* app, int feature)
    {
        return AsApp(app)->device()->queryFeatureSupport(static_cast<nvrhi::Feature>(feature)) ? 1 : 0;
    }

    const char* Donut_GetRendererString(void* app)
    {
        return AsApp(app)->deviceManager->GetRendererString();
    }

    void Donut_SetWindowTitle(void* app, const char* title)
    {
        AsApp(app)->deviceManager->SetWindowTitle(title);
    }

    // Sets "<title> (<graphics API>, <fps> FPS)"; cheap enough to call every frame.
    void Donut_SetInformativeWindowTitle(void* app, const char* title)
    {
        AsApp(app)->deviceManager->SetInformativeWindowTitle(title);
    }

    // Same, with extraInfo appended.
    void Donut_SetInformativeWindowTitleWithInfo(void* app, const char* title, const char* extraInfo)
    {
        AsApp(app)->deviceManager->SetInformativeWindowTitle(title, true, extraInfo);
    }

    // Apps start with vsync on. The change takes effect at the start of the next frame; on
    // Vulkan it recreates the swap chain, so the passes get onBackBufferResizing.
    void Donut_SetVsyncEnabled(void* app, int enabled)
    {
        AsApp(app)->deviceManager->SetVsyncEnabled(enabled != 0);
    }

    // Lags Donut_SetVsyncEnabled by up to a frame.
    int Donut_IsVsyncEnabled(void* app)
    {
        return AsApp(app)->deviceManager->IsVsyncEnabled() ? 1 : 0;
    }

    // Makes Donut_RunApp return after the current frame.
    void Donut_CloseWindow(void* app)
    {
        glfwSetWindowShouldClose(AsApp(app)->deviceManager->GetWindow(), GLFW_TRUE);
    }

    // --- Resources (owned by the app until released or the app is destroyed) ---------------

    // Loads a shader compiled from the example's shaders/<example>.cfg. shaderType is an
    // nvrhi::ShaderType value. Returns null on failure.
    void* Donut_CreateShader(void* app, const char* fileName, const char* entryName, int shaderType)
    {
        App* a = AsApp(app);
        const std::string path = std::string("app/") + fileName;
        nvrhi::ShaderHandle shader = a->shaderFactory->CreateShader(
            path.c_str(), entryName, nullptr, static_cast<nvrhi::ShaderType>(shaderType));
        return a->Own(shader);
    }

    // Same, for the permutation compiled with -D defineName=defineValue in the .cfg.
    void* Donut_CreateShaderWithDefine(void* app, const char* fileName, const char* entryName, int shaderType,
        const char* defineName, const char* defineValue)
    {
        App* a = AsApp(app);
        const std::string path = std::string("app/") + fileName;
        const std::vector<donut::engine::ShaderMacro> defines = { { defineName, defineValue } };
        nvrhi::ShaderHandle shader = a->shaderFactory->CreateShader(
            path.c_str(), entryName, &defines, static_cast<nvrhi::ShaderType>(shaderType));
        return a->Own(shader);
    }

    // Shader library permutation compiled with -T lib -D defineName=defineValue. Returns null on failure.
    void* Donut_CreateShaderLibraryWithDefine(void* app, const char* fileName, const char* defineName, const char* defineValue)
    {
        App* a = AsApp(app);
        const std::string path = std::string("app/") + fileName;
        const std::vector<donut::engine::ShaderMacro> defines = { { defineName, defineValue } };
        return a->Own(a->shaderFactory->CreateShaderLibrary(path.c_str(), &defines));
    }

    // Loads a shader library (compiled with -T lib) from the example's shaders/<example>.cfg.
    // Returns null on failure.
    void* Donut_CreateShaderLibrary(void* app, const char* fileName)
    {
        App* a = AsApp(app);
        const std::string path = std::string("app/") + fileName;
        return a->Own(a->shaderFactory->CreateShaderLibrary(path.c_str(), nullptr));
    }

    // Ray tracing pipeline with one ray generation shader, one miss shader and one triangle hit
    // group made of a closest-hit shader (none if closestHitEntry is empty), all exported from
    // shaderLibrary by entry name, and one global binding layout. Returns null on failure.
    void* Donut_CreateRayTracingPipeline(void* app, void* shaderLibrary, void* bindingLayout,
        const char* rayGenEntry, const char* missEntry, const char* hitGroupName, const char* closestHitEntry,
        int maxPayloadSize)
    {
        auto* library = static_cast<nvrhi::IShaderLibrary*>(shaderLibrary);

        nvrhi::rt::PipelineDesc desc;
        desc.globalBindingLayouts = { static_cast<nvrhi::IBindingLayout*>(bindingLayout) };
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

        App* a = AsApp(app);
        return a->Own(a->device()->createRayTracingPipeline(desc));
    }

    // Same, with a closest-hit and an any-hit shader in the hit group (either may be ""), and a
    // second global binding layout (e.g. a bindless layout; null for none).
    void* Donut_CreateRayTracingPipelineWithLayouts(void* app, void* shaderLibrary, void* bindingLayout, void* secondBindingLayout,
        const char* rayGenEntry, const char* missEntry, const char* hitGroupName, const char* closestHitEntry,
        const char* anyHitEntry, int maxPayloadSize)
    {
        auto* library = static_cast<nvrhi::IShaderLibrary*>(shaderLibrary);
        auto entryShader = [library](const char* entry, nvrhi::ShaderType type) -> nvrhi::ShaderHandle {
            return entry && *entry ? library->getShader(entry, type) : nullptr;
        };

        nvrhi::rt::PipelineDesc desc;
        desc.globalBindingLayouts = { static_cast<nvrhi::IBindingLayout*>(bindingLayout) };
        if (secondBindingLayout)
            desc.globalBindingLayouts.push_back(static_cast<nvrhi::IBindingLayout*>(secondBindingLayout));
        desc.shaders = {
            { "", library->getShader(rayGenEntry, nvrhi::ShaderType::RayGeneration), nullptr },
            { "", library->getShader(missEntry, nvrhi::ShaderType::Miss), nullptr }
        };
        desc.hitGroups = { nvrhi::rt::PipelineHitGroupDesc()
            .setExportName(hitGroupName)
            .setClosestHitShader(entryShader(closestHitEntry, nvrhi::ShaderType::ClosestHit))
            .setAnyHitShader(entryShader(anyHitEntry, nvrhi::ShaderType::AnyHit)) };
        desc.maxPayloadSize = static_cast<uint32_t>(maxPayloadSize);

        App* a = AsApp(app);
        return a->Own(a->device()->createRayTracingPipeline(desc));
    }

    // Ray tracing pipelines of any shape: a description built up with the Donut_RtPipeline*
    // functions below, then consumed (freed) by Donut_CreateRayTracingPipelineFromDesc.
    // maxRecursionDepth: how deeply hit shaders may trace further rays (1 = no recursion).
    void* Donut_CreateRayTracingPipelineDesc(int maxPayloadSize, int maxRecursionDepth)
    {
        auto* desc = new nvrhi::rt::PipelineDesc();
        desc->maxPayloadSize = static_cast<uint32_t>(maxPayloadSize);
        desc->maxRecursionDepth = static_cast<uint32_t>(maxRecursionDepth);
        return desc;
    }

    void Donut_RtPipelineAddGlobalBindingLayout(void* pipelineDesc, void* bindingLayout)
    {
        static_cast<nvrhi::rt::PipelineDesc*>(pipelineDesc)->globalBindingLayouts.push_back(
            static_cast<nvrhi::IBindingLayout*>(bindingLayout));
    }

    // A ray generation, miss or callable shader (shaderType), exported by its entry name.
    void Donut_RtPipelineAddShader(void* pipelineDesc, void* shaderLibrary, const char* entryName, int shaderType)
    {
        static_cast<nvrhi::rt::PipelineDesc*>(pipelineDesc)->shaders.push_back({ "",
            static_cast<nvrhi::IShaderLibrary*>(shaderLibrary)->getShader(entryName, static_cast<nvrhi::ShaderType>(shaderType)),
            nullptr });
    }

    // A triangle hit group: closest-hit and any-hit shaders by entry name ("" for none), and an
    // optional local binding layout (D3D12 only; null for none) whose binding sets are given per
    // shader table entry.
    void Donut_RtPipelineAddHitGroup(void* pipelineDesc, void* shaderLibrary, const char* exportName,
        const char* closestHitEntry, const char* anyHitEntry, void* localBindingLayout)
    {
        auto* library = static_cast<nvrhi::IShaderLibrary*>(shaderLibrary);
        auto entryShader = [library](const char* entry, nvrhi::ShaderType type) -> nvrhi::ShaderHandle {
            return entry && *entry ? library->getShader(entry, type) : nullptr;
        };

        static_cast<nvrhi::rt::PipelineDesc*>(pipelineDesc)->hitGroups.push_back(nvrhi::rt::PipelineHitGroupDesc()
            .setExportName(exportName)
            .setClosestHitShader(entryShader(closestHitEntry, nvrhi::ShaderType::ClosestHit))
            .setAnyHitShader(entryShader(anyHitEntry, nvrhi::ShaderType::AnyHit))
            .setBindingLayout(static_cast<nvrhi::IBindingLayout*>(localBindingLayout)));
    }

    // Returns null on failure.
    void* Donut_CreateRayTracingPipelineFromDesc(void* app, void* pipelineDesc)
    {
        std::unique_ptr<nvrhi::rt::PipelineDesc> desc(static_cast<nvrhi::rt::PipelineDesc*>(pipelineDesc));
        App* a = AsApp(app);
        return a->Own(a->device()->createRayTracingPipeline(*desc));
    }

    // An empty shader table of a pipeline, filled with the Donut_ShaderTable* functions below.
    // It keeps the pipeline alive. Returns null on failure.
    void* Donut_CreateEmptyShaderTable(void* app, void* rayTracingPipeline)
    {
        return AsApp(app)->Own(static_cast<nvrhi::rt::IPipeline*>(rayTracingPipeline)->createShaderTable());
    }

    void Donut_ShaderTableSetRayGeneration(void* shaderTable, const char* exportName)
    {
        static_cast<nvrhi::rt::IShaderTable*>(shaderTable)->setRayGenerationShader(exportName);
    }

    // Returns the miss shader's index (TraceRay's MissShaderIndex).
    int Donut_ShaderTableAddMiss(void* shaderTable, const char* exportName)
    {
        return static_cast<nvrhi::rt::IShaderTable*>(shaderTable)->addMissShader(exportName);
    }

    // Adds an entry for a hit group, with a binding set for its local binding layout (null for
    // none). Returns the entry's index.
    int Donut_ShaderTableAddHitGroup(void* shaderTable, const char* exportName, void* localBindingSet)
    {
        return static_cast<nvrhi::rt::IShaderTable*>(shaderTable)->addHitGroup(exportName,
            static_cast<nvrhi::IBindingSet*>(localBindingSet));
    }

    // Same as Donut_CreateShaderTable, with caching: NVRHI keeps up to maxCachedVersions copies
    // of the table in GPU memory, instead of re-uploading it every time it's used.
    void* Donut_CreateCachedShaderTable(void* app, void* rayTracingPipeline, const char* rayGenExport,
        const char* hitGroupExport, const char* missExport, int maxCachedVersions, const char* debugName)
    {
        nvrhi::rt::ShaderTableHandle table = static_cast<nvrhi::rt::IPipeline*>(rayTracingPipeline)->createShaderTable(
            nvrhi::rt::ShaderTableDesc().enableCaching(static_cast<uint32_t>(maxCachedVersions)).setDebugName(debugName));
        if (!table)
            return nullptr;
        table->setRayGenerationShader(rayGenExport);
        table->addHitGroup(hitGroupExport);
        table->addMissShader(missExport);
        return AsApp(app)->Own(table);
    }

    // Shader table of a ray tracing pipeline, with one ray generation shader, one hit group and
    // one miss shader, named by their export names. It keeps the pipeline alive.
    void* Donut_CreateShaderTable(void* app, void* rayTracingPipeline, const char* rayGenExport,
        const char* hitGroupExport, const char* missExport)
    {
        nvrhi::rt::ShaderTableHandle table = static_cast<nvrhi::rt::IPipeline*>(rayTracingPipeline)->createShaderTable();
        table->setRayGenerationShader(rayGenExport);
        table->addHitGroup(hitGroupExport);
        table->addMissShader(missExport);
        return AsApp(app)->Own(table);
    }

    // Buffer that acceleration structures are built from (vertex or index data), filled with
    // Donut_WriteBuffer. Returns null on failure.
    void* Donut_CreateAccelStructInputBuffer(void* app, int byteSize, const char* debugName)
    {
        auto desc = nvrhi::BufferDesc()
            .setByteSize(static_cast<uint64_t>(byteSize))
            .setIsAccelStructBuildInput(true)
            .setDebugName(debugName)
            .setInitialState(nvrhi::ResourceStates::ShaderResource)
            .setKeepInitialState(true);

        App* a = AsApp(app);
        return a->Own(a->device()->createBuffer(desc));
    }

    // Creates a bottom-level acceleration structure of opaque triangles (R32_UINT indices,
    // RGB32_FLOAT vertices) and records its build into an open command list.
    void* Donut_BuildTriangleBLAS(void* app, void* commandList, void* indexBuffer, int indexCount,
        void* vertexBuffer, int vertexCount)
    {
        nvrhi::rt::GeometryDesc geometry;
        auto& triangles = geometry.geometryData.triangles;
        triangles.indexBuffer = AsBuffer(indexBuffer);
        triangles.vertexBuffer = AsBuffer(vertexBuffer);
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

        App* a = AsApp(app);
        nvrhi::rt::AccelStructHandle blas = a->device()->createAccelStruct(desc);
        if (!blas)
            return nullptr;
        nvrhi::utils::BuildBottomLevelAccelStruct(AsCommandList(commandList), blas, desc);
        return a->Own(blas);
    }

    // Creates a top-level acceleration structure holding one instance of bottomLevelAS (identity
    // transform, mask 1, counter-clockwise front faces) and records its build into an open
    // command list.
    void* Donut_BuildSingleInstanceTLAS(void* app, void* commandList, void* bottomLevelAS)
    {
        nvrhi::rt::AccelStructDesc desc;
        desc.isTopLevel = true;
        desc.topLevelMaxInstances = 1;

        App* a = AsApp(app);
        nvrhi::rt::AccelStructHandle tlas = a->device()->createAccelStruct(desc);
        if (!tlas)
            return nullptr;

        nvrhi::rt::InstanceDesc instance;
        instance.bottomLevelAS = static_cast<nvrhi::rt::IAccelStruct*>(bottomLevelAS);
        instance.instanceMask = 1;
        instance.flags = nvrhi::rt::InstanceFlags::TriangleFrontCounterclockwise;
        const float identity[12] = { 1, 0, 0, 0,   0, 1, 0, 0,   0, 0, 1, 0 };
        memcpy(instance.transform, identity, sizeof(identity));

        AsCommandList(commandList)->buildTopLevelAccelStruct(tlas, &instance, 1);
        return a->Own(tlas);
    }

    // RGBA8_UNORM texture of the frame's size that shaders write as RWTexture2D<float4>; show
    // it with Donut_BlitTexture. Returns null on failure.
    void* Donut_CreateUAVTextureForFrameWithFormat(void* app, void* frame, const char* debugName, int format);

    void* Donut_CreateUAVTextureForFrame(void* app, void* frame, const char* debugName)
    {
        return Donut_CreateUAVTextureForFrameWithFormat(app, frame, debugName, static_cast<int>(nvrhi::Format::RGBA8_UNORM));
    }

    // Same, in `format` (an nvrhi::Format value).
    void* Donut_CreateUAVTextureForFrameWithFormat(void* app, void* frame, const char* debugName, int format)
    {
        nvrhi::TextureDesc desc = AsFrame(frame)->framebuffer->getDesc().colorAttachments[0].texture->getDesc();
        desc.isUAV = true;
        desc.isRenderTarget = false;
        desc.initialState = nvrhi::ResourceStates::UnorderedAccess;
        desc.keepInitialState = true;
        desc.format = static_cast<nvrhi::Format>(format);
        desc.debugName = debugName;

        App* a = AsApp(app);
        return a->Own(a->device()->createTexture(desc));
    }

    // Triangle-list pipeline without depth test, for the frame's framebuffer layout; recreate it
    // after the back buffer is resized. Returns null on failure.
    void* Donut_CreateGraphicsPipeline(void* app, void* frame, void* vertexShader, void* pixelShader)
    {
        nvrhi::GraphicsPipelineDesc desc;
        desc.VS = static_cast<nvrhi::IShader*>(vertexShader);
        desc.PS = static_cast<nvrhi::IShader*>(pixelShader);
        desc.primType = nvrhi::PrimitiveType::TriangleList;
        desc.renderState.depthStencilState.depthTestEnable = false;

        App* a = AsApp(app);
        nvrhi::GraphicsPipelineHandle pipeline = a->device()->createGraphicsPipeline(
            desc, AsFrame(frame)->framebuffer->getFramebufferInfo());
        return a->Own(pipeline);
    }

    // Specializes one constant ([[vk::constant_id(constantId)]] in HLSL) of a SPIR-V shader;
    // requires nvrhi::Feature::ShaderSpecializations (Vulkan only). Returns null on failure.
    void* Donut_SpecializeShaderFloat(void* app, void* shader, int constantId, double value)
    {
        const nvrhi::ShaderSpecialization constant =
            nvrhi::ShaderSpecialization::Float(static_cast<uint32_t>(constantId), float(value));
        App* a = AsApp(app);
        nvrhi::ShaderHandle specialized = a->device()->createShaderSpecialization(
            static_cast<nvrhi::IShader*>(shader), &constant, 1);
        return a->Own(specialized);
    }

    // As above, for a uint constant; value's bits are used as-is.
    void* Donut_SpecializeShaderUInt(void* app, void* shader, int constantId, int value)
    {
        const nvrhi::ShaderSpecialization constant =
            nvrhi::ShaderSpecialization::UInt32(static_cast<uint32_t>(constantId), static_cast<uint32_t>(value));
        App* a = AsApp(app);
        nvrhi::ShaderHandle specialized = a->device()->createShaderSpecialization(
            static_cast<nvrhi::IShader*>(shader), &constant, 1);
        return a->Own(specialized);
    }

    // Amplification + mesh + pixel shader pipeline (triangle list, no depth test) for the frame's
    // framebuffer layout; recreate it after the back buffer is resized. Requires
    // nvrhi::Feature::Meshlets. Returns null on failure.
    void* Donut_CreateMeshletPipeline(void* app, void* frame, void* amplificationShader, void* meshShader, void* pixelShader)
    {
        nvrhi::MeshletPipelineDesc desc;
        desc.AS = static_cast<nvrhi::IShader*>(amplificationShader);
        desc.MS = static_cast<nvrhi::IShader*>(meshShader);
        desc.PS = static_cast<nvrhi::IShader*>(pixelShader);
        desc.primType = nvrhi::PrimitiveType::TriangleList;
        desc.renderState.depthStencilState.depthTestEnable = false;

        App* a = AsApp(app);
        nvrhi::MeshletPipelineHandle pipeline = a->device()->createMeshletPipeline(
            desc, AsFrame(frame)->framebuffer->getFramebufferInfo());
        return a->Own(pipeline);
    }

    // Safe to call while the GPU may still use the resource: NVRHI defers the actual destruction.
    void Donut_ReleaseResource(void* app, void* resource)
    {
        AsApp(app)->resources.erase(static_cast<nvrhi::IResource*>(resource));
    }

    // Typed buffer of elementCount R32_UINT values. writable != 0: a UAV the GPU writes to;
    // otherwise shader-readable only, filled with Donut_WriteBuffer. Returns null on failure.
    void* Donut_CreateUIntBuffer(void* app, int elementCount, int writable, const char* debugName)
    {
        auto desc = nvrhi::BufferDesc()
            .setByteSize(sizeof(uint32_t) * static_cast<uint64_t>(elementCount))
            .setCanHaveTypedViews(true)
            .setCanHaveUAVs(writable != 0)
            .setFormat(nvrhi::Format::R32_UINT)
            .setDebugName(debugName)
            .setInitialState(writable ? nvrhi::ResourceStates::UnorderedAccess : nvrhi::ResourceStates::CopyDest)
            .setKeepInitialState(true);

        App* a = AsApp(app);
        return a->Own(a->device()->createBuffer(desc));
    }

    // CPU-readable buffer to copy GPU results into; read it with Donut_ReadBuffer. Returns null
    // on failure.
    void* Donut_CreateReadbackBuffer(void* app, int byteSize, const char* debugName)
    {
        auto desc = nvrhi::BufferDesc()
            .setByteSize(static_cast<uint64_t>(byteSize))
            .setCpuAccess(nvrhi::CpuAccessMode::Read)
            .setDebugName(debugName)
            .setInitialState(nvrhi::ResourceStates::CopyDest)
            .setKeepInitialState(true);

        App* a = AsApp(app);
        return a->Own(a->device()->createBuffer(desc));
    }

    // Copies byteSize bytes of a readback buffer to dst, after the GPU work writing it has
    // finished (see Donut_WaitForIdle). Returns 0 if the buffer can't be mapped.
    int Donut_ReadBuffer(void* app, void* readbackBuffer, void* dst, int byteSize)
    {
        nvrhi::IDevice* device = AsApp(app)->device();
        const void* data = device->mapBuffer(AsBuffer(readbackBuffer), nvrhi::CpuAccessMode::Read);
        if (!data)
            return 0;
        memcpy(dst, data, static_cast<size_t>(byteSize));
        device->unmapBuffer(AsBuffer(readbackBuffer));
        return 1;
    }

    // Binding set descriptions are built up with the Donut_Bind* functions below and then
    // consumed (freed) by Donut_CreateBindingSet.
    void* Donut_CreateBindingSetDesc()
    {
        return new nvrhi::BindingSetDesc();
    }

    // Buffer created by Donut_CreateUIntBuffer, read by the shader as Buffer<uint> at t<slot>.
    void Donut_BindTypedBufferSRV(void* bindingSetDesc, int slot, void* buffer)
    {
        static_cast<nvrhi::BindingSetDesc*>(bindingSetDesc)->addItem(
            nvrhi::BindingSetItem::TypedBuffer_SRV(static_cast<uint32_t>(slot), AsBuffer(buffer)));
    }

    // Writable buffer created by Donut_CreateUIntBuffer, written by the shader as RWBuffer<uint>
    // at u<slot>.
    void Donut_BindTypedBufferUAV(void* bindingSetDesc, int slot, void* buffer)
    {
        static_cast<nvrhi::BindingSetDesc*>(bindingSetDesc)->addItem(
            nvrhi::BindingSetItem::TypedBuffer_UAV(static_cast<uint32_t>(slot), AsBuffer(buffer)));
    }

    // Creates a binding set, and a matching layout (in register space 0) visible to the stages
    // in shaderType (nvrhi::ShaderType bits), from a description, which it frees. Returns null
    // on failure.
    void* Donut_CreateBindingSet(void* app, void* bindingSetDesc, int shaderType)
    {
        std::unique_ptr<nvrhi::BindingSetDesc> desc(static_cast<nvrhi::BindingSetDesc*>(bindingSetDesc));

        nvrhi::BindingLayoutHandle layout;
        nvrhi::BindingSetHandle bindingSet;
        App* a = AsApp(app);
        if (!nvrhi::utils::CreateBindingSetAndLayout(a->device(), static_cast<nvrhi::ShaderType>(shaderType),
                0, *desc, layout, bindingSet))
            return nullptr;

        // The binding set keeps its layout alive; pipelines get it from the set.
        return a->Own(bindingSet);
    }

    // Texture created by Donut_CreateUAVTextureForFrame, written by the shader as
    // RWTexture2D<float4> at u<slot>.
    void Donut_BindTextureUAV(void* bindingSetDesc, int slot, void* texture)
    {
        static_cast<nvrhi::BindingSetDesc*>(bindingSetDesc)->addItem(
            nvrhi::BindingSetItem::Texture_UAV(static_cast<uint32_t>(slot), static_cast<nvrhi::ITexture*>(texture)));
    }

    // Top-level acceleration structure, read by the shader as RaytracingAccelerationStructure
    // at t<slot>.
    void Donut_BindAccelStruct(void* bindingSetDesc, int slot, void* accelStruct)
    {
        static_cast<nvrhi::BindingSetDesc*>(bindingSetDesc)->addItem(
            nvrhi::BindingSetItem::RayTracingAccelStruct(static_cast<uint32_t>(slot),
                static_cast<nvrhi::rt::IAccelStruct*>(accelStruct)));
    }

    // Creates a binding set for an existing layout (see Donut_CreateBindingLayout) from a
    // description, which it frees. Returns null on failure.
    void* Donut_CreateBindingSetForLayout(void* app, void* bindingSetDesc, void* bindingLayout)
    {
        std::unique_ptr<nvrhi::BindingSetDesc> desc(static_cast<nvrhi::BindingSetDesc*>(bindingSetDesc));
        App* a = AsApp(app);
        return a->Own(a->device()->createBindingSet(*desc, static_cast<nvrhi::IBindingLayout*>(bindingLayout)));
    }

    // Binding layout descriptions, for when the layout is needed before the resources exist
    // (e.g. to create a pipeline); built up with the Donut_Layout* functions below, then
    // consumed (freed) by Donut_CreateBindingLayout.
    void* Donut_CreateBindingLayoutDesc()
    {
        return new nvrhi::BindingLayoutDesc();
    }

    void Donut_LayoutTextureUAV(void* bindingLayoutDesc, int slot)
    {
        static_cast<nvrhi::BindingLayoutDesc*>(bindingLayoutDesc)->addItem(
            nvrhi::BindingLayoutItem::Texture_UAV(static_cast<uint32_t>(slot)));
    }

    void Donut_LayoutAccelStruct(void* bindingLayoutDesc, int slot)
    {
        static_cast<nvrhi::BindingLayoutDesc*>(bindingLayoutDesc)->addItem(
            nvrhi::BindingLayoutItem::RayTracingAccelStruct(static_cast<uint32_t>(slot)));
    }

    void Donut_LayoutTextureSRV(void* bindingLayoutDesc, int slot)
    {
        static_cast<nvrhi::BindingLayoutDesc*>(bindingLayoutDesc)->addItem(
            nvrhi::BindingLayoutItem::Texture_SRV(static_cast<uint32_t>(slot)));
    }

    void Donut_LayoutStructuredBufferSRV(void* bindingLayoutDesc, int slot)
    {
        static_cast<nvrhi::BindingLayoutDesc*>(bindingLayoutDesc)->addItem(
            nvrhi::BindingLayoutItem::StructuredBuffer_SRV(static_cast<uint32_t>(slot)));
    }

    void Donut_LayoutSampler(void* bindingLayoutDesc, int slot)
    {
        static_cast<nvrhi::BindingLayoutDesc*>(bindingLayoutDesc)->addItem(
            nvrhi::BindingLayoutItem::Sampler(static_cast<uint32_t>(slot)));
    }

    // byteSize bytes of push constants (DECLARE_PUSH_CONSTANTS in HLSL) at b<slot>.
    void Donut_LayoutPushConstants(void* bindingLayoutDesc, int slot, int byteSize)
    {
        static_cast<nvrhi::BindingLayoutDesc*>(bindingLayoutDesc)->addItem(
            nvrhi::BindingLayoutItem::PushConstants(static_cast<uint32_t>(slot), static_cast<uint32_t>(byteSize)));
    }

    // For a buffer from Donut_CreateVolatileConstantBuffer.
    void Donut_LayoutVolatileConstantBuffer(void* bindingLayoutDesc, int slot)
    {
        static_cast<nvrhi::BindingLayoutDesc*>(bindingLayoutDesc)->addItem(
            nvrhi::BindingLayoutItem::VolatileConstantBuffer(static_cast<uint32_t>(slot)));
    }

    // Register space of the layout's items (D3D12 only; 0 by default).
    void Donut_SetBindingLayoutRegisterSpace(void* bindingLayoutDesc, int space)
    {
        static_cast<nvrhi::BindingLayoutDesc*>(bindingLayoutDesc)->registerSpace = static_cast<uint32_t>(space);
    }

    // Buffer<T> at t<slot>.
    void Donut_LayoutTypedBufferSRV(void* bindingLayoutDesc, int slot)
    {
        static_cast<nvrhi::BindingLayoutDesc*>(bindingLayoutDesc)->addItem(
            nvrhi::BindingLayoutItem::TypedBuffer_SRV(static_cast<uint32_t>(slot)));
    }

    // A non-volatile cbuffer at b<slot>.
    void Donut_LayoutConstantBuffer(void* bindingLayoutDesc, int slot)
    {
        static_cast<nvrhi::BindingLayoutDesc*>(bindingLayoutDesc)->addItem(
            nvrhi::BindingLayoutItem::ConstantBuffer(static_cast<uint32_t>(slot)));
    }

    // RWStructuredBuffer at u<slot>.
    void Donut_LayoutStructuredBufferUAV(void* bindingLayoutDesc, int slot)
    {
        static_cast<nvrhi::BindingLayoutDesc*>(bindingLayoutDesc)->addItem(
            nvrhi::BindingLayoutItem::StructuredBuffer_UAV(static_cast<uint32_t>(slot)));
    }

    // Layout visible to the stages in shaderType (nvrhi::ShaderType bits), in register space 0
    // unless set with Donut_SetBindingLayoutRegisterSpace. Returns null on failure.
    void* Donut_CreateBindingLayout(void* app, void* bindingLayoutDesc, int shaderType)
    {
        std::unique_ptr<nvrhi::BindingLayoutDesc> desc(static_cast<nvrhi::BindingLayoutDesc*>(bindingLayoutDesc));
        desc->visibility = static_cast<nvrhi::ShaderType>(shaderType);
        App* a = AsApp(app);
        return a->Own(a->device()->createBindingLayout(*desc));
    }

    // Compute pipeline with one binding layout (Donut_CreateBindingLayout). Returns null on failure.
    void* Donut_CreateComputePipelineWithLayout(void* app, void* computeShader, void* bindingLayout)
    {
        auto desc = nvrhi::ComputePipelineDesc()
            .setComputeShader(static_cast<nvrhi::IShader*>(computeShader))
            .addBindingLayout(static_cast<nvrhi::IBindingLayout*>(bindingLayout));

        App* a = AsApp(app);
        return a->Own(a->device()->createComputePipeline(desc));
    }

    // Same, with a second binding layout (e.g. a bindless layout; null for none).
    void* Donut_CreateComputePipelineWithLayouts(void* app, void* computeShader, void* bindingLayout, void* secondBindingLayout)
    {
        auto desc = nvrhi::ComputePipelineDesc()
            .setComputeShader(static_cast<nvrhi::IShader*>(computeShader))
            .addBindingLayout(static_cast<nvrhi::IBindingLayout*>(bindingLayout));
        if (secondBindingLayout)
            desc.addBindingLayout(static_cast<nvrhi::IBindingLayout*>(secondBindingLayout));

        App* a = AsApp(app);
        return a->Own(a->device()->createComputePipeline(desc));
    }

    // Compute pipeline using the layout of bindingSet. Returns null on failure.
    void* Donut_CreateComputePipeline(void* app, void* computeShader, void* bindingSet)
    {
        auto desc = nvrhi::ComputePipelineDesc()
            .setComputeShader(static_cast<nvrhi::IShader*>(computeShader))
            .addBindingLayout(static_cast<nvrhi::IBindingSet*>(bindingSet)->getLayout());

        App* a = AsApp(app);
        return a->Own(a->device()->createComputePipeline(desc));
    }

    // Constant buffer for cbuffers, written with Donut_WriteBuffer. Bind slices of it (offsets
    // and sizes in multiples of 256 bytes) with Donut_BindConstantBuffer. Returns null on failure.
    void* Donut_CreateConstantBuffer(void* app, int byteSize, const char* debugName)
    {
        auto desc = nvrhi::utils::CreateStaticConstantBufferDesc(static_cast<uint32_t>(byteSize), debugName)
            .setInitialState(nvrhi::ResourceStates::ConstantBuffer)
            .setKeepInitialState(true);

        App* a = AsApp(app);
        return a->Own(a->device()->createBuffer(desc));
    }

    // Constant buffer rewritten (with Donut_WriteBuffer) every time it's used, up to
    // c_MaxRenderPassConstantBufferVersions times per frame; bind it with
    // Donut_BindEntireConstantBuffer and Donut_LayoutVolatileConstantBuffer. Returns null on failure.
    void* Donut_CreateVolatileConstantBuffer(void* app, int byteSize, const char* debugName)
    {
        App* a = AsApp(app);
        return a->Own(a->device()->createBuffer(nvrhi::utils::CreateVolatileConstantBufferDesc(
            static_cast<uint32_t>(byteSize), debugName, donut::engine::c_MaxRenderPassConstantBufferVersions)));
    }

    // StructuredBuffer of `count` elements of `stride` bytes, for shaders to read (t registers),
    // filled with Donut_WriteBuffer. Returns null on failure.
    void* Donut_CreateStructuredBuffer(void* app, int stride, int count, const char* debugName)
    {
        auto desc = nvrhi::BufferDesc()
            .setByteSize(uint64_t(stride) * uint64_t(count))
            .setStructStride(static_cast<uint32_t>(stride))
            .setDebugName(debugName)
            .setInitialState(nvrhi::ResourceStates::ShaderResource)
            .setKeepInitialState(true);

        App* a = AsApp(app);
        return a->Own(a->device()->createBuffer(desc));
    }

    // Same, that shaders can also write (RWStructuredBuffer, u registers).
    void* Donut_CreateRWStructuredBuffer(void* app, int stride, int count, const char* debugName)
    {
        auto desc = nvrhi::BufferDesc()
            .setByteSize(uint64_t(stride) * uint64_t(count))
            .setStructStride(static_cast<uint32_t>(stride))
            .setCanHaveUAVs(true)
            .setDebugName(debugName)
            .setInitialState(nvrhi::ResourceStates::UnorderedAccess)
            .setKeepInitialState(true);

        App* a = AsApp(app);
        return a->Own(a->device()->createBuffer(desc));
    }

    // Stores an int's bits at dst (e.g. Ref of an f32 array element), for int / uint fields of
    // structures that TypeScript lays out as f32 arrays.
    void Donut_StoreInt32(void* dst, int value)
    {
        memcpy(dst, &value, sizeof(value));
    }

    // Vertex buffer with byteSize bytes of data (copied during the call), uploaded by an open
    // command list; the contents can't change afterwards. Returns null on failure.
    void* Donut_CreateStaticVertexBuffer(void* app, void* commandList, const void* data, int byteSize, const char* debugName)
    {
        return CreateStaticBuffer(AsApp(app), AsCommandList(commandList),
            nvrhi::BufferDesc().setIsVertexBuffer(true).setDebugName(debugName),
            nvrhi::ResourceStates::VertexBuffer, data, byteSize);
    }

    // Same, for an index buffer.
    void* Donut_CreateStaticIndexBuffer(void* app, void* commandList, const void* data, int byteSize, const char* debugName)
    {
        return CreateStaticBuffer(AsApp(app), AsCommandList(commandList),
            nvrhi::BufferDesc().setIsIndexBuffer(true).setDebugName(debugName),
            nvrhi::ResourceStates::IndexBuffer, data, byteSize);
    }

    // The first primitive of a glTF file's first mesh (path relative to the executable's
    // directory), as the Vulkan-Samples framework's load_model reads it: positions, normals and
    // texture coordinates interleaved, 32-bit indices, the nodes' transforms ignored. Uploaded by
    // an open command list. Returns null (after logging why) on failure.
    void* Donut_LoadGltfMesh(void* app, void* commandList, const char* path)
    {
        const std::filesystem::path fileName = GetExecutablePath().parent_path() / path;
        const std::string fileNameString = fileName.generic_string();
        donut::vfs::NativeFileSystem fs;
        const std::shared_ptr<donut::vfs::IBlob> blob = fs.readFile(fileName);
        if (!blob)
        {
            donut::log::error("Cannot read %s", fileNameString.c_str());
            return nullptr;
        }

        // The buffers can be files next to the glTF or data URIs.
        cgltf_options options{};
        cgltf_data* data = nullptr;
        cgltf_result result = cgltf_parse(&options, blob->data(), blob->size(), &data);
        if (result == cgltf_result_success)
            result = cgltf_load_buffers(&options, data, fileNameString.c_str());
        const cgltf_primitive* primitive = result == cgltf_result_success && data->meshes_count > 0
            && data->meshes[0].primitives_count > 0 ? &data->meshes[0].primitives[0] : nullptr;

        const cgltf_accessor* positions = nullptr;
        const cgltf_accessor* normals = nullptr;
        const cgltf_accessor* texCoords = nullptr;
        for (size_t i = 0; primitive && i < primitive->attributes_count; i++)
        {
            const cgltf_attribute& attribute = primitive->attributes[i];
            if (attribute.type == cgltf_attribute_type_position)
                positions = attribute.data;
            else if (attribute.type == cgltf_attribute_type_normal)
                normals = attribute.data;
            else if (attribute.type == cgltf_attribute_type_texcoord && attribute.index == 0)
                texCoords = attribute.data;
        }
        if (!positions || !primitive->indices)
        {
            donut::log::error("Cannot load an indexed mesh from %s", fileNameString.c_str());
            cgltf_free(data);
            return nullptr;
        }

        constexpr size_t vertexFloats = 8;
        std::vector<float> vertices(positions->count * vertexFloats, 0.f);
        for (size_t v = 0; v < positions->count; v++)
        {
            float* vertex = &vertices[v * vertexFloats];
            cgltf_accessor_read_float(positions, v, vertex, 3);
            if (normals)
                cgltf_accessor_read_float(normals, v, vertex + 3, 3);
            if (texCoords)
                cgltf_accessor_read_float(texCoords, v, vertex + 6, 2);
        }
        std::vector<uint32_t> indices(primitive->indices->count);
        for (size_t i = 0; i < indices.size(); i++)
            indices[i] = static_cast<uint32_t>(cgltf_accessor_read_index(primitive->indices, i));
        cgltf_free(data);

        App* a = AsApp(app);
        auto mesh = std::make_shared<GltfMesh>();
        mesh->vertexBuffer = AsBuffer(CreateStaticBuffer(a, AsCommandList(commandList),
            nvrhi::BufferDesc().setIsVertexBuffer(true).setDebugName(fileNameString + " vertices"),
            nvrhi::ResourceStates::VertexBuffer, vertices.data(), static_cast<int>(vertices.size() * sizeof(float))));
        mesh->indexBuffer = AsBuffer(CreateStaticBuffer(a, AsCommandList(commandList),
            nvrhi::BufferDesc().setIsIndexBuffer(true).setDebugName(fileNameString + " indices"),
            nvrhi::ResourceStates::IndexBuffer, indices.data(), static_cast<int>(indices.size() * sizeof(uint32_t))));
        mesh->indexCount = static_cast<int>(indices.size());
        if (!mesh->vertexBuffer || !mesh->indexBuffer)
        {
            donut::log::error("Cannot create the buffers of %s", fileNameString.c_str());
            return nullptr;
        }
        return a->OwnObject(mesh);
    }

    // Valid as long as the mesh.
    void* Donut_GetGltfMeshVertexBuffer(void* gltfMesh)
    {
        return static_cast<GltfMesh*>(gltfMesh)->vertexBuffer.Get();
    }

    void* Donut_GetGltfMeshIndexBuffer(void* gltfMesh)
    {
        return static_cast<GltfMesh*>(gltfMesh)->indexBuffer.Get();
    }

    int Donut_GetGltfMeshIndexCount(void* gltfMesh)
    {
        return static_cast<GltfMesh*>(gltfMesh)->indexCount;
    }

    // Input layout descriptions are built up with Donut_AddVertexAttribute and then consumed
    // (freed) by Donut_CreateInputLayout.
    void* Donut_CreateInputLayoutDesc()
    {
        return new std::vector<nvrhi::VertexAttributeDesc>();
    }

    // A vertex shader input with semantic `name`, read from vertex buffer slot bufferIndex at
    // byte offset `offset` of each elementStride-byte element. format is an nvrhi::Format value.
    void Donut_AddVertexAttribute(void* inputLayoutDesc, const char* name, int format, int offset, int bufferIndex, int elementStride)
    {
        static_cast<std::vector<nvrhi::VertexAttributeDesc>*>(inputLayoutDesc)->push_back(nvrhi::VertexAttributeDesc()
            .setName(name)
            .setFormat(static_cast<nvrhi::Format>(format))
            .setOffset(static_cast<uint32_t>(offset))
            .setBufferIndex(static_cast<uint32_t>(bufferIndex))
            .setElementStride(static_cast<uint32_t>(elementStride)));
    }

    // Same, read once per instance instead of once per vertex.
    void Donut_AddInstanceVertexAttribute(void* inputLayoutDesc, const char* name, int format, int offset, int bufferIndex, int elementStride)
    {
        static_cast<std::vector<nvrhi::VertexAttributeDesc>*>(inputLayoutDesc)->push_back(nvrhi::VertexAttributeDesc()
            .setName(name)
            .setFormat(static_cast<nvrhi::Format>(format))
            .setOffset(static_cast<uint32_t>(offset))
            .setBufferIndex(static_cast<uint32_t>(bufferIndex))
            .setElementStride(static_cast<uint32_t>(elementStride))
            .setIsInstanced(true));
    }

    // Returns null on failure.
    void* Donut_CreateInputLayout(void* app, void* inputLayoutDesc, void* vertexShader)
    {
        std::unique_ptr<std::vector<nvrhi::VertexAttributeDesc>> attributes(
            static_cast<std::vector<nvrhi::VertexAttributeDesc>*>(inputLayoutDesc));
        App* a = AsApp(app);
        return a->Own(a->device()->createInputLayout(attributes->data(), static_cast<uint32_t>(attributes->size()),
            static_cast<nvrhi::IShader*>(vertexShader)));
    }

    // Loads an image file (path relative to the executable's directory) and records its upload
    // into an open command list; sRGB != 0 treats the data as sRGB. Returns null (after logging
    // why) if the file can't be loaded.
    void* Donut_LoadTexture(void* app, void* commandList, const char* path, int sRGB)
    {
        App* a = AsApp(app);
        donut::engine::TextureLoadOptions options;
        options.sRGBMode = donut::engine::SRGBModeFromBool(sRGB != 0);

        std::shared_ptr<donut::engine::LoadedTexture> texture = a->textureCache()->LoadTextureFromFile(
            GetExecutablePath().parent_path() / path, options, nullptr, AsCommandList(commandList));
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

    void* Donut_GetCommonSampler(void* app, int which)
    {
        App* a = AsApp(app);
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

    // cbuffer at b<slot>: byteSize bytes of a constant buffer starting at byteOffset (both
    // multiples of 256).
    void Donut_BindConstantBuffer(void* bindingSetDesc, int slot, void* constantBuffer, int byteOffset, int byteSize)
    {
        static_cast<nvrhi::BindingSetDesc*>(bindingSetDesc)->addItem(nvrhi::BindingSetItem::ConstantBuffer(
            static_cast<uint32_t>(slot), AsBuffer(constantBuffer),
            nvrhi::BufferRange(static_cast<uint64_t>(byteOffset), static_cast<uint64_t>(byteSize))));
    }

    // StructuredBuffer at t<slot> (e.g. from Donut_GetSceneBuffer).
    void Donut_BindStructuredBufferSRV(void* bindingSetDesc, int slot, void* buffer)
    {
        static_cast<nvrhi::BindingSetDesc*>(bindingSetDesc)->addItem(
            nvrhi::BindingSetItem::StructuredBuffer_SRV(static_cast<uint32_t>(slot), AsBuffer(buffer)));
    }

    // A buffer from Donut_CreateRWStructuredBuffer, as RWStructuredBuffer at u<slot>.
    void Donut_BindStructuredBufferUAV(void* bindingSetDesc, int slot, void* buffer)
    {
        static_cast<nvrhi::BindingSetDesc*>(bindingSetDesc)->addItem(
            nvrhi::BindingSetItem::StructuredBuffer_UAV(static_cast<uint32_t>(slot), AsBuffer(buffer)));
    }

    // The push constants of a Donut_LayoutPushConstants item: byteSize bytes at b<slot>, whose
    // values are given when dispatching or drawing (Donut_DispatchWithPushConstants,
    // Donut_DrawIndexedWithPushConstants).
    void Donut_BindPushConstants(void* bindingSetDesc, int slot, int byteSize)
    {
        static_cast<nvrhi::BindingSetDesc*>(bindingSetDesc)->addItem(
            nvrhi::BindingSetItem::PushConstants(static_cast<uint32_t>(slot), static_cast<uint32_t>(byteSize)));
    }

    // cbuffer at b<slot>: the whole of a constant buffer (required for volatile ones).
    void Donut_BindEntireConstantBuffer(void* bindingSetDesc, int slot, void* constantBuffer)
    {
        static_cast<nvrhi::BindingSetDesc*>(bindingSetDesc)->addItem(
            nvrhi::BindingSetItem::ConstantBuffer(static_cast<uint32_t>(slot), AsBuffer(constantBuffer)));
    }

    // Texture2D at t<slot>.
    void Donut_BindTextureSRV(void* bindingSetDesc, int slot, void* texture)
    {
        static_cast<nvrhi::BindingSetDesc*>(bindingSetDesc)->addItem(
            nvrhi::BindingSetItem::Texture_SRV(static_cast<uint32_t>(slot), static_cast<nvrhi::ITexture*>(texture)));
    }

    // SamplerState at s<slot>.
    void Donut_BindSampler(void* bindingSetDesc, int slot, void* sampler)
    {
        static_cast<nvrhi::BindingSetDesc*>(bindingSetDesc)->addItem(
            nvrhi::BindingSetItem::Sampler(static_cast<uint32_t>(slot), static_cast<nvrhi::ISampler*>(sampler)));
    }

    // The layout a binding set was created with; valid as long as the binding set. Use it for
    // more binding sets (Donut_CreateBindingSetForLayout) and pipelines.
    void* Donut_GetBindingLayout(void* bindingSet)
    {
        return static_cast<nvrhi::IBindingSet*>(bindingSet)->getLayout();
    }

    // Triangle list, no depth test, for the frame's framebuffer layout, with an input layout
    // and one binding layout. Returns null on failure.
    void* Donut_CreateGraphicsPipelineWithLayouts(void* app, void* frame, void* vertexShader, void* pixelShader,
        void* inputLayout, void* bindingLayout)
    {
        nvrhi::GraphicsPipelineDesc desc;
        desc.VS = static_cast<nvrhi::IShader*>(vertexShader);
        desc.PS = static_cast<nvrhi::IShader*>(pixelShader);
        desc.inputLayout = static_cast<nvrhi::IInputLayout*>(inputLayout);
        desc.bindingLayouts = { static_cast<nvrhi::IBindingLayout*>(bindingLayout) };
        desc.primType = nvrhi::PrimitiveType::TriangleList;
        desc.renderState.depthStencilState.depthTestEnable = false;

        App* a = AsApp(app);
        return a->Own(a->device()->createGraphicsPipeline(desc, AsFrame(frame)->framebuffer->getFramebufferInfo()));
    }

    // Pipeline without depth test for the frame's framebuffer layout, drawing primitiveType (an
    // nvrhi::PrimitiveType value), with an optional input layout and an optional binding layout
    // (null for either means none). Returns null on failure.
    void* Donut_CreateGraphicsPipelineWithTopology(void* app, void* frame, void* vertexShader, void* pixelShader,
        void* inputLayout, void* bindingLayout, int primitiveType)
    {
        nvrhi::GraphicsPipelineDesc desc;
        desc.VS = static_cast<nvrhi::IShader*>(vertexShader);
        desc.PS = static_cast<nvrhi::IShader*>(pixelShader);
        desc.inputLayout = static_cast<nvrhi::IInputLayout*>(inputLayout);
        if (bindingLayout)
            desc.bindingLayouts = { static_cast<nvrhi::IBindingLayout*>(bindingLayout) };
        desc.primType = static_cast<nvrhi::PrimitiveType>(primitiveType);
        desc.renderState.depthStencilState.depthTestEnable = false;

        App* a = AsApp(app);
        return a->Own(a->device()->createGraphicsPipeline(desc, AsFrame(frame)->framebuffer->getFramebufferInfo()));
    }

    // Same, blending into the framebuffer with blendMode (a BlendMode value): 1 is additive (color
    // One + One, alpha SrcAlpha + DstAlpha), 0 none. Returns null on failure.
    void* Donut_CreateGraphicsPipelineWithBlend(void* app, void* frame, void* vertexShader, void* pixelShader,
        void* inputLayout, void* bindingLayout, int primitiveType, int blendMode)
    {
        nvrhi::GraphicsPipelineDesc desc;
        desc.VS = static_cast<nvrhi::IShader*>(vertexShader);
        desc.PS = static_cast<nvrhi::IShader*>(pixelShader);
        desc.inputLayout = static_cast<nvrhi::IInputLayout*>(inputLayout);
        if (bindingLayout)
            desc.bindingLayouts = { static_cast<nvrhi::IBindingLayout*>(bindingLayout) };
        desc.primType = static_cast<nvrhi::PrimitiveType>(primitiveType);
        desc.renderState.depthStencilState.depthTestEnable = false;
        if (blendMode == 1)
        {
            desc.renderState.blendState.targets[0]
                .enableBlend()
                .setSrcBlend(nvrhi::BlendFactor::One)
                .setDestBlend(nvrhi::BlendFactor::One)
                .setBlendOp(nvrhi::BlendOp::Add)
                .setSrcBlendAlpha(nvrhi::BlendFactor::SrcAlpha)
                .setDestBlendAlpha(nvrhi::BlendFactor::DstAlpha)
                .setBlendOpAlpha(nvrhi::BlendOp::Add);
        }

        App* a = AsApp(app);
        return a->Own(a->device()->createGraphicsPipeline(desc, AsFrame(frame)->framebuffer->getFramebufferInfo()));
    }

    // RGBA8_UNORM texture of width x height that compute shaders write as RWTexture2D<float4> and
    // pixel shaders read; NVRHI tracks its state, which rests at NonPixelShaderResource. Returns
    // null on failure.
    void* Donut_CreateUAVTexture(void* app, int width, int height, const char* debugName)
    {
        auto desc = nvrhi::TextureDesc()
            .setFormat(nvrhi::Format::RGBA8_UNORM)
            .setWidth(static_cast<uint32_t>(width))
            .setHeight(static_cast<uint32_t>(height))
            .setIsUAV(true)
            .setDebugName(debugName)
            .enableAutomaticStateTracking(nvrhi::ResourceStates::NonPixelShaderResource);

        App* a = AsApp(app);
        return a->Own(a->device()->createTexture(desc));
    }

    // Render target (for Donut_CreateFramebuffer) of width x height in `format` (an nvrhi::Format
    // value) that shaders can also read; resting at ShaderResource. A depth format makes a depth
    // buffer, cleared to 1 by default, whose shader view reads the depth. Returns null on failure.
    void* Donut_CreateRenderTargetTexture(void* app, int width, int height, int format, const char* debugName)
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

        App* a = AsApp(app);
        return a->Own(a->device()->createTexture(desc));
    }

    // Framebuffer of one color target and an optional depth target (null for none), textures from
    // Donut_CreateRenderTargetTexture. Draw into it with Donut_BeginDrawToFramebuffer. Returns null
    // on failure.
    void* Donut_CreateFramebuffer(void* app, void* colorTexture, void* depthTexture)
    {
        auto desc = nvrhi::FramebufferDesc().addColorAttachment(static_cast<nvrhi::ITexture*>(colorTexture));
        if (depthTexture)
            desc.setDepthAttachment(static_cast<nvrhi::ITexture*>(depthTexture));

        App* a = AsApp(app);
        return a->Own(a->device()->createFramebuffer(desc));
    }

    // Triangle-list pipeline for a framebuffer's layout (Donut_CreateFramebuffer), with an input
    // layout and one binding layout, and NVRHI's default render state: depth test (less) and
    // depth writes on, back faces culled (clockwise triangles are front faces). Returns null on
    // failure.
    void* Donut_CreateGraphicsPipelineForFramebuffer(void* app, void* framebuffer, void* vertexShader, void* pixelShader,
        void* inputLayout, void* bindingLayout)
    {
        nvrhi::GraphicsPipelineDesc desc;
        desc.VS = static_cast<nvrhi::IShader*>(vertexShader);
        desc.PS = static_cast<nvrhi::IShader*>(pixelShader);
        desc.inputLayout = static_cast<nvrhi::IInputLayout*>(inputLayout);
        desc.bindingLayouts = { static_cast<nvrhi::IBindingLayout*>(bindingLayout) };
        desc.primType = nvrhi::PrimitiveType::TriangleList;

        App* a = AsApp(app);
        return a->Own(a->device()->createGraphicsPipeline(desc,
            static_cast<nvrhi::IFramebuffer*>(framebuffer)->getFramebufferInfo()));
    }

    // Graphics pipelines of any shape: a description built up with the Donut_GraphicsPipeline*
    // functions below, then consumed (freed) by Donut_CreateGraphicsPipelineFromDesc. It starts as
    // a triangle list with NVRHI's default render state: depth test (less) and depth writes on,
    // back faces culled (clockwise triangles are front faces), solid fill, no blending.
    void* Donut_CreateGraphicsPipelineDesc(void* vertexShader, void* pixelShader)
    {
        auto* desc = new nvrhi::GraphicsPipelineDesc();
        desc->VS = static_cast<nvrhi::IShader*>(vertexShader);
        desc->PS = static_cast<nvrhi::IShader*>(pixelShader);
        desc->primType = nvrhi::PrimitiveType::TriangleList;
        return desc;
    }

    static nvrhi::GraphicsPipelineDesc* AsGraphicsPipelineDesc(void* graphicsPipelineDesc)
    {
        return static_cast<nvrhi::GraphicsPipelineDesc*>(graphicsPipelineDesc);
    }

    void Donut_GraphicsPipelineAddBindingLayout(void* graphicsPipelineDesc, void* bindingLayout)
    {
        AsGraphicsPipelineDesc(graphicsPipelineDesc)->bindingLayouts.push_back(
            static_cast<nvrhi::IBindingLayout*>(bindingLayout));
    }

    void Donut_GraphicsPipelineSetInputLayout(void* graphicsPipelineDesc, void* inputLayout)
    {
        AsGraphicsPipelineDesc(graphicsPipelineDesc)->inputLayout = static_cast<nvrhi::IInputLayout*>(inputLayout);
    }

    // primitiveType: an nvrhi::PrimitiveType value.
    void Donut_GraphicsPipelineSetPrimitiveType(void* graphicsPipelineDesc, int primitiveType)
    {
        AsGraphicsPipelineDesc(graphicsPipelineDesc)->primType = static_cast<nvrhi::PrimitiveType>(primitiveType);
    }

    // Hull and domain shaders, drawing patches of controlPoints vertices.
    void Donut_GraphicsPipelineSetTessellation(void* graphicsPipelineDesc, void* hullShader, void* domainShader,
        int controlPoints)
    {
        nvrhi::GraphicsPipelineDesc* desc = AsGraphicsPipelineDesc(graphicsPipelineDesc);
        desc->HS = static_cast<nvrhi::IShader*>(hullShader);
        desc->DS = static_cast<nvrhi::IShader*>(domainShader);
        desc->primType = nvrhi::PrimitiveType::PatchList;
        desc->patchControlPoints = static_cast<uint32_t>(controlPoints);
    }

    static_assert(int(nvrhi::ComparisonFunc::Never) == 1 && int(nvrhi::ComparisonFunc::Greater) == 5
        && int(nvrhi::ComparisonFunc::Always) == 8);

    // depthFunc: an nvrhi::ComparisonFunc value.
    void Donut_GraphicsPipelineSetDepthState(void* graphicsPipelineDesc, int testEnable, int writeEnable, int depthFunc)
    {
        nvrhi::DepthStencilState& state = AsGraphicsPipelineDesc(graphicsPipelineDesc)->renderState.depthStencilState;
        state.depthTestEnable = testEnable != 0;
        state.depthWriteEnable = writeEnable != 0;
        state.depthFunc = static_cast<nvrhi::ComparisonFunc>(depthFunc);
    }

    static_assert(int(nvrhi::RasterCullMode::Back) == 0 && int(nvrhi::RasterCullMode::Front) == 1
        && int(nvrhi::RasterCullMode::None) == 2);
    static_assert(int(nvrhi::RasterFillMode::Solid) == 0 && int(nvrhi::RasterFillMode::Wireframe) == 1);

    // cullMode, fillMode: nvrhi::RasterCullMode and nvrhi::RasterFillMode values.
    void Donut_GraphicsPipelineSetRasterState(void* graphicsPipelineDesc, int cullMode, int fillMode,
        int frontCounterClockwise)
    {
        nvrhi::RasterState& state = AsGraphicsPipelineDesc(graphicsPipelineDesc)->renderState.rasterState;
        state.cullMode = static_cast<nvrhi::RasterCullMode>(cullMode);
        state.fillMode = static_cast<nvrhi::RasterFillMode>(fillMode);
        state.frontCounterClockwise = frontCounterClockwise != 0;
    }

    // For a framebuffer's layout (Donut_CreateFramebuffer); frees the description. Returns null on
    // failure.
    void* Donut_CreateGraphicsPipelineFromDesc(void* app, void* graphicsPipelineDesc, void* framebuffer)
    {
        std::unique_ptr<nvrhi::GraphicsPipelineDesc> desc(AsGraphicsPipelineDesc(graphicsPipelineDesc));
        App* a = AsApp(app);
        return a->Own(a->device()->createGraphicsPipeline(*desc,
            static_cast<nvrhi::IFramebuffer*>(framebuffer)->getFramebufferInfo()));
    }

    // A binding set for a description (which it frees) from the app's binding cache: created on
    // the first request, reused for identical ones after. Valid until Donut_ClearBindingCache.
    void* Donut_GetCachedBindingSet(void* app, void* bindingSetDesc, void* bindingLayout)
    {
        std::unique_ptr<nvrhi::BindingSetDesc> desc(static_cast<nvrhi::BindingSetDesc*>(bindingSetDesc));
        return AsApp(app)->bindingCache()->GetOrCreateBindingSet(*desc, static_cast<nvrhi::IBindingLayout*>(bindingLayout)).Get();
    }

    // --- Async compute -----------------------------------------------------------------------

    // A loop that, every intervalMicroseconds, dispatches groupsX x groupsY groups of a compute
    // pipeline on the compute queue (the app needs AppOptions.ComputeQueue), on a C++ worker thread.
    // Each run writes one texture, bound as RWTexture2D at u0, with the run's index (a uint,
    // counting from 0) as push constants at b0; the binding layout must hold exactly those two.
    // Give it textures with Donut_AddAsyncComputeTexture, then start it. Returns null if the
    // device has no compute queue.
    void* Donut_CreateAsyncComputeLoop(void* app, void* computePipeline, void* bindingLayout,
        int groupsX, int groupsY, int intervalMicroseconds)
    {
        App* a = AsApp(app);
        nvrhi::IDevice* device = a->device();
        if (!device->queryFeatureSupport(nvrhi::Feature::ComputeQueue))
            return nullptr;

        auto loop = std::make_shared<AsyncComputeLoop>();
        loop->device = device;
        loop->pipeline = static_cast<nvrhi::IComputePipeline*>(computePipeline);
        loop->bindingLayout = static_cast<nvrhi::IBindingLayout*>(bindingLayout);
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
    void Donut_AddAsyncComputeTexture(void* asyncComputeLoop, void* texture)
    {
        static_cast<AsyncComputeLoop*>(asyncComputeLoop)->renderToCompute.Push(static_cast<nvrhi::ITexture*>(texture), 0);
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
    void* Donut_AcquireAsyncComputeTexture(void* asyncComputeLoop, void* frame)
    {
        auto* loop = static_cast<AsyncComputeLoop*>(asyncComputeLoop);

        nvrhi::TextureHandle newTexture;
        uint64_t newTextureLastUse = 0;
        if (loop->computeToRender.TryPop(newTexture, newTextureLastUse))
        {
            loop->current.Swap(newTexture);
            // The previous frame was the last to use the texture shown until now.
            if (newTexture)
                loop->renderToCompute.Push(std::move(newTexture), AsFrame(frame)->previousSubmission);

            loop->device->queueWaitForCommandList(nvrhi::CommandQueue::Graphics, nvrhi::CommandQueue::Compute, newTextureLastUse);
        }

        return loop->current.Get();
    }

    // --- Command lists (for work outside render passes, e.g. in a headless app) --------------

    void* Donut_CreateCommandList(void* app)
    {
        App* a = AsApp(app);
        return a->Own(a->device()->createCommandList());
    }

    void Donut_OpenCommandList(void* commandList)
    {
        AsCommandList(commandList)->open();
    }

    void Donut_CloseCommandList(void* commandList)
    {
        AsCommandList(commandList)->close();
    }

    void Donut_ExecuteCommandList(void* app, void* commandList)
    {
        AsApp(app)->device()->executeCommandList(AsCommandList(commandList));
    }

    // Blocks the CPU until the GPU has finished all submitted work.
    void Donut_WaitForIdle(void* app)
    {
        AsApp(app)->device()->waitForIdle();
    }

    // Uploads byteSize bytes from data (copied during the call) into buffer.
    void Donut_WriteBuffer(void* commandList, void* buffer, const void* data, int byteSize)
    {
        AsCommandList(commandList)->writeBuffer(AsBuffer(buffer), data, static_cast<size_t>(byteSize));
    }

    void Donut_CopyBuffer(void* commandList, void* dst, int dstOffset, void* src, int srcOffset, int byteSize)
    {
        AsCommandList(commandList)->copyBuffer(AsBuffer(dst), static_cast<uint64_t>(dstOffset),
            AsBuffer(src), static_cast<uint64_t>(srcOffset), static_cast<uint64_t>(byteSize));
    }

    // Same as Donut_Dispatch, with a descriptor table (Donut_GetDescriptorTable) bound after the
    // binding set, for pipelines with a bindless layout second.
    void Donut_DispatchWithDescriptorTable(void* commandList, void* computePipeline, void* bindingSet, void* descriptorTable,
        int groupsX, int groupsY, int groupsZ)
    {
        auto state = nvrhi::ComputeState()
            .setPipeline(static_cast<nvrhi::IComputePipeline*>(computePipeline))
            .addBindingSet(static_cast<nvrhi::IBindingSet*>(bindingSet))
            .addBindingSet(static_cast<nvrhi::IDescriptorTable*>(descriptorTable));

        nvrhi::ICommandList* cl = AsCommandList(commandList);
        cl->setComputeState(state);
        cl->dispatch(static_cast<uint32_t>(groupsX), static_cast<uint32_t>(groupsY), static_cast<uint32_t>(groupsZ));
    }

    void Donut_Dispatch(void* commandList, void* computePipeline, void* bindingSet, int groupsX, int groupsY, int groupsZ)
    {
        auto state = nvrhi::ComputeState()
            .setPipeline(static_cast<nvrhi::IComputePipeline*>(computePipeline))
            .addBindingSet(static_cast<nvrhi::IBindingSet*>(bindingSet));

        nvrhi::ICommandList* cl = AsCommandList(commandList);
        cl->setComputeState(state);
        cl->dispatch(static_cast<uint32_t>(groupsX), static_cast<uint32_t>(groupsY), static_cast<uint32_t>(groupsZ));
    }

    // Same, with byteSize bytes of push constants from data (the binding set's
    // Donut_BindPushConstants item).
    void Donut_DispatchWithPushConstants(void* commandList, void* computePipeline, void* bindingSet,
        const void* data, int byteSize, int groupsX, int groupsY, int groupsZ)
    {
        auto state = nvrhi::ComputeState()
            .setPipeline(static_cast<nvrhi::IComputePipeline*>(computePipeline))
            .addBindingSet(static_cast<nvrhi::IBindingSet*>(bindingSet));

        nvrhi::ICommandList* cl = AsCommandList(commandList);
        cl->setComputeState(state);
        cl->setPushConstants(data, static_cast<size_t>(byteSize));
        cl->dispatch(static_cast<uint32_t>(groupsX), static_cast<uint32_t>(groupsY), static_cast<uint32_t>(groupsZ));
    }

    // Fills a depth texture (Donut_CreateRenderTargetTexture) with `depth`.
    void Donut_ClearDepth(void* commandList, void* depthTexture, double depth)
    {
        AsCommandList(commandList)->clearDepthStencilTexture(static_cast<nvrhi::ITexture*>(depthTexture),
            nvrhi::AllSubresources, true, float(depth), false, 0);
    }

    // Names the commands recorded until the matching Donut_EndMarker, for GPU debuggers and profilers.
    void Donut_BeginMarker(void* commandList, const char* name)
    {
        AsCommandList(commandList)->beginMarker(name);
    }

    void Donut_EndMarker(void* commandList)
    {
        AsCommandList(commandList)->endMarker();
    }

    // --- GPU timer queries ---------------------------------------------------------------------

    // Measures the GPU time between Donut_BeginTimerQuery and Donut_EndTimerQuery. Returns null on
    // failure.
    void* Donut_CreateTimerQuery(void* app)
    {
        App* a = AsApp(app);
        return a->Own(a->device()->createTimerQuery());
    }

    // Makes a query that has been read (or never used) ready to measure again.
    void Donut_ResetTimerQuery(void* app, void* timerQuery)
    {
        AsApp(app)->device()->resetTimerQuery(static_cast<nvrhi::ITimerQuery*>(timerQuery));
    }

    void Donut_BeginTimerQuery(void* commandList, void* timerQuery)
    {
        AsCommandList(commandList)->beginTimerQuery(static_cast<nvrhi::ITimerQuery*>(timerQuery));
    }

    void Donut_EndTimerQuery(void* commandList, void* timerQuery)
    {
        AsCommandList(commandList)->endTimerQuery(static_cast<nvrhi::ITimerQuery*>(timerQuery));
    }

    // Non-zero once the GPU has finished the measured commands.
    int Donut_PollTimerQuery(void* app, void* timerQuery)
    {
        return AsApp(app)->device()->pollTimerQuery(static_cast<nvrhi::ITimerQuery*>(timerQuery)) ? 1 : 0;
    }

    // The measured time in seconds; waits for the GPU unless Donut_PollTimerQuery returned non-zero.
    double Donut_GetTimerQueryTime(void* app, void* timerQuery)
    {
        return AsApp(app)->device()->getTimerQueryTime(static_cast<nvrhi::ITimerQuery*>(timerQuery));
    }

    // --- Render passes -----------------------------------------------------------------------

    // Adds a pass drawn after the previously added ones. The app owns it; set its callbacks
    // with the functions below.
    void* Donut_AddPass(void* app)
    {
        App* a = AsApp(app);
        a->passes.push_back(std::make_unique<TsRenderPass>(a->deviceManager.get()));
        TsRenderPass* pass = a->passes.back().get();
        a->deviceManager->AddRenderPassToBack(pass);
        return pass;
    }

    // By default (as in Donut) animation and rendering pause while the window is unfocused.
    void Donut_SetRunWhenUnfocused(void* pass, int enabled)
    {
        AsPass(pass)->m_RunWhenUnfocused = enabled != 0;
    }

    void Donut_SetRenderCallback(void* pass, RenderFn method, void* thisVal)
    {
        AsPass(pass)->m_Render = { method, thisVal };
    }

    void Donut_SetAnimateCallback(void* pass, AnimateFn method, void* thisVal)
    {
        AsPass(pass)->m_Animate = { method, thisVal };
    }

    // Called before the swap chain is resized; release framebuffer-dependent resources here.
    void Donut_SetBackBufferResizingCallback(void* pass, VoidFn method, void* thisVal)
    {
        AsPass(pass)->m_BackBufferResizing = { method, thisVal };
    }

    // Keys go to the most recently added pass first; the callback returns non-zero if it
    // handled the key, and then passes added before it don't see it.
    void Donut_SetKeyboardCallback(void* pass, KeyboardFn method, void* thisVal)
    {
        AsPass(pass)->m_Keyboard = { method, thisVal };
    }

    // Mouse position in window pixels; same return convention as the keyboard callback.
    void Donut_SetMousePosCallback(void* pass, MousePosFn method, void* thisVal)
    {
        AsPass(pass)->m_MousePos = { method, thisVal };
    }

    // GLFW mouse button and action values; same return convention as the keyboard callback.
    void Donut_SetMouseButtonCallback(void* pass, MouseButtonFn method, void* thisVal)
    {
        AsPass(pass)->m_MouseButton = { method, thisVal };
    }

    // Scroll offsets; same return convention as the keyboard callback.
    void Donut_SetMouseScrollCallback(void* pass, MouseScrollFn method, void* thisVal)
    {
        AsPass(pass)->m_MouseScroll = { method, thisVal };
    }

    // --- ImGui --------------------------------------------------------------------------------

    // Adds Donut's ImGui renderer as a pass drawn after the previously added ones (on top), which
    // sees input before them; buildUI is called every frame to build the UI with the Donut_ImGui*
    // functions below. Returns null if the renderer can't be initialized.
    void* Donut_AddImGuiPass(void* app, VoidFn buildUI, void* thisVal)
    {
        App* a = AsApp(app);
        auto pass = std::make_unique<TsImGuiPass>(a->deviceManager.get());
        if (!pass->Init(a->shaderFactory))
            return nullptr;
        pass->m_BuildUI = { buildUI, thisVal };

        TsImGuiPass* raw = pass.get();
        a->otherPasses.push_back(std::move(pass));
        a->deviceManager->AddRenderPassToBack(raw);
        return raw;
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

    // A value edited by dragging (speed per pixel), clamped to min .. max; returns the new value.
    double Donut_ImGuiDragFloat(const char* label, double value, double speed, double min, double max)
    {
        float v = float(value);
        ImGui::DragFloat(label, &v, float(speed), float(min), float(max));
        return v;
    }

    // Returns non-zero while the header is expanded (show its contents then).
    int Donut_ImGuiCollapsingHeader(const char* label)
    {
        return ImGui::CollapsingHeader(label) ? 1 : 0;
    }

    // The next item goes on the same line as the previous one.
    void Donut_ImGuiSameLine()
    {
        ImGui::SameLine();
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

    void Donut_ReleaseObject(void* app, void* object)
    {
        AsApp(app)->objects.erase(object);
    }

    // Loads a scene (glTF or Donut's .scene.json; path relative to the executable's directory,
    // or absolute) on the app's thread pool, then finishes uploading its textures. Returns null
    // (after logging why) on failure.
    void* Donut_LoadScene(void* app, const char* path)
    {
        App* a = AsApp(app);
        return LoadScene(a, path, a->textureCache(), nullptr);
    }

    // Bindless ray tracing: a bindless layout (register spaces added with the two functions
    // below), consumed (freed) by Donut_CreateBindlessLayout.
    void* Donut_CreateBindlessLayoutDesc(int firstSlot, int maxCapacity, int shaderType)
    {
        auto* desc = new nvrhi::BindlessLayoutDesc();
        desc->visibility = static_cast<nvrhi::ShaderType>(shaderType);
        desc->firstSlot = static_cast<uint32_t>(firstSlot);
        desc->maxCapacity = static_cast<uint32_t>(maxCapacity);
        return desc;
    }

    // ByteAddressBuffer[] in register space `space`.
    void Donut_BindlessLayoutAddRawBuffers(void* bindlessLayoutDesc, int space)
    {
        static_cast<nvrhi::BindlessLayoutDesc*>(bindlessLayoutDesc)->registerSpaces.push_back(
            nvrhi::BindingLayoutItem::RawBuffer_SRV(static_cast<uint32_t>(space)));
    }

    // Texture2D[] in register space `space`.
    void Donut_BindlessLayoutAddTextures(void* bindlessLayoutDesc, int space)
    {
        static_cast<nvrhi::BindlessLayoutDesc*>(bindlessLayoutDesc)->registerSpaces.push_back(
            nvrhi::BindingLayoutItem::Texture_SRV(static_cast<uint32_t>(space)));
    }

    // Returns null on failure.
    void* Donut_CreateBindlessLayout(void* app, void* bindlessLayoutDesc)
    {
        std::unique_ptr<nvrhi::BindlessLayoutDesc> desc(static_cast<nvrhi::BindlessLayoutDesc*>(bindlessLayoutDesc));
        App* a = AsApp(app);
        return a->Own(a->device()->createBindlessLayout(*desc));
    }

    // Donut's DescriptorTableManager: a descriptor table of a bindless layout that scenes loaded
    // with Donut_LoadSceneWithDescriptorTable put their buffers and textures in.
    void* Donut_CreateDescriptorTableManager(void* app, void* bindlessLayout)
    {
        App* a = AsApp(app);
        return a->OwnObject(std::make_shared<donut::engine::DescriptorTableManager>(
            a->device(), static_cast<nvrhi::IBindingLayout*>(bindlessLayout)));
    }

    // The table itself, to bind next to a binding set; valid as long as the manager.
    void* Donut_GetDescriptorTable(void* descriptorTableManager)
    {
        return static_cast<donut::engine::DescriptorTableManager*>(descriptorTableManager)->GetDescriptorTable();
    }

    // Same as Donut_LoadScene, also registering the scene's vertex / index buffers and textures in
    // a descriptor table (Donut_CreateDescriptorTableManager), where the scene's geometry and
    // material buffers refer to them by index. Returns null (after logging why) on failure.
    void* Donut_LoadSceneWithDescriptorTable(void* app, const char* path, void* descriptorTableManager)
    {
        App* a = AsApp(app);
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
    void* Donut_GetSceneBuffer(void* scene, int which)
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
    void Donut_BindGeometryIndexBuffer(void* bindingSetDesc, int slot, void* scene, int globalGeometryIndex)
    {
        const SceneGeometry g = FindSceneGeometry(scene, globalGeometryIndex);
        static_cast<nvrhi::BindingSetDesc*>(bindingSetDesc)->addItem(nvrhi::BindingSetItem::TypedBuffer_SRV(
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
    void Donut_BindGeometryVertexAttribute(void* bindingSetDesc, int slot, void* scene, int globalGeometryIndex, int attribute)
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
        static_cast<nvrhi::BindingSetDesc*>(bindingSetDesc)->addItem(nvrhi::BindingSetItem::TypedBuffer_SRV(
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
    void Donut_BindGeometryMaterialTexture(void* app, void* bindingSetDesc, int slot, void* scene, int globalGeometryIndex,
        int which, int fallback)
    {
        const donut::engine::Material& material = *FindSceneGeometry(scene, globalGeometryIndex).geometry->material;
        const std::shared_ptr<donut::engine::LoadedTexture>* textures[] = {
            &material.baseOrDiffuseTexture, &material.metalRoughOrSpecularTexture, &material.normalTexture,
            &material.emissiveTexture, &material.occlusionTexture, &material.transmissionTexture, &material.opacityTexture,
        };
        const std::shared_ptr<donut::engine::LoadedTexture>& texture = *textures[which];

        donut::engine::CommonRenderPasses* passes = AsApp(app)->commonPasses();
        nvrhi::ITexture* bound = texture && texture->texture ? texture->texture.Get()
            : fallback == FallbackTexture_Black ? passes->m_BlackTexture.Get() : passes->m_WhiteTexture.Get();

        static_cast<nvrhi::BindingSetDesc*>(bindingSetDesc)->addItem(
            nvrhi::BindingSetItem::Texture_SRV(static_cast<uint32_t>(slot), bound));
    }

    // cbuffer at b<slot>: the geometry's MaterialConstants (donut/shaders/material_cb.h).
    void Donut_BindGeometryMaterialConstants(void* bindingSetDesc, int slot, void* scene, int globalGeometryIndex)
    {
        static_cast<nvrhi::BindingSetDesc*>(bindingSetDesc)->addItem(nvrhi::BindingSetItem::ConstantBuffer(
            static_cast<uint32_t>(slot), FindSceneGeometry(scene, globalGeometryIndex).geometry->material->materialConstants));
    }

    // Like Donut_BuildSceneAccelStructs (opaque triangles; BLASes kept in the meshes), for shader
    // tables with hitGroupStride entries per geometry, laid out by globalGeometryIndex: each
    // instance's hit groups start at its mesh's first geometry index times hitGroupStride.
    void* Donut_BuildSceneAccelStructsWithHitGroupStride(void* app, void* commandList, void* scene, int hitGroupStride)
    {
        App* a = AsApp(app);
        nvrhi::ICommandList* cl = AsCommandList(commandList);
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
    void* Donut_LoadBindlessTexture(void* app, void* descriptorTableManager, const char* path, int sRGB)
    {
        App* a = AsApp(app);
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
    void* Donut_CreateDynamicMesh(void* app, void* descriptorTableManager, int maxVertices, int maxIndices, const char* name)
    {
        using namespace donut::engine;

        App* a = AsApp(app);
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
    void Donut_AttachDynamicMesh(void* app, void* scene, void* dynamicMesh)
    {
        App* a = AsApp(app);
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
    void Donut_SetDynamicMeshTexture(void* app, void* dynamicMesh, void* loadedTexture)
    {
        auto* m = static_cast<DynamicMesh*>(dynamicMesh);
        m->material->baseOrDiffuseTexture = AsApp(app)->SharedObject<donut::engine::LoadedTexture>(loadedTexture);
        m->material->dirty = true;
    }

    // Inside a render callback: replaces the dynamic mesh's contents with vertexCount vertices
    // (positions: 3 floats each, texCoords: 2 floats each) and indexCount uint indices (at most the
    // sizes it was created with), and rebuilds its BLAS.
    void Donut_UpdateDynamicMesh(void* frame, void* dynamicMesh, const void* positions, const void* texCoords, int vertexCount,
        const void* indices, int indexCount)
    {
        using donut::engine::VertexAttribute;

        auto* m = static_cast<DynamicMesh*>(dynamicMesh);
        nvrhi::ICommandList* cl = AsFrame(frame)->commandList;
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
    void Donut_BuildSceneBLASes(void* app, void* commandList, void* scene)
    {
        App* a = AsApp(app);
        for (const auto& mesh : static_cast<donut::engine::Scene*>(scene)->GetSceneGraph()->GetMeshes())
        {
            if (mesh->accelStruct)
                continue;

            const nvrhi::rt::AccelStructDesc blasDesc = GetMeshBlasDesc(*mesh, true);
            mesh->accelStruct = a->device()->createAccelStruct(blasDesc);
            nvrhi::utils::BuildBottomLevelAccelStruct(AsCommandList(commandList), mesh->accelStruct, blasDesc);
        }
    }

    // A BLAS of one procedural AABB, (-1, -1, -1) .. (1, 1, 1), built into an open command list;
    // instance it scaled and moved (Donut_AddTopLevelASInstance) for intersection-shader or ray
    // query primitives.
    void* Donut_CreateUnitAABBBlas(void* app, void* commandList, const char* debugName)
    {
        App* a = AsApp(app);
        nvrhi::ICommandList* cl = AsCommandList(commandList);

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
    void* Donut_CreateTopLevelAS(void* app, int maxInstances)
    {
        App* a = AsApp(app);
        auto accelStructs = std::make_shared<SceneAccelStructs>();
        nvrhi::rt::AccelStructDesc tlasDesc;
        tlasDesc.isTopLevel = true;
        tlasDesc.topLevelMaxInstances = static_cast<size_t>(maxInstances);
        accelStructs->topLevel = a->device()->createAccelStruct(tlasDesc);
        return a->OwnObject(accelStructs);
    }

    // Adds all mesh instances of a loaded scene (instance ID = instance index; meshes' BLASes from
    // Donut_BuildSceneBLASes), with instanceMask, except dynamicMesh's (if not null) with
    // dynamicMeshMask.
    void Donut_AddSceneTopLevelASInstances(void* sceneAccelStructs, void* scene, int instanceMask,
        void* dynamicMesh, int dynamicMeshMask)
    {
        auto* accelStructs = static_cast<SceneAccelStructs*>(sceneAccelStructs);
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
    void Donut_AddTopLevelASInstance(void* sceneAccelStructs, void* bottomLevelAS, int instanceMask, int instanceID,
        double scale, double x, double y, double z)
    {
        nvrhi::rt::InstanceDesc instanceDesc;
        instanceDesc.bottomLevelAS = static_cast<nvrhi::rt::IAccelStruct*>(bottomLevelAS);
        instanceDesc.instanceMask = static_cast<uint32_t>(instanceMask);
        instanceDesc.instanceID = static_cast<uint32_t>(instanceID);
        const dm::affine3 transform = dm::scaling(dm::float3(float(scale))) * dm::translation(dm::float3(float(x), float(y), float(z)));
        dm::affineToColumnMajor(transform, instanceDesc.transform);
        static_cast<SceneAccelStructs*>(sceneAccelStructs)->pendingInstances.push_back(instanceDesc);
    }

    // Inside a render callback: builds the TLAS from the instances added since the last build.
    void Donut_BuildTopLevelAS(void* frame, void* sceneAccelStructs)
    {
        auto* accelStructs = static_cast<SceneAccelStructs*>(sceneAccelStructs);
        nvrhi::ICommandList* cl = AsFrame(frame)->commandList;
        cl->beginMarker("TLAS Update");
        cl->buildTopLevelAccelStruct(accelStructs->topLevel, accelStructs->pendingInstances.data(),
            accelStructs->pendingInstances.size());
        cl->endMarker();
        accelStructs->pendingInstances.clear();
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
    void Donut_RefreshScene(void* app, void* frame, void* scene)
    {
        static_cast<donut::engine::Scene*>(scene)->Refresh(AsFrame(frame)->commandList,
            AsApp(app)->deviceManager->GetFrameIndex());
    }

    // Acceleration structures for an animated scene: builds one BLAS per mesh (kept in the
    // mesh's accelStruct; alpha-tested geometries non-opaque, static ones compacted later) into
    // an open command list, and creates a TLAS for Donut_UpdateSceneAccelStructs to build every
    // frame. Get the TLAS with Donut_GetSceneTopLevelAS.
    void* Donut_CreateAnimatedSceneAccelStructs(void* app, void* commandList, void* scene)
    {
        App* a = AsApp(app);
        nvrhi::ICommandList* cl = AsCommandList(commandList);
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
    void Donut_UpdateSceneAccelStructs(void* app, void* frame, void* sceneAccelStructs, void* scene)
    {
        nvrhi::ICommandList* cl = AsFrame(frame)->commandList;
        const uint32_t frameIndex = AsApp(app)->deviceManager->GetFrameIndex();
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
        cl->buildTopLevelAccelStruct(static_cast<SceneAccelStructs*>(sceneAccelStructs)->topLevel,
            instances.data(), instances.size());
        cl->endMarker();
    }

    // Donut's forward shading pass; numConstantBufferVersions bounds how many views it can
    // render per frame.
    void* Donut_CreateForwardShadingPass(void* app, int numConstantBufferVersions)
    {
        App* a = AsApp(app);
        auto pass = std::make_shared<donut::render::ForwardShadingPass>(a->device(), a->sharedCommonPasses());
        donut::render::ForwardShadingPass::CreateParameters params;
        params.numConstantBufferVersions = static_cast<uint32_t>(numConstantBufferVersions);
        pass->Init(*a->shaderFactory, params);
        return a->OwnObject(pass);
    }

    // Cube map render target of resolution x resolution faces: SRGBA8 color, D32 depth.
    void* Donut_CreateCubemapTarget(void* app, int resolution)
    {
        App* a = AsApp(app);
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
    void* Donut_GetCubemapColorTexture(void* cubemapTarget)
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
    void* Donut_CreateDeferredCommandList(void* app)
    {
        App* a = AsApp(app);
        return a->Own(a->device()->createCommandList(nvrhi::CommandListParameters().setEnableImmediateExecution(false)));
    }

    // Records the scene as seen by one cube map face (0..5) into commandList (opening and closing
    // it), with the forward shading pass and ambient lighting only.
    void Donut_RenderCubemapFace(void* cubemapTarget, int face, void* commandList, void* scene, void* forwardShadingPass)
    {
        RenderCubemapFace(static_cast<CubemapTarget*>(cubemapTarget), face, AsCommandList(commandList),
            static_cast<donut::engine::Scene*>(scene), static_cast<donut::render::ForwardShadingPass*>(forwardShadingPass));
    }

    // Same, as a task on the app's thread pool; call Donut_WaitForTasks before executing the
    // command list. Each concurrent task needs its own command list.
    void Donut_RenderCubemapFaceAsync(void* app, void* cubemapTarget, int face, void* commandList, void* scene, void* forwardShadingPass)
    {
        auto* target = static_cast<CubemapTarget*>(cubemapTarget);
        auto* cl = AsCommandList(commandList);
        auto* sc = static_cast<donut::engine::Scene*>(scene);
        auto* fwd = static_cast<donut::render::ForwardShadingPass*>(forwardShadingPass);
        AsApp(app)->threadPool()->AddTask([=]() { RenderCubemapFace(target, face, cl, sc, fwd); });
    }

    // Blocks until all tasks queued on the app's thread pool have finished.
    void Donut_WaitForTasks(void* app)
    {
        AsApp(app)->threadPool()->WaitForTasks();
    }

    // Donut's first person camera: WASD/arrow keys move, dragging with the left button looks around.
    void* Donut_CreateFirstPersonCamera(void* app)
    {
        donut::app::BaseCamera* camera = AsApp(app)->OwnObject(std::make_shared<donut::app::FirstPersonCamera>());
        return camera;
    }

    // Donut's third person (orbit) camera around a target: dragging with the left button orbits,
    // the mouse wheel zooms, WASD / arrows move the target.
    void* Donut_CreateThirdPersonCamera(void* app)
    {
        donut::app::BaseCamera* camera = AsApp(app)->OwnObject(std::make_shared<donut::app::ThirdPersonCamera>());
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
    void* Donut_BuildSceneAccelStructs(void* app, void* commandList, void* scene)
    {
        App* a = AsApp(app);
        nvrhi::ICommandList* cl = AsCommandList(commandList);
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
    void* Donut_GetSceneTopLevelAS(void* sceneAccelStructs)
    {
        return static_cast<SceneAccelStructs*>(sceneAccelStructs)->topLevel.Get();
    }

    // --- Scenes built in code ----------------------------------------------------------------

    // Material with a diffuse texture (path relative to the executable's directory, sRGB);
    // records the texture and constant buffer uploads into an open command list. specularGloss
    // != 0 selects the specular-glossiness model. Returns null (after logging why) if the
    // texture can't be loaded.
    void* Donut_CreateTexturedMaterial(void* app, void* commandList, const char* name, const char* diffuseTexturePath,
        int specularGloss)
    {
        App* a = AsApp(app);
        nvrhi::ICommandList* cl = AsCommandList(commandList);

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
    void* Donut_CreateMesh(void* app, void* commandList, const char* name, void* material,
        const void* positions, const void* texCoords, const void* normals, const void* tangents, int vertexCount,
        const void* indices, int indexCount)
    {
        using namespace donut::engine;

        App* a = AsApp(app);
        nvrhi::IDevice* device = a->device();
        nvrhi::ICommandList* cl = AsCommandList(commandList);

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
    void* Donut_CreateSceneGraph(void* app)
    {
        return AsApp(app)->OwnObject(std::make_shared<donut::engine::SceneGraph>());
    }

    // Adds a node holding an instance of a mesh from Donut_CreateMesh, under parentNode, or as the
    // root node if parentNode is null. Returns the node, valid as long as the scene graph.
    void* Donut_AddMeshNode(void* app, void* sceneGraph, void* parentNode, void* mesh, const char* name)
    {
        App* a = AsApp(app);
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
    void Donut_RefreshSceneGraph(void* app, void* sceneGraph)
    {
        static_cast<donut::engine::SceneGraph*>(sceneGraph)->Refresh(AsApp(app)->deviceManager->GetFrameIndex());
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
    void* Donut_CreateGBufferTargets(void* app, int width, int height, int reverseDepth)
    {
        App* a = AsApp(app);
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
    void* Donut_GetGBufferTexture(void* gbufferTargets, int which)
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
    void* Donut_GetGBufferShadedColor(void* gbufferTargets)
    {
        return static_cast<GBufferTargets*>(gbufferTargets)->ShadedColor.Get();
    }

    // Donut's G-buffer fill pass; its pipelines depend on the targets' formats and sample count.
    void* Donut_CreateGBufferFillPass(void* app)
    {
        App* a = AsApp(app);
        auto pass = std::make_shared<donut::render::GBufferFillPass>(a->device(), a->sharedCommonPasses());
        pass->Init(*a->shaderFactory, donut::render::GBufferFillPass::CreateParameters());
        return a->OwnObject(pass);
    }

    // Donut's deferred lighting pass (a compute shader reading the G-buffer).
    void* Donut_CreateDeferredLightingPass(void* app)
    {
        App* a = AsApp(app);
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
    void* Donut_CreatePlanarView(void* app)
    {
        return AsApp(app)->OwnObject(std::make_shared<donut::engine::PlanarView>());
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
    void Donut_ClearGBuffer(void* frame, void* gbufferTargets)
    {
        static_cast<GBufferTargets*>(gbufferTargets)->Clear(AsFrame(frame)->commandList);
    }

    // Draws the mesh instance of a node from Donut_AddMeshNode (all its geometries, back faces
    // culled) into the G-buffer, as seen by view.
    void Donut_RenderMeshNodeToGBuffer(void* frame, void* gbufferFillPass, void* view, void* gbufferTargets, void* meshNode)
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
        donut::render::RenderView(AsFrame(frame)->commandList, planarView, planarView,
            static_cast<GBufferTargets*>(gbufferTargets)->GBufferFramebuffer->GetFramebuffer(*planarView),
            drawStrategy, *static_cast<donut::render::GBufferFillPass*>(gbufferFillPass), context, false);
    }

    // Draws the opaque meshes of a scene from Donut_LoadScene into the G-buffer, as seen by view.
    void Donut_RenderSceneToGBuffer(void* frame, void* gbufferFillPass, void* view, void* gbufferTargets, void* scene)
    {
        auto* planarView = static_cast<donut::engine::PlanarView*>(view);
        donut::render::InstancedOpaqueDrawStrategy drawStrategy;
        donut::render::GBufferFillPass::Context context;
        donut::render::RenderCompositeView(AsFrame(frame)->commandList, planarView, planarView,
            *static_cast<GBufferTargets*>(gbufferTargets)->GBufferFramebuffer,
            static_cast<donut::engine::Scene*>(scene)->GetSceneGraph()->GetRootNode(),
            drawStrategy, *static_cast<donut::render::GBufferFillPass*>(gbufferFillPass), context);
    }

    // Draws the transparent meshes of a loaded scene with a forward shading pass
    // (Donut_CreateForwardShadingPass) over the targets' shaded color, depth-tested against the
    // G-buffer depth, lit by the scene graph's lights plus a top / bottom ambient term.
    void Donut_RenderSceneTransparentOverGBuffer(void* frame, void* forwardShadingPass, void* view, void* gbufferTargets,
        void* scene, double topR, double topG, double topB, double bottomR, double bottomG, double bottomB)
    {
        nvrhi::ICommandList* cl = AsFrame(frame)->commandList;
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
    void Donut_RenderDeferredLighting(void* frame, void* deferredLightingPass, void* view, void* gbufferTargets,
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
            AsFrame(frame)->commandList, *static_cast<donut::engine::PlanarView*>(view), inputs);
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
    void* Donut_CreateTemporalTargets(void* app, int width, int height)
    {
        App* a = AsApp(app);
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
    void* Donut_GetTemporalTargetsTexture(void* temporalTargets, int which)
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
    void Donut_SetTemporalTargetsShadingRateSurface(void* temporalTargets, void* shadingRateSurface)
    {
        static_cast<TemporalTargets*>(temporalTargets)->framebuffer->ShadingRateSurface =
            static_cast<nvrhi::ITexture*>(shadingRateSurface);
    }

    // Clears depth (to 0, for reverse Z) and HDR color.
    void Donut_ClearTemporalTargets(void* frame, void* temporalTargets)
    {
        auto* targets = static_cast<TemporalTargets*>(temporalTargets);
        nvrhi::ICommandList* cl = AsFrame(frame)->commandList;
        cl->clearDepthStencilTexture(targets->depth, nvrhi::AllSubresources, true, 0.f, true, 0);
        cl->clearTextureFloat(targets->hdrColor, nvrhi::AllSubresources, nvrhi::Color(0.f));
    }

    // Draws a loaded scene, opaque then transparent meshes, into the targets' HDR color and depth
    // with a forward shading pass (Donut_CreateForwardShadingPass), lit by the scene graph's
    // lights plus a top / bottom ambient term.
    void Donut_RenderSceneForward(void* frame, void* forwardShadingPass, void* view, void* temporalTargets, void* scene,
        double topR, double topG, double topB, double bottomR, double bottomG, double bottomB)
    {
        nvrhi::ICommandList* cl = AsFrame(frame)->commandList;
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
    void* Donut_CreateTemporalAntiAliasingPass(void* app, void* view, void* temporalTargets)
    {
        App* a = AsApp(app);
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
    void Donut_RenderMotionVectors(void* frame, void* temporalAntiAliasingPass, void* view, void* previousView)
    {
        static_cast<donut::render::TemporalAntiAliasingPass*>(temporalAntiAliasingPass)->RenderMotionVectors(
            AsFrame(frame)->commandList, *static_cast<donut::engine::PlanarView*>(view),
            *static_cast<donut::engine::PlanarView*>(previousView));
    }

    // Resolves the HDR color into the resolved color with default TAA parameters;
    // feedbackIsValid == 0 on the first frame, when there's no history yet.
    void Donut_TemporalResolve(void* frame, void* temporalAntiAliasingPass, void* view, int feedbackIsValid)
    {
        auto* planarView = static_cast<donut::engine::PlanarView*>(view);
        static_cast<donut::render::TemporalAntiAliasingPass*>(temporalAntiAliasingPass)->TemporalResolve(
            AsFrame(frame)->commandList, donut::render::TemporalAntiAliasingParameters(), feedbackIsValid != 0,
            *planarView, *planarView);
    }

    // --- Variable rate shading ----------------------------------------------------------------

    // Pixels per shading rate surface texel in each dimension, as NVRHI reports it (0 without
    // nvrhi::Feature::VariableRateShading).
    int Donut_GetShadingRateTileSize(void* app)
    {
        nvrhi::VariableRateShadingFeatureInfo info = {};
        AsApp(app)->device()->queryFeatureSupport(nvrhi::Feature::VariableRateShading, &info, sizeof(info));
        return static_cast<int>(info.shadingRateImageTileSize);
    }

    // Same, straight from D3D12 (D3D12_FEATURE_D3D12_OPTIONS6); 0 on other graphics APIs.
    int Donut_GetD3D12ShadingRateTileSize(void* app)
    {
#if DONUT_WITH_DX12
        nvrhi::IDevice* device = AsApp(app)->device();
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

    // R8_UINT shading rate surface of width x height tiles, written by compute shaders as
    // RWTexture2D<uint> (D3D12_SHADING_RATE values). Returns null on failure.
    void* Donut_CreateShadingRateSurface(void* app, int width, int height)
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

        App* a = AsApp(app);
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
    void Donut_BeginD3D12ShadingRateImage(void* frame, void* shadingRateSurface)
    {
#if DONUT_WITH_DX12
        ID3D12GraphicsCommandList* d3dCommandList = AsFrame(frame)->commandList->getNativeObject(
            nvrhi::ObjectTypes::D3D12_GraphicsCommandList);
        ID3D12GraphicsCommandList5* vrsCommandList = nullptr;
        if (!d3dCommandList || FAILED(d3dCommandList->QueryInterface(IID_PPV_ARGS(&vrsCommandList))))
            return;
        ID3D12Resource* vrsResource = static_cast<nvrhi::ITexture*>(shadingRateSurface)->getNativeObject(
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
    void Donut_EndD3D12ShadingRateImage(void* frame, void* shadingRateSurface)
    {
#if DONUT_WITH_DX12
        ID3D12GraphicsCommandList* d3dCommandList = AsFrame(frame)->commandList->getNativeObject(
            nvrhi::ObjectTypes::D3D12_GraphicsCommandList);
        ID3D12GraphicsCommandList5* vrsCommandList = nullptr;
        if (!d3dCommandList || FAILED(d3dCommandList->QueryInterface(IID_PPV_ARGS(&vrsCommandList))))
            return;
        ID3D12Resource* vrsResource = static_cast<nvrhi::ITexture*>(shadingRateSurface)->getNativeObject(
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
    int Donut_GetD3D12WorkGraphsTier(void* app)
    {
#if DONUT_WITH_DX12
        nvrhi::IDevice* device = AsApp(app)->device();
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
    void* Donut_CreateD3D12WorkGraph(void* app, void* shaderLibrary, void* computePipeline, const char* programName,
        const char* entryNodeName, int gridX, int gridY, int gridZ)
    {
#if DONUT_WITH_DX12
        App* a = AsApp(app);
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
        static_cast<nvrhi::IShaderLibrary*>(shaderLibrary)->getBytecode(&libraryCode.pShaderBytecode, &libraryCode.BytecodeLength);
        ID3D12RootSignature* rootSignature = static_cast<nvrhi::IComputePipeline*>(computePipeline)->getNativeObject(
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
    void Donut_DispatchD3D12WorkGraph(void* commandList, void* workGraph, void* computePipeline, void* bindingSet,
        const void* data, int byteSize, int initializeBackingMemory)
    {
#if DONUT_WITH_DX12
        const auto* graph = static_cast<D3D12WorkGraph*>(workGraph);
        nvrhi::ICommandList* cl = AsCommandList(commandList);

        // Bindings (and the barriers they need) through NVRHI.
        cl->setComputeState(nvrhi::ComputeState()
            .setPipeline(static_cast<nvrhi::IComputePipeline*>(computePipeline))
            .addBindingSet(static_cast<nvrhi::IBindingSet*>(bindingSet)));
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
    double Donut_GetAverageFrameTime(void* app)
    {
        return AsApp(app)->deviceManager->GetAverageFrameTimeSeconds();
    }

    // Window size in pixels, e.g. for placing ImGui windows.
    int Donut_GetWindowWidth(void* app)
    {
        int width = 0, height = 0;
        AsApp(app)->deviceManager->GetWindowDimensions(width, height);
        return width;
    }

    int Donut_GetWindowHeight(void* app)
    {
        int width = 0, height = 0;
        AsApp(app)->deviceManager->GetWindowDimensions(width, height);
        return height;
    }

    // Drops the compiled shaders the app's shader factory cached, so that passes created after
    // this load them from disk again (e.g. after recompiling them).
    void Donut_ClearShaderCache(void* app)
    {
        AsApp(app)->shaderFactory->ClearCache();
    }

    // Destroys resources released since the GPU last finished with them; after Donut_WaitForIdle.
    void Donut_RunGarbageCollection(void* app)
    {
        AsApp(app)->device()->runGarbageCollection();
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

    int Donut_QueryFormatSupport(void* app, int format)
    {
        return static_cast<int>(AsApp(app)->device()->queryFormatSupport(static_cast<nvrhi::Format>(format)));
    }

    // --- Scene loading ------------------------------------------------------------------------

    // A scene loader: loads one scene at a time on a thread (Donut_BeginLoadingScene); poll it
    // with Donut_UpdateSceneLoader every frame. Its scenes use the app's texture cache.
    void* Donut_CreateSceneLoader(void* app)
    {
        auto loader = std::make_shared<SceneLoader>();
        loader->app = AsApp(app);
        return AsApp(app)->OwnObject(loader);
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
    int Donut_UpdateSceneLoader(void* sceneLoader, void* frame)
    {
        auto* loader = static_cast<SceneLoader*>(sceneLoader);
        App* a = loader->app;
        FrameContext* ctx = AsFrame(frame);
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
    void* Donut_FindScenes(void* app, const char* directory)
    {
        donut::vfs::NativeFileSystem fs;
        return AsApp(app)->OwnObject(std::make_shared<std::vector<std::string>>(donut::app::FindScenes(fs, directory)));
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
            ? static_cast<ShadowMapTarget*>(shadowMapTarget)->shadowMap : nullptr;
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

    // --- Views ----------------------------------------------------------------------------------

    // Two planar views side by side, left and right eye, rendered as one.
    void* Donut_CreateStereoView(void* app)
    {
        donut::engine::IView* view = AsApp(app)->OwnObject(std::make_shared<donut::engine::StereoPlanarView>());
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
    void* Donut_CreateSceneRenderTargets(void* app, int width, int height, int sampleCount)
    {
        App* a = AsApp(app);
        auto targets = std::make_shared<SceneRenderTargets>();
        targets->Init(a->device(), dm::uint2(uint32_t(width), uint32_t(height)), uint32_t(sampleCount), true, true);
        return a->OwnObject(targets);
    }

    // Clears the G-buffer (depth to 0, for reverse Z), HDR, LDR and resolved color.
    void Donut_ClearSceneRenderTargets(void* commandList, void* sceneRenderTargets)
    {
        AsSceneRenderTargets(sceneRenderTargets)->Clear(AsCommandList(commandList));
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
    void* Donut_GetSceneRenderTargetsTexture(void* sceneRenderTargets, int which)
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

    void* Donut_GetSceneRenderTargetsFramebuffer(void* sceneRenderTargets, int which)
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
    void Donut_ResolveTexture(void* commandList, void* dstTexture, void* srcTexture)
    {
        const auto subresources = nvrhi::TextureSubresourceSet(0, 1, 0, 1);
        AsCommandList(commandList)->resolveTexture(static_cast<nvrhi::ITexture*>(dstTexture), subresources,
            static_cast<nvrhi::ITexture*>(srcTexture), subresources);
    }

    // Clears all of an integer texture to value.
    void Donut_ClearTextureUInt(void* commandList, void* texture, int value)
    {
        AsCommandList(commandList)->clearTextureUInt(static_cast<nvrhi::ITexture*>(texture), nvrhi::AllSubresources,
            static_cast<uint32_t>(value));
    }

    // --- Shadows ------------------------------------------------------------------------------

    // A cascaded shadow map of numCascades resolution x resolution cascades.
    void* Donut_CreateCascadedShadowMap(void* app, int resolution, int numCascades)
    {
        App* a = AsApp(app);
        auto target = std::make_shared<ShadowMapTarget>();
        target->shadowMap = std::make_shared<donut::render::CascadedShadowMap>(a->device(), resolution, numCascades, 0,
            ChooseDepthFormat(a->device()));
        target->shadowMap->SetupProxyViews();

        target->framebuffer = std::make_shared<donut::engine::FramebufferFactory>(a->device());
        target->framebuffer->DepthTarget = target->shadowMap->GetTexture();
        return a->OwnObject(target);
    }

    // The depth texture, one array slice per cascade.
    void* Donut_GetShadowMapTexture(void* shadowMapTarget)
    {
        return static_cast<ShadowMapTarget*>(shadowMapTarget)->shadowMap->GetTexture();
    }

    // Fits the cascades to a directional light and the first planar view of `view`, out to
    // maxShadowDistance, with cascade split exponent `exponent` (stable: they don't shimmer
    // when the camera moves).
    void Donut_SetupShadowMapForView(void* shadowMapTarget, void* light, void* view, double maxShadowDistance,
        double zRange, double exponent)
    {
        donut::engine::IView* v = AsView(view);
        const dm::affine3 viewMatrixInv = v->GetChildView(donut::engine::ViewType::PLANAR, 0)->GetInverseViewMatrix();
        static_cast<ShadowMapTarget*>(shadowMapTarget)->shadowMap->SetupForPlanarViewStable(
            *static_cast<donut::engine::DirectionalLight*>(static_cast<donut::engine::Light*>(light)),
            v->GetProjectionFrustum(), viewMatrixInv, float(maxShadowDistance), float(zRange), float(zRange), float(exponent));
    }

    void Donut_ClearShadowMap(void* commandList, void* shadowMapTarget)
    {
        static_cast<ShadowMapTarget*>(shadowMapTarget)->shadowMap->Clear(AsCommandList(commandList));
    }

    // Donut's depth-only pass, with depth biases for shadow maps.
    void* Donut_CreateShadowDepthPass(void* app, int depthBias, double slopeScaledDepthBias)
    {
        App* a = AsApp(app);
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
    void Donut_RenderShadowDepth(void* commandList, void* depthPass, void* shadowMapTarget, void* sceneGraph, int materialEvents)
    {
        auto* target = static_cast<ShadowMapTarget*>(shadowMapTarget);
        donut::render::InstancedOpaqueDrawStrategy strategy;
        donut::render::DepthPass::Context context;
        donut::render::RenderCompositeView(AsCommandList(commandList), &target->shadowMap->GetView(), nullptr,
            *target->framebuffer, AsSceneGraph(sceneGraph)->GetRootNode(), strategy,
            *static_cast<donut::render::DepthPass*>(depthPass), context, "ShadowMap", materialEvents != 0);
    }

    // --- Geometry passes ------------------------------------------------------------------------

    // Donut_CreateForwardShadingPass with options: singlePassCubemap != 0 renders all six faces
    // of a cube map view at once (needs nvrhi::Feature::FastGeometryShader); trackLiveness == 0
    // skips resource liveness tracking.
    void* Donut_CreateForwardShadingPassWithOptions(void* app, int singlePassCubemap, int trackLiveness)
    {
        App* a = AsApp(app);
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
    void* Donut_CreateForwardShadingContext(void* app)
    {
        return AsApp(app)->OwnObject(std::make_shared<donut::render::ForwardShadingPass::Context>());
    }

    // Uploads a scene graph's lights, a top / bottom ambient term and the enabled probes of a
    // light probe set (or none: null) for Donut_RenderForward with the same context.
    void Donut_PrepareForwardLights(void* commandList, void* forwardShadingPass, void* forwardShadingContext, void* sceneGraph,
        double topR, double topG, double topB, double bottomR, double bottomG, double bottomB, void* lightProbeSet)
    {
        std::vector<std::shared_ptr<donut::engine::LightProbe>> lightProbes;
        if (lightProbeSet)
            lightProbes = static_cast<LightProbeSet*>(lightProbeSet)->EnabledProbes();

        static_cast<donut::render::ForwardShadingPass*>(forwardShadingPass)->PrepareLights(
            *static_cast<donut::render::ForwardShadingPass::Context*>(forwardShadingContext), AsCommandList(commandList),
            AsSceneGraph(sceneGraph)->GetLights(), dm::float3(float(topR), float(topG), float(topB)),
            dm::float3(float(bottomR), float(bottomG), float(bottomB)), lightProbes);
    }

    // Draws a scene graph's opaque (transparent == 0) or transparent meshes with a forward shading
    // pass into a framebuffer, as seen by view; previousView (or null) is for motion vectors.
    // `name` labels the GPU marker; materialEvents != 0 adds one per material.
    void Donut_RenderForward(void* commandList, void* forwardShadingPass, void* forwardShadingContext, void* view,
        void* previousView, void* framebuffer, void* sceneGraph, int transparent, const char* name, int materialEvents)
    {
        donut::render::InstancedOpaqueDrawStrategy opaqueStrategy;
        donut::render::TransparentDrawStrategy transparentStrategy;
        donut::render::IDrawStrategy& strategy = transparent
            ? static_cast<donut::render::IDrawStrategy&>(transparentStrategy) : opaqueStrategy;

        donut::render::RenderCompositeView(AsCommandList(commandList), AsView(view),
            previousView ? AsView(previousView) : nullptr, *AsFramebufferFactory(framebuffer),
            AsSceneGraph(sceneGraph)->GetRootNode(), strategy, *static_cast<donut::render::ForwardShadingPass*>(forwardShadingPass),
            *static_cast<donut::render::ForwardShadingPass::Context*>(forwardShadingContext), name, materialEvents != 0);
    }

    // Donut_CreateGBufferFillPass with options: enableMotionVectors != 0 writes motion vectors
    // (and stencilWriteMask into the stencil where it does, for TAA).
    void* Donut_CreateGBufferFillPassWithOptions(void* app, int enableMotionVectors, int stencilWriteMask)
    {
        App* a = AsApp(app);
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
    void Donut_RenderGBufferFill(void* commandList, void* gbufferFillPass, void* view, void* previousView,
        void* sceneRenderTargets, void* sceneGraph, int materialEvents)
    {
        donut::render::InstancedOpaqueDrawStrategy strategy;
        donut::render::GBufferFillPass::Context context;
        donut::render::RenderCompositeView(AsCommandList(commandList), AsView(view), AsView(previousView),
            *AsSceneRenderTargets(sceneRenderTargets)->GBufferFramebuffer, AsSceneGraph(sceneGraph)->GetRootNode(), strategy,
            *static_cast<donut::render::GBufferFillPass*>(gbufferFillPass), context, "GBufferFill", materialEvents != 0);
    }

    // Donut's material ID pass: writes each pixel's material ID and instance index (RG16_UINT).
    void* Donut_CreateMaterialIDPass(void* app, int stencilWriteMask)
    {
        App* a = AsApp(app);
        donut::render::GBufferFillPass::CreateParameters params;
        params.enableMotionVectors = false;
        params.stencilWriteMask = static_cast<uint8_t>(stencilWriteMask);
        auto pass = std::make_shared<donut::render::MaterialIDPass>(a->device(), a->sharedCommonPasses());
        pass->Init(*a->shaderFactory, params);
        return a->OwnObject(pass);
    }

    // Draws a scene graph's opaque (transparent == 0) or transparent meshes into the targets'
    // material IDs.
    void Donut_RenderMaterialIDs(void* commandList, void* materialIdPass, void* view, void* previousView,
        void* sceneRenderTargets, void* sceneGraph, int transparent)
    {
        donut::render::InstancedOpaqueDrawStrategy opaqueStrategy;
        donut::render::TransparentDrawStrategy transparentStrategy;
        donut::render::IDrawStrategy& strategy = transparent
            ? static_cast<donut::render::IDrawStrategy&>(transparentStrategy) : opaqueStrategy;

        donut::render::MaterialIDPass::Context context;
        donut::render::RenderCompositeView(AsCommandList(commandList), AsView(view), AsView(previousView),
            *AsSceneRenderTargets(sceneRenderTargets)->MaterialIDFramebuffer, AsSceneGraph(sceneGraph)->GetRootNode(), strategy,
            *static_cast<donut::render::MaterialIDPass*>(materialIdPass), context,
            transparent ? "MaterialID - Translucent" : "MaterialID");
    }

    // Lights the targets' G-buffer into their HDR color with a scene graph's lights, a top /
    // bottom ambient term, the targets' ambient occlusion (useAmbientOcclusion != 0) and a light
    // probe set (or none: null).
    void Donut_RenderDeferredLightingToHdr(void* commandList, void* deferredLightingPass, void* view, void* sceneRenderTargets,
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
            AsCommandList(commandList), *AsView(view), inputs);
    }

    // --- Post-processing and other passes -----------------------------------------------------

    // Donut's SSAO over the targets' depth and G-buffer normals, into their ambient occlusion.
    // Single-sample targets only.
    void* Donut_CreateSsaoPass(void* app, void* sceneRenderTargets)
    {
        App* a = AsApp(app);
        auto* targets = AsSceneRenderTargets(sceneRenderTargets);
        return a->OwnObject(std::make_shared<donut::render::SsaoPass>(a->device(), a->shaderFactory, a->sharedCommonPasses(),
            targets->Depth, targets->GBufferNormals, targets->AmbientOcclusion));
    }

    // With default parameters.
    void Donut_RenderSsao(void* commandList, void* ssaoPass, void* view)
    {
        static_cast<donut::render::SsaoPass*>(ssaoPass)->Render(AsCommandList(commandList),
            donut::render::SsaoParameters(), *AsView(view));
    }

    // Donut's procedural sky, drawn where the framebuffer's depth is still clear.
    void* Donut_CreateSkyPass(void* app, void* framebuffer, void* view)
    {
        App* a = AsApp(app);
        return a->OwnObject(std::make_shared<donut::render::SkyPass>(a->device(), a->shaderFactory, a->sharedCommonPasses(),
            AsFramebufferFactory(framebuffer), *AsView(view)));
    }

    // Draws the sky around a directional light; the SkyParameters not given keep their defaults.
    void Donut_RenderSky(void* commandList, void* skyPass, void* view, void* light, double brightness,
        double glowSize, double glowSharpness, double glowIntensity, double horizonSize)
    {
        donut::render::SkyParameters params;
        params.brightness = float(brightness);
        params.glowSize = float(glowSize);
        params.glowSharpness = float(glowSharpness);
        params.glowIntensity = float(glowIntensity);
        params.horizonSize = float(horizonSize);
        static_cast<donut::render::SkyPass*>(skyPass)->Render(AsCommandList(commandList), *AsView(view),
            *static_cast<donut::engine::DirectionalLight*>(static_cast<donut::engine::Light*>(light)), params);
    }

    // Donut's TAA over the targets: resolves HDR color into resolved color with Catmull-Rom
    // filtering, using motion vectors where the stencil has motionVectorStencilMask set.
    void* Donut_CreateSceneTemporalAntiAliasingPass(void* app, void* view, void* sceneRenderTargets, int motionVectorStencilMask)
    {
        App* a = AsApp(app);
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
    void Donut_RenderViewMotionVectors(void* commandList, void* temporalAntiAliasingPass, void* view, void* previousView)
    {
        static_cast<donut::render::TemporalAntiAliasingPass*>(temporalAntiAliasingPass)->RenderMotionVectors(
            AsCommandList(commandList), *AsView(view), *AsView(previousView));
    }

    // Donut_TemporalResolve for any view, with history clamping on or off.
    void Donut_TemporalResolveView(void* commandList, void* temporalAntiAliasingPass, void* view, int feedbackIsValid,
        int enableHistoryClamping)
    {
        donut::render::TemporalAntiAliasingParameters params;
        params.enableHistoryClamping = enableHistoryClamping != 0;
        static_cast<donut::render::TemporalAntiAliasingPass*>(temporalAntiAliasingPass)->TemporalResolve(
            AsCommandList(commandList), params, feedbackIsValid != 0, *AsView(view), *AsView(view));
    }

    // Moves on to the next jitter offset; once per frame.
    void Donut_AdvanceTemporalFrame(void* temporalAntiAliasingPass)
    {
        static_cast<donut::render::TemporalAntiAliasingPass*>(temporalAntiAliasingPass)->AdvanceFrame();
    }

    // Donut's tone mapping with eye adaptation, into a framebuffer. Pass the tone mapping pass
    // this one replaces (or null) to keep its adapted exposure.
    void* Donut_CreateToneMappingPass(void* app, void* framebuffer, void* view, void* previousToneMappingPass)
    {
        App* a = AsApp(app);
        donut::render::ToneMappingPass::CreateParameters params;
        if (previousToneMappingPass)
            params.exposureBufferOverride = static_cast<donut::render::ToneMappingPass*>(previousToneMappingPass)->GetExposureBuffer();
        return a->OwnObject(std::make_shared<donut::render::ToneMappingPass>(a->device(), a->shaderFactory,
            a->sharedCommonPasses(), AsFramebufferFactory(framebuffer), *AsView(view), params));
    }

    // Once per frame, with the frame time in seconds (for eye adaptation).
    void Donut_AdvanceToneMappingFrame(void* toneMappingPass, double elapsedSeconds)
    {
        static_cast<donut::render::ToneMappingPass*>(toneMappingPass)->AdvanceFrame(float(elapsedSeconds));
    }

    void Donut_ResetExposure(void* commandList, void* toneMappingPass, double initialExposure)
    {
        static_cast<donut::render::ToneMappingPass*>(toneMappingPass)->ResetExposure(AsCommandList(commandList), float(initialExposure));
    }

    // Tone maps an HDR texture with default parameters; freezeEyeAdaptation != 0 keeps the
    // current exposure (e.g. right after Donut_ResetExposure).
    void Donut_RenderToneMapping(void* commandList, void* toneMappingPass, void* view, void* sourceTexture, int freezeEyeAdaptation)
    {
        donut::render::ToneMappingParameters params;
        if (freezeEyeAdaptation)
        {
            params.eyeAdaptationSpeedUp = 0.f;
            params.eyeAdaptationSpeedDown = 0.f;
        }
        static_cast<donut::render::ToneMappingPass*>(toneMappingPass)->SimpleRender(AsCommandList(commandList), params,
            *AsView(view), static_cast<nvrhi::ITexture*>(sourceTexture));
    }

    // Donut's bloom, blended into a framebuffer's color.
    void* Donut_CreateBloomPass(void* app, void* framebuffer, void* view)
    {
        App* a = AsApp(app);
        return a->OwnObject(std::make_shared<donut::render::BloomPass>(a->device(), a->shaderFactory, a->sharedCommonPasses(),
            AsFramebufferFactory(framebuffer), *AsView(view)));
    }

    // Blurs sourceTexture (Gaussian sigma in pixels) and adds it to the framebuffer, weighted by alpha.
    void Donut_RenderBloom(void* commandList, void* bloomPass, void* framebuffer, void* view, void* sourceTexture,
        double sigma, double alpha)
    {
        static_cast<donut::render::BloomPass*>(bloomPass)->Render(AsCommandList(commandList), AsFramebufferFactory(framebuffer),
            *AsView(view), static_cast<nvrhi::ITexture*>(sourceTexture), float(sigma), float(alpha));
    }

    // NVIDIA DLSS, loading nvngx_dlss.dll from the executable's directory (donut_interop.dll's under
    // the JIT). Null when Donut was built without DONUT_WITH_DLSS, or the device can't create it.
    void* Donut_CreateDlss(void* app)
    {
#if DONUT_WITH_DLSS
        App* a = AsApp(app);
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
    void Donut_EvaluateDlss(void* commandList, void* dlss, void* view, void* sceneRenderTargets, void* toneMappingPass)
    {
#if DONUT_WITH_DLSS
        auto* targets = AsSceneRenderTargets(sceneRenderTargets);
        donut::render::DLSS::EvaluateParameters params;
        params.depthTexture = targets->Depth;
        params.motionVectorsTexture = targets->MotionVectors;
        params.inputColorTexture = targets->HdrColor;
        params.outputColorTexture = targets->ResolvedColor;
        params.exposureBuffer = static_cast<donut::render::ToneMappingPass*>(toneMappingPass)->GetExposureBuffer();
        static_cast<donut::render::DLSS*>(dlss)->Evaluate(AsCommandList(commandList), params,
            *static_cast<donut::engine::PlanarView*>(view));
#else
        (void)commandList; (void)dlss; (void)view; (void)sceneRenderTargets; (void)toneMappingPass;
#endif
    }

    // Reads back one pixel of a texture (as RGBA32_UINT): Donut_CapturePixel, execute the command
    // list, then Donut_ReadPixelUInts.
    void* Donut_CreatePixelReadbackPass(void* app, void* texture)
    {
        App* a = AsApp(app);
        return a->OwnObject(std::make_shared<donut::render::PixelReadbackPass>(a->device(), a->shaderFactory,
            static_cast<nvrhi::ITexture*>(texture), nvrhi::Format::RGBA32_UINT));
    }

    void Donut_CapturePixel(void* commandList, void* pixelReadbackPass, int x, int y)
    {
        static_cast<donut::render::PixelReadbackPass*>(pixelReadbackPass)->Capture(AsCommandList(commandList),
            dm::uint2(uint32_t(x), uint32_t(y)));
    }

    // The captured pixel as 4 ints into dst; waits for the GPU if needed.
    void Donut_ReadPixelUInts(void* pixelReadbackPass, void* dst)
    {
        const dm::uint4 value = static_cast<donut::render::PixelReadbackPass*>(pixelReadbackPass)->ReadUInts();
        memcpy(dst, &value, sizeof(value));
    }

    // Donut's mip generation (compute) for a color texture with mips.
    void* Donut_CreateMipMapGenPass(void* app, void* texture)
    {
        App* a = AsApp(app);
        return a->OwnObject(std::make_shared<donut::render::MipMapGenPass>(a->device(), a->shaderFactory,
            static_cast<nvrhi::ITexture*>(texture), donut::render::MipMapGenPass::MODE_COLOR));
    }

    void Donut_DispatchMipMapGen(void* commandList, void* mipMapGenPass)
    {
        static_cast<donut::render::MipMapGenPass*>(mipMapGenPass)->Dispatch(AsCommandList(commandList));
    }

    // Inside a render callback: draws the texture's mips over the frame.
    void Donut_DisplayMipMapGen(void* app, void* frame, void* mipMapGenPass)
    {
        static_cast<donut::render::MipMapGenPass*>(mipMapGenPass)->Display(AsApp(app)->sharedCommonPasses(),
            AsFrame(frame)->commandList, AsFrame(frame)->framebuffer);
    }

    // --- Light probes -------------------------------------------------------------------------

    // numProbes light probes (named "1", "2", ...), disabled until rendered: 256x256 diffuse and
    // 512x512 specular (8 mips) RGBA16_FLOAT cube maps.
    void* Donut_CreateLightProbeSet(void* app, int numProbes)
    {
        App* a = AsApp(app);
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
    void* Donut_CreateLightProbeProcessingPass(void* app)
    {
        App* a = AsApp(app);
        return a->OwnObject(std::make_shared<donut::render::LightProbeProcessingPass>(a->device(), a->shaderFactory,
            a->sharedCommonPasses()));
    }

    void Donut_ResetLightProbeProcessingCaches(void* lightProbeProcessingPass)
    {
        static_cast<donut::render::LightProbeProcessingPass*>(lightProbeProcessingPass)->ResetCaches();
    }

    // An environment cube map of size x size faces (RGBA16_FLOAT, mipLevels mips) with a depth
    // buffer, and the cube map view that renders it. Place it with Donut_SetLightProbeCaptureTransform.
    void* Donut_CreateLightProbeCapture(void* app, int size, int mipLevels)
    {
        App* a = AsApp(app);
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

    void* Donut_GetLightProbeCaptureFramebuffer(void* lightProbeCapture)
    {
        return &static_cast<LightProbeCapture*>(lightProbeCapture)->framebuffer;
    }

    // Clears color to black and depth to 0 (reverse Z).
    void Donut_ClearLightProbeCapture(void* commandList, void* lightProbeCapture)
    {
        auto* capture = static_cast<LightProbeCapture*>(lightProbeCapture);
        nvrhi::ICommandList* cl = AsCommandList(commandList);
        cl->clearTextureFloat(capture->colorTexture, nvrhi::AllSubresources, nvrhi::Color(0.f));
        const nvrhi::FormatInfo& depthFormatInfo = nvrhi::getFormatInfo(capture->depthTexture->getDesc().format);
        cl->clearDepthStencilTexture(capture->depthTexture, nvrhi::AllSubresources, true, 0.f, depthFormatInfo.hasStencil, 0);
    }

    // Fits the shadow map's cascades to a directional light and the capture's cube map view.
    void Donut_SetupShadowMapForLightProbeCapture(void* shadowMapTarget, void* light, void* lightProbeCapture,
        double cullDistance, double zRange, double exponent)
    {
        auto* capture = static_cast<LightProbeCapture*>(lightProbeCapture);
        static_cast<ShadowMapTarget*>(shadowMapTarget)->shadowMap->SetupForCubemapView(
            *static_cast<donut::engine::DirectionalLight*>(static_cast<donut::engine::Light*>(light)),
            capture->view.GetViewOrigin(), float(cullDistance), float(zRange), float(zRange), float(exponent));
    }

    // Fills the capture's environment map mips from mip 0.
    void Donut_GenerateLightProbeCaptureMips(void* commandList, void* lightProbeProcessingPass, void* lightProbeCapture)
    {
        auto* capture = static_cast<LightProbeCapture*>(lightProbeCapture);
        static_cast<donut::render::LightProbeProcessingPass*>(lightProbeProcessingPass)->GenerateCubemapMips(
            AsCommandList(commandList), capture->colorTexture, 0, 0, capture->mipLevels - 1);
    }

    // Convolves the capture into a probe's diffuse map.
    void Donut_RenderLightProbeDiffuse(void* commandList, void* lightProbeProcessingPass, void* lightProbeCapture,
        void* lightProbeSet, int index)
    {
        auto& probe = *static_cast<LightProbeSet*>(lightProbeSet)->probes[index];
        static_cast<donut::render::LightProbeProcessingPass*>(lightProbeProcessingPass)->RenderDiffuseMap(
            AsCommandList(commandList), static_cast<LightProbeCapture*>(lightProbeCapture)->colorTexture, nvrhi::AllSubresources,
            probe.diffuseMap, probe.diffuseArrayIndex * 6, 0);
    }

    // Prefilters the capture for a roughness into one mip of a probe's specular map.
    void Donut_RenderLightProbeSpecular(void* commandList, void* lightProbeProcessingPass, void* lightProbeCapture,
        void* lightProbeSet, int index, double roughness, int mipLevel)
    {
        auto& probe = *static_cast<LightProbeSet*>(lightProbeSet)->probes[index];
        static_cast<donut::render::LightProbeProcessingPass*>(lightProbeProcessingPass)->RenderSpecularMap(
            AsCommandList(commandList), float(roughness), static_cast<LightProbeCapture*>(lightProbeCapture)->colorTexture,
            nvrhi::AllSubresources, probe.specularMap, probe.specularArrayIndex * 6, uint32_t(mipLevel));
    }

    // Renders the environment BRDF lookup table the probes share (once is enough).
    void Donut_RenderEnvironmentBrdf(void* commandList, void* lightProbeProcessingPass)
    {
        static_cast<donut::render::LightProbeProcessingPass*>(lightProbeProcessingPass)->RenderEnvironmentBrdfTexture(
            AsCommandList(commandList));
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
    void Donut_FlushFrameCommandList(void* app, void* frame)
    {
        FrameContext* ctx = AsFrame(frame);
        ctx->commandList->close();
        AsApp(app)->device()->executeCommandList(ctx->commandList);
        ctx->commandList->open();
    }

    // Saves the frame's color (as recorded so far, which it submits) to an image file: BMP, PNG,
    // JPG or TGA, by the extension. Returns non-zero on success.
    int Donut_SaveFrameToFile(void* app, void* frame, const char* path)
    {
        App* a = AsApp(app);
        FrameContext* ctx = AsFrame(frame);
        ctx->commandList->close();
        a->device()->executeCommandList(ctx->commandList);

        // No immediate command list may be open while it runs.
        const bool saved = donut::engine::SaveTextureToFile(a->device(), a->commonPasses(),
            ctx->framebuffer->getDesc().colorAttachments[0].texture, nvrhi::ResourceStates::RenderTarget, path);

        ctx->commandList->open();
        return saved ? 1 : 0;
    }

    void Donut_ClearColor(void* frame, double r, double g, double b, double a)
    {
        FrameContext* ctx = AsFrame(frame);
        nvrhi::utils::ClearColorAttachment(ctx->commandList, ctx->framebuffer, 0,
            nvrhi::Color(float(r), float(g), float(b), float(a)));
    }

    // Draws vertexCount vertices with no vertex buffers, over the whole framebuffer.
    void Donut_Draw(void* frame, void* pipeline, int vertexCount)
    {
        FrameContext* ctx = AsFrame(frame);

        nvrhi::GraphicsState state;
        state.pipeline = static_cast<nvrhi::IGraphicsPipeline*>(pipeline);
        state.framebuffer = ctx->framebuffer;
        state.viewport.addViewportAndScissorRect(ctx->framebuffer->getFramebufferInfo().getViewport());
        ctx->commandList->setGraphicsState(state);

        nvrhi::DrawArguments args;
        args.vertexCount = static_cast<uint32_t>(vertexCount);
        ctx->commandList->draw(args);
    }

    // Launches groupsX amplification-shader groups of a meshlet pipeline, over the whole framebuffer.
    void Donut_DispatchMesh(void* frame, void* meshletPipeline, int groupsX)
    {
        FrameContext* ctx = AsFrame(frame);

        nvrhi::MeshletState state;
        state.pipeline = static_cast<nvrhi::IMeshletPipeline*>(meshletPipeline);
        state.framebuffer = ctx->framebuffer;
        state.viewport.addViewportAndScissorRect(ctx->framebuffer->getFramebufferInfo().getViewport());
        ctx->commandList->setMeshletState(state);

        ctx->commandList->dispatchMesh(static_cast<uint32_t>(groupsX));
    }

    // Traces width x height rays with a shader table, with bindingSet as its global bindings.
    void Donut_DispatchRays(void* frame, void* shaderTable, void* bindingSet, int width, int height)
    {
        FrameContext* ctx = AsFrame(frame);

        nvrhi::rt::State state;
        state.shaderTable = static_cast<nvrhi::rt::IShaderTable*>(shaderTable);
        state.bindings = { static_cast<nvrhi::IBindingSet*>(bindingSet) };
        ctx->commandList->setRayTracingState(state);

        nvrhi::rt::DispatchRaysArguments args;
        args.width = static_cast<uint32_t>(width);
        args.height = static_cast<uint32_t>(height);
        ctx->commandList->dispatchRays(args);
    }

    // Same as Donut_DispatchRays, with a descriptor table (Donut_GetDescriptorTable) bound after
    // the binding set, for pipelines with a bindless layout second.
    void Donut_DispatchRaysWithDescriptorTable(void* frame, void* shaderTable, void* bindingSet, void* descriptorTable,
        int width, int height)
    {
        FrameContext* ctx = AsFrame(frame);

        nvrhi::rt::State state;
        state.shaderTable = static_cast<nvrhi::rt::IShaderTable*>(shaderTable);
        state.bindings = { static_cast<nvrhi::IBindingSet*>(bindingSet), static_cast<nvrhi::IDescriptorTable*>(descriptorTable) };
        ctx->commandList->setRayTracingState(state);

        nvrhi::rt::DispatchRaysArguments args;
        args.width = static_cast<uint32_t>(width);
        args.height = static_cast<uint32_t>(height);
        ctx->commandList->dispatchRays(args);
    }

    // Copies a texture over the whole framebuffer, stretched, with Donut's CommonRenderPasses.
    // Call Donut_ClearBindingCache when textures blitted before are released.
    void Donut_BlitTexture(void* app, void* frame, void* texture)
    {
        App* a = AsApp(app);
        FrameContext* ctx = AsFrame(frame);
        a->commonPasses()->BlitTexture(ctx->commandList, ctx->framebuffer,
            static_cast<nvrhi::ITexture*>(texture), a->bindingCache());
    }

    // Copies one array slice of a texture, stretched, into a rectangle of the framebuffer (pixels).
    void Donut_BlitTextureSlice(void* app, void* frame, void* texture, int arraySlice,
        double left, double top, double width, double height)
    {
        App* a = AsApp(app);
        FrameContext* ctx = AsFrame(frame);

        donut::engine::BlitParameters params;
        params.targetFramebuffer = ctx->framebuffer;
        params.targetViewport = nvrhi::Viewport(float(left), float(left + width), float(top), float(top + height), 0.f, 1.f);
        params.sourceTexture = static_cast<nvrhi::ITexture*>(texture);
        params.sourceArraySlice = static_cast<uint32_t>(arraySlice);
        a->commonPasses()->BlitTexture(ctx->commandList, params, a->bindingCache());
    }

    // Drops the binding sets Donut_BlitTexture cached, and with them their references to the
    // blitted textures.
    void Donut_ClearBindingCache(void* app)
    {
        AsApp(app)->bindingCache()->Clear();
    }

    // The frame's open command list, for the command list functions (e.g. Donut_WriteBuffer).
    // Don't open, close or execute it: the pass does.
    void* Donut_GetFrameCommandList(void* frame)
    {
        return AsFrame(frame)->commandList;
    }

    // Starts describing a draw with a graphics pipeline, over the whole framebuffer; add to it
    // with the Donut_Draw* functions, then issue it with Donut_DrawIndexed.
    void Donut_BeginDraw(void* frame, void* pipeline)
    {
        FrameContext* ctx = AsFrame(frame);
        ctx->draw = nvrhi::GraphicsState();
        ctx->draw.pipeline = static_cast<nvrhi::IGraphicsPipeline*>(pipeline);
        ctx->draw.framebuffer = ctx->framebuffer;
    }

    // Same, into another framebuffer (Donut_CreateFramebuffer; the pipeline must be for its layout).
    void Donut_BeginDrawToFramebuffer(void* frame, void* pipeline, void* framebuffer)
    {
        FrameContext* ctx = AsFrame(frame);
        ctx->draw = nvrhi::GraphicsState();
        ctx->draw.pipeline = static_cast<nvrhi::IGraphicsPipeline*>(pipeline);
        ctx->draw.framebuffer = static_cast<nvrhi::IFramebuffer*>(framebuffer);
    }

    void Donut_DrawAddBindingSet(void* frame, void* bindingSet)
    {
        AsFrame(frame)->draw.bindings.push_back(static_cast<nvrhi::IBindingSet*>(bindingSet));
    }

    // R32_UINT indices.
    void Donut_DrawSetIndexBuffer(void* frame, void* indexBuffer)
    {
        AsFrame(frame)->draw.indexBuffer = { AsBuffer(indexBuffer), nvrhi::Format::R32_UINT, 0 };
    }

    // R16_UINT indices.
    void Donut_DrawSetIndexBuffer16(void* frame, void* indexBuffer)
    {
        AsFrame(frame)->draw.indexBuffer = { AsBuffer(indexBuffer), nvrhi::Format::R16_UINT, 0 };
    }

    // Binds a vertex buffer, starting at byteOffset, to the input layout's slot.
    void Donut_DrawAddVertexBuffer(void* frame, void* vertexBuffer, int slot, int byteOffset)
    {
        AsFrame(frame)->draw.vertexBuffers.push_back(
            { AsBuffer(vertexBuffer), static_cast<uint32_t>(slot), static_cast<uint64_t>(byteOffset) });
    }

    // Draws into this rectangle of the framebuffer (in pixels) instead of all of it.
    void Donut_DrawSetViewport(void* frame, double left, double top, double width, double height)
    {
        const nvrhi::Viewport viewport(float(left), float(left + width), float(top), float(top + height), 0.f, 1.f);
        AsFrame(frame)->draw.viewport = nvrhi::ViewportState().addViewportAndScissorRect(viewport);
    }

    void Donut_DrawIndexed(void* frame, int indexCount)
    {
        FrameContext* ctx = AsFrame(frame);
        if (ctx->draw.viewport.viewports.empty())
            ctx->draw.viewport.addViewportAndScissorRect(ctx->draw.framebuffer->getFramebufferInfo().getViewport());
        ctx->commandList->setGraphicsState(ctx->draw);

        nvrhi::DrawArguments args;
        args.vertexCount = static_cast<uint32_t>(indexCount);
        ctx->commandList->drawIndexed(args);
    }

    // Same, instanceCount times (instance attributes advance per instance).
    void Donut_DrawIndexedInstanced(void* frame, int indexCount, int instanceCount)
    {
        FrameContext* ctx = AsFrame(frame);
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
    void Donut_DrawIndexedWithPushConstants(void* frame, int indexCount, const void* data, int byteSize)
    {
        FrameContext* ctx = AsFrame(frame);
        if (ctx->draw.viewport.viewports.empty())
            ctx->draw.viewport.addViewportAndScissorRect(ctx->draw.framebuffer->getFramebufferInfo().getViewport());
        // NVRHI skips the parts of the state that haven't changed since the previous draw.
        ctx->commandList->setGraphicsState(ctx->draw);
        ctx->commandList->setPushConstants(data, static_cast<size_t>(byteSize));

        nvrhi::DrawArguments args;
        args.vertexCount = static_cast<uint32_t>(indexCount);
        ctx->commandList->drawIndexed(args);
    }

    // Copies a texture of the back buffer's size and a compatible format (e.g. RGBA8_UNORM) into
    // the back buffer, without conversion.
    void Donut_CopyTextureToFrame(void* frame, void* texture)
    {
        FrameContext* ctx = AsFrame(frame);
        ctx->commandList->copyTexture(ctx->framebuffer->getDesc().colorAttachments[0].texture, nvrhi::TextureSlice(),
            static_cast<nvrhi::ITexture*>(texture), nvrhi::TextureSlice());
    }

    // Same as Donut_DrawIndexed, without an index buffer: vertexCount vertices.
    void Donut_DrawVertices(void* frame, int vertexCount)
    {
        FrameContext* ctx = AsFrame(frame);
        if (ctx->draw.viewport.viewports.empty())
            ctx->draw.viewport.addViewportAndScissorRect(ctx->draw.framebuffer->getFramebufferInfo().getViewport());
        ctx->commandList->setGraphicsState(ctx->draw);

        nvrhi::DrawArguments args;
        args.vertexCount = static_cast<uint32_t>(vertexCount);
        ctx->commandList->draw(args);
    }

    int Donut_GetFrameWidth(void* frame)
    {
        return static_cast<int>(AsFrame(frame)->framebuffer->getFramebufferInfo().width);
    }

    int Donut_GetFrameHeight(void* frame)
    {
        return static_cast<int>(AsFrame(frame)->framebuffer->getFramebufferInfo().height);
    }
}
