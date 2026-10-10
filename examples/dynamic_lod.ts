// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";
import { MeshletModel } from "../core/meshlet_model";
import {
    matrixInverse, matrixLookToRH, matrixMultiply, matrixPerspectiveFovRH, matrixTranslation, matrixTranspose,
    planeNormalize, row, vadd, vsub, XM_PI,
} from "../core/directx_math";

namespace DynamicLod {
    const WINDOW_TITLE = "D3D12 Mesh Shader Dynamic LOD";
    const MEDIA_DIR = "media/dynamic_lod/";
    const LOD_FILES = ["Dragon_LOD0.bin", "Dragon_LOD1.bin", "Dragon_LOD2.bin", "Dragon_LOD3.bin", "Dragon_LOD4.bin", "Dragon_LOD5.bin"];

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

    // Shared.h.
    const MAX_LOD_LEVELS = 8;
    // The most amplification shader groups a DispatchMesh launches here.
    const MAX_GROUP_DISPATCH_COUNT = 65536;

    // Constants: View, ViewProj, Planes[6], ViewPosition, RecipTanHalfFovy, RenderMode (uint),
    // LODCount (uint); 256-byte aligned.
    const CONSTANTS_SIZE = 256;
    const CONSTANT_FLOATS = 60;
    const RENDER_MODE_OFFSET = 240;
    // DrawParams, the push constants: InstanceOffset, InstanceCount.
    const DRAW_PARAMS_SIZE = 8;
    // MeshInfo: IndexBytes, MeshletCount, LastMeshletVertCount, LastMeshletPrimCount.
    const MESH_INFO_SIZE = 256;
    // The files' vertex records (position, normal), Meshlet (4 uints); Instance (World,
    // WorldInvTranspose, BoundingSphere).
    const VERTEX_STRIDE = 24;
    const MESHLET_STRIDE = 16;
    const INSTANCE_STRIDE = 144;
    const INSTANCE_FLOATS = 36;

    // The render modes Space cycles through: flat, meshlet colors, LOD colors (red LOD 0 to green
    // LOD n). The sample starts with LOD colors.
    const RENDER_MODE_COUNT = 3;
    const RENDER_MODE_LOD = 2;

    // The sample's clear color, (0, 0.2, 0.4).
    const CLEAR_R = 0.0;
    const CLEAR_G = 0.2;
    const CLEAR_B = 0.4;

    // Test mode: the frames rendered, each 1/60 s, at instance level 2 (125 dragons, near ones at
    // fine LODs and far ones at coarse ones).
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

    // Port of DirectX-Graphics-Samples' D3D12MeshShaders DynamicLOD: a cube of dragons ((2 level +
    // 1)^3 of them; + and - change the level), an amplification shader thread per dragon culling it
    // against the view frustum and picking one of six levels of detail by its size on screen, then a
    // mesh shader group per meshlet and dragon (several dragons per group for each LOD's last
    // meshlet) reading that LOD's meshlets from arrays of buffers. Space cycles flat, meshlet and LOD
    // colors (red the finest LOD to green the coarsest). The sample's back buffer (R8G8B8A8_UNORM)
    // and D32_FLOAT depth buffer are a color target here, blitted into the back buffer.
    class DynamicLodPass {
        private app: App;
        private ampShader: ShaderHandle;
        private meshShader: ShaderHandle;
        private pixelShader: ShaderHandle;
        private bindingLayout: BindingLayoutHandle;
        private constantBuffer: BufferHandle;
        // Per LOD: MeshInfo, vertices, meshlets, unique vertex indices, primitives; then the
        // placeholders bound to the arrays' unused slots.
        private lodBuffers: BufferHandle[];
        private placeholders: BufferHandle[];
        private bindingSet: BindingSet;
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
        private uints: int[];
        private drawParams: int[];
        private camera: SimpleCamera;
        private radius: number;
        private fovY: number;
        instanceLevel: int;
        instanceCount: int;
        renderMode: int;

        constructor(app: App) {
            this.app = app;
            this.lodBuffers = [];
            this.placeholders = [];
            this.bindingSet = new BindingSet(null);
            this.instanceBuffer = null;
            this.instanceCapacity = 0;
            this.instanceData = [];
            this.updateInstances = true;
            this.hasTargets = false;
            this.constants = [];
            for (let i = 0; i < CONSTANT_FLOATS; i++) {
                this.constants.push(0.0);
            }
            this.uints = [RENDER_MODE_LOD, LOD_FILES.length];
            this.drawParams = [0, 0];
            this.camera = new SimpleCamera();
            this.radius = 0.0;
            this.fovY = Math.fround(XM_PI / 3.0);
            this.instanceLevel = 0;
            this.instanceCount = 1;
            this.renderMode = RENDER_MODE_LOD;
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
                    this.renderMode = (this.renderMode + 1) % RENDER_MODE_COUNT;
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

        // RegenerateInstances: the dragons in a cube growing with the level, 1.5 bounding sphere
        // radii apart, each with its bounding sphere (its position, the finest LOD's radius); the
        // instance buffer made larger when they don't fit.
        regenerateInstances(): void {
            this.updateInstances = true;
            const radius = this.radius;
            const spacing = Math.fround(Math.fround(1.0 + 0.5) * radius);
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
                this.createBindingSet(buffer);
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
                data.push(x);
                data.push(y);
                data.push(z);
                data.push(radius);
            }
            this.instanceData = data;
        }

        // OnUpdate: the camera; the constants with its frustum planes and position.
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

            const desc = GraphicsPipelineDesc.createMeshlet(this.ampShader, this.meshShader, this.pixelShader);
            desc.addBindingLayout(this.bindingLayout);
            desc.setDepthState(1, 1, ComparisonFunc.Less);
            desc.setRasterState(CullMode.Back, FillMode.Solid, 0);
            this.pipeline = this.app.createMeshletPipelineFromDesc(desc, this.framebuffer);
            this.hasTargets = true;
        }

        // OnUpdate's constants for the frame: the view, the 60 degree perspective (near 1, far
        // 10000), the frustum planes from their product, the camera's position.
        updateConstants(width: int, height: int): void {
            const view = this.camera.viewMatrix();
            const proj = matrixPerspectiveFovRH(this.fovY, Math.fround(width / height), 1.0, 10000.0);
            const viewProj = matrixMultiply(view, proj);
            const vp = matrixTranspose(viewProj);
            const r0 = row(vp, 0);
            const r1 = row(vp, 1);
            const r2 = row(vp, 2);
            const r3 = row(vp, 3);
            const planes = [
                planeNormalize(vadd(r3, r0)), // Left
                planeNormalize(vsub(r3, r0)), // Right
                planeNormalize(vadd(r3, r1)), // Bottom
                planeNormalize(vsub(r3, r1)), // Top
                planeNormalize(r2),           // Near
                planeNormalize(vsub(r3, r2)), // Far
            ];
            const c = this.constants;
            const viewT = matrixTranspose(view);
            const viewProjT = matrixTranspose(viewProj);
            for (let i = 0; i < 16; i++) {
                c[i] = viewT[i];
                c[16 + i] = viewProjT[i];
            }
            for (let p = 0; p < 6; p++) {
                for (let i = 0; i < 4; i++) {
                    c[32 + p * 4 + i] = planes[p][i];
                }
            }
            const viewPosition = row(matrixInverse(view), 3);
            for (let i = 0; i < 3; i++) {
                c[56 + i] = viewPosition[i];
            }
            c[59] = Math.fround(1.0 / Math.fround(Math.tan(Math.fround(this.fovY * 0.5))));
            this.uints[0] = this.renderMode;
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

            this.updateConstants(width, height);
            commandList.writeBuffer(this.constantBuffer, Ref(this.constants[0]), CONSTANT_FLOATS * 4);
            commandList.writeBufferAt(this.constantBuffer, RENDER_MODE_OFFSET, Ref(this.uints[0]), 8);

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

            // An amplification shader group per instance (of which its first thread's has one).
            // The sample's batches start at dispatchCount * i, as here.
            frame.beginMeshDrawToFramebuffer(this.pipeline, this.framebuffer);
            frame.drawAddBindingSet(this.bindingSet);
            const dispatchCount = Math.floor((this.instanceCount + MAX_GROUP_DISPATCH_COUNT - 1) / MAX_GROUP_DISPATCH_COUNT);
            for (let i = 0; i < dispatchCount; i++) {
                const offset = dispatchCount * i;
                let count = this.instanceCount - offset;
                if (count > MAX_GROUP_DISPATCH_COUNT) {
                    count = MAX_GROUP_DISPATCH_COUNT;
                }
                this.drawParams[0] = offset;
                this.drawParams[1] = count;
                frame.drawMeshTasksWithPushConstants(count, Ref(this.drawParams[0]), DRAW_PARAMS_SIZE);
            }

            this.app.blitTexture(frame, this.colorBuffer);
        }

        // The binding set: the LODs' buffers in the arrays' first slots, placeholders (zeroed) in
        // the rest, as the sample's null descriptors; and an instance buffer.
        createBindingSet(instanceBuffer: BufferHandle): void {
            const lodCount = LOD_FILES.length;
            const setDesc = BindingSetDesc.create();
            setDesc.bindEntireConstantBuffer(0, this.constantBuffer);
            setDesc.bindPushConstants(1, DRAW_PARAMS_SIZE);
            for (let i = 0; i < MAX_LOD_LEVELS; i++) {
                const b = this.lodBuffers;
                const p = this.placeholders;
                const lod = i < lodCount;
                setDesc.bindConstantBufferArrayElement(2, i, lod ? b[i * 5] : p[0]);
                setDesc.bindRawBufferSRVArrayElement(0, i, lod ? b[i * 5 + 1] : p[1]);
                setDesc.bindStructuredBufferSRVArrayElement(8, i, lod ? b[i * 5 + 2] : p[2]);
                setDesc.bindRawBufferSRVArrayElement(16, i, lod ? b[i * 5 + 3] : p[1]);
                setDesc.bindStructuredBufferSRVArrayElement(24, i, lod ? b[i * 5 + 4] : p[3]);
            }
            setDesc.bindStructuredBufferSRV(32, instanceBuffer);
            this.bindingSet = this.app.createBindingSetForLayout(setDesc, this.bindingLayout);
        }

        // Model::LoadFromFile and UploadGpuResources, for each LOD's first mesh: its MeshInfo and
        // buffers for the shaders.
        loadLods(commandList: CommandList): boolean {
            for (let l = 0; l < LOD_FILES.length; l++) {
                const path = MEDIA_DIR + LOD_FILES[l];
                const binaryFile = this.app.loadBinaryFile(path);
                if (binaryFile.isNull()) {
                    console.log(`Cannot load ${path} (the sample's model: build with DIRECTX_GRAPHICS_SAMPLES_DIR set)`);
                    return false;
                }
                const loaded = MeshletModel.load(binaryFile.getData(), binaryFile.getSize());
                this.app.releaseObject(binaryFile.handle);
                if (loaded.isNull()) {
                    return false;
                }
                const model = loaded;
                if (model.getVertexBufferStride(0, 0) != VERTEX_STRIDE) {
                    console.log(`${path}: vertices of another layout than the mesh shader's`);
                    model.destroy();
                    return false;
                }
                // The finest LOD's bounding sphere spaces the instances.
                if (l == 0) {
                    let sphere: f32[] = [0.0, 0.0, 0.0, 0.0];
                    model.copyBoundingSphere(-1, Ref(sphere[0]));
                    this.radius = sphere[3];
                }

                const meshletCount = model.getDataCount(0, MeshletModelData.Meshlets);
                let meshlets: int[] = [];
                for (let j = 0; j < meshletCount * 4; j++) {
                    meshlets.push(0);
                }
                model.copyData(0, MeshletModelData.Meshlets, Ref(meshlets[0]));
                let meshInfo: int[] = [model.getIndexSize(0), meshletCount,
                    meshlets[(meshletCount - 1) * 4], meshlets[(meshletCount - 1) * 4 + 2]];
                const meshInfoBuffer = this.app.createConstantBuffer(MESH_INFO_SIZE, "MeshInfo");
                commandList.writeBuffer(meshInfoBuffer, Ref(meshInfo[0]), 16);
                this.lodBuffers.push(meshInfoBuffer);

                this.lodBuffers.push(this.app.createStaticShaderBuffer(commandList, model.getVertexBufferData(0, 0),
                    model.getVertexBufferSize(0, 0), 0, "Vertices"));
                this.lodBuffers.push(this.app.createStaticShaderBuffer(commandList, Ref(meshlets[0]), meshletCount * MESHLET_STRIDE,
                    MESHLET_STRIDE, "Meshlets"));
                // The unique vertex indices, rounded up to whole uints, as the sample's buffer.
                const uniqueSize = model.getDataSize(0, MeshletModelData.UniqueVertexIndices);
                const uniqueInts = Math.floor((uniqueSize + 3) / 4);
                let unique: int[] = [];
                for (let j = 0; j < uniqueInts; j++) {
                    unique.push(0);
                }
                model.copyData(0, MeshletModelData.UniqueVertexIndices, Ref(unique[0]));
                this.lodBuffers.push(this.app.createStaticShaderBuffer(commandList, Ref(unique[0]), uniqueInts * 4, 0, "UniqueVertexIndices"));
                const primitiveCount = model.getDataCount(0, MeshletModelData.PrimitiveIndices);
                this.lodBuffers.push(this.app.createStaticShaderBuffer(commandList, model.getData(0, MeshletModelData.PrimitiveIndices),
                    primitiveCount * 4, 4, "PrimitiveIndices"));
                model.destroy();
            }

            // Placeholders: a zeroed MeshInfo, raw buffer, meshlet and primitive.
            let zeros: int[] = [0, 0, 0, 0];
            const placeholderInfo = this.app.createConstantBuffer(MESH_INFO_SIZE, "MeshInfoPlaceholder");
            commandList.writeBuffer(placeholderInfo, Ref(zeros[0]), 16);
            this.placeholders.push(placeholderInfo);
            this.placeholders.push(this.app.createStaticShaderBuffer(commandList, Ref(zeros[0]), 16, 0, "RawPlaceholder"));
            this.placeholders.push(this.app.createStaticShaderBuffer(commandList, Ref(zeros[0]), 16, MESHLET_STRIDE, "MeshletPlaceholder"));
            this.placeholders.push(this.app.createStaticShaderBuffer(commandList, Ref(zeros[0]), 16, 4, "PrimitivePlaceholder"));
            return true;
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(): boolean {
            const shader = "dynamic_lod.hlsl";
            this.ampShader = this.app.createShader(shader, "main_as", ShaderType.Amplification);
            this.meshShader = this.app.createShader(shader, "main_ms", ShaderType.Mesh);
            this.pixelShader = this.app.createShader(shader, "main_ps", ShaderType.Pixel);
            if (!this.ampShader || !this.meshShader || !this.pixelShader) {
                return false;
            }
            // The sample's root signature: CBV(b0), RootConstants(b1, 2), a descriptor table of
            // CBV(b2, 8) and SRV(t0, 32) (vertices, meshlets, unique vertex indices, primitives:
            // 8 each), SRV(t32).
            const layoutDesc = BindingLayoutDesc.create();
            layoutDesc.layoutConstantBuffer(0);
            layoutDesc.layoutPushConstants(1, DRAW_PARAMS_SIZE);
            layoutDesc.layoutConstantBufferArray(2, MAX_LOD_LEVELS);
            layoutDesc.layoutRawBufferSRVArray(0, MAX_LOD_LEVELS);
            layoutDesc.layoutStructuredBufferSRVArray(8, MAX_LOD_LEVELS);
            layoutDesc.layoutRawBufferSRVArray(16, MAX_LOD_LEVELS);
            layoutDesc.layoutStructuredBufferSRVArray(24, MAX_LOD_LEVELS);
            layoutDesc.layoutStructuredBufferSRV(32);
            this.bindingLayout = this.app.createBindingLayout(layoutDesc, ShaderType.All);
            this.constantBuffer = this.app.createConstantBuffer(CONSTANTS_SIZE, "Constants");

            // The sample's camera: at (0, 75, 150), 150 units a second.
            this.camera.init(0.0, 75.0, 150.0);
            this.camera.setMoveSpeed(150.0);

            const commandList = this.app.createCommandList();
            commandList.open();
            const ok = this.loadLods(commandList);
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.releaseResource(commandList.handle);
            if (!ok) {
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

    // -test: checks the last frame, at instance level 2 with LOD colors. The camera starts among the
    // dragons (inside the nearest one); the dragons near it are drawn at the finest LOD (red), the
    // farther ones at coarser LODs (toward green), and the clear color shows between them.
    function checkFrame(app: App, pass: DynamicLodPass): string {
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
        let clear = 0;
        let reddish = 0;
        let yellowish = 0;
        let greenish = 0;
        for (let i = 0; i < width * height; i++) {
            const p = pixels[i] & 0xFFFFFF;
            if (p == background) {
                clear++;
                continue;
            }
            const r = p & 0xFF;
            const g = (p >> 8) & 0xFF;
            const b = (p >> 16) & 0xFF;
            if (r > g + 30) {
                reddish++;
            } else if (g > r + 30) {
                greenish++;
            } else if (r > 60 && g > 60 && b < r / 2) {
                yellowish++;
            }
        }
        console.log(`Clear color ${clear}, reddish (finest LOD) ${reddish}, yellowish ${yellowish}, greenish (coarse LODs) ${greenish}`);
        if (clear < 1000) {
            return `the clear color shows in ${clear} pixels only`;
        }
        if (reddish < 20000) {
            return `the near dragons aren't at the finest LOD: ${reddish} reddish pixels`;
        }
        if (greenish < 500) {
            return `the far dragons aren't at coarser LODs: ${greenish} greenish pixels`;
        }
        return "";
    }

    export function main(argc: int, argv: Ref<string>): int {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("dynamic_lod");

        // -debug: the graphics API's debug layer and NVRHI's validation layer.
        // -test [-testOutput <file>]: render a few frames without a window at instance level 2 and
        // check the last one (see checkFrame).
        // -instanceLevel <n>: start at instance level n (0 by default, as the sample; 2 for -test).
        // UNORM back buffers, as the sample's R8G8B8A8_UNORM.
        let options = AppOptions.UnormBackBuffer;
        let instanceLevel = -1;
        for (let i = 1; i < argc; i++) {
            const arg = Donut_GetArg(argv, i);
            if (arg == "-debug") {
                options = options | AppOptions.DebugRuntime;
            } else if (arg == "-instanceLevel" && i + 1 < argc) {
                i++;
                instanceLevel = parseInt(Donut_GetArg(argv, i));
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

        const pass = new DynamicLodPass(app);
        if (!pass.init()) {
            app.destroy();
            return 1;
        }
        if (instanceLevel < 0 && test) {
            instanceLevel = TEST_LEVEL;
        }
        if (instanceLevel > 0) {
            pass.instanceLevel = instanceLevel;
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
    return DynamicLod.main(argc, argv);
}
