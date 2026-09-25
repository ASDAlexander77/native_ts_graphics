// Flat C API over Donut for mycode.ts.
//
// TSLANG's `declare function` binds by literal symbol name only (no C++ name mangling),
// and it can't express virtual overrides, smart pointers or STL types, so everything the
// TypeScript side needs goes through the extern "C" functions below, using opaque handles
// and plain scalars.
//
// C++ owns the application (device manager, window, message loop, teardown order);
// TypeScript only supplies render passes, as objects whose methods are the callbacks.
//
// Callbacks: a TypeScript method passed as a callback (`this.onRender`) arrives here as
// two arguments: a function pointer taking `this` first, then the `this` value itself
// (the same lowering tslang's Win32 sample relies on). The TypeScript object is referenced
// only from C++ heap memory here, which the GC does not scan, so the TypeScript side must
// keep it alive (e.g. in a module-level variable) until Donut_RunApp returns.

#include <donut/app/ApplicationBase.h>
#include <donut/app/DeviceManager.h>
#include <donut/core/log.h>
#include <nvrhi/utils.h>

#include <GLFW/glfw3.h>

#include <memory>
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

        bool KeyboardUpdate(int key, int scancode, int action, int mods) override
        {
            return m_Keyboard && m_Keyboard.method(m_Keyboard.thisVal, key, scancode, action, mods) != 0;
        }

        bool ShouldAnimateUnfocused() override { return m_RunWhenUnfocused; }
        bool ShouldRenderUnfocused() override { return m_RunWhenUnfocused; }

        bool m_RunWhenUnfocused = false;
        Callback<RenderFn> m_Render;
        Callback<AnimateFn> m_Animate;
        Callback<KeyboardFn> m_Keyboard;

    private:
        nvrhi::CommandListHandle m_CommandList;
    };

    struct App
    {
        std::unique_ptr<DeviceManager> deviceManager;
        std::vector<std::unique_ptr<TsRenderPass>> passes;

        ~App()
        {
            // Passes hold GPU resources owned by the device, so they go first.
            for (auto& pass : passes)
                deviceManager->RemoveRenderPass(pass.get());
            passes.clear();

            deviceManager->Shutdown();
        }
    };

    App* AsApp(void* app) { return static_cast<App*>(app); }
    TsRenderPass* AsPass(void* pass) { return static_cast<TsRenderPass*>(pass); }
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
        return app;
    }

    // Blocks until the window is closed, then destroys the app and all its passes; the app
    // and pass handles are invalid afterwards.
    void Donut_RunApp(void* app)
    {
        AsApp(app)->deviceManager->RunMessageLoop();
        delete AsApp(app);
    }

    const char* Donut_GetRendererString(void* app)
    {
        return AsApp(app)->deviceManager->GetRendererString();
    }

    void Donut_SetWindowTitle(void* app, const char* title)
    {
        AsApp(app)->deviceManager->SetWindowTitle(title);
    }

    // Makes Donut_RunApp return after the current frame.
    void Donut_CloseWindow(void* app)
    {
        glfwSetWindowShouldClose(AsApp(app)->deviceManager->GetWindow(), GLFW_TRUE);
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

    // Keys go to the most recently added pass first; the callback returns non-zero if it
    // handled the key, and then passes added before it don't see it.
    void Donut_SetKeyboardCallback(void* pass, KeyboardFn method, void* thisVal)
    {
        AsPass(pass)->m_Keyboard = { method, thisVal };
    }

    // --- Frame commands (valid only inside the render callback) ----------------------------

    void Donut_ClearColor(void* frame, double r, double g, double b, double a)
    {
        auto* ctx = static_cast<FrameContext*>(frame);
        nvrhi::utils::ClearColorAttachment(ctx->commandList, ctx->framebuffer, 0,
            nvrhi::Color(float(r), float(g), float(b), float(a)));
    }

    int Donut_GetFrameWidth(void* frame)
    {
        return static_cast<int>(static_cast<FrameContext*>(frame)->framebuffer->getFramebufferInfo().width);
    }

    int Donut_GetFrameHeight(void* frame)
    {
        return static_cast<int>(static_cast<FrameContext*>(frame)->framebuffer->getFramebufferInfo().height);
    }
}
