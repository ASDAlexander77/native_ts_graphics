// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";
import { MeshletModel } from "../core/meshlet_model";
import {
    matrixInverse, matrixLookToRH, matrixMultiply, matrixPerspectiveFovRH, matrixTranslation, matrixTranspose, XM_PI,
} from "../core/directx_math";

namespace MeshletInstancing {
    const WINDOW_TITLE = "D3D12 Mesh Shader Instancing";
    const MESH_FILE = "media/meshlet_instancing/ToyRobot.bin";

    // GLFW values, as passed to the keyboard callback.
    const KEY_SPACE = 32;
    const KEY_MINUS = 45;
    const KEY_EQUAL = 61;
    const KEY_A = 65;
    const KEY_D = 68;
    const KEY_S = 83;
    const KEY_W = 87;
    const KEY_RIGHT = 262;
    const KEY_LEFT = 263;
    const KEY_DOWN = 264;
    const KEY_UP = 265;
    const KEY_KP_SUBTRACT = 333;
    const KEY_KP_ADD = 334;
    const ACTION_PRESS = 1;
    const ACTION_RELEASE = 0;

    // Shared.h: what a mesh shader group outputs at most.
    const MAX_VERTS = 64;
    const MAX_PRIMS = 126;
    // The most groups a DispatchMesh launches here (1D).
    const MAX_GROUP_DISPATCH_COUNT = 65536.0;

    // SceneConstantBuffer: View, ViewProj (float4x4 each), DrawMeshlets (uint), 256-byte aligned.
    const CONSTANTS_SIZE = 256;
    const CONSTANT_FLOATS = 32;
    const DRAW_MESHLETS_OFFSET = 128;
    // The push constants: InstanceCount, InstanceOffset, IndexBytes, MeshletCount, MeshletOffset.
    const PARAMS_SIZE = 20;
    // The mesh shader's vertex records (position, normal), Meshlet (4 uints) and Instance (World,
    // WorldInvTranspose).
    const VERTEX_STRIDE = 24;
    const MESHLET_STRIDE = 16;
    const INSTANCE_STRIDE = 128;

    // The sample's clear color, (0, 0.2, 0.4).
    const CLEAR_R = 0.0;
    const CLEAR_G = 0.2;
    const CLEAR_B = 0.4;

    // Test mode: the frames rendered, each 1/60 s, at instance level 2 (125 robots), so that groups
    // pack several instances of the last meshlets.
    const TEST_FRAMES = 3;
    const TEST_LEVEL = 2;

    // DirectX-Graphics-Samples' SimpleCamera: WASD move it, the arrow keys turn it (pitch within 45
    // degrees up and down), at its move and turn speeds per second.
    class SimpleCamera {
        private initialPosition: number[];
        position: number[];
        private yaw: number;
        private pitch: number;
        lookDirection: number[];
        private moveSpeed: number;
        private turnSpeed: number;
        private keys: int[];

        constructor() {
            this.initialPosition = [0.0, 0.0, 0.0, 0.0];
            this.position = [0.0, 0.0, 0.0, 0.0];
            this.yaw = XM_PI;
            this.pitch = 0.0;
            this.lookDirection = [0.0, 0.0, -1.0, 0.0];
            this.moveSpeed = 20.0;
            this.turnSpeed = Math.fround(XM_PI / 2.0);
            // w, a, s, d, left, right, up, down.
            this.keys = [0, 0, 0, 0, 0, 0, 0, 0];
        }

        init(x: number, y: number, z: number): void {
            this.initialPosition = [Math.fround(x), Math.fround(y), Math.fround(z), 0.0];
            this.reset();
        }

        setMoveSpeed(unitsPerSecond: number): void {
            this.moveSpeed = Math.fround(unitsPerSecond);
        }

        reset(): void {
            this.position = [this.initialPosition[0], this.initialPosition[1], this.initialPosition[2], 0.0];
            this.yaw = XM_PI;
            this.pitch = 0.0;
            this.lookDirection = [0.0, 0.0, -1.0, 0.0];
        }

        onKey(key: int, down: boolean): void {
            let index = -1;
            if (key == KEY_W) {
                index = 0;
            } else if (key == KEY_A) {
                index = 1;
            } else if (key == KEY_S) {
                index = 2;
            } else if (key == KEY_D) {
                index = 3;
            } else if (key == KEY_LEFT) {
                index = 4;
            } else if (key == KEY_RIGHT) {
                index = 5;
            } else if (key == KEY_UP) {
                index = 6;
            } else if (key == KEY_DOWN) {
                index = 7;
            }
            if (index >= 0) {
                this.keys[index] = down ? 1 : 0;
            }
        }

        update(elapsedSeconds: number): void {
            const k = this.keys;
            // The move vector in camera space.
            let moveX = 0.0;
            let moveZ = 0.0;
            if (k[1] != 0) {
                moveX -= 1.0;
            }
            if (k[3] != 0) {
                moveX += 1.0;
            }
            if (k[0] != 0) {
                moveZ -= 1.0;
            }
            if (k[2] != 0) {
                moveZ += 1.0;
            }
            if (Math.abs(moveX) > 0.1 && Math.abs(moveZ) > 0.1) {
                const length = Math.fround(Math.sqrt(moveX * moveX + moveZ * moveZ));
                moveX = Math.fround(moveX / length);
                moveZ = Math.fround(moveZ / length);
            }

            const moveInterval = Math.fround(this.moveSpeed * elapsedSeconds);
            const rotateInterval = Math.fround(this.turnSpeed * elapsedSeconds);
            if (k[4] != 0) {
                this.yaw = Math.fround(this.yaw + rotateInterval);
            }
            if (k[5] != 0) {
                this.yaw = Math.fround(this.yaw - rotateInterval);
            }
            if (k[6] != 0) {
                this.pitch = Math.fround(this.pitch + rotateInterval);
            }
            if (k[7] != 0) {
                this.pitch = Math.fround(this.pitch - rotateInterval);
            }
            // Prevent looking too far up or down. Not Math.max: tslang's starts from
            // Number.MIN_VALUE, above any negative number.
            const quarterPi = Math.fround(XM_PI / 4.0);
            if (this.pitch > quarterPi) {
                this.pitch = quarterPi;
            }
            if (this.pitch < -quarterPi) {
                this.pitch = -quarterPi;
            }

            // Move the camera in model space.
            const cosYaw = Math.fround(Math.cos(this.yaw));
            const sinYaw = Math.fround(Math.sin(this.yaw));
            const x = Math.fround(Math.fround(moveX * -cosYaw) - Math.fround(moveZ * sinYaw));
            const z = Math.fround(Math.fround(moveX * sinYaw) - Math.fround(moveZ * cosYaw));
            this.position[0] = Math.fround(this.position[0] + Math.fround(x * moveInterval));
            this.position[2] = Math.fround(this.position[2] + Math.fround(z * moveInterval));

            // The look direction.
            const r = Math.fround(Math.cos(this.pitch));
            this.lookDirection = [Math.fround(r * sinYaw), Math.fround(Math.sin(this.pitch)), Math.fround(r * cosYaw), 0.0];
        }

        viewMatrix(): number[] {
            return matrixLookToRH(this.position, this.lookDirection, [0.0, 1.0, 0.0, 0.0]);
        }

    }

    // A mesh of the model on the GPU: its binding set, index size and meshlet subsets (offset, count
    // pairs) with their last meshlet's pack counts.
    class GpuMesh {
        bindingSet: BindingSet;
        indexSize: int;
        subsets: int[];
        packCounts: int[];

        constructor(bindingSet: BindingSet, indexSize: int) {
            this.bindingSet = bindingSet;
            this.indexSize = indexSize;
            this.subsets = [];
            this.packCounts = [];
        }
    }

    // Port of DirectX-Graphics-Samples' D3D12MeshShaders MeshletInstancing: a cube of toy robots
    // ((2 level + 1)^3 of them; + and - change the level) drawn by a mesh shader alone, a group per
    // meshlet and instance but for each subset's last meshlet, of which as many instances as fit
    // share a group; the dispatches are cut into batches of at most 65536 groups. Space switches the
    // meshlet colors. The sample's back buffer (R8G8B8A8_UNORM) and D32_FLOAT depth buffer are a
    // color target here, blitted into the back buffer.
    class MeshletInstancingPass {
        private app: App;
        private meshShader: ShaderHandle;
        private pixelShader: ShaderHandle;
        private bindingLayout: BindingLayoutHandle;
        private constantBuffer: BufferHandle;
        private meshes: GpuMesh[];
        // The meshes' buffers, for binding sets made again with a new instance buffer.
        private meshBuffers: BufferHandle[];
        private instanceBuffer: BufferHandle | null;
        private instanceCapacity: int;
        private instanceData: f32[];
        private updateInstances: boolean;
        private hasTargets: boolean;
        private colorBuffer: TextureHandle;
        private depthBuffer: TextureHandle;
        private framebuffer: FramebufferHandle;
        private pipeline: MeshletPipelineHandle;
        private constants: f32[];
        private drawMeshletsValue: int[];
        private params: int[];
        private camera: SimpleCamera;
        private radius: number;
        instanceLevel: int;
        instanceCount: int;
        drawMeshlets: boolean;

        constructor(app: App) {
            this.app = app;
            this.meshes = [];
            this.meshBuffers = [];
            this.instanceBuffer = null;
            this.instanceCapacity = 0;
            this.instanceData = [];
            this.updateInstances = true;
            this.hasTargets = false;
            this.constants = [];
            for (let i = 0; i < CONSTANT_FLOATS; i++) {
                this.constants.push(0.0);
            }
            this.drawMeshletsValue = [1];
            this.params = [0, 0, 0, 0, 0];
            this.camera = new SimpleCamera();
            this.radius = 0.0;
            this.instanceLevel = 0;
            this.instanceCount = 1;
            this.drawMeshlets = true;
        }

        // OnKeyDown / OnKeyUp.
        onKey(key: int, scancode: int, action: int, mods: int): int {
            if (action == ACTION_PRESS) {
                if (key == KEY_EQUAL || key == KEY_KP_ADD) {
                    this.instanceLevel++;
                    this.regenerateInstances();
                } else if (key == KEY_MINUS || key == KEY_KP_SUBTRACT) {
                    if (this.instanceLevel != 0) {
                        this.instanceLevel--;
                        this.regenerateInstances();
                    }
                } else if (key == KEY_SPACE) {
                    this.drawMeshlets = !this.drawMeshlets;
                }
                this.camera.onKey(key, true);
                return 1;
            }
            if (action == ACTION_RELEASE) {
                this.camera.onKey(key, false);
                return 1;
            }
            return 0;
        }

        // RegenerateInstances: the instances in a cube growing with the level, a bounding sphere's
        // diameter apart; the instance buffer made larger when they don't fit.
        regenerateInstances(): void {
            this.updateInstances = true;
            const spacing = Math.fround(Math.fround(1.0 * this.radius) * 2.0);
            const width = this.instanceLevel * 2 + 1;
            const extents = Math.fround(spacing * this.instanceLevel);
            this.instanceCount = width * width * width;

            if (this.instanceCount > this.instanceCapacity) {
                this.app.waitForIdle();
                const old = this.instanceBuffer;
                if (old) {
                    this.app.releaseResource(old);
                }
                this.instanceCapacity = this.instanceCount;
                const buffer = this.app.createStructuredBuffer(INSTANCE_STRIDE, this.instanceCapacity, "Instances");
                this.instanceBuffer = buffer;
                this.createBindingSets(buffer);
            }

            let data: f32[] = [];
            for (let i = 0; i < this.instanceCount; i++) {
                const x = Math.fround(Math.fround((i % width) * spacing) - extents);
                const y = Math.fround(Math.fround((Math.floor(i / width) % width) * spacing) - extents);
                const z = Math.fround(Math.fround(Math.floor(i / (width * width)) * spacing) - extents);
                const world = matrixTranslation(x, y, z);
                const worldT = matrixTranspose(world);
                const worldInvTranspose = matrixTranspose(matrixInverse(matrixTranspose(world)));
                for (let k = 0; k < 16; k++) {
                    data.push(worldT[k]);
                }
                for (let k = 0; k < 16; k++) {
                    data.push(worldInvTranspose[k]);
                }
            }
            this.instanceData = data;
        }

        // OnUpdate: the camera and the constants for its view.
        onAnimate(elapsedSeconds: number): void {
            this.app.setInformativeWindowTitleWithInfo(WINDOW_TITLE, `${this.instanceCount} instances`);
            this.camera.update(Math.fround(elapsedSeconds));
        }

        onBackBufferResizing(): void {
            if (!this.hasTargets) {
                return;
            }
            this.app.releaseResource(this.pipeline);
            this.app.releaseResource(this.framebuffer);
            this.app.releaseResource(this.colorBuffer);
            this.app.releaseResource(this.depthBuffer);
            this.app.clearBindingCache();
            this.hasTargets = false;
        }

        // The sample's back buffer and depth buffer, and its pipeline state: the default rasterizer
        // state (back faces culled), blend state (opaque) and depth state (less, writes).
        createTargets(width: int, height: int): void {
            this.colorBuffer = this.app.createRenderTargetTexture(width, height, Format.RGBA8_UNORM, "ColorBuffer");
            this.depthBuffer = this.app.createRenderTargetTexture(width, height, Format.D32, "DepthBuffer");
            this.framebuffer = this.app.createFramebuffer(this.colorBuffer, this.depthBuffer);

            const desc = GraphicsPipelineDesc.createMeshlet(null, this.meshShader, this.pixelShader);
            desc.addBindingLayout(this.bindingLayout);
            desc.setDepthState(1, 1, ComparisonFunc.Less);
            desc.setRasterState(CullMode.Back, FillMode.Solid, 0);
            this.pipeline = this.app.createMeshletPipelineFromDesc(desc, this.framebuffer);
            this.hasTargets = true;
        }

        // PopulateCommandList.
        onRender(frameHandle: FrameHandle): void {
            const frame = new Frame(frameHandle);
            const commandList = frame.getCommandList();
            const width = frame.getWidth();
            const height = frame.getHeight();
            if (!this.hasTargets) {
                this.createTargets(width, height);
            }

            // OnUpdate's constants: the camera's view, a 60 degree perspective (near 1, far 10000).
            const view = this.camera.viewMatrix();
            const proj = matrixPerspectiveFovRH(Math.fround(XM_PI / 3.0), Math.fround(width / height), 1.0, 10000.0);
            const viewT = matrixTranspose(view);
            const viewProjT = matrixTranspose(matrixMultiply(view, proj));
            for (let i = 0; i < 16; i++) {
                this.constants[i] = viewT[i];
                this.constants[16 + i] = viewProjT[i];
            }
            this.drawMeshletsValue[0] = this.drawMeshlets ? 1 : 0;
            commandList.writeBuffer(this.constantBuffer, Ref(this.constants[0]), CONSTANT_FLOATS * 4);
            commandList.writeBufferAt(this.constantBuffer, DRAW_MESHLETS_OFFSET, Ref(this.drawMeshletsValue[0]), 4);

            // Only upload instance data if it changed.
            const instanceBuffer = this.instanceBuffer;
            if (this.updateInstances) {
                if (instanceBuffer) {
                    commandList.writeBuffer(instanceBuffer, Ref(this.instanceData[0]), this.instanceCount * INSTANCE_STRIDE);
                }
                this.updateInstances = false;
            }

            commandList.clearTextureFloat(this.colorBuffer, CLEAR_R, CLEAR_G, CLEAR_B, 1.0);
            commandList.clearDepth(this.depthBuffer, 1.0);

            for (let m = 0; m < this.meshes.length; m++) {
                const mesh = this.meshes[m];
                frame.beginMeshDrawToFramebuffer(this.pipeline, this.framebuffer);
                frame.drawAddBindingSet(mesh.bindingSet);
                for (let s = 0; s < mesh.packCounts.length; s++) {
                    const subsetOffset = mesh.subsets[s * 2];
                    const subsetCount = mesh.subsets[s * 2 + 1];
                    const groupsPerInstance = Math.fround((subsetCount - 1) + Math.fround(1.0 / mesh.packCounts[s]));
                    const maxInstancePerBatch: int = Math.floor(Math.fround(MAX_GROUP_DISPATCH_COUNT / groupsPerInstance));
                    const dispatchCount = Math.floor((this.instanceCount + maxInstancePerBatch - 1) / maxInstancePerBatch);
                    for (let j = 0; j < dispatchCount; j++) {
                        const instanceOffset = maxInstancePerBatch * j;
                        let instanceCount = this.instanceCount - instanceOffset;
                        if (instanceCount > maxInstancePerBatch) {
                            instanceCount = maxInstancePerBatch;
                        }
                        this.params[0] = instanceCount;
                        this.params[1] = instanceOffset;
                        this.params[2] = mesh.indexSize;
                        this.params[3] = subsetCount;
                        this.params[4] = subsetOffset;
                        const groupCount: int = Math.ceil(Math.fround(groupsPerInstance * instanceCount));
                        frame.drawMeshTasksWithPushConstants(groupCount, Ref(this.params[0]), PARAMS_SIZE);
                    }
                }
            }

            this.app.blitTexture(frame, this.colorBuffer);
        }

        // The meshes' binding sets, for an instance buffer.
        createBindingSets(instanceBuffer: BufferHandle): void {
            for (let m = 0; m < this.meshes.length; m++) {
                const setDesc = BindingSetDesc.create();
                setDesc.bindEntireConstantBuffer(0, this.constantBuffer);
                setDesc.bindPushConstants(1, PARAMS_SIZE);
                setDesc.bindRawBufferSRV(0, this.meshBuffers[m * 4]);
                setDesc.bindStructuredBufferSRV(1, this.meshBuffers[m * 4 + 1]);
                setDesc.bindRawBufferSRV(2, this.meshBuffers[m * 4 + 2]);
                setDesc.bindStructuredBufferSRV(3, this.meshBuffers[m * 4 + 3]);
                setDesc.bindStructuredBufferSRV(4, instanceBuffer);
                this.meshes[m].bindingSet = this.app.createBindingSetForLayout(setDesc, this.bindingLayout);
            }
        }

        // Model::LoadFromFile and UploadGpuResources: each mesh's vertices, meshlets, unique vertex
        // indices and primitives in buffers for the mesh shader, its subsets and their pack counts.
        loadModel(): boolean {
            const binaryFile = this.app.loadBinaryFile(MESH_FILE);
            if (binaryFile.isNull()) {
                console.log(`Cannot load ${MESH_FILE} (the sample's model: build with DIRECTX_GRAPHICS_SAMPLES_DIR set)`);
                return false;
            }
            const loaded = MeshletModel.load(binaryFile.getData(), binaryFile.getSize());
            this.app.releaseObject(binaryFile.handle);
            if (loaded.isNull()) {
                return false;
            }
            const model = loaded;
            let sphere: f32[] = [0.0, 0.0, 0.0, 0.0];
            model.copyBoundingSphere(-1, Ref(sphere[0]));
            this.radius = sphere[3];

            const commandList = this.app.createCommandList();
            commandList.open();
            let ok = true;
            const meshCount = model.getMeshCount();
            for (let i = 0; i < meshCount; i++) {
                if (model.getVertexBufferStride(i, 0) != VERTEX_STRIDE) {
                    console.log(`${MESH_FILE}: vertices of another layout than the mesh shader's`);
                    ok = false;
                    break;
                }
                const meshletCount = model.getDataCount(i, MeshletModelData.Meshlets);
                this.meshBuffers.push(this.app.createStaticShaderBuffer(commandList, model.getVertexBufferData(i, 0),
                    model.getVertexBufferSize(i, 0), 0, "Vertices"));
                this.meshBuffers.push(this.app.createStaticShaderBuffer(commandList, model.getData(i, MeshletModelData.Meshlets),
                    meshletCount * MESHLET_STRIDE, MESHLET_STRIDE, "Meshlets"));
                // The unique vertex indices, rounded up to whole uints, as the sample's buffer.
                const uniqueSize = model.getDataSize(i, MeshletModelData.UniqueVertexIndices);
                const uniqueInts = Math.floor((uniqueSize + 3) / 4);
                let unique: int[] = [];
                for (let j = 0; j < uniqueInts; j++) {
                    unique.push(0);
                }
                model.copyData(i, MeshletModelData.UniqueVertexIndices, Ref(unique[0]));
                this.meshBuffers.push(this.app.createStaticShaderBuffer(commandList, Ref(unique[0]), uniqueInts * 4, 0, "UniqueVertexIndices"));
                const primitiveCount = model.getDataCount(i, MeshletModelData.PrimitiveIndices);
                this.meshBuffers.push(this.app.createStaticShaderBuffer(commandList, model.getData(i, MeshletModelData.PrimitiveIndices),
                    primitiveCount * 4, 4, "PrimitiveIndices"));

                const mesh = new GpuMesh(new BindingSet(null), model.getIndexSize(i));
                let meshlets: int[] = [];
                for (let j = 0; j < meshletCount * 4; j++) {
                    meshlets.push(0);
                }
                model.copyData(i, MeshletModelData.Meshlets, Ref(meshlets[0]));
                const subsetCount = model.getDataCount(i, MeshletModelData.MeshletSubsets);
                let subsets: int[] = [];
                for (let j = 0; j < subsetCount * 2; j++) {
                    subsets.push(0);
                }
                model.copyData(i, MeshletModelData.MeshletSubsets, Ref(subsets[0]));
                mesh.subsets = subsets;
                // GetLastMeshletPackCount: how many instances of the subset's last meshlet fit a group.
                for (let s = 0; s < subsetCount; s++) {
                    const last = subsets[s * 2] + subsets[s * 2 + 1] - 1;
                    const byVerts = Math.floor(MAX_VERTS / meshlets[last * 4]);
                    const byPrims = Math.floor(MAX_PRIMS / meshlets[last * 4 + 2]);
                    mesh.packCounts.push(byVerts < byPrims ? byVerts : byPrims);
                }
                this.meshes.push(mesh);
            }
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.releaseResource(commandList.handle);
            model.destroy();
            return ok;
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(): boolean {
            this.meshShader = this.app.createShader("meshlet_instancing.hlsl", "main_ms", ShaderType.Mesh);
            this.pixelShader = this.app.createShader("meshlet_instancing.hlsl", "main_ps", ShaderType.Pixel);
            if (!this.meshShader || !this.pixelShader) {
                return false;
            }
            // The sample's root signature: CBV(b0), RootConstants(b1, 2), RootConstants(b2, 3),
            // SRV(t0) .. SRV(t4); its root constants one block of push constants.
            const layoutDesc = BindingLayoutDesc.create();
            layoutDesc.layoutConstantBuffer(0);
            layoutDesc.layoutPushConstants(1, PARAMS_SIZE);
            layoutDesc.layoutRawBufferSRV(0);
            layoutDesc.layoutStructuredBufferSRV(1);
            layoutDesc.layoutRawBufferSRV(2);
            layoutDesc.layoutStructuredBufferSRV(3);
            layoutDesc.layoutStructuredBufferSRV(4);
            this.bindingLayout = this.app.createBindingLayout(layoutDesc, ShaderType.All);
            this.constantBuffer = this.app.createConstantBuffer(CONSTANTS_SIZE, "SceneConstantBuffer");

            // The sample's camera: at (0, 5, 35), 60 units a second.
            this.camera.init(0.0, 5.0, 35.0);
            this.camera.setMoveSpeed(60.0);

            if (!this.loadModel()) {
                return false;
            }
            this.regenerateInstances();
            // Blitting creates Donut's common passes: before any command list is open.
            this.app.getCommonSampler(CommonSampler.LinearClamp);

            const pass = this.app.addPass();
            pass.setKeyboardCallback(this.onKey);
            pass.setAnimateCallback(this.onAnimate);
            pass.setBackBufferResizingCallback(this.onBackBufferResizing);
            pass.setRenderCallback(this.onRender);
            return true;
        }
    }

    // -test: checks the last frame, at instance level 2 (125 robots around the camera). They cover
    // most of the frame but not all of it (the clear color shows between them), in meshlet colors:
    // some pixels without red (odd meshlets), some with.
    function checkFrame(app: App, pass: MeshletInstancingPass): string {
        const width = app.getWindowWidth();
        const height = app.getWindowHeight();
        let pixels: int[] = [];
        for (let i = 0; i < width * height; i++) {
            pixels.push(0);
        }
        if (app.readBackBufferRGBA8(Ref(pixels[0]), pixels.length) == 0) {
            return "cannot read the back buffer";
        }
        if (pass.instanceCount != 125) {
            return `${pass.instanceCount} instances, not 125`;
        }
        const background = 0 | (51 << 8) | (102 << 16);
        let covered = 0;
        let noRed = 0;
        let red = 0;
        for (let i = 0; i < width * height; i++) {
            const p = pixels[i] & 0xFFFFFF;
            if (p != background) {
                covered++;
                if ((p & 0xFF) == 0) {
                    noRed++;
                } else {
                    red++;
                }
            }
        }
        const coverage = covered / (width * height);
        console.log(`Coverage ${coverage}, pixels without red ${noRed}, with red ${red}`);
        // The camera is among the robots: they cover most of the frame, the clear color between them.
        if (coverage < 0.5 || coverage > 0.98) {
            return `the robots cover ${coverage} of the frame`;
        }
        if (noRed < covered / 10 || red < covered / 10) {
            return `no meshlet colors: ${noRed} pixels without red, ${red} with`;
        }
        return "";
    }

    export function main(argc: int, argv: Ref<string>): int {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("meshlet_instancing");

        // -debug: the graphics API's debug layer and NVRHI's validation layer.
        // -test [-testOutput <file>]: render a few frames without a window at instance level 2 and
        // check the last one (see checkFrame).
        // UNORM back buffers, as the sample's R8G8B8A8_UNORM.
        let options = AppOptions.UnormBackBuffer;
        for (let i = 1; i < argc; i++) {
            if (Donut_GetArg(argv, i) == "-debug") {
                options = options | AppOptions.DebugRuntime;
            }
        }
        const test = Donut_ParseTestArgs(argc, argv, TEST_FRAMES, 1.0 / 60.0) != 0;

        // The sample's window.
        const api = Donut_GetGraphicsAPIFromCommandLine(argc, argv);
        const app = App.createWithOptions(api, WINDOW_TITLE, 1280, 720, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }
        if (app.isFeatureSupported(Feature.Meshlets) == 0) {
            console.log("The graphics device has no mesh shaders");
            app.destroy();
            return 1;
        }

        const pass = new MeshletInstancingPass(app);
        if (!pass.init()) {
            app.destroy();
            return 1;
        }
        if (test) {
            pass.instanceLevel = TEST_LEVEL;
            pass.regenerateInstances();
        }

        const input = new InputPass(app.handle);

        app.run();
        let result = 0;
        if (test) {
            result = app.finishTest(checkFrame(app, pass));
        }
        app.destroy();
        return result;
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>): int {
    return MeshletInstancing.main(argc, argv);
}
