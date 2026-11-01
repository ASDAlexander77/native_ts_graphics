/// <reference path="../../core/nri/nri_interop.d.ts" />
import { radians, perspProjD3DStyleReverse } from "../../core/matrix";

namespace AtomOrbitalsNri {
    // atom_orbitals, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead of Donut
    // and NVRHI: the same shaders (atom_orbitals.hlsl's), through the NRI calls
    // core/nri/nri_interop.d.ts binds, as compute_nbody_nri draws, with NRIFramework's ImGui for the
    // settings window. This example creates everything it runs, and does the rendering.

    const WINDOW_TITLE = "NRI Example: Atom Orbitals";

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
    // PlanarViewConstants (donut/shaders/view_cb.h): ten float4x4, eight float2, a float4; the fields
    // main_vs reads, in floats.
    const VIEW_CONSTANTS_SIZE = 720;
    const MAT_WORLD_TO_VIEW = 0;
    const MAT_VIEW_TO_CLIP = 16;
    const VIEWPORT_ORIGIN = 160;
    const VIEWPORT_SIZE = 162;
    const VIEWPORT_SIZE_INV = 164;
    // A queued frame's constants: the view's (768 bytes, D3D12's views a multiple of 256), then the
    // display's (256), FRAME_CONSTANTS_STRIDE bytes apart.
    const VIEW_CONSTANTS_VIEW_SIZE = 768;
    const DISPLAY_CONSTANTS_OFFSET = 768;
    const DISPLAY_CONSTANTS_VIEW_SIZE = 256;
    const FRAME_CONSTANTS_STRIDE = 1024;
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

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // What a frame in flight records into.
    class QueuedFrame {
        constructor(public commandAllocator: NriCommandAllocatorHandle, public commandBuffer: NriCommandBufferHandle) {
        }
    }

    // A swap chain texture, its view and the semaphores of its acquire and release.
    class SwapChainTexture {
        constructor(public texture: NriTextureHandle, public colorAttachment: NriDescriptorHandle,
            public acquireSemaphore: NriFenceHandle, public releaseSemaphore: NriFenceHandle) {
        }
    }

    // --- Math (as the Donut example's) ------------------------------------------------------------

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

    // A float32 value is finite.
    function isFinite32(x: number): boolean {
        return x > -1.0e38 && x < 1.0e38;
    }

    // A state's n, l, m, with what is drawn from it: its normalization, the cumulative radial
    // distribution r^2 R^2 over RADIAL_TABLE_SIZE points to radialExtent(n), and the maximum of the
    // angular one, (1 - t^2)^|m| P^2 over t = cos(theta).
    class Orbital {
        norm: number;
        private extent: number;
        private cdf: number[] = [];
        private angularMax: number = 0.0;
        // Eigenstate's result, psi without the e^(-i E t).
        re: number = 0.0;
        im: number = 0.0;

        constructor(public n: int, public l: int, public m: int) {
            this.norm = normalization(n, l, m);
            this.extent = radialExtent(n);

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

        // A point drawn from |psi_nlm|^2 into px, py, pz of the target: r by the radial table,
        // cos(theta) by rejection, phi uniformly.
        sample(target: AtomOrbitals) {
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

    // Quaternion product a * b, (w, x, y, z), in float32 as donut::math's.
    function quatMultiply(a: number[], b: number[]) {
        const f = Math.fround;
        return [
            f(f(f(f(a[0] * b[0]) - f(a[1] * b[1])) - f(a[2] * b[2])) - f(a[3] * b[3])),
            f(f(f(f(a[0] * b[1]) + f(a[1] * b[0])) + f(a[2] * b[3])) - f(a[3] * b[2])),
            f(f(f(f(a[0] * b[2]) + f(a[2] * b[0])) + f(a[3] * b[1])) - f(a[1] * b[3])),
            f(f(f(f(a[0] * b[3]) + f(a[3] * b[0])) + f(a[1] * b[2])) - f(a[2] * b[1])),
        ];
    }

    // Donut's ThirdPersonCamera, as the Donut example uses it: orbiting the nucleus at distance,
    // turned by yaw and pitch (the left mouse button drags them, the wheel zooms). Its world-to-view
    // matrix in float32, as Donut computes it (compute_nbody_nri's port).
    class ThirdPersonCamera {
        target: number[] = [0.0, 0.0, 0.0];
        distance: number = 0.0;
        yaw: number = 0.0;
        pitch: number = 0.0;
        // mouse sensitivity in radians/pixel
        rotateSpeed: number = 0.005;

        // Row-major, for row vectors (Donut's affineToHomogeneous(m_MatWorldToView)).
        worldToView: number[] = [];

        setRotation(yaw: number, pitch: number) {
            this.yaw = Math.fround(yaw);
            this.pitch = Math.fround(pitch);
        }

        // ThirdPersonCamera::AnimateOrbit with the mouse's motion (when orbiting) and
        // MouseScrollUpdate with the wheel's.
        orbit(deltaX: number, deltaY: number, wheel: number) {
            const f = Math.fround;
            this.yaw = f(this.yaw - f(this.rotateSpeed * f(deltaX)));
            this.pitch = f(this.pitch + f(this.rotateSpeed * f(deltaY)));
            // (Explicit: tslang's Math.max gets negative numbers wrong.)
            if (this.pitch < f(-0.5 * Math.PI)) {
                this.pitch = f(-0.5 * Math.PI);
            }
            if (this.pitch > f(0.5 * Math.PI)) {
                this.pitch = f(0.5 * Math.PI);
            }
            if (wheel != 0.0) {
                this.distance = f(wheel < 0.0 ? this.distance * f(1.15) : this.distance * f(1.0 / f(1.15)));
            }
        }

        // ThirdPersonCamera::Animate's world-to-view matrix.
        animate() {
            const f = Math.fround;
            // rotationQuat(float3(pitch, yaw, 0)).toMatrix()
            const halfX = f(0.5 * this.pitch);
            const halfY = f(0.5 * this.yaw);
            const quatX = [f(Math.cos(halfX)), f(Math.sin(halfX)), 0.0, 0.0];
            const quatY = [f(Math.cos(halfY)), 0.0, f(Math.sin(halfY)), 0.0];
            const quatZ = [1.0, 0.0, 0.0, 0.0];
            const q = quatMultiply(quatMultiply(quatZ, quatY), quatX);
            const w = q[0];
            const x = q[1];
            const y = q[2];
            const z = q[3];
            const row0 = [f(1.0 - f(2.0 * f(f(y * y) + f(z * z)))), f(2.0 * f(f(x * y) + f(z * w))), f(2.0 * f(f(x * z) - f(y * w)))];
            const row1 = [f(2.0 * f(f(x * y) - f(z * w))), f(1.0 - f(2.0 * f(f(x * x) + f(z * z)))), f(2.0 * f(f(y * z) + f(x * w)))];
            const row2 = [f(2.0 * f(f(x * z) + f(y * w))), f(2.0 * f(f(y * z) - f(x * w))), f(1.0 - f(2.0 * f(f(x * x) + f(y * y))))];

            // The camera at target - distance * forward; right = -row0, up = row1, forward = row2.
            const camPos = [0.0, 0.0, 0.0];
            const right = [0.0, 0.0, 0.0];
            for (let i = 0; i < 3; i++) {
                camPos[i] = f(this.target[i] + f(f(-this.distance) * row2[i]));
                right[i] = -row0[i];
            }

            // translation(-camPos) * affine3::from_cols(right, up, forward, 0)
            const columns = [right, row1, row2];
            const m: number[] = [];
            for (let r = 0; r < 3; r++) {
                for (let c = 0; c < 3; c++) {
                    m.push(columns[c][r]);
                }
                m.push(0.0);
            }
            for (let c = 0; c < 3; c++) {
                const column = columns[c];
                m.push(f(f(f(f(-camPos[0]) * column[0]) + f(f(-camPos[1]) * column[1])) + f(f(-camPos[2]) * column[2])));
            }
            m.push(1.0);
            this.worldToView = m;
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

    // Port of the atom_orbitals example (examples/atom_orbitals.ts) to NRI: hydrogen's electron as a
    // Bohmian flow, on compute_nbody's particles: psi is an eigenstate psi_nlm, or two superposed,
    // a psi_A + b psi_B e^(-i dE t). The particles start distributed as |psi|^2, and one compute
    // pass a frame (advance_cs) moves them with the guidance velocity v = Im(conj(psi) grad psi) /
    // |psi|^2, which keeps them distributed as |psi(t)|^2. They're drawn as additive sprites colored
    // by the phase of psi at them (or their speed). The UI (top right, off with -noUI) picks the
    // states, the share of the second and the particles: a change draws them anew. Space pauses;
    // left alone for IDLE_SECONDS, the camera orbits slowly. The camera: the left mouse button turns
    // it, the wheel zooms (the Donut example's ThirdPersonCamera also pans and takes keys).
    export class AtomOrbitals {
        private device: NriDeviceHandle | null = null;
        private queue: NriQueueHandle;
        private frameFence: NriFenceHandle;
        private swapChain: NriSwapChainHandle;
        private swapChainTextures: SwapChainTexture[] = [];
        private queuedFrames: QueuedFrame[] = [];
        private viewFormat: NriFormat = NriFormat.Unknown;
        private computeLayout: NriPipelineLayoutHandle | null = null;
        private advancePipeline: NriPipelineHandle | null = null;
        private drawLayout: NriPipelineLayoutHandle | null = null;
        private drawPipeline: NriPipelineHandle | null = null;
        private particleBuffer: NriBufferHandle | null = null;
        // The particles, written by the compute pass and read by the draw.
        private particlesStorage: NriDescriptorHandle | null = null;
        private particlesView: NriDescriptorHandle | null = null;
        // The particle buffer's state between frames (Storage before the first).
        private particlesDrawn: boolean = false;
        // A queued frame's view and display constants each, FRAME_CONSTANTS_STRIDE bytes apart.
        private constantBuffer: NriBufferHandle | null = null;
        private viewConstantsView: NriDescriptorHandle | null = null;
        private displayConstantsView: NriDescriptorHandle | null = null;
        private imgui: boolean = false;
        private width: int = 0;
        private height: int = 0;

        private camera: ThirdPersonCamera = new ThirdPersonCamera();
        private paused: boolean = false;
        private idleSeconds: number = 0.0;

        // The running states (orbitalB only while superposed), the second's share of the probability
        // (|b|^2), and the particles.
        private orbitalA: Orbital = new Orbital(1, 0, 0);
        private orbitalB: Orbital = new Orbital(1, 0, 0);
        private superposed: boolean = false;
        private weight: number = 0.0;
        private numParticles: int = 0;
        // Atomic time units since the particles were drawn.
        private simTime: number = 0.0;

        // The UI's settings: a change restarts the simulation, at the start of the next frame
        // (-orbital <n> <l> <m>, -mix <n> <l> <m>, -weight <w>, -particles <n>).
        uiA: int[] = [DEFAULT_N, DEFAULT_L, DEFAULT_M];
        uiB: int[] = [2, 1, 1];
        uiSuperposed: boolean = false;
        uiWeight: number = 0.5;
        uiParticles: int = DEFAULT_PARTICLES;
        private restartRequested: boolean = false;
        // Display settings, live (-timescale <a.u. per second>).
        timeScale: number = DEFAULT_TIME_SCALE;
        private colorMode: int = 0;
        private brightness: number = DEFAULT_BRIGHTNESS;
        private cutAway: boolean = false;
        // -test renders the same frames every run: no rotation.
        private autoRotate: boolean = true;
        // -noUI: no settings window.
        noUI: boolean = false;
        // -test: the particles' starting positions (empty otherwise), for the circles' check.
        private startPositions: number[] = [];

        // The SimulationConstants push constants; the DisplayConstants and PlanarViewConstants.
        private simulationConstants: f32[] = [];
        private displayConstants: f32[] = [];
        private viewConstants: f32[] = [];

        // Orbital.sample's result.
        px: number = 0.0;
        py: number = 0.0;
        pz: number = 0.0;

        // -test: the last frame and the particles after it are read back.
        private test: boolean = false;
        private readbackBuffer: NriBufferHandle | null = null;
        private particleReadbackBuffer: NriBufferHandle | null = null;
        private rowPitch: int = 0;
        private readbackFormat: NriFormat = NriFormat.Unknown;

        constructor(private sample: NriSampleHandle) {
            for (let i = 0; i < SIMULATION_FLOATS; i++) {
                this.simulationConstants.push(0.0);
            }
            for (let i = 0; i < DISPLAY_FLOATS; i++) {
                this.displayConstants.push(0.0);
            }
            for (let i = 0; i < VIEW_CONSTANTS_SIZE / 4; i++) {
                this.viewConstants.push(0.0);
            }
        }

        // Renders until the window is closed (in test mode, the test's frames); the exit code.
        run(argc: int, argv: Ref<string>): int {
            const initialize: NriInitializeCallback = this.initialize;
            const latencySleep: NriFrameCallback = this.latencySleep;
            const renderFrame: NriFrameCallback = this.renderFrame;
            retainedInitializeCallbacks.push(initialize);
            retainedFrameCallbacks.push(latencySleep);
            retainedFrameCallbacks.push(renderFrame);
            Nri_SetInitializeCallback(this.sample, initialize);
            Nri_SetLatencySleepCallback(this.sample, latencySleep);
            Nri_SetRenderFrameCallback(this.sample, renderFrame);

            let result = Nri_RunSample(this.sample, argc, argv, WINDOW_TITLE, TEST_FRAMES);
            if (result == 0 && this.test) {
                const failure = this.checkTest();
                console.log(failure == "" ? "Test PASSED" : `Test FAILED: ${failure}`);
                result = failure == "" ? 0 : 1;
            }
            this.destroy();
            return result;
        }

        initialize(graphicsAPI: NriGraphicsAPI): int {
            const device = Nri_CreateDevice(this.sample, graphicsAPI);
            if (!device) {
                console.log("Cannot initialize a graphics device with the requested parameters");
                return 0;
            }
            this.device = device;
            console.log(`Renderer: ${Nri_GetGraphicsAPIString(graphicsAPI)} (${Nri_GetAdapterName(device)})`);

            this.queue = Nri_GetGraphicsQueue(device);
            this.frameFence = Nri_CreateFence(device, 0);
            this.width = Nri_GetOutputWidth(this.sample);
            this.height = Nri_GetOutputHeight(this.sample);
            this.test = Nri_IsTest(this.sample) != 0;
            this.autoRotate = !this.test;

            // Swap chain: rendered through sRGB views, as into Donut's sRGB back buffers.
            const queuedFrameNum = Nri_GetQueuedFrameNum(this.sample);
            this.swapChain = Nri_CreateSwapChain(this.sample, device, this.queue, queuedFrameNum + 1);
            const textureNum = Nri_GetSwapChainTextureNum(this.swapChain);
            const format = Nri_GetTextureFormat(Nri_GetSwapChainTexture(this.swapChain, 0));
            const viewFormat = Nri_GetSrgbFormat(format);
            this.viewFormat = viewFormat;
            for (let i = 0; i < textureNum; i++) {
                const texture = Nri_GetSwapChainTexture(this.swapChain, i);
                this.swapChainTextures.push(new SwapChainTexture(texture, Nri_CreateColorAttachmentView(texture, viewFormat),
                    Nri_CreateSwapChainSemaphore(device), Nri_CreateSwapChainSemaphore(device)));
            }

            // Queued frames
            for (let i = 0; i < queuedFrameNum; i++) {
                const commandAllocator = Nri_CreateCommandAllocator(this.queue);
                this.queuedFrames.push(new QueuedFrame(commandAllocator, Nri_CreateCommandBuffer(commandAllocator)));
            }

            // The layouts: the compute pass's SimulationConstants (push constants, b0) and particles
            // (u0); the draw's view (b1) and display (b2) constants and particles (t0). All root
            // descriptors.
            const computeLayoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRootConstants(computeLayoutDesc, 0, SIMULATION_CONSTANTS_SIZE, NriStage.Compute);
            Nri_PipelineLayoutDescAddRootDescriptor(computeLayoutDesc, 0, NriDescriptorType.StorageStructuredBuffer, NriStage.Compute);
            this.computeLayout = Nri_CreatePipelineLayoutFromDesc(device, computeLayoutDesc);
            Nri_DestroyPipelineLayoutDesc(computeLayoutDesc);
            const drawLayoutDesc = Nri_CreatePipelineLayoutDesc();
            Nri_PipelineLayoutDescAddRootDescriptor(drawLayoutDesc, 1, NriDescriptorType.ConstantBuffer, NriStage.Vertex);
            Nri_PipelineLayoutDescAddRootDescriptor(drawLayoutDesc, 2, NriDescriptorType.ConstantBuffer, NriStage.Vertex);
            Nri_PipelineLayoutDescAddRootDescriptor(drawLayoutDesc, 0, NriDescriptorType.StructuredBuffer, NriStage.Vertex);
            this.drawLayout = Nri_CreatePipelineLayoutFromDesc(device, drawLayoutDesc);
            Nri_DestroyPipelineLayoutDesc(drawLayoutDesc);
            const computeLayout = this.computeLayout;
            const drawLayout = this.drawLayout;
            if (!computeLayout || !drawLayout) {
                console.log("Cannot create the pipeline layouts");
                return 0;
            }

            // The pipelines: atom_orbitals.hlsl's shaders, as compiled for the Donut example (the
            // compute shader with SIMULATION=1); the draw additively blended, back faces culled
            // (NVRHI's default raster state).
            const folder = graphicsAPI == NriGraphicsAPI.D3D11 ? "dxbc" : graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv";
            const shaders = `shaders/atom_orbitals/${folder}/atom_orbitals`;
            this.advancePipeline = Nri_CreateComputePipelinePermutation(device, computeLayout, `${shaders}_advance_cs.bin`, "advance_cs",
                "SIMULATION=1");
            const desc = Nri_CreatePipelineDesc();
            let loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Vertex, `${shaders}_main_vs.bin`, "main_vs") != 0;
            if (loaded) {
                loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Pixel, `${shaders}_main_ps.bin`, "main_ps") != 0;
            }
            Nri_PipelineDescSetCullMode(desc, NriCullMode.Back);
            Nri_PipelineDescSetColor(desc, viewFormat, NriColorWrite.RGBA);
            Nri_PipelineDescSetAdditiveBlend(desc);
            if (loaded) {
                this.drawPipeline = Nri_CreatePipelineFromDesc(device, drawLayout, desc);
            }
            Nri_DestroyPipelineDesc(desc);
            if (!this.advancePipeline || !this.drawPipeline) {
                console.log("Cannot load the atom orbitals shaders");
                return 0;
            }

            const constantBuffer = Nri_CreateHostBuffer(device, queuedFrameNum * FRAME_CONSTANTS_STRIDE, NriBufferUsage.ConstantBuffer);
            this.constantBuffer = constantBuffer;
            if (!constantBuffer) {
                console.log("Cannot create the constant buffer");
                return 0;
            }
            this.viewConstantsView = Nri_CreateConstantBufferView(constantBuffer, 0, VIEW_CONSTANTS_VIEW_SIZE);
            this.displayConstantsView = Nri_CreateConstantBufferView(constantBuffer, DISPLAY_CONSTANTS_OFFSET, DISPLAY_CONSTANTS_VIEW_SIZE);

            // The camera: (35, 20) degrees around the nucleus, far enough back to see the state.
            this.camera.setRotation(radians(35.0), radians(20.0));
            if (!this.createParticles(device)) {
                console.log("Cannot create the particles");
                return 0;
            }

            // The settings window.
            if (!this.noUI) {
                if (Nri_InitImgui(this.sample, device) == 0) {
                    console.log("Cannot initialize the user interface");
                    return 0;
                }
                this.imgui = true;
            }

            if (this.test) {
                const alignment = Nri_GetUploadBufferTextureRowAlignment(device);
                this.rowPitch = Math.floor((this.width * 4 + alignment - 1) / alignment) * alignment;
                this.readbackBuffer = Nri_CreateReadbackBuffer(device, this.rowPitch * this.height);
                this.particleReadbackBuffer = Nri_CreateReadbackBuffer(device, this.numParticles * PARTICLE_FLOATS * 4);
                this.readbackFormat = format;
            }
            return 1;
        }

        largestN(): int {
            return this.superposed && this.orbitalB.n > this.orbitalA.n ? this.orbitalB.n : this.orbitalA.n;
        }

        smallestN(): int {
            return this.superposed && this.orbitalB.n < this.orbitalA.n ? this.orbitalB.n : this.orbitalA.n;
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

        // The particles drawn from |psi|^2 at t = 0, with their phase, uploaded, and their views; the
        // camera far enough back to see the larger state whole. A superposition's
        // |a psi_A + b psi_B|^2 is at most 2 (|a psi_A|^2 + |b psi_B|^2), the mixture of the two
        // states' distributions (|a|^2 + |b|^2 = 1), doubled: points drawn from the mixture are kept
        // with the probability |psi|^2 / (2 mixture), which leaves them distributed as |psi|^2.
        // False on failure.
        createParticles(device: NriDeviceHandle): boolean {
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
                if (this.test) {
                    this.startPositions.push(x);
                    this.startPositions.push(y);
                    this.startPositions.push(z);
                }
            }

            const particleBuffer = Nri_CreateStorageBuffer(device, this.queue, Ref(particles[0]), this.numParticles * PARTICLE_FLOATS * 4,
                PARTICLE_FLOATS * 4);
            this.particleBuffer = particleBuffer;
            this.particlesDrawn = false;
            if (!particleBuffer) {
                return false;
            }
            this.particlesStorage = Nri_CreateStructuredBufferView(particleBuffer, 1);
            this.particlesView = Nri_CreateStructuredBufferView(particleBuffer, 0);

            const extent = sceneExtent(this.largestN());
            this.camera.distance = Math.fround(2.0 * extent);
            return true;
        }

        // The UI's settings applied: the particles drawn anew (the GPU done with the old ones).
        restart() {
            const device = this.device;
            if (!device) {
                return;
            }
            Nri_DeviceWaitIdle(device);
            this.destroyDescriptor(this.particlesStorage);
            this.destroyDescriptor(this.particlesView);
            this.destroyBuffer(this.particleBuffer);
            this.particlesStorage = null;
            this.particlesView = null;
            this.particleBuffer = null;
            g_RandomSeed = DEFAULT_SEED * 1.0;
            if (!this.createParticles(device)) {
                console.log("Cannot create the particles");
            }
        }

        // Waits for the frame that last used this frame's command allocator.
        latencySleep(frameIndex: int) {
            const queuedFrameNum = this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[frameIndex % queuedFrameNum];
            Nri_Wait(this.frameFence, frameIndex >= queuedFrameNum ? 1 + frameIndex - queuedFrameNum : 0);
            Nri_ResetCommandAllocator(queuedFrame.commandAllocator);
        }

        // The Donut example's onAnimate: a restart the UI asked for; the camera (its input, unless
        // the settings window has the mouse; its idle orbit); this frame's step from simTime: the
        // relative phase at its start, wrapped (only the relative phase of the two states moves
        // anything); the window title.
        update() {
            if (this.restartRequested) {
                this.restartRequested = false;
                this.restart();
            }

            // In test mode 1/60 second a frame in float32, as Donut's test mode passes it.
            const elapsedSeconds = Math.fround(this.test ? 1.0 / 60.0 : Nri_GetFrameTime(this.sample));
            if (Nri_IsKeyToggled(this.sample, NriKey.Space) != 0) {
                this.paused = !this.paused;
                this.idleSeconds = 0.0;
            }
            const overlay = this.imgui && Nri_ImguiWantsMouse() != 0;
            const orbiting = !overlay && Nri_IsButtonPressed(this.sample, 0) != 0;
            const wheel = overlay ? 0.0 : Nri_GetMouseWheel(this.sample);
            if (orbiting || wheel != 0.0) {
                this.idleSeconds = 0.0;
                this.camera.orbit(orbiting ? Nri_GetMouseDeltaX(this.sample) : 0.0, orbiting ? Nri_GetMouseDeltaY(this.sample) : 0.0, wheel);
            }

            this.idleSeconds += elapsedSeconds;
            if (this.autoRotate && this.idleSeconds > IDLE_SECONDS) {
                const ramp = Math.min((this.idleSeconds - IDLE_SECONDS) / IDLE_RAMP_SECONDS, 1.0);
                this.camera.setRotation(this.camera.yaw + IDLE_ROTATION_SPEED * ramp * elapsedSeconds, this.camera.pitch);
            }
            this.camera.animate();

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
            Nri_SetWindowTitle(this.sample,
                this.paused ? `${WINDOW_TITLE} - ${name}, ${this.numParticles} particles (paused)` : `${WINDOW_TITLE} - ${name}, ${this.numParticles} particles`);
        }

        // A state's n, l, m sliders, l and m kept in range as n and l change; true on a change.
        stateUI(label: string, state: int[]) {
            const n = Nri_ImguiSliderInt(`n ${label}`, state[0], 1, MAX_N);
            let l = state[1] < n ? state[1] : n - 1;
            l = Nri_ImguiSliderInt(`l ${label}`, l, 0, n - 1);
            let m = state[2];
            if (m > l) {
                m = l;
            }
            if (m < -l) {
                m = -l;
            }
            m = Nri_ImguiSliderInt(`m ${label}`, m, -l, l);
            const changed = n != state[0] || l != state[1] || m != state[2];
            state[0] = n;
            state[1] = l;
            state[2] = m;
            return changed;
        }

        // The settings window, top right.
        buildUI() {
            Nri_ImguiNewFrame(this.sample);
            Nri_ImguiSetNextWindowPosPivot(this.width - 10.0, 10.0, 1.0, 0.0);
            Nri_ImguiBegin("Atom Orbitals", 1);
            Nri_ImguiPushItemWidth(160.0);

            if (Nri_ImguiCollapsingHeader("State", 1) != 0) {
                Nri_ImguiText(`A: ${orbitalName(this.uiA[0], this.uiA[1], this.uiA[2])}, E = ${energy(this.uiA[0])}`);
                let changed = this.stateUI("(A)", this.uiA);
                const superposed = Nri_ImguiCheckbox("Superpose B", this.uiSuperposed ? 1 : 0) != 0;
                changed = changed || superposed != this.uiSuperposed;
                this.uiSuperposed = superposed;
                if (this.uiSuperposed) {
                    Nri_ImguiText(`B: ${orbitalName(this.uiB[0], this.uiB[1], this.uiB[2])}, E = ${energy(this.uiB[0])}`);
                    changed = this.stateUI("(B)", this.uiB) || changed;
                    const weight = Nri_ImguiSliderFloat("Share of B |b|^2", this.uiWeight, 0.0, 1.0);
                    changed = changed || weight != this.uiWeight;
                    this.uiWeight = weight;
                    const deltaE = energy(this.uiB[0]) - energy(this.uiA[0]);
                    if (deltaE != 0.0) {
                        Nri_ImguiText(`Beat period 2 pi / |dE| = ${2.0 * Math.PI / Math.abs(deltaE)} a.u.`);
                    } else {
                        Nri_ImguiText("Same energy: stationary");
                    }
                }
                const choice = Nri_ImguiCombo("Particles", particleChoiceIndex(this.uiParticles), PARTICLE_CHOICES);
                if (choice >= 0 && choice != particleChoiceIndex(this.uiParticles)) {
                    this.uiParticles = particleChoice(choice);
                    changed = true;
                }
                if (Nri_ImguiButton("Restart") != 0 || changed) {
                    this.restartRequested = true;
                }
            }

            if (Nri_ImguiCollapsingHeader("Simulation", 1) != 0) {
                this.paused = Nri_ImguiCheckbox("Paused (Space)", this.paused ? 1 : 0) != 0;
                this.timeScale = Nri_ImguiSliderFloat("Time scale (a.u./s)", this.timeScale, 0.0, TIME_SCALE_MAX);
                Nri_ImguiText(`t = ${this.simTime} a.u.`);
            }

            if (Nri_ImguiCollapsingHeader("Display", 1) != 0) {
                this.colorMode = Nri_ImguiCombo("Color", this.colorMode, COLOR_MODES);
                this.brightness = Nri_ImguiSliderFloat("Brightness", this.brightness, 0.02, 1.0);
                this.cutAway = Nri_ImguiCheckbox("Cut away x > 0", this.cutAway ? 1 : 0) != 0;
                this.autoRotate = Nri_ImguiCheckbox("Orbit when idle", this.autoRotate ? 1 : 0) != 0;
            }

            if (Nri_ImguiCollapsingHeader("Units", 0) != 0) {
                Nri_ImguiText("Atomic units: hbar = electron mass = e = 1");
                Nri_ImguiText("Length: Bohr radius a0 = 0.0529 nm (scene unit)");
                Nri_ImguiText("Time: hbar / E_h = 24.2 as; E_n = -1 / (2 n^2)");
                Nri_ImguiText("psi = a psi_A + b psi_B e^(-i dE t), dE = E_B - E_A");
                Nri_ImguiText("v = Im(conj(psi) grad psi) / |psi|^2");
                Nri_ImguiText("Phase colors: arg psi around the hue wheel");
            }

            Nri_ImguiPopItemWidth();
            Nri_ImguiEnd();
            Nri_ImguiRender(this.sample);
        }

        // The view constants main_vs reads (the camera; 60 degrees vertically) and the display
        // constants, for this frame, into the queued frame's part of the constant buffer.
        writeConstants(offset: int) {
            const constantBuffer = this.constantBuffer;
            if (!constantBuffer) {
                return;
            }
            const projection = perspProjD3DStyleReverse(radians(60.0), this.width / this.height, 0.1);
            const worldToView = this.camera.worldToView;
            for (let i = 0; i < 16; i++) {
                this.viewConstants[MAT_WORLD_TO_VIEW + i] = worldToView[i];
                this.viewConstants[MAT_VIEW_TO_CLIP + i] = projection[i];
            }
            this.viewConstants[VIEWPORT_ORIGIN] = 0.0;
            this.viewConstants[VIEWPORT_ORIGIN + 1] = 0.0;
            this.viewConstants[VIEWPORT_SIZE] = this.width;
            this.viewConstants[VIEWPORT_SIZE + 1] = this.height;
            this.viewConstants[VIEWPORT_SIZE_INV] = 1.0 / Math.fround(this.width);
            this.viewConstants[VIEWPORT_SIZE_INV + 1] = 1.0 / Math.fround(this.height);
            Nri_WriteBuffer(constantBuffer, offset, Ref(this.viewConstants[0]), VIEW_CONSTANTS_SIZE);

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
            Nri_WriteBuffer(constantBuffer, offset + DISPLAY_CONSTANTS_OFFSET, Ref(this.displayConstants[0]), DISPLAY_CONSTANTS_SIZE);
        }

        // advance_cs over the particles, which then go to the draw.
        recordCompute(commandBuffer: NriCommandBufferHandle) {
            const computeLayout = this.computeLayout;
            const advancePipeline = this.advancePipeline;
            const particleBuffer = this.particleBuffer;
            const particlesStorage = this.particlesStorage;
            if (!computeLayout || !advancePipeline || !particleBuffer || !particlesStorage) {
                return;
            }
            if (this.particlesDrawn) {
                Nri_CmdBufferBarrier(commandBuffer, particleBuffer, NriBufferState.VertexShaderResource, NriBufferState.Storage);
            }
            const groups: int = Math.floor((this.numParticles + WORKGROUP_SIZE - 1) / WORKGROUP_SIZE);
            Nri_CmdSetComputePipelineLayout(commandBuffer, computeLayout);
            Nri_CmdSetPipeline(commandBuffer, advancePipeline);
            Nri_CmdSetComputeRootConstants(commandBuffer, 0, Ref(this.simulationConstants[0]), SIMULATION_CONSTANTS_SIZE);
            Nri_CmdSetComputeRootDescriptor(commandBuffer, 0, particlesStorage);
            Nri_CmdDispatch(commandBuffer, groups, 1, 1);
            Nri_CmdBufferBarrier(commandBuffer, particleBuffer, NriBufferState.Storage, NriBufferState.VertexShaderResource);
            this.particlesDrawn = true;
        }

        // The particles' sprites and the nucleus (between Nri_CmdBeginRendering and
        // Nri_CmdEndRendering).
        recordDraw(commandBuffer: NriCommandBufferHandle, constantsOffset: int) {
            const drawLayout = this.drawLayout;
            const drawPipeline = this.drawPipeline;
            const viewConstantsView = this.viewConstantsView;
            const displayConstantsView = this.displayConstantsView;
            const particlesView = this.particlesView;
            if (!drawLayout || !drawPipeline || !viewConstantsView || !displayConstantsView || !particlesView) {
                return;
            }
            Nri_CmdSetViewport(commandBuffer, 0.0, 0.0, this.width, this.height);
            Nri_CmdSetScissor(commandBuffer, 0, 0, this.width, this.height);
            Nri_CmdSetPipelineLayout(commandBuffer, drawLayout);
            Nri_CmdSetPipeline(commandBuffer, drawPipeline);
            Nri_CmdSetRootDescriptor(commandBuffer, 0, viewConstantsView, constantsOffset);
            Nri_CmdSetRootDescriptor(commandBuffer, 1, displayConstantsView, constantsOffset);
            Nri_CmdSetRootDescriptor(commandBuffer, 2, particlesView, 0);
            Nri_CmdDraw(commandBuffer, (this.numParticles + 1) * VERTICES_PER_PARTICLE, 1, 0, 0);
        }

        renderFrame(frameIndex: int) {
            const queuedFrameIndex = frameIndex % this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            this.update();
            if (this.imgui) {
                this.buildUI();
            }

            // Acquire a swap chain texture
            const acquireSemaphore = this.swapChainTextures[frameIndex % this.swapChainTextures.length].acquireSemaphore;
            const index = Nri_AcquireNextTexture(this.swapChain, acquireSemaphore);
            if (index >= 0) {
                const swapChainTexture = this.swapChainTextures[index];
                const commandBuffer = queuedFrame.commandBuffer;
                const constantsOffset = queuedFrameIndex * FRAME_CONSTANTS_STRIDE;
                this.writeConstants(constantsOffset);

                // Record: the compute pass; cleared to black, the particles, the settings window.
                Nri_BeginCommandBuffer(commandBuffer);
                this.recordCompute(commandBuffer);
                if (this.imgui) {
                    Nri_CmdCopyImguiData(this.sample, commandBuffer);
                }
                Nri_CmdTextureBarrier(commandBuffer, swapChainTexture.texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                Nri_CmdBeginRendering(commandBuffer, swapChainTexture.colorAttachment);
                Nri_CmdClearColor(commandBuffer, 0.0, 0.0, 0.0, 1.0);
                this.recordDraw(commandBuffer, constantsOffset);
                if (this.imgui) {
                    Nri_CmdDrawImgui(this.sample, commandBuffer, this.viewFormat);
                }
                Nri_CmdEndRendering(commandBuffer);

                // The test's last frame: read back, and the particles after it
                let presentFrom = NriTextureState.ColorAttachment;
                const readbackBuffer = this.readbackBuffer;
                if (readbackBuffer) {
                    if (frameIndex == TEST_FRAMES - 1) {
                        Nri_CmdTextureBarrier(commandBuffer, swapChainTexture.texture, NriTextureState.ColorAttachment, NriTextureState.CopySource);
                        Nri_CmdReadbackTextureToBuffer(commandBuffer, readbackBuffer, this.rowPitch, swapChainTexture.texture, this.width, this.height);
                        presentFrom = NriTextureState.CopySource;
                        this.recordParticleReadback(commandBuffer);
                    }
                }
                Nri_CmdTextureBarrier(commandBuffer, swapChainTexture.texture, presentFrom, NriTextureState.Present);
                Nri_EndCommandBuffer(commandBuffer);

                // Submit and present
                Nri_QueueSubmit(this.queue, commandBuffer, acquireSemaphore, swapChainTexture.releaseSemaphore);
                if (this.imgui) {
                    Nri_ImguiEndFrame(this.sample);
                }
                Nri_QueuePresent(this.swapChain, swapChainTexture.releaseSemaphore);
            }

            // Signaled after the present, as NRISamples do
            Nri_QueueSignal(this.queue, this.frameFence, 1 + frameIndex);
        }

        // Copies the particles to particleReadbackBuffer (after the last frame's draw).
        recordParticleReadback(commandBuffer: NriCommandBufferHandle) {
            const particleBuffer = this.particleBuffer;
            const particleReadbackBuffer = this.particleReadbackBuffer;
            if (!particleBuffer || !particleReadbackBuffer) {
                return;
            }
            Nri_CmdBufferBarrier(commandBuffer, particleBuffer, NriBufferState.VertexShaderResource, NriBufferState.CopySource);
            Nri_CmdCopyBuffer(commandBuffer, particleReadbackBuffer, particleBuffer, this.numParticles * PARTICLE_FLOATS * 4);
            Nri_CmdBufferBarrier(commandBuffer, particleBuffer, NriBufferState.CopySource, NriBufferState.VertexShaderResource);
        }

        // -test, as the Donut example checks: the particles after the last frame: every position and
        // velocity finite, their mean distance from the nucleus the state's <r> (a superposition's:
        // the two states' shares of theirs, when their cross term vanishes), an eigenstate's angular
        // momentum L_z = m, and a superposition's <z>(t), 2 a b <A|z|B> cos(dE t). Then the frame:
        // black corners, particles drawn.
        checkTest(): string {
            const device = this.device;
            const particleReadbackBuffer = this.particleReadbackBuffer;
            if (!device || !particleReadbackBuffer) {
                return "cannot read the particles back";
            }
            Nri_DeviceWaitIdle(device);
            const particles: f32[] = [];
            for (let i = 0; i < this.numParticles * PARTICLE_FLOATS; i++) {
                particles.push(0.0);
            }
            if (Nri_ReadBufferFloats(particleReadbackBuffer, Ref(particles[0]), particles.length) == 0) {
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

            const pixels = this.readBack();
            if (pixels.length == 0) {
                return "cannot read the back buffer";
            }
            const xs = [0, this.width - 1, 0, this.width - 1];
            const ys = [0, 0, this.height - 1, this.height - 1];
            for (let k = 0; k < 4; k++) {
                const p = pixels[ys[k] * this.width + xs[k]] & 0xFFFFFF;
                if (p != 0) {
                    return `corner (${xs[k]}, ${ys[k]}) is ${p & 0xFF}, ${(p >> 8) & 0xFF}, ${(p >> 16) & 0xFF}, not 0, 0, 0`;
                }
            }
            let drawn = 0;
            for (let i = 0; i < pixels.length; i++) {
                if ((pixels[i] & 0xFFFFFF) != 0) {
                    drawn++;
                }
            }
            console.log(`Particles: ${drawn} pixels`);
            if (drawn < 1000) {
                return `Particles: ${drawn} pixels drawn, not 1000 or more`;
            }
            return "";
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

        // The last frame's pixels (0xAABBGGRR), empty if it can't be read.
        readBack(): int[] {
            const readbackBuffer = this.readbackBuffer;
            if (!readbackBuffer) {
                return [];
            }
            const pixels: int[] = [];
            for (let i = 0; i < this.width * this.height; i++) {
                pixels.push(0);
            }
            if (Nri_ReadBufferRGBA8(readbackBuffer, this.rowPitch, this.width, this.height, this.readbackFormat,
                Ref(pixels[0]), pixels.length) == 0) {
                return [];
            }
            return pixels;
        }

        destroy() {
            const device = this.device;
            if (device) {
                Nri_DeviceWaitIdle(device);
                if (this.imgui) {
                    Nri_DestroyImgui(this.sample);
                }
                for (const queuedFrame of this.queuedFrames) {
                    Nri_DestroyCommandBuffer(queuedFrame.commandBuffer);
                    Nri_DestroyCommandAllocator(queuedFrame.commandAllocator);
                }
                for (const swapChainTexture of this.swapChainTextures) {
                    Nri_DestroyFence(swapChainTexture.acquireSemaphore);
                    Nri_DestroyFence(swapChainTexture.releaseSemaphore);
                    Nri_DestroyDescriptor(swapChainTexture.colorAttachment);
                }
                this.destroyDescriptor(this.particlesStorage);
                this.destroyDescriptor(this.particlesView);
                this.destroyDescriptor(this.viewConstantsView);
                this.destroyDescriptor(this.displayConstantsView);
                this.destroyBuffer(this.particleBuffer);
                this.destroyBuffer(this.constantBuffer);
                this.destroyBuffer(this.readbackBuffer);
                this.destroyBuffer(this.particleReadbackBuffer);
                this.destroyPipeline(this.advancePipeline);
                this.destroyPipeline(this.drawPipeline);
                const computeLayout = this.computeLayout;
                if (computeLayout) {
                    Nri_DestroyPipelineLayout(computeLayout);
                }
                const drawLayout = this.drawLayout;
                if (drawLayout) {
                    Nri_DestroyPipelineLayout(drawLayout);
                }
                Nri_DestroyFence(this.frameFence);
                Nri_DestroySwapChain(this.swapChain);
                Nri_DestroyDevice(device);
            }
            Nri_DestroySample(this.sample);
        }

        destroyDescriptor(descriptor: NriDescriptorHandle | null) {
            if (descriptor) {
                Nri_DestroyDescriptor(descriptor);
            }
        }

        destroyBuffer(buffer: NriBufferHandle | null) {
            if (buffer) {
                Nri_DestroyBuffer(buffer);
            }
        }

        destroyPipeline(pipeline: NriPipelineHandle | null) {
            if (pipeline) {
                Nri_DestroyPipeline(pipeline);
            }
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = Nri_CreateSample();
        const orbitals = new AtomOrbitals(sample);
        // -orbital <n> <l> <m>: the state (3 2 1 by default); -mix <n> <l> <m>: a second state
        // superposed (with -weight); -weight <w>: its share of the probability, |b|^2 (0, none, by
        // default); -particles <n>; -timescale <a.u. per second>; -noUI: no settings window.
        Nri_AddExampleOptionWithValues(sample, "-orbital", 3);
        Nri_AddExampleOptionWithValues(sample, "-mix", 3);
        Nri_AddExampleOptionWithValues(sample, "-weight", 1);
        Nri_AddExampleOptionWithValues(sample, "-particles", 1);
        Nri_AddExampleOptionWithValues(sample, "-timescale", 1);
        Nri_AddExampleOption(sample, "-noUI");
        Nri_UseImgui(sample);
        let weight = 0.0;
        for (let i = 1; i < argc; i++) {
            const arg = Nri_GetArg(argc, argv, i);
            if (arg == "-orbital" && i + 3 < argc) {
                orbitals.uiA = [parseInt(Nri_GetArg(argc, argv, i + 1)), parseInt(Nri_GetArg(argc, argv, i + 2)),
                    parseInt(Nri_GetArg(argc, argv, i + 3))];
                i += 3;
            } else if (arg == "-mix" && i + 3 < argc) {
                orbitals.uiB = [parseInt(Nri_GetArg(argc, argv, i + 1)), parseInt(Nri_GetArg(argc, argv, i + 2)),
                    parseInt(Nri_GetArg(argc, argv, i + 3))];
                i += 3;
            } else if (arg == "-weight" && i + 1 < argc) {
                weight = parseFloat(Nri_GetArg(argc, argv, i + 1));
                i++;
            } else if (arg == "-particles" && i + 1 < argc) {
                orbitals.uiParticles = parseInt(Nri_GetArg(argc, argv, i + 1));
                i++;
            } else if (arg == "-timescale" && i + 1 < argc) {
                orbitals.timeScale = parseFloat(Nri_GetArg(argc, argv, i + 1));
                i++;
            } else if (arg == "-noUI") {
                orbitals.noUI = true;
            }
        }
        clampState(orbitals.uiA);
        clampState(orbitals.uiB);
        if (orbitals.uiParticles < 1) {
            orbitals.uiParticles = 1;
        }
        orbitals.uiSuperposed = weight > 0.0;
        orbitals.uiWeight = weight > 0.0 ? weight : 0.5;
        return orbitals.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return AtomOrbitalsNri.main(argc, argv);
}
