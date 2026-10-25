// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";
import { Args } from "../core/args";
import { TestCheck, unsupported } from "../core/test_check";
import { radians, perspective } from "../core/matrix";
import { FirstPersonCamera } from "../core/vulkan_samples_camera";

namespace FragmentShadingRateDynamic {
    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    // -test: checks the last frame: the cubes with the Vulkan logo over the sky, about 13% of it
    // red and 31% white.
    function checkFrame(app: App) {
        const check = new TestCheck(app);
        if (check.frameRead() != "") {
            return check.frameRead();
        }
        const total = check.width * check.height;
        const red = check.share(check.countInRange(151, 255, 0, 89, 0, 89, 0, 0, check.width, check.height), total,
            8.0, 18.0, "Red");
        if (red != "") {
            return red;
        }
        return check.share(check.countInRange(221, 255, 221, 255, 221, 255, 0, 0, check.width, check.height), total,
            20.0, 40.0, "White");
    }

    const WINDOW_TITLE = "Donut Example: Dynamic Fragment Shading Rate";

    // The sample's models and textures (Vulkan-Samples' assets), the KTX textures converted to DDS
    // at build time (see VULKAN_SAMPLES_ASSETS_DIR in CMakeLists.txt).
    const MEDIA_DIR = "media/fragment_shading_rate_dynamic/";
    const SKYSPHERE_PATH = MEDIA_DIR + "geosphere.gltf";
    const SCENE_PATH = MEDIA_DIR + "textured_unit_cube.gltf";
    const SKYSPHERE_TEXTURE_PATH = MEDIA_DIR + "skysphere_rgba.dds";
    const SCENE_TEXTURE_PATH = MEDIA_DIR + "vulkan_logo_full.dds";

    // Donut_LoadGltfMesh's vertices: float3 position, float3 normal, float2 texture coordinates.
    const VERTEX_SIZE = 8 * 4;

    // struct UBOScene { float4x4 projection, modelview, skysphere_modelview; int color_shading_rate; },
    // padded.
    const UBO_PROJECTION = 0;
    const UBO_MODELVIEW = 16;
    const UBO_SKYSPHERE_MODELVIEW = 32;
    const UBO_COLOR_SHADING_RATE = 48;
    const UBO_FLOATS = 52;
    // The push constants: float4 offset; int object_type.
    const PUSH_FLOATS = 5;
    const PUSH_SIZE = PUSH_FLOATS * 4;
    enum ObjectKind {
        Skysphere = 0,
        Cube = 1
    }

    // The three cubes' offsets.
    const MESH_OFFSETS = [-2.5, 0.0, 0.0, 0.0, 0.0, 0.0, 2.5, 0.0, 0.0];

    // The sample's first person camera at (0, 0, -4) (the view's translation), a 60 degree vertical
    // field of view, depth reversed (near 256, far 0.1, as the sample passes them).
    const CAMERA_POSITION = [0.0, 0.0, -4.0];
    const CAMERA_FOV = 60.0;
    const Z_NEAR = 256.0;
    const Z_FAR = 0.1;

    // The compute shader's 8 x 8 thread groups.
    const GROUP_SIZE = 8;

    const SUBPASS_RATIOS = "1|2|4|8|16";
    const VISUALIZE_NAMES = "Render output|Shading Rates|Frequency channel";

    // --- Pass -------------------------------------------------------------------------------

    // Port of Vulkan-Samples' fragment_shading_rate_dynamic: a sky sphere and three textured,
    // lit cubes drawn with a shading rate image (a texel per tile of pixels) that a compute shader
    // makes from the frequency content of the picture: each draw also writes its color's squared
    // screen-space derivatives, and the tiles where they're low get coarser rates. To keep the rates
    // from feeding back on themselves, the frequency content comes from a second, reduced size pass
    // at the full rate, which the sample draws into the corner of the same targets; the compute
    // shader reads that corner. Each back buffer has its own shading rate, frequency and compute
    // images, as the sample has per swap chain image: a frame uses the rates its back buffer's
    // previous frame made, and shows the frequency content of the frame before.
    //
    // NVRHI's targets are of one size, so the reduced size pass draws into targets of its own,
    // copied into the corners. D3D12 (tier 2) or Vulkan (VK_KHR_fragment_shading_rate).
    class FragmentShadingRateDynamicPass {
        private app: App;
        private camera: FirstPersonCamera;

        // The sample's settings, from its UI.
        enableAttachmentShadingRate: boolean;
        displaySkySphere: boolean;
        subpassExtentRatio: int;
        colorShadingRate: int;
        // Set by init() when the device lacks a feature it needs ("" otherwise).
        unsupportedReason: string;

        // The device's shading rates (width, height pairs, largest first) and the shading rate
        // image's tile size.
        private rates: int[];
        private rateCount: int;
        private tileSize: int;

        private sceneVS: ShaderHandle;
        private scenePS: ShaderHandle;
        private inputLayout: InputLayoutHandle;
        private skysphereMesh: GltfMesh;
        private sceneMesh: GltfMesh;
        private skyspherePipeline: GraphicsPipelineHandle;
        private cubePipeline: GraphicsPipelineHandle;
        private renderBindingLayout: BindingLayoutHandle;
        private computePipeline: ComputePipelineHandle;
        private computeBindingLayout: BindingLayoutHandle;
        private uniformBuffer: BufferHandle;
        private skysphereTexture: TextureHandle;
        private sceneTexture: TextureHandle;
        private textureSampler: SamplerHandle;

        // The targets, for the back buffers' size and the subpass ratio (width 0: none yet): per
        // back buffer, its shading rate image, the compute shader's copy of it, its frequency
        // content, the full size pass's framebuffer, the binding sets; then the shared depth buffer,
        // the reduced size pass's targets, and the compute shader's parameters.
        private targetWidth: int;
        private targetHeight: int;
        private targetRatio: int;
        private resources: ResourceHandle[];
        private shadingRateImages: TextureHandle[];
        private shadingRateComputeImages: TextureHandle[];
        private frequencyImages: TextureHandle[];
        private framebuffers: FramebufferHandle[];
        private renderBindingSets: BindingSet[];
        private computeBindingSets: BindingSet[];
        private depth: TextureHandle;
        private smallColor: TextureHandle;
        private smallFrequency: TextureHandle;
        private smallDepth: TextureHandle;
        private smallFramebuffer: FramebufferHandle;
        private subpassWidth: int;
        private subpassHeight: int;
        private shadingRateWidth: int;
        private shadingRateHeight: int;
        // The shading rate images' first contents: the lowest rate (the device's first, largest).
        private initialRateCode: int;

        // Upload buffers.
        private ubo: f32[];
        private push: f32[];

        constructor(app: App) {
            this.app = app;
            this.camera = new FirstPersonCamera(CAMERA_POSITION, [0.0, 0.0, 0.0]);
            this.enableAttachmentShadingRate = true;
            this.displaySkySphere = true;
            this.subpassExtentRatio = 4;
            this.colorShadingRate = 0;
            this.unsupportedReason = "";
            this.rates = [];
            for (let i = 0; i < 32; i++) {
                this.rates.push(0);
            }
            this.rateCount = 0;
            this.tileSize = 1;
            this.targetWidth = 0;
            this.targetHeight = 0;
            this.targetRatio = 0;
            this.resources = [];
            this.shadingRateImages = [];
            this.shadingRateComputeImages = [];
            this.frequencyImages = [];
            this.framebuffers = [];
            this.renderBindingSets = [];
            this.computeBindingSets = [];
            this.subpassWidth = 0;
            this.subpassHeight = 0;
            this.shadingRateWidth = 0;
            this.shadingRateHeight = 0;
            this.initialRateCode = 0;
            this.ubo = [];
            for (let i = 0; i < UBO_FLOATS; i++) {
                this.ubo.push(0.0);
            }
            this.push = [];
            for (let i = 0; i < PUSH_FLOATS; i++) {
                this.push.push(0.0);
            }
        }

        init() {
            this.rateCount = this.app.getFragmentShadingRates(Ref(this.rates[0]));
            this.tileSize = this.app.getShadingRateTileSize();
            if (this.rateCount == 0 || this.tileSize == 0) {
                this.unsupportedReason = "The graphics device has no variable rate shading with shading rate images";
                return false;
            }
            // (min_shading_rate.height >> 1) | ((min_shading_rate.width << 1) & 12).
            this.initialRateCode = (this.rates[1] >> 1) | ((this.rates[0] << 1) & 12);

            const shader = "fragment_shading_rate_dynamic.hlsl";
            this.sceneVS = this.app.createShader(shader, "scene_vs", ShaderType.Vertex);
            this.scenePS = this.app.createShader(shader, "scene_ps", ShaderType.Pixel);
            const computeShader = this.app.createShader("fragment_shading_rate_dynamic_compute.hlsl", "generate_cs", ShaderType.Compute);
            if (!this.sceneVS || !this.scenePS || !computeShader) {
                return false;
            }

            const layoutDesc = InputLayoutDesc.create();
            layoutDesc.addVertexAttribute("POSITION", Format.RGB32_FLOAT, 0, 0, VERTEX_SIZE);
            layoutDesc.addVertexAttribute("NORMAL", Format.RGB32_FLOAT, 12, 0, VERTEX_SIZE);
            layoutDesc.addVertexAttribute("TEXCOORD", Format.RG32_FLOAT, 24, 0, VERTEX_SIZE);
            this.inputLayout = this.app.createInputLayout(layoutDesc, this.sceneVS);

            this.uniformBuffer = this.app.createVolatileConstantBuffer(UBO_FLOATS * 4, "UBOScene");
            const renderLayoutDesc = BindingLayoutDesc.create();
            renderLayoutDesc.layoutVolatileConstantBuffer(0);
            renderLayoutDesc.layoutTextureSRV(0);
            renderLayoutDesc.layoutSampler(0);
            renderLayoutDesc.layoutTextureSRV(1);
            renderLayoutDesc.layoutSampler(1);
            renderLayoutDesc.layoutTextureUAV(0);
            renderLayoutDesc.layoutPushConstants(1, PUSH_SIZE);
            this.renderBindingLayout = this.app.createBindingLayout(renderLayoutDesc, ShaderType.All);

            const computeLayoutDesc = BindingLayoutDesc.create();
            computeLayoutDesc.layoutTextureUAV(0);
            computeLayoutDesc.layoutTextureUAV(1);
            computeLayoutDesc.layoutStructuredBufferSRV(0);
            this.computeBindingLayout = this.app.createBindingLayout(computeLayoutDesc, ShaderType.Compute);
            this.computePipeline = this.app.createComputePipelineWithLayout(computeShader, this.computeBindingLayout);

            // ApiVulkanSample::load_texture's sampler: linear, repeating, anisotropic at the device's
            // most.
            this.textureSampler = this.app.createSamplerWithDesc(1, 1, 1, SamplerAddressMode.Wrap, 0.0, 0.0, 1000.0,
                this.app.getMaxSamplerAnisotropy());

            const commandList = this.app.createCommandList();
            commandList.open();
            this.skysphereMesh = this.app.loadGltfMesh(commandList, SKYSPHERE_PATH);
            this.sceneMesh = this.app.loadGltfMesh(commandList, SCENE_PATH);
            // As the framework loads KTX 1 color textures: as sRGB.
            this.skysphereTexture = this.app.loadTexture(commandList, SKYSPHERE_TEXTURE_PATH, 1);
            this.sceneTexture = this.app.loadTexture(commandList, SCENE_TEXTURE_PATH, 1);
            this.createTargets(commandList, this.app.getWindowWidth(), this.app.getWindowHeight());
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.waitForIdle();
            this.app.releaseResource(commandList.handle);
            if (this.skysphereMesh.isNull() || this.sceneMesh.isNull() || !this.skysphereTexture || !this.sceneTexture) {
                console.log("Cannot load the models and textures: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return false;
            }

            const pass = this.app.addPass();
            pass.setKeyboardCallback(this.onKey);
            pass.setMousePosCallback(this.onMousePos);
            pass.setMouseButtonCallback(this.onMouseButton);
            pass.setAnimateCallback(this.onAnimate);
            pass.setBackBufferResizingCallback(this.onBackBufferResizing);
            pass.setRenderCallback(this.onRender);
            return true;
        }

        // The reduced size pass's size, for the UI's placement.
        getSubpassHeight() {
            return this.subpassHeight;
        }

        onKey(key: Key, scancode: int, action: Action, mods: KeyMods) {
            this.camera.key(key, action);
            return 1;
        }

        onMousePos(x: number, y: number) {
            this.camera.mouseMove(x, y);
            return 1;
        }

        onMouseButton(button: MouseButton, action: Action, mods: KeyMods) {
            this.camera.mouseButton(button, action);
            return 1;
        }

        onAnimate(elapsedSeconds: number) {
            this.camera.update(elapsedSeconds);
            this.app.setInformativeWindowTitle(WINDOW_TITLE);
        }

        // The framebuffers of the back buffers go before the back buffers do.
        onBackBufferResizing() {
            this.releaseTargets();
        }

        releaseTargets() {
            for (const resource of this.resources) {
                this.app.releaseResource(resource);
            }
            this.resources = [];
            this.shadingRateImages = [];
            this.shadingRateComputeImages = [];
            this.frequencyImages = [];
            this.framebuffers = [];
            this.renderBindingSets = [];
            this.computeBindingSets = [];
            this.targetWidth = 0;
        }

        own<T extends ResourceHandle>(resource: T) {
            this.resources.push(resource);
            return resource;
        }

        // The sample's create_shading_rate_attachment, setup_framebuffer, update_compute_pipeline
        // and setup_descriptor_sets, recorded into an open command list.
        createTargets(commandList: CommandList, width: int, height: int) {
            this.app.waitForIdle();
            this.releaseTargets();

            const ratio = this.subpassExtentRatio;
            this.subpassWidth = Math.ceil(width / ratio);
            this.subpassHeight = Math.ceil(height / ratio);
            this.shadingRateWidth = Math.ceil(width / this.tileSize);
            this.shadingRateHeight = Math.ceil(height / this.tileSize);

            const colorFormat = this.app.getBackBufferFormat();
            this.depth = this.own(this.app.createDepthTexture(width, height, Format.D32, 0.0, "Depth"));
            const count = this.app.getBackBufferCount();
            for (let i = 0; i < count; i++) {
                const shadingRateImage = this.own(this.app.createShadingRateSurface(this.shadingRateWidth, this.shadingRateHeight));
                commandList.clearTextureUInt(shadingRateImage, this.initialRateCode);
                this.shadingRateImages.push(shadingRateImage);
                this.shadingRateComputeImages.push(this.own(this.app.createUAVTextureWithFormat(this.shadingRateWidth,
                    this.shadingRateHeight, Format.R8_UINT, `Shading Rate Compute ${i}`)));
                const frequency = this.own(this.app.createRenderTargetUAVTexture(width, height, Format.RG8_UINT, `Frequency ${i}`));
                commandList.clearTextureUInt(frequency, 0);
                this.frequencyImages.push(frequency);
                this.framebuffers.push(this.own(this.app.createFramebufferWithShadingRate(this.app.getBackBuffer(i), frequency,
                    this.depth, shadingRateImage)));
            }

            // The reduced size pass's targets.
            this.smallColor = this.own(this.app.createMultisampledTexture(this.subpassWidth, this.subpassHeight, colorFormat, 1, 0.0,
                "Subpass Color"));
            this.smallFrequency = this.own(this.app.createRenderTargetUAVTexture(this.subpassWidth, this.subpassHeight,
                Format.RG8_UINT, "Subpass Frequency"));
            this.smallDepth = this.own(this.app.createDepthTexture(this.subpassWidth, this.subpassHeight, Format.D32, 0.0,
                "Subpass Depth"));
            this.smallFramebuffer = this.own(this.app.createFramebufferWithShadingRate(this.smallColor, this.smallFrequency,
                this.smallDepth, null));

            // The compute shader's parameters: the frequency (reduced size) and shading rate images'
            // sizes, the largest rate, the rate count, the rates.
            let maxRateX: int = 0;
            let maxRateY: int = 0;
            for (let r = 0; r < this.rateCount; r++) {
                maxRateX = Math.max(maxRateX, this.rates[r * 2]);
                maxRateY = Math.max(maxRateY, this.rates[r * 2 + 1]);
            }
            const params: int[] = [this.subpassWidth, this.subpassHeight, this.shadingRateWidth, this.shadingRateHeight,
                maxRateX, maxRateY, this.rateCount, 0];
            for (let r = 0; r < this.rateCount * 2; r++) {
                params.push(this.rates[r]);
            }
            const paramsBuffer = this.app.createStructuredBuffer(8, params.length / 2, "FrequencyInformation");
            this.own(paramsBuffer);
            commandList.writeBuffer(paramsBuffer, Ref(params[0]), params.length * 4);

            for (let i = 0; i < count; i++) {
                const computeSetDesc = BindingSetDesc.create();
                computeSetDesc.bindTextureUAV(0, this.frequencyImages[i]);
                computeSetDesc.bindTextureUAV(1, this.shadingRateComputeImages[i]);
                computeSetDesc.bindStructuredBufferSRV(0, paramsBuffer);
                const computeSet = this.app.createBindingSetForLayout(computeSetDesc, this.computeBindingLayout);
                this.own(computeSet.handle);
                this.computeBindingSets.push(computeSet);

                // The previous back buffer's frequency content, to show.
                const previous = (i + count - 1) % count;
                const renderSetDesc = BindingSetDesc.create();
                renderSetDesc.bindEntireConstantBuffer(0, this.uniformBuffer);
                renderSetDesc.bindTextureSRV(0, this.skysphereTexture);
                renderSetDesc.bindSampler(0, this.textureSampler);
                renderSetDesc.bindTextureSRV(1, this.sceneTexture);
                renderSetDesc.bindSampler(1, this.textureSampler);
                renderSetDesc.bindTextureUAV(0, this.frequencyImages[previous]);
                renderSetDesc.bindPushConstants(1, PUSH_SIZE);
                const renderSet = this.app.createBindingSetForLayout(renderSetDesc, this.renderBindingLayout);
                this.own(renderSet.handle);
                this.renderBindingSets.push(renderSet);
            }

            // The pipelines: their framebuffers' layouts are the full and reduced passes' both.
            if (this.targetRatio == 0) {
                for (let cube = 0; cube < 2; cube++) {
                    const desc = GraphicsPipelineDesc.create(this.sceneVS, this.scenePS);
                    desc.setInputLayout(this.inputLayout);
                    desc.addBindingLayout(this.renderBindingLayout);
                    desc.setVariableRateShading(true);
                    if (cube == 1) {
                        // Depth tested (greater: reversed) and written, front faces culled.
                        desc.setDepthState(1, 1, ComparisonFunc.Greater);
                        desc.setRasterState(CullMode.Front, FillMode.Solid, 1);
                    } else {
                        desc.setDepthState(0, 0, ComparisonFunc.Greater);
                        desc.setRasterState(CullMode.Back, FillMode.Solid, 1);
                    }
                    const pipeline = this.app.createGraphicsPipelineFromDesc(desc, this.framebuffers[0]);
                    if (cube == 1) {
                        this.cubePipeline = pipeline;
                    } else {
                        this.skyspherePipeline = pipeline;
                    }
                }
            }

            this.targetWidth = width;
            this.targetHeight = height;
            this.targetRatio = ratio;
        }

        // The sample's build_command_buffer for one target: the sky sphere (if shown) and the three
        // cubes, each draw's shading rate the attachment's (Override) or the pipeline's 1x1.
        drawScene(frame: Frame, framebuffer: FramebufferHandle, bindingSet: BindingSet, useAttachment: boolean) {
            const imageCombiner = useAttachment ? ShadingRateCombiner.Override : ShadingRateCombiner.Passthrough;
            if (this.displaySkySphere) {
                frame.beginDrawToFramebuffer(this.skyspherePipeline, framebuffer);
                frame.drawSetVariableRateShading(true, VariableShadingRate.Rate1x1, ShadingRateCombiner.Passthrough, imageCombiner);
                frame.drawAddBindingSet(bindingSet);
                frame.drawSetIndexBuffer(this.skysphereMesh.getIndexBuffer());
                frame.drawAddVertexBuffer(this.skysphereMesh.getVertexBuffer(), 0, 0);
                this.push[0] = 0.0;
                this.push[1] = 0.0;
                this.push[2] = 0.0;
                this.push[3] = 0.0;
                Donut_StoreInt32(Ref(this.push[4]), ObjectKind.Skysphere);
                frame.drawIndexedWithPushConstants(this.skysphereMesh.getIndexCount(), Ref(this.push[0]), PUSH_SIZE);
            }
            frame.beginDrawToFramebuffer(this.cubePipeline, framebuffer);
            frame.drawSetVariableRateShading(true, VariableShadingRate.Rate1x1, ShadingRateCombiner.Passthrough, imageCombiner);
            frame.drawAddBindingSet(bindingSet);
            frame.drawSetIndexBuffer(this.sceneMesh.getIndexBuffer());
            frame.drawAddVertexBuffer(this.sceneMesh.getVertexBuffer(), 0, 0);
            for (let j = 0; j < 3; j++) {
                this.push[0] = MESH_OFFSETS[j * 3];
                this.push[1] = MESH_OFFSETS[j * 3 + 1];
                this.push[2] = MESH_OFFSETS[j * 3 + 2];
                this.push[3] = 0.0;
                Donut_StoreInt32(Ref(this.push[4]), ObjectKind.Cube);
                frame.drawIndexedWithPushConstants(this.sceneMesh.getIndexCount(), Ref(this.push[0]), PUSH_SIZE);
            }
        }

        onRender(frameHandle: FrameHandle) {
            const frame = new Frame(frameHandle);
            const width = frame.getWidth();
            const height = frame.getHeight();
            const commandList = frame.getCommandList();

            if (this.targetWidth != width || this.targetHeight != height || this.targetRatio != this.subpassExtentRatio) {
                this.createTargets(commandList, width, height);
            }

            // The sample's update_uniform_buffers: its projection (clip y negated for Donut) and
            // view.
            const projection = perspective(radians(CAMERA_FOV), width / height, Z_NEAR, Z_FAR);
            const view = this.camera.view();
            const u = this.ubo;
            for (let i = 0; i < 16; i++) {
                u[UBO_PROJECTION + i] = i % 4 == 1 ? -projection[i] : projection[i];
                u[UBO_MODELVIEW + i] = view[i];
                u[UBO_SKYSPHERE_MODELVIEW + i] = view[i];
            }
            Donut_StoreInt32(Ref(u[UBO_COLOR_SHADING_RATE]), this.colorShadingRate);
            commandList.writeBuffer(this.uniformBuffer, Ref(u[0]), UBO_FLOATS * 4);

            // The full size pass, with the shading rate image (color and frequency cleared to 0,
            // depth to 0).
            const index = this.app.getCurrentBackBufferIndex();
            const backBuffer = this.app.getBackBuffer(index);
            commandList.beginMarker("Full size pass");
            commandList.clearTextureFloat(backBuffer, 0.0, 0.0, 0.0, 0.0);
            commandList.clearTextureUInt(this.frequencyImages[index], 0);
            commandList.clearDepth(this.depth, 0.0);
            this.drawScene(frame, this.framebuffers[index], this.renderBindingSets[index], this.enableAttachmentShadingRate);
            commandList.endMarker();

            // The reduced size pass, at the full rate, into the corner of the targets.
            commandList.beginMarker("Reduced size pass");
            commandList.clearTextureFloat(this.smallColor, 0.0, 0.0, 0.0, 0.0);
            commandList.clearTextureUInt(this.smallFrequency, 0);
            commandList.clearDepth(this.smallDepth, 0.0);
            this.drawScene(frame, this.smallFramebuffer, this.renderBindingSets[index], false);
            commandList.copyTextureRegion(backBuffer, 0, 0, 0, this.smallColor, 0, 0, 0, this.subpassWidth, this.subpassHeight);
            commandList.copyTextureRegion(this.frequencyImages[index], 0, 0, 0, this.smallFrequency, 0, 0, 0,
                this.subpassWidth, this.subpassHeight);
            commandList.endMarker();

            // The compute shader: the next shading rates from the reduced pass's frequency content,
            // copied into the shading rate image.
            commandList.beginMarker("Generate shading rate");
            commandList.dispatch(this.computePipeline, this.computeBindingSets[index],
                Math.floor((this.shadingRateWidth + GROUP_SIZE - 1) / GROUP_SIZE),
                Math.floor((this.shadingRateHeight + GROUP_SIZE - 1) / GROUP_SIZE), 1);
            commandList.copyTextureRegion(this.shadingRateImages[index], 0, 0, 0, this.shadingRateComputeImages[index], 0, 0, 0,
                this.shadingRateWidth, this.shadingRateHeight);
            commandList.endMarker();
        }
    }

    // The sample's settings, placed below the reduced size pass's corner (which the sample draws
    // over its UI).
    class UserInterface {
        private pass: FragmentShadingRateDynamicPass;

        constructor(pass: FragmentShadingRateDynamicPass) {
            this.pass = pass;
        }

        init(app: App) {
            return !app.addImGuiPass(this.buildUI).isNull();
        }

        buildUI() {
            const p = this.pass;
            Donut_ImGuiSetNextWindowPos(10.0, p.getSubpassHeight() + 10.0);
            Donut_ImGuiBegin("Options", true);
            if (Donut_ImGuiCollapsingHeaderDefaultOpen("Settings")) {
                p.enableAttachmentShadingRate = Donut_ImGuiCheckbox("Enable attachment shading rate",
                    p.enableAttachmentShadingRate);
                let selection = 0;
                while ((1 << (selection + 1)) <= p.subpassExtentRatio && selection < 4) {
                    selection++;
                }
                selection = Donut_ImGuiCombo("Subpass size reduction", selection, SUBPASS_RATIOS);
                p.subpassExtentRatio = 1 << selection;
                p.colorShadingRate = Donut_ImGuiCombo("Data visualize", p.colorShadingRate, VISUALIZE_NAMES);
                p.displaySkySphere = Donut_ImGuiCheckbox("sky-sphere", p.displaySkySphere);
            }
            Donut_ImGuiEnd();
        }
    }

    class FragmentShadingRateDynamicArgs extends Args {
        // -visualize <n>: 0 the render output, 1 the shading rates, 2 the frequency content.
        visualize = 0;
        // -ratio <n>: the reduced size pass's ratio (1, 2, 4, 8 or 16).
        ratio = 4;
        // -noattachment: the full rate everywhere.
        noAttachment = false;
        // -nosky: without the sky sphere.
        noSky = false;

        protected parseOptions() {
            for (let i = 1; i < this.argc; i++) {
                const arg = this[i];
                if (arg == "-visualize" && i + 1 < this.argc) {
                    this.visualize = Math.min(2, Math.max(0, parseInt(this[i + 1])));
                    i++;
                } else if (arg == "-ratio" && i + 1 < this.argc) {
                    this.ratio = Math.min(16, Math.max(1, parseInt(this[i + 1])));
                    i++;
                } else if (arg == "-noattachment") {
                    this.noAttachment = true;
                } else if (arg == "-nosky") {
                    this.noSky = true;
                }
            }
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("fragment_shading_rate_dynamic");

        const args = new FragmentShadingRateDynamicArgs(argc, argv, TEST_FRAMES);
        args.parseArgs();

        const app = App.createWithOptions(args.api, WINDOW_TITLE, 1280, 720, args.options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        if (!app.isFeatureSupported(Feature.VariableRateShading)) {
            app.destroy();
            return unsupported(args.test, "The graphics device has no variable rate shading (D3D12 tier 2 or Vulkan's VK_KHR_fragment_shading_rate)");
        }

        const pass = new FragmentShadingRateDynamicPass(app);
        pass.subpassExtentRatio = args.ratio;
        if (!pass.init()) {
            app.destroy();
            return pass.unsupportedReason != "" ? unsupported(args.test, pass.unsupportedReason) : 1;
        }
        pass.colorShadingRate = args.visualize;
        pass.enableAttachmentShadingRate = !args.noAttachment;
        pass.displaySkySphere = !args.noSky;

        // Drawn after (over) the scene, and sees the mouse first.
        const gui = new UserInterface(pass);
        if (!args.noUI &&!gui.init(app)) {
            console.log("Cannot initialize the user interface");
            app.destroy();
            return 1;
        }

        const input = new InputPass(app.handle);

        app.run();
        let result = 0;
        if (args.test) {
            result = app.finishTest(checkFrame(app));
        }
        app.destroy();
        return result;
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return FragmentShadingRateDynamic.main(argc, argv);
}
