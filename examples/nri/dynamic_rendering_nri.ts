/// <reference path="../../core/nri/nri_interop.d.ts" />
import { NriFrameRing } from "../../core/nri_frame_ring";
import { NriSwapChain } from "../../core/nri_swap_chain";
import { inverseRigid, radians, perspective } from "../../core/matrix";
import { LookAtCamera } from "../../core/vulkan_samples_camera";
import { Nri, NriBuffer, NriCommandBuffer, NriDescriptor, NriDescriptorPool, NriDescriptorSet, NriDevice, NriGltfMesh, NriPipeline, NriPipelineDesc, NriPipelineLayout, NriPipelineLayoutDesc, NriQueue, NriSample, NriTexture } from "../../core/nri";

namespace DynamicRenderingNri {
    // dynamic_rendering, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead of
    // Donut and NVRHI: the same shaders (vertex_dynamic_state.hlsl's, as dynamic_rendering compiles
    // them), models and cube map, through the NRI calls core/nri/nri_interop.d.ts binds, as
    // basic_triangle_nri draws. This example creates everything it runs, and does the rendering.

    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    const WINDOW_TITLE = "NRI Example: Dynamic Rendering";

    // The sample's models and HDR cube map (Vulkan-Samples' assets, hdr's copies: the KTX cube map
    // converted to DDS at build time, see VULKAN_SAMPLES_ASSETS_DIR in CMakeLists.txt).
    const CUBE_PATH = "media/hdr/cube.gltf";
    const OBJECT_PATH = "media/hdr/geosphere.gltf";
    const ENVMAP_PATH = "media/hdr/uffizi_rgba16f_cube.dds";

    // NriDevice.loadGltfMesh's vertices: float3 position, float3 normal, float2 texture coordinates.
    const VERTEX_SIZE = 32;
    const NORMAL_OFFSET = 12;

    // struct UBO { float4x4 projection, modelview, skybox_modelview, inverse_modelview; float
    // modelscale; }, padded; a queued frame's each in a constant buffer view of UBO_VIEW_SIZE bytes
    // (a multiple of 256, D3D12's).
    const UBO_PROJECTION = 0;
    const UBO_MODELVIEW = 16;
    const UBO_SKYBOX_MODELVIEW = 32;
    const UBO_INVERSE_MODELVIEW = 48;
    const UBO_MODELSCALE = 64;
    const UBO_FLOATS = 68;
    const UBO_VIEW_SIZE = 512;
    const MODEL_SCALE = 0.05;

    // The sample's look-at camera at (0, 0, -4) (vkb::Camera's position, the view's translation),
    // turned 180 degrees around y; reversed depth from 0.1 to 256.
    const CAMERA_POSITION = [0.0, 0.0, -4.0];
    const CAMERA_ROTATION = [0.0, 180.0, 0.0];
    const CAMERA_FOV = 60.0;
    const Z_NEAR = 256.0;
    const Z_FAR = 0.1;

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // A frame in flight's own data: its descriptor set (its copy of the UBO, the cube
    // map, the sampler).
    class QueuedFrame {
        constructor(public descriptorSet: NriDescriptorSet | null, public uboView: NriDescriptor | null) {
        }
    }

    // -test: checks the last frame, read back, as the Donut example does: the street skybox fills it
    // (90% or more lit: some channel over 20), the reflective sphere's highlights and the sky 1% to 6%
    // white (every channel over 220).
    function checkFrame(pixels: int[], width: int, height: int) {
        if (pixels.length == 0) {
            return "cannot read the back buffer";
        }
        const total = width * height;
        let dark = 0;
        let white = 0;
        for (let i = 0; i < total; i++) {
            const p = pixels[i];
            const r = p & 0xFF;
            const g = (p >> 8) & 0xFF;
            const b = (p >> 16) & 0xFF;
            if (r <= 20 && g <= 20 && b <= 20) {
                dark++;
            }
            if (r >= 221 && g >= 221 && b >= 221) {
                white++;
            }
        }
        const lit = 100.0 * (total - dark) / total;
        console.log(`Lit: ${lit}% (${total - dark} of ${total} pixels)`);
        if (lit < 90.0 || lit > 100.0) {
            return `Lit: ${lit}% of the pixels, not 90% to 100%`;
        }
        const whitePercent = 100.0 * white / total;
        console.log(`White: ${whitePercent}% (${white} of ${total} pixels)`);
        if (whitePercent < 1.0 || whitePercent > 6.0) {
            return `White: ${whitePercent}% of the pixels, not 1% to 6%`;
        }
        return "";
    }

    // Port of Vulkan-Samples' dynamic_rendering (as examples/dynamic_rendering.ts ports it) to NRI:
    // hdr's skybox and a reflective geosphere. The sample renders with VK_KHR_dynamic_rendering (no
    // render pass or framebuffer objects); NRI's Vulkan backend always renders that way
    // (CmdBeginRendering), D3D has no render pass objects either. The left mouse button turns the
    // camera, the right one zooms it.
    class DynamicRendering {
        private device: NriDevice | null = null;
        private queue: NriQueue;
        private frames: NriFrameRing = new NriFrameRing();
        private swapChain: NriSwapChain = new NriSwapChain();
        // The swap chain textures' format and their views'.
        private swapChainFormat: NriFormat = 0;
        private swapChainViewFormat: NriFormat = 0;
        private queuedFrames: QueuedFrame[] = [];
        private viewFormat: NriFormat = NriFormat.Unknown;
        private depthTexture: NriTexture | null = null;
        private depthAttachment: NriDescriptor | null = null;
        private layout: NriPipelineLayout | null = null;
        private skyboxPipeline: NriPipeline | null = null;
        private modelPipeline: NriPipeline | null = null;
        private skybox: NriGltfMesh | null = null;
        private object: NriGltfMesh | null = null;
        private envmap: NriTexture | null = null;
        private envmapView: NriDescriptor | null = null;
        private sampler: NriDescriptor | null = null;
        private uniformBuffer: NriBuffer | null = null;
        private descriptorPool: NriDescriptorPool | null = null;
        private width: int = 0;
        private height: int = 0;

        private camera: LookAtCamera = new LookAtCamera(CAMERA_POSITION, CAMERA_ROTATION);
        // The mouse, as the camera sees it: its position (summed from its moves) and buttons.
        private mouseX: number = 0.0;
        private mouseY: number = 0.0;
        private buttons: boolean[] = [false, false, false];

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

            // The depth buffer: D32, cleared to 0 (the sample's reversed depth).
            if (!this.createSizeTargets(device)) {
                console.log("Cannot create the depth buffer");
                return 0;
            }

            // The models and the cube map, its sampler as the framework's load_texture_cubemap:
            // trilinear, clamped, the device's widest anisotropic filtering.
            this.skybox = device.loadGltfMesh(this.queue, CUBE_PATH);
            this.object = device.loadGltfMesh(this.queue, OBJECT_PATH);
            const envmap = device.loadDdsTexture(this.queue, ENVMAP_PATH, 0);
            this.envmap = envmap;
            if (!this.skybox || !this.object || !envmap) {
                console.log("Cannot load the models and the cube map: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return 0;
            }
            const envmapView = envmap.createCubeView(NriFormat.RGBA16_SFLOAT);
            this.envmapView = envmapView;
            const sampler = device.createSamplerWithMipFilter(NriFilter.Linear, NriFilter.Linear, NriAddressMode.ClampToEdge,
                device.getMaxSamplerAnisotropy());
            this.sampler = sampler;
            if (!sampler) {
                console.log("Cannot create the sampler");
                return 0;
            }

            // The layout: the UBO (b0, both shaders'), the cube map (t0) and its sampler (s0).
            const layoutDesc = NriPipelineLayoutDesc.create();
            layoutDesc.addRange(0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.VertexPixel, NriRangeFlags.None);
            layoutDesc.addRange(0, 0, 1, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            layoutDesc.addRange(0, 0, 1, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
            const layout = device.createPipelineLayoutFromDesc(layoutDesc);
            layoutDesc.destroy();
            this.layout = layout;
            if (!layout) {
                console.log("Cannot create the pipeline layout");
                return 0;
            }

            // The pipelines: vertex_dynamic_state.hlsl's shaders (TYPE 0: the skybox, 1: the object),
            // as compiled for the Donut example.
            const folder = graphicsAPI == NriGraphicsAPI.D3D11 ? "dxbc" : graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv";
            const shaders = `shaders/dynamic_rendering/${folder}/vertex_dynamic_state`;
            this.skyboxPipeline = this.createPipeline(device, layout, shaders, false);
            this.modelPipeline = this.createPipeline(device, layout, shaders, true);
            if (!this.skyboxPipeline || !this.modelPipeline) {
                console.log("Cannot load the dynamic rendering shaders");
                return 0;
            }

            // A queued frame's UBO each, in its own descriptor set with the cube map and sampler.
            const uniformBuffer = device.createHostBuffer(queuedFrameNum * UBO_VIEW_SIZE, NriBufferUsage.ConstantBuffer);
            this.uniformBuffer = uniformBuffer;
            const descriptorPool = device.createDescriptorPool(queuedFrameNum, queuedFrameNum, queuedFrameNum, queuedFrameNum, 0, 0);
            this.descriptorPool = descriptorPool;
            if (!uniformBuffer || !descriptorPool) {
                console.log("Cannot create the descriptors");
                return 0;
            }
            this.frames.init(device, this.queue, queuedFrameNum);
            for (let i = 0; i < queuedFrameNum; i++) {
                const descriptorSet = descriptorPool.allocateDescriptorSet(layout, 0, 0);
                const uboView = uniformBuffer.createConstantView(i * UBO_VIEW_SIZE, UBO_VIEW_SIZE);
                this.queuedFrames.push(new QueuedFrame(descriptorSet, uboView));
                if (!descriptorSet || !uboView) {
                    console.log("Cannot create the descriptor sets");
                    return 0;
                }
                descriptorSet.updateDescriptor(0, 0, uboView);
                descriptorSet.updateDescriptor(1, 0, envmapView);
                descriptorSet.updateDescriptor(2, 0, sampler);
            }

            if (this.test) {
                const alignment = device.getUploadBufferTextureRowAlignment();
                this.rowPitch = Math.floor((this.width * 4 + alignment - 1) / alignment) * alignment;
                this.readbackBuffer = device.createReadbackBuffer(this.rowPitch * this.height);
                this.readbackFormat = format;
            }
            return 1;
        }

        // The sample's prepare_pipelines: position and normal of the glTF loader's vertices; the
        // skybox without depth, back faces culled (counter-clockwise front faces); the object with
        // depth tested (greater: reversed) and written, front faces culled.
        createPipeline(device: NriDevice, layout: NriPipelineLayout, shaders: string, isObject: boolean) {
            const permutation = isObject ? "TYPE=1" : "TYPE=0";
            const desc = NriPipelineDesc.create();
            let loaded = desc.addShaderPermutation(NriShaderStage.Vertex, `${shaders}_gbuffer_vs.bin`, "gbuffer_vs",
                permutation) != 0;
            if (loaded) {
                loaded = desc.addShaderPermutation(NriShaderStage.Pixel, `${shaders}_gbuffer_ps.bin`, "gbuffer_ps",
                    permutation) != 0;
            }
            desc.addVertexAttribute("POSITION", NriFormat.RGB32_SFLOAT, 0);
            desc.addVertexAttribute("NORMAL", NriFormat.RGB32_SFLOAT, NORMAL_OFFSET);
            desc.setCullMode(isObject ? NriCullMode.Front : NriCullMode.Back);
            desc.setFrontCounterClockwise(1);
            desc.setColor(this.viewFormat, NriColorWrite.RGBA);
            desc.setDepth(NriFormat.D32_SFLOAT, isObject ? NriCompareOp.Greater : NriCompareOp.None, isObject ? 1 : 0, 0);
            let pipeline: NriPipeline | null = null;
            if (loaded) {
                pipeline = device.createPipelineFromDesc(layout, desc);
            }
            desc.destroy();
            return pipeline;
        }

        // Waits for the frame that last used this frame's command allocator (and its UBO).
        latencySleep(frameIndex: int) {
            this.frames.wait(frameIndex);
        }

        // The camera's mouse handling: the buttons' changes, then the move.
        handleMouse() {
            for (let button = 0; button < 3; button++) {
                const pressed = this.sample.isButtonPressed(button) != 0;
                if (pressed != this.buttons[button]) {
                    this.camera.mouseButton(<MouseButton>button, <Action>(pressed ? 1 : 0));
                    this.buttons[button] = pressed;
                }
            }
            this.mouseX += this.sample.getMouseDeltaX();
            this.mouseY += this.sample.getMouseDeltaY();
            this.camera.mouseMove(this.mouseX, this.mouseY);
        }

        // The sample's update_uniform_buffers: its projection (clip y negated, as the Donut example
        // gives it), the view (the object at the origin), its inverse; into this frame's UBO.
        writeUbo(queuedFrameIndex: int) {
            const uniformBuffer = this.uniformBuffer;
            if (!uniformBuffer) {
                return;
            }
            const projection = perspective(radians(CAMERA_FOV), this.width / this.height, Z_NEAR, Z_FAR);
            const view = this.camera.view();
            const inverseView = inverseRigid(view);
            for (let i = 0; i < 16; i++) {
                this.ubo[UBO_PROJECTION + i] = i % 4 == 1 ? -projection[i] : projection[i];
                this.ubo[UBO_MODELVIEW + i] = view[i];
                this.ubo[UBO_SKYBOX_MODELVIEW + i] = view[i];
                this.ubo[UBO_INVERSE_MODELVIEW + i] = inverseView[i];
            }
            this.ubo[UBO_MODELSCALE] = MODEL_SCALE;
            uniformBuffer.write(queuedFrameIndex * UBO_VIEW_SIZE, Ref(this.ubo[0]), UBO_FLOATS * 4);
        }

        // A model with a pipeline (between NriCommandBuffer.beginRenderingWithDepth and NriCommandBuffer.endRendering).
        drawMesh(commandBuffer: NriCommandBuffer, pipeline: NriPipeline | null, mesh: NriGltfMesh | null) {
            if (!pipeline || !mesh) {
                return;
            }
            commandBuffer.setPipeline(pipeline);
            commandBuffer.setIndexBuffer(mesh.getIndexBuffer(), 0, NriIndexType.UInt32);
            commandBuffer.setVertexBuffer(0, mesh.getVertexBuffer(), 0, VERTEX_SIZE);
            commandBuffer.drawIndexed(mesh.getIndexCount(), 1, 0, 0, 0);
        }

        // The skybox, the object.
        recordDraw(commandBuffer: NriCommandBuffer, queuedFrame: QueuedFrame) {
            const layout = this.layout;
            const descriptorPool = this.descriptorPool;
            const descriptorSet = queuedFrame.descriptorSet;
            if (!layout || !descriptorPool || !descriptorSet) {
                return;
            }
            commandBuffer.setViewport(0.0, 0.0, this.width, this.height);
            commandBuffer.setScissor(0, 0, this.width, this.height);
            commandBuffer.setDescriptorPool(descriptorPool);
            commandBuffer.setPipelineLayout(layout);
            commandBuffer.setDescriptorSet(0, descriptorSet);
            this.drawMesh(commandBuffer, this.skyboxPipeline, this.skybox);
            this.drawMesh(commandBuffer, this.modelPipeline, this.object);
        }

        // The swap chain's size and formats (its views sRGB, as Donut's back buffers).
        sizeToSwapChain() {
            this.width = this.swapChain.width();
            this.height = this.swapChain.height();
            this.viewFormat = this.swapChain.viewFormat();
            this.swapChainFormat = this.swapChain.format();
            this.swapChainViewFormat = this.swapChain.viewFormat();
        }

        // The window-size targets: the depth buffer (D32, cleared to 0: the sample's reversed depth) and its attachment view; false if it can't
        // be created.
        createSizeTargets(device: NriDevice): boolean {
            const depthTexture = device.createDepthTexture(this.queue, this.width, this.height, NriFormat.D32_SFLOAT);
            this.depthTexture = depthTexture;
            if (!depthTexture) {
                return false;
            }
            this.depthAttachment = depthTexture.createDepthAttachmentView(NriFormat.D32_SFLOAT);
            return true;
        }

        destroySizeTargets() {
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

        // The window was resized (NriSample.useResizableWindow): the swap chain and the window-size targets made again at its
        // size, once the GPU is done with the old ones.
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
            this.destroySizeTargets();
            this.createSizeTargets(device);
        }

        renderFrame(frameIndex: int) {
            this.resizeIfNeeded();
            const queuedFrameIndex = frameIndex % this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            this.handleMouse();
            this.writeUbo(queuedFrameIndex);

            // Acquire a swap chain texture
            const index = this.swapChain.acquire(frameIndex);
            const depthAttachment = this.depthAttachment;
            if (index >= 0) {
                const texture = this.swapChain.texture(index);
                const commandBuffer = this.frames.commandBuffer(frameIndex);

                // Record: color cleared to transparent black, depth to 0 (reversed); the skybox and
                // the object.
                commandBuffer.begin();
                commandBuffer.textureBarrier(texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                if (depthAttachment) {
                    commandBuffer.beginRenderingWithDepth(this.swapChain.colorAttachment(index), depthAttachment);
                    commandBuffer.clearColor(0.0, 0.0, 0.0, 0.0);
                    commandBuffer.clearDepth(0.0);
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
                this.destroyDescriptor(this.envmapView);
                this.destroyDescriptor(this.sampler);
                this.destroySizeTargets();
                this.destroyTexture(this.envmap);
                this.destroyMesh(this.skybox);
                this.destroyMesh(this.object);
                this.destroyBuffer(this.uniformBuffer);
                this.destroyBuffer(this.readbackBuffer);
                this.destroyPipeline(this.skyboxPipeline);
                this.destroyPipeline(this.modelPipeline);
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

        destroyTexture(texture: NriTexture | null) {
            if (texture) {
                texture.destroy();
            }
        }

        destroyMesh(mesh: NriGltfMesh | null) {
            if (mesh) {
                mesh.destroy();
            }
        }

        destroyBuffer(buffer: NriBuffer | null) {
            if (buffer) {
                buffer.destroy();
            }
        }

        destroyPipeline(pipeline: NriPipeline | null) {
            if (pipeline) {
                pipeline.destroy();
            }
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = NriSample.create();
        sample.useResizableWindow();
        const dynamicRendering = new DynamicRendering(sample);
        return dynamicRendering.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return DynamicRenderingNri.main(argc, argv);
}
