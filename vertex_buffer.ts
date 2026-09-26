// donut_interop.d.ts comes in through input_pass.ts: tslang would load it twice if this
// file referenced it too.
import { InputPass } from "./input_pass";

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

    function radians(degrees: number): number {
        return degrees * Math.PI / 180.0;
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
    function perspProjD3DStyle(verticalFOV: number, aspect: number, zNear: number, zFar: number): number[] {
        const yScale = 1.0 / Math.tan(0.5 * verticalFOV);
        const xScale = yScale / aspect;
        const zScale = 1.0 / (zFar - zNear);
        return [
            xScale, 0.0,    0.0,                    0.0,
            0.0,    yScale, 0.0,                    0.0,
            0.0,    0.0,    zFar * zScale,          1.0,
            0.0,    0.0,    -zNear * zFar * zScale, 0.0,
        ];
    }

    // --- Passes -------------------------------------------------------------------------------

    // Port of Donut-Samples' vertex_buffer.cpp.
    class VertexBufferPass {
        private app: Opaque;
        private vertexShader: Opaque;
        private pixelShader: Opaque;
        private constantBuffer: Opaque;
        private vertexBuffer: Opaque;
        private indexBuffer: Opaque;
        private texture: Opaque;
        private inputLayout: Opaque;
        private bindingLayout: Opaque;
        private bindingSets: Opaque[];
        // Created on the first frame (it depends on the framebuffer layout), dropped on resize.
        private pipeline: Opaque | null;
        private rotation: number;
        // The constant buffer contents, NUM_VIEWS entries of CONSTANT_BUFFER_ENTRY_FLOATS floats.
        private constants: f32[];

        constructor(app: Opaque) {
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
            Donut_SetInformativeWindowTitle(this.app, WINDOW_TITLE);
        }

        onBackBufferResizing(): void {
            const pipeline = this.pipeline;
            if (pipeline) {
                Donut_ReleaseResource(this.app, pipeline);
                this.pipeline = null;
            }
        }

        onRender(frame: Opaque): void {
            const width = Donut_GetFrameWidth(frame);
            const height = Donut_GetFrameHeight(frame);

            let pipeline = this.pipeline;
            if (!pipeline) {
                pipeline = Donut_CreateGraphicsPipelineWithLayouts(this.app, frame, this.vertexShader, this.pixelShader,
                    this.inputLayout, this.bindingLayout);
                this.pipeline = pipeline;
            }

            Donut_ClearColor(frame, 0.0, 0.0, 0.0, 0.0);

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
            Donut_WriteBuffer(Donut_GetFrameCommandList(frame), this.constantBuffer, Ref(this.constants[0]),
                NUM_VIEWS * CONSTANT_BUFFER_ENTRY_SIZE);

            for (let viewIndex = 0; viewIndex < NUM_VIEWS; viewIndex++) {
                Donut_BeginDraw(frame, pipeline);
                // Pick the right binding set for this view.
                Donut_DrawAddBindingSet(frame, this.bindingSets[viewIndex]);
                Donut_DrawSetIndexBuffer(frame, this.indexBuffer);
                // Bind the vertex buffers in reverse order to test the NVRHI implementation of binding slots
                Donut_DrawAddVertexBuffer(frame, this.vertexBuffer, 1, UV_OFFSET);
                Donut_DrawAddVertexBuffer(frame, this.vertexBuffer, 0, 0);

                // Construct the viewport so that all viewports form a grid.
                const viewWidth = width * 0.5;
                const viewHeight = height * 0.5;
                const left = viewWidth * (viewIndex % 2);
                const top = viewHeight * Math.floor(viewIndex / 2);
                Donut_DrawSetViewport(frame, left, top, viewWidth, viewHeight);

                // Draw the model.
                Donut_DrawIndexed(frame, INDEX_COUNT);
            }
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(): boolean {
            this.vertexShader = Donut_CreateShader(this.app, "vertex_buffer.hlsl", "main_vs", ShaderType.Vertex);
            this.pixelShader = Donut_CreateShader(this.app, "vertex_buffer.hlsl", "main_ps", ShaderType.Pixel);

            if (!this.vertexShader || !this.pixelShader) {
                return false;
            }

            this.constantBuffer = Donut_CreateConstantBuffer(this.app, CONSTANT_BUFFER_ENTRY_SIZE * NUM_VIEWS, "ConstantBuffer");

            const layoutDesc = Donut_CreateInputLayoutDesc();
            Donut_AddVertexAttribute(layoutDesc, "POSITION", Format.RGB32_FLOAT, 0, 0, VERTEX_SIZE);
            Donut_AddVertexAttribute(layoutDesc, "UV", Format.RG32_FLOAT, 0, 1, VERTEX_SIZE);
            this.inputLayout = Donut_CreateInputLayout(this.app, layoutDesc, this.vertexShader);

            const commandList = Donut_CreateCommandList(this.app);
            Donut_OpenCommandList(commandList);

            this.vertexBuffer = Donut_CreateStaticVertexBuffer(this.app, commandList, Ref(g_Vertices[0]),
                24 * VERTEX_SIZE, "VertexBuffer");
            this.indexBuffer = Donut_CreateStaticIndexBuffer(this.app, commandList, Ref(g_Indices[0]),
                INDEX_COUNT * 4, "IndexBuffer");

            const texture = Donut_LoadTexture(this.app, commandList, "media/nvidia-logo.png", 1);

            Donut_CloseCommandList(commandList);
            Donut_ExecuteCommandList(this.app, commandList);
            Donut_ReleaseResource(this.app, commandList);

            if (!texture) {
                console.log("Couldn't load the texture");
                return false;
            }
            this.texture = texture;

            // Create a single binding layout and multiple binding sets, one set per view.
            // The different binding sets use different slices of the same constant buffer.
            const sampler = Donut_GetCommonSampler(this.app, CommonSampler.AnisotropicWrap);
            for (let viewIndex = 0; viewIndex < NUM_VIEWS; viewIndex++) {
                const bindingSetDesc = Donut_CreateBindingSetDesc();
                // Note: using viewIndex to construct a buffer range.
                Donut_BindConstantBuffer(bindingSetDesc, 0, this.constantBuffer, CONSTANT_BUFFER_ENTRY_SIZE * viewIndex, CONSTANT_BUFFER_ENTRY_SIZE);
                // Texture and sampler are the same for all model views.
                Donut_BindTextureSRV(bindingSetDesc, 0, this.texture);
                Donut_BindSampler(bindingSetDesc, 0, sampler);

                // Create the binding layout with the first binding set, and use it for the others.
                const bindingSet = viewIndex == 0
                    ? Donut_CreateBindingSet(this.app, bindingSetDesc, ShaderType.All)
                    : Donut_CreateBindingSetForLayout(this.app, bindingSetDesc, this.bindingLayout);
                if (!bindingSet) {
                    console.log("Couldn't create the binding set or layout");
                    return false;
                }
                if (viewIndex == 0) {
                    this.bindingLayout = Donut_GetBindingLayout(bindingSet);
                }
                this.bindingSets.push(bindingSet);
            }

            const pass = Donut_AddPass(this.app);
            Donut_SetAnimateCallback(pass, this.onAnimate);
            Donut_SetBackBufferResizingCallback(pass, this.onBackBufferResizing);
            Donut_SetRenderCallback(pass, this.onRender);
            return true;
        }
    }

    export function main(argc: int, argv: Ref<string>): int {

        const app = Donut_CreateApp(argc, argv, WINDOW_TITLE, 1280, 720);
        if (!app) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        console.log(`Renderer: ${Donut_GetRendererString(app)}`);

        const vertexBuffer = new VertexBufferPass(app);
        if (!vertexBuffer.init()) {
            Donut_DestroyApp(app);
            return 1;
        }

        const input = new InputPass(app);

        Donut_RunApp(app);
        Donut_DestroyApp(app);
        return 0;
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>): int {
    return VertexBuffer.main(argc, argv);
}
