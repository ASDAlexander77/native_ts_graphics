/// <reference path="../../core/nri/nri_interop.d.ts" />
import { NriFrameRing } from "../../core/nri_frame_ring";
import { NriSwapChain } from "../../core/nri_swap_chain";
import { formatFixed } from "../../core/text_format";
import { Nri, NriAsyncComputeLoop, NriBuffer, NriCommandBuffer, NriDescriptor, NriDescriptorPool, NriDescriptorSet, NriDevice, NriImgui, NriPipeline, NriPipelineDesc, NriPipelineLayout, NriPipelineLayoutDesc, NriQueue, NriSample, NriTexture } from "../../core/nri";

namespace SimpleComputeNri {
    // simple_compute, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead of
    // Donut and NVRHI: the same compute shader (simple_compute.hlsl's), through the NRI calls
    // core/nri/nri_interop.d.ts binds, with NRIFramework's ImGui for the sample's HUD. The worker
    // thread is C++ (NriQueue.createAsyncComputeLoop), as Donut's: tslang code can't run on threads its
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

    // GLFW's key codes (NriSample.isKeyPressed's).
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

    // A fractal texture: its views, and the draw's descriptor set that shows it.
    class FractalTexture {
        constructor(public texture: NriTexture, public storageView: NriDescriptor, public view: NriDescriptor,
            public drawSet: NriDescriptorSet) {
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
        private device: NriDevice | null = null;
        private queue: NriQueue;
        private frames: NriFrameRing = new NriFrameRing();
        private swapChain: NriSwapChain = new NriSwapChain();
        private viewFormat: NriFormat = NriFormat.Unknown;
        private computeLayout: NriPipelineLayout | null = null;
        private computePipeline: NriPipeline | null = null;
        private drawLayout: NriPipelineLayout | null = null;
        private drawPipeline: NriPipeline | null = null;
        private gradient: NriTexture | null = null;
        private rainbow: NriTexture | null = null;
        private gradientView: NriDescriptor | null = null;
        private rainbowView: NriDescriptor | null = null;
        private pointSampler: NriDescriptor | null = null;
        private linearSampler: NriDescriptor | null = null;
        // The render thread's descriptor sets (the synchronous dispatch's, the draws'), and the
        // compute loop's (only its worker uses them).
        private descriptorPool: NriDescriptorPool | null = null;
        private asyncPool: NriDescriptorPool | null = null;
        private syncSet: NriDescriptorSet | null = null;
        // The synchronous path's texture, then the worker's.
        private syncTexture: FractalTexture | null = null;
        private asyncTextures: FractalTexture[] = [];
        private computeLoop: NriAsyncComputeLoop | null = null;
        // The synchronous texture is read by the draw (after its first dispatch).
        private syncDrawn: boolean = false;
        // The worker's texture held by the render thread (-1: none yet).
        private asyncCurrent: int = -1;
        private imgui: boolean = false;
        // The swap chain's size: the window's when it was (re)created.
        private width: int = 0;
        private height: int = 0;
        // The swap chain textures' format and their views'.
        private swapChainFormat: NriFormat = 0;
        private swapChainViewFormat: NriFormat = 0;

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
        private readbackBuffer: NriBuffer | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSample) {
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
            this.sample.setInitializeCallback(initialize);
            this.sample.setLatencySleepCallback(latencySleep);
            this.sample.setRenderFrameCallback(renderFrame);

            let result = this.sample.run(argc, argv, WINDOW_TITLE, TEST_FRAMES);
            // The worker thread stops first: then the GPU is done with everything.
            const computeLoop = this.computeLoop;
            if (computeLoop) {
                computeLoop.destroy();
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
            const device = this.sample.createDevice(graphicsAPI);
            if (!device) {
                console.log("Cannot initialize a graphics device with the requested parameters");
                return 0;
            }
            this.device = device;
            console.log(`Renderer: ${Nri.getGraphicsAPIString(graphicsAPI)} (${device.getAdapterName()})`);

            this.queue = device.getGraphicsQueue();
            this.test = this.sample.isTest() != 0;

            // Swap chain: rendered through UNORM views, as the sample's B8G8R8A8_UNORM back buffers.
            const queuedFrameNum = this.sample.getQueuedFrameNum();
            this.swapChain.init(this.sample, device, this.queue, false);
            this.sizeToSwapChain();
            const format = this.swapChainFormat;
            this.viewFormat = format;

            // Queued frames
            this.frames.init(device, this.queue, queuedFrameNum);

            // The layouts: the compute shader's constants (push constants, b0), fractal (u0), color
            // map (t0) and sampler (s0); the draw's texture (t0) and sampler (s0).
            const computeLayoutDesc = NriPipelineLayoutDesc.create();
            computeLayoutDesc.addRootConstants(0, PUSH_CONSTANTS_SIZE, NriStage.Compute);
            computeLayoutDesc.addRange(0, 0, 1, NriDescriptorType.StorageTexture, NriStage.Compute, NriRangeFlags.None);
            computeLayoutDesc.addRange(0, 0, 1, NriDescriptorType.Texture, NriStage.Compute, NriRangeFlags.None);
            computeLayoutDesc.addRange(0, 0, 1, NriDescriptorType.Sampler, NriStage.Compute, NriRangeFlags.None);
            this.computeLayout = device.createPipelineLayoutFromDesc(computeLayoutDesc);
            computeLayoutDesc.destroy();
            const drawLayoutDesc = NriPipelineLayoutDesc.create();
            drawLayoutDesc.addRange(0, 0, 1, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            drawLayoutDesc.addRange(0, 0, 1, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
            this.drawLayout = device.createPipelineLayoutFromDesc(drawLayoutDesc);
            drawLayoutDesc.destroy();
            const computeLayout = this.computeLayout;
            const drawLayout = this.drawLayout;
            if (!computeLayout || !drawLayout) {
                console.log("Cannot create the pipeline layouts");
                return 0;
            }

            // The pipelines: fractal_cs as compiled for the Donut example; the blit, a triangle over
            // the screen (16bit_arithmetic.hlsl's visualize shaders), no culling, no depth.
            const folder = graphicsAPI == NriGraphicsAPI.D3D11 ? "dxbc" : (graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv");
            const computePipeline = device.createComputePipeline(computeLayout,
                `shaders/simple_compute/${folder}/simple_compute_fractal_cs.bin`, "fractal_cs");
            this.computePipeline = computePipeline;
            const blit = `shaders/16bit_arithmetic/${folder}/16bit_arithmetic`;
            const desc = NriPipelineDesc.create();
            let loaded = desc.addShader(NriShaderStage.Vertex, `${blit}_visualize_vs.bin`, "visualize_vs") != 0;
            if (loaded) {
                loaded = desc.addShader(NriShaderStage.Pixel, `${blit}_visualize_ps.bin`, "visualize_ps") != 0;
            }
            desc.setColor(format, NriColorWrite.RGBA);
            if (loaded) {
                this.drawPipeline = device.createPipelineFromDesc(drawLayout, desc);
            }
            desc.destroy();
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
            const gradient = device.createUploadedComputeTexture(this.queue, COLOR_MAP_SIZE, 1, NriFormat.RGBA8_UNORM,
                Ref(gradientTexels[0]), COLOR_MAP_SIZE * 4);
            const rainbow = device.createUploadedComputeTexture(this.queue, COLOR_MAP_SIZE, 1, NriFormat.RGBA8_UNORM,
                Ref(rainbowTexels[0]), COLOR_MAP_SIZE * 4);
            this.gradient = gradient;
            this.rainbow = rainbow;
            const pointSampler = device.createSampler(NriFilter.Nearest, NriAddressMode.ClampToEdge, 1);
            const linearSampler = device.createSampler(NriFilter.Linear, NriAddressMode.ClampToEdge, 1);
            this.pointSampler = pointSampler;
            this.linearSampler = linearSampler;
            const descriptorPool = device.createDescriptorPool(1 + 1 + NUM_ASYNC_TEXTURES, 2 + NUM_ASYNC_TEXTURES, 0,
                2 + NUM_ASYNC_TEXTURES, 1, 0);
            const asyncPool = device.createDescriptorPool(NUM_ASYNC_TEXTURES, NUM_ASYNC_TEXTURES, 0, NUM_ASYNC_TEXTURES,
                NUM_ASYNC_TEXTURES, 0);
            this.descriptorPool = descriptorPool;
            this.asyncPool = asyncPool;
            if (!gradient || !rainbow || !pointSampler || !linearSampler || !descriptorPool || !asyncPool) {
                console.log("Cannot create the color maps and descriptors");
                return 0;
            }
            const gradientView = gradient.createView(NriFormat.RGBA8_UNORM);
            const rainbowView = rainbow.createView(NriFormat.RGBA8_UNORM);
            this.gradientView = gradientView;
            this.rainbowView = rainbowView;

            // The synchronous path's texture and set.
            const syncTexture = this.createFractalTexture(device, descriptorPool, drawLayout, linearSampler);
            const syncSet = descriptorPool.allocateDescriptorSet(computeLayout, 0, 0);
            this.syncTexture = syncTexture;
            this.syncSet = syncSet;
            if (!syncTexture || !syncSet) {
                console.log("Cannot create the fractal texture");
                return 0;
            }
            syncSet.updateDescriptor(0, 0, syncTexture.storageView);
            syncSet.updateDescriptor(1, 0, gradientView);
            syncSet.updateDescriptor(2, 0, pointSampler);

            // The worker, where there's a compute queue. On D3D11 with the HUD, NRI's command buffer
            // emulation (which NRIFramework's ImGui needs there: NriSample.useImgui) breaks the compute
            // queue: synchronous compute only then.
            const computeQueue = device.getComputeQueue();
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
                if (this.sample.initImgui(device) == 0) {
                    console.log("Cannot initialize the user interface");
                    return 0;
                }
                this.imgui = true;
            }

            if (this.test) {
                const alignment = device.getUploadBufferTextureRowAlignment();
                this.rowPitch = Math.floor((this.width * 4 + alignment - 1) / alignment) * alignment;
                this.readbackBuffer = device.createReadbackBuffer(this.rowPitch * this.height);
                this.readbackFormat = format;
            }
            return 1;
        }

        // A fractal texture (in NriTextureState.Storage) and the draw's set showing it; null on
        // failure.
        createFractalTexture(device: NriDevice, descriptorPool: NriDescriptorPool, drawLayout: NriPipelineLayout,
            sampler: NriDescriptor): FractalTexture | null {
            const texture = device.createStorageTexture(this.queue, TEXTURE_WIDTH, TEXTURE_HEIGHT, NriFormat.RGBA8_UNORM);
            if (!texture) {
                return null;
            }
            const drawSet = descriptorPool.allocateDescriptorSet(drawLayout, 0, 0);
            if (!drawSet) {
                texture.destroy();
                return null;
            }
            const view = texture.createView(NriFormat.RGBA8_UNORM);
            drawSet.updateDescriptor(0, 0, view);
            drawSet.updateDescriptor(1, 0, sampler);
            return new FractalTexture(texture, texture.createStorageView(NriFormat.RGBA8_UNORM), view, drawSet);
        }

        // The worker: its textures (with the rainbow color map), paused until async compute is on.
        startComputeLoop(device: NriDevice, computeQueue: NriQueue, computeLayout: NriPipelineLayout,
            computePipeline: NriPipeline, asyncPool: NriDescriptorPool, drawLayout: NriPipelineLayout,
            linearSampler: NriDescriptor, pointSampler: NriDescriptor, rainbowView: NriDescriptor): boolean {
            const descriptorPool = this.descriptorPool;
            if (!descriptorPool) {
                return false;
            }
            const computeLoop = computeQueue.createAsyncComputeLoop(device, this.frames.fence(), computeLayout, computePipeline, asyncPool,
                TEXTURE_WIDTH / NUM_SHADER_THREADS, TEXTURE_HEIGHT / NUM_SHADER_THREADS, 0);
            this.computeLoop = computeLoop;
            if (!computeLoop) {
                console.log("Cannot create the compute loop");
                return false;
            }
            for (let i = 0; i < NUM_ASYNC_TEXTURES; i++) {
                const texture = this.createFractalTexture(device, descriptorPool, drawLayout, linearSampler);
                const computeSet = asyncPool.allocateDescriptorSet(computeLayout, 0, 0);
                if (!texture || !computeSet) {
                    console.log("Cannot create the async fractal textures");
                    return false;
                }
                computeSet.updateDescriptor(0, 0, texture.storageView);
                computeSet.updateDescriptor(1, 0, rainbowView);
                computeSet.updateDescriptor(2, 0, pointSampler);
                this.asyncTextures.push(texture);
                computeLoop.addTexture(computeSet);
            }
            computeLoop.setConstants(Ref(this.constants[0]), PUSH_CONSTANTS_SIZE);
            computeLoop.setPaused(1);
            computeLoop.start();
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
                this.runsAtResume = computeLoop.getRunCount();
                this.lastRunCount = this.runsAtResume;
            }
            computeLoop.setPaused(value ? 0 : 1);
        }

        // The swap chain's size and formats (its views in the textures' format).
        sizeToSwapChain() {
            this.width = this.swapChain.width();
            this.height = this.swapChain.height();
            this.swapChainFormat = this.swapChain.format();
            this.swapChainViewFormat = this.swapChain.viewFormat();
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
            this.swapChain.recreate();
            this.sizeToSwapChain();
        }

        // Waits for the frame that last used this frame's command allocator.
        latencySleep(frameIndex: int) {
            this.frames.wait(frameIndex);
        }

        pressed(key: int): boolean {
            return this.sample.isKeyPressed(key) != 0;
        }

        // Sample::Update: Space and Home, the smoothed rates, then the held keys pan and zoom the
        // window (none of them in the test, which takes 1/60 second a frame, as Donut's test mode).
        update() {
            const elapsedTime = Math.fround(this.test ? 1.0 / 60.0 : this.sample.getFrameTime());
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
                    const runCount = computeLoop.getRunCount();
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

            this.sample.imguiNewFrame();
            NriImgui.drawText(left, top, `Simple Compute Context ${formatFixed(this.renderFPS, 2)} fps`, 1.0, 1.0, 1.0, 1.0, 0);
            if (this.usingAsyncCompute) {
                NriImgui.drawText(left, top + LINE_SPACING, `Asynchronous compute ${formatFixed(this.computeFPS, 2)} fps`,
                    1.0, 1.0, 1.0, 1.0, 0);
            } else {
                NriImgui.drawText(left, top + LINE_SPACING, `Synchronous compute ${formatFixed(this.renderFPS, 2)} fps`,
                    1.0, 1.0, 1.0, 1.0, 0);
            }
            NriImgui.drawText(left, bottom - LINE_SPACING,
                "WASD: Pan viewport   PageUp/Down: Zoom viewport    Space: Toggle async   Esc: Exit", 1.0, 1.0, 1.0, 1.0, 0);
            this.sample.imguiRender();
        }

        // The synchronous dispatch (the window is updated every frame: the sample never clears
        // m_windowUpdated), then the texture goes to the draw.
        recordCompute(commandBuffer: NriCommandBuffer) {
            const computeLayout = this.computeLayout;
            const computePipeline = this.computePipeline;
            const descriptorPool = this.descriptorPool;
            const syncSet = this.syncSet;
            const syncTexture = this.syncTexture;
            if (!computeLayout || !computePipeline || !descriptorPool || !syncSet || !syncTexture) {
                return;
            }
            if (this.syncDrawn) {
                commandBuffer.textureBarrier(syncTexture.texture, NriTextureState.ShaderResource, NriTextureState.Storage);
            }
            commandBuffer.setDescriptorPool(descriptorPool);
            commandBuffer.setComputePipelineLayout(computeLayout);
            commandBuffer.setPipeline(computePipeline);
            commandBuffer.setComputeRootConstants(0, Ref(this.constants[0]), PUSH_CONSTANTS_SIZE);
            commandBuffer.setComputeDescriptorSet(0, syncSet);
            commandBuffer.dispatch(TEXTURE_WIDTH / NUM_SHADER_THREADS, TEXTURE_HEIGHT / NUM_SHADER_THREADS, 1);
            commandBuffer.textureBarrier(syncTexture.texture, NriTextureState.Storage, NriTextureState.ShaderResource);
            this.syncDrawn = true;
        }

        // The texture over the frame, stretched by a linear clamped blit (between
        // NriCommandBuffer.beginRendering and NriCommandBuffer.endRendering).
        recordDraw(commandBuffer: NriCommandBuffer, texture: FractalTexture) {
            const drawLayout = this.drawLayout;
            const drawPipeline = this.drawPipeline;
            const descriptorPool = this.descriptorPool;
            if (!drawLayout || !drawPipeline || !descriptorPool) {
                return;
            }
            commandBuffer.setViewport(0.0, 0.0, this.width, this.height);
            commandBuffer.setScissor(0, 0, this.width, this.height);
            commandBuffer.setDescriptorPool(descriptorPool);
            commandBuffer.setPipelineLayout(drawLayout);
            commandBuffer.setPipeline(drawPipeline);
            commandBuffer.setDescriptorSet(0, texture.drawSet);
            commandBuffer.draw(3, 1, 0, 0);
        }

        // The texture shown: the worker's newest (once it has run since async compute went on), or
        // the synchronous one.
        shownTexture(): FractalTexture | null {
            const computeLoop = this.computeLoop;
            if (!computeLoop || !this.usingAsyncCompute || this.asyncCurrent < 0) {
                return this.syncTexture;
            }
            if (computeLoop.getRunCount() <= this.runsAtResume) {
                return this.syncTexture;
            }
            return this.asyncTextures[this.asyncCurrent];
        }

        renderFrame(frameIndex: int) {
            this.resizeIfNeeded();
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
                    computeLoop.setConstants(Ref(this.constants[0]), PUSH_CONSTANTS_SIZE);
                    const next = computeLoop.acquireTexture(this.queue);
                    if (next >= 0) {
                        switched = true;
                        previous = this.asyncCurrent;
                        this.asyncCurrent = next;
                    }
                }
            }

            // Acquire a swap chain texture
            const index = this.swapChain.acquire(frameIndex);
            if (index >= 0) {
                const backBuffer = this.swapChain.texture(index);
                const commandBuffer = this.frames.commandBuffer(frameIndex);

                // Record: the fractal (computed now, or the worker's: the new one from the compute
                // queue's state, the previous one back), then the background and the fractal over
                // it, the HUD over that.
                commandBuffer.begin();
                if (!this.usingAsyncCompute) {
                    this.recordCompute(commandBuffer);
                }
                if (switched) {
                    commandBuffer.textureBarrier(this.asyncTextures[this.asyncCurrent].texture, NriTextureState.Storage,
                        NriTextureState.ShaderResource);
                }
                if (previous >= 0) {
                    commandBuffer.textureBarrier(this.asyncTextures[previous].texture, NriTextureState.ShaderResource,
                        NriTextureState.Storage);
                }
                if (this.imgui) {
                    this.sample.copyImguiData(commandBuffer);
                }
                commandBuffer.textureBarrier(backBuffer, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                commandBuffer.beginRendering(this.swapChain.colorAttachment(index));
                commandBuffer.clearColor(BACKGROUND, BACKGROUND, BACKGROUND, 1.0);
                const texture = this.shownTexture();
                if (texture) {
                    this.recordDraw(commandBuffer, texture);
                }
                if (this.imgui) {
                    this.sample.drawImgui(commandBuffer, this.viewFormat);
                }
                commandBuffer.endRendering();

                // The test's last frame: read back
                let presentFrom = NriTextureState.ColorAttachment;
                const readbackBuffer = this.readbackBuffer;
                if (readbackBuffer) {
                    if (frameIndex == TEST_FRAMES - 1) {
                        commandBuffer.textureBarrier(backBuffer, NriTextureState.ColorAttachment, NriTextureState.CopySource);
                        commandBuffer.readbackTextureToBuffer(readbackBuffer, this.rowPitch, backBuffer, this.width, this.height);
                        presentFrom = NriTextureState.CopySource;
                    }
                }
                commandBuffer.textureBarrier(backBuffer, presentFrom, NriTextureState.Present);
                commandBuffer.end();

                // Submit and present
                this.swapChain.submit(commandBuffer, index);
                if (this.imgui) {
                    this.sample.imguiEndFrame();
                }
                this.swapChain.present(index);
            }

            // Signaled after the present, as NRISamples do
            this.frames.signal(frameIndex);
            if (previous >= 0) {
                if (computeLoop) {
                    computeLoop.releaseTexture(previous, 1 + frameIndex);
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
                if (this.imgui) {
                    this.sample.destroyImgui();
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
                    readbackBuffer.destroy();
                }
                this.destroyPipeline(this.computePipeline);
                this.destroyPipeline(this.drawPipeline);
                this.destroyLayout(this.computeLayout);
                this.destroyLayout(this.drawLayout);
                this.frames.destroy();
                this.swapChain.destroy();
                device.destroy();
            }
            this.sample.destroy();
        }

        destroyFractalTexture(texture: FractalTexture | null) {
            if (texture) {
                texture.storageView.destroy();
                texture.view.destroy();
                texture.texture.destroy();
            }
        }

        destroyTexture(texture: NriTexture | null) {
            if (texture) {
                texture.destroy();
            }
        }

        destroyDescriptor(descriptor: NriDescriptor | null) {
            if (descriptor) {
                descriptor.destroy();
            }
        }

        destroyPool(pool: NriDescriptorPool | null) {
            if (pool) {
                pool.destroy();
            }
        }

        destroyPipeline(pipeline: NriPipeline | null) {
            if (pipeline) {
                pipeline.destroy();
            }
        }

        destroyLayout(layout: NriPipelineLayout | null) {
            if (layout) {
                layout.destroy();
            }
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = NriSample.create();
        sample.useResizableWindow();
        const simpleCompute = new SimpleCompute(sample);
        // -async: start with asynchronous compute (Space toggles it); -window X Y CX CY: the fractal
        // window's size and center instead of the default (Home); -noUI: no HUD.
        sample.addExampleOption("-async");
        sample.addExampleOptionWithValues("-window", 4);
        sample.addExampleOption("-noUI");
        for (let i = 1; i < argc; i++) {
            const arg = Nri.getArg(argc, argv, i);
            if (arg == "-async") {
                simpleCompute.startAsync = true;
            } else if (arg == "-window" && i + 4 < argc) {
                simpleCompute.setWindow(parseFloat(Nri.getArg(argc, argv, i + 1)), parseFloat(Nri.getArg(argc, argv, i + 2)),
                    parseFloat(Nri.getArg(argc, argv, i + 3)), parseFloat(Nri.getArg(argc, argv, i + 4)));
                i += 4;
            } else if (arg == "-noUI") {
                simpleCompute.noUI = true;
            }
        }
        // The HUD's ImGui (on D3D11, with NRI's command buffer emulation, which the compute queue
        // doesn't work with): not with -noUI.
        if (!simpleCompute.noUI) {
            sample.useImgui();
        }
        return simpleCompute.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return SimpleComputeNri.main(argc, argv);
}
