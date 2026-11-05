/// <reference path="../../core/nri/nri_interop.d.ts" />
import { NriFrameRing } from "../../core/nri_frame_ring";
import { NriSwapChain } from "../../core/nri_swap_chain";
import { radians, perspective } from "../../core/matrix";
import { FirstPersonCamera } from "../../core/vulkan_samples_camera";
import { Nri, NriAccelerationStructure, NriBlasDesc, NriBuffer, NriCommandBuffer, NriDescriptor, NriDescriptorPool, NriDescriptorSet, NriDevice, NriGltfModel, NriPipeline, NriPipelineDesc, NriPipelineLayout, NriPipelineLayoutDesc, NriQueue, NriSample, NriTexture, NriTopLevelAS } from "../../core/nri";

namespace RayQueriesNri {
    // ray_queries, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead of Donut and
    // NVRHI: the same shaders (ray_queries.hlsl's) and scene (read as Donut's loadGltfModel reads it),
    // through the NRI calls core/nri/nri_interop.d.ts binds. This example creates everything it runs,
    // and does the rendering.

    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    // core/test_check.ts' TEST_SKIPPED (CTest's SKIP_RETURN_CODE): no ray queries, or no shaders for
    // the graphics API (D3D11).
    const TEST_SKIPPED = 77;

    const WINDOW_TITLE = "NRI Example: Ray Queries";

    // The sample's scene (Vulkan-Samples' assets, ray_tracing_extended's copy; see
    // VULKAN_SAMPLES_ASSETS_DIR in CMakeLists.txt): only its geometry is used.
    const SCENE_PATH = "media/ray_tracing_extended/sponza/Sponza01.gltf";
    const SPONZA_SCALE = 0.01;

    // The sample's first person camera: turned 90 degrees around y, at (0, -2, 0) (vkb::Camera's
    // position, the view's translation).
    const CAMERA_ROTATION = [0.0, 90.0, 0.0];
    const CAMERA_POSITION = [0.0, -2.0, 0.0];
    const CAMERA_FOV = 60.0;
    const Z_NEAR = 0.1;
    const Z_FAR = 512.0;
    // ApiVulkanSample's default_clear_color.
    const CLEAR_COLOR = 0.002;

    // GLFW's key codes of the camera's keys (W, S, A, D: Donut's Key values).
    const CAMERA_KEYS = [87, 83, 65, 68];

    // The light circles the scene: 100 units away, half a turn every 5 seconds.
    const PI = 3.14159;
    const LIGHT_RADIUS = 100.0;

    // NriGltfModel.load's vertices: float3 position, float3 normal, float2 texture coordinates.
    const GLTF_VERTEX_FLOATS = 8;
    // The sample's vertices: float3 position, float3 normal.
    const VERTEX_FLOATS = 6;
    const VERTEX_SIZE = VERTEX_FLOATS * 4;
    const NORMAL_OFFSET = 12;

    // struct GlobalUniform { float4x4 view, proj; float3 camera_position, light_position (16
    // bytes each); }; a queued frame's in a 256-byte slice of the constant buffer (D3D12 constant
    // buffer views' alignment).
    const UBO_VIEW = 0;
    const UBO_PROJ = 16;
    const UBO_CAMERA_POSITION = 32;
    const UBO_LIGHT_POSITION = 36;
    const UBO_FLOATS = 40;
    const UBO_STRIDE = 256;

    // nri::TopLevelInstanceBits::TRIANGLE_CULL_DISABLE (NVRHI's InstanceFlags::TriangleCullDisable).
    const INSTANCE_FLAGS_CULL_DISABLE = 1;

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // A frame in flight's own data: its descriptor set (its UBO slice and the TLAS).
    class QueuedFrame {
        constructor(public uboView: NriDescriptor | null, public set: NriDescriptorSet | null) {
        }
    }

    // The pixels whose red, green and blue are each within their range (inclusive).
    function countInRange(pixels: int[], rMin: int, rMax: int, gMin: int, gMax: int, bMin: int, bMax: int): int {
        let count = 0;
        for (let i = 0; i < pixels.length; i++) {
            const p = pixels[i];
            const r = p & 0xFF;
            const g = (p >> 8) & 0xFF;
            const b = (p >> 16) & 0xFF;
            if (r >= rMin && r <= rMax && g >= gMin && g <= gMax && b >= bMin && b <= bMax) {
                count++;
            }
        }
        return count;
    }

    // The pixels whose largest and smallest channels are at least spread apart (colors, not grays).
    function countColored(pixels: int[], spread: int): int {
        let count = 0;
        for (let i = 0; i < pixels.length; i++) {
            const p = pixels[i];
            const r = p & 0xFF;
            const g = (p >> 8) & 0xFF;
            const b = (p >> 16) & 0xFF;
            const high = r > g ? (r > b ? r : b) : (g > b ? g : b);
            const low = r < g ? (r < b ? r : b) : (g < b ? g : b);
            if (high - low >= spread) {
                count++;
            }
        }
        return count;
    }

    // count is between min and max hundredths of total pixels; what names them in the failure.
    function share(count: int, total: int, min: number, max: number, what: string): string {
        const percent = 100.0 * count / total;
        console.log(`${what}: ${percent}% (${count} of ${total} pixels)`);
        if (percent < min || percent > max) {
            return `${what}: ${percent}% of the pixels, not ${min}% to ${max}%`;
        }
        return "";
    }

    // -test: checks the last frame, read back, as the Donut example does: Sponza in gray, lit with ray
    // queried shadows, about 20% in full light (white), no color.
    function checkFrame(pixels: int[], width: int, height: int) {
        if (pixels.length == 0) {
            return "cannot read the back buffer";
        }
        const total = width * height;
        const full = share(countInRange(pixels, 221, 255, 221, 255, 221, 255), total, 12.0, 30.0, "Full light");
        if (full != "") {
            return full;
        }
        return share(countColored(pixels, 61), total, 0.0, 0.5, "Colored");
    }

    // Port of Vulkan-Samples' ray_queries (as examples/ray_queries.ts ports it) to NRI: Sponza
    // rasterized, each pixel shaded by ray queries from its pixel shader (no ray tracing pipeline)
    // against a TLAS of the scene: nine rays for ambient occlusion, one towards a light circling the
    // scene for a hard shadow. The scene's vertices are in a vertex buffer for the rasterization; its
    // BLAS is built from the same positions and indices.
    class RayQueries {
        private device: NriDevice | null = null;
        private queue: NriQueue;
        private frames: NriFrameRing = new NriFrameRing();
        private swapChain: NriSwapChain = new NriSwapChain();
        private queuedFrames: QueuedFrame[] = [];
        private viewFormat: NriFormat = NriFormat.Unknown;
        private depthTexture: NriTexture | null = null;
        private depthAttachment: NriDescriptor | null = null;
        private layout: NriPipelineLayout | null = null;
        private pipeline: NriPipeline | null = null;
        private vertexBuffer: NriBuffer | null = null;
        private indexBuffer: NriBuffer | null = null;
        private indexCount: int = 0;
        private blas: NriAccelerationStructure | null = null;
        private topLevelAS: NriTopLevelAS | null = null;
        private topLevelASView: NriDescriptor | null = null;
        private constantBuffer: NriBuffer | null = null;
        private descriptorPool: NriDescriptorPool | null = null;
        // The swap chain's size: the window's when it was (re)created.
        private width: int = 0;
        private height: int = 0;
        // The swap chain textures' format and their views'.
        private swapChainFormat: NriFormat = 0;
        private swapChainViewFormat: NriFormat = 0;
        // Set by initialize when the example can't run ("" otherwise).
        private unsupportedReason: string = "";

        private camera: FirstPersonCamera = new FirstPersonCamera(CAMERA_POSITION, CAMERA_ROTATION);
        // The mouse buttons and the camera's keys as the camera last saw them.
        private buttons: boolean[] = [false, false, false];
        private keys: boolean[] = [false, false, false, false];

        // The light's clock (milliseconds since the start), or a fixed time (-time).
        private timeMs: number = 0.0;
        fixedTimeMs: number = -1.0;

        // Upload buffer.
        private ubo: f32[] = [];

        // -test: the last frame is read back into readbackBuffer, rows rowPitch bytes apart.
        private test: boolean = false;
        private readbackBuffer: NriBuffer | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSample) {
            for (let i = 0; i < UBO_FLOATS; i++) {
                this.ubo.push(0.0);
            }
        }

        // Renders until the window is closed (in test mode, the test's frames); the exit code.
        run(argc: int, argv: Ref<string>): int {
            const initialize: NriInitializeCallback = this.initialize;
            const latencySleep: NriFrameCallback = this.latencySleep;
            const renderFrame: NriFrameCallback = this.renderFrame;
            retainedInitializeCallbacks.push(initialize);
            retainedFrameCallbacks.push(latencySleep);
            retainedFrameCallbacks.push(renderFrame);
            this.sample.setInitializeCallback(initialize);
            this.sample.setLatencySleepCallback(latencySleep);
            this.sample.setRenderFrameCallback(renderFrame);

            let result = this.sample.run(argc, argv, WINDOW_TITLE, TEST_FRAMES);
            if (this.unsupportedReason != "") {
                const test = this.sample.isTest() != 0;
                console.log(test ? `Test SKIPPED: ${this.unsupportedReason}` : this.unsupportedReason);
                result = test ? TEST_SKIPPED : 1;
            } else if (result == 0 && this.test) {
                const failure = checkFrame(this.readBack(), this.width, this.height);
                console.log(failure == "" ? "Test PASSED" : `Test FAILED: ${failure}`);
                result = failure == "" ? 0 : 1;
            }
            this.destroy();
            return result;
        }

        initialize(graphicsAPI: NriGraphicsAPI): int {
            const device = this.sample.createDevice(graphicsAPI);
            if (!device) {
                console.log("Cannot initialize a graphics device with the requested parameters");
                return 0;
            }
            this.device = device;
            console.log(`Renderer: ${Nri.getGraphicsAPIString(graphicsAPI)} (${device.getAdapterName()})`);

            this.queue = device.getGraphicsQueue();
            this.test = this.sample.isTest() != 0;

            // Swap chain: rendered through sRGB views, as into Donut's sRGB back buffers.
            const queuedFrameNum = this.sample.getQueuedFrameNum();
            this.swapChain.init(this.sample, device, this.queue, true);
            this.sizeToSwapChain();
            const format = this.swapChainFormat;
            const viewFormat = this.swapChainViewFormat;
            this.viewFormat = viewFormat;

            // Ray queries: D3D12 or Vulkan (the Donut example's shaders have no DXBC).
            if (graphicsAPI == NriGraphicsAPI.D3D11) {
                this.unsupportedReason = "No D3D11 shaders (ray queries need D3D12 or Vulkan)";
                return 0;
            }
            if (device.isFeatureSupported(NriFeature.RayQuery) == 0) {
                this.unsupportedReason = "The graphics device does not support Ray Queries";
                return 0;
            }

            // The depth buffer: D32, cleared to 1.
            if (!this.createDepth(device)) {
                console.log("Cannot create the depth buffer");
                return 0;
            }

            if (!this.loadScene(device)) {
                console.log("Cannot load the scene: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return 0;
            }

            // The sample's create_top_level_acceleration_structure: the scene's BLAS once (identity
            // transform, no culling), built before the first frame.
            const blas = this.blas;
            const topLevelAS = device.createTopLevelAS(1, NriAccelerationStructureFlags.None, 1);
            this.topLevelAS = topLevelAS;
            if (!blas || !topLevelAS) {
                console.log("Cannot create the top level acceleration structure");
                return 0;
            }
            const transform: f32[] = [];
            for (let i = 0; i < 12; i++) {
                transform.push(i % 5 == 0 ? 1.0 : 0.0);
            }
            topLevelAS.addInstance(blas, Ref(transform[0]), 0, 0xFF, 0, INSTANCE_FLAGS_CULL_DISABLE);
            if (this.queue.buildTopLevelAS(topLevelAS) == 0) {
                console.log("Cannot build the top level acceleration structure");
                return 0;
            }
            const topLevelASView = topLevelAS.getTopLevelAccelerationStructure().createDescriptor();
            this.topLevelASView = topLevelASView;

            // The layout, as the Donut example's binding layout: the global UBO (b0) and the TLAS (t0).
            const layoutDesc = NriPipelineLayoutDesc.create();
            layoutDesc.addRange(0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.VertexPixel, NriRangeFlags.None);
            layoutDesc.addRange(0, 0, 1, NriDescriptorType.AccelerationStructure, NriStage.Pixel, NriRangeFlags.None);
            const layout = device.createPipelineLayoutFromDesc(layoutDesc);
            layoutDesc.destroy();
            this.layout = layout;
            if (!layout) {
                console.log("Cannot create the pipeline layout");
                return 0;
            }

            const folder = graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv";
            this.pipeline = this.createPipeline(device, layout, `shaders/ray_queries/${folder}/ray_queries`);
            if (!this.pipeline) {
                console.log("Cannot load the ray queries shaders");
                return 0;
            }

            // A queued frame's UBO slice, in its descriptor set with the TLAS.
            const constantBuffer = device.createHostBuffer(queuedFrameNum * UBO_STRIDE, NriBufferUsage.ConstantBuffer);
            this.constantBuffer = constantBuffer;
            const descriptorPool = device.createDescriptorPoolWithAccelerationStructures(queuedFrameNum, 0, queuedFrameNum, 0, 0, 0,
                queuedFrameNum);
            this.descriptorPool = descriptorPool;
            if (!constantBuffer || !descriptorPool || !topLevelASView) {
                console.log("Cannot create the descriptors");
                return 0;
            }
            this.frames.init(device, this.queue, queuedFrameNum);
            for (let i = 0; i < queuedFrameNum; i++) {
                const uboView = constantBuffer.createConstantView(i * UBO_STRIDE, UBO_STRIDE);
                const set = descriptorPool.allocateDescriptorSet(layout, 0, 0);
                this.queuedFrames.push(new QueuedFrame(uboView, set));
                if (!uboView || !set) {
                    console.log("Cannot create the descriptor sets");
                    return 0;
                }
                set.updateDescriptor(0, 0, uboView);
                set.updateDescriptor(1, 0, topLevelASView);
            }

            if (this.test) {
                const alignment = device.getUploadBufferTextureRowAlignment();
                this.rowPitch = Math.floor((this.width * 4 + alignment - 1) / alignment) * alignment;
                this.readbackBuffer = device.createReadbackBuffer(this.rowPitch * this.height);
                this.readbackFormat = format;
            }
            return 1;
        }

        // The sample's pipeline: positions and normals, depth tested (less) and written, back faces
        // culled (counter-clockwise front faces), no blending.
        createPipeline(device: NriDevice, layout: NriPipelineLayout, shaders: string) {
            const desc = NriPipelineDesc.create();
            let loaded = desc.addShader(NriShaderStage.Vertex, `${shaders}_ray_shadow_vs.bin`, "ray_shadow_vs") != 0;
            if (loaded) {
                loaded = desc.addShader(NriShaderStage.Pixel, `${shaders}_ray_shadow_ps.bin`, "ray_shadow_ps") != 0;
            }
            desc.addVertexAttribute("POSITION", NriFormat.RGB32_SFLOAT, 0);
            desc.addVertexAttribute("NORMAL", NriFormat.RGB32_SFLOAT, NORMAL_OFFSET);
            desc.setCullMode(NriCullMode.Back);
            desc.setFrontCounterClockwise(1);
            desc.setColor(this.viewFormat, NriColorWrite.RGBA);
            desc.setDepth(NriFormat.D32_SFLOAT, NriCompareOp.Less, 1, 0);
            let pipeline: NriPipeline | null = null;
            if (loaded) {
                pipeline = device.createPipelineFromDesc(layout, desc);
            }
            desc.destroy();
            return pipeline;
        }

        // The sample's load_scene: every node's meshes, positions pre-multiplied by the node's world
        // transform (and Sponza's scale, which also scales the translation: the sample multiplies
        // vec4(position, 1) by it), normals by its normal matrix (not normalized), into one vertex and
        // one index list; then create_bottom_level_acceleration_structure and create_uniforms: a BLAS of
        // them (preferring fast tracing), and the buffers the rasterization reads. False on failure.
        loadScene(device: NriDevice) {
            const model = NriGltfModel.load(SCENE_PATH);
            if (!model) {
                return false;
            }
            const vertices: f32[] = [];
            const positions: f32[] = [];
            const indices: int[] = [];
            const m: f32[] = [];
            for (let i = 0; i < 16; i++) {
                m.push(0.0);
            }
            const primitiveCount = model.getPrimitiveCount();
            const nodeCount = model.getNodeCount();
            for (let node = 0; node < nodeCount; node++) {
                const mesh = model.getNodeMesh(node);
                model.copyNodeTransform(node, Ref(m[0]));
                // transpose(inverse(mat3(m))): the cofactor matrix over the determinant.
                const a = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
                const c = [
                    a[4] * a[8] - a[5] * a[7], a[5] * a[6] - a[3] * a[8], a[3] * a[7] - a[4] * a[6],
                    a[2] * a[7] - a[1] * a[8], a[0] * a[8] - a[2] * a[6], a[1] * a[6] - a[0] * a[7],
                    a[1] * a[5] - a[2] * a[4], a[2] * a[3] - a[0] * a[5], a[0] * a[4] - a[1] * a[3],
                ];
                const det = a[0] * c[0] + a[1] * c[1] + a[2] * c[2];
                for (let p = 0; p < primitiveCount; p++) {
                    if (model.getPrimitiveMesh(p) != mesh) {
                        continue;
                    }
                    const vertexStart = vertices.length / VERTEX_FLOATS;
                    const vertexCount = model.getVertexCount(p);
                    const indexCount = model.getIndexCount(p);
                    const gltfVertices: f32[] = [];
                    for (let i = 0; i < vertexCount * GLTF_VERTEX_FLOATS; i++) {
                        gltfVertices.push(0.0);
                    }
                    const gltfIndices: int[] = [];
                    for (let i = 0; i < indexCount; i++) {
                        gltfIndices.push(0);
                    }
                    model.copyVertices(p, Ref(gltfVertices[0]));
                    model.copyIndices(p, Ref(gltfIndices[0]));
                    for (let v = 0; v < vertexCount; v++) {
                        const g = v * GLTF_VERTEX_FLOATS;
                        const x = gltfVertices[g];
                        const y = gltfVertices[g + 1];
                        const z = gltfVertices[g + 2];
                        for (let row = 0; row < 3; row++) {
                            const position: f32 = SPONZA_SCALE * (m[row] * x + m[4 + row] * y + m[8 + row] * z + m[12 + row]);
                            vertices.push(position);
                            positions.push(position);
                        }
                        const nx = gltfVertices[g + 3];
                        const ny = gltfVertices[g + 4];
                        const nz = gltfVertices[g + 5];
                        // c holds the cofactors of mat3(m) transposed (it's read by rows from m's
                        // columns), so transpose(inverse) = cofactors / det has c[k * 3 + row] in row
                        // `row`, column k.
                        for (let row = 0; row < 3; row++) {
                            vertices.push((c[row] * nx + c[3 + row] * ny + c[6 + row] * nz) / det);
                        }
                    }
                    for (let i = 0; i < indexCount; i++) {
                        indices.push(vertexStart + gltfIndices[i]);
                    }
                }
            }
            model.destroy();

            const vertexCount = vertices.length / VERTEX_FLOATS;
            if (vertexCount == 0) {
                return false;
            }
            this.indexCount = indices.length;
            const vertexBuffer = device.createUploadedBuffer(this.queue, Ref(vertices[0]), vertexCount * VERTEX_SIZE,
                NriBufferUsage.VertexBuffer);
            this.vertexBuffer = vertexBuffer;
            const indexBuffer = device.createUploadedBufferFromInts(this.queue, Ref(indices[0]), indices.length * 4,
                NriBufferUsage.IndexBuffer);
            this.indexBuffer = indexBuffer;
            const blasDesc = NriBlasDesc.create();
            blasDesc.addTriangles(Ref(positions[0]), vertexCount, Ref(indices[0]), indices.length);
            const blas = device.buildBlasFromDesc(this.queue, blasDesc, NriAccelerationStructureFlags.PreferFastTrace);
            this.blas = blas;
            blasDesc.destroy();
            if (!vertexBuffer || !indexBuffer || !blas) {
                return false;
            }
            return true;
        }

        // Waits for the frame that last used this frame's command allocator (and its UBO slice).
        latencySleep(frameIndex: int) {
            this.frames.wait(frameIndex);
        }

        // The camera's input (ApiVulkanSample's): the mouse buttons and cursor, the W, S, A, D keys;
        // then its movement and the light's clock over the frame's time (Donut's test mode: 1/60 s, as
        // a float).
        handleInput() {
            for (let button = 0; button < 3; button++) {
                const pressed = this.sample.isButtonPressed(button) != 0;
                if (pressed != this.buttons[button]) {
                    this.camera.mouseButton(<MouseButton>button, <Action>(pressed ? 1 : 0));
                    this.buttons[button] = pressed;
                }
            }
            this.camera.mouseMove(this.sample.getMouseX(), this.sample.getMouseY());
            for (let k = 0; k < 4; k++) {
                const pressed = this.sample.isKeyPressed(CAMERA_KEYS[k]) != 0;
                if (pressed != this.keys[k]) {
                    this.camera.key(<Key>CAMERA_KEYS[k], <Action>(pressed ? 1 : 0));
                    this.keys[k] = pressed;
                }
            }
            const elapsedSeconds = this.test ? Math.fround(1.0 / 60.0) : this.sample.getFrameTime();
            this.camera.update(elapsedSeconds);
            this.timeMs += elapsedSeconds * 1000.0;
        }

        // The sample's update_uniform_buffers: the camera's view and projection (without the Vulkan y
        // flip: as the Donut example's, NRI's clip space is y-up), and the light: angle =
        // mod(time * speed, pi) with the time in whole milliseconds, in float as the sample computes
        // it; into this frame's UBO slice.
        writeUbo(constantBuffer: NriBuffer, queuedFrameIndex: int) {
            const u = this.ubo;
            const view = this.camera.view();
            const projection = perspective(radians(CAMERA_FOV), this.width / this.height, Z_NEAR, Z_FAR);
            for (let i = 0; i < 16; i++) {
                u[UBO_VIEW + i] = view[i];
                u[UBO_PROJ + i] = projection[i];
            }
            for (let i = 0; i < 3; i++) {
                u[UBO_CAMERA_POSITION + i] = this.camera.position[i];
            }
            const time = Math.fround(Math.floor(this.fixedTimeMs >= 0.0 ? this.fixedTimeMs : this.timeMs));
            const pi = Math.fround(PI);
            const speed = Math.fround(Math.fround(2.0 * pi) / 10000.0);
            const x = Math.fround(time * speed);
            const angle = Math.fround(x - Math.fround(pi * Math.floor(Math.fround(x / pi))));
            u[UBO_LIGHT_POSITION] = 0.0;
            u[UBO_LIGHT_POSITION + 1] = LIGHT_RADIUS * Math.fround(Math.sin(angle));
            u[UBO_LIGHT_POSITION + 2] = LIGHT_RADIUS * Math.fround(Math.cos(angle));
            constantBuffer.write(queuedFrameIndex * UBO_STRIDE, Ref(u[0]), UBO_FLOATS * 4);
        }

        // The scene, its pixels shaded by the ray queries (between NriCommandBuffer.beginRenderingWithDepth and
        // NriCommandBuffer.endRendering).
        recordDraw(commandBuffer: NriCommandBuffer, queuedFrame: QueuedFrame) {
            const layout = this.layout;
            const pipeline = this.pipeline;
            const set = queuedFrame.set;
            const vertexBuffer = this.vertexBuffer;
            const indexBuffer = this.indexBuffer;
            if (!layout || !pipeline || !set || !vertexBuffer || !indexBuffer) {
                return;
            }
            commandBuffer.setViewport(0.0, 0.0, this.width, this.height);
            commandBuffer.setScissor(0, 0, this.width, this.height);
            commandBuffer.setPipelineLayout(layout);
            commandBuffer.setDescriptorSet(0, set);
            commandBuffer.setPipeline(pipeline);
            commandBuffer.setIndexBuffer(indexBuffer, 0, NriIndexType.UInt32);
            commandBuffer.setVertexBuffer(0, vertexBuffer, 0, VERTEX_SIZE);
            commandBuffer.drawIndexed(this.indexCount, 1, 0, 0, 0);
        }

        // The swap chain's size and formats (its views sRGB, as Donut's back buffers).
        sizeToSwapChain() {
            this.width = this.swapChain.width();
            this.height = this.swapChain.height();
            this.swapChainFormat = this.swapChain.format();
            this.swapChainViewFormat = this.swapChain.viewFormat();
        }

        // The depth buffer at the swap chain's size; false on failure.
        createDepth(device: NriDevice): boolean {
            const depthTexture = device.createDepthTexture(this.queue, this.width, this.height, NriFormat.D32_SFLOAT);
            this.depthTexture = depthTexture;
            if (!depthTexture) {
                return false;
            }
            this.depthAttachment = depthTexture.createDepthAttachmentView(NriFormat.D32_SFLOAT);
            return true;
        }

        destroyDepth() {
            const depthAttachment = this.depthAttachment;
            if (depthAttachment) {
                depthAttachment.destroy();
            }
            this.depthAttachment = null;
            const depthTexture = this.depthTexture;
            if (depthTexture) {
                depthTexture.destroy();
            }
            this.depthTexture = null;
        }

        // The window was resized (NriSample.useResizableWindow): the swap chain (and what has the window's
        // size) made again at its size, once the GPU is done with the old ones.
        resizeIfNeeded() {
            const device = this.device;
            if (!device) {
                return;
            }
            if (!this.swapChain.resized()) {
                return;
            }
            device.waitIdle();
            this.destroyDepth();
            this.swapChain.recreate();
            this.sizeToSwapChain();
            this.createDepth(device);
        }

        renderFrame(frameIndex: int) {
            this.resizeIfNeeded();
            const queuedFrameIndex = frameIndex % this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            this.handleInput();
            const constantBuffer = this.constantBuffer;
            if (constantBuffer) {
                this.writeUbo(constantBuffer, queuedFrameIndex);
            }

            // Acquire a swap chain texture
            const index = this.swapChain.acquire(frameIndex);
            const depthAttachment = this.depthAttachment;
            const descriptorPool = this.descriptorPool;
            if (index >= 0) {
                const texture = this.swapChain.texture(index);
                const commandBuffer = this.frames.commandBuffer(frameIndex);

                // Record: color cleared to the sample's clear color, depth to 1; the scene.
                commandBuffer.begin();
                if (descriptorPool) {
                    commandBuffer.setDescriptorPool(descriptorPool);
                }
                commandBuffer.textureBarrier(texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                if (depthAttachment) {
                    commandBuffer.beginRenderingWithDepth(this.swapChain.colorAttachment(index), depthAttachment);
                    commandBuffer.clearColor(CLEAR_COLOR, CLEAR_COLOR, CLEAR_COLOR, 1.0);
                    commandBuffer.clearDepth(1.0);
                    this.recordDraw(commandBuffer, queuedFrame);
                    commandBuffer.endRendering();
                }

                // The test's last frame: read back
                let presentFrom = NriTextureState.ColorAttachment;
                const readbackBuffer = this.readbackBuffer;
                if (readbackBuffer) {
                    if (frameIndex == TEST_FRAMES - 1) {
                        commandBuffer.textureBarrier(texture, NriTextureState.ColorAttachment, NriTextureState.CopySource);
                        commandBuffer.readbackTextureToBuffer(readbackBuffer, this.rowPitch, texture, this.width, this.height);
                        presentFrom = NriTextureState.CopySource;
                    }
                }
                commandBuffer.textureBarrier(texture, presentFrom, NriTextureState.Present);
                commandBuffer.end();

                // Submit and present
                this.swapChain.submit(commandBuffer, index);
                this.swapChain.present(index);
            }

            // Signaled after the present, as NRISamples do
            this.frames.signal(frameIndex);
        }

        // The last frame's pixels (0xAABBGGRR), empty if it can't be read.
        readBack(): int[] {
            const device = this.device;
            const readbackBuffer = this.readbackBuffer;
            if (!device || !readbackBuffer) {
                return [];
            }
            device.waitIdle();
            const pixels: int[] = [];
            for (let i = 0; i < this.width * this.height; i++) {
                pixels.push(0);
            }
            if (readbackBuffer.readRGBA8(this.rowPitch, this.width, this.height, this.readbackFormat,
                Ref(pixels[0]), pixels.length) == 0) {
                return [];
            }
            return pixels;
        }

        destroy() {
            const device = this.device;
            if (device) {
                device.waitIdle();
                for (const queuedFrame of this.queuedFrames) {
                    this.destroyDescriptor(queuedFrame.uboView);
                }
                const descriptorPool = this.descriptorPool;
                if (descriptorPool) {
                    descriptorPool.destroy();
                }
                this.destroyDepth();
                this.destroyDescriptor(this.topLevelASView);
                const topLevelAS = this.topLevelAS;
                if (topLevelAS) {
                    topLevelAS.destroy();
                }
                const blas = this.blas;
                if (blas) {
                    blas.destroy();
                }
                this.destroyBuffer(this.vertexBuffer);
                this.destroyBuffer(this.indexBuffer);
                this.destroyBuffer(this.constantBuffer);
                this.destroyBuffer(this.readbackBuffer);
                const pipeline = this.pipeline;
                if (pipeline) {
                    pipeline.destroy();
                }
                const layout = this.layout;
                if (layout) {
                    layout.destroy();
                }
                this.frames.destroy();
                this.swapChain.destroy();
                device.destroy();
            }
            this.sample.destroy();
        }

        destroyDescriptor(descriptor: NriDescriptor | null) {
            if (descriptor) {
                descriptor.destroy();
            }
        }

        destroyBuffer(buffer: NriBuffer | null) {
            if (buffer) {
                buffer.destroy();
            }
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = NriSample.create();
        sample.useResizableWindow();
        const rayQueries = new RayQueries(sample);
        // -time <ms>: the light where it is that many milliseconds after the start, not moving.
        sample.addExampleOptionWithValues("-time", 1);
        for (let i = 1; i < argc; i++) {
            const arg = Nri.getArg(argc, argv, i);
            if (arg == "-time" && i + 1 < argc) {
                i++;
                rayQueries.fixedTimeMs = Math.max(parseFloat(Nri.getArg(argc, argv, i)), 0.0);
            }
        }
        return rayQueries.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return RayQueriesNri.main(argc, argv);
}
