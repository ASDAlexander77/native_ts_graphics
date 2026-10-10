// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";

namespace MemoryBudget {
    const WINDOW_TITLE = "Donut Example: Memory Budget";

    // The sample's models and textures (Vulkan-Samples' assets), the KTX textures converted to DDS at
    // build time (see VULKAN_SAMPLES_ASSETS_DIR in CMakeLists.txt).
    const ROCK_PATH = "media/memory_budget/rock.gltf";
    const PLANET_PATH = "media/memory_budget/planet.gltf";
    const ROCK_TEXTURES_PATH = "media/memory_budget/texturearray_rocks_color_rgba.dds";
    const PLANET_TEXTURE_PATH = "media/memory_budget/lavaplanet_color_rgba.dds";
    // Layers of the rocks' texture array.
    const ROCK_TEXTURE_LAYERS = 5;

    // The sample's MESH_DENSITY.
    const INSTANCE_COUNT = 2048;

    // Donut_LoadGltfMesh's vertices: float3 position, float3 normal, float2 texture coordinates.
    const VERTEX_SIZE = 32;
    // struct InstanceData { float3 pos; float3 rot; float scale; uint texIndex; }
    const INSTANCE_FLOATS = 8;
    const INSTANCE_SIZE = INSTANCE_FLOATS * 4;

    // struct UBO, as f32 offsets (HLSL packing).
    const CONST_PROJECTION = 0;
    const CONST_MODELVIEW = 16;
    const CONST_LIGHT_POS = 32;
    const CONST_LOC_SPEED = 36;
    const CONST_GLOB_SPEED = 37;
    // Padded to 16 bytes.
    const CONST_FLOATS = 40;

    // The sample's camera: reversed depth from 0.1 to 256.
    const Z_NEAR = 0.1;
    const Z_FAR = 256.0;

    const KEY_P = 80;
    const ACTION_PRESS = 1;

    // The sample's units: bytes, then KB, MB, GB as each is reached (1024 of the one before).
    const KILOBYTE = 1024.0;
    const MEGABYTE = KILOBYTE * 1024.0;
    const GIGABYTE = MEGABYTE * 1024.0;

    // A number with `digits` decimals, like printf's %.Nf (Number.toFixed is missing under the JIT).
    function formatFixed(value: number, digits: int): string {
        let scale = 1.0;
        for (let i = 0; i < digits; i++) {
            scale *= 10.0;
        }
        const scaled = Math.round(Math.abs(value) * scale);
        const whole: int = Math.floor(scaled / scale);
        const fraction: int = scaled - whole * scale;
        let fractionText = `${fraction}`;
        while (fractionText.length < digits) {
            fractionText = "0" + fractionText;
        }
        const sign = value < 0.0 && scaled > 0.0 ? "-" : "";
        return digits > 0 ? `${sign}${whole}.${fractionText}` : `${sign}${whole}`;
    }

    // The sample's update_converted_memory: a byte count in the largest unit it reaches, "%.2f %s".
    function formatMemory(bytes: number): string {
        if (bytes < KILOBYTE) {
            return `${formatFixed(bytes, 2)} B`;
        }
        if (bytes < MEGABYTE) {
            return `${formatFixed(bytes / KILOBYTE, 2)} KB`;
        }
        if (bytes < GIGABYTE) {
            return `${formatFixed(bytes / MEGABYTE, 2)} MB`;
        }
        return `${formatFixed(bytes / GIGABYTE, 2)} GB`;
    }

    // The sample's read_memoryHeap_flags: the flags as one of Vulkan's, or none of them.
    function heapFlagName(flags: int): string {
        if (flags == MemoryHeapFlag.DeviceLocal) {
            return "Device Local Bit";
        }
        if (flags == MemoryHeapFlag.MultiInstance) {
            return "Multiple Instance Bit";
        }
        return "Host Local Heap Memory";
    }

    // --- Math ---------------------------------------------------------------------------------

    // glm::radians(float): in float32, as every use in the sample is.
    function radians(degrees: number): number {
        return Math.fround(Math.fround(degrees) * Math.fround(Math.PI / 180.0));
    }

    // std::default_random_engine replacement: a Park-Miller generator (tslang's Math.random isn't usable).
    let g_RandomSeed = 12345.0;
    function randomFloat(): number {
        g_RandomSeed = (g_RandomSeed * 16807.0) % 2147483647.0;
        return g_RandomSeed / 2147483647.0;
    }

    // The sample's glm::perspective(fov, aspect, 256, 0.1) (near and far swapped for reversed
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

    // Port of Vulkan-Samples' memory_budget: its instancing sample's scene (see instancing.ts; 2048
    // rocks here) with the memory heaps' usage and budget shown, VK_EXT_memory_budget's on Vulkan
    // (DXGI's video and system memory on D3D). As the sample, they're read once, after loading: the
    // scene allocates nothing more.
    class InstancingPass {
        private app: App;
        private camera: Camera;
        private view: View;
        private paused: boolean;

        private rocksVS: Opaque;
        private rocksPS: Opaque;
        private planetVS: Opaque;
        private planetPS: Opaque;
        private starfieldVS: Opaque;
        private starfieldPS: Opaque;
        private rocksInputLayout: Opaque;
        private planetInputLayout: Opaque;
        private bindingLayout: Opaque;
        private constantBuffer: Opaque;
        private rock: GltfMesh;
        private planet: GltfMesh;
        private instanceBuffer: Opaque;
        private rocksBindingSet: BindingSet;
        private planetBindingSet: BindingSet;

        // Created on the first frame (the size of the back buffer), dropped on resize.
        private colorBuffer: Opaque | null;
        private depthBuffer: Opaque | null;
        private framebuffer: Opaque | null;
        private rocksPipeline: Opaque | null;
        private planetPipeline: Opaque | null;
        private starfieldPipeline: Opaque | null;

        // The UBO contents.
        private constants: f32[];
        // Donut's view matrices, 16 floats each.
        private viewMatrix: f32[];
        private projMatrix: f32[];

        constructor(app: App) {
            this.app = app;
            this.paused = false;
            this.colorBuffer = null;
            this.depthBuffer = null;
            this.framebuffer = null;
            this.rocksPipeline = null;
            this.planetPipeline = null;
            this.starfieldPipeline = null;

            this.constants = [];
            for (let i = 0; i < CONST_FLOATS; i++) {
                this.constants.push(0.0);
            }
            this.viewMatrix = [];
            this.projMatrix = [];
            for (let i = 0; i < 16; i++) {
                this.viewMatrix.push(0.0);
                this.projMatrix.push(0.0);
            }
        }

        onKey(key: int, scancode: int, action: int, mods: int): int {
            this.camera.keyboardUpdate(key, scancode, action, mods);

            if (key == KEY_P && action == ACTION_PRESS) {
                this.paused = !this.paused;
            }

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

        // The sample's update_uniform_buffer: the rocks spin, and the rings turn slowly.
        onAnimate(elapsedSeconds: number): void {
            this.camera.animate(elapsedSeconds);
            if (!this.paused) {
                this.constants[CONST_LOC_SPEED] += elapsedSeconds * 0.35;
                this.constants[CONST_GLOB_SPEED] += elapsedSeconds * 0.01;
            }
            this.app.setInformativeWindowTitleWithInfo(WINDOW_TITLE, this.paused ? "paused" : "");
        }

        releaseTargets(): void {
            const resources = [this.rocksPipeline, this.planetPipeline, this.starfieldPipeline,
                this.framebuffer, this.colorBuffer, this.depthBuffer];
            for (let i = 0; i < resources.length; i++) {
                const resource = resources[i];
                if (resource) {
                    this.app.releaseResource(resource);
                }
            }
            this.rocksPipeline = null;
            this.planetPipeline = null;
            this.starfieldPipeline = null;
            this.framebuffer = null;
            this.colorBuffer = null;
            this.depthBuffer = null;
        }

        onBackBufferResizing(): void {
            this.releaseTargets();
            // The blit's cached binding sets still reference the old color buffer.
            this.app.clearBindingCache();
        }

        // The rocks and the planet: reversed depth (greater passes), back faces culled.
        createMeshPipeline(framebuffer: Opaque, vertexShader: Opaque, pixelShader: Opaque, inputLayout: Opaque): Opaque {
            const desc = GraphicsPipelineDesc.create(vertexShader, pixelShader);
            desc.setInputLayout(inputLayout);
            desc.addBindingLayout(this.bindingLayout);
            desc.setDepthState(1, 1, ComparisonFunc.Greater);
            desc.setRasterState(CullMode.Back, FillMode.Solid, 0);
            return this.app.createGraphicsPipelineFromDesc(desc, framebuffer);
        }

        createTargets(width: int, height: int): void {
            const colorBuffer = this.app.createRenderTargetTexture(width, height, Format.RGBA8_UNORM, "ColorBuffer");
            const depthBuffer = this.app.createRenderTargetTexture(width, height, Format.D32, "DepthBuffer");
            const framebuffer = this.app.createFramebuffer(colorBuffer, depthBuffer);
            this.colorBuffer = colorBuffer;
            this.depthBuffer = depthBuffer;
            this.framebuffer = framebuffer;

            this.rocksPipeline = this.createMeshPipeline(framebuffer, this.rocksVS, this.rocksPS, this.rocksInputLayout);
            this.planetPipeline = this.createMeshPipeline(framebuffer, this.planetVS, this.planetPS, this.planetInputLayout);

            // The star field: a full screen triangle behind everything, without depth or bindings.
            const starfieldDesc = GraphicsPipelineDesc.create(this.starfieldVS, this.starfieldPS);
            starfieldDesc.setDepthState(0, 0, ComparisonFunc.Always);
            starfieldDesc.setRasterState(CullMode.None, FillMode.Solid, 0);
            this.starfieldPipeline = this.app.createGraphicsPipelineFromDesc(starfieldDesc, framebuffer);
        }

        // The view and projection of the UBO; locSpeed and globSpeed advance in onAnimate.
        updateConstants(width: int, height: int): void {
            const c = this.constants;

            const projection = perspProjReverse(radians(60.0), width / height, Z_NEAR, Z_FAR);
            for (let i = 0; i < 16; i++) {
                this.projMatrix[i] = projection[i];
            }
            this.camera.getWorldToView(Ref(this.viewMatrix[0]));
            this.view.setPlanarView(Ref(this.viewMatrix[0]), Ref(this.projMatrix[0]), width, height);
            this.camera.thirdPersonSetView(this.view);

            // The sample's world has -y up on the screen (Vulkan, without a flipped viewport). Mirrored
            // in y it is Donut's world, y up, with the same picture: Donut's view space is left-handed,
            // the sample's right-handed.
            for (let i = 0; i < 16; i++) {
                const row = Math.floor(i / 4);
                c[CONST_MODELVIEW + i] = row == 1 ? -this.viewMatrix[i] : this.viewMatrix[i];
                c[CONST_PROJECTION + i] = this.projMatrix[i];
            }

            c[CONST_LIGHT_POS + 0] = 0.0;
            c[CONST_LIGHT_POS + 1] = -5.0;
            c[CONST_LIGHT_POS + 2] = 0.0;
            c[CONST_LIGHT_POS + 3] = 1.0;
        }

        onRender(frameHandle: Opaque): void {
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
            const rocksPipeline = this.rocksPipeline;
            const planetPipeline = this.planetPipeline;
            const starfieldPipeline = this.starfieldPipeline;
            if (!framebuffer || !colorBuffer || !depthBuffer || !rocksPipeline || !planetPipeline || !starfieldPipeline) {
                return;
            }

            this.updateConstants(width, height);
            commandList.writeBuffer(this.constantBuffer, Ref(this.constants[0]), CONST_FLOATS * 4);

            // Reversed depth: the far plane is 0. The star field covers the whole color buffer.
            commandList.clearDepth(depthBuffer, 0.0);

            // Star field
            frame.beginDrawToFramebuffer(starfieldPipeline, framebuffer);
            frame.drawVertices(3);

            // Planet
            frame.beginDrawToFramebuffer(planetPipeline, framebuffer);
            frame.drawAddBindingSet(this.planetBindingSet);
            frame.drawAddVertexBuffer(this.planet.getVertexBuffer(), 0, 0);
            frame.drawSetIndexBuffer(this.planet.getIndexBuffer());
            frame.drawIndexed(this.planet.getIndexCount());

            // Instanced rocks
            frame.beginDrawToFramebuffer(rocksPipeline, framebuffer);
            frame.drawAddBindingSet(this.rocksBindingSet);
            // Binding point 0 : Mesh vertex buffer
            frame.drawAddVertexBuffer(this.rock.getVertexBuffer(), 0, 0);
            // Binding point 1 : Instance data buffer
            frame.drawAddVertexBuffer(this.instanceBuffer, 1, 0);
            frame.drawSetIndexBuffer(this.rock.getIndexBuffer());
            // Render instances
            frame.drawIndexedInstanced(this.rock.getIndexCount(), INSTANCE_COUNT);

            this.app.blitTexture(frame, colorBuffer);
        }

        // The sample's prepare_instance_data: the rocks distributed randomly on two rings, half on
        // each, uploaded once.
        createInstanceBuffer(commandList: CommandList): Opaque {
            let instanceData: f32[] = [];
            for (let i = 0; i < INSTANCE_COUNT * INSTANCE_FLOATS; i++) {
                instanceData.push(0.0);
            }

            const ringRadii = [7.0, 11.0, 14.0, 18.0];
            for (let i = 0; i < INSTANCE_COUNT / 2; i++) {
                // Inner ring, then outer ring.
                for (let ring = 0; ring < 2; ring++) {
                    const innerRadius = ringRadii[ring * 2];
                    const outerRadius = ringRadii[ring * 2 + 1];
                    const instance = (i + ring * INSTANCE_COUNT / 2) * INSTANCE_FLOATS;

                    const rho = Math.sqrt((outerRadius * outerRadius - innerRadius * innerRadius) * randomFloat()
                        + innerRadius * innerRadius);
                    const theta = 2.0 * Math.PI * randomFloat();
                    instanceData[instance + 0] = rho * Math.cos(theta);
                    instanceData[instance + 1] = randomFloat() * 0.5 - 0.25;
                    instanceData[instance + 2] = rho * Math.sin(theta);
                    instanceData[instance + 3] = Math.PI * randomFloat();
                    instanceData[instance + 4] = Math.PI * randomFloat();
                    instanceData[instance + 5] = Math.PI * randomFloat();
                    instanceData[instance + 6] = (1.5 + randomFloat() - randomFloat()) * 0.75;
                    // A layer of the texture array (the sample's distribution also picks one past the
                    // last layer, which the sampler clamps to it).
                    const layer: int = Math.min(Math.floor(randomFloat() * ROCK_TEXTURE_LAYERS), ROCK_TEXTURE_LAYERS - 1);
                    Donut_StoreInt32(Ref(instanceData[instance + 7]), layer);
                }
            }

            return this.app.createStaticVertexBuffer(commandList, Ref(instanceData[0]),
                INSTANCE_COUNT * INSTANCE_SIZE, "InstanceBuffer");
        }

        createBindingSet(texture: Opaque): BindingSet {
            const setDesc = BindingSetDesc.create();
            setDesc.bindEntireConstantBuffer(0, this.constantBuffer);
            setDesc.bindTextureSRV(0, texture);
            setDesc.bindSampler(0, this.app.getCommonSampler(CommonSampler.AnisotropicWrap));
            return this.app.createBindingSetForLayout(setDesc, this.bindingLayout);
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(): boolean {
            this.rocksVS = this.app.createShader("instancing.hlsl", "instancing_vs", ShaderType.Vertex);
            this.rocksPS = this.app.createShader("instancing.hlsl", "instancing_ps", ShaderType.Pixel);
            this.planetVS = this.app.createShader("instancing.hlsl", "planet_vs", ShaderType.Vertex);
            this.planetPS = this.app.createShader("instancing.hlsl", "planet_ps", ShaderType.Pixel);
            this.starfieldVS = this.app.createShader("instancing.hlsl", "starfield_vs", ShaderType.Vertex);
            this.starfieldPS = this.app.createShader("instancing.hlsl", "starfield_ps", ShaderType.Pixel);
            if (!this.rocksVS || !this.rocksPS || !this.planetVS || !this.planetPS || !this.starfieldVS || !this.starfieldPS) {
                return false;
            }

            // The instancing pipeline uses a vertex input state with two bindings: the mesh's vertices
            // at per-vertex rate, the instance data at per-instance rate. The planet uses the first.
            const rocksLayoutDesc = InputLayoutDesc.create();
            rocksLayoutDesc.addVertexAttribute("POSITION", Format.RGB32_FLOAT, 0, 0, VERTEX_SIZE);
            rocksLayoutDesc.addVertexAttribute("NORMAL", Format.RGB32_FLOAT, 12, 0, VERTEX_SIZE);
            rocksLayoutDesc.addVertexAttribute("TEXCOORD", Format.RG32_FLOAT, 24, 0, VERTEX_SIZE);
            rocksLayoutDesc.addInstanceVertexAttribute("INSTANCE_POSITION", Format.RGB32_FLOAT, 0, 1, INSTANCE_SIZE);
            rocksLayoutDesc.addInstanceVertexAttribute("INSTANCE_ROTATION", Format.RGB32_FLOAT, 12, 1, INSTANCE_SIZE);
            rocksLayoutDesc.addInstanceVertexAttribute("INSTANCE_SCALE", Format.R32_FLOAT, 24, 1, INSTANCE_SIZE);
            rocksLayoutDesc.addInstanceVertexAttribute("INSTANCE_TEXINDEX", Format.R32_SINT, 28, 1, INSTANCE_SIZE);
            this.rocksInputLayout = this.app.createInputLayout(rocksLayoutDesc, this.rocksVS);

            const planetLayoutDesc = InputLayoutDesc.create();
            planetLayoutDesc.addVertexAttribute("POSITION", Format.RGB32_FLOAT, 0, 0, VERTEX_SIZE);
            planetLayoutDesc.addVertexAttribute("NORMAL", Format.RGB32_FLOAT, 12, 0, VERTEX_SIZE);
            planetLayoutDesc.addVertexAttribute("TEXCOORD", Format.RG32_FLOAT, 24, 0, VERTEX_SIZE);
            this.planetInputLayout = this.app.createInputLayout(planetLayoutDesc, this.planetVS);

            const commandList = this.app.createCommandList();
            commandList.open();
            const rock = this.app.loadGltfMesh(commandList, ROCK_PATH);
            const planet = this.app.loadGltfMesh(commandList, PLANET_PATH);
            // As the sample (vkb) loads KTX 1 color textures: as sRGB.
            const rockTextures = this.app.loadTexture(commandList, ROCK_TEXTURES_PATH, 1);
            const planetTexture = this.app.loadTexture(commandList, PLANET_TEXTURE_PATH, 1);
            this.instanceBuffer = this.createInstanceBuffer(commandList);
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.waitForIdle();
            this.app.releaseResource(commandList.handle);
            if (rock.isNull() || planet.isNull() || !rockTextures || !planetTexture) {
                console.log("Cannot load the models and textures: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return false;
            }
            this.rock = rock;
            this.planet = planet;

            this.constantBuffer = this.app.createVolatileConstantBuffer(CONST_FLOATS * 4, "UBO");

            const layoutDesc = BindingLayoutDesc.create();
            layoutDesc.layoutVolatileConstantBuffer(0);
            layoutDesc.layoutTextureSRV(0);
            layoutDesc.layoutSampler(0);
            this.bindingLayout = this.app.createBindingLayout(layoutDesc, ShaderType.All);

            this.rocksBindingSet = this.createBindingSet(rockTextures);
            this.planetBindingSet = this.createBindingSet(planetTexture);

            this.camera = this.app.createThirdPersonCamera();
            this.lookFromSampleCamera();
            this.camera.setMoveSpeed(5.0);
            this.view = this.app.createPlanarView();

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

        // The sample's look-at camera, rotated (-17.2, -4.7) degrees and translated by
        // (5.5, -1.85, -18.5): its view matrix is T * Rx * Ry. The orbit camera starts at its position,
        // looking at the point 18.5 ahead (as far ahead as the world's origin is), in Donut's world.
        lookFromSampleCamera(): void {
            const ca = Math.cos(radians(-17.2));
            const sa = Math.sin(radians(-17.2));
            const cb = Math.cos(radians(-4.7));
            const sb = Math.sin(radians(-4.7));
            // R = Rx * Ry (glm::rotate, column vectors), row by row.
            const r = [
                cb,       0.0, sb,
                sa * sb,  ca,  -sa * cb,
                -ca * sb, sa,  ca * cb,
            ];
            const t = [5.5, -1.85, -18.5];
            const distance = 18.5;

            // The camera's position, -R^T * t, and its forward direction, R^T * (0, 0, -1).
            const position: number[] = [];
            const target: number[] = [];
            for (let k = 0; k < 3; k++) {
                const p = -(r[k] * t[0] + r[3 + k] * t[1] + r[6 + k] * t[2]);
                const forward = -r[6 + k];
                position.push(p);
                target.push(p + forward * distance);
            }

            // To Donut's world (see updateConstants): y negated.
            this.camera.thirdPersonLookAt(position[0], -position[1], position[2], target[0], -target[1], target[2]);
        }
    }

    // The device's memory heaps: this process's usage and its budget, and the heaps' flags.
    class MemoryHeaps {
        usage: number[];
        budget: number[];
        flags: int[];
        totalUsage: number;
        totalBudget: number;

        constructor() {
            this.usage = [];
            this.budget = [];
            this.flags = [];
            this.totalUsage = 0.0;
            this.totalBudget = 0.0;
        }

        // The sample's update_device_memory_properties.
        query(app: App): void {
            const count = app.queryMemoryBudget();
            this.usage = [];
            this.budget = [];
            this.flags = [];
            this.totalUsage = 0.0;
            this.totalBudget = 0.0;
            for (let i = 0; i < count; i++) {
                this.usage.push(app.getMemoryHeapUsage(i));
                this.budget.push(app.getMemoryHeapBudget(i));
                this.flags.push(app.getMemoryHeapFlags(i));
                this.totalUsage += this.usage[i];
                this.totalBudget += this.budget[i];
            }
        }
    }

    // The sample's overlay.
    class UserInterface {
        private heaps: MemoryHeaps;

        constructor(heaps: MemoryHeaps) {
            this.heaps = heaps;
        }

        buildUI(): void {
            const h = this.heaps;
            Donut_ImGuiSetNextWindowPos(10.0, 10.0);
            Donut_ImGuiBegin("Memory Budget", 1);
            Donut_ImGuiText(`Total Memory Usage: ${formatMemory(h.totalUsage)}`);
            Donut_ImGuiText(`Total Memory Budget: ${formatMemory(h.totalBudget)}`);
            if (Donut_ImGuiCollapsingHeaderDefaultOpen("Memory Heap Details") != 0) {
                for (let i = 0; i < h.usage.length; i++) {
                    if (Donut_ImGuiCollapsingHeaderDefaultOpen(`Memory Heap Index: ${i}`) != 0) {
                        Donut_ImGuiText(`Usage: ${formatMemory(h.usage[i])}`);
                        Donut_ImGuiText(`Budget: ${formatMemory(h.budget[i])}`);
                        Donut_ImGuiText(`Heap Flag: ${heapFlagName(h.flags[i])}`);
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
        Donut_SetAppName("memory_budget");

        // -debug: the graphics API's debug layer and NVRHI's validation layer.
        // -noui: without the memory budget window.
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

        const instancing = new InstancingPass(app);
        if (!instancing.init()) {
            app.destroy();
            return 1;
        }

        // Read once the scene is loaded.
        const heaps = new MemoryHeaps();
        heaps.query(app);
        for (let i = 0; i < heaps.usage.length; i++) {
            console.log(`Memory heap ${i}: usage ${formatMemory(heaps.usage[i])}, budget ${formatMemory(heaps.budget[i])}, `
                + `${heapFlagName(heaps.flags[i])}`);
        }

        // Drawn after (over) the scene, and sees the mouse first.
        const gui = new UserInterface(heaps);
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
    return MemoryBudget.main(argc, argv);
}
