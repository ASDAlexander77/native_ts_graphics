/// <reference path="../../core/nri/nri_interop.d.ts" />
import { inverseRigid, radians, perspective } from "../../core/matrix";
import { LookAtCamera } from "../../core/vulkan_samples_camera";

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

    // Nri_LoadGltfMesh's vertices: float3 position, float3 normal, float2 texture coordinates.
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

    // What a frame in flight records into, and its descriptor set (its copy of the UBO, the cube
    // map, the sampler).
    class QueuedFrame {
        constructor(public commandAllocator: NriCommandAllocatorHandle, public commandBuffer: NriCommandBufferHandle,
            public descriptorSet: NriDescriptorSetHandle | null, public uboView: NriDescriptorHandle | null) {
        }
    }

    // A swap chain texture, its view and the semaphores of its acquire and release.
    class SwapChainTexture {
        constructor(public texture: NriTextureHandle, public colorAttachment: NriDescriptorHandle,
            public acquireSemaphore: NriFenceHandle, public releaseSemaphore: NriFenceHandle) {
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
        private device: NriDeviceHandle | null = null;
        private queue: NriQueueHandle;
        private frameFence: NriFenceHandle;
        private swapChain: NriSwapChainHandle;
        private swapChainTextures: SwapChainTexture[] = [];
        private queuedFrames: QueuedFrame[] = [];
        private viewFormat: NriFormat = NriFormat.Unknown;
        private depthTexture: NriTextureHandle | null = null;
        private depthAttachment: NriDescriptorHandle | null = null;
        private layout: NriPipelineLayoutHandle | null = null;
        private skyboxPipeline: NriPipelineHandle | null = null;
        private modelPipeline: NriPipelineHandle | null = null;
        private skybox: NriGltfMeshHandle | null = null;
        private object: NriGltfMeshHandle | null = null;
        private envmap: NriTextureHandle | null = null;
        private envmapView: NriDescriptorHandle | null = null;
        private sampler: NriDescriptorHandle | null = null;
        private uniformBuffer: NriBufferHandle | null = null;
        private descriptorPool: NriDescriptorPoolHandle | null = null;
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
        private readbackBuffer: NriBufferHandle | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSampleHandle) {
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
            this.viewFormat = viewFormat;
            for (let i = 0; i < textureNum; i++) {
                const texture = Nri_GetSwapChainTexture(this.swapChain, i);
                this.swapChainTextures.push(new SwapChainTexture(texture, Nri_CreateColorAttachmentView(texture, viewFormat),
                    Nri_CreateSwapChainSemaphore(device), Nri_CreateSwapChainSemaphore(device)));
            }

            // The depth buffer: D32, cleared to 0 (the sample's reversed depth).
            const depthTexture = Nri_CreateDepthTexture(device, this.queue, this.width, this.height, NriFormat.D32_SFLOAT);
            this.depthTexture = depthTexture;
            if (!depthTexture) {
                console.log("Cannot create the depth buffer");
                return 0;
            }
            this.depthAttachment = Nri_CreateDepthAttachmentView(depthTexture, NriFormat.D32_SFLOAT);

            // The models and the cube map, its sampler as the framework's load_texture_cubemap:
            // trilinear, clamped, the device's widest anisotropic filtering.
            this.skybox = Nri_LoadGltfMesh(device, this.queue, CUBE_PATH);
            this.object = Nri_LoadGltfMesh(device, this.queue, OBJECT_PATH);
            const envmap = Nri_LoadDdsTexture(device, this.queue, ENVMAP_PATH, 0);
            this.envmap = envmap;
            if (!this.skybox || !this.object || !envmap) {
                console.log("Cannot load the models and the cube map: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return 0;
            }
            const envmapView = Nri_CreateTextureCubeView(envmap, NriFormat.RGBA16_SFLOAT);
            this.envmapView = envmapView;
            const sampler = Nri_CreateSamplerWithMipFilter(device, NriFilter.Linear, NriFilter.Linear, NriAddressMode.ClampToEdge,
                Nri_GetMaxSamplerAnisotropy(device));
            this.sampler = sampler;
            if (!sampler) {
                console.log("Cannot create the sampler");
                return 0;
            }

            // The layout: the UBO (b0, both shaders'), the cube map (t0) and its sampler (s0).
            const layoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.VertexPixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 0, 1, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 0, 1, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
            const layout = Nri_CreatePipelineLayoutFromDesc(device, layoutDesc);
            Nri_DestroyPipelineLayoutDesc(layoutDesc);
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
            const uniformBuffer = Nri_CreateHostBuffer(device, queuedFrameNum * UBO_VIEW_SIZE, NriBufferUsage.ConstantBuffer);
            this.uniformBuffer = uniformBuffer;
            const descriptorPool = Nri_CreateDescriptorPool(device, queuedFrameNum, queuedFrameNum, queuedFrameNum, queuedFrameNum, 0, 0);
            this.descriptorPool = descriptorPool;
            if (!uniformBuffer || !descriptorPool) {
                console.log("Cannot create the descriptors");
                return 0;
            }
            for (let i = 0; i < queuedFrameNum; i++) {
                const commandAllocator = Nri_CreateCommandAllocator(this.queue);
                const descriptorSet = Nri_AllocateDescriptorSet(descriptorPool, layout, 0, 0);
                const uboView = Nri_CreateConstantBufferView(uniformBuffer, i * UBO_VIEW_SIZE, UBO_VIEW_SIZE);
                this.queuedFrames.push(new QueuedFrame(commandAllocator, Nri_CreateCommandBuffer(commandAllocator), descriptorSet, uboView));
                if (!descriptorSet || !uboView) {
                    console.log("Cannot create the descriptor sets");
                    return 0;
                }
                Nri_UpdateDescriptor(descriptorSet, 0, 0, uboView);
                Nri_UpdateDescriptor(descriptorSet, 1, 0, envmapView);
                Nri_UpdateDescriptor(descriptorSet, 2, 0, sampler);
            }

            if (this.test) {
                const alignment = Nri_GetUploadBufferTextureRowAlignment(device);
                this.rowPitch = Math.floor((this.width * 4 + alignment - 1) / alignment) * alignment;
                this.readbackBuffer = Nri_CreateReadbackBuffer(device, this.rowPitch * this.height);
                this.readbackFormat = format;
            }
            return 1;
        }

        // The sample's prepare_pipelines: position and normal of the glTF loader's vertices; the
        // skybox without depth, back faces culled (counter-clockwise front faces); the object with
        // depth tested (greater: reversed) and written, front faces culled.
        createPipeline(device: NriDeviceHandle, layout: NriPipelineLayoutHandle, shaders: string, isObject: boolean) {
            const permutation = isObject ? "TYPE=1" : "TYPE=0";
            const desc = Nri_CreatePipelineDesc();
            let loaded = Nri_PipelineDescAddShaderPermutation(desc, NriShaderStage.Vertex, `${shaders}_gbuffer_vs.bin`, "gbuffer_vs",
                permutation) != 0;
            if (loaded) {
                loaded = Nri_PipelineDescAddShaderPermutation(desc, NriShaderStage.Pixel, `${shaders}_gbuffer_ps.bin`, "gbuffer_ps",
                    permutation) != 0;
            }
            Nri_PipelineDescAddVertexAttribute(desc, "POSITION", NriFormat.RGB32_SFLOAT, 0);
            Nri_PipelineDescAddVertexAttribute(desc, "NORMAL", NriFormat.RGB32_SFLOAT, NORMAL_OFFSET);
            Nri_PipelineDescSetCullMode(desc, isObject ? NriCullMode.Front : NriCullMode.Back);
            Nri_PipelineDescSetFrontCounterClockwise(desc, 1);
            Nri_PipelineDescSetColor(desc, this.viewFormat, NriColorWrite.RGBA);
            Nri_PipelineDescSetDepth(desc, NriFormat.D32_SFLOAT, isObject ? NriCompareOp.Greater : NriCompareOp.None, isObject ? 1 : 0, 0);
            let pipeline: NriPipelineHandle | null = null;
            if (loaded) {
                pipeline = Nri_CreatePipelineFromDesc(device, layout, desc);
            }
            Nri_DestroyPipelineDesc(desc);
            return pipeline;
        }

        // Waits for the frame that last used this frame's command allocator (and its UBO).
        latencySleep(frameIndex: int) {
            const queuedFrameNum = this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[frameIndex % queuedFrameNum];
            Nri_Wait(this.frameFence, frameIndex >= queuedFrameNum ? 1 + frameIndex - queuedFrameNum : 0);
            Nri_ResetCommandAllocator(queuedFrame.commandAllocator);
        }

        // The camera's mouse handling: the buttons' changes, then the move.
        handleMouse() {
            for (let button = 0; button < 3; button++) {
                const pressed = Nri_IsButtonPressed(this.sample, button) != 0;
                if (pressed != this.buttons[button]) {
                    this.camera.mouseButton(<MouseButton>button, <Action>(pressed ? 1 : 0));
                    this.buttons[button] = pressed;
                }
            }
            this.mouseX += Nri_GetMouseDeltaX(this.sample);
            this.mouseY += Nri_GetMouseDeltaY(this.sample);
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
            Nri_WriteBuffer(uniformBuffer, queuedFrameIndex * UBO_VIEW_SIZE, Ref(this.ubo[0]), UBO_FLOATS * 4);
        }

        // A model with a pipeline (between Nri_CmdBeginRenderingWithDepth and Nri_CmdEndRendering).
        drawMesh(commandBuffer: NriCommandBufferHandle, pipeline: NriPipelineHandle | null, mesh: NriGltfMeshHandle | null) {
            if (!pipeline || !mesh) {
                return;
            }
            Nri_CmdSetPipeline(commandBuffer, pipeline);
            Nri_CmdSetIndexBuffer(commandBuffer, Nri_GetGltfMeshIndexBuffer(mesh), 0, NriIndexType.UInt32);
            Nri_CmdSetVertexBuffer(commandBuffer, 0, Nri_GetGltfMeshVertexBuffer(mesh), 0, VERTEX_SIZE);
            Nri_CmdDrawIndexed(commandBuffer, Nri_GetGltfMeshIndexCount(mesh), 1, 0, 0, 0);
        }

        // The skybox, the object.
        recordDraw(commandBuffer: NriCommandBufferHandle, queuedFrame: QueuedFrame) {
            const layout = this.layout;
            const descriptorPool = this.descriptorPool;
            const descriptorSet = queuedFrame.descriptorSet;
            if (!layout || !descriptorPool || !descriptorSet) {
                return;
            }
            Nri_CmdSetViewport(commandBuffer, 0.0, 0.0, this.width, this.height);
            Nri_CmdSetScissor(commandBuffer, 0, 0, this.width, this.height);
            Nri_CmdSetDescriptorPool(commandBuffer, descriptorPool);
            Nri_CmdSetPipelineLayout(commandBuffer, layout);
            Nri_CmdSetDescriptorSet(commandBuffer, 0, descriptorSet);
            this.drawMesh(commandBuffer, this.skyboxPipeline, this.skybox);
            this.drawMesh(commandBuffer, this.modelPipeline, this.object);
        }

        renderFrame(frameIndex: int) {
            const queuedFrameIndex = frameIndex % this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            this.handleMouse();
            this.writeUbo(queuedFrameIndex);

            // Acquire a swap chain texture
            const acquireSemaphore = this.swapChainTextures[frameIndex % this.swapChainTextures.length].acquireSemaphore;
            const index = Nri_AcquireNextTexture(this.swapChain, acquireSemaphore);
            const depthAttachment = this.depthAttachment;
            if (index >= 0) {
                const swapChainTexture = this.swapChainTextures[index];
                const commandBuffer = queuedFrame.commandBuffer;

                // Record: color cleared to transparent black, depth to 0 (reversed); the skybox and
                // the object.
                Nri_BeginCommandBuffer(commandBuffer);
                Nri_CmdTextureBarrier(commandBuffer, swapChainTexture.texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                if (depthAttachment) {
                    Nri_CmdBeginRenderingWithDepth(commandBuffer, swapChainTexture.colorAttachment, depthAttachment);
                    Nri_CmdClearColor(commandBuffer, 0.0, 0.0, 0.0, 0.0);
                    Nri_CmdClearDepth(commandBuffer, 0.0);
                    this.recordDraw(commandBuffer, queuedFrame);
                    Nri_CmdEndRendering(commandBuffer);
                }

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
                    Nri_DestroyCommandBuffer(queuedFrame.commandBuffer);
                    Nri_DestroyCommandAllocator(queuedFrame.commandAllocator);
                    this.destroyDescriptor(queuedFrame.uboView);
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
                this.destroyDescriptor(this.depthAttachment);
                this.destroyDescriptor(this.envmapView);
                this.destroyDescriptor(this.sampler);
                this.destroyTexture(this.depthTexture);
                this.destroyTexture(this.envmap);
                this.destroyMesh(this.skybox);
                this.destroyMesh(this.object);
                this.destroyBuffer(this.uniformBuffer);
                this.destroyBuffer(this.readbackBuffer);
                this.destroyPipeline(this.skyboxPipeline);
                this.destroyPipeline(this.modelPipeline);
                const layout = this.layout;
                if (layout) {
                    Nri_DestroyPipelineLayout(layout);
                }
                Nri_DestroyFence(this.frameFence);
                Nri_DestroySwapChain(this.swapChain);
                Nri_DestroyDevice(device);
            }
            Nri_DestroySample(this.sample);
        }

        destroyDescriptor(descriptor: NriDescriptorHandle | null) {
            if (descriptor) {
                Nri_DestroyDescriptor(descriptor);
            }
        }

        destroyTexture(texture: NriTextureHandle | null) {
            if (texture) {
                Nri_DestroyTexture(texture);
            }
        }

        destroyMesh(mesh: NriGltfMeshHandle | null) {
            if (mesh) {
                Nri_DestroyGltfMesh(mesh);
            }
        }

        destroyBuffer(buffer: NriBufferHandle | null) {
            if (buffer) {
                Nri_DestroyBuffer(buffer);
            }
        }

        destroyPipeline(pipeline: NriPipelineHandle | null) {
            if (pipeline) {
                Nri_DestroyPipeline(pipeline);
            }
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = Nri_CreateSample();
        const dynamicRendering = new DynamicRendering(sample);
        return dynamicRendering.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return DynamicRenderingNri.main(argc, argv);
}
