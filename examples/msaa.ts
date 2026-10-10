// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";

namespace Msaa {
    const WINDOW_TITLE = "Donut Example: MSAA";

    // The sample's scene (Vulkan-Samples' assets): a glTF file whose base color textures, KTX 1
    // ASTC, are decoded to DDS at build time (see VULKAN_SAMPLES_ASSETS_DIR in CMakeLists.txt).
    const SCENE_DIR = "media/msaa/space_module/";
    const SCENE_PATH = SCENE_DIR + "SpaceModule.gltf";

    // Donut_LoadGltfModel's vertices: float3 position, float3 normal, float2 texture coordinates.
    const VERTEX_FLOATS = 8;
    const VERTEX_SIZE = VERTEX_FLOATS * 4;

    // struct SceneConstants { float4x4 viewProj; float4 lightColor, lightDirection; }, as f32 offsets.
    const CONST_VIEW_PROJ = 0;
    const CONST_LIGHT_COLOR = 16;
    const CONST_LIGHT_DIRECTION = 20;
    const CONST_FLOATS = 24;
    // The draws' push constants: their node's transform.
    const MODEL_FLOATS = 16;
    const MODEL_SIZE = MODEL_FLOATS * 4;
    // struct PostConstants { float2 nearFar; }, padded to a float4.
    const POST_FLOATS = 4;

    // The framework's depth format (get_suitable_depth_format's first choice), reversed.
    const DEPTH_FORMAT = Format.D32;

    // The scene's camera node (main_camera): position, and orientation (x, y, z, w), its
    // perspective's vertical field of view and depth range.
    const CAMERA_POSITION = [-260.0, 190.0, 80.0];
    const CAMERA_ROTATION = [-0.0059817, -0.6014712, -0.0073468, 0.7988383];
    const CAMERA_FOV = 1.0;
    const Z_NEAR = 1.0;
    const Z_FAR = 4000.0;
    // The sample's free camera: 50 units per step, times its speed multiplier of 3, per second.
    const CAMERA_MOVE_SPEED = 150.0;

    // The scene's directional light: white, intensity 1, on a node with this rotation (x, y, z, w).
    const LIGHT_COLOR = [1.0, 1.0, 1.0, 1.0];
    const LIGHT_ROTATION = [0.0, 0.0, 0.258819, 0.9659258];

    // The sample counts from most to least preferred as the default: "On Mali GPUs 4X MSAA is
    // recommended as best performance/quality trade-off".
    const SAMPLE_COUNTS = [4, 2, 8, 16, 32, 64, 1];
    // The depth resolve modes from most to least preferred as the default.
    const DEPTH_RESOLVE_MODES = [ResolveMode.SampleZero, ResolveMode.Min, ResolveMode.Max, ResolveMode.Average];

    // The color resolve methods.
    const RESOLVE_ON_WRITEBACK = 0;
    const RESOLVE_SEPARATE = 1;

    // Bounds start out inverted.
    const HUGE = 1.0e30;

    function sampleCountName(count: int): string {
        return count == 1 ? "No MSAA" : `${count}X MSAA`;
    }

    function resolveModeName(mode: ResolveMode): string {
        if (mode == ResolveMode.SampleZero) {
            return "Sample 0";
        }
        if (mode == ResolveMode.Average) {
            return "Average";
        }
        if (mode == ResolveMode.Min) {
            return "Min";
        }
        if (mode == ResolveMode.Max) {
            return "Max";
        }
        return "None";
    }

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

    // A matrix into the sample's clip space, into Donut's (y up on the screen): clip y negated. The
    // pictures land where the sample's do.
    function toDonutClip(m: number[]): number[] {
        let result: number[] = [];
        for (let i = 0; i < 16; i++) {
            result.push(i % 4 == 1 ? -m[i] : m[i]);
        }
        return result;
    }

    // --- Passes -------------------------------------------------------------------------------

    // Port of Vulkan-Samples' msaa: the Space Module scene forward shaded, with multisampling or
    // not, into the swap chain; or into a texture that a second render pass reads, with the scene's
    // depth, for an outline post-processing effect. The multisampled color is resolved by the scene
    // render pass as it ends ("on writeback", Vulkan's dynamic rendering resolve) or by a separate
    // resolve command; with post-processing, the multisampled depth too is resolved by the render
    // pass (Vulkan's depth resolve modes) or, without that, read multisampled by the effect.
    //
    // NVRHI runs D3D11 and D3D12 without render passes: there color resolves separately, and depth
    // is read multisampled, as the sample does without VK_KHR_depth_stencil_resolve.
    class MsaaPass {
        private app: App;
        private camera: Camera;

        // The sample's settings, from its UI.
        sampleCount: int;
        postprocessing: boolean;
        colorResolveMethod: int;
        resolveDepthOnWriteback: boolean;
        depthResolveMode: ResolveMode;
        // What the device has: the sample counts (as Donut_GetSupportedSampleCounts bits), render
        // pass resolves, and depth resolve modes (bits 1 << ResolveMode).
        supportedSampleCounts: int;
        renderPassResolve: boolean;
        depthResolveModes: int;

        // The settings and back buffer size the targets below were made for (sampleCount 0: none
        // yet).
        private builtSampleCount: int;
        private builtPostprocessing: boolean;
        private builtColorResolveMethod: int;
        private builtResolveDepthOnWriteback: boolean;
        private builtDepthResolveMode: int;
        private builtWidth: int;
        private builtHeight: int;

        // The targets, made for the settings: the color (multisampled, or the single-sampled
        // texture the post-processing reads), the depth (multisampled with MSAA), the single-sampled
        // color and depth that the multisampled ones resolve into for the post-processing.
        private resources: ResourceHandle[];
        private msColor: TextureHandle;
        private depth: TextureHandle;
        private resolvedColor: TextureHandle;
        private resolvedDepth: TextureHandle;
        // Whether the scene renders into the back buffer (one framebuffer per back buffer) rather
        // than into textures (one framebuffer).
        private sceneToBackBuffer: boolean;
        private sceneFramebuffers: Opaque[];
        // Whether the multisampled color is resolved by the scene's render pass, and whether the
        // post-processing reads multisampled depth.
        private writebackColorResolve: boolean;
        private multisampledDepthPost: boolean;
        // The opaque draws' pipelines (front faces counter-clockwise, or clockwise for the nodes
        // that the framework sees as flipped), and the blended draws'.
        private scenePipeline: Opaque;
        private sceneFlippedPipeline: Opaque;
        private sceneBlendPipeline: Opaque;
        private postBindingSet: BindingSet;

        private sceneVS: Opaque;
        private scenePS: Opaque;
        private postVS: Opaque;
        private outlinePS: Opaque;
        private outlineMSPS: Opaque;
        private sceneInputLayout: Opaque;
        private sceneBindingLayout: Opaque;
        private postBindingLayout: Opaque;
        private sceneConstantBuffer: BufferHandle;
        private postConstantBuffer: BufferHandle;
        private linearClamp: SamplerHandle;
        private vertexBuffer: BufferHandle;
        private indexBuffer: BufferHandle;
        // The scene's base color textures.
        private textures: TextureHandle[];
        // Created on the first frame (the back buffer's layout), dropped on resize: the outline
        // effect reading single-sampled and multisampled depth.
        private postPipelinesCreated: boolean;
        private postPipeline: Opaque;
        private postMSPipeline: Opaque;

        // The draws, a node's primitive each: index range and base vertex, base color texture,
        // alpha blending (0 or 1), front faces flipped (0 or 1: a node scaled by a negative factor),
        // node transform (MODEL_FLOATS each, from models), and world bounds center (3 each), in the
        // framework's order: by mesh, node, primitive.
        private drawFirstIndex: int[];
        private drawIndexCount: int[];
        private drawBaseVertex: int[];
        private drawTexture: int[];
        private drawBlend: boolean[];
        private drawFlipped: boolean[];
        private drawCenters: number[];
        private models: f32[];
        // The draws in drawing order: opaque ones front to back, then blended ones back to front.
        private order: int[];
        private distances: number[];
        // Per base color texture, its binding set for the scene pass.
        private sceneBindingSets: BindingSet[];

        // Upload buffers.
        private constants: f32[];
        private postConstants: f32[];
        // Donut's view matrix, 16 floats.
        private viewMatrix: f32[];

        constructor(app: App) {
            this.app = app;
            this.sampleCount = 1;
            this.postprocessing = false;
            this.colorResolveMethod = RESOLVE_ON_WRITEBACK;
            this.resolveDepthOnWriteback = true;
            this.depthResolveMode = ResolveMode.None;
            this.supportedSampleCounts = 1;
            this.renderPassResolve = false;
            this.depthResolveModes = 0;
            this.builtSampleCount = 0;
            this.builtPostprocessing = false;
            this.builtColorResolveMethod = 0;
            this.builtResolveDepthOnWriteback = false;
            this.builtDepthResolveMode = 0;
            this.builtWidth = 0;
            this.builtHeight = 0;
            this.resources = [];
            this.sceneToBackBuffer = false;
            this.sceneFramebuffers = [];
            this.writebackColorResolve = false;
            this.multisampledDepthPost = false;
            this.textures = [];
            this.postPipelinesCreated = false;
            this.drawFirstIndex = [];
            this.drawIndexCount = [];
            this.drawBaseVertex = [];
            this.drawTexture = [];
            this.drawBlend = [];
            this.drawFlipped = [];
            this.drawCenters = [];
            this.models = [];
            this.order = [];
            this.distances = [];
            this.sceneBindingSets = [];

            this.constants = [];
            for (let i = 0; i < CONST_FLOATS; i++) {
                this.constants.push(0.0);
            }
            this.postConstants = [];
            for (let i = 0; i < POST_FLOATS; i++) {
                this.postConstants.push(0.0);
            }
            this.viewMatrix = [];
            for (let i = 0; i < 16; i++) {
                this.viewMatrix.push(0.0);
            }
        }

        // Whether render passes can resolve the depth (for the post-processing).
        canResolveDepthOnWriteback(): boolean {
            return this.depthResolveModes != 0;
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
            const post = this.postprocessing ? ", post-processing" : "";
            this.app.setInformativeWindowTitleWithInfo(WINDOW_TITLE, sampleCountName(this.sampleCount) + post);
        }

        // The framebuffers of the back buffers go before the back buffers do.
        onBackBufferResizing(): void {
            this.releaseTargets();
            if (this.postPipelinesCreated) {
                this.app.releaseResource(this.postPipeline);
                this.app.releaseResource(this.postMSPipeline);
            }
            this.postPipelinesCreated = false;
        }

        releaseTargets(): void {
            for (let i = 0; i < this.resources.length; i++) {
                this.app.releaseResource(this.resources[i]);
            }
            this.resources = [];
            this.sceneFramebuffers = [];
            this.builtSampleCount = 0;
        }

        own<T extends ResourceHandle>(resource: T): T {
            this.resources.push(resource);
            return resource;
        }

        // The sample's update_pipelines (on a change of settings) and create_render_target: the
        // targets and framebuffers of the scene pass for the settings, and the pipelines drawing
        // into them (their sample count is the framebuffer's).
        createTargets(width: int, height: int): void {
            // The sample waits for the device to be idle too.
            this.app.waitForIdle();
            this.releaseTargets();

            const msaa = this.sampleCount > 1;
            const colorFormat = this.app.getBackBufferFormat();
            // The color resolves in the scene's render pass where render passes resolve.
            this.writebackColorResolve = msaa && this.colorResolveMethod == RESOLVE_ON_WRITEBACK && this.renderPassResolve;
            // With post-processing, the multisampled depth resolves in the render pass where it can
            // (and the setting is on); otherwise the post-processing reads it multisampled.
            const writebackDepthResolve = msaa && this.postprocessing && this.resolveDepthOnWriteback
                && this.canResolveDepthOnWriteback();
            this.multisampledDepthPost = msaa && this.postprocessing && !writebackDepthResolve;

            this.depth = this.own(this.app.createMultisampledTexture(width, height, DEPTH_FORMAT, this.sampleCount, 0.0, "Depth"));
            this.msColor = this.depth;
            if (msaa) {
                this.msColor = this.own(this.app.createMultisampledTexture(width, height, colorFormat, this.sampleCount, 0.0,
                    "Multisampled Color"));
            }
            this.resolvedColor = this.own(this.app.createMultisampledTexture(width, height, colorFormat, 1, 0.0, "Resolved Color"));
            this.resolvedDepth = this.depth;
            if (writebackDepthResolve) {
                this.resolvedDepth = this.own(this.app.createMultisampledTexture(width, height, DEPTH_FORMAT, 1, 0.0, "Resolved Depth"));
            }

            // Without post-processing the scene goes to the back buffer: drawn there, or resolved
            // there by the render pass (writeback) or afterwards (separate).
            this.sceneToBackBuffer = !this.postprocessing && (!msaa || this.writebackColorResolve);
            if (this.sceneToBackBuffer) {
                const count = this.app.getBackBufferCount();
                for (let i = 0; i < count; i++) {
                    const backBuffer = this.app.getBackBuffer(i);
                    if (msaa) {
                        this.sceneFramebuffers.push(this.own<ResourceHandle>(this.app.createResolveFramebuffer(this.msColor, backBuffer, this.depth,
                            null, ResolveMode.None)));
                    } else {
                        this.sceneFramebuffers.push(this.own<ResourceHandle>(this.app.createFramebuffer(backBuffer, this.depth)));
                    }
                }
            } else if (!msaa) {
                this.sceneFramebuffers.push(this.own<ResourceHandle>(this.app.createFramebuffer(this.resolvedColor, this.depth)));
            } else if (this.writebackColorResolve || writebackDepthResolve) {
                // Into the resolved color with post-processing (or separately), and the resolved depth.
                const colorResolve = this.writebackColorResolve ? this.resolvedColor : null;
                const depthResolve = writebackDepthResolve ? this.resolvedDepth : null;
                this.sceneFramebuffers.push(this.own<ResourceHandle>(this.app.createResolveFramebuffer(this.msColor, colorResolve, this.depth,
                    depthResolve, writebackDepthResolve ? this.depthResolveMode : ResolveMode.None)));
            } else {
                this.sceneFramebuffers.push(this.own<ResourceHandle>(this.app.createFramebuffer(this.msColor, this.depth)));
            }

            // The framework's geometry pipeline state: reversed depth (greater), back faces culled,
            // counter-clockwise front faces (clockwise for the opaque draws of flipped nodes);
            // blending for the materials in blend mode.
            for (let variant = 0; variant < 3; variant++) {
                const desc = GraphicsPipelineDesc.create(this.sceneVS, this.scenePS);
                desc.setInputLayout(this.sceneInputLayout);
                desc.addBindingLayout(this.sceneBindingLayout);
                desc.setDepthState(1, 1, ComparisonFunc.Greater);
                desc.setRasterState(CullMode.Back, FillMode.Solid, variant == 1 ? 0 : 1);
                if (variant == 2) {
                    desc.setBlendMode(BlendMode.AlphaBlend);
                }
                const pipeline = this.own<ResourceHandle>(this.app.createGraphicsPipelineFromDesc(desc, this.sceneFramebuffers[0]));
                if (variant == 0) {
                    this.scenePipeline = pipeline;
                } else if (variant == 1) {
                    this.sceneFlippedPipeline = pipeline;
                } else {
                    this.sceneBlendPipeline = pipeline;
                }
            }

            // The post-processing's color and depth: resolved, or the multisampled depth.
            if (this.postprocessing) {
                const setDesc = BindingSetDesc.create();
                setDesc.bindEntireConstantBuffer(0, this.postConstantBuffer);
                setDesc.bindTextureSRV(0, this.resolvedColor);
                setDesc.bindTextureSRV(1, this.resolvedDepth);
                setDesc.bindSampler(0, this.linearClamp);
                this.postBindingSet = this.app.createBindingSetForLayout(setDesc, this.postBindingLayout);
                this.own<ResourceHandle>(this.postBindingSet.handle);
            }

            this.builtSampleCount = this.sampleCount;
            this.builtPostprocessing = this.postprocessing;
            this.builtColorResolveMethod = this.colorResolveMethod;
            this.builtResolveDepthOnWriteback = this.resolveDepthOnWriteback;
            this.builtDepthResolveMode = this.depthResolveMode;
            this.builtWidth = width;
            this.builtHeight = height;
        }

        targetsAreCurrent(width: int, height: int): boolean {
            const depthResolveMode: int = this.depthResolveMode;
            if (this.builtDepthResolveMode != depthResolveMode) {
                return false;
            }
            return this.builtSampleCount == this.sampleCount && this.builtPostprocessing == this.postprocessing
                && this.builtColorResolveMethod == this.colorResolveMethod
                && this.builtResolveDepthOnWriteback == this.resolveDepthOnWriteback
                && this.builtWidth == width && this.builtHeight == height;
        }

        // The framework's GeometrySubpass order, from a camera at (x, y, z): opaque draws front to
        // back, then the blended ones back to front, by the distance to their node's bounds;
        // stable, as its multimap.
        sortDraws(x: number, y: number, z: number): void {
            const count = this.drawIndexCount.length;
            for (let d = 0; d < count; d++) {
                const dx = this.drawCenters[d * 3] - x;
                const dy = this.drawCenters[d * 3 + 1] - y;
                const dz = this.drawCenters[d * 3 + 2] - z;
                this.distances[d] = Math.sqrt(dx * dx + dy * dy + dz * dz);
            }
            let n = 0;
            for (let pass = 0; pass < 2; pass++) {
                const first = n;
                for (let d = 0; d < count; d++) {
                    if (this.drawBlend[d] != (pass == 1)) {
                        continue;
                    }
                    // Insertion sort: nearest first for opaque draws, farthest first for blended ones.
                    let i = n;
                    while (i > first) {
                        const previous = this.distances[this.order[i - 1]];
                        const after = pass == 0 ? previous > this.distances[d] : previous < this.distances[d];
                        if (!after) {
                            break;
                        }
                        this.order[i] = this.order[i - 1];
                        i--;
                    }
                    this.order[i] = d;
                    n++;
                }
            }
        }

        drawScene(frame: Frame, framebuffer: Opaque): void {
            // The draw state's pipeline (0 opaque, 1 opaque flipped, 2 blended; -1 before the first
            // draw) and texture.
            let currentPipeline = -1;
            let currentTexture = -1;
            for (let i = 0; i < this.order.length; i++) {
                const d = this.order[i];
                const pipeline = this.drawBlend[d] ? 2 : this.drawFlipped[d] ? 1 : 0;
                const texture = this.drawTexture[d];
                if (pipeline != currentPipeline || texture != currentTexture) {
                    frame.beginDrawToFramebuffer(pipeline == 2 ? this.sceneBlendPipeline
                        : pipeline == 1 ? this.sceneFlippedPipeline : this.scenePipeline, framebuffer);
                    frame.drawAddBindingSet(this.sceneBindingSets[texture]);
                    frame.drawSetIndexBuffer(this.indexBuffer);
                    frame.drawAddVertexBuffer(this.vertexBuffer, 0, 0);
                    currentPipeline = pipeline;
                    currentTexture = texture;
                }
                frame.drawIndexedRangeWithPushConstants(this.drawIndexCount[d], this.drawFirstIndex[d], this.drawBaseVertex[d],
                    Ref(this.models[d * MODEL_FLOATS]), MODEL_SIZE);
            }
        }

        // The scene uniforms: the camera's view-projection in Donut's clip space, and the light (its
        // direction, the node's rotation of (0, 0, -1)).
        updateConstants(commandList: CommandList, width: int, height: int): void {
            // Donut's camera, in Donut's view space (z forward), into the sample's (-z forward).
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
            commandList.writeBuffer(this.sceneConstantBuffer, Ref(c[0]), CONST_FLOATS * 4);

            // The sample's near_far: (far, near).
            this.postConstants[0] = Z_FAR;
            this.postConstants[1] = Z_NEAR;
            commandList.writeBuffer(this.postConstantBuffer, Ref(this.postConstants[0]), POST_FLOATS * 4);
        }

        onRender(frameHandle: FrameHandle): void {
            const frame = new Frame(frameHandle);
            const width = frame.getWidth();
            const height = frame.getHeight();
            const commandList = frame.getCommandList();

            if (!this.postPipelinesCreated) {
                this.postPipeline = this.app.createGraphicsPipelineWithTopology(frame, this.postVS, this.outlinePS,
                    null, this.postBindingLayout, PrimitiveType.TriangleList);
                this.postMSPipeline = this.app.createGraphicsPipelineWithTopology(frame, this.postVS, this.outlineMSPS,
                    null, this.postBindingLayout, PrimitiveType.TriangleList);
                this.postPipelinesCreated = true;
            }
            if (!this.targetsAreCurrent(width, height)) {
                this.createTargets(width, height);
            }

            this.updateConstants(commandList, width, height);

            // The scene pass: into the back buffer's framebuffer or the one of the textures, cleared
            // (to black, depth to 0) as the sample's render pass loads its attachments.
            const backBufferIndex = this.app.getCurrentBackBufferIndex();
            const backBuffer = this.app.getBackBuffer(backBufferIndex);
            const msaa = this.builtSampleCount > 1;
            let framebuffer = this.sceneFramebuffers[0];
            if (this.sceneToBackBuffer) {
                framebuffer = this.sceneFramebuffers[backBufferIndex];
            }
            commandList.beginMarker("Scene");
            if (msaa) {
                commandList.clearTextureFloat(this.msColor, 0.0, 0.0, 0.0, 1.0);
            } else if (this.postprocessing) {
                commandList.clearTextureFloat(this.resolvedColor, 0.0, 0.0, 0.0, 1.0);
            } else {
                commandList.clearTextureFloat(backBuffer, 0.0, 0.0, 0.0, 1.0);
            }
            commandList.clearDepth(this.depth, 0.0);

            const view = this.viewMatrix;
            // The camera's position: -R^T t of its view [R t].
            let position: number[] = [0.0, 0.0, 0.0];
            for (let column = 0; column < 3; column++) {
                for (let row = 0; row < 3; row++) {
                    position[column] -= view[column * 4 + row] * view[12 + row];
                }
            }
            this.sortDraws(position[0], position[1], position[2]);
            this.drawScene(frame, framebuffer);
            commandList.endMarker();

            // The sample's resolve_color_separate_pass: "extremely expensive".
            if (msaa && !this.writebackColorResolve) {
                commandList.beginMarker("Resolve color");
                if (this.postprocessing) {
                    commandList.resolveTexture(this.resolvedColor, this.msColor);
                } else {
                    commandList.resolveTexture(backBuffer, this.msColor);
                }
                commandList.endMarker();
            }

            // The second render pass: the outline effect over the resolved color into the back
            // buffer (the UI comes after, in the ImGui pass).
            if (this.postprocessing) {
                commandList.beginMarker("Post-processing");
                frame.beginDraw(this.multisampledDepthPost ? this.postMSPipeline : this.postPipeline);
                frame.drawAddBindingSet(this.postBindingSet);
                frame.drawVertices(3);
                commandList.endMarker();
            }
        }

        // The scene's base color textures and its draws: every node's primitives, their vertices and
        // indices in one vertex and one index buffer, recorded into an open command list.
        loadScene(commandList: CommandList, linearWrap: SamplerHandle): boolean {
            const scene = this.app.loadGltfModel(SCENE_PATH);
            if (scene.isNull()) {
                return false;
            }
            const primitiveCount = scene.getPrimitiveCount();

            // The primitives' textures (by image URI) and vertices.
            let imageNames: string[] = [];
            let primitiveTexture: int[] = [];
            let primitiveFirstIndex: int[] = [];
            let primitiveBaseVertex: int[] = [];
            let vertices: f32[] = [];
            let indices: int[] = [];
            // Per mesh: its bounds (min x, y, z, max x, y, z) and first primitive.
            let meshBounds: number[] = [];
            let meshFirstPrimitive: int[] = [];
            for (let p = 0; p < primitiveCount; p++) {
                const image = scene.getBaseColorImage(p);
                let texture = -1;
                for (let t = 0; t < imageNames.length; t++) {
                    if (imageNames[t] == image) {
                        texture = t;
                    }
                }
                if (texture < 0) {
                    texture = imageNames.length;
                    imageNames.push(image);
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
                for (let v = 0; v < vertexCount * VERTEX_FLOATS; v++) {
                    vertices.push(primitiveVertices[v]);
                }
                for (let i = 0; i < indexCount; i++) {
                    indices.push(primitiveIndices[i]);
                }
                for (let v = 0; v < vertexCount * VERTEX_FLOATS; v += VERTEX_FLOATS) {
                    for (let k = 0; k < 3; k++) {
                        meshBounds[mesh * 6 + k] = Math.min(meshBounds[mesh * 6 + k], primitiveVertices[v + k]);
                        meshBounds[mesh * 6 + 3 + k] = Math.max(meshBounds[mesh * 6 + 3 + k], primitiveVertices[v + k]);
                    }
                }
            }
            meshFirstPrimitive.push(primitiveCount);

            // As the framework loads ASTC textures on GPUs without ASTC: level 0 decoded (to DDS
            // here), the mip levels generated.
            for (let t = 0; t < imageNames.length; t++) {
                const name = imageNames[t];
                const dot = name.lastIndexOf(".");
                const path = SCENE_DIR + (dot >= 0 ? name.substring(0, dot) : name) + ".dds";
                const texture = this.app.loadTexture(commandList, path, 1);
                if (!texture) {
                    return false;
                }
                this.textures.push(texture);
                const setDesc = BindingSetDesc.create();
                setDesc.bindEntireConstantBuffer(0, this.sceneConstantBuffer);
                setDesc.bindTextureSRV(0, texture);
                setDesc.bindSampler(0, linearWrap);
                setDesc.bindPushConstants(1, MODEL_SIZE);
                this.sceneBindingSets.push(this.app.createBindingSetForLayout(setDesc, this.sceneBindingLayout));
            }

            // The draws: by mesh, then node, then primitive, as the framework's meshes list their
            // nodes and submeshes.
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
                    // Flipped: scaled by a negative factor, as the framework tells by the node's
                    // scale (the determinant of its world transform here: no parent flips here).
                    const determinant = transform[0] * (transform[5] * transform[10] - transform[9] * transform[6])
                        - transform[4] * (transform[1] * transform[10] - transform[9] * transform[2])
                        + transform[8] * (transform[1] * transform[6] - transform[5] * transform[2]);
                    // The mesh's bounds, transformed (their corners), and their center.
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
                        this.drawBlend.push(scene.getPrimitiveAlphaMode(p) == AlphaMode.Blend);
                        this.drawFlipped.push(determinant < 0.0);
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

        // The sample's prepare_supported_sample_count_list and prepare_depth_resolve_mode_list: what
        // the device has, and the defaults (the first supported in order of preference).
        querySupport(): void {
            this.supportedSampleCounts = this.app.getSupportedSampleCounts(this.app.getBackBufferFormat(), DEPTH_FORMAT);
            this.renderPassResolve = this.app.hasRenderPassResolve() != 0;
            this.depthResolveModes = this.app.getDepthResolveModes();
            this.sampleCount = 1;
            for (let i = 0; i < SAMPLE_COUNTS.length; i++) {
                if ((this.supportedSampleCounts & SAMPLE_COUNTS[i]) != 0) {
                    this.sampleCount = SAMPLE_COUNTS[i];
                    break;
                }
            }
            this.depthResolveMode = ResolveMode.None;
            for (let i = 0; i < DEPTH_RESOLVE_MODES.length; i++) {
                if ((this.depthResolveModes & (1 << DEPTH_RESOLVE_MODES[i])) != 0) {
                    this.depthResolveMode = DEPTH_RESOLVE_MODES[i];
                    break;
                }
            }
            if (!this.renderPassResolve) {
                this.colorResolveMethod = RESOLVE_SEPARATE;
            }
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(): boolean {
            const shader = "msaa.hlsl";
            const postShader = "msaa_post.hlsl";
            this.sceneVS = this.app.createShader(shader, "scene_vs", ShaderType.Vertex);
            this.scenePS = this.app.createShader(shader, "scene_ps", ShaderType.Pixel);
            this.postVS = this.app.createShader(postShader, "post_vs", ShaderType.Vertex);
            this.outlinePS = this.app.createShaderWithDefine(postShader, "outline_ps", ShaderType.Pixel, "MS_DEPTH", "0");
            this.outlineMSPS = this.app.createShaderWithDefine(postShader, "outline_ps", ShaderType.Pixel, "MS_DEPTH", "1");
            if (!this.sceneVS || !this.scenePS || !this.postVS || !this.outlinePS || !this.outlineMSPS) {
                return false;
            }

            this.querySupport();

            const layoutDesc = InputLayoutDesc.create();
            layoutDesc.addVertexAttribute("POSITION", Format.RGB32_FLOAT, 0, 0, VERTEX_SIZE);
            layoutDesc.addVertexAttribute("NORMAL", Format.RGB32_FLOAT, 12, 0, VERTEX_SIZE);
            layoutDesc.addVertexAttribute("TEXCOORD", Format.RG32_FLOAT, 24, 0, VERTEX_SIZE);
            this.sceneInputLayout = this.app.createInputLayout(layoutDesc, this.sceneVS);

            this.sceneConstantBuffer = this.app.createVolatileConstantBuffer(CONST_FLOATS * 4, "SceneConstants");
            this.postConstantBuffer = this.app.createVolatileConstantBuffer(POST_FLOATS * 4, "PostConstants");

            // The scene pass: the scene uniform, the base color texture and its sampler, the node
            // transform.
            const sceneLayoutDesc = BindingLayoutDesc.create();
            sceneLayoutDesc.layoutVolatileConstantBuffer(0);
            sceneLayoutDesc.layoutTextureSRV(0);
            sceneLayoutDesc.layoutSampler(0);
            sceneLayoutDesc.layoutPushConstants(1, MODEL_SIZE);
            this.sceneBindingLayout = this.app.createBindingLayout(sceneLayoutDesc, ShaderType.All);

            // The post-processing: its uniform, the color and its sampler, the depth.
            const postLayoutDesc = BindingLayoutDesc.create();
            postLayoutDesc.layoutVolatileConstantBuffer(0);
            postLayoutDesc.layoutTextureSRV(0);
            postLayoutDesc.layoutTextureSRV(1);
            postLayoutDesc.layoutSampler(0);
            this.postBindingLayout = this.app.createBindingLayout(postLayoutDesc, ShaderType.Pixel);

            // Donut's common passes, which hold the samplers, upload their textures on a command
            // list of their own: before ours is open.
            this.linearClamp = this.app.getCommonSampler(CommonSampler.LinearClamp);
            const linearWrap = this.app.getCommonSampler(CommonSampler.LinearWrap);

            const commandList = this.app.createCommandList();
            commandList.open();
            const loaded = this.loadScene(commandList, linearWrap);
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.waitForIdle();
            this.app.releaseResource(commandList.handle);
            if (!loaded) {
                console.log("Cannot load the scene and its textures: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return false;
            }

            // The scene's camera, as the sample's free camera starts: looking down its node's -z,
            // its up its node's y (the node rolls it a little).
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
        private msaa: MsaaPass;

        constructor(msaa: MsaaPass) {
            this.msaa = msaa;
        }

        buildUI(): void {
            const m = this.msaa;
            const msaaEnabled = m.sampleCount > 1;
            Donut_ImGuiSetNextWindowPos(10.0, 10.0);
            Donut_ImGuiBegin("Options", 1);

            if (Donut_ImGuiBeginCombo("##sample_count", sampleCountName(m.sampleCount)) != 0) {
                for (let i = 0; i < SAMPLE_COUNTS.length; i++) {
                    const count = SAMPLE_COUNTS[i];
                    if ((m.supportedSampleCounts & count) == 0) {
                        continue;
                    }
                    const selected = count == m.sampleCount;
                    if (Donut_ImGuiSelectable(sampleCountName(count), selected ? 1 : 0) != 0) {
                        m.sampleCount = count;
                    }
                    if (selected) {
                        Donut_ImGuiSetItemDefaultFocus();
                    }
                }
                Donut_ImGuiEndCombo();
            }
            Donut_ImGuiSameLine();
            m.postprocessing = Donut_ImGuiCheckbox("Post-processing (2 renderpasses)", m.postprocessing ? 1 : 0) != 0;

            Donut_ImGuiText("Resolve color: ");
            Donut_ImGuiSameLine();
            if (!msaaEnabled) {
                Donut_ImGuiText("n/a");
            } else if (m.renderPassResolve) {
                if (Donut_ImGuiRadioButton("On writeback", m.colorResolveMethod == RESOLVE_ON_WRITEBACK ? 1 : 0) != 0) {
                    m.colorResolveMethod = RESOLVE_ON_WRITEBACK;
                }
                Donut_ImGuiSameLine();
                if (Donut_ImGuiRadioButton("Separate", m.colorResolveMethod == RESOLVE_SEPARATE ? 1 : 0) != 0) {
                    m.colorResolveMethod = RESOLVE_SEPARATE;
                }
            } else {
                // No render pass resolves (D3D, as NVRHI runs it).
                Donut_ImGuiText("Separate");
            }

            Donut_ImGuiText("Resolve depth: ");
            Donut_ImGuiSameLine();
            if (!msaaEnabled || !m.postprocessing) {
                Donut_ImGuiText("n/a");
            } else if (m.canResolveDepthOnWriteback()) {
                m.resolveDepthOnWriteback = Donut_ImGuiCheckbox("##resolve_depth", m.resolveDepthOnWriteback ? 1 : 0) != 0;
                Donut_ImGuiSameLine();
                Donut_ImGuiText("On writeback");
                Donut_ImGuiSameLine();
                Donut_ImGuiPushItemWidth(120.0);
                if (Donut_ImGuiBeginCombo("##resolve_mode", resolveModeName(m.depthResolveMode)) != 0) {
                    for (let i = 0; i < DEPTH_RESOLVE_MODES.length; i++) {
                        const mode = DEPTH_RESOLVE_MODES[i];
                        if ((m.depthResolveModes & (1 << mode)) == 0) {
                            continue;
                        }
                        const selected = mode == m.depthResolveMode;
                        if (Donut_ImGuiSelectable(resolveModeName(mode), selected ? 1 : 0) != 0) {
                            m.depthResolveMode = mode;
                        }
                        if (selected) {
                            Donut_ImGuiSetItemDefaultFocus();
                        }
                    }
                    Donut_ImGuiEndCombo();
                }
                Donut_ImGuiPopItemWidth();
            } else {
                Donut_ImGuiText("Not supported");
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
        Donut_SetAppName("msaa");

        // -debug: the graphics API's debug layer and NVRHI's validation layer.
        // -noui: without the options window.
        // -samples <n>: n samples per pixel (1 for no MSAA) instead of the preferred supported count.
        // -post: with the post-processing pass. -separate: the color resolved in a separate pass.
        // -nodepthresolve: the post-processing reads multisampled depth even where the render pass
        // can resolve it. -depthresolve zero|average|min|max: the depth resolve mode.
        let options = AppOptions.None;
        let withUI = true;
        let samples = 0;
        let postprocessing = false;
        let separate = false;
        let noDepthResolve = false;
        let depthResolveMode = ResolveMode.None;
        for (let i = 1; i < argc; i++) {
            const arg = Donut_GetArg(argv, i);
            if (arg == "-debug") {
                options = AppOptions.DebugRuntime;
            } else if (arg == "-noui") {
                withUI = false;
            } else if (arg == "-samples" && i + 1 < argc) {
                samples = parseInt(Donut_GetArg(argv, i + 1));
                i++;
            } else if (arg == "-post") {
                postprocessing = true;
            } else if (arg == "-separate") {
                separate = true;
            } else if (arg == "-nodepthresolve") {
                noDepthResolve = true;
            } else if (arg == "-depthresolve" && i + 1 < argc) {
                const mode = Donut_GetArg(argv, i + 1);
                i++;
                if (mode == "zero") {
                    depthResolveMode = ResolveMode.SampleZero;
                } else if (mode == "average") {
                    depthResolveMode = ResolveMode.Average;
                } else if (mode == "min") {
                    depthResolveMode = ResolveMode.Min;
                } else if (mode == "max") {
                    depthResolveMode = ResolveMode.Max;
                }
            }
        }

        const api = Donut_GetGraphicsAPIFromCommandLine(argc, argv);
        const app = App.createWithOptions(api, WINDOW_TITLE, 1280, 720, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        const msaa = new MsaaPass(app);
        if (!msaa.init()) {
            app.destroy();
            return 1;
        }
        if (samples > 0) {
            if ((msaa.supportedSampleCounts & samples) != 0) {
                msaa.sampleCount = samples;
            } else {
                console.log(`${samples} samples per pixel aren't supported: ${sampleCountName(msaa.sampleCount)}`);
            }
        }
        msaa.postprocessing = postprocessing;
        if (separate) {
            msaa.colorResolveMethod = RESOLVE_SEPARATE;
        }
        if (noDepthResolve) {
            msaa.resolveDepthOnWriteback = false;
        }
        if (depthResolveMode != ResolveMode.None && (msaa.depthResolveModes & (1 << depthResolveMode)) != 0) {
            msaa.depthResolveMode = depthResolveMode;
        }

        // Drawn after (over) the scene, and sees the mouse first.
        const gui = new UserInterface(msaa);
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
    return Msaa.main(argc, argv);
}
