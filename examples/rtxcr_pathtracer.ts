// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";
import { Args } from "../core/args";
import { unsupported } from "../core/test_check";
import { RtxcrScene } from "../core/rtxcr_scene";

// Port of NVIDIA's RTX Character Rendering pathtracer sample (github.com/NVIDIA-RTX/RTXCR), which
// is under the NVIDIA RTX SDKs License: build with RTXCR_DIR set to a checkout (CMakeLists.txt) and
// run with --scene <RTXCR_DIR>/assets/claire.scene.json. This software contains source code
// provided by NVIDIA Corporation.
namespace RtxcrPathtracer {
    const WINDOW_TITLE = "RTX Character Rendering: Pathtracer";

    // The sample's TessellationType values.
    enum HairTessellation {
        Polytube = 0,
        Dots = 1,
        Lss = 2
    }

    // ui.hairRadiusScale of the sample.
    const HAIR_RADIUS_SCALE = 0.618;

    class RtxcrArgs extends Args {
        // -hairTessellationType <0 polytubes, 1 DOTS, 2 LSS>
        hairTessellationType: int = HairTessellation.Dots;

        protected parseOptions() {
            for (let i = 1; i + 1 < this.argc; i++) {
                if (this[i] == "-hairTessellationType") {
                    this.hairTessellationType = parseInt(this[i + 1]);
                }
            }
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        Donut_SetAppName("rtxcr_pathtracer");

        const args = new RtxcrArgs(argc, argv, 1);
        args.parseArgs();

        if (args.scenePath == "") {
            console.log("Pass the scene with --scene <RTXCR_DIR>/assets/claire.scene.json");
            return 1;
        }

        const app = App.createWithOptions(args.api, WINDOW_TITLE, 1920, 1080, AppOptions.RayTracing | args.options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }
        if (!app.isFeatureSupported(Feature.RayTracingPipeline)) {
            app.destroy();
            return unsupported(args.test, "The graphics device does not support Ray Tracing Pipelines");
        }
        console.log(`Renderer: ${app.getRendererString()}`);

        const bindlessLayoutDesc = BindlessLayoutDesc.create(0, 1024, ShaderType.All);
        bindlessLayoutDesc.addRawBuffers(2);
        bindlessLayoutDesc.addTextures(3);
        const bindlessLayout = app.createBindlessLayout(bindlessLayoutDesc);
        const descriptorTableManager = app.createDescriptorTableManager(bindlessLayout);

        const scene = app.loadSceneWithDescriptorTableDeferred(args.scenePath, descriptorTableManager);
        if (scene.isNull()) {
            console.log(`Cannot load the scene ${args.scenePath}`);
            app.destroy();
            return 1;
        }
        const rtxcrScene = RtxcrScene.create(app.getNvrhiDevice(), scene.handle, descriptorTableManager.handle, HAIR_RADIUS_SCALE,
            args.hairTessellationType);
        console.log(`Curve meshes: ${rtxcrScene.getCurveMeshCount()}`);

        const commandList = app.createCommandList();
        commandList.open();
        rtxcrScene.buildAccelStructs(commandList.handle, true);
        rtxcrScene.buildTlas(commandList.handle, false);
        commandList.close();
        app.executeCommandList(commandList);
        app.waitForIdle();
        console.log("Acceleration structures built");

        rtxcrScene.destroy();
        app.destroy();
        return 0;
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return RtxcrPathtracer.main(argc, argv);
}
