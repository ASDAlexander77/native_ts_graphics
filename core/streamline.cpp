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

#include <donut/app/DeviceManager.h>
#include <donut/core/log.h>
#include <nvrhi/nvrhi.h>

#include <cstdint>
#include <cstring>
#include <filesystem>
#include <functional>
#include <map>
#include <string>
#include <vector>

#include "donut_api.h"

#include <windows.h>

#include <sl.h>
#include <sl_consts.h>
#include <sl_helpers.h>
#include <sl_security.h>

// The hook Donut_CreateAppWithOptions calls with AppOptions.Streamline (core/donut_interop.cpp).
namespace donut_interop
{
    extern std::function<void(nvrhi::GraphicsAPI, donut::app::DeviceCreationParameters&)> g_StreamlineConfigureDevice;
}

// core/donut_interop.cpp's app and its NVRHI device.
struct App;
extern "C" void* Donut_GetNvrhiDevice(App* app);

namespace
{
    // The sample's (and its NGX) application id.
    constexpr uint32_t kApplicationId = 231313132;

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
        PFunD3D12CreateDevice* d3d12CreateDevice = nullptr;
        PFunCreateDXGIFactory2* createDxgiFactory2 = nullptr;
        PFN_vkGetInstanceProcAddr vkGetInstanceProcAddr = nullptr;

        // Streamline_FeatureStatusText's: by feature, what Streamline_IsFeatureSupported found last.
        std::map<uint32_t, std::string> status;
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
            && GetExport(g_Streamline.slSetFeatureLoaded, "slSetFeatureLoaded");
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
        return result == sl::Result::eOk ? 1 : 0;
    }

    // Why Streamline_IsFeatureSupported said what it did for the feature (tslang copies the string).
    DONUT_API const char* Streamline_FeatureStatusText(int feature)
    {
        auto it = g_Streamline.status.find(static_cast<uint32_t>(feature));
        return it != g_Streamline.status.end() ? it->second.c_str() : "not queried";
    }

    // Shuts Streamline down, before the app's device is destroyed (see streamline.d.ts).
    DONUT_API void Streamline_Shutdown()
    {
        if (!g_Streamline.initialized)
            return;
        // No resource is tagged yet (the evaluations come with the demo's frame); slShutdown drops Streamline's
        // tags and the plugins' resources.
        const sl::Result result = g_Streamline.slShutdown();
        if (result != sl::Result::eOk)
            donut::log::warning("Streamline: slShutdown: %s", sl::getResultAsStr(result));
        g_Streamline.initialized = false;
        donut_interop::g_StreamlineConfigureDevice = nullptr;
        // The interposer stays loaded: the app's D3D12 device is its proxy until Donut_DestroyApp.
    }
}
