/// <reference path="../../core/nri/nri_interop.d.ts" />
import { NriFrameRing } from "../../core/nri_frame_ring";
import { NriSwapChain } from "../../core/nri_swap_chain";
import { TranscodedTexture } from "../../core/transcoded_texture";
import { multiply, reversedPerspective, vulkanStyleProjection, toDonutClip } from "../../core/matrix";
import { DonutFirstPersonCamera } from "../../core/donut_first_person_camera";
import { Nri, NriBuffer, NriCommandBuffer, NriDescriptor, NriDescriptorPool, NriDescriptorSet, NriDevice, NriFile, NriGltfModel, NriImgui, NriPipeline, NriPipelineDesc, NriPipelineLayout, NriPipelineLayoutDesc, NriQueue, NriSample, NriTexture, NriTextureLevels } from "../../core/nri";

namespace TextureCompressionComparisonNri {
    // texture_compression_comparison, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework
    // instead of Donut and NVRHI: the same shaders (msaa.hlsl's, compiled for the Donut example), scene
    // (read as Donut's loadGltfModel reads it), KTX 2 textures and Basis Universal transcoder
    // (core/basis_transcoder.cpp, compiled into nri_interop), through the NRI calls
    // core/nri/nri_interop.d.ts binds, with NRIFramework's ImGui for the sample's options window. This
    // example creates everything it runs, and does the rendering.

    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    const WINDOW_TITLE = "NRI Example: Texture Compression Comparison";

    // The sample's scene (Vulkan-Samples' assets, copied at build time, see VULKAN_SAMPLES_ASSETS_DIR
    // in CMakeLists.txt): Sponza, its images loaded from the Basis Universal KTX 2 files beside it
    // (ktx2/<image name>2) rather than from the KTX 1 files it names.
    const SCENE_DIR = "media/texture_compression_comparison/sponza/";
    const SCENE_PATH = SCENE_DIR + "Sponza01.gltf";

    // NriGltfModel.load's vertices: float3 position, float3 normal, float2 texture coordinates.
    const VERTEX_FLOATS = 8;
    const VERTEX_SIZE = VERTEX_FLOATS * 4;
    const NORMAL_OFFSET = 12;
    const TEXCOORD_OFFSET = 24;

    // struct SceneConstants { float4x4 viewProj; float4 lightColor, lightDirection; }, as f32
    // offsets (msaa.hlsl's: the framework's base.vert and base.frag), a queued frame's in a constant
    // buffer view of CONST_VIEW_SIZE bytes (a multiple of 256, D3D12's).
    const CONST_VIEW_PROJ = 0;
    const CONST_LIGHT_COLOR = 16;
    const CONST_LIGHT_DIRECTION = 20;
    const CONST_FLOATS = 24;
    const CONST_VIEW_SIZE = 256;
    // The draws' push constants (b1: root constants): their node's transform.
    const MODEL_FLOATS = 16;
    const MODEL_SIZE = MODEL_FLOATS * 4;

    // The framework's depth format (get_suitable_depth_format's first choice), reversed.
    const DEPTH_FORMAT = NriFormat.D32_SFLOAT;

    // The scene's camera node (main_camera): position, and orientation (x, y, z, w), its
    // perspective's vertical field of view and depth range.
    const CAMERA_POSITION = [-705.01001, 195.20282, -119.932266];
    const CAMERA_ROTATION = [-0.004728, -0.775409, -0.005807, 0.631416];
    const CAMERA_FOV = 1.0;
    const Z_NEAR = 1.0;
    const Z_FAR = 4000.0;
    // The sample's free camera: 50 units per step, times its speed multiplier of 3, per second;
    // Donut's FirstPersonCamera's rotation speed.
    const CAMERA_MOVE_SPEED = 150.0;
    const CAMERA_ROTATE_SPEED = 0.005;

    // The scene's directional light: white, intensity 1, on a node with this rotation (x, y, z, w).
    const LIGHT_COLOR = [1.0, 1.0, 1.0, 1.0];
    const LIGHT_ROTATION = [-0.683013, -0.183013, 0.183013, 0.683013];

    // The sample's formats: the transcoder's target, the texture format (Unknown: none, as NVRHI has
    // no ASTC or ETC2 format, so the Donut example offers neither), their names (libktx's, and short).
    const TRANSCODE_FORMATS = [TranscodeFormat.RGBA32, TranscodeFormat.BC7, TranscodeFormat.BC3, TranscodeFormat.ASTC4x4,
        TranscodeFormat.ETC2];
    const TEXTURE_FORMATS = [NriFormat.RGBA8_SRGB, NriFormat.BC7_RGBA_SRGB, NriFormat.BC3_RGBA_SRGB, NriFormat.Unknown,
        NriFormat.Unknown];
    const FORMAT_NAMES = ["KTX_TTF_RGBA32", "KTX_TTF_BC7_RGBA", "KTX_TTF_BC3_RGBA", "KTX_TTF_ASTC_4x4_RGBA", "KTX_TTF_ETC2_RGBA"];
    const SHORT_NAMES = ["RGBA 32", "BC7", "BC3", "ASTC 4x4", "ETC2"];
    // nri::FormatSupportBits::TEXTURE (NVRHI's FormatSupport::Texture).
    const FORMAT_SUPPORT_TEXTURE = 0x1;

    // Bounds start out inverted.
    const HUGE = 1.0e30;

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // The share of the pixels in [low, high], as the Donut example's TestCheck.share reports it.
    function share(count: int, total: int, low: number, high: number, name: string) {
        const percent = 100.0 * count / total;
        console.log(`${name}: ${percent}% (${count} of ${total} pixels)`);
        if (percent < low || percent > high) {
            return `${name}: ${percent}% of the pixels, not ${low}% to ${high}%`;
        }
        return "";
    }

    // -test: checks the last frame, read back, as the Donut example does: Sponza with its textures
    // compressed fills it (95% to 100% of the pixels not near black), its banners about 24% colored
    // (TestCheck.countSpread(61): the largest and smallest channels at least 61 apart).
    function checkFrame(pixels: int[], width: int, height: int) {
        if (pixels.length == 0) {
            return "cannot read the back buffer";
        }
        const total = width * height;
        let dark = 0;
        let colored = 0;
        for (let i = 0; i < total; i++) {
            const p = pixels[i];
            const r = p & 0xFF;
            const g = (p >> 8) & 0xFF;
            const b = (p >> 16) & 0xFF;
            if (r <= 20 && g <= 20 && b <= 20) {
                dark++;
            }
            let high = r;
            let low = r;
            if (g > high) {
                high = g;
            }
            if (b > high) {
                high = b;
            }
            if (g < low) {
                low = g;
            }
            if (b < low) {
                low = b;
            }
            if (high - low >= 61) {
                colored++;
            }
        }
        const lit = share(total - dark, total, 95.0, 100.0, "Lit");
        if (lit != "") {
            return lit;
        }
        return share(colored, total, 15.0, 32.0, "Colored");
    }

    // glm::mat3_cast(q) * v (quaternions as x, y, z, w).
    function rotateByQuaternion(q: number[], v: number[]) {
        const x = q[0];
        const y = q[1];
        const z = q[2];
        const w = q[3];
        return [
            (1.0 - 2.0 * (y * y + z * z)) * v[0] + 2.0 * (x * y - w * z) * v[1] + 2.0 * (x * z + w * y) * v[2],
            2.0 * (x * y + w * z) * v[0] + (1.0 - 2.0 * (x * x + z * z)) * v[1] + 2.0 * (y * z - w * x) * v[2],
            2.0 * (x * z - w * y) * v[0] + 2.0 * (y * z + w * x) * v[1] + (1.0 - 2.0 * (x * x + y * y)) * v[2],
        ];
    }

    // A frame in flight's own data: its command buffer, its slice of the scene constants and
    // the scene pass's descriptor sets (one per scene image, with that slice).
    class QueuedFrame {
        constructor(public sceneView: NriDescriptor | null, public sceneSets: NriDescriptorSet[]) {
        }
    }

    // Port of Vulkan-Samples' texture_compression_comparison (as
    // examples/texture_compression_comparison.ts ports it) to NRI: Sponza forward shaded (the
    // framework's base shaders), its textures transcoded from Basis Universal KTX 2 files into the
    // format picked in the UI (RGBA8, BC7, BC3), the transcoding timed and the texture bytes counted,
    // as the sample's update_textures. Donut's FirstPersonCamera's controls.
    class TextureCompressionComparison {
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

        // The format picked in the UI, the one the textures are in, and whether to transcode again.
        guiFormat: int = 0;
        currentFormat: int = 0;
        private requireRedraw: boolean = true;
        // The last transcoding's time (milliseconds) and bytes.
        private compressTimeMs: number = 0.0;
        private totalBytes: number = 0.0;
        // The combo's items: "<short name> " or "<short name> (not supported)".
        private items: string = "";

        private sceneLayout: NriPipelineLayout | null = null;
        private pipeline: NriPipeline | null = null;
        private sceneBuffer: NriBuffer | null = null;
        private descriptorPool: NriDescriptorPool | null = null;
        private linearWrap: NriDescriptor | null = null;
        private vertexBuffer: NriBuffer | null = null;
        private indexBuffer: NriBuffer | null = null;
        private depthTexture: NriTexture | null = null;
        private depthAttachment: NriDescriptor | null = null;

        // The scene's images (by URI) and, for the current format, their textures and views (all of
        // them, or none: textureViews.length == imageNames.length when drawable).
        private imageNames: string[] = [];
        private textures: NriTexture[] = [];
        private textureViews: NriDescriptor[] = [];

        // The draws, a node's primitive each: index range and base vertex, image (imageNames index),
        // node transform (MODEL_FLOATS each, from models), and world bounds center (3 each), in the
        // framework's order: by mesh, node, primitive. Sponza's materials are all opaque.
        private drawFirstIndex: int[] = [];
        private drawIndexCount: int[] = [];
        private drawBaseVertex: int[] = [];
        private drawTexture: int[] = [];
        private drawCenters: number[] = [];
        private models: f32[] = [];
        // The draws in drawing order: front to back.
        private order: int[] = [];
        private distances: number[] = [];

        // Donut's FirstPersonCamera, as the Donut example sets it up.
        private camera: DonutFirstPersonCamera = new DonutFirstPersonCamera(CAMERA_MOVE_SPEED, CAMERA_ROTATE_SPEED);

        // Upload buffers.
        private constants: f32[] = [];
        private stats: f32[] = [0.0, 0.0];

        // -format <n>; -noUI: no options window.
        requestedFormat: int = 0;
        noUI: boolean = false;
        private imgui: boolean = false;

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

            // The format: -format's if the device has it, as the Donut example applies it.
            this.guiFormat = this.requestedFormat;
            if (this.isFormatSupported(this.requestedFormat)) {
                this.currentFormat = this.requestedFormat;
            } else {
                console.log(`${SHORT_NAMES[this.requestedFormat]} isn't supported here: ${SHORT_NAMES[this.currentFormat]}`);
            }

            // Swap chain: rendered through sRGB views, as into Donut's sRGB back buffers.
            const queuedFrameNum = this.sample.getQueuedFrameNum();
            this.swapChain.init(this.sample, device, this.queue, true);
            this.sizeToSwapChain();
            const format = this.swapChainFormat;
            const viewFormat = this.swapChainViewFormat;

            // The depth buffer: D32, cleared to 0 (the framework's reversed depth).
            if (!this.createDepth(device)) {
                return 0;
            }

            // The framework's glTF sampler without a sampler in the file: linear, repeating (Donut's
            // LinearWrap).
            const linearWrap = device.createSamplerWithMipFilter(NriFilter.Linear, NriFilter.Linear, NriAddressMode.Repeat, 1);
            this.linearWrap = linearWrap;
            if (!linearWrap || !this.loadScene(device)) {
                console.log("Cannot load the scene: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return 0;
            }

            // The scene's layout: the scene constants b0, the base color texture t0 and its sampler s0,
            // the node transform as root constants b1.
            const sceneDesc = NriPipelineLayoutDesc.create();
            sceneDesc.addRange(0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.VertexPixel, NriRangeFlags.None);
            sceneDesc.addRange(0, 0, 1, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
            sceneDesc.addRange(0, 0, 1, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
            sceneDesc.addRootConstants(1, MODEL_SIZE, NriStage.VertexPixel);
            const sceneLayout = device.createPipelineLayoutFromDesc(sceneDesc);
            sceneDesc.destroy();
            this.sceneLayout = sceneLayout;
            if (!sceneLayout) {
                console.log("Cannot create the pipeline layout");
                return 0;
            }

            // The framework's geometry pipeline state: msaa.hlsl's shaders as compiled for the Donut
            // example; reversed depth (greater), back faces culled, counter-clockwise front faces.
            const folder = graphicsAPI == NriGraphicsAPI.D3D11 ? "dxbc" : graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv";
            const shaders = `shaders/texture_compression_comparison/${folder}/msaa`;
            const desc = NriPipelineDesc.create();
            let loaded = desc.addShader(NriShaderStage.Vertex, `${shaders}_scene_vs.bin`, "scene_vs") != 0;
            if (loaded) {
                loaded = desc.addShader(NriShaderStage.Pixel, `${shaders}_scene_ps.bin`, "scene_ps") != 0;
            }
            desc.addVertexAttribute("POSITION", NriFormat.RGB32_SFLOAT, 0);
            desc.addVertexAttribute("NORMAL", NriFormat.RGB32_SFLOAT, NORMAL_OFFSET);
            desc.addVertexAttribute("TEXCOORD", NriFormat.RG32_SFLOAT, TEXCOORD_OFFSET);
            desc.setCullMode(NriCullMode.Back);
            desc.setFrontCounterClockwise(1);
            desc.setColor(viewFormat, NriColorWrite.RGBA);
            desc.setDepth(DEPTH_FORMAT, NriCompareOp.Greater, 1, 0);
            if (loaded) {
                this.pipeline = device.createPipelineFromDesc(sceneLayout, desc);
            }
            desc.destroy();
            if (!this.pipeline) {
                console.log("Cannot load the texture compression comparison shaders");
                return 0;
            }

            // The scene constants, a queued frame's each, and per queued frame a set per scene image
            // (its view set once the images are transcoded).
            const sceneBuffer = device.createHostBuffer(queuedFrameNum * CONST_VIEW_SIZE, NriBufferUsage.ConstantBuffer);
            this.sceneBuffer = sceneBuffer;
            const imageCount = this.imageNames.length;
            const sceneSetNum = queuedFrameNum * imageCount;
            const descriptorPool = device.createDescriptorPool(sceneSetNum, sceneSetNum, sceneSetNum, sceneSetNum, 0, 0);
            this.descriptorPool = descriptorPool;
            if (!sceneBuffer || !descriptorPool) {
                console.log("Cannot create the descriptors");
                return 0;
            }
            this.frames.init(device, this.queue, queuedFrameNum);
            for (let i = 0; i < queuedFrameNum; i++) {
                const sceneView = sceneBuffer.createConstantView(i * CONST_VIEW_SIZE, CONST_VIEW_SIZE);
                const sceneSets: NriDescriptorSet[] = [];
                this.queuedFrames.push(new QueuedFrame(sceneView, sceneSets));
                if (!sceneView) {
                    console.log("Cannot create the constant buffer views");
                    return 0;
                }
                for (let t = 0; t < imageCount; t++) {
                    const sceneSet = descriptorPool.allocateDescriptorSet(sceneLayout, 0, 0);
                    if (!sceneSet) {
                        console.log("Cannot create the descriptor sets");
                        return 0;
                    }
                    sceneSet.updateDescriptor(0, 0, sceneView);
                    sceneSet.updateDescriptor(2, 0, linearWrap);
                    sceneSets.push(sceneSet);
                }
            }

            // The scene's camera, as the sample's free camera starts: looking down its node's -z,
            // its up its node's y.
            const forward = rotateByQuaternion(CAMERA_ROTATION, [0.0, 0.0, -1.0]);
            const up = rotateByQuaternion(CAMERA_ROTATION, [0.0, 1.0, 0.0]);
            const p = CAMERA_POSITION;
            this.camera.lookAtWithUp(p[0], p[1], p[2], p[0] + forward[0], p[1] + forward[1], p[2] + forward[2], up[0], up[1], up[2]);

            // The sample's options window.
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

        // The sample's is_texture_format_supported: a format the Donut example has, that the device
        // samples.
        isFormatSupported(index: int) {
            const device = this.device;
            const format = TEXTURE_FORMATS[index];
            if (!device || format == NriFormat.Unknown) {
                return false;
            }
            return (device.getFormatSupport(format) & FORMAT_SUPPORT_TEXTURE) != 0;
        }

        // Waits for the frame that last used this frame's command allocator (and its constants).
        latencySleep(frameIndex: int) {
            this.frames.wait(frameIndex);
        }

        // The textures of the current format, and their views, gone.
        destroyTextures() {
            for (const view of this.textureViews) {
                view.destroy();
            }
            for (const texture of this.textures) {
                texture.destroy();
            }
            this.textureViews = [];
            this.textures = [];
        }

        // The sample's update_textures and compress: every image of the scene transcoded from its
        // KTX 2 file into the format (each once), the time and bytes summed; the textures replaced
        // (the GPU idle first) and uploaded, and the sets given them.
        updateTextures(formatIndex: int) {
            const device = this.device;
            if (!device) {
                return false;
            }
            device.waitIdle();
            this.destroyTextures();

            let time = 0.0;
            let bytes = 0.0;
            let loaded = true;
            for (const name of this.imageNames) {
                const file = NriFile.load(SCENE_DIR + "ktx2/" + name + "2");
                if (!file) {
                    loaded = false;
                    break;
                }
                const transcoded = TranscodedTexture.transcodeKtx2(file.getData(), file.getSize(), TRANSCODE_FORMATS[formatIndex],
                    Ref(this.stats[0]));
                file.destroy();
                if (transcoded.isNull()) {
                    loaded = false;
                    break;
                }
                const image = transcoded;
                time += this.stats[0];
                bytes += this.stats[1];

                const levelNum = image.getLevelCount();
                const levels = NriTextureLevels.create(image.getWidth(), image.getHeight(), levelNum, TEXTURE_FORMATS[formatIndex]);
                for (let level = 0; level < levelNum; level++) {
                    levels.setTextureLevel(level, image.getLevelData(level), image.getLevelRowPitch(level));
                }
                image.destroy();
                const texture = device.createTextureFromLevels(this.queue, levels);
                levels.destroy();
                if (!texture) {
                    loaded = false;
                    break;
                }
                this.textures.push(texture);
                this.textureViews.push(texture.createView(TEXTURE_FORMATS[formatIndex]));
            }

            this.compressTimeMs = time;
            this.totalBytes = bytes;
            if (!loaded) {
                this.destroyTextures();
                return false;
            }
            for (const queuedFrame of this.queuedFrames) {
                for (let t = 0; t < this.textureViews.length; t++) {
                    queuedFrame.sceneSets[t].updateDescriptor(1, 0, this.textureViews[t]);
                }
            }
            return true;
        }

        // The sample's options window.
        buildUI() {
            this.sample.imguiNewFrame();
            if (this.items == "") {
                for (let i = 0; i < SHORT_NAMES.length; i++) {
                    this.items += (i > 0 ? "|" : "") + SHORT_NAMES[i] + " " + (this.isFormatSupported(i) ? "" : "(not supported)");
                }
            }
            NriImgui.setNextWindowPos(10.0, 10.0);
            NriImgui.begin("Options", 1);
            const selection = NriImgui.combo("Compressed Format", this.guiFormat, this.items);
            if (selection != this.guiFormat) {
                this.guiFormat = selection;
                this.requireRedraw = true;
                if (this.isFormatSupported(selection)) {
                    this.currentFormat = selection;
                }
            }
            if (this.isFormatSupported(this.guiFormat)) {
                NriImgui.text(`Format name: ${FORMAT_NAMES[this.guiFormat]}`);
                NriImgui.text(`Bytes: ${(this.totalBytes / 1024.0 / 1024.0).toFixed(6)} MB`);
                NriImgui.text(`Compression Time: ${this.compressTimeMs.toFixed(6)} (ms)`);
            } else {
                NriImgui.text(`${SHORT_NAMES[this.guiFormat]} not supported on this GPU.`);
            }
            NriImgui.end();
            this.sample.imguiRender();
        }

        // The scene uniforms: the camera's view-projection in Donut's clip space, and the light (its
        // direction, the node's rotation of (0, 0, -1)), into this frame's slice; the draws sorted
        // from the camera's position.
        writeConstants(queuedFrameIndex: int) {
            const sceneBuffer = this.sceneBuffer;
            if (!sceneBuffer) {
                return;
            }
            // Donut's camera, in Donut's view space (z forward), into the sample's (-z forward).
            const viewMatrix = this.camera.worldToView();
            const view: number[] = [];
            for (let i = 0; i < 16; i++) {
                view.push(i % 4 == 2 ? -viewMatrix[i] : viewMatrix[i]);
            }
            const viewProj = toDonutClip(multiply(vulkanStyleProjection(reversedPerspective(CAMERA_FOV, this.width / this.height, Z_NEAR, Z_FAR)),
                view));
            const c = this.constants;
            for (let i = 0; i < 16; i++) {
                c[CONST_VIEW_PROJ + i] = viewProj[i];
            }
            for (let i = 0; i < 4; i++) {
                c[CONST_LIGHT_COLOR + i] = LIGHT_COLOR[i];
            }
            const direction = rotateByQuaternion(LIGHT_ROTATION, [0.0, 0.0, -1.0]);
            for (let i = 0; i < 3; i++) {
                c[CONST_LIGHT_DIRECTION + i] = direction[i];
            }
            c[CONST_LIGHT_DIRECTION + 3] = 0.0;
            sceneBuffer.write(queuedFrameIndex * CONST_VIEW_SIZE, Ref(c[0]), CONST_FLOATS * 4);

            // The camera's position: -R^T t of its view [R t].
            const position: number[] = [0.0, 0.0, 0.0];
            for (let column = 0; column < 3; column++) {
                for (let row = 0; row < 3; row++) {
                    position[column] -= viewMatrix[column * 4 + row] * viewMatrix[12 + row];
                }
            }
            this.sortDraws(position[0], position[1], position[2]);
        }

        // The framework's GeometrySubpass order, from a camera at (x, y, z): front to back, by the
        // distance to the node's bounds; stable, as its multimap.
        sortDraws(x: number, y: number, z: number) {
            const count = this.drawIndexCount.length;
            for (let d = 0; d < count; d++) {
                const dx = this.drawCenters[d * 3] - x;
                const dy = this.drawCenters[d * 3 + 1] - y;
                const dz = this.drawCenters[d * 3 + 2] - z;
                this.distances[d] = Math.sqrt(dx * dx + dy * dy + dz * dz);
            }
            for (let d = 0; d < count; d++) {
                let i = d;
                while (i > 0 && this.distances[this.order[i - 1]] > this.distances[d]) {
                    this.order[i] = this.order[i - 1];
                    i--;
                }
                this.order[i] = d;
            }
        }

        // The draws in their order, each with its image's set and its node's transform (between
        // NriCommandBuffer.beginRenderingWithDepth and NriCommandBuffer.endRendering), once the textures are there.
        recordDraws(commandBuffer: NriCommandBuffer, queuedFrame: QueuedFrame) {
            const layout = this.sceneLayout;
            const pipeline = this.pipeline;
            const vertexBuffer = this.vertexBuffer;
            const indexBuffer = this.indexBuffer;
            if (this.textureViews.length != this.imageNames.length || !layout || !pipeline || !vertexBuffer || !indexBuffer) {
                return;
            }
            commandBuffer.setViewport(0.0, 0.0, this.width, this.height);
            commandBuffer.setScissor(0, 0, this.width, this.height);
            commandBuffer.setPipelineLayout(layout);
            commandBuffer.setPipeline(pipeline);
            commandBuffer.setIndexBuffer(indexBuffer, 0, NriIndexType.UInt32);
            commandBuffer.setVertexBuffer(0, vertexBuffer, 0, VERTEX_SIZE);
            let currentTexture = -1;
            for (const d of this.order) {
                const texture = this.drawTexture[d];
                if (texture != currentTexture) {
                    commandBuffer.setDescriptorSet(0, queuedFrame.sceneSets[texture]);
                    currentTexture = texture;
                }
                commandBuffer.setRootConstants(0, Ref(this.models[d * MODEL_FLOATS]), MODEL_SIZE);
                commandBuffer.drawIndexed(this.drawIndexCount[d], 1, this.drawFirstIndex[d], this.drawBaseVertex[d], 0);
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
            const depthTexture = device.createDepthTexture(this.queue, this.width, this.height, DEPTH_FORMAT);
            this.depthTexture = depthTexture;
            if (!depthTexture) {
                console.log("Cannot create the depth buffer");
                return false;
            }
            this.depthAttachment = depthTexture.createDepthAttachmentView(DEPTH_FORMAT);
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
            if (this.imgui) {
                this.buildUI();
            }
            const mouseFree = !this.imgui || NriImgui.wantsMouse() == 0;
            this.camera.animate(this.sample, this.test ? Math.fround(1.0 / 60.0) : this.sample.getFrameTime(), mouseFree);

            // The sample's update: the textures transcoded again when the UI asks.
            if (this.requireRedraw) {
                this.requireRedraw = false;
                if (!this.updateTextures(this.currentFormat)) {
                    console.log("Cannot transcode the scene's KTX 2 textures");
                }
            }
            this.writeConstants(queuedFrameIndex);

            // Acquire a swap chain texture
            const index = this.swapChain.acquire(frameIndex);
            const depthAttachment = this.depthAttachment;
            if (index >= 0) {
                const texture = this.swapChain.texture(index);
                const commandBuffer = this.frames.commandBuffer(frameIndex);
                const descriptorPool = this.descriptorPool;

                // Record: the forward pass (cleared to black, depth to 0), then the options window over
                // it (a pass of its own: without depth).
                commandBuffer.begin();
                if (this.imgui) {
                    this.sample.copyImguiData(commandBuffer);
                }
                if (descriptorPool) {
                    commandBuffer.setDescriptorPool(descriptorPool);
                }
                commandBuffer.textureBarrier(texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                if (depthAttachment) {
                    commandBuffer.beginRenderingWithDepth(this.swapChain.colorAttachment(index), depthAttachment);
                    commandBuffer.clearColor(0.0, 0.0, 0.0, 1.0);
                    commandBuffer.clearDepth(0.0);
                    this.recordDraws(commandBuffer, queuedFrame);
                    commandBuffer.endRendering();
                }
                if (this.imgui) {
                    commandBuffer.beginRendering(this.swapChain.colorAttachment(index));
                    this.sample.drawImgui(commandBuffer, this.viewFormat);
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
                if (this.imgui) {
                    this.sample.imguiEndFrame();
                }
                this.swapChain.present(index);
            }

            // Signaled after the present, as NRISamples do
            this.frames.signal(frameIndex);
        }

        // The scene's draws: every node's primitives, their vertices and indices in one vertex and one
        // index buffer; false on failure.
        loadScene(device: NriDevice): boolean {
            const scene = NriGltfModel.load(SCENE_PATH);
            if (!scene) {
                return false;
            }
            const loaded = this.loadSceneFrom(device, scene);
            scene.destroy();
            return loaded;
        }

        loadSceneFrom(device: NriDevice, scene: NriGltfModel): boolean {
            const primitiveCount = scene.getPrimitiveCount();

            // The primitives' images (by URI) and vertices.
            const primitiveTexture: int[] = [];
            const primitiveFirstIndex: int[] = [];
            const primitiveBaseVertex: int[] = [];
            const vertices: f32[] = [];
            const indices: int[] = [];
            // Per mesh: its bounds (min x, y, z, max x, y, z) and first primitive.
            const meshBounds: number[] = [];
            const meshFirstPrimitive: int[] = [];
            for (let p = 0; p < primitiveCount; p++) {
                const image = scene.getBaseColorImage(p);
                let texture = -1;
                for (let t = 0; t < this.imageNames.length; t++) {
                    if (this.imageNames[t] == image) {
                        texture = t;
                    }
                }
                if (texture < 0) {
                    texture = this.imageNames.length;
                    this.imageNames.push(image);
                }
                primitiveTexture.push(texture);

                const mesh = scene.getPrimitiveMesh(p);
                if (mesh == meshFirstPrimitive.length) {
                    meshFirstPrimitive.push(p);
                    for (let k = 0; k < 3; k++) {
                        meshBounds.push(HUGE);
                    }
                    for (let k = 0; k < 3; k++) {
                        meshBounds.push(-HUGE);
                    }
                }

                const vertexCount = scene.getVertexCount(p);
                const indexCount = scene.getIndexCount(p);
                const primitiveVertices: f32[] = [];
                for (let i = 0; i < vertexCount * VERTEX_FLOATS; i++) {
                    primitiveVertices.push(0.0);
                }
                const primitiveIndices: int[] = [];
                for (let i = 0; i < indexCount; i++) {
                    primitiveIndices.push(0);
                }
                scene.copyVertices(p, Ref(primitiveVertices[0]));
                scene.copyIndices(p, Ref(primitiveIndices[0]));

                primitiveBaseVertex.push(vertices.length / VERTEX_FLOATS);
                primitiveFirstIndex.push(indices.length);
                for (let v = 0; v < vertexCount * VERTEX_FLOATS; v++) {
                    vertices.push(primitiveVertices[v]);
                }
                for (let i = 0; i < indexCount; i++) {
                    indices.push(primitiveIndices[i]);
                }
                for (let v = 0; v < vertexCount * VERTEX_FLOATS; v += VERTEX_FLOATS) {
                    for (let k = 0; k < 3; k++) {
                        meshBounds[mesh * 6 + k] = Math.min(meshBounds[mesh * 6 + k], primitiveVertices[v + k]);
                        meshBounds[mesh * 6 + 3 + k] = Math.max(meshBounds[mesh * 6 + 3 + k], primitiveVertices[v + k]);
                    }
                }
            }
            meshFirstPrimitive.push(primitiveCount);
            if (this.imageNames.length == 0) {
                return false;
            }

            // The draws: by mesh, then node, then primitive, as the framework's meshes list their
            // nodes and submeshes.
            const nodeCount = scene.getNodeCount();
            const transform: f32[] = [];
            for (let i = 0; i < 16; i++) {
                transform.push(0.0);
            }
            for (let mesh = 0; mesh + 1 < meshFirstPrimitive.length; mesh++) {
                for (let node = 0; node < nodeCount; node++) {
                    if (scene.getNodeMesh(node) != mesh) {
                        continue;
                    }
                    scene.copyNodeTransform(node, Ref(transform[0]));
                    // The mesh's bounds, transformed (their corners), and their center.
                    const low = [HUGE, HUGE, HUGE];
                    const high = [-HUGE, -HUGE, -HUGE];
                    for (let corner = 0; corner < 8; corner++) {
                        const x = meshBounds[mesh * 6 + ((corner & 1) != 0 ? 3 : 0)];
                        const y = meshBounds[mesh * 6 + 1 + ((corner & 2) != 0 ? 3 : 0)];
                        const z = meshBounds[mesh * 6 + 2 + ((corner & 4) != 0 ? 3 : 0)];
                        for (let k = 0; k < 3; k++) {
                            const value = transform[k] * x + transform[4 + k] * y + transform[8 + k] * z + transform[12 + k];
                            low[k] = Math.min(low[k], value);
                            high[k] = Math.max(high[k], value);
                        }
                    }
                    for (let p = meshFirstPrimitive[mesh]; p < meshFirstPrimitive[mesh + 1]; p++) {
                        this.drawFirstIndex.push(primitiveFirstIndex[p]);
                        this.drawIndexCount.push(scene.getIndexCount(p));
                        this.drawBaseVertex.push(primitiveBaseVertex[p]);
                        this.drawTexture.push(primitiveTexture[p]);
                        for (let k = 0; k < 3; k++) {
                            this.drawCenters.push(0.5 * (low[k] + high[k]));
                        }
                        for (let i = 0; i < 16; i++) {
                            this.models.push(transform[i]);
                        }
                        this.order.push(this.order.length);
                        this.distances.push(0.0);
                    }
                }
            }

            this.vertexBuffer = device.createUploadedBuffer(this.queue, Ref(vertices[0]), vertices.length * 4, NriBufferUsage.VertexBuffer);
            this.indexBuffer = device.createUploadedBufferFromInts(this.queue, Ref(indices[0]), indices.length * 4,
                NriBufferUsage.IndexBuffer);
            return this.buffersCreated();
        }

        buffersCreated(): boolean {
            if (!this.vertexBuffer) {
                return false;
            }
            return this.indexBuffer ? true : false;
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
                for (const queuedFrame of this.queuedFrames) {
                    this.destroyDescriptor(queuedFrame.sceneView);
                }
                const descriptorPool = this.descriptorPool;
                if (descriptorPool) {
                    descriptorPool.destroy();
                }
                const pipeline = this.pipeline;
                if (pipeline) {
                    pipeline.destroy();
                }
                const sceneLayout = this.sceneLayout;
                if (sceneLayout) {
                    sceneLayout.destroy();
                }
                this.destroyTextures();
                this.destroyDescriptor(this.depthAttachment);
                const depthTexture = this.depthTexture;
                if (depthTexture) {
                    depthTexture.destroy();
                }
                this.destroyDescriptor(this.linearWrap);
                this.destroyBuffer(this.vertexBuffer);
                this.destroyBuffer(this.indexBuffer);
                this.destroyBuffer(this.sceneBuffer);
                this.destroyBuffer(this.readbackBuffer);
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
        const comparison = new TextureCompressionComparison(sample);
        // -format <n>: 0 RGBA 32 (the default), 1 BC7, 2 BC3, 3 ASTC 4x4, 4 ETC2; -noUI: no options
        // window.
        sample.addExampleOptionWithValues("-format", 1);
        sample.addExampleOption("-noUI");
        sample.useImgui();
        for (let i = 1; i < argc; i++) {
            const arg = Nri.getArg(argc, argv, i);
            if (arg == "-format" && i + 1 < argc) {
                comparison.requestedFormat = Math.min(4, Math.max(0, parseInt(Nri.getArg(argc, argv, i + 1))));
                i++;
            } else if (arg == "-noUI") {
                comparison.noUI = true;
            }
        }
        return comparison.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return TextureCompressionComparisonNri.main(argc, argv);
}
