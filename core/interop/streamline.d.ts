/// <reference path="../donut_handles.d.ts" />
/// <reference path="app.d.ts" />
// NVIDIA Streamline (core/streamline.cpp; the streamline_demo example links it, with WITH_STREAMLINE)

// Streamline's features (sl::kFeature* in sl_core_types.h).
enum StreamlineFeature {
    DLSS = 0,
    Reflex = 3,
    PCL = 4,
    DeepDVC = 5,
    Latewarp = 6,
    DLSS_G = 1000,
    DLSS_RR = 1001
}

// Starts Streamline, before the app (Donut_CreateAppWithOptions with AppOptions.Streamline, whose device it
// then makes): loads pluginDir/sl.interposer.dll (empty: bin/streamline/ next to the executable, or to
// donut_interop_shared.dll under the JIT) after checking its signature, and its plugins (DLSS, DLSS-RR, DeepDVC,
// Reflex, PCL, and DLSS-G or with latewarp != 0 Latewarp, which Streamline 2.12.0 doesn't have: then it fails).
// log != 0: Streamline's log in the console. Non-zero on success; logs why not.
@nodrops declare function Streamline_Init(api: GraphicsAPI, pluginDir: string, latewarp: int, log: int): int;
// Non-zero if the app's adapter (GPU, driver, OS) supports the feature; zero also without Streamline_Init.
@nodrops declare function Streamline_IsFeatureSupported(app: AppHandle, feature: StreamlineFeature): int;
// Why the last Streamline_IsFeatureSupported of the feature said what it did ("supported", or Streamline's
// reason, e.g. "eErrorNoSupportedAdapterFound").
@nodrops declare function Streamline_FeatureStatusText(feature: StreamlineFeature): string;
// Clears the resource tags and shuts Streamline down: before Donut_DestroyApp. Nothing without Streamline_Init.
@nodrops declare function Streamline_Shutdown(): void;
