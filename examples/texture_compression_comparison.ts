// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";

namespace TextureCompressionComparison {
    const WINDOW_TITLE = "Donut Example: Texture Compression Comparison";

    // The sample's scene (Vulkan-Samples' assets, copied at build time, see VULKAN_SAMPLES_ASSETS_DIR
    // in CMakeLists.txt): Sponza, its images loaded from the Basis Universal KTX 2 files beside it
    // (ktx2/<image name>2) rather than from the KTX 1 files it names.
    const SCENE_DIR = "media/texture_compression_comparison/sponza/";
    const SCENE_PATH = SCENE_DIR + "Sponza01.gltf";

    // Donut_LoadGltfModel's vertices: float3 position, float3 normal, float2 texture coordinates.
    const VERTEX_FLOATS = 8;
    const VERTEX_SIZE = VERTEX_FLOATS * 4;

    // struct SceneConstants { float4x4 viewProj; float4 lightColor, lightDirection; }, as f32 offsets
    // (msaa.hlsl's: the framework's base.vert and base.frag).
    const CONST_VIEW_PROJ = 0;
    const CONST_LIGHT_COLOR = 16;
    const CONST_LIGHT_DIRECTION = 20;
    const CONST_FLOATS = 24;
    // The draws' push constants: their node's transform.
    const MODEL_FLOATS = 16;
    const MODEL_SIZE = MODEL_FLOATS * 4;

    // The scene's camera node (main_camera): position, and orientation (x, y, z, w), its
    // perspective's vertical field of view and depth range.
    const CAMERA_POSITION = [-705.01001, 195.20282, -119.932266];
    const CAMERA_ROTATION = [-0.004728, -0.775409, -0.005807, 0.631416];
    const CAMERA_FOV = 1.0;
    const Z_NEAR = 1.0;
    const Z_FAR = 4000.0;
    // The sample's free camera: 50 units per step, times its speed multiplier of 3, per second.
    const CAMERA_MOVE_SPEED = 150.0;

    // The scene's directional light: white, intensity 1, on a node with this rotation (x, y, z, w).
    const LIGHT_COLOR = [1.0, 1.0, 1.0, 1.0];
    const LIGHT_ROTATION = [-0.683013, -0.183013, 0.183013, 0.683013];

    // The sample's formats: the transcoder's target, the texture format (-1: none in NVRHI), their
    // names (libktx's, and short).
    const TRANSCODE_FORMATS = [TranscodeFormat.RGBA32, TranscodeFormat.BC7, TranscodeFormat.BC3, TranscodeFormat.ASTC4x4,
        TranscodeFormat.ETC2];
    const TEXTURE_FORMATS = [Format.SRGBA8_UNORM, Format.BC7_UNORM_SRGB, Format.BC3_UNORM_SRGB, -1, -1];
    const FORMAT_NAMES = ["KTX_TTF_RGBA32", "KTX_TTF_BC7_RGBA", "KTX_TTF_BC3_RGBA", "KTX_TTF_ASTC_4x4_RGBA", "KTX_TTF_ETC2_RGBA"];
    const SHORT_NAMES = ["RGBA 32", "BC7", "BC3", "ASTC 4x4", "ETC2"];
    // nvrhi::FormatSupport::Texture.
    const FORMAT_SUPPORT_TEXTURE = 0x8;

    // Bounds start out inverted.
    const HUGE = 1.0e30;

    // --- Math (glm's layout: 4 x 4 matrices by columns, quaternions as x, y, z, w) --------------

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

    // glm::mat3_cast(q) * v.
    function rotate(q: number[], v: number[]): number[] {
        const x = q[0];
        const y = q[1];
        const z = q[2];
        const w = q[3];
        return [
            (1.0 - 2.0 * (y * y + z * z)) * v[0] + 2.0 * (x * y - w * z) * v[1] + 2.0 * (x * z + w * y) * v[2],
            2.0 * (x * y + w * z) * v[0] + (1.0 - 2.0 * (x * x + z * z)) * v[1] + 2.0 * (y * z - w * x) * v[2],
            2.0 * (x * z - w * y) * v[0] + 2.0 * (y * z + w * x) * v[1] + (1.0 - 2.0 * (x * x + y * y)) * v[2],
        ];
    }

    // The framework's PerspectiveCamera::get_projection, glm::perspective(fov, aspect, far, near)
    // (near and far swapped for reversed depth; right-handed, depth from 0 to 1).
    function reversedPerspective(fov: number, aspect: number, zNear: number, zFar: number): number[] {
        const tanHalfFovy = Math.tan(0.5 * fov);
        const n = zFar;
        const f = zNear;
        return [
            1.0 / (aspect * tanHalfFovy), 0.0,               0.0,                0.0,
            0.0,                          1.0 / tanHalfFovy, 0.0,                0.0,
            0.0,                          0.0,               f / (n - f),        -1.0,
            0.0,                          0.0,               -(f * n) / (f - n), 0.0,
        ];
    }

    // The framework's vulkan_style_projection: [1][1] negated, for Vulkan's clip space (y down).
    function vulkanStyleProjection(m: number[]): number[] {
        let result: number[] = [];
        for (let i = 0; i < 16; i++) {
            result.push(i == 5 ? -m[i] : m[i]);
        }
        return result;
    }

    // A matrix into the sample's clip space, into Donut's (y up on the screen): clip y negated.
    function toDonutClip(m: number[]): number[] {
        let result: number[] = [];
        for (let i = 0; i < 16; i++) {
            result.push(i % 4 == 1 ? -m[i] : m[i]);
        }
        return result;
    }

    // --- Pass -------------------------------------------------------------------------------

    // Port of Vulkan-Samples' texture_compression_comparison: Sponza forward shaded (the
    // framework's base shaders), its textures transcoded from Basis Universal KTX 2 files into the
    // format picked in the UI (RGBA8, BC7, BC3; ASTC 4x4 and ETC2 aren't NVRHI formats), the
    // transcoding timed and the texture bytes counted, as the sample's update_textures.
    class TextureCompressionComparisonPass {
        private app: App;
        private camera: Camera;

        // The format picked in the UI, the one the textures are in, and whether to transcode again.
        guiFormat: int;
        currentFormat: int;
        requireRedraw: boolean;
        // The last transcoding's time (milliseconds) and bytes.
        compressTimeMs: number;
        totalBytes: number;

        private pipeline: Opaque;
        private bindingLayout: Opaque;
        private constantBuffer: Opaque;
        private sampler: Opaque;
        private vertexBuffer: Opaque;
        private indexBuffer: Opaque;
        private depth: Opaque;
        private framebuffers: Opaque[];
        private targetWidth: int;
        private targetHeight: int;

        // The scene's images (by URI) and, for the current format, their textures and binding sets.
        private imageNames: string[];
        private textures: Opaque[];
        private bindingSets: BindingSet[];

        // The draws, a node's primitive each: index range and base vertex, image (imageNames index),
        // node transform (MODEL_FLOATS each, from models), and world bounds center (3 each), in the
        // framework's order: by mesh, node, primitive. Sponza's materials are all opaque.
        private drawFirstIndex: int[];
        private drawIndexCount: int[];
        private drawBaseVertex: int[];
        private drawTexture: int[];
        private drawCenters: number[];
        private models: f32[];
        // The draws in drawing order: front to back.
        private order: int[];
        private distances: number[];

        // Upload buffers.
        private constants: f32[];
        private stats: f32[];
        // Donut's view matrix, 16 floats.
        private viewMatrix: f32[];

        constructor(app: App) {
            this.app = app;
            this.guiFormat = 0;
            this.currentFormat = 0;
            this.requireRedraw = true;
            this.compressTimeMs = 0.0;
            this.totalBytes = 0.0;
            this.framebuffers = [];
            this.targetWidth = 0;
            this.targetHeight = 0;
            this.imageNames = [];
            this.textures = [];
            this.bindingSets = [];
            this.drawFirstIndex = [];
            this.drawIndexCount = [];
            this.drawBaseVertex = [];
            this.drawTexture = [];
            this.drawCenters = [];
            this.models = [];
            this.order = [];
            this.distances = [];
            this.constants = [];
            for (let i = 0; i < CONST_FLOATS; i++) {
                this.constants.push(0.0);
            }
            this.stats = [0.0, 0.0];
            this.viewMatrix = [];
            for (let i = 0; i < 16; i++) {
                this.viewMatrix.push(0.0);
            }
        }

        // The sample's is_texture_format_supported: a format NVRHI has, that the device samples.
        isFormatSupported(index: int): boolean {
            const format = TEXTURE_FORMATS[index];
            return format >= 0 && (this.app.queryFormatSupport(format) & FORMAT_SUPPORT_TEXTURE) != 0;
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

        onAnimate(elapsedSeconds: number): void {
            this.camera.animate(elapsedSeconds);
            this.app.setInformativeWindowTitleWithInfo(WINDOW_TITLE, SHORT_NAMES[this.currentFormat]);
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
            }
            this.framebuffers = [];
            this.targetWidth = 0;
            this.targetHeight = 0;
        }

        createTargets(width: int, height: int): void {
            this.releaseTargets();
            this.depth = this.app.createDepthTexture(width, height, Format.D32, 0.0, "Depth");
            const count = this.app.getBackBufferCount();
            for (let i = 0; i < count; i++) {
                this.framebuffers.push(this.app.createFramebuffer(this.app.getBackBuffer(i), this.depth));
            }
            this.targetWidth = width;
            this.targetHeight = height;
        }

        // The sample's update_textures and compress: every image of the scene transcoded from its
        // KTX 2 file into the format (each once), the time and bytes summed; the textures replaced,
        // their uploads recorded into an open command list (the frame's: the previous textures stay
        // alive until the GPU is done with them).
        updateTextures(commandList: CommandList, formatIndex: int): boolean {
            for (let i = 0; i < this.textures.length; i++) {
                this.app.releaseResource(this.bindingSets[i].handle);
                this.app.releaseResource(this.textures[i]);
            }
            this.textures = [];
            this.bindingSets = [];

            let time = 0.0;
            let bytes = 0.0;
            let loaded = true;
            for (let t = 0; t < this.imageNames.length; t++) {
                const name = this.imageNames[t];
                const file = this.app.loadBinaryFile(SCENE_DIR + "ktx2/" + name + "2");
                if (file.isNull()) {
                    loaded = false;
                    break;
                }
                const transcoded = Donut_TranscodeKtx2(file.getData(), file.getSize(), TRANSCODE_FORMATS[formatIndex], Ref(this.stats[0]));
                this.app.releaseObject(file.handle);
                if (!transcoded) {
                    loaded = false;
                    break;
                }
                const image = transcoded as Opaque;
                time += this.stats[0];
                bytes += this.stats[1];

                const levels = Donut_GetTranscodedLevelCount(image);
                const texture = this.app.createTextureWithLevels(Donut_GetTranscodedWidth(image), Donut_GetTranscodedHeight(image),
                    levels, TEXTURE_FORMATS[formatIndex], name);
                for (let level = 0; level < levels; level++) {
                    commandList.writeTextureLevel(texture, level, Donut_GetTranscodedLevelData(image, level),
                        Donut_GetTranscodedLevelRowPitch(image, level));
                }
                Donut_DestroyTranscodedTexture(image);
                this.textures.push(texture);

                const setDesc = BindingSetDesc.create();
                setDesc.bindEntireConstantBuffer(0, this.constantBuffer);
                setDesc.bindTextureSRV(0, texture);
                setDesc.bindSampler(0, this.sampler);
                setDesc.bindPushConstants(1, MODEL_SIZE);
                this.bindingSets.push(this.app.createBindingSetForLayout(setDesc, this.bindingLayout));
            }

            this.compressTimeMs = time;
            this.totalBytes = bytes;
            return loaded;
        }

        // The framework's GeometrySubpass order, from a camera at (x, y, z): front to back, by the
        // distance to the node's bounds; stable, as its multimap.
        sortDraws(x: number, y: number, z: number): void {
            const count = this.drawIndexCount.length;
            for (let d = 0; d < count; d++) {
                const dx = this.drawCenters[d * 3] - x;
                const dy = this.drawCenters[d * 3 + 1] - y;
                const dz = this.drawCenters[d * 3 + 2] - z;
                this.distances[d] = Math.sqrt(dx * dx + dy * dy + dz * dz);
            }
            for (let d = 0; d < count; d++) {
                let i = d;
                while (i > 0 && this.distances[this.order[i - 1]] > this.distances[d]) {
                    this.order[i] = this.order[i - 1];
                    i--;
                }
                this.order[i] = d;
            }
        }

        onRender(frameHandle: FrameHandle): void {
            const frame = new Frame(frameHandle);
            const width = frame.getWidth();
            const height = frame.getHeight();
            const commandList = frame.getCommandList();

            // The sample's update: the textures transcoded again when the UI asks.
            if (this.requireRedraw) {
                this.requireRedraw = false;
                if (!this.updateTextures(commandList, this.currentFormat)) {
                    console.log("Cannot transcode the scene's KTX 2 textures");
                }
            }
            if (this.targetWidth != width || this.targetHeight != height) {
                this.createTargets(width, height);
            }

            // The scene uniforms: the camera's view-projection in Donut's clip space, the light.
            this.camera.getWorldToView(Ref(this.viewMatrix[0]));
            let view: number[] = [];
            for (let i = 0; i < 16; i++) {
                view.push(i % 4 == 2 ? -this.viewMatrix[i] : this.viewMatrix[i]);
            }
            const viewProj = toDonutClip(multiply(vulkanStyleProjection(reversedPerspective(CAMERA_FOV, width / height, Z_NEAR, Z_FAR)), view));
            const c = this.constants;
            for (let i = 0; i < 16; i++) {
                c[CONST_VIEW_PROJ + i] = viewProj[i];
            }
            for (let i = 0; i < 4; i++) {
                c[CONST_LIGHT_COLOR + i] = LIGHT_COLOR[i];
            }
            const direction = rotate(LIGHT_ROTATION, [0.0, 0.0, -1.0]);
            for (let i = 0; i < 3; i++) {
                c[CONST_LIGHT_DIRECTION + i] = direction[i];
            }
            c[CONST_LIGHT_DIRECTION + 3] = 0.0;
            commandList.writeBuffer(this.constantBuffer, Ref(c[0]), CONST_FLOATS * 4);

            // The forward pass: cleared to black, depth to 0.
            const index = this.app.getCurrentBackBufferIndex();
            commandList.clearTextureFloat(this.app.getBackBuffer(index), 0.0, 0.0, 0.0, 1.0);
            commandList.clearDepth(this.depth, 0.0);
            if (this.bindingSets.length != this.imageNames.length) {
                return;
            }
            // The camera's position: -R^T t of its view [R t].
            const v = this.viewMatrix;
            let position: number[] = [0.0, 0.0, 0.0];
            for (let column = 0; column < 3; column++) {
                for (let row = 0; row < 3; row++) {
                    position[column] -= v[column * 4 + row] * v[12 + row];
                }
            }
            this.sortDraws(position[0], position[1], position[2]);
            let currentTexture = -1;
            for (let i = 0; i < this.order.length; i++) {
                const d = this.order[i];
                const texture = this.drawTexture[d];
                if (texture != currentTexture) {
                    frame.beginDrawToFramebuffer(this.pipeline, this.framebuffers[index]);
                    frame.drawAddBindingSet(this.bindingSets[texture]);
                    frame.drawSetIndexBuffer(this.indexBuffer);
                    frame.drawAddVertexBuffer(this.vertexBuffer, 0, 0);
                    currentTexture = texture;
                }
                frame.drawIndexedRangeWithPushConstants(this.drawIndexCount[d], this.drawFirstIndex[d], this.drawBaseVertex[d],
                    Ref(this.models[d * MODEL_FLOATS]), MODEL_SIZE);
            }
        }

        // The scene's draws: every node's primitives, their vertices and indices in one vertex and
        // one index buffer, recorded into an open command list.
        loadScene(commandList: CommandList): boolean {
            const scene = this.app.loadGltfModel(SCENE_PATH);
            if (scene.isNull()) {
                return false;
            }
            const primitiveCount = scene.getPrimitiveCount();

            let primitiveTexture: int[] = [];
            let primitiveFirstIndex: int[] = [];
            let primitiveBaseVertex: int[] = [];
            let vertices: f32[] = [];
            let indices: int[] = [];
            let meshBounds: number[] = [];
            let meshFirstPrimitive: int[] = [];
            for (let p = 0; p < primitiveCount; p++) {
                const image = scene.getBaseColorImage(p);
                let texture = -1;
                for (let t = 0; t < this.imageNames.length; t++) {
                    if (this.imageNames[t] == image) {
                        texture = t;
                    }
                }
                if (texture < 0) {
                    texture = this.imageNames.length;
                    this.imageNames.push(image);
                }
                primitiveTexture.push(texture);

                const mesh = scene.getPrimitiveMesh(p);
                if (mesh == meshFirstPrimitive.length) {
                    meshFirstPrimitive.push(p);
                    for (let k = 0; k < 3; k++) {
                        meshBounds.push(HUGE);
                    }
                    for (let k = 0; k < 3; k++) {
                        meshBounds.push(-HUGE);
                    }
                }

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

                primitiveBaseVertex.push(vertices.length / VERTEX_FLOATS);
                primitiveFirstIndex.push(indices.length);
                for (let i = 0; i < vertexCount * VERTEX_FLOATS; i++) {
                    vertices.push(primitiveVertices[i]);
                }
                for (let i = 0; i < indexCount; i++) {
                    indices.push(primitiveIndices[i]);
                }
                for (let i = 0; i < vertexCount * VERTEX_FLOATS; i += VERTEX_FLOATS) {
                    for (let k = 0; k < 3; k++) {
                        meshBounds[mesh * 6 + k] = Math.min(meshBounds[mesh * 6 + k], primitiveVertices[i + k]);
                        meshBounds[mesh * 6 + 3 + k] = Math.max(meshBounds[mesh * 6 + 3 + k], primitiveVertices[i + k]);
                    }
                }
            }
            meshFirstPrimitive.push(primitiveCount);

            const nodeCount = scene.getNodeCount();
            let transform: f32[] = [];
            for (let i = 0; i < 16; i++) {
                transform.push(0.0);
            }
            for (let mesh = 0; mesh + 1 < meshFirstPrimitive.length; mesh++) {
                for (let node = 0; node < nodeCount; node++) {
                    if (scene.getNodeMesh(node) != mesh) {
                        continue;
                    }
                    scene.copyNodeTransform(node, Ref(transform[0]));
                    let low: number[] = [HUGE, HUGE, HUGE];
                    let high: number[] = [-HUGE, -HUGE, -HUGE];
                    for (let corner = 0; corner < 8; corner++) {
                        const x = meshBounds[mesh * 6 + ((corner & 1) != 0 ? 3 : 0)];
                        const y = meshBounds[mesh * 6 + 1 + ((corner & 2) != 0 ? 3 : 0)];
                        const z = meshBounds[mesh * 6 + 2 + ((corner & 4) != 0 ? 3 : 0)];
                        for (let k = 0; k < 3; k++) {
                            const value = transform[k] * x + transform[4 + k] * y + transform[8 + k] * z + transform[12 + k];
                            low[k] = Math.min(low[k], value);
                            high[k] = Math.max(high[k], value);
                        }
                    }
                    for (let p = meshFirstPrimitive[mesh]; p < meshFirstPrimitive[mesh + 1]; p++) {
                        this.drawFirstIndex.push(primitiveFirstIndex[p]);
                        this.drawIndexCount.push(scene.getIndexCount(p));
                        this.drawBaseVertex.push(primitiveBaseVertex[p]);
                        this.drawTexture.push(primitiveTexture[p]);
                        for (let k = 0; k < 3; k++) {
                            this.drawCenters.push(0.5 * (low[k] + high[k]));
                        }
                        for (let i = 0; i < 16; i++) {
                            this.models.push(transform[i]);
                        }
                        this.order.push(this.order.length);
                        this.distances.push(0.0);
                    }
                }
            }

            this.vertexBuffer = this.app.createStaticVertexBuffer(commandList, Ref(vertices[0]), vertices.length * 4, "Vertices");
            this.indexBuffer = this.app.createStaticIndexBuffer(commandList, Ref(indices[0]), indices.length * 4, "Indices");
            return true;
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(): boolean {
            const shader = "msaa.hlsl";
            const vs = this.app.createShader(shader, "scene_vs", ShaderType.Vertex);
            const ps = this.app.createShader(shader, "scene_ps", ShaderType.Pixel);
            if (!vs || !ps) {
                return false;
            }

            const layoutDesc = InputLayoutDesc.create();
            layoutDesc.addVertexAttribute("POSITION", Format.RGB32_FLOAT, 0, 0, VERTEX_SIZE);
            layoutDesc.addVertexAttribute("NORMAL", Format.RGB32_FLOAT, 12, 0, VERTEX_SIZE);
            layoutDesc.addVertexAttribute("TEXCOORD", Format.RG32_FLOAT, 24, 0, VERTEX_SIZE);
            const inputLayout = this.app.createInputLayout(layoutDesc, vs);

            this.constantBuffer = this.app.createVolatileConstantBuffer(CONST_FLOATS * 4, "SceneConstants");
            const bindingLayoutDesc = BindingLayoutDesc.create();
            bindingLayoutDesc.layoutVolatileConstantBuffer(0);
            bindingLayoutDesc.layoutTextureSRV(0);
            bindingLayoutDesc.layoutSampler(0);
            bindingLayoutDesc.layoutPushConstants(1, MODEL_SIZE);
            this.bindingLayout = this.app.createBindingLayout(bindingLayoutDesc, ShaderType.All);
            // The framework's glTF sampler without a sampler in the file: linear, repeating.
            this.sampler = this.app.getCommonSampler(CommonSampler.LinearWrap);

            const commandList = this.app.createCommandList();
            commandList.open();
            const loaded = this.loadScene(commandList);
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.waitForIdle();
            this.app.releaseResource(commandList.handle);
            if (!loaded) {
                console.log("Cannot load the scene: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return false;
            }

            // The framework's geometry pipeline state: reversed depth (greater), back faces culled,
            // counter-clockwise front faces.
            this.createTargets(this.app.getWindowWidth(), this.app.getWindowHeight());
            const desc = GraphicsPipelineDesc.create(vs, ps);
            desc.setInputLayout(inputLayout);
            desc.addBindingLayout(this.bindingLayout);
            desc.setDepthState(1, 1, ComparisonFunc.Greater);
            desc.setRasterState(CullMode.Back, FillMode.Solid, 1);
            this.pipeline = this.app.createGraphicsPipelineFromDesc(desc, this.framebuffers[0]);

            // The scene's camera, as the sample's free camera starts: looking down its node's -z,
            // its up its node's y.
            const forward = rotate(CAMERA_ROTATION, [0.0, 0.0, -1.0]);
            const up = rotate(CAMERA_ROTATION, [0.0, 1.0, 0.0]);
            const p = CAMERA_POSITION;
            this.camera = this.app.createFirstPersonCamera();
            this.camera.lookAtWithUp(p[0], p[1], p[2], p[0] + forward[0], p[1] + forward[1], p[2] + forward[2], up[0], up[1], up[2]);
            this.camera.setMoveSpeed(CAMERA_MOVE_SPEED);

            const pass = this.app.addPass();
            pass.setKeyboardCallback(this.onKey);
            pass.setMousePosCallback(this.onMousePos);
            pass.setMouseButtonCallback(this.onMouseButton);
            pass.setAnimateCallback(this.onAnimate);
            pass.setBackBufferResizingCallback(this.onBackBufferResizing);
            pass.setRenderCallback(this.onRender);
            return true;
        }
    }

    // The sample's options window.
    class UserInterface {
        private pass: TextureCompressionComparisonPass;
        // The combo's items: "<short name> " or "<short name> (not supported)".
        private items: string;

        constructor(pass: TextureCompressionComparisonPass) {
            this.pass = pass;
            this.items = "";
        }

        buildUI(): void {
            const p = this.pass;
            if (this.items == "") {
                for (let i = 0; i < SHORT_NAMES.length; i++) {
                    this.items += (i > 0 ? "|" : "") + SHORT_NAMES[i] + " " + (p.isFormatSupported(i) ? "" : "(not supported)");
                }
            }
            Donut_ImGuiSetNextWindowPos(10.0, 10.0);
            Donut_ImGuiBegin("Options", 1);
            const selection = Donut_ImGuiCombo("Compressed Format", p.guiFormat, this.items);
            if (selection != p.guiFormat) {
                p.guiFormat = selection;
                p.requireRedraw = true;
                if (p.isFormatSupported(selection)) {
                    p.currentFormat = selection;
                }
            }
            if (p.isFormatSupported(p.guiFormat)) {
                Donut_ImGuiText(`Format name: ${FORMAT_NAMES[p.guiFormat]}`);
                Donut_ImGuiText(`Bytes: ${(p.totalBytes / 1024.0 / 1024.0).toFixed(6)} MB`);
                Donut_ImGuiText(`Compression Time: ${p.compressTimeMs.toFixed(6)} (ms)`);
            } else {
                Donut_ImGuiText(`${SHORT_NAMES[p.guiFormat]} not supported on this GPU.`);
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
        Donut_SetAppName("texture_compression_comparison");

        // -debug: the graphics API's debug layer and NVRHI's validation layer.
        // -noui: without the options window.
        // -format <n>: 0 RGBA 32 (the default), 1 BC7, 2 BC3, 3 ASTC 4x4, 4 ETC2.
        let options = AppOptions.None;
        let withUI = true;
        let format = 0;
        for (let i = 1; i < argc; i++) {
            const arg = Donut_GetArg(argv, i);
            if (arg == "-debug") {
                options = AppOptions.DebugRuntime;
            } else if (arg == "-noui") {
                withUI = false;
            } else if (arg == "-format" && i + 1 < argc) {
                format = Math.min(4, Math.max(0, parseInt(Donut_GetArg(argv, i + 1))));
                i++;
            }
        }

        const api = Donut_GetGraphicsAPIFromCommandLine(argc, argv);
        const app = App.createWithOptions(api, WINDOW_TITLE, 1280, 720, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        const pass = new TextureCompressionComparisonPass(app);
        if (!pass.init()) {
            app.destroy();
            return 1;
        }
        pass.guiFormat = format;
        if (pass.isFormatSupported(format)) {
            pass.currentFormat = format;
        } else {
            console.log(`${SHORT_NAMES[format]} isn't supported here: ${SHORT_NAMES[pass.currentFormat]}`);
        }

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
    return TextureCompressionComparison.main(argc, argv);
}
