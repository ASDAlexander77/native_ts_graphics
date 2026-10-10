// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";

namespace MeshShaderCulling {
    const WINDOW_TITLE = "Donut Example: Mesh Shader Culling";

    // struct CullConstants { float cullCenterX, cullCenterY, cullRadius, meshletDensity; uint2
    // numWorkGroups; }, padded to 32 bytes.
    const CONST_CULL_CENTER_X = 0;
    const CONST_CULL_CENTER_Y = 1;
    const CONST_CULL_RADIUS = 2;
    const CONST_MESHLET_DENSITY = 3;
    const CONST_NUM_WORK_GROUPS_X = 4;
    const CONST_NUM_WORK_GROUPS_Y = 5;
    const CONST_FLOATS = 8;

    // The sample's camera: first person at (1, 0, 1), turned off for the mouse; WASD moves it one
    // unit per second, and the square with it.
    const CAMERA_X = 1.0;
    const CAMERA_Z = 1.0;
    const TRANSLATION_SPEED = 1.0;

    // ApiVulkanSample's clear color.
    const CLEAR_COLOR = 0.002;

    // GLFW keys and actions.
    const KEY_W = 87;
    const KEY_A = 65;
    const KEY_S = 83;
    const KEY_D = 68;
    const ACTION_RELEASE = 0;
    const ACTION_PRESS = 1;

    // Pipeline statistics, as Donut_GetMeshPipelineStatistic numbers them.
    const STAT_PIXEL = 0;
    const STAT_TASK = 1;
    const STAT_MESH = 2;

    // Task shader workgroups per side for each density level: 4 x 4, 6 x 6, 8 x 8.
    function workGroupsPerSide(densityLevel: int): int {
        return densityLevel == 0 ? 4 : (densityLevel == 1 ? 6 : (densityLevel == 2 ? 8 : 2));
    }

    // Port of Vulkan-Samples' mesh_shader_culling: a square of N x N task shader workgroups of 2 x 2
    // invocations, each invocation a sub-rect, in clip space. Task (amplification) shaders keep the
    // sub-rects whose corners are all within a circle around the center of the screen and launch a
    // mesh shader workgroup for each (an offset each through the payload), which draws it as 2 x 2
    // colored quads. WASD moves the square; pipeline statistics count the shader invocations.
    class MeshShaderCullingPass {
        private app: App;

        // The sample's settings (its UBO and density level).
        cullRadius: number;
        densityLevel: int;
        statistics: MeshPipelineStatistics;
        hasStatistics: boolean;

        // The camera's x and z (the square's position is minus those).
        private cameraX: number;
        private cameraZ: number;
        private keyUp: boolean;
        private keyDown: boolean;
        private keyLeft: boolean;
        private keyRight: boolean;

        private constantBuffer: BufferHandle;
        private bindingLayout: BindingLayoutHandle;
        private bindingSet: BindingSet;
        private amplificationShader: ShaderHandle;
        private meshShader: ShaderHandle;
        private pixelShader: ShaderHandle;
        private pipelineCreated: boolean;
        private pipeline: Opaque;

        private constants: f32[];

        constructor(app: App) {
            this.app = app;
            this.cullRadius = 1.0;
            this.densityLevel = 2;
            this.hasStatistics = false;
            this.cameraX = CAMERA_X;
            this.cameraZ = CAMERA_Z;
            this.keyUp = false;
            this.keyDown = false;
            this.keyLeft = false;
            this.keyRight = false;
            this.pipelineCreated = false;
            this.constants = [];
            for (let i = 0; i < CONST_FLOATS; i++) {
                this.constants.push(0.0);
            }
        }

        // ApiVulkanSample's keys: WASD move the camera while held.
        onKeyboard(key: int, scancode: int, action: int, mods: int): int {
            if (action != ACTION_PRESS && action != ACTION_RELEASE) {
                return 0;
            }
            const pressed = action == ACTION_PRESS;
            if (key == KEY_W) {
                this.keyUp = pressed;
            } else if (key == KEY_S) {
                this.keyDown = pressed;
            } else if (key == KEY_A) {
                this.keyLeft = pressed;
            } else if (key == KEY_D) {
                this.keyRight = pressed;
            } else {
                return 0;
            }
            return 1;
        }

        // The framework's first person camera, never rotated: W and S along z, A and D along x.
        onAnimate(elapsedSeconds: number): void {
            const moveSpeed = elapsedSeconds * TRANSLATION_SPEED;
            if (this.keyUp) {
                this.cameraZ += moveSpeed;
            }
            if (this.keyDown) {
                this.cameraZ -= moveSpeed;
            }
            if (this.keyLeft) {
                this.cameraX += moveSpeed;
            }
            if (this.keyRight) {
                this.cameraX -= moveSpeed;
            }
            this.app.setInformativeWindowTitle(WINDOW_TITLE);
        }

        onRender(frameHandle: FrameHandle): void {
            const frame = new Frame(frameHandle);
            const commandList = frame.getCommandList();

            if (!this.pipelineCreated) {
                // No depth test, no culling.
                const desc = GraphicsPipelineDesc.createMeshlet(this.amplificationShader, this.meshShader, this.pixelShader);
                desc.addBindingLayout(this.bindingLayout);
                desc.setDepthState(0, 0, ComparisonFunc.Greater);
                desc.setRasterState(CullMode.None, FillMode.Solid, 1);
                this.pipeline = this.app.createMeshletPipelineFromDescForFrame(desc, frame);
                this.pipelineCreated = true;
            }

            if (this.hasStatistics) {
                frame.beginMeshPipelineStatistics(this.statistics);
            }

            const groups = workGroupsPerSide(this.densityLevel);
            const c = this.constants;
            c[CONST_CULL_CENTER_X] = -this.cameraX;
            c[CONST_CULL_CENTER_Y] = -this.cameraZ;
            c[CONST_CULL_RADIUS] = this.cullRadius;
            c[CONST_MESHLET_DENSITY] = this.densityLevel;
            Donut_StoreInt32(Ref(c[CONST_NUM_WORK_GROUPS_X]), groups);
            Donut_StoreInt32(Ref(c[CONST_NUM_WORK_GROUPS_Y]), groups);
            commandList.writeBuffer(this.constantBuffer, Ref(c[0]), CONST_FLOATS * 4);

            frame.clearColor(CLEAR_COLOR, CLEAR_COLOR, CLEAR_COLOR, 1.0);
            frame.beginMeshDraw(this.pipeline);
            frame.drawAddBindingSet(this.bindingSet);
            // N x N task shader workgroups.
            if (this.hasStatistics) {
                frame.drawMeshTasksWithStatistics(groups, groups, this.statistics);
            } else {
                frame.drawMeshTasks2D(groups, groups);
            }
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(): boolean {
            if (this.app.isFeatureSupported(Feature.Meshlets) == 0) {
                console.log("This example needs task and mesh shaders (D3D12 or Vulkan)");
                return false;
            }

            const shader = "mesh_shader_culling.hlsl";
            this.amplificationShader = this.app.createShader(shader, "cull_as", ShaderType.Amplification);
            this.meshShader = this.app.createShader(shader, "cull_ms", ShaderType.Mesh);
            this.pixelShader = this.app.createShader(shader, "cull_ps", ShaderType.Pixel);
            if (!this.amplificationShader || !this.meshShader || !this.pixelShader) {
                return false;
            }

            // The sample's descriptor set: the UBO, for the task shader.
            this.constantBuffer = this.app.createVolatileConstantBuffer(CONST_FLOATS * 4, "UBO");
            const layoutDesc = BindingLayoutDesc.create();
            layoutDesc.layoutVolatileConstantBuffer(0);
            this.bindingLayout = this.app.createBindingLayout(layoutDesc, ShaderType.Amplification);
            const setDesc = BindingSetDesc.create();
            setDesc.bindEntireConstantBuffer(0, this.constantBuffer);
            this.bindingSet = this.app.createBindingSetForLayout(setDesc, this.bindingLayout);

            // Pipeline statistics, where the device counts mesh shader work.
            this.statistics = this.app.createMeshPipelineStatistics();
            this.hasStatistics = !this.statistics.isNull();

            const pass = this.app.addPass();
            pass.setKeyboardCallback(this.onKeyboard);
            pass.setAnimateCallback(this.onAnimate);
            pass.setRenderCallback(this.onRender);
            return true;
        }
    }

    // The sample's overlay.
    class UserInterface {
        private sample: MeshShaderCullingPass;

        constructor(sample: MeshShaderCullingPass) {
            this.sample = sample;
        }

        buildUI(): void {
            const sample = this.sample;
            Donut_ImGuiSetNextWindowPos(10.0, 10.0);
            // The sample's title (ApiVulkanSample's default).
            Donut_ImGuiBegin("Vulkan Example", 1);
            if (Donut_ImGuiCollapsingHeaderDefaultOpen("Use WASD to move the square\n Configurations:\n") != 0) {
                sample.cullRadius = Donut_ImGuiSliderFloat("Cull Radius: ", sample.cullRadius, 0.5, 2.0);
                sample.densityLevel = Donut_ImGuiCombo("Meshlet Density Level: ", sample.densityLevel, "4 x 4|6 x 6|8 x 8");

                if (sample.hasStatistics) {
                    if (Donut_ImGuiCollapsingHeaderDefaultOpen("Pipeline statistics") != 0) {
                        Donut_ImGuiText(`TS invocations: ${sample.statistics.get(STAT_TASK)}`);
                        Donut_ImGuiText(`MS invocations: ${sample.statistics.get(STAT_MESH)}`);
                        Donut_ImGuiText(`FS invocations: ${sample.statistics.get(STAT_PIXEL)}`);
                    }
                }
            }
            Donut_ImGuiEnd();
        }

        // Declared after buildUI: tslang resolves `this.buildUI` only for members declared earlier.
        init(app: App): boolean {
            return !app.addImGuiPass(this.buildUI).isNull();
        }
    }

    export function main(argc: int, argv: Ref<string>): int {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("mesh_shader_culling");

        // -debug: the graphics API's debug layer and NVRHI's validation layer.
        // -noui: without the settings window.
        // -radius <0.5..2>: the culling circle's radius; -density <0..2>: 4 x 4, 6 x 6 or 8 x 8.
        let options = AppOptions.None;
        let withUI = true;
        let cullRadius = 1.0;
        let densityLevel = 2;
        for (let i = 1; i < argc; i++) {
            const arg = Donut_GetArg(argv, i);
            if (arg == "-debug") {
                options = AppOptions.DebugRuntime;
            } else if (arg == "-noui") {
                withUI = false;
            } else if (arg == "-radius" && i + 1 < argc) {
                i++;
                cullRadius = Math.min(Math.max(parseFloat(Donut_GetArg(argv, i)), 0.5), 2.0);
            } else if (arg == "-density" && i + 1 < argc) {
                i++;
                densityLevel = Math.min(Math.max(parseInt(Donut_GetArg(argv, i)), 0), 2);
            }
        }

        const api = Donut_GetGraphicsAPIFromCommandLine(argc, argv);
        const app = App.createWithOptions(api, WINDOW_TITLE, 1280, 720, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        const sample = new MeshShaderCullingPass(app);
        sample.cullRadius = cullRadius;
        sample.densityLevel = densityLevel;
        if (!sample.init()) {
            app.destroy();
            return 1;
        }

        // Drawn after (over) the scene.
        const gui = new UserInterface(sample);
        if (withUI && !gui.init(app)) {
            console.log("Cannot initialize the user interface");
            app.destroy();
            return 1;
        }

        const input = new InputPass(app.handle);

        app.run();
        app.destroy();
        return 0;
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>): int {
    return MeshShaderCulling.main(argc, argv);
}
