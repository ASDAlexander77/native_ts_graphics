// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";
import { Args } from "../core/args";
import { unsupported } from "../core/test_check";

// NVIDIA Streamline (github.com/NVIDIA-RTX/Streamline) on Donut: core/streamline.cpp loads its interposer and
// plugins from bin/streamline/ and hooks the app's device creation (AppOptions.Streamline). So far this starts
// Streamline, creates the device through it and reports which of its features this GPU and driver support.
namespace StreamlineDemo {
    // Test mode: the frames rendered (a clear: the device made through Streamline renders).
    const TEST_FRAMES = 4;

    const WINDOW_TITLE = "Donut Example: Streamline";

    class StreamlineDemoArgs extends Args {
        width: int = 1920;
        height: int = 1080;
        // -slDisable: without Streamline (no Streamline_Init): every feature reports unsupported.
        slDisable: boolean = false;
        // -latewarp: Latewarp instead of DLSS-G (not in Streamline 2.12.0: Streamline_Init fails).
        latewarp: boolean = false;
        // -slLog: Streamline's log in the console.
        slLog: boolean = false;

        protected parseOptions() {
            for (let i = 1; i < this.argc; i++) {
                const arg = this[i];
                if (arg == "-width" && i + 1 < this.argc) {
                    this.width = parseInt(this[i + 1]);
                } else if (arg == "-height" && i + 1 < this.argc) {
                    this.height = parseInt(this[i + 1]);
                } else if (arg == "-slDisable") {
                    this.slDisable = true;
                } else if (arg == "-latewarp") {
                    this.latewarp = true;
                } else if (arg == "-slLog") {
                    this.slLog = true;
                }
            }
        }
    }

    // A frame cleared to black: the device Streamline made renders and presents (reads back, under -test).
    class ClearPass {
        constructor(private app: App) {
        }

        init() {
            const pass = this.app.addPass();
            pass.setRenderCallback(this.onRender);
        }

        onRender(frameHandle: FrameHandle) {
            const frame = new Frame(frameHandle);
            frame.clearColor(0.0, 0.0, 0.0, 0.0);
        }
    }

    // The features the demo reports, by name, and those -test needs (DLSS-G and PCL depend on the GPU
    // generation and on a swap chain, Latewarp isn't in 2.12.0: reported only).
    const FEATURE_NAMES = ["DLSS", "DLSS_RR", "DeepDVC", "Reflex", "PCL", "DLSS_G", "Latewarp"];
    const FEATURES = [StreamlineFeature.DLSS, StreamlineFeature.DLSS_RR, StreamlineFeature.DeepDVC,
        StreamlineFeature.Reflex, StreamlineFeature.PCL, StreamlineFeature.DLSS_G, StreamlineFeature.Latewarp];
    const REQUIRED_FEATURES = 4;

    export function main(argc: int, argv: Ref<string>) {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Program.setAppName("streamline_demo");

        const args = new StreamlineDemoArgs(argc, argv, TEST_FRAMES);
        args.parseArgs();

        // Streamline before the device: its plugins from bin/streamline/ (next to the executable, or to
        // donut_interop_shared.dll under the JIT).
        let slInitialized = false;
        if (!args.slDisable) {
            slInitialized = Streamline_Init(args.api, "", args.latewarp ? 1 : 0, args.slLog ? 1 : 0) != 0;
            if (!slInitialized) {
                console.log("Streamline: not initialized (see the log above)");
            }
        }

        const app = App.createWithOptions(args.api, WINDOW_TITLE, args.width, args.height,
            args.options | AppOptions.Streamline);
        if (app.isNull()) {
            Streamline_Shutdown();
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        // One line a feature: "<name>: supported" or "<name>: <why not>".
        let missing = "";
        let supportedCount = 0;
        for (let i = 0; i < FEATURES.length; i++) {
            const supported = Streamline_IsFeatureSupported(app.handle, FEATURES[i]) != 0;
            const status = supported ? "supported" : Streamline_FeatureStatusText(FEATURES[i]);
            console.log(`${FEATURE_NAMES[i]}: ${status}`);
            if (supported) {
                supportedCount++;
            } else if (i < REQUIRED_FEATURES) {
                missing = missing == "" ? FEATURE_NAMES[i] : `${missing}, ${FEATURE_NAMES[i]}`;
            }
        }

        const clear = new ClearPass(app);
        clear.init();
        const input = new InputPass(app.handle);
        app.run();

        let result = 0;
        if (args.test) {
            if (!args.slDisable && !slInitialized) {
                // Streamline starts on any GPU (its features may not be supported): failing to is an error, but
                // Latewarp's, which this SDK hasn't.
                result = args.latewarp ? unsupported(true, "Latewarp: not in Streamline 2.12.0")
                    : app.finishTest("Streamline_Init failed");
            } else if (!slInitialized) {
                // Without Streamline nothing may report supported.
                result = supportedCount == 0 ? unsupported(true, "Streamline is not initialized")
                    : app.finishTest(`${supportedCount} features report supported without Streamline`);
            } else if (missing != "") {
                result = unsupported(true, `not supported here: ${missing}`);
            } else {
                result = app.finishTest("");
            }
        }

        // Streamline goes before the device it hooks.
        Streamline_Shutdown();
        app.destroy();
        return result;
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return StreamlineDemo.main(argc, argv);
}
