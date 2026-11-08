// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";
import { Args } from "../core/args";
import { TestCheck, isFinite32, unsupported } from "../core/test_check";
import { PrepareLightsPass, RtxdiDI, RtxdiRenderTargets } from "../core/rtxdi_di";

// Port of NVIDIA's RTXDI Minimal Sample (github.com/NVIDIA-RTX/RTXDI, Samples/MinimalSample, RTXDI 3.0.0): the
// Arcade lit by its emissive triangles. The sample, its RTXDI library and its shaders are under the NVIDIA RTX
// SDKs License, so they are used in place from an RTXDI checkout (RTXDI_DIR), nothing of them copied.
namespace RtxdiMinimal {
    // Test mode: the frames rendered.
    const TEST_FRAMES = 2;

    const WINDOW_TITLE = "Hello RTXDI";
    // The sample's scene, from RTXDI_DIR/Assets (CMakeLists.txt links it next to bin/).
    const SCENE_PATH = "../Assets/Media/Arcade/Arcade.gltf";

    // sizeof(RAB_LightInfo) in the sample's ShaderParameters.h, and its words: float3 center, uint scalars, uint2
    // radiance (four halves, alpha 0), two oct-encoded directions.
    const LIGHT_INFO_SIZE = 32;
    const LIGHT_INFO_WORDS = 8;
    const LIGHT_CENTER = 0;
    const LIGHT_RADIANCE = 4;

    class RtxdiMinimalArgs extends Args {
        // -width, -height: the window's (the render size), the sample's 1920 x 1080 by default.
        width: int = 1920;
        height: int = 1080;

        protected parseOptions() {
            for (let i = 1; i < this.argc; i++) {
                const arg = this[i];
                if (arg == "-width" && i + 1 < this.argc) {
                    this.width = parseInt(this[i + 1]);
                } else if (arg == "-height" && i + 1 < this.argc) {
                    this.height = parseInt(this[i + 1]);
                }
            }
        }
    }

    // The sample's SceneRenderer: the scene loaded with the bindless layout its shaders read through, its
    // acceleration structures, and, made on the first frame and again after a resize, the ReSTIR DI context and
    // resources, the render targets and the binding sets. A frame refreshes the scene, prepares the lights and
    // swaps the current and previous G-buffers.
    class SceneRenderer {
        private bindlessLayout: BindingLayoutHandle;
        private scene: Scene;
        private accelStructs: RtxdiSceneAccelStructsHandle | null = null;
        private prepareLightsPass: PrepareLightsPass;
        // Made on the first frame, dropped on resize.
        di: RtxdiDI | null = null;
        private targets: RtxdiRenderTargets | null = null;

        // What -test checks: the app's frame index on the first frame rendered (0, as the sample's first
        // frame after a synchronous load), and the light count of the last frame.
        firstFrameIndex: int = -1;
        lightCount: int = 0;

        constructor(private app: App) {
        }

        init(): boolean {
            // The sample's bindless layout: its scene's vertex and index buffers (t0, space1), textures (t0,
            // space2) and writable textures (u0, space3), for every stage.
            const bindlessLayoutDesc = BindlessLayoutDesc.create(0, 1024, ShaderType.All);
            bindlessLayoutDesc.addRawBuffers(1);
            bindlessLayoutDesc.addTextures(2);
            bindlessLayoutDesc.addTextureUAVs(3);
            this.bindlessLayout = this.app.createBindlessLayout(bindlessLayoutDesc);
            const descriptorTableManager = this.app.createDescriptorTableManager(this.bindlessLayout);

            // Loaded before the first frame: the sample with its synchronous loading renders its first frame at
            // frame index 0, which RTXDI's random sequences start from; the frames match it from there.
            const scene = this.app.loadSceneWithDescriptorTable(SCENE_PATH, descriptorTableManager);
            if (scene.isNull()) {
                console.log(`Cannot load the scene ${SCENE_PATH} (configure with RTXDI_DIR, which links its Assets)`);
                return false;
            }
            this.scene = scene;

            this.prepareLightsPass = new PrepareLightsPass(this.app, this.bindlessLayout, scene,
                descriptorTableManager.getDescriptorTable());
            if (!this.prepareLightsPass.createPipeline()) {
                return false;
            }

            const commandList = this.app.createCommandList();
            commandList.open();
            this.accelStructs = Rtxdi_BuildSceneAccelStructs(this.app.handle, commandList.handle, scene.handle);
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.waitForIdle();
            this.app.releaseResource(commandList.handle);
            if (!this.accelStructs) {
                return false;
            }

            const pass = this.app.addPass();
            pass.setBackBufferResizingCallback(this.onBackBufferResizing);
            pass.setRenderCallback(this.onRender);
            return true;
        }

        // BackBufferResized: the context, the resources and the render targets are made again for the new size.
        onBackBufferResizing() {
            this.prepareLightsPass.releaseBindingSet();
            const di = this.di;
            if (di) {
                di.dispose();
                this.di = null;
            }
            const targets = this.targets;
            if (targets) {
                targets.release(this.app);
                this.targets = null;
            }
        }

        onRender(frameHandle: FrameHandle) {
            const frame = new Frame(frameHandle);
            const width = frame.getWidth();
            const height = frame.getHeight();
            const frameIndex = this.app.getFrameIndex();
            if (this.firstFrameIndex < 0) {
                this.firstFrameIndex = frameIndex;
                console.log(`First rendered frame index ${frameIndex}, ${width} x ${height}`);
            }

            // SetupRenderPasses.
            let di = this.di;
            if (!di) {
                di = new RtxdiDI(this.app, this.scene, width, height);
                if (di.isNull()) {
                    return;
                }
                this.prepareLightsPass.createBindingSet(di);
                this.di = di;
            }
            let targets = this.targets;
            if (!targets) {
                targets = new RtxdiRenderTargets(this.app, width, height);
                this.targets = targets;
            }

            const commandList = frame.getCommandList();
            this.app.refreshScene(frame, this.scene);
            di.initializeNeighborOffsets(commandList);
            di.setFrameIndex(frameIndex);
            // The lights are static, but prepared every frame, as the sample does.
            this.lightCount = this.prepareLightsPass.dispatch(commandList, di);

            // NextFrame.
            targets.swap();
        }

        // Before the app: frees what the app doesn't own.
        dispose(): void {
            this.onBackBufferResizing();
            const accelStructs = this.accelStructs;
            if (accelStructs) {
                Rtxdi_DestroySceneAccelStructs(accelStructs);
                this.accelStructs = null;
            }
        }
    }

    // A GPU buffer's first byteSize bytes, as ints (TestCheck.readFloats' readback); empty if they can't be read.
    function readInts(app: App, buffer: BufferHandle, byteSize: int): int[] {
        const readback = app.createReadbackBuffer(byteSize, "Test readback");
        const commandList = app.createCommandList();
        commandList.open();
        commandList.copyBuffer(readback, 0, buffer, 0, byteSize);
        commandList.close();
        app.executeCommandList(commandList);
        app.waitForIdle();
        app.releaseResource(commandList.handle);
        const values: int[] = [];
        for (let i = 0; i < byteSize / 4; i++) {
            values.push(0);
        }
        const read = app.readBuffer(readback, Ref(values[0]), byteSize);
        app.releaseResource(readback);
        if (!read) {
            return [];
        }
        return values;
    }

    // A half's bits (IEEE 754 binary16) are a finite value that isn't negative.
    function isFiniteNonNegativeHalf(bits: int): boolean {
        return (bits & 0x8000) == 0 && (bits & 0x7C00) != 0x7C00;
    }

    // -test: the first frame was frame index 0 (as the sample's), and PrepareLights wrote every light: its center
    // finite, its radiance finite and not negative. Some lights' radiance is not zero, but not every one's: the
    // Arcade's one emissive material (the cabinets') is masked by its emissive texture, which PrepareLights samples
    // at each triangle's center, and most of the cabinets' triangles are dark there.
    function checkLights(app: App, renderer: SceneRenderer): string {
        if (renderer.firstFrameIndex != 0) {
            return `the first frame rendered was frame index ${renderer.firstFrameIndex}, not 0`;
        }
        const di = renderer.di;
        if (!di) {
            return "no RTXDI resources";
        }
        const count = renderer.lightCount;
        if (count <= 0) {
            return "PrepareLights found no lights";
        }
        const check = new TestCheck(app);
        const lightData = di.buffer(RtxdiBuffer.LightData);
        const floats = check.readFloats(lightData, count * LIGHT_INFO_SIZE);
        const ints = readInts(app, lightData, count * LIGHT_INFO_SIZE);
        if (floats.length == 0 || ints.length == 0) {
            return "cannot read the light data buffer";
        }
        let lit = 0;
        for (let i = 0; i < count; i++) {
            const base = i * LIGHT_INFO_WORDS;
            const x = floats[base + LIGHT_CENTER];
            const y = floats[base + LIGHT_CENTER + 1];
            const z = floats[base + LIGHT_CENTER + 2];
            if (!isFinite32(x) || !isFinite32(y) || !isFinite32(z)) {
                return `light ${i} of ${count}: center ${x}, ${y}, ${z} is not finite`;
            }
            // Red and green, then blue and alpha (0).
            const redGreen = ints[base + LIGHT_RADIANCE];
            const blueAlpha = ints[base + LIGHT_RADIANCE + 1];
            if (!isFiniteNonNegativeHalf(redGreen & 0xFFFF) || !isFiniteNonNegativeHalf((redGreen >> 16) & 0xFFFF)
                || !isFiniteNonNegativeHalf(blueAlpha & 0xFFFF) || (blueAlpha >> 16) != 0) {
                return `light ${i} of ${count}: radiance bits ${redGreen}, ${blueAlpha} are not a finite color that isn't negative (alpha 0)`;
            }
            if (redGreen != 0 || blueAlpha != 0) {
                lit++;
            }
        }
        console.log(`Lights: ${count}, ${lit} with radiance`);
        if (lit == 0) {
            return `none of the ${count} lights has radiance`;
        }
        return "";
    }

    export function main(argc: int, argv: Ref<string>) {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Program.setAppName("rtxdi_minimal");

        const args = new RtxdiMinimalArgs(argc, argv, TEST_FRAMES);
        args.parseArgs();

        // RayTracing: Vulkan's ray tracing extensions (the shaders' ray queries).
        const app = App.createWithOptions(args.api, WINDOW_TITLE, args.width, args.height,
            AppOptions.RayTracing | args.options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }
        if (!app.isFeatureSupported(Feature.RayQuery)) {
            app.destroy();
            return unsupported(args.test, "The graphics device does not support Ray Queries");
        }
        console.log(`Renderer: ${app.getRendererString()}`);

        const renderer = new SceneRenderer(app);
        if (!renderer.init()) {
            app.destroy();
            return 1;
        }

        const input = new InputPass(app.handle);

        app.run();
        let result = 0;
        if (args.test) {
            result = app.finishTest(checkLights(app, renderer));
        }
        app.waitForIdle();
        renderer.dispose();
        app.destroy();
        return result;
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return RtxdiMinimal.main(argc, argv);
}
