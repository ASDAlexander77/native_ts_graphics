// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";

namespace ExtendedDynamicState2 {
    const WINDOW_TITLE = "Donut Example: Extended Dynamic State 2";

    const SCENE_PATH = "media/extended_dynamic_state2/primitives.gltf";
    const BACKGROUND_PATH = "media/extended_dynamic_state2/cube.gltf";
    const ENVMAP_PATH = "media/extended_dynamic_state2/uffizi_rgba16f_cube.dds";

    // The scene's meshes in the framework's order (its nodes breadth first: Sphere_1 holds the
    // others). The geosphere is tessellated, the others drawn by the baseline pipeline; Cube_1 moves
    // against Cube_2 (z-fighting, which depth bias settles).
    const SCENE_ORDER = ["Sphere_1", "Cube_1", "Cube_2", "Geosphere", "Sphere_2", "Sphere_3"];
    const TESSELLATED = "Geosphere";
    const MOVING = "Cube_1";

    // Donut_LoadGltfModel's vertices (and Donut_LoadGltfMesh's): position, normal, texture
    // coordinates.
    const VERTEX_FLOATS = 8;

    // The sample's camera: a look-at camera at (2, -4, -10) turned by (-15, 190, 0) degrees, a 60
    // degree vertical field of view, depth reversed (near 256, far 0.1, as the sample passes them).
    const CAMERA_POSITION = [2.0, -4.0, -10.0];
    const CAMERA_ROTATION = [-15.0, 190.0, 0.0];
    const CAMERA_FOV = 60.0;
    const Z_NEAR = 256.0;
    const Z_FAR = 0.1;

    // UBOBAS: ambient light color, light position, light color, light intensity.
    const BASELINE_CONSTANTS = [
        1.0, 1.0, 1.0, 0.1,
        -3.0, -8.0, 6.0, -1.0,
        1.0, 1.0, 1.0, 1.0,
        50.0, 0.0, 0.0, 0.0,
    ];
    // Push constants: the model matrix and the color.
    const NODE_FLOATS = 20;

    // The cube drawn as triangle strips restarting at 0xFFFFFFFF: corners of a unit cube (and
    // their normals, the sum of their faces'), scaled by 4 and moved by (15, 2, 0).
    const RESTART_INDICES = [0, 4, 3, 7, -1, 1, 0, 2, 3, -1, 2, 6, 1, 5, -1, 1, 5, 0, 4, -1, 4, 5, 7, 6, -1, 2, 3, 6, 7];
    const RESTART_COLOR = [0.5, 1.0, 1.0, 1.0];

    // The selection effect's alpha and the moving cube's x: the sample steps them every 0.05 seconds.
    const TICK = 0.05;
    const ALPHA_STEP = 0.075;
    const ALPHA_MAX = 0.98;
    const ALPHA_MIN = 0.3;
    const MOVE_DELTA = 0.05;
    const MOVE_STEP = 0.0005;

    // ImGui's combo items: names separated by '|'.
    function comboItems(names: string[]): string {
        let items = "";
        for (let i = 0; i < names.length; i++) {
            items += (i > 0 ? "|" : "") + names[i];
        }
        return items;
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

    // glm::perspective (right-handed, depth from 0 to 1); with near > far, depth is reversed.
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
    // controls: the left button turns it, the right one zooms, the middle one pans.
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

        // ApiVulkanSample::handle_mouse_move, with its speeds (1).
        mouseMove(x: number, y: number): void {
            const dx = Math.floor(this.mouseX) - Math.floor(x);
            const dy = Math.floor(this.mouseY) - Math.floor(y);
            if (this.buttons[0]) {
                this.rotation[0] += dy;
                this.rotation[1] -= dx;
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

    // A mesh node of the scene: its primitive's range of the shared buffers, world transform and
    // material color, and the UI's settings for it.
    class SceneNode {
        name: string;
        firstIndex: int;
        indexCount: int;
        baseVertex: int;
        transform: number[];
        color: number[];
        depthBias: boolean;
        rasterizerDiscard: boolean;

        constructor(name: string, firstIndex: int, indexCount: int, baseVertex: int, transform: number[], color: number[]) {
            this.name = name;
            this.firstIndex = firstIndex;
            this.indexCount = indexCount;
            this.baseVertex = baseVertex;
            this.transform = transform;
            this.color = color;
            this.depthBias = false;
            this.rasterizerDiscard = false;
        }
    }

    // --- Pass -------------------------------------------------------------------------------

    // Port of Vulkan-Samples' extended_dynamic_state2: a few primitives over an environment cube
    // map, each with depth bias and rasterizer discard switched in the UI (two cubes in the same
    // place z-fight until one has depth bias), a cube drawn as triangle strips with primitive
    // restart, and a geosphere tessellated as a wireframe. The sample sets these as dynamic state
    // (VK_EXT_extended_dynamic_state2: depth bias, rasterizer discard, primitive restart, patch
    // control points); here they're pipelines of their own, and rasterizer discard, which D3D
    // doesn't have, skips the draw (discarding every primitive draws nothing either).
    class ExtendedDynamicState2Pass {
        private app: App;
        private camera: SampleCamera;

        // The sample's settings, from its UI.
        tessellation: boolean;
        tessFactor: number;
        selectionActive: boolean;
        selectedObject: int;
        // The baseline pipeline's nodes (the UI's objects) and the tessellated ones.
        baselineNodes: SceneNode[];
        tessNodes: SceneNode[];
        // Seconds per frame instead of the clock's (0: the clock's).
        fixedDelta: number;

        // The animations' state (the sample's statics): rounded to float as the sample's are.
        private timePass: f32[];
        private difference: f32[];
        private rising: boolean;
        private accumulatedDiff: f32[];
        private alphaRise: boolean;
        private previousSelected: int;
        private movingNode: int;
        private movingX: number;
        private parentScaleX: number;
        private scratch: f32[];

        private baselineVS: Opaque;
        private baselinePS: Opaque;
        private backgroundVS: Opaque;
        private backgroundPS: Opaque;
        private tessVS: Opaque;
        private tessHS: Opaque;
        private tessDS: Opaque;
        private tessPS: Opaque;
        private inputLayout: Opaque;
        private bindingLayout: Opaque;
        private bindingSet: BindingSet;
        private commonBuffer: Opaque;
        private baselineBuffer: Opaque;
        private tessBuffer: Opaque;
        private vertexBuffer: Opaque;
        private indexBuffer: Opaque;
        private restartVertexBuffer: Opaque;
        private restartIndexBuffer: Opaque;
        private background: GltfMesh;

        // The depth buffer (reversed) and a framebuffer per back buffer, for the back buffers' size,
        // and the pipelines, made for them.
        private depth: Opaque;
        private framebuffers: Opaque[];
        private targetWidth: int;
        private targetHeight: int;
        private backgroundPipeline: Opaque;
        private baselinePipeline: Opaque;
        private biasedPipeline: Opaque;
        private restartPipeline: Opaque;
        private tessPipeline: Opaque;

        // Upload buffers.
        private commonConstants: f32[];
        private baselineConstants: f32[];
        private tessConstants: f32[];
        private nodeConstants: f32[];

        constructor(app: App) {
            this.app = app;
            this.camera = new SampleCamera();
            this.tessellation = false;
            this.tessFactor = 1.0;
            this.selectionActive = true;
            this.selectedObject = 0;
            this.baselineNodes = [];
            this.tessNodes = [];
            this.fixedDelta = 0.0;
            this.timePass = [0.0];
            this.difference = [0.0];
            this.rising = true;
            this.accumulatedDiff = [0.0];
            this.alphaRise = false;
            this.previousSelected = 0;
            this.movingNode = -1;
            this.movingX = 0.0;
            this.parentScaleX = 0.0;
            this.scratch = [0.0];
            this.framebuffers = [];
            this.targetWidth = 0;
            this.targetHeight = 0;
            this.commonConstants = [];
            for (let i = 0; i < 32; i++) {
                this.commonConstants.push(0.0);
            }
            this.baselineConstants = [];
            for (let i = 0; i < BASELINE_CONSTANTS.length; i++) {
                this.baselineConstants.push(BASELINE_CONSTANTS[i]);
            }
            this.tessConstants = [0.0, 0.0, 0.0, 0.0];
            this.nodeConstants = [];
            for (let i = 0; i < NODE_FLOATS; i++) {
                this.nodeConstants.push(0.0);
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

        // x rounded to float.
        fround(x: number): number {
            this.scratch[0] = x;
            return this.scratch[0];
        }

        // The sample's cube_animation: every 0.05 seconds the moving cube steps along x (back and
        // forth by up to 0.05), and the selection effect's alpha steps too.
        onAnimate(elapsedSeconds: number): void {
            this.app.setInformativeWindowTitle(WINDOW_TITLE);
            const delta = this.fround(this.fixedDelta > 0.0 ? this.fixedDelta : elapsedSeconds);
            this.timePass[0] = this.timePass[0] + delta;
            if (this.timePass[0] > this.fround(TICK)) {
                if (this.difference[0] < -this.fround(MOVE_DELTA)) {
                    this.rising = true;
                } else if (this.difference[0] > this.fround(MOVE_DELTA)) {
                    this.rising = false;
                }
                if (this.rising) {
                    this.difference[0] = this.difference[0] + this.fround(MOVE_STEP);
                } else {
                    this.difference[0] = this.difference[0] - this.fround(MOVE_STEP);
                }
                this.timePass[0] = 0.0;
                // The node's translation is in its parent's space (Sphere_1's, scaled).
                if (this.movingNode >= 0) {
                    this.baselineNodes[this.movingNode].transform[12] = this.movingX + this.parentScaleX * this.difference[0];
                }
                this.tickAlpha();
            }
        }

        // The sample's get_changed_alpha, at a tick (it consumes the tick as it rebuilds the
        // command buffers): the selected node's alpha steps down to 0.3 and up to 0.98.
        tickAlpha(): void {
            this.accumulatedDiff[0] = this.accumulatedDiff[0] + this.fround(this.alphaRise ? ALPHA_STEP : -ALPHA_STEP);
            this.updateAlphaDirection();
        }

        selectedAlpha(): number {
            return this.fround(this.baselineNodes[this.selectedObject].color[3] + this.accumulatedDiff[0]);
        }

        updateAlphaDirection(): void {
            if (this.previousSelected != this.selectedObject) {
                this.accumulatedDiff[0] = 0.0;
                this.previousSelected = this.selectedObject;
            }
            const alpha = this.selectedAlpha();
            if (alpha < this.fround(ALPHA_MIN)) {
                this.alphaRise = true;
            } else if (alpha > this.fround(ALPHA_MAX)) {
                this.alphaRise = false;
            }
        }

        // The framebuffers of the back buffers go before the back buffers do.
        onBackBufferResizing(): void {
            this.releaseTargets();
        }

        releaseTargets(): void {
            for (let i = 0; i < this.framebuffers.length; i++) {
                this.app.releaseResource(this.framebuffers[i]);
            }
            if (this.framebuffers.length > 0) {
                this.app.releaseResource(this.depth);
                this.app.releaseResource(this.backgroundPipeline);
                this.app.releaseResource(this.baselinePipeline);
                this.app.releaseResource(this.biasedPipeline);
                this.app.releaseResource(this.restartPipeline);
                this.app.releaseResource(this.tessPipeline);
            }
            this.framebuffers = [];
            this.targetWidth = 0;
            this.targetHeight = 0;
        }

        // The sample's pipeline state: depth test (greater: reversed) and write, blending by the
        // source's alpha (the alpha written as is), back faces culled, clockwise front faces.
        pipelineDesc(vs: Opaque, ps: Opaque): GraphicsPipelineDesc {
            const desc = GraphicsPipelineDesc.create(vs, ps);
            desc.setInputLayout(this.inputLayout);
            desc.addBindingLayout(this.bindingLayout);
            desc.setDepthState(1, 1, ComparisonFunc.Greater);
            desc.setRasterState(CullMode.Back, FillMode.Solid, 0);
            desc.setBlendState(1, BlendFactor.SrcAlpha, BlendFactor.InvSrcAlpha, BlendOp.Add,
                BlendFactor.One, BlendFactor.Zero, BlendOp.Add);
            return desc;
        }

        createTargets(width: int, height: int): void {
            this.releaseTargets();
            this.depth = this.app.createDepthTexture(width, height, Format.D32, 0.0, "Depth");
            const count = this.app.getBackBufferCount();
            for (let i = 0; i < count; i++) {
                this.framebuffers.push(this.app.createFramebuffer(this.app.getBackBuffer(i), this.depth));
            }
            const framebuffer = this.framebuffers[0];

            // The background: counter-clockwise front faces.
            const background = this.pipelineDesc(this.backgroundVS, this.backgroundPS);
            background.setRasterState(CullMode.Back, FillMode.Solid, 1);
            this.backgroundPipeline = this.app.createGraphicsPipelineFromDesc(background, framebuffer);

            // The baseline: with and without depth bias (1, slope 1).
            this.baselinePipeline = this.app.createGraphicsPipelineFromDesc(this.pipelineDesc(this.baselineVS, this.baselinePS),
                framebuffer);
            const biased = this.pipelineDesc(this.baselineVS, this.baselinePS);
            biased.setDepthBias(1, 0.0, 1.0);
            this.biasedPipeline = this.app.createGraphicsPipelineFromDesc(biased, framebuffer);

            // Triangle strips, restarting at 0xFFFFFFFF.
            const restart = this.pipelineDesc(this.baselineVS, this.baselinePS);
            restart.setPrimitiveType(PrimitiveType.TriangleStrip);
            restart.setPrimitiveRestart(Format.R32_UINT);
            this.restartPipeline = this.app.createGraphicsPipelineFromDesc(restart, framebuffer);

            // Triangle patches (3 control points), as a wireframe if the device draws one, front
            // faces culled (counter-clockwise ones, the background's state carried over).
            const tess = this.pipelineDesc(this.tessVS, this.tessPS);
            tess.setTessellation(this.tessHS, this.tessDS, 3);
            tess.setRasterState(CullMode.Front, FillMode.Wireframe, 1);
            this.tessPipeline = this.app.createGraphicsPipelineFromDesc(tess, framebuffer);

            this.targetWidth = width;
            this.targetHeight = height;
        }

        // A draw of the shared buffers' range with a node's push constants.
        drawNode(frame: Frame, pipeline: Opaque, framebuffer: Opaque, node: SceneNode, alpha: number): void {
            for (let i = 0; i < 16; i++) {
                this.nodeConstants[i] = node.transform[i];
            }
            for (let i = 0; i < 3; i++) {
                this.nodeConstants[16 + i] = node.color[i];
            }
            this.nodeConstants[19] = alpha;
            frame.beginDrawToFramebuffer(pipeline, framebuffer);
            frame.drawAddBindingSet(this.bindingSet);
            frame.drawSetIndexBuffer(this.indexBuffer);
            frame.drawAddVertexBuffer(this.vertexBuffer, 0, 0);
            frame.drawIndexedRangeWithPushConstants(node.indexCount, node.firstIndex, node.baseVertex,
                Ref(this.nodeConstants[0]), NODE_FLOATS * 4);
        }

        onRender(frameHandle: Opaque): void {
            const frame = new Frame(frameHandle);
            const width = frame.getWidth();
            const height = frame.getHeight();
            const commandList = frame.getCommandList();

            if (this.targetWidth != width || this.targetHeight != height) {
                this.createTargets(width, height);
            }

            // The sample's update_uniform_buffers: its projection, into Donut's clip space (y
            // negated), and view; the tessellation factor (0 when off: factors of 1).
            const projection = perspective(radians(CAMERA_FOV), width / height, Z_NEAR, Z_FAR);
            const view = this.camera.view();
            for (let i = 0; i < 16; i++) {
                this.commonConstants[i] = i % 4 == 1 ? -projection[i] : projection[i];
                this.commonConstants[16 + i] = view[i];
            }
            commandList.writeBuffer(this.commonBuffer, Ref(this.commonConstants[0]), 32 * 4);
            commandList.writeBuffer(this.baselineBuffer, Ref(this.baselineConstants[0]), BASELINE_CONSTANTS.length * 4);
            this.tessConstants[0] = this.tessellation ? this.tessFactor : 0.0;
            commandList.writeBuffer(this.tessBuffer, Ref(this.tessConstants[0]), 4 * 4);

            // The render pass: cleared to transparent black, depth to 0.
            const backBuffer = this.app.getBackBuffer(this.app.getCurrentBackBufferIndex());
            commandList.clearTextureFloat(backBuffer, 0.0, 0.0, 0.0, 0.0);
            commandList.clearDepth(this.depth, 0.0);
            const framebuffer = this.framebuffers[this.app.getCurrentBackBufferIndex()];

            // The background.
            for (let i = 0; i < 16; i++) {
                this.nodeConstants[i] = i % 5 == 0 ? 1.0 : 0.0;
            }
            frame.beginDrawToFramebuffer(this.backgroundPipeline, framebuffer);
            frame.drawAddBindingSet(this.bindingSet);
            frame.drawSetIndexBuffer(this.background.getIndexBuffer());
            frame.drawAddVertexBuffer(this.background.getVertexBuffer(), 0, 0);
            frame.drawIndexedRangeWithPushConstants(this.background.getIndexCount(), 0, 0, Ref(this.nodeConstants[0]),
                NODE_FLOATS * 4);

            // The baseline scene, with each node's depth bias and rasterizer discard (as nothing
            // drawn), the selected node blinking.
            this.updateAlphaDirection();
            for (let i = 0; i < this.baselineNodes.length; i++) {
                const node = this.baselineNodes[i];
                if (node.rasterizerDiscard) {
                    continue;
                }
                const alpha = this.selectionActive && i == this.selectedObject ? this.selectedAlpha() : node.color[3];
                this.drawNode(frame, node.depthBias ? this.biasedPipeline : this.baselinePipeline, framebuffer, node, alpha);
            }

            // The cube of triangle strips with primitive restart.
            for (let i = 0; i < 4; i++) {
                this.nodeConstants[16 + i] = RESTART_COLOR[i];
            }
            frame.beginDrawToFramebuffer(this.restartPipeline, framebuffer);
            frame.drawAddBindingSet(this.bindingSet);
            frame.drawSetIndexBuffer(this.restartIndexBuffer);
            frame.drawAddVertexBuffer(this.restartVertexBuffer, 0, 0);
            frame.drawIndexedRangeWithPushConstants(RESTART_INDICES.length, 0, 0, Ref(this.nodeConstants[0]), NODE_FLOATS * 4);

            // The tessellated scene.
            for (let i = 0; i < this.tessNodes.length; i++) {
                const node = this.tessNodes[i];
                this.drawNode(frame, this.tessPipeline, framebuffer, node, node.color[3]);
            }
        }

        // The sample's load_assets and model_data_creation.
        loadModels(commandList: CommandList): boolean {
            const model = this.app.loadGltfModel(SCENE_PATH);
            this.background = this.app.loadGltfMesh(commandList, BACKGROUND_PATH);
            if (model.isNull() || this.background.isNull()) {
                return false;
            }

            // Every primitive in the shared buffers, then the nodes in the framework's order.
            const primitiveCount = model.getPrimitiveCount();
            let vertices: f32[] = [];
            let indices: int[] = [];
            let firstIndex: int[] = [];
            let indexCounts: int[] = [];
            let baseVertex: int[] = [];
            for (let p = 0; p < primitiveCount; p++) {
                const vertexCount = model.getVertexCount(p);
                const indexCount = model.getIndexCount(p);
                let primitiveVertices: f32[] = [];
                for (let i = 0; i < vertexCount * VERTEX_FLOATS; i++) {
                    primitiveVertices.push(0.0);
                }
                let primitiveIndices: int[] = [];
                for (let i = 0; i < indexCount; i++) {
                    primitiveIndices.push(0);
                }
                model.copyVertices(p, Ref(primitiveVertices[0]));
                model.copyIndices(p, Ref(primitiveIndices[0]));
                baseVertex.push(vertices.length / VERTEX_FLOATS);
                firstIndex.push(indices.length);
                indexCounts.push(indexCount);
                for (let v = 0; v < vertexCount * VERTEX_FLOATS; v++) {
                    vertices.push(primitiveVertices[v]);
                }
                for (let i = 0; i < indexCount; i++) {
                    indices.push(primitiveIndices[i]);
                }
            }

            let transform: f32[] = [];
            for (let i = 0; i < 16; i++) {
                transform.push(0.0);
            }
            let color: f32[] = [0.0, 0.0, 0.0, 0.0];
            const nodeCount = model.getNodeCount();
            for (let o = 0; o < SCENE_ORDER.length; o++) {
                for (let p = 0; p < primitiveCount; p++) {
                    if (model.getMeshName(p) != SCENE_ORDER[o]) {
                        continue;
                    }
                    for (let n = 0; n < nodeCount; n++) {
                        if (model.getNodeMesh(n) != model.getPrimitiveMesh(p)) {
                            continue;
                        }
                        model.copyNodeTransform(n, Ref(transform[0]));
                        model.copyBaseColorFactor(p, Ref(color[0]));
                        let t: number[] = [];
                        for (let i = 0; i < 16; i++) {
                            t.push(transform[i]);
                        }
                        const node = new SceneNode(SCENE_ORDER[o], firstIndex[p], indexCounts[p], baseVertex[p], t,
                            [color[0], color[1], color[2], color[3]]);
                        if (SCENE_ORDER[o] == TESSELLATED) {
                            this.tessNodes.push(node);
                        } else {
                            if (SCENE_ORDER[o] == MOVING) {
                                this.movingNode = this.baselineNodes.length;
                                this.movingX = t[12];
                            } else if (o == 0) {
                                // Sphere_1, the moving cube's parent: its x scale.
                                this.parentScaleX = t[0];
                            }
                            this.baselineNodes.push(node);
                        }
                    }
                }
            }
            this.vertexBuffer = this.app.createStaticVertexBuffer(commandList, Ref(vertices[0]), vertices.length * 4, "Vertices");
            this.indexBuffer = this.app.createStaticIndexBuffer(commandList, Ref(indices[0]), indices.length * 4, "Indices");

            // The restarting cube: its 8 corners, normals the sum of their faces'.
            let cube: f32[] = [];
            for (let v = 0; v < 8; v++) {
                const x = v == 1 || v == 2 || v == 5 || v == 6 ? 1.0 : 0.0;
                const y = v == 2 || v == 3 || v == 6 || v == 7 ? 1.0 : 0.0;
                const z = v >= 4 ? 1.0 : 0.0;
                cube.push(x * 4.0 + 15.0);
                cube.push(y * 4.0 + 2.0);
                cube.push(z * 4.0);
                const s = 1.0 / Math.sqrt(3.0);
                cube.push((x * 2.0 - 1.0) * s);
                cube.push((y * 2.0 - 1.0) * s);
                cube.push((z * 2.0 - 1.0) * s);
                cube.push(0.0);
                cube.push(0.0);
            }
            let restartIndices: int[] = [];
            for (let i = 0; i < RESTART_INDICES.length; i++) {
                restartIndices.push(RESTART_INDICES[i]);
            }
            this.restartVertexBuffer = this.app.createStaticVertexBuffer(commandList, Ref(cube[0]), cube.length * 4, "CubeVertices");
            this.restartIndexBuffer = this.app.createStaticIndexBuffer(commandList, Ref(restartIndices[0]), restartIndices.length * 4,
                "CubeIndices");
            return true;
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(): boolean {
            const shader = "extended_dynamic_state2.hlsl";
            this.baselineVS = this.app.createShader(shader, "baseline_vs", ShaderType.Vertex);
            this.baselinePS = this.app.createShader(shader, "baseline_ps", ShaderType.Pixel);
            this.backgroundVS = this.app.createShader(shader, "background_vs", ShaderType.Vertex);
            this.backgroundPS = this.app.createShader(shader, "background_ps", ShaderType.Pixel);
            this.tessVS = this.app.createShader(shader, "tess_vs", ShaderType.Vertex);
            this.tessHS = this.app.createShader(shader, "tess_hs", ShaderType.Hull);
            this.tessDS = this.app.createShader(shader, "tess_ds", ShaderType.Domain);
            this.tessPS = this.app.createShader(shader, "tess_ps", ShaderType.Pixel);
            if (!this.baselineVS || !this.baselinePS || !this.backgroundVS || !this.backgroundPS || !this.tessVS || !this.tessHS
                || !this.tessDS || !this.tessPS) {
                return false;
            }

            const layoutDesc = InputLayoutDesc.create();
            layoutDesc.addVertexAttribute("POSITION", Format.RGB32_FLOAT, 0, 0, VERTEX_FLOATS * 4);
            layoutDesc.addVertexAttribute("NORMAL", Format.RGB32_FLOAT, 12, 0, VERTEX_FLOATS * 4);
            this.inputLayout = this.app.createInputLayout(layoutDesc, this.baselineVS);

            const commandList = this.app.createCommandList();
            commandList.open();
            const loaded = this.loadModels(commandList);
            const envmap = this.app.loadTexture(commandList, ENVMAP_PATH, 0);
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.waitForIdle();
            this.app.releaseResource(commandList.handle);
            if (!loaded || !envmap) {
                console.log("Cannot load the models and the cube map: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return false;
            }
            this.previousSelected = this.selectedObject;
            this.updateAlphaDirection();

            this.commonBuffer = this.app.createVolatileConstantBuffer(32 * 4, "UBOCOMM");
            this.baselineBuffer = this.app.createVolatileConstantBuffer(BASELINE_CONSTANTS.length * 4, "UBOBAS");
            this.tessBuffer = this.app.createVolatileConstantBuffer(4 * 4, "UBOTESS");
            // The sample's cube map sampler: trilinear and anisotropic, clamped.
            const sampler = this.app.createSamplerWithDesc(1, 1, 1, SamplerAddressMode.Clamp, 0.0, 0.0, 1000.0,
                this.app.getMaxSamplerAnisotropy());

            const bindingLayoutDesc = BindingLayoutDesc.create();
            bindingLayoutDesc.layoutVolatileConstantBuffer(0);
            bindingLayoutDesc.layoutVolatileConstantBuffer(1);
            bindingLayoutDesc.layoutPushConstants(2, NODE_FLOATS * 4);
            bindingLayoutDesc.layoutVolatileConstantBuffer(3);
            bindingLayoutDesc.layoutTextureSRV(0);
            bindingLayoutDesc.layoutSampler(0);
            this.bindingLayout = this.app.createBindingLayout(bindingLayoutDesc, ShaderType.All);
            const setDesc = BindingSetDesc.create();
            setDesc.bindEntireConstantBuffer(0, this.commonBuffer);
            setDesc.bindEntireConstantBuffer(1, this.baselineBuffer);
            setDesc.bindPushConstants(2, NODE_FLOATS * 4);
            setDesc.bindEntireConstantBuffer(3, this.tessBuffer);
            setDesc.bindTextureSRV(0, envmap);
            setDesc.bindSampler(0, sampler);
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

    // The sample's options.
    class UserInterface {
        private pass: ExtendedDynamicState2Pass;

        constructor(pass: ExtendedDynamicState2Pass) {
            this.pass = pass;
        }

        buildUI(): void {
            const p = this.pass;
            Donut_ImGuiSetNextWindowPos(10.0, 10.0);
            Donut_ImGuiBegin("Options", 1);
            if (Donut_ImGuiCollapsingHeaderDefaultOpen("Settings") != 0) {
                p.tessellation = Donut_ImGuiCheckbox("Tessellation Enable", p.tessellation ? 1 : 0) != 0;
                // Maximum tessellation factor is set to 4.0
                p.tessFactor = Donut_ImGuiSliderFloat("Tessellation Factor", p.tessFactor, 1.0, 4.0);
            }
            if (Donut_ImGuiCollapsingHeaderDefaultOpen("Models") != 0) {
                p.selectionActive = Donut_ImGuiCheckbox("Selection effect active", p.selectionActive ? 1 : 0) != 0;
                let names: string[] = [];
                for (let i = 0; i < p.baselineNodes.length; i++) {
                    names.push(p.baselineNodes[i].name);
                }
                p.selectedObject = Donut_ImGuiCombo("Name", p.selectedObject, comboItems(names));
                const node = p.baselineNodes[p.selectedObject];
                node.depthBias = Donut_ImGuiCheckbox("Depth Bias Enable", node.depthBias ? 1 : 0) != 0;
                node.rasterizerDiscard = Donut_ImGuiCheckbox("Rasterizer Discard", node.rasterizerDiscard ? 1 : 0) != 0;
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
        Donut_SetAppName("extended_dynamic_state2");

        // -debug: the graphics API's debug layer and NVRHI's validation layer.
        // -noui: without the options window. -benchmark: 1/60 second per frame (as vulkan_samples'
        // --benchmark). -tessellation <factor>: tessellation on. -bias <object>, -discard <object>:
        // depth bias or rasterizer discard for an object of the UI's list. -noselection: the
        // selection effect off.
        let options = AppOptions.None;
        let withUI = true;
        let benchmark = false;
        let tessFactor = 0.0;
        let bias = -1;
        let discard = -1;
        let selection = true;
        for (let i = 1; i < argc; i++) {
            const arg = Donut_GetArg(argv, i);
            if (arg == "-debug") {
                options = AppOptions.DebugRuntime;
            } else if (arg == "-noui") {
                withUI = false;
            } else if (arg == "-benchmark") {
                benchmark = true;
            } else if (arg == "-tessellation" && i + 1 < argc) {
                tessFactor = parseFloat(Donut_GetArg(argv, i + 1));
                i++;
            } else if (arg == "-bias" && i + 1 < argc) {
                bias = parseInt(Donut_GetArg(argv, i + 1));
                i++;
            } else if (arg == "-discard" && i + 1 < argc) {
                discard = parseInt(Donut_GetArg(argv, i + 1));
                i++;
            } else if (arg == "-noselection") {
                selection = false;
            }
        }

        const api = Donut_GetGraphicsAPIFromCommandLine(argc, argv);
        const app = App.createWithOptions(api, WINDOW_TITLE, 1280, 720, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        const pass = new ExtendedDynamicState2Pass(app);
        if (!pass.init()) {
            app.destroy();
            return 1;
        }
        if (benchmark) {
            pass.fixedDelta = 1.0 / 60.0;
        }
        if (tessFactor > 0.0) {
            pass.tessellation = true;
            pass.tessFactor = Math.min(tessFactor, 4.0);
        }
        if (bias >= 0 && bias < pass.baselineNodes.length) {
            pass.baselineNodes[bias].depthBias = true;
        }
        if (discard >= 0 && discard < pass.baselineNodes.length) {
            pass.baselineNodes[discard].rasterizerDiscard = true;
        }
        pass.selectionActive = selection;

        // Drawn after (over) the scene, and sees the mouse first.
        const gui = new UserInterface(pass);
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
    return ExtendedDynamicState2.main(argc, argv);
}
