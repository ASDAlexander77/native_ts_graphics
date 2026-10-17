// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";
import { Args } from "../core/args";
import { unsupported } from "../core/test_check";
import { MeshletModel } from "../core/meshlet_model";
import {
    matrixIdentity, matrixLookToRH, matrixMultiply, matrixPerspectiveFovRH, matrixTranspose, XM_PI,
} from "../core/directx_math";

namespace MeshletRender {
    const WINDOW_TITLE = "D3D12 Mesh Shader";
    const MESH_FILE = "media/meshlet_render/Dragon_LOD0.bin";

    // GLFW values, as passed to the keyboard callback.
    const KEY_A = 65;
    const KEY_D = 68;
    const KEY_S = 83;
    const KEY_W = 87;
    const KEY_RIGHT = 262;
    const KEY_LEFT = 263;
    const KEY_DOWN = 264;
    const KEY_UP = 265;
    const ACTION_PRESS = 1;
    const ACTION_RELEASE = 0;

    // SceneConstantBuffer: World, WorldView, WorldViewProj (float4x4 each), DrawMeshlets (uint),
    // 256-byte aligned.
    const CONSTANTS_SIZE = 256;
    const CONSTANT_FLOATS = 48;
    const DRAW_MESHLETS_OFFSET = 192;
    // The mesh shader's vertex records (position, normal) and Meshlet (4 uints).
    const VERTEX_STRIDE = 24;
    const MESHLET_STRIDE = 16;
    // MeshInfo, the sample's root constants: IndexBytes, MeshletOffset.
    const MESH_INFO_SIZE = 8;

    // The sample's clear color, (0, 0.2, 0.4).
    const CLEAR_R = 0.0;
    const CLEAR_G = 0.2;
    const CLEAR_B = 0.4;

    // Test mode: the frames rendered, each 1/60 s.
    const TEST_FRAMES = 3;

    // DirectX-Graphics-Samples' SimpleCamera: WASD move it, the arrow keys turn it (pitch within 45
    // degrees up and down), at its move and turn speeds per second. Escape closes the window, as in
    // the other examples, rather than putting the camera back.
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

        // True if it took the key.
        onKey(key: int, down: boolean): boolean {
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
            if (index < 0) {
                return false;
            }
            this.keys[index] = down ? 1 : 0;
            return true;
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
            // Prevent looking too far up or down.
            const quarterPi = Math.fround(XM_PI / 4.0);
            // Not Math.max: tslang's starts from Number.MIN_VALUE, above any negative number.
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

    // A mesh of the model on the GPU: its buffers, binding set, index size and meshlet subsets.
    class GpuMesh {
        bindingSet: BindingSet;
        indexSize: int;
        // The meshlet subsets: offset, count pairs.
        subsets: int[];

        constructor(bindingSet: BindingSet, indexSize: int, subsets: int[]) {
            this.bindingSet = bindingSet;
            this.indexSize = indexSize;
            this.subsets = subsets;
        }
    }

    // Port of DirectX-Graphics-Samples' D3D12MeshShaders MeshletRender: the Stanford dragon drawn
    // by a mesh shader alone, a group per meshlet of each meshlet subset reading the meshlet's
    // vertices and packed triangles from structured buffers, shaded in a color per meshlet. The
    // sample's back buffer (R8G8B8A8_UNORM) and D32_FLOAT depth buffer are a color target here,
    // blitted into the back buffer.
    class MeshletRenderPass {
        private app: App;
        private meshShader: ShaderHandle;
        private pixelShader: ShaderHandle;
        private bindingLayout: BindingLayoutHandle;
        private constantBuffer: BufferHandle;
        private meshes: GpuMesh[];
        private hasTargets: boolean;
        private colorBuffer: TextureHandle;
        private depthBuffer: TextureHandle;
        private framebuffer: FramebufferHandle;
        private pipeline: MeshletPipelineHandle;
        private constants: f32[];
        private drawMeshlets: int[];
        private meshInfo: int[];
        camera: SimpleCamera;
        // The model's bounding sphere: center, radius.
        boundingSphere: f32[];
        // The last frame's WorldViewProj (row vectors), for the test.
        worldViewProj: number[];

        constructor(app: App) {
            this.app = app;
            this.meshes = [];
            this.hasTargets = false;
            this.constants = [];
            for (let i = 0; i < CONSTANT_FLOATS; i++) {
                this.constants.push(0.0);
            }
            // DrawMeshlets: true.
            this.drawMeshlets = [1];
            this.meshInfo = [0, 0];
            this.camera = new SimpleCamera();
            this.boundingSphere = [0.0, 0.0, 0.0, 0.0];
            this.worldViewProj = matrixIdentity();
        }

        onKey(key: int, scancode: int, action: int, mods: int): int {
            if (action != ACTION_PRESS && action != ACTION_RELEASE) {
                return 0;
            }
            return this.camera.onKey(key, action == ACTION_PRESS) ? 1 : 0;
        }

        // OnUpdate: the camera, then the constants for its view.
        onAnimate(elapsedSeconds: number): void {
            this.app.setInformativeWindowTitle(WINDOW_TITLE);
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

        // The sample's back buffer and depth buffer, and its pipeline state: the default
        // rasterizer state (back faces culled, clockwise front faces), blend state (opaque) and
        // depth state (less, writes).
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

        // OnUpdate's constants: an identity world, the camera's view, a 60 degree perspective at the
        // back buffer's aspect ratio (near 1, far 1000), stored transposed.
        updateConstants(width: int, height: int): void {
            const world = matrixIdentity();
            const view = this.camera.viewMatrix();
            const aspectRatio = Math.fround(width / height);
            const proj = matrixPerspectiveFovRH(Math.fround(XM_PI / 3.0), aspectRatio, 1.0, 1000.0);
            const worldView = matrixMultiply(world, view);
            const worldViewProj = matrixMultiply(worldView, proj);
            this.worldViewProj = worldViewProj;
            const matrices = [matrixTranspose(world), matrixTranspose(worldView), matrixTranspose(worldViewProj)];
            for (let m = 0; m < 3; m++) {
                const matrix = matrices[m];
                for (let i = 0; i < 16; i++) {
                    this.constants[m * 16 + i] = matrix[i];
                }
            }
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
            commandList.writeBufferAt(this.constantBuffer, DRAW_MESHLETS_OFFSET, Ref(this.drawMeshlets[0]), 4);

            commandList.clearTextureFloat(this.colorBuffer, CLEAR_R, CLEAR_G, CLEAR_B, 1.0);
            commandList.clearDepth(this.depthBuffer, 1.0);

            for (const mesh of this.meshes) {
                frame.beginMeshDrawToFramebuffer(this.pipeline, this.framebuffer);
                frame.drawAddBindingSet(mesh.bindingSet);
                this.meshInfo[0] = mesh.indexSize;
                for (let s = 0; s < mesh.subsets.length; s += 2) {
                    this.meshInfo[1] = mesh.subsets[s];
                    frame.drawMeshTasksWithPushConstants(mesh.subsets[s + 1], Ref(this.meshInfo[0]), MESH_INFO_SIZE);
                }
            }

            this.app.blitTexture(frame, this.colorBuffer);
        }

        // Model::LoadFromFile and UploadGpuResources: each mesh's vertices, meshlets, unique vertex
        // indices and primitives in buffers for the mesh shader.
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
            model.copyBoundingSphere(-1, Ref(this.boundingSphere[0]));

            const commandList = this.app.createCommandList();
            commandList.open();
            const meshCount = model.getMeshCount();
            for (let i = 0; i < meshCount; i++) {
                // The mesh shader reads the first vertex buffer as positions and normals.
                if (model.getVertexBufferStride(i, 0) != VERTEX_STRIDE) {
                    console.log(`${MESH_FILE}: vertices of another layout than the mesh shader's`);
                    return false;
                }
                const vertices = this.app.createStaticShaderBuffer(commandList, model.getVertexBufferData(i, 0),
                    model.getVertexBufferSize(i, 0), 0, "Vertices");
                const meshlets = this.app.createStaticShaderBuffer(commandList, model.getData(i, MeshletModelData.Meshlets),
                    model.getDataSize(i, MeshletModelData.Meshlets), MESHLET_STRIDE, "Meshlets");
                // The unique vertex indices, rounded up to whole uints, as the sample's buffer.
                const uniqueSize = model.getDataSize(i, MeshletModelData.UniqueVertexIndices);
                let unique: int[] = [];
                const uniqueInts = Math.floor((uniqueSize + 3) / 4);
                for (let j = 0; j < uniqueInts; j++) {
                    unique.push(0);
                }
                model.copyData(i, MeshletModelData.UniqueVertexIndices, Ref(unique[0]));
                const uniqueVertexIndices = this.app.createStaticShaderBuffer(commandList, Ref(unique[0]), uniqueInts * 4, 0, "UniqueVertexIndices");
                const primitiveIndices = this.app.createStaticShaderBuffer(commandList, model.getData(i, MeshletModelData.PrimitiveIndices),
                    model.getDataSize(i, MeshletModelData.PrimitiveIndices), 4, "PrimitiveIndices");

                const setDesc = BindingSetDesc.create();
                setDesc.bindEntireConstantBuffer(0, this.constantBuffer);
                setDesc.bindPushConstants(1, MESH_INFO_SIZE);
                setDesc.bindRawBufferSRV(0, vertices);
                setDesc.bindStructuredBufferSRV(1, meshlets);
                setDesc.bindRawBufferSRV(2, uniqueVertexIndices);
                setDesc.bindStructuredBufferSRV(3, primitiveIndices);
                const bindingSet = this.app.createBindingSetForLayout(setDesc, this.bindingLayout);

                let subsets: int[] = [];
                const subsetCount = model.getDataCount(i, MeshletModelData.MeshletSubsets);
                for (let j = 0; j < subsetCount * 2; j++) {
                    subsets.push(0);
                }
                model.copyData(i, MeshletModelData.MeshletSubsets, Ref(subsets[0]));
                this.meshes.push(new GpuMesh(bindingSet, model.getIndexSize(i), subsets));
            }
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.releaseResource(commandList.handle);
            model.destroy();
            return true;
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(): boolean {
            this.meshShader = this.app.createShader("meshlet_render.hlsl", "main_ms", ShaderType.Mesh);
            this.pixelShader = this.app.createShader("meshlet_render.hlsl", "main_ps", ShaderType.Pixel);
            if (!this.meshShader || !this.pixelShader) {
                return false;
            }
            // The sample's root signature: CBV(b0), RootConstants(b1, 2), SRV(t0) .. SRV(t3).
            const layoutDesc = BindingLayoutDesc.create();
            layoutDesc.layoutConstantBuffer(0);
            layoutDesc.layoutPushConstants(1, MESH_INFO_SIZE);
            layoutDesc.layoutRawBufferSRV(0);
            layoutDesc.layoutStructuredBufferSRV(1);
            layoutDesc.layoutRawBufferSRV(2);
            layoutDesc.layoutStructuredBufferSRV(3);
            this.bindingLayout = this.app.createBindingLayout(layoutDesc, ShaderType.All);
            this.constantBuffer = this.app.createConstantBuffer(CONSTANTS_SIZE, "SceneConstantBuffer");

            // The sample's camera: at (0, 75, 150) looking down -z, 150 units a second.
            this.camera.init(0.0, 75.0, 150.0);
            this.camera.setMoveSpeed(150.0);

            if (!this.loadModel()) {
                return false;
            }
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

    // -test: checks the last frame. The background is the clear color at the corners; the dragon
    // covers the pixel its bounding sphere's center projects to and between minCoverage and
    // maxCoverage of the frame; its pixels show the meshlet colors (diffuse red 0 for odd meshlets
    // and 1 for even ones, so some covered pixels have no red and others do).
    function checkFrame(app: App, pass: MeshletRenderPass): string {
        const width = app.getWindowWidth();
        const height = app.getWindowHeight();
        let pixels: int[] = [];
        for (let i = 0; i < width * height; i++) {
            pixels.push(0);
        }
        if (app.readBackBufferRGBA8(Ref(pixels[0]), pixels.length) == 0) {
            return "cannot read the back buffer";
        }
        const background = 0 | (51 << 8) | (102 << 16);
        const corners = [0, width - 1, (height - 1) * width, height * width - 1];
        for (let i = 0; i < corners.length; i++) {
            const p = pixels[corners[i]] & 0xFFFFFF;
            if (p != background) {
                return `corner pixel ${corners[i]} is ${p & 0xFF}, ${(p >> 8) & 0xFF}, ${(p >> 16) & 0xFF}, not the clear color`;
            }
        }

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
        if (coverage < 0.05 || coverage > 0.6) {
            return `the dragon covers ${coverage} of the frame`;
        }
        if (noRed < covered / 10 || red < covered / 10) {
            return `no meshlet colors: ${noRed} pixels without red, ${red} with`;
        }

        // The bounding sphere's center through WorldViewProj, to a pixel.
        const c = pass.boundingSphere;
        const m = pass.worldViewProj;
        const x = c[0] * m[0] + c[1] * m[4] + c[2] * m[8] + m[12];
        const y = c[0] * m[1] + c[1] * m[5] + c[2] * m[9] + m[13];
        const w = c[0] * m[3] + c[1] * m[7] + c[2] * m[11] + m[15];
        const px: int = Math.floor((x / w * 0.5 + 0.5) * width);
        const py: int = Math.floor((0.5 - y / w * 0.5) * height);
        if (px < 0 || px >= width || py < 0 || py >= height || (pixels[py * width + px] & 0xFFFFFF) == background) {
            return `the model's center (${px}, ${py}) isn't covered`;
        }
        return "";
    }

    export function main(argc: int, argv: Ref<string>): int {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("meshlet_render");

        // -test [-testOutput <file>]: render a few frames without a window and check the last one
        // (see checkFrame).
        const args = new Args(argc, argv, TEST_FRAMES);
        args.parseArgs();

        // UNORM back buffers, as the sample's R8G8B8A8_UNORM.
        const options = AppOptions.UnormBackBuffer | args.options;

        // The sample's window.
        const app = App.createWithOptions(args.api, WINDOW_TITLE, 1280, 720, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }
        if (app.isFeatureSupported(Feature.Meshlets) == 0) {
            app.destroy();
            return unsupported(args.test, "The graphics device has no mesh shaders");
        }

        const pass = new MeshletRenderPass(app);
        if (!pass.init()) {
            app.destroy();
            return 1;
        }

        const input = new InputPass(app.handle);

        app.run();
        let result = 0;
        if (args.test) {
            result = app.finishTest(checkFrame(app, pass));
        }
        app.destroy();
        return result;
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>): int {
    return MeshletRender.main(argc, argv);
}
