// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";
import { Args } from "../core/args";
import { TestCheck, unsupported } from "../core/test_check";
import { radians, perspective, inverseGaussJordan } from "../core/matrix";
import { LookAtCamera } from "../core/vulkan_samples_camera";

namespace RayTracingReflection {
    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    // -test: checks the last frame. The top corners are the gray background; the cubes and their
    // reflections color about a quarter of the frame, blue about 1.5%.
    function checkFrame(app: App) {
        const check = new TestCheck(app);
        if (check.frameRead() != "") {
            return check.frameRead();
        }
        const total = check.width * check.height;
        if (check.rgb(0, 0) != 0x4C4C4C || check.rgb(check.width - 1, 0) != 0x4C4C4C) {
            return "the top corners aren't the gray background";
        }
        const colored = check.share(check.countSpread(61, false, 0, 0, 0, check.width, check.height), total,
            15.0, 35.0, "Colored");
        if (colored != "") {
            return colored;
        }
        return check.share(check.countInRange(0, 89, 0, 119, 121, 255, 0, 0, check.width, check.height), total,
            0.8, 3.0, "Blue");
    }

    const WINDOW_TITLE = "Donut Example: Ray Tracing Reflection";

    // The sample's camera: look-at type, not turned, at (0, 0, -2.5) (vkb::Camera's position, the
    // view's translation).
    const CAMERA_POSITION = [0.0, 0.0, -2.5];
    const CAMERA_FOV = 60.0;
    const Z_NEAR = 0.1;
    const Z_FAR = 512.0;

    // struct hitPayload { float3 radiance, attenuation; int done; float3 rayOrigin, rayDir; }.
    const PAYLOAD_SIZE = 13 * 4;
    // The closest hit shader traces shadow rays.
    const MAX_RECURSION_DEPTH = 2;

    // struct UniformData { float4x4 view_inverse, proj_inverse; }.
    const UBO_VIEW_INVERSE = 0;
    const UBO_PROJ_INVERSE = 16;
    const UBO_FLOATS = 32;

    // ObjVertex: float3 pos, float3 nrm. ObjMaterial: float3 diffuse, float3 specular, float
    // shininess.
    const VERTEX_FLOATS = 6;
    const MATERIAL_FLOATS = 7;

    // nvrhi::rt::InstanceFlags::TriangleCullDisable.
    const INSTANCE_FLAGS_CULL_DISABLE = 1;

    // The sample's ObjPlane: a 2 x 2 square facing +y.
    const PLANE_VERTICES = [
        +1.0, 0.0, +1.0, 0.0, 1.0, 0.0,
        -1.0, 0.0, +1.0, 0.0, 1.0, 0.0,
        +1.0, 0.0, -1.0, 0.0, 1.0, 0.0,
        -1.0, 0.0, -1.0, 0.0, 1.0, 0.0,
    ];
    const PLANE_INDICES = [0, 1, 2, 1, 2, 3];
    const PLANE_MAT_INDEX = [0, 0];

    // Its ObjCube: a unit cube, each face's 4 vertices with its normal.
    const CUBE_VERTICES = [
        +0.5, +0.5, +0.5, +0.0, +1.0, +0.0,        // Top
        -0.5, +0.5, +0.5, +0.0, +1.0, +0.0,
        +0.5, +0.5, -0.5, +0.0, +1.0, +0.0,
        -0.5, +0.5, -0.5, +0.0, +1.0, +0.0,
        +0.5, -0.5, +0.5, +0.0, -1.0, +0.0,        // Bottom
        -0.5, -0.5, +0.5, +0.0, -1.0, +0.0,
        +0.5, -0.5, -0.5, +0.0, -1.0, +0.0,
        -0.5, -0.5, -0.5, +0.0, -1.0, +0.0,
        +0.5, +0.5, +0.5, +1.0, +0.0, +0.0,        // Right
        +0.5, +0.5, -0.5, +1.0, +0.0, +0.0,
        +0.5, -0.5, -0.5, +1.0, +0.0, +0.0,
        +0.5, -0.5, +0.5, +1.0, +0.0, +0.0,
        -0.5, +0.5, +0.5, -1.0, +0.0, +0.0,        // left
        -0.5, +0.5, -0.5, -1.0, +0.0, +0.0,
        -0.5, -0.5, -0.5, -1.0, +0.0, +0.0,
        -0.5, -0.5, +0.5, -1.0, +0.0, +0.0,
        -0.5, +0.5, +0.5, +0.0, +0.0, +1.0,        // front
        +0.5, +0.5, +0.5, +0.0, +0.0, +1.0,
        +0.5, -0.5, +0.5, +0.0, +0.0, +1.0,
        -0.5, -0.5, +0.5, +0.0, +0.0, +1.0,
        -0.5, +0.5, -0.5, +0.0, +0.0, -1.0,        // back
        +0.5, +0.5, -0.5, +0.0, +0.0, -1.0,
        +0.5, -0.5, -0.5, +0.0, +0.0, -1.0,
        -0.5, -0.5, -0.5, +0.0, +0.0, -1.0,
    ];
    const CUBE_INDICES = [
        0, 1, 2, 1, 2, 3,       /*top*/
        4, 5, 6, 5, 6, 7,       /*bottom*/
        8, 9, 10, 8, 10, 11,    /*right*/
        12, 13, 14, 12, 14, 15, /*left*/
        16, 17, 18, 16, 18, 19, /*front*/
        20, 21, 22, 20, 22, 23, /*back*/
    ];
    const CUBE_MAT_INDEX = [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5];

    // The sample's materials (diffuse, specular, shininess).
    const MAT_RED = [1.0, 0.0, 0.0, 1.0, 1.0, 1.0, 0.0];
    const MAT_GREEN = [0.0, 1.0, 0.0, 1.0, 1.0, 1.0, 0.0];
    const MAT_BLUE = [0.0, 0.0, 1.0, 1.0, 1.0, 1.0, 0.0];
    const MAT_YELLOW = [1.0, 1.0, 0.0, 1.0, 1.0, 1.0, 0.0];
    const MAT_CYAN = [0.0, 1.0, 1.0, 1.0, 1.0, 1.0, 0.0];
    const MAT_MAGENTA = [1.0, 0.0, 1.0, 1.0, 1.0, 1.0, 0.0];
    // Slightly reflective
    const MAT_GREY = [0.7, 0.7, 0.7, 0.9, 0.9, 0.9, 0.1];
    // Mirror Slightly blue
    const MAT_MIRROR = [0.3, 0.9, 1.0, 0.9, 0.9, 0.9, 0.9];

    // --- Math (glm's layout: 4 x 4 matrices by columns) ---------------------------------------

    // glm::scale(glm::translate(mat4(1), t), s): columns scaled, translation t.
    function scaled(tx: number, ty: number, tz: number, sx: number, sy: number, sz: number) {
        return [sx, 0.0, 0.0, 0.0, 0.0, sy, 0.0, 0.0, 0.0, 0.0, sz, 0.0, tx, ty, tz, 1.0];
    }

    // --- Pass -------------------------------------------------------------------------------

    // Port of Vulkan-Samples' ray_tracing_reflection: two cubes with a color per face over a
    // slightly reflective floor, between two mirrors facing each other, ray traced with a ray
    // tracing pipeline. Each ray bounces off reflective surfaces until little of it is left (up to
    // 64 times); each hit is lit by a fixed light, with a shadow ray (a second miss shader). The
    // scene: three models (the colored cube, the plane, the mirror cube), five instances.
    class RayTracingReflectionPass {
        private app: App;
        private camera: LookAtCamera;

        private bindingLayout: BindingLayoutHandle;
        private shaderTable: ShaderTable;
        private uniformBuffer: BufferHandle;
        private objDescBuffer: BufferHandle;
        private vertexBuffer: BufferHandle;
        private indexBuffer: BufferHandle;
        private matIndexBuffer: BufferHandle;
        private materialBuffer: BufferHandle;
        private blases: TriangleBlas[];
        private topLevelAS: SceneAccelStructs;
        private topLevelASBuilt: boolean;

        // The storage image (the frame's size) and the binding set with it.
        private storageImage: TextureHandle | null;
        private bindingSet: BindingSet;

        // Upload buffers.
        private ubo: f32[];
        private transform: f32[];

        constructor(app: App) {
            this.app = app;
            this.camera = new LookAtCamera(CAMERA_POSITION, [0.0, 0.0, 0.0]);
            this.blases = [];
            this.topLevelASBuilt = false;
            this.storageImage = null;
            this.bindingSet = new BindingSet(null);
            this.ubo = [];
            for (let i = 0; i < UBO_FLOATS; i++) {
                this.ubo.push(0.0);
            }
            this.transform = [];
            for (let i = 0; i < 12; i++) {
                this.transform.push(0.0);
            }
        }

        init() {
            const layoutDesc = BindingLayoutDesc.create();
            layoutDesc.layoutVolatileConstantBuffer(0);
            layoutDesc.layoutAccelStruct(0);
            layoutDesc.layoutStructuredBufferSRV(1);
            layoutDesc.layoutStructuredBufferSRV(2);
            layoutDesc.layoutStructuredBufferSRV(3);
            layoutDesc.layoutStructuredBufferSRV(4);
            layoutDesc.layoutStructuredBufferSRV(5);
            layoutDesc.layoutTextureUAV(0);
            this.bindingLayout = this.app.createBindingLayout(layoutDesc, ShaderType.All);

            if (!this.createRayTracingPipeline()) {
                return false;
            }

            const commandList = this.app.createCommandList();
            commandList.open();
            const created = this.createModels(commandList);
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.waitForIdle();
            this.app.releaseResource(commandList.handle);
            if (!created) {
                return false;
            }

            this.topLevelAS = this.app.createTopLevelAS(5);
            this.uniformBuffer = this.app.createVolatileConstantBuffer(UBO_FLOATS * 4, "CameraProperties");

            const pass = this.app.addPass();
            pass.setMousePosCallback(this.onMousePos);
            pass.setMouseButtonCallback(this.onMouseButton);
            pass.setAnimateCallback(this.onAnimate);
            pass.setBackBufferResizingCallback(this.onBackBufferResizing);
            pass.setRenderCallback(this.onRender);
            return true;
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
            this.app.setInformativeWindowTitle(WINDOW_TITLE);
        }

        // The storage image has the back buffers' size.
        onBackBufferResizing() {
            const bindingSet = this.bindingSet;
            if (!bindingSet.isNull()) {
                this.app.releaseResource(bindingSet.handle);
                this.bindingSet = new BindingSet(null);
            }
            const storageImage = this.storageImage;
            if (storageImage) {
                this.app.releaseResource(storageImage);
                this.storageImage = null;
            }
        }

        // The sample's create_blas_instance: the instance's transform, transposed to 3 rows of 4,
        // its custom index the model's (for its buffers).
        addInstance(blasId: int, m: number[]) {
            for (let row = 0; row < 3; row++) {
                for (let column = 0; column < 4; column++) {
                    this.transform[row * 4 + column] = m[column * 4 + row];
                }
            }
            this.topLevelAS.addInstanceWithTransform(this.blases[blasId].getAccelStruct(), 0xFF, blasId,
                INSTANCE_FLAGS_CULL_DISABLE, Ref(this.transform[0]));
        }

        // The rest of the sample's create_scene: the mirrors behind and in front, the floor below,
        // the two cubes side by side.
        buildTopLevelAS(frame: Frame) {
            this.addInstance(0, scaled(-1.0, 0.0, 0.0, 1.0, 1.0, 1.0));
            this.addInstance(0, scaled(1.0, 0.0, 0.0, 1.0, 1.0, 1.0));
            this.addInstance(1, scaled(0.0, -1.0, 0.0, 15.0, 15.0, 15.0));
            this.addInstance(2, scaled(0.0, 0.0, -7.0, 5.0, 5.0, 0.1));
            this.addInstance(2, scaled(0.0, 0.0, 7.0, 5.0, 5.0, 0.1));
            frame.buildTopLevelAS(this.topLevelAS);
        }

        // The sample's update_uniform_buffers: the inverses of its view and of its projection
        // with the Vulkan y flip (the ray generation shader's launch rows run down, as Vulkan's).
        updateUniformBuffers(width: int, height: int) {
            let projection = perspective(radians(CAMERA_FOV), width / height, Z_NEAR, Z_FAR);
            projection[5] = -projection[5];
            const projInverse = inverseGaussJordan(projection);
            const viewInverse = inverseGaussJordan(this.camera.view());
            for (let i = 0; i < 16; i++) {
                this.ubo[UBO_VIEW_INVERSE + i] = viewInverse[i];
                this.ubo[UBO_PROJ_INVERSE + i] = projInverse[i];
            }
        }

        onRender(frameHandle: FrameHandle) {
            const frame = new Frame(frameHandle);
            const width = frame.getWidth();
            const height = frame.getHeight();
            const commandList = frame.getCommandList();

            let storageImage = this.storageImage;
            let bindingSet = this.bindingSet;
            if (!storageImage || bindingSet.isNull()) {
                // The storage image the ray generation shader writes: UNORM, in the back buffer's
                // channel order, for the copy below.
                storageImage = this.app.createUAVTextureForFrameCopy(frame, "StorageImage");

                const bindingSetDesc = BindingSetDesc.create();
                bindingSetDesc.bindEntireConstantBuffer(0, this.uniformBuffer);
                bindingSetDesc.bindAccelStruct(0, this.topLevelAS.getTopLevelAS());
                bindingSetDesc.bindStructuredBufferSRV(1, this.objDescBuffer);
                bindingSetDesc.bindStructuredBufferSRV(2, this.vertexBuffer);
                bindingSetDesc.bindStructuredBufferSRV(3, this.indexBuffer);
                bindingSetDesc.bindStructuredBufferSRV(4, this.matIndexBuffer);
                bindingSetDesc.bindStructuredBufferSRV(5, this.materialBuffer);
                bindingSetDesc.bindTextureUAV(0, storageImage);
                bindingSet = this.app.createBindingSetForLayout(bindingSetDesc, this.bindingLayout);

                this.storageImage = storageImage;
                this.bindingSet = bindingSet;
            }

            if (!this.topLevelASBuilt) {
                this.buildTopLevelAS(frame);
                this.topLevelASBuilt = true;
            }

            this.updateUniformBuffers(width, height);
            commandList.writeBuffer(this.uniformBuffer, Ref(this.ubo[0]), UBO_FLOATS * 4);

            frame.dispatchRays(this.shaderTable, bindingSet, width, height);

            // Without conversion, as the sample's vkCmdCopyImage: the UNORM values become the sRGB
            // back buffer's encoded ones.
            frame.copyTextureToFrame(storageImage);
        }

        // The sample's create_model for each model and create_bottom_level_acceleration_structure:
        // its vertices, indices, material indices (clamped to its materials) and materials,
        // appended to one buffer of each, and a BLAS of its triangles.
        createModels(commandList: CommandList) {
            const vertexLists = [CUBE_VERTICES, PLANE_VERTICES, CUBE_VERTICES];
            const indexLists = [CUBE_INDICES, PLANE_INDICES, CUBE_INDICES];
            const matIndexLists = [CUBE_MAT_INDEX, PLANE_MAT_INDEX, CUBE_MAT_INDEX];
            const materialLists = [
                [MAT_RED, MAT_GREEN, MAT_BLUE, MAT_YELLOW, MAT_CYAN, MAT_MAGENTA],        // 6 color faces
                [MAT_GREY],
                [MAT_MIRROR],
            ];

            const vertices: f32[] = [];
            const indices: int[] = [];
            const matIndices: int[] = [];
            const materials: f32[] = [];
            const objDesc: int[] = [];
            for (let o = 0; o < vertexLists.length; o++) {
                objDesc.push(vertices.length / VERTEX_FLOATS);
                objDesc.push(indices.length);
                objDesc.push(matIndices.length);
                objDesc.push(materials.length / MATERIAL_FLOATS);
                const vertexList = vertexLists[o];
                for (const coordinate of vertexList) {
                    vertices.push(coordinate);
                }
                const indexList = indexLists[o];
                for (const index of indexList) {
                    indices.push(index);
                }
                const materialList = materialLists[o];
                const maxIndex = materialList.length - 1;
                const matIndexList = matIndexLists[o];
                for (const matIndex of matIndexList) {
                    matIndices.push(Math.min(maxIndex, matIndex));
                }
                for (const material of materialList) {
                    for (let i = 0; i < MATERIAL_FLOATS; i++) {
                        materials.push(material[i]);
                    }
                }
            }

            const vertexCount = vertices.length / VERTEX_FLOATS;
            this.vertexBuffer = this.app.createAccelStructInputStructuredBuffer(4, vertices.length, "Vertices");
            this.indexBuffer = this.app.createAccelStructInputStructuredBuffer(4, indices.length, "Indices");
            this.matIndexBuffer = this.app.createStructuredBuffer(4, matIndices.length, "Material Indices");
            this.materialBuffer = this.app.createStructuredBuffer(4, materials.length, "Materials");
            this.objDescBuffer = this.app.createStructuredBuffer(16, objDesc.length / 4, "Scene Description");
            commandList.writeBuffer(this.vertexBuffer, Ref(vertices[0]), vertices.length * 4);
            commandList.writeBuffer(this.indexBuffer, Ref(indices[0]), indices.length * 4);
            commandList.writeBuffer(this.matIndexBuffer, Ref(matIndices[0]), matIndices.length * 4);
            commandList.writeBuffer(this.materialBuffer, Ref(materials[0]), materials.length * 4);
            commandList.writeBuffer(this.objDescBuffer, Ref(objDesc[0]), objDesc.length * 4);

            for (let o = 0; o < vertexLists.length; o++) {
                const firstVertex = objDesc[o * 4];
                const firstIndex = objDesc[o * 4 + 1];
                const blas = this.app.createEmptyTriangleBlas(`BLAS ${o}`);
                blas.addGeometry(this.indexBuffer, firstIndex * 4, indexLists[o].length, this.vertexBuffer,
                    firstVertex * VERTEX_FLOATS * 4, vertexLists[o].length / VERTEX_FLOATS, VERTEX_FLOATS * 4, null);
                if (blas.build(this.app, commandList, AccelStructBuildFlags.PreferFastTrace) == 0) {
                    return false;
                }
                this.blases.push(blas);
            }
            return vertexCount > 0;
        }

        // The sample's create_ray_tracing_pipeline and create_shader_binding_tables: ray generation,
        // the miss shaders (primary rays, then shadow rays) and one hit group.
        createRayTracingPipeline() {
            const shaderLibrary = this.app.createShaderLibrary("ray_tracing_reflection.hlsl");
            if (!shaderLibrary) {
                return false;
            }
            const pipelineDesc = RtPipelineDesc.create(PAYLOAD_SIZE, MAX_RECURSION_DEPTH);
            pipelineDesc.addGlobalBindingLayout(this.bindingLayout);
            pipelineDesc.addShader(shaderLibrary, "raygen", ShaderType.RayGeneration);
            pipelineDesc.addShader(shaderLibrary, "miss", ShaderType.Miss);
            pipelineDesc.addShader(shaderLibrary, "missShadow", ShaderType.Miss);
            pipelineDesc.addHitGroup(shaderLibrary, "HitGroup", "closesthit", "", null);
            const pipeline = this.app.createRayTracingPipelineFromDesc(pipelineDesc);
            if (!pipeline) {
                return false;
            }

            const shaderTable = this.app.createEmptyShaderTable(pipeline);
            // The shader table keeps the pipeline alive.
            this.app.releaseResource(pipeline);
            shaderTable.setRayGeneration("raygen");
            shaderTable.addMiss("miss");
            shaderTable.addMiss("missShadow");
            shaderTable.addHitGroup("HitGroup", null);
            this.shaderTable = shaderTable;
            return true;
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("ray_tracing_reflection");

        const args = new Args(argc, argv, TEST_FRAMES);
        args.parseArgs();

        const app = App.createWithOptions(args.api, WINDOW_TITLE, 1280, 720, AppOptions.RayTracing | args.options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        if (!app.isFeatureSupported(Feature.RayTracingPipeline)) {
            app.destroy();
            return unsupported(args.test, "The graphics device does not support Ray Tracing Pipelines");
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        const pass = new RayTracingReflectionPass(app);
        if (!pass.init()) {
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
    return RayTracingReflection.main(argc, argv);
}
