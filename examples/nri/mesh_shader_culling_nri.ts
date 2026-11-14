/// <reference path="../../core/nri/nri_interop.d.ts" />
import { NriFrameRing } from "../../core/nri_frame_ring";
import { NriSwapChain } from "../../core/nri_swap_chain";
import { Nri, NriBuffer, NriCommandBuffer, NriDescriptor, NriDevice, NriImgui, NriPipeline, NriPipelineDesc, NriPipelineLayout, NriPipelineLayoutDesc, NriQueue, NriSample } from "../../core/nri";

namespace MeshShaderCullingNri {
    // mesh_shader_culling, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead of
    // Donut and NVRHI: the same shaders (mesh_shader_culling.hlsl's), through the NRI calls
    // core/nri/nri_interop.d.ts binds, as meshlets_nri draws, with NRIFramework's ImGui for the
    // sample's overlay. This example creates everything it runs, and does the rendering.

    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    // core/test_check.ts' TEST_SKIPPED (CTest's SKIP_RETURN_CODE): no task and mesh shaders.
    const TEST_SKIPPED = 77;

    const WINDOW_TITLE = "NRI Example: Mesh Shader Culling";

    // struct CullConstants { float cullCenterX, cullCenterY, cullRadius, meshletDensity; uint2
    // numWorkGroups; }, padded to 32 bytes; a queued frame's each CONSTANTS_STRIDE bytes apart (D3D12
    // constant buffer views' alignment).
    const CONST_CULL_CENTER_X = 0;
    const CONST_CULL_CENTER_Y = 1;
    const CONST_CULL_RADIUS = 2;
    const CONST_MESHLET_DENSITY = 3;
    const CONST_NUM_WORK_GROUPS_X = 4;
    const CONST_NUM_WORK_GROUPS_Y = 5;
    const CONST_FLOATS = 8;
    const CONSTANTS_STRIDE = 256;

    // The sample's camera: first person at (1, 0, 1), turned off for the mouse; WASD (GLFW key
    // codes) moves it one unit per second, and the square with it.
    const CAMERA_X = 1.0;
    const CAMERA_Z = 1.0;
    const TRANSLATION_SPEED = 1.0;
    const KEY_A = 65;
    const KEY_D = 68;
    const KEY_S = 83;
    const KEY_W = 87;

    // ApiVulkanSample's clear color.
    const CLEAR_COLOR = 0.002;

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // Task shader workgroups per side for each density level: 4 x 4, 6 x 6, 8 x 8.
    function workGroupsPerSide(densityLevel: int) {
        return densityLevel == 0 ? 4 : (densityLevel == 1 ? 6 : (densityLevel == 2 ? 8 : 2));
    }

    // -test: checks the last frame, read back, as the Donut example does. The corners are the dark
    // clear color; the meshlets the task shader kept (those within the cull radius) cover 55% to 80%
    // of the frame, 40% to 70% colored (channels 61 or more apart).
    function checkFrame(pixels: int[], width: int, height: int) {
        if (pixels.length == 0) {
            return "cannot read the back buffer";
        }
        const clear = 0x070707;
        const xs = [0, width - 1, 0, width - 1];
        const ys = [0, 0, height - 1, height - 1];
        for (let k = 0; k < 4; k++) {
            const p = pixels[ys[k] * width + xs[k]] & 0xFFFFFF;
            if (p != clear) {
                return `corner (${xs[k]}, ${ys[k]}) is ${p & 0xFF}, ${(p >> 8) & 0xFF}, ${(p >> 16) & 0xFF}, not 7, 7, 7`;
            }
        }
        let colored = 0;
        let meshlets = 0;
        for (let i = 0; i < width * height; i++) {
            const p = pixels[i] & 0xFFFFFF;
            const r = p & 0xFF;
            const g = (p >> 8) & 0xFF;
            const b = (p >> 16) & 0xFF;
            const high = Math.max(r, Math.max(g, b));
            const low = Math.min(r, Math.min(g, b));
            if (high - low >= 61) {
                colored++;
            }
            if (p != clear) {
                meshlets++;
            }
        }
        const total = width * height;
        const coloredPercent = 100.0 * colored / total;
        console.log(`Colored: ${coloredPercent}% (${colored} of ${total} pixels)`);
        if (coloredPercent < 40.0 || coloredPercent > 70.0) {
            return `Colored: ${coloredPercent}% of the pixels, not 40% to 70%`;
        }
        const meshletPercent = 100.0 * meshlets / total;
        console.log(`Meshlets: ${meshletPercent}% (${meshlets} of ${total} pixels)`);
        if (meshletPercent < 55.0 || meshletPercent > 80.0) {
            return `Meshlets: ${meshletPercent}% of the pixels, not 55% to 80%`;
        }
        return "";
    }

    // Port of Vulkan-Samples' mesh_shader_culling (as examples/mesh_shader_culling.ts ports it) to
    // NRI: a square of N x N task shader workgroups of 2 x 2 invocations, each invocation a sub-rect,
    // in clip space. Task (amplification) shaders keep the sub-rects whose corners are all within a
    // circle around the center of the screen and launch a mesh shader workgroup for each, which
    // draws it as 2 x 2 colored quads. WASD moves the square. The Donut example's pipeline
    // statistics aren't shown: nri_interop has no queries.
    class MeshShaderCulling {
        private device: NriDevice | null = null;
        private queue: NriQueue;
        private frames: NriFrameRing = new NriFrameRing();
        private swapChain: NriSwapChain = new NriSwapChain();
        private viewFormat: NriFormat = NriFormat.Unknown;
        private pipelineLayout: NriPipelineLayout | null = null;
        private pipeline: NriPipeline | null = null;
        private constantBuffer: NriBuffer | null = null;
        private constantBufferView: NriDescriptor | null = null;
        private imgui: boolean = false;
        // The swap chain's size: the window's when it was (re)created.
        private width: int = 0;
        private height: int = 0;
        // The swap chain textures' format and their views'.
        private swapChainFormat: NriFormat = 0;
        private swapChainViewFormat: NriFormat = 0;
        // Set by initialize when the example can't run ("" otherwise).
        private unsupportedReason: string = "";

        // The camera's x and z (the square's position is minus those).
        private cameraX: number = CAMERA_X;
        private cameraZ: number = CAMERA_Z;
        private constants: f32[] = [];

        // The sample's settings (its UBO and density level): -radius <0.5..2>, -density <0..2>;
        // -noUI: no overlay.
        cullRadius: number = 1.0;
        densityLevel: int = 2;
        noUI: boolean = false;

        // -test: the last frame is read back into readbackBuffer, rows rowPitch bytes apart.
        private test: boolean = false;
        private readbackBuffer: NriBuffer | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSample) {
            for (let i = 0; i < CONST_FLOATS; i++) {
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

            // Swap chain: rendered through sRGB views, as the Donut example's sRGB back buffer.
            const queuedFrameNum = this.sample.getQueuedFrameNum();
            this.swapChain.init(this.sample, device, this.queue, true);
            this.sizeToSwapChain();
            const format = this.swapChainFormat;
            const viewFormat = this.swapChainViewFormat;
            this.viewFormat = viewFormat;

            // Queued frames
            this.frames.init(device, this.queue, queuedFrameNum);

            if (device.isFeatureSupported(NriFeature.MeshShader) == 0) {
                this.unsupportedReason = "This example needs task and mesh shaders (D3D12 or Vulkan)";
                return 0;
            }

            // The layout: the task shader's constant buffer (b0), a root descriptor.
            const layoutDesc = NriPipelineLayoutDesc.create();
            layoutDesc.addRootDescriptor(0, NriDescriptorType.ConstantBuffer, NriStage.Task);
            this.pipelineLayout = device.createPipelineLayoutFromDesc(layoutDesc);
            layoutDesc.destroy();
            const pipelineLayout = this.pipelineLayout;
            if (!pipelineLayout) {
                console.log("Cannot create the pipeline layout");
                return 0;
            }

            // The pipeline: mesh_shader_culling.hlsl's shaders, as compiled for the Donut example; no
            // depth test, no culling.
            const folder = graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv";
            const shaders = `shaders/mesh_shader_culling/${folder}/mesh_shader_culling`;
            const desc = NriPipelineDesc.create();
            let loaded = desc.addShader(NriShaderStage.Task, `${shaders}_cull_as.bin`, "cull_as") != 0;
            if (loaded) {
                loaded = desc.addShader(NriShaderStage.Mesh, `${shaders}_cull_ms.bin`, "cull_ms") != 0;
            }
            if (loaded) {
                loaded = desc.addShader(NriShaderStage.Pixel, `${shaders}_cull_ps.bin`, "cull_ps") != 0;
            }
            desc.setColor(viewFormat, NriColorWrite.RGBA);
            if (loaded) {
                this.pipeline = device.createPipelineFromDesc(pipelineLayout, desc);
            }
            desc.destroy();
            if (!this.pipeline) {
                console.log("Cannot load the mesh shader culling shaders");
                return 0;
            }

            // The constants, a queued frame's each.
            const constantBuffer = device.createHostBuffer(queuedFrameNum * CONSTANTS_STRIDE, NriBufferUsage.ConstantBuffer);
            this.constantBuffer = constantBuffer;
            if (!constantBuffer) {
                console.log("Cannot create the constant buffer");
                return 0;
            }
            this.constantBufferView = constantBuffer.createConstantView(0, CONSTANTS_STRIDE);

            // The sample's overlay.
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

        // The swap chain's size and formats (its views sRGB, as Donut's back buffers).
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

        // The framework's first person camera, never rotated: W and S along z, A and D along x
        // (none of them in the test).
        update() {
            if (this.test) {
                return;
            }
            const moveSpeed = this.sample.getFrameTime() * TRANSLATION_SPEED;
            if (this.sample.isKeyPressed(KEY_W) != 0) {
                this.cameraZ += moveSpeed;
            }
            if (this.sample.isKeyPressed(KEY_S) != 0) {
                this.cameraZ -= moveSpeed;
            }
            if (this.sample.isKeyPressed(KEY_A) != 0) {
                this.cameraX += moveSpeed;
            }
            if (this.sample.isKeyPressed(KEY_D) != 0) {
                this.cameraX -= moveSpeed;
            }
        }

        // The sample's overlay (its title, ApiVulkanSample's default).
        buildUI() {
            this.sample.imguiNewFrame();
            NriImgui.setNextWindowPos(10.0, 10.0);
            NriImgui.begin("Vulkan Example", 1);
            if (NriImgui.collapsingHeader("Use WASD to move the square\n Configurations:\n", 1) != 0) {
                this.cullRadius = NriImgui.sliderFloat("Cull Radius: ", this.cullRadius, 0.5, 2.0);
                this.densityLevel = NriImgui.combo("Meshlet Density Level: ", this.densityLevel, "4 x 4|6 x 6|8 x 8");
            }
            NriImgui.end();
            this.sample.imguiRender();
        }

        // The square: N x N task shader workgroups (between NriCommandBuffer.beginRendering and
        // NriCommandBuffer.endRendering), their constants at constantsOffset.
        recordDraw(commandBuffer: NriCommandBuffer, constantsOffset: int) {
            const pipelineLayout = this.pipelineLayout;
            const pipeline = this.pipeline;
            const constantBuffer = this.constantBuffer;
            const constantBufferView = this.constantBufferView;
            if (!pipelineLayout || !pipeline || !constantBuffer || !constantBufferView) {
                return;
            }
            const groups = workGroupsPerSide(this.densityLevel);
            const c = this.constants;
            c[CONST_CULL_CENTER_X] = -this.cameraX;
            c[CONST_CULL_CENTER_Y] = -this.cameraZ;
            c[CONST_CULL_RADIUS] = this.cullRadius;
            c[CONST_MESHLET_DENSITY] = this.densityLevel;
            Nri.storeInt32(Ref(c[CONST_NUM_WORK_GROUPS_X]), groups);
            Nri.storeInt32(Ref(c[CONST_NUM_WORK_GROUPS_Y]), groups);
            constantBuffer.write(constantsOffset, Ref(c[0]), CONST_FLOATS * 4);

            commandBuffer.setViewport(0.0, 0.0, this.width, this.height);
            commandBuffer.setScissor(0, 0, this.width, this.height);
            commandBuffer.setPipelineLayout(pipelineLayout);
            commandBuffer.setPipeline(pipeline);
            commandBuffer.setRootDescriptor(0, constantBufferView, constantsOffset);
            commandBuffer.drawMeshTasks(groups, groups, 1);
        }

        renderFrame(frameIndex: int) {
            this.resizeIfNeeded();
            const queuedFrameIndex = frameIndex % this.frames.size();
            this.update();
            if (this.imgui) {
                this.buildUI();
            }

            // Acquire a swap chain texture
            const index = this.swapChain.acquire(frameIndex);
            if (index >= 0) {
                const texture = this.swapChain.texture(index);
                const commandBuffer = this.frames.commandBuffer(frameIndex);

                // Record: cleared, the square, the overlay over it.
                commandBuffer.begin();
                if (this.imgui) {
                    this.sample.copyImguiData(commandBuffer);
                }
                commandBuffer.textureBarrier(texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                commandBuffer.beginRendering(this.swapChain.colorAttachment(index));
                commandBuffer.clearColor(CLEAR_COLOR, CLEAR_COLOR, CLEAR_COLOR, 1.0);
                this.recordDraw(commandBuffer, queuedFrameIndex * CONSTANTS_STRIDE);
                if (this.imgui) {
                    this.sample.drawImgui(commandBuffer, this.viewFormat);
                }
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
                if (this.imgui) {
                    this.sample.imguiEndFrame();
                }
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
                if (this.imgui) {
                    this.sample.destroyImgui();
                }
                const constantBufferView = this.constantBufferView;
                if (constantBufferView) {
                    constantBufferView.destroy();
                }
                const constantBuffer = this.constantBuffer;
                if (constantBuffer) {
                    constantBuffer.destroy();
                }
                const readbackBuffer = this.readbackBuffer;
                if (readbackBuffer) {
                    readbackBuffer.destroy();
                }
                const pipeline = this.pipeline;
                if (pipeline) {
                    pipeline.destroy();
                }
                const pipelineLayout = this.pipelineLayout;
                if (pipelineLayout) {
                    pipelineLayout.destroy();
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
        const meshShaderCulling = new MeshShaderCulling(sample);
        // -radius <0.5..2>: the culling circle's radius; -density <0..2>: 4 x 4, 6 x 6 or 8 x 8;
        // -noUI: no overlay.
        sample.addExampleOptionWithValues("-radius", 1);
        sample.addExampleOptionWithValues("-density", 1);
        sample.addExampleOption("-noUI");
        sample.useImgui();
        for (let i = 1; i < argc; i++) {
            const arg = Nri.getArg(argc, argv, i);
            if (arg == "-radius" && i + 1 < argc) {
                i++;
                meshShaderCulling.cullRadius = Math.min(Math.max(parseFloat(Nri.getArg(argc, argv, i)), 0.5), 2.0);
            } else if (arg == "-density" && i + 1 < argc) {
                i++;
                meshShaderCulling.densityLevel = Math.min(Math.max(parseInt(Nri.getArg(argc, argv, i)), 0), 2);
            } else if (arg == "-noUI") {
                meshShaderCulling.noUI = true;
            }
        }
        return meshShaderCulling.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return MeshShaderCullingNri.main(argc, argv);
}
