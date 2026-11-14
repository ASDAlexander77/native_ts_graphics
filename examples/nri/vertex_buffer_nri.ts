/// <reference path="../../core/nri/nri_interop.d.ts" />
import { NriFrameRing } from "../../core/nri_frame_ring";
import { NriSwapChain } from "../../core/nri_swap_chain";
import { perspProjD3DStyle, radiansF32, translation } from "../../core/matrix";
import { Nri, NriBuffer, NriCommandBuffer, NriDescriptor, NriDescriptorPool, NriDescriptorSet, NriDevice, NriPipeline, NriPipelineDesc, NriPipelineLayout, NriPipelineLayoutDesc, NriQueue, NriSample, NriTexture } from "../../core/nri";

namespace VertexBufferNri {
    // vertex_buffer, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead of Donut
    // and NVRHI: the same shaders (vertex_buffer.hlsl's), through the NRI calls
    // core/nri/nri_interop.d.ts binds, as basic_triangle_nri draws. The cube's positions and texture
    // coordinates come from one vertex buffer bound to two slots; each view's constants are a slice
    // of one constant buffer, bound by a descriptor set of its own (with the texture and the
    // sampler), as Donut's binding sets.

    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    const WINDOW_TITLE = "NRI Example: Vertex Buffer";

    // --- Model --------------------------------------------------------------------------------

    // struct Vertex { float3 position; float2 uv; }
    const VERTEX_FLOATS = 5;
    const VERTEX_SIZE = VERTEX_FLOATS * 4;
    const UV_OFFSET = 3 * 4;

    const g_Vertices: f32[] = [
        -0.5,  0.5, -0.5,   0.0, 0.0, // front face
         0.5, -0.5, -0.5,   1.0, 1.0,
        -0.5, -0.5, -0.5,   0.0, 1.0,
         0.5,  0.5, -0.5,   1.0, 0.0,

         0.5, -0.5, -0.5,   0.0, 1.0, // right side face
         0.5,  0.5,  0.5,   1.0, 0.0,
         0.5, -0.5,  0.5,   1.0, 1.0,
         0.5,  0.5, -0.5,   0.0, 0.0,

        -0.5,  0.5,  0.5,   0.0, 0.0, // left side face
        -0.5, -0.5, -0.5,   1.0, 1.0,
        -0.5, -0.5,  0.5,   0.0, 1.0,
        -0.5,  0.5, -0.5,   1.0, 0.0,

         0.5,  0.5,  0.5,   0.0, 0.0, // back face
        -0.5, -0.5,  0.5,   1.0, 1.0,
         0.5, -0.5,  0.5,   0.0, 1.0,
        -0.5,  0.5,  0.5,   1.0, 0.0,

        -0.5,  0.5, -0.5,   0.0, 1.0, // top face
         0.5,  0.5,  0.5,   1.0, 0.0,
         0.5,  0.5, -0.5,   1.0, 1.0,
        -0.5,  0.5,  0.5,   0.0, 0.0,

         0.5, -0.5,  0.5,   1.0, 1.0, // bottom face
        -0.5, -0.5, -0.5,   0.0, 0.0,
         0.5, -0.5, -0.5,   1.0, 0.0,
        -0.5, -0.5,  0.5,   0.0, 1.0,
    ];

    const g_Indices: int[] = [
         0,  1,  2,   0,  3,  1, // front face
         4,  5,  6,   4,  7,  5, // left face
         8,  9, 10,   8, 11,  9, // right face
        12, 13, 14,  12, 15, 13, // back face
        16, 17, 18,  16, 19, 17, // top face
        20, 21, 22,  20, 23, 21, // bottom face
    ];
    const INDEX_COUNT = 36;

    const NUM_VIEWS = 4;

    const g_RotationAxes: number[] = [
        1.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
        0.0, 0.0, 1.0,
        1.0, 1.0, 1.0,
    ];

    // One constant buffer with a slice per view (and per frame in flight): a float4x4
    // viewProjMatrix padded to 256 bytes, the alignment of constant buffer views.
    const CONSTANT_BUFFER_ENTRY_SIZE = 256;
    const CONSTANT_BUFFER_ENTRY_FLOATS = CONSTANT_BUFFER_ENTRY_SIZE / 4;
    const FRAME_CONSTANTS_SIZE = NUM_VIEWS * CONSTANT_BUFFER_ENTRY_SIZE;

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // A frame in flight's own data: the descriptor sets of its part of the constant
    // buffer (one per view: its constants, the texture, the sampler).
    class QueuedFrame {
        descriptorSets: NriDescriptorSet[] = [];
        constantViews: NriDescriptor[] = [];
    }

    // --- Math ---------------------------------------------------------------------------------
    // The donut::math functions the C++ sample uses, on row-major 4x4 matrices (16 numbers) with
    // Donut's row-vector convention: `mul(a, b)` applies a, then b.

    function mul(a: number[], b: number[]) {
        const r: number[] = [];
        for (let i = 0; i < 4; i++) {
            for (let j = 0; j < 4; j++) {
                let sum = 0.0;
                for (let k = 0; k < 4; k++) {
                    sum += a[i * 4 + k] * b[k * 4 + j];
                }
                r.push(sum);
            }
        }
        return r;
    }

    // math::rotation(normalize(axis), radians): Rodrigues' rotation formula.
    function rotation(ax: number, ay: number, az: number, angle: number) {
        const len = Math.sqrt(ax * ax + ay * ay + az * az);
        const x = ax / len;
        const y = ay / len;
        const z = az / len;
        const s = Math.sin(angle);
        const c = Math.cos(angle);
        const t = 1.0 - c;
        return [
            c + x * x * t,      z * s + x * y * t,  -y * s + x * z * t, 0.0,
            -z * s + y * x * t, c + y * y * t,      x * s + y * z * t,  0.0,
            y * s + z * x * t,  -x * s + z * y * t, c + z * z * t,      0.0,
            0.0,                0.0,                0.0,                1.0,
        ];
    }

    // math::yawPitchRoll(yaw, pitch, roll).
    function yawPitchRoll(yaw: number, pitch: number, roll: number) {
        const sh = Math.sin(yaw);
        const ch = Math.cos(yaw);
        const sp = Math.sin(pitch);
        const cp = Math.cos(pitch);
        const sb = Math.sin(roll);
        const cb = Math.cos(roll);
        return [
            ch * cb + sh * sp * sb,  sb * cp, -sh * cb + ch * sp * sb, 0.0,
            -ch * sb + sh * sp * cb, cb * cp, sb * sh + ch * sp * cb,  0.0,
            sh * cp,                 -sp,     ch * cp,                 0.0,
            0.0,                     0.0,     0.0,                     1.0,
        ];
    }

    // -test: checks the last frame, read back. The corners are the black clear color; the four
    // textured cubes, one in each quarter of the frame, cover about 17% of each, mostly white.
    function checkFrame(pixels: int[], width: int, height: int) {
        if (pixels.length == 0) {
            return "cannot read the back buffer";
        }
        const xs = [0, width - 1, 0, width - 1];
        const ys = [0, 0, height - 1, height - 1];
        for (let k = 0; k < 4; k++) {
            const p = pixels[ys[k] * width + xs[k]] & 0xFFFFFF;
            if (p != 0) {
                return `corner (${xs[k]}, ${ys[k]}) is ${p & 0xFF}, ${(p >> 8) & 0xFF}, ${(p >> 16) & 0xFF}, not 0, 0, 0`;
            }
        }
        const w = Math.floor(width / 2);
        const h = Math.floor(height / 2);
        for (let q = 0; q < 4; q++) {
            const x0 = (q % 2) * w;
            const y0 = q < 2 ? 0 : h;
            let count = 0;
            for (let y = y0; y < y0 + h; y++) {
                for (let x = x0; x < x0 + w; x++) {
                    if ((pixels[y * width + x] & 0xFFFFFF) != 0) {
                        count++;
                    }
                }
            }
            const percent = 100.0 * count / (w * h);
            console.log(`Cube ${q + 1}: ${percent}% (${count} of ${w * h} pixels)`);
            if (percent < 10.0 || percent > 25.0) {
                return `Cube ${q + 1}: ${percent}% of the pixels, not 10% to 25%`;
            }
        }
        let white = 0;
        for (let i = 0; i < width * height; i++) {
            const p = pixels[i];
            if ((p & 0xFF) >= 221 && ((p >> 8) & 0xFF) >= 221 && ((p >> 16) & 0xFF) >= 221) {
                white++;
            }
        }
        const percent = 100.0 * white / (width * height);
        console.log(`White: ${percent}% (${white} of ${width * height} pixels)`);
        if (percent < 8.0 || percent > 20.0) {
            return `White: ${percent}% of the pixels, not 8% to 20%`;
        }
        return "";
    }

    // Port of Donut-Samples' vertex_buffer.cpp (as examples/vertex_buffer.ts ports it) to NRI: a
    // textured cube drawn in four viewports, each turning around its own axis.
    class VertexBuffer {
        private device: NriDevice | null = null;
        private queue: NriQueue;
        private frames: NriFrameRing = new NriFrameRing();
        private swapChain: NriSwapChain = new NriSwapChain();
        private queuedFrames: QueuedFrame[] = [];
        private pipelineLayout: NriPipelineLayout | null = null;
        private pipeline: NriPipeline | null = null;
        private vertexBuffer: NriBuffer | null = null;
        private indexBuffer: NriBuffer | null = null;
        private texture: NriTexture | null = null;
        private textureView: NriDescriptor | null = null;
        private sampler: NriDescriptor | null = null;
        private constantBuffer: NriBuffer | null = null;
        private descriptorPool: NriDescriptorPool | null = null;
        private width: int = 0;
        private height: int = 0;
        // The swap chain textures' format and their views' (the swap chain's).
        private swapChainFormat: NriFormat = NriFormat.Unknown;
        private swapChainViewFormat: NriFormat = NriFormat.Unknown;

        private rotation: number = 0.0;
        // A frame's constant buffer contents, NUM_VIEWS entries of CONSTANT_BUFFER_ENTRY_FLOATS floats.
        private constants: f32[] = [];

        // -test: the last frame is read back into readbackBuffer, rows rowPitch bytes apart.
        private test: boolean = false;
        private readbackBuffer: NriBuffer | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSample) {
            for (let i = 0; i < NUM_VIEWS * CONSTANT_BUFFER_ENTRY_FLOATS; i++) {
                this.constants.push(0.0);
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

            // On a wrapper of its own: the callbacks Nri_RunSample runs may overwrite this.sample.
            let result = new NriSample(this.sample.handle).run(argc, argv, WINDOW_TITLE, TEST_FRAMES);
            if (result == 0 && this.test) {
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

            // Queued frames
            this.frames.init(device, this.queue, queuedFrameNum);
            for (let i = 0; i < queuedFrameNum; i++) {
                this.queuedFrames.push(new QueuedFrame());
            }

            // The binding layout: the view's constants (b0), the texture (t0), the sampler (s0), as
            // one descriptor set.
            const layoutDesc = NriPipelineLayoutDesc.create();
            layoutDesc.addRange(0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.Vertex, NriRangeFlags.None);
            layoutDesc.addRange(0, 0, 1, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            layoutDesc.addRange(0, 0, 1, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
            this.pipelineLayout = device.createPipelineLayoutFromDesc(layoutDesc);
            layoutDesc.destroy();
            const pipelineLayout = this.pipelineLayout;
            if (!pipelineLayout) {
                console.log("Cannot create the pipeline layout");
                return 0;
            }

            this.vertexBuffer = device.createUploadedBuffer(this.queue, Ref(g_Vertices[0]), 24 * VERTEX_SIZE, NriBufferUsage.VertexBuffer);
            this.indexBuffer = device.createUploadedBufferFromInts(this.queue, Ref(g_Indices[0]), INDEX_COUNT * 4, NriBufferUsage.IndexBuffer);
            if (!this.vertexBuffer || !this.indexBuffer) {
                console.log("Cannot create the cube's buffers");
                return 0;
            }
            const texture = device.loadImageTexture(this.queue, "media/nvidia-logo.png", 1);
            this.texture = texture;
            if (!texture) {
                console.log("Couldn't load the texture");
                return 0;
            }
            this.textureView = texture.createView(NriFormat.RGBA8_SRGB);
            if (!this.createDescriptorSets(device, pipelineLayout)) {
                console.log("Couldn't create the descriptor sets");
                return 0;
            }

            // The pipeline: vertex_buffer.hlsl's shaders, as compiled for the Donut example; the
            // positions from slot 0, the texture coordinates from slot 1; back faces culled (NVRHI's
            // default raster state).
            const folder = graphicsAPI == NriGraphicsAPI.D3D11 ? "dxbc" : graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv";
            const shaders = `shaders/vertex_buffer/${folder}/vertex_buffer`;
            const desc = NriPipelineDesc.create();
            let loaded = desc.addShader(NriShaderStage.Vertex, `${shaders}_main_vs.bin`, "main_vs") != 0;
            if (loaded) {
                loaded = desc.addShader(NriShaderStage.Pixel, `${shaders}_main_ps.bin`, "main_ps") != 0;
            }
            desc.addVertexAttributeFromStream("POSITION", NriFormat.RGB32_SFLOAT, 0, 0);
            desc.addVertexAttributeFromStream("UV", NriFormat.RG32_SFLOAT, 0, 1);
            desc.setCullMode(NriCullMode.Back);
            desc.setColor(viewFormat, NriColorWrite.RGBA);
            if (loaded) {
                this.pipeline = device.createPipelineFromDesc(pipelineLayout, desc);
            }
            desc.destroy();
            if (!this.pipeline) {
                console.log("Cannot load the vertex buffer shaders");
                return 0;
            }

            if (this.test) {
                const alignment = device.getUploadBufferTextureRowAlignment();
                this.rowPitch = Math.floor((this.width * 4 + alignment - 1) / alignment) * alignment;
                this.readbackBuffer = device.createReadbackBuffer(this.rowPitch * this.height);
                this.readbackFormat = format;
            }
            return 1;
        }

        // A descriptor set per view per frame in flight: the view's slice of the frame's part of the
        // constant buffer, and the texture and the sampler, the same for all views (Donut's
        // anisotropic wrap sampler: 16 times).
        createDescriptorSets(device: NriDevice, pipelineLayout: NriPipelineLayout) {
            const queuedFrameNum = this.queuedFrames.length;
            const sampler = device.createSampler(NriFilter.Linear, NriAddressMode.Repeat, 16);
            this.sampler = sampler;
            const constantBuffer = device.createHostBuffer(queuedFrameNum * FRAME_CONSTANTS_SIZE, NriBufferUsage.ConstantBuffer);
            this.constantBuffer = constantBuffer;
            const setNum = queuedFrameNum * NUM_VIEWS;
            const descriptorPool = device.createDescriptorPool(setNum, setNum, setNum, setNum, 0, 0);
            this.descriptorPool = descriptorPool;
            const textureView = this.textureView;
            if (!sampler || !constantBuffer || !descriptorPool || !textureView) {
                return false;
            }
            for (let f = 0; f < queuedFrameNum; f++) {
                const queuedFrame = this.queuedFrames[f];
                for (let viewIndex = 0; viewIndex < NUM_VIEWS; viewIndex++) {
                    const constantView = constantBuffer.createConstantView(
                        f * FRAME_CONSTANTS_SIZE + viewIndex * CONSTANT_BUFFER_ENTRY_SIZE, CONSTANT_BUFFER_ENTRY_SIZE);
                    const descriptorSet = descriptorPool.allocateDescriptorSet(pipelineLayout, 0, 0);
                    if (!constantView || !descriptorSet) {
                        return false;
                    }
                    descriptorSet.updateDescriptor(0, 0, constantView);
                    descriptorSet.updateDescriptor(1, 0, textureView);
                    descriptorSet.updateDescriptor(2, 0, sampler);
                    queuedFrame.constantViews.push(constantView);
                    queuedFrame.descriptorSets.push(descriptorSet);
                }
            }
            return true;
        }

        // Waits for the frame that last used this frame's command allocator (and its constants).
        latencySleep(frameIndex: int) {
            this.frames.wait(frameIndex);
        }

        // Animate, and the constant buffer slices for the views of the model, into this frame's part.
        updateConstants(frameOffset: int, constantBuffer: NriBuffer) {
            // In test mode 1/60 second a frame, as Donut's test mode.
            this.rotation += (this.test ? 1.0 / 60.0 : this.sample.getFrameTime()) * 1.1;
            for (let viewIndex = 0; viewIndex < NUM_VIEWS; viewIndex++) {
                const viewMatrix = mul(mul(
                    rotation(g_RotationAxes[viewIndex * 3], g_RotationAxes[viewIndex * 3 + 1], g_RotationAxes[viewIndex * 3 + 2], this.rotation),
                    yawPitchRoll(0.0, radiansF32(-30.0), 0.0)),
                    translation(0.0, 0.0, 2.0));
                const projMatrix = perspProjD3DStyle(radiansF32(60.0), this.width / this.height, 0.1, 10.0);
                const viewProjMatrix = mul(viewMatrix, projMatrix);
                for (let i = 0; i < 16; i++) {
                    this.constants[viewIndex * CONSTANT_BUFFER_ENTRY_FLOATS + i] = viewProjMatrix[i];
                }
            }
            constantBuffer.write(frameOffset, Ref(this.constants[0]), FRAME_CONSTANTS_SIZE);
        }

        // The model in each view: the view's descriptor set, the vertex buffer bound to its two slots
        // (in reverse order, as the Donut sample tests NVRHI's binding slots), its viewport.
        recordViews(commandBuffer: NriCommandBuffer, queuedFrame: QueuedFrame) {
            const pipelineLayout = this.pipelineLayout;
            const pipeline = this.pipeline;
            const vertexBuffer = this.vertexBuffer;
            const indexBuffer = this.indexBuffer;
            const descriptorPool = this.descriptorPool;
            if (!pipelineLayout || !pipeline || !vertexBuffer) {
                return;
            }
            if (!indexBuffer || !descriptorPool) {
                return;
            }
            commandBuffer.setScissor(0, 0, this.width, this.height);
            commandBuffer.setDescriptorPool(descriptorPool);
            commandBuffer.setPipelineLayout(pipelineLayout);
            commandBuffer.setPipeline(pipeline);
            for (let viewIndex = 0; viewIndex < NUM_VIEWS; viewIndex++) {
                commandBuffer.setDescriptorSet(0, queuedFrame.descriptorSets[viewIndex]);
                commandBuffer.setIndexBuffer(indexBuffer, 0, NriIndexType.UInt32);
                commandBuffer.setVertexBuffer(1, vertexBuffer, UV_OFFSET, VERTEX_SIZE);
                commandBuffer.setVertexBuffer(0, vertexBuffer, 0, VERTEX_SIZE);

                // Construct the viewport so that all viewports form a grid.
                const viewWidth = this.width * 0.5;
                const viewHeight = this.height * 0.5;
                const left = viewWidth * (viewIndex % 2);
                const top = viewHeight * Math.floor(viewIndex / 2);
                commandBuffer.setViewport(left, top, viewWidth, viewHeight);

                commandBuffer.drawIndexed(INDEX_COUNT, 1, 0, 0, 0);
            }
        }

        // The swap chain's size and formats (its views sRGB, as Donut's back buffers).
        sizeToSwapChain() {
            this.width = this.swapChain.width();
            this.height = this.swapChain.height();
            this.swapChainFormat = this.swapChain.format();
            this.swapChainViewFormat = this.swapChain.viewFormat();
        }

        // The window was resized (NriSample.useResizableWindow): the swap chain made
        // again at its size, once the GPU is done with the old ones.
        resizeIfNeeded() {
            const device = this.device;
            if (!device) {
                return;
            }
            if (!this.swapChain.resized()) {
                return;
            }
            this.swapChain.recreate();
            this.sizeToSwapChain();
        }

        renderFrame(frameIndex: int) {
            this.resizeIfNeeded();
            const queuedFrameIndex = frameIndex % this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            const constantBuffer = this.constantBuffer;
            if (constantBuffer) {
                this.updateConstants(queuedFrameIndex * FRAME_CONSTANTS_SIZE, constantBuffer);
            }

            // Acquire a swap chain texture
            const index = this.swapChain.acquire(frameIndex);
            if (index >= 0) {
                const texture = this.swapChain.texture(index);
                const commandBuffer = this.frames.commandBuffer(frameIndex);

                // Record
                commandBuffer.begin();
                commandBuffer.textureBarrier(texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                commandBuffer.beginRendering(this.swapChain.colorAttachment(index));
                commandBuffer.clearColor(0.0, 0.0, 0.0, 0.0);
                this.recordViews(commandBuffer, queuedFrame);
                commandBuffer.endRendering();

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
                    for (const constantView of queuedFrame.constantViews) {
                        constantView.destroy();
                    }
                }
                const descriptorPool = this.descriptorPool;
                if (descriptorPool) {
                    descriptorPool.destroy();
                }
                const pipeline = this.pipeline;
                if (pipeline) {
                    pipeline.destroy();
                }
                const pipelineLayout = this.pipelineLayout;
                if (pipelineLayout) {
                    pipelineLayout.destroy();
                }
                const sampler = this.sampler;
                if (sampler) {
                    sampler.destroy();
                }
                const textureView = this.textureView;
                if (textureView) {
                    textureView.destroy();
                }
                const texture = this.texture;
                if (texture) {
                    texture.destroy();
                }
                const constantBuffer = this.constantBuffer;
                if (constantBuffer) {
                    constantBuffer.destroy();
                }
                const vertexBuffer = this.vertexBuffer;
                if (vertexBuffer) {
                    vertexBuffer.destroy();
                }
                const indexBuffer = this.indexBuffer;
                if (indexBuffer) {
                    indexBuffer.destroy();
                }
                const readbackBuffer = this.readbackBuffer;
                if (readbackBuffer) {
                    readbackBuffer.destroy();
                }
                this.frames.destroy();
                this.swapChain.destroy();
                device.destroy();
            }
            this.sample.destroy();
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = NriSample.create();
        sample.useResizableWindow();
        const vertexBuffer = new VertexBuffer(sample);
        return vertexBuffer.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return VertexBufferNri.main(argc, argv);
}
