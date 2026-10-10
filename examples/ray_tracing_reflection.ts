// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";

namespace RayTracingReflection {
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

    // glm::perspective (right-handed, depth from 0 to 1).
    function perspective(fov: number, aspect: number, zNear: number, zFar: number): number[] {
        const tanHalfFovy = Math.tan(0.5 * fov);
        return [
            1.0 / (aspect * tanHalfFovy), 0.0,               0.0,                              0.0,
            0.0,                          1.0 / tanHalfFovy, 0.0,                              0.0,
            0.0,                          0.0,               zFar / (zNear - zFar),            -1.0,
            0.0,                          0.0,               -(zFar * zNear) / (zFar - zNear), 0.0,
        ];
    }

    // glm::scale(glm::translate(mat4(1), t), s): columns scaled, translation t.
    function scaled(tx: number, ty: number, tz: number, sx: number, sy: number, sz: number): number[] {
        return [sx, 0.0, 0.0, 0.0, 0.0, sy, 0.0, 0.0, 0.0, 0.0, sz, 0.0, tx, ty, tz, 1.0];
    }

    // The inverse of m, by Gauss-Jordan elimination with partial pivoting.
    function inverse(m: number[]): number[] {
        // Rows of [m | I].
        let a: number[] = [];
        for (let row = 0; row < 4; row++) {
            for (let column = 0; column < 4; column++) {
                a.push(m[column * 4 + row]);
            }
            for (let column = 0; column < 4; column++) {
                a.push(row == column ? 1.0 : 0.0);
            }
        }
        for (let column = 0; column < 4; column++) {
            let pivot = column;
            for (let row = column + 1; row < 4; row++) {
                if (Math.abs(a[row * 8 + column]) > Math.abs(a[pivot * 8 + column])) {
                    pivot = row;
                }
            }
            for (let k = 0; k < 8; k++) {
                const t = a[column * 8 + k];
                a[column * 8 + k] = a[pivot * 8 + k];
                a[pivot * 8 + k] = t;
            }
            const p = a[column * 8 + column];
            for (let k = 0; k < 8; k++) {
                a[column * 8 + k] /= p;
            }
            for (let row = 0; row < 4; row++) {
                if (row != column) {
                    const f = a[row * 8 + column];
                    for (let k = 0; k < 8; k++) {
                        a[row * 8 + k] -= f * a[column * 8 + k];
                    }
                }
            }
        }
        let result: number[] = [];
        for (let column = 0; column < 4; column++) {
            for (let row = 0; row < 4; row++) {
                result.push(a[row * 8 + 4 + column]);
            }
        }
        return result;
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
            this.rotation = [0.0, 0.0, 0.0];
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

    // Port of Vulkan-Samples' ray_tracing_reflection: two cubes with a color per face over a
    // slightly reflective floor, between two mirrors facing each other, ray traced with a ray
    // tracing pipeline. Each ray bounces off reflective surfaces until little of it is left (up to
    // 64 times); each hit is lit by a fixed light, with a shadow ray (a second miss shader). The
    // scene: three models (the colored cube, the plane, the mirror cube), five instances.
    class RayTracingReflectionPass {
        private app: App;
        private camera: SampleCamera;

        private bindingLayout: Opaque;
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
        private storageImage: Opaque | null;
        private bindingSet: BindingSet;

        // Upload buffers.
        private ubo: f32[];
        private transform: f32[];

        constructor(app: App) {
            this.app = app;
            this.camera = new SampleCamera();
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

        // The storage image has the back buffers' size.
        onBackBufferResizing(): void {
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
        addInstance(blasId: int, m: number[]): void {
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
        buildTopLevelAS(frame: Frame): void {
            this.addInstance(0, scaled(-1.0, 0.0, 0.0, 1.0, 1.0, 1.0));
            this.addInstance(0, scaled(1.0, 0.0, 0.0, 1.0, 1.0, 1.0));
            this.addInstance(1, scaled(0.0, -1.0, 0.0, 15.0, 15.0, 15.0));
            this.addInstance(2, scaled(0.0, 0.0, -7.0, 5.0, 5.0, 0.1));
            this.addInstance(2, scaled(0.0, 0.0, 7.0, 5.0, 5.0, 0.1));
            frame.buildTopLevelAS(this.topLevelAS);
        }

        // The sample's update_uniform_buffers: the inverses of its view and of its projection
        // with the Vulkan y flip (the ray generation shader's launch rows run down, as Vulkan's).
        updateUniformBuffers(width: int, height: int): void {
            let projection = perspective(radians(CAMERA_FOV), width / height, Z_NEAR, Z_FAR);
            projection[5] = -projection[5];
            const projInverse = inverse(projection);
            const viewInverse = inverse(this.camera.view());
            for (let i = 0; i < 16; i++) {
                this.ubo[UBO_VIEW_INVERSE + i] = viewInverse[i];
                this.ubo[UBO_PROJ_INVERSE + i] = projInverse[i];
            }
        }

        onRender(frameHandle: FrameHandle): void {
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
        createModels(commandList: CommandList): boolean {
            const vertexLists = [CUBE_VERTICES, PLANE_VERTICES, CUBE_VERTICES];
            const indexLists = [CUBE_INDICES, PLANE_INDICES, CUBE_INDICES];
            const matIndexLists = [CUBE_MAT_INDEX, PLANE_MAT_INDEX, CUBE_MAT_INDEX];
            const materialLists = [
                [MAT_RED, MAT_GREEN, MAT_BLUE, MAT_YELLOW, MAT_CYAN, MAT_MAGENTA],        // 6 color faces
                [MAT_GREY],
                [MAT_MIRROR],
            ];

            let vertices: f32[] = [];
            let indices: int[] = [];
            let matIndices: int[] = [];
            let materials: f32[] = [];
            let objDesc: int[] = [];
            for (let o = 0; o < vertexLists.length; o++) {
                objDesc.push(vertices.length / VERTEX_FLOATS);
                objDesc.push(indices.length);
                objDesc.push(matIndices.length);
                objDesc.push(materials.length / MATERIAL_FLOATS);
                const vertexList = vertexLists[o];
                for (let i = 0; i < vertexList.length; i++) {
                    vertices.push(vertexList[i]);
                }
                const indexList = indexLists[o];
                for (let i = 0; i < indexList.length; i++) {
                    indices.push(indexList[i]);
                }
                const materialList = materialLists[o];
                const maxIndex = materialList.length - 1;
                const matIndexList = matIndexLists[o];
                for (let i = 0; i < matIndexList.length; i++) {
                    matIndices.push(Math.min(maxIndex, matIndexList[i]));
                }
                for (let m = 0; m < materialList.length; m++) {
                    for (let i = 0; i < MATERIAL_FLOATS; i++) {
                        materials.push(materialList[m][i]);
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
        createRayTracingPipeline(): boolean {
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

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(): boolean {
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
    }

    export function main(argc: int, argv: Ref<string>): int {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("ray_tracing_reflection");

        // -debug: the graphics API's debug layer and NVRHI's validation layer.
        let options = AppOptions.RayTracing;
        for (let i = 1; i < argc; i++) {
            const arg = Donut_GetArg(argv, i);
            if (arg == "-debug") {
                options = options | AppOptions.DebugRuntime;
            }
        }

        const api = Donut_GetGraphicsAPIFromCommandLine(argc, argv);
        const app = App.createWithOptions(api, WINDOW_TITLE, 1280, 720, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        if (!app.isFeatureSupported(Feature.RayTracingPipeline)) {
            console.log("The graphics device does not support Ray Tracing Pipelines");
            app.destroy();
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        const pass = new RayTracingReflectionPass(app);
        if (!pass.init()) {
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
    return RayTracingReflection.main(argc, argv);
}
