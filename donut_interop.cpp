// Flat C API over Donut for mycode.ts.
//
// TSLANG's `declare function` binds by literal symbol name only (no C++ name mangling),
// and it can't express virtual overrides, smart pointers or STL types, so everything the
// TypeScript side needs goes through the extern "C" functions below, using opaque handles
// and plain scalars.
//
// Callbacks: a TypeScript method passed as a callback (`this.onRender`) arrives here as
// two arguments: a function pointer taking `this` first, then the `this` value itself
// (the same lowering tslang's Win32 sample relies on). The TypeScript object is referenced
// only from C++ heap memory here, which the GC does not scan, so the TypeScript side must
// keep it alive (e.g. in a module-level variable) for as long as the pass exists.

#include <donut/app/ApplicationBase.h>
#include <donut/app/DeviceManager.h>
#include <donut/core/log.h>
#include <nvrhi/utils.h>

#include <GLFW/glfw3.h>

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

    class TsRenderPass;

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
}

extern "C"
{
    int Donut_GetGraphicsAPIFromCommandLine(int argc, const char* const* argv)
    {
        return static_cast<int>(donut::app::GetGraphicsAPIFromCommandLine(argc, argv));
    }

    // --- Device manager / window ---------------------------------------------------------

    // Returns null on failure (unsupported API, no adapter, window creation failed).
    void* Donut_CreateDeviceManager(int graphicsApi, int width, int height, const char* title)
    {
        // Console app: log to the console instead of Donut's default modal MessageBox on errors.
        donut::log::ConsoleApplicationMode();

        DeviceManager* deviceManager = DeviceManager::Create(static_cast<nvrhi::GraphicsAPI>(graphicsApi));
        if (!deviceManager)
            return nullptr;

        donut::app::DeviceCreationParameters params;
        params.backBufferWidth = static_cast<uint32_t>(width);
        params.backBufferHeight = static_cast<uint32_t>(height);
        params.vsyncEnabled = true;

        if (!deviceManager->CreateWindowDeviceAndSwapChain(params, title))
        {
            donut::log::error("Donut_CreateDeviceManager: cannot initialize the graphics device");
            delete deviceManager;
            return nullptr;
        }

        return deviceManager;
    }

    const char* Donut_GetRendererString(void* deviceManager)
    {
        return static_cast<DeviceManager*>(deviceManager)->GetRendererString();
    }

    void Donut_SetWindowTitle(void* deviceManager, const char* title)
    {
        static_cast<DeviceManager*>(deviceManager)->SetWindowTitle(title);
    }

    void Donut_CloseWindow(void* deviceManager)
    {
        glfwSetWindowShouldClose(static_cast<DeviceManager*>(deviceManager)->GetWindow(), GLFW_TRUE);
    }

    // Blocks until the window is closed.
    void Donut_RunMessageLoop(void* deviceManager)
    {
        static_cast<DeviceManager*>(deviceManager)->RunMessageLoop();
    }

    // Destroy all render passes first: they hold GPU resources owned by this device.
    void Donut_DestroyDeviceManager(void* deviceManager)
    {
        auto* dm = static_cast<DeviceManager*>(deviceManager);
        dm->Shutdown();
        delete dm;
    }

    // --- Render pass ---------------------------------------------------------------------

    // Created and registered with the device manager (drawn after previously added passes).
    void* Donut_CreateRenderPass(void* deviceManager)
    {
        auto* dm = static_cast<DeviceManager*>(deviceManager);
        auto* pass = new TsRenderPass(dm);
        dm->AddRenderPassToBack(pass);
        return pass;
    }

    void Donut_DestroyRenderPass(void* deviceManager, void* pass)
    {
        auto* renderPass = static_cast<TsRenderPass*>(pass);
        static_cast<DeviceManager*>(deviceManager)->RemoveRenderPass(renderPass);
        delete renderPass;
    }

    // By default (as in Donut) animation and rendering pause while the window is unfocused.
    void Donut_SetRunWhenUnfocused(void* pass, int enabled)
    {
        static_cast<TsRenderPass*>(pass)->m_RunWhenUnfocused = enabled != 0;
    }

    void Donut_SetRenderCallback(void* pass, RenderFn method, void* thisVal)
    {
        static_cast<TsRenderPass*>(pass)->m_Render = { method, thisVal };
    }

    void Donut_SetAnimateCallback(void* pass, AnimateFn method, void* thisVal)
    {
        static_cast<TsRenderPass*>(pass)->m_Animate = { method, thisVal };
    }

    // The callback returns non-zero if it handled the key.
    void Donut_SetKeyboardCallback(void* pass, KeyboardFn method, void* thisVal)
    {
        static_cast<TsRenderPass*>(pass)->m_Keyboard = { method, thisVal };
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
