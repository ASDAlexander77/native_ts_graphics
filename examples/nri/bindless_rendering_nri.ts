/// <reference path="../../core/nri/nri_interop.d.ts" />
import { NriFrameRing } from "../../core/nri_frame_ring";
import { NriSwapChain } from "../../core/nri_swap_chain";
import { perspProjD3DStyleReverse } from "../../core/matrix";
import { DonutFirstPersonCamera } from "../../core/donut_first_person_camera";
import { DonutSceneTextures } from "../../core/nri_donut_textures";
import { Nri, NriBuffer, NriCommandBuffer, NriDescriptor, NriDescriptorPool, NriDescriptorSet, NriDevice, NriDonutScene, NriPipeline, NriPipelineDesc, NriPipelineLayout, NriPipelineLayoutDesc, NriQueue, NriSample, NriTexture } from "../../core/nri";

namespace BindlessRenderingNri {
    // bindless_rendering, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead of
    // Donut and NVRHI: the same shaders (bindless_rendering.hlsl's), the scene loaded as Donut's
    // engine loads it (core/nri/nri_donut_scene.cpp: its buffers, its textures with the mip chains
    // Donut's texture cache blits), through the NRI calls core/nri/nri_interop.d.ts binds. This
    // example creates everything it runs, and does the rendering.

    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    const WINDOW_TITLE = "NRI Example: Bindless Rendering";
    const DEFAULT_SCENE = "media/glTF-Sample-Assets/Models/Sponza/glTF/Sponza.gltf";

    // The Donut example's camera: Donut's FirstPersonCamera (its default rotate speed), at the eye
    // height looking along x; reversed depth from 0.1, a 45 degree field of view.
    const MOVE_SPEED = 3.0;
    const ROTATE_SPEED = 0.005;
    const Z_NEAR = 0.1;

    // struct InstanceConstants in bindless_rendering.hlsl: the instance and its geometry, as push
    // constants.
    const INSTANCE_CONSTANTS_SIZE = 2 * 4;

    // Constant buffer views' alignment.
    const CONSTANTS_ALIGNMENT = 256;

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // -test: checks the last frame, read back, as the Donut example does: Sponza fills it (almost all
    // lit), a quarter of it in color, its blue banners about 3%.
    function checkFrame(pixels: int[], width: int, height: int) {
        if (pixels.length == 0) {
            return "cannot read the back buffer";
        }
        const total = width * height;
        let dark = 0;
        let colored = 0;
        let blue = 0;
        for (let i = 0; i < total; i++) {
            const p = pixels[i];
            const r = p & 0xFF;
            const g = (p >> 8) & 0xFF;
            const b = (p >> 16) & 0xFF;
            if (r <= 20 && g <= 20 && b <= 20) {
                dark++;
            }
            if (Math.max(r, Math.max(g, b)) - Math.min(r, Math.min(g, b)) >= 61) {
                colored++;
            }
            if (r <= 89 && g <= 119 && b >= 121) {
                blue++;
            }
        }
        const shares = [100.0 * (total - dark) / total, 100.0 * colored / total, 100.0 * blue / total];
        const names = ["Lit", "Colored", "Blue banners"];
        const lows = [95.0, 15.0, 1.5];
        const highs = [100.0, 35.0, 5.0];
        for (let k = 0; k < 3; k++) {
            console.log(`${names[k]}: ${shares[k]}%`);
            if (shares[k] < lows[k] || shares[k] > highs[k]) {
                return `${names[k]}: ${shares[k]}% of the pixels, not ${lows[k]}% to ${highs[k]}%`;
            }
        }
        return "";
    }

    // A frame in flight's own data: its set (its copy of the view's constants).
    class QueuedFrame {
        constructor(public set: NriDescriptorSet | null, public viewConstantsView: NriDescriptor | null) {
        }
    }

    // Port of Donut-Samples' bindless_rendering.cpp (as examples/bindless_rendering.ts ports it) to
    // NRI: Sponza drawn without binding any vertex or index buffer. Each draw passes its instance and
    // geometry as push constants; the vertex shader reads the index and vertex data from the scene's
    // bindless buffer array, and the pixel shader the material's diffuse texture from its bindless
    // texture array (alpha-tested materials clip). WASD/QE and the left mouse button move the
    // camera (Donut's FirstPersonCamera).
    class BindlessRendering {
        private device: NriDevice | null = null;
        private queue: NriQueue;
        private frames: NriFrameRing = new NriFrameRing();
        private swapChain: NriSwapChain = new NriSwapChain();
        private queuedFrames: QueuedFrame[] = [];
        private viewFormat: NriFormat = NriFormat.Unknown;
        private width: int = 0;
        private height: int = 0;
        // The swap chain textures' format and their views' (the swap chain's).
        private swapChainFormat: NriFormat = NriFormat.Unknown;
        private swapChainViewFormat: NriFormat = NriFormat.Unknown;
        private test: boolean = false;
        scenePath: string = DEFAULT_SCENE;

        // The scene: its buffers (vertices, indices, instances, geometries, materials), their views,
        // its textures and their views; the draws.
        private scene: NriDonutScene | null = null;
        private sceneBuffers: NriBuffer[] = [];
        private sceneBufferViews: NriDescriptor[] = [];
        // (Their mip chains made in the first frame.)
        private textures: DonutSceneTextures = new DonutSceneTextures();

        // The depth buffer (D24S8, the Donut example's).
        private depthTexture: NriTexture | null = null;
        private depthAttachment: NriDescriptor | null = null;

        private layout: NriPipelineLayout | null = null;
        private pipeline: NriPipeline | null = null;
        // CommonRenderPasses' anisotropic wrap sampler (the materials').
        private anisotropicWrap: NriDescriptor | null = null;
        private constantBuffer: NriBuffer | null = null;
        private descriptorPool: NriDescriptorPool | null = null;
        // The bindless arrays' sets: one on Vulkan (the shader's set 1, bindings 0 and 1), the
        // buffers' and the textures' (spaces 1 and 2) on D3D12.
        private bindlessSets: NriDescriptorSet[] = [];
        private viewConstantsSize: int = 0;
        private viewStride: int = 0;

        private camera: DonutFirstPersonCamera = new DonutFirstPersonCamera(MOVE_SPEED, ROTATE_SPEED);
        private viewMatrix: f32[] = [];
        private projMatrix: f32[] = [];
        private viewConstants: f32[] = [];
        private instanceConstants: f32[] = [0.0, 0.0];

        // -test: the last frame is read back into readbackBuffer, rows rowPitch bytes apart.
        private readbackBuffer: NriBuffer | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSample) {
            for (let i = 0; i < 16; i++) {
                this.viewMatrix.push(0.0);
                this.projMatrix.push(0.0);
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
            // As the Donut example: its shaders read bindless arrays, which D3D11 lacks.
            if (graphicsAPI == NriGraphicsAPI.D3D11) {
                console.log("The Bindless Rendering example does not support D3D11.");
                return 0;
            }
            const device = this.sample.createDevice(graphicsAPI);
            if (!device) {
                console.log("Cannot initialize a graphics device with the requested parameters");
                return 0;
            }
            this.device = device;
            console.log(`Renderer: ${Nri.getGraphicsAPIString(graphicsAPI)} (${device.getAdapterName()})`);

            this.queue = device.getGraphicsQueue();
            this.test = this.sample.isTest() != 0;

            // Swap chain: rendered into through sRGB views, as into Donut's sRGB back buffers.
            const queuedFrameNum = this.sample.getQueuedFrameNum();
            this.swapChain.init(this.sample, device, this.queue, true);
            this.sizeToSwapChain();
            const format = this.swapChainFormat;
            const viewFormat = this.swapChainViewFormat;

            // Reverse Z: cleared to 0, nearer is greater.
            if (!this.createDepth(device)) {
                return 0;
            }

            const vulkan = graphicsAPI == NriGraphicsAPI.VK;
            if (!this.loadScene(device, vulkan) || !this.createPipelines(device, vulkan)
                || !this.createDescriptorSets(device, queuedFrameNum, vulkan)) {
                return 0;
            }

            this.camera.lookAt(0.0, 1.8, 0.0, 1.0, 1.8, 0.0);
            this.viewConstantsSize = Nri.getDonutConstantsSize(0);

            if (this.test) {
                const alignment = device.getUploadBufferTextureRowAlignment();
                this.rowPitch = Math.floor((this.width * 4 + alignment - 1) / alignment) * alignment;
                this.readbackBuffer = device.createReadbackBuffer(this.rowPitch * this.height);
                this.readbackFormat = format;
            }
            return 1;
        }

        // The scene, as Donut's engine loads it: its buffers, its textures (their mip chains below the
        // first level blitted in the first frame).
        loadScene(device: NriDevice, vulkan: boolean) {
            const scene = NriDonutScene.load(this.scenePath);
            this.scene = scene;
            if (!scene) {
                console.log(`Cannot load the scene ${this.scenePath}`);
                return false;
            }
            for (let which = 0; which < 5; which++) {
                const buffer = device.createDonutSceneBuffer(this.queue, scene, which);
                if (!buffer) {
                    console.log("Cannot create the scene's buffers");
                    return false;
                }
                this.sceneBuffers.push(buffer);
                const view = buffer.createStructuredView(0);
                if (!view) {
                    console.log("Cannot create the scene's buffers");
                    return false;
                }
                this.sceneBufferViews.push(view);
            }
            return this.textures.load(device, this.queue, scene, vulkan ? "spirv" : "dxil");
        }

        // The example's layout and pipeline (front faces counterclockwise, back faces culled; depth
        // tested greater or equal and written).
        createPipelines(device: NriDevice, vulkan: boolean) {
            const textureCount = this.textures.textures.length;
            // Set 0: the view (b0), the instances, geometries and materials (t0 to t2), the
            // sampler (s0); the instance constants (b1) as root constants.
            const layoutDesc = NriPipelineLayoutDesc.create();
            layoutDesc.addRange(0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.VertexPixel, NriRangeFlags.None);
            layoutDesc.addRange(0, 0, 3, NriDescriptorType.StructuredBuffer, NriStage.VertexPixel, NriRangeFlags.None);
            layoutDesc.addRange(0, 0, 1, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
            layoutDesc.addRootConstants(1, INSTANCE_CONSTANTS_SIZE, NriStage.Vertex);
            // The bindless arrays: on Vulkan set 1, the buffers at binding 0 and the textures at 1 (the
            // shader's vk::binding); on D3D12 spaces 1 and 2.
            const arrayFlags = NriRangeFlags.PartiallyBound | NriRangeFlags.Array;
            layoutDesc.addRange(1, 0, 2, NriDescriptorType.StructuredBuffer, NriStage.Vertex, arrayFlags);
            if (vulkan) {
                layoutDesc.addRange(1, 1, textureCount, NriDescriptorType.Texture, NriStage.Pixel, arrayFlags);
            } else {
                layoutDesc.addRange(2, 0, textureCount, NriDescriptorType.Texture, NriStage.Pixel, arrayFlags);
            }
            const layout = device.createPipelineLayoutFromDesc(layoutDesc);
            layoutDesc.destroy();
            this.layout = layout;

            if (!layout) {
                console.log("Cannot create the pipeline layout");
                return false;
            }

            const folder = vulkan ? "spirv" : "dxil";
            const shaders = `shaders/bindless_rendering/${folder}/bindless_rendering`;
            const desc = NriPipelineDesc.create();
            let loaded = desc.addShader(NriShaderStage.Vertex, `${shaders}_vs_main.bin`, "vs_main") != 0;
            if (loaded) {
                loaded = desc.addShader(NriShaderStage.Pixel, `${shaders}_ps_main.bin`, "ps_main") != 0;
            }
            desc.setCullMode(NriCullMode.Back);
            desc.setFrontCounterClockwise(1);
            desc.setColor(this.viewFormat, NriColorWrite.RGBA);
            desc.setDepth(NriFormat.D24_UNORM_S8_UINT, NriCompareOp.GreaterEqual, 1, 0);
            if (loaded) {
                this.pipeline = device.createPipelineFromDesc(layout, desc);
            }
            desc.destroy();

            if (!this.pipeline) {
                console.log("Cannot load the bindless rendering shaders");
                return false;
            }
            return true;
        }

        // The sampler, the view's constants (a queued frame's copy each), the sets: a queued frame's,
        // the bindless arrays', a mip blit's each.
        createDescriptorSets(device: NriDevice, queuedFrameNum: int, vulkan: boolean) {
            const layout = this.layout;
            if (!layout) {
                return false;
            }
            this.anisotropicWrap = device.createSampler(NriFilter.Linear, NriAddressMode.Repeat, 16);
            const anisotropicWrap = this.anisotropicWrap;
            const blitCount = this.textures.blitSetCount();
            const textureCount = this.textures.textures.length;

            this.viewStride = Math.floor((Nri.getDonutConstantsSize(0) + CONSTANTS_ALIGNMENT - 1) / CONSTANTS_ALIGNMENT) * CONSTANTS_ALIGNMENT;
            const constantBuffer = device.createHostBuffer(queuedFrameNum * this.viewStride, NriBufferUsage.ConstantBuffer);
            this.constantBuffer = constantBuffer;
            const setNum = queuedFrameNum + 2 + blitCount;
            const descriptorPool = device.createDescriptorPoolWithBuffers(setNum, queuedFrameNum + blitCount, queuedFrameNum,
                textureCount + blitCount, 0, 3 * queuedFrameNum + 2, 0, 0);
            this.descriptorPool = descriptorPool;
            if (!constantBuffer || !descriptorPool || !anisotropicWrap) {
                console.log("Cannot create the descriptors");
                return false;
            }

            this.frames.init(device, this.queue, queuedFrameNum);
            for (let i = 0; i < queuedFrameNum; i++) {
                const set = descriptorPool.allocateDescriptorSet(layout, 0, 0);
                const viewConstantsView = constantBuffer.createConstantView(i * this.viewStride, this.viewStride);
                this.queuedFrames.push(new QueuedFrame(set, viewConstantsView));
                if (!set || !viewConstantsView) {
                    console.log("Cannot create the descriptor sets");
                    return false;
                }
                set.updateDescriptor(0, 0, viewConstantsView);
                for (let k = 0; k < 3; k++) {
                    set.updateDescriptor(1, k, this.sceneBufferViews[2 + k]);
                }
                set.updateDescriptor(2, 0, anisotropicWrap);
            }

            // The bindless arrays: the vertices (0) and indices (1); the textures by number.
            const bufferSet = descriptorPool.allocateDescriptorSet(layout, 1, 0);
            if (!bufferSet) {
                console.log("Cannot create the descriptor sets");
                return false;
            }
            this.bindlessSets.push(bufferSet);
            bufferSet.updateDescriptor(0, 0, this.sceneBufferViews[0]);
            bufferSet.updateDescriptor(0, 1, this.sceneBufferViews[1]);
            let textureSet = bufferSet;
            let textureRange = 1;
            if (!vulkan) {
                const set = descriptorPool.allocateDescriptorSet(layout, 2, 0);
                if (!set) {
                    console.log("Cannot create the descriptor sets");
                    return false;
                }
                this.bindlessSets.push(set);
                textureSet = set;
                textureRange = 0;
            }
            for (let i = 0; i < textureCount; i++) {
                textureSet.updateDescriptor(textureRange, i, this.textures.views[i]);
            }
            if (!this.textures.createBlits(descriptorPool)) {
                console.log("Cannot create the descriptor sets");
                return false;
            }
            return true;
        }

        // Waits for the frame that last used this frame's command allocator.
        latencySleep(frameIndex: int) {
            this.frames.wait(frameIndex);
        }

        // The camera (Donut's FirstPersonCamera, unless in test mode, where nothing moves it) and the
        // queued frame's PlanarViewConstants.
        writeConstants(queuedFrameIndex: int) {
            const constantBuffer = this.constantBuffer;
            if (!constantBuffer) {
                return;
            }
            if (!this.test) {
                this.camera.animate(this.sample, this.sample.getFrameTime(), true);
            }
            const worldToView = this.camera.worldToView();
            const projection = perspProjD3DStyleReverse(Math.PI * 0.25, this.width / this.height, Z_NEAR);
            for (let i = 0; i < 16; i++) {
                this.viewMatrix[i] = worldToView[i];
                this.projMatrix[i] = projection[i];
            }
            if (this.viewConstants.length == 0) {
                for (let i = 0; i < this.viewConstantsSize / 4; i++) {
                    this.viewConstants.push(0.0);
                }
            }
            Nri.fillDonutPlanarViewConstants(Ref(this.viewMatrix[0]), Ref(this.projMatrix[0]), this.width, this.height,
                Ref(this.viewConstants[0]));
            constantBuffer.write(queuedFrameIndex * this.viewStride, Ref(this.viewConstants[0]), this.viewConstantsSize);
        }

        // Every geometry of every instance, a draw each (between NriCommandBuffer.beginRenderingWithDepth and
        // NriCommandBuffer.endRendering).
        recordDraws(commandBuffer: NriCommandBuffer, queuedFrame: QueuedFrame) {
            const scene = this.scene;
            const layout = this.layout;
            const pipeline = this.pipeline;
            const descriptorPool = this.descriptorPool;
            const set = queuedFrame.set;
            if (!scene || !layout || !pipeline || !descriptorPool || !set) {
                return;
            }
            commandBuffer.setViewport(0.0, 0.0, this.width, this.height);
            commandBuffer.setScissor(0, 0, this.width, this.height);
            commandBuffer.setDescriptorPool(descriptorPool);
            commandBuffer.setPipelineLayout(layout);
            commandBuffer.setPipeline(pipeline);
            commandBuffer.setDescriptorSet(0, set);
            for (let k = 0; k < this.bindlessSets.length; k++) {
                commandBuffer.setDescriptorSet(1 + k, this.bindlessSets[k]);
            }
            const instanceCount = scene.getInstanceCount();
            for (let i = 0; i < instanceCount; i++) {
                const geometryCount = scene.getInstanceGeometryCount(i);
                for (let g = 0; g < geometryCount; g++) {
                    Nri.storeInt32(Ref(this.instanceConstants[0]), i);
                    Nri.storeInt32(Ref(this.instanceConstants[1]), g);
                    commandBuffer.setRootConstants(0, Ref(this.instanceConstants[0]), INSTANCE_CONSTANTS_SIZE);
                    commandBuffer.draw(scene.getGeometryIndexCount(i, g), 1, 0, 0);
                }
            }
        }

        // The swap chain's size and formats (its views sRGB, as Donut's back buffers).
        sizeToSwapChain() {
            this.width = this.swapChain.width();
            this.height = this.swapChain.height();
            this.swapChainFormat = this.swapChain.format();
            this.swapChainViewFormat = this.swapChain.viewFormat();
            this.viewFormat = this.swapChain.viewFormat();
        }

        // The depth buffer at the swap chain's size.
        createDepth(device: NriDevice): boolean {
            const depthTexture = device.createDepthTexture(this.queue, this.width, this.height, NriFormat.D24_UNORM_S8_UINT);
            this.depthTexture = depthTexture;
            if (!depthTexture) {
                console.log("Cannot create the depth buffer");
                return false;
            }
            this.depthAttachment = depthTexture.createDepthAttachmentView(NriFormat.D24_UNORM_S8_UINT);
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

        // The window was resized (NriSample.useResizableWindow): the swap chain and the depth buffer made
        // again at its size, once the GPU is done with the old ones.
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
            this.writeConstants(queuedFrameIndex);

            // Acquire a swap chain texture
            const index = this.swapChain.acquire(frameIndex);
            const depthAttachment = this.depthAttachment;
            if (index >= 0) {
                const texture = this.swapChain.texture(index);
                const commandBuffer = this.frames.commandBuffer(frameIndex);

                // Record: the mip chains (the first frame), then the scene.
                commandBuffer.begin();
                const descriptorPool = this.descriptorPool;
                if (descriptorPool) {
                    commandBuffer.setDescriptorPool(descriptorPool);
                    this.textures.recordBlits(commandBuffer);
                }
                commandBuffer.textureBarrier(texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                if (depthAttachment) {
                    commandBuffer.beginRenderingWithDepth(this.swapChain.colorAttachment(index), depthAttachment);
                    commandBuffer.clearColor(0.0, 0.0, 0.0, 0.0);
                    commandBuffer.clearDepth(0.0);
                    this.recordDraws(commandBuffer, queuedFrame);
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
                    this.destroyDescriptor(queuedFrame.viewConstantsView);
                }
                const descriptorPool = this.descriptorPool;
                if (descriptorPool) {
                    descriptorPool.destroy();
                }
                this.textures.destroy();
                for (const view of this.sceneBufferViews) {
                    view.destroy();
                }
                for (const buffer of this.sceneBuffers) {
                    buffer.destroy();
                }
                this.destroyDescriptor(this.anisotropicWrap);
                this.destroyDescriptor(this.depthAttachment);
                const depthTexture = this.depthTexture;
                if (depthTexture) {
                    depthTexture.destroy();
                }
                this.destroyBuffer(this.constantBuffer);
                this.destroyBuffer(this.readbackBuffer);
                this.destroyPipeline(this.pipeline);
                this.destroyLayout(this.layout);
                this.frames.destroy();
                this.swapChain.destroy();
                device.destroy();
            }
            const scene = this.scene;
            if (scene) {
                scene.destroy();
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
        const rendering = new BindlessRendering(sample);
        // --scene <path>: relative to the executable's directory.
        sample.addExampleOptionWithValues("--scene", 1);
        for (let i = 1; i < argc; i++) {
            if (Nri.getArg(argc, argv, i) == "--scene" && i + 1 < argc) {
                rendering.scenePath = Nri.getArg(argc, argv, i + 1);
            }
        }
        return rendering.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return BindlessRenderingNri.main(argc, argv);
}
