// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";

namespace AsyncComputeBloom {
    const WINDOW_TITLE = "Donut Example: Async Compute Bloom";

    // The sample's scene (Vulkan-Samples' assets): a glTF file whose base color textures, KTX 2
    // ASTC, are decoded to DDS at build time (see VULKAN_SAMPLES_ASSETS_DIR in CMakeLists.txt).
    const SCENE_DIR = "media/async_compute_bloom/bonza/";
    const SCENE_PATH = SCENE_DIR + "Bonza.gltf";

    // Donut_LoadGltfModel's vertices: float3 position, float3 normal, float2 texture coordinates.
    const VERTEX_FLOATS = 8;
    const VERTEX_SIZE = VERTEX_FLOATS * 4;

    // struct SceneConstants { float4x4 viewProj, shadowMatrix; float4 lightColor, lightDirection; },
    // as f32 offsets.
    const CONST_VIEW_PROJ = 0;
    const CONST_SHADOW_MATRIX = 16;
    const CONST_LIGHT_COLOR = 32;
    const CONST_LIGHT_DIRECTION = 36;
    const CONST_FLOATS = 40;
    // The draws' push constants: their node's transform.
    const MODEL_FLOATS = 16;
    const MODEL_SIZE = MODEL_FLOATS * 4;
    // struct BlurConstants { uint2 resolution; float2 invResolution, invInputResolution; }.
    const BLUR_FLOATS = 6;
    const BLUR_SIZE = BLUR_FLOATS * 4;

    // The sample's render targets: 4K HDR color (to make it demanding enough for the mobile GPUs it
    // was tested on), an 8K shadow map, and the bloom's chain of half sizes below the HDR target's
    // (levels 1 to 6).
    const HDR_WIDTH = 3840;
    const HDR_HEIGHT = 2160;
    const SHADOW_RESOLUTION = 8192;
    const BLUR_LEVELS = 6;
    // The bloom's output: the chain's index 1 (level 2, a quarter of the HDR size).
    const BLOOM_INDEX = 1;
    // The compute shaders' 8 x 8 thread groups.
    const BLUR_GROUP_SIZE = 8;

    // The scene's camera node (main_camera): position, and orientation (x, y, z, w) without roll,
    // its perspective's vertical field of view and depth range.
    const CAMERA_POSITION = [-110.107864, 1103.093872, -640.680786];
    const CAMERA_ROTATION = [0.069169, -0.919112, -0.187113, -0.339761];
    const CAMERA_FOV = 1.0;
    const Z_NEAR = 1.0;
    const Z_FAR = 4000.0;
    // The sample's free camera: 50 units per step, times its speed multiplier of 3, per second.
    const CAMERA_MOVE_SPEED = 150.0;

    // The sample's directional light: its color and intensity, and the shadow camera on its node,
    // an orthographic one "hardcoded to fit to the scene".
    const LIGHT_COLOR = [50.0, 40.0, 30.0, 1.0];
    const SHADOW_LEFT = -2000.0;
    const SHADOW_RIGHT = 3000.0;
    const SHADOW_BOTTOM = -2500.0;
    const SHADOW_TOP = 1500.0;
    const SHADOW_NEAR = -2000.0;
    const SHADOW_FAR = 2000.0;
    // The shadow pass's depth bias: negative, as depth is reversed.
    const SHADOW_DEPTH_BIAS = -1;
    const SHADOW_SLOPE_SCALED_DEPTH_BIAS = -2.0;

    // The sample's benchmark mode (--benchmark): simulated at 60 frames per second.
    const BENCHMARK_FRAME_TIME = 1.0 / 60.0;

    // Bounds start out inverted.
    const HUGE = 1.0e30;

    // The blur chain's level sizes: the HDR size halved `level` times.
    function levelWidth(level: int): int {
        return Math.max(1, HDR_WIDTH >> level);
    }

    function levelHeight(level: int): int {
        return Math.max(1, HDR_HEIGHT >> level);
    }

    // --- Math (glm's layout: 4 x 4 matrices by columns, quaternions as x, y, z, w) --------------

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

    // glm::angleAxis.
    function angleAxis(angle: number, x: number, y: number, z: number): number[] {
        const s = Math.sin(0.5 * angle);
        return [x * s, y * s, z * s, Math.cos(0.5 * angle)];
    }

    // a * b.
    function quatMultiply(a: number[], b: number[]): number[] {
        return [
            a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
            a[3] * b[1] + a[1] * b[3] + a[2] * b[0] - a[0] * b[2],
            a[3] * b[2] + a[2] * b[3] + a[0] * b[1] - a[1] * b[0],
            a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
        ];
    }

    function quatNormalize(q: number[]): number[] {
        const length = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
        return [q[0] / length, q[1] / length, q[2] / length, q[3] / length];
    }

    // glm::mat4_cast.
    function quatToMatrix(q: number[]): number[] {
        const x = q[0];
        const y = q[1];
        const z = q[2];
        const w = q[3];
        return [
            1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y + w * z),       2.0 * (x * z - w * y),       0.0,
            2.0 * (x * y - w * z),       1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z + w * x),       0.0,
            2.0 * (x * z + w * y),       2.0 * (y * z - w * x),       1.0 - 2.0 * (x * x + y * y), 0.0,
            0.0,                         0.0,                         0.0,                         1.0,
        ];
    }

    function transpose(m: number[]): number[] {
        let result: number[] = [];
        for (let column = 0; column < 4; column++) {
            for (let row = 0; row < 4; row++) {
                result.push(m[row * 4 + column]);
            }
        }
        return result;
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

    // The framework's OrthographicCamera::get_projection, glm::ortho(left, right, bottom, top,
    // far, near) (swapped too).
    function reversedOrtho(left: number, right: number, bottom: number, top: number, zNear: number, zFar: number): number[] {
        const n = zFar;
        const f = zNear;
        return [
            2.0 / (right - left),             0.0,                              0.0,              0.0,
            0.0,                              2.0 / (top - bottom),             0.0,              0.0,
            0.0,                              0.0,                              -1.0 / (f - n),   0.0,
            -(right + left) / (right - left), -(top + bottom) / (top - bottom), -n / (f - n),     1.0,
        ];
    }

    // The framework's vulkan_style_projection: [1][1] negated (only that element), for Vulkan's
    // clip space, y down on the screen.
    function vulkanStyleProjection(m: number[]): number[] {
        let result: number[] = [];
        for (let i = 0; i < 16; i++) {
            result.push(i == 5 ? -m[i] : m[i]);
        }
        return result;
    }

    // A matrix into the sample's clip space, into Donut's (y up on the screen): clip y negated. The
    // pictures (and shadow map texels) land where the sample's do.
    function toDonutClip(m: number[]): number[] {
        let result: number[] = [];
        for (let i = 0; i < 16; i++) {
            result.push(i % 4 == 1 ? -m[i] : m[i]);
        }
        return result;
    }

    // --- Passes -------------------------------------------------------------------------------

    // Port of Vulkan-Samples' async_compute: an 8K shadow map and a 4K HDR forward pass of the
    // Bonza scene on the graphics queue, an HDR bloom (threshold, blur down, blur up) in compute
    // shaders, and a tone mapping composite into the swap chain. With async queues, the bloom runs
    // on the compute queue: it waits for the HDR frame, and the composite waits for it, on the GPU.
    // Without, everything runs on the graphics queue.
    //
    // The sample renders the HDR frame on a second, low priority graphics queue where the device
    // has one, so that the next frame's shadow pass overlaps the bloom; Donut has one graphics
    // queue, as most desktop GPUs, where the sample does the same as here.
    class AsyncComputeBloomPass {
        private app: App;
        private camera: Camera;

        // The sample's settings.
        asyncEnabled: boolean;
        doubleBufferHdr: boolean;
        rotateShadows: boolean;
        // Fixed simulation steps, as the sample's benchmark mode.
        benchmark: boolean;
        // Null without a compute queue.
        private computeCommandList: CommandList | null;
        private elapsedTime: number;
        private hdrIndex: int;

        private forwardInputLayout: InputLayoutHandle;
        private shadowInputLayout: InputLayoutHandle;
        private shadowConstantBuffer: BufferHandle;
        private forwardConstantBuffer: BufferHandle;
        private vertexBuffer: BufferHandle;
        private indexBuffer: BufferHandle;

        private shadowMap: TextureHandle;
        private shadowFramebuffer: FramebufferHandle;
        private shadowPipeline: GraphicsPipelineHandle;
        private shadowBindingSet: BindingSet;

        private hdrTargets: TextureHandle[];
        private hdrDepth: TextureHandle;
        private hdrFramebuffers: FramebufferHandle[];
        private forwardPipeline: GraphicsPipelineHandle;
        private forwardBlendPipeline: GraphicsPipelineHandle;
        // One per base color texture.
        private forwardBindingSets: BindingSet[];

        private blurChain: TextureHandle[];
        private thresholdPipeline: ComputePipelineHandle;
        private blurDownPipeline: ComputePipelineHandle;
        private blurUpPipeline: ComputePipelineHandle;
        // The threshold pass from each HDR target, the blur down passes into blur levels 1 ..
        // BLUR_LEVELS - 1 (index level - 1), the blur up passes into levels BLUR_LEVELS - 2 .. 1
        // (index BLUR_LEVELS - 2 - level).
        private thresholdBindingSets: BindingSet[];
        private blurDownBindingSets: BindingSet[];
        private blurUpBindingSets: BindingSet[];

        private compositePS: ShaderHandle;
        private compositeVS: ShaderHandle;
        private compositeBindingLayout: BindingLayoutHandle;
        private compositeBindingSets: BindingSet[];
        // Created on the first frame (the back buffer's layout), dropped on resize.
        private compositePipeline: GraphicsPipelineHandle | null;

        // The draws, a node's primitive each: index range and base vertex, base color texture
        // (forwardBindingSets index), alpha blending, node transform (MODEL_FLOATS each, from
        // models), and world bounds center (3 each), in the framework's order: by mesh, node,
        // primitive.
        private drawFirstIndex: int[];
        private drawIndexCount: int[];
        private drawBaseVertex: int[];
        private drawTexture: int[];
        private drawBlend: boolean[];
        private drawCenters: number[];
        private models: f32[];
        // The draws in drawing order: opaque ones front to back, then blended ones back to front.
        private order: int[];
        private distances: number[];

        // Upload buffers.
        private constants: f32[];
        private blurConstants: f32[];
        // Donut's view matrix, 16 floats.
        private viewMatrix: f32[];

        constructor(app: App) {
            this.app = app;
            this.asyncEnabled = false;
            this.doubleBufferHdr = false;
            this.rotateShadows = true;
            this.benchmark = false;
            this.computeCommandList = null;
            this.elapsedTime = 0.0;
            this.hdrIndex = 0;
            this.hdrTargets = [];
            this.hdrFramebuffers = [];
            this.forwardBindingSets = [];
            this.blurChain = [];
            this.thresholdBindingSets = [];
            this.blurDownBindingSets = [];
            this.blurUpBindingSets = [];
            this.compositeBindingSets = [];
            this.compositePipeline = null;
            this.drawFirstIndex = [];
            this.drawIndexCount = [];
            this.drawBaseVertex = [];
            this.drawTexture = [];
            this.drawBlend = [];
            this.drawCenters = [];
            this.models = [];
            this.order = [];
            this.distances = [];

            this.constants = [];
            for (let i = 0; i < CONST_FLOATS; i++) {
                this.constants.push(0.0);
            }
            this.blurConstants = [];
            for (let i = 0; i < BLUR_FLOATS; i++) {
                this.blurConstants.push(0.0);
            }
            this.viewMatrix = [];
            for (let i = 0; i < 16; i++) {
                this.viewMatrix.push(0.0);
            }
        }

        hasComputeQueue(): boolean {
            return this.computeCommandList != null;
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
            this.elapsedTime += this.benchmark ? BENCHMARK_FRAME_TIME : elapsedSeconds;
            const queues = this.asyncEnabled && this.hasComputeQueue() ? "async compute" : "one queue";
            this.app.setInformativeWindowTitleWithInfo(WINDOW_TITLE, queues);
        }

        onBackBufferResizing(): void {
            const compositePipeline = this.compositePipeline;
            if (compositePipeline) {
                this.app.releaseResource(compositePipeline);
            }
            this.compositePipeline = null;
        }

        // The sample's update: the directional light's (and shadow camera's) orientation, "lots of
        // random jank to get a desired orientation quaternion", turning once every 20 seconds when
        // the shadows rotate.
        lightOrientation(): number[] {
            let orientation = quatMultiply(angleAxis(Math.PI, 0.0, -1.0, 0.0), angleAxis(-0.2 * 0.5 * Math.PI, 1.0, 0.0, 0.0));
            if (this.rotateShadows) {
                const turns = this.elapsedTime * 0.05;
                orientation = quatMultiply(orientation, angleAxis(2.0 * Math.PI * (turns - Math.floor(turns)), 0.0, 0.0, -1.0));
                orientation = quatMultiply(orientation, angleAxis(-0.05 * 0.5 * Math.PI, 1.0, 0.0, 0.0));
            }
            return quatNormalize(orientation);
        }

        // The scene uniforms of both passes: the shadow camera's (on the light's node, at the
        // origin) and the main camera's view-projections, in Donut's clip space; the sample's
        // shadow matrix (its shadow clip space to texture coordinates); the light.
        updateConstants(commandList: CommandList, width: int, height: int): void {
            const light = quatToMatrix(this.lightOrientation());
            // The shadow camera's view: the inverse of its node's rotation.
            const shadowView = transpose(light);
            const shadowClip = multiply(vulkanStyleProjection(reversedOrtho(SHADOW_LEFT, SHADOW_RIGHT, SHADOW_BOTTOM, SHADOW_TOP,
                SHADOW_NEAR, SHADOW_FAR)), shadowView);
            // translate(0.5, 0.5, 0) * scale(0.5, 0.5, 1) * shadowClip
            let bias = identity();
            bias[0] = 0.5;
            bias[5] = 0.5;
            bias[12] = 0.5;
            bias[13] = 0.5;
            const shadowMatrix = multiply(bias, shadowClip);

            // Donut's camera, in Donut's view space (z forward), into the sample's (-z forward).
            this.camera.getWorldToView(Ref(this.viewMatrix[0]));
            let view: number[] = [];
            for (let i = 0; i < 16; i++) {
                view.push(i % 4 == 2 ? -this.viewMatrix[i] : this.viewMatrix[i]);
            }
            const viewProj = multiply(vulkanStyleProjection(reversedPerspective(CAMERA_FOV, width / height, Z_NEAR, Z_FAR)), view);

            const c = this.constants;
            const donutShadowClip = toDonutClip(shadowClip);
            for (let i = 0; i < 16; i++) {
                c[CONST_VIEW_PROJ + i] = donutShadowClip[i];
                c[CONST_SHADOW_MATRIX + i] = shadowMatrix[i];
            }
            for (let i = 0; i < 4; i++) {
                c[CONST_LIGHT_COLOR + i] = LIGHT_COLOR[i];
            }
            // The light's direction: its node's rotation of (0, 0, -1).
            c[CONST_LIGHT_DIRECTION] = -light[8];
            c[CONST_LIGHT_DIRECTION + 1] = -light[9];
            c[CONST_LIGHT_DIRECTION + 2] = -light[10];
            c[CONST_LIGHT_DIRECTION + 3] = 0.0;
            commandList.writeBuffer(this.shadowConstantBuffer, Ref(c[0]), CONST_FLOATS * 4);

            const donutViewProj = toDonutClip(viewProj);
            for (let i = 0; i < 16; i++) {
                c[CONST_VIEW_PROJ + i] = donutViewProj[i];
            }
            commandList.writeBuffer(this.forwardConstantBuffer, Ref(c[0]), CONST_FLOATS * 4);
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
            // Opaque draws, then blended ones; each in the framework's order.
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

        drawScene(frame: Frame, pipeline: GraphicsPipelineHandle, blendPipeline: GraphicsPipelineHandle, framebuffer: FramebufferHandle, forward: boolean): void {
            // The draw state's blending (-1 before the first draw) and texture.
            let currentBlend = -1;
            let currentTexture = -1;
            for (let i = 0; i < this.order.length; i++) {
                const d = this.order[i];
                const blend = this.drawBlend[d] ? 1 : 0;
                const texture = forward ? this.drawTexture[d] : 0;
                // A new draw state for another pipeline or binding set.
                if (blend != currentBlend || texture != currentTexture) {
                    frame.beginDrawToFramebuffer(blend == 1 ? blendPipeline : pipeline, framebuffer);
                    if (forward) {
                        frame.drawAddBindingSet(this.forwardBindingSets[texture]);
                    } else {
                        frame.drawAddBindingSet(this.shadowBindingSet);
                    }
                    frame.drawSetIndexBuffer(this.indexBuffer);
                    frame.drawAddVertexBuffer(this.vertexBuffer, 0, 0);
                    currentBlend = blend;
                    currentTexture = texture;
                }
                frame.drawIndexedRangeWithPushConstants(this.drawIndexCount[d], this.drawFirstIndex[d], this.drawBaseVertex[d],
                    Ref(this.models[d * MODEL_FLOATS]), MODEL_SIZE);
            }
        }

        // The sample's render_shadow_pass: the scene's depth from the light, into the shadow map
        // (reversed depth, cleared to 0).
        renderShadowPass(frame: Frame, commandList: CommandList): void {
            commandList.beginMarker("Shadow pass");
            commandList.clearDepth(this.shadowMap, 0.0);
            // The shadow camera's node is at the origin.
            this.sortDraws(0.0, 0.0, 0.0);
            this.drawScene(frame, this.shadowPipeline, this.shadowPipeline, this.shadowFramebuffer, false);
            commandList.endMarker();
        }

        // The sample's render_forward_offscreen_pass: the lit and shadowed scene into the HDR target.
        renderForwardPass(frame: Frame, commandList: CommandList): void {
            commandList.beginMarker("Forward offscreen pass");
            commandList.clearTextureFloat(this.hdrTargets[this.hdrIndex], 0.0, 0.0, 0.0, 1.0);
            commandList.clearDepth(this.hdrDepth, 0.0);
            const view = this.viewMatrix;
            // The camera's position: -R^T t of its view [R t].
            let position: number[] = [0.0, 0.0, 0.0];
            for (let column = 0; column < 3; column++) {
                for (let row = 0; row < 3; row++) {
                    position[column] -= view[column * 4 + row] * view[12 + row];
                }
            }
            this.sortDraws(position[0], position[1], position[2]);
            this.drawScene(frame, this.forwardPipeline, this.forwardBlendPipeline, this.hdrFramebuffers[this.hdrIndex], true);
            commandList.endMarker();
        }

        // One bloom pass: a thread per texel of the destination.
        dispatchBlurPass(commandList: CommandList, pipeline: ComputePipelineHandle, bindingSet: BindingSet,
            width: int, height: int, inputWidth: int, inputHeight: int): void {
            const b = this.blurConstants;
            Donut_StoreInt32(Ref(b[0]), width);
            Donut_StoreInt32(Ref(b[1]), height);
            b[2] = 1.0 / width;
            b[3] = 1.0 / height;
            b[4] = 1.0 / inputWidth;
            b[5] = 1.0 / inputHeight;
            commandList.dispatchWithPushConstants(pipeline, bindingSet, Ref(b[0]), BLUR_SIZE,
                Math.floor((width + BLUR_GROUP_SIZE - 1) / BLUR_GROUP_SIZE), Math.floor((height + BLUR_GROUP_SIZE - 1) / BLUR_GROUP_SIZE), 1);
        }

        // The sample's render_compute_post: "a very basic and dumb HDR Bloom pipeline", a threshold
        // pass into the first blur level, then blurring down the levels and back up to the second.
        renderComputePost(commandList: CommandList): void {
            commandList.beginMarker("Compute post");
            this.dispatchBlurPass(commandList, this.thresholdPipeline, this.thresholdBindingSets[this.hdrIndex],
                levelWidth(1), levelHeight(1), HDR_WIDTH, HDR_HEIGHT);
            for (let index = 1; index < BLUR_LEVELS; index++) {
                this.dispatchBlurPass(commandList, this.blurDownPipeline, this.blurDownBindingSets[index - 1],
                    levelWidth(index + 1), levelHeight(index + 1), levelWidth(index), levelHeight(index));
            }
            for (let index = BLUR_LEVELS - 2; index >= 1; index--) {
                this.dispatchBlurPass(commandList, this.blurUpPipeline, this.blurUpBindingSets[BLUR_LEVELS - 2 - index],
                    levelWidth(index + 1), levelHeight(index + 1), levelWidth(index + 2), levelHeight(index + 2));
            }
            commandList.endMarker();
        }

        onRender(frameHandle: FrameHandle): void {
            const frame = new Frame(frameHandle);
            const width = frame.getWidth();
            const height = frame.getHeight();
            const commandList = frame.getCommandList();

            if (!this.compositePipeline) {
                this.compositePipeline = this.app.createGraphicsPipelineWithTopology(frame, this.compositeVS, this.compositePS,
                    null, this.compositeBindingLayout, PrimitiveType.TriangleList);
            }
            const compositePipeline = this.compositePipeline;
            if (!compositePipeline) {
                return;
            }

            // Double buffered HDR: the next frame can run ahead a little further before it needs to
            // block.
            this.hdrIndex = this.doubleBufferHdr ? 1 - this.hdrIndex : 0;

            this.updateConstants(commandList, width, height);
            this.renderShadowPass(frame, commandList);
            this.renderForwardPass(frame, commandList);

            let computed = false;
            const computeCommandList = this.computeCommandList;
            if (this.asyncEnabled) {
                if (computeCommandList) {
                    computeCommandList.open();
                    this.renderComputePost(computeCommandList);
                    computeCommandList.close();
                    this.app.executeFrameComputeWork(frame, computeCommandList);
                    computed = true;
                }
            }
            if (!computed) {
                this.renderComputePost(commandList);
            }

            // The sample's render_swapchain: the composite (its UI comes after, in the ImGui pass).
            frame.beginDraw(compositePipeline);
            frame.drawAddBindingSet(this.compositeBindingSets[this.hdrIndex]);
            frame.drawVertices(3);
        }

        // The scene's base color textures and its draws: every node's primitives, their vertices and
        // indices in one vertex and one index buffer, recorded into an open command list.
        loadScene(commandList: CommandList, linearWrap: SamplerHandle, comparisonSampler: SamplerHandle, forwardBindingLayout: BindingLayoutHandle): boolean {
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
                const setDesc = BindingSetDesc.create();
                setDesc.bindEntireConstantBuffer(0, this.forwardConstantBuffer);
                setDesc.bindTextureSRV(0, texture);
                setDesc.bindSampler(0, linearWrap);
                setDesc.bindTextureSRV(1, this.shadowMap);
                setDesc.bindSampler(1, comparisonSampler);
                setDesc.bindPushConstants(1, MODEL_SIZE);
                this.forwardBindingSets.push(this.app.createBindingSetForLayout(setDesc, forwardBindingLayout));
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
            const shader = "async_compute_bloom.hlsl";
            const shadowVS = this.app.createShader(shader, "shadow_vs", ShaderType.Vertex);
            const shadowPS = this.app.createShader(shader, "shadow_ps", ShaderType.Pixel);
            const forwardVS = this.app.createShader(shader, "forward_vs", ShaderType.Vertex);
            const forwardPS = this.app.createShader(shader, "forward_ps", ShaderType.Pixel);
            const postShader = "async_compute_bloom_post.hlsl";
            const thresholdCS = this.app.createShader(postShader, "threshold_cs", ShaderType.Compute);
            const blurDownCS = this.app.createShader(postShader, "blur_down_cs", ShaderType.Compute);
            const blurUpCS = this.app.createShader(postShader, "blur_up_cs", ShaderType.Compute);
            this.compositeVS = this.app.createShader(shader, "composite_vs", ShaderType.Vertex);
            this.compositePS = this.app.createShader(shader, "composite_ps", ShaderType.Pixel);
            if (!shadowVS || !shadowPS || !forwardVS || !forwardPS || !thresholdCS || !blurDownCS || !blurUpCS
                || !this.compositeVS || !this.compositePS) {
                return false;
            }

            this.computeCommandList = null;
            const computeCommandList = this.app.createComputeQueueCommandList();
            if (!computeCommandList.isNull()) {
                this.computeCommandList = computeCommandList;
            }

            // The vertices: positions for the shadow pass, all of them for the forward pass.
            const shadowLayoutDesc = InputLayoutDesc.create();
            shadowLayoutDesc.addVertexAttribute("POSITION", Format.RGB32_FLOAT, 0, 0, VERTEX_SIZE);
            this.shadowInputLayout = this.app.createInputLayout(shadowLayoutDesc, shadowVS);
            const forwardLayoutDesc = InputLayoutDesc.create();
            forwardLayoutDesc.addVertexAttribute("POSITION", Format.RGB32_FLOAT, 0, 0, VERTEX_SIZE);
            forwardLayoutDesc.addVertexAttribute("NORMAL", Format.RGB32_FLOAT, 12, 0, VERTEX_SIZE);
            forwardLayoutDesc.addVertexAttribute("TEXCOORD", Format.RG32_FLOAT, 24, 0, VERTEX_SIZE);
            this.forwardInputLayout = this.app.createInputLayout(forwardLayoutDesc, forwardVS);

            this.shadowConstantBuffer = this.app.createVolatileConstantBuffer(CONST_FLOATS * 4, "Shadow SceneConstants");
            this.forwardConstantBuffer = this.app.createVolatileConstantBuffer(CONST_FLOATS * 4, "Forward SceneConstants");

            // The shadow map: 16-bit depth (8K, "overkill to stress devices"), reversed.
            this.shadowMap = this.app.createDepthTexture(SHADOW_RESOLUTION, SHADOW_RESOLUTION, Format.D16, 0.0, "Shadow Map");
            this.shadowFramebuffer = this.app.createDepthFramebuffer(this.shadowMap);
            const shadowLayoutBindingDesc = BindingLayoutDesc.create();
            shadowLayoutBindingDesc.layoutVolatileConstantBuffer(0);
            shadowLayoutBindingDesc.layoutPushConstants(1, MODEL_SIZE);
            const shadowBindingLayout = this.app.createBindingLayout(shadowLayoutBindingDesc, ShaderType.All);
            const shadowSetDesc = BindingSetDesc.create();
            shadowSetDesc.bindEntireConstantBuffer(0, this.shadowConstantBuffer);
            shadowSetDesc.bindPushConstants(1, MODEL_SIZE);
            this.shadowBindingSet = this.app.createBindingSetForLayout(shadowSetDesc, shadowBindingLayout);
            // The framework's geometry pipeline state: reversed depth (greater), back faces culled,
            // counter-clockwise front faces; plus the sample's depth bias against shadow acne.
            const shadowDesc = GraphicsPipelineDesc.create(shadowVS, shadowPS);
            shadowDesc.setInputLayout(this.shadowInputLayout);
            shadowDesc.addBindingLayout(shadowBindingLayout);
            shadowDesc.setDepthState(1, 1, ComparisonFunc.Greater);
            shadowDesc.setRasterState(CullMode.Back, FillMode.Solid, 1);
            shadowDesc.setDepthBias(SHADOW_DEPTH_BIAS, 0.0, SHADOW_SLOPE_SCALED_DEPTH_BIAS);
            this.shadowPipeline = this.app.createGraphicsPipelineFromDesc(shadowDesc, this.shadowFramebuffer);

            // The HDR targets, the compute post's input: RGBA16F, two for double buffering, with one
            // depth buffer (reversed).
            this.hdrDepth = this.app.createDepthTexture(HDR_WIDTH, HDR_HEIGHT, Format.D32, 0.0, "HDR Depth");
            for (let i = 0; i < 2; i++) {
                const target = this.app.createComputeReadableRenderTarget(HDR_WIDTH, HDR_HEIGHT, Format.RGBA16_FLOAT, `HDR Color ${i}`);
                this.hdrTargets.push(target);
                this.hdrFramebuffers.push(this.app.createFramebuffer(target, this.hdrDepth));
            }

            // The forward pass: the scene uniform, the base color texture and its sampler, the
            // shadow map and its comparison sampler, the node transform.
            const forwardLayoutBindingDesc = BindingLayoutDesc.create();
            forwardLayoutBindingDesc.layoutVolatileConstantBuffer(0);
            forwardLayoutBindingDesc.layoutTextureSRV(0);
            forwardLayoutBindingDesc.layoutSampler(0);
            forwardLayoutBindingDesc.layoutTextureSRV(1);
            forwardLayoutBindingDesc.layoutSampler(1);
            forwardLayoutBindingDesc.layoutPushConstants(1, MODEL_SIZE);
            const forwardBindingLayout = this.app.createBindingLayout(forwardLayoutBindingDesc, ShaderType.All);
            for (let blend = 0; blend < 2; blend++) {
                const desc = GraphicsPipelineDesc.create(forwardVS, forwardPS);
                desc.setInputLayout(this.forwardInputLayout);
                desc.addBindingLayout(forwardBindingLayout);
                desc.setDepthState(1, 1, ComparisonFunc.Greater);
                desc.setRasterState(CullMode.Back, FillMode.Solid, 1);
                // The framework blends the materials in blend mode.
                if (blend == 1) {
                    desc.setBlendMode(BlendMode.AlphaBlend);
                }
                const pipeline = this.app.createGraphicsPipelineFromDesc(desc, this.hdrFramebuffers[0]);
                if (blend == 1) {
                    this.forwardBlendPipeline = pipeline;
                } else {
                    this.forwardPipeline = pipeline;
                }
            }

            // The sample's samplers: linear and clamped for the post passes, a comparison one for
            // the shadow map; the scene's (linear, repeating) for its textures. Donut's common passes,
            // which hold theirs, upload their textures on a command list of their own: before ours is
            // open.
            const linearClamp = this.app.getCommonSampler(CommonSampler.LinearClamp);
            const linearWrap = this.app.getCommonSampler(CommonSampler.LinearWrap);
            const comparisonSampler = this.app.createComparisonSampler();

            const commandList = this.app.createCommandList();
            commandList.open();
            const loaded = this.loadScene(commandList, linearWrap, comparisonSampler, forwardBindingLayout);
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.waitForIdle();
            this.app.releaseResource(commandList.handle);
            if (!loaded) {
                console.log("Cannot load the scene and its textures: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return false;
            }

            // The bloom: the blur chain, levels 1 to BLUR_LEVELS of the HDR size, RGBA16F.
            for (let level = 1; level <= BLUR_LEVELS; level++) {
                this.blurChain.push(this.app.createComputeTexture(levelWidth(level), levelHeight(level), Format.RGBA16_FLOAT,
                    `Blur Chain ${level}`));
            }
            // Each pass: its input and sampler, its output, the resolutions.
            const blurLayoutDesc = BindingLayoutDesc.create();
            blurLayoutDesc.layoutTextureSRV(0);
            blurLayoutDesc.layoutSampler(0);
            blurLayoutDesc.layoutTextureUAV(0);
            blurLayoutDesc.layoutPushConstants(0, BLUR_SIZE);
            const blurBindingLayout = this.app.createBindingLayout(blurLayoutDesc, ShaderType.Compute);
            this.thresholdPipeline = this.app.createComputePipelineWithLayout(thresholdCS, blurBindingLayout);
            this.blurDownPipeline = this.app.createComputePipelineWithLayout(blurDownCS, blurBindingLayout);
            this.blurUpPipeline = this.app.createComputePipelineWithLayout(blurUpCS, blurBindingLayout);
            for (let i = 0; i < 2; i++) {
                this.thresholdBindingSets.push(this.createBlurBindingSet(blurBindingLayout, linearClamp, this.hdrTargets[i], this.blurChain[0]));
            }
            for (let index = 1; index < BLUR_LEVELS; index++) {
                this.blurDownBindingSets.push(this.createBlurBindingSet(blurBindingLayout, linearClamp,
                    this.blurChain[index - 1], this.blurChain[index]));
            }
            for (let index = BLUR_LEVELS - 2; index >= 1; index--) {
                this.blurUpBindingSets.push(this.createBlurBindingSet(blurBindingLayout, linearClamp,
                    this.blurChain[index + 1], this.blurChain[index]));
            }

            // The composite: the HDR frame and the bloom, through the linear sampler.
            const compositeLayoutDesc = BindingLayoutDesc.create();
            compositeLayoutDesc.layoutTextureSRV(0);
            compositeLayoutDesc.layoutTextureSRV(1);
            compositeLayoutDesc.layoutSampler(0);
            this.compositeBindingLayout = this.app.createBindingLayout(compositeLayoutDesc, ShaderType.Pixel);
            for (let i = 0; i < 2; i++) {
                const setDesc = BindingSetDesc.create();
                setDesc.bindTextureSRV(0, this.hdrTargets[i]);
                setDesc.bindTextureSRV(1, this.blurChain[BLOOM_INDEX]);
                setDesc.bindSampler(0, linearClamp);
                this.compositeBindingSets.push(this.app.createBindingSetForLayout(setDesc, this.compositeBindingLayout));
            }

            // The scene's camera, as the sample's free camera starts.
            const q = CAMERA_ROTATION;
            const forward = [-2.0 * (q[0] * q[2] + q[3] * q[1]), -2.0 * (q[1] * q[2] - q[3] * q[0]), -(1.0 - 2.0 * (q[0] * q[0] + q[1] * q[1]))];
            const p = CAMERA_POSITION;
            this.camera = this.app.createFirstPersonCamera();
            this.camera.lookAt(p[0], p[1], p[2], p[0] + forward[0], p[1] + forward[1], p[2] + forward[2]);
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

        createBlurBindingSet(layout: BindingLayoutHandle, sampler: SamplerHandle, input: TextureHandle, output: TextureHandle): BindingSet {
            const setDesc = BindingSetDesc.create();
            setDesc.bindTextureSRV(0, input);
            setDesc.bindSampler(0, sampler);
            setDesc.bindTextureUAV(0, output);
            setDesc.bindPushConstants(0, BLUR_SIZE);
            return this.app.createBindingSetForLayout(setDesc, layout);
        }
    }

    // The sample's options window.
    class UserInterface {
        private post: AsyncComputeBloomPass;

        constructor(post: AsyncComputeBloomPass) {
            this.post = post;
        }

        buildUI(): void {
            const post = this.post;
            Donut_ImGuiSetNextWindowPos(10.0, 10.0);
            Donut_ImGuiBegin("Options", 1);
            if (post.hasComputeQueue()) {
                post.asyncEnabled = Donut_ImGuiCheckbox("Enable async queues", post.asyncEnabled ? 1 : 0) != 0;
            } else {
                Donut_ImGuiText("No compute queue: no async queues");
            }
            post.doubleBufferHdr = Donut_ImGuiCheckbox("Double buffer HDR", post.doubleBufferHdr ? 1 : 0) != 0;
            post.rotateShadows = Donut_ImGuiCheckbox("Rotate shadows", post.rotateShadows ? 1 : 0) != 0;
            Donut_ImGuiEnd();
        }

        // Declared after buildUI: tslang resolves `this.buildUI` only for members declared earlier.
        init(app: App): boolean {
            return !app.addImGuiPass(this.buildUI).isNull();
        }
    }

    export function main(argc: int, argv: Ref<string>): int {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("async_compute_bloom");

        // -debug: the graphics API's debug layer and NVRHI's validation layer.
        // -noui: without the options window.
        // -async: async queues on; -doublebuffer: double buffered HDR; -norotate: shadows fixed.
        // -benchmark: simulated at 60 frames per second whatever the frame rate, as the sample's
        // --benchmark.
        let options = AppOptions.ComputeQueue;
        let withUI = true;
        let asyncEnabled = false;
        let doubleBufferHdr = false;
        let rotateShadows = true;
        let benchmark = false;
        for (let i = 1; i < argc; i++) {
            const arg = Donut_GetArg(argv, i);
            if (arg == "-debug") {
                options = AppOptions.ComputeQueue | AppOptions.DebugRuntime;
            } else if (arg == "-noui") {
                withUI = false;
            } else if (arg == "-async") {
                asyncEnabled = true;
            } else if (arg == "-doublebuffer") {
                doubleBufferHdr = true;
            } else if (arg == "-norotate") {
                rotateShadows = false;
            } else if (arg == "-benchmark") {
                benchmark = true;
            }
        }

        const api = Donut_GetGraphicsAPIFromCommandLine(argc, argv);
        const app = App.createWithOptions(api, WINDOW_TITLE, 1280, 720, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        const post = new AsyncComputeBloomPass(app);
        post.asyncEnabled = asyncEnabled;
        post.doubleBufferHdr = doubleBufferHdr;
        post.rotateShadows = rotateShadows;
        post.benchmark = benchmark;
        if (!post.init()) {
            app.destroy();
            return 1;
        }
        if (asyncEnabled && !post.hasComputeQueue()) {
            console.log("The graphics device has no compute queue: running on one queue");
        }

        // Drawn after (over) the scene, and sees the mouse first.
        const gui = new UserInterface(post);
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
    return AsyncComputeBloom.main(argc, argv);
}
