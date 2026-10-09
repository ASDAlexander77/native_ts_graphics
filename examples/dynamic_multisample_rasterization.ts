// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";

namespace DynamicMultisampleRasterization {
    const WINDOW_TITLE = "Donut Example: Dynamic Multisample Rasterization";

    // The sample's scene (Vulkan-Samples' assets): msaa's copy of the glTF file and of its base
    // color textures, and this example's own of the others (normal and metallic-roughness maps),
    // all ASTC sRGB KTX files decoded to DDS at build time (see VULKAN_SAMPLES_ASSETS_DIR in
    // CMakeLists.txt).
    const SCENE_DIR = "media/msaa/space_module/";
    const SCENE_PATH = SCENE_DIR + "SpaceModule.gltf";
    const OWN_TEXTURE_DIR = "media/dynamic_multisample_rasterization/";
    const OWN_TEXTURES = ["PlaneCylinderRoom_M_CylinderRoom_Normal", "PlaneCylinderRoom_M_CylinderRoom_OcclusionRoughnessMetallic",
        "T_Metal_S", "T_Pedestal_N", "T_Pedestal_S", "phone_NORM", "phone_SPEC"];

    // Donut_LoadGltfModel's vertices: float3 position, float3 normal, float2 texture coordinates.
    const VERTEX_FLOATS = 8;
    const VERTEX_SIZE = VERTEX_FLOATS * 4;

    // struct UBO { float4x4 projection, view; }.
    const UBO_PROJECTION = 0;
    const UBO_VIEW = 16;
    const UBO_FLOATS = 32;
    // The push constants: float4x4 model; float4 base_color_factor; float metallic_factor,
    // roughness_factor; uint baseTextureIndex, normalTextureIndex, metallicRoughnessTextureIndex.
    const PUSH_MODEL = 0;
    const PUSH_BASE_COLOR_FACTOR = 16;
    const PUSH_METALLIC_FACTOR = 20;
    const PUSH_ROUGHNESS_FACTOR = 21;
    const PUSH_TEXTURE_INDICES = 22;
    const PUSH_FLOATS = 25;
    const PUSH_SIZE = PUSH_FLOATS * 4;
    // The shader's texture bindings (the sample's array of 15).
    const MAX_TEXTURES = 15;

    // The sample's look-at camera: at (1.9, 10, -18) (vkb::Camera's position, the view's
    // translation), turned -40 degrees around y, rotating at a tenth of the usual speed; reversed
    // depth from 0.1 to 256.
    const CAMERA_POSITION = [1.9, 10.0, -18.0];
    const CAMERA_ROTATION = [0.0, -40.0, 0.0];
    const CAMERA_ROTATION_SPEED = 0.1;
    const CAMERA_FOV = 60.0;
    const Z_NEAR = 256.0;
    const Z_FAR = 0.1;

    const DEPTH_FORMAT = Format.D32;

    // The sample counts in the sample's order (its first supported one is the default).
    const SAMPLE_COUNTS = [4, 2, 8, 16, 32, 64, 1];

    // The draws' groups, in drawing order.
    const GROUP_OPAQUE = 0;
    const GROUP_OPAQUE_FLIPPED = 1;
    const GROUP_TRANSPARENT = 2;
    const GROUP_TRANSPARENT_FLIPPED = 3;

    function sampleCountName(count: int): string {
        return count == 1 ? "No MSAA" : `${count}X MSAA`;
    }

    // --- Math (glm's layout: 4 x 4 matrices by columns) ---------------------------------------

    function identity(): number[] {
        return [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0];
    }

    // a * b.
    function multiply(a: number[], b: number[]): number[] {
        let result: number[] = [];
        for (let column = 0; column < 4; column++) {
            for (let row = 0; row < 4; row++) {
                let sum = 0.0;
                for (let k = 0; k < 4; k++) {
                    sum += a[k * 4 + row] * b[column * 4 + k];
                }
                result.push(sum);
            }
        }
        return result;
    }

    // glm::rotate(m, angle, axis) for a unit axis.
    function rotate(m: number[], angle: number, x: number, y: number, z: number): number[] {
        const c = Math.cos(angle);
        const s = Math.sin(angle);
        const t = 1.0 - c;
        const r = [
            c + t * x * x,     t * x * y + s * z, t * x * z - s * y, 0.0,
            t * x * y - s * z, c + t * y * y,     t * y * z + s * x, 0.0,
            t * x * z + s * y, t * y * z - s * x, c + t * z * z,     0.0,
            0.0,               0.0,               0.0,               1.0,
        ];
        return multiply(m, r);
    }

    function radians(degrees: number): number {
        return degrees * Math.PI / 180.0;
    }

    // glm::perspective (right-handed, depth from 0 to 1); the sample swaps near and far for
    // reversed depth.
    function perspective(fov: number, aspect: number, zNear: number, zFar: number): number[] {
        const tanHalfFovy = Math.tan(0.5 * fov);
        return [
            1.0 / (aspect * tanHalfFovy), 0.0,               0.0,                              0.0,
            0.0,                          1.0 / tanHalfFovy, 0.0,                              0.0,
            0.0,                          0.0,               zFar / (zNear - zFar),            -1.0,
            0.0,                          0.0,               -(zFar * zNear) / (zFar - zNear), 0.0,
        ];
    }

    // The sample's camera (the framework's vkb::Camera, look-at type), with ApiVulkanSample's mouse
    // controls: the left button turns it (at its rotation speed), the right one zooms, the middle
    // one pans.
    class SampleCamera {
        rotation: number[];
        position: number[];
        private mouseX: number;
        private mouseY: number;
        private buttons: boolean[];

        constructor() {
            this.rotation = [CAMERA_ROTATION[0], CAMERA_ROTATION[1], CAMERA_ROTATION[2]];
            this.position = [CAMERA_POSITION[0], CAMERA_POSITION[1], CAMERA_POSITION[2]];
            this.mouseX = 0.0;
            this.mouseY = 0.0;
            this.buttons = [false, false, false];
        }

        // vkb::Camera::update_view_matrix: translate(position) * rotations around x, y, z.
        view(): number[] {
            let r = identity();
            r = rotate(r, radians(this.rotation[0]), 1.0, 0.0, 0.0);
            r = rotate(r, radians(this.rotation[1]), 0.0, 1.0, 0.0);
            r = rotate(r, radians(this.rotation[2]), 0.0, 0.0, 1.0);
            let t = identity();
            t[12] = this.position[0];
            t[13] = this.position[1];
            t[14] = this.position[2];
            return multiply(t, r);
        }

        // GLFW buttons: 0 left, 1 right, 2 middle; action 1 press, 0 release.
        mouseButton(button: int, action: int): void {
            if (button >= 0 && button < 3) {
                this.buttons[button] = action == 1;
            }
        }

        // ApiVulkanSample::handle_mouse_move.
        mouseMove(x: number, y: number): void {
            const dx = Math.floor(this.mouseX) - Math.floor(x);
            const dy = Math.floor(this.mouseY) - Math.floor(y);
            if (this.buttons[0]) {
                this.rotation[0] += dy * CAMERA_ROTATION_SPEED;
                this.rotation[1] -= dx * CAMERA_ROTATION_SPEED;
            }
            if (this.buttons[1]) {
                this.position[2] += dy * 0.005;
            }
            if (this.buttons[2]) {
                this.position[0] -= dx * 0.01;
                this.position[1] -= dy * 0.01;
            }
            this.mouseX = x;
            this.mouseY = y;
        }
    }

    // --- Pass -------------------------------------------------------------------------------

    // Port of Vulkan-Samples' dynamic_multisample_rasterization: the Space Module scene with its
    // normal and metallic-roughness maps, drawn multisampled (the sample count picked in the UI)
    // and resolved into the back buffer. The sample sets the count as dynamic state
    // (VK_EXT_extended_dynamic_state3) on pipelines made once; NVRHI has no such state, so here the
    // pipelines (opaque, opaque of flipped nodes, transparent, transparent of flipped nodes) are
    // made again with the targets when the count changes. The multisampled color resolves as the
    // render pass ends where render passes resolve (Vulkan, as the sample's dynamic rendering),
    // with a separate resolve on D3D.
    class DynamicMultisamplePass {
        private app: App;
        private camera: SampleCamera;

        // The sample count, the supported ones (Donut_GetSupportedSampleCounts bits, and in the
        // sample's order) and whether render passes resolve.
        sampleCount: int;
        supportedCounts: int[];
        private renderPassResolve: boolean;

        private vs: Opaque;
        private ps: Opaque;
        private inputLayout: Opaque;
        private bindingLayout: Opaque;
        private bindingSet: BindingSet;
        private uniformBuffer: Opaque;
        private vertexBuffer: Opaque;
        private indexBuffer: Opaque;

        // The draws, a node's primitive each, by group in the sample's order (by mesh, node,
        // primitive): index range and base vertex, push constants (PUSH_FLOATS each).
        private drawGroup: int[];
        private drawFirstIndex: int[];
        private drawIndexCount: int[];
        private drawBaseVertex: int[];
        private drawPush: f32[];

        // The targets and pipelines, for builtSampleCount (0: none yet) and the back buffers' size.
        private resources: Opaque[];
        private msColor: Opaque;
        private depth: Opaque;
        private framebuffers: Opaque[];
        private pipelines: Opaque[];
        private builtSampleCount: int;
        private builtWidth: int;
        private builtHeight: int;

        // Upload buffers.
        private ubo: f32[];
        private push: f32[];

        constructor(app: App) {
            this.app = app;
            this.camera = new SampleCamera();
            this.sampleCount = 1;
            this.supportedCounts = [];
            this.renderPassResolve = false;
            this.drawGroup = [];
            this.drawFirstIndex = [];
            this.drawIndexCount = [];
            this.drawBaseVertex = [];
            this.drawPush = [];
            this.resources = [];
            this.framebuffers = [];
            this.pipelines = [];
            this.builtSampleCount = 0;
            this.builtWidth = 0;
            this.builtHeight = 0;
            this.ubo = [];
            for (let i = 0; i < UBO_FLOATS; i++) {
                this.ubo.push(0.0);
            }
            this.push = [];
            for (let i = 0; i < PUSH_FLOATS; i++) {
                this.push.push(0.0);
            }
        }

        onMousePos(x: number, y: number): int {
            this.camera.mouseMove(x, y);
            return 1;
        }

        onMouseButton(button: int, action: int, mods: int): int {
            this.camera.mouseButton(button, action);
            return 1;
        }

        onAnimate(elapsedSeconds: number): void {
            this.app.setInformativeWindowTitle(WINDOW_TITLE);
        }

        // The framebuffers of the back buffers go before the back buffers do.
        onBackBufferResizing(): void {
            this.releaseTargets();
        }

        releaseTargets(): void {
            for (let i = 0; i < this.resources.length; i++) {
                this.app.releaseResource(this.resources[i]);
            }
            this.resources = [];
            this.framebuffers = [];
            this.pipelines = [];
            this.builtSampleCount = 0;
        }

        own(resource: Opaque): Opaque {
            this.resources.push(resource);
            return resource;
        }

        // The sample's attachments_setup and prepare_pipelines: the multisampled color (the back
        // buffer's format) and depth, a framebuffer per back buffer (resolving into it as the render
        // pass ends) or one for a separate resolve, and the pipelines: reversed depth (greater),
        // back faces culled, counter-clockwise front faces (clockwise for flipped nodes), the
        // transparent ones blended.
        createTargets(width: int, height: int): void {
            this.app.waitForIdle();
            this.releaseTargets();
            const msaa = this.sampleCount > 1;
            const colorFormat = this.app.getBackBufferFormat();
            this.depth = this.own(this.app.createMultisampledTexture(width, height, DEPTH_FORMAT, this.sampleCount, 0.0, "Depth"));
            if (msaa) {
                this.msColor = this.own(this.app.createMultisampledTexture(width, height, colorFormat, this.sampleCount, 0.0,
                    "Multisampled Color"));
            }
            const count = this.app.getBackBufferCount();
            if (!msaa) {
                for (let i = 0; i < count; i++) {
                    this.framebuffers.push(this.own(this.app.createFramebuffer(this.app.getBackBuffer(i), this.depth)));
                }
            } else if (this.renderPassResolve) {
                for (let i = 0; i < count; i++) {
                    this.framebuffers.push(this.own(this.app.createResolveFramebuffer(this.msColor, this.app.getBackBuffer(i),
                        this.depth, null, ResolveMode.None)));
                }
            } else {
                this.framebuffers.push(this.own(this.app.createFramebuffer(this.msColor, this.depth)));
            }

            for (let group = 0; group < 4; group++) {
                const desc = GraphicsPipelineDesc.create(this.vs, this.ps);
                desc.setInputLayout(this.inputLayout);
                desc.addBindingLayout(this.bindingLayout);
                desc.setDepthState(1, 1, ComparisonFunc.Greater);
                const flipped = group == GROUP_OPAQUE_FLIPPED || group == GROUP_TRANSPARENT_FLIPPED;
                desc.setRasterState(CullMode.Back, FillMode.Solid, flipped ? 0 : 1);
                if (group == GROUP_TRANSPARENT || group == GROUP_TRANSPARENT_FLIPPED) {
                    desc.setBlendState(1, BlendFactor.SrcAlpha, BlendFactor.InvSrcAlpha, BlendOp.Add,
                        BlendFactor.InvSrcAlpha, BlendFactor.Zero, BlendOp.Add);
                }
                this.pipelines.push(this.own(this.app.createGraphicsPipelineFromDesc(desc, this.framebuffers[0])));
            }
            this.builtSampleCount = this.sampleCount;
            this.builtWidth = width;
            this.builtHeight = height;
        }

        onRender(frameHandle: Opaque): void {
            const frame = new Frame(frameHandle);
            const width = frame.getWidth();
            const height = frame.getHeight();
            const commandList = frame.getCommandList();

            if (this.builtSampleCount != this.sampleCount || this.builtWidth != width || this.builtHeight != height) {
                this.createTargets(width, height);
            }

            // The sample's update_uniform_buffers: its projection (clip y negated for Donut), and
            // its view scaled down (the model is pretty large) and flipped upside down.
            const projection = perspective(radians(CAMERA_FOV), width / height, Z_NEAR, Z_FAR);
            const view = this.camera.view();
            for (let i = 0; i < 16; i++) {
                this.ubo[UBO_PROJECTION + i] = i % 4 == 1 ? -projection[i] : projection[i];
                const column = Math.floor(i / 4);
                this.ubo[UBO_VIEW + i] = view[i] * (column == 1 ? -0.1 : column == 3 ? 1.0 : 0.1);
            }
            commandList.writeBuffer(this.uniformBuffer, Ref(this.ubo[0]), UBO_FLOATS * 4);

            // The render pass: color cleared to transparent black, depth to 0 (reversed).
            const index = this.app.getCurrentBackBufferIndex();
            const backBuffer = this.app.getBackBuffer(index);
            const msaa = this.builtSampleCount > 1;
            commandList.clearTextureFloat(msaa ? this.msColor : backBuffer, 0.0, 0.0, 0.0, 0.0);
            commandList.clearDepth(this.depth, 0.0);
            const framebuffer = this.framebuffers.length > 1 ? this.framebuffers[index] : this.framebuffers[0];

            for (let group = 0; group < 4; group++) {
                for (let d = 0; d < this.drawGroup.length; d++) {
                    if (this.drawGroup[d] != group) {
                        continue;
                    }
                    for (let i = 0; i < PUSH_FLOATS; i++) {
                        this.push[i] = this.drawPush[d * PUSH_FLOATS + i];
                    }
                    frame.beginDrawToFramebuffer(this.pipelines[group], framebuffer);
                    frame.drawAddBindingSet(this.bindingSet);
                    frame.drawSetIndexBuffer(this.indexBuffer);
                    frame.drawAddVertexBuffer(this.vertexBuffer, 0, 0);
                    frame.drawIndexedRangeWithPushConstants(this.drawIndexCount[d], this.drawFirstIndex[d], this.drawBaseVertex[d],
                        Ref(this.push[0]), PUSH_SIZE);
                }
            }

            if (msaa && !this.renderPassResolve) {
                commandList.resolveTexture(backBuffer, this.msColor);
            }
        }

        // The sample's load_assets: the scene's vertices and indices in one buffer each, its
        // textures (in the file's order: the shader's indices), and the draws, by group, in the
        // framework's order (by mesh, node, primitive), recorded into an open command list.
        loadScene(commandList: CommandList, setDesc: BindingSetDesc): boolean {
            const scene = this.app.loadGltfModel(SCENE_PATH);
            if (scene.isNull()) {
                return false;
            }

            const textureCount = scene.getTextureCount();
            if (textureCount > MAX_TEXTURES) {
                console.log(`${SCENE_PATH} has more than ${MAX_TEXTURES} textures`);
                return false;
            }
            let lastTexture: Opaque | null = null;
            for (let t = 0; t < textureCount; t++) {
                const image = scene.getTextureImage(t);
                const dot = image.lastIndexOf(".");
                const name = dot >= 0 ? image.substring(0, dot) : image;
                let dir = SCENE_DIR;
                for (let k = 0; k < OWN_TEXTURES.length; k++) {
                    if (OWN_TEXTURES[k] == name) {
                        dir = OWN_TEXTURE_DIR;
                    }
                }
                const texture = this.app.loadTexture(commandList, dir + name + ".dds", 1);
                if (!texture) {
                    return false;
                }
                setDesc.bindTextureSRV(t, texture);
                lastTexture = texture;
            }
            // The unused bindings (the sample's array is partly bound too).
            for (let t = textureCount; t < MAX_TEXTURES; t++) {
                if (lastTexture) {
                    setDesc.bindTextureSRV(t, lastTexture);
                }
            }

            const primitiveCount = scene.getPrimitiveCount();
            let vertices: f32[] = [];
            let indices: int[] = [];
            let firstIndex: int[] = [];
            let baseVertex: int[] = [];
            let meshCount = 0;
            for (let p = 0; p < primitiveCount; p++) {
                const vertexCount = scene.getVertexCount(p);
                const indexCount = scene.getIndexCount(p);
                let primitiveVertices: f32[] = [];
                for (let i = 0; i < vertexCount * VERTEX_FLOATS; i++) {
                    primitiveVertices.push(0.0);
                }
                let primitiveIndices: int[] = [];
                for (let i = 0; i < indexCount; i++) {
                    primitiveIndices.push(0);
                }
                scene.copyVertices(p, Ref(primitiveVertices[0]));
                scene.copyIndices(p, Ref(primitiveIndices[0]));
                baseVertex.push(vertices.length / VERTEX_FLOATS);
                firstIndex.push(indices.length);
                for (let v = 0; v < vertexCount * VERTEX_FLOATS; v++) {
                    vertices.push(primitiveVertices[v]);
                }
                for (let i = 0; i < indexCount; i++) {
                    indices.push(primitiveIndices[i]);
                }
                meshCount = Math.max(meshCount, scene.getPrimitiveMesh(p) + 1);
            }

            let transform: f32[] = [];
            let factor: f32[] = [0.0, 0.0, 0.0, 0.0];
            for (let i = 0; i < 16; i++) {
                transform.push(0.0);
            }
            const nodeCount = scene.getNodeCount();
            for (let mesh = 0; mesh < meshCount; mesh++) {
                for (let node = 0; node < nodeCount; node++) {
                    if (scene.getNodeMesh(node) != mesh) {
                        continue;
                    }
                    scene.copyNodeTransform(node, Ref(transform[0]));
                    // Flipped: scaled by a negative factor (the determinant of its world transform).
                    const determinant = transform[0] * (transform[5] * transform[10] - transform[9] * transform[6])
                        - transform[4] * (transform[1] * transform[10] - transform[9] * transform[2])
                        + transform[8] * (transform[1] * transform[6] - transform[5] * transform[2]);
                    for (let p = 0; p < primitiveCount; p++) {
                        if (scene.getPrimitiveMesh(p) != mesh) {
                            continue;
                        }
                        const transparent = scene.getPrimitiveAlphaMode(p) == AlphaMode.Blend;
                        const flipped = determinant < 0.0;
                        this.drawGroup.push(transparent ? (flipped ? GROUP_TRANSPARENT_FLIPPED : GROUP_TRANSPARENT)
                            : (flipped ? GROUP_OPAQUE_FLIPPED : GROUP_OPAQUE));
                        this.drawFirstIndex.push(firstIndex[p]);
                        this.drawIndexCount.push(scene.getIndexCount(p));
                        this.drawBaseVertex.push(baseVertex[p]);
                        // The sample's draw_node: the node's transform, the material's factors and
                        // texture indices (-1: none).
                        const pushStart = this.drawPush.length;
                        for (let i = 0; i < PUSH_FLOATS; i++) {
                            this.drawPush.push(0.0);
                        }
                        for (let i = 0; i < 16; i++) {
                            this.drawPush[pushStart + PUSH_MODEL + i] = transform[i];
                        }
                        scene.copyBaseColorFactor(p, Ref(factor[0]));
                        for (let i = 0; i < 4; i++) {
                            this.drawPush[pushStart + PUSH_BASE_COLOR_FACTOR + i] = factor[i];
                        }
                        this.drawPush[pushStart + PUSH_METALLIC_FACTOR] = scene.getMaterialFactor(p, 0);
                        this.drawPush[pushStart + PUSH_ROUGHNESS_FACTOR] = scene.getMaterialFactor(p, 1);
                        for (let k = 0; k < 3; k++) {
                            Donut_StoreInt32(Ref(this.drawPush[pushStart + PUSH_TEXTURE_INDICES + k]), scene.getMaterialTexture(p, k));
                        }
                    }
                }
            }
            this.app.releaseResource(scene.handle);

            this.vertexBuffer = this.app.createStaticVertexBuffer(commandList, Ref(vertices[0]), vertices.length * 4, "Vertices");
            this.indexBuffer = this.app.createStaticIndexBuffer(commandList, Ref(indices[0]), indices.length * 4, "Indices");
            return true;
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(): boolean {
            const shader = "dynamic_multisample_rasterization.hlsl";
            this.vs = this.app.createShader(shader, "model_vs", ShaderType.Vertex);
            this.ps = this.app.createShader(shader, "model_ps", ShaderType.Pixel);
            if (!this.vs || !this.ps) {
                return false;
            }

            // The sample's prepare_supported_sample_count_list.
            const supported = this.app.getSupportedSampleCounts(this.app.getBackBufferFormat(), DEPTH_FORMAT);
            for (let i = 0; i < SAMPLE_COUNTS.length; i++) {
                if ((supported & SAMPLE_COUNTS[i]) != 0) {
                    this.supportedCounts.push(SAMPLE_COUNTS[i]);
                }
            }
            this.sampleCount = this.supportedCounts.length > 0 ? this.supportedCounts[0] : 1;
            this.renderPassResolve = this.app.hasRenderPassResolve() != 0;

            const layoutDesc = InputLayoutDesc.create();
            layoutDesc.addVertexAttribute("POSITION", Format.RGB32_FLOAT, 0, 0, VERTEX_SIZE);
            layoutDesc.addVertexAttribute("NORMAL", Format.RGB32_FLOAT, 12, 0, VERTEX_SIZE);
            layoutDesc.addVertexAttribute("TEXCOORD", Format.RG32_FLOAT, 24, 0, VERTEX_SIZE);
            this.inputLayout = this.app.createInputLayout(layoutDesc, this.vs);

            this.uniformBuffer = this.app.createVolatileConstantBuffer(UBO_FLOATS * 4, "UBO");
            const bindingLayoutDesc = BindingLayoutDesc.create();
            bindingLayoutDesc.layoutVolatileConstantBuffer(0);
            bindingLayoutDesc.layoutPushConstants(1, PUSH_SIZE);
            for (let t = 0; t < MAX_TEXTURES; t++) {
                bindingLayoutDesc.layoutTextureSRV(t);
            }
            bindingLayoutDesc.layoutSampler(0);
            this.bindingLayout = this.app.createBindingLayout(bindingLayoutDesc, ShaderType.All);

            // The glTF file's sampler: trilinear, repeating (Donut's common passes, which hold the
            // samplers, upload on a command list of their own: before ours is open).
            const sampler = this.app.getCommonSampler(CommonSampler.LinearWrap);
            const setDesc = BindingSetDesc.create();
            setDesc.bindEntireConstantBuffer(0, this.uniformBuffer);
            setDesc.bindPushConstants(1, PUSH_SIZE);
            setDesc.bindSampler(0, sampler);

            const commandList = this.app.createCommandList();
            commandList.open();
            const loaded = this.loadScene(commandList, setDesc);
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.waitForIdle();
            this.app.releaseResource(commandList.handle);
            if (!loaded) {
                console.log("Cannot load the scene: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return false;
            }
            this.bindingSet = this.app.createBindingSetForLayout(setDesc, this.bindingLayout);

            const pass = this.app.addPass();
            pass.setMousePosCallback(this.onMousePos);
            pass.setMouseButtonCallback(this.onMouseButton);
            pass.setAnimateCallback(this.onAnimate);
            pass.setBackBufferResizingCallback(this.onBackBufferResizing);
            pass.setRenderCallback(this.onRender);
            return true;
        }
    }

    // The sample's overlay.
    class UserInterface {
        private sample: DynamicMultisamplePass;
        private names: string;

        constructor(sample: DynamicMultisamplePass) {
            this.sample = sample;
            this.names = "";
        }

        buildUI(): void {
            const sample = this.sample;
            if (this.names.length == 0) {
                for (let i = 0; i < sample.supportedCounts.length; i++) {
                    this.names += (i > 0 ? "|" : "") + sampleCountName(sample.supportedCounts[i]);
                }
            }
            let current = 0;
            for (let i = 0; i < sample.supportedCounts.length; i++) {
                if (sample.supportedCounts[i] == sample.sampleCount) {
                    current = i;
                }
            }
            Donut_ImGuiSetNextWindowPos(10.0, 10.0);
            Donut_ImGuiBegin("Dynamic Multisample Rasterization", 1);
            Donut_ImGuiPushItemWidth(110.0);
            if (Donut_ImGuiCollapsingHeaderDefaultOpen("Settings") != 0 && sample.supportedCounts.length > 0) {
                current = Donut_ImGuiCombo("antialiasing", current, this.names);
                sample.sampleCount = sample.supportedCounts[current];
            }
            Donut_ImGuiPopItemWidth();
            Donut_ImGuiEnd();
        }

        // Declared after buildUI: tslang resolves `this.buildUI` only for members declared earlier.
        init(app: App): boolean {
            return !app.addImGuiPass(this.buildUI).isNull();
        }
    }

    export function main(argc: int, argv: Ref<string>): int {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("dynamic_multisample_rasterization");

        // -debug: the graphics API's debug layer and NVRHI's validation layer.
        // -noui: without the settings window.
        // -samples <count>: the initial sample count (when supported).
        let options = AppOptions.None;
        let withUI = true;
        let samples = 0;
        for (let i = 1; i < argc; i++) {
            const arg = Donut_GetArg(argv, i);
            if (arg == "-debug") {
                options = AppOptions.DebugRuntime;
            } else if (arg == "-noui") {
                withUI = false;
            } else if (arg == "-samples" && i + 1 < argc) {
                i++;
                samples = parseInt(Donut_GetArg(argv, i));
            }
        }

        const api = Donut_GetGraphicsAPIFromCommandLine(argc, argv);
        const app = App.createWithOptions(api, WINDOW_TITLE, 1280, 720, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        const sample = new DynamicMultisamplePass(app);
        if (!sample.init()) {
            app.destroy();
            return 1;
        }
        for (let i = 0; i < sample.supportedCounts.length; i++) {
            if (sample.supportedCounts[i] == samples) {
                sample.sampleCount = samples;
            }
        }

        // Drawn after (over) the scene, and sees the mouse first.
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
    return DynamicMultisampleRasterization.main(argc, argv);
}
