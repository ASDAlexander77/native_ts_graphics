// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";

namespace RenderOctomap {
    const WINDOW_TITLE = "Donut Example: Octomap Viewer";

    // The sample's map (Vulkan-Samples' assets, copied at build time: see VULKAN_SAMPLES_ASSETS_DIR
    // in CMakeLists.txt): an octomap binary tree file, the same scene as a glTF mesh with vertex
    // colors, and as Gaussian splats in glTF files of a grid cell each (KHR_gaussian_splatting).
    const MEDIA = "media/render_octomap/";
    const OCTOMAP_PATH = "media/render_octomap/octMap.bin";
    const GLTF_PATH = "media/render_octomap/savedMap_v1.2.0.gltf";
    // The sample takes the directory's *_cell_*.gltf files, sorted.
    const SPLAT_CELLS = [
        "savedMap_v1.2.0_cell_-1_-1_-1.gltf",
        "savedMap_v1.2.0_cell_-1_-1_0.gltf",
        "savedMap_v1.2.0_cell_-1_0_-1.gltf",
        "savedMap_v1.2.0_cell_-1_0_0.gltf",
        "savedMap_v1.2.0_cell_0_-1_-1.gltf",
        "savedMap_v1.2.0_cell_0_-1_0.gltf",
        "savedMap_v1.2.0_cell_0_0_-1.gltf",
        "savedMap_v1.2.0_cell_0_0_0.gltf",
    ];

    // The views.
    const VIEW_OCTOMAP = 0;
    const VIEW_GLTF = 1;
    const VIEW_SPLATS = 2;

    // octomap::OcTree: 16 levels, keys centered on 2^15.
    const TREE_DEPTH = 16;
    const TREE_MAX_VAL = 32768;

    // struct InstanceData { float pos[3]; float col[4]; float scale; }.
    const INSTANCE_FLOATS = 8;
    // struct SplatInstance { float pos[3], rot[4], scale[3], opacity, color[3], _pad; }, without the
    // padding (the sample's vertex binding stride is sizeof(SplatInstance), 60 bytes).
    const SPLAT_FLOATS = 15;
    // struct UBO { float4x4 projection, camera; }, as f32 offsets.
    const CONST_PROJECTION = 0;
    const CONST_CAMERA = 16;
    const CONST_FLOATS = 32;
    // The glTF view's push constants: float4x4 model; float4 color.
    const PUSH_FLOATS = 20;

    // The sample's camera: first person, at (0, 0, -1), 60 degrees vertically, depth from 0.1 to
    // 256; WASD move it a unit per second, numpad 4/6/8/2 turn it 60 degrees per second.
    const CAMERA_FOV = 60.0;
    const Z_NEAR = 0.1;
    const Z_FAR = 256.0;
    const TRANSLATION_SPEED = 1.0;
    const LOOK_SPEED = 60.0;
    // ApiVulkanSample's mouse controls: degrees per pixel dragged with the left button, zoom per
    // pixel with the right one, panning per pixel with the middle one.
    const ROTATION_SPEED = 1.0;
    const ZOOM_SPEED = 0.005;
    const PAN_SPEED = 0.01;

    // GLFW keys, mouse buttons and actions.
    const KEY_W = 87;
    const KEY_A = 65;
    const KEY_S = 83;
    const KEY_D = 68;
    const KEY_KP_2 = 322;
    const KEY_KP_4 = 324;
    const KEY_KP_6 = 326;
    const KEY_KP_8 = 328;
    const MOUSE_BUTTON_LEFT = 0;
    const MOUSE_BUTTON_RIGHT = 1;
    const MOUSE_BUTTON_MIDDLE = 2;
    const ACTION_RELEASE = 0;
    const ACTION_PRESS = 1;

    // ASCII.
    const CHAR_NEWLINE = 10;
    const CHAR_HASH = 35;
    const CHAR_MINUS = 45;
    const CHAR_DOT = 46;
    const CHAR_0 = 48;
    const CHAR_9 = 57;
    const CHAR_E = 69;
    const CHAR_D = 100;
    const CHAR_LOWER_E = 101;
    const CHAR_R = 114;
    const CHAR_S = 115;

    // --- Math (glm's layout: 4 x 4 matrices by columns) ---------------------------------------

    function radians(degrees: number): number {
        return degrees * Math.PI / 180.0;
    }

    // a * b.
    function multiply(a: number[], b: number[]): number[] {
        let result: number[] = [];
        for (let column = 0; column < 4; column++) {
            for (let row = 0; row < 4; row++) {
                let sum = 0.0;
                for (let k = 0; k < 4; k++) {
                    sum += a[k * 4 + row] * b[column * 4 + k];
                }
                result.push(sum);
            }
        }
        return result;
    }

    // glm::rotate(mat4(1), angle, axis) about a unit axis.
    function rotation(angle: number, x: number, y: number, z: number): number[] {
        const c = Math.cos(angle);
        const s = Math.sin(angle);
        const t = 1.0 - c;
        return [
            c + t * x * x,     t * x * y + s * z, t * x * z - s * y, 0.0,
            t * x * y - s * z, c + t * y * y,     t * y * z + s * x, 0.0,
            t * x * z + s * y, t * y * z - s * x, c + t * z * z,     0.0,
            0.0,               0.0,               0.0,               1.0,
        ];
    }

    function translation(x: number, y: number, z: number): number[] {
        return [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, x, y, z, 1.0];
    }

    function scale(x: number, y: number, z: number): number[] {
        return [x, 0.0, 0.0, 0.0, 0.0, y, 0.0, 0.0, 0.0, 0.0, z, 0.0, 0.0, 0.0, 0.0, 1.0];
    }

    // glm::perspective(fov, aspect, near, far) (right-handed, depth from 0 to 1), with clip y
    // negated: the sample's clip space has y down on the screen (Vulkan's), Donut's y up.
    function samplePerspective(fov: number, aspect: number, zNear: number, zFar: number): number[] {
        const tanHalfFovy = Math.tan(0.5 * fov);
        return [
            1.0 / (aspect * tanHalfFovy), 0.0,                0.0,                              0.0,
            0.0,                          -1.0 / tanHalfFovy, 0.0,                              0.0,
            0.0,                          0.0,                zFar / (zNear - zFar),            -1.0,
            0.0,                          0.0,                -(zFar * zNear) / (zFar - zNear), 0.0,
        ];
    }

    // The sample's hsv_to_rgb (h in [0,1], s and v in [0,1]), into rgb[0..2].
    function hsvToRgb(hIn: number, s: number, v: number, rgb: number[]): void {
        let h = hIn - Math.floor(hIn);
        h *= 6.0;
        const i = Math.floor(h);
        let f = h - i;
        if (i % 2 == 0) {
            f = 1.0 - f;
        }
        const m = v * (1.0 - s);
        const n = v * (1.0 - s * f);
        if (i == 6 || i == 0) {
            rgb[0] = v; rgb[1] = n; rgb[2] = m;
        } else if (i == 1) {
            rgb[0] = n; rgb[1] = v; rgb[2] = m;
        } else if (i == 2) {
            rgb[0] = m; rgb[1] = v; rgb[2] = n;
        } else if (i == 3) {
            rgb[0] = m; rgb[1] = n; rgb[2] = v;
        } else if (i == 4) {
            rgb[0] = n; rgb[1] = m; rgb[2] = v;
        } else if (i == 5) {
            rgb[0] = v; rgb[1] = m; rgb[2] = n;
        } else {
            rgb[0] = 1.0; rgb[1] = 0.5; rgb[2] = 0.5;
        }
    }

    // A decimal number in bytes [start, end) ("0.1", "-2e-3"...): digits as an integer, scaled by a
    // power of ten, as strtod rounds it for numbers of up to 15 digits.
    function parseNumber(bytes: int[], start: int, end: int): number {
        let i = start;
        let negative = false;
        if (i < end && bytes[i] == CHAR_MINUS) {
            negative = true;
            i++;
        }
        let mantissa = 0.0;
        let decimals = 0;
        let inFraction = false;
        while (i < end) {
            const c = bytes[i];
            if (c >= CHAR_0 && c <= CHAR_9) {
                mantissa = mantissa * 10.0 + (c - CHAR_0);
                if (inFraction) {
                    decimals++;
                }
            } else if (c == CHAR_DOT) {
                inFraction = true;
            } else {
                break;
            }
            i++;
        }
        let exponent = 0;
        if (i < end && (bytes[i] == CHAR_LOWER_E || bytes[i] == CHAR_E)) {
            i++;
            let exponentNegative = false;
            if (i < end && bytes[i] == CHAR_MINUS) {
                exponentNegative = true;
                i++;
            }
            while (i < end && bytes[i] >= CHAR_0 && bytes[i] <= CHAR_9) {
                exponent = exponent * 10 + (bytes[i] - CHAR_0);
                i++;
            }
            if (exponentNegative) {
                exponent = -exponent;
            }
        }
        exponent -= decimals;
        const value = exponent >= 0 ? mantissa * Math.pow(10.0, exponent) : mantissa / Math.pow(10.0, -exponent);
        return negative ? -value : value;
    }

    // octomap::OcTree's readBinary and its tree iterator: the file's header (resolution), then
    // the nodes, depth first, 2 bits per child (01 occupied leaf, 10 free leaf, 11 inner node,
    // 00 none), each inner node's children following it. The leaves come out in the order the
    // iterator visits them (children 0 to 7, depth first), with their centers and sizes as
    // keyToCoord and getNodeSize compute them.
    class OctomapReader {
        bytes: int[];
        position: int;
        resolution: number;
        // Every leaf: x, y, z (center) and size; and whether it's occupied.
        leaves: number[];
        occupied: boolean[];

        constructor() {
            this.bytes = [];
            this.position = 0;
            this.resolution = 0.1;
            this.leaves = [];
            this.occupied = [];
        }

        keyToCoord(key: int, depth: int): number {
            if (depth == 0) {
                return 0.0;
            }
            if (depth == TREE_DEPTH) {
                return (key - TREE_MAX_VAL + 0.5) * this.resolution;
            }
            const cells = Math.pow(2.0, TREE_DEPTH - depth);
            return (Math.floor((key - TREE_MAX_VAL) / cells) + 0.5) * this.resolution * cells;
        }

        addLeaf(depth: int, kx: int, ky: int, kz: int, occupied: boolean): void {
            this.leaves.push(this.keyToCoord(kx, depth));
            this.leaves.push(this.keyToCoord(ky, depth));
            this.leaves.push(this.keyToCoord(kz, depth));
            this.leaves.push(this.resolution * Math.pow(2.0, TREE_DEPTH - depth));
            this.occupied.push(occupied);
        }

        // computeChildKey for one axis.
        childKey(parentKey: int, centerOffsetKey: int, upper: boolean): int {
            if (upper) {
                return parentKey + centerOffsetKey;
            }
            return parentKey - centerOffsetKey - (centerOffsetKey != 0 ? 0 : 1);
        }

        readNode(depth: int, kx: int, ky: int, kz: int): boolean {
            if (this.position + 2 > this.bytes.length) {
                return false;
            }
            const child1to4 = this.bytes[this.position];
            const child5to8 = this.bytes[this.position + 1];
            this.position += 2;

            const childDepth = depth + 1;
            const centerOffsetKey = TREE_MAX_VAL >> childDepth;
            for (let i = 0; i < 8; i++) {
                const bits = i < 4 ? child1to4 : child5to8;
                const shift = (i % 4) * 2;
                const low = (bits >> shift) & 1;
                const high = (bits >> (shift + 1)) & 1;
                if (low == 0 && high == 0) {
                    continue;
                }
                const cx = this.childKey(kx, centerOffsetKey, (i & 1) != 0);
                const cy = this.childKey(ky, centerOffsetKey, (i & 2) != 0);
                const cz = this.childKey(kz, centerOffsetKey, (i & 4) != 0);
                if (low == 1 && high == 1) {
                    if (!this.readNode(childDepth, cx, cy, cz)) {
                        return false;
                    }
                } else {
                    // 01: occupied leaf, 10: free leaf.
                    this.addLeaf(childDepth, cx, cy, cz, high == 1);
                }
            }
            return true;
        }

        // The header's lines up to "data" (its resolution from "res"), then the tree.
        read(file: BinaryFile): boolean {
            const size = file.getSize();
            for (let i = 0; i < size; i++) {
                this.bytes.push(0);
            }
            if (size == 0) {
                return false;
            }
            file.copyBytes(0, size, Ref(this.bytes[0]));
            if (this.bytes[0] != CHAR_HASH) {
                return false;
            }
            let lineStart = 0;
            let foundData = false;
            while (lineStart < size && !foundData) {
                let lineEnd = lineStart;
                while (lineEnd < size && this.bytes[lineEnd] != CHAR_NEWLINE) {
                    lineEnd++;
                }
                const b = this.bytes;
                if (lineEnd - lineStart >= 4 && b[lineStart] == CHAR_R && b[lineStart + 1] == CHAR_LOWER_E
                    && b[lineStart + 2] == CHAR_S) {
                    this.resolution = parseNumber(b, lineStart + 4, lineEnd);
                } else if (lineEnd - lineStart >= 4 && b[lineStart] == CHAR_D && b[lineStart + 1] == 97
                    && b[lineStart + 2] == 116 && b[lineStart + 3] == 97) {
                    foundData = true;
                }
                lineStart = lineEnd + 1;
            }
            if (!foundData) {
                return false;
            }
            this.position = lineStart;
            return this.readNode(0, TREE_MAX_VAL, TREE_MAX_VAL, TREE_MAX_VAL);
        }
    }

    // Sorts order[] by key[] descending (merge sort, stable), with scratch[] as large as order.
    function sortDescending(order: int[], key: number[], scratch: int[]): void {
        const n = order.length;
        let width = 1;
        let src = order;
        let dst = scratch;
        let inScratch = false;
        while (width < n) {
            for (let left = 0; left < n; left += 2 * width) {
                const mid = Math.min(left + width, n);
                const right = Math.min(left + 2 * width, n);
                let i = left;
                let j = mid;
                let k = left;
                while (i < mid && j < right) {
                    if (key[src[j]] > key[src[i]]) {
                        dst[k] = src[j];
                        j++;
                    } else {
                        dst[k] = src[i];
                        i++;
                    }
                    k++;
                }
                while (i < mid) {
                    dst[k] = src[i];
                    i++;
                    k++;
                }
                while (j < right) {
                    dst[k] = src[j];
                    j++;
                    k++;
                }
            }
            const swap = src;
            src = dst;
            dst = swap;
            inScratch = !inScratch;
            width *= 2;
        }
        if (inScratch) {
            for (let i = 0; i < n; i++) {
                order[i] = src[i];
            }
        }
    }

    // Port of Vulkan-Samples' render_octomap: a map of a building, as an ARKit SLAM octomap (an
    // octree of occupied voxels, read from its compact binary file and drawn as instanced cubes
    // colored by height), as a glTF mesh with vertex colors, and as Gaussian splats (glTF files
    // with KHR_gaussian_splatting attributes, sorted back to front every frame and drawn as
    // camera-facing quads with premultiplied alpha). A first-person camera moves with WASD and
    // turns with the numpad (or the mouse); the overlay's buttons pick the view, from the keyboard
    // too (Tab, arrows, Enter).
    class OctomapPass {
        private app: App;

        // The view shown, as the overlay picks it.
        viewState: int;

        // The sample's camera: rotation (degrees about x, y, z) and position, and the keys held.
        private cameraRotation: number[];
        private cameraPosition: number[];
        private keyUp: boolean;
        private keyDown: boolean;
        private keyLeft: boolean;
        private keyRight: boolean;
        private lookUp: boolean;
        private lookDown: boolean;
        private lookLeft: boolean;
        private lookRight: boolean;
        private leftButton: boolean;
        private rightButton: boolean;
        private middleButton: boolean;
        private mouseX: number;
        private mouseY: number;

        private renderVS: ShaderHandle;
        private colorPS: ShaderHandle;
        private gltfVS: ShaderHandle;
        private splatVS: ShaderHandle;
        private splatPS: ShaderHandle;
        private octomapInputLayout: InputLayoutHandle;
        private gltfInputLayout: InputLayoutHandle;
        private splatInputLayout: InputLayoutHandle;
        private bindingLayout: Opaque;
        private gltfBindingLayout: Opaque;
        private bindingSet: BindingSet;
        private gltfBindingSet: BindingSet;
        private constantBuffer: BufferHandle;

        // Octomap: the cube and an instance per occupied voxel.
        private cubeVertices: BufferHandle;
        private cubeIndices: BufferHandle;
        private cubeIndexCount: int;
        private instanceBuffer: BufferHandle | null;
        instanceCount: int;

        // glTF: loaded when first shown.
        private gltfLoaded: boolean;
        private gltfPositions: BufferHandle | null;
        private gltfColors: BufferHandle | null;
        private gltfIndices: BufferHandle | null;
        private gltfDrawIndexCount: int[];
        private gltfDrawStartIndex: int[];
        private gltfDrawBaseVertex: int[];
        private gltfDrawConstants: f32[];

        // Splats: loaded when first shown; their data, the back-to-front order and the buffer
        // written in that order every frame.
        private splatsLoaded: boolean;
        private splatData: f32[];
        private splatOrder: int[];
        private splatScratch: int[];
        private splatDistance: number[];
        private splatSorted: f32[];
        private splatBuffer: BufferHandle | null;
        private splatQuadIndices: BufferHandle;
        splatCount: int;

        // The back buffer's size: color (sRGB, as the sample's swapchain) and depth targets.
        private colorBuffer: TextureHandle | null;
        private depthBuffer: TextureHandle | null;
        private framebuffer: Opaque | null;
        private octomapPipeline: Opaque | null;
        private gltfPipeline: Opaque | null;
        private splatPipeline: Opaque | null;

        private constants: f32[];
        private pushConstants: f32[];

        constructor(app: App) {
            this.app = app;
            this.viewState = VIEW_OCTOMAP;
            this.cameraRotation = [0.0, 0.0, 0.0];
            this.cameraPosition = [0.0, 0.0, -1.0];
            this.keyUp = false;
            this.keyDown = false;
            this.keyLeft = false;
            this.keyRight = false;
            this.lookUp = false;
            this.lookDown = false;
            this.lookLeft = false;
            this.lookRight = false;
            this.leftButton = false;
            this.rightButton = false;
            this.middleButton = false;
            this.mouseX = 0.0;
            this.mouseY = 0.0;
            this.cubeIndexCount = 0;
            this.instanceBuffer = null;
            this.instanceCount = 0;
            this.gltfLoaded = false;
            this.gltfPositions = null;
            this.gltfColors = null;
            this.gltfIndices = null;
            this.gltfDrawIndexCount = [];
            this.gltfDrawStartIndex = [];
            this.gltfDrawBaseVertex = [];
            this.gltfDrawConstants = [];
            this.splatsLoaded = false;
            this.splatData = [];
            this.splatOrder = [];
            this.splatScratch = [];
            this.splatDistance = [];
            this.splatSorted = [];
            this.splatBuffer = null;
            this.splatCount = 0;
            this.colorBuffer = null;
            this.depthBuffer = null;
            this.framebuffer = null;
            this.octomapPipeline = null;
            this.gltfPipeline = null;
            this.splatPipeline = null;
            this.constants = [];
            for (let i = 0; i < CONST_FLOATS; i++) {
                this.constants.push(0.0);
            }
            this.pushConstants = [];
            for (let i = 0; i < PUSH_FLOATS; i++) {
                this.pushConstants.push(0.0);
            }
        }

        // WASD move the camera, numpad 4/6/8/2 turn it. Seen before the overlay (see main), so
        // they work while it has the keyboard; the other keys go on to it.
        onKey(key: int, scancode: int, action: int, mods: int): int {
            if (action != ACTION_PRESS && action != ACTION_RELEASE) {
                return key == KEY_W || key == KEY_A || key == KEY_S || key == KEY_D || key == KEY_KP_2
                    || key == KEY_KP_4 || key == KEY_KP_6 || key == KEY_KP_8 ? 1 : 0;
            }
            const down = action == ACTION_PRESS;
            if (key == KEY_W) {
                this.keyUp = down;
            } else if (key == KEY_S) {
                this.keyDown = down;
            } else if (key == KEY_A) {
                this.keyLeft = down;
            } else if (key == KEY_D) {
                this.keyRight = down;
            } else if (key == KEY_KP_4) {
                this.lookLeft = down;
            } else if (key == KEY_KP_6) {
                this.lookRight = down;
            } else if (key == KEY_KP_8) {
                this.lookUp = down;
            } else if (key == KEY_KP_2) {
                this.lookDown = down;
            } else {
                return 0;
            }
            return 1;
        }

        // ApiVulkanSample's mouse handling: dragging with the left button rotates the camera, with
        // the right one zooms, with the middle one pans.
        onMousePos(x: number, y: number): int {
            const dx = this.mouseX - x;
            const dy = this.mouseY - y;
            if (this.leftButton) {
                this.cameraRotation[0] += dy * ROTATION_SPEED;
                this.cameraRotation[1] -= dx * ROTATION_SPEED;
            }
            if (this.rightButton) {
                this.cameraPosition[2] += dy * ZOOM_SPEED;
            }
            if (this.middleButton) {
                this.cameraPosition[0] -= dx * PAN_SPEED;
                this.cameraPosition[1] -= dy * PAN_SPEED;
            }
            this.mouseX = x;
            this.mouseY = y;
            return 1;
        }

        onMouseButton(button: int, action: int, mods: int): int {
            const pressed = action == ACTION_PRESS;
            if (button == MOUSE_BUTTON_LEFT) {
                this.leftButton = pressed;
            } else if (button == MOUSE_BUTTON_RIGHT) {
                this.rightButton = pressed;
            } else if (button == MOUSE_BUTTON_MIDDLE) {
                this.middleButton = pressed;
            }
            return 1;
        }

        // The framework's first-person camera update (WASD along the view direction and its
        // right), then the sample's numpad look.
        onAnimate(elapsedSeconds: number): void {
            const r = this.cameraRotation;
            const p = this.cameraPosition;
            if (this.keyUp || this.keyDown || this.keyLeft || this.keyRight) {
                let fx = -Math.cos(radians(r[0])) * Math.sin(radians(r[1]));
                let fy = Math.sin(radians(r[0]));
                let fz = Math.cos(radians(r[0])) * Math.cos(radians(r[1]));
                const length = Math.sqrt(fx * fx + fy * fy + fz * fz);
                fx /= length;
                fy /= length;
                fz /= length;
                // normalize(cross(front, (0, 1, 0))).
                const rightLength = Math.sqrt(fz * fz + fx * fx);
                const rx = -fz / rightLength;
                const rz = fx / rightLength;
                const moveSpeed = elapsedSeconds * TRANSLATION_SPEED;
                if (this.keyUp) {
                    p[0] += fx * moveSpeed;
                    p[1] += fy * moveSpeed;
                    p[2] += fz * moveSpeed;
                }
                if (this.keyDown) {
                    p[0] -= fx * moveSpeed;
                    p[1] -= fy * moveSpeed;
                    p[2] -= fz * moveSpeed;
                }
                if (this.keyLeft) {
                    p[0] -= rx * moveSpeed;
                    p[2] -= rz * moveSpeed;
                }
                if (this.keyRight) {
                    p[0] += rx * moveSpeed;
                    p[2] += rz * moveSpeed;
                }
            }

            // Apply numpad look: KP_4/6 = yaw left/right, KP_8/2 = pitch up/down
            const lookSpeed = LOOK_SPEED * elapsedSeconds;
            if (this.lookUp) {
                r[0] -= lookSpeed;
            }
            if (this.lookDown) {
                r[0] += lookSpeed;
            }
            if (this.lookLeft) {
                r[1] += lookSpeed;
            }
            if (this.lookRight) {
                r[1] -= lookSpeed;
            }
            this.app.setInformativeWindowTitle(WINDOW_TITLE);
        }

        releaseTargets(): void {
            const resources: (ResourceHandle | null)[] = [this.octomapPipeline, this.gltfPipeline, this.splatPipeline, this.framebuffer,
                this.colorBuffer, this.depthBuffer];
            for (let i = 0; i < resources.length; i++) {
                const resource = resources[i];
                if (resource) {
                    this.app.releaseResource(resource);
                }
            }
            this.octomapPipeline = null;
            this.gltfPipeline = null;
            this.splatPipeline = null;
            this.framebuffer = null;
            this.colorBuffer = null;
            this.depthBuffer = null;
        }

        onBackBufferResizing(): void {
            this.releaseTargets();
            // The blit's cached binding sets still reference the old color buffer.
            this.app.clearBindingCache();
        }

        createPipeline(framebuffer: Opaque, vertexShader: ShaderHandle, pixelShader: ShaderHandle, inputLayout: InputLayoutHandle, bindingLayout: Opaque,
            cullMode: CullMode, depthWrite: int, blendMode: BlendMode, primitiveType: PrimitiveType): Opaque {
            const desc = GraphicsPipelineDesc.create(vertexShader, pixelShader);
            desc.setInputLayout(inputLayout);
            desc.addBindingLayout(bindingLayout);
            desc.setPrimitiveType(primitiveType);
            desc.setDepthState(1, depthWrite, ComparisonFunc.LessOrEqual);
            desc.setRasterState(cullMode, FillMode.Solid, 1);
            // Clipped at the near plane, as Vulkan does (the camera walks through the map's walls).
            desc.setDepthClip(1);
            desc.setBlendMode(blendMode);
            return this.app.createGraphicsPipelineFromDesc(desc, framebuffer);
        }

        // The sample's pipelines: depth from 0 to 1 (less or equal passes), counter-clockwise front
        // faces; the splats unculled, without depth writes, blended with premultiplied alpha.
        createTargets(width: int, height: int): void {
            const colorBuffer = this.app.createRenderTargetTexture(width, height, Format.SRGBA8_UNORM, "ColorBuffer");
            const depthBuffer = this.app.createRenderTargetTexture(width, height, Format.D32, "DepthBuffer");
            const framebuffer = this.app.createFramebuffer(colorBuffer, depthBuffer);
            this.colorBuffer = colorBuffer;
            this.depthBuffer = depthBuffer;
            this.framebuffer = framebuffer;

            this.octomapPipeline = this.createPipeline(framebuffer, this.renderVS, this.colorPS, this.octomapInputLayout, this.bindingLayout,
                CullMode.Back, 1, BlendMode.None, PrimitiveType.TriangleList);
            this.gltfPipeline = this.createPipeline(framebuffer, this.gltfVS, this.colorPS, this.gltfInputLayout, this.gltfBindingLayout,
                CullMode.Back, 1, BlendMode.None, PrimitiveType.TriangleList);
            this.splatPipeline = this.createPipeline(framebuffer, this.splatVS, this.splatPS, this.splatInputLayout, this.bindingLayout,
                CullMode.None, 0, BlendMode.Premultiplied, PrimitiveType.TriangleStrip);
        }

        // The sample's update_ubo: a first-person camera, rotation * translation.
        updateConstants(width: int, height: int): void {
            const c = this.constants;
            const projection = samplePerspective(radians(CAMERA_FOV), width / height, Z_NEAR, Z_FAR);
            const r = this.cameraRotation;
            let rotationMatrix = multiply(rotation(radians(r[0]), 1.0, 0.0, 0.0), rotation(radians(r[1]), 0.0, 1.0, 0.0));
            rotationMatrix = multiply(rotationMatrix, rotation(radians(r[2]), 0.0, 0.0, 1.0));
            const p = this.cameraPosition;
            const view = multiply(rotationMatrix, translation(p[0], p[1], p[2]));
            for (let i = 0; i < 16; i++) {
                c[CONST_PROJECTION + i] = projection[i];
                c[CONST_CAMERA + i] = view[i];
            }
        }

        // Sort splats back-to-front for correct alpha compositing, from the camera's position
        // (-R^T * t of the view, the position negated for this camera), and write them in that
        // order.
        sortSplats(commandList: CommandList, splatBuffer: BufferHandle): void {
            const p = this.cameraPosition;
            const cx = -p[0];
            const cy = -p[1];
            const cz = -p[2];
            const data = this.splatData;
            for (let i = 0; i < this.splatCount; i++) {
                const dx = data[i * SPLAT_FLOATS] - cx;
                const dy = data[i * SPLAT_FLOATS + 1] - cy;
                const dz = data[i * SPLAT_FLOATS + 2] - cz;
                this.splatDistance[i] = dx * dx + dy * dy + dz * dz;
            }
            sortDescending(this.splatOrder, this.splatDistance, this.splatScratch);
            const sorted = this.splatSorted;
            for (let i = 0; i < this.splatCount; i++) {
                const src = this.splatOrder[i] * SPLAT_FLOATS;
                const dst = i * SPLAT_FLOATS;
                for (let k = 0; k < SPLAT_FLOATS; k++) {
                    sorted[dst + k] = data[src + k];
                }
            }
            commandList.writeBuffer(splatBuffer, Ref(sorted[0]), this.splatCount * SPLAT_FLOATS * 4);
        }

        onRender(frameHandle: FrameHandle): void {
            const frame = new Frame(frameHandle);
            const width = frame.getWidth();
            const height = frame.getHeight();
            const commandList = frame.getCommandList();

            if (!this.framebuffer) {
                this.createTargets(width, height);
            }
            const framebuffer = this.framebuffer;
            const colorBuffer = this.colorBuffer;
            const depthBuffer = this.depthBuffer;
            const octomapPipeline = this.octomapPipeline;
            const gltfPipeline = this.gltfPipeline;
            const splatPipeline = this.splatPipeline;
            if (!framebuffer || !colorBuffer || !depthBuffer || !octomapPipeline || !gltfPipeline || !splatPipeline) {
                return;
            }

            this.updateConstants(width, height);
            commandList.writeBuffer(this.constantBuffer, Ref(this.constants[0]), CONST_FLOATS * 4);

            commandList.clearTextureFloat(colorBuffer, 0.0, 0.0, 0.0, 1.0);
            commandList.clearDepth(depthBuffer, 1.0);

            const instanceBuffer = this.instanceBuffer;
            const gltfPositions = this.gltfPositions;
            const gltfColors = this.gltfColors;
            const gltfIndices = this.gltfIndices;
            const splatBuffer = this.splatBuffer;
            if (this.viewState == VIEW_OCTOMAP) {
                if (instanceBuffer) {
                    frame.beginDrawToFramebuffer(octomapPipeline, framebuffer);
                    frame.drawAddBindingSet(this.bindingSet);
                    frame.drawAddVertexBuffer(this.cubeVertices, 0, 0);
                    frame.drawAddVertexBuffer(instanceBuffer, 1, 0);
                    frame.drawSetIndexBuffer(this.cubeIndices);
                    frame.drawIndexedInstanced(this.cubeIndexCount, this.instanceCount);
                }
            } else if (this.viewState == VIEW_GLTF) {
                if (gltfPositions && gltfColors && gltfIndices) {
                    frame.beginDrawToFramebuffer(gltfPipeline, framebuffer);
                    frame.drawAddBindingSet(this.gltfBindingSet);
                    frame.drawAddVertexBuffer(gltfPositions, 0, 0);
                    frame.drawAddVertexBuffer(gltfColors, 1, 0);
                    frame.drawSetIndexBuffer(gltfIndices);
                    for (let d = 0; d < this.gltfDrawIndexCount.length; d++) {
                        for (let i = 0; i < PUSH_FLOATS; i++) {
                            this.pushConstants[i] = this.gltfDrawConstants[d * PUSH_FLOATS + i];
                        }
                        frame.drawIndexedRangeWithPushConstants(this.gltfDrawIndexCount[d], this.gltfDrawStartIndex[d],
                            this.gltfDrawBaseVertex[d], Ref(this.pushConstants[0]), PUSH_FLOATS * 4);
                    }
                }
            } else if (splatBuffer) {
                this.sortSplats(commandList, splatBuffer);
                frame.beginDrawToFramebuffer(splatPipeline, framebuffer);
                frame.drawAddBindingSet(this.bindingSet);
                frame.drawAddVertexBuffer(splatBuffer, 0, 0);
                frame.drawSetIndexBuffer(this.splatQuadIndices);
                frame.drawIndexedInstanced(4, this.splatCount);
            }

            this.app.blitTexture(frame, colorBuffer);
        }

        // The sample's build_cubes: an instance per occupied leaf, at its center (y negated), its
        // size, colored by height (hue from red, high, to 80% of the circle, low) between the
        // lowest and highest corners of all leaves.
        buildCubes(commandList: CommandList, reader: OctomapReader): void {
            const leaves = reader.leaves;
            const leafCount = reader.occupied.length;
            let minZ = 1e300;
            let maxZ = -1e300;
            for (let i = 0; i < leafCount; i++) {
                const halfSize = leaves[i * 4 + 3] / 2.0;
                minZ = Math.min(minZ, leaves[i * 4 + 2] - halfSize);
                maxZ = Math.max(maxZ, leaves[i * 4 + 2] - halfSize + leaves[i * 4 + 3]);
            }
            const zRange = maxZ - minZ;

            let instances: f32[] = [];
            let rgb: number[] = [0.0, 0.0, 0.0];
            for (let i = 0; i < leafCount; i++) {
                if (!reader.occupied[i]) {
                    continue;
                }
                const z = leaves[i * 4 + 2];
                instances.push(leaves[i * 4]);
                instances.push(-leaves[i * 4 + 1]);
                instances.push(z);
                let h = 0.5;
                if (zRange > 0.0) {
                    h = (1.0 - Math.min(Math.max((z - minZ) / zRange, 0.0), 1.0)) * 0.8;
                }
                hsvToRgb(h, 1.0, 1.0, rgb);
                instances.push(rgb[0]);
                instances.push(rgb[1]);
                instances.push(rgb[2]);
                instances.push(1.0);
                instances.push(leaves[i * 4 + 3]);
            }
            this.instanceCount = instances.length / INSTANCE_FLOATS;
            if (this.instanceCount > 0) {
                this.instanceBuffer = this.app.createStaticVertexBuffer(commandList, Ref(instances[0]), instances.length * 4,
                    "InstanceBuffer");
            }
        }

        // The sample's generate_master_cube: a unit cube, counter-clockwise outward faces.
        createCube(commandList: CommandList): void {
            const vertices: f32[] = [
                0.5, 0.5, 0.5,
                0.5, 0.5, -0.5,
                0.5, -0.5, 0.5,
                0.5, -0.5, -0.5,
                -0.5, 0.5, 0.5,
                -0.5, 0.5, -0.5,
                -0.5, -0.5, 0.5,
                -0.5, -0.5, -0.5,
            ];
            const indices: int[] = [
                // Right face (+X) - looking from +X toward origin
                0, 2, 3, 3, 1, 0,
                // Left face (-X) - looking from -X toward origin
                4, 5, 7, 7, 6, 4,
                // Top face (+Y) - looking from +Y toward origin
                0, 1, 5, 5, 4, 0,
                // Bottom face (-Y) - looking from -Y toward origin
                2, 6, 7, 7, 3, 2,
                // Back face (+Z) - looking from +Z toward origin
                0, 4, 6, 6, 2, 0,
                // Front face (-Z) - looking from -Z toward origin
                1, 3, 7, 7, 5, 1,
            ];
            this.cubeIndexCount = indices.length;
            this.cubeVertices = this.app.createStaticVertexBuffer(commandList, Ref(vertices[0]), vertices.length * 4, "CubeVertices");
            this.cubeIndices = this.app.createStaticIndexBuffer(commandList, Ref(indices[0]), indices.length * 4, "CubeIndices");
        }

        // The sample's load_gltf_scene: the meshes' primitives (POSITION and COLOR_0) in shared
        // buffers, drawn per node (each node instancing a mesh, its primitives), the node's world
        // transform mirrored in y (the octomap's convention) and its material's color.
        loadGltf(): void {
            this.gltfLoaded = true;
            const model = this.app.loadGltfModel(GLTF_PATH);
            if (model.isNull()) {
                console.log("Cannot load the glTF map: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return;
            }
            const primitiveCount = model.getPrimitiveCount();
            let positions: f32[] = [];
            let colors: f32[] = [];
            let indices: int[] = [];
            let primitiveFirstIndex: int[] = [];
            let primitiveIndexCount: int[] = [];
            let primitiveBaseVertex: int[] = [];
            let primitiveColor: f32[] = [];
            let color: f32[] = [1.0, 1.0, 1.0, 1.0];
            for (let p = 0; p < primitiveCount; p++) {
                const vertexCount = model.getAttributeCount(p, "POSITION");
                const indexCount = model.getIndexCount(p);
                if (vertexCount == 0 || indexCount == 0 || model.getAttributeComponents(p, "COLOR_0") != 4) {
                    primitiveFirstIndex.push(0);
                    primitiveIndexCount.push(0);
                    primitiveBaseVertex.push(0);
                    for (let i = 0; i < 4; i++) {
                        primitiveColor.push(1.0);
                    }
                    continue;
                }
                const firstVertex = positions.length / 3;
                for (let i = 0; i < vertexCount * 3; i++) {
                    positions.push(0.0);
                }
                for (let i = 0; i < vertexCount * 4; i++) {
                    colors.push(0.0);
                }
                model.copyAttribute(p, "POSITION", Ref(positions[firstVertex * 3]));
                model.copyAttribute(p, "COLOR_0", Ref(colors[firstVertex * 4]));
                const firstIndex = indices.length;
                for (let i = 0; i < indexCount; i++) {
                    indices.push(0);
                }
                model.copyIndices(p, Ref(indices[firstIndex]));
                primitiveFirstIndex.push(firstIndex);
                primitiveIndexCount.push(indexCount);
                primitiveBaseVertex.push(firstVertex);
                // Try to get color from material, otherwise use white
                model.copyBaseColorFactor(p, Ref(color[0]));
                for (let i = 0; i < 4; i++) {
                    primitiveColor.push(color[i]);
                }
            }
            if (indices.length == 0) {
                return;
            }

            const flipY = scale(1.0, -1.0, 1.0);
            let transform: f32[] = [];
            for (let i = 0; i < 16; i++) {
                transform.push(0.0);
            }
            const nodeCount = model.getNodeCount();
            for (let node = 0; node < nodeCount; node++) {
                const mesh = model.getNodeMesh(node);
                model.copyNodeTransform(node, Ref(transform[0]));
                let world: number[] = [];
                for (let i = 0; i < 16; i++) {
                    world.push(transform[i]);
                }
                const modelMatrix = multiply(flipY, world);
                for (let p = 0; p < primitiveCount; p++) {
                    if (model.getPrimitiveMesh(p) != mesh || primitiveIndexCount[p] == 0) {
                        continue;
                    }
                    this.gltfDrawIndexCount.push(primitiveIndexCount[p]);
                    this.gltfDrawStartIndex.push(primitiveFirstIndex[p]);
                    this.gltfDrawBaseVertex.push(primitiveBaseVertex[p]);
                    for (let i = 0; i < 16; i++) {
                        this.gltfDrawConstants.push(modelMatrix[i]);
                    }
                    for (let i = 0; i < 4; i++) {
                        this.gltfDrawConstants.push(primitiveColor[p * 4 + i]);
                    }
                }
            }

            const commandList = this.app.createCommandList();
            commandList.open();
            this.gltfPositions = this.app.createStaticVertexBuffer(commandList, Ref(positions[0]), positions.length * 4, "GltfPositions");
            this.gltfColors = this.app.createStaticVertexBuffer(commandList, Ref(colors[0]), colors.length * 4, "GltfColors");
            this.gltfIndices = this.app.createStaticIndexBuffer(commandList, Ref(indices[0]), indices.length * 4, "GltfIndices");
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.waitForIdle();
            this.app.releaseResource(commandList.handle);
        }

        // One accessor of a splat cell, count elements of `components` floats, into the splats'
        // data at `offset` of each splat (the splats from `first` on).
        copySplatAttribute(model: GltfModel, name: string, components: int, offset: int, first: int, count: int): boolean {
            if (model.getAttributeCount(0, name) != count || model.getAttributeComponents(0, name) < components) {
                return false;
            }
            const stride = model.getAttributeComponents(0, name);
            let values: f32[] = [];
            for (let i = 0; i < count * stride; i++) {
                values.push(0.0);
            }
            model.copyAttribute(0, name, Ref(values[0]));
            for (let i = 0; i < count; i++) {
                for (let k = 0; k < components; k++) {
                    this.splatData[(first + i) * SPLAT_FLOATS + offset + k] = values[i * stride + k];
                }
            }
            return true;
        }

        // The sample's load_gaussian_splats_scene: every cell's splats (POSITION,
        // KHR_gaussian_splatting:ROTATION, SCALE, OPACITY, and COLOR_0 or else the SH degree 0
        // coefficients), appended in the cells' order.
        loadSplats(): void {
            this.splatsLoaded = true;
            for (let c = 0; c < SPLAT_CELLS.length; c++) {
                const model = this.app.loadGltfModel(MEDIA + SPLAT_CELLS[c]);
                if (model.isNull() || model.getPrimitiveCount() == 0) {
                    console.log(`Cannot load the splats of ${SPLAT_CELLS[c]}`);
                    continue;
                }
                const count = model.getAttributeCount(0, "POSITION");
                const first = this.splatData.length / SPLAT_FLOATS;
                for (let i = 0; i < count * SPLAT_FLOATS; i++) {
                    this.splatData.push(0.0);
                }
                let ok = this.copySplatAttribute(model, "POSITION", 3, 0, first, count)
                    && this.copySplatAttribute(model, "KHR_gaussian_splatting:ROTATION", 4, 3, first, count)
                    && this.copySplatAttribute(model, "KHR_gaussian_splatting:SCALE", 3, 7, first, count)
                    && this.copySplatAttribute(model, "KHR_gaussian_splatting:OPACITY", 1, 10, first, count);
                if (ok) {
                    ok = this.copySplatAttribute(model, "COLOR_0", 3, 11, first, count)
                        || this.copySplatAttribute(model, "KHR_gaussian_splatting:SH_DEGREE_0_COEF_0", 3, 11, first, count);
                }
                if (!ok) {
                    console.log(`${SPLAT_CELLS[c]} lacks the KHR_gaussian_splatting attributes`);
                    while (this.splatData.length > first * SPLAT_FLOATS) {
                        this.splatData.pop();
                    }
                }
            }
            this.splatCount = this.splatData.length / SPLAT_FLOATS;
            if (this.splatCount == 0) {
                return;
            }
            for (let i = 0; i < this.splatCount; i++) {
                this.splatOrder.push(i);
                this.splatScratch.push(0);
                this.splatDistance.push(0.0);
            }
            for (let i = 0; i < this.splatData.length; i++) {
                this.splatSorted.push(0.0);
            }
            this.splatBuffer = this.app.createDynamicVertexBuffer(this.splatData.length * 4, "SplatInstances");
        }

        // The sample's on_view_state_changed: the glTF scene and the splats load when first shown.
        setViewState(viewState: int): void {
            this.viewState = viewState;
            if (viewState == VIEW_GLTF && !this.gltfLoaded) {
                this.loadGltf();
            } else if (viewState == VIEW_SPLATS && !this.splatsLoaded) {
                this.loadSplats();
            }
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(): boolean {
            const shader = "render_octomap.hlsl";
            this.renderVS = this.app.createShader(shader, "render_vs", ShaderType.Vertex);
            this.colorPS = this.app.createShader(shader, "color_ps", ShaderType.Pixel);
            this.gltfVS = this.app.createShader(shader, "gltf_vs", ShaderType.Vertex);
            this.splatVS = this.app.createShader(shader, "splat_vs", ShaderType.Vertex);
            this.splatPS = this.app.createShader(shader, "splat_ps", ShaderType.Pixel);
            if (!this.renderVS || !this.colorPS || !this.gltfVS || !this.splatVS || !this.splatPS) {
                return false;
            }

            // The cube's corners, and the voxels' instances: position, color, size.
            const octomapLayoutDesc = InputLayoutDesc.create();
            octomapLayoutDesc.addVertexAttribute("POSITION", Format.RGB32_FLOAT, 0, 0, 12);
            octomapLayoutDesc.addInstanceVertexAttribute("INSTANCE_POSITION", Format.RGB32_FLOAT, 0, 1, INSTANCE_FLOATS * 4);
            octomapLayoutDesc.addInstanceVertexAttribute("INSTANCE_COLOR", Format.RGBA32_FLOAT, 12, 1, INSTANCE_FLOATS * 4);
            octomapLayoutDesc.addInstanceVertexAttribute("INSTANCE_SCALE", Format.R32_FLOAT, 28, 1, INSTANCE_FLOATS * 4);
            this.octomapInputLayout = this.app.createInputLayout(octomapLayoutDesc, this.renderVS);
            // The glTF map: positions and vertex colors.
            const gltfLayoutDesc = InputLayoutDesc.create();
            gltfLayoutDesc.addVertexAttribute("POSITION", Format.RGB32_FLOAT, 0, 0, 12);
            gltfLayoutDesc.addVertexAttribute("COLOR", Format.RGBA32_FLOAT, 0, 1, 16);
            this.gltfInputLayout = this.app.createInputLayout(gltfLayoutDesc, this.gltfVS);
            // The splats: per instance.
            const splatLayoutDesc = InputLayoutDesc.create();
            splatLayoutDesc.addInstanceVertexAttribute("SPLAT_POSITION", Format.RGB32_FLOAT, 0, 0, SPLAT_FLOATS * 4);
            splatLayoutDesc.addInstanceVertexAttribute("SPLAT_ROTATION", Format.RGBA32_FLOAT, 12, 0, SPLAT_FLOATS * 4);
            splatLayoutDesc.addInstanceVertexAttribute("SPLAT_SCALE", Format.RGB32_FLOAT, 28, 0, SPLAT_FLOATS * 4);
            splatLayoutDesc.addInstanceVertexAttribute("SPLAT_OPACITY", Format.R32_FLOAT, 40, 0, SPLAT_FLOATS * 4);
            splatLayoutDesc.addInstanceVertexAttribute("SPLAT_COLOR", Format.RGB32_FLOAT, 44, 0, SPLAT_FLOATS * 4);
            this.splatInputLayout = this.app.createInputLayout(splatLayoutDesc, this.splatVS);

            // The UBO; with the glTF view's push constants.
            this.constantBuffer = this.app.createVolatileConstantBuffer(CONST_FLOATS * 4, "UBO");
            const layoutDesc = BindingLayoutDesc.create();
            layoutDesc.layoutVolatileConstantBuffer(0);
            this.bindingLayout = this.app.createBindingLayout(layoutDesc, ShaderType.All);
            const setDesc = BindingSetDesc.create();
            setDesc.bindEntireConstantBuffer(0, this.constantBuffer);
            this.bindingSet = this.app.createBindingSetForLayout(setDesc, this.bindingLayout);
            const gltfLayoutBindingDesc = BindingLayoutDesc.create();
            gltfLayoutBindingDesc.layoutVolatileConstantBuffer(0);
            gltfLayoutBindingDesc.layoutPushConstants(1, PUSH_FLOATS * 4);
            this.gltfBindingLayout = this.app.createBindingLayout(gltfLayoutBindingDesc, ShaderType.All);
            const gltfSetDesc = BindingSetDesc.create();
            gltfSetDesc.bindEntireConstantBuffer(0, this.constantBuffer);
            gltfSetDesc.bindPushConstants(1, PUSH_FLOATS * 4);
            this.gltfBindingSet = this.app.createBindingSetForLayout(gltfSetDesc, this.gltfBindingLayout);

            // The blit's common passes, created on first use, upload their textures on a command
            // list of their own: create them before ours (or the frame's) is open.
            this.app.getCommonSampler(CommonSampler.PointClamp);

            const reader = new OctomapReader();
            const file = this.app.loadBinaryFile(OCTOMAP_PATH);
            if (file.isNull() || !reader.read(file)) {
                console.log("Cannot read the octomap: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return false;
            }
            this.app.releaseObject(file.handle);

            const commandList = this.app.createCommandList();
            commandList.open();
            this.createCube(commandList);
            this.buildCubes(commandList, reader);
            const quad: int[] = [0, 1, 2, 3];
            this.splatQuadIndices = this.app.createStaticIndexBuffer(commandList, Ref(quad[0]), 16, "SplatQuadIndices");
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.waitForIdle();
            this.app.releaseResource(commandList.handle);

            const pass = this.app.addPass();
            pass.setMousePosCallback(this.onMousePos);
            pass.setMouseButtonCallback(this.onMouseButton);
            pass.setAnimateCallback(this.onAnimate);
            pass.setBackBufferResizingCallback(this.onBackBufferResizing);
            pass.setRenderCallback(this.onRender);
            return true;
        }

        // The camera keys, in a pass added after the overlay's (so it sees them first).
        addKeyPass(): void {
            this.app.addPass().setKeyboardCallback(this.onKey);
        }
    }

    // The sample's overlay: the view buttons.
    class UserInterface {
        private sample: OctomapPass;

        constructor(sample: OctomapPass) {
            this.sample = sample;
        }

        buildUI(): void {
            const sample = this.sample;
            Donut_ImGuiSetNextWindowPos(10.0, 10.0);
            // The sample's title (ApiVulkanSample's default).
            Donut_ImGuiBegin("Vulkan Example", 1);
            if (Donut_ImGuiButton("OCTOMAP") != 0) {
                sample.setViewState(VIEW_OCTOMAP);
            }
            if (Donut_ImGuiButton("GLTF MAP") != 0) {
                sample.setViewState(VIEW_GLTF);
            }
            if (Donut_ImGuiButton("SPLATS") != 0) {
                sample.setViewState(VIEW_SPLATS);
            }
            Donut_ImGuiEnd();
        }

        // Declared after buildUI: tslang resolves `this.buildUI` only for members declared earlier.
        init(app: App): boolean {
            if (app.addImGuiPass(this.buildUI).isNull()) {
                return false;
            }
            // The overlay works from the keyboard as well (as the framework's).
            Donut_ImGuiSetKeyboardNavigation(1);
            return true;
        }
    }

    export function main(argc: int, argv: Ref<string>): int {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("render_octomap");

        // -debug: the graphics API's debug layer and NVRHI's validation layer.
        // -noui: without the overlay.
        // -view <0..2>: the view at start (octomap, glTF map, splats).
        let options = AppOptions.None;
        let withUI = true;
        let view: int = VIEW_OCTOMAP;
        for (let i = 1; i < argc; i++) {
            const arg = Donut_GetArg(argv, i);
            if (arg == "-debug") {
                options = AppOptions.DebugRuntime;
            } else if (arg == "-noui") {
                withUI = false;
            } else if (arg == "-view" && i + 1 < argc) {
                i++;
                view = Math.min(Math.max(parseInt(Donut_GetArg(argv, i)), 0), VIEW_SPLATS);
            }
        }

        const api = Donut_GetGraphicsAPIFromCommandLine(argc, argv);
        const app = App.createWithOptions(api, WINDOW_TITLE, 1280, 720, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        const sample = new OctomapPass(app);
        if (!sample.init()) {
            app.destroy();
            return 1;
        }
        sample.setViewState(view);

        // Drawn after (over) the scene, and sees the mouse first.
        const gui = new UserInterface(sample);
        if (withUI && !gui.init(app)) {
            console.log("Cannot initialize the user interface");
            app.destroy();
            return 1;
        }
        sample.addKeyPass();

        const input = new InputPass(app.handle);

        app.run();
        app.destroy();
        return 0;
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>): int {
    return RenderOctomap.main(argc, argv);
}
