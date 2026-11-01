/// <reference path="../../core/nri/nri_interop.d.ts" />
import { formatFixed } from "../../core/text_format";

namespace SimpleComputeNri {
    // simple_compute, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead of
    // Donut and NVRHI: the same compute shader (simple_compute.hlsl's), through the NRI calls
    // core/nri/nri_interop.d.ts binds, with NRIFramework's ImGui for the sample's HUD. The worker
    // thread is C++ (Nri_CreateAsyncComputeLoop), as Donut's: tslang code can't run on threads its
    // GC doesn't know about. The fractal is stretched over the window by 16bit_arithmetic.hlsl's
    // visualize shaders (a triangle over the screen sampling a texture), as Donut's blit does. This
    // example creates everything it runs, and does the rendering.

    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    const WINDOW_TITLE = "NRI Example: Simple Compute";

    // The sample's SegoeUI_18 sprite font's lines, 32 pixels apart (the text is in ImGui's default
    // font here).
    const LINE_SPACING = 32.0;

    // The fractal textures are 1920 x 1080 whatever the window's size, computed in groups of
    // 8 x 8 threads (fractal_cs in simple_compute.hlsl).
    const TEXTURE_WIDTH = 1920;
    const TEXTURE_HEIGHT = 1080;
    const NUM_SHADER_THREADS = 8;
    const FRACTAL_MAX_ITERATIONS = 300;
    // CB_FractalCS: MaxThreadIter and Window, two float4s.
    const PUSH_CONSTANTS_SIZE = 32;
    // The color maps: 8 x 1 R8G8B8A8_UNORM.
    const COLOR_MAP_SIZE = 8;
    // The async compute worker's textures: one shown, one computed.
    const NUM_ASYNC_TEXTURES = 2;
    // SmoothedFPS's default interval.
    const FPS_FRAME_INTERVAL = 100;

    // ATG::Colors::Background (#414141), stored as is in the UNORM back buffer as the sample's.
    const BACKGROUND = 0.254901975;

    // GLFW's key codes (Nri_IsKeyPressed's).
    const KEY_SPACE = 32;
    const KEY_A = 65;
    const KEY_D = 68;
    const KEY_S = 83;
    const KEY_W = 87;
    const KEY_PAGE_UP = 266;
    const KEY_PAGE_DOWN = 267;
    const KEY_HOME = 268;
    const KEY_LEFT_SHIFT = 340;
    const KEY_RIGHT_SHIFT = 344;

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // What a frame in flight records into.
    class QueuedFrame {
        constructor(public commandAllocator: NriCommandAllocatorHandle, public commandBuffer: NriCommandBufferHandle) {
        }
    }

    // A swap chain texture, its view and the semaphores of its acquire and release.
    class SwapChainTexture {
        constructor(public texture: NriTextureHandle, public colorAttachment: NriDescriptorHandle,
            public acquireSemaphore: NriFenceHandle, public releaseSemaphore: NriFenceHandle) {
        }
    }

    // A fractal texture: its views, and the draw's descriptor set that shows it.
    class FractalTexture {
        constructor(public texture: NriTextureHandle, public storageView: NriDescriptorHandle, public view: NriDescriptorHandle,
            public drawSet: NriDescriptorSetHandle) {
        }
    }

    // An R8G8B8A8_UNORM texel (the sample's 0xAABBGGRR values), opaque.
    function texel(r: int, g: int, b: int) {
        return r | (g << 8) | (b << 16) | (255 << 24);
    }

    // -test: checks the last frame, read back, as the Donut example does. The corners are the dark
    // red outside of the Mandelbrot set; its boundary's colored bands cover about 2% of the
    // 1280x720 frame (3% with the HUD's text, which the Donut example's check counts too). The set itself (its main cardioid at (860, 360)) is yellow, about 17% of the
    // frame, where the driver divides by an approximate reciprocal (NVIDIA's), or the outside's dark
    // red where it divides exactly (NVIDIA's D3D11 driver, lavapipe): see fractal_cs.
    function checkFrame(pixels: int[], width: int, height: int) {
        if (pixels.length == 0) {
            return "cannot read the back buffer";
        }
        const outside = 0x000040;
        const xs = [0, width - 1, 0, width - 1];
        const ys = [0, 0, height - 1, height - 1];
        for (let k = 0; k < 4; k++) {
            const p = pixels[ys[k] * width + xs[k]] & 0xFFFFFF;
            if (p != outside) {
                return `corner (${xs[k]}, ${ys[k]}) is ${p & 0xFF}, ${(p >> 8) & 0xFF}, ${(p >> 16) & 0xFF}, not 64, 0, 0`;
            }
        }
        let yellow = 0;
        let other = 0;
        for (let i = 0; i < width * height; i++) {
            const p = pixels[i] & 0xFFFFFF;
            const r = p & 0xFF;
            const g = (p >> 8) & 0xFF;
            const b = (p >> 16) & 0xFF;
            if (r >= 201 && g >= 201 && b <= 79) {
                yellow++;
            }
            if (p != outside) {
                other++;
            }
        }
        const total = width * height;
        const bandsPercent = 100.0 * (other - yellow) / total;
        console.log(`Boundary bands: ${bandsPercent}% (${other - yellow} of ${total} pixels)`);
        if (bandsPercent < 1.5 || bandsPercent > 5.0) {
            return `Boundary bands: ${bandsPercent}% of the pixels, not 1.5% to 5%`;
        }
        const yellowPercent = 100.0 * yellow / total;
        const cardioid = pixels[360 * width + 860] & 0xFFFFFF;
        if (cardioid == outside) {
            console.log(`Mandelbrot set in yellow (exact division): ${yellowPercent}% (${yellow} of ${total} pixels)`);
            return yellowPercent > 0.1 ? `Mandelbrot set in yellow (exact division): ${yellowPercent}% of the pixels, not 0% to 0.1%` : "";
        }
        if (cardioid != 0x00FFFF) {
            return "the main cardioid is neither yellow nor dark red at (860, 360)";
        }
        console.log(`Mandelbrot set: ${yellowPercent}% (${yellow} of ${total} pixels)`);
        if (yellowPercent < 10.0 || yellowPercent > 25.0) {
            return `Mandelbrot set: ${yellowPercent}% of the pixels, not 10% to 25%`;
        }
        return "";
    }

    // Port of SimpleComputePC12.cpp (as examples/simple_compute.ts ports it) to NRI: a compute
    // shader draws a Mandelbrot fractal into a texture, which is stretched over the window.
    // Synchronous compute dispatches it in the frame's command buffer (with the gradient color map);
    // asynchronous compute has a worker thread dispatch it on the compute queue, as fast as the
    // render thread hands back the texture it stops showing (with the rainbow color map). Space
    // switches between the two. As in the Donut example, the synchronous path has a texture of its
    // own, shown until the worker's first run after a switch to async compute.
    class SimpleCompute {
        private device: NriDeviceHandle | null = null;
        private queue: NriQueueHandle;
        private frameFence: NriFenceHandle;
        private swapChain: NriSwapChainHandle;
        private swapChainTextures: SwapChainTexture[] = [];
        private queuedFrames: QueuedFrame[] = [];
        private viewFormat: NriFormat = NriFormat.Unknown;
        private computeLayout: NriPipelineLayoutHandle | null = null;
        private computePipeline: NriPipelineHandle | null = null;
        private drawLayout: NriPipelineLayoutHandle | null = null;
        private drawPipeline: NriPipelineHandle | null = null;
        private gradient: NriTextureHandle | null = null;
        private rainbow: NriTextureHandle | null = null;
        private gradientView: NriDescriptorHandle | null = null;
        private rainbowView: NriDescriptorHandle | null = null;
        private pointSampler: NriDescriptorHandle | null = null;
        private linearSampler: NriDescriptorHandle | null = null;
        // The render thread's descriptor sets (the synchronous dispatch's, the draws'), and the
        // compute loop's (only its worker uses them).
        private descriptorPool: NriDescriptorPoolHandle | null = null;
        private asyncPool: NriDescriptorPoolHandle | null = null;
        private syncSet: NriDescriptorSetHandle | null = null;
        // The synchronous path's texture, then the worker's.
        private syncTexture: FractalTexture | null = null;
        private asyncTextures: FractalTexture[] = [];
        private computeLoop: NriAsyncComputeLoopHandle | null = null;
        // The synchronous texture is read by the draw (after its first dispatch).
        private syncDrawn: boolean = false;
        // The worker's texture held by the render thread (-1: none yet).
        private asyncCurrent: int = -1;
        private imgui: boolean = false;
        private width: int = 0;
        private height: int = 0;

        // CB_FractalCS: MaxThreadIter (texture width, height, max iterations, 0), Window (scale x,
        // y, center x, y).
        private constants: f32[] = [TEXTURE_WIDTH, TEXTURE_HEIGHT, FRACTAL_MAX_ITERATIONS, 0.0, 0.0, 0.0, 0.0, 0.0];
        hasAsyncCompute: boolean = false;
        usingAsyncCompute: boolean = false;
        // The worker's run count when async compute was last switched on.
        private runsAtResume: int = 0;
        private spaceWasDown: boolean = false;

        // SmoothedFPS: frames (runs) and their time since the last update.
        private renderFPS: number = 0.0;
        private renderFrames: int = 0;
        private renderTime: number = 0.0;
        private computeFPS: number = 0.0;
        private computeRuns: int = 0;
        private computeTime: number = 0.0;
        // The worker's run count when last looked at.
        private lastRunCount: int = 0;

        // -async: start with asynchronous compute; -window X Y CX CY: the fractal window; -noUI: no
        // HUD.
        startAsync: boolean = false;
        noUI: boolean = false;

        // -test: the last frame is read back into readbackBuffer, rows rowPitch bytes apart.
        private test: boolean = false;
        private readbackBuffer: NriBufferHandle | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSampleHandle) {
            this.resetWindow();
        }

        resetWindow() {
            this.constants[4] = 4.0;
            this.constants[5] = 2.25;
            this.constants[6] = -0.65;
            this.constants[7] = 0.0;
        }

        // The fractal window, for -window.
        setWindow(x: number, y: number, z: number, w: number) {
            this.constants[4] = x;
            this.constants[5] = y;
            this.constants[6] = z;
            this.constants[7] = w;
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
            // The worker thread stops first: then the GPU is done with everything.
            const computeLoop = this.computeLoop;
            if (computeLoop) {
                Nri_DestroyAsyncComputeLoop(computeLoop);
                this.computeLoop = null;
            }
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

            // Swap chain: rendered through UNORM views, as the sample's B8G8R8A8_UNORM back buffers.
            const queuedFrameNum = Nri_GetQueuedFrameNum(this.sample);
            this.swapChain = Nri_CreateSwapChain(this.sample, device, this.queue, queuedFrameNum + 1);
            const textureNum = Nri_GetSwapChainTextureNum(this.swapChain);
            const format = Nri_GetTextureFormat(Nri_GetSwapChainTexture(this.swapChain, 0));
            this.viewFormat = format;
            for (let i = 0; i < textureNum; i++) {
                const texture = Nri_GetSwapChainTexture(this.swapChain, i);
                this.swapChainTextures.push(new SwapChainTexture(texture, Nri_CreateColorAttachmentView(texture, format),
                    Nri_CreateSwapChainSemaphore(device), Nri_CreateSwapChainSemaphore(device)));
            }

            // Queued frames
            for (let i = 0; i < queuedFrameNum; i++) {
                const commandAllocator = Nri_CreateCommandAllocator(this.queue);
                this.queuedFrames.push(new QueuedFrame(commandAllocator, Nri_CreateCommandBuffer(commandAllocator)));
            }

            // The layouts: the compute shader's constants (push constants, b0), fractal (u0), color
            // map (t0) and sampler (s0); the draw's texture (t0) and sampler (s0).
            const computeLayoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRootConstants(computeLayoutDesc, 0, PUSH_CONSTANTS_SIZE, NriStage.Compute);
            Nri_PipelineLayoutDescAddRange(computeLayoutDesc, 0, 0, 1, NriDescriptorType.StorageTexture, NriStage.Compute, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(computeLayoutDesc, 0, 0, 1, NriDescriptorType.Texture, NriStage.Compute, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(computeLayoutDesc, 0, 0, 1, NriDescriptorType.Sampler, NriStage.Compute, NriRangeFlags.None);
            this.computeLayout = Nri_CreatePipelineLayoutFromDesc(device, computeLayoutDesc);
            Nri_DestroyPipelineLayoutDesc(computeLayoutDesc);
            const drawLayoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRange(drawLayoutDesc, 0, 0, 1, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(drawLayoutDesc, 0, 0, 1, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
            this.drawLayout = Nri_CreatePipelineLayoutFromDesc(device, drawLayoutDesc);
            Nri_DestroyPipelineLayoutDesc(drawLayoutDesc);
            const computeLayout = this.computeLayout;
            const drawLayout = this.drawLayout;
            if (!computeLayout || !drawLayout) {
                console.log("Cannot create the pipeline layouts");
                return 0;
            }

            // The pipelines: fractal_cs as compiled for the Donut example; the blit, a triangle over
            // the screen (16bit_arithmetic.hlsl's visualize shaders), no culling, no depth.
            const folder = graphicsAPI == NriGraphicsAPI.D3D11 ? "dxbc" : (graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv");
            const computePipeline = Nri_CreateComputePipeline(device, computeLayout,
                `shaders/simple_compute/${folder}/simple_compute_fractal_cs.bin`, "fractal_cs");
            this.computePipeline = computePipeline;
            const blit = `shaders/16bit_arithmetic/${folder}/16bit_arithmetic`;
            const desc = Nri_CreatePipelineDesc();
            let loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Vertex, `${blit}_visualize_vs.bin`, "visualize_vs") != 0;
            if (loaded) {
                loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Pixel, `${blit}_visualize_ps.bin`, "visualize_ps") != 0;
            }
            Nri_PipelineDescSetColor(desc, format, NriColorWrite.RGBA);
            if (loaded) {
                this.drawPipeline = Nri_CreatePipelineFromDesc(device, drawLayout, desc);
            }
            Nri_DestroyPipelineDesc(desc);
            if (!computePipeline || !this.drawPipeline) {
                console.log("Cannot load the simple compute shaders");
                return 0;
            }

            // The color maps, read by compute shaders on either queue; MinMagMipPointUVWClamp for
            // them, a linear clamped sampler for the blit.
            const gradientTexels: int[] = [
                texel(0x40, 0x00, 0x00), texel(0x80, 0x00, 0x00), texel(0xC0, 0x00, 0x00), texel(0xFF, 0x00, 0x00),
                texel(0xFF, 0x40, 0x00), texel(0xFF, 0x80, 0x00), texel(0xFF, 0xC0, 0x00), texel(0xFF, 0xFF, 0x00),
            ];
            const rainbowTexels: int[] = [
                texel(0xFF, 0x00, 0x00), texel(0xFF, 0x80, 0x00), texel(0xFF, 0xFF, 0x00), texel(0x00, 0xFF, 0x00),
                texel(0x00, 0xFF, 0xFF), texel(0x00, 0x00, 0xFF), texel(0x00, 0x00, 0x80), texel(0xFF, 0x00, 0xFF),
            ];
            const gradient = Nri_CreateUploadedComputeTexture(device, this.queue, COLOR_MAP_SIZE, 1, NriFormat.RGBA8_UNORM,
                Ref(gradientTexels[0]), COLOR_MAP_SIZE * 4);
            const rainbow = Nri_CreateUploadedComputeTexture(device, this.queue, COLOR_MAP_SIZE, 1, NriFormat.RGBA8_UNORM,
                Ref(rainbowTexels[0]), COLOR_MAP_SIZE * 4);
            this.gradient = gradient;
            this.rainbow = rainbow;
            const pointSampler = Nri_CreateSampler(device, NriFilter.Nearest, NriAddressMode.ClampToEdge, 1);
            const linearSampler = Nri_CreateSampler(device, NriFilter.Linear, NriAddressMode.ClampToEdge, 1);
            this.pointSampler = pointSampler;
            this.linearSampler = linearSampler;
            const descriptorPool = Nri_CreateDescriptorPool(device, 1 + 1 + NUM_ASYNC_TEXTURES, 2 + NUM_ASYNC_TEXTURES, 0,
                2 + NUM_ASYNC_TEXTURES, 1, 0);
            const asyncPool = Nri_CreateDescriptorPool(device, NUM_ASYNC_TEXTURES, NUM_ASYNC_TEXTURES, 0, NUM_ASYNC_TEXTURES,
                NUM_ASYNC_TEXTURES, 0);
            this.descriptorPool = descriptorPool;
            this.asyncPool = asyncPool;
            if (!gradient || !rainbow || !pointSampler || !linearSampler || !descriptorPool || !asyncPool) {
                console.log("Cannot create the color maps and descriptors");
                return 0;
            }
            const gradientView = Nri_CreateTextureView(gradient, NriFormat.RGBA8_UNORM);
            const rainbowView = Nri_CreateTextureView(rainbow, NriFormat.RGBA8_UNORM);
            this.gradientView = gradientView;
            this.rainbowView = rainbowView;

            // The synchronous path's texture and set.
            const syncTexture = this.createFractalTexture(device, descriptorPool, drawLayout, linearSampler);
            const syncSet = Nri_AllocateDescriptorSet(descriptorPool, computeLayout, 0, 0);
            this.syncTexture = syncTexture;
            this.syncSet = syncSet;
            if (!syncTexture || !syncSet) {
                console.log("Cannot create the fractal texture");
                return 0;
            }
            Nri_UpdateDescriptor(syncSet, 0, 0, syncTexture.storageView);
            Nri_UpdateDescriptor(syncSet, 1, 0, gradientView);
            Nri_UpdateDescriptor(syncSet, 2, 0, pointSampler);

            // The worker, where there's a compute queue. On D3D11 with the HUD, NRI's command buffer
            // emulation (which NRIFramework's ImGui needs there: Nri_UseImgui) breaks the compute
            // queue: synchronous compute only then.
            const computeQueue = Nri_GetComputeQueue(device);
            if (!computeQueue) {
                console.log("The graphics device has no compute queue: synchronous compute only");
            } else if (graphicsAPI == NriGraphicsAPI.D3D11 && !this.noUI) {
                console.log("D3D11 with the HUD (command buffer emulation): synchronous compute only (-noUI for both)");
            } else if (!this.startComputeLoop(device, computeQueue, computeLayout, computePipeline, asyncPool, drawLayout, linearSampler,
                pointSampler, rainbowView)) {
                return 0;
            }
            this.setUsingAsyncCompute(this.startAsync);

            // The sample's HUD.
            if (!this.noUI) {
                if (Nri_InitImgui(this.sample, device) == 0) {
                    console.log("Cannot initialize the user interface");
                    return 0;
                }
                this.imgui = true;
            }

            if (this.test) {
                const alignment = Nri_GetUploadBufferTextureRowAlignment(device);
                this.rowPitch = Math.floor((this.width * 4 + alignment - 1) / alignment) * alignment;
                this.readbackBuffer = Nri_CreateReadbackBuffer(device, this.rowPitch * this.height);
                this.readbackFormat = format;
            }
            return 1;
        }

        // A fractal texture (in NriTextureState.Storage) and the draw's set showing it; null on
        // failure.
        createFractalTexture(device: NriDeviceHandle, descriptorPool: NriDescriptorPoolHandle, drawLayout: NriPipelineLayoutHandle,
            sampler: NriDescriptorHandle): FractalTexture | null {
            const texture = Nri_CreateStorageTexture(device, this.queue, TEXTURE_WIDTH, TEXTURE_HEIGHT, NriFormat.RGBA8_UNORM);
            if (!texture) {
                return null;
            }
            const drawSet = Nri_AllocateDescriptorSet(descriptorPool, drawLayout, 0, 0);
            if (!drawSet) {
                Nri_DestroyTexture(texture);
                return null;
            }
            const view = Nri_CreateTextureView(texture, NriFormat.RGBA8_UNORM);
            Nri_UpdateDescriptor(drawSet, 0, 0, view);
            Nri_UpdateDescriptor(drawSet, 1, 0, sampler);
            return new FractalTexture(texture, Nri_CreateStorageTextureView(texture, NriFormat.RGBA8_UNORM), view, drawSet);
        }

        // The worker: its textures (with the rainbow color map), paused until async compute is on.
        startComputeLoop(device: NriDeviceHandle, computeQueue: NriQueueHandle, computeLayout: NriPipelineLayoutHandle,
            computePipeline: NriPipelineHandle, asyncPool: NriDescriptorPoolHandle, drawLayout: NriPipelineLayoutHandle,
            linearSampler: NriDescriptorHandle, pointSampler: NriDescriptorHandle, rainbowView: NriDescriptorHandle): boolean {
            const descriptorPool = this.descriptorPool;
            if (!descriptorPool) {
                return false;
            }
            const computeLoop = Nri_CreateAsyncComputeLoop(computeQueue, device, this.frameFence, computeLayout, computePipeline, asyncPool,
                TEXTURE_WIDTH / NUM_SHADER_THREADS, TEXTURE_HEIGHT / NUM_SHADER_THREADS, 0);
            this.computeLoop = computeLoop;
            if (!computeLoop) {
                console.log("Cannot create the compute loop");
                return false;
            }
            for (let i = 0; i < NUM_ASYNC_TEXTURES; i++) {
                const texture = this.createFractalTexture(device, descriptorPool, drawLayout, linearSampler);
                const computeSet = Nri_AllocateDescriptorSet(asyncPool, computeLayout, 0, 0);
                if (!texture || !computeSet) {
                    console.log("Cannot create the async fractal textures");
                    return false;
                }
                Nri_UpdateDescriptor(computeSet, 0, 0, texture.storageView);
                Nri_UpdateDescriptor(computeSet, 1, 0, rainbowView);
                Nri_UpdateDescriptor(computeSet, 2, 0, pointSampler);
                this.asyncTextures.push(texture);
                Nri_AddAsyncComputeTexture(computeLoop, computeSet);
            }
            Nri_SetAsyncComputeConstants(computeLoop, Ref(this.constants[0]), PUSH_CONSTANTS_SIZE);
            Nri_SetAsyncComputePaused(computeLoop, 1);
            Nri_StartAsyncComputeLoop(computeLoop);
            this.hasAsyncCompute = true;
            return true;
        }

        setUsingAsyncCompute(value: boolean) {
            const computeLoop = this.computeLoop;
            if (!computeLoop) {
                return;
            }
            this.usingAsyncCompute = value;
            if (value) {
                this.runsAtResume = Nri_GetAsyncComputeRunCount(computeLoop);
                this.lastRunCount = this.runsAtResume;
            }
            Nri_SetAsyncComputePaused(computeLoop, value ? 0 : 1);
        }

        // Waits for the frame that last used this frame's command allocator.
        latencySleep(frameIndex: int) {
            const queuedFrameNum = this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[frameIndex % queuedFrameNum];
            Nri_Wait(this.frameFence, frameIndex >= queuedFrameNum ? 1 + frameIndex - queuedFrameNum : 0);
            Nri_ResetCommandAllocator(queuedFrame.commandAllocator);
        }

        pressed(key: int): boolean {
            return Nri_IsKeyPressed(this.sample, key) != 0;
        }

        // Sample::Update: Space and Home, the smoothed rates, then the held keys pan and zoom the
        // window (none of them in the test, which takes 1/60 second a frame, as Donut's test mode).
        update() {
            const elapsedTime = Math.fround(this.test ? 1.0 / 60.0 : Nri_GetFrameTime(this.sample));
            if (!this.test) {
                const spaceDown = this.pressed(KEY_SPACE);
                if (spaceDown && !this.spaceWasDown) {
                    this.setUsingAsyncCompute(!this.usingAsyncCompute);
                }
                this.spaceWasDown = spaceDown;
                if (this.pressed(KEY_HOME)) {
                    this.resetWindow();
                }
            }

            this.renderTime += elapsedTime;
            this.renderFrames++;
            if (this.renderFrames >= FPS_FRAME_INTERVAL) {
                this.renderFPS = FPS_FRAME_INTERVAL / this.renderTime;
                this.renderTime = 0.0;
                this.renderFrames = 0;
            }

            // The worker's rate: its runs over the time async compute was on.
            const computeLoop = this.computeLoop;
            if (computeLoop) {
                if (this.usingAsyncCompute) {
                    const runCount = Nri_GetAsyncComputeRunCount(computeLoop);
                    this.computeRuns += runCount - this.lastRunCount;
                    this.lastRunCount = runCount;
                    this.computeTime += elapsedTime;
                    if (this.computeRuns >= FPS_FRAME_INTERVAL) {
                        this.computeFPS = this.computeRuns / this.computeTime;
                        this.computeTime = 0.0;
                        this.computeRuns = 0;
                    }
                }
            }

            if (this.test) {
                return;
            }
            const panUp = this.pressed(KEY_W);
            const panDown = this.pressed(KEY_S);
            const panLeft = this.pressed(KEY_A);
            const panRight = this.pressed(KEY_D);
            const zoomIn = this.pressed(KEY_PAGE_UP);
            const zoomOut = this.pressed(KEY_PAGE_DOWN);
            if (panUp || panDown || panLeft || panRight || zoomIn || zoomOut) {
                let scaleSpeed = 1.0;
                if (this.pressed(KEY_LEFT_SHIFT) || this.pressed(KEY_RIGHT_SHIFT)) {
                    scaleSpeed = 4.0;
                }
                let zoom = 0.0;
                if (zoomOut) {
                    zoom = 1.0;
                } else if (zoomIn) {
                    zoom = -1.0;
                }
                let x = 0.0;
                if (panRight) {
                    x = 1.0;
                } else if (panLeft) {
                    x = -1.0;
                }
                let y = 0.0;
                if (panUp) {
                    y = 1.0;
                } else if (panDown) {
                    y = -1.0;
                }

                const windowScale = Math.fround(1.0 + Math.fround(Math.fround(zoom * scaleSpeed) * elapsedTime));
                const c = this.constants;
                c[4] = Math.fround(c[4] * windowScale);
                c[5] = Math.fround(c[5] * windowScale);
                c[6] = Math.fround(c[6] + Math.fround(Math.fround(Math.fround(c[4] * x) * elapsedTime) * 0.5));
                c[7] = Math.fround(c[7] + Math.fround(Math.fround(Math.fround(c[5] * y) * elapsedTime) * 0.5));
            }
        }

        // The sample's HUD (SpriteFont text in the title-safe area): the rates at the top, the
        // controls at the bottom.
        buildUI() {
            // SimpleMath::Viewport::ComputeTitleSafeArea
            const safeW = Math.fround((this.width + 19.0) / 20.0);
            const safeH = Math.fround((this.height + 19.0) / 20.0);
            const left: int = Math.floor(safeW);
            const top: int = Math.floor(safeH);
            const bottom: int = Math.floor(this.height - safeH + 0.5);

            Nri_ImguiNewFrame(this.sample);
            Nri_ImguiDrawText(left, top, `Simple Compute Context ${formatFixed(this.renderFPS, 2)} fps`, 1.0, 1.0, 1.0, 1.0, 0);
            if (this.usingAsyncCompute) {
                Nri_ImguiDrawText(left, top + LINE_SPACING, `Asynchronous compute ${formatFixed(this.computeFPS, 2)} fps`,
                    1.0, 1.0, 1.0, 1.0, 0);
            } else {
                Nri_ImguiDrawText(left, top + LINE_SPACING, `Synchronous compute ${formatFixed(this.renderFPS, 2)} fps`,
                    1.0, 1.0, 1.0, 1.0, 0);
            }
            Nri_ImguiDrawText(left, bottom - LINE_SPACING,
                "WASD: Pan viewport   PageUp/Down: Zoom viewport    Space: Toggle async   Esc: Exit", 1.0, 1.0, 1.0, 1.0, 0);
            Nri_ImguiRender(this.sample);
        }

        // The synchronous dispatch (the window is updated every frame: the sample never clears
        // m_windowUpdated), then the texture goes to the draw.
        recordCompute(commandBuffer: NriCommandBufferHandle) {
            const computeLayout = this.computeLayout;
            const computePipeline = this.computePipeline;
            const descriptorPool = this.descriptorPool;
            const syncSet = this.syncSet;
            const syncTexture = this.syncTexture;
            if (!computeLayout || !computePipeline || !descriptorPool || !syncSet || !syncTexture) {
                return;
            }
            if (this.syncDrawn) {
                Nri_CmdTextureBarrier(commandBuffer, syncTexture.texture, NriTextureState.ShaderResource, NriTextureState.Storage);
            }
            Nri_CmdSetDescriptorPool(commandBuffer, descriptorPool);
            Nri_CmdSetComputePipelineLayout(commandBuffer, computeLayout);
            Nri_CmdSetPipeline(commandBuffer, computePipeline);
            Nri_CmdSetComputeRootConstants(commandBuffer, 0, Ref(this.constants[0]), PUSH_CONSTANTS_SIZE);
            Nri_CmdSetComputeDescriptorSet(commandBuffer, 0, syncSet);
            Nri_CmdDispatch(commandBuffer, TEXTURE_WIDTH / NUM_SHADER_THREADS, TEXTURE_HEIGHT / NUM_SHADER_THREADS, 1);
            Nri_CmdTextureBarrier(commandBuffer, syncTexture.texture, NriTextureState.Storage, NriTextureState.ShaderResource);
            this.syncDrawn = true;
        }

        // The texture over the frame, stretched by a linear clamped blit (between
        // Nri_CmdBeginRendering and Nri_CmdEndRendering).
        recordDraw(commandBuffer: NriCommandBufferHandle, texture: FractalTexture) {
            const drawLayout = this.drawLayout;
            const drawPipeline = this.drawPipeline;
            const descriptorPool = this.descriptorPool;
            if (!drawLayout || !drawPipeline || !descriptorPool) {
                return;
            }
            Nri_CmdSetViewport(commandBuffer, 0.0, 0.0, this.width, this.height);
            Nri_CmdSetScissor(commandBuffer, 0, 0, this.width, this.height);
            Nri_CmdSetDescriptorPool(commandBuffer, descriptorPool);
            Nri_CmdSetPipelineLayout(commandBuffer, drawLayout);
            Nri_CmdSetPipeline(commandBuffer, drawPipeline);
            Nri_CmdSetDescriptorSet(commandBuffer, 0, texture.drawSet);
            Nri_CmdDraw(commandBuffer, 3, 1, 0, 0);
        }

        // The texture shown: the worker's newest (once it has run since async compute went on), or
        // the synchronous one.
        shownTexture(): FractalTexture | null {
            const computeLoop = this.computeLoop;
            if (!computeLoop || !this.usingAsyncCompute || this.asyncCurrent < 0) {
                return this.syncTexture;
            }
            if (Nri_GetAsyncComputeRunCount(computeLoop) <= this.runsAtResume) {
                return this.syncTexture;
            }
            return this.asyncTextures[this.asyncCurrent];
        }

        renderFrame(frameIndex: int) {
            const queuedFrame = this.queuedFrames[frameIndex % this.queuedFrames.length];
            this.update();
            if (this.imgui) {
                this.buildUI();
            }

            // In async compute, the worker gets the latest window; if it finished a texture, switch
            // to it (the work submitted from now on waiting for its run); the one held until then
            // goes back to it after this frame.
            let switched = false;
            let previous = -1;
            const computeLoop = this.computeLoop;
            if (computeLoop) {
                if (this.usingAsyncCompute) {
                    Nri_SetAsyncComputeConstants(computeLoop, Ref(this.constants[0]), PUSH_CONSTANTS_SIZE);
                    const next = Nri_AcquireAsyncComputeTexture(computeLoop, this.queue);
                    if (next >= 0) {
                        switched = true;
                        previous = this.asyncCurrent;
                        this.asyncCurrent = next;
                    }
                }
            }

            // Acquire a swap chain texture
            const acquireSemaphore = this.swapChainTextures[frameIndex % this.swapChainTextures.length].acquireSemaphore;
            const index = Nri_AcquireNextTexture(this.swapChain, acquireSemaphore);
            if (index >= 0) {
                const swapChainTexture = this.swapChainTextures[index];
                const commandBuffer = queuedFrame.commandBuffer;

                // Record: the fractal (computed now, or the worker's: the new one from the compute
                // queue's state, the previous one back), then the background and the fractal over
                // it, the HUD over that.
                Nri_BeginCommandBuffer(commandBuffer);
                if (!this.usingAsyncCompute) {
                    this.recordCompute(commandBuffer);
                }
                if (switched) {
                    Nri_CmdTextureBarrier(commandBuffer, this.asyncTextures[this.asyncCurrent].texture, NriTextureState.Storage,
                        NriTextureState.ShaderResource);
                }
                if (previous >= 0) {
                    Nri_CmdTextureBarrier(commandBuffer, this.asyncTextures[previous].texture, NriTextureState.ShaderResource,
                        NriTextureState.Storage);
                }
                if (this.imgui) {
                    Nri_CmdCopyImguiData(this.sample, commandBuffer);
                }
                Nri_CmdTextureBarrier(commandBuffer, swapChainTexture.texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                Nri_CmdBeginRendering(commandBuffer, swapChainTexture.colorAttachment);
                Nri_CmdClearColor(commandBuffer, BACKGROUND, BACKGROUND, BACKGROUND, 1.0);
                const texture = this.shownTexture();
                if (texture) {
                    this.recordDraw(commandBuffer, texture);
                }
                if (this.imgui) {
                    Nri_CmdDrawImgui(this.sample, commandBuffer, this.viewFormat);
                }
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
                if (this.imgui) {
                    Nri_ImguiEndFrame(this.sample);
                }
                Nri_QueuePresent(this.swapChain, swapChainTexture.releaseSemaphore);
            }

            // Signaled after the present, as NRISamples do
            Nri_QueueSignal(this.queue, this.frameFence, 1 + frameIndex);
            if (previous >= 0) {
                if (computeLoop) {
                    Nri_ReleaseAsyncComputeTexture(computeLoop, previous, 1 + frameIndex);
                }
            }
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
                if (this.imgui) {
                    Nri_DestroyImgui(this.sample);
                }
                for (const queuedFrame of this.queuedFrames) {
                    Nri_DestroyCommandBuffer(queuedFrame.commandBuffer);
                    Nri_DestroyCommandAllocator(queuedFrame.commandAllocator);
                }
                for (const swapChainTexture of this.swapChainTextures) {
                    Nri_DestroyFence(swapChainTexture.acquireSemaphore);
                    Nri_DestroyFence(swapChainTexture.releaseSemaphore);
                    Nri_DestroyDescriptor(swapChainTexture.colorAttachment);
                }
                this.destroyFractalTexture(this.syncTexture);
                for (const texture of this.asyncTextures) {
                    this.destroyFractalTexture(texture);
                }
                this.destroyPool(this.descriptorPool);
                this.destroyPool(this.asyncPool);
                this.destroyDescriptor(this.gradientView);
                this.destroyDescriptor(this.rainbowView);
                this.destroyDescriptor(this.pointSampler);
                this.destroyDescriptor(this.linearSampler);
                this.destroyTexture(this.gradient);
                this.destroyTexture(this.rainbow);
                const readbackBuffer = this.readbackBuffer;
                if (readbackBuffer) {
                    Nri_DestroyBuffer(readbackBuffer);
                }
                this.destroyPipeline(this.computePipeline);
                this.destroyPipeline(this.drawPipeline);
                this.destroyLayout(this.computeLayout);
                this.destroyLayout(this.drawLayout);
                Nri_DestroyFence(this.frameFence);
                Nri_DestroySwapChain(this.swapChain);
                Nri_DestroyDevice(device);
            }
            Nri_DestroySample(this.sample);
        }

        destroyFractalTexture(texture: FractalTexture | null) {
            if (texture) {
                Nri_DestroyDescriptor(texture.storageView);
                Nri_DestroyDescriptor(texture.view);
                Nri_DestroyTexture(texture.texture);
            }
        }

        destroyTexture(texture: NriTextureHandle | null) {
            if (texture) {
                Nri_DestroyTexture(texture);
            }
        }

        destroyDescriptor(descriptor: NriDescriptorHandle | null) {
            if (descriptor) {
                Nri_DestroyDescriptor(descriptor);
            }
        }

        destroyPool(pool: NriDescriptorPoolHandle | null) {
            if (pool) {
                Nri_DestroyDescriptorPool(pool);
            }
        }

        destroyPipeline(pipeline: NriPipelineHandle | null) {
            if (pipeline) {
                Nri_DestroyPipeline(pipeline);
            }
        }

        destroyLayout(layout: NriPipelineLayoutHandle | null) {
            if (layout) {
                Nri_DestroyPipelineLayout(layout);
            }
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = Nri_CreateSample();
        const simpleCompute = new SimpleCompute(sample);
        // -async: start with asynchronous compute (Space toggles it); -window X Y CX CY: the fractal
        // window's size and center instead of the default (Home); -noUI: no HUD.
        Nri_AddExampleOption(sample, "-async");
        Nri_AddExampleOptionWithValues(sample, "-window", 4);
        Nri_AddExampleOption(sample, "-noUI");
        for (let i = 1; i < argc; i++) {
            const arg = Nri_GetArg(argc, argv, i);
            if (arg == "-async") {
                simpleCompute.startAsync = true;
            } else if (arg == "-window" && i + 4 < argc) {
                simpleCompute.setWindow(parseFloat(Nri_GetArg(argc, argv, i + 1)), parseFloat(Nri_GetArg(argc, argv, i + 2)),
                    parseFloat(Nri_GetArg(argc, argv, i + 3)), parseFloat(Nri_GetArg(argc, argv, i + 4)));
                i += 4;
            } else if (arg == "-noUI") {
                simpleCompute.noUI = true;
            }
        }
        // The HUD's ImGui (on D3D11, with NRI's command buffer emulation, which the compute queue
        // doesn't work with): not with -noUI.
        if (!simpleCompute.noUI) {
            Nri_UseImgui(sample);
        }
        return simpleCompute.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return SimpleComputeNri.main(argc, argv);
}
