// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";

namespace GshaderToMshader {
    const WINDOW_TITLE = "Donut Example: Geometry Shader to Mesh Shader";

    // The sample's model (Vulkan-Samples' asset, copied at build time: see VULKAN_SAMPLES_ASSETS_DIR
    // in CMakeLists.txt): its first mesh's first primitive, the node's scale ignored.
    const MODEL_PATH = "media/gshader_to_mshader/teapot.gltf";

    // Donut_LoadGltfModel's vertices: float3 position, float3 normal, float2 texture coordinates.
    const GLTF_VERTEX_FLOATS = 8;
    // The model's vertex buffer: float3 position, float3 normal (the framework's Vertex, as the
    // sample's input layout reads it).
    const VERTEX_FLOATS = 6;
    // The mesh shader's vertices: float4 position, float4 normal (the framework's AlignedVertex).
    const ALIGNED_VERTEX_FLOATS = 8;

    // The framework's Meshlet: uint vertices[64], indices[126], vertex_count, index_count.
    const MESHLET_MAX_VERTICES = 64;
    const MESHLET_MAX_INDICES = 126;
    const MESHLET_VERTEX_COUNT = MESHLET_MAX_VERTICES + MESHLET_MAX_INDICES;
    const MESHLET_INDEX_COUNT = MESHLET_VERTEX_COUNT + 1;
    const MESHLET_UINTS = MESHLET_INDEX_COUNT + 1;
    // Where its prepare_meshlets ends a meshlet: 64 different vertices, or 96 indices (32 triangles,
    // so 64 line vertices out of the mesh shader).
    const MESHLET_SPLIT_VERTICES = 64;
    const MESHLET_SPLIT_INDICES = 96;

    // struct SceneConstants { float4x4 model, view, projection, normal; }, as f32 offsets.
    const CONST_MODEL = 0;
    const CONST_VIEW = 16;
    const CONST_PROJECTION = 32;
    const CONST_NORMAL = 48;
    const CONST_FLOATS = 64;

    // The sample's camera: a "look at" camera 10 units back, 60 degrees vertically, reversed depth
    // from 256 to 0.1 (glm::perspective with near and far swapped).
    const CAMERA_POSITION = [0.0, 0.0, -10.0];
    const CAMERA_FOV = 60.0;
    const Z_NEAR = 256.0;
    const Z_FAR = 0.1;
    // ApiVulkanSample's mouse controls: degrees per pixel dragged with the left button, zoom per
    // pixel with the right one, panning per pixel with the middle one.
    const ROTATION_SPEED = 1.0;
    const ZOOM_SPEED = 0.005;
    const PAN_SPEED = 0.01;

    // ApiVulkanSample's clear color.
    const CLEAR_COLOR = 0.002;

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

    function transpose(m: number[]): number[] {
        let result: number[] = [];
        for (let column = 0; column < 4; column++) {
            for (let row = 0; row < 4; row++) {
                result.push(m[row * 4 + column]);
            }
        }
        return result;
    }

    // glm::inverse, by Gauss-Jordan elimination with partial pivoting.
    function inverse(m: number[]): number[] {
        // Rows of [m | identity].
        let rows: number[][] = [];
        for (let row = 0; row < 4; row++) {
            let r: number[] = [];
            for (let column = 0; column < 4; column++) {
                r.push(m[column * 4 + row]);
            }
            for (let column = 0; column < 4; column++) {
                r.push(column == row ? 1.0 : 0.0);
            }
            rows.push(r);
        }
        for (let column = 0; column < 4; column++) {
            let pivot = column;
            for (let row = column + 1; row < 4; row++) {
                if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) {
                    pivot = row;
                }
            }
            const swap = rows[column];
            rows[column] = rows[pivot];
            rows[pivot] = swap;
            const scale = 1.0 / rows[column][column];
            for (let k = 0; k < 8; k++) {
                rows[column][k] *= scale;
            }
            for (let row = 0; row < 4; row++) {
                if (row != column) {
                    const factor = rows[row][column];
                    for (let k = 0; k < 8; k++) {
                        rows[row][k] -= factor * rows[column][k];
                    }
                }
            }
        }
        let result: number[] = [];
        for (let column = 0; column < 4; column++) {
            for (let row = 0; row < 4; row++) {
                result.push(rows[row][4 + column]);
            }
        }
        return result;
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

    // --- Meshlets -----------------------------------------------------------------------------

    // The Vulkan-Samples framework's prepare_meshlets: the index buffer cut into meshlets of whole
    // triangles, each ending at 64 different vertices or 96 indices (a triangle cut short there
    // starts the next meshlet). A meshlet's vertices are the different ones it indexes, in
    // increasing order, the triangle cut short's included. One meshlet record is reused all along:
    // what lies past its counts is the previous meshlets'. Returns the meshlets' uints.
    function prepareMeshlets(indices: int[], indexCount: int, vertexCount: int): int[] {
        let meshlet: int[] = [];
        for (let i = 0; i < MESHLET_UINTS; i++) {
            meshlet.push(0);
        }
        let meshletVertexCount = 0;
        let meshletIndexCount = 0;

        // The meshlet's different vertices (std::set): marked with the meshlet's number.
        let vertexMeshlet: int[] = [];
        for (let v = 0; v < vertexCount; v++) {
            vertexMeshlet.push(-1);
        }
        let vertices: int[] = [];
        // Each meshlet needs to contain full primitives.
        let triangleCheck = 0;

        let meshlets: int[] = [];
        let meshletNumber = 0;
        for (let i = 0; i < indexCount; i++) {
            const index = indices[i];
            meshlet[MESHLET_MAX_VERTICES + meshletIndexCount] = index;
            if (vertexMeshlet[index] != meshletNumber) {
                vertexMeshlet[index] = meshletNumber;
                vertices.push(index);
                meshletVertexCount++;
            }
            meshletIndexCount++;
            triangleCheck = triangleCheck < 3 ? triangleCheck + 1 : 1;

            if (meshletVertexCount == MESHLET_SPLIT_VERTICES || meshletIndexCount == MESHLET_SPLIT_INDICES || i == indexCount - 1) {
                // The set's order.
                for (let a = 1; a < vertices.length; a++) {
                    const value = vertices[a];
                    let b = a;
                    while (b > 0 && vertices[b - 1] > value) {
                        vertices[b] = vertices[b - 1];
                        b--;
                    }
                    vertices[b] = value;
                }
                for (let v = 0; v < vertices.length; v++) {
                    meshlet[v] = vertices[v];
                }
                if (triangleCheck != 3) {
                    meshletIndexCount -= triangleCheck;
                    i -= triangleCheck;
                    triangleCheck = 0;
                }

                meshlet[MESHLET_VERTEX_COUNT] = meshletVertexCount;
                meshlet[MESHLET_INDEX_COUNT] = meshletIndexCount;
                for (let k = 0; k < MESHLET_UINTS; k++) {
                    meshlets.push(meshlet[k]);
                }
                meshletVertexCount = 0;
                meshletIndexCount = 0;
                vertices = [];
                meshletNumber++;
            }
        }
        return meshlets;
    }

    // --- Passes -------------------------------------------------------------------------------

    // Port of Vulkan-Samples' gshader_to_mshader: a lit teapot, and its normals as lines, one per
    // triangle, drawn either by a geometry shader (a line strip out of each triangle the model's
    // draw feeds it) or by a mesh shader (a group per meshlet of the index buffer, reading the
    // vertices and the meshlets from structured buffers).
    class GshaderToMshaderPass {
        private app: App;

        // The sample's settings: which shader draws the normals (one at most).
        showNormalsGeo: boolean;
        showNormalsMesh: boolean;
        // The device has mesh shaders (not D3D11, nor GPUs without them).
        meshShadersSupported: boolean;

        // The sample's camera: rotation (degrees about x, y, z) and position.
        private cameraRotation: number[];
        private cameraPosition: number[];
        // The mouse: buttons held, last position.
        private leftButton: boolean;
        private rightButton: boolean;
        private middleButton: boolean;
        private mouseX: number;
        private mouseY: number;

        private modelVS: Opaque;
        private modelPS: Opaque;
        private baseVS: Opaque;
        private normalsGS: Opaque;
        private basePS: Opaque;
        private normalsMS: Opaque;
        private meshPS: Opaque;
        private inputLayout: Opaque;
        private bindingLayout: Opaque;
        private meshBindingLayout: Opaque;
        private constantBuffer: Opaque;
        private bindingSet: BindingSet;
        private meshBindingSet: BindingSet;
        private vertexBuffer: Opaque;
        private indexBuffer: Opaque;
        private indexCount: int;
        private meshletCount: int;

        // The back buffer's size; created on the first frame and after a resize.
        private colorBuffer: Opaque | null;
        private depthBuffer: Opaque | null;
        private framebuffer: Opaque | null;
        private modelPipeline: Opaque | null;
        private geometryPipeline: Opaque | null;
        private meshPipeline: Opaque | null;

        // The UBO contents.
        private constants: f32[];

        constructor(app: App) {
            this.app = app;
            this.showNormalsGeo = false;
            this.showNormalsMesh = false;
            this.meshShadersSupported = false;
            this.cameraRotation = [0.0, 0.0, 0.0];
            this.cameraPosition = [CAMERA_POSITION[0], CAMERA_POSITION[1], CAMERA_POSITION[2]];
            this.leftButton = false;
            this.rightButton = false;
            this.middleButton = false;
            this.mouseX = 0.0;
            this.mouseY = 0.0;
            this.indexCount = 0;
            this.meshletCount = 0;
            this.colorBuffer = null;
            this.depthBuffer = null;
            this.framebuffer = null;
            this.modelPipeline = null;
            this.geometryPipeline = null;
            this.meshPipeline = null;

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
            this.app.setInformativeWindowTitle(WINDOW_TITLE);
        }

        releaseTargets(): void {
            const resources = [this.modelPipeline, this.geometryPipeline, this.meshPipeline,
                this.framebuffer, this.colorBuffer, this.depthBuffer];
            for (let i = 0; i < resources.length; i++) {
                const resource = resources[i];
                if (resource) {
                    this.app.releaseResource(resource);
                }
            }
            this.modelPipeline = null;
            this.geometryPipeline = null;
            this.meshPipeline = null;
            this.framebuffer = null;
            this.colorBuffer = null;
            this.depthBuffer = null;
        }

        onBackBufferResizing(): void {
            this.releaseTargets();
            // The blit's cached binding sets still reference the old color buffer.
            this.app.clearBindingCache();
        }

        // The sample's render pass targets (an sRGB color buffer, as its swapchain, and a depth
        // buffer) and its three pipelines, which share their state: reversed depth (greater passes),
        // no culling.
        createTargets(width: int, height: int): void {
            const colorBuffer = this.app.createRenderTargetTexture(width, height, Format.SRGBA8_UNORM, "ColorBuffer");
            const depthBuffer = this.app.createRenderTargetTexture(width, height, Format.D32, "DepthBuffer");
            const framebuffer = this.app.createFramebuffer(colorBuffer, depthBuffer);
            this.colorBuffer = colorBuffer;
            this.depthBuffer = depthBuffer;
            this.framebuffer = framebuffer;

            // The lit model.
            const modelDesc = GraphicsPipelineDesc.create(this.modelVS, this.modelPS);
            modelDesc.setInputLayout(this.inputLayout);
            modelDesc.addBindingLayout(this.bindingLayout);
            modelDesc.setDepthState(1, 1, ComparisonFunc.Greater);
            modelDesc.setRasterState(CullMode.None, FillMode.Solid, 0);
            this.modelPipeline = this.app.createGraphicsPipelineFromDesc(modelDesc, framebuffer);

            // The normals, by the geometry shader: the model's triangles in, lines out.
            const geometryDesc = GraphicsPipelineDesc.create(this.baseVS, this.basePS);
            geometryDesc.setGeometryShader(this.normalsGS);
            geometryDesc.setInputLayout(this.inputLayout);
            geometryDesc.addBindingLayout(this.bindingLayout);
            geometryDesc.setDepthState(1, 1, ComparisonFunc.Greater);
            geometryDesc.setRasterState(CullMode.None, FillMode.Solid, 0);
            this.geometryPipeline = this.app.createGraphicsPipelineFromDesc(geometryDesc, framebuffer);

            // The normals, by the mesh shader (no task shader: a group per meshlet), lines out.
            if (this.meshShadersSupported) {
                const meshDesc = GraphicsPipelineDesc.createMeshlet(null, this.normalsMS, this.meshPS);
                meshDesc.addBindingLayout(this.meshBindingLayout);
                meshDesc.setPrimitiveType(PrimitiveType.LineList);
                meshDesc.setDepthState(1, 1, ComparisonFunc.Greater);
                meshDesc.setRasterState(CullMode.None, FillMode.Solid, 0);
                this.meshPipeline = this.app.createMeshletPipelineFromDesc(meshDesc, framebuffer);
            }
        }

        // The sample's update_uniform_buffers: its camera's matrices, the model turned half a turn
        // about z, and the normal matrix.
        updateConstants(width: int, height: int): void {
            const c = this.constants;
            const projection = samplePerspective(radians(CAMERA_FOV), width / height, Z_NEAR, Z_FAR);
            // A "look at" camera: translation * rotation (about x, then y, then z).
            const r = this.cameraRotation;
            let rotationMatrix = multiply(rotation(radians(r[0]), 1.0, 0.0, 0.0), rotation(radians(r[1]), 0.0, 1.0, 0.0));
            rotationMatrix = multiply(rotationMatrix, rotation(radians(r[2]), 0.0, 0.0, 1.0));
            const p = this.cameraPosition;
            const view = multiply(translation(p[0], p[1], p[2]), rotationMatrix);
            const model = rotation(Math.PI, 0.0, 0.0, 1.0);
            const normal = transpose(inverse(multiply(view, model)));
            for (let i = 0; i < 16; i++) {
                c[CONST_MODEL + i] = model[i];
                c[CONST_VIEW + i] = view[i];
                c[CONST_PROJECTION + i] = projection[i];
                c[CONST_NORMAL + i] = normal[i];
            }
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
            const depthBuffer = this.depthBuffer;
            const modelPipeline = this.modelPipeline;
            const geometryPipeline = this.geometryPipeline;
            if (!framebuffer || !colorBuffer || !depthBuffer || !modelPipeline || !geometryPipeline) {
                return;
            }

            this.updateConstants(width, height);
            commandList.writeBuffer(this.constantBuffer, Ref(this.constants[0]), CONST_FLOATS * 4);

            // Reversed depth: the far plane is 0.
            commandList.clearTextureFloat(colorBuffer, CLEAR_COLOR, CLEAR_COLOR, CLEAR_COLOR, 1.0);
            commandList.clearDepth(depthBuffer, 0.0);

            frame.beginDrawToFramebuffer(modelPipeline, framebuffer);
            frame.drawAddBindingSet(this.bindingSet);
            frame.drawAddVertexBuffer(this.vertexBuffer, 0, 0);
            frame.drawSetIndexBuffer(this.indexBuffer);
            frame.drawIndexed(this.indexCount);

            if (this.showNormalsGeo) {
                commandList.beginMarker("Normals (geometry shader)");
                frame.beginDrawToFramebuffer(geometryPipeline, framebuffer);
                frame.drawAddBindingSet(this.bindingSet);
                frame.drawAddVertexBuffer(this.vertexBuffer, 0, 0);
                frame.drawSetIndexBuffer(this.indexBuffer);
                frame.drawIndexed(this.indexCount);
                commandList.endMarker();
            }

            if (this.showNormalsMesh) {
                const meshPipeline = this.meshPipeline;
                if (meshPipeline) {
                    commandList.beginMarker("Normals (mesh shader)");
                    frame.beginMeshDrawToFramebuffer(meshPipeline, framebuffer);
                    frame.drawAddBindingSet(this.meshBindingSet);
                    frame.drawMeshTasks(this.meshletCount);
                    commandList.endMarker();
                }
            }

            this.app.blitTexture(frame, colorBuffer);
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(): boolean {
            this.meshShadersSupported = this.app.isFeatureSupported(Feature.Meshlets) != 0;
            if (!this.meshShadersSupported) {
                console.log("The device has no mesh shaders: the normals are drawn by the geometry shader only");
            }

            const shader = "gshader_to_mshader.hlsl";
            this.modelVS = this.app.createShader(shader, "model_vs", ShaderType.Vertex);
            this.modelPS = this.app.createShader(shader, "model_ps", ShaderType.Pixel);
            this.baseVS = this.app.createShader(shader, "base_vs", ShaderType.Vertex);
            this.normalsGS = this.app.createShader(shader, "normals_gs", ShaderType.Geometry);
            this.basePS = this.app.createShader(shader, "base_ps", ShaderType.Pixel);
            if (!this.modelVS || !this.modelPS || !this.baseVS || !this.normalsGS || !this.basePS) {
                return false;
            }
            if (this.meshShadersSupported) {
                const meshShader = "gshader_to_mshader_mesh.hlsl";
                this.normalsMS = this.app.createShader(meshShader, "normals_ms", ShaderType.Mesh);
                this.meshPS = this.app.createShader(meshShader, "mesh_ps", ShaderType.Pixel);
                if (!this.normalsMS || !this.meshPS) {
                    return false;
                }
            }

            // The model's vertex input: positions and normals.
            const layoutDesc = InputLayoutDesc.create();
            layoutDesc.addVertexAttribute("POSITION", Format.RGB32_FLOAT, 0, 0, VERTEX_FLOATS * 4);
            layoutDesc.addVertexAttribute("NORMAL", Format.RGB32_FLOAT, 12, 0, VERTEX_FLOATS * 4);
            this.inputLayout = this.app.createInputLayout(layoutDesc, this.modelVS);

            this.constantBuffer = this.app.createVolatileConstantBuffer(CONST_FLOATS * 4, "SceneConstants");

            // The sample's descriptor set, split by pipeline: the uniforms for the model's and the
            // geometry shader's; the uniforms, meshlets and vertices for the mesh shader's.
            const layoutDescModel = BindingLayoutDesc.create();
            layoutDescModel.layoutVolatileConstantBuffer(0);
            this.bindingLayout = this.app.createBindingLayout(layoutDescModel, ShaderType.All);

            const model = this.app.loadGltfModel(MODEL_PATH);
            if (model.isNull()) {
                console.log("Cannot load the model: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return false;
            }
            const vertexCount = model.getVertexCount(0);
            this.indexCount = model.getIndexCount(0);
            let gltfVertices: f32[] = [];
            for (let i = 0; i < vertexCount * GLTF_VERTEX_FLOATS; i++) {
                gltfVertices.push(0.0);
            }
            let indices: int[] = [];
            for (let i = 0; i < this.indexCount; i++) {
                indices.push(0);
            }
            model.copyVertices(0, Ref(gltfVertices[0]));
            model.copyIndices(0, Ref(indices[0]));

            // The framework's glTF loader's vertices: normals normalized.
            let vertices: f32[] = [];
            let alignedVertices: f32[] = [];
            for (let v = 0; v < vertexCount; v++) {
                const g = v * GLTF_VERTEX_FLOATS;
                const nx = gltfVertices[g + 3];
                const ny = gltfVertices[g + 4];
                const nz = gltfVertices[g + 5];
                const inverseLength = 1.0 / Math.sqrt(nx * nx + ny * ny + nz * nz);
                vertices.push(gltfVertices[g + 0]);
                vertices.push(gltfVertices[g + 1]);
                vertices.push(gltfVertices[g + 2]);
                vertices.push(nx * inverseLength);
                vertices.push(ny * inverseLength);
                vertices.push(nz * inverseLength);
                alignedVertices.push(gltfVertices[g + 0]);
                alignedVertices.push(gltfVertices[g + 1]);
                alignedVertices.push(gltfVertices[g + 2]);
                alignedVertices.push(1.0);
                alignedVertices.push(nx * inverseLength);
                alignedVertices.push(ny * inverseLength);
                alignedVertices.push(nz * inverseLength);
                alignedVertices.push(0.0);
            }

            // The blit's common passes, created on first use, upload their textures on a command
            // list of their own: create them before ours (or the frame's) is open.
            this.app.getCommonSampler(CommonSampler.PointClamp);

            const commandList = this.app.createCommandList();
            commandList.open();
            this.vertexBuffer = this.app.createStaticVertexBuffer(commandList, Ref(vertices[0]),
                vertexCount * VERTEX_FLOATS * 4, "VertexBuffer");
            this.indexBuffer = this.app.createStaticIndexBuffer(commandList, Ref(indices[0]),
                this.indexCount * 4, "IndexBuffer");
            if (this.meshShadersSupported) {
                const meshlets = prepareMeshlets(indices, this.indexCount, vertexCount);
                this.meshletCount = meshlets.length / MESHLET_UINTS;
                const meshletBuffer = this.app.createStructuredBuffer(MESHLET_UINTS * 4, this.meshletCount, "MeshletBuffer");
                const alignedVertexBuffer = this.app.createStructuredBuffer(ALIGNED_VERTEX_FLOATS * 4, vertexCount, "AlignedVertexBuffer");
                commandList.writeBuffer(meshletBuffer, Ref(meshlets[0]), meshlets.length * 4);
                commandList.writeBuffer(alignedVertexBuffer, Ref(alignedVertices[0]), alignedVertices.length * 4);

                const meshLayoutDesc = BindingLayoutDesc.create();
                meshLayoutDesc.layoutVolatileConstantBuffer(0);
                meshLayoutDesc.layoutStructuredBufferSRV(0);
                meshLayoutDesc.layoutStructuredBufferSRV(1);
                this.meshBindingLayout = this.app.createBindingLayout(meshLayoutDesc, ShaderType.Mesh);

                const meshSetDesc = BindingSetDesc.create();
                meshSetDesc.bindEntireConstantBuffer(0, this.constantBuffer);
                meshSetDesc.bindStructuredBufferSRV(0, meshletBuffer);
                meshSetDesc.bindStructuredBufferSRV(1, alignedVertexBuffer);
                this.meshBindingSet = this.app.createBindingSetForLayout(meshSetDesc, this.meshBindingLayout);
            }
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.waitForIdle();
            this.app.releaseResource(commandList.handle);

            const setDesc = BindingSetDesc.create();
            setDesc.bindEntireConstantBuffer(0, this.constantBuffer);
            this.bindingSet = this.app.createBindingSetForLayout(setDesc, this.bindingLayout);

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
        private sample: GshaderToMshaderPass;

        constructor(sample: GshaderToMshaderPass) {
            this.sample = sample;
        }

        buildUI(): void {
            const sample = this.sample;
            Donut_ImGuiSetNextWindowPos(10.0, 10.0);
            // The sample's title (ApiVulkanSample's default).
            Donut_ImGuiBegin("Vulkan Example", 1);
            if (Donut_ImGuiCollapsingHeaderDefaultOpen("Settings") != 0) {
                // One at a time: checking one unchecks the other.
                const showNormalsGeo = Donut_ImGuiCheckbox("Display normals - gshader", sample.showNormalsGeo ? 1 : 0) != 0;
                if (showNormalsGeo != sample.showNormalsGeo) {
                    sample.showNormalsGeo = showNormalsGeo;
                    sample.showNormalsMesh = false;
                }
                if (sample.meshShadersSupported) {
                    const showNormalsMesh = Donut_ImGuiCheckbox("Display normals - mshader", sample.showNormalsMesh ? 1 : 0) != 0;
                    if (showNormalsMesh != sample.showNormalsMesh) {
                        sample.showNormalsMesh = showNormalsMesh;
                        sample.showNormalsGeo = false;
                    }
                }
            }
            Donut_ImGuiEnd();
        }

        // Declared after buildUI: tslang resolves `this.buildUI` only for members declared earlier.
        init(app: App): boolean {
            return !app.addImGuiPass(this.buildUI).isNull();
        }
    }

    export function main(argc: int, argv: Ref<string>): int {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("gshader_to_mshader");

        // -debug: the graphics API's debug layer and NVRHI's validation layer.
        // -noui: without the settings window.
        // -gshader / -mshader: start with the normals drawn by the geometry / mesh shader.
        let options = AppOptions.None;
        let withUI = true;
        let showNormalsGeo = false;
        let showNormalsMesh = false;
        for (let i = 1; i < argc; i++) {
            const arg = Donut_GetArg(argv, i);
            if (arg == "-debug") {
                options = AppOptions.DebugRuntime;
            } else if (arg == "-noui") {
                withUI = false;
            } else if (arg == "-gshader") {
                showNormalsGeo = true;
                showNormalsMesh = false;
            } else if (arg == "-mshader") {
                showNormalsMesh = true;
                showNormalsGeo = false;
            }
        }

        const api = Donut_GetGraphicsAPIFromCommandLine(argc, argv);
        const app = App.createWithOptions(api, WINDOW_TITLE, 1280, 720, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        const sample = new GshaderToMshaderPass(app);
        if (!sample.init()) {
            app.destroy();
            return 1;
        }
        sample.showNormalsGeo = showNormalsGeo;
        sample.showNormalsMesh = showNormalsMesh && sample.meshShadersSupported;

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
    return GshaderToMshader.main(argc, argv);
}
