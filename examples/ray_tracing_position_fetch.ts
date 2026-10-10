// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";

namespace RayTracingPositionFetch {
    const WINDOW_TITLE = "Donut Example: Ray Tracing Position Fetch";

    // The sample's scene (Vulkan-Samples' assets, copied at build time, see
    // VULKAN_SAMPLES_ASSETS_DIR in CMakeLists.txt): the Pica Pica robot, its meshes' positions only.
    const SCENE_PATH = "media/ray_tracing_position_fetch/pica_pica_robot/scene.gltf";

    // Donut_LoadGltfModel's vertices: float3 position, float3 normal, float2 texture coordinates.
    const VERTEX_FLOATS = 8;
    const VERTEX_SIZE = VERTEX_FLOATS * 4;

    // The BLAS geometries' transform (a VkTransformMatrixKHR: 3 rows of 4): the robot mirrored in y
    // and moved 2 down, upright in the sample's world (-y up on the screen).
    const GEOMETRY_TRANSFORM = [
        1.0, 0.0, 0.0, 0.0,
        0.0, -1.0, 0.0, 2.0,
        0.0, 0.0, 1.0, 0.0,
    ];
    const IDENTITY_TRANSFORM = [
        1.0, 0.0, 0.0, 0.0,
        0.0, 1.0, 0.0, 0.0,
        0.0, 0.0, 1.0, 0.0,
    ];
    // VK_GEOMETRY_INSTANCE_TRIANGLE_FACING_CULL_DISABLE_BIT_KHR (nvrhi::rt::InstanceFlags).
    const INSTANCE_FLAGS_CULL_DISABLE = 1;

    // struct UBO { float4x4 viewInverse, projInverse; int displayMode; }, padded.
    const UBO_VIEW_INVERSE = 0;
    const UBO_PROJ_INVERSE = 16;
    const UBO_DISPLAY_MODE = 32;
    const UBO_FLOATS = 36;
    // The payload: float3 hitValue.
    const PAYLOAD_SIZE = 12;

    // The sample's look-at camera, at (0, 0, -6.5) (the view's translation) turned 15 degrees
    // around y; a 60 degree vertical field of view, depth from 0.1 to 512.
    const CAMERA_TRANSLATION = [0.0, 0.0, -6.5];
    const CAMERA_ROTATION = [0.0, 15.0, 0.0];
    const CAMERA_FOV = 60.0;
    const Z_NEAR = 0.1;
    const Z_FAR = 512.0;

    const DISPLAY_MODE_NAMES = "Geometric normal|Vertex position";

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

    // glm::rotate(m, angle, axis) for a unit axis.
    function rotate(m: number[], angle: number, x: number, y: number, z: number): number[] {
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

    function radians(degrees: number): number {
        return degrees * Math.PI / 180.0;
    }

    // The inverse of a rotation and translation [R t]: [R^T -R^T t].
    function inverseRigid(m: number[]): number[] {
        let result = identity();
        for (let row = 0; row < 3; row++) {
            for (let column = 0; column < 3; column++) {
                result[column * 4 + row] = m[row * 4 + column];
            }
        }
        for (let row = 0; row < 3; row++) {
            let t = 0.0;
            for (let k = 0; k < 3; k++) {
                t -= m[row * 4 + k] * m[12 + k];
            }
            result[12 + row] = t;
        }
        return result;
    }

    // inverse(glm::perspective(fov, aspect, near, far)) (right-handed, depth from 0 to 1).
    function inversePerspective(fov: number, aspect: number, zNear: number, zFar: number): number[] {
        const tanHalfFovy = Math.tan(0.5 * fov);
        const p22 = zFar / (zNear - zFar);
        const p32 = -(zFar * zNear) / (zFar - zNear);
        return [
            aspect * tanHalfFovy, 0.0,         0.0,  0.0,
            0.0,                  tanHalfFovy, 0.0,  0.0,
            0.0,                  0.0,         0.0,  1.0 / p32,
            0.0,                  0.0,         -1.0, p22 / p32,
        ];
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
            this.position = [CAMERA_TRANSLATION[0], CAMERA_TRANSLATION[1], CAMERA_TRANSLATION[2]];
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
            let t = identity();
            t[12] = this.position[0];
            t[13] = this.position[1];
            t[14] = this.position[2];
            return multiply(t, r);
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

    // Port of Vulkan-Samples' ray_tracing_position_fetch: the robot's meshes in one bottom-level
    // acceleration structure built so that hit shaders can read its vertex positions
    // (AccelStructBuildFlags.AllowDataAccess), ray traced; the closest hit shader shows each hit
    // triangle's geometric normal or the position hit, both from the positions it fetches, not from
    // vertex buffers. Vulkan only (VK_KHR_ray_tracing_position_fetch).
    class RayTracingPositionFetchPass {
        private app: App;
        private camera: SampleCamera;

        // The sample's display mode, from its UI: 0 geometric normal, 1 vertex position.
        displayMode: int;

        private blas: TriangleBlas;
        private topLevelAS: SceneAccelStructs;
        private bindingLayout: Opaque;
        private shaderTable: ShaderTable;
        private uniformBuffer: Opaque;
        // Created on the first frame (the back buffer's size and channel order), dropped on resize.
        private storageImage: Opaque | null;
        private bindingSet: BindingSet;

        // Upload buffers.
        private ubo: f32[];
        private transform: f32[];

        constructor(app: App) {
            this.app = app;
            this.camera = new SampleCamera();
            this.displayMode = 0;
            this.storageImage = null;
            this.bindingSet = new BindingSet(null);
            this.ubo = [];
            for (let i = 0; i < UBO_FLOATS; i++) {
                this.ubo.push(0.0);
            }
            this.transform = [];
            for (let i = 0; i < 12; i++) {
                this.transform.push(IDENTITY_TRANSFORM[i]);
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

        onAnimate(elapsedSeconds: number): void {
            this.app.setInformativeWindowTitle(WINDOW_TITLE);
        }

        onBackBufferResizing(): void {
            const storageImage = this.storageImage;
            if (storageImage) {
                this.app.releaseResource(storageImage);
            }
            if (!this.bindingSet.isNull()) {
                this.app.releaseResource(this.bindingSet.handle);
            }
            this.storageImage = null;
            this.bindingSet = new BindingSet(null);
        }

        // The sample's update_uniform_buffers: inverse view and projection matrices, the display mode.
        updateUniformBuffers(commandList: CommandList, width: int, height: int): void {
            const viewInverse = inverseRigid(this.camera.view());
            const projInverse = inversePerspective(radians(CAMERA_FOV), width / height, Z_NEAR, Z_FAR);
            const u = this.ubo;
            for (let i = 0; i < 16; i++) {
                u[UBO_VIEW_INVERSE + i] = viewInverse[i];
                u[UBO_PROJ_INVERSE + i] = projInverse[i];
            }
            Donut_StoreInt32(Ref(u[UBO_DISPLAY_MODE]), this.displayMode);
            commandList.writeBuffer(this.uniformBuffer, Ref(u[0]), UBO_FLOATS * 4);
        }

        onRender(frameHandle: FrameHandle): void {
            const frame = new Frame(frameHandle);
            const width = frame.getWidth();
            const height = frame.getHeight();
            const commandList = frame.getCommandList();

            let storageImage = this.storageImage;
            if (!storageImage) {
                // The image the ray generation shader writes: UNORM, in the back buffer's channel
                // order, for the copy below.
                const image = this.app.createUAVTextureForFrameCopy(frame, "StorageImage");
                const setDesc = BindingSetDesc.create();
                setDesc.bindEntireConstantBuffer(0, this.uniformBuffer);
                setDesc.bindAccelStruct(0, this.topLevelAS.getTopLevelAS());
                setDesc.bindTextureUAV(0, image);
                this.bindingSet = this.app.createBindingSetForLayout(setDesc, this.bindingLayout);
                this.storageImage = image;
                storageImage = image;
            }

            this.updateUniformBuffers(commandList, width, height);

            // The sample's top-level acceleration structure: the BLAS once, untransformed, both
            // faces of its triangles hit.
            this.topLevelAS.addInstanceWithTransform(this.blas.getAccelStruct(), 0xFF, 0, INSTANCE_FLAGS_CULL_DISABLE,
                Ref(this.transform[0]));
            frame.buildTopLevelAS(this.topLevelAS);

            frame.dispatchRays(this.shaderTable, this.bindingSet, width, height);
            // Without conversion, as the sample's copy: the UNORM values become the back buffer's
            // (sRGB) encoded ones.
            frame.copyTextureToFrame(storageImage as Opaque);
        }

        // The sample's create_bottom_level_acceleration_structure: every mesh's triangles (in mesh
        // space: the scene's node transforms aren't applied), each a geometry with the transform,
        // in one BLAS, its vertex positions readable by hit shaders. Recorded into an open command
        // list.
        createBottomLevelAccelerationStructure(commandList: CommandList): boolean {
            const scene = this.app.loadGltfModel(SCENE_PATH);
            if (scene.isNull()) {
                return false;
            }
            const primitiveCount = scene.getPrimitiveCount();
            let vertices: f32[] = [];
            let indices: int[] = [];
            let firstVertex: int[] = [];
            let firstIndex: int[] = [];
            for (let p = 0; p < primitiveCount; p++) {
                const vertexCount = scene.getVertexCount(p);
                const indexCount = scene.getIndexCount(p);
                let primitiveVertices: f32[] = [];
                for (let i = 0; i < vertexCount * VERTEX_FLOATS; i++) {
                    primitiveVertices.push(0.0);
                }
                let primitiveIndices: int[] = [];
                for (let i = 0; i < indexCount; i++) {
                    primitiveIndices.push(0);
                }
                scene.copyVertices(p, Ref(primitiveVertices[0]));
                scene.copyIndices(p, Ref(primitiveIndices[0]));
                firstVertex.push(vertices.length / VERTEX_FLOATS);
                firstIndex.push(indices.length);
                for (let i = 0; i < primitiveVertices.length; i++) {
                    vertices.push(primitiveVertices[i]);
                }
                for (let i = 0; i < indexCount; i++) {
                    indices.push(primitiveIndices[i]);
                }
            }

            const vertexBuffer = this.app.createAccelStructInputBuffer(vertices.length * 4, "Vertices");
            const indexBuffer = this.app.createAccelStructInputBuffer(indices.length * 4, "Indices");
            commandList.writeBuffer(vertexBuffer, Ref(vertices[0]), vertices.length * 4);
            commandList.writeBuffer(indexBuffer, Ref(indices[0]), indices.length * 4);

            let geometryTransform: f32[] = [];
            for (let i = 0; i < 12; i++) {
                geometryTransform.push(GEOMETRY_TRANSFORM[i]);
            }
            this.blas = this.app.createEmptyTriangleBlas("BLAS");
            for (let p = 0; p < primitiveCount; p++) {
                this.blas.addGeometry(indexBuffer, firstIndex[p] * 4, scene.getIndexCount(p), vertexBuffer,
                    firstVertex[p] * VERTEX_SIZE, scene.getVertexCount(p), VERTEX_SIZE, Ref(geometryTransform[0]));
            }
            return this.blas.build(this.app, commandList, AccelStructBuildFlags.AllowDataAccess | AccelStructBuildFlags.PreferFastTrace) != 0;
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(): boolean {
            const layoutDesc = BindingLayoutDesc.create();
            layoutDesc.layoutVolatileConstantBuffer(0);
            layoutDesc.layoutAccelStruct(0);
            layoutDesc.layoutTextureUAV(0);
            this.bindingLayout = this.app.createBindingLayout(layoutDesc, ShaderType.All);

            const shaderLibrary = this.app.createShaderLibrary("ray_tracing_position_fetch.hlsl");
            if (!shaderLibrary) {
                return false;
            }
            const pipeline = this.app.createRayTracingPipeline(shaderLibrary, this.bindingLayout, "raygen", "miss", "HitGroup",
                "closesthit", PAYLOAD_SIZE);
            if (!pipeline) {
                return false;
            }
            this.shaderTable = this.app.createShaderTable(pipeline, "raygen", "HitGroup", "miss");
            // The shader table keeps the pipeline alive.
            this.app.releaseResource(pipeline);

            const commandList = this.app.createCommandList();
            commandList.open();
            const loaded = this.createBottomLevelAccelerationStructure(commandList);
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.waitForIdle();
            this.app.releaseResource(commandList.handle);
            if (!loaded) {
                console.log("Cannot load the scene: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return false;
            }
            this.topLevelAS = this.app.createTopLevelAS(1);
            this.uniformBuffer = this.app.createVolatileConstantBuffer(UBO_FLOATS * 4, "UBO");

            const pass = this.app.addPass();
            pass.setMousePosCallback(this.onMousePos);
            pass.setMouseButtonCallback(this.onMouseButton);
            pass.setAnimateCallback(this.onAnimate);
            pass.setBackBufferResizingCallback(this.onBackBufferResizing);
            pass.setRenderCallback(this.onRender);
            return true;
        }
    }

    // The sample's display mode choice.
    class UserInterface {
        private pass: RayTracingPositionFetchPass;

        constructor(pass: RayTracingPositionFetchPass) {
            this.pass = pass;
        }

        buildUI(): void {
            Donut_ImGuiSetNextWindowPos(10.0, 10.0);
            Donut_ImGuiBegin("Options", 1);
            this.pass.displayMode = Donut_ImGuiCombo("Display mode", this.pass.displayMode, DISPLAY_MODE_NAMES);
            Donut_ImGuiEnd();
        }

        // Declared after buildUI: tslang resolves `this.buildUI` only for members declared earlier.
        init(app: App): boolean {
            return !app.addImGuiPass(this.buildUI).isNull();
        }
    }

    export function main(argc: int, argv: Ref<string>): int {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("ray_tracing_position_fetch");

        // -debug: the graphics API's debug layer and NVRHI's validation layer.
        // -noui: without the options window.
        // -mode <n>: display mode 0 (geometric normal) or 1 (vertex position).
        let options = AppOptions.RayTracing;
        let withUI = true;
        let displayMode = 0;
        for (let i = 1; i < argc; i++) {
            const arg = Donut_GetArg(argv, i);
            if (arg == "-debug") {
                options = options | AppOptions.DebugRuntime;
            } else if (arg == "-noui") {
                withUI = false;
            } else if (arg == "-mode" && i + 1 < argc) {
                displayMode = Math.min(1, Math.max(0, parseInt(Donut_GetArg(argv, i + 1))));
                i++;
            }
        }

        // Position fetch is Vulkan's (VK_KHR_ray_tracing_position_fetch); D3D12 has it only through
        // NVAPI's HLSL extensions, which this build doesn't have.
        const api = Donut_GetGraphicsAPIFromCommandLine(argc, argv);
        if (api != GraphicsAPI.VULKAN) {
            console.log("This example needs Vulkan (-vk): it reads vertex positions in hit shaders, VK_KHR_ray_tracing_position_fetch");
            return 1;
        }
        const app = App.createWithOptions(api, WINDOW_TITLE, 1280, 720, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        if (app.isFeatureSupported(Feature.RayTracingPipeline) == 0
            || app.isFeatureSupported(Feature.RayTracingPositionFetch) == 0) {
            console.log("The graphics device has no ray tracing pipelines with position fetch (VK_KHR_ray_tracing_position_fetch)");
            app.destroy();
            return 1;
        }

        const pass = new RayTracingPositionFetchPass(app);
        if (!pass.init()) {
            app.destroy();
            return 1;
        }
        pass.displayMode = displayMode;

        // Drawn after (over) the scene, and sees the mouse first.
        const gui = new UserInterface(pass);
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
    return RayTracingPositionFetch.main(argc, argv);
}
