// The rtxpt example's SampleGame (RTXPT_DIR/Rtxpt/SampleGame: GameScene, GameProps, GameModel, GameMisc,
// GamePropComponent): props read from the scene's SampleGame/<scene file name> folder next to it (models/*.model.json,
// props/*.prop.json), each a model of the scene's "models" list placed in the scene graph and moved along its
// keyframe animation; the models' spot and point lights driven by light controllers (colour, intensity, blinking,
// the RX6 ship's police lights); the game's time and play speed; and a camera that attaches to a prop. It runs on
// a Donut scene (GameWorld: the scene graph and the scene file's "models", edited through core/donut_interop.cpp's
// scene graph, JSON and file functions), so on any example's scene as on rtxpt's. The sample's developer settings
// (camera recording, saving props, moving them with the numpad) are not ported, nor its "press F" prop picking.
//
// The sample is under the NVIDIA RTX SDKs License. This software contains source code provided by NVIDIA
// Corporation.

/// <reference path="donut_interop.d.ts" />

import { Camera, ImGui } from "./donut";

// The sample mixes float and double math; f32 rounds to float where it uses floats.
function f32(x: number): number {
    return Math.fround(x);
}

// The scene the game runs in: a loaded Donut scene (its graph, and the scene file's "models" the props are made of),
// the app that owns the game's JSON files, and what the host knows of it: whether the scene has game settings (an
// RTXPT GameSettings node), and whether its renderer reads a spot light's negative outer angle as the minimum
// falloff past it (RTXPT's kUseMinSpotlightFalloff, as SampleGame sets it). Nodes and JSON files are handles.
// The strings C++ returns are copied (`${...}`): a module that imports donut.ts gets them from tslang (up to
// pre-alpha111) as its own strings, uncopied, which -mm=rc then counts and frees (C++'s memory: Android's crash).
export class GameWorld {
    constructor(private app: AppHandle | null, private scene: SceneHandle | null, public hasGameSettings: boolean,
        private minSpotFalloff: boolean) {
    }

    private graph(): SceneGraphHandle {
        return Donut_GetSceneGraph(this.scene as SceneHandle);
    }

    listFiles(folder: string, wildcard: string): int {
        return Donut_ListFiles(folder, wildcard);
    }

    getListedFile(index: int): string {
        return `${Donut_GetListedFile(index)}`;
    }

    // Null (see !) if it can't be read.
    loadGameJson(path: string): JsonDocumentHandle {
        return Donut_LoadJsonDocument(this.app as AppHandle, path) as JsonDocumentHandle;
    }

    hasGameJson(json: JsonDocumentHandle, path: string): boolean {
        return Donut_JsonHas(json, path);
    }

    getGameJsonSize(json: JsonDocumentHandle, path: string): int {
        return Donut_JsonGetSize(json, path);
    }

    getGameJsonNumber(json: JsonDocumentHandle, path: string, defaultValue: number): number {
        return Donut_JsonGetNumber(json, path, defaultValue);
    }

    getGameJsonBool(json: JsonDocumentHandle, path: string, defaultValue: boolean): boolean {
        return Donut_JsonGetBool(json, path, defaultValue);
    }

    getGameJsonString(json: JsonDocumentHandle, path: string, defaultValue: string): string {
        return `${Donut_JsonGetString(json, path, defaultValue)}`;
    }

    getGameJsonVector(json: JsonDocumentHandle, path: string, count: int, component: int): number {
        return Donut_JsonGetVector(json, path, count, component);
    }

    getSceneModelCount(): int {
        return Donut_GetSceneModelCount(this.scene as SceneHandle);
    }

    getSceneModelRootName(index: int): string {
        const root = Donut_GetSceneModelRoot(this.scene as SceneHandle, index);
        return !root ? "" : `${Donut_GetNodeName(root as NodeHandle)}`;
    }

    // ModelType's constructor: the model's pose on its import root (copied with it to every instance).
    setSceneModelTransform(index: int, tx: number, ty: number, tz: number, rx: number, ry: number, rz: number, rw: number,
        sx: number, sy: number, sz: number) {
        const root = Donut_GetSceneModelRoot(this.scene as SceneHandle, index);
        if (!root) {
            return;
        }
        Donut_SetNodeTransform(root as NodeHandle, tx, ty, tz, rx, ry, rz, rw, sx, sy, sz);
    }

    // PropBase's and ModelInstance's constructors: a new named node under `parent` (null: the scene's root).
    createGameNode(parent: NodeHandle | null, name: string): NodeHandle {
        return Donut_CreateSceneNode(this.graph(), parent, name);
    }

    // ModelInstance's constructor: the scene's model `modelIndex` (its import root) under `parent`; the first
    // instance gets the import root itself, later ones copies (SceneGraph::Attach).
    attachGameModel(parent: NodeHandle, modelIndex: int) {
        const root = Donut_GetSceneModelRoot(this.scene as SceneHandle, modelIndex);
        if (!root) {
            return;
        }
        Donut_AttachSceneNode(this.graph(), parent, root as NodeHandle);
    }

    // ModelInstance::MapLightControllers' walk: the light nodes under `node`, depth first.
    collectGameLights(node: NodeHandle, lights: NodeHandle[]) {
        if (Donut_IsLightNode(node)) {
            lights.push(node);
        }
        const count = Donut_GetNodeChildCount(node);
        for (let i = 0; i < count; i++) {
            this.collectGameLights(Donut_GetNodeChild(node, i) as NodeHandle, lights);
        }
    }

    getGameNodeName(node: NodeHandle): string {
        return `${Donut_GetNodeName(node)}`;
    }

    // 0-2 translation, 3-6 rotation (x, y, z, w), 7-9 scaling.
    getGameNodeTransform(node: NodeHandle | null, component: int): number {
        return !node ? (component == 6 ? 1.0 : 0.0) : Donut_GetNodeTransform(node as NodeHandle, component);
    }

    setGameNodeRotation(node: NodeHandle | null, x: number, y: number, z: number, w: number) {
        if (!node) {
            return;
        }
        Donut_SetNodeRotation(node as NodeHandle, x, y, z, w);
    }

    setGameNodeTransform(node: NodeHandle, tx: number, ty: number, tz: number, rx: number, ry: number, rz: number, rw: number,
        sx: number, sy: number, sz: number) {
        Donut_SetNodeTransform(node, tx, ty, tz, rx, ry, rz, rw, sx, sy, sz);
    }

    // ModelInstance::UpdateLightFromControllers, one controller's light: the radius is the average of its (a frame
    // old) world scale, as the sample's; floats as the sample's.
    updateGameLight(node: NodeHandle | null, r: number, g: number, b: number, intensity: number, innerAngle: number,
        outerAngle: number) {
        if (!node) {
            return;
        }
        const light = node as NodeHandle;
        const radius = f32(f32(f32(Donut_GetNodeWorldScale(light, 0) + Donut_GetNodeWorldScale(light, 1)) +
            Donut_GetNodeWorldScale(light, 2)) / 3.0);
        const outer = Math.abs(f32(outerAngle));
        Donut_SetNodeLight(light, f32(r), f32(g), f32(b), f32(intensity), radius, f32(innerAngle),
            this.minSpotFalloff ? -outer : outer);
    }

    // GameScene::TickCamera: the game camera's pose (position, direction, up) in the prop's space into the scene's.
    transformGameCamera(propNode: NodeHandle, posDirUp: Ref<f32>) {
        Donut_TransformPoseByNode(propNode, posDirUp);
    }
}

function minD(a: number, b: number): number {
    return b < a ? b : a;
}

function maxD(a: number, b: number): number {
    return a < b ? b : a;
}

function clampD(x: number, lo: number, hi: number): number {
    return x < lo ? lo : (x > hi ? hi : x);
}

function saturateD(x: number): number {
    return clampD(x, 0.0, 1.0);
}

function joinPath(path: string, key: string): string {
    return path == "" ? key : path + "/" + key;
}

// SampleCommon's FindSubStringIgnoreCase(text, subString) != npos.
function containsIgnoreCase(text: string, subString: string): boolean {
    return text.toLowerCase().indexOf(subString.toLowerCase()) >= 0;
}

// path.filename() without its last `extensions` extensions ("a/b/name.prop.json", 2 -> "name").
function fileStem(path: string, extensions: int): string {
    let start = 0;
    for (let i = 0; i < path.length; i++) {
        const c = path.charAt(i);
        if (c == "/" || c == "\\") {
            start = i + 1;
        }
    }
    let name = path.substring(start);
    for (let k = 0; k < extensions; k++) {
        const dot = name.lastIndexOf(".");
        if (dot > 0) {
            name = name.substring(0, dot);
        }
    }
    return name;
}

const FLT_MAX = 3.4028234663852886e38;
const PI_F = 3.1415927410125732;   // float(PI)

// dm::dquat (w, x, y, z) and its operations as Donut's quat.h and GameMisc.cpp do them.
class Quat {
    constructor(public w: number, public x: number, public y: number, public z: number) {
    }

    static fromXYZW(x: number, y: number, z: number, w: number): Quat {
        return new Quat(w, x, y, z);
    }

    // operator *
    mul(b: Quat): Quat {
        const a = this;
        return new Quat(
            a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
            a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
            a.w * b.y + a.y * b.w + a.z * b.x - a.x * b.z,
            a.w * b.z + a.z * b.w + a.x * b.y - a.y * b.x);
    }

    // rotationQuat(euler)
    static fromEuler(ex: number, ey: number, ez: number): Quat {
        const quatX = new Quat(Math.cos(0.5 * ex), Math.sin(0.5 * ex), 0.0, 0.0);
        const quatY = new Quat(Math.cos(0.5 * ey), 0.0, Math.sin(0.5 * ey), 0.0);
        const quatZ = new Quat(Math.cos(0.5 * ez), 0.0, 0.0, Math.sin(0.5 * ez));
        return quatZ.mul(quatY).mul(quatX);
    }
}

class Vec3 {
    constructor(public x: number, public y: number, public z: number) {
    }

    add(b: Vec3): Vec3 {
        return new Vec3(this.x + b.x, this.y + b.y, this.z + b.z);
    }

    scale(s: number): Vec3 {
        return new Vec3(this.x * s, this.y * s, this.z * s);
    }
}

// GameMisc.cpp's quaternion helpers (sqrtf, acosf, cosf and sinf as floats).
function quatInv(q: Quat): Quat {
    return new Quat(-q.w, q.x, q.y, q.z);
}

function quatMul(q: Quat, p: Quat): Quat {
    return new Quat(
        p.w * q.w - p.x * q.x - p.y * q.y - p.z * q.z,
        p.w * q.x + p.x * q.w - p.y * q.z + p.z * q.y,
        p.w * q.y + p.x * q.z + p.y * q.w - p.z * q.x,
        p.w * q.z - p.x * q.y + p.y * q.x + p.z * q.w);
}

function quatMulInv(q: Quat, p: Quat): Quat {
    return quatMul(q, quatInv(p));
}

function quatAbs(q: Quat): Quat {
    return q.w < 0.0 ? new Quat(-q.w, -q.x, -q.y, -q.z) : q;
}

function quatLog(q: Quat, eps: number): Vec3 {
    const length = f32(Math.sqrt(f32(q.x * q.x + q.y * q.y + q.z * q.z)));
    if (length < eps) {
        return new Vec3(q.x, q.y, q.z);
    }
    const halfangle = f32(Math.acos(f32(clampD(q.w, -1.0, 1.0))));
    return new Vec3(halfangle * (q.x / length), halfangle * (q.y / length), halfangle * (q.z / length));
}

function quatToScaledAngleAxis(q: Quat): Vec3 {
    return quatLog(q, f32(1e-8)).scale(2.0);
}

function quatNormalize(q: Quat, eps: number): Quat {
    const length = Math.sqrt(q.w * q.w + q.x * q.x + q.y * q.y + q.z * q.z) + eps;
    return new Quat(q.w / length, q.x / length, q.y / length, q.z / length);
}

function quatExp(v: Vec3, eps: number): Quat {
    const halfangle = f32(Math.sqrt(f32(v.x * v.x + v.y * v.y + v.z * v.z)));
    if (halfangle < eps) {
        return quatNormalize(new Quat(1.0, v.x, v.y, v.z), f32(1e-8));
    }
    const c = f32(Math.cos(halfangle));
    const s = f32(f32(Math.sin(halfangle)) / halfangle);
    return new Quat(c, s * v.x, s * v.y, s * v.z);
}

function quatFromScaledAngleAxis(v: Vec3): Quat {
    return quatExp(new Vec3(v.x / 2.0, v.y / 2.0, v.z / 2.0), f32(1e-8));
}

// quat_hermite's rotation; x is a float there.
function quatHermite(xIn: number, r0: Quat, r1: Quat, v0: Vec3, v1: Vec3): Quat {
    const x = f32(xIn);
    const w1 = f32(f32(f32(3.0 * x) * x) - f32(f32(f32(2.0 * x) * x) * x));
    const w2 = f32(f32(f32(f32(x * x) * x) - f32(f32(2.0 * x) * x)) + x);
    const w3 = f32(f32(f32(x * x) * x) - f32(x * x));
    const r1SubR0 = quatToScaledAngleAxis(quatAbs(quatMulInv(r1, r0)));
    return quatMul(quatFromScaledAngleAxis(r1SubR0.scale(w1).add(v0.scale(w2)).add(v1.scale(w3))), r0);
}

function quatCatmullRom(x: number, r0: Quat, r1: Quat, r2: Quat, r3: Quat): Quat {
    const r1SubR0 = quatToScaledAngleAxis(quatAbs(quatMulInv(r1, r0)));
    const r2SubR1 = quatToScaledAngleAxis(quatAbs(quatMulInv(r2, r1)));
    const r3SubR2 = quatToScaledAngleAxis(quatAbs(quatMulInv(r3, r2)));
    const v1 = new Vec3((r1SubR0.x + r2SubR1.x) / 2.0, (r1SubR0.y + r2SubR1.y) / 2.0, (r1SubR0.z + r2SubR1.z) / 2.0);
    const v2 = new Vec3((r2SubR1.x + r3SubR2.x) / 2.0, (r2SubR1.y + r3SubR2.y) / 2.0, (r2SubR1.z + r3SubR2.z) / 2.0);
    return quatHermite(x, r1, r2, v1, v2);
}

function catmullRom1(v0: number, v1: number, v2: number, v3: number, s: number): number {
    return 0.5 * (2.0 * v1 + (v2 - v0) * s + (2.0 * v0 - 5.0 * v1 + 4.0 * v2 - v3) * s * s + (v3 - 3.0 * v2 + 3.0 * v1 - v0) * s * s * s);
}

// game::Pose: a transform (doubles) at a key time.
export class Pose {
    tx = 0.0;
    ty = 0.0;
    tz = 0.0;
    rotation = new Quat(1.0, 0.0, 0.0, 0.0);
    sx = 1.0;
    sy = 1.0;
    sz = 1.0;
    keyTime = 0.0;

    // Pose::Read: the values the JSON object at `path` has.
    read(world: GameWorld, json: JsonDocumentHandle, path: string): boolean {
        if (!world.hasGameJson(json, path)) {
            return false;
        }
        const translation = joinPath(path, "translation");
        if (world.hasGameJson(json, translation) && !isNaN(world.getGameJsonVector(json, translation, 3, 0))) {
            this.tx = world.getGameJsonVector(json, translation, 3, 0);
            this.ty = world.getGameJsonVector(json, translation, 3, 1);
            this.tz = world.getGameJsonVector(json, translation, 3, 2);
        }
        const rotation = joinPath(path, "rotation");
        if (world.hasGameJson(json, rotation)) {
            let x = 0.0;
            let y = 0.0;
            let z = 0.0;
            let w = 1.0;
            if (!isNaN(world.getGameJsonVector(json, rotation, 4, 0))) {
                x = world.getGameJsonVector(json, rotation, 4, 0);
                y = world.getGameJsonVector(json, rotation, 4, 1);
                z = world.getGameJsonVector(json, rotation, 4, 2);
                w = world.getGameJsonVector(json, rotation, 4, 3);
            }
            this.rotation = Quat.fromXYZW(x, y, z, w);
        } else {
            const euler = joinPath(path, "euler");
            if (world.hasGameJson(json, euler)) {
                let ex = 0.0;
                let ey = 0.0;
                let ez = 0.0;
                if (!isNaN(world.getGameJsonVector(json, euler, 3, 0))) {
                    ex = world.getGameJsonVector(json, euler, 3, 0);
                    ey = world.getGameJsonVector(json, euler, 3, 1);
                    ez = world.getGameJsonVector(json, euler, 3, 2);
                }
                this.rotation = Quat.fromEuler(ex, ey, ez);
            }
        }
        const scaling = joinPath(path, "scaling");
        if (world.hasGameJson(json, scaling) && !isNaN(world.getGameJsonVector(json, scaling, 3, 0))) {
            this.sx = world.getGameJsonVector(json, scaling, 3, 0);
            this.sy = world.getGameJsonVector(json, scaling, 3, 1);
            this.sz = world.getGameJsonVector(json, scaling, 3, 2);
        }
        this.keyTime = world.getGameJsonNumber(json, joinPath(path, "keytime"), this.keyTime);
        return true;
    }

    // Pose::GetPosDirUp: the position and the rotation's first two rows, as floats.
    getPosDirUp(dst: f32[]) {
        const q = this.rotation;
        const x = q.x;
        const y = q.y;
        const z = q.z;
        const w = q.w;
        dst[0] = f32(this.tx);
        dst[1] = f32(this.ty);
        dst[2] = f32(this.tz);
        dst[3] = f32(1.0 - 2.0 * (y * y + z * z));
        dst[4] = f32(2.0 * (x * y + z * w));
        dst[5] = f32(2.0 * (x * z - y * w));
        dst[6] = f32(2.0 * (x * y - z * w));
        dst[7] = f32(1.0 - 2.0 * (x * x + z * z));
        dst[8] = f32(2.0 * (y * z + x * w));
    }
}

// KeyframeAnimation::GetAt's spline (NiceSpline).
function niceSpline(v0: Pose, v1: Pose, v2: Pose, v3: Pose, k: number): Pose {
    const ret = new Pose();
    ret.keyTime = v1.keyTime + (v2.keyTime - v1.keyTime) * k;
    ret.tx = catmullRom1(v0.tx, v1.tx, v2.tx, v3.tx, k);
    ret.ty = catmullRom1(v0.ty, v1.ty, v2.ty, v3.ty, k);
    ret.tz = catmullRom1(v0.tz, v1.tz, v2.tz, v3.tz, k);
    ret.rotation = quatCatmullRom(k, v0.rotation, v1.rotation, v2.rotation, v3.rotation);
    ret.sx = catmullRom1(v0.sx, v1.sx, v2.sx, v3.sx, k);
    ret.sy = catmullRom1(v0.sy, v1.sy, v2.sy, v3.sy, k);
    ret.sz = catmullRom1(v0.sz, v1.sz, v2.sz, v3.sz, k);
    return ret;
}

// game::KeyframeAnimation.
class KeyframeAnimation {
    keys: Pose[] = [];
    keyTimeMin = FLT_MAX;
    keyTimeMax = -FLT_MAX;
    // GetAt's outAnimTime (a float).
    animTime = 0.0;
    private lastFound: int = -1;

    read(world: GameWorld, json: JsonDocumentHandle, path: string) {
        this.keyTimeMin = FLT_MAX;
        this.keyTimeMax = -FLT_MAX;
        const count = world.getGameJsonSize(json, path);
        for (let i = 0; i < count; i++) {
            const key = new Pose();
            key.read(world, json, joinPath(path, `${i}`));
            this.keys.push(key);
            this.keyTimeMin = minD(this.keyTimeMin, key.keyTime);
            this.keyTimeMax = maxD(this.keyTimeMax, key.keyTime);
        }
        // std::sort by key time (insertion: the files' keys are already in order)
        for (let i = 1; i < this.keys.length; i++) {
            const key = this.keys[i];
            let j = i - 1;
            while (j >= 0 && key.keyTime < this.keys[j].keyTime) {
                this.keys[j + 1] = this.keys[j];
                j--;
            }
            this.keys[j + 1] = key;
        }
    }

    // KeyframeAnimation::GetAt: the pose at `time` (wrapped into the keys' span), and animTime.
    getAt(timeIn: number, wrap: boolean, outPose: Pose[]): boolean {
        const keys = this.keys;
        if (keys.length == 0) {
            return false;
        }
        let time = timeIn;
        if (!wrap) {
            time = clampD(time, this.keyTimeMin, this.keyTimeMax);
        } else {
            time = Math.abs(time - this.keyTimeMin + this.keyTimeMax - this.keyTimeMin) % (this.keyTimeMax - this.keyTimeMin);
            time += this.keyTimeMin;
        }
        this.animTime = f32(time);

        let ia = 0;
        let ib = keys.length - 1;
        const lastFound = this.lastFound;
        if (lastFound > 0 && keys[lastFound - 1].keyTime <= time && keys[lastFound].keyTime >= time) {
            ia = lastFound - 1;
            ib = lastFound;
        } else {
            let start = 1;
            if (lastFound > 0 && keys[lastFound - 1].keyTime <= time && keys[lastFound].keyTime <= time) {
                start = lastFound;
            }
            this.lastFound = start - 1;
            for (let i = start; i < keys.length; i++) {
                if (keys[i].keyTime > time) {
                    ia = i - 1;
                    ib = i;
                    this.lastFound = i;
                    break;
                }
            }
        }

        const a = keys[ia];
        const b = keys[ib];
        const span = b.keyTime - a.keyTime + 1e-15;
        const off = time - a.keyTime;
        const lerpK = saturateD(off / span);
        const iL = ia > 0 ? ia - 1 : ia;
        const iR = ib < keys.length - 1 ? ib + 1 : ib;
        outPose[0] = niceSpline(keys[iL], a, b, keys[iR], lerpK);
        return true;
    }
}

// game::LightController (floats as the sample's).
class LightController {
    node: NodeHandle | null = null;
    nodeName = "";
    r = 1.0;
    g = 1.0;
    b = 1.0;
    intensity = 1.0;
    enabled = true;
    toggleOnUIClick = false;
    innerAngle = 0.0;
    outerAngle = 0.0;
    autoOffTime = 0.0;
    autoOnTime = 0.0;
    autoOnOffTimeOffset = 0.0;

    // LightController::Read: the values the JSON object at `path` has.
    read(world: GameWorld, json: JsonDocumentHandle, path: string): boolean {
        if (!world.hasGameJson(json, path)) {
            return false;
        }
        const color = joinPath(path, "color");
        if (!isNaN(world.getGameJsonVector(json, color, 3, 0))) {
            this.r = f32(world.getGameJsonVector(json, color, 3, 0));
            this.g = f32(world.getGameJsonVector(json, color, 3, 1));
            this.b = f32(world.getGameJsonVector(json, color, 3, 2));
        }
        this.intensity = f32(world.getGameJsonNumber(json, joinPath(path, "intensity"), this.intensity));
        this.enabled = world.getGameJsonBool(json, joinPath(path, "enabled"), this.enabled);
        this.toggleOnUIClick = world.getGameJsonBool(json, joinPath(path, "toggleOnUIClick"), this.toggleOnUIClick);
        this.innerAngle = f32(world.getGameJsonNumber(json, joinPath(path, "innerAngle"), this.innerAngle));
        this.outerAngle = f32(world.getGameJsonNumber(json, joinPath(path, "outerAngle"), this.outerAngle));
        this.autoOffTime = f32(world.getGameJsonNumber(json, joinPath(path, "autoOffTime"), this.autoOffTime));
        this.autoOnTime = f32(world.getGameJsonNumber(json, joinPath(path, "autoOnTime"), this.autoOnTime));
        this.autoOnOffTimeOffset = f32(world.getGameJsonNumber(json, joinPath(path, "autoOnOffTimeOffset"), this.autoOnOffTimeOffset));
        return true;
    }
}

// game::ModelType: a model of the scene's "models" list, its pose, and its lights' controller settings.
class ModelType {
    valid = false;
    modelIndex: int = -1;
    modelPose = new Pose();
    // the "lights" entries: their names and paths in `json`
    lightNames: string[] = [];
    lightPaths: string[] = [];

    constructor(world: GameWorld, public name: string, public json: JsonDocumentHandle) {
        let modelIndex = <int>world.getGameJsonNumber(json, "sceneModelIndex", -1.0);
        const modelName = world.getGameJsonString(json, "sceneModelName", "");
        this.modelPose.read(world, json, "modelPose");

        const lightCount = world.getGameJsonSize(json, "lights");
        for (let i = 0; i < lightCount; i++) {
            const lightPath = `lights/${i}`;
            const lightName = world.getGameJsonString(json, joinPath(lightPath, "name"), "");
            if (lightName == "" || this.findLight(lightName) >= 0) {
                console.log(`malformed or repeated light name in ${name}.model.json`);
                continue;
            }
            this.lightNames.push(lightName);
            this.lightPaths.push(lightPath);
        }

        const modelCount = world.getSceneModelCount();
        if (modelIndex == -1 && modelName != "") {
            for (let i = 0; i < modelCount; i++) {
                if (containsIgnoreCase(world.getSceneModelRootName(i), modelName)) {
                    modelIndex = i;
                    break;
                }
            }
        }
        if (modelIndex < 0 || modelIndex >= modelCount) {
            console.log(`Referenced model ${modelIndex} is not defined in the model array.`);
            return;
        }
        const p = this.modelPose;
        const q = p.rotation;
        world.setSceneModelTransform(modelIndex, p.tx, p.ty, p.tz, q.x, q.y, q.z, q.w, p.sx, p.sy, p.sz);
        this.modelIndex = modelIndex;
        this.valid = name != "";
    }

    findLight(name: string): int {
        for (let i = 0; i < this.lightNames.length; i++) {
            if (this.lightNames[i] == name) {
                return i;
            }
        }
        return -1;
    }
}

// game::ModelInstance: a node of its own with the model type's model under it, and its lights' controllers.
class ModelInstance {
    node: NodeHandle;
    lights: LightController[] = [];

    constructor(world: GameWorld, public instanceName: string, modelType: ModelType, parentNode: NodeHandle) {
        this.node = world.createGameNode(parentNode, instanceName);
        world.attachGameModel(this.node, modelType.modelIndex);

        // MapLightControllers
        const handles: NodeHandle[] = [];
        world.collectGameLights(this.node, handles);
        for (let i = 0; i < handles.length; i++) {
            const lightName = world.getGameNodeName(handles[i]);
            const index = modelType.findLight(lightName);
            if (index < 0) {
                console.log(`Model instance '${instanceName}', light '${lightName}' has no controller`);
                continue;
            }
            const controller = new LightController();
            if (controller.read(world, modelType.json, modelType.lightPaths[index])) {
                controller.node = handles[i];
                controller.nodeName = lightName;
                this.lights.push(controller);
            }
        }
    }

    // ModelInstance::UpdateLightFromControllers
    updateLightFromControllers(world: GameWorld, gameTime: number) {
        for (let i = 0; i < this.lights.length; i++) {
            const c = this.lights[i];
            let enabled = c.enabled;
            if (c.autoOffTime != 0.0 && c.autoOnTime != 0.0) {
                const periodLength = f32(c.autoOffTime + c.autoOnTime);
                const scaledTime = (gameTime + c.autoOnOffTimeOffset) / periodLength;
                const remainder = saturateD(scaledTime - Math.floor(scaledTime));
                enabled = enabled && remainder < c.autoOffTime / periodLength;
            }
            const intensity = enabled ? c.intensity : 0.0;
            world.updateGameLight(c.node, c.r, c.g, c.b, intensity, c.innerAngle, c.outerAngle);
        }
    }
}

// GamePropComponent.cpp's PropComponentPoliceLights ("PoliceLightingOnRX6"): the RX6 ship's spot lights alternating
// and its blob lights spinning between animTimeStart and animTimeStop of its animation.
class PoliceLights {
    start = 0.0;
    stop = 0.0;
    spotLeft: LightController = new LightController();
    spotRight: LightController = new LightController();
    blobLeft: LightController = new LightController();
    blobRight: LightController = new LightController();
    spotLeftIntensity = 0.0;
    spotRightIntensity = 0.0;
    blobLeftIntensity = 0.0;
    blobRightIntensity = 0.0;
    blobLeftRot = new Quat(1.0, 0.0, 0.0, 0.0);
    blobRightRot = new Quat(1.0, 0.0, 0.0, 0.0);

    load(world: GameWorld, json: JsonDocumentHandle, path: string, models: ModelInstance[]) {
        this.start = f32(world.getGameJsonNumber(json, joinPath(path, "animTimeStart"), this.start));
        this.stop = f32(world.getGameJsonNumber(json, joinPath(path, "animTimeStop"), this.stop));
        for (let m = 0; m < models.length; m++) {
            const lights = models[m].lights;
            for (let i = 0; i < lights.length; i++) {
                const light = lights[i];
                if (light.nodeName == "SpotLeft") {
                    this.spotLeft = light;
                    this.spotLeftIntensity = light.intensity;
                }
                if (light.nodeName == "SpotRight") {
                    this.spotRight = light;
                    this.spotRightIntensity = light.intensity;
                }
                if (light.nodeName == "BlobLeft") {
                    this.blobLeft = light;
                    this.blobLeftRot = nodeRotation(world, light.node);
                    this.blobLeftIntensity = light.intensity;
                }
                if (light.nodeName == "BlobRight") {
                    this.blobRight = light;
                    this.blobRightRot = nodeRotation(world, light.node);
                    this.blobRightIntensity = light.intensity;
                }
            }
        }
    }

    tick(world: GameWorld, animationTime: number) {
        let blobRightI = 0.0;
        let blobRotAngle = 0.0;
        if (animationTime > this.start && animationTime < this.stop) {
            let spotLeftI = 0.0;
            let spotRightI = 0.0;
            let blobLeftI = 0.0;
            if (animationTime < f32(this.start + 2.0) || animationTime > f32(this.stop - 2.0)) {
                spotLeftI = f32(this.spotLeftIntensity * f32(0.1));
                spotRightI = f32(this.spotRightIntensity * f32(0.1));
                blobLeftI = f32(this.blobLeftIntensity * f32(0.01));
                blobRightI = f32(this.blobRightIntensity * f32(0.01));
            } else {
                const spotPeriodLength = f32(0.9);
                const spotPeriod = saturateD(f32((animationTime % spotPeriodLength) / spotPeriodLength));
                if (spotPeriod < 0.5) {
                    spotLeftI = this.spotLeftIntensity;
                } else {
                    spotRightI = this.spotRightIntensity;
                }
                const blobPeriodLength = f32(1.1);
                const blobPeriod = saturateD(f32((animationTime % blobPeriodLength) / blobPeriodLength));
                blobRotAngle = f32(f32(f32(blobPeriod - 0.5) * PI_F) * 2.0);
                blobLeftI = this.blobLeftIntensity;
                blobRightI = this.blobRightIntensity;
            }
            this.spotLeft.intensity = spotLeftI;
            this.spotRight.intensity = spotRightI;
            this.blobLeft.intensity = blobLeftI;
            this.blobRight.intensity = blobRightI;
        } else {
            this.spotLeft.intensity = 0.0;
            this.spotRight.intensity = 0.0;
            this.blobLeft.intensity = 0.0;
            this.blobRight.intensity = 0.0;
        }
        const rot = Quat.fromEuler(blobRotAngle, 0.0, 0.0);
        setNodeRotation(world, this.blobLeft.node, this.blobLeftRot.mul(rot));
        setNodeRotation(world, this.blobRight.node, this.blobRightRot.mul(rot));
    }
}

// GameScene::FindModelType
function findModelType(modelTypes: ModelType[], name: string): ModelType | null {
    if (name == "") {
        return null;
    }
    for (let i = 0; i < modelTypes.length; i++) {
        if (modelTypes[i].name == name) {
            return modelTypes[i];
        }
    }
    return null;
}

function nodeRotation(world: GameWorld, node: NodeHandle | null): Quat {
    return Quat.fromXYZW(world.getGameNodeTransform(node, 3), world.getGameNodeTransform(node, 4),
        world.getGameNodeTransform(node, 5), world.getGameNodeTransform(node, 6));
}

function setNodeRotation(world: GameWorld, node: NodeHandle | null, q: Quat) {
    world.setGameNodeRotation(node, q.x, q.y, q.z, q.w);
}

function setNodeTransform(world: GameWorld, node: NodeHandle, p: Pose) {
    const q = p.rotation;
    world.setGameNodeTransform(node, p.tx, p.ty, p.tz, q.x, q.y, q.z, q.w, p.sx, p.sy, p.sz);
}

// game::SimpleProp (the only prop type): a node under the scene's root with one model instance, its start pose,
// its keyframe animation, the light overrides and components.
class Prop {
    node: NodeHandle;
    startPose = new Pose();
    defaultCameraPose = new Pose();
    animation = new KeyframeAnimation();
    animPlaybackSpeed = 1.0;
    animOffset = 0.0;
    showOnlyIfTagged = "";
    models: ModelInstance[] = [];
    policeLights: PoliceLights[] = [];

    constructor(private world: GameWorld, public name: string) {
        this.node = world.createGameNode(null, name);
    }

    // PropBase::Load and SimpleProp::Load, with the game's --propShowTags and model types.
    load(json: JsonDocumentHandle, propShowTags: string, modelTypes: ModelType[]) {
        const world = this.world;
        this.startPose.read(world, json, "startPose");
        // An empty "defaultCameraPose" is the pose of a camera at the origin looking along +x with +y up: no rotation.
        if (world.getGameJsonSize(json, "defaultCameraPose") > 0) {
            this.defaultCameraPose.read(world, json, "defaultCameraPose");
        }
        this.animPlaybackSpeed = f32(world.getGameJsonNumber(json, "animPlaybackSpeed", this.animPlaybackSpeed));
        this.showOnlyIfTagged = world.getGameJsonString(json, "showOnlyIfTagged", this.showOnlyIfTagged);
        if (world.getGameJsonSize(json, "animation") > 0) {
            this.animation.read(world, json, "animation");
        }

        if (this.showOnlyIfTagged != "" && !containsIgnoreCase(propShowTags, this.showOnlyIfTagged)) {
            return;
        }
        const modelType = findModelType(modelTypes, world.getGameJsonString(json, "modelName", ""));
        if (modelType == null || !modelType.valid) {
            console.log(`Prop ${this.name}: no model ${world.getGameJsonString(json, "modelName", "")}`);
            return;
        }
        // CreateAndAttachModel at the origin
        const model = new ModelInstance(world, "SimplePropOnlyModel", modelType, this.node);
        setNodeTransform(world, model.node, new Pose());
        this.models.push(model);
    }

    // PropBase::PostLoadSetup: the light overrides, then the components.
    postLoadSetup(json: JsonDocumentHandle) {
        const world = this.world;
        const overrideCount = world.getGameJsonSize(json, "modelsLightsOverrides");
        for (let m = 0; m < overrideCount; m++) {
            const path = `modelsLightsOverrides/${m}`;
            const modelName = world.getGameJsonString(json, joinPath(path, "modelInstanceName"), "");
            let model: ModelInstance | null = null;
            for (let i = 0; i < this.models.length; i++) {
                if (this.models[i].instanceName == modelName) {
                    model = this.models[i];
                    break;
                }
            }
            if (model == null) {
                console.log(`Bad light override, prop ${this.name}, model ${modelName}`);
                continue;
            }
            const lightOverrides = joinPath(path, "lightOverrides");
            const lightCount = world.getGameJsonSize(json, lightOverrides);
            for (let l = 0; l < lightCount; l++) {
                const lightPath = joinPath(lightOverrides, `${l}`);
                const lightName = world.getGameJsonString(json, joinPath(lightPath, "name"), "");
                let found = false;
                for (let i = 0; i < model.lights.length; i++) {
                    if (model.lights[i].nodeName == lightName) {
                        model.lights[i].read(world, json, lightPath);
                        found = true;
                        break;
                    }
                }
                if (!found) {
                    console.log(`Bad light override, prop ${this.name}, model ${modelName}, light name ${lightName}`);
                }
            }
        }

        const componentCount = world.getGameJsonSize(json, "components");
        for (let c = 0; c < componentCount; c++) {
            const path = `components/${c}`;
            // "BasicInteractableUI" only picks the prop with the mouse, not ported
            if (world.getGameJsonString(json, joinPath(path, "type"), "") == "PoliceLightingOnRX6") {
                const component = new PoliceLights();
                component.load(world, json, path, this.models);
                this.policeLights.push(component);
            }
        }
    }

    // PropBase::Reset
    reset() {
        setNodeTransform(this.world, this.node, this.startPose);
        this.animOffset = 0.0;
    }

    // PropBase::Tick (without the numpad moves of the selected prop)
    tick(gameTime: number) {
        const world = this.world;
        let animTime = 0.0;
        const pose: Pose[] = [new Pose()];
        if (this.animation.getAt(this.animPlaybackSpeed * gameTime + this.animOffset, true, pose)) {
            setNodeTransform(world, this.node, pose[0]);
            animTime = this.animation.animTime;
        }
        for (let i = 0; i < this.policeLights.length; i++) {
            this.policeLights[i].tick(world, animTime);
        }
        for (let i = 0; i < this.models.length; i++) {
            this.models[i].updateLightFromControllers(world, gameTime);
        }
    }
}

// GameScene: the props, the game's time and play speed, and the prop camera.
export class RtxptGame {
    // GameScene::IsInitialized: the scene has a GameSettings node.
    initialized = false;
    // GameScene::m_playSpeed: 0 paused, 1 0.1x, 2 0.5x, 3 1x, 4 2x, 5 10x.
    playSpeed: int = 3;
    gameTime = 0.0;
    timeLoopEnable = false;
    timeLoopFrom = 0.0;
    timeLoopTo = 0.0;
    // The command line's --propShowTags (props tagged with one of them show).
    propShowTags = "";
    private modelTypes: ModelType[] = [];
    private props: Prop[] = [];
    private selectedProp: int = -1;
    private lastTickGlobalAnimationEnabled = false;
    // The prop the game camera is attached to (-1: none) and the render camera's pose from before.
    private cameraAttached: int = -1;
    private wasCameraActive = false;
    private sceneCameraLast: f32[] = [];
    private cameraPose: f32[] = [];

    // The scene the game runs in (sceneLoaded's).
    private world = new GameWorld(null, null, false, false);

    constructor(public gameCamera: Camera) {
        for (let i = 0; i < 9; i++) {
            this.sceneCameraLast.push(0.0);
            this.cameraPose.push(0.0);
        }
    }

    // GameScene::Deinitialize (also before the scene unloads: the props hold its nodes).
    deinitialize() {
        this.initialized = false;
        this.props = [];
        this.modelTypes = [];
        this.gameTime = 0.0;
        this.timeLoopEnable = false;
        this.timeLoopFrom = 0.0;
        this.timeLoopTo = 0.0;
        this.lastTickGlobalAnimationEnabled = false;
        this.wasCameraActive = false;
        this.cameraAttached = -1;
        this.selectedProp = -1;
        this.playSpeed = 3;
    }

    // GameScene::SceneLoaded: after the scene file loaded (rtxpt: core/rtxpt.cpp's LoadScene, before the rest of the
    // loading, FinishLoadingScene), in `world`. The game's files are in <assets>/SampleGame/<scene file name without .json>.
    sceneLoaded(world: GameWorld, scenePath: string, assetsPath: string, propShowTags: string, propCameraAttach: string) {
        this.deinitialize();
        this.world = world;
        this.propShowTags = propShowTags;
        if (!world.hasGameSettings) {
            return;
        }
        const storagePath = `${assetsPath}/SampleGame/${fileStem(scenePath, 1)}`;
        this.initialized = true;

        const modelCount = world.listFiles(`${storagePath}/models`, "*.model.json");
        const modelFiles: string[] = [];
        for (let i = 0; i < modelCount; i++) {
            modelFiles.push(world.getListedFile(i));
        }
        for (let i = 0; i < modelFiles.length; i++) {
            const json = world.loadGameJson(modelFiles[i]);
            if (!json) {
                continue;
            }
            this.modelTypes.push(new ModelType(world, fileStem(modelFiles[i], 2), json));
        }

        const propCount = world.listFiles(`${storagePath}/props`, "*.prop.json");
        const propFiles: string[] = [];
        for (let i = 0; i < propCount; i++) {
            propFiles.push(world.getListedFile(i));
        }
        for (let i = 0; i < propFiles.length; i++) {
            const json = world.loadGameJson(propFiles[i]);
            if (!json) {
                continue;
            }
            // CreatePropFromFile
            if (world.getGameJsonString(json, "propType", "") != "SimpleProp") {
                continue;
            }
            const prop = new Prop(world, fileStem(propFiles[i], 2));
            prop.load(json, this.propShowTags, this.modelTypes);
            prop.postLoadSetup(json);
            prop.reset();
            this.props.push(prop);
        }

        if (propCameraAttach != "") {
            for (let i = 0; i < this.props.length; i++) {
                if (this.props[i].name.toLowerCase() == propCameraAttach.toLowerCase()) {
                    this.attachCamera(i);
                    break;
                }
            }
        }
    }

    isActive(): boolean {
        return this.playSpeed != 0;
    }

    cameraActive(): boolean {
        return this.cameraAttached >= 0;
    }

    // GameScene::AttachCamera (-1 detaches): the game camera starts at the prop's default camera pose.
    attachCamera(prop: int) {
        if (prop < 0) {
            this.cameraAttached = -1;
            return;
        }
        const p = this.cameraPose;
        this.props[prop].defaultCameraPose.getPosDirUp(p);
        this.gameCamera.lookTo(p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7], p[8]);
        this.cameraAttached = prop;
    }

    private static playSpeedK(playSpeed: int): number {
        if (playSpeed == 1) {
            return f32(0.1);
        }
        if (playSpeed == 2) {
            return 0.5;
        }
        if (playSpeed == 3) {
            return 1.0;
        }
        if (playSpeed == 4) {
            return 2.0;
        }
        if (playSpeed == 5) {
            return 10.0;
        }
        return 0.0;
    }

    // GameScene::Tick: globalAnimationEnabled is the sample's animations in real-time mode.
    tick(deltaTimeIn: number, globalAnimationEnabled: boolean) {
        const deltaTime = minD(f32(deltaTimeIn), 0.5);
        if (this.timeLoopEnable && this.gameTime < this.timeLoopFrom) {
            this.gameTime = this.timeLoopFrom;
        }
        this.playSpeed = this.playSpeed < 0 ? 0 : (this.playSpeed > 5 ? 5 : this.playSpeed);
        const playSpeedK = RtxptGame.playSpeedK(this.playSpeed);
        this.lastTickGlobalAnimationEnabled = globalAnimationEnabled;
        if (this.isActive() && globalAnimationEnabled) {
            this.gameTime += f32(deltaTime * playSpeedK);
            if (this.timeLoopEnable) {
                const loopSpan = this.timeLoopTo - this.timeLoopFrom;
                if (loopSpan > 0.0) {
                    const p = (this.gameTime - this.timeLoopFrom) / loopSpan;
                    this.gameTime = (p - Math.floor(p)) * loopSpan + this.timeLoopFrom;
                } else {
                    this.gameTime = this.timeLoopFrom;
                }
            }
        }
        for (let i = 0; i < this.props.length; i++) {
            this.props[i].tick(this.gameTime);
        }
    }

    // GameScene::TickCamera: while attached, the game camera (in the prop's space) moves the render camera.
    tickCamera(deltaTime: number, renderCamera: Camera) {
        const last = this.sceneCameraLast;
        if (!this.wasCameraActive && this.cameraActive()) {
            renderCamera.getPosition(Ref(last[0]));
            renderCamera.getDirection(Ref(last[3]));
            renderCamera.getUp(Ref(last[6]));
        }
        if (this.wasCameraActive && !this.cameraActive()) {
            renderCamera.lookTo(last[0], last[1], last[2], last[3], last[4], last[5], last[6], last[7], last[8]);
        }
        this.wasCameraActive = this.cameraActive();
        if (this.cameraActive()) {
            this.gameCamera.animate(deltaTime);
            const p = this.cameraPose;
            this.gameCamera.getPosition(Ref(p[0]));
            this.gameCamera.getDirection(Ref(p[3]));
            this.gameCamera.getUp(Ref(p[6]));
            this.world.transformGameCamera(this.props[this.cameraAttached].node, Ref(p[0]));
            renderCamera.lookTo(p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7], p[8]);
        }
    }

    // GameScene::DebugGUI (SampleUI's "Interactive elements"), without the developer settings.
    debugGUI() {
        if (!this.lastTickGlobalAnimationEnabled) {
            ImGui.text("Note: global animations disabled, game world not updating!");
        }
        if (ImGui.button("[-2s]")) {
            this.gameTime = maxD(0.0, this.gameTime - 2.0);
        }
        ImGui.sameLine();
        if (ImGui.button("<slower<")) {
            this.playSpeed--;
        }
        ImGui.sameLine();
        if (this.playSpeed == 0) {
            if (ImGui.button("[PLAY]")) {
                this.playSpeed = 3;
            }
        } else if (ImGui.button("[PAUSE]")) {
            this.playSpeed = 0;
        }
        ImGui.sameLine();
        if (ImGui.button(">faster>")) {
            this.playSpeed++;
        }
        ImGui.sameLine();
        if (ImGui.button("[+2s]")) {
            this.gameTime = this.gameTime + 2.0;
        }
        ImGui.text(`Time ${this.gameTime.toFixed(2)}, play speed ${RtxptGame.playSpeedK(this.playSpeed).toFixed(2)}x`);
        ImGui.sameLine();
        if (ImGui.button("Reset##Timer")) {
            this.gameTime = 0.0;
        }
        this.timeLoopEnable = ImGui.checkbox("Loop", this.timeLoopEnable);
        if (this.timeLoopEnable) {
            this.timeLoopFrom = ImGui.inputFloat("Loop from", this.timeLoopFrom, 0.1, "%.2f");
            this.timeLoopTo = ImGui.inputFloat("Loop to", this.timeLoopTo, 0.1, "%.2f");
        }

        if (!this.cameraActive()) {
            ImGui.text("Game camera not active");
        } else {
            ImGui.text(`Game camera attached to ${this.props[this.cameraAttached].name}`);
            if (ImGui.button("Detach")) {
                this.attachCamera(-1);
            }
        }

        if (ImGui.collapsingHeaderDefaultOpen("Props")) {
            ImGui.indent();
            for (let i = 0; i < this.props.length; i++) {
                const selected = this.selectedProp == i;
                if (ImGui.selectable(this.props[i].name, selected)) {
                    this.selectedProp = selected ? -1 : i;
                }
            }
            ImGui.separator();
            if (this.selectedProp >= 0) {
                const prop = this.props[this.selectedProp];
                ImGui.text(`Properties for ${prop.name}`);
                if (this.cameraAttached == this.selectedProp) {
                    ImGui.text("Camera ATTACHED!");
                    ImGui.sameLine();
                    if (ImGui.button("Detach##Prop")) {
                        this.attachCamera(-1);
                    }
                } else {
                    ImGui.text("Camera not attached");
                    ImGui.sameLine();
                    if (ImGui.button("Attach")) {
                        this.attachCamera(this.selectedProp);
                    }
                }
            } else {
                ImGui.text("No selected prop");
            }
            ImGui.unindent();
        }
    }

    // GameScene::StandaloneGUI's "Exit prop camera" button at the bottom of the window while attached.
    standaloneGUI(displayWidth: number, displayHeight: number) {
        if (!this.cameraActive()) {
            return;
        }
        ImGui.setNextWindowPosPivot(displayWidth * 0.5, displayHeight - 10.0, 0.5, 1.0);
        ImGui.begin("GameUI", true);
        if (ImGui.button("Exit prop camera")) {
            this.attachCamera(-1);
        }
        ImGui.end();
    }
}
