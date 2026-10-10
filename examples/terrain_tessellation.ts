// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";

namespace TerrainTessellation {
    const WINDOW_TITLE = "Donut Example: Terrain Tessellation";

    // The sample's KTX textures, converted to DDS at build time (see VULKAN_SAMPLES_ASSETS_DIR in
    // CMakeLists.txt).
    const HEIGHTMAP_PATH = "media/terrain_tessellation/terrain_heightmap_r16.dds";
    const TERRAIN_LAYERS_PATH = "media/terrain_tessellation/terrain_texturearray_rgba.dds";
    const SKY_PATH = "media/terrain_tessellation/skysphere_rgba.dds";

    // main_vs in terrain_tessellation.hlsl: (64 - 1)^2 quad patches of 4 vertices.
    const PATCH_SIZE = 64;
    const PATCH_VERTICES = 4;
    const TERRAIN_VERTICES = (PATCH_SIZE - 1) * (PATCH_SIZE - 1) * PATCH_VERTICES;

    // struct TerrainConstants, as f32 offsets (HLSL packing).
    const CONST_WORLD_TO_VIEW = 0;
    const CONST_VIEW_TO_CLIP = 16;
    const CONST_VIEW_TO_WORLD = 32;
    const CONST_LIGHT_POS = 48;
    const CONST_FRUSTUM_PLANES = 52;
    const CONST_DISPLACEMENT_FACTOR = 76;
    const CONST_TESSELLATION_FACTOR = 77;
    const CONST_VIEWPORT_DIM = 78;
    const CONST_TESSELLATED_EDGE_SIZE = 80;
    // Padded to 16 bytes.
    const CONST_FLOATS = 84;

    // The sample's camera: reversed depth from 0.1 to 512.
    const Z_NEAR = 0.1;
    const Z_FAR = 512.0;
    const DISPLACEMENT_FACTOR = 32.0;

    // --- Math ---------------------------------------------------------------------------------

    // glm::radians(float): in float32, as every use in the sample is.
    function radians(degrees: number): number {
        return Math.fround(Math.fround(degrees) * Math.fround(Math.PI / 180.0));
    }

    // The sample's glm::perspective(fov, aspect, 512, 0.1) (near and far swapped for reversed
    // depth), in Donut's row-vector convention, with view space z forward.
    // In float32, in glm's order of operations.
    function perspProjReverse(verticalFOV: number, aspect: number, zNear: number, zFar: number): number[] {
        const near = Math.fround(zNear);
        const far = Math.fround(zFar);
        const tanHalfFovy = Math.fround(Math.tan(Math.fround(Math.fround(verticalFOV) / 2.0)));
        const xScale = Math.fround(1.0 / Math.fround(Math.fround(aspect) * tanHalfFovy));
        const yScale = Math.fround(1.0 / tanHalfFovy);
        const depthRange = Math.fround(far - near);
        return [
            xScale, 0.0,    0.0,                                            0.0,
            0.0,    yScale, 0.0,                                            0.0,
            0.0,    0.0,    -Math.fround(near / depthRange),                1.0,
            0.0,    0.0,    Math.fround(Math.fround(far * near) / depthRange), 0.0,
        ];
    }

    // --- Passes -------------------------------------------------------------------------------

    class UIData {
        public tessellation: boolean;
        public tessellationFactor: number;
        public wireframe: boolean;

        constructor() {
            this.tessellation = true;
            this.tessellationFactor = 0.75;
            this.wireframe = false;
        }
    }

    // Port of Vulkan-Samples' terrain_tessellation: a terrain of quad patches, tessellated by the
    // hull shader according to their size on screen (and culled against the view frustum),
    // displaced by a heightmap in the domain shader, and textured by height from a texture array,
    // under a sky sphere.
    class TerrainPass {
        private app: App;
        private ui: UIData;
        private camera: Camera;

        private terrainVS: Opaque;
        private terrainHS: Opaque;
        private terrainDS: Opaque;
        private terrainPS: Opaque;
        private skyVS: Opaque;
        private skyPS: Opaque;
        private bindingLayout: Opaque;
        private constantBuffer: BufferHandle;
        private heightmap: Opaque;
        private terrainLayers: Opaque;
        private sky: Opaque;
        // Equal, but one each: NVRHI's D3D11 backend rebinds resources only when the binding sets
        // (or the framebuffer) change, not the pipeline, so with one set for both the terrain's hull
        // and domain shaders would be left with the sky pipeline's bindings (none).
        private skyBindingSet: BindingSet;
        private terrainBindingSet: BindingSet;

        // Created on the first frame (the size of the back buffer), dropped on resize.
        private colorBuffer: Opaque | null;
        private depthBuffer: Opaque | null;
        private framebuffer: Opaque | null;
        private terrainPipeline: Opaque | null;
        private wireframePipeline: Opaque | null;
        private skyPipeline: Opaque | null;

        // The TerrainConstants contents.
        private constants: f32[];
        // Donut's world to view matrix, 16 floats.
        private donutWorldToView: f32[];

        constructor(app: App, ui: UIData) {
            this.app = app;
            this.ui = ui;
            this.colorBuffer = null;
            this.depthBuffer = null;
            this.framebuffer = null;
            this.terrainPipeline = null;
            this.wireframePipeline = null;
            this.skyPipeline = null;

            this.constants = [];
            for (let i = 0; i < CONST_FLOATS; i++) {
                this.constants.push(0.0);
            }
            this.donutWorldToView = [];
            for (let i = 0; i < 16; i++) {
                this.donutWorldToView.push(0.0);
            }
        }

        onKey(key: int, scancode: int, action: int, mods: int): int {
            this.camera.keyboardUpdate(key, scancode, action, mods);
            return 1;
        }

        onMousePos(x: number, y: number): int {
            this.camera.mousePosUpdate(x, y);
            return 1;
        }

        onMouseButton(button: int, action: int, mods: int): int {
            this.camera.mouseButtonUpdate(button, action, mods);
            return 1;
        }

        onMouseScroll(xOffset: number, yOffset: number): int {
            this.camera.mouseScrollUpdate(xOffset, yOffset);
            return 1;
        }

        onAnimate(elapsedSeconds: number): void {
            this.camera.animate(elapsedSeconds);
            this.app.setInformativeWindowTitle(WINDOW_TITLE);
        }

        releaseTargets(): void {
            const resources: ResourceHandle[] = [this.terrainPipeline, this.wireframePipeline, this.skyPipeline,
                this.framebuffer, this.colorBuffer, this.depthBuffer];
            for (let i = 0; i < resources.length; i++) {
                const resource = resources[i];
                if (resource) {
                    this.app.releaseResource(resource);
                }
            }
            this.terrainPipeline = null;
            this.wireframePipeline = null;
            this.skyPipeline = null;
            this.framebuffer = null;
            this.colorBuffer = null;
            this.depthBuffer = null;
        }

        onBackBufferResizing(): void {
            this.releaseTargets();
            // The blit's cached binding sets still reference the old color buffer.
            this.app.clearBindingCache();
        }

        // The terrain pipeline: quad patches, reversed depth (greater passes), back faces culled.
        createTerrainPipeline(framebuffer: Opaque, fillMode: FillMode): Opaque {
            const desc = GraphicsPipelineDesc.create(this.terrainVS, this.terrainPS);
            desc.setTessellation(this.terrainHS, this.terrainDS, PATCH_VERTICES);
            desc.addBindingLayout(this.bindingLayout);
            desc.setDepthState(1, 1, ComparisonFunc.Greater);
            desc.setRasterState(CullMode.Back, fillMode, 0);
            return this.app.createGraphicsPipelineFromDesc(desc, framebuffer);
        }

        createTargets(width: int, height: int): void {
            const colorBuffer = this.app.createRenderTargetTexture(width, height, Format.RGBA8_UNORM, "ColorBuffer");
            const depthBuffer = this.app.createRenderTargetTexture(width, height, Format.D32, "DepthBuffer");
            const framebuffer = this.app.createFramebuffer(colorBuffer, depthBuffer);
            this.colorBuffer = colorBuffer;
            this.depthBuffer = depthBuffer;
            this.framebuffer = framebuffer;

            this.terrainPipeline = this.createTerrainPipeline(framebuffer, FillMode.Solid);
            this.wireframePipeline = this.createTerrainPipeline(framebuffer, FillMode.Wireframe);

            // The sky: a full screen triangle behind everything, without depth.
            const skyDesc = GraphicsPipelineDesc.create(this.skyVS, this.skyPS);
            skyDesc.addBindingLayout(this.bindingLayout);
            skyDesc.setDepthState(0, 0, ComparisonFunc.Always);
            skyDesc.setRasterState(CullMode.None, FillMode.Solid, 0);
            this.skyPipeline = this.app.createGraphicsPipelineFromDesc(skyDesc, framebuffer);
        }

        // The sample's update_uniform_buffers.
        updateConstants(width: int, height: int): void {
            const c = this.constants;

            // The sample's world has the terrain rising towards -y and, rendered by Vulkan without a
            // flipped viewport, -y up on the screen. Rotating it half a turn around z (x and y
            // negated) gives Donut's world, y up, with the same picture.
            this.camera.getWorldToView(Ref(this.donutWorldToView[0]));
            for (let i = 0; i < 16; i++) {
                const row = Math.floor(i / 4);
                c[CONST_WORLD_TO_VIEW + i] = row < 2 ? -this.donutWorldToView[i] : this.donutWorldToView[i];
            }

            const projection = perspProjReverse(radians(60.0), width / height, Z_NEAR, Z_FAR);
            for (let i = 0; i < 16; i++) {
                c[CONST_VIEW_TO_CLIP + i] = projection[i];
            }

            // The rotation's inverse: its transpose.
            for (let row = 0; row < 4; row++) {
                for (let column = 0; column < 4; column++) {
                    c[CONST_VIEW_TO_WORLD + row * 4 + column] = row < 3 && column < 3
                        ? c[CONST_WORLD_TO_VIEW + column * 4 + row] : (row == column ? 1.0 : 0.0);
                }
            }

            c[CONST_LIGHT_POS + 0] = -48.0;
            c[CONST_LIGHT_POS + 1] = -0.5 - DISPLACEMENT_FACTOR;
            c[CONST_LIGHT_POS + 2] = 46.0;
            c[CONST_LIGHT_POS + 3] = 0.0;

            // The frustum planes (vkb::Frustum) of world to clip space, as row vectors times matrix:
            // each plane is a combination of the matrix's columns.
            const worldToClip: number[] = [];
            for (let row = 0; row < 4; row++) {
                for (let column = 0; column < 4; column++) {
                    let sum = 0.0;
                    for (let k = 0; k < 4; k++) {
                        sum += c[CONST_WORLD_TO_VIEW + row * 4 + k] * c[CONST_VIEW_TO_CLIP + k * 4 + column];
                    }
                    worldToClip.push(sum);
                }
            }
            // Left, right (x), bottom, top (y), far (z >= 0, reversed depth) and near (z <= w).
            const columnA = [3, 3, 3, 3, 2, 3];
            const columnB = [0, 0, 1, 1, -1, 2];
            const signB = [1.0, -1.0, 1.0, -1.0, 0.0, -1.0];
            for (let plane = 0; plane < 6; plane++) {
                const p = CONST_FRUSTUM_PLANES + plane * 4;
                for (let k = 0; k < 4; k++) {
                    let value = worldToClip[k * 4 + columnA[plane]];
                    if (columnB[plane] >= 0) {
                        value += signB[plane] * worldToClip[k * 4 + columnB[plane]];
                    }
                    c[p + k] = value;
                }
                const length = Math.sqrt(c[p] * c[p] + c[p + 1] * c[p + 1] + c[p + 2] * c[p + 2]);
                for (let k = 0; k < 4; k++) {
                    c[p + k] = c[p + k] / length;
                }
            }

            c[CONST_DISPLACEMENT_FACTOR] = DISPLACEMENT_FACTOR;
            // Zero sets all tessellation factors to 1 in the hull shader.
            c[CONST_TESSELLATION_FACTOR] = this.ui.tessellation ? this.ui.tessellationFactor : 0.0;
            c[CONST_VIEWPORT_DIM + 0] = width;
            c[CONST_VIEWPORT_DIM + 1] = height;
            // Desired size of tessellated quad patch edge
            c[CONST_TESSELLATED_EDGE_SIZE] = 20.0;
        }

        onRender(frameHandle: FrameHandle): void {
            const frame = new Frame(frameHandle);
            const width = frame.getWidth();
            const height = frame.getHeight();
            const commandList = frame.getCommandList();

            if (!this.framebuffer) {
                this.createTargets(width, height);
            }
            const framebuffer = this.framebuffer;
            const colorBuffer = this.colorBuffer;
            const depthBuffer = this.depthBuffer;
            const skyPipeline = this.skyPipeline;
            const terrainPipeline = this.ui.wireframe ? this.wireframePipeline : this.terrainPipeline;
            if (!framebuffer || !colorBuffer || !depthBuffer || !skyPipeline || !terrainPipeline) {
                return;
            }

            this.updateConstants(width, height);
            commandList.writeBuffer(this.constantBuffer, Ref(this.constants[0]), CONST_FLOATS * 4);

            // Reversed depth: the far plane is 0.
            commandList.clearDepth(depthBuffer, 0.0);

            // Skysphere
            frame.beginDrawToFramebuffer(skyPipeline, framebuffer);
            frame.drawAddBindingSet(this.skyBindingSet);
            frame.drawVertices(3);

            // Terrain
            frame.beginDrawToFramebuffer(terrainPipeline, framebuffer);
            frame.drawAddBindingSet(this.terrainBindingSet);
            frame.drawVertices(TERRAIN_VERTICES);

            this.app.blitTexture(frame, colorBuffer);
        }

        // The sample's samplers: mirrored for the heightmap (only ever sampled inside [0, 1]),
        // repeating and anisotropic for the terrain layers, repeating for the sky.
        createBindingSet(): BindingSet {
            const setDesc = BindingSetDesc.create();
            setDesc.bindEntireConstantBuffer(0, this.constantBuffer);
            setDesc.bindTextureSRV(0, this.heightmap);
            setDesc.bindTextureSRV(1, this.terrainLayers);
            setDesc.bindTextureSRV(2, this.sky);
            setDesc.bindSampler(0, this.app.getCommonSampler(CommonSampler.LinearClamp));
            setDesc.bindSampler(1, this.app.getCommonSampler(CommonSampler.AnisotropicWrap));
            setDesc.bindSampler(2, this.app.getCommonSampler(CommonSampler.LinearWrap));
            return this.app.createBindingSetForLayout(setDesc, this.bindingLayout);
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(): boolean {
            this.terrainVS = this.app.createShader("terrain_tessellation.hlsl", "main_vs", ShaderType.Vertex);
            this.terrainHS = this.app.createShader("terrain_tessellation.hlsl", "main_hs", ShaderType.Hull);
            this.terrainDS = this.app.createShader("terrain_tessellation.hlsl", "main_ds", ShaderType.Domain);
            this.terrainPS = this.app.createShader("terrain_tessellation.hlsl", "main_ps", ShaderType.Pixel);
            this.skyVS = this.app.createShader("terrain_tessellation.hlsl", "sky_vs", ShaderType.Vertex);
            this.skyPS = this.app.createShader("terrain_tessellation.hlsl", "sky_ps", ShaderType.Pixel);
            if (!this.terrainVS || !this.terrainHS || !this.terrainDS || !this.terrainPS || !this.skyVS || !this.skyPS) {
                return false;
            }

            const commandList = this.app.createCommandList();
            commandList.open();
            // As the sample (vkb) loads KTX 1 files: color as sRGB, the heightmap as is.
            const heightmap = this.app.loadTexture(commandList, HEIGHTMAP_PATH, 0);
            const terrainLayers = this.app.loadTexture(commandList, TERRAIN_LAYERS_PATH, 1);
            const sky = this.app.loadTexture(commandList, SKY_PATH, 1);
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.waitForIdle();
            this.app.releaseResource(commandList.handle);
            if (!heightmap || !terrainLayers || !sky) {
                console.log("Cannot load the terrain textures: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return false;
            }
            this.heightmap = heightmap;
            this.terrainLayers = terrainLayers;
            this.sky = sky;

            this.constantBuffer = this.app.createVolatileConstantBuffer(CONST_FLOATS * 4, "TerrainConstants");

            const layoutDesc = BindingLayoutDesc.create();
            layoutDesc.layoutVolatileConstantBuffer(0);
            layoutDesc.layoutTextureSRV(0);
            layoutDesc.layoutTextureSRV(1);
            layoutDesc.layoutTextureSRV(2);
            layoutDesc.layoutSampler(0);
            layoutDesc.layoutSampler(1);
            layoutDesc.layoutSampler(2);
            this.bindingLayout = this.app.createBindingLayout(layoutDesc, ShaderType.All);

            this.skyBindingSet = this.createBindingSet();
            this.terrainBindingSet = this.createBindingSet();

            // The sample's first person camera at (18, 22.5, 57.5), rotated (-12, 159) degrees: in
            // Donut's world (see updateConstants), at (18, 22.5, -57.5) looking down the direction below.
            this.camera = this.app.createFirstPersonCamera();
            this.camera.lookAt(18.0, 22.5, -57.5, 18.0 - 0.3505, 22.5 - 0.2079, -57.5 + 0.9132);
            this.camera.setMoveSpeed(7.5);

            const pass = this.app.addPass();
            pass.setKeyboardCallback(this.onKey);
            pass.setMousePosCallback(this.onMousePos);
            pass.setMouseButtonCallback(this.onMouseButton);
            pass.setMouseScrollCallback(this.onMouseScroll);
            pass.setAnimateCallback(this.onAnimate);
            pass.setBackBufferResizingCallback(this.onBackBufferResizing);
            pass.setRenderCallback(this.onRender);
            return true;
        }
    }

    // The sample's settings window.
    class UserInterface {
        private ui: UIData;

        constructor(ui: UIData) {
            this.ui = ui;
        }

        checkbox(label: string, value: boolean): boolean {
            return Donut_ImGuiCheckbox(label, value ? 1 : 0) != 0;
        }

        buildUI(): void {
            const ui = this.ui;

            Donut_ImGuiSetNextWindowPos(10.0, 10.0);
            Donut_ImGuiBegin("Settings", 1);
            ui.tessellation = this.checkbox("Tessellation", ui.tessellation);
            ui.tessellationFactor = Donut_ImGuiDragFloat("Factor", ui.tessellationFactor, 0.05, 0.0, 4.0);
            ui.wireframe = this.checkbox("Wireframe", ui.wireframe);
            Donut_ImGuiEnd();
        }

        // Declared after buildUI: tslang resolves `this.buildUI` only for members declared earlier.
        init(app: App): boolean {
            return !app.addImGuiPass(this.buildUI).isNull();
        }
    }

    export function main(argc: int, argv: Ref<string>): int {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("terrain_tessellation");

        // -debug: the graphics API's debug layer and NVRHI's validation layer.
        // -noui: without the settings window.
        let options = AppOptions.None;
        let withUI = true;
        for (let i = 1; i < argc; i++) {
            const arg = Donut_GetArg(argv, i);
            if (arg == "-debug") {
                options = AppOptions.DebugRuntime;
            } else if (arg == "-noui") {
                withUI = false;
            }
        }

        const api = Donut_GetGraphicsAPIFromCommandLine(argc, argv);
        const app = App.createWithOptions(api, WINDOW_TITLE, 1280, 720, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        const uiData = new UIData();
        const terrain = new TerrainPass(app, uiData);
        if (!terrain.init()) {
            app.destroy();
            return 1;
        }

        // Drawn after (over) the terrain, and sees the mouse first.
        const gui = new UserInterface(uiData);
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
    return TerrainTessellation.main(argc, argv);
}
