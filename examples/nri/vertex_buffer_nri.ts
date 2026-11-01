/// <reference path="../../core/nri/nri_interop.d.ts" />
import { perspProjD3DStyle, radiansF32, translation } from "../../core/matrix";

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

    // What a frame in flight records into, and the descriptor sets of its part of the constant
    // buffer (one per view: its constants, the texture, the sampler).
    class QueuedFrame {
        descriptorSets: NriDescriptorSetHandle[] = [];
        constantViews: NriDescriptorHandle[] = [];

        constructor(public commandAllocator: NriCommandAllocatorHandle, public commandBuffer: NriCommandBufferHandle) {
        }
    }

    // A swap chain texture, its view and the semaphores of its acquire and release.
    class SwapChainTexture {
        constructor(public texture: NriTextureHandle, public colorAttachment: NriDescriptorHandle,
            public acquireSemaphore: NriFenceHandle, public releaseSemaphore: NriFenceHandle) {
        }
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
        private device: NriDeviceHandle | null = null;
        private queue: NriQueueHandle;
        private frameFence: NriFenceHandle;
        private swapChain: NriSwapChainHandle;
        private swapChainTextures: SwapChainTexture[] = [];
        private queuedFrames: QueuedFrame[] = [];
        private pipelineLayout: NriPipelineLayoutHandle | null = null;
        private pipeline: NriPipelineHandle | null = null;
        private vertexBuffer: NriBufferHandle | null = null;
        private indexBuffer: NriBufferHandle | null = null;
        private texture: NriTextureHandle | null = null;
        private textureView: NriDescriptorHandle | null = null;
        private sampler: NriDescriptorHandle | null = null;
        private constantBuffer: NriBufferHandle | null = null;
        private descriptorPool: NriDescriptorPoolHandle | null = null;
        private width: int = 0;
        private height: int = 0;

        private rotation: number = 0.0;
        // A frame's constant buffer contents, NUM_VIEWS entries of CONSTANT_BUFFER_ENTRY_FLOATS floats.
        private constants: f32[] = [];

        // -test: the last frame is read back into readbackBuffer, rows rowPitch bytes apart.
        private test: boolean = false;
        private readbackBuffer: NriBufferHandle | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSampleHandle) {
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
            Nri_SetInitializeCallback(this.sample, initialize);
            Nri_SetLatencySleepCallback(this.sample, latencySleep);
            Nri_SetRenderFrameCallback(this.sample, renderFrame);

            let result = Nri_RunSample(this.sample, argc, argv, WINDOW_TITLE, TEST_FRAMES);
            if (result == 0 && this.test) {
                const failure = checkFrame(this.readBack(), this.width, this.height);
                console.log(failure == "" ? "Test PASSED" : `Test FAILED: ${failure}`);
                result = failure == "" ? 0 : 1;
            }
            this.destroy();
            return result;
        }

        initialize(graphicsAPI: NriGraphicsAPI): int {
            const device = Nri_CreateDevice(this.sample, graphicsAPI);
            if (!device) {
                console.log("Cannot initialize a graphics device with the requested parameters");
                return 0;
            }
            this.device = device;
            console.log(`Renderer: ${Nri_GetGraphicsAPIString(graphicsAPI)} (${Nri_GetAdapterName(device)})`);

            this.queue = Nri_GetGraphicsQueue(device);
            this.frameFence = Nri_CreateFence(device, 0);
            this.width = Nri_GetOutputWidth(this.sample);
            this.height = Nri_GetOutputHeight(this.sample);
            this.test = Nri_IsTest(this.sample) != 0;

            // Swap chain: rendered through sRGB views, as into Donut's sRGB back buffers.
            const queuedFrameNum = Nri_GetQueuedFrameNum(this.sample);
            this.swapChain = Nri_CreateSwapChain(this.sample, device, this.queue, queuedFrameNum + 1);
            const textureNum = Nri_GetSwapChainTextureNum(this.swapChain);
            const format = Nri_GetTextureFormat(Nri_GetSwapChainTexture(this.swapChain, 0));
            const viewFormat = Nri_GetSrgbFormat(format);
            for (let i = 0; i < textureNum; i++) {
                const texture = Nri_GetSwapChainTexture(this.swapChain, i);
                this.swapChainTextures.push(new SwapChainTexture(texture, Nri_CreateColorAttachmentView(texture, viewFormat),
                    Nri_CreateSwapChainSemaphore(device), Nri_CreateSwapChainSemaphore(device)));
            }

            // Queued frames
            for (let i = 0; i < queuedFrameNum; i++) {
                const commandAllocator = Nri_CreateCommandAllocator(this.queue);
                this.queuedFrames.push(new QueuedFrame(commandAllocator, Nri_CreateCommandBuffer(commandAllocator)));
            }

            // The binding layout: the view's constants (b0), the texture (t0), the sampler (s0), as
            // one descriptor set.
            const layoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.Vertex, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 0, 1, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 0, 1, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
            this.pipelineLayout = Nri_CreatePipelineLayoutFromDesc(device, layoutDesc);
            Nri_DestroyPipelineLayoutDesc(layoutDesc);
            const pipelineLayout = this.pipelineLayout;
            if (!pipelineLayout) {
                console.log("Cannot create the pipeline layout");
                return 0;
            }

            this.vertexBuffer = Nri_CreateUploadedBuffer(device, this.queue, Ref(g_Vertices[0]), 24 * VERTEX_SIZE, NriBufferUsage.VertexBuffer);
            this.indexBuffer = Nri_CreateUploadedBufferFromInts(device, this.queue, Ref(g_Indices[0]), INDEX_COUNT * 4, NriBufferUsage.IndexBuffer);
            if (!this.vertexBuffer || !this.indexBuffer) {
                console.log("Cannot create the cube's buffers");
                return 0;
            }
            const texture = Nri_LoadImageTexture(device, this.queue, "media/nvidia-logo.png", 1);
            this.texture = texture;
            if (!texture) {
                console.log("Couldn't load the texture");
                return 0;
            }
            this.textureView = Nri_CreateTextureView(texture, NriFormat.RGBA8_SRGB);
            if (!this.createDescriptorSets(device, pipelineLayout)) {
                console.log("Couldn't create the descriptor sets");
                return 0;
            }

            // The pipeline: vertex_buffer.hlsl's shaders, as compiled for the Donut example; the
            // positions from slot 0, the texture coordinates from slot 1; back faces culled (NVRHI's
            // default raster state).
            const folder = graphicsAPI == NriGraphicsAPI.D3D11 ? "dxbc" : graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv";
            const shaders = `shaders/vertex_buffer/${folder}/vertex_buffer`;
            const desc = Nri_CreatePipelineDesc();
            let loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Vertex, `${shaders}_main_vs.bin`, "main_vs") != 0;
            if (loaded) {
                loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Pixel, `${shaders}_main_ps.bin`, "main_ps") != 0;
            }
            Nri_PipelineDescAddVertexAttributeFromStream(desc, "POSITION", NriFormat.RGB32_SFLOAT, 0, 0);
            Nri_PipelineDescAddVertexAttributeFromStream(desc, "UV", NriFormat.RG32_SFLOAT, 0, 1);
            Nri_PipelineDescSetCullMode(desc, NriCullMode.Back);
            Nri_PipelineDescSetColor(desc, viewFormat, NriColorWrite.RGBA);
            if (loaded) {
                this.pipeline = Nri_CreatePipelineFromDesc(device, pipelineLayout, desc);
            }
            Nri_DestroyPipelineDesc(desc);
            if (!this.pipeline) {
                console.log("Cannot load the vertex buffer shaders");
                return 0;
            }

            if (this.test) {
                const alignment = Nri_GetUploadBufferTextureRowAlignment(device);
                this.rowPitch = Math.floor((this.width * 4 + alignment - 1) / alignment) * alignment;
                this.readbackBuffer = Nri_CreateReadbackBuffer(device, this.rowPitch * this.height);
                this.readbackFormat = format;
            }
            return 1;
        }

        // A descriptor set per view per frame in flight: the view's slice of the frame's part of the
        // constant buffer, and the texture and the sampler, the same for all views (Donut's
        // anisotropic wrap sampler: 16 times).
        createDescriptorSets(device: NriDeviceHandle, pipelineLayout: NriPipelineLayoutHandle) {
            const queuedFrameNum = this.queuedFrames.length;
            const sampler = Nri_CreateSampler(device, NriFilter.Linear, NriAddressMode.Repeat, 16);
            this.sampler = sampler;
            const constantBuffer = Nri_CreateHostBuffer(device, queuedFrameNum * FRAME_CONSTANTS_SIZE, NriBufferUsage.ConstantBuffer);
            this.constantBuffer = constantBuffer;
            const setNum = queuedFrameNum * NUM_VIEWS;
            const descriptorPool = Nri_CreateDescriptorPool(device, setNum, setNum, setNum, setNum, 0);
            this.descriptorPool = descriptorPool;
            const textureView = this.textureView;
            if (!sampler || !constantBuffer || !descriptorPool || !textureView) {
                return false;
            }
            for (let f = 0; f < queuedFrameNum; f++) {
                const queuedFrame = this.queuedFrames[f];
                for (let viewIndex = 0; viewIndex < NUM_VIEWS; viewIndex++) {
                    const constantView = Nri_CreateConstantBufferView(constantBuffer,
                        f * FRAME_CONSTANTS_SIZE + viewIndex * CONSTANT_BUFFER_ENTRY_SIZE, CONSTANT_BUFFER_ENTRY_SIZE);
                    const descriptorSet = Nri_AllocateDescriptorSet(descriptorPool, pipelineLayout, 0, 0);
                    if (!constantView || !descriptorSet) {
                        return false;
                    }
                    Nri_UpdateDescriptor(descriptorSet, 0, 0, constantView);
                    Nri_UpdateDescriptor(descriptorSet, 1, 0, textureView);
                    Nri_UpdateDescriptor(descriptorSet, 2, 0, sampler);
                    queuedFrame.constantViews.push(constantView);
                    queuedFrame.descriptorSets.push(descriptorSet);
                }
            }
            return true;
        }

        // Waits for the frame that last used this frame's command allocator (and its constants).
        latencySleep(frameIndex: int) {
            const queuedFrameNum = this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[frameIndex % queuedFrameNum];
            Nri_Wait(this.frameFence, frameIndex >= queuedFrameNum ? 1 + frameIndex - queuedFrameNum : 0);
            Nri_ResetCommandAllocator(queuedFrame.commandAllocator);
        }

        // Animate, and the constant buffer slices for the views of the model, into this frame's part.
        updateConstants(frameOffset: int, constantBuffer: NriBufferHandle) {
            // In test mode 1/60 second a frame, as Donut's test mode.
            this.rotation += (this.test ? 1.0 / 60.0 : Nri_GetFrameTime(this.sample)) * 1.1;
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
            Nri_WriteBuffer(constantBuffer, frameOffset, Ref(this.constants[0]), FRAME_CONSTANTS_SIZE);
        }

        // The model in each view: the view's descriptor set, the vertex buffer bound to its two slots
        // (in reverse order, as the Donut sample tests NVRHI's binding slots), its viewport.
        recordViews(commandBuffer: NriCommandBufferHandle, queuedFrame: QueuedFrame) {
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
            Nri_CmdSetScissor(commandBuffer, 0, 0, this.width, this.height);
            Nri_CmdSetDescriptorPool(commandBuffer, descriptorPool);
            Nri_CmdSetPipelineLayout(commandBuffer, pipelineLayout);
            Nri_CmdSetPipeline(commandBuffer, pipeline);
            for (let viewIndex = 0; viewIndex < NUM_VIEWS; viewIndex++) {
                Nri_CmdSetDescriptorSet(commandBuffer, 0, queuedFrame.descriptorSets[viewIndex]);
                Nri_CmdSetIndexBuffer(commandBuffer, indexBuffer, 0, NriIndexType.UInt32);
                Nri_CmdSetVertexBuffer(commandBuffer, 1, vertexBuffer, UV_OFFSET, VERTEX_SIZE);
                Nri_CmdSetVertexBuffer(commandBuffer, 0, vertexBuffer, 0, VERTEX_SIZE);

                // Construct the viewport so that all viewports form a grid.
                const viewWidth = this.width * 0.5;
                const viewHeight = this.height * 0.5;
                const left = viewWidth * (viewIndex % 2);
                const top = viewHeight * Math.floor(viewIndex / 2);
                Nri_CmdSetViewport(commandBuffer, left, top, viewWidth, viewHeight);

                Nri_CmdDrawIndexed(commandBuffer, INDEX_COUNT, 1, 0, 0, 0);
            }
        }

        renderFrame(frameIndex: int) {
            const queuedFrameIndex = frameIndex % this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            const constantBuffer = this.constantBuffer;
            if (constantBuffer) {
                this.updateConstants(queuedFrameIndex * FRAME_CONSTANTS_SIZE, constantBuffer);
            }

            // Acquire a swap chain texture
            const acquireSemaphore = this.swapChainTextures[frameIndex % this.swapChainTextures.length].acquireSemaphore;
            const index = Nri_AcquireNextTexture(this.swapChain, acquireSemaphore);
            if (index >= 0) {
                const swapChainTexture = this.swapChainTextures[index];
                const commandBuffer = queuedFrame.commandBuffer;

                // Record
                Nri_BeginCommandBuffer(commandBuffer);
                Nri_CmdTextureBarrier(commandBuffer, swapChainTexture.texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                Nri_CmdBeginRendering(commandBuffer, swapChainTexture.colorAttachment);
                Nri_CmdClearColor(commandBuffer, 0.0, 0.0, 0.0, 0.0);
                this.recordViews(commandBuffer, queuedFrame);
                Nri_CmdEndRendering(commandBuffer);

                // The test's last frame: read back
                let presentFrom = NriTextureState.ColorAttachment;
                const readbackBuffer = this.readbackBuffer;
                if (readbackBuffer) {
                    if (frameIndex == TEST_FRAMES - 1) {
                        Nri_CmdTextureBarrier(commandBuffer, swapChainTexture.texture, NriTextureState.ColorAttachment, NriTextureState.CopySource);
                        Nri_CmdReadbackTextureToBuffer(commandBuffer, readbackBuffer, this.rowPitch, swapChainTexture.texture, this.width, this.height);
                        presentFrom = NriTextureState.CopySource;
                    }
                }
                Nri_CmdTextureBarrier(commandBuffer, swapChainTexture.texture, presentFrom, NriTextureState.Present);
                Nri_EndCommandBuffer(commandBuffer);

                // Submit and present
                Nri_QueueSubmit(this.queue, commandBuffer, acquireSemaphore, swapChainTexture.releaseSemaphore);
                Nri_QueuePresent(this.swapChain, swapChainTexture.releaseSemaphore);
            }

            // Signaled after the present, as NRISamples do
            Nri_QueueSignal(this.queue, this.frameFence, 1 + frameIndex);
        }

        // The last frame's pixels (0xAABBGGRR), empty if it can't be read.
        readBack(): int[] {
            const device = this.device;
            const readbackBuffer = this.readbackBuffer;
            if (!device || !readbackBuffer) {
                return [];
            }
            Nri_DeviceWaitIdle(device);
            const pixels: int[] = [];
            for (let i = 0; i < this.width * this.height; i++) {
                pixels.push(0);
            }
            if (Nri_ReadBufferRGBA8(readbackBuffer, this.rowPitch, this.width, this.height, this.readbackFormat,
                Ref(pixels[0]), pixels.length) == 0) {
                return [];
            }
            return pixels;
        }

        destroy() {
            const device = this.device;
            if (device) {
                Nri_DeviceWaitIdle(device);
                for (const queuedFrame of this.queuedFrames) {
                    for (const constantView of queuedFrame.constantViews) {
                        Nri_DestroyDescriptor(constantView);
                    }
                    Nri_DestroyCommandBuffer(queuedFrame.commandBuffer);
                    Nri_DestroyCommandAllocator(queuedFrame.commandAllocator);
                }
                for (const swapChainTexture of this.swapChainTextures) {
                    Nri_DestroyFence(swapChainTexture.acquireSemaphore);
                    Nri_DestroyFence(swapChainTexture.releaseSemaphore);
                    Nri_DestroyDescriptor(swapChainTexture.colorAttachment);
                }
                const descriptorPool = this.descriptorPool;
                if (descriptorPool) {
                    Nri_DestroyDescriptorPool(descriptorPool);
                }
                const pipeline = this.pipeline;
                if (pipeline) {
                    Nri_DestroyPipeline(pipeline);
                }
                const pipelineLayout = this.pipelineLayout;
                if (pipelineLayout) {
                    Nri_DestroyPipelineLayout(pipelineLayout);
                }
                const sampler = this.sampler;
                if (sampler) {
                    Nri_DestroyDescriptor(sampler);
                }
                const textureView = this.textureView;
                if (textureView) {
                    Nri_DestroyDescriptor(textureView);
                }
                const texture = this.texture;
                if (texture) {
                    Nri_DestroyTexture(texture);
                }
                const constantBuffer = this.constantBuffer;
                if (constantBuffer) {
                    Nri_DestroyBuffer(constantBuffer);
                }
                const vertexBuffer = this.vertexBuffer;
                if (vertexBuffer) {
                    Nri_DestroyBuffer(vertexBuffer);
                }
                const indexBuffer = this.indexBuffer;
                if (indexBuffer) {
                    Nri_DestroyBuffer(indexBuffer);
                }
                const readbackBuffer = this.readbackBuffer;
                if (readbackBuffer) {
                    Nri_DestroyBuffer(readbackBuffer);
                }
                Nri_DestroyFence(this.frameFence);
                Nri_DestroySwapChain(this.swapChain);
                Nri_DestroyDevice(device);
            }
            Nri_DestroySample(this.sample);
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        const vertexBuffer = new VertexBuffer(Nri_CreateSample());
        return vertexBuffer.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return VertexBufferNri.main(argc, argv);
}
