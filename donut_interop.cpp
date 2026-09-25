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
#include <donut/app/DeviceManager.h>
#include <donut/core/log.h>
#include <donut/core/vfs/VFS.h>
#include <donut/engine/ShaderFactory.h>
#include <nvrhi/utils.h>

#include <GLFW/glfw3.h>

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

    // Passed to the TypeScript render callback; only valid for the duration of that call.
    struct FrameContext
    {
        nvrhi::ICommandList* commandList;
        nvrhi::IFramebuffer* framebuffer;
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

        bool ShouldAnimateUnfocused() override { return m_RunWhenUnfocused; }
        bool ShouldRenderUnfocused() override { return m_RunWhenUnfocused; }

        bool m_RunWhenUnfocused = false;
        Callback<RenderFn> m_Render;
        Callback<AnimateFn> m_Animate;
        Callback<VoidFn> m_BackBufferResizing;
        Callback<KeyboardFn> m_Keyboard;

    private:
        nvrhi::CommandListHandle m_CommandList;
    };

    struct App
    {
        std::unique_ptr<DeviceManager> deviceManager;
        std::unique_ptr<donut::engine::ShaderFactory> shaderFactory;
        std::vector<std::unique_ptr<TsRenderPass>> passes;
        // GPU resources handed to TypeScript as raw pointers; the app holds the reference.
        std::unordered_map<nvrhi::IResource*, nvrhi::RefCountPtr<nvrhi::IResource>> resources;

        nvrhi::IDevice* device() const { return deviceManager->GetDevice(); }

        void* Own(nvrhi::IResource* resource)
        {
            if (!resource)
                return nullptr;
            resources.emplace(resource, resource);
            return resource;
        }

        ~App()
        {
            // Everything created on the device goes before the device itself.
            device()->waitForIdle();

            for (auto& pass : passes)
                deviceManager->RemoveRenderPass(pass.get());
            passes.clear();
            resources.clear();
            shaderFactory.reset();

            deviceManager->Shutdown();
        }
    };

    // Each example executable loads its shaders from bin/shaders/<executable name>/<api>.
    std::filesystem::path GetShaderPath(nvrhi::GraphicsAPI api)
    {
#ifdef _WIN32
        wchar_t path[MAX_PATH] = {};
        GetModuleFileNameW(nullptr, path, MAX_PATH);
        const std::filesystem::path exe(path);
#else
        const std::filesystem::path exe = std::filesystem::read_symlink("/proc/self/exe");
#endif
        return exe.parent_path() / "shaders" / exe.stem() / donut::app::GetShaderTypeName(api);
    }

    App* AsApp(void* app) { return static_cast<App*>(app); }
    TsRenderPass* AsPass(void* pass) { return static_cast<TsRenderPass*>(pass); }
    FrameContext* AsFrame(void* frame) { return static_cast<FrameContext*>(frame); }
}

extern "C"
{
    // --- Application -----------------------------------------------------------------------

    // Picks the graphics API from the command line (-d3d11, -d3d12, -vk; D3D12 by default on
    // Windows) and creates the device and window. Returns null on failure.
    void* Donut_CreateApp(int argc, const char* const* argv, const char* title, int width, int height)
    {
        // Console app: log to the console instead of Donut's default modal MessageBox on errors.
        donut::log::ConsoleApplicationMode();

        const nvrhi::GraphicsAPI api = donut::app::GetGraphicsAPIFromCommandLine(argc, argv);
        std::unique_ptr<DeviceManager> deviceManager(DeviceManager::Create(api));
        if (!deviceManager)
            return nullptr;

        donut::app::DeviceCreationParameters params;
        params.backBufferWidth = static_cast<uint32_t>(width);
        params.backBufferHeight = static_cast<uint32_t>(height);
        params.vsyncEnabled = true;

        if (!deviceManager->CreateWindowDeviceAndSwapChain(params, title))
        {
            donut::log::error("Donut_CreateApp: cannot initialize the graphics device");
            return nullptr;
        }

        auto* app = new App();
        app->deviceManager = std::move(deviceManager);

        app->shaderFactory = std::make_unique<donut::engine::ShaderFactory>(
            app->device(), std::make_shared<donut::vfs::NativeFileSystem>(), GetShaderPath(api));

        return app;
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
        nvrhi::ShaderHandle shader = a->shaderFactory->CreateShader(
            fileName, entryName, nullptr, static_cast<nvrhi::ShaderType>(shaderType));
        return a->Own(shader);
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

    int Donut_GetFrameWidth(void* frame)
    {
        return static_cast<int>(AsFrame(frame)->framebuffer->getFramebufferInfo().width);
    }

    int Donut_GetFrameHeight(void* frame)
    {
        return static_cast<int>(AsFrame(frame)->framebuffer->getFramebufferInfo().height);
    }
}
