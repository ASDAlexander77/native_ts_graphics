// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";
import { Args } from "../core/args";

namespace BufferDeviceAddress {
    const WINDOW_TITLE = "Donut Example: Buffer Device Address";

    // The sample's meshes: 64 of 16 x 16 vertices (float2 positions), drawn as triangle strips, 15
    // strips of 2 x 16 indices each closed by a primitive restart index.
    const MESH_COUNT = 64;
    const MESH_WIDTH = 16;
    const MESH_HEIGHT = 16;
    const MESH_STRIPS = MESH_HEIGHT - 1;
    const MESH_INDICES_PER_STRIP = 2 * MESH_WIDTH;
    const MESH_NUM_INDICES = MESH_STRIPS * (MESH_INDICES_PER_STRIP + 1);
    const PRIMITIVE_RESTART = 0xFFFF;
    // A VkDeviceAddress, and a float2.
    const ADDRESS_SIZE = 8;
    const POSITION_SIZE = 8;

    // PushCompute { VkDeviceAddress table; float fract_time; } (16 bytes with its padding) and
    // PushVertex { glm::mat4 view_projection; VkDeviceAddress table; } (72 bytes), as floats; the
    // addresses' 8 bytes go in two of them.
    const PUSH_COMPUTE_FLOATS = 4;
    const PUSH_VERTEX_FLOATS = 18;

    // update_meshlets' dispatch: 8 x 8 threads a group, 2 x 2 groups a mesh, a mesh per z.
    const GROUPS_X = MESH_WIDTH / 8;
    const GROUPS_Y = MESH_HEIGHT / 8;

    // The render pass's clear color.
    const CLEAR_R = 0.033;
    const CLEAR_G = 0.073;
    const CLEAR_B = 0.133;

    // Test mode: the frames rendered, each 1/60 s.
    const TEST_FRAMES = 60;

    // --- Math (glm's, in float32: 4 x 4 matrices by columns) ---------------------------------

    function multiply(a: number[], b: number[]): number[] {
        let result: number[] = [];
        for (let column = 0; column < 4; column++) {
            for (let row = 0; row < 4; row++) {
                let sum = Math.fround(a[row] * b[column * 4]);
                for (let k = 1; k < 4; k++) {
                    sum = Math.fround(sum + Math.fround(a[k * 4 + row] * b[column * 4 + k]));
                }
                result.push(sum);
            }
        }
        return result;
    }

    // glm::perspective (right-handed, depth from 0 to 1, as the samples build glm).
    function perspective(fovy: number, aspect: number, zNear: number, zFar: number): number[] {
        const tanHalfFovy = Math.fround(Math.tan(Math.fround(fovy / 2.0)));
        const near = Math.fround(zNear);
        const far = Math.fround(zFar);
        return [
            Math.fround(1.0 / Math.fround(Math.fround(aspect) * tanHalfFovy)), 0.0, 0.0, 0.0,
            0.0, Math.fround(1.0 / tanHalfFovy), 0.0, 0.0,
            0.0, 0.0, Math.fround(far / Math.fround(near - far)), -1.0,
            0.0, 0.0, -Math.fround(Math.fround(far * near) / Math.fround(far - near)), 0.0,
        ];
    }

    // glm::lookAt from (0, 0, 5) at the origin, y up: a translation by -5 along z.
    function lookAtOriginFromZ5(): number[] {
        return [
            1.0, 0.0, 0.0, 0.0,
            0.0, 1.0, 0.0, 0.0,
            0.0, 0.0, 1.0, 0.0,
            0.0, 0.0, -5.0, 1.0,
        ];
    }

    // --- Pass -------------------------------------------------------------------------------

    // Port of Vulkan-Samples' buffer_device_address: 64 meshes animated by a compute shader and
    // drawn instanced, every one of them in a buffer that the shaders reach only through its device
    // address (a GPU pointer). A table of the 64 addresses is uploaded every frame, and its own
    // address goes in push constants: no descriptor sets, no vertex buffers. The vertex shader loads
    // its instance's mesh address from the table and its vertex by index. Vulkan only: D3D shaders
    // have no pointers.
    class BufferDeviceAddressPass {
        private app: App;
        private meshBuffers: BufferHandle[];
        private pointerBuffer: BufferHandle;
        private indexBuffer: BufferHandle;
        private computeShader: ShaderHandle;
        private vertexShader: ShaderHandle;
        private pixelShader: ShaderHandle;
        private computeBindingLayout: BindingLayoutHandle;
        private computeBindingSet: BindingSet;
        private computePipeline: ComputePipelineHandle;
        private vertexBindingLayout: BindingLayoutHandle;
        private vertexBindingSet: BindingSet;
        private pipeline: GraphicsPipelineHandle | null;

        // The meshes' addresses (two ints each), the push constants, the animation time.
        private pointers: int[];
        private pushCompute: f32[];
        private pushVertex: f32[];
        private accumulatedTime: number;

        // -time: the animation time, fixed.
        fixedTime: number;

        constructor(app: App) {
            this.app = app;
            this.meshBuffers = [];
            this.pipeline = null;
            this.pointers = [];
            for (let i = 0; i < MESH_COUNT * 2; i++) {
                this.pointers.push(0);
            }
            this.pushCompute = [];
            for (let i = 0; i < PUSH_COMPUTE_FLOATS; i++) {
                this.pushCompute.push(0.0);
            }
            this.pushVertex = [];
            for (let i = 0; i < PUSH_VERTEX_FLOATS; i++) {
                this.pushVertex.push(0.0);
            }
            this.accumulatedTime = 0.0;
            this.fixedTime = -1.0;
        }

        // render: the time advances 0.2 a second, kept to a fraction.
        onAnimate(elapsedSeconds: number): void {
            this.app.setInformativeWindowTitle(WINDOW_TITLE);
            this.accumulatedTime = Math.fround(this.accumulatedTime + Math.fround(0.2 * Math.fround(elapsedSeconds)));
            this.accumulatedTime = Math.fround(this.accumulatedTime - Math.floor(this.accumulatedTime));
            if (this.fixedTime >= 0.0) {
                this.accumulatedTime = Math.fround(this.fixedTime);
            }
        }

        onBackBufferResizing(): void {
            const pipeline = this.pipeline;
            if (pipeline) {
                this.app.releaseResource(pipeline);
                this.pipeline = null;
            }
        }

        onRender(frameHandle: FrameHandle): void {
            const frame = new Frame(frameHandle);
            const commandList = frame.getCommandList();
            const width = frame.getWidth();
            const height = frame.getHeight();
            if (!this.pipeline) {
                // The sample's pipeline: triangle strips with primitive restart, no culling, no
                // depth test, no vertex attributes.
                const desc = GraphicsPipelineDesc.create(this.vertexShader, this.pixelShader);
                desc.addBindingLayout(this.vertexBindingLayout);
                desc.setPrimitiveType(PrimitiveType.TriangleStrip);
                desc.setPrimitiveRestart(Format.R16_UINT);
                desc.setRasterState(CullMode.None, FillMode.Solid, 0);
                desc.setDepthState(0, 0, ComparisonFunc.Always);
                this.pipeline = this.app.createGraphicsPipelineFromDescForFrame(desc, frame);
            }
            const pipeline = this.pipeline;
            if (!pipeline) {
                return;
            }

            // update_pointer_buffer: the table of the meshes' addresses, uploaded every frame.
            commandList.writeBuffer(this.pointerBuffer, Ref(this.pointers[0]), MESH_COUNT * ADDRESS_SIZE);
            commandList.setBufferState(this.pointerBuffer, ResourceState.ShaderResource);
            for (let i = 0; i < MESH_COUNT; i++) {
                commandList.setBufferState(this.meshBuffers[i], ResourceState.UnorderedAccess);
            }
            commandList.commitBarriers();

            // update_meshlets: the compute shader writes every mesh through its address. NVRHI
            // doesn't see those accesses: the barriers before and after are explicit.
            Donut_CopyBufferDeviceAddress(this.pointerBuffer, Ref(this.pushCompute[0]));
            this.pushCompute[2] = this.accumulatedTime;
            commandList.dispatchWithPushConstants(this.computePipeline, this.computeBindingSet, Ref(this.pushCompute[0]),
                PUSH_COMPUTE_FLOATS * 4, GROUPS_X, GROUPS_Y, MESH_COUNT);
            for (let i = 0; i < MESH_COUNT; i++) {
                commandList.setBufferState(this.meshBuffers[i], ResourceState.ShaderResource);
            }
            commandList.commitBarriers();

            // The render pass: an ad-hoc perspective (90 degrees, depth 1 to 100) from (0, 0, 5),
            // its clip y negated for Donut, and the table's address; a mesh per instance.
            const projection = perspective(Math.fround(0.5 * Math.fround(Math.PI)), Math.fround(Math.fround(width) / Math.fround(height)), 1.0, 100.0);
            const viewProjection = multiply(projection, lookAtOriginFromZ5());
            for (let i = 0; i < 16; i++) {
                this.pushVertex[i] = i % 4 == 1 ? -viewProjection[i] : viewProjection[i];
            }
            Donut_CopyBufferDeviceAddress(this.pointerBuffer, Ref(this.pushVertex[16]));
            frame.clearColor(CLEAR_R, CLEAR_G, CLEAR_B, 1.0);
            frame.beginDraw(pipeline);
            frame.drawAddBindingSet(this.vertexBindingSet);
            frame.drawSetIndexBuffer16(this.indexBuffer);
            frame.drawIndexedInstancedWithPushConstants(MESH_NUM_INDICES, MESH_COUNT, Ref(this.pushVertex[0]), PUSH_VERTEX_FLOATS * 4);
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(): boolean {
            const shader = "buffer_device_address.hlsl";
            this.computeShader = this.app.createShaderWithDefine(shader, "update_vbo_cs", ShaderType.Compute, "UPDATE_VBO", "1");
            this.vertexShader = this.app.createShader(shader, "render_vs", ShaderType.Vertex);
            this.pixelShader = this.app.createShader(shader, "render_ps", ShaderType.Pixel);
            if (!this.computeShader || !this.vertexShader || !this.pixelShader) {
                return false;
            }

            // create_vbo_buffers: the meshes' buffers, which the shaders write and read only through
            // their device addresses, and the table of those addresses.
            for (let i = 0; i < MESH_COUNT; i++) {
                const buffer = this.app.createRWStructuredBuffer(POSITION_SIZE, MESH_WIDTH * MESH_HEIGHT, `Mesh${i}`);
                this.meshBuffers.push(buffer);
                Donut_CopyBufferDeviceAddress(buffer, Ref(this.pointers[i * 2]));
            }
            this.pointerBuffer = this.app.createRWStructuredBuffer(ADDRESS_SIZE, MESH_COUNT, "PointerBuffer");

            // create_index_buffer: the strips' 16-bit indices, two to an int.
            let indices16: int[] = [];
            for (let strip = 0; strip < MESH_STRIPS; strip++) {
                for (let x = 0; x < MESH_WIDTH; x++) {
                    indices16.push(strip * MESH_WIDTH + x);
                    indices16.push((strip + 1) * MESH_WIDTH + x);
                }
                indices16.push(PRIMITIVE_RESTART);
            }
            if (indices16.length % 2 != 0) {
                indices16.push(0);
            }
            let indices: int[] = [];
            for (let i = 0; i < indices16.length; i += 2) {
                indices.push(indices16[i] | (indices16[i + 1] << 16));
            }
            const commandList = this.app.createCommandList();
            commandList.open();
            this.indexBuffer = this.app.createStaticIndexBuffer(commandList, Ref(indices[0]), indices.length * 4, "Indices");
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.releaseResource(commandList.handle);

            // The pipelines' layouts: push constants only.
            const computeLayoutDesc = BindingLayoutDesc.create();
            computeLayoutDesc.layoutPushConstants(0, PUSH_COMPUTE_FLOATS * 4);
            this.computeBindingLayout = this.app.createBindingLayout(computeLayoutDesc, ShaderType.Compute);
            const computeSetDesc = BindingSetDesc.create();
            computeSetDesc.bindPushConstants(0, PUSH_COMPUTE_FLOATS * 4);
            this.computeBindingSet = this.app.createBindingSetForLayout(computeSetDesc, this.computeBindingLayout);
            this.computePipeline = this.app.createComputePipelineWithLayout(this.computeShader, this.computeBindingLayout);

            const vertexLayoutDesc = BindingLayoutDesc.create();
            vertexLayoutDesc.layoutPushConstants(0, PUSH_VERTEX_FLOATS * 4);
            this.vertexBindingLayout = this.app.createBindingLayout(vertexLayoutDesc, ShaderType.Vertex);
            const vertexSetDesc = BindingSetDesc.create();
            vertexSetDesc.bindPushConstants(0, PUSH_VERTEX_FLOATS * 4);
            this.vertexBindingSet = this.app.createBindingSetForLayout(vertexSetDesc, this.vertexBindingLayout);

            const pass = this.app.addPass();
            pass.setAnimateCallback(this.onAnimate);
            pass.setBackBufferResizingCallback(this.onBackBufferResizing);
            pass.setRenderCallback(this.onRender);
            return true;
        }
    }

    // -test: checks the last frame: the corners are the clear color; the meshes (in their red,
    // green and dark checkers) cover a good part of the frame.
    function checkFrame(app: App): string {
        const width = app.getWindowWidth();
        const height = app.getWindowHeight();
        let pixels: int[] = [];
        for (let i = 0; i < width * height; i++) {
            pixels.push(0);
        }
        if (app.readBackBufferRGBA8(Ref(pixels[0]), pixels.length) == 0) {
            return "cannot read the back buffer";
        }
        const corner = pixels[0] & 0xFFFFFF;
        let covered = 0;
        let colorful = 0;
        for (let i = 0; i < width * height; i++) {
            const p = pixels[i] & 0xFFFFFF;
            if (p == corner) {
                continue;
            }
            covered++;
            const r = p & 0xFF;
            const g = (p >> 8) & 0xFF;
            const b = (p >> 16) & 0xFF;
            if (r > b + 40 || g > b + 40) {
                colorful++;
            }
        }
        const coverage = covered / (width * height);
        console.log(`Coverage ${coverage}, colorful ${colorful / (width * height)}`);
        if (coverage < 0.2) {
            return `the meshes cover ${coverage} of the frame`;
        }
        if (colorful < covered / 4) {
            return "the meshes don't have their red and green colors";
        }
        return "";
    }

    class BufferDeviceAddressArgs extends Args {
        // -time <t>: the animation time fixed at t (a fraction).
        fixedTime = -1.0;

        protected parseOptions(): void {
            for (let i = 1; i < this.argc; i++) {
                const arg = this[i];
                if (arg == "-time" && i + 1 < this.argc) {
                    this.fixedTime = parseFloat(this[i + 1]);
                    i++;
                }
            }
        }
    }

    export function main(argc: int, argv: Ref<string>): int {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("buffer_device_address");

        // -test [-testOutput <file>]: render 60 frames (at 60 a second) without a window and check
        // the last one (see checkFrame).
        const args = new BufferDeviceAddressArgs();
        args.parseArgs(argc, argv, TEST_FRAMES);

        // Device addresses are Vulkan's.
        if (args.api != GraphicsAPI.VULKAN) {
            console.log("The Buffer Device Address example can only run on Vulkan API.");
            return 1;
        }
        const app = App.createWithOptions(args.api, WINDOW_TITLE, 1280, 720, args.options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }
        if (app.hasBufferDeviceAddress() == 0) {
            console.log("The device doesn't support buffer device addresses (bufferDeviceAddress).");
            app.destroy();
            return 1;
        }

        const pass = new BufferDeviceAddressPass(app);
        pass.fixedTime = args.fixedTime;
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
function main(argc: int, argv: Ref<string>): int {
    return BufferDeviceAddress.main(argc, argv);
}
