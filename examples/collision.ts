// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";

namespace Collision {
    const WINDOW_TITLE = "Donut Example: Collision";
    const FONT_PATH = "media/fonts/OpenSans/OpenSans-Regular.ttf";
    // The sample's SegoeUI_18 sprite font (its lines 32 pixels apart) as the OpenSans size giving
    // its strings' widths (ImGui sizes a font by its ascent + descent, 1.3618 OpenSans ems); the
    // help screen's SegoeUI_36 title the same way.
    const FONT_SIZE = 31.5;
    const LINE_SPACING = 32.0;
    const TITLE_FONT_SIZE = 61.8;

    const PI = 3.14159274;
    const CAMERA_SPACING = 50.0;
    const GROUP_COUNT = 4;
    const GROUP_NAMES = ["Frustum", "Axis-aligned box", "Oriented box", "Ray"];

    // ATG::Colors.
    const BACKGROUND = 0.254901975;
    const GREEN = [0.062745102, 0.486274511, 0.062745102];
    const BLUE = [0.019607844, 0.372549027, 0.803921580];
    const ORANGE = [0.764705896, 0.176470593, 0.019607844];
    const LIGHT_GREY = [0.478431374, 0.478431374, 0.478431374];
    const OFF_WHITE = [0.635294139, 0.635294139, 0.635294139];
    const WHITE = [0.980392158, 0.980392158, 0.980392158];

    // VertexPositionColor: float3 position, float4 color.
    const VERTEX_FLOATS = 7;
    const MAX_VERTICES = 8192;

    // GLFW values.
    const KEY_1 = 49;
    const KEY_4 = 52;
    const KEY_A = 65;
    const KEY_D = 68;
    const KEY_S = 83;
    const KEY_W = 87;
    const KEY_ESCAPE = 256;
    const KEY_RIGHT = 262;
    const KEY_LEFT = 263;
    const KEY_DOWN = 264;
    const KEY_UP = 265;
    const KEY_HOME = 268;
    const KEY_END = 269;
    const KEY_F1 = 290;
    const ACTION_RELEASE = 0;
    const ACTION_PRESS = 1;
    const MOUSE_LEFT = 0;
    const MOUSE_RIGHT = 1;

    // --- Math (DirectXMath's layout: 4 x 4 matrices by rows, for row vectors; float precision) -


    function f(x: number): number {
        return Math.fround(x);
    }

    function multiply(a: number[], b: number[]): number[] {
        let result: number[] = [];
        for (let row = 0; row < 4; row++) {
            for (let column = 0; column < 4; column++) {
                let sum = 0.0;
                for (let k = 0; k < 4; k++) {
                    sum += a[row * 4 + k] * b[k * 4 + column];
                }
                result.push(f(sum));
            }
        }
        return result;
    }

    function inverse(m: number[]): number[] {
        const a00 = m[0]; const a01 = m[1]; const a02 = m[2]; const a03 = m[3];
        const a10 = m[4]; const a11 = m[5]; const a12 = m[6]; const a13 = m[7];
        const a20 = m[8]; const a21 = m[9]; const a22 = m[10]; const a23 = m[11];
        const a30 = m[12]; const a31 = m[13]; const a32 = m[14]; const a33 = m[15];
        const b00 = a00 * a11 - a01 * a10;
        const b01 = a00 * a12 - a02 * a10;
        const b02 = a00 * a13 - a03 * a10;
        const b03 = a01 * a12 - a02 * a11;
        const b04 = a01 * a13 - a03 * a11;
        const b05 = a02 * a13 - a03 * a12;
        const b06 = a20 * a31 - a21 * a30;
        const b07 = a20 * a32 - a22 * a30;
        const b08 = a20 * a33 - a23 * a30;
        const b09 = a21 * a32 - a22 * a31;
        const b10 = a21 * a33 - a23 * a31;
        const b11 = a22 * a33 - a23 * a32;
        const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
        const invDet = 1.0 / det;
        return [
            f((a11 * b11 - a12 * b10 + a13 * b09) * invDet),
            f((a02 * b10 - a01 * b11 - a03 * b09) * invDet),
            f((a31 * b05 - a32 * b04 + a33 * b03) * invDet),
            f((a22 * b04 - a21 * b05 - a23 * b03) * invDet),
            f((a12 * b08 - a10 * b11 - a13 * b07) * invDet),
            f((a00 * b11 - a02 * b08 + a03 * b07) * invDet),
            f((a32 * b02 - a30 * b05 - a33 * b01) * invDet),
            f((a20 * b05 - a22 * b02 + a23 * b01) * invDet),
            f((a10 * b10 - a11 * b08 + a13 * b06) * invDet),
            f((a01 * b08 - a00 * b10 - a03 * b06) * invDet),
            f((a30 * b04 - a31 * b02 + a33 * b00) * invDet),
            f((a21 * b02 - a20 * b04 - a23 * b00) * invDet),
            f((a11 * b07 - a10 * b09 - a12 * b06) * invDet),
            f((a00 * b09 - a01 * b07 + a02 * b06) * invDet),
            f((a31 * b01 - a30 * b03 - a32 * b00) * invDet),
            f((a20 * b03 - a21 * b01 + a22 * b00) * invDet),
        ];
    }

    function normalize3(v: number[]): number[] {
        const length = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
        return [f(v[0] / length), f(v[1] / length), f(v[2] / length)];
    }

    function cross3(a: number[], b: number[]): number[] {
        return [f(a[1] * b[2] - a[2] * b[1]), f(a[2] * b[0] - a[0] * b[2]), f(a[0] * b[1] - a[1] * b[0])];
    }

    function dot3(a: number[], b: number[]): number {
        return f(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]);
    }

    // XMMatrixLookAtRH: XMMatrixLookToLH along eye - focus.
    function lookAtRH(eye: number[], focus: number[], up: number[]): number[] {
        const r2 = normalize3([f(eye[0] - focus[0]), f(eye[1] - focus[1]), f(eye[2] - focus[2])]);
        const r0 = normalize3(cross3(up, r2));
        const r1 = cross3(r2, r0);
        const negEye = [-eye[0], -eye[1], -eye[2]];
        return [
            r0[0], r1[0], r2[0], 0.0,
            r0[1], r1[1], r2[1], 0.0,
            r0[2], r1[2], r2[2], 0.0,
            dot3(r0, negEye), dot3(r1, negEye), dot3(r2, negEye), 1.0,
        ];
    }

    // XMMatrixPerspectiveFovLH, XMMatrixPerspectiveFovRH.
    function perspectiveFov(fovY: number, aspect: number, nearZ: number, farZ: number, rightHanded: boolean): number[] {
        const height = f(Math.cos(0.5 * fovY) / Math.sin(0.5 * fovY));
        const width = f(height / aspect);
        if (rightHanded) {
            const range = f(farZ / (nearZ - farZ));
            return [width, 0.0, 0.0, 0.0, 0.0, height, 0.0, 0.0, 0.0, 0.0, range, -1.0, 0.0, 0.0, f(range * nearZ), 0.0];
        }
        const range = f(farZ / (farZ - nearZ));
        return [width, 0.0, 0.0, 0.0, 0.0, height, 0.0, 0.0, 0.0, 0.0, range, 1.0, 0.0, 0.0, f(-range * nearZ), 0.0];
    }

    // v (a point) * m.
    function transformPoint(v: number[], m: number[]): number[] {
        let result: number[] = [];
        for (let i = 0; i < 3; i++) {
            result.push(f(v[0] * m[i] + v[1] * m[4 + i] + v[2] * m[8 + i] + m[12 + i]));
        }
        return result;
    }

    // v (a direction) * m.
    function transformNormal(v: number[], m: number[]): number[] {
        let result: number[] = [];
        for (let i = 0; i < 3; i++) {
            result.push(f(v[0] * m[i] + v[1] * m[4 + i] + v[2] * m[8 + i]));
        }
        return result;
    }

    // Quaternions (x, y, z, w). XMQuaternionMultiply(q1, q2): q1's rotation, then q2's.
    function quaternionMultiply(q1: number[], q2: number[]): number[] {
        return [
            f(q2[3] * q1[0] + q2[0] * q1[3] + q2[1] * q1[2] - q2[2] * q1[1]),
            f(q2[3] * q1[1] - q2[0] * q1[2] + q2[1] * q1[3] + q2[2] * q1[0]),
            f(q2[3] * q1[2] + q2[0] * q1[1] - q2[1] * q1[0] + q2[2] * q1[3]),
            f(q2[3] * q1[3] - q2[0] * q1[0] - q2[1] * q1[1] - q2[2] * q1[2]),
        ];
    }

    function quaternionNormalize(q: number[]): number[] {
        const length = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
        return [f(q[0] / length), f(q[1] / length), f(q[2] / length), f(q[3] / length)];
    }

    // XMQuaternionInverse.
    function quaternionInverse(q: number[]): number[] {
        const lengthSq = f(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
        if (lengthSq <= 1.192092896e-7) {
            return [0.0, 0.0, 0.0, 0.0];
        }
        return [f(-q[0] / lengthSq), f(-q[1] / lengthSq), f(-q[2] / lengthSq), f(q[3] / lengthSq)];
    }

    // XMQuaternionRotationAxis.
    function quaternionRotationAxis(axis: number[], angle: number): number[] {
        const n = normalize3(axis);
        const s = f(Math.sin(0.5 * angle));
        return [f(n[0] * s), f(n[1] * s), f(n[2] * s), f(Math.cos(0.5 * angle))];
    }

    // XMVector3Rotate.
    function rotate3(v: number[], q: number[]): number[] {
        const conjugate = [-q[0], -q[1], -q[2], q[3]];
        const result = quaternionMultiply(quaternionMultiply(conjugate, [v[0], v[1], v[2], 0.0]), q);
        return [result[0], result[1], result[2]];
    }

    // XMMatrixRotationQuaternion.
    function matrixRotationQuaternion(q: number[]): number[] {
        const x = q[0]; const y = q[1]; const z = q[2]; const w = q[3];
        return [
            f(1.0 - 2.0 * (y * y + z * z)), f(2.0 * (x * y + z * w)), f(2.0 * (x * z - y * w)), 0.0,
            f(2.0 * (x * y - z * w)), f(1.0 - 2.0 * (x * x + z * z)), f(2.0 * (y * z + x * w)), 0.0,
            f(2.0 * (x * z + y * w)), f(2.0 * (y * z - x * w)), f(1.0 - 2.0 * (x * x + y * y)), 0.0,
            0.0, 0.0, 0.0, 1.0,
        ];
    }

    // DirectXMath's (exact) XMQuaternionRotationRollPitchYaw and XMMatrixRotationRollPitchYaw.
    function quaternionRollPitchYaw(pitch: number, yaw: number, roll: number): number[] {
        let q: f32[] = [0.0, 0.0, 0.0, 1.0];
        Donut_QuaternionRotationRollPitchYaw(pitch, yaw, roll, Ref(q[0]));
        return [q[0], q[1], q[2], q[3]];
    }

    function matrixRollPitchYaw(pitch: number, yaw: number, roll: number): number[] {
        let m: f32[] = [];
        for (let i = 0; i < 16; i++) {
            m.push(0.0);
        }
        Donut_MatrixRotationRollPitchYaw(pitch, yaw, roll, Ref(m[0]));
        let result: number[] = [];
        for (let i = 0; i < 16; i++) {
            result.push(m[i]);
        }
        return result;
    }

    // ArcBall::QuatFromBallPoints.
    function quatFromBallPoints(from: number[], to: number[]): number[] {
        const part = cross3(from, to);
        return [part[0], part[1], part[2], dot3(from, to)];
    }

    // --- ATGTK's OrbitCamera ------------------------------------------------------------------

    // Ken Shoemake, "Arcball Rotation Control", Graphics Gems IV, pg 176 - 192
    class ArcBall {
        width: number;
        height: number;
        radius: number;
        qdown: number[];
        qnow: number[];
        downPoint: number[];
        drag: boolean;

        constructor() {
            this.width = 800.0;
            this.height = 400.0;
            this.radius = 1.0;
            this.qdown = [0.0, 0.0, 0.0, 1.0];
            this.qnow = [0.0, 0.0, 0.0, 1.0];
            this.downPoint = [0.0, 0.0, 0.0];
            this.drag = false;
        }

        reset(): void {
            this.qdown = [0.0, 0.0, 0.0, 1.0];
            this.qnow = [0.0, 0.0, 0.0, 1.0];
        }

        onBegin(x: number, y: number, quat: number[]): void {
            this.drag = true;
            this.qdown = quat;
            this.downPoint = this.screenToVector(x, y);
        }

        onMove(x: number, y: number): void {
            if (this.drag) {
                const curr = this.screenToVector(x, y);
                this.qnow = quaternionNormalize(quaternionMultiply(this.qdown, quatFromBallPoints(this.downPoint, curr)));
            }
        }

        screenToVector(screenX: number, screenY: number): number[] {
            let x = f(-(screenX - this.width / 2.0) / (this.radius * this.width / 2.0));
            let y = f((screenY - this.height / 2.0) / (this.radius * this.height / 2.0));
            let z = 0.0;
            const mag = f(x * x + y * y);
            if (mag > 1.0) {
                const scale = f(1.0 / Math.sqrt(mag));
                x = f(x * scale);
                y = f(y * scale);
            } else {
                z = f(Math.sqrt(1.0 - mag));
            }
            return [x, y, z];
        }

    }

    // OrbitCamera with the sample's settings: radius 25, translation, roll, radius and sensitivity
    // controls off, arrow keys (and W, A, S, D) orbiting; right-handed. The mouse's left button
    // drags an arcball; the right one switches the mouse to relative mode (hidden, captured) while
    // held, which here only stops the keys orbiting (translation is off). Home resets the view, End
    // the focus and radius.
    class OrbitCamera {
        focus: number[];
        homeFocus: number[];
        rotation: number[];
        homeRotation: number[];
        radius: number;
        defaultRadius: number;
        width: int;
        height: int;
        arcBall: ArcBall;
        relativeMouse: boolean;
        cameraPosition: number[];

        constructor() {
            this.focus = [0.0, 0.0, 0.0];
            this.homeFocus = [0.0, 0.0, 0.0];
            this.rotation = [0.0, 0.0, 0.0, 1.0];
            this.homeRotation = [0.0, 0.0, 0.0, 1.0];
            this.radius = 25.0;
            this.defaultRadius = 25.0;
            this.width = 1280;
            this.height = 720;
            this.arcBall = new ArcBall();
            this.relativeMouse = false;
            this.cameraPosition = [0.0, 0.0, 0.0];
        }

        reset(): void {
            this.focus = [this.homeFocus[0], this.homeFocus[1], this.homeFocus[2]];
            this.radius = this.defaultRadius;
            this.rotation = [this.homeRotation[0], this.homeRotation[1], this.homeRotation[2], this.homeRotation[3]];
            this.arcBall.reset();
            this.arcBall.drag = false;
        }

        setWindow(width: int, height: int): void {
            this.width = width;
            this.height = height;
            this.arcBall.width = width;
            this.arcBall.height = height;
        }

        setFocus(focus: number[]): void {
            this.focus = [focus[0], focus[1], focus[2]];
            this.homeFocus = [focus[0], focus[1], focus[2]];
        }

        setRotation(rotation: number[]): void {
            const nr = quaternionNormalize(rotation);
            this.rotation = nr;
            this.homeRotation = [nr[0], nr[1], nr[2], nr[3]];
        }

        getView(): number[] {
            const dir = rotate3([0.0, 0.0, 1.0], this.rotation);
            const up = rotate3([0.0, 1.0, 0.0], this.rotation);
            this.cameraPosition = [f(this.focus[0] + dir[0] * this.radius), f(this.focus[1] + dir[1] * this.radius), f(this.focus[2] + dir[2] * this.radius)];
            return lookAtRH(this.cameraPosition, this.focus, up);
        }

        getProjection(): number[] {
            const aspect = this.height > 0 ? f(f(this.width) / f(this.height)) : 1.0;
            return perspectiveFov(f(PI / 4.0), aspect, 0.1, 1000.0, true);
        }

        // OrbitCamera::Update(elapsedTime, mouse, keyboard): the mouse's position and buttons and
        // the keys held this frame. Returns the mouse mode wanted (true: relative).
        update(elapsedTime: number, mouseX: number, mouseY: number, leftButton: boolean, rightButton: boolean, held: boolean[]): boolean {
            const handed = -1.0;
            const im = inverse(this.getView());

            if (!this.relativeMouse && !this.arcBall.drag) {
                // Keyboard controls
                let orbitX = 0.0;
                let orbitY = 0.0;
                if (held[KEY_UP] || held[KEY_W]) {
                    orbitY = 1.0;
                }
                if (held[KEY_DOWN] || held[KEY_S]) {
                    orbitY = -1.0;
                }
                if (held[KEY_RIGHT] || held[KEY_D]) {
                    orbitX = 1.0;
                }
                if (held[KEY_LEFT] || held[KEY_A]) {
                    orbitX = -1.0;
                }
                if (orbitX != 0.0 || orbitY != 0.0) {
                    orbitX = f(orbitX * elapsedTime);
                    orbitY = f(orbitY * elapsedTime);
                    const right = [im[0], im[1], im[2]];
                    const up = [im[4], im[5], im[6]];
                    this.rotation = quaternionMultiply(this.rotation, quaternionRotationAxis(right, orbitY * handed));
                    this.rotation = quaternionMultiply(this.rotation, quaternionRotationAxis(up, -orbitX * handed));
                    this.rotation = quaternionNormalize(this.rotation);
                }

                if (held[KEY_HOME]) {
                    this.reset();
                } else if (held[KEY_END]) {
                    this.radius = this.defaultRadius;
                    this.focus = [this.homeFocus[0], this.homeFocus[1], this.homeFocus[2]];
                }
            }

            // Mouse controls
            if (!this.relativeMouse && this.arcBall.drag) {
                // Rotate camera
                this.arcBall.onMove(mouseX, mouseY);
                this.rotation = quaternionInverse(this.arcBall.qnow);
            }

            if (!this.arcBall.drag) {
                if (rightButton && !this.relativeMouse) {
                    this.relativeMouse = true;
                } else if (!rightButton && this.relativeMouse) {
                    this.relativeMouse = false;
                }
                if (leftButton) {
                    this.arcBall.onBegin(mouseX, mouseY, quaternionInverse(this.rotation));
                }
            } else if (!leftButton) {
                this.arcBall.drag = false;
            }
            return this.relativeMouse;
        }
    }

    // --- The sample ---------------------------------------------------------------------------

    // Port of the Xbox ATG Collision UWP sample (UWPSamples/System/CollisionUWP): four groups of
    // objects, each a primary object (a frustum, an axis-aligned box, an oriented box, a ray, in
    // blue) with a sphere, an oriented box, an axis-aligned box and a triangle moving around it,
    // colored by DirectXMath's collision test against it (green: disjoint, orange: intersecting,
    // white: contained; for the ray, white on a hit, and an orange box where it hit). 1 to 4 look
    // at a group (the sample's D-pad), the orbit camera turns around it.
    //
    // The tests are DirectXMath's own (core/directx_collision.cpp); the objects are drawn as the
    // sample's DebugDraw lines.
    class CollisionPass {
        private app: App;
        private camera: OrbitCamera;
        private held: boolean[];
        private mouseX: number;
        private mouseY: number;
        private leftButton: boolean;
        private rightButton: boolean;
        private relativeMouse: boolean;
        private totalTime: number;
        // The time Animate uses: the total time, or a fixed one (-time).
        fixedTime: number;

        showHelp: boolean;
        name: string;
        frameWidth: int;
        frameHeight: int;

        // The objects as DirectXCollision takes them (CollisionShape floats).
        private primaryFrustum: f32[];
        private primaryAABox: f32[];
        private primaryOrientedBox: f32[];
        private rayOrigin: f32[];
        private rayDirection: f32[];
        private spheres: f32[][];
        private orientedBoxes: f32[][];
        private aaBoxes: f32[][];
        private triangles: f32[][];
        // Containment per group: sphere, oriented box, box, triangle.
        private collisions: int[];
        private rayHitBox: f32[];
        private rayHit: boolean;
        private cameraOrigins: number[][];
        private distance: f32[];

        private vertices: f32[];
        private vertexCount: int;
        private vertexBuffer: Opaque;
        private vs: Opaque;
        private ps: Opaque;
        private inputLayout: Opaque;
        private bindingLayout: Opaque;
        private bindingSet: BindingSet;
        private pipeline: Opaque | null;
        private constants: f32[];

        constructor(app: App) {
            this.app = app;
            this.camera = new OrbitCamera();
            this.held = [];
            for (let i = 0; i < 512; i++) {
                this.held.push(false);
            }
            this.mouseX = 0.0;
            this.mouseY = 0.0;
            this.leftButton = false;
            this.rightButton = false;
            this.relativeMouse = false;
            this.totalTime = 0.0;
            this.fixedTime = -1.0;
            this.showHelp = false;
            this.name = GROUP_NAMES[0];
            this.frameWidth = 1280;
            this.frameHeight = 720;
            this.spheres = [];
            this.orientedBoxes = [];
            this.aaBoxes = [];
            this.triangles = [];
            this.collisions = [];
            this.cameraOrigins = [];
            this.distance = [0.0];
            this.vertices = [];
            for (let i = 0; i < MAX_VERTICES * VERTEX_FLOATS; i++) {
                this.vertices.push(0.0);
            }
            this.vertexCount = 0;
            this.pipeline = null;
            this.constants = [];
            for (let i = 0; i < 16; i++) {
                this.constants.push(0.0);
            }
            this.initializeObjects();
            this.setViewForGroup(0);
        }

        initializeObjects(): void {
            // Set up the primary frustum object from a D3D projection matrix
            // NOTE: This can also be done on your camera's projection matrix.  The projection
            // matrix built here is somewhat contrived so it renders well.
            let projection: f32[] = [];
            const xmProj = perspectiveFov(f(PI / 4.0), 1.77778, 0.5, 10.0, false);
            for (let i = 0; i < 16; i++) {
                projection.push(xmProj[i]);
            }
            this.primaryFrustum = [];
            for (let i = 0; i < 13; i++) {
                this.primaryFrustum.push(0.0);
            }
            Donut_CollisionFrustumFromMatrix(Ref(projection[0]), Ref(this.primaryFrustum[0]));
            this.primaryFrustum[2] = -7.0;
            this.cameraOrigins.push([0.0, 0.0, 0.0]);

            // Set up the primary axis aligned box
            this.primaryAABox = [CAMERA_SPACING, 0.0, 0.0, 5.0, 5.0, 5.0];
            this.cameraOrigins.push([CAMERA_SPACING, 0.0, 0.0]);

            // Set up the primary oriented box with some rotation
            const orientation = quaternionRollPitchYaw(f(PI / 4.0), f(PI / 4.0), 0.0);
            this.primaryOrientedBox = [-CAMERA_SPACING, 0.0, 0.0, 5.0, 5.0, 5.0, orientation[0], orientation[1], orientation[2], orientation[3]];
            this.cameraOrigins.push([-CAMERA_SPACING, 0.0, 0.0]);

            // Set up the primary ray
            this.rayOrigin = [0.0, 0.0, CAMERA_SPACING];
            this.rayDirection = [0.0, 0.0, 1.0];
            this.cameraOrigins.push([0.0, 0.0, CAMERA_SPACING]);

            // Initialize all of the secondary objects with default values
            for (let i = 0; i < GROUP_COUNT; i++) {
                this.spheres.push([0.0, 0.0, 0.0, 1.0]);
                this.orientedBoxes.push([0.0, 0.0, 0.0, 0.5, 0.5, 0.5, 0.0, 0.0, 0.0, 1.0]);
                this.aaBoxes.push([0.0, 0.0, 0.0, 0.5, 0.5, 0.5]);
                this.triangles.push([0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]);
                for (let j = 0; j < 4; j++) {
                    this.collisions.push(Containment.Disjoint);
                }
            }

            // Set up ray hit result box
            this.rayHitBox = [0.0, 0.0, 0.0, 0.05, 0.05, 0.05];
            this.rayHit = false;
        }

        // A triangle's points: the equilateral triangle of radius 2 in local space, turned by
        // XMMatrixRotationRollPitchYaw(t * 1.4, t * 2.5, t) and moved to (x, y, z).
        setTriangle(triangle: f32[], t: number, x: number, y: number, z: number): void {
            // triangle points in local space - equilateral triangle with radius of 2
            const points = [0.0, 2.0, 0.0, 1.732, -1.0, 0.0, -1.732, -1.0, 0.0];
            let coords = matrixRollPitchYaw(f(t * 1.4), f(t * 2.5), t);
            coords[12] = x;
            coords[13] = y;
            coords[14] = z;
            for (let p = 0; p < 3; p++) {
                const v = transformPoint([points[p * 3], points[p * 3 + 1], points[p * 3 + 2]], coords);
                triangle[p * 3] = v[0];
                triangle[p * 3 + 1] = v[1];
                triangle[p * 3 + 2] = v[2];
            }
        }

        setOrientation(box: f32[], q: number[]): void {
            box[6] = q[0];
            box[7] = q[1];
            box[8] = q[2];
            box[9] = q[3];
        }

        animate(time: number): void {
            const t = f(time * 0.2);

            const camera0OriginX = this.cameraOrigins[0][0];
            const camera1OriginX = this.cameraOrigins[1][0];
            const camera2OriginX = this.cameraOrigins[2][0];
            const camera3OriginX = this.cameraOrigins[3][0];
            const camera3OriginZ = this.cameraOrigins[3][2];
            const s = this.spheres;
            const o = this.orientedBoxes;
            const a = this.aaBoxes;

            // animate sphere 0 around the frustum
            s[0][0] = f(10.0 * f(Math.sin(f(3.0 * t))));
            s[0][1] = f(7.0 * f(Math.cos(f(5.0 * t))));

            // animate oriented box 0 around the frustum
            o[0][0] = f(8.0 * f(Math.sin(f(3.5 * t))));
            o[0][1] = f(5.0 * f(Math.cos(f(5.1 * t))));
            this.setOrientation(o[0], quaternionRollPitchYaw(f(t * 1.4), f(t * 0.2), t));

            // animate aligned box 0 around the frustum
            a[0][0] = f(10.0 * f(Math.sin(f(2.1 * t))));
            a[0][1] = f(7.0 * f(Math.cos(f(3.8 * t))));

            // animate sphere 1 around the aligned box
            s[1][0] = f(f(8.0 * f(Math.sin(f(2.9 * t)))) + camera1OriginX);
            s[1][1] = f(8.0 * f(Math.cos(f(4.6 * t))));
            s[1][2] = f(8.0 * f(Math.cos(f(1.6 * t))));

            // animate oriented box 1 around the aligned box
            o[1][0] = f(f(8.0 * f(Math.sin(f(3.2 * t)))) + camera1OriginX);
            o[1][1] = f(8.0 * f(Math.cos(f(2.1 * t))));
            o[1][2] = f(8.0 * f(Math.sin(f(1.6 * t))));
            this.setOrientation(o[1], quaternionRollPitchYaw(f(t * 0.7), f(t * 1.3), t));

            // animate aligned box 1 around the aligned box
            a[1][0] = f(f(8.0 * f(Math.sin(f(1.1 * t)))) + camera1OriginX);
            a[1][1] = f(8.0 * f(Math.cos(f(5.8 * t))));
            a[1][2] = f(8.0 * f(Math.cos(f(3.0 * t))));

            // animate sphere 2 around the oriented box
            s[2][0] = f(f(8.0 * f(Math.sin(f(2.2 * t)))) + camera2OriginX);
            s[2][1] = f(8.0 * f(Math.cos(f(4.3 * t))));
            s[2][2] = f(8.0 * f(Math.cos(f(1.8 * t))));

            // animate oriented box 2 around the oriented box
            o[2][0] = f(f(8.0 * f(Math.sin(f(3.7 * t)))) + camera2OriginX);
            o[2][1] = f(8.0 * f(Math.cos(f(2.5 * t))));
            o[2][2] = f(8.0 * f(Math.sin(f(1.1 * t))));
            this.setOrientation(o[2], quaternionRollPitchYaw(f(t * 0.9), f(t * 1.8), t));

            // animate aligned box 2 around the oriented box
            a[2][0] = f(f(8.0 * f(Math.sin(f(1.3 * t)))) + camera2OriginX);
            a[2][1] = f(8.0 * f(Math.cos(f(5.2 * t))));
            a[2][2] = f(8.0 * f(Math.cos(f(3.5 * t))));

            // animate triangle 0 around the frustum
            this.setTriangle(this.triangles[0], t, f(f(5.0 * f(Math.sin(f(5.3 * t)))) + camera0OriginX),
                f(5.0 * f(Math.cos(f(2.3 * t)))), f(5.0 * f(Math.sin(f(3.4 * t)))));

            // animate triangle 1 around the aligned box
            this.setTriangle(this.triangles[1], t, f(f(8.0 * f(Math.sin(f(5.3 * t)))) + camera1OriginX),
                f(8.0 * f(Math.cos(f(2.3 * t)))), f(8.0 * f(Math.sin(f(3.4 * t)))));

            // animate triangle 2 around the oriented box
            this.setTriangle(this.triangles[2], t, f(f(8.0 * f(Math.sin(f(5.3 * t)))) + camera2OriginX),
                f(8.0 * f(Math.cos(f(2.3 * t)))), f(8.0 * f(Math.sin(f(3.4 * t)))));

            // animate primary ray (this is the only animated primary object)
            this.rayDirection[0] = f(Math.sin(f(t * 3.0)));
            this.rayDirection[1] = 0.0;
            this.rayDirection[2] = f(Math.cos(f(t * 3.0)));

            // animate sphere 3 around the ray
            s[3][0] = f(camera3OriginX - 3.0);
            s[3][1] = f(0.5 * f(Math.sin(f(t * 5.0))));
            s[3][2] = camera3OriginZ;

            // animate aligned box 3 around the ray
            a[3][0] = f(camera3OriginX + 3.0);
            a[3][1] = f(0.5 * f(Math.sin(f(t * 4.0))));
            a[3][2] = camera3OriginZ;

            // animate oriented box 3 around the ray
            o[3][0] = camera3OriginX;
            o[3][1] = f(0.5 * f(Math.sin(f(t * 4.5))));
            o[3][2] = f(camera3OriginZ + 3.0);
            this.setOrientation(o[3], quaternionRollPitchYaw(f(t * 0.9), f(t * 1.8), t));

            // animate triangle 3 around the ray
            this.setTriangle(this.triangles[3], t, camera3OriginX, f(0.5 * f(Math.cos(f(4.3 * t)))), f(camera3OriginZ - 3.0));
        }

        // The containment of group g's objects in its primary (shape, floats).
        collideGroup(g: int, primaryShape: CollisionShape, primary: f32[]): void {
            this.collisions[g * 4] = Donut_CollisionContains(primaryShape, Ref(primary[0]), CollisionShape.Sphere, Ref(this.spheres[g][0]));
            this.collisions[g * 4 + 1] = Donut_CollisionContains(primaryShape, Ref(primary[0]), CollisionShape.OrientedBox, Ref(this.orientedBoxes[g][0]));
            this.collisions[g * 4 + 2] = Donut_CollisionContains(primaryShape, Ref(primary[0]), CollisionShape.Box, Ref(this.aaBoxes[g][0]));
            this.collisions[g * 4 + 3] = Donut_CollisionContains(primaryShape, Ref(primary[0]), CollisionShape.Triangle, Ref(this.triangles[g][0]));
        }

        // A ray test: the hit's distance in fDistance (the last hit wins, as in the sample).
        rayTest(shape: CollisionShape, s: f32[], index: int, fDistance: number): number {
            if (Donut_CollisionIntersectsRay(shape, Ref(s[0]), Ref(this.rayOrigin[0]), Ref(this.rayDirection[0]), Ref(this.distance[0])) != 0) {
                this.collisions[3 * 4 + index] = Containment.Intersects;
                return this.distance[0];
            }
            this.collisions[3 * 4 + index] = Containment.Disjoint;
            return fDistance;
        }

        collide(): void {
            // test collisions between objects and frustum
            this.collideGroup(0, CollisionShape.Frustum, this.primaryFrustum);
            // test collisions between objects and aligned box
            this.collideGroup(1, CollisionShape.Box, this.primaryAABox);
            // test collisions between objects and oriented box
            this.collideGroup(2, CollisionShape.OrientedBox, this.primaryOrientedBox);

            // test collisions between objects and ray
            let fDistance = -1.0;
            fDistance = this.rayTest(CollisionShape.Sphere, this.spheres[3], 0, fDistance);
            fDistance = this.rayTest(CollisionShape.OrientedBox, this.orientedBoxes[3], 1, fDistance);
            fDistance = this.rayTest(CollisionShape.Box, this.aaBoxes[3], 2, fDistance);
            fDistance = this.rayTest(CollisionShape.Triangle, this.triangles[3], 3, fDistance);

            // If one of the ray intersection tests was successful, fDistance will be positive.
            // If so, compute the intersection location and store it in g_RayHitResultBox.
            if (fDistance > 0.0) {
                // The primary ray's direction is assumed to be normalized.
                for (let i = 0; i < 3; i++) {
                    this.rayHitBox[i] = f(this.rayDirection[i] * fDistance + this.rayOrigin[i]);
                }
                this.rayHit = true;
            } else {
                this.rayHit = false;
            }
        }

        // Sets the camera to view a particular group of objects
        setViewForGroup(group: int): void {
            this.camera.setFocus(this.cameraOrigins[group]);
            this.camera.setRotation(quaternionRollPitchYaw(f(-PI / 4.0), 0.0, 0.0));
            this.name = GROUP_NAMES[group];
        }

        onKey(key: int, scancode: int, action: int, mods: int): int {
            if (key >= 0 && key < 512) {
                this.held[key] = action != ACTION_RELEASE;
            }
            if (action != ACTION_PRESS) {
                return 0;
            }
            // Keyboard input handling for controller help menu.
            if (key == KEY_F1) {
                this.showHelp = !this.showHelp;
            } else if (this.showHelp && key == KEY_ESCAPE) {
                this.showHelp = false;
            } else if (!this.showHelp && key >= KEY_1 && key <= KEY_4) {
                this.setViewForGroup(key - KEY_1);
            } else {
                // Escape (outside the help screen) goes on to InputPass, which closes the window.
                return 0;
            }
            return 1;
        }

        onMousePos(x: number, y: number): int {
            this.mouseX = x;
            this.mouseY = y;
            return 1;
        }

        onMouseButton(button: int, action: int, mods: int): int {
            if (button == MOUSE_LEFT) {
                this.leftButton = action != ACTION_RELEASE;
            } else if (button == MOUSE_RIGHT) {
                this.rightButton = action != ACTION_RELEASE;
            }
            return 1;
        }

        // Sample::Update: the objects move and are tested, then the camera follows the input.
        onAnimate(elapsedSeconds: number): void {
            this.app.setInformativeWindowTitle(WINDOW_TITLE);
            this.totalTime += elapsedSeconds;

            // Update position of collision objects.
            this.animate(this.fixedTime >= 0.0 ? this.fixedTime : this.totalTime);

            // Compute collisions.
            this.collide();

            if (!this.showHelp) {
                const relative = this.camera.update(f(elapsedSeconds), this.mouseX, this.mouseY, this.leftButton, this.rightButton, this.held);
                if (relative != this.relativeMouse) {
                    this.relativeMouse = relative;
                    if (relative) {
                        this.app.setCursorMode(CursorMode.Disabled);
                    } else {
                        this.app.setCursorMode(CursorMode.Normal);
                    }
                }
            }
        }

        // --- DebugDraw ---------------------------------------------------------------------------

        vertex(p: number[], color: number[]): void {
            if (this.vertexCount >= MAX_VERTICES) {
                return;
            }
            const v = this.vertices;
            const base = this.vertexCount * VERTEX_FLOATS;
            v[base] = p[0];
            v[base + 1] = p[1];
            v[base + 2] = p[2];
            v[base + 3] = color[0];
            v[base + 4] = color[1];
            v[base + 5] = color[2];
            v[base + 6] = 1.0;
            this.vertexCount++;
        }

        line(a: number[], b: number[], color: number[]): void {
            this.vertex(a, color);
            this.vertex(b, color);
        }

        // DrawCube: the unit cube's 12 edges through matWorld.
        drawCube(world: number[], color: number[]): void {
            const corners = [
                -1.0, -1.0, -1.0, 1.0, -1.0, -1.0, 1.0, -1.0, 1.0, -1.0, -1.0, 1.0,
                -1.0, 1.0, -1.0, 1.0, 1.0, -1.0, 1.0, 1.0, 1.0, -1.0, 1.0, 1.0,
            ];
            const indices = [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7];
            let verts: number[][] = [];
            for (let i = 0; i < 8; i++) {
                verts.push(transformPoint([corners[i * 3], corners[i * 3 + 1], corners[i * 3 + 2]], world));
            }
            for (let i = 0; i < indices.length; i++) {
                this.vertex(verts[indices[i]], color);
            }
        }

        drawBox(box: f32[], color: number[]): void {
            const world: number[] = [box[3], 0.0, 0.0, 0.0, 0.0, box[4], 0.0, 0.0, 0.0, 0.0, box[5], 0.0, box[0], box[1], box[2], 1.0];
            this.drawCube(world, color);
        }

        drawOrientedBox(box: f32[], color: number[]): void {
            const scale: number[] = [box[3], 0.0, 0.0, 0.0, 0.0, box[4], 0.0, 0.0, 0.0, 0.0, box[5], 0.0, 0.0, 0.0, 0.0, 1.0];
            const orientation: number[] = [box[6], box[7], box[8], box[9]];
            let world = multiply(scale, matrixRotationQuaternion(orientation));
            world[12] = box[0];
            world[13] = box[1];
            world[14] = box[2];
            this.drawCube(world, color);
        }

        drawFrustum(frustum: f32[], color: number[]): void {
            let c: f32[] = [];
            for (let i = 0; i < 24; i++) {
                c.push(0.0);
            }
            Donut_CollisionFrustumCorners(Ref(frustum[0]), Ref(c[0]));
            const edges = [0, 1, 1, 2, 2, 3, 3, 0, 0, 4, 1, 5, 2, 6, 3, 7, 4, 5, 5, 6, 6, 7, 7, 4];
            for (let i = 0; i < edges.length; i++) {
                const k = edges[i];
                const corner: number[] = [c[k * 3], c[k * 3 + 1], c[k * 3 + 2]];
                this.vertex(corner, color);
            }
        }

        // DrawRing: 32 segments, the sines and cosines rotated incrementally.
        drawRing(origin: number[], majorAxis: number[], minorAxis: number[], color: number[]): void {
            const segments = 32;
            const angleDelta = f(f(2.0 * PI) / segments);
            const cosDelta = f(Math.cos(angleDelta));
            const sinDelta = f(Math.sin(angleDelta));
            let incrementalSin = 0.0;
            let incrementalCos = 1.0;
            let points: number[][] = [];
            for (let i = 0; i < segments; i++) {
                let pos: number[] = [];
                for (let k = 0; k < 3; k++) {
                    pos.push(f(f(majorAxis[k] * incrementalCos + origin[k]) + minorAxis[k] * incrementalSin));
                }
                points.push(pos);
                // Standard formula to rotate a vector.
                const newCos = f(f(incrementalCos * cosDelta) - f(incrementalSin * sinDelta));
                const newSin = f(f(incrementalCos * sinDelta) + f(incrementalSin * cosDelta));
                incrementalCos = newCos;
                incrementalSin = newSin;
            }
            for (let i = 0; i < segments; i++) {
                this.line(points[i], points[(i + 1) % segments], color);
            }
        }

        drawSphere(sphere: f32[], color: number[]): void {
            const origin: number[] = [sphere[0], sphere[1], sphere[2]];
            const radius = sphere[3];
            const xaxis: number[] = [radius, 0.0, 0.0];
            const yaxis: number[] = [0.0, radius, 0.0];
            const zaxis: number[] = [0.0, 0.0, radius];
            this.drawRing(origin, xaxis, zaxis, color);
            this.drawRing(origin, xaxis, yaxis, color);
            this.drawRing(origin, yaxis, zaxis, color);
        }

        drawGrid(xAxis: number[], yAxis: number[], origin: number[], xdivs: int, ydivs: int, color: number[]): void {
            for (let i = 0; i <= xdivs; i++) {
                const percent = f(f(f(i) / f(xdivs)) * 2.0 - 1.0);
                const scale = [f(xAxis[0] * percent + origin[0]), f(xAxis[1] * percent + origin[1]), f(xAxis[2] * percent + origin[2])];
                this.line([f(scale[0] - yAxis[0]), f(scale[1] - yAxis[1]), f(scale[2] - yAxis[2])],
                    [f(scale[0] + yAxis[0]), f(scale[1] + yAxis[1]), f(scale[2] + yAxis[2])], color);
            }
            for (let i = 0; i <= ydivs; i++) {
                const percent = f(f(f(i) / f(ydivs)) * 2.0 - 1.0);
                const scale = [f(yAxis[0] * percent + origin[0]), f(yAxis[1] * percent + origin[1]), f(yAxis[2] * percent + origin[2])];
                this.line([f(scale[0] - xAxis[0]), f(scale[1] - xAxis[1]), f(scale[2] - xAxis[2])],
                    [f(scale[0] + xAxis[0]), f(scale[1] + xAxis[1]), f(scale[2] + xAxis[2])], color);
            }
        }

        // DrawRay (not normalized): its line strip has only the first two points, origin and
        // origin + direction.
        drawRay(origin: number[], direction: number[], color: number[]): void {
            this.line(origin, [f(direction[0] + origin[0]), f(direction[1] + origin[1]), f(direction[2] + origin[2])], color);
        }

        drawTriangle(t: f32[], color: number[]): void {
            const a: number[] = [t[0], t[1], t[2]];
            const b: number[] = [t[3], t[4], t[5]];
            const c: number[] = [t[6], t[7], t[8]];
            this.line(a, b, color);
            this.line(b, c, color);
            this.line(c, a, color);
        }

        // Returns the color based on the collision result and the group number.
        // Frustum tests (group 0) return 0, 1, or 2 for outside, partially inside, and fully inside;
        // all other tests return 0 or 1 for no collision or collision.
        collisionColor(collision: int, group: int): number[] {
            // special case: a value of 1 for groups 1 and higher needs to register as a full collision
            let c = collision;
            if (group >= 3 && c > 0) {
                c = Containment.Contains;
            }
            if (c == Containment.Disjoint) {
                return GREEN;
            }
            if (c == Containment.Intersects) {
                return ORANGE;
            }
            return WHITE;
        }

        // --- Rendering ----------------------------------------------------------------------------

        // Sample::Render: the scene's lines (opaque, no depth, no culling) with BasicEffect's
        // vertex colors.
        onRender(frameHandle: FrameHandle): void {
            const frame = new Frame(frameHandle);
            const width = frame.getWidth();
            const height = frame.getHeight();
            if (width != this.frameWidth || height != this.frameHeight) {
                this.frameWidth = width;
                this.frameHeight = height;
            }
            this.camera.setWindow(width, height);

            // Sample::Clear.
            frame.clearColor(BACKGROUND, BACKGROUND, BACKGROUND, 1.0);
            if (this.showHelp) {
                return;
            }

            this.vertexCount = 0;
            // Draw ground planes
            for (let i = 0; i < GROUP_COUNT; i++) {
                const origin = this.cameraOrigins[i];
                this.drawGrid([20.0, 0.0, 0.0], [0.0, 0.0, 20.0], [origin[0], f(origin[1] - 10.0), origin[2]], 20, 20, OFF_WHITE);
            }

            // Draw primary collision objects in white
            this.drawFrustum(this.primaryFrustum, BLUE);
            this.drawBox(this.primaryAABox, BLUE);
            this.drawOrientedBox(this.primaryOrientedBox, BLUE);

            const origin: number[] = [this.rayOrigin[0], this.rayOrigin[1], this.rayOrigin[2]];
            const direction = [f(this.rayDirection[0] * 10.0), f(this.rayDirection[1] * 10.0), f(this.rayDirection[2] * 10.0)];
            this.drawRay(origin, direction, LIGHT_GREY);
            this.drawRay(origin, direction, WHITE);

            // Draw secondary collision objects in colors based on collision results
            for (let i = 0; i < GROUP_COUNT; i++) {
                this.drawSphere(this.spheres[i], this.collisionColor(this.collisions[i * 4], i));
                this.drawOrientedBox(this.orientedBoxes[i], this.collisionColor(this.collisions[i * 4 + 1], i));
                this.drawBox(this.aaBoxes[i], this.collisionColor(this.collisions[i * 4 + 2], i));
                this.drawTriangle(this.triangles[i], this.collisionColor(this.collisions[i * 4 + 3], i));
            }

            // Draw results of ray-object intersection, if there was a hit this frame
            if (this.rayHit) {
                this.drawBox(this.rayHitBox, ORANGE);
            }

            if (!this.pipeline) {
                // PrimitiveBatch's line lists: opaque, DepthNone, CullNone. CommonStates' rasterizer
                // states have MultisampleEnable on, which makes D3D lines quadrilaterals 1.4 pixels
                // wide: Vulkan's rectangular lines that wide, where the device has them (D3D ignores
                // the width).
                let lineWidth = 1.4;
                if (this.app.getMaxLineWidth() < lineWidth) {
                    lineWidth = 1.0;
                }
                const desc = GraphicsPipelineDesc.create(this.vs, this.ps);
                desc.setInputLayout(this.inputLayout);
                desc.addBindingLayout(this.bindingLayout);
                desc.setPrimitiveType(PrimitiveType.LineList);
                desc.setDepthState(0, 0, ComparisonFunc.Always);
                desc.setRasterState(CullMode.None, FillMode.Solid, 0);
                desc.setDepthClip(1);
                if ((this.app.getLineRasterizationModes() & LineRasterization.Rectangular) != 0) {
                    desc.setLineRasterization(LineRasterizationMode.Rectangular, lineWidth, 0, 1, 0xFFFF);
                }
                this.pipeline = this.app.createGraphicsPipelineFromDescForFrame(desc, frame);
            }

            const viewProjection = multiply(this.camera.getView(), this.camera.getProjection());
            for (let i = 0; i < 16; i++) {
                this.constants[i] = viewProjection[i];
            }
            frame.getCommandList().writeBuffer(this.vertexBuffer, Ref(this.vertices[0]), this.vertexCount * VERTEX_FLOATS * 4);
            frame.beginDraw(this.pipeline as Opaque);
            frame.drawAddBindingSet(this.bindingSet);
            frame.drawAddVertexBuffer(this.vertexBuffer, 0, 0);
            frame.drawVerticesWithPushConstants(this.vertexCount, Ref(this.constants[0]), 64);
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(): boolean {
            this.vs = this.app.createShader("collision.hlsl", "line_vs", ShaderType.Vertex);
            this.ps = this.app.createShader("collision.hlsl", "line_ps", ShaderType.Pixel);
            if (!this.vs || !this.ps) {
                return false;
            }

            const layoutDesc = InputLayoutDesc.create();
            layoutDesc.addVertexAttribute("POSITION", Format.RGB32_FLOAT, 0, 0, VERTEX_FLOATS * 4);
            layoutDesc.addVertexAttribute("COLOR", Format.RGBA32_FLOAT, 12, 0, VERTEX_FLOATS * 4);
            this.inputLayout = this.app.createInputLayout(layoutDesc, this.vs);
            this.vertexBuffer = this.app.createDynamicVertexBuffer(MAX_VERTICES * VERTEX_FLOATS * 4, "Lines");

            const bindingLayoutDesc = BindingLayoutDesc.create();
            bindingLayoutDesc.layoutPushConstants(0, 64);
            this.bindingLayout = this.app.createBindingLayout(bindingLayoutDesc, ShaderType.All);
            const bindingSetDesc = BindingSetDesc.create();
            bindingSetDesc.bindPushConstants(0, 64);
            this.bindingSet = this.app.createBindingSetForLayout(bindingSetDesc, this.bindingLayout);

            const pass = this.app.addPass();
            pass.setKeyboardCallback(this.onKey);
            pass.setMousePosCallback(this.onMousePos);
            pass.setMouseButtonCallback(this.onMouseButton);
            pass.setAnimateCallback(this.onAnimate);
            pass.setRenderCallback(this.onRender);
            return true;
        }
    }

    // The sample's HUD (SpriteFont text in the title-safe area): the group's name at the top, the
    // controls at the bottom. Port: the help screen (ATG::Help, a gamepad picture with callouts)
    // is the sample's title, description and keyboard and mouse controls as text.
    class UserInterface {
        private sample: CollisionPass;
        private app: App;

        font: ImGuiFont;
        titleFont: ImGuiFont;

        constructor(sample: CollisionPass, app: App) {
            this.sample = sample;
            this.app = app;
        }

        buildUI(): void {
            const sample = this.sample;
            // SimpleMath::Viewport::ComputeTitleSafeArea
            const safeW = Math.fround((sample.frameWidth + 19.0) / 20.0);
            const safeH = Math.fround((sample.frameHeight + 19.0) / 20.0);
            const left: int = Math.floor(safeW);
            const top: int = Math.floor(safeH);
            const bottom: int = Math.floor(sample.frameHeight - safeH + 0.5);

            if (sample.showHelp) {
                this.titleFont.push();
                Donut_ImGuiDrawText(left, top, "Collision sample", WHITE[0], WHITE[1], WHITE[2], 1.0, 0);
                Donut_ImGuiPopFont();
                this.font.push();
                const y = top + TITLE_FONT_SIZE + LINE_SPACING;
                Donut_ImGuiDrawText(left, y, "This sample demonstrates DirectXMath's collision types", WHITE[0], WHITE[1], WHITE[2], 1.0, 0);
                const controls = [
                    "1: Frustum",
                    "2: Axis-aligned box",
                    "3: Oriented box",
                    "4: Ray",
                    "Arrow keys / W, A, S, D, left mouse button drag: Orbit X/Y",
                    "Home: Reset view",
                    "F1: Toggle help",
                    "Esc: Exit (or hide this help)",
                ];
                for (let i = 0; i < controls.length; i++) {
                    Donut_ImGuiDrawText(left, y + (i + 2) * LINE_SPACING, controls[i], WHITE[0], WHITE[1], WHITE[2], 1.0, 0);
                }
                Donut_ImGuiPopFont();
                return;
            }

            this.font.push();
            Donut_ImGuiDrawText(left, top, sample.name, WHITE[0], WHITE[1], WHITE[2], 1.0, 0);
            Donut_ImGuiDrawText(left, bottom - LINE_SPACING, "Esc - Exit   F1 - Help", LIGHT_GREY[0], LIGHT_GREY[1], LIGHT_GREY[2], 1.0, 0);
            Donut_ImGuiPopFont();
        }

        // Declared after buildUI: tslang resolves `this.buildUI` only for members declared earlier.
        init(): boolean {
            const imguiPass = this.app.addImGuiPass(this.buildUI);
            if (imguiPass.isNull()) {
                return false;
            }
            this.font = imguiPass.createFont(FONT_PATH, FONT_SIZE);
            this.titleFont = imguiPass.createFont(FONT_PATH, TITLE_FONT_SIZE);
            if (this.font.isNull() || this.titleFont.isNull()) {
                console.log("Cannot load the font: set DONUT_SAMPLES_MEDIA_DIR when configuring");
                return false;
            }
            return true;
        }
    }

    export function main(argc: int, argv: Ref<string>): int {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("collision");

        // -debug: the graphics API's debug layer and NVRHI's validation layer.
        // -group <1..4>: the group looked at first. -time <seconds>: the objects frozen at that time.
        // -help: start with the help screen.
        let options = AppOptions.UnormBackBuffer;
        let group = 0;
        let fixedTime = -1.0;
        let showHelp = false;
        for (let i = 1; i < argc; i++) {
            const arg = Donut_GetArg(argv, i);
            if (arg == "-debug") {
                options = options | AppOptions.DebugRuntime;
            } else if (arg == "-group" && i + 1 < argc) {
                i++;
                group = Math.min(Math.max(parseInt(Donut_GetArg(argv, i)), 1), GROUP_COUNT) - 1;
            } else if (arg == "-time" && i + 1 < argc) {
                i++;
                fixedTime = parseFloat(Donut_GetArg(argv, i));
            } else if (arg == "-help") {
                showHelp = true;
            }
        }

        // The sample's B8G8R8A8_UNORM back buffers, in a 1280 x 720 window.
        const api = Donut_GetGraphicsAPIFromCommandLine(argc, argv);
        const app = App.createWithOptions(api, WINDOW_TITLE, 1280, 720, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        // Before the sample's pass, which then sees the keys first (Escape closes the help screen).
        const input = new InputPass(app.handle);

        const sample = new CollisionPass(app);
        if (!sample.init()) {
            app.destroy();
            return 1;
        }
        sample.setViewForGroup(group);
        sample.fixedTime = fixedTime;
        sample.showHelp = showHelp;

        const ui = new UserInterface(sample, app);
        if (!ui.init()) {
            app.destroy();
            return 1;
        }

        app.run();
        app.destroy();
        return 0;
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>): int {
    return Collision.main(argc, argv);
}
