// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";
import { Args } from "../core/args";
import { dot3, matrixInverse, matrixLookToRH, matrixMultiply, matrixPerspectiveFovRH, XM_PI } from "../core/directx_math";
import {
    KEY_A, KEY_D, KEY_S, KEY_W, KEY_RIGHT, KEY_LEFT, KEY_DOWN, KEY_UP, ACTION_RELEASE, ACTION_PRESS,
} from "../core/glfw_input";

namespace NBodyGravity {
    const WINDOW_TITLE = "D3D12 n-Body Gravity Simulation";

    // The sample's particles: two groups of 5000 in spheres of radius 400, 200 left and right of the
    // middle. The step's thread groups take 128 each: the buffers have room for 79 groups, the
    // elements past the particles zero (the sample's out of bounds reads).
    const PARTICLE_COUNT = 10000;
    const PARTICLE_SPREAD = 400.0;
    const BLOCK_SIZE = 128;
    const GROUP_COUNT = 79;
    const PARTICLE_STRIDE = 32;

    // The push constants: the draw's world-view-projection and inverse view matrices; the step's
    // particle count, group count, time step and damping.
    const DRAW_CONSTANT_FLOATS = 32;
    const STEP_CONSTANT_FLOATS = 8;

    // The sample's clear color, (0, 0, 0.1, 0).
    const CLEAR_B = 0.1;

    // Simulation steps per frame: the sample's compute thread steps as fast as the GPU lets it
    // (about 27 per 60 Hz frame on the GPU it was compared on).
    const DEFAULT_STEPS_PER_FRAME = 10;

    // Test mode: the frames rendered (200 steps at the default steps per frame).
    const TEST_FRAMES = 20;

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

        init(x: number, y: number, z: number) {
            this.initialPosition = [Math.fround(x), Math.fround(y), Math.fround(z), 0.0];
            this.reset();
        }

        setMoveSpeed(unitsPerSecond: number) {
            this.moveSpeed = Math.fround(unitsPerSecond);
        }

        reset() {
            this.position = [this.initialPosition[0], this.initialPosition[1], this.initialPosition[2], 0.0];
            this.yaw = XM_PI;
            this.pitch = 0.0;
            this.lookDirection = [0.0, 0.0, -1.0, 0.0];
        }

        // True if it took the key.
        onKey(key: int, down: boolean) {
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

        update(elapsedSeconds: number) {
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

        viewMatrix() {
            return matrixLookToRH(this.position, this.lookDirection, [0.0, 1.0, 0.0, 0.0]);
        }
    }

    // The C runtime's rand() as MSVC's has it, seeded with srand(0) as the sample does for each
    // group, and the sample's RandomPercent over it, in float: -1 to 1.
    class Rand {
        private state: number;

        constructor() {
            this.state = 0;
        }

        next() {
            this.state = (this.state * 214013 + 2531011) % 4294967296;
            return Math.floor(this.state / 65536) & 0x7FFF;
        }

        percent() {
            const value = Math.fround((this.next() % 10000) - 5000);
            return Math.fround(value / 5000.0);
        }
    }

    // The sample's LoadParticles: count particles at random within a sphere of radius spread around
    // (centerX, 0, 0), their mass (10000 * 10000) in position.w, all moving along z at velocityZ.
    function loadParticles(data: f32[], first: int, count: int, centerX: number, velocityZ: number, spread: number) {
        const rand = new Rand();
        const spreadSquared = Math.fround(spread * spread);
        for (let i = 0; i < count; i++) {
            let delta = [spread, spread, spread, 0.0];
            while (dot3(delta, delta) > spreadSquared) {
                const x = Math.fround(rand.percent() * spread);
                const y = Math.fround(rand.percent() * spread);
                const z = Math.fround(rand.percent() * spread);
                delta = [x, y, z, 0.0];
            }
            const base = (first + i) * 8;
            data[base] = Math.fround(centerX + delta[0]);
            data[base + 1] = delta[1];
            data[base + 2] = delta[2];
            data[base + 3] = 100000000.0;
            data[base + 4] = 0.0;
            data[base + 5] = 0.0;
            data[base + 6] = velocityZ;
            data[base + 7] = Math.fround(1.0 / 100000000.0);
        }
    }

    // Port of DirectX-Graphics-Samples' D3D12nBodyGravity: two clusters of 5000 particles, every
    // particle pulling on every other (an n-body simulation in a compute shader), drawn as additive
    // point sprites, yellow turning red with their acceleration. The sample steps the simulation on
    // a compute queue from a CPU thread of its own, as fast as the GPU lets it, ping-ponging between
    // two particle buffers while the graphics queue draws the latest; here each frame steps it a set
    // number of times (-steps) on the compute queue and the frame's draw waits for that (on the
    // frame's command list where there's no compute queue). The camera is the sample's SimpleCamera,
    // moved by a tenth of a second per frame as the sample's.
    class NBodyGravityPass {
        private app: App;
        private vertexShader: ShaderHandle;
        private geometryShader: ShaderHandle;
        private pixelShader: ShaderHandle;
        private inputLayout: InputLayoutHandle;
        private drawBindingLayout: BindingLayoutHandle;
        private stepPipeline: ComputePipelineHandle;
        private computeCommandList: CommandList | null;
        private vertexBuffer: BufferHandle;
        // Per particle buffer: the step reading it (writing the other), and the draw reading it.
        private stepBindingSets: BindingSet[];
        private drawBindingSets: BindingSet[];
        // The particle buffer the next step reads and the draw shows (the sample's m_srvIndex).
        private srvIndex: int;
        stepsPerFrame: int;
        private camera: SimpleCamera;

        // A framebuffer per back buffer, for the back buffers' size, and the pipeline made for them.
        private framebuffers: FramebufferHandle[];
        private targetWidth: int;
        private targetHeight: int;
        private pipeline: GraphicsPipelineHandle;
        private pipelineCreated: boolean;

        // Upload buffers.
        private drawConstants: f32[];
        private stepConstants: f32[];

        constructor(app: App) {
            this.app = app;
            this.computeCommandList = null;
            this.stepBindingSets = [];
            this.drawBindingSets = [];
            this.srvIndex = 0;
            this.stepsPerFrame = DEFAULT_STEPS_PER_FRAME;
            this.camera = new SimpleCamera();
            this.framebuffers = [];
            this.targetWidth = 0;
            this.targetHeight = 0;
            this.pipelineCreated = false;
            this.drawConstants = [];
            for (let i = 0; i < DRAW_CONSTANT_FLOATS; i++) {
                this.drawConstants.push(0.0);
            }
            // The sample's cbCS: param (particle count, group count), paramf (time step, damping).
            this.stepConstants = [PARTICLE_COUNT, GROUP_COUNT, 0.0, 0.0, 0.1, 1.0, 0.0, 0.0];
        }

        onKey(key: int, scancode: int, action: int, mods: int): int {
            if (action != ACTION_PRESS && action != ACTION_RELEASE) {
                return 0;
            }
            return this.camera.onKey(key, action == ACTION_PRESS) ? 1 : 0;
        }

        // OnUpdate: the camera, by a tenth of a second whatever the frame time (as the sample's).
        onAnimate(elapsedSeconds: number) {
            this.app.setInformativeWindowTitle(WINDOW_TITLE);
            this.camera.update(Math.fround(0.1));
        }

        // The framebuffers of the back buffers go before the back buffers do.
        onBackBufferResizing() {
            for (const framebuffer of this.framebuffers) {
                this.app.releaseResource(framebuffer);
            }
            this.framebuffers = [];
            this.targetWidth = 0;
            this.targetHeight = 0;
        }

        // The sample's pipeline state: points the geometry shader makes quads of, back faces culled,
        // blended additively by the sprites' alpha (alpha written as 0), no depth.
        createTargets(width: int, height: int) {
            this.onBackBufferResizing();
            const count = this.app.getBackBufferCount();
            for (let i = 0; i < count; i++) {
                this.framebuffers.push(this.app.createFramebuffer(this.app.getBackBuffer(i), null));
            }
            if (!this.pipelineCreated) {
                const desc = GraphicsPipelineDesc.create(this.vertexShader, this.pixelShader);
                desc.setGeometryShader(this.geometryShader);
                desc.setInputLayout(this.inputLayout);
                desc.addBindingLayout(this.drawBindingLayout);
                desc.setPrimitiveType(PrimitiveType.PointList);
                desc.setDepthState(0, 0, ComparisonFunc.Always);
                desc.setRasterState(CullMode.Back, FillMode.Solid, 0);
                desc.setBlendState(1, BlendFactor.SrcAlpha, BlendFactor.One, BlendOp.Add, BlendFactor.Zero, BlendFactor.Zero, BlendOp.Add);
                this.pipeline = this.app.createGraphicsPipelineFromDesc(desc, this.framebuffers[0]);
                this.pipelineCreated = true;
            }
            this.targetWidth = width;
            this.targetHeight = height;
        }

        // The sample's Simulate, stepsPerFrame times: each step reads one particle buffer and writes
        // the other, which the next step reads.
        recordSteps(commandList: CommandList) {
            for (let i = 0; i < this.stepsPerFrame; i++) {
                commandList.dispatchWithPushConstants(this.stepPipeline, this.stepBindingSets[this.srvIndex],
                    Ref(this.stepConstants[0]), STEP_CONSTANT_FLOATS * 4, GROUP_COUNT, 1, 1);
                this.srvIndex = 1 - this.srvIndex;
            }
        }

        // OnRender: the steps, then the particles from the buffer the last step wrote.
        onRender(frameHandle: FrameHandle) {
            const frame = new Frame(frameHandle);
            const width = frame.getWidth();
            const height = frame.getHeight();
            const commandList = frame.getCommandList();
            if (this.targetWidth != width || this.targetHeight != height) {
                this.createTargets(width, height);
            }

            const computeCommandList = this.computeCommandList;
            if (computeCommandList) {
                computeCommandList.open();
                this.recordSteps(computeCommandList);
                computeCommandList.close();
                this.app.executeFrameComputeWork(frame, computeCommandList);
            } else {
                this.recordSteps(commandList);
            }

            // OnUpdate's constant buffer: view * projection, and the view's inverse (row vectors, as
            // the shaders' row_major matrices take them).
            const view = this.camera.viewMatrix();
            const aspectRatio = Math.fround(Math.fround(width) / Math.fround(height));
            const projection = matrixPerspectiveFovRH(Math.fround(0.8), aspectRatio, 1.0, 5000.0);
            const worldViewProjection = matrixMultiply(view, projection);
            const inverseView = matrixInverse(view);
            for (let k = 0; k < 16; k++) {
                this.drawConstants[k] = worldViewProjection[k];
                this.drawConstants[16 + k] = inverseView[k];
            }

            const index = this.app.getCurrentBackBufferIndex();
            commandList.clearTextureFloat(this.app.getBackBuffer(index), 0.0, 0.0, CLEAR_B, 0.0);
            frame.beginDrawToFramebuffer(this.pipeline, this.framebuffers[index]);
            frame.drawAddBindingSet(this.drawBindingSets[this.srvIndex]);
            frame.drawAddVertexBuffer(this.vertexBuffer, 0, 0);
            frame.drawVerticesWithPushConstants(PARTICLE_COUNT, Ref(this.drawConstants[0]), DRAW_CONSTANT_FLOATS * 4);
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init() {
            this.vertexShader = this.app.createShader("n_body_gravity_draw.hlsl", "VSParticleDraw", ShaderType.Vertex);
            this.geometryShader = this.app.createShader("n_body_gravity_draw.hlsl", "GSParticleDraw", ShaderType.Geometry);
            this.pixelShader = this.app.createShader("n_body_gravity_draw.hlsl", "PSParticleDraw", ShaderType.Pixel);
            const computeShader = this.app.createShader("n_body_gravity_cs.hlsl", "CSMain", ShaderType.Compute);
            if (!this.vertexShader || !this.geometryShader || !this.pixelShader || !computeShader) {
                return false;
            }

            const computeCommandList = this.app.createComputeQueueCommandList();
            if (!computeCommandList.isNull()) {
                this.computeCommandList = computeCommandList;
            }

            // The particles' color (the vertex shader turns it red by acceleration).
            const layoutDesc = InputLayoutDesc.create();
            layoutDesc.addVertexAttribute("COLOR", Format.RGBA32_FLOAT, 0, 0, 16);
            this.inputLayout = this.app.createInputLayout(layoutDesc, this.vertexShader);

            // The sample's root signatures: the draw's CBV and particle SRV; the step's CBV, SRV and
            // UAV.
            const drawLayoutDesc = BindingLayoutDesc.create();
            drawLayoutDesc.layoutPushConstants(0, DRAW_CONSTANT_FLOATS * 4);
            drawLayoutDesc.layoutStructuredBufferSRV(0);
            this.drawBindingLayout = this.app.createBindingLayout(drawLayoutDesc, ShaderType.All);
            const stepLayoutDesc = BindingLayoutDesc.create();
            stepLayoutDesc.layoutPushConstants(0, STEP_CONSTANT_FLOATS * 4);
            stepLayoutDesc.layoutStructuredBufferSRV(0);
            stepLayoutDesc.layoutStructuredBufferUAV(0);
            const stepBindingLayout = this.app.createBindingLayout(stepLayoutDesc, ShaderType.Compute);
            this.stepPipeline = this.app.createComputePipelineWithLayout(computeShader, stepBindingLayout);

            // CreateVertexBuffer and CreateParticleBuffers: the particles all yellow; the two groups
            // moving along z, 20 a second either way, in both particle buffers.
            let data: f32[] = [];
            for (let i = 0; i < GROUP_COUNT * BLOCK_SIZE * 8; i++) {
                data.push(0.0);
            }
            const centerSpread = Math.fround(PARTICLE_SPREAD * 0.5);
            loadParticles(data, 0, PARTICLE_COUNT / 2, centerSpread, -20.0, PARTICLE_SPREAD);
            loadParticles(data, PARTICLE_COUNT / 2, PARTICLE_COUNT / 2, -centerSpread, 20.0, PARTICLE_SPREAD);
            let colors: f32[] = [];
            for (let i = 0; i < PARTICLE_COUNT; i++) {
                colors.push(1.0);
                colors.push(1.0);
                colors.push(Math.fround(0.2));
                colors.push(1.0);
            }

            const commandList = this.app.createCommandList();
            commandList.open();
            this.vertexBuffer = this.app.createStaticVertexBuffer(commandList, Ref(colors[0]), PARTICLE_COUNT * 16, "ParticleColors");
            const buffers: BufferHandle[] = [];
            for (let i = 0; i < 2; i++) {
                const buffer = this.app.createRWStructuredBuffer(PARTICLE_STRIDE, GROUP_COUNT * BLOCK_SIZE, `Particles${i}`);
                commandList.writeBuffer(buffer, Ref(data[0]), GROUP_COUNT * BLOCK_SIZE * PARTICLE_STRIDE);
                buffers.push(buffer);
            }
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.releaseResource(commandList.handle);

            for (let i = 0; i < 2; i++) {
                const stepDesc = BindingSetDesc.create();
                stepDesc.bindPushConstants(0, STEP_CONSTANT_FLOATS * 4);
                stepDesc.bindStructuredBufferSRV(0, buffers[i]);
                stepDesc.bindStructuredBufferUAV(0, buffers[1 - i]);
                this.stepBindingSets.push(this.app.createBindingSetForLayout(stepDesc, stepBindingLayout));
                const drawDesc = BindingSetDesc.create();
                drawDesc.bindPushConstants(0, DRAW_CONSTANT_FLOATS * 4);
                drawDesc.bindStructuredBufferSRV(0, buffers[i]);
                this.drawBindingSets.push(this.app.createBindingSetForLayout(drawDesc, this.drawBindingLayout));
            }

            // The sample's camera: 1500 back from the middle, 250 a second.
            this.camera.init(0.0, 0.0, 1500.0);
            this.camera.setMoveSpeed(250.0);

            const pass = this.app.addPass();
            pass.setKeyboardCallback(this.onKey);
            pass.setAnimateCallback(this.onAnimate);
            pass.setBackBufferResizingCallback(this.onBackBufferResizing);
            pass.setRenderCallback(this.onRender);
            return true;
        }
    }

    // -test: checks the last frame. The corners are the clear color; the clusters (merging by then)
    // show as bright, mostly yellow pixels, in both the left and the right half of the frame.
    function checkFrame(app: App) {
        const width = app.getWindowWidth();
        const height = app.getWindowHeight();
        let pixels: int[] = [];
        for (let i = 0; i < width * height; i++) {
            pixels.push(0);
        }
        if (app.readBackBufferRGBA8(Ref(pixels[0]), pixels.length) == 0) {
            return "cannot read the back buffer";
        }
        // The clear color as the sample's back buffer has it: 0.1 is 25 of 255 there too (26 where
        // 25.5 rounds up, as on Android's emulator).
        const corners = [0, width - 1, (height - 1) * width, height * width - 1];
        for (let k = 0; k < 4; k++) {
            const p = pixels[corners[k]] & 0xFFFFFF;
            const blue = (p >> 16) & 0xFF;
            if ((p & 0xFFFF) != 0 || blue < 25 || blue > 26) {
                return `corner pixel ${corners[k]} is ${p & 0xFF}, ${(p >> 8) & 0xFF}, ${(p >> 16) & 0xFF}, not the clear color`;
            }
        }
        // Bright pixels (red over 128) in each half, and the yellow ones (green over 128 too).
        let left = 0;
        let right = 0;
        let yellow = 0;
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const p = pixels[y * width + x];
                const r = p & 0xFF;
                const g = (p >> 8) & 0xFF;
                if (r <= 128) {
                    continue;
                }
                if (x < width / 2) {
                    left++;
                } else {
                    right++;
                }
                if (g > 128) {
                    yellow++;
                }
            }
        }
        console.log(`Bright pixels: left ${left}, right ${right}, yellow ${yellow}`);
        const minimum = (width * height) / 50;
        if (left < minimum || right < minimum) {
            return `bright pixels left ${left}, right ${right}: not both ${minimum} or more`;
        }
        if (yellow * 2 < left + right) {
            return `${yellow} of ${left + right} bright pixels are yellow, not half or more`;
        }
        return "";
    }

    class NBodyGravityArgs extends Args {
        // -steps <n>: simulation steps per frame (10 by default).
        stepsPerFrame = DEFAULT_STEPS_PER_FRAME;

        protected parseOptions() {
            for (let i = 1; i < this.argc; i++) {
                const arg = this[i];
                if (arg == "-steps" && i + 1 < this.argc) {
                    this.stepsPerFrame = parseInt(this[i + 1]);
                    i++;
                }
            }
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("n_body_gravity");

        // -test [-testOutput <file>]: render a few frames without a window and check the last one
        // (see checkFrame).
        const args = new NBodyGravityArgs(argc, argv, TEST_FRAMES);
        args.parseArgs();

        // UNORM back buffers, as the sample's R8G8B8A8_UNORM; a compute queue for the simulation.
        const options = AppOptions.UnormBackBuffer | AppOptions.ComputeQueue | args.options;

        // The sample's window.
        const app = App.createWithOptions(args.api, WINDOW_TITLE, 1280, 720, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        const pass = new NBodyGravityPass(app);
        pass.stepsPerFrame = args.stepsPerFrame;
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
    return NBodyGravity.main(argc, argv);
}
