// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";
import { Args } from "../core/args";
import { unsupported } from "../core/test_check";

namespace CalibratedTimestampsSample {
    const WINDOW_TITLE = "Donut Example: Calibrated Timestamps";

    // The sample's models and HDR cube map (Vulkan-Samples' assets), the KTX cube map converted to
    // DDS at build time (see VULKAN_SAMPLES_ASSETS_DIR in CMakeLists.txt).
    const SKYBOX_PATH = "media/hdr/cube.gltf";
    const OBJECT_PATHS = ["media/hdr/geosphere.gltf", "media/hdr/teapot.gltf", "media/hdr/torusknot.gltf"];
    const OBJECT_NAMES = "Sphere|Teapot|Torusknot";
    const ENVMAP_PATH = "media/hdr/uffizi_rgba16f_cube.dds";

    // Donut_LoadGltfMesh's vertices: float3 position, float3 normal, float2 texture coordinates.
    const VERTEX_SIZE = 32;

    // struct UBOMatrices, as f32 offsets (HLSL packing).
    const CONST_PROJECTION = 0;
    const CONST_MODELVIEW = 16;
    const CONST_SKYBOX_MODELVIEW = 32;
    const CONST_INVERSE_MODELVIEW = 48;
    const CONST_MODELSCALE = 64;
    // Padded to 16 bytes.
    const CONST_FLOATS = 68;
    // struct UBOParams { float exposure; }, padded to 16 bytes.
    const PARAMS_EXPOSURE = 0;
    const PARAMS_FLOATS = 4;

    // The sample's camera: reversed depth from 0.1 to 256.
    const Z_NEAR = 0.1;
    const Z_FAR = 256.0;

    // The code the sample times, in the order its overlay lists them (its std::unordered_map of
    // tags'): updating the uniform buffers, loading the assets, recording the frame's commands (its
    // build_command_buffers), and submitting and presenting the frame (its draw).
    const TAG_UPDATE_UBO = 0;
    const TAG_LOAD_ASSETS = 1;
    const TAG_BUILD_COMMAND_BUFFERS = 2;
    const TAG_DRAW = 3;
    const TAGS = ["update ubo", "loadAssets", "Build_Command_Buffers", "draw"];

    // Test mode: the frames rendered, each 1/60 s.
    const TEST_FRAMES = 10;

    // --- Math ---------------------------------------------------------------------------------

    // glm::radians(float): in float32, as every use in the sample is.
    function radians(degrees: number): number {
        return Math.fround(Math.fround(degrees) * Math.fround(Math.PI / 180.0));
    }

    // The sample's glm::perspective(fov, aspect, 256, 0.1) (near and far swapped for reversed
    // depth; right-handed, depth from 0 to 1), for row vectors, with clip y negated: the sample's
    // clip space has y down on the screen (Vulkan's), Donut's y up.
    // In float32, in glm's order of operations.
    function samplePerspective(verticalFOV: number, aspect: number, zNear: number, zFar: number): number[] {
        const tanHalfFovy = Math.fround(Math.tan(Math.fround(Math.fround(verticalFOV) / 2.0)));
        // glm's near and far, swapped.
        const n = Math.fround(zFar);
        const f = Math.fround(zNear);
        return [
            Math.fround(1.0 / Math.fround(Math.fround(aspect) * tanHalfFovy)), 0.0, 0.0, 0.0,
            0.0, -Math.fround(1.0 / tanHalfFovy), 0.0, 0.0,
            0.0, 0.0, Math.fround(f / Math.fround(n - f)), -1.0,
            0.0, 0.0, Math.fround(-Math.fround(f * n) / Math.fround(f - n)), 0.0,
        ];
    }

    // The same projection in Donut's conventions (view space z forward), for Donut's camera.
    // In float32, in glm's order of operations.
    function perspProjReverse(verticalFOV: number, aspect: number, zNear: number, zFar: number): number[] {
        const near = Math.fround(zNear);
        const far = Math.fround(zFar);
        const tanHalfFovy = Math.fround(Math.tan(Math.fround(Math.fround(verticalFOV) / 2.0)));
        const xScale = Math.fround(1.0 / Math.fround(Math.fround(aspect) * tanHalfFovy));
        const yScale = Math.fround(1.0 / tanHalfFovy);
        const depthRange = Math.fround(far - near);
        return [
            xScale, 0.0,    0.0,                                            0.0,
            0.0,    yScale, 0.0,                                            0.0,
            0.0,    0.0,    -Math.fround(near / depthRange),                1.0,
            0.0,    0.0,    Math.fround(Math.fround(far * near) / depthRange), 0.0,
        ];
    }

    // time_domain_to_string.
    function timeDomainToString(timeDomain: int): string {
        if (timeDomain == TimeDomain.Device) {
            return "device time domain";
        }
        if (timeDomain == TimeDomain.ClockMonotonic) {
            return "clock monotonic time domain";
        }
        if (timeDomain == TimeDomain.ClockMonotonicRaw) {
            return "clock monotonic raw time domain";
        }
        if (timeDomain == TimeDomain.QueryPerformanceCounter) {
            return "query performance time domain";
        }
        return "unknown time domain";
    }

    // --- Timestamps -----------------------------------------------------------------------------

    // The sample's timestamps_begin / timestamps_end: a tagged piece of code timed by the device's
    // timestamps (the device time domain's), sampled calibrated with the other domains' at its
    // beginning and end. The deltas are in the device's ticks.
    class Timestamps {
        private calibrated: CalibratedTimestamps | null;
        private begins: number[];
        private begun: boolean[];
        // get_device_time_domain's selection: the device's domain when there are several.
        selectedIndex: int;
        selectedTimeDomain: int;
        deltas: number[];
        measured: boolean[];

        constructor(app: App) {
            this.begins = [];
            this.begun = [];
            this.deltas = [];
            this.measured = [];
            for (let i = 0; i < TAGS.length; i++) {
                this.begins.push(0.0);
                this.begun.push(false);
                this.deltas.push(0.0);
                this.measured.push(false);
            }
            this.selectedIndex = 0;
            this.selectedTimeDomain = TimeDomain.Device;
            const calibrated = app.createCalibratedTimestamps();
            if (calibrated.isNull()) {
                this.calibrated = null;
                return;
            }
            this.calibrated = calibrated;
            const count = calibrated.getDomainCount();
            if (count > 1) {
                for (let i = 0; i < count; i++) {
                    if (calibrated.getDomain(i) == TimeDomain.Device) {
                        this.selectedIndex = i;
                        this.selectedTimeDomain = TimeDomain.Device;
                    }
                }
            }
        }

        available(): boolean {
            return this.calibrated != null;
        }

        // The selected domain's timestamp, sampled now with the others; -1 on failure.
        sample(): number {
            const calibrated = this.calibrated;
            if (!calibrated || calibrated.sample() == 0) {
                return -1.0;
            }
            return calibrated.getTimestamp(this.selectedIndex);
        }

        begin(tag: int): void {
            const timestamp = this.sample();
            if (timestamp >= 0.0) {
                this.begins[tag] = timestamp;
                this.begun[tag] = true;
            }
        }

        end(tag: int): void {
            if (!this.begun[tag]) {
                return;
            }
            const timestamp = this.sample();
            if (timestamp >= 0.0) {
                this.deltas[tag] = timestamp - this.begins[tag];
                this.measured[tag] = true;
            }
        }

        anyMeasured(): boolean {
            for (let i = 0; i < this.measured.length; i++) {
                if (this.measured[i]) {
                    return true;
                }
            }
            return false;
        }
    }

    // --- Passes -------------------------------------------------------------------------------

    // Port of Vulkan-Samples' calibrated_timestamps: its hdr sample (a reflective object in front of
    // an HDR environment cube map, its bright parts blurred into a bloom; exposure 1), with pieces of
    // its code timed by calibrated timestamps (VK_EXT_calibrated_timestamps; D3D12's clock
    // calibration): loading the assets, updating the uniform buffers, recording the frame's
    // commands, and submitting and presenting the frame (from the end of the frame's recording to
    // the beginning of the next frame). The overlay shows the device's timestamp period, the time
    // domain the timestamps come from and each piece's time.
    class HdrPass {
        private app: App;
        timestamps: Timestamps;
        private camera: Camera;
        private view: View;

        // The sample's settings.
        objectIndex: int;
        exposure: number;
        bloom: boolean;
        displaySkybox: boolean;

        private skyboxVS: ShaderHandle;
        private skyboxPS: ShaderHandle;
        private reflectVS: ShaderHandle;
        private reflectPS: ShaderHandle;
        private fullscreenVS: ShaderHandle;
        private compositionPS: ShaderHandle;
        private bloomFilterPS: ShaderHandle;
        private bloomCompositePS: ShaderHandle;
        private inputLayout: InputLayoutHandle;
        private modelsBindingLayout: BindingLayoutHandle;
        private postBindingLayout: BindingLayoutHandle;
        private matricesBuffer: BufferHandle;
        private paramsBuffer: BufferHandle;
        private skybox: GltfMesh;
        private objects: GltfMesh[];
        private modelsBindingSet: BindingSet;

        // Created on the first frame (the size of the back buffer), dropped on resize.
        private offscreenColor0: TextureHandle | null;
        private offscreenColor1: TextureHandle | null;
        private offscreenDepth: TextureHandle | null;
        private offscreenFramebuffer: FramebufferHandle | null;
        private filterColor: TextureHandle | null;
        private filterFramebuffer: FramebufferHandle | null;
        private skyboxPipeline: GraphicsPipelineHandle | null;
        private reflectPipeline: GraphicsPipelineHandle | null;
        private bloomFilterPipeline: GraphicsPipelineHandle | null;
        private compositionPipeline: GraphicsPipelineHandle | null;
        private bloomCompositePipeline: GraphicsPipelineHandle | null;
        private bloomFilterBindingSet: BindingSet;
        private compositionBindingSet: BindingSet;

        // The UBO contents.
        private matrices: f32[];
        private params: f32[];
        // Donut's view matrices, 16 floats each.
        private viewMatrix: f32[];
        private projMatrix: f32[];

        constructor(app: App) {
            this.app = app;
            this.objectIndex = 0;
            this.exposure = 1.0;
            this.bloom = true;
            this.displaySkybox = true;
            this.objects = [];
            this.offscreenColor0 = null;
            this.offscreenColor1 = null;
            this.offscreenDepth = null;
            this.offscreenFramebuffer = null;
            this.filterColor = null;
            this.filterFramebuffer = null;
            this.skyboxPipeline = null;
            this.reflectPipeline = null;
            this.bloomFilterPipeline = null;
            this.compositionPipeline = null;
            this.bloomCompositePipeline = null;
            this.bloomFilterBindingSet = new BindingSet(null);
            this.compositionBindingSet = new BindingSet(null);

            this.matrices = [];
            for (let i = 0; i < CONST_FLOATS; i++) {
                this.matrices.push(0.0);
            }
            this.params = [];
            for (let i = 0; i < PARAMS_FLOATS; i++) {
                this.params.push(0.0);
            }
            this.viewMatrix = [];
            this.projMatrix = [];
            for (let i = 0; i < 16; i++) {
                this.viewMatrix.push(0.0);
                this.projMatrix.push(0.0);
            }
        }

        onKey(key: int, scancode: int, action: int, mods: int): int {
            this.camera.keyboardUpdate(key, scancode, action, mods);
            return 1;
        }

        onMousePos(x: number, y: number): int {
            this.camera.mousePosUpdate(x, y);
            return 1;
        }

        onMouseButton(button: int, action: int, mods: int): int {
            this.camera.mouseButtonUpdate(button, action, mods);
            return 1;
        }

        onMouseScroll(xOffset: number, yOffset: number): int {
            this.camera.mouseScrollUpdate(xOffset, yOffset);
            return 1;
        }

        onAnimate(elapsedSeconds: number): void {
            // The previous frame's submission and presentation end here.
            this.timestamps.end(TAG_DRAW);
            this.camera.animate(elapsedSeconds);
            this.app.setInformativeWindowTitle(WINDOW_TITLE);
        }

        releaseTargets(): void {
            const bindingSets = [this.bloomFilterBindingSet, this.compositionBindingSet];
            for (let i = 0; i < bindingSets.length; i++) {
                const bindingSet = bindingSets[i];
                if (!bindingSet.isNull()) {
                    this.app.releaseResource(bindingSet.handle);
                }
            }
            this.bloomFilterBindingSet = new BindingSet(null);
            this.compositionBindingSet = new BindingSet(null);

            const resources: (ResourceHandle | null)[] = [this.skyboxPipeline, this.reflectPipeline, this.bloomFilterPipeline,
                this.compositionPipeline, this.bloomCompositePipeline, this.offscreenFramebuffer,
                this.filterFramebuffer, this.offscreenColor0, this.offscreenColor1, this.offscreenDepth,
                this.filterColor];
            for (let i = 0; i < resources.length; i++) {
                const resource = resources[i];
                if (resource) {
                    this.app.releaseResource(resource);
                }
            }
            this.skyboxPipeline = null;
            this.reflectPipeline = null;
            this.bloomFilterPipeline = null;
            this.compositionPipeline = null;
            this.bloomCompositePipeline = null;
            this.offscreenFramebuffer = null;
            this.filterFramebuffer = null;
            this.offscreenColor0 = null;
            this.offscreenColor1 = null;
            this.offscreenDepth = null;
            this.filterColor = null;
        }

        onBackBufferResizing(): void {
            this.releaseTargets();
        }

        // The skybox and the object, into the offscreen targets: reversed depth (greater passes),
        // counter-clockwise front faces. The sample's projection keeps its framebuffer
        // coordinates, so its cull modes too.
        createModelPipeline(framebuffer: FramebufferHandle, vertexShader: ShaderHandle, pixelShader: ShaderHandle, depthTestAndWrite: int,
            cullMode: CullMode): GraphicsPipelineHandle {
            const desc = GraphicsPipelineDesc.create(vertexShader, pixelShader);
            desc.setInputLayout(this.inputLayout);
            desc.addBindingLayout(this.modelsBindingLayout);
            desc.setDepthState(depthTestAndWrite, depthTestAndWrite, ComparisonFunc.Greater);
            desc.setRasterState(cullMode, FillMode.Solid, 1);
            return this.app.createGraphicsPipelineFromDesc(desc, framebuffer);
        }

        createPostBindingSet(texture0: TextureHandle, texture1: TextureHandle): BindingSet {
            const setDesc = BindingSetDesc.create();
            setDesc.bindTextureSRV(0, texture0);
            setDesc.bindTextureSRV(1, texture1);
            setDesc.bindSampler(0, this.app.getCommonSampler(CommonSampler.PointClamp));
            return this.app.createBindingSetForLayout(setDesc, this.postBindingLayout);
        }

        // The sample's prepare_offscreen_buffer and the pipelines drawing into its targets.
        createTargets(frame: Frame, width: int, height: int): void {
            // We are using two 128-Bit RGBA floating point color buffers for this sample
            // In a performance or bandwidth-limited scenario you should consider using a format with lower precision
            const offscreenColor0 = this.app.createRenderTargetTexture(width, height, Format.RGBA32_FLOAT, "OffscreenColor0");
            const offscreenColor1 = this.app.createRenderTargetTexture(width, height, Format.RGBA32_FLOAT, "OffscreenColor1");
            const offscreenDepth = this.app.createRenderTargetTexture(width, height, Format.D32, "OffscreenDepth");
            const offscreenFramebuffer = this.app.createFramebufferWithTwoTargets(offscreenColor0, offscreenColor1, offscreenDepth);
            // Bloom separable filter pass
            const filterColor = this.app.createRenderTargetTexture(width, height, Format.RGBA32_FLOAT, "FilterColor");
            const filterFramebuffer = this.app.createFramebuffer(filterColor, null);
            this.offscreenColor0 = offscreenColor0;
            this.offscreenColor1 = offscreenColor1;
            this.offscreenDepth = offscreenDepth;
            this.offscreenFramebuffer = offscreenFramebuffer;
            this.filterColor = filterColor;
            this.filterFramebuffer = filterFramebuffer;

            // Skybox pipeline (background cube): no depth test or writes.
            this.skyboxPipeline = this.createModelPipeline(offscreenFramebuffer, this.skyboxVS, this.skyboxPS, 0, CullMode.Back);
            // Object rendering pipeline: depth test and writes, cull mode flipped.
            this.reflectPipeline = this.createModelPipeline(offscreenFramebuffer, this.reflectVS, this.reflectPS, 1, CullMode.Front);

            // First blur pass, into the filter target (additive, as the sample's bloom pipelines).
            const bloomFilterDesc = GraphicsPipelineDesc.create(this.fullscreenVS, this.bloomFilterPS);
            bloomFilterDesc.addBindingLayout(this.postBindingLayout);
            bloomFilterDesc.setDepthState(0, 0, ComparisonFunc.Always);
            bloomFilterDesc.setRasterState(CullMode.None, FillMode.Solid, 0);
            bloomFilterDesc.setBlendMode(BlendMode.Additive);
            this.bloomFilterPipeline = this.app.createGraphicsPipelineFromDesc(bloomFilterDesc, filterFramebuffer);

            // Final fullscreen composition pass, and the second blur pass added over it.
            this.compositionPipeline = this.app.createGraphicsPipelineWithBlend(frame, this.fullscreenVS, this.compositionPS,
                null, this.postBindingLayout, PrimitiveType.TriangleList, BlendMode.None);
            this.bloomCompositePipeline = this.app.createGraphicsPipelineWithBlend(frame, this.fullscreenVS, this.bloomCompositePS,
                null, this.postBindingLayout, PrimitiveType.TriangleList, BlendMode.Additive);

            this.bloomFilterBindingSet = this.createPostBindingSet(offscreenColor0, offscreenColor1);
            this.compositionBindingSet = this.createPostBindingSet(offscreenColor0, filterColor);
        }

        // The sample's update_uniform_buffers and update_params.
        updateConstants(width: int, height: int): void {
            const projection = perspProjReverse(radians(60.0), width / height, Z_NEAR, Z_FAR);
            for (let i = 0; i < 16; i++) {
                this.projMatrix[i] = projection[i];
            }
            this.camera.getWorldToView(Ref(this.viewMatrix[0]));
            this.view.setPlanarView(Ref(this.viewMatrix[0]), Ref(this.projMatrix[0]), width, height);
            this.camera.thirdPersonSetView(this.view);

            // The sample's world has -y up on the screen (Vulkan, without a flipped viewport). Mirrored
            // in y it is Donut's world, y up, with the same picture: Donut's view space is left-handed,
            // the sample's right-handed. So the sample's view matrix is the y mirror, then Donut's
            // view, then Donut's view space to the sample's (y down, -z forward): rows and columns of
            // Donut's negated.
            const view: number[] = [];
            for (let i = 0; i < 16; i++) {
                const row = Math.floor(i / 4);
                const column = i % 4;
                const mirrored = row == 1 ? -this.viewMatrix[i] : this.viewMatrix[i];
                view.push(column == 1 || column == 2 ? -mirrored : mirrored);
            }

            // The objects' transforms: the teapot scaled by 10 and turned 180 degrees around x.
            const model = this.objectIndex == 1 ? [10.0, -10.0, -10.0, 1.0] : [1.0, 1.0, 1.0, 1.0];

            const c = this.matrices;
            const sampleProjection = samplePerspective(radians(60.0), width / height, Z_NEAR, Z_FAR);
            for (let i = 0; i < 16; i++) {
                const row = Math.floor(i / 4);
                c[CONST_PROJECTION + i] = sampleProjection[i];
                c[CONST_MODELVIEW + i] = model[row] * view[i];
                c[CONST_SKYBOX_MODELVIEW + i] = view[i];
            }

            // inverse(view): the view is a rotation and a translation, so its rotation transposed and
            // the translation turned back.
            for (let row = 0; row < 3; row++) {
                for (let column = 0; column < 3; column++) {
                    c[CONST_INVERSE_MODELVIEW + row * 4 + column] = view[column * 4 + row];
                }
                c[CONST_INVERSE_MODELVIEW + row * 4 + 3] = 0.0;
            }
            for (let column = 0; column < 3; column++) {
                let t = 0.0;
                for (let k = 0; k < 3; k++) {
                    t -= view[12 + k] * view[column * 4 + k];
                }
                c[CONST_INVERSE_MODELVIEW + 12 + column] = t;
            }
            c[CONST_INVERSE_MODELVIEW + 15] = 1.0;

            c[CONST_MODELSCALE] = 0.05;

            this.params[PARAMS_EXPOSURE] = this.exposure;
        }

        drawModel(frame: Frame, pipeline: GraphicsPipelineHandle, framebuffer: FramebufferHandle, mesh: GltfMesh): void {
            frame.beginDrawToFramebuffer(pipeline, framebuffer);
            frame.drawAddBindingSet(this.modelsBindingSet);
            frame.drawAddVertexBuffer(mesh.getVertexBuffer(), 0, 0);
            frame.drawSetIndexBuffer(mesh.getIndexBuffer());
            frame.drawIndexed(mesh.getIndexCount());
        }

        onRender(frameHandle: FrameHandle): void {
            const frame = new Frame(frameHandle);
            const width = frame.getWidth();
            const height = frame.getHeight();
            const commandList = frame.getCommandList();

            if (!this.offscreenFramebuffer) {
                this.createTargets(frame, width, height);
            }
            const offscreenColor0 = this.offscreenColor0;
            const offscreenColor1 = this.offscreenColor1;
            const offscreenDepth = this.offscreenDepth;
            const offscreenFramebuffer = this.offscreenFramebuffer;
            const filterColor = this.filterColor;
            const filterFramebuffer = this.filterFramebuffer;
            const skyboxPipeline = this.skyboxPipeline;
            const reflectPipeline = this.reflectPipeline;
            const bloomFilterPipeline = this.bloomFilterPipeline;
            const compositionPipeline = this.compositionPipeline;
            const bloomCompositePipeline = this.bloomCompositePipeline;
            if (!offscreenColor0 || !offscreenColor1 || !offscreenDepth || !offscreenFramebuffer || !filterColor
                || !filterFramebuffer || !skyboxPipeline || !reflectPipeline || !bloomFilterPipeline
                || !compositionPipeline || !bloomCompositePipeline) {
                return;
            }

            this.timestamps.begin(TAG_UPDATE_UBO);
            this.updateConstants(width, height);
            commandList.writeBuffer(this.matricesBuffer, Ref(this.matrices[0]), CONST_FLOATS * 4);
            commandList.writeBuffer(this.paramsBuffer, Ref(this.params[0]), PARAMS_FLOATS * 4);
            this.timestamps.end(TAG_UPDATE_UBO);

            this.timestamps.begin(TAG_BUILD_COMMAND_BUFFERS);

            /*
                First pass: Render scene to offscreen framebuffer
            */

            // Reversed depth: the far plane is 0.
            commandList.clearTextureFloat(offscreenColor0, 0.0, 0.0, 0.0, 0.0);
            commandList.clearTextureFloat(offscreenColor1, 0.0, 0.0, 0.0, 0.0);
            commandList.clearDepth(offscreenDepth, 0.0);

            // Skybox
            if (this.displaySkybox) {
                this.drawModel(frame, skyboxPipeline, offscreenFramebuffer, this.skybox);
            }

            // 3D object
            this.drawModel(frame, reflectPipeline, offscreenFramebuffer, this.objects[this.objectIndex]);

            /*
                Second render pass: First bloom pass
            */
            if (this.bloom) {
                commandList.clearTextureFloat(filterColor, 0.0, 0.0, 0.0, 0.0);
                frame.beginDrawToFramebuffer(bloomFilterPipeline, filterFramebuffer);
                frame.drawAddBindingSet(this.bloomFilterBindingSet);
                frame.drawVertices(3);
            }

            /*
                Third render pass: Scene rendering with applied second bloom pass (when enabled)
            */

            // Scene
            frame.beginDraw(compositionPipeline);
            frame.drawAddBindingSet(this.compositionBindingSet);
            frame.drawVertices(3);

            // Bloom
            if (this.bloom) {
                frame.beginDraw(bloomCompositePipeline);
                frame.drawAddBindingSet(this.compositionBindingSet);
                frame.drawVertices(3);
            }
            this.timestamps.end(TAG_BUILD_COMMAND_BUFFERS);

            // Donut submits and presents the frame after the passes.
            this.timestamps.begin(TAG_DRAW);
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(): boolean {
            // Get the optimal time domain as soon as possible.
            this.timestamps = new Timestamps(this.app);

            this.skyboxVS = this.app.createShader("hdr.hlsl", "skybox_vs", ShaderType.Vertex);
            this.skyboxPS = this.app.createShader("hdr.hlsl", "skybox_ps", ShaderType.Pixel);
            this.reflectVS = this.app.createShader("hdr.hlsl", "reflect_vs", ShaderType.Vertex);
            this.reflectPS = this.app.createShader("hdr.hlsl", "reflect_ps", ShaderType.Pixel);
            this.fullscreenVS = this.app.createShader("hdr.hlsl", "fullscreen_vs", ShaderType.Vertex);
            this.compositionPS = this.app.createShader("hdr.hlsl", "composition_ps", ShaderType.Pixel);
            this.bloomFilterPS = this.app.createShader("hdr.hlsl", "bloom_filter_ps", ShaderType.Pixel);
            this.bloomCompositePS = this.app.createShader("hdr.hlsl", "bloom_composite_ps", ShaderType.Pixel);
            if (!this.skyboxVS || !this.skyboxPS || !this.reflectVS || !this.reflectPS || !this.fullscreenVS
                || !this.compositionPS || !this.bloomFilterPS || !this.bloomCompositePS) {
                return false;
            }

            // Vertex bindings and attributes for model rendering: position and normal.
            const layoutDesc = InputLayoutDesc.create();
            layoutDesc.addVertexAttribute("POSITION", Format.RGB32_FLOAT, 0, 0, VERTEX_SIZE);
            layoutDesc.addVertexAttribute("NORMAL", Format.RGB32_FLOAT, 12, 0, VERTEX_SIZE);
            this.inputLayout = this.app.createInputLayout(layoutDesc, this.skyboxVS);

            this.timestamps.begin(TAG_LOAD_ASSETS);
            const commandList = this.app.createCommandList();
            commandList.open();
            const skybox = this.app.loadGltfMesh(commandList, SKYBOX_PATH);
            let objectsLoaded = !skybox.isNull();
            for (let i = 0; i < OBJECT_PATHS.length; i++) {
                const object = this.app.loadGltfMesh(commandList, OBJECT_PATHS[i]);
                objectsLoaded = objectsLoaded && !object.isNull();
                this.objects.push(object);
            }
            // Load HDR cube map
            const envmap = this.app.loadTexture(commandList, ENVMAP_PATH, 0);
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.waitForIdle();
            this.app.releaseResource(commandList.handle);
            this.timestamps.end(TAG_LOAD_ASSETS);
            if (!objectsLoaded || !envmap) {
                console.log("Cannot load the models and the cube map: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return false;
            }
            this.skybox = skybox;

            this.matricesBuffer = this.app.createVolatileConstantBuffer(CONST_FLOATS * 4, "UBOMatrices");
            this.paramsBuffer = this.app.createVolatileConstantBuffer(PARAMS_FLOATS * 4, "UBOParams");

            const modelsLayoutDesc = BindingLayoutDesc.create();
            modelsLayoutDesc.layoutVolatileConstantBuffer(0);
            modelsLayoutDesc.layoutVolatileConstantBuffer(1);
            modelsLayoutDesc.layoutTextureSRV(0);
            modelsLayoutDesc.layoutSampler(0);
            this.modelsBindingLayout = this.app.createBindingLayout(modelsLayoutDesc, ShaderType.All);

            const modelsSetDesc = BindingSetDesc.create();
            modelsSetDesc.bindEntireConstantBuffer(0, this.matricesBuffer);
            modelsSetDesc.bindEntireConstantBuffer(1, this.paramsBuffer);
            modelsSetDesc.bindTextureSRV(0, envmap);
            modelsSetDesc.bindSampler(0, this.app.getCommonSampler(CommonSampler.AnisotropicWrap));
            this.modelsBindingSet = this.app.createBindingSetForLayout(modelsSetDesc, this.modelsBindingLayout);

            // The composition and bloom passes: two textures and a point sampler, as the sample's
            // offscreen sampler (nearest, clamped).
            const postLayoutDesc = BindingLayoutDesc.create();
            postLayoutDesc.layoutTextureSRV(0);
            postLayoutDesc.layoutTextureSRV(1);
            postLayoutDesc.layoutSampler(0);
            this.postBindingLayout = this.app.createBindingLayout(postLayoutDesc, ShaderType.Pixel);

            // The sample's look-at camera, at (0, 0, -4) and turned 180 degrees around y: looking at
            // the world's origin from (0, 0, -4), in either world (see updateConstants).
            this.camera = this.app.createThirdPersonCamera();
            this.camera.thirdPersonLookAt(0.0, 0.0, -4.0, 0.0, 0.0, 0.0);
            this.view = this.app.createPlanarView();

            const pass = this.app.addPass();
            pass.setKeyboardCallback(this.onKey);
            pass.setMousePosCallback(this.onMousePos);
            pass.setMouseButtonCallback(this.onMouseButton);
            pass.setMouseScrollCallback(this.onMouseScroll);
            pass.setAnimateCallback(this.onAnimate);
            pass.setBackBufferResizingCallback(this.onBackBufferResizing);
            pass.setRenderCallback(this.onRender);
            return true;
        }
    }

    // The sample's overlay.
    class UserInterface {
        private hdr: HdrPass;
        private timestampPeriod: number;

        constructor(hdr: HdrPass, timestampPeriod: number) {
            this.hdr = hdr;
            this.timestampPeriod = timestampPeriod;
        }

        // on_update_ui_overlay: the timestamp period, the settings, the time domain and the times
        // (the timestamps' deltas in microseconds).
        buildUI(): void {
            const hdr = this.hdr;
            const timestamps = hdr.timestamps;
            const timestampPeriod = Math.fround(this.timestampPeriod);
            Donut_ImGuiSetNextWindowPos(10.0, 10.0);
            Donut_ImGuiBegin("Calibrated Timestamps", 1);
            Donut_ImGuiPushItemWidth(110.0);
            // The sample's two-line texts, a line at a time.
            Donut_ImGuiText("Timestamps Period:");
            Donut_ImGuiText(` ${timestampPeriod.toFixed(1)} Nanoseconds`);
            if (Donut_ImGuiCollapsingHeaderDefaultOpen("Settings") != 0) {
                hdr.objectIndex = Donut_ImGuiCombo("Object type", hdr.objectIndex, OBJECT_NAMES);
                hdr.bloom = Donut_ImGuiCheckbox("Bloom", hdr.bloom ? 1 : 0) != 0;
                hdr.displaySkybox = Donut_ImGuiCheckbox("Skybox", hdr.displaySkybox ? 1 : 0) != 0;
            }
            if (timestamps.anyMeasured()) {
                Donut_ImGuiText("Time Domain Selected:");
                Donut_ImGuiText(` ${timeDomainToString(timestamps.selectedTimeDomain)}`);
                for (let i = 0; i < TAGS.length; i++) {
                    if (timestamps.measured[i]) {
                        const microseconds = Math.fround(Math.fround(Math.fround(timestamps.deltas[i]) * timestampPeriod) * Math.fround(0.001));
                        Donut_ImGuiText(`${TAGS[i]}:`);
                        Donut_ImGuiText(` ${microseconds.toFixed(1)} Microseconds`);
                    }
                }
            }
            Donut_ImGuiPopItemWidth();
            Donut_ImGuiEnd();
        }

        // Declared after buildUI: tslang resolves `this.buildUI` only for members declared earlier.
        init(app: App): boolean {
            return !app.addImGuiPass(this.buildUI).isNull();
        }
    }

    // -test: checks the last frame and the times. The object in the middle and the environment
    // around it are lit (not black); every timed piece of code was timed, and took more than nothing
    // and less than 10 s.
    function checkFrame(app: App, timestamps: Timestamps, timestampPeriod: number): string {
        const width = app.getWindowWidth();
        const height = app.getWindowHeight();
        let pixels: int[] = [];
        for (let i = 0; i < width * height; i++) {
            pixels.push(0);
        }
        if (app.readBackBufferRGBA8(Ref(pixels[0]), pixels.length) == 0) {
            return "cannot read the back buffer";
        }
        let lit = 0;
        for (let i = 0; i < width * height; i++) {
            if ((pixels[i] & 0xFFFFFF) != 0) {
                lit++;
            }
        }
        const litFraction = lit / (width * height);
        console.log(`Lit ${litFraction}, timestamp period ${timestampPeriod} ns`);
        if (litFraction < 0.9) {
            return `only ${litFraction} of the frame is lit`;
        }
        if (timestampPeriod <= 0.0) {
            return "no timestamp period";
        }
        for (let i = 0; i < TAGS.length; i++) {
            if (!timestamps.measured[i]) {
                return `${TAGS[i]} was not timed`;
            }
            const microseconds = timestamps.deltas[i] * timestampPeriod * 0.001;
            console.log(`${TAGS[i]}: ${microseconds.toFixed(1)} Microseconds`);
            if (microseconds <= 0.0 || microseconds > 1e7) {
                return `${TAGS[i]} took ${microseconds} microseconds`;
            }
        }
        return "";
    }

    // -object <0..2>, -nobloom, -noskybox: the settings' initial values.
    class CalibratedTimestampsSampleArgs extends Args {
        objectIndex: int = 0;
        bloom = true;
        displaySkybox = true;

        protected parseOptions(): void {
            for (let i = 1; i < this.argc; i++) {
                const arg = this[i];
                if (arg == "-nobloom") {
                    this.bloom = false;
                } else if (arg == "-noskybox") {
                    this.displaySkybox = false;
                } else if (arg == "-object" && i + 1 < this.argc) {
                    i++;
                    this.objectIndex = Math.min(Math.max(parseInt(this[i]), 0), 2);
                }
            }
        }
    }

    export function main(argc: int, argv: Ref<string>): int {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("calibrated_timestamps");

        // -test [-testOutput <file>]: render a few frames without a window and check the last one
        // and the times (see checkFrame).
        const args = new CalibratedTimestampsSampleArgs(argc, argv, TEST_FRAMES);
        args.parseArgs();

        const app = App.createWithOptions(args.api, WINDOW_TITLE, 1280, 720, args.options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);
        const timestampPeriod = app.getTimestampPeriod();

        const hdr = new HdrPass(app);
        hdr.objectIndex = args.objectIndex;
        hdr.bloom = args.bloom;
        hdr.displaySkybox = args.displaySkybox;
        if (!hdr.init()) {
            app.destroy();
            return 1;
        }
        if (!hdr.timestamps.available()) {
            app.destroy();
            return unsupported(args.test, "The device has no calibrated timestamps (VK_EXT_calibrated_timestamps on Vulkan; D3D12).");
        }

        // Drawn after (over) the scene, and sees the mouse first.
        const gui = new UserInterface(hdr, timestampPeriod);
        if (!args.noUI && !gui.init(app)) {
            console.log("Cannot initialize the user interface");
            app.destroy();
            return 1;
        }

        const input = new InputPass(app.handle);

        app.run();
        let result = 0;
        if (args.test) {
            result = app.finishTest(checkFrame(app, hdr.timestamps, timestampPeriod));
        }
        app.destroy();
        return result;
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>): int {
    return CalibratedTimestampsSample.main(argc, argv);
}
