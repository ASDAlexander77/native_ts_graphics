// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";
import { Args } from "../core/args";
import { TestCheck, isFinite32 } from "../core/test_check";
import { radians, perspProjD3DStyleReverse } from "../core/matrix";

namespace AtomOrbitals {
    const WINDOW_TITLE = "Donut Example: Atom Orbitals";

    // Seconds without input before the camera starts to orbit the nucleus by itself, the seconds it
    // takes to reach full speed, and that speed in radians per second (compute_nbody_collisions').
    const IDLE_SECONDS = 5.0;
    const IDLE_RAMP_SECONDS = 2.0;
    const IDLE_ROTATION_SPEED = 0.09;

    // The default state, 3d with m = 1 (it circulates: a state with m = 0 alone stands still), and the
    // highest n the UI offers.
    const DEFAULT_N = 3;
    const DEFAULT_L = 2;
    const DEFAULT_M = 1;
    const MAX_N = 5;
    const DEFAULT_PARTICLES = 65536;
    const PARTICLE_CHOICES = "16384|65536|262144";
    function particleChoiceIndex(particles: int) {
        return particles == 16384 ? 0 : (particles == 65536 ? 1 : (particles == 262144 ? 2 : -1));
    }
    function particleChoice(index: int) {
        return index == 0 ? 16384 : (index == 1 ? 65536 : 262144);
    }
    // Test mode: the frames rendered (5 seconds, 100 atomic time units at the default time scale).
    const TEST_FRAMES = 300;
    // Test mode: how far the particles' mean distance from the nucleus may be from the state's (a
    // share of it), the angular momentum L_z = x v_y - y v_x from m (on average over the particles:
    // it is m for every one, up to the central differences' error near the z axis), and <z> from its
    // value at the last frame (Bohr radii: the sampling's own spread is about 0.01).
    const MEAN_RADIUS_TOLERANCE = 0.02;
    const ANGULAR_MOMENTUM_TOLERANCE = 0.01;
    const MEAN_Z_TOLERANCE = 0.05;
    // Test mode, an eigenstate: every particle circles the z axis, its distance rho from it and its z
    // kept, at the angular speed m / rho^2. The particles at least CIRCLE_MIN_RHO from the axis
    // (closer, the flow turns fast and they may run out of substeps) are checked against their
    // starting points: rho and z within CIRCLE_DRIFT_TOLERANCE (Bohr radii), the angle within
    // CIRCLE_ANGLE_TOLERANCE (radians).
    const CIRCLE_MIN_RHO = 1.0;
    const CIRCLE_DRIFT_TOLERANCE = 1.0e-2;
    const CIRCLE_ANGLE_TOLERANCE = 1.0e-2;
    // advance_cs runs 256 threads per group.
    const WORKGROUP_SIZE = 256;
    // struct Particle: float4 pos (w: the phase of psi), float4 vel.
    const PARTICLE_FLOATS = 8;
    // struct SimulationConstants: 8 floats, then the two states' float4s.
    const SIMULATION_FLOATS = 16;
    const SIMULATION_CONSTANTS_SIZE = SIMULATION_FLOATS * 4;
    const CONSTANT_DELTA_T = 0;
    const CONSTANT_PARTICLE_COUNT = 1;
    const CONSTANT_PHASE = 2;
    const CONSTANT_DELTA_E = 3;
    const CONSTANT_MAX_STEP = 4;
    const CONSTANT_GRADIENT_STEP = 5;
    const CONSTANT_AMPLITUDE_A = 6;
    const CONSTANT_AMPLITUDE_B = 7;
    const CONSTANT_STATE_A = 8;
    const CONSTANT_STATE_B = 12;
    // struct DisplayConstants: 8 floats.
    const DISPLAY_FLOATS = 8;
    const DISPLAY_CONSTANTS_SIZE = DISPLAY_FLOATS * 4;
    // Atomic time units simulated per second (one is 24 attoseconds), and the slider's range.
    const DEFAULT_TIME_SCALE = 20.0;
    const TIME_SCALE_MAX = 100.0;
    // Longest frame, in seconds: a stall (window dragged) would otherwise take many substeps at once.
    const MAX_DELTA_T = 1.0 / 30.0;
    const DEFAULT_BRIGHTNESS = 0.25;
    // The quad each particle is drawn as (main_vs); one more for the nucleus.
    const VERTICES_PER_PARTICLE = 6;
    // The radial distribution's table: points from 0 to radialExtent(n).
    const RADIAL_TABLE_SIZE = 4096;
    // The angular distribution's maximum, from this many points over cos(theta) in [-1, 1].
    const ANGULAR_SCAN_POINTS = 2001;
    // The Park-Miller generator's seed (from 1 up).
    const DEFAULT_SEED = 12345;

    const ORBITAL_LETTERS = "spdfg";
    const COLOR_MODES = "Phase of psi|Speed";

    // --- Math ---------------------------------------------------------------------------------

    // A Park-Miller generator from a seed, so runs (and the tests) repeat; restarted with it.
    let g_RandomSeed = DEFAULT_SEED * 1.0;
    function randomFloat() {
        g_RandomSeed = (g_RandomSeed * 16807.0) % 2147483647.0;
        return g_RandomSeed / 2147483647.0;
    }

    function factorial(k: int) {
        let result = 1.0;
        for (let i = 2; i <= k; i++) {
            result *= i;
        }
        return result;
    }

    function energy(n: int) {
        return -0.5 / (n * n);
    }

    // The radius within which the state's particles are drawn from (far beyond its outermost lobe),
    // and the size of the scene drawn: the camera's distance, the sprites' size follow it.
    function radialExtent(n: int) {
        return 5.0 * n * n + 15.0;
    }
    function sceneExtent(n: int) {
        return 2.5 * n * n + 2.0;
    }

    // The shader's Radial: R_nl(r) over its normalization, (2r/n)^l e^(-r/n) L_(n-l-1)^(2l+1)(2r/n).
    function radial(n: int, l: int, r: number) {
        const x = 2.0 * r / n;
        const k = n - l - 1;
        const alpha = 2.0 * l + 1.0;
        let previous = 1.0;
        let laguerre = 1.0;
        if (k > 0) {
            laguerre = 1.0 + alpha - x;
            for (let j = 1; j < k; j++) {
                const next = ((2.0 * j + 1.0 + alpha - x) * laguerre - (j + alpha) * previous) / (j + 1.0);
                previous = laguerre;
                laguerre = next;
            }
        }
        let power = 1.0;
        for (let i = 0; i < l; i++) {
            power *= x;
        }
        return power * Math.exp(-0.5 * x) * laguerre;
    }

    // The shader's LegendreReduced: the m-th derivative of P_l at t, m >= 0.
    function legendreReduced(l: int, m: int, t: number) {
        let pmm = 1.0;
        for (let i = 1; i <= m; i++) {
            pmm *= 2.0 * i - 1.0;
        }
        if (l == m) {
            return pmm;
        }
        let previous = pmm;
        let current = (2.0 * m + 1.0) * t * pmm;
        for (let k = m + 1; k < l; k++) {
            const next = ((2.0 * k + 1.0) * t * current - (k + m) * previous) / (k - m + 1.0);
            previous = current;
            current = next;
        }
        return current;
    }

    // |m|, without Math.abs's float result.
    function absInt(m: int): int {
        return m < 0 ? -m : m;
    }

    // The normalization of R_nl times that of Y_lm: psi_nlm = this * radial * legendreReduced *
    // ((x +- i y) / r)^|m|, with integral |psi|^2 = 1.
    function normalization(n: int, l: int, m: int) {
        const radialNorm = Math.sqrt(8.0 / (n * n * n) * factorial(n - l - 1) / (2.0 * n * factorial(n + l)));
        const mm = absInt(m);
        const angularNorm = Math.sqrt((2.0 * l + 1.0) / (4.0 * Math.PI) * factorial(l - mm) / factorial(l + mm));
        return radialNorm * angularNorm;
    }

    function orbitalName(n: int, l: int, m: int) {
        return `${n}${ORBITAL_LETTERS.substring(l, l + 1)} (m = ${m})`;
    }

    // A state's n, l, m, with what is drawn from it: its normalization, the cumulative radial
    // distribution r^2 R^2 over RADIAL_TABLE_SIZE points to radialExtent(n), and the maximum of the
    // angular one, (1 - t^2)^|m| P^2 over t = cos(theta).
    class Orbital {
        n: int;
        l: int;
        m: int;
        norm: number;
        private extent: number;
        private cdf: number[];
        private angularMax: number;
        // Eigenstate's result, psi without the e^(-i E t).
        re: number;
        im: number;

        constructor(n: int, l: int, m: int) {
            this.n = n;
            this.l = l;
            this.m = m;
            this.norm = normalization(n, l, m);
            this.extent = radialExtent(n);
            this.re = 0.0;
            this.im = 0.0;

            this.cdf = [];
            let sum = 0.0;
            let previous = 0.0;
            this.cdf.push(0.0);
            for (let i = 1; i < RADIAL_TABLE_SIZE; i++) {
                const r = this.extent * i / (RADIAL_TABLE_SIZE - 1);
                const R = radial(n, l, r);
                const density = r * r * R * R;
                sum += 0.5 * (density + previous);
                previous = density;
                this.cdf.push(sum);
            }
            for (let i = 0; i < RADIAL_TABLE_SIZE; i++) {
                this.cdf[i] = this.cdf[i] / sum;
            }

            this.angularMax = 0.0;
            const mm = absInt(m);
            for (let i = 0; i < ANGULAR_SCAN_POINTS; i++) {
                const t = -1.0 + 2.0 * i / (ANGULAR_SCAN_POINTS - 1);
                const value = this.angularDensity(t, mm);
                if (value > this.angularMax) {
                    this.angularMax = value;
                }
            }
            // The scan's points may straddle the true maximum.
            this.angularMax *= 1.05;
        }

        same(other: Orbital) {
            return this.n == other.n && this.l == other.l && this.m == other.m;
        }

        private angularDensity(t: number, mm: int) {
            const p = legendreReduced(this.l, mm, t);
            let s = 1.0;
            for (let i = 0; i < mm; i++) {
                s *= 1.0 - t * t;
            }
            return s * p * p;
        }

        // psi_nlm at (x, y, z) into re, im (the shader's Eigenstate).
        eigenstate(x: number, y: number, z: number) {
            let r = Math.sqrt(x * x + y * y + z * z);
            if (r < 1.0e-6) {
                r = 1.0e-6;
            }
            const mm = absInt(this.m);
            let re = this.norm * radial(this.n, this.l, r) * legendreReduced(this.l, mm, z / r);
            let im = 0.0;
            const wx = x / r;
            const wy = (this.m < 0 ? -y : y) / r;
            for (let i = 0; i < mm; i++) {
                const nextRe = re * wx - im * wy;
                im = re * wy + im * wx;
                re = nextRe;
            }
            this.re = re;
            this.im = im;
        }

        // A point drawn from |psi_nlm|^2 into px, py, pz of the pass: r by the radial table, cos(theta)
        // by rejection, phi uniformly.
        sample(target: OrbitalsPass) {
            const u = randomFloat();
            let low = 0;
            let high = RADIAL_TABLE_SIZE - 1;
            while (high - low > 1) {
                const middle: int = Math.floor((low + high) / 2);
                if (this.cdf[middle] < u) {
                    low = middle;
                } else {
                    high = middle;
                }
            }
            const span = this.cdf[high] - this.cdf[low];
            const fraction = span > 0.0 ? (u - this.cdf[low]) / span : 0.0;
            const r = this.extent * (low + fraction) / (RADIAL_TABLE_SIZE - 1);

            const mm = absInt(this.m);
            let t = 0.0;
            for (let attempt = 0; attempt < 10000; attempt++) {
                t = 2.0 * randomFloat() - 1.0;
                if (randomFloat() * this.angularMax <= this.angularDensity(t, mm)) {
                    break;
                }
            }
            const phi = 2.0 * Math.PI * randomFloat();
            const s = Math.sqrt(1.0 - t * t);
            target.px = r * s * Math.cos(phi);
            target.py = r * s * Math.sin(phi);
            target.pz = r * t;
        }

        // <r> of the state.
        meanRadius() {
            return (3.0 * this.n * this.n - this.l * (this.l + 1)) / 2.0;
        }

        // <this|z|other>, by quadrature: the radial integral of R R r^3 and, for equal m (else 0),
        // 2 pi times that of the angular parts times t. Real, with these phase conventions.
        dipole(other: Orbital) {
            if (this.m != other.m) {
                return 0.0;
            }
            const steps = 20000;
            const extent = Math.max(this.extent, other.extent);
            let radialSum = 0.0;
            for (let i = 1; i < steps; i++) {
                const r = extent * i / steps;
                radialSum += radial(this.n, this.l, r) * radial(other.n, other.l, r) * r * r * r;
            }
            radialSum *= extent / steps;
            const mm = absInt(this.m);
            let angularSum = 0.0;
            for (let i = 0; i < steps; i++) {
                const t = -1.0 + 2.0 * (i + 0.5) / steps;
                let s = 1.0;
                for (let k = 0; k < mm; k++) {
                    s *= 1.0 - t * t;
                }
                angularSum += legendreReduced(this.l, mm, t) * legendreReduced(other.l, mm, t) * s * t;
            }
            angularSum *= 2.0 / steps;
            return this.norm * other.norm * radialSum * 2.0 * Math.PI * angularSum;
        }
    }

    // --- Passes -------------------------------------------------------------------------------

    // Hydrogen's electron as a Bohmian flow, on compute_nbody's particles: psi is an eigenstate psi_nlm,
    // or two superposed, a psi_A + b psi_B e^(-i dE t). The particles start distributed as |psi|^2,
    // and one compute pass a frame (advance_cs) moves them with the guidance velocity
    // v = Im(conj(psi) grad psi) / |psi|^2, which keeps them distributed as |psi(t)|^2: an m != 0 state
    // circulates about the z axis (L_z = m for every particle), a real one (m = 0) stands still, and a
    // superposition of different energies sloshes at the frequency dE (in atomic units, E_n = -1/(2n^2)).
    // The particles are drawn as additive sprites colored by the phase of psi at them (or their speed).
    // The UI (top right, off with -noui) picks the states, the share of the second and the particles:
    // a change draws them anew. Space pauses; left alone for IDLE_SECONDS, the camera orbits slowly.
    export class OrbitalsPass {
        private app: App;
        private camera: Camera;
        private view: View;
        private paused: boolean;
        private showUI: boolean;
        // -test renders the same frames every run: no rotation.
        private autoRotate: boolean;
        private idleSeconds: number;
        private buttonsDown: int;
        private frameWidth: int;

        // The running states (orbitalB only while superposed), the second's share of the probability
        // (|b|^2), and the particles.
        private orbitalA: Orbital;
        private orbitalB: Orbital;
        private superposed: boolean;
        private weight: number;
        private numParticles: int;
        // Atomic time units since the particles were drawn.
        private simTime: number;
        private timeScale: number;

        // The UI's settings: a change restarts the simulation, at the start of the next frame.
        private uiA: int[];
        private uiB: int[];
        private uiSuperposed: boolean;
        private uiWeight: number;
        private uiParticles: int;
        private restartRequested: boolean;
        // Display settings, live.
        private colorMode: int;
        private brightness: number;
        private cutAway: boolean;
        // -test: the particles' starting positions (empty otherwise), for the circles' check.
        private keepStart: boolean;
        private startPositions: number[];

        private particleBuffer: BufferHandle;
        private advancePipeline: ComputePipelineHandle;
        private computeBindingLayout: BindingLayoutHandle;
        private computeBindingSet: BindingSet;
        private vertexShader: ShaderHandle;
        private pixelShader: ShaderHandle;
        private drawBindingLayout: BindingLayoutHandle;
        private drawBindingSet: BindingSet;
        private viewConstantBuffer: BufferHandle;
        private displayConstantBuffer: BufferHandle;
        // Created on the first frame (it depends on the framebuffer layout), dropped on resize.
        private graphicsPipeline: GraphicsPipelineHandle | null;

        private simulationConstants: f32[];
        private displayConstants: f32[];
        private viewConstants: f32[];
        private viewConstantsSize: int;
        private viewMatrix: f32[];
        private projMatrix: f32[];

        // Orbital.sample's result.
        px: number;
        py: number;
        pz: number;

        constructor(app: App, a: int[], b: int[], weight: number, particles: int, autoRotate: boolean, showUI: boolean) {
            this.app = app;
            this.paused = false;
            this.showUI = showUI;
            this.autoRotate = autoRotate;
            this.idleSeconds = 0.0;
            this.buttonsDown = 0;
            this.frameWidth = 1280;
            this.uiA = [a[0], a[1], a[2]];
            this.uiB = [b[0], b[1], b[2]];
            this.uiSuperposed = weight > 0.0;
            this.uiWeight = weight > 0.0 ? weight : 0.5;
            this.uiParticles = particles;
            this.restartRequested = false;
            this.colorMode = 0;
            this.brightness = DEFAULT_BRIGHTNESS;
            this.cutAway = false;
            this.keepStart = !autoRotate;
            this.startPositions = [];
            this.timeScale = DEFAULT_TIME_SCALE;
            this.simTime = 0.0;
            this.numParticles = 0;
            this.superposed = false;
            this.weight = 0.0;
            this.orbitalA = new Orbital(1, 0, 0);
            this.orbitalB = this.orbitalA;
            this.graphicsPipeline = null;
            this.viewConstantsSize = 0;
            this.px = 0.0;
            this.py = 0.0;
            this.pz = 0.0;

            this.simulationConstants = [];
            for (let i = 0; i < SIMULATION_FLOATS; i++) {
                this.simulationConstants.push(0.0);
            }
            this.displayConstants = [];
            for (let i = 0; i < DISPLAY_FLOATS; i++) {
                this.displayConstants.push(0.0);
            }
            this.viewConstants = [];
            this.viewMatrix = [];
            this.projMatrix = [];
            for (let i = 0; i < 16; i++) {
                this.viewMatrix.push(0.0);
                this.projMatrix.push(0.0);
            }
        }

        init() {
            this.vertexShader = this.app.createShader("atom_orbitals.hlsl", "main_vs", ShaderType.Vertex);
            this.pixelShader = this.app.createShader("atom_orbitals.hlsl", "main_ps", ShaderType.Pixel);
            const advanceShader = this.app.createShaderWithDefine("atom_orbitals.hlsl", "advance_cs", ShaderType.Compute, "SIMULATION", "1");
            if (!this.vertexShader || !this.pixelShader || !advanceShader) {
                return false;
            }

            // Compute: the particles and the SimulationConstants push constants.
            const computeLayoutDesc = BindingLayoutDesc.create();
            computeLayoutDesc.layoutPushConstants(0, SIMULATION_CONSTANTS_SIZE);
            computeLayoutDesc.layoutStructuredBufferUAV(0);
            this.computeBindingLayout = this.app.createBindingLayout(computeLayoutDesc, ShaderType.Compute);
            this.advancePipeline = this.app.createComputePipelineWithLayout(advanceShader, this.computeBindingLayout);

            // Drawing: the view and display constants and the particles, read by the vertex shader.
            this.viewConstantsSize = ConstantSizes.planarView();
            for (let i = 0; i < this.viewConstantsSize / 4; i++) {
                this.viewConstants.push(0.0);
            }
            // Static, written in the command list every frame: a volatile one runs out of versions in
            // -test's unthrottled frames on Vulkan.
            this.viewConstantBuffer = this.app.createConstantBuffer(this.viewConstantsSize, "ViewConstants");
            this.displayConstantBuffer = this.app.createConstantBuffer(DISPLAY_CONSTANTS_SIZE, "DisplayConstants");

            const drawLayoutDesc = BindingLayoutDesc.create();
            drawLayoutDesc.layoutConstantBuffer(1);
            drawLayoutDesc.layoutConstantBuffer(2);
            drawLayoutDesc.layoutStructuredBufferSRV(0);
            this.drawBindingLayout = this.app.createBindingLayout(drawLayoutDesc, ShaderType.Vertex);

            this.camera = this.app.createThirdPersonCamera();
            this.camera.thirdPersonSetTarget(0.0, 0.0, 0.0);
            this.camera.thirdPersonSetRotation(radians(35.0), radians(20.0));

            this.createParticles();
            this.createParticleBindings();
            this.fitCamera();

            this.view = this.app.createPlanarView();

            const pass = this.app.addPass();
            pass.setKeyboardCallback(this.onKey);
            pass.setMousePosCallback(this.onMousePos);
            pass.setMouseButtonCallback(this.onMouseButton);
            pass.setMouseScrollCallback(this.onMouseScroll);
            pass.setAnimateCallback(this.onAnimate);
            pass.setBackBufferResizingCallback(this.onBackBufferResizing);
            pass.setRenderCallback(this.onRender);

            // Drawn after (over) the scene, and sees the mouse first.
            if (this.showUI && this.app.addImGuiPass(this.buildUI).isNull()) {
                return false;
            }
            return true;
        }

        setTimeScale(timeScale: number) {
            this.timeScale = timeScale;
        }

        // The camera far enough back to see the larger state whole.
        fitCamera() {
            const extent = sceneExtent(this.largestN());
            this.camera.thirdPersonSetDistance(2.0 * extent);
            this.camera.setMoveSpeed(0.2 * extent);
        }

        largestN(): int {
            return this.superposed && this.orbitalB.n > this.orbitalA.n ? this.orbitalB.n : this.orbitalA.n;
        }

        smallestN(): int {
            return this.superposed && this.orbitalB.n < this.orbitalA.n ? this.orbitalB.n : this.orbitalA.n;
        }

        onKey(key: Key, scancode: ScanCode, action: Action, mods: KeyMods) {
            this.idleSeconds = 0.0;
            this.camera.keyboardUpdate(key, scancode, action, mods);
            if (key == Key.Space && action == Action.Press) {
                this.paused = !this.paused;
            }
            return 1;
        }

        onMousePos(x: number, y: number) {
            // The mouse moving over the window isn't input for the camera, dragging is.
            if (this.buttonsDown > 0) {
                this.idleSeconds = 0.0;
            }
            this.camera.mousePosUpdate(x, y);
            return 1;
        }

        onMouseButton(button: MouseButton, action: Action, mods: KeyMods) {
            this.idleSeconds = 0.0;
            if (action == Action.Press) {
                this.buttonsDown++;
            } else if (action == Action.Release && this.buttonsDown > 0) {
                this.buttonsDown--;
            }
            this.camera.mouseButtonUpdate(button, action, mods);
            return 1;
        }

        onMouseScroll(xOffset: number, yOffset: number) {
            this.idleSeconds = 0.0;
            this.camera.mouseScrollUpdate(xOffset, yOffset);
            return 1;
        }

        onAnimate(elapsedSeconds: number) {
            // Before this frame's commands exist: the GPU is idle, so the buffers can be replaced.
            if (this.restartRequested) {
                this.restartRequested = false;
                this.restart();
            }

            this.idleSeconds += elapsedSeconds;
            if (this.autoRotate && this.idleSeconds > IDLE_SECONDS) {
                const ramp = Math.min((this.idleSeconds - IDLE_SECONDS) / IDLE_RAMP_SECONDS, 1.0);
                this.camera.thirdPersonSetRotation(
                    this.camera.thirdPersonGetYaw() + IDLE_ROTATION_SPEED * ramp * elapsedSeconds,
                    this.camera.thirdPersonGetPitch());
            }
            this.camera.animate(elapsedSeconds);

            // This frame's step from simTime: the relative phase at its start, wrapped (only the
            // relative phase of the two states moves anything).
            const seconds = elapsedSeconds < MAX_DELTA_T ? elapsedSeconds : MAX_DELTA_T;
            const step = this.paused ? 0.0 : seconds * this.timeScale;
            const deltaE = this.superposed ? energy(this.orbitalB.n) - energy(this.orbitalA.n) : 0.0;
            this.simulationConstants[CONSTANT_DELTA_T] = step;
            this.simulationConstants[CONSTANT_PHASE] = (deltaE * this.simTime) % (2.0 * Math.PI);
            this.simulationConstants[CONSTANT_DELTA_E] = deltaE;
            this.simTime += step;

            const name = this.superposed
                ? `${orbitalName(this.orbitalA.n, this.orbitalA.l, this.orbitalA.m)} + ${orbitalName(this.orbitalB.n, this.orbitalB.l, this.orbitalB.m)}`
                : orbitalName(this.orbitalA.n, this.orbitalA.l, this.orbitalA.m);
            this.app.setInformativeWindowTitleWithInfo(WINDOW_TITLE,
                this.paused ? `${name}, ${this.numParticles} particles (paused)` : `${name}, ${this.numParticles} particles`);
        }

        onBackBufferResizing() {
            const graphicsPipeline = this.graphicsPipeline;
            if (graphicsPipeline) {
                this.app.releaseResource(graphicsPipeline);
                this.graphicsPipeline = null;
            }
        }

        onRender(frameHandle: FrameHandle) {
            const frame = new Frame(frameHandle);
            const width = frame.getWidth();
            const height = frame.getHeight();
            this.frameWidth = width;
            const commandList = frame.getCommandList();

            let graphicsPipeline = this.graphicsPipeline;
            if (!graphicsPipeline) {
                graphicsPipeline = this.app.createGraphicsPipelineWithBlend(frame, this.vertexShader, this.pixelShader,
                    null, this.drawBindingLayout, PrimitiveType.TriangleList, BlendMode.Additive);
                this.graphicsPipeline = graphicsPipeline;
            }

            const groups: int = Math.floor((this.numParticles + WORKGROUP_SIZE - 1) / WORKGROUP_SIZE);
            commandList.dispatchWithPushConstants(this.advancePipeline, this.computeBindingSet,
                Ref(this.simulationConstants[0]), SIMULATION_CONSTANTS_SIZE, groups, 1, 1);

            this.camera.getWorldToView(Ref(this.viewMatrix[0]));
            const projection = perspProjD3DStyleReverse(radians(60.0), width / height, 0.1);
            for (let i = 0; i < 16; i++) {
                this.projMatrix[i] = projection[i];
            }
            this.view.setPlanarView(Ref(this.viewMatrix[0]), Ref(this.projMatrix[0]), width, height);
            this.camera.thirdPersonSetView(this.view);
            this.view.fillPlanarViewConstants(Ref(this.viewConstants[0]));
            commandList.writeBuffer(this.viewConstantBuffer, Ref(this.viewConstants[0]), this.viewConstantsSize);

            // Sprites a little larger for fewer particles, the same light in all.
            const extent = sceneExtent(this.largestN());
            const density = Math.sqrt(DEFAULT_PARTICLES / this.numParticles);
            this.displayConstants[0] = 0.006 * extent * density;
            this.displayConstants[1] = this.brightness;
            this.displayConstants[2] = this.colorMode;
            this.displayConstants[3] = 2.0 / this.largestN();
            this.displayConstants[4] = this.cutAway ? 1.0 : 0.0;
            this.displayConstants[5] = this.numParticles;
            this.displayConstants[6] = 0.04 * extent;
            commandList.writeBuffer(this.displayConstantBuffer, Ref(this.displayConstants[0]), DISPLAY_CONSTANTS_SIZE);

            frame.clearColor(0.0, 0.0, 0.0, 1.0);

            frame.beginDraw(graphicsPipeline);
            frame.drawAddBindingSet(this.drawBindingSet);
            frame.drawVertices((this.numParticles + 1) * VERTICES_PER_PARTICLE);
        }

        // The UI's states into the running ones: a superposition of a state with itself is the
        // state alone.
        applyStates() {
            this.orbitalA = new Orbital(this.uiA[0], this.uiA[1], this.uiA[2]);
            this.orbitalB = new Orbital(this.uiB[0], this.uiB[1], this.uiB[2]);
            this.superposed = this.uiSuperposed && !this.orbitalA.same(this.orbitalB) && this.uiWeight > 0.0;
            this.weight = this.superposed ? this.uiWeight : 0.0;
            if (this.superposed && this.weight >= 1.0) {
                // B alone.
                this.orbitalA = this.orbitalB;
                this.superposed = false;
                this.weight = 0.0;
            }
            this.numParticles = this.uiParticles;
            this.simTime = 0.0;

            const a = this.orbitalA;
            const b = this.orbitalB;
            const constants = this.simulationConstants;
            constants[CONSTANT_PARTICLE_COUNT] = this.numParticles;
            constants[CONSTANT_MAX_STEP] = 0.05 * this.smallestN() * this.smallestN();
            constants[CONSTANT_GRADIENT_STEP] = 2.0e-3 * this.largestN();
            constants[CONSTANT_AMPLITUDE_A] = Math.sqrt(1.0 - this.weight);
            constants[CONSTANT_AMPLITUDE_B] = this.superposed ? Math.sqrt(this.weight) : 0.0;
            constants[CONSTANT_STATE_A + 0] = a.n;
            constants[CONSTANT_STATE_A + 1] = a.l;
            constants[CONSTANT_STATE_A + 2] = a.m;
            constants[CONSTANT_STATE_A + 3] = a.norm;
            constants[CONSTANT_STATE_B + 0] = b.n;
            constants[CONSTANT_STATE_B + 1] = b.l;
            constants[CONSTANT_STATE_B + 2] = b.m;
            constants[CONSTANT_STATE_B + 3] = b.norm;
        }

        // psi at t = 0 at (x, y, z) into px (real part) and py (imaginary part); psi_A and psi_B are
        // left in the two orbitals' re, im.
        psi(x: number, y: number, z: number) {
            const amplitudeA = Math.sqrt(1.0 - this.weight);
            this.orbitalA.eigenstate(x, y, z);
            let re = amplitudeA * this.orbitalA.re;
            let im = amplitudeA * this.orbitalA.im;
            if (this.superposed) {
                const amplitudeB = Math.sqrt(this.weight);
                this.orbitalB.eigenstate(x, y, z);
                re += amplitudeB * this.orbitalB.re;
                im += amplitudeB * this.orbitalB.im;
            }
            this.px = re;
            this.py = im;
        }

        // The particles drawn from |psi|^2 at t = 0, with their phase, uploaded. A superposition's
        // |a psi_A + b psi_B|^2 is at most 2 (|a psi_A|^2 + |b psi_B|^2), the mixture of the two
        // states' distributions (|a|^2 + |b|^2 = 1), doubled: points drawn from the mixture are kept
        // with the probability |psi|^2 / (2 mixture), which leaves them distributed as |psi|^2.
        createParticles() {
            this.applyStates();
            this.startPositions = [];
            const particles: f32[] = [];
            for (let i = 0; i < this.numParticles * PARTICLE_FLOATS; i++) {
                particles.push(0.0);
            }

            for (let i = 0; i < this.numParticles; i++) {
                let x = 0.0;
                let y = 0.0;
                let z = 0.0;
                for (let attempt = 0; attempt < 1000; attempt++) {
                    const fromB = this.superposed && randomFloat() < this.weight;
                    if (fromB) {
                        this.orbitalB.sample(this);
                    } else {
                        this.orbitalA.sample(this);
                    }
                    x = this.px;
                    y = this.py;
                    z = this.pz;
                    if (!this.superposed) {
                        break;
                    }
                    this.psi(x, y, z);
                    const density = this.px * this.px + this.py * this.py;
                    const a = this.orbitalA;
                    const b = this.orbitalB;
                    const mixture = (1.0 - this.weight) * (a.re * a.re + a.im * a.im) + this.weight * (b.re * b.re + b.im * b.im);
                    if (randomFloat() * 2.0 * mixture <= density) {
                        break;
                    }
                }

                this.psi(x, y, z);
                const p = i * PARTICLE_FLOATS;
                particles[p + 0] = x;
                particles[p + 1] = y;
                particles[p + 2] = z;
                particles[p + 3] = Math.atan2(this.py, this.px);
                if (this.keepStart) {
                    this.startPositions.push(x);
                    this.startPositions.push(y);
                    this.startPositions.push(z);
                }
            }

            this.particleBuffer = this.app.createRWStructuredBuffer(PARTICLE_FLOATS * 4, this.numParticles, "Particles");

            const commandList = this.app.createCommandList();
            commandList.open();
            commandList.writeBuffer(this.particleBuffer, Ref(particles[0]), this.numParticles * PARTICLE_FLOATS * 4);
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.waitForIdle();
            this.app.releaseResource(commandList.handle);
        }

        createParticleBindings() {
            const computeSetDesc = BindingSetDesc.create();
            computeSetDesc.bindPushConstants(0, SIMULATION_CONSTANTS_SIZE);
            computeSetDesc.bindStructuredBufferUAV(0, this.particleBuffer);
            this.computeBindingSet = this.app.createBindingSetForLayout(computeSetDesc, this.computeBindingLayout);

            const drawSetDesc = BindingSetDesc.create();
            drawSetDesc.bindEntireConstantBuffer(1, this.viewConstantBuffer);
            drawSetDesc.bindEntireConstantBuffer(2, this.displayConstantBuffer);
            drawSetDesc.bindStructuredBufferSRV(0, this.particleBuffer);
            this.drawBindingSet = this.app.createBindingSetForLayout(drawSetDesc, this.drawBindingLayout);
        }

        restart() {
            this.app.waitForIdle();
            this.app.releaseResource(this.computeBindingSet.handle);
            this.app.releaseResource(this.drawBindingSet.handle);
            this.app.releaseResource(this.particleBuffer);
            g_RandomSeed = DEFAULT_SEED * 1.0;
            this.createParticles();
            this.createParticleBindings();
            this.fitCamera();
        }

        // -test: checks the particles after the last frame: every position and velocity finite, their
        // mean distance from the nucleus the state's <r> (a superposition's: the two states' shares
        // of theirs, when their cross term vanishes), an eigenstate's angular momentum L_z = m, and a
        // superposition's <z>(t), 2 a b <A|z|B> cos(dE t). Then the frame: black corners, particles drawn.
        checkTest() {
            const check = new TestCheck(this.app);
            const particles = check.readFloats(this.particleBuffer, this.numParticles * PARTICLE_FLOATS * 4);
            if (particles.length == 0) {
                return "cannot read the particles back";
            }
            let sumRadius = 0.0;
            let sumZ = 0.0;
            let sumAngularError = 0.0;
            for (let i = 0; i < this.numParticles; i++) {
                const p = i * PARTICLE_FLOATS;
                for (let k = 0; k < 7; k++) {
                    const value = particles[p + k];
                    if (k != 3 && !isFinite32(value)) {
                        return `particle ${i}: ${k < 3 ? "position" : "velocity"} ${value} is not finite`;
                    }
                }
                const x: number = particles[p + 0];
                const y: number = particles[p + 1];
                const z: number = particles[p + 2];
                sumRadius += Math.sqrt(x * x + y * y + z * z);
                sumZ += z;
                const lz: number = x * particles[p + 5] - y * particles[p + 4];
                sumAngularError += Math.abs(lz - this.orbitalA.m);
            }
            const count = this.numParticles * 1.0;
            const a = this.orbitalA;
            const b = this.orbitalB;
            const meanRadius = sumRadius / count;
            const meanZ = sumZ / count;
            console.log(`t = ${this.simTime}: <r> = ${meanRadius}, <z> = ${meanZ}, mean |L_z - m| = ${sumAngularError / count}`);

            // <r>'s cross term <A|r|B> vanishes unless the two have the same l and m.
            if (!this.superposed || a.l != b.l || a.m != b.m) {
                const expected = this.superposed
                    ? (1.0 - this.weight) * a.meanRadius() + this.weight * b.meanRadius()
                    : a.meanRadius();
                if (Math.abs(meanRadius - expected) > MEAN_RADIUS_TOLERANCE * expected) {
                    return `<r> ${meanRadius}, not the state's ${expected}`;
                }
            }
            if (this.superposed) {
                const deltaE = energy(b.n) - energy(a.n);
                const expected = 2.0 * Math.sqrt((1.0 - this.weight) * this.weight) * a.dipole(b) * Math.cos(deltaE * this.simTime);
                console.log(`expected <z> = ${expected}`);
                if (Math.abs(meanZ - expected) > MEAN_Z_TOLERANCE) {
                    return `<z> ${meanZ} at t = ${this.simTime}, not ${expected}`;
                }
            } else {
                if (sumAngularError / count > ANGULAR_MOMENTUM_TOLERANCE) {
                    return `L_z is ${sumAngularError / count} from m = ${a.m} on average`;
                }
                const circles = this.checkCircles(particles);
                if (circles != "") {
                    return circles;
                }
            }

            const corners = check.corners(0x000000);
            if (corners != "") {
                return corners;
            }
            return check.drawn(0x000000, 1000, "Particles");
        }

        // An eigenstate's particles after simTime against their starting points: the same rho and z,
        // the angle about z advanced by m simTime / rho^2 (see CIRCLE_MIN_RHO).
        checkCircles(particles: f32[]) {
            const m = this.orbitalA.m;
            let checked = 0;
            let worstDrift = 0.0;
            let worstAngle = 0.0;
            for (let i = 0; i < this.numParticles; i++) {
                const x0 = this.startPositions[i * 3 + 0];
                const y0 = this.startPositions[i * 3 + 1];
                const z0 = this.startPositions[i * 3 + 2];
                const rho0 = Math.sqrt(x0 * x0 + y0 * y0);
                if (rho0 < CIRCLE_MIN_RHO) {
                    continue;
                }
                checked++;
                const p = i * PARTICLE_FLOATS;
                const x: number = particles[p + 0];
                const y: number = particles[p + 1];
                const z: number = particles[p + 2];
                const drift = Math.abs(Math.sqrt(x * x + y * y) - rho0) + Math.abs(z - z0);
                if (drift > worstDrift) {
                    worstDrift = drift;
                }
                // The angle turned, against m t / rho^2, wrapped to [-pi, pi).
                let angle = Math.atan2(y, x) - Math.atan2(y0, x0) - m * this.simTime / (rho0 * rho0);
                angle = angle - 2.0 * Math.PI * Math.floor((angle + Math.PI) / (2.0 * Math.PI));
                if (Math.abs(angle) > worstAngle) {
                    worstAngle = Math.abs(angle);
                }
            }
            console.log(`${checked} particles on their circles: rho and z drifted by ${worstDrift}, the angle by ${worstAngle} at most`);
            if (worstDrift > CIRCLE_DRIFT_TOLERANCE) {
                return `a particle's rho and z drifted by ${worstDrift}`;
            }
            if (worstAngle > CIRCLE_ANGLE_TOLERANCE) {
                return `a particle's angle about z is ${worstAngle} from m t / rho^2`;
            }
            return "";
        }

        // A state's n, l, m sliders, l and m kept in range as n and l change; true on a change.
        stateUI(label: string, state: int[]) {
            const n = ImGui.sliderInt(`n ${label}`, state[0], 1, MAX_N);
            let l = state[1] < n ? state[1] : n - 1;
            l = ImGui.sliderInt(`l ${label}`, l, 0, n - 1);
            let m = state[2];
            if (m > l) {
                m = l;
            }
            if (m < -l) {
                m = -l;
            }
            m = ImGui.sliderInt(`m ${label}`, m, -l, l);
            const changed = n != state[0] || l != state[1] || m != state[2];
            state[0] = n;
            state[1] = l;
            state[2] = m;
            return changed;
        }

        buildUI() {
            ImGui.setNextWindowPosPivot(this.frameWidth - 10.0, 10.0, 1.0, 0.0);
            ImGui.begin("Atom Orbitals", true);
            ImGui.pushItemWidth(160.0);

            if (ImGui.collapsingHeaderDefaultOpen("State")) {
                ImGui.text(`A: ${orbitalName(this.uiA[0], this.uiA[1], this.uiA[2])}, E = ${energy(this.uiA[0])}`);
                let changed = this.stateUI("(A)", this.uiA);
                const superposed = ImGui.checkbox("Superpose B", this.uiSuperposed);
                changed = changed || superposed != this.uiSuperposed;
                this.uiSuperposed = superposed;
                if (this.uiSuperposed) {
                    ImGui.text(`B: ${orbitalName(this.uiB[0], this.uiB[1], this.uiB[2])}, E = ${energy(this.uiB[0])}`);
                    changed = this.stateUI("(B)", this.uiB) || changed;
                    const weight = ImGui.sliderFloat("Share of B |b|^2", this.uiWeight, 0.0, 1.0);
                    changed = changed || weight != this.uiWeight;
                    this.uiWeight = weight;
                    const deltaE = energy(this.uiB[0]) - energy(this.uiA[0]);
                    if (deltaE != 0.0) {
                        ImGui.text(`Beat period 2 pi / |dE| = ${2.0 * Math.PI / Math.abs(deltaE)} a.u.`);
                    } else {
                        ImGui.text("Same energy: stationary");
                    }
                }
                const choice = ImGui.combo("Particles", particleChoiceIndex(this.uiParticles), PARTICLE_CHOICES);
                if (choice >= 0 && choice != particleChoiceIndex(this.uiParticles)) {
                    this.uiParticles = particleChoice(choice);
                    changed = true;
                }
                if (ImGui.button("Restart") || changed) {
                    this.restartRequested = true;
                }
            }

            if (ImGui.collapsingHeaderDefaultOpen("Simulation")) {
                this.paused = ImGui.checkbox("Paused (Space)", this.paused);
                this.timeScale = ImGui.sliderFloat("Time scale (a.u./s)", this.timeScale, 0.0, TIME_SCALE_MAX);
                ImGui.text(`t = ${this.simTime} a.u.`);
            }

            if (ImGui.collapsingHeaderDefaultOpen("Display")) {
                this.colorMode = ImGui.combo("Color", this.colorMode, COLOR_MODES);
                this.brightness = ImGui.sliderFloat("Brightness", this.brightness, 0.02, 1.0);
                this.cutAway = ImGui.checkbox("Cut away x > 0", this.cutAway);
                this.autoRotate = ImGui.checkbox("Orbit when idle", this.autoRotate);
            }

            if (ImGui.collapsingHeader("Units")) {
                ImGui.text("Atomic units: hbar = electron mass = e = 1");
                ImGui.text("Length: Bohr radius a0 = 0.0529 nm (scene unit)");
                ImGui.text("Time: hbar / E_h = 24.2 as; E_n = -1 / (2 n^2)");
                ImGui.text("psi = a psi_A + b psi_B e^(-i dE t), dE = E_B - E_A");
                ImGui.text("v = Im(conj(psi) grad psi) / |psi|^2");
                ImGui.text("Phase colors: arg psi around the hue wheel");
            }

            ImGui.popItemWidth();
            ImGui.end();
        }
    }

    class OrbitalsArgs extends Args {
        // -orbital <n> <l> <m>: the state (3 2 1 by default).
        orbital: int[] = [DEFAULT_N, DEFAULT_L, DEFAULT_M];
        // -mix <n> <l> <m>: a second state superposed (with -weight).
        mix: int[] = [2, 1, 1];
        // -weight <w>: the second state's share of the probability, |b|^2 (0, none, by default).
        weight = 0.0;
        // -particles <n>.
        particles: int = DEFAULT_PARTICLES;
        // -timescale <a.u. per second>: atomic time units simulated per second (DEFAULT_TIME_SCALE).
        timeScale = DEFAULT_TIME_SCALE;

        protected parseOptions() {
            for (let i = 1; i < this.argc; i++) {
                const arg = this[i];
                if (arg == "-orbital" && i + 3 < this.argc) {
                    this.orbital = [parseInt(this[i + 1]), parseInt(this[i + 2]), parseInt(this[i + 3])];
                    i += 3;
                } else if (arg == "-mix" && i + 3 < this.argc) {
                    this.mix = [parseInt(this[i + 1]), parseInt(this[i + 2]), parseInt(this[i + 3])];
                    i += 3;
                } else if (arg == "-weight" && i + 1 < this.argc) {
                    this.weight = parseFloat(this[i + 1]);
                    i++;
                } else if (arg == "-particles" && i + 1 < this.argc) {
                    this.particles = parseInt(this[i + 1]);
                    i++;
                } else if (arg == "-timescale" && i + 1 < this.argc) {
                    this.timeScale = parseFloat(this[i + 1]);
                    i++;
                }
            }
            clampState(this.orbital);
            clampState(this.mix);
            if (this.particles < 1) {
                this.particles = 1;
            }
        }
    }

    // n in 1..MAX_N, l in 0..n-1, |m| <= l.
    function clampState(state: int[]) {
        if (state[0] < 1) {
            state[0] = 1;
        }
        if (state[0] > MAX_N) {
            state[0] = MAX_N;
        }
        if (state[1] < 0) {
            state[1] = 0;
        }
        if (state[1] > state[0] - 1) {
            state[1] = state[0] - 1;
        }
        if (state[2] > state[1]) {
            state[2] = state[1];
        }
        if (state[2] < -state[1]) {
            state[2] = -state[1];
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Program.setAppName("atom_orbitals");

        // -test [-testOutput <file>]: render TEST_FRAMES frames without a window and check the
        // particles and the last frame (see checkTest).
        const args = new OrbitalsArgs(argc, argv, TEST_FRAMES);
        args.parseArgs();

        const app = App.createWithOptions(args.api, WINDOW_TITLE, 1280, 720, args.options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        const orbitals = new OrbitalsPass(app, args.orbital, args.mix, args.weight, args.particles, !args.test, !args.noUI);
        orbitals.setTimeScale(args.timeScale);
        if (!orbitals.init()) {
            app.destroy();
            return 1;
        }

        const input = new InputPass(app.handle);

        app.run();
        let result = 0;
        if (args.test) {
            result = app.finishTest(orbitals.checkTest());
        }
        app.destroy();
        return result;
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return AtomOrbitals.main(argc, argv);
}
