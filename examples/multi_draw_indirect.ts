// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";

namespace MultiDrawIndirect {
    const WINDOW_TITLE = "Donut Example: Multi-Draw Indirect";

    // The sample's scene (Vulkan-Samples' assets): a glTF file whose meshes each have a texture
    // named after them, the KTX textures converted to DDS at build time (see
    // VULKAN_SAMPLES_ASSETS_DIR in CMakeLists.txt).
    const SCENE_DIR = "media/multi_draw_indirect/vokselia/";
    const SCENE_PATH = SCENE_DIR + "vokselia.gltf";
    // The shaders' texture array (TEXTURE_COUNT in multi_draw_indirect.hlsl): one per mesh.
    const TEXTURE_COUNT = 225;

    // Donut_LoadGltfModel's vertices: float3 position, float3 normal, float2 texture coordinates.
    const VERTEX_FLOATS = 8;
    const VERTEX_SIZE = VERTEX_FLOATS * 4;
    // struct GpuModelInformation { vec3 bounding_sphere_center; float bounding_sphere_radius;
    // uint texture_index, firstIndex, indexCount, _pad; }
    const MODEL_INFORMATION_FLOATS = 8;
    const MODEL_INFORMATION_SIZE = MODEL_INFORMATION_FLOATS * 4;
    // struct VkDrawIndexedIndirectCommand { uint indexCount, instanceCount, firstIndex;
    // int vertexOffset; uint firstInstance; }
    const COMMAND_INTS = 5;
    const COMMAND_SIZE = COMMAND_INTS * 4;
    const COMMAND_INSTANCE_COUNT = 1;

    // struct SceneUniform { mat4 view, proj, proj_view; uint model_count; }, as f32 offsets.
    const CONST_VIEW = 0;
    const CONST_PROJ = 16;
    const CONST_PROJ_VIEW = 32;
    const CONST_MODEL_COUNT = 48;
    // Padded to 16 bytes.
    const CONST_FLOATS = 52;

    // The sample's camera: depth from 0.001 to 512.
    const Z_NEAR = 0.001;
    const Z_FAR = 512.0;

    // The sample's clear color (linear, into an sRGB target).
    const CLEAR_COLOR = 0.002;

    // The sample's RenderMode: who culls the models.
    const RENDER_CPU = 0;
    const RENDER_GPU = 1;
    const RENDER_GPU_DEVICE_ADDRESS = 2;
    const RENDER_MODE_NAMES = "CPU|GPU|GPU Device Address";

    // The GPU's commands are read back this many frames after the culling wrote them, when the GPU
    // is done with them (Donut has up to 2 frames in flight).
    const READBACK_BUFFERS = 3;

    // --- Math ---------------------------------------------------------------------------------

    function radians(degrees: number): number {
        return degrees * Math.PI / 180.0;
    }

    // The sample's glm::perspective(fov, aspect, near, far) (right-handed, depth from 0 to 1), as glm
    // lays it out (columns), with clip y negated: the sample's clip space has y down on the screen
    // (Vulkan's), Donut's y up.
    function samplePerspective(verticalFOV: number, aspect: number, zNear: number, zFar: number): number[] {
        const tanHalfFovy = Math.tan(0.5 * verticalFOV);
        return [
            1.0 / (aspect * tanHalfFovy), 0.0,                0.0,                              0.0,
            0.0,                          -1.0 / tanHalfFovy, 0.0,                              0.0,
            0.0,                          0.0,                zFar / (zNear - zFar),            -1.0,
            0.0,                          0.0,                -(zFar * zNear) / (zFar - zNear), 0.0,
        ];
    }

    // The sample's VisibilityTester (see https://www.gamedevs.org/uploads/fast-extraction-viewing-frustum-planes-from-world-view-projection-matrix.pdf):
    // a bounding sphere against the frustum planes of a projection-view matrix (glm's layout),
    // the left, right, near and far ones.
    class VisibilityTester {
        planes: number[];

        constructor(mat: f32[], offset: int) {
            // out[2 * i + j][k] = mat[k][3] + sign * mat[k][i]
            this.planes = [];
            for (let i = 0; i < 3; i++) {
                for (let j = 0; j < 2; j++) {
                    const sign = j > 0 ? 1.0 : -1.0;
                    for (let k = 0; k < 4; k++) {
                        this.planes.push(mat[offset + k * 4 + 3] + sign * mat[offset + k * 4 + i]);
                    }
                }
            }

            // normalize plane; see Appendix A.2
            for (let p = 0; p < 6; p++) {
                const x = this.planes[p * 4];
                const y = this.planes[p * 4 + 1];
                const z = this.planes[p * 4 + 2];
                const length = Math.sqrt(x * x + y * y + z * z);
                for (let k = 0; k < 4; k++) {
                    this.planes[p * 4 + k] /= length;
                }
            }
        }

        isVisible(x: number, y: number, z: number, radius: number): boolean {
            const tested = [0, 1, 4, 5];
            for (let t = 0; t < tested.length; t++) {
                const p = tested[t] * 4;
                const plane = this.planes;
                if (x * plane[p] + y * plane[p + 1] + z * plane[p + 2] + plane[p + 3] + radius < 0.0) {
                    return false;
                }
            }
            return true;
        }
    }

    // --- Passes -------------------------------------------------------------------------------

    // Port of Vulkan-Samples' multi_draw_indirect: a scene of 225 meshes, each with its own texture,
    // in one vertex and one index buffer, drawn by one indirect draw call of a draw per mesh (or a
    // call per mesh). Each draw's instance count makes it visible or not: frustum culling of the
    // meshes' bounding spheres sets it, on the CPU, or on the GPU in a compute shader writing the
    // draws' buffer through its binding or (Vulkan) its device address. Each draw's first instance
    // reads its mesh's texture index from a per-instance vertex buffer.
    class MultiDrawIndirectPass {
        private app: App;
        private camera: Camera;

        // The sample's settings.
        enableMdi: boolean;
        freezeCull: boolean;
        renderMode: int;
        // IndirectDrawSupport bits.
        support: int;
        // Visible models, as last counted, and all of them.
        instanceCount: int;
        modelCount: int;

        private drawVS: Opaque;
        private drawPS: Opaque;
        private inputLayout: Opaque;
        private drawBindingLayout: Opaque;
        private drawBindingSet: BindingSet;
        private cullPipeline: Opaque;
        private cullBindingSet: BindingSet;
        // Null without buffer device addresses (then the binding set is unset too).
        private addressPipeline: Opaque | null;
        private addressBindingSet: BindingSet;

        private constantBuffer: Opaque;
        private vertexBuffer: Opaque;
        private indexBuffer: Opaque;
        private modelInformationBuffer: Opaque;
        private indirectCallBuffer: Opaque;
        private readbackBuffers: Opaque[];
        // Whether each readback buffer holds commands yet.
        private readbackValid: boolean[];
        private frameIndex: int;

        // Created on the first frame (the size of the back buffer), dropped on resize.
        private colorBuffer: Opaque | null;
        private depthBuffer: Opaque | null;
        private framebuffer: Opaque | null;
        private drawPipeline: Opaque | null;

        // The models' bounding spheres (x, y, z, radius each), and their draws' commands.
        private spheres: number[];
        private commands: int[];
        // The UBO contents.
        private constants: f32[];
        // Donut's view matrix, 16 floats.
        private viewMatrix: f32[];

        constructor(app: App) {
            this.app = app;
            this.enableMdi = true;
            this.freezeCull = false;
            this.renderMode = RENDER_GPU;
            this.support = 0;
            this.instanceCount = 0;
            this.modelCount = 0;
            this.addressPipeline = null;
            this.readbackBuffers = [];
            this.readbackValid = [];
            this.frameIndex = 0;
            this.colorBuffer = null;
            this.depthBuffer = null;
            this.framebuffer = null;
            this.drawPipeline = null;
            this.spheres = [];
            this.commands = [];

            this.constants = [];
            for (let i = 0; i < CONST_FLOATS; i++) {
                this.constants.push(0.0);
            }
            this.viewMatrix = [];
            for (let i = 0; i < 16; i++) {
                this.viewMatrix.push(0.0);
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

        onAnimate(elapsedSeconds: number): void {
            this.camera.animate(elapsedSeconds);
            this.app.setInformativeWindowTitleWithInfo(WINDOW_TITLE,
                `${this.instanceCount} / ${this.modelCount} instances`);
        }

        releaseTargets(): void {
            const resources = [this.drawPipeline, this.framebuffer, this.colorBuffer, this.depthBuffer];
            for (let i = 0; i < resources.length; i++) {
                const resource = resources[i];
                if (resource) {
                    this.app.releaseResource(resource);
                }
            }
            this.drawPipeline = null;
            this.framebuffer = null;
            this.colorBuffer = null;
            this.depthBuffer = null;
        }

        onBackBufferResizing(): void {
            this.releaseTargets();
            // The blit's cached binding sets still reference the old color buffer.
            this.app.clearBindingCache();
        }

        // The sample's render pass: an sRGB color target (as its swap chain) and depth. Its pipeline:
        // depth test (less), back faces culled, counter-clockwise front faces, in the sample's clip
        // space (see updateSceneUniform).
        createTargets(width: int, height: int): void {
            const colorBuffer = this.app.createRenderTargetTexture(width, height, Format.SRGBA8_UNORM, "ColorBuffer");
            const depthBuffer = this.app.createRenderTargetTexture(width, height, Format.D32, "DepthBuffer");
            const framebuffer = this.app.createFramebuffer(colorBuffer, depthBuffer);
            this.colorBuffer = colorBuffer;
            this.depthBuffer = depthBuffer;
            this.framebuffer = framebuffer;

            const desc = GraphicsPipelineDesc.create(this.drawVS, this.drawPS);
            desc.setInputLayout(this.inputLayout);
            desc.addBindingLayout(this.drawBindingLayout);
            desc.setDepthState(1, 1, ComparisonFunc.Less);
            desc.setRasterState(CullMode.Back, FillMode.Solid, 1);
            this.drawPipeline = this.app.createGraphicsPipelineFromDesc(desc, framebuffer);
        }

        // The sample's update_scene_uniform: its camera's view and projection matrices, and the
        // number of models.
        updateSceneUniform(width: int, height: int): void {
            this.camera.getWorldToView(Ref(this.viewMatrix[0]));

            // The sample's world has -y up on the screen. Mirrored in y it is Donut's world, y up,
            // with the same picture: Donut's world is right-handed, its view space left-handed. So
            // the sample's view matrix is the y mirror, then Donut's view, then Donut's view space
            // to the sample's (y down, -z forward): rows and columns of Donut's negated. Donut's
            // row-vector matrices have glm's (column-vector) layout.
            const c = this.constants;
            for (let i = 0; i < 16; i++) {
                const row = Math.floor(i / 4);
                const column = i % 4;
                const mirrored = row == 1 ? -this.viewMatrix[i] : this.viewMatrix[i];
                c[CONST_VIEW + i] = column == 1 || column == 2 ? -mirrored : mirrored;
            }

            const projection = samplePerspective(radians(60.0), width / height, Z_NEAR, Z_FAR);
            for (let i = 0; i < 16; i++) {
                c[CONST_PROJ + i] = projection[i];
            }

            // proj_view = proj * view, glm's layout: element (column, row) at column * 4 + row.
            for (let column = 0; column < 4; column++) {
                for (let row = 0; row < 4; row++) {
                    let sum = 0.0;
                    for (let k = 0; k < 4; k++) {
                        sum += c[CONST_PROJ + k * 4 + row] * c[CONST_VIEW + column * 4 + k];
                    }
                    c[CONST_PROJ_VIEW + column * 4 + row] = sum;
                }
            }

            Donut_StoreInt32(Ref(c[CONST_MODEL_COUNT]), this.modelCount);
        }

        // The sample's cpu_cull: every model's draw, visible (one instance) or not (none).
        cpuCull(): void {
            const tester = new VisibilityTester(this.constants, CONST_PROJ_VIEW);
            let visible = 0;
            for (let i = 0; i < this.modelCount; i++) {
                const s = i * 4;
                const isVisible = tester.isVisible(this.spheres[s], this.spheres[s + 1], this.spheres[s + 2], this.spheres[s + 3]);
                // we control visibility by changing the instance count
                this.commands[i * COMMAND_INTS + COMMAND_INSTANCE_COUNT] = isVisible ? 1 : 0;
                if (isVisible) {
                    visible++;
                }
            }
            this.instanceCount = visible;
        }

        // The sample's run_gpu_cull: a thread per model.
        runGpuCull(commandList: CommandList): void {
            const groups = Math.floor((this.modelCount + 63) / 64);
            const addressPipeline = this.addressPipeline;
            if (this.renderMode == RENDER_GPU_DEVICE_ADDRESS) {
                if (addressPipeline) {
                    // The shader writes the commands through their address, out of NVRHI's sight.
                    commandList.setBufferWrittenByShaders(this.indirectCallBuffer);
                    commandList.dispatch(addressPipeline, this.addressBindingSet, groups, 1, 1);
                    return;
                }
            }
            commandList.dispatch(this.cullPipeline, this.cullBindingSet, groups, 1, 1);
        }

        // The sample's overlay counts the instances the GPU culling left: here from a copy of the
        // commands made READBACK_BUFFERS - 1 frames before, then a copy of this frame's.
        readBackInstanceCount(commandList: CommandList): void {
            const slot = this.frameIndex % READBACK_BUFFERS;
            const oldest = (this.frameIndex + 1) % READBACK_BUFFERS;
            if (this.readbackValid[oldest]) {
                let commands: int[] = [];
                for (let i = 0; i < this.modelCount * COMMAND_INTS; i++) {
                    commands.push(0);
                }
                if (this.app.readBuffer(this.readbackBuffers[oldest], Ref(commands[0]), this.modelCount * COMMAND_SIZE) != 0) {
                    let visible = 0;
                    for (let i = 0; i < this.modelCount; i++) {
                        visible += commands[i * COMMAND_INTS + COMMAND_INSTANCE_COUNT];
                    }
                    this.instanceCount = visible;
                }
            }
            commandList.copyBuffer(this.readbackBuffers[slot], 0, this.indirectCallBuffer, 0, this.modelCount * COMMAND_SIZE);
            this.readbackValid[slot] = true;
        }

        onRender(frameHandle: FrameHandle): void {
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
            const drawPipeline = this.drawPipeline;
            if (!framebuffer || !colorBuffer || !depthBuffer || !drawPipeline) {
                return;
            }

            if (this.renderMode == RENDER_GPU_DEVICE_ADDRESS && !this.addressPipeline) {
                this.renderMode = RENDER_GPU;
            }

            this.updateSceneUniform(width, height);
            commandList.writeBuffer(this.constantBuffer, Ref(this.constants[0]), CONST_FLOATS * 4);

            if (!this.freezeCull) {
                if (this.renderMode == RENDER_CPU) {
                    this.cpuCull();
                    commandList.writeBuffer(this.indirectCallBuffer, Ref(this.commands[0]), this.modelCount * COMMAND_SIZE);
                } else {
                    this.runGpuCull(commandList);
                }
            }
            if (this.renderMode != RENDER_CPU) {
                this.readBackInstanceCount(commandList);
            }
            this.frameIndex++;

            commandList.clearTextureFloat(colorBuffer, CLEAR_COLOR, CLEAR_COLOR, CLEAR_COLOR, 1.0);
            commandList.clearDepth(depthBuffer, 1.0);

            frame.beginDrawToFramebuffer(drawPipeline, framebuffer);
            frame.drawAddBindingSet(this.drawBindingSet);
            frame.drawSetIndexBuffer(this.indexBuffer);
            frame.drawAddVertexBuffer(this.vertexBuffer, 0, 0);
            frame.drawAddVertexBuffer(this.modelInformationBuffer, 1, 0);
            frame.drawSetIndirectBuffer(this.indirectCallBuffer);

            if (this.enableMdi && (this.support & IndirectDrawSupport.MultiDraw) != 0) {
                frame.drawIndexedIndirect(0, this.modelCount);
            } else {
                for (let j = 0; j < this.modelCount; j++) {
                    frame.drawIndexedIndirect(j * COMMAND_SIZE, 1);
                }
            }

            this.app.blitTexture(frame, colorBuffer);
        }

        // The sample's load_scene and initialize_resources: each mesh's texture, and its vertices and
        // triangles in one vertex and one index buffer, recorded into an open command list. As the
        // sample, the vertices are mirrored in y (into its world), but not the bounding spheres,
        // computed from the vertices as read: so its culling tests mirrored spheres.
        loadScene(commandList: CommandList, sampler: Opaque): boolean {
            const scene = this.app.loadGltfModel(SCENE_PATH);
            if (scene.isNull()) {
                return false;
            }
            this.modelCount = scene.getPrimitiveCount();
            if (this.modelCount != TEXTURE_COUNT) {
                console.log(`${SCENE_PATH} has ${this.modelCount} meshes, the shaders expect ${TEXTURE_COUNT}`);
                return false;
            }

            const textureSetDesc = BindingSetDesc.create();
            textureSetDesc.bindEntireConstantBuffer(0, this.constantBuffer);
            textureSetDesc.bindSampler(0, sampler);

            let vertices: f32[] = [];
            let indices: int[] = [];
            let modelInformation: f32[] = [];
            for (let p = 0; p < this.modelCount; p++) {
                // As the sample (vkb) loads KTX 1 color textures: as sRGB. One mip level, as the sample's.
                const texture = this.app.loadTexture(commandList, SCENE_DIR + scene.getMeshName(p) + ".dds", 1);
                if (!texture) {
                    return false;
                }
                textureSetDesc.bindTextureSRVArrayElement(0, p, texture);

                const vertexCount = scene.getVertexCount(p);
                const indexCount = scene.getIndexCount(p);
                let modelVertices: f32[] = [];
                for (let i = 0; i < vertexCount * VERTEX_FLOATS; i++) {
                    modelVertices.push(0.0);
                }
                let modelIndices: int[] = [];
                for (let i = 0; i < indexCount; i++) {
                    modelIndices.push(0);
                }
                scene.copyVertices(p, Ref(modelVertices[0]));
                scene.copyIndices(p, Ref(modelIndices[0]));

                const firstVertex = vertices.length / VERTEX_FLOATS;
                const firstIndex = indices.length;

                // The sample's BoundingSphere: the points' average and the farthest point from it
                // (plus one float ulp).
                let cx = 0.0;
                let cy = 0.0;
                let cz = 0.0;
                for (let v = 0; v < vertexCount * VERTEX_FLOATS; v += VERTEX_FLOATS) {
                    cx += modelVertices[v];
                    cy += modelVertices[v + 1];
                    cz += modelVertices[v + 2];
                }
                cx /= vertexCount;
                cy /= vertexCount;
                cz /= vertexCount;
                let radius2 = 0.0;
                for (let v = 0; v < vertexCount * VERTEX_FLOATS; v += VERTEX_FLOATS) {
                    const dx = modelVertices[v] - cx;
                    const dy = modelVertices[v + 1] - cy;
                    const dz = modelVertices[v + 2] - cz;
                    radius2 = Math.max(radius2, dx * dx + dy * dy + dz * dz);
                }
                const radius = Math.sqrt(radius2) * (1.0 + 1.0 / 8388608.0);
                this.spheres.push(cx);
                this.spheres.push(cy);
                this.spheres.push(cz);
                this.spheres.push(radius);

                for (let v = 0; v < vertexCount * VERTEX_FLOATS; v++) {
                    const isY = v % VERTEX_FLOATS == 1;
                    vertices.push(isY ? -modelVertices[v] : modelVertices[v]);
                }
                for (let i = 0; i < indexCount; i++) {
                    indices.push(modelIndices[i]);
                }

                // The model's information, read per instance by the vertex shader (each draw's first
                // instance is its model) and by the culling. Its indexCount is the triangle count,
                // as the sample's (nothing reads it).
                modelInformation.push(cx);
                modelInformation.push(cy);
                modelInformation.push(cz);
                modelInformation.push(radius);
                for (let k = 0; k < 4; k++) {
                    modelInformation.push(0.0);
                }
                const info = p * MODEL_INFORMATION_FLOATS;
                Donut_StoreInt32(Ref(modelInformation[info + 4]), p);
                Donut_StoreInt32(Ref(modelInformation[info + 5]), firstIndex);
                Donut_StoreInt32(Ref(modelInformation[info + 6]), indexCount / 3);

                // The model's draw: its triangles, one instance until culled.
                this.commands.push(indexCount);
                this.commands.push(1);
                this.commands.push(firstIndex);
                this.commands.push(firstVertex);
                this.commands.push(p);
            }

            this.drawBindingSet = this.app.createBindingSetForLayout(textureSetDesc, this.drawBindingLayout);
            this.vertexBuffer = this.app.createStaticVertexBuffer(commandList, Ref(vertices[0]), vertices.length * 4, "Vertices");
            this.indexBuffer = this.app.createStaticIndexBuffer(commandList, Ref(indices[0]), indices.length * 4, "Indices");
            this.modelInformationBuffer = this.app.createStaticRawVertexBuffer(commandList, Ref(modelInformation[0]),
                this.modelCount * MODEL_INFORMATION_SIZE, "Model Information");
            return true;
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(): boolean {
            this.support = this.app.getIndirectDrawSupport();

            this.drawVS = this.app.createShader("multi_draw_indirect.hlsl", "mdi_vs", ShaderType.Vertex);
            this.drawPS = this.app.createShader("multi_draw_indirect.hlsl", "mdi_ps", ShaderType.Pixel);
            const cullCS = this.app.createShader("multi_draw_indirect.hlsl", "cull_cs", ShaderType.Compute);
            if (!this.drawVS || !this.drawPS || !cullCS) {
                return false;
            }

            // Vertex bindings and attributes: the vertices at per-vertex rate, the models'
            // information at per-instance rate (the sample also reads its bounding sphere, which its
            // vertex shader ignores).
            const layoutDesc = InputLayoutDesc.create();
            layoutDesc.addVertexAttribute("POSITION", Format.RGB32_FLOAT, 0, 0, VERTEX_SIZE);
            layoutDesc.addVertexAttribute("TEXCOORD", Format.RG32_FLOAT, 24, 0, VERTEX_SIZE);
            layoutDesc.addInstanceVertexAttribute("TEXTURE_INDEX", Format.R32_UINT, 16, 1, MODEL_INFORMATION_SIZE);
            this.inputLayout = this.app.createInputLayout(layoutDesc, this.drawVS);

            this.constantBuffer = this.app.createVolatileConstantBuffer(CONST_FLOATS * 4, "SceneUniform");

            // The render pipeline: the scene uniform, the array of textures (accessed via the
            // instance's texture index) and their sampler.
            const drawLayoutDesc = BindingLayoutDesc.create();
            drawLayoutDesc.layoutVolatileConstantBuffer(0);
            drawLayoutDesc.layoutTextureSRVArray(0, TEXTURE_COUNT);
            drawLayoutDesc.layoutSampler(0);
            this.drawBindingLayout = this.app.createBindingLayout(drawLayoutDesc, ShaderType.All);

            // The sample's linear sampler (repeat). Donut's common passes, which hold it, upload their
            // textures on a command list of their own: before ours is open.
            const sampler = this.app.getCommonSampler(CommonSampler.LinearWrap);

            const commandList = this.app.createCommandList();
            commandList.open();
            const loaded = this.loadScene(commandList, sampler);
            this.indirectCallBuffer = this.app.createDrawIndexedIndirectBuffer(this.modelCount, "Indirect Calls");
            if (loaded) {
                // initialize buffer: the draws, all visible until culled
                commandList.writeBuffer(this.indirectCallBuffer, Ref(this.commands[0]), this.modelCount * COMMAND_SIZE);
            }

            // The address of the commands' buffer, in a buffer of its own, for the device address
            // culling.
            let addressBuffer: Opaque | null = null;
            if ((this.support & IndirectDrawSupport.BufferDeviceAddress) != 0) {
                let address: f32[] = [0.0, 0.0];
                Donut_StoreBufferDeviceAddress(Ref(address[0]), this.indirectCallBuffer);
                addressBuffer = this.app.createStructuredBuffer(8, 1, "Device Address");
                commandList.writeBuffer(addressBuffer, Ref(address[0]), 8);
            }
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.waitForIdle();
            this.app.releaseResource(commandList.handle);
            if (!loaded) {
                console.log("Cannot load the scene and its textures: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return false;
            }

            // The compute pipeline: the models' information, the scene uniform and the commands.
            const cullLayoutDesc = BindingLayoutDesc.create();
            cullLayoutDesc.layoutVolatileConstantBuffer(0);
            cullLayoutDesc.layoutRawBufferSRV(0);
            cullLayoutDesc.layoutRawBufferUAV(0);
            const cullLayout = this.app.createBindingLayout(cullLayoutDesc, ShaderType.Compute);
            const cullSetDesc = BindingSetDesc.create();
            cullSetDesc.bindEntireConstantBuffer(0, this.constantBuffer);
            cullSetDesc.bindRawBufferSRV(0, this.modelInformationBuffer);
            cullSetDesc.bindRawBufferUAV(0, this.indirectCallBuffer);
            this.cullBindingSet = this.app.createBindingSetForLayout(cullSetDesc, cullLayout);
            this.cullPipeline = this.app.createComputePipelineWithLayout(cullCS, cullLayout);

            // The device address pipeline: the commands through the references from the device
            // addresses, instead of their binding.
            if (addressBuffer) {
                const addressCS = this.app.createShader("multi_draw_indirect.hlsl", "cull_address_cs", ShaderType.Compute);
                if (!addressCS) {
                    return false;
                }
                const addressLayoutDesc = BindingLayoutDesc.create();
                addressLayoutDesc.layoutVolatileConstantBuffer(0);
                addressLayoutDesc.layoutRawBufferSRV(0);
                addressLayoutDesc.layoutStructuredBufferSRV(1);
                const addressLayout = this.app.createBindingLayout(addressLayoutDesc, ShaderType.Compute);
                const addressSetDesc = BindingSetDesc.create();
                addressSetDesc.bindEntireConstantBuffer(0, this.constantBuffer);
                addressSetDesc.bindRawBufferSRV(0, this.modelInformationBuffer);
                addressSetDesc.bindStructuredBufferSRV(1, addressBuffer);
                this.addressBindingSet = this.app.createBindingSetForLayout(addressSetDesc, addressLayout);
                this.addressPipeline = this.app.createComputePipelineWithLayout(addressCS, addressLayout);
            }

            for (let i = 0; i < READBACK_BUFFERS; i++) {
                this.readbackBuffers.push(this.app.createReadbackBuffer(this.modelCount * COMMAND_SIZE, `Readback ${i}`));
                this.readbackValid.push(false);
            }

            // The sample's first person camera, rotated (-23.5, -45, 0) degrees and translated by
            // (0, 0.5, -0.2): its view matrix is Rx * Ry * T, so it's at -(0, 0.5, -0.2), looking down
            // R^T * (0, 0, -1). In Donut's world (see updateSceneUniform), y negated. One degree per
            // pixel of mouse movement and one unit per second, as its camera.
            const sa = Math.sin(radians(-23.5));
            const ca = Math.cos(radians(-23.5));
            const sb = Math.sin(radians(-45.0));
            const cb = Math.cos(radians(-45.0));
            const position = [0.0, -0.5, 0.2];
            const forward = [ca * sb, -sa, -ca * cb];
            this.camera = this.app.createFirstPersonCamera();
            this.camera.lookAt(position[0], -position[1], position[2],
                position[0] + forward[0], -(position[1] + forward[1]), position[2] + forward[2]);
            this.camera.setMoveSpeed(1.0);
            this.camera.setRotateSpeed(radians(1.0));

            const pass = this.app.addPass();
            pass.setKeyboardCallback(this.onKey);
            pass.setMousePosCallback(this.onMousePos);
            pass.setMouseButtonCallback(this.onMouseButton);
            pass.setAnimateCallback(this.onAnimate);
            pass.setBackBufferResizingCallback(this.onBackBufferResizing);
            pass.setRenderCallback(this.onRender);
            return true;
        }
    }

    function supportText(supported: boolean): string {
        return supported ? "Supported" : "Not supported";
    }

    // The sample's overlay.
    class UserInterface {
        private mdi: MultiDrawIndirectPass;

        constructor(mdi: MultiDrawIndirectPass) {
            this.mdi = mdi;
        }

        buildUI(): void {
            const mdi = this.mdi;
            Donut_ImGuiSetNextWindowPos(10.0, 10.0);
            // The sample's title (ApiVulkanSample's default).
            Donut_ImGuiBegin("Vulkan Example", 1);
            if (Donut_ImGuiCollapsingHeaderDefaultOpen("GPU Rendering") != 0) {
                Donut_ImGuiText(`Multi-Draw Indirect: ${supportText((mdi.support & IndirectDrawSupport.MultiDraw) != 0)}`);
                Donut_ImGuiText(`drawIndirectFirstInstance: ${supportText((mdi.support & IndirectDrawSupport.FirstInstance) != 0)}`);
                Donut_ImGuiText(`Device buffer address: ${supportText((mdi.support & IndirectDrawSupport.BufferDeviceAddress) != 0)}`);

                Donut_ImGuiText("");
                Donut_ImGuiText(`Instances: ${mdi.instanceCount} / ${mdi.modelCount}`);

                mdi.enableMdi = Donut_ImGuiCheckbox("Enable multi-draw", mdi.enableMdi ? 1 : 0) != 0;
                mdi.freezeCull = Donut_ImGuiCheckbox("Freeze culling", mdi.freezeCull ? 1 : 0) != 0;
                mdi.renderMode = Donut_ImGuiCombo("Cull mode", mdi.renderMode, RENDER_MODE_NAMES);
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
        Donut_SetAppName("multi_draw_indirect");

        // -debug: the graphics API's debug layer and NVRHI's validation layer.
        // -noui: without the settings window.
        // -mode <0..2>: the cull mode (CPU, GPU, GPU device address); -nomdi: a draw call per model;
        // -freeze: culling frozen.
        let options = AppOptions.None;
        let withUI = true;
        let renderMode = RENDER_GPU;
        let enableMdi = true;
        let freezeCull = false;
        for (let i = 1; i < argc; i++) {
            const arg = Donut_GetArg(argv, i);
            if (arg == "-debug") {
                options = AppOptions.DebugRuntime;
            } else if (arg == "-noui") {
                withUI = false;
            } else if (arg == "-nomdi") {
                enableMdi = false;
            } else if (arg == "-freeze") {
                freezeCull = true;
            } else if (arg == "-mode" && i + 1 < argc) {
                i++;
                renderMode = Math.min(Math.max(parseInt(Donut_GetArg(argv, i)), RENDER_CPU), RENDER_GPU_DEVICE_ADDRESS);
            }
        }

        const api = Donut_GetGraphicsAPIFromCommandLine(argc, argv);
        // The scene's 225 textures are one array: more than D3D11's 128 texture slots.
        if (api == GraphicsAPI.D3D11) {
            console.log("This example needs D3D12 or Vulkan (-dx12 or -vk)");
            return 1;
        }

        const app = App.createWithOptions(api, WINDOW_TITLE, 1280, 720, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        const mdi = new MultiDrawIndirectPass(app);
        mdi.renderMode = renderMode;
        mdi.enableMdi = enableMdi;
        mdi.freezeCull = freezeCull;
        if (!mdi.init()) {
            app.destroy();
            return 1;
        }

        // Drawn after (over) the scene, and sees the mouse first.
        const gui = new UserInterface(mdi);
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
    return MultiDrawIndirect.main(argc, argv);
}
