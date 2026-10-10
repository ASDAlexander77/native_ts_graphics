// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";

namespace ShaderObjectSample {
    const WINDOW_TITLE = "Donut Example: Shader Object";

    // The sample's models and textures (Vulkan-Samples' assets, other ports' copies: the KTX
    // textures converted to DDS at build time, see VULKAN_SAMPLES_ASSETS_DIR in CMakeLists.txt).
    const TORUS_PATH = "media/hdr/torusknot.gltf";
    const ROCK_PATH = "media/instancing/rock.gltf";
    const CUBE_PATH = "media/hdr/cube.gltf";
    const SKYBOX_PATH = "media/hdr/geosphere.gltf";
    const TEAPOT_PATH = "media/hdr/teapot.gltf";
    const ENVMAP_PATH = "media/terrain_tessellation/skysphere_rgba.dds";
    const CHECKERBOARD_PATH = "media/texture_mipmap_generation/checkerboard_rgba.dds";
    const TERRAIN_LAYERS_PATH = "media/terrain_tessellation/terrain_texturearray_rgba.dds";
    const HEIGHTMAP_PATH = "media/terrain_tessellation/terrain_heightmap_r16.dds";

    // The heightmap DDS: a DX10 header (148 bytes), then 1024 x 1024 R16_UNORM texels.
    const HEIGHTMAP_HEADER_SIZE = 148;
    const HEIGHTMAP_DIM = 1024;

    // The sample's generate_terrain: a 256 x 256 grid, 1024 units wide.
    const TERRAIN_RESOLUTION = 256;
    const TERRAIN_SIZE = 1024;

    // Donut_LoadGltfMesh's vertices (and the terrain's): float3 position, float3 normal, float2
    // texture coordinates.
    const VERTEX_SIZE = 32;
    const NORMAL_OFFSET = 12;
    const UV_OFFSET = 24;

    // struct UBO { float4x4 projection, view, proj_view; float postElapsedTime; }, padded.
    const UBO_PROJECTION = 0;
    const UBO_VIEW = 16;
    const UBO_PROJ_VIEW = 32;
    const UBO_POST_ELAPSED_TIME = 48;
    const UBO_FLOATS = 52;

    // The sample's MaterialPushConstant (BasicPushConstant is its model matrix):
    // { float4x4 model; float3 camera_pos; float elapsed_time, material_diffuse, material_spec; }.
    const PUSH_MODEL = 0;
    const PUSH_CAMERA_POS = 16;
    const PUSH_ELAPSED_TIME = 19;
    const PUSH_MATERIAL_DIFFUSE = 20;
    const PUSH_MATERIAL_SPEC = 21;
    const PUSH_FLOATS = 22;
    const PUSH_SIZE = 88;

    // The sample's look-at camera at (0, 0, -4.5) (vkb::Camera's position, the view's translation),
    // turned 19 degrees around x and 312 around y; reversed depth from 0.1 to 1024.
    const CAMERA_POSITION = [0.0, 0.0, -4.5];
    const CAMERA_ROTATION = [19.0, 312.0, 0.0];
    const CAMERA_FOV = 60.0;
    const Z_NEAR = 1024.0;
    const Z_FAR = 0.1;

    // Iterate mode: a random change every half second.
    const MAX_ITERATION_TIME = 0.5;
    const NUM_BASIC_OBJECTS = 5;
    const NUM_MATERIAL_OBJECTS = 6;
    const MAX_SELECTABLE_OBJECTS = 6;

    // The CPU frame time graph: the last 2000 frames.
    const TIMESTAMP_COUNT = 2000;

    // The shaders (shaders.json's lists, in its order: nlohmann's json keeps the basic sets' keys
    // sorted). The names are the sample's: it cuts the file names with the fragment shader's suffix
    // length, so its vertex shaders lose one character more ("scene.ver"), and the rest one less.
    const BASIC_NAMES = ["normals", "positions", "simple n dot l", "tex coords"];
    const BASIC_VS = ["basic_normals_vs", "basic_pos_vs", "basic_n_dot_l_vs", "basic_uv_vs"];
    const BASIC_PS = ["basic_color_ps", "basic_color_ps", "basic_n_dot_l_ps", "basic_color_ps"];
    const MATERIAL_VS_NAMES = ["scene.ver", "rotates.ver", "wave_x.ver", "wave_y.ver", "wave_z.ver"];
    const MATERIAL_VS = ["material_scene_vs", "material_rotates_vs", "material_wave_x_vs", "material_wave_y_vs",
        "material_wave_z_vs"];
    const MATERIAL_GS_NAMES = ["pass_through.geom", "pass_sin_offset.geom", "gen_normals.geom"];
    const MATERIAL_GS = ["material_pass_through_gs", "material_pass_sin_offset_gs", "material_gen_normals_gs"];
    const MATERIAL_PS_NAMES = ["normals.fra", "texture.fra", "reflective.fra", "n_dot_l.fra"];
    const MATERIAL_PS = ["material_normals_ps", "material_texture_ps", "material_reflective_ps", "material_n_dot_l_ps"];
    const POST_NAMES = ["brighten.fra", "invert.fra", "grayscale.fra", "quantize.fra", "edge_detection.fra",
        "color_cycle.fra"];
    const POST_PS = ["post_brighten_ps", "post_invert_ps", "post_grayscale_ps", "post_quantize_ps",
        "post_edge_detection_ps", "post_color_cycle_ps"];

    // The sample's possible output formats, those the device can render to (and sample) kept. NVRHI
    // has no 3-channel 16-bit formats (UNKNOWN here): no device renders to them in optimal tiling
    // anyway. VK_FORMAT_A2R10G10B10_UNORM_PACK32 is NVRHI's R10G10B10A2_UNORM with red and blue
    // swapped in memory, the same once drawn and sampled.
    const OUTPUT_FORMATS = [Format.RGBA8_UNORM, Format.SRGBA8_UNORM, Format.SBGRA8_UNORM, Format.UNKNOWN, Format.UNKNOWN,
        Format.RGBA16_UNORM, Format.RGBA16_FLOAT, Format.RGBA32_FLOAT, Format.R11G11B10_FLOAT, Format.R10G10B10A2_UNORM];
    const OUTPUT_FORMAT_NAMES = ["VK_FORMAT_R8G8B8A8_UNORM", "VK_FORMAT_R8G8B8A8_SRGB", "VK_FORMAT_B8G8R8A8_SRGB",
        "VK_FORMAT_R16G16B16_UNORM", "VK_FORMAT_R16G16B16_SFLOAT", "VK_FORMAT_R16G16B16A16_UNORM",
        "VK_FORMAT_R16G16B16A16_SFLOAT", "VK_FORMAT_R32G32B32A32_SFLOAT", "VK_FORMAT_B10G11R11_UFLOAT_PACK32",
        "VK_FORMAT_A2R10G10B10_UNORM_PACK32"];
    const DEPTH_FORMATS = [Format.D16, Format.D32];
    const DEPTH_FORMAT_NAMES = ["VK_FORMAT_D16_UNORM", "VK_FORMAT_D32_SFLOAT"];

    // nvrhi::FormatSupport bits.
    const SUPPORT_DEPTH_STENCIL = 0x10;
    const SUPPORT_RENDER_TARGET = 0x20;
    const SUPPORT_SHADER_SAMPLE = 0x100;

    // The scene's pipeline combinations: the skybox, the terrain, the basic sets, then the material
    // shaders (vertex, geometry or none, fragment).
    const COMBO_SKYBOX = 0;
    const COMBO_TERRAIN = 1;
    const COMBO_BASIC = 2;
    const COMBO_MATERIAL = COMBO_BASIC + 4;
    const GEOMETRY_NONE = 3;
    const COMBO_COUNT = COMBO_MATERIAL + 5 * 4 * 4;

    // --- Math (glm's layout: 4 x 4 matrices by columns) ---------------------------------------

    function identity(): number[] {
        return [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0];
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

    // glm::rotate(m, angle, axis) (the axis normalized, as glm does).
    function rotate(m: number[], angle: number, ax: number, ay: number, az: number): number[] {
        const length = Math.sqrt(ax * ax + ay * ay + az * az);
        const x = ax / length;
        const y = ay / length;
        const z = az / length;
        const c = Math.cos(angle);
        const s = Math.sin(angle);
        const t = 1.0 - c;
        const r = [
            c + t * x * x,     t * x * y + s * z, t * x * z - s * y, 0.0,
            t * x * y - s * z, c + t * y * y,     t * y * z + s * x, 0.0,
            t * x * z + s * y, t * y * z - s * x, c + t * z * z,     0.0,
            0.0,               0.0,               0.0,               1.0,
        ];
        return multiply(m, r);
    }

    function translation(x: number, y: number, z: number): number[] {
        let m = identity();
        m[12] = x;
        m[13] = y;
        m[14] = z;
        return m;
    }

    function scale(m: number[], s: number): number[] {
        let result: number[] = [];
        for (let i = 0; i < 16; i++) {
            result.push(i < 12 ? m[i] * s : m[i]);
        }
        return result;
    }

    function radians(degrees: number): number {
        return degrees * Math.PI / 180.0;
    }

    // glm::perspective (right-handed, depth from 0 to 1); the sample swaps near and far for
    // reversed depth.
    function perspective(fov: number, aspect: number, zNear: number, zFar: number): number[] {
        const tanHalfFovy = Math.tan(0.5 * fov);
        return [
            1.0 / (aspect * tanHalfFovy), 0.0,               0.0,                              0.0,
            0.0,                          1.0 / tanHalfFovy, 0.0,                              0.0,
            0.0,                          0.0,               zFar / (zNear - zFar),            -1.0,
            0.0,                          0.0,               -(zFar * zNear) / (zFar - zNear), 0.0,
        ];
    }

    // A number with `digits` decimals, like printf's %.Nf (Number.toFixed is missing under the JIT).
    function formatFixed(value: number, digits: int): string {
        let scaleFactor = 1.0;
        for (let i = 0; i < digits; i++) {
            scaleFactor *= 10.0;
        }
        const scaled = Math.round(Math.abs(value) * scaleFactor);
        const whole: int = Math.floor(scaled / scaleFactor);
        const fraction: int = scaled - whole * scaleFactor;
        let fractionText = `${fraction}`;
        while (fractionText.length < digits) {
            fractionText = "0" + fractionText;
        }
        const sign = value < 0.0 && scaled > 0.0 ? "-" : "";
        return digits > 0 ? `${sign}${whole}.${fractionText}` : `${sign}${whole}`;
    }

    // The sample's camera (the framework's vkb::Camera, look-at type), with ApiVulkanSample's mouse
    // controls: the left button turns it, the right one zooms, the middle one pans.
    class SampleCamera {
        rotation: number[];
        position: number[];
        private mouseX: number;
        private mouseY: number;
        private buttons: boolean[];

        constructor() {
            this.rotation = [CAMERA_ROTATION[0], CAMERA_ROTATION[1], CAMERA_ROTATION[2]];
            this.position = [CAMERA_POSITION[0], CAMERA_POSITION[1], CAMERA_POSITION[2]];
            this.mouseX = 0.0;
            this.mouseY = 0.0;
            this.buttons = [false, false, false];
        }

        // vkb::Camera::update_view_matrix: translate(position) * rotations around x, y, z.
        view(): number[] {
            let r = identity();
            r = rotate(r, radians(this.rotation[0]), 1.0, 0.0, 0.0);
            r = rotate(r, radians(this.rotation[1]), 0.0, 1.0, 0.0);
            r = rotate(r, radians(this.rotation[2]), 0.0, 0.0, 1.0);
            return multiply(translation(this.position[0], this.position[1], this.position[2]), r);
        }

        // GLFW buttons: 0 left, 1 right, 2 middle; action 1 press, 0 release.
        mouseButton(button: int, action: int): void {
            if (button >= 0 && button < 3) {
                this.buttons[button] = action == 1;
            }
        }

        // ApiVulkanSample::handle_mouse_move, with its speeds (1).
        mouseMove(x: number, y: number): void {
            const dx = Math.floor(this.mouseX) - Math.floor(x);
            const dy = Math.floor(this.mouseY) - Math.floor(y);
            if (this.buttons[0]) {
                this.rotation[0] += dy;
                this.rotation[1] -= dx;
            }
            if (this.buttons[1]) {
                this.position[2] += dy * 0.005;
            }
            if (this.buttons[2]) {
                this.position[0] -= dx * 0.01;
                this.position[1] -= dy * 0.01;
            }
            this.mouseX = x;
            this.mouseY = y;
        }
    }

    // --- Pass -------------------------------------------------------------------------------

    // Port of Vulkan-Samples' shader_object: a skybox, a terrain and eleven objects, drawn with
    // shaders picked per object at draw time (VK_EXT_shader_object: no pipelines, every state
    // dynamic) into an output image whose color and depth formats change too, then post-processed.
    // Iterate mode changes one at random every half second. NVRHI has no shader objects: every
    // combination in use gets a pipeline, created the first time it's drawn, for the formats then.
    class ShaderObjectPass {
        private app: App;
        private camera: SampleCamera;

        // Shaders by stage, in the sample's order.
        private skyboxVS: Opaque;
        private skyboxPS: Opaque;
        private terrainVS: Opaque;
        private terrainPS: Opaque;
        private basicVS: Opaque[];
        private basicPS: Opaque[];
        private materialVS: Opaque[];
        private materialGS: Opaque[];
        private materialPS: Opaque[];
        private fsqVS: Opaque;
        private postPS: Opaque[];

        private inputLayout: Opaque;
        private sceneLayout: Opaque;
        private sceneBindingSet: BindingSet;
        private postLayout: Opaque;
        private postSampler: Opaque;
        private uniformBuffer: Opaque;

        private torus: GltfMesh;
        private rock: GltfMesh;
        private cube: GltfMesh;
        private skybox: GltfMesh;
        private teapot: GltfMesh;
        private terrainVertexBuffer: Opaque;
        private terrainIndexBuffer: Opaque;
        private terrainIndexCount: int;

        // The supported output and depth formats (indices into OUTPUT_FORMATS / DEPTH_FORMATS).
        outputFormats: int[];
        depthFormats: int[];

        // For the back buffers' size: an output image per output format, a depth image per depth
        // format, a framebuffer per pair (output * depth count + depth), the post-processing image,
        // its framebuffer, and its binding sets (one per output image read).
        private outputImages: Opaque[];
        private depthImages: Opaque[];
        private framebuffers: Opaque[];
        private postImage: Opaque;
        private postFramebuffer: Opaque;
        private postBindingSets: BindingSet[];
        private targetWidth: int;
        private targetHeight: int;

        // The pipelines made so far: pipelineIndex[key] into pipelineList, -1 until made (key: the
        // combination, the output and depth formats, wireframe); post-processing's, made once.
        private pipelineList: Opaque[];
        private pipelineIndex: int[];
        private postPipelines: Opaque[];
        private postPipelinesCreated: boolean;

        // The sample's state.
        private rng: Opaque;
        private elapsedTime: number;
        private elapsedIterationTime: number;
        currentBasicLinkedShaders: int[];
        currentMaterialVert: int[];
        currentMaterialGeo: int[];
        currentMaterialFrag: int[];
        currentPostProcessShader: int;
        currentOutputFormat: int;
        currentDepthFormat: int;
        selectedBasicObject: int;
        selectedMaterialObject: int;
        iterateBasic: boolean;
        iterateMaterialVert: boolean;
        iterateMaterialGeo: boolean;
        iterateMaterialFrag: boolean;
        iteratePostProcess: boolean;
        iterateOutput: boolean;
        iterateDepth: boolean;
        wireframeMode: boolean;
        postProcessing: boolean;
        iteratePermutations: boolean;
        enableGeometryPass: boolean;
        // -benchmark: 1/60 second per frame, as vulkan_samples' --benchmark.
        benchmark: boolean;

        // The CPU frame times (ms) of the last frames, a ring.
        timestampValues: f32[];
        currentTimestamp: int;

        // Upload buffers.
        private ubo: f32[];
        private push: f32[];

        constructor(app: App) {
            this.app = app;
            this.camera = new SampleCamera();
            this.basicVS = [];
            this.basicPS = [];
            this.materialVS = [];
            this.materialGS = [];
            this.materialPS = [];
            this.postPS = [];
            this.terrainIndexCount = 0;
            this.outputFormats = [];
            this.depthFormats = [];
            this.outputImages = [];
            this.depthImages = [];
            this.framebuffers = [];
            this.postBindingSets = [];
            this.targetWidth = 0;
            this.targetHeight = 0;
            this.pipelineList = [];
            this.pipelineIndex = [];
            this.postPipelines = [];
            this.postPipelinesCreated = false;
            this.elapsedTime = 0.0;
            this.elapsedIterationTime = 0.0;
            this.currentBasicLinkedShaders = [0, 0, 0, 0, 0];
            this.currentMaterialVert = [0, 0, 0, 0, 0, 0];
            this.currentMaterialGeo = [0, 0, 0, 0, 0, 0];
            this.currentMaterialFrag = [0, 0, 0, 0, 0, 0];
            this.currentPostProcessShader = 0;
            this.currentOutputFormat = 0;
            this.currentDepthFormat = 0;
            this.selectedBasicObject = 0;
            this.selectedMaterialObject = 0;
            this.iterateBasic = true;
            this.iterateMaterialVert = true;
            this.iterateMaterialGeo = true;
            this.iterateMaterialFrag = true;
            this.iteratePostProcess = true;
            this.iterateOutput = true;
            this.iterateDepth = true;
            this.wireframeMode = false;
            this.postProcessing = true;
            this.iteratePermutations = true;
            this.enableGeometryPass = true;
            this.benchmark = false;
            this.timestampValues = [];
            for (let i = 0; i < TIMESTAMP_COUNT; i++) {
                this.timestampValues.push(0.0);
            }
            this.currentTimestamp = 0;
            this.ubo = [];
            for (let i = 0; i < UBO_FLOATS; i++) {
                this.ubo.push(0.0);
            }
            this.push = [];
            for (let i = 0; i < PUSH_FLOATS; i++) {
                this.push.push(0.0);
            }
        }

        onMousePos(x: number, y: number): int {
            this.camera.mouseMove(x, y);
            return 1;
        }

        onMouseButton(button: int, action: int, mods: int): int {
            this.camera.mouseButton(button, action);
            return 1;
        }

        // The sample's render: the timers (floats) advanced, and every half second in iterate mode,
        // a random change. Its CPU frame time graph gets the real frame time.
        onAnimate(elapsedSeconds: number): void {
            const deltaTime = Math.fround(this.benchmark ? 1.0 / 60.0 : elapsedSeconds);
            this.elapsedTime = Math.fround(this.elapsedTime + deltaTime);
            this.elapsedIterationTime = Math.fround(this.elapsedIterationTime + deltaTime);
            if (this.elapsedIterationTime > MAX_ITERATION_TIME && this.iteratePermutations) {
                this.elapsedIterationTime = 0.0;
                this.iterateCurrent();
            }
            this.timestampValues[this.currentTimestamp] = elapsedSeconds * 1000.0;
            this.app.setInformativeWindowTitle(WINDOW_TITLE);
        }

        // The sample's iterate_current: one random number picks the object, another one of the
        // enabled changes (std::uniform_int_distribution<int>{0, 100} over its engine, as it does).
        iterateCurrent(): void {
            const selectedShader: int = Donut_RandomUniformInt(this.rng, 0, 100) % MAX_SELECTABLE_OBJECTS;
            let funcs: int[] = [];
            if (this.iterateBasic) {
                funcs.push(0);
            }
            if (this.iterateMaterialVert) {
                funcs.push(1);
            }
            if (this.iterateMaterialGeo) {
                funcs.push(2);
            }
            if (this.iterateMaterialFrag) {
                funcs.push(3);
            }
            if (this.iteratePostProcess) {
                funcs.push(4);
            }
            if (this.iterateOutput) {
                funcs.push(5);
            }
            if (this.iterateDepth) {
                funcs.push(6);
            }
            if (funcs.length == 0) {
                return;
            }
            const func = funcs[Donut_RandomUniformInt(this.rng, 0, 100) % funcs.length];
            const basic: int = selectedShader % NUM_BASIC_OBJECTS;
            const material: int = selectedShader % NUM_MATERIAL_OBJECTS;
            if (func == 0) {
                this.selectedBasicObject = basic;
                this.currentBasicLinkedShaders[basic] = (this.currentBasicLinkedShaders[basic] + 1) % BASIC_VS.length;
            } else if (func == 1) {
                this.selectedMaterialObject = material;
                this.currentMaterialVert[material] = (this.currentMaterialVert[material] + 1) % MATERIAL_VS.length;
            } else if (func == 2) {
                this.selectedMaterialObject = material;
                this.currentMaterialGeo[material] = (this.currentMaterialGeo[material] + 1) % MATERIAL_GS.length;
            } else if (func == 3) {
                this.selectedMaterialObject = material;
                this.currentMaterialFrag[material] = (this.currentMaterialFrag[material] + 1) % MATERIAL_PS.length;
            } else if (func == 4) {
                this.currentPostProcessShader = (this.currentPostProcessShader + 1) % POST_PS.length;
            } else if (func == 5) {
                this.currentOutputFormat = (this.currentOutputFormat + 1) % this.outputFormats.length;
            } else {
                this.currentDepthFormat = (this.currentDepthFormat + 1) % this.depthFormats.length;
            }
        }

        // The sample's randomize_current: every enabled choice advanced by a random number.
        randomizeCurrent(): void {
            if (this.iterateBasic) {
                for (let i = 0; i < NUM_BASIC_OBJECTS; i++) {
                    this.currentBasicLinkedShaders[i] = (this.currentBasicLinkedShaders[i] + Donut_RandomUniformInt(this.rng, 0, 100)) % BASIC_VS.length;
                }
            }
            if (this.iterateMaterialVert) {
                for (let i = 0; i < NUM_MATERIAL_OBJECTS; i++) {
                    this.currentMaterialVert[i] = (this.currentMaterialVert[i] + Donut_RandomUniformInt(this.rng, 0, 100)) % MATERIAL_VS.length;
                }
            }
            if (this.iterateMaterialGeo) {
                for (let i = 0; i < NUM_MATERIAL_OBJECTS; i++) {
                    this.currentMaterialGeo[i] = (this.currentMaterialGeo[i] + Donut_RandomUniformInt(this.rng, 0, 100)) % MATERIAL_GS.length;
                }
            }
            if (this.iterateMaterialFrag) {
                for (let i = 0; i < NUM_MATERIAL_OBJECTS; i++) {
                    this.currentMaterialFrag[i] = (this.currentMaterialFrag[i] + Donut_RandomUniformInt(this.rng, 0, 100)) % MATERIAL_PS.length;
                }
            }
            if (this.iteratePostProcess) {
                this.currentPostProcessShader = (this.currentPostProcessShader + Donut_RandomUniformInt(this.rng, 0, 100)) % POST_PS.length;
            }
            if (this.iterateOutput) {
                this.currentOutputFormat = (this.currentOutputFormat + Donut_RandomUniformInt(this.rng, 0, 100)) % this.outputFormats.length;
            }
            if (this.iterateDepth) {
                this.currentDepthFormat = (this.currentDepthFormat + Donut_RandomUniformInt(this.rng, 0, 100)) % this.depthFormats.length;
            }
        }

        // The images go before the back buffers do.
        onBackBufferResizing(): void {
            this.releaseTargets();
        }

        releaseTargets(): void {
            if (this.outputImages.length == 0) {
                return;
            }
            for (let i = 0; i < this.framebuffers.length; i++) {
                this.app.releaseResource(this.framebuffers[i]);
            }
            for (let i = 0; i < this.outputImages.length; i++) {
                this.app.releaseResource(this.outputImages[i]);
            }
            for (let i = 0; i < this.depthImages.length; i++) {
                this.app.releaseResource(this.depthImages[i]);
            }
            this.app.releaseResource(this.postFramebuffer);
            this.app.releaseResource(this.postImage);
            // Donut_BlitTexture's cached binding sets hold the images too.
            this.app.clearBindingCache();
            this.framebuffers = [];
            this.outputImages = [];
            this.depthImages = [];
            this.postBindingSets = [];
            this.targetWidth = 0;
            this.targetHeight = 0;
        }

        // The sample's create_images: an output image per supported format, a depth image per
        // supported depth format, the post-processing image (RGBA8).
        createTargets(width: int, height: int): void {
            this.releaseTargets();
            for (let i = 0; i < this.outputFormats.length; i++) {
                const format = OUTPUT_FORMATS[this.outputFormats[i]];
                this.outputImages.push(this.app.createRenderTargetTexture(width, height, format, OUTPUT_FORMAT_NAMES[this.outputFormats[i]]));
            }
            for (let i = 0; i < this.depthFormats.length; i++) {
                const format = DEPTH_FORMATS[this.depthFormats[i]];
                this.depthImages.push(this.app.createDepthTexture(width, height, format, 0.0, DEPTH_FORMAT_NAMES[this.depthFormats[i]]));
            }
            for (let c = 0; c < this.outputImages.length; c++) {
                for (let d = 0; d < this.depthImages.length; d++) {
                    this.framebuffers.push(this.app.createFramebuffer(this.outputImages[c], this.depthImages[d]));
                }
            }
            this.postImage = this.app.createRenderTargetTexture(width, height, Format.RGBA8_UNORM, "Post-processing");
            this.postFramebuffer = this.app.createFramebuffer(this.postImage, null);
            for (let c = 0; c < this.outputImages.length; c++) {
                const setDesc = BindingSetDesc.create();
                setDesc.bindEntireConstantBuffer(0, this.uniformBuffer);
                setDesc.bindTextureSRV(0, this.outputImages[c]);
                setDesc.bindSampler(0, this.postSampler);
                this.postBindingSets.push(this.app.createBindingSetForLayout(setDesc, this.postLayout));
            }
            if (!this.postPipelinesCreated) {
                for (let i = 0; i < POST_PS.length; i++) {
                    const desc = GraphicsPipelineDesc.create(this.fsqVS, this.postPS[i]);
                    desc.addBindingLayout(this.postLayout);
                    desc.setDepthState(0, 0, ComparisonFunc.Always);
                    desc.setRasterState(CullMode.None, FillMode.Solid, 1);
                    this.postPipelines.push(this.app.createGraphicsPipelineFromDesc(desc, this.postFramebuffer));
                }
                this.postPipelinesCreated = true;
            }
            this.targetWidth = width;
            this.targetHeight = height;
        }

        // A scene pipeline: the sample's set_initial_state (counter-clockwise front faces, depth
        // tested greater: reversed, the polygon mode) with the draw's shaders, cull mode and depth
        // writes; depth clipped, as Vulkan does.
        getPipeline(combo: int, framebuffer: Opaque): Opaque {
            const wireframe: int = this.wireframeMode ? 1 : 0;
            const key = ((combo * this.outputFormats.length + this.currentOutputFormat) * this.depthFormats.length
                + this.currentDepthFormat) * 2 + wireframe;
            const index = this.pipelineIndex[key];
            if (index >= 0) {
                return this.pipelineList[index];
            }
            let vs = this.skyboxVS;
            let ps = this.skyboxPS;
            let gs = -1;
            let cullMode = CullMode.None;
            let depthWrite = 1;
            if (combo == COMBO_SKYBOX) {
                depthWrite = 0;
            } else if (combo == COMBO_TERRAIN) {
                vs = this.terrainVS;
                ps = this.terrainPS;
                cullMode = CullMode.Back;
            } else if (combo < COMBO_MATERIAL) {
                vs = this.basicVS[combo - COMBO_BASIC];
                ps = this.basicPS[combo - COMBO_BASIC];
                cullMode = CullMode.Front;
            } else {
                const material = combo - COMBO_MATERIAL;
                vs = this.materialVS[Math.floor(material / 16)];
                gs = Math.floor(material / 4) % 4;
                ps = this.materialPS[material % 4];
                cullMode = CullMode.Front;
            }
            const desc = GraphicsPipelineDesc.create(vs, ps);
            if (gs >= 0 && gs != GEOMETRY_NONE) {
                desc.setGeometryShader(this.materialGS[gs]);
            }
            desc.setInputLayout(this.inputLayout);
            desc.addBindingLayout(this.sceneLayout);
            desc.setDepthState(1, depthWrite, ComparisonFunc.Greater);
            desc.setRasterState(cullMode, wireframe != 0 ? FillMode.Wireframe : FillMode.Solid, 1);
            desc.setDepthClip(1);
            const pipeline = this.app.createGraphicsPipelineFromDesc(desc, framebuffer);
            this.pipelineIndex[key] = this.pipelineList.length;
            this.pipelineList.push(pipeline);
            return pipeline;
        }

        // The model matrix into the push constants.
        setModel(m: number[]): void {
            for (let i = 0; i < 16; i++) {
                this.push[PUSH_MODEL + i] = m[i];
            }
        }

        drawMesh(frame: Frame, combo: int, framebuffer: Opaque, mesh: GltfMesh): void {
            frame.beginDrawToFramebuffer(this.getPipeline(combo, framebuffer), framebuffer);
            frame.drawAddBindingSet(this.sceneBindingSet);
            frame.drawSetIndexBuffer(mesh.getIndexBuffer());
            frame.drawAddVertexBuffer(mesh.getVertexBuffer(), 0, 0);
            frame.drawIndexedWithPushConstants(mesh.getIndexCount(), Ref(this.push[0]), PUSH_SIZE);
        }

        // The sample's bind_material_shader: its vertex, geometry (if the geometry pass is
        // enabled) and fragment shaders.
        drawMaterial(frame: Frame, framebuffer: Opaque, index: int, mesh: GltfMesh, model: number[]): void {
            this.setModel(model);
            const geo = this.enableGeometryPass ? this.currentMaterialGeo[index] : GEOMETRY_NONE;
            const combo = COMBO_MATERIAL + (this.currentMaterialVert[index] * 4 + geo) * 4 + this.currentMaterialFrag[index];
            this.drawMesh(frame, combo, framebuffer, mesh);
        }

        drawBasic(frame: Frame, framebuffer: Opaque, index: int, mesh: GltfMesh, model: number[]): void {
            this.setModel(model);
            this.drawMesh(frame, COMBO_BASIC + this.currentBasicLinkedShaders[index], framebuffer, mesh);
        }

        onRender(frameHandle: FrameHandle): void {
            const frame = new Frame(frameHandle);
            const width = frame.getWidth();
            const height = frame.getHeight();
            const commandList = frame.getCommandList();

            if (this.targetWidth != width || this.targetHeight != height) {
                this.createTargets(width, height);
            }

            // The sample's update_uniform_buffers: its projection (clip y negated for Donut), view,
            // and their product; post-processing's elapsed time.
            const projection = perspective(radians(CAMERA_FOV), width / height, Z_NEAR, Z_FAR);
            const view = this.camera.view();
            const projView = multiply(projection, view);
            for (let i = 0; i < 16; i++) {
                this.ubo[UBO_PROJECTION + i] = i % 4 == 1 ? -projection[i] : projection[i];
                this.ubo[UBO_VIEW + i] = view[i];
                this.ubo[UBO_PROJ_VIEW + i] = i % 4 == 1 ? -projView[i] : projView[i];
            }
            this.ubo[UBO_POST_ELAPSED_TIME] = this.elapsedTime;
            commandList.writeBuffer(this.uniformBuffer, Ref(this.ubo[0]), UBO_FLOATS * 4);

            // The output image's rendering: depth cleared to 0 (reversed); the sample leaves color
            // to the skybox (it clears it in wireframe mode only).
            const outputImage = this.outputImages[this.currentOutputFormat];
            commandList.clearTextureFloat(outputImage, 0.0, 0.0, 0.0, 0.0);
            commandList.clearDepth(this.depthImages[this.currentDepthFormat], 0.0);
            const framebuffer = this.framebuffers[this.currentOutputFormat * this.depthImages.length + this.currentDepthFormat];

            // The skybox: cull mode none, no depth writes.
            this.setModel(identity());
            this.drawMesh(frame, COMBO_SKYBOX, framebuffer, this.skybox);

            // The terrain, culling back faces.
            this.setModel(translation(0.0, -100.0, 0.0));
            frame.beginDrawToFramebuffer(this.getPipeline(COMBO_TERRAIN, framebuffer), framebuffer);
            frame.drawAddBindingSet(this.sceneBindingSet);
            frame.drawSetIndexBuffer(this.terrainIndexBuffer);
            frame.drawAddVertexBuffer(this.terrainVertexBuffer, 0, 0);
            frame.drawIndexedWithPushConstants(this.terrainIndexCount, Ref(this.push[0]), PUSH_SIZE);

            // The material objects, culling front faces.
            const t = this.elapsedTime;
            this.push[PUSH_CAMERA_POS] = this.camera.position[0];
            this.push[PUSH_CAMERA_POS + 1] = this.camera.position[1];
            this.push[PUSH_CAMERA_POS + 2] = this.camera.position[2];
            this.push[PUSH_ELAPSED_TIME] = t;
            this.push[PUSH_MATERIAL_DIFFUSE] = 0.8;
            this.push[PUSH_MATERIAL_SPEC] = 0.2;
            this.drawMaterial(frame, framebuffer, 0, this.torus, scale(rotate(translation(1.2, 0.0, 0.0), t, 1.0, 0.0, 0.0), 0.015));
            this.drawMaterial(frame, framebuffer, 1, this.rock, scale(rotate(translation(1.2, 1.0, 0.0), t, 0.0, 0.0, 1.0), 4.0));
            this.drawMaterial(frame, framebuffer, 2, this.cube, scale(rotate(translation(1.2, -1.0, 0.0), t, 0.0, 1.0, 0.0), 0.05));
            this.drawMaterial(frame, framebuffer, 3, this.torus, scale(rotate(translation(-1.2, 1.0, 0.0), t, 0.0, 1.0, 0.0), 0.015));
            this.drawMaterial(frame, framebuffer, 4, this.rock, scale(rotate(translation(-1.2, -1.0, 0.0), t, 0.0, 1.0, 0.0), 4.0));
            this.drawMaterial(frame, framebuffer, 5, this.cube, scale(rotate(translation(-1.2, 0.0, 0.0), t, 1.0, 0.0, 0.0), 0.05));

            // The basic objects (the teapots turned upside down).
            const halfTurn = radians(180.0);
            this.drawBasic(frame, framebuffer, 0, this.rock, scale(rotate(translation(0.0, 0.0, -1.2), t, 0.0, 0.0, 1.0), 4.0));
            this.drawBasic(frame, framebuffer, 1, this.teapot,
                scale(rotate(rotate(translation(0.0, 0.0, 0.0), t, 0.0, 1.0, 0.0), halfTurn, 1.0, 0.0, 0.0), 0.2));
            this.drawBasic(frame, framebuffer, 2, this.teapot,
                scale(rotate(rotate(translation(0.0, -1.2, 0.0), t, 1.0, 0.0, 0.0), halfTurn, 1.0, 0.0, 0.0), 0.2));
            this.drawBasic(frame, framebuffer, 3, this.teapot,
                scale(rotate(rotate(translation(0.0, 1.2, 0.0), t, 0.0, 0.0, 1.0), halfTurn, 1.0, 0.0, 0.0), 0.2));
            this.drawBasic(frame, framebuffer, 4, this.cube, scale(rotate(translation(0.0, 0.0, 1.2), t, 1.0, 1.0, 0.0), 0.05));

            // Post-processing into its image, blitted to the back buffer (the sample's vkCmdBlitImage,
            // which encodes to the sRGB swapchain as drawing into the back buffer does); without it,
            // the output image straight.
            if (this.postProcessing) {
                frame.beginDrawToFramebuffer(this.postPipelines[this.currentPostProcessShader], this.postFramebuffer);
                frame.drawAddBindingSet(this.postBindingSets[this.currentOutputFormat]);
                frame.drawVertices(3);
                this.app.blitTexture(frame, this.postImage);
            } else {
                this.app.blitTexture(frame, outputImage);
            }
        }

        // The sample's generate_terrain: a grid of vertices, their normals from the heightmap read
        // on the CPU (vkb::HeightMap at the grid's resolution: every fourth texel, the edges
        // clamped) by a Sobel filter, two triangles per cell (the last row and column's indices left
        // 0, drawn degenerate as the sample does).
        generateTerrain(commandList: CommandList): boolean {
            const file = this.app.loadBinaryFile(HEIGHTMAP_PATH);
            if (file.isNull() || file.getSize() < HEIGHTMAP_HEADER_SIZE + HEIGHTMAP_DIM * HEIGHTMAP_DIM * 2) {
                return false;
            }
            const scaleFactor = HEIGHTMAP_DIM / TERRAIN_RESOLUTION;
            let heights: number[] = [];
            let row: int[] = [];
            for (let i = 0; i < HEIGHTMAP_DIM * 2; i++) {
                row.push(0);
            }
            for (let y = 0; y < TERRAIN_RESOLUTION; y++) {
                file.copyBytes(HEIGHTMAP_HEADER_SIZE + y * scaleFactor * HEIGHTMAP_DIM * 2, HEIGHTMAP_DIM * 2, Ref(row[0]));
                for (let x = 0; x < TERRAIN_RESOLUTION; x++) {
                    const texel = row[x * scaleFactor * 2] + row[x * scaleFactor * 2 + 1] * 256;
                    heights.push(Math.fround(texel / 65535.0));
                }
            }
            this.app.releaseObject(file.handle);

            let vertices: f32[] = [];
            let indices: int[] = [];
            const vertexCount = TERRAIN_RESOLUTION * TERRAIN_RESOLUTION;
            for (let i = 0; i < vertexCount * 8; i++) {
                vertices.push(0.0);
            }
            for (let i = 0; i < vertexCount * 6; i++) {
                indices.push(0);
            }
            for (let x = 0; x < TERRAIN_RESOLUTION; x++) {
                for (let y = 0; y < TERRAIN_RESOLUTION; y++) {
                    const index = x + y * TERRAIN_RESOLUTION;
                    const v = index * 8;
                    vertices[v] = x / TERRAIN_RESOLUTION * TERRAIN_SIZE - TERRAIN_SIZE / 2.0;
                    vertices[v + 1] = 0.0;
                    vertices[v + 2] = y / TERRAIN_RESOLUTION * TERRAIN_SIZE - TERRAIN_SIZE / 2.0;
                    vertices[v + 6] = x / TERRAIN_RESOLUTION;
                    vertices[v + 7] = y / TERRAIN_RESOLUTION;

                    // h[hx + 1][hy + 1], the samples around.
                    let h: number[] = [];
                    for (let hx = -1; hx <= 1; hx++) {
                        for (let hy = -1; hy <= 1; hy++) {
                            const sx = Math.min(Math.max(x + hx, 0), TERRAIN_RESOLUTION - 1);
                            const sy = Math.min(Math.max(y + hy, 0), TERRAIN_RESOLUTION - 1);
                            h.push(heights[sx + sy * TERRAIN_RESOLUTION]);
                        }
                    }
                    // Gx and Gy Sobel filters, then the missing up component (0.25: the bump strength).
                    const nx = h[0] - h[6] + 2.0 * h[1] - 2.0 * h[7] + h[2] - h[8];
                    const nz = h[0] + 2.0 * h[3] + h[6] - h[2] - 2.0 * h[5] - h[8];
                    const ny = 0.25 * Math.sqrt(1.0 - nx * nx - nz * nz);
                    const sx2 = nx * 2.0;
                    const sz2 = nz * 2.0;
                    const length = Math.sqrt(sx2 * sx2 + ny * ny + sz2 * sz2);
                    vertices[v + 3] = sx2 / length;
                    vertices[v + 4] = ny / length;
                    vertices[v + 5] = sz2 / length;

                    // Two counter-clockwise triangles: A, D, B and B, D, C.
                    if (x < TERRAIN_RESOLUTION - 1 && y < TERRAIN_RESOLUTION - 1) {
                        const i = index * 6;
                        indices[i] = x + y * TERRAIN_RESOLUTION;
                        indices[i + 1] = x + (y + 1) * TERRAIN_RESOLUTION;
                        indices[i + 2] = x + 1 + y * TERRAIN_RESOLUTION;
                        indices[i + 3] = x + 1 + y * TERRAIN_RESOLUTION;
                        indices[i + 4] = x + (y + 1) * TERRAIN_RESOLUTION;
                        indices[i + 5] = x + 1 + (y + 1) * TERRAIN_RESOLUTION;
                    }
                }
            }
            this.terrainVertexBuffer = this.app.createStaticVertexBuffer(commandList, Ref(vertices[0]), vertices.length * 4, "Terrain vertices");
            this.terrainIndexBuffer = this.app.createStaticIndexBuffer(commandList, Ref(indices[0]), indices.length * 4, "Terrain indices");
            this.terrainIndexCount = indices.length;
            return true;
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(): boolean {
            // The sample's request_gpu_features: the supported output and depth formats, in order.
            for (let i = 0; i < OUTPUT_FORMATS.length; i++) {
                const support = OUTPUT_FORMATS[i] == Format.UNKNOWN ? 0 : this.app.queryFormatSupport(OUTPUT_FORMATS[i]);
                if ((support & SUPPORT_RENDER_TARGET) != 0 && (support & SUPPORT_SHADER_SAMPLE) != 0) {
                    this.outputFormats.push(i);
                }
            }
            for (let i = 0; i < DEPTH_FORMATS.length; i++) {
                if ((this.app.queryFormatSupport(DEPTH_FORMATS[i]) & SUPPORT_DEPTH_STENCIL) != 0) {
                    this.depthFormats.push(i);
                }
            }
            if (this.outputFormats.length == 0 || this.depthFormats.length == 0) {
                console.log("No supported output or depth format");
                return false;
            }
            const pipelineKeys = COMBO_COUNT * this.outputFormats.length * this.depthFormats.length * 2;
            for (let i = 0; i < pipelineKeys; i++) {
                this.pipelineIndex.push(-1);
            }

            const shader = "shader_object.hlsl";
            this.skyboxVS = this.app.createShader(shader, "skybox_vs", ShaderType.Vertex);
            this.skyboxPS = this.app.createShader(shader, "skybox_ps", ShaderType.Pixel);
            this.terrainVS = this.app.createShader(shader, "terrain_vs", ShaderType.Vertex);
            this.terrainPS = this.app.createShader(shader, "terrain_ps", ShaderType.Pixel);
            this.fsqVS = this.app.createShader(shader, "fsq_vs", ShaderType.Vertex);
            let ok = true;
            if (!this.skyboxVS || !this.skyboxPS || !this.terrainVS || !this.terrainPS || !this.fsqVS) {
                ok = false;
            }
            for (let i = 0; i < BASIC_VS.length; i++) {
                const vs = this.app.createShader(shader, BASIC_VS[i], ShaderType.Vertex);
                const ps = this.app.createShader(shader, BASIC_PS[i], ShaderType.Pixel);
                if (!vs || !ps) {
                    ok = false;
                }
                this.basicVS.push(vs);
                this.basicPS.push(ps);
            }
            for (let i = 0; i < MATERIAL_VS.length; i++) {
                const vs = this.app.createShader(shader, MATERIAL_VS[i], ShaderType.Vertex);
                if (!vs) {
                    ok = false;
                }
                this.materialVS.push(vs);
            }
            for (let i = 0; i < MATERIAL_GS.length; i++) {
                const gs = this.app.createShader(shader, MATERIAL_GS[i], ShaderType.Geometry);
                if (!gs) {
                    ok = false;
                }
                this.materialGS.push(gs);
            }
            for (let i = 0; i < MATERIAL_PS.length; i++) {
                const ps = this.app.createShader(shader, MATERIAL_PS[i], ShaderType.Pixel);
                if (!ps) {
                    ok = false;
                }
                this.materialPS.push(ps);
            }
            for (let i = 0; i < POST_PS.length; i++) {
                const ps = this.app.createShader(shader, POST_PS[i], ShaderType.Pixel);
                if (!ps) {
                    ok = false;
                }
                this.postPS.push(ps);
            }
            if (!ok) {
                return false;
            }

            // The sample's vertex input: position, normal, texture coordinates.
            const layoutDesc = InputLayoutDesc.create();
            layoutDesc.addVertexAttribute("POSITION", Format.RGB32_FLOAT, 0, 0, VERTEX_SIZE);
            layoutDesc.addVertexAttribute("NORMAL", Format.RGB32_FLOAT, NORMAL_OFFSET, 0, VERTEX_SIZE);
            layoutDesc.addVertexAttribute("TEXCOORD", Format.RG32_FLOAT, UV_OFFSET, 0, VERTEX_SIZE);
            this.inputLayout = this.app.createInputLayout(layoutDesc, this.skyboxVS);

            // The sample's samplers: the framework's load_texture's (trilinear, repeating, the
            // device's widest anisotropic filtering), a mirroring one for the heightmap, a repeating
            // one for the terrain's layers, and its standard sampler for post-processing (clamped,
            // levels 0 and 1).
            const maxAnisotropy = this.app.getMaxSamplerAnisotropy();
            const textureSampler = this.app.createSamplerWithDesc(1, 1, 1, SamplerAddressMode.Wrap, 0.0, 0.0, 1000.0, maxAnisotropy);
            const heightmapSampler = this.app.createSamplerWithDesc(1, 1, 1, SamplerAddressMode.Mirror, 0.0, 0.0, 1000.0, 1.0);
            const layersSampler = this.app.createSamplerWithDesc(1, 1, 1, SamplerAddressMode.Wrap, 0.0, 0.0, 1000.0, 1.0);
            this.postSampler = this.app.createSamplerWithDesc(1, 1, 1, SamplerAddressMode.Clamp, 0.0, 0.0, 1.0, maxAnisotropy);

            // Donut's common passes (the blit's), made before a command list is open: they upload
            // their textures with an immediate command list of their own.
            this.app.getCommonSampler(CommonSampler.LinearClamp);

            // As the sample (vkb) loads KTX 1 files: color as sRGB, the heightmap as is.
            const commandList = this.app.createCommandList();
            commandList.open();
            this.torus = this.app.loadGltfMesh(commandList, TORUS_PATH);
            this.rock = this.app.loadGltfMesh(commandList, ROCK_PATH);
            this.cube = this.app.loadGltfMesh(commandList, CUBE_PATH);
            this.skybox = this.app.loadGltfMesh(commandList, SKYBOX_PATH);
            this.teapot = this.app.loadGltfMesh(commandList, TEAPOT_PATH);
            const envmap = this.app.loadTexture(commandList, ENVMAP_PATH, 1);
            const checkerboard = this.app.loadTexture(commandList, CHECKERBOARD_PATH, 1);
            const terrainLayers = this.app.loadTexture(commandList, TERRAIN_LAYERS_PATH, 1);
            const heightmap = this.app.loadTexture(commandList, HEIGHTMAP_PATH, 0);
            const terrainMade = this.generateTerrain(commandList);
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.waitForIdle();
            this.app.releaseResource(commandList.handle);
            if (this.torus.isNull() || this.rock.isNull() || this.cube.isNull() || this.skybox.isNull() || this.teapot.isNull()
                || !envmap || !checkerboard || !terrainLayers || !heightmap || !terrainMade) {
                console.log("Cannot load the models and textures: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return false;
            }

            // The scene's bindings (the sample's basic and material descriptor sets in one): the
            // cameras' matrices, the push constants, the textures.
            this.uniformBuffer = this.app.createVolatileConstantBuffer(UBO_FLOATS * 4, "UBO");
            const sceneLayoutDesc = BindingLayoutDesc.create();
            sceneLayoutDesc.layoutVolatileConstantBuffer(0);
            sceneLayoutDesc.layoutPushConstants(1, PUSH_SIZE);
            for (let i = 1; i <= 4; i++) {
                sceneLayoutDesc.layoutTextureSRV(i);
            }
            for (let i = 1; i <= 3; i++) {
                sceneLayoutDesc.layoutSampler(i);
            }
            this.sceneLayout = this.app.createBindingLayout(sceneLayoutDesc, ShaderType.All);
            const setDesc = BindingSetDesc.create();
            setDesc.bindEntireConstantBuffer(0, this.uniformBuffer);
            setDesc.bindPushConstants(1, PUSH_SIZE);
            setDesc.bindTextureSRV(1, envmap);
            setDesc.bindTextureSRV(2, heightmap);
            setDesc.bindTextureSRV(3, terrainLayers);
            setDesc.bindTextureSRV(4, checkerboard);
            setDesc.bindSampler(1, textureSampler);
            setDesc.bindSampler(2, heightmapSampler);
            setDesc.bindSampler(3, layersSampler);
            this.sceneBindingSet = this.app.createBindingSetForLayout(setDesc, this.sceneLayout);

            // Post-processing's: the output image (one set per image, see createTargets).
            const postLayoutDesc = BindingLayoutDesc.create();
            postLayoutDesc.layoutVolatileConstantBuffer(0);
            postLayoutDesc.layoutTextureSRV(0);
            postLayoutDesc.layoutSampler(0);
            this.postLayout = this.app.createBindingLayout(postLayoutDesc, ShaderType.All);

            // Its random numbers: a fixed seed.
            this.rng = this.app.createRandomEngine(12345);

            const pass = this.app.addPass();
            pass.setMousePosCallback(this.onMousePos);
            pass.setMouseButtonCallback(this.onMouseButton);
            pass.setAnimateCallback(this.onAnimate);
            pass.setBackBufferResizingCallback(this.onBackBufferResizing);
            pass.setRenderCallback(this.onRender);
            return true;
        }
    }

    // The sample's overlay: its options, and the CPU frame time graph along the bottom.
    class UserInterface {
        private sample: ShaderObjectPass;
        private app: App;
        // The value slider() leaves.
        private sliderValue: int;

        constructor(sample: ShaderObjectPass, app: App) {
            this.sample = sample;
            this.app = app;
            this.sliderValue = 0;
        }

        checkbox(label: string, value: boolean): boolean {
            return Donut_ImGuiCheckbox(label, value ? 1 : 0) != 0;
        }

        // The sample's imgui_slider: a checkbox (iterate this choice), the slider (grayed out when
        // not iterated), the shader's name. Returns the checkbox, the slider's value in sliderValue.
        slider(enabled: boolean, label: string, name: string, value: int, max: int, alignment: number,
            checkboxAlignment: number): boolean {
            const result = this.checkbox(`##${label}`, enabled);
            Donut_ImGuiSameLineAt(checkboxAlignment);
            if (result) {
                Donut_ImGuiPushTextColor(1.0, 1.0, 1.0, 1.0);
            } else {
                Donut_ImGuiPushTextColor(0.3, 0.3, 0.3, 1.0);
            }
            this.sliderValue = Donut_ImGuiSliderInt(label, value, 0, max);
            Donut_ImGuiPopStyleColor();
            Donut_ImGuiSameLineAt(alignment);
            Donut_ImGuiText(name);
            return result;
        }

        buildUI(): void {
            const s = this.sample;
            const width = this.app.getWindowWidth();
            const height = this.app.getWindowHeight();
            const fontSize = Donut_ImGuiGetFontSize();
            // The sample's DPI factor (ImGui's font is 13 pixels unscaled).
            const dpiFactor = fontSize / 13.0;

            Donut_ImGuiSetNextWindowPos(10.0, 10.0);
            Donut_ImGuiBegin("Shader Object", 1);
            // The framework's drawer narrows the items to 110 pixels (scaled).
            Donut_ImGuiPushItemWidth(110.0 * dpiFactor);
            if (Donut_ImGuiCollapsingHeader("Options") != 0) {
                const span = Math.min(Math.max(width, 1300), 2000);
                const checkboxOptionSpacing = Math.floor(span * 0.12 * dpiFactor);
                const sliderSpacing = Math.floor(span * 0.24 * dpiFactor);
                const checkboxSpacing = Math.floor(span * 0.025 * dpiFactor);

                s.wireframeMode = this.checkbox("Wireframe Mode", s.wireframeMode);
                Donut_ImGuiSameLineAt(checkboxOptionSpacing);
                s.iteratePermutations = this.checkbox("Iterate Mode", s.iteratePermutations);
                Donut_ImGuiSameLineAt(checkboxOptionSpacing * 2);
                s.postProcessing = this.checkbox("Post Processing Enabled", s.postProcessing);
                s.enableGeometryPass = this.checkbox("Material Shader Geometry Pass Enabled", s.enableGeometryPass);
                Donut_ImGuiText("Checkbox Enables Random Shader Iterate");

                s.selectedBasicObject = Donut_ImGuiSliderInt("Selected Basic Object:", s.selectedBasicObject, 0, NUM_BASIC_OBJECTS - 1);
                const basic = s.selectedBasicObject;
                s.iterateBasic = this.slider(s.iterateBasic, "Basic Linked Shader Set:", BASIC_NAMES[s.currentBasicLinkedShaders[basic]],
                    s.currentBasicLinkedShaders[basic], BASIC_VS.length - 1, sliderSpacing, checkboxSpacing);
                s.currentBasicLinkedShaders[basic] = this.sliderValue;

                s.selectedMaterialObject = Donut_ImGuiSliderInt("Selected Material Object:", s.selectedMaterialObject, 0, NUM_MATERIAL_OBJECTS - 1);
                const material = s.selectedMaterialObject;
                s.iterateMaterialVert = this.slider(s.iterateMaterialVert, "Material Vert Shader:", MATERIAL_VS_NAMES[s.currentMaterialVert[material]],
                    s.currentMaterialVert[material], MATERIAL_VS.length - 1, sliderSpacing, checkboxSpacing);
                s.currentMaterialVert[material] = this.sliderValue;
                s.iterateMaterialGeo = this.slider(s.iterateMaterialGeo, "Material Geo Shader:", MATERIAL_GS_NAMES[s.currentMaterialGeo[material]],
                    s.currentMaterialGeo[material], MATERIAL_GS.length - 1, sliderSpacing, checkboxSpacing);
                s.currentMaterialGeo[material] = this.sliderValue;
                s.iterateMaterialFrag = this.slider(s.iterateMaterialFrag, "Material Frag Shader:", MATERIAL_PS_NAMES[s.currentMaterialFrag[material]],
                    s.currentMaterialFrag[material], MATERIAL_PS.length - 1, sliderSpacing, checkboxSpacing);
                s.currentMaterialFrag[material] = this.sliderValue;
                s.iteratePostProcess = this.slider(s.iteratePostProcess, "Post Process Frag Shader:", POST_NAMES[s.currentPostProcessShader],
                    s.currentPostProcessShader, POST_PS.length - 1, sliderSpacing, checkboxSpacing);
                s.currentPostProcessShader = this.sliderValue;
                s.iterateOutput = this.slider(s.iterateOutput, "Output Format:", OUTPUT_FORMAT_NAMES[s.outputFormats[s.currentOutputFormat]],
                    s.currentOutputFormat, s.outputFormats.length - 1, sliderSpacing, checkboxSpacing);
                s.currentOutputFormat = this.sliderValue;
                s.iterateDepth = this.slider(s.iterateDepth, "Depth Format:", DEPTH_FORMAT_NAMES[s.depthFormats[s.currentDepthFormat]],
                    s.currentDepthFormat, s.depthFormats.length - 1, sliderSpacing, checkboxSpacing);
                s.currentDepthFormat = this.sliderValue;

                if (Donut_ImGuiButton("Randomize All") != 0) {
                    s.randomizeCurrent();
                }
            }
            Donut_ImGuiPopItemWidth();
            Donut_ImGuiEnd();

            // The CPU frame time graph (16.667 ms at the top) along the bottom of the screen.
            const graphHeight = Math.min(height, 400) * 0.25 * dpiFactor;
            const windowHeight = graphHeight + fontSize * 2.0;
            Donut_ImGuiBeginOverlay("Histograms of CPU Frame time in (ms) of last 2000 frames", 0.0, height - windowHeight,
                width, windowHeight);
            let maxValue = 0.0;
            for (let i = 0; i < TIMESTAMP_COUNT; i++) {
                maxValue = Math.max(maxValue, s.timestampValues[i]);
            }
            Donut_ImGuiText("16.667 ms");
            Donut_ImGuiSameLineAt(-fontSize);
            Donut_ImGuiPlotLines("##Frame Times", Ref(s.timestampValues[0]), TIMESTAMP_COUNT, s.currentTimestamp + 1, 0.0, 16.667,
                1.08 * width, graphHeight, 0);
            Donut_ImGuiText(`CPU Frame Time: ${formatFixed(s.timestampValues[s.currentTimestamp], 6)} ms (max ${formatFixed(maxValue, 6)} ms)`);
            Donut_ImGuiEnd();
            s.currentTimestamp = (s.currentTimestamp + 1) % TIMESTAMP_COUNT;
        }

        // Declared after buildUI: tslang resolves `this.buildUI` only for members declared earlier.
        init(): boolean {
            return !this.app.addImGuiPass(this.buildUI).isNull();
        }
    }

    export function main(argc: int, argv: Ref<string>): int {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("shader_object");

        // -debug: the graphics API's debug layer and NVRHI's validation layer.
        // -noui: without the options and the frame time graph.
        // -benchmark: 1/60 second per frame (as vulkan_samples' --benchmark).
        let options = AppOptions.None;
        let withUI = true;
        let benchmark = false;
        for (let i = 1; i < argc; i++) {
            const arg = Donut_GetArg(argv, i);
            if (arg == "-debug") {
                options = AppOptions.DebugRuntime;
            } else if (arg == "-noui") {
                withUI = false;
            } else if (arg == "-benchmark") {
                benchmark = true;
            }
        }

        const api = Donut_GetGraphicsAPIFromCommandLine(argc, argv);
        const app = App.createWithOptions(api, WINDOW_TITLE, 1280, 720, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        const sample = new ShaderObjectPass(app);
        sample.benchmark = benchmark;
        if (!sample.init()) {
            app.destroy();
            return 1;
        }

        // Drawn after (over) the scene, and sees the mouse first.
        const gui = new UserInterface(sample, app);
        if (withUI && !gui.init()) {
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
    return ShaderObjectSample.main(argc, argv);
}
