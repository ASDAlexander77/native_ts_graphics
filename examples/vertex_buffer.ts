// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";

namespace VertexBuffer {
    const WINDOW_TITLE = "Donut Example: Vertex Buffer";

    // --- Model --------------------------------------------------------------------------------

    // struct Vertex { float3 position; float2 uv; }
    const VERTEX_FLOATS = 5;
    const VERTEX_SIZE = VERTEX_FLOATS * 4;
    const UV_OFFSET = 3 * 4;

    // `let`, not `const`: tslang takes the address of the array's storage only for non-const arrays.
    let g_Vertices: f32[] = [
        -0.5,  0.5, -0.5,   0.0, 0.0, // front face
         0.5, -0.5, -0.5,   1.0, 1.0,
        -0.5, -0.5, -0.5,   0.0, 1.0,
         0.5,  0.5, -0.5,   1.0, 0.0,

         0.5, -0.5, -0.5,   0.0, 1.0, // right side face
         0.5,  0.5,  0.5,   1.0, 0.0,
         0.5, -0.5,  0.5,   1.0, 1.0,
         0.5,  0.5, -0.5,   0.0, 0.0,

        -0.5,  0.5,  0.5,   0.0, 0.0, // left side face
        -0.5, -0.5, -0.5,   1.0, 1.0,
        -0.5, -0.5,  0.5,   0.0, 1.0,
        -0.5,  0.5, -0.5,   1.0, 0.0,

         0.5,  0.5,  0.5,   0.0, 0.0, // back face
        -0.5, -0.5,  0.5,   1.0, 1.0,
         0.5, -0.5,  0.5,   0.0, 1.0,
        -0.5,  0.5,  0.5,   1.0, 0.0,

        -0.5,  0.5, -0.5,   0.0, 1.0, // top face
         0.5,  0.5,  0.5,   1.0, 0.0,
         0.5,  0.5, -0.5,   1.0, 1.0,
        -0.5,  0.5,  0.5,   0.0, 0.0,

         0.5, -0.5,  0.5,   1.0, 1.0, // bottom face
        -0.5, -0.5, -0.5,   0.0, 0.0,
         0.5, -0.5, -0.5,   1.0, 0.0,
        -0.5, -0.5,  0.5,   0.0, 1.0,
    ];

    let g_Indices: int[] = [
         0,  1,  2,   0,  3,  1, // front face
         4,  5,  6,   4,  7,  5, // left face
         8,  9, 10,   8, 11,  9, // right face
        12, 13, 14,  12, 15, 13, // back face
        16, 17, 18,  16, 19, 17, // top face
        20, 21, 22,  20, 23, 21, // bottom face
    ];
    const INDEX_COUNT = 36;

    const NUM_VIEWS = 4;

    const g_RotationAxes: number[] = [
        1.0, 0.0, 0.0,
        0.0, 1.0, 0.0,
        0.0, 0.0, 1.0,
        1.0, 1.0, 1.0,
    ];

    // This example uses a single large constant buffer with multiple views to draw multiple versions
    // of the same model. The alignment and size of partially bound constant buffers must be a
    // multiple of 256 bytes, so each entry is a float4x4 viewProjMatrix padded to 256 bytes.
    const CONSTANT_BUFFER_ENTRY_SIZE = 256;
    const CONSTANT_BUFFER_ENTRY_FLOATS = CONSTANT_BUFFER_ENTRY_SIZE / 4;

    // --- Math ---------------------------------------------------------------------------------
    // The donut::math functions the C++ sample uses, on row-major 4x4 matrices (16 numbers) with
    // Donut's row-vector convention: `mul(a, b)` applies a, then b.

    // math::radians(float): in float32, as every use in the sample is.
    function radians(degrees: number): number {
        return Math.fround(Math.fround(degrees) * Math.fround(Math.fround(Math.PI) / 180.0));
    }

    function mul(a: number[], b: number[]): number[] {
        // `let`: tslang's push needs a non-const array.
        let r: number[] = [];
        for (let i = 0; i < 4; i++) {
            for (let j = 0; j < 4; j++) {
                let sum = 0.0;
                for (let k = 0; k < 4; k++) {
                    sum += a[i * 4 + k] * b[k * 4 + j];
                }
                r.push(sum);
            }
        }
        return r;
    }

    // math::rotation(normalize(axis), radians): Rodrigues' rotation formula.
    function rotation(ax: number, ay: number, az: number, angle: number): number[] {
        const len = Math.sqrt(ax * ax + ay * ay + az * az);
        const x = ax / len;
        const y = ay / len;
        const z = az / len;
        const s = Math.sin(angle);
        const c = Math.cos(angle);
        const t = 1.0 - c;
        return [
            c + x * x * t,      z * s + x * y * t,  -y * s + x * z * t, 0.0,
            -z * s + y * x * t, c + y * y * t,      x * s + y * z * t,  0.0,
            y * s + z * x * t,  -x * s + z * y * t, c + z * z * t,      0.0,
            0.0,                0.0,                0.0,                1.0,
        ];
    }

    // math::yawPitchRoll(yaw, pitch, roll).
    function yawPitchRoll(yaw: number, pitch: number, roll: number): number[] {
        const sh = Math.sin(yaw);
        const ch = Math.cos(yaw);
        const sp = Math.sin(pitch);
        const cp = Math.cos(pitch);
        const sb = Math.sin(roll);
        const cb = Math.cos(roll);
        return [
            ch * cb + sh * sp * sb,  sb * cp, -sh * cb + ch * sp * sb, 0.0,
            -ch * sb + sh * sp * cb, cb * cp, sb * sh + ch * sp * cb,  0.0,
            sh * cp,                 -sp,     ch * cp,                 0.0,
            0.0,                     0.0,     0.0,                     1.0,
        ];
    }

    // math::translation(float3(x, y, z)).
    function translation(x: number, y: number, z: number): number[] {
        return [
            1.0, 0.0, 0.0, 0.0,
            0.0, 1.0, 0.0, 0.0,
            0.0, 0.0, 1.0, 0.0,
            x,   y,   z,   1.0,
        ];
    }

    // math::perspProjD3DStyle(verticalFOV, aspect, zNear, zFar).
    // In float32 as Donut's (computed in double, the terms differ in the last bit, which moves
    // edges by a pixel here and there).
    function perspProjD3DStyle(verticalFOV: number, aspect: number, zNear: number, zFar: number): number[] {
        const near = Math.fround(zNear);
        const far = Math.fround(zFar);
        const yScale = Math.fround(1.0 / Math.fround(Math.tan(Math.fround(0.5 * Math.fround(verticalFOV)))));
        const xScale = Math.fround(yScale / Math.fround(aspect));
        const zScale = Math.fround(1.0 / Math.fround(far - near));
        return [
            xScale, 0.0,    0.0,                                         0.0,
            0.0,    yScale, 0.0,                                         0.0,
            0.0,    0.0,    Math.fround(far * zScale),                   1.0,
            0.0,    0.0,    Math.fround(Math.fround(-near * far) * zScale), 0.0,
        ];
    }

    // --- Passes -------------------------------------------------------------------------------

    // Port of Donut-Samples' vertex_buffer.cpp.
    class VertexBufferPass {
        private app: App;
        private vertexShader: Opaque;
        private pixelShader: Opaque;
        private constantBuffer: Opaque;
        private vertexBuffer: Opaque;
        private indexBuffer: Opaque;
        private texture: Opaque;
        private inputLayout: Opaque;
        private bindingLayout: Opaque;
        private bindingSets: BindingSet[];
        // Created on the first frame (it depends on the framebuffer layout), dropped on resize.
        private pipeline: Opaque | null;
        private rotation: number;
        // The constant buffer contents, NUM_VIEWS entries of CONSTANT_BUFFER_ENTRY_FLOATS floats.
        private constants: f32[];

        constructor(app: App) {
            this.app = app;
            this.bindingSets = [];
            this.pipeline = null;
            this.rotation = 0.0;
            this.constants = [];
            for (let i = 0; i < NUM_VIEWS * CONSTANT_BUFFER_ENTRY_FLOATS; i++) {
                this.constants.push(0.0);
            }
        }

        onAnimate(seconds: number): void {
            this.rotation += seconds * 1.1;
            this.app.setInformativeWindowTitle(WINDOW_TITLE);
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
            const width = frame.getWidth();
            const height = frame.getHeight();

            let pipeline = this.pipeline;
            if (!pipeline) {
                pipeline = this.app.createGraphicsPipelineWithLayouts(frame, this.vertexShader, this.pixelShader,
                    this.inputLayout, this.bindingLayout);
                this.pipeline = pipeline;
            }

            frame.clearColor(0.0, 0.0, 0.0, 0.0);

            // Fill out the constant buffer slices for multiple views of the model.
            for (let viewIndex = 0; viewIndex < NUM_VIEWS; viewIndex++) {
                const viewMatrix = mul(mul(
                    rotation(g_RotationAxes[viewIndex * 3], g_RotationAxes[viewIndex * 3 + 1], g_RotationAxes[viewIndex * 3 + 2], this.rotation),
                    yawPitchRoll(0.0, radians(-30.0), 0.0)),
                    translation(0.0, 0.0, 2.0));
                const projMatrix = perspProjD3DStyle(radians(60.0), width / height, 0.1, 10.0);
                const viewProjMatrix = mul(viewMatrix, projMatrix);

                for (let i = 0; i < 16; i++) {
                    this.constants[viewIndex * CONSTANT_BUFFER_ENTRY_FLOATS + i] = viewProjMatrix[i];
                }
            }

            // Upload all constant buffer slices at once.
            frame.getCommandList().writeBuffer(this.constantBuffer, Ref(this.constants[0]),
                NUM_VIEWS * CONSTANT_BUFFER_ENTRY_SIZE);

            for (let viewIndex = 0; viewIndex < NUM_VIEWS; viewIndex++) {
                frame.beginDraw(pipeline);
                // Pick the right binding set for this view.
                frame.drawAddBindingSet(this.bindingSets[viewIndex]);
                frame.drawSetIndexBuffer(this.indexBuffer);
                // Bind the vertex buffers in reverse order to test the NVRHI implementation of binding slots
                frame.drawAddVertexBuffer(this.vertexBuffer, 1, UV_OFFSET);
                frame.drawAddVertexBuffer(this.vertexBuffer, 0, 0);

                // Construct the viewport so that all viewports form a grid.
                const viewWidth = width * 0.5;
                const viewHeight = height * 0.5;
                const left = viewWidth * (viewIndex % 2);
                const top = viewHeight * Math.floor(viewIndex / 2);
                frame.drawSetViewport(left, top, viewWidth, viewHeight);

                // Draw the model.
                frame.drawIndexed(INDEX_COUNT);
            }
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(): boolean {
            this.vertexShader = this.app.createShader("vertex_buffer.hlsl", "main_vs", ShaderType.Vertex);
            this.pixelShader = this.app.createShader("vertex_buffer.hlsl", "main_ps", ShaderType.Pixel);

            if (!this.vertexShader || !this.pixelShader) {
                return false;
            }

            this.constantBuffer = this.app.createConstantBuffer(CONSTANT_BUFFER_ENTRY_SIZE * NUM_VIEWS, "ConstantBuffer");

            const layoutDesc = InputLayoutDesc.create();
            layoutDesc.addVertexAttribute("POSITION", Format.RGB32_FLOAT, 0, 0, VERTEX_SIZE);
            layoutDesc.addVertexAttribute("UV", Format.RG32_FLOAT, 0, 1, VERTEX_SIZE);
            this.inputLayout = this.app.createInputLayout(layoutDesc, this.vertexShader);

            const commandList = this.app.createCommandList();
            commandList.open();

            this.vertexBuffer = this.app.createStaticVertexBuffer(commandList, Ref(g_Vertices[0]),
                24 * VERTEX_SIZE, "VertexBuffer");
            this.indexBuffer = this.app.createStaticIndexBuffer(commandList, Ref(g_Indices[0]),
                INDEX_COUNT * 4, "IndexBuffer");

            const texture = this.app.loadTexture(commandList, "media/nvidia-logo.png", 1);

            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.releaseResource(commandList.handle);

            if (!texture) {
                console.log("Couldn't load the texture");
                return false;
            }
            this.texture = texture;

            // Create a single binding layout and multiple binding sets, one set per view.
            // The different binding sets use different slices of the same constant buffer.
            const sampler = this.app.getCommonSampler(CommonSampler.AnisotropicWrap);
            for (let viewIndex = 0; viewIndex < NUM_VIEWS; viewIndex++) {
                const bindingSetDesc = BindingSetDesc.create();
                // Note: using viewIndex to construct a buffer range.
                bindingSetDesc.bindConstantBuffer(0, this.constantBuffer, CONSTANT_BUFFER_ENTRY_SIZE * viewIndex, CONSTANT_BUFFER_ENTRY_SIZE);
                // Texture and sampler are the same for all model views.
                bindingSetDesc.bindTextureSRV(0, this.texture);
                bindingSetDesc.bindSampler(0, sampler);

                // Create the binding layout with the first binding set, and use it for the others.
                const bindingSet = viewIndex == 0
                    ? this.app.createBindingSet(bindingSetDesc, ShaderType.All)
                    : this.app.createBindingSetForLayout(bindingSetDesc, this.bindingLayout);
                if (bindingSet.isNull()) {
                    console.log("Couldn't create the binding set or layout");
                    return false;
                }
                if (viewIndex == 0) {
                    this.bindingLayout = bindingSet.getBindingLayout();
                }
                this.bindingSets.push(bindingSet);
            }

            const pass = this.app.addPass();
            pass.setAnimateCallback(this.onAnimate);
            pass.setBackBufferResizingCallback(this.onBackBufferResizing);
            pass.setRenderCallback(this.onRender);
            return true;
        }
    }

    export function main(argc: int, argv: Ref<string>): int {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("vertex_buffer");

        // -debug: the graphics API's debug layer and NVRHI's validation layer.
        let options = AppOptions.None;
        for (let i = 1; i < argc; i++) {
            if (Donut_GetArg(argv, i) == "-debug") {
                options = AppOptions.DebugRuntime;
            }
        }

        const api = Donut_GetGraphicsAPIFromCommandLine(argc, argv);
        const app = App.createWithOptions(api, WINDOW_TITLE, 1280, 720, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        const vertexBuffer = new VertexBufferPass(app);
        if (!vertexBuffer.init()) {
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
    return VertexBuffer.main(argc, argv);
}
