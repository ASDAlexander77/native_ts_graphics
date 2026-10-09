// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";

namespace OitDepthPeeling {
    const WINDOW_TITLE = "Donut Example: OIT Depth Peeling";

    // The sample's model and background (Vulkan-Samples' assets), the KTX texture converted to DDS
    // at build time (see VULKAN_SAMPLES_ASSETS_DIR in CMakeLists.txt).
    const OBJECT_PATH = "media/oit_depth_peeling/torusknot.gltf";
    const BACKGROUND_PATH = "media/oit_depth_peeling/vulkan_logo_full.dds";

    // Donut_LoadGltfMesh's vertices: float3 position, float3 normal, float2 texture coordinates.
    const VERTEX_SIZE = 32;

    // The layers peeled at most, and the depth targets taking turns.
    const LAYER_MAX_COUNT = 8;
    const DEPTH_COUNT = 2;

    // struct SceneConstants { float4x4 model_view_projection; float background_grayscale,
    // object_alpha; int front_layer_index, back_layer_index; }, as f32 offsets.
    const CONST_MVP = 0;
    const CONST_BACKGROUND_GRAYSCALE = 16;
    const CONST_OBJECT_ALPHA = 17;
    const CONST_FRONT_LAYER_INDEX = 18;
    const CONST_BACK_LAYER_INDEX = 19;
    const CONST_FLOATS = 20;

    // The sample's camera: a "look at" camera at (0, 0, -4), 60 degrees vertically, reversed depth
    // from 16 to 0.1 (glm::perspective with near and far swapped); the model scaled by 0.08.
    const CAMERA_POSITION = [0.0, 0.0, -4.0];
    const CAMERA_FOV = 60.0;
    const Z_NEAR = 16.0;
    const Z_FAR = 0.1;
    const MODEL_SCALE = 0.08;
    // Degrees per second about x and y, with auto-rotation on.
    const AUTO_ROTATION_SPEED = 5.0;
    // ApiVulkanSample's mouse controls: degrees per pixel dragged with the left button, zoom per
    // pixel with the right one, panning per pixel with the middle one.
    const ROTATION_SPEED = 1.0;
    const ZOOM_SPEED = 0.005;
    const PAN_SPEED = 0.01;

    // GLFW mouse buttons and actions.
    const MOUSE_BUTTON_LEFT = 0;
    const MOUSE_BUTTON_RIGHT = 1;
    const MOUSE_BUTTON_MIDDLE = 2;
    const ACTION_PRESS = 1;

    // --- Math (glm's layout: 4 x 4 matrices by columns) ---------------------------------------

    function radians(degrees: number): number {
        return degrees * Math.PI / 180.0;
    }

    // a * b.
    function multiply(a: number[], b: number[]): number[] {
        let result: number[] = [];
        for (let column = 0; column < 4; column++) {
            for (let row = 0; row < 4; row++) {
                let sum = 0.0;
                for (let k = 0; k < 4; k++) {
                    sum += a[k * 4 + row] * b[column * 4 + k];
                }
                result.push(sum);
            }
        }
        return result;
    }

    // glm::rotate(mat4(1), angle, axis) about a unit axis.
    function rotation(angle: number, x: number, y: number, z: number): number[] {
        const c = Math.cos(angle);
        const s = Math.sin(angle);
        const t = 1.0 - c;
        return [
            c + t * x * x,     t * x * y + s * z, t * x * z - s * y, 0.0,
            t * x * y - s * z, c + t * y * y,     t * y * z + s * x, 0.0,
            t * x * z + s * y, t * y * z - s * x, c + t * z * z,     0.0,
            0.0,               0.0,               0.0,               1.0,
        ];
    }

    function translation(x: number, y: number, z: number): number[] {
        return [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, x, y, z, 1.0];
    }

    function scale(x: number, y: number, z: number): number[] {
        return [x, 0.0, 0.0, 0.0, 0.0, y, 0.0, 0.0, 0.0, 0.0, z, 0.0, 0.0, 0.0, 0.0, 1.0];
    }

    // glm::perspective(fov, aspect, near, far) (right-handed, depth from 0 to 1), with clip y
    // negated: the sample's clip space has y down on the screen (Vulkan's), Donut's y up.
    function samplePerspective(fov: number, aspect: number, zNear: number, zFar: number): number[] {
        const tanHalfFovy = Math.tan(0.5 * fov);
        return [
            1.0 / (aspect * tanHalfFovy), 0.0,                0.0,                              0.0,
            0.0,                          -1.0 / tanHalfFovy, 0.0,                              0.0,
            0.0,                          0.0,                zFar / (zNear - zFar),            -1.0,
            0.0,                          0.0,                -(zFar * zNear) / (zFar - zNear), 0.0,
        ];
    }

    // Port of Vulkan-Samples' oit_depth_peeling: order-independent transparency by depth peeling
    // (Cass Everitt's): a transparent torus knot is drawn up to 8 times, each gather pass keeping
    // the nearest fragments behind the layer the pass before kept (its depth target, read as a
    // texture), into a layer texture of its own; a combine pass blends the layers back to front over
    // the background. Pixel-perfect, whatever the triangles' order.
    class DepthPeelingPass {
        private app: App;

        // The sample's settings.
        cameraAutoRotation: boolean;
        backgroundGrayscale: number;
        objectAlpha: number;
        frontLayerIndex: int;
        backLayerIndex: int;

        // The sample's camera: rotation (degrees about x, y, z) and position.
        private cameraRotation: number[];
        private cameraPosition: number[];
        private leftButton: boolean;
        private rightButton: boolean;
        private middleButton: boolean;
        private mouseX: number;
        private mouseY: number;

        private fullscreenVS: Opaque;
        private backgroundPS: Opaque;
        private combinePS: Opaque;
        private gatherVS: Opaque;
        private gatherFirstPS: Opaque;
        private gatherPS: Opaque;
        private inputLayout: Opaque;
        private gatherBindingLayout: Opaque;
        private combineBindingLayout: Opaque;
        private constantBuffer: Opaque;
        private background: Opaque;
        private object: GltfMesh;

        // The back buffer's size: the layers, the depth targets, their framebuffers and binding
        // sets, the color target (sRGB, as the sample's swapchain) and the pipelines.
        private layers: Opaque[];
        private depths: Opaque[];
        private gatherFramebuffers: Opaque[];
        private gatherBindingSets: BindingSet[];
        private combineBindingSet: BindingSet;
        private colorBuffer: Opaque | null;
        private framebuffer: Opaque | null;
        private gatherFirstPipeline: Opaque | null;
        private gatherPipeline: Opaque | null;
        private backgroundPipeline: Opaque | null;
        private combinePipeline: Opaque | null;

        private constants: f32[];

        constructor(app: App) {
            this.app = app;
            this.cameraAutoRotation = false;
            this.backgroundGrayscale = 0.3;
            this.objectAlpha = 0.5;
            this.frontLayerIndex = 0;
            this.backLayerIndex = LAYER_MAX_COUNT - 1;
            this.cameraRotation = [0.0, 0.0, 0.0];
            this.cameraPosition = [CAMERA_POSITION[0], CAMERA_POSITION[1], CAMERA_POSITION[2]];
            this.leftButton = false;
            this.rightButton = false;
            this.middleButton = false;
            this.mouseX = 0.0;
            this.mouseY = 0.0;
            this.layers = [];
            this.depths = [];
            this.gatherFramebuffers = [];
            this.gatherBindingSets = [];
            this.combineBindingSet = new BindingSet(null);
            this.colorBuffer = null;
            this.framebuffer = null;
            this.gatherFirstPipeline = null;
            this.gatherPipeline = null;
            this.backgroundPipeline = null;
            this.combinePipeline = null;
            this.constants = [];
            for (let i = 0; i < CONST_FLOATS; i++) {
                this.constants.push(0.0);
            }
        }

        // ApiVulkanSample's mouse handling: dragging with the left button rotates the camera, with
        // the right one zooms, with the middle one pans.
        onMousePos(x: number, y: number): int {
            const dx = this.mouseX - x;
            const dy = this.mouseY - y;
            if (this.leftButton) {
                this.cameraRotation[0] += dy * ROTATION_SPEED;
                this.cameraRotation[1] -= dx * ROTATION_SPEED;
            }
            if (this.rightButton) {
                this.cameraPosition[2] += dy * ZOOM_SPEED;
            }
            if (this.middleButton) {
                this.cameraPosition[0] -= dx * PAN_SPEED;
                this.cameraPosition[1] -= dy * PAN_SPEED;
            }
            this.mouseX = x;
            this.mouseY = y;
            return 1;
        }

        onMouseButton(button: int, action: int, mods: int): int {
            const pressed = action == ACTION_PRESS;
            if (button == MOUSE_BUTTON_LEFT) {
                this.leftButton = pressed;
            } else if (button == MOUSE_BUTTON_RIGHT) {
                this.rightButton = pressed;
            } else if (button == MOUSE_BUTTON_MIDDLE) {
                this.middleButton = pressed;
            }
            return 1;
        }

        onAnimate(elapsedSeconds: number): void {
            if (this.cameraAutoRotation) {
                this.cameraRotation[0] += elapsedSeconds * AUTO_ROTATION_SPEED;
                this.cameraRotation[1] += elapsedSeconds * AUTO_ROTATION_SPEED;
            }
            this.app.setInformativeWindowTitle(WINDOW_TITLE);
        }

        releaseTargets(): void {
            const bindingSets = [this.combineBindingSet];
            for (let i = 0; i < this.gatherBindingSets.length; i++) {
                bindingSets.push(this.gatherBindingSets[i]);
            }
            for (let i = 0; i < bindingSets.length; i++) {
                const bindingSet = bindingSets[i];
                if (!bindingSet.isNull()) {
                    this.app.releaseResource(bindingSet.handle);
                }
            }
            this.gatherBindingSets = [];
            this.combineBindingSet = new BindingSet(null);

            const sized = [this.gatherFirstPipeline, this.gatherPipeline, this.backgroundPipeline, this.combinePipeline,
                this.framebuffer, this.colorBuffer];
            for (let i = 0; i < sized.length; i++) {
                const resource = sized[i];
                if (resource) {
                    this.app.releaseResource(resource);
                }
            }
            for (let i = 0; i < this.gatherFramebuffers.length; i++) {
                this.app.releaseResource(this.gatherFramebuffers[i]);
            }
            for (let i = 0; i < this.layers.length; i++) {
                this.app.releaseResource(this.layers[i]);
            }
            for (let i = 0; i < this.depths.length; i++) {
                this.app.releaseResource(this.depths[i]);
            }
            this.gatherFramebuffers = [];
            this.layers = [];
            this.depths = [];
            this.gatherFirstPipeline = null;
            this.gatherPipeline = null;
            this.backgroundPipeline = null;
            this.combinePipeline = null;
            this.framebuffer = null;
            this.colorBuffer = null;
        }

        onBackBufferResizing(): void {
            this.releaseTargets();
            // The blit's cached binding sets still reference the old color buffer.
            this.app.clearBindingCache();
        }

        // The sample's create_sized_objects and the pipelines drawing into them.
        createTargets(width: int, height: int): void {
            for (let i = 0; i < LAYER_MAX_COUNT; i++) {
                this.layers.push(this.app.createRenderTargetTexture(width, height, Format.RGBA8_UNORM, `Layer${i}`));
            }
            for (let i = 0; i < DEPTH_COUNT; i++) {
                this.depths.push(this.app.createRenderTargetTexture(width, height, Format.D32, `Depth${i}`));
            }
            // A layer each, with the depth targets taking turns.
            for (let i = 0; i < LAYER_MAX_COUNT; i++) {
                this.gatherFramebuffers.push(this.app.createFramebuffer(this.layers[i], this.depths[i % DEPTH_COUNT]));
            }
            // The pass drawing into depth target i reads the other one.
            for (let i = 0; i < DEPTH_COUNT; i++) {
                const setDesc = BindingSetDesc.create();
                setDesc.bindEntireConstantBuffer(0, this.constantBuffer);
                setDesc.bindTextureSRV(0, this.depths[(i + 1) % DEPTH_COUNT]);
                this.gatherBindingSets.push(this.app.createBindingSetForLayout(setDesc, this.gatherBindingLayout));
            }
            const combineSetDesc = BindingSetDesc.create();
            combineSetDesc.bindEntireConstantBuffer(0, this.constantBuffer);
            combineSetDesc.bindTextureSRV(1, this.background);
            // The framework's texture sampler: trilinear, the device's maximum anisotropy (16).
            combineSetDesc.bindSampler(1, this.app.getCommonSampler(CommonSampler.AnisotropicWrap));
            for (let i = 0; i < LAYER_MAX_COUNT; i++) {
                combineSetDesc.bindTextureSRVArrayElement(2, i, this.layers[i]);
            }
            combineSetDesc.bindSampler(0, this.app.getCommonSampler(CommonSampler.PointClamp));
            this.combineBindingSet = this.app.createBindingSetForLayout(combineSetDesc, this.combineBindingLayout);

            const colorBuffer = this.app.createRenderTargetTexture(width, height, Format.SRGBA8_UNORM, "ColorBuffer");
            const framebuffer = this.app.createFramebuffer(colorBuffer, null);
            this.colorBuffer = colorBuffer;
            this.framebuffer = framebuffer;

            // The gather passes: no culling, reversed depth (greater passes), written.
            const gatherFramebuffer = this.gatherFramebuffers[0];
            this.gatherFirstPipeline = this.createGatherPipeline(gatherFramebuffer, this.gatherFirstPS);
            this.gatherPipeline = this.createGatherPipeline(gatherFramebuffer, this.gatherPS);

            // The background, then the layers combined and alpha blended over it (the sample's
            // alpha factors are One and Zero; the color target's alpha isn't shown).
            this.backgroundPipeline = this.createFullscreenPipeline(framebuffer, this.backgroundPS, BlendMode.None);
            this.combinePipeline = this.createFullscreenPipeline(framebuffer, this.combinePS, BlendMode.AlphaBlend);
        }

        createGatherPipeline(framebuffer: Opaque, pixelShader: Opaque): Opaque {
            const desc = GraphicsPipelineDesc.create(this.gatherVS, pixelShader);
            desc.setInputLayout(this.inputLayout);
            desc.addBindingLayout(this.gatherBindingLayout);
            desc.setDepthState(1, 1, ComparisonFunc.Greater);
            desc.setRasterState(CullMode.None, FillMode.Solid, 1);
            return this.app.createGraphicsPipelineFromDesc(desc, framebuffer);
        }

        createFullscreenPipeline(framebuffer: Opaque, pixelShader: Opaque, blendMode: BlendMode): Opaque {
            const desc = GraphicsPipelineDesc.create(this.fullscreenVS, pixelShader);
            desc.addBindingLayout(this.combineBindingLayout);
            desc.setDepthState(0, 0, ComparisonFunc.Greater);
            desc.setRasterState(CullMode.None, FillMode.Solid, 1);
            desc.setBlendMode(blendMode);
            return this.app.createGraphicsPipelineFromDesc(desc, framebuffer);
        }

        // The sample's update_scene_constants.
        updateConstants(width: int, height: int): void {
            const c = this.constants;
            const projection = samplePerspective(radians(CAMERA_FOV), width / height, Z_NEAR, Z_FAR);
            // A "look at" camera: translation * rotation (about x, then y, then z).
            const r = this.cameraRotation;
            let rotationMatrix = multiply(rotation(radians(r[0]), 1.0, 0.0, 0.0), rotation(radians(r[1]), 0.0, 1.0, 0.0));
            rotationMatrix = multiply(rotationMatrix, rotation(radians(r[2]), 0.0, 0.0, 1.0));
            const p = this.cameraPosition;
            const view = multiply(translation(p[0], p[1], p[2]), rotationMatrix);
            const mvp = multiply(multiply(projection, view), scale(MODEL_SCALE, MODEL_SCALE, MODEL_SCALE));
            for (let i = 0; i < 16; i++) {
                c[CONST_MVP + i] = mvp[i];
            }
            c[CONST_BACKGROUND_GRAYSCALE] = this.backgroundGrayscale;
            c[CONST_OBJECT_ALPHA] = this.objectAlpha;
            Donut_StoreInt32(Ref(c[CONST_FRONT_LAYER_INDEX]), this.frontLayerIndex);
            Donut_StoreInt32(Ref(c[CONST_BACK_LAYER_INDEX]), this.backLayerIndex);
        }

        onRender(frameHandle: Opaque): void {
            const frame = new Frame(frameHandle);
            const width = frame.getWidth();
            const height = frame.getHeight();
            const commandList = frame.getCommandList();

            if (!this.framebuffer) {
                this.createTargets(width, height);
            }
            const framebuffer = this.framebuffer;
            const colorBuffer = this.colorBuffer;
            const gatherFirstPipeline = this.gatherFirstPipeline;
            const gatherPipeline = this.gatherPipeline;
            const backgroundPipeline = this.backgroundPipeline;
            const combinePipeline = this.combinePipeline;
            if (!framebuffer || !colorBuffer || !gatherFirstPipeline || !gatherPipeline || !backgroundPipeline
                || !combinePipeline) {
                return;
            }

            this.updateConstants(width, height);
            commandList.writeBuffer(this.constantBuffer, Ref(this.constants[0]), CONST_FLOATS * 4);

            // Gather passes
            // Each pass renders a single transparent layer into a layer texture.
            for (let l = 0; l <= this.backLayerIndex; l++) {
                // Two depth textures are used.
                // Their roles alternates for each pass.
                // The first depth texture is used for fixed-function depth test.
                // The second one is the result of the depth test from the previous gather pass.
                // It is bound as texture and read in the shader to discard fragments from the
                // previous layers.
                commandList.clearTextureFloat(this.layers[l], 0.0, 0.0, 0.0, 0.0);
                commandList.clearDepth(this.depths[l % DEPTH_COUNT], 0.0);
                frame.beginDrawToFramebuffer(l == 0 ? gatherFirstPipeline : gatherPipeline, this.gatherFramebuffers[l]);
                frame.drawAddBindingSet(this.gatherBindingSets[l % DEPTH_COUNT]);
                frame.drawAddVertexBuffer(this.object.getVertexBuffer(), 0, 0);
                frame.drawSetIndexBuffer(this.object.getIndexBuffer());
                frame.drawIndexed(this.object.getIndexCount());
            }

            // Combine pass
            // This pass blends all the layers into the final transparent color.
            // The final color is then alpha blended into the background.
            commandList.clearTextureFloat(colorBuffer, 0.0, 0.0, 0.0, 0.0);
            frame.beginDrawToFramebuffer(backgroundPipeline, framebuffer);
            frame.drawAddBindingSet(this.combineBindingSet);
            frame.drawVertices(3);
            frame.beginDrawToFramebuffer(combinePipeline, framebuffer);
            frame.drawAddBindingSet(this.combineBindingSet);
            frame.drawVertices(3);

            this.app.blitTexture(frame, colorBuffer);
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(): boolean {
            const shader = "oit_depth_peeling.hlsl";
            this.fullscreenVS = this.app.createShader(shader, "fullscreen_vs", ShaderType.Vertex);
            this.backgroundPS = this.app.createShader(shader, "background_ps", ShaderType.Pixel);
            this.combinePS = this.app.createShader(shader, "combine_ps", ShaderType.Pixel);
            this.gatherVS = this.app.createShader(shader, "gather_vs", ShaderType.Vertex);
            this.gatherFirstPS = this.app.createShader(shader, "gather_first_ps", ShaderType.Pixel);
            this.gatherPS = this.app.createShader(shader, "gather_ps", ShaderType.Pixel);
            if (!this.fullscreenVS || !this.backgroundPS || !this.combinePS || !this.gatherVS || !this.gatherFirstPS
                || !this.gatherPS) {
                return false;
            }

            // Positions and texture coordinates.
            const layoutDesc = InputLayoutDesc.create();
            layoutDesc.addVertexAttribute("POSITION", Format.RGB32_FLOAT, 0, 0, VERTEX_SIZE);
            layoutDesc.addVertexAttribute("TEXCOORD", Format.RG32_FLOAT, 24, 0, VERTEX_SIZE);
            this.inputLayout = this.app.createInputLayout(layoutDesc, this.gatherVS);

            // The blit's common passes, created on first use, upload their textures on a command
            // list of their own: create them before ours (or the frame's) is open.
            this.app.getCommonSampler(CommonSampler.PointClamp);

            const commandList = this.app.createCommandList();
            commandList.open();
            const object = this.app.loadGltfMesh(commandList, OBJECT_PATH);
            // KTX 1 files have no color space: the framework takes color textures as sRGB.
            const background = this.app.loadTexture(commandList, BACKGROUND_PATH, 1);
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.waitForIdle();
            this.app.releaseResource(commandList.handle);
            if (object.isNull() || !background) {
                console.log("Cannot load the model and the texture: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return false;
            }
            this.object = object;
            this.background = background;

            this.constantBuffer = this.app.createVolatileConstantBuffer(CONST_FLOATS * 4, "SceneConstants");

            // The gather passes: the constants and the other depth target.
            const gatherLayoutDesc = BindingLayoutDesc.create();
            gatherLayoutDesc.layoutVolatileConstantBuffer(0);
            gatherLayoutDesc.layoutTextureSRV(0);
            this.gatherBindingLayout = this.app.createBindingLayout(gatherLayoutDesc, ShaderType.All);

            // The background and combine passes: the constants, the background texture and the
            // layers.
            const combineLayoutDesc = BindingLayoutDesc.create();
            combineLayoutDesc.layoutVolatileConstantBuffer(0);
            combineLayoutDesc.layoutTextureSRV(1);
            combineLayoutDesc.layoutSampler(1);
            combineLayoutDesc.layoutTextureSRVArray(2, LAYER_MAX_COUNT);
            combineLayoutDesc.layoutSampler(0);
            this.combineBindingLayout = this.app.createBindingLayout(combineLayoutDesc, ShaderType.Pixel);

            const pass = this.app.addPass();
            pass.setMousePosCallback(this.onMousePos);
            pass.setMouseButtonCallback(this.onMouseButton);
            pass.setAnimateCallback(this.onAnimate);
            pass.setBackBufferResizingCallback(this.onBackBufferResizing);
            pass.setRenderCallback(this.onRender);
            return true;
        }
    }

    // The sample's overlay.
    class UserInterface {
        private sample: DepthPeelingPass;

        constructor(sample: DepthPeelingPass) {
            this.sample = sample;
        }

        buildUI(): void {
            const sample = this.sample;
            Donut_ImGuiSetNextWindowPos(10.0, 10.0);
            // The sample's title (ApiVulkanSample's default).
            Donut_ImGuiBegin("Vulkan Example", 1);
            sample.cameraAutoRotation = Donut_ImGuiCheckbox("Camera auto-rotation", sample.cameraAutoRotation ? 1 : 0) != 0;
            sample.backgroundGrayscale = Donut_ImGuiSliderFloat("Background grayscale", sample.backgroundGrayscale, 0.0, 1.0);
            sample.objectAlpha = Donut_ImGuiSliderFloat("Object opacity", sample.objectAlpha, 0.0, 1.0);
            sample.frontLayerIndex = Donut_ImGuiSliderInt("Front layer index", sample.frontLayerIndex, 0, sample.backLayerIndex);
            sample.backLayerIndex = Donut_ImGuiSliderInt("Back layer index", sample.backLayerIndex, sample.frontLayerIndex, LAYER_MAX_COUNT - 1);
            Donut_ImGuiEnd();
        }

        // Declared after buildUI: tslang resolves `this.buildUI` only for members declared earlier.
        init(app: App): boolean {
            return !app.addImGuiPass(this.buildUI).isNull();
        }
    }

    export function main(argc: int, argv: Ref<string>): int {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("oit_depth_peeling");

        // -debug: the graphics API's debug layer and NVRHI's validation layer.
        // -noui: without the settings window.
        // -layers <front> <back>: the layers combined (0..7).
        // -alpha <value>, -grayscale <value>: the object's opacity, the background's brightness.
        // -rotate: start with the camera's auto-rotation on.
        let options = AppOptions.None;
        let withUI = true;
        let frontLayer = 0;
        let backLayer = LAYER_MAX_COUNT - 1;
        let alpha = 0.5;
        let grayscale = 0.3;
        let rotate = false;
        for (let i = 1; i < argc; i++) {
            const arg = Donut_GetArg(argv, i);
            if (arg == "-debug") {
                options = AppOptions.DebugRuntime;
            } else if (arg == "-noui") {
                withUI = false;
            } else if (arg == "-rotate") {
                rotate = true;
            } else if (arg == "-layers" && i + 2 < argc) {
                backLayer = Math.min(Math.max(parseInt(Donut_GetArg(argv, i + 2)), 0), LAYER_MAX_COUNT - 1);
                frontLayer = Math.min(Math.max(parseInt(Donut_GetArg(argv, i + 1)), 0), backLayer);
                i += 2;
            } else if (arg == "-alpha" && i + 1 < argc) {
                i++;
                alpha = parseFloat(Donut_GetArg(argv, i));
            } else if (arg == "-grayscale" && i + 1 < argc) {
                i++;
                grayscale = parseFloat(Donut_GetArg(argv, i));
            }
        }

        const api = Donut_GetGraphicsAPIFromCommandLine(argc, argv);
        const app = App.createWithOptions(api, WINDOW_TITLE, 1280, 720, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        const sample = new DepthPeelingPass(app);
        sample.frontLayerIndex = frontLayer;
        sample.backLayerIndex = backLayer;
        sample.objectAlpha = alpha;
        sample.backgroundGrayscale = grayscale;
        sample.cameraAutoRotation = rotate;
        if (!sample.init()) {
            app.destroy();
            return 1;
        }

        // Drawn after (over) the scene, and sees the mouse first.
        const gui = new UserInterface(sample);
        if (withUI && !gui.init(app)) {
            console.log("Cannot initialize the user interface");
            app.destroy();
            return 1;
        }

        const input = new InputPass(app.handle);

        app.run();
        app.destroy();
        return 0;
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>): int {
    return OitDepthPeeling.main(argc, argv);
}
