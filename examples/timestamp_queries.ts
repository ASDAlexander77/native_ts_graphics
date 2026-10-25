// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";
import { Args } from "../core/args";
import { TestCheck } from "../core/test_check";
import { perspProjReverse, radiansF32 } from "../core/matrix";

namespace TimestampQueries {
    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    // -test: checks the last frame: the HDR skybox scene fills it (about 98% lit), its sky and the
    // sphere's highlights about 3.7% white.
    function checkFrame(app: App) {
        const check = new TestCheck(app);
        if (check.frameRead() != "") {
            return check.frameRead();
        }
        const total = check.width * check.height;
        const lit = check.share(total - check.countInRange(0, 20, 0, 20, 0, 20, 0, 0, check.width, check.height), total,
            92.0, 100.0, "Lit");
        if (lit != "") {
            return lit;
        }
        return check.share(check.countInRange(221, 255, 221, 255, 221, 255, 0, 0, check.width, check.height), total,
            2.0, 6.0, "White");
    }

    const WINDOW_TITLE = "Donut Example: Timestamp Queries";

    // The sample's models and HDR cube map (Vulkan-Samples' assets, hdr's copies: the KTX cube map
    // converted to DDS at build time, see VULKAN_SAMPLES_ASSETS_DIR in CMakeLists.txt).
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

    // GPU times are measured in this many frames in turn, each read back when its turn comes again
    // (by then the GPU has finished it, so reading it doesn't wait).
    const TIMER_FRAMES = 3;
    // The passes measured: the offscreen scene, the first bloom pass (or the scene's display), the
    // second bloom pass.
    const TIMED_PASSES = 3;

    // The sample's camera: reversed depth from 0.1 to 256.
    const Z_NEAR = 0.1;
    const Z_FAR = 256.0;

    // --- Math ---------------------------------------------------------------------------------

    // The sample's glm::perspective(fov, aspect, 256, 0.1) (near and far swapped for reversed
    // depth; right-handed, depth from 0 to 1), for row vectors, with clip y negated: the sample's
    // clip space has y down on the screen (Vulkan's), Donut's y up.
    // In float32, in glm's order of operations.
    function samplePerspective(verticalFOV: number, aspect: number, zNear: number, zFar: number) {
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

    // --- Passes -------------------------------------------------------------------------------

    // Port of Vulkan-Samples' timestamp_queries: its hdr sample (see hdr.ts; a reflective object in
    // front of an HDR environment cube map, rendered to two float targets, the bright parts blurred
    // in two passes, the second added over the colors as they are copied to the back buffer) with
    // the GPU time of each of its passes measured by timer queries (the sample's timestamps at the
    // start and end of each render pass) and shown in the UI. The sample's last pass includes its
    // UI; here the UI is a pass of its own, after the measured ones.
    class HdrPass {
        private app: App;
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

        // Timer queries: TIMED_PASSES per frame of TIMER_FRAMES, the frame measuring next, which
        // frames hold measurements not read yet (and whether bloom was on then), and the latest
        // times read (milliseconds).
        private timers: TimerQueryHandle[];
        private timerFrame: int;
        private timerPending: boolean[];
        private timerBloom: boolean[];
        passTimes: number[];
        // Whether passTimes were measured with bloom.
        passTimesBloom: boolean;
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

            this.timers = [];
            this.timerFrame = 0;
            this.timerPending = [];
            this.timerBloom = [];
            for (let i = 0; i < TIMER_FRAMES; i++) {
                this.timerPending.push(false);
                this.timerBloom.push(false);
            }
            this.passTimes = [0.0, 0.0, 0.0];
            this.passTimesBloom = true;
        }

        init() {
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

            const commandList = this.app.createCommandList();
            commandList.open();
            const skybox = this.app.loadGltfMesh(commandList, SKYBOX_PATH);
            let objectsLoaded = !skybox.isNull();
            for (const objectPath of OBJECT_PATHS) {
                const mesh = this.app.loadGltfMesh(commandList, objectPath);
                objectsLoaded = objectsLoaded && !mesh.isNull();
                this.objects.push(mesh);
            }
            // Load HDR cube map
            const envmap = this.app.loadTexture(commandList, ENVMAP_PATH, 0);
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.waitForIdle();
            this.app.releaseResource(commandList.handle);
            if (!objectsLoaded || !envmap) {
                console.log("Cannot load the models and the cube map: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return false;
            }
            this.skybox = skybox;

            for (let i = 0; i < TIMER_FRAMES * TIMED_PASSES; i++) {
                this.timers.push(this.app.createTimerQuery());
            }

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

        // The sample's get_time_stamp_results: this frame's timers, measured TIMER_FRAMES frames
        // ago, read back and reset for this frame's measurements.
        readTimers() {
            const first = this.timerFrame * TIMED_PASSES;
            if (this.timerPending[this.timerFrame]) {
                const count = this.timerBloom[this.timerFrame] ? TIMED_PASSES : TIMED_PASSES - 1;
                for (let i = 0; i < count; i++) {
                    this.passTimes[i] = this.app.getTimerQueryTime(this.timers[first + i]) * 1000.0;
                }
                this.passTimesBloom = this.timerBloom[this.timerFrame];
            }
            for (let i = 0; i < TIMED_PASSES; i++) {
                this.app.resetTimerQuery(this.timers[first + i]);
            }
            this.timerPending[this.timerFrame] = true;
            this.timerBloom[this.timerFrame] = this.bloom;
        }

        timer(pass: int) {
            return this.timers[this.timerFrame * TIMED_PASSES + pass];
        }

        onKey(key: Key, scancode: int, action: Action, mods: KeyMods) {
            this.camera.keyboardUpdate(key, scancode, action, mods);
            return 1;
        }

        onMousePos(x: number, y: number) {
            this.camera.mousePosUpdate(x, y);
            return 1;
        }

        onMouseButton(button: MouseButton, action: Action, mods: KeyMods) {
            this.camera.mouseButtonUpdate(button, action, mods);
            return 1;
        }

        onMouseScroll(xOffset: number, yOffset: number) {
            this.camera.mouseScrollUpdate(xOffset, yOffset);
            return 1;
        }

        onAnimate(elapsedSeconds: number) {
            this.camera.animate(elapsedSeconds);
            this.app.setInformativeWindowTitle(WINDOW_TITLE);
        }

        releaseTargets() {
            this.app.releaseBindingSets([this.bloomFilterBindingSet, this.compositionBindingSet]);
            this.bloomFilterBindingSet = new BindingSet(null);
            this.compositionBindingSet = new BindingSet(null);

            this.app.releaseResources([this.skyboxPipeline, this.reflectPipeline, this.bloomFilterPipeline,
                this.compositionPipeline, this.bloomCompositePipeline, this.offscreenFramebuffer,
                this.filterFramebuffer, this.offscreenColor0, this.offscreenColor1, this.offscreenDepth,
                this.filterColor]);
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

        onBackBufferResizing() {
            this.releaseTargets();
        }

        // The skybox and the object, into the offscreen targets: reversed depth (greater passes),
        // counter-clockwise front faces. The sample's projection keeps its framebuffer
        // coordinates, so its cull modes too.
        createModelPipeline(framebuffer: FramebufferHandle, vertexShader: ShaderHandle, pixelShader: ShaderHandle, depthTestAndWrite: int,
            cullMode: CullMode) {
            const desc = GraphicsPipelineDesc.create(vertexShader, pixelShader);
            desc.setInputLayout(this.inputLayout);
            desc.addBindingLayout(this.modelsBindingLayout);
            desc.setDepthState(depthTestAndWrite, depthTestAndWrite, ComparisonFunc.Greater);
            desc.setRasterState(cullMode, FillMode.Solid, 1);
            return this.app.createGraphicsPipelineFromDesc(desc, framebuffer);
        }

        createPostBindingSet(texture0: TextureHandle, texture1: TextureHandle) {
            const setDesc = BindingSetDesc.create();
            setDesc.bindTextureSRV(0, texture0);
            setDesc.bindTextureSRV(1, texture1);
            setDesc.bindSampler(0, this.app.getCommonSampler(CommonSampler.PointClamp));
            return this.app.createBindingSetForLayout(setDesc, this.postBindingLayout);
        }

        // The sample's prepare_offscreen_buffer and the pipelines drawing into its targets.
        createTargets(frame: Frame, width: int, height: int) {
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
        updateConstants(width: int, height: int) {
            const projection = perspProjReverse(radiansF32(60.0), width / height, Z_NEAR, Z_FAR);
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
            const sampleProjection = samplePerspective(radiansF32(60.0), width / height, Z_NEAR, Z_FAR);
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

        drawModel(frame: Frame, pipeline: GraphicsPipelineHandle, framebuffer: FramebufferHandle, mesh: GltfMesh) {
            frame.beginDrawToFramebuffer(pipeline, framebuffer);
            frame.drawAddBindingSet(this.modelsBindingSet);
            frame.drawAddVertexBuffer(mesh.getVertexBuffer(), 0, 0);
            frame.drawSetIndexBuffer(mesh.getIndexBuffer());
            frame.drawIndexed(mesh.getIndexCount());
        }

        onRender(frameHandle: FrameHandle) {
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

            this.updateConstants(width, height);
            commandList.writeBuffer(this.matricesBuffer, Ref(this.matrices[0]), CONST_FLOATS * 4);
            commandList.writeBuffer(this.paramsBuffer, Ref(this.params[0]), PARAMS_FLOATS * 4);

            this.readTimers();

            /*
                First pass: Render scene to offscreen framebuffer
            */

            commandList.beginTimerQuery(this.timer(0));

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

            commandList.endTimerQuery(this.timer(0));

            /*
                Second render pass: First bloom pass
            */
            if (this.bloom) {
                commandList.beginTimerQuery(this.timer(1));
                commandList.clearTextureFloat(filterColor, 0.0, 0.0, 0.0, 0.0);
                frame.beginDrawToFramebuffer(bloomFilterPipeline, filterFramebuffer);
                frame.drawAddBindingSet(this.bloomFilterBindingSet);
                frame.drawVertices(3);
                commandList.endTimerQuery(this.timer(1));
            }

            /*
                Third render pass: Scene rendering with applied second bloom pass (when enabled)
            */

            const finalTimer = this.timer(this.bloom ? 2 : 1);
            commandList.beginTimerQuery(finalTimer);

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

            commandList.endTimerQuery(finalTimer);
            this.timerFrame = (this.timerFrame + 1) % TIMER_FRAMES;
        }
    }

    // "%.3f".
    function formatMs(ms: number) {
        const thousandths = Math.round(ms * 1000.0);
        const whole = Math.floor(thousandths / 1000);
        const fraction = thousandths - whole * 1000;
        const digits = `${fraction}`;
        return `${whole}.${fraction < 10 ? "00" : fraction < 100 ? "0" : ""}${digits}`;
    }

    // The sample's overlay.
    class UserInterface {
        private hdr: HdrPass;

        constructor(hdr: HdrPass) {
            this.hdr = hdr;
        }

        init(app: App) {
            return !app.addImGuiPass(this.buildUI).isNull();
        }

        buildUI() {
            const hdr = this.hdr;
            Donut_ImGuiSetNextWindowPos(10.0, 10.0);
            Donut_ImGuiBegin("Timestamp queries", true);
            Donut_ImGuiPushItemWidth(110.0);
            if (Donut_ImGuiCollapsingHeaderDefaultOpen("Settings")) {
                hdr.objectIndex = Donut_ImGuiCombo("Object type", hdr.objectIndex, OBJECT_NAMES);
                hdr.exposure = Donut_ImGuiInputFloat("Exposure", hdr.exposure, 0.025, "%.3f");
                hdr.bloom = Donut_ImGuiCheckbox("Bloom", hdr.bloom);
                hdr.displaySkybox = Donut_ImGuiCheckbox("Skybox", hdr.displaySkybox);
            }
            if (Donut_ImGuiCollapsingHeaderDefaultOpen("timing")) {
                const times = hdr.passTimes;
                Donut_ImGuiText(`Pass 1: Offscreen scene rendering: ${formatMs(times[0])} ms`);
                Donut_ImGuiText(`Pass 2: ${hdr.passTimesBloom ? "First bloom pass" : "Scene display"} ${formatMs(times[1])} ms`);
                if (hdr.passTimesBloom) {
                    Donut_ImGuiText(`Pass 3: Second bloom pass ${formatMs(times[2])} ms`);
                }
            }
            Donut_ImGuiPopItemWidth();
            Donut_ImGuiEnd();
        }
    }

    class TimestampQueriesArgs extends Args {
        // -object <0..2>, -exposure <value>, -nobloom, -noskybox: the settings' initial values.
        objectIndex = 0;
        exposure = 1.0;
        bloom = true;
        displaySkybox = true;

        protected parseOptions() {
            for (let i = 1; i < this.argc; i++) {
                const arg = this[i];
                if (arg == "-nobloom") {
                    this.bloom = false;
                } else if (arg == "-noskybox") {
                    this.displaySkybox = false;
                } else if (arg == "-object" && i + 1 < this.argc) {
                    i++;
                    this.objectIndex = Math.min(Math.max(parseInt(this[i]), 0), 2);
                } else if (arg == "-exposure" && i + 1 < this.argc) {
                    i++;
                    this.exposure = parseFloat(this[i]);
                }
            }
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("timestamp_queries");

        const args = new TimestampQueriesArgs(argc, argv, TEST_FRAMES);
        args.parseArgs();

        const app = App.createWithOptions(args.api, WINDOW_TITLE, 1280, 720, args.options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        const hdr = new HdrPass(app);
        hdr.objectIndex = args.objectIndex;
        hdr.exposure = args.exposure;
        hdr.bloom = args.bloom;
        hdr.displaySkybox = args.displaySkybox;
        if (!hdr.init()) {
            app.destroy();
            return 1;
        }

        // Drawn after (over) the scene, and sees the mouse first.
        const gui = new UserInterface(hdr);
        if (!args.noUI && !gui.init(app)) {
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
    return TimestampQueries.main(argc, argv);
}
