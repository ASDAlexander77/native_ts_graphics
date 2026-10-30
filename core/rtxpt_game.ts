// The rtxpt example's SampleGame (RTXPT_DIR/Rtxpt/SampleGame: GameScene, GameProps, GameModel, GameMisc,
// GamePropComponent): props read from the scene's SampleGame/<scene file name> folder next to it (models/*.model.json,
// props/*.prop.json), each a model of the scene's "models" list placed in the scene graph and moved along its
// keyframe animation; the models' spot and point lights driven by light controllers (colour, intensity, blinking,
// the RX6 ship's police lights); the game's time and play speed; and a camera that attaches to a prop. Its scene
// graph and JSON steps are core/rtxpt.cpp's (Donut_RtxptRenderer*Game*). The sample's developer settings (camera
// recording, saving props, moving them with the numpad) are not ported, nor its "press F" prop picking.
//
// The sample is under the NVIDIA RTX SDKs License. This software contains source code provided by NVIDIA
// Corporation.

import { Camera, ImGui } from "./donut";
import { RtxptRenderer } from "./rtxpt_renderer";

// The sample mixes float and double math; f32 rounds to float where it uses floats.
function f32(x: number): number {
    return Math.fround(x);
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
    read(rtxpt: RtxptRenderer, json: int, path: string): boolean {
        if (!rtxpt.hasGameJson(json, path)) {
            return false;
        }
        const translation = joinPath(path, "translation");
        if (rtxpt.hasGameJson(json, translation) && !isNaN(rtxpt.getGameJsonVector(json, translation, 3, 0))) {
            this.tx = rtxpt.getGameJsonVector(json, translation, 3, 0);
            this.ty = rtxpt.getGameJsonVector(json, translation, 3, 1);
            this.tz = rtxpt.getGameJsonVector(json, translation, 3, 2);
        }
        const rotation = joinPath(path, "rotation");
        if (rtxpt.hasGameJson(json, rotation)) {
            let x = 0.0;
            let y = 0.0;
            let z = 0.0;
            let w = 1.0;
            if (!isNaN(rtxpt.getGameJsonVector(json, rotation, 4, 0))) {
                x = rtxpt.getGameJsonVector(json, rotation, 4, 0);
                y = rtxpt.getGameJsonVector(json, rotation, 4, 1);
                z = rtxpt.getGameJsonVector(json, rotation, 4, 2);
                w = rtxpt.getGameJsonVector(json, rotation, 4, 3);
            }
            this.rotation = Quat.fromXYZW(x, y, z, w);
        } else {
            const euler = joinPath(path, "euler");
            if (rtxpt.hasGameJson(json, euler)) {
                let ex = 0.0;
                let ey = 0.0;
                let ez = 0.0;
                if (!isNaN(rtxpt.getGameJsonVector(json, euler, 3, 0))) {
                    ex = rtxpt.getGameJsonVector(json, euler, 3, 0);
                    ey = rtxpt.getGameJsonVector(json, euler, 3, 1);
                    ez = rtxpt.getGameJsonVector(json, euler, 3, 2);
                }
                this.rotation = Quat.fromEuler(ex, ey, ez);
            }
        }
        const scaling = joinPath(path, "scaling");
        if (rtxpt.hasGameJson(json, scaling) && !isNaN(rtxpt.getGameJsonVector(json, scaling, 3, 0))) {
            this.sx = rtxpt.getGameJsonVector(json, scaling, 3, 0);
            this.sy = rtxpt.getGameJsonVector(json, scaling, 3, 1);
            this.sz = rtxpt.getGameJsonVector(json, scaling, 3, 2);
        }
        this.keyTime = rtxpt.getGameJsonNumber(json, joinPath(path, "keytime"), this.keyTime);
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

    read(rtxpt: RtxptRenderer, json: int, path: string) {
        this.keyTimeMin = FLT_MAX;
        this.keyTimeMax = -FLT_MAX;
        const count = rtxpt.getGameJsonSize(json, path);
        for (let i = 0; i < count; i++) {
            const key = new Pose();
            key.read(rtxpt, json, joinPath(path, `${i}`));
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
    node: int = -1;
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
    read(rtxpt: RtxptRenderer, json: int, path: string): boolean {
        if (!rtxpt.hasGameJson(json, path)) {
            return false;
        }
        const color = joinPath(path, "color");
        if (!isNaN(rtxpt.getGameJsonVector(json, color, 3, 0))) {
            this.r = f32(rtxpt.getGameJsonVector(json, color, 3, 0));
            this.g = f32(rtxpt.getGameJsonVector(json, color, 3, 1));
            this.b = f32(rtxpt.getGameJsonVector(json, color, 3, 2));
        }
        this.intensity = f32(rtxpt.getGameJsonNumber(json, joinPath(path, "intensity"), this.intensity));
        this.enabled = rtxpt.getGameJsonBool(json, joinPath(path, "enabled"), this.enabled);
        this.toggleOnUIClick = rtxpt.getGameJsonBool(json, joinPath(path, "toggleOnUIClick"), this.toggleOnUIClick);
        this.innerAngle = f32(rtxpt.getGameJsonNumber(json, joinPath(path, "innerAngle"), this.innerAngle));
        this.outerAngle = f32(rtxpt.getGameJsonNumber(json, joinPath(path, "outerAngle"), this.outerAngle));
        this.autoOffTime = f32(rtxpt.getGameJsonNumber(json, joinPath(path, "autoOffTime"), this.autoOffTime));
        this.autoOnTime = f32(rtxpt.getGameJsonNumber(json, joinPath(path, "autoOnTime"), this.autoOnTime));
        this.autoOnOffTimeOffset = f32(rtxpt.getGameJsonNumber(json, joinPath(path, "autoOnOffTimeOffset"), this.autoOnOffTimeOffset));
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

    constructor(rtxpt: RtxptRenderer, public name: string, public json: int) {
        let modelIndex = <int>rtxpt.getGameJsonNumber(json, "sceneModelIndex", -1.0);
        const modelName = rtxpt.getGameJsonString(json, "sceneModelName", "");
        this.modelPose.read(rtxpt, json, "modelPose");

        const lightCount = rtxpt.getGameJsonSize(json, "lights");
        for (let i = 0; i < lightCount; i++) {
            const lightPath = `lights/${i}`;
            const lightName = rtxpt.getGameJsonString(json, joinPath(lightPath, "name"), "");
            if (lightName == "" || this.findLight(lightName) >= 0) {
                console.log(`malformed or repeated light name in ${name}.model.json`);
                continue;
            }
            this.lightNames.push(lightName);
            this.lightPaths.push(lightPath);
        }

        const modelCount = rtxpt.getSceneModelCount();
        if (modelIndex == -1 && modelName != "") {
            for (let i = 0; i < modelCount; i++) {
                if (containsIgnoreCase(rtxpt.getSceneModelRootName(i), modelName)) {
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
        rtxpt.setSceneModelTransform(modelIndex, p.tx, p.ty, p.tz, q.x, q.y, q.z, q.w, p.sx, p.sy, p.sz);
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
    node: int;
    lights: LightController[] = [];

    constructor(rtxpt: RtxptRenderer, public instanceName: string, modelType: ModelType, parentNode: int) {
        this.node = rtxpt.createGameNode(parentNode, instanceName);
        rtxpt.attachGameModel(this.node, modelType.modelIndex);

        // MapLightControllers
        const count = rtxpt.collectGameLights(this.node);
        const handles: int[] = [];
        for (let i = 0; i < count; i++) {
            handles.push(rtxpt.getCollectedGameLight(i));
        }
        for (let i = 0; i < handles.length; i++) {
            const lightName = rtxpt.getGameNodeName(handles[i]);
            const index = modelType.findLight(lightName);
            if (index < 0) {
                console.log(`Model instance '${instanceName}', light '${lightName}' has no controller`);
                continue;
            }
            const controller = new LightController();
            if (controller.read(rtxpt, modelType.json, modelType.lightPaths[index])) {
                controller.node = handles[i];
                controller.nodeName = lightName;
                this.lights.push(controller);
            }
        }
    }

    // ModelInstance::UpdateLightFromControllers
    updateLightFromControllers(rtxpt: RtxptRenderer, gameTime: number) {
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
            rtxpt.updateGameLight(c.node, c.r, c.g, c.b, intensity, c.innerAngle, c.outerAngle);
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

    load(rtxpt: RtxptRenderer, json: int, path: string, models: ModelInstance[]) {
        this.start = f32(rtxpt.getGameJsonNumber(json, joinPath(path, "animTimeStart"), this.start));
        this.stop = f32(rtxpt.getGameJsonNumber(json, joinPath(path, "animTimeStop"), this.stop));
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
                    this.blobLeftRot = nodeRotation(rtxpt, light.node);
                    this.blobLeftIntensity = light.intensity;
                }
                if (light.nodeName == "BlobRight") {
                    this.blobRight = light;
                    this.blobRightRot = nodeRotation(rtxpt, light.node);
                    this.blobRightIntensity = light.intensity;
                }
            }
        }
    }

    tick(rtxpt: RtxptRenderer, animationTime: number) {
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
        setNodeRotation(rtxpt, this.blobLeft.node, this.blobLeftRot.mul(rot));
        setNodeRotation(rtxpt, this.blobRight.node, this.blobRightRot.mul(rot));
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

function nodeRotation(rtxpt: RtxptRenderer, node: int): Quat {
    return Quat.fromXYZW(rtxpt.getGameNodeTransform(node, 3), rtxpt.getGameNodeTransform(node, 4),
        rtxpt.getGameNodeTransform(node, 5), rtxpt.getGameNodeTransform(node, 6));
}

function setNodeRotation(rtxpt: RtxptRenderer, node: int, q: Quat) {
    rtxpt.setGameNodeRotation(node, q.x, q.y, q.z, q.w);
}

function setNodeTransform(rtxpt: RtxptRenderer, node: int, p: Pose) {
    const q = p.rotation;
    rtxpt.setGameNodeTransform(node, p.tx, p.ty, p.tz, q.x, q.y, q.z, q.w, p.sx, p.sy, p.sz);
}

// game::SimpleProp (the only prop type): a node under the scene's root with one model instance, its start pose,
// its keyframe animation, the light overrides and components.
class Prop {
    node: int;
    startPose = new Pose();
    defaultCameraPose = new Pose();
    animation = new KeyframeAnimation();
    animPlaybackSpeed = 1.0;
    animOffset = 0.0;
    showOnlyIfTagged = "";
    models: ModelInstance[] = [];
    policeLights: PoliceLights[] = [];

    constructor(private rtxpt: RtxptRenderer, public name: string) {
        this.node = rtxpt.createGameNode(-1, name);
    }

    // PropBase::Load and SimpleProp::Load, with the game's --propShowTags and model types.
    load(json: int, propShowTags: string, modelTypes: ModelType[]) {
        const rtxpt = this.rtxpt;
        this.startPose.read(rtxpt, json, "startPose");
        // An empty "defaultCameraPose" is the pose of a camera at the origin looking along +x with +y up: no rotation.
        if (rtxpt.getGameJsonSize(json, "defaultCameraPose") > 0) {
            this.defaultCameraPose.read(rtxpt, json, "defaultCameraPose");
        }
        this.animPlaybackSpeed = f32(rtxpt.getGameJsonNumber(json, "animPlaybackSpeed", this.animPlaybackSpeed));
        this.showOnlyIfTagged = rtxpt.getGameJsonString(json, "showOnlyIfTagged", this.showOnlyIfTagged);
        if (rtxpt.getGameJsonSize(json, "animation") > 0) {
            this.animation.read(rtxpt, json, "animation");
        }

        if (this.showOnlyIfTagged != "" && !containsIgnoreCase(propShowTags, this.showOnlyIfTagged)) {
            return;
        }
        const modelType = findModelType(modelTypes, rtxpt.getGameJsonString(json, "modelName", ""));
        if (modelType == null || !modelType.valid) {
            console.log(`Prop ${this.name}: no model ${rtxpt.getGameJsonString(json, "modelName", "")}`);
            return;
        }
        // CreateAndAttachModel at the origin
        const model = new ModelInstance(rtxpt, "SimplePropOnlyModel", modelType, this.node);
        setNodeTransform(rtxpt, model.node, new Pose());
        this.models.push(model);
    }

    // PropBase::PostLoadSetup: the light overrides, then the components.
    postLoadSetup(json: int) {
        const rtxpt = this.rtxpt;
        const overrideCount = rtxpt.getGameJsonSize(json, "modelsLightsOverrides");
        for (let m = 0; m < overrideCount; m++) {
            const path = `modelsLightsOverrides/${m}`;
            const modelName = rtxpt.getGameJsonString(json, joinPath(path, "modelInstanceName"), "");
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
            const lightCount = rtxpt.getGameJsonSize(json, lightOverrides);
            for (let l = 0; l < lightCount; l++) {
                const lightPath = joinPath(lightOverrides, `${l}`);
                const lightName = rtxpt.getGameJsonString(json, joinPath(lightPath, "name"), "");
                let found = false;
                for (let i = 0; i < model.lights.length; i++) {
                    if (model.lights[i].nodeName == lightName) {
                        model.lights[i].read(rtxpt, json, lightPath);
                        found = true;
                        break;
                    }
                }
                if (!found) {
                    console.log(`Bad light override, prop ${this.name}, model ${modelName}, light name ${lightName}`);
                }
            }
        }

        const componentCount = rtxpt.getGameJsonSize(json, "components");
        for (let c = 0; c < componentCount; c++) {
            const path = `components/${c}`;
            // "BasicInteractableUI" only picks the prop with the mouse, not ported
            if (rtxpt.getGameJsonString(json, joinPath(path, "type"), "") == "PoliceLightingOnRX6") {
                const component = new PoliceLights();
                component.load(rtxpt, json, path, this.models);
                this.policeLights.push(component);
            }
        }
    }

    // PropBase::Reset
    reset() {
        setNodeTransform(this.rtxpt, this.node, this.startPose);
        this.animOffset = 0.0;
    }

    // PropBase::Tick (without the numpad moves of the selected prop)
    tick(gameTime: number) {
        const rtxpt = this.rtxpt;
        let animTime = 0.0;
        const pose: Pose[] = [new Pose()];
        if (this.animation.getAt(this.animPlaybackSpeed * gameTime + this.animOffset, true, pose)) {
            setNodeTransform(rtxpt, this.node, pose[0]);
            animTime = this.animation.animTime;
        }
        for (let i = 0; i < this.policeLights.length; i++) {
            this.policeLights[i].tick(rtxpt, animTime);
        }
        for (let i = 0; i < this.models.length; i++) {
            this.models[i].updateLightFromControllers(rtxpt, gameTime);
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

    constructor(private rtxpt: RtxptRenderer, public gameCamera: Camera) {
        for (let i = 0; i < 9; i++) {
            this.sceneCameraLast.push(0.0);
            this.cameraPose.push(0.0);
        }
    }

    // GameScene::Deinitialize
    private deinitialize() {
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

    // GameScene::SceneLoaded: after the scene file loaded (core/rtxpt.cpp's LoadScene), before the rest of the
    // loading (FinishLoadingScene). The game's files are in <assets>/SampleGame/<scene file name without .json>.
    sceneLoaded(scenePath: string, assetsPath: string, propShowTags: string, propCameraAttach: string) {
        this.deinitialize();
        this.propShowTags = propShowTags;
        const rtxpt = this.rtxpt;
        if (!rtxpt.hasGameSettings()) {
            return;
        }
        const storagePath = `${assetsPath}/SampleGame/${fileStem(scenePath, 1)}`;
        this.initialized = true;

        const modelCount = rtxpt.listFiles(`${storagePath}/models`, "*.model.json");
        const modelFiles: string[] = [];
        for (let i = 0; i < modelCount; i++) {
            modelFiles.push(rtxpt.getListedFile(i));
        }
        for (let i = 0; i < modelFiles.length; i++) {
            const json = rtxpt.loadGameJson(modelFiles[i]);
            if (json < 0) {
                continue;
            }
            this.modelTypes.push(new ModelType(rtxpt, fileStem(modelFiles[i], 2), json));
        }

        const propCount = rtxpt.listFiles(`${storagePath}/props`, "*.prop.json");
        const propFiles: string[] = [];
        for (let i = 0; i < propCount; i++) {
            propFiles.push(rtxpt.getListedFile(i));
        }
        for (let i = 0; i < propFiles.length; i++) {
            const json = rtxpt.loadGameJson(propFiles[i]);
            if (json < 0) {
                continue;
            }
            // CreatePropFromFile
            if (rtxpt.getGameJsonString(json, "propType", "") != "SimpleProp") {
                continue;
            }
            const prop = new Prop(rtxpt, fileStem(propFiles[i], 2));
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
            this.rtxpt.transformGameCamera(this.props[this.cameraAttached].node, Ref(p[0]));
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
