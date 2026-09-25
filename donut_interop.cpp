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
#include <donut/core/log.h>
#include <donut/core/vfs/VFS.h>
#include <donut/engine/BindingCache.h>
#include <donut/engine/CommonRenderPasses.h>
#include <donut/engine/ShaderFactory.h>
#include <donut/engine/TextureCache.h>
#include <donut/engine/FramebufferFactory.h>
#include <donut/engine/Scene.h>
#include <donut/engine/ThreadPool.h>
#include <donut/engine/View.h>
#include <donut/render/DrawStrategy.h>
#include <donut/render/ForwardShadingPass.h>
#include <donut/render/GeometryPasses.h>
#include <nvrhi/utils.h>

#include <GLFW/glfw3.h>

#include <cstring>
#include <memory>
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

    // Passed to the TypeScript render callback; only valid for the duration of that call.
    struct FrameContext
    {
        nvrhi::ICommandList* commandList;
        nvrhi::IFramebuffer* framebuffer;
        // Built up by Donut_BeginDraw / Donut_Draw* and used by Donut_DrawIndexed.
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
                FrameContext frame{ m_CommandList, framebuffer };
                m_Render.method(m_Render.thisVal, &frame);
            }

            m_CommandList->close();
            GetDevice()->executeCommandList(m_CommandList);
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

        bool ShouldAnimateUnfocused() override { return m_RunWhenUnfocused; }
        bool ShouldRenderUnfocused() override { return m_RunWhenUnfocused; }

        bool m_RunWhenUnfocused = false;
        Callback<RenderFn> m_Render;
        Callback<AnimateFn> m_Animate;
        Callback<VoidFn> m_BackBufferResizing;
        Callback<KeyboardFn> m_Keyboard;
        Callback<MousePosFn> m_MousePos;
        Callback<MouseButtonFn> m_MouseButton;

    private:
        nvrhi::CommandListHandle m_CommandList;
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

        nvrhi::IDevice* device() const { return deviceManager->GetDevice(); }

        template <typename T>
        T* OwnObject(std::shared_ptr<T> object)
        {
            T* raw = object.get();
            if (raw)
                objects.emplace(raw, std::move(object));
            return raw;
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

            for (auto& pass : passes)
                deviceManager->RemoveRenderPass(pass.get());
            passes.clear();
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

    std::filesystem::path GetExecutablePath()
    {
#ifdef _WIN32
        wchar_t path[MAX_PATH] = {};
        GetModuleFileNameW(nullptr, path, MAX_PATH);
        return std::filesystem::path(path);
#else
        return std::filesystem::read_symlink("/proc/self/exe");
#endif
    }

    // Each example executable loads its shaders from bin/shaders/<executable name>/<api>, and
    // Donut's own from bin/shaders/framework/<api> (DONUT_SHADERS_OUTPUT_DIR in CMakeLists.txt).
    App* MakeApp(std::unique_ptr<DeviceManager> deviceManager, nvrhi::GraphicsAPI api)
    {
        const std::filesystem::path exe = GetExecutablePath();
        const std::filesystem::path shaders = exe.parent_path() / "shaders";
        const char* shaderType = donut::app::GetShaderTypeName(api);

        auto rootFS = std::make_shared<donut::vfs::RootFileSystem>();
        rootFS->mount("/shaders/donut", shaders / "framework" / shaderType);
        rootFS->mount("/shaders/app", shaders / exe.stem() / shaderType);

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
}

// donut_interop.d.ts mirrors these enum values as plain numbers.
static_assert(int(nvrhi::GraphicsAPI::D3D11) == 0 && int(nvrhi::GraphicsAPI::D3D12) == 1 && int(nvrhi::GraphicsAPI::VULKAN) == 2);
static_assert(int(nvrhi::Feature::Meshlets) == 9 && int(nvrhi::Feature::RayTracingPipeline) == 14
    && int(nvrhi::Feature::ShaderSpecializations) == 18);
static_assert(int(nvrhi::ShaderType::Vertex) == 0x1 && int(nvrhi::ShaderType::Pixel) == 0x10
    && int(nvrhi::ShaderType::Compute) == 0x20 && int(nvrhi::ShaderType::Amplification) == 0x40
    && int(nvrhi::ShaderType::Mesh) == 0x80 && int(nvrhi::ShaderType::All) == 0x3FFF);
static_assert(int(nvrhi::Format::R32_UINT) == 33 && int(nvrhi::Format::RG32_FLOAT) == 43
    && int(nvrhi::Format::RGB32_FLOAT) == 46);
static_assert(int(donut::log::Severity::None) == 0 && int(donut::log::Severity::Fatal) == 5);

extern "C"
{
    // --- Application -----------------------------------------------------------------------

    // Values of the `options` bit mask of Donut_CreateAppWithOptions.
    enum AppOptions
    {
        AppOption_RayTracing = 1, // enables the Vulkan ray tracing extensions (D3D12 has them built in)
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
        params.vsyncEnabled = true;
        params.enableRayTracingExtensions = (options & AppOption_RayTracing) != 0;

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

    // Loads a shader library (compiled with -T lib) from the example's shaders/<example>.cfg.
    // Returns null on failure.
    void* Donut_CreateShaderLibrary(void* app, const char* fileName)
    {
        App* a = AsApp(app);
        const std::string path = std::string("app/") + fileName;
        return a->Own(a->shaderFactory->CreateShaderLibrary(path.c_str(), nullptr));
    }

    // Ray tracing pipeline with one ray generation shader, one miss shader and one triangle hit
    // group made of a closest-hit shader, all exported from shaderLibrary by entry name, and one
    // global binding layout. Returns null on failure.
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
            .setClosestHitShader(library->getShader(closestHitEntry, nvrhi::ShaderType::ClosestHit)) };
        desc.maxPayloadSize = static_cast<uint32_t>(maxPayloadSize);

        App* a = AsApp(app);
        return a->Own(a->device()->createRayTracingPipeline(desc));
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
    void* Donut_CreateUAVTextureForFrame(void* app, void* frame, const char* debugName)
    {
        nvrhi::TextureDesc desc = AsFrame(frame)->framebuffer->getDesc().colorAttachments[0].texture->getDesc();
        desc.isUAV = true;
        desc.isRenderTarget = false;
        desc.initialState = nvrhi::ResourceStates::UnorderedAccess;
        desc.keepInitialState = true;
        desc.format = nvrhi::Format::RGBA8_UNORM;
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

    // Layout (register space 0) visible to the stages in shaderType (nvrhi::ShaderType bits).
    // Returns null on failure.
    void* Donut_CreateBindingLayout(void* app, void* bindingLayoutDesc, int shaderType)
    {
        std::unique_ptr<nvrhi::BindingLayoutDesc> desc(static_cast<nvrhi::BindingLayoutDesc*>(bindingLayoutDesc));
        desc->visibility = static_cast<nvrhi::ShaderType>(shaderType);
        App* a = AsApp(app);
        return a->Own(a->device()->createBindingLayout(*desc));
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

    void Donut_Dispatch(void* commandList, void* computePipeline, void* bindingSet, int groupsX, int groupsY, int groupsZ)
    {
        auto state = nvrhi::ComputeState()
            .setPipeline(static_cast<nvrhi::IComputePipeline*>(computePipeline))
            .addBindingSet(static_cast<nvrhi::IBindingSet*>(bindingSet));

        nvrhi::ICommandList* cl = AsCommandList(commandList);
        cl->setComputeState(state);
        cl->dispatch(static_cast<uint32_t>(groupsX), static_cast<uint32_t>(groupsY), static_cast<uint32_t>(groupsZ));
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
        auto nativeFS = std::make_shared<donut::vfs::NativeFileSystem>();
        auto scene = std::make_shared<donut::engine::Scene>(a->device(), *a->shaderFactory, nativeFS,
            a->textureCache(), nullptr, nullptr);

        if (!scene->LoadWithThreadPool(GetExecutablePath().parent_path() / path, a->threadPool()))
            return nullptr;

        // What ApplicationBase::SceneLoaded does after a synchronous load.
        a->textureCache()->ProcessRenderingThreadCommands(*a->commonPasses(), 0.f);
        a->textureCache()->LoadingFinished();

        scene->FinishedLoading(a->deviceManager->GetFrameIndex());
        return a->OwnObject(scene);
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
        target->view.SetTransform(static_cast<donut::app::FirstPersonCamera*>(camera)->GetWorldToViewMatrix(),
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
        return AsApp(app)->OwnObject(std::make_shared<donut::app::FirstPersonCamera>());
    }

    void Donut_CameraLookAt(void* camera, double posX, double posY, double posZ, double targetX, double targetY, double targetZ)
    {
        static_cast<donut::app::FirstPersonCamera*>(camera)->LookAt(
            dm::float3(float(posX), float(posY), float(posZ)), dm::float3(float(targetX), float(targetY), float(targetZ)));
    }

    // In units per second.
    void Donut_CameraSetMoveSpeed(void* camera, double speed)
    {
        static_cast<donut::app::FirstPersonCamera*>(camera)->SetMoveSpeed(float(speed));
    }

    // Forward the pass input callbacks' arguments to these.
    void Donut_CameraKeyboardUpdate(void* camera, int key, int scancode, int action, int mods)
    {
        static_cast<donut::app::FirstPersonCamera*>(camera)->KeyboardUpdate(key, scancode, action, mods);
    }

    void Donut_CameraMousePosUpdate(void* camera, double x, double y)
    {
        static_cast<donut::app::FirstPersonCamera*>(camera)->MousePosUpdate(x, y);
    }

    void Donut_CameraMouseButtonUpdate(void* camera, int button, int action, int mods)
    {
        static_cast<donut::app::FirstPersonCamera*>(camera)->MouseButtonUpdate(button, action, mods);
    }

    void Donut_CameraAnimate(void* camera, double elapsedSeconds)
    {
        static_cast<donut::app::FirstPersonCamera*>(camera)->Animate(float(elapsedSeconds));
    }

    // --- Frame commands (valid only inside the render callback) ----------------------------

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

    void Donut_DrawAddBindingSet(void* frame, void* bindingSet)
    {
        AsFrame(frame)->draw.bindings.push_back(static_cast<nvrhi::IBindingSet*>(bindingSet));
    }

    // R32_UINT indices.
    void Donut_DrawSetIndexBuffer(void* frame, void* indexBuffer)
    {
        AsFrame(frame)->draw.indexBuffer = { AsBuffer(indexBuffer), nvrhi::Format::R32_UINT, 0 };
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
            ctx->draw.viewport.addViewportAndScissorRect(ctx->framebuffer->getFramebufferInfo().getViewport());
        ctx->commandList->setGraphicsState(ctx->draw);

        nvrhi::DrawArguments args;
        args.vertexCount = static_cast<uint32_t>(indexCount);
        ctx->commandList->drawIndexed(args);
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
