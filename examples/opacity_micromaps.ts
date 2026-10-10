// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";
import {
    cross3, matrixInverse, matrixLookAtLH, matrixMultiply, matrixPerspectiveFovLH, matrixRotationY,
    normalize3, normalize4, radians, transform3, vsub,
} from "../core/directx_math";

namespace OpacityMicromaps {
    const WINDOW_TITLE = "D3D12 Raytracing - Opacity Micromaps";
    const MEDIA_DIR = "media/opacity_micromaps/";
    const FONT_PATH = "media/fonts/OpenSans/OpenSans-Regular.ttf";
    // The sample's SegoeUI_18 sprite font in its 1280 x 720 window: OpenSans at the size matching
    // its strings' widths, and its line spacing.
    const FONT_SIZE = 31.5;
    const LINE_SPACING = 31.9;
    const LAYOUT_HEIGHT = 720.0;

    // GLFW keys and actions.
    const KEY_A = 65;
    const KEY_B = 66;
    const KEY_F = 70;
    const KEY_H = 72;
    const KEY_O = 79;
    const KEY_Q = 81;
    const KEY_R = 82;
    const KEY_W = 87;
    const KEY_X = 88;
    const KEY_Z = 90;
    const ACTION_RELEASE = 0;
    const ACTION_PRESS = 1;

    // The sample's ConfigFlags, ray flags and instance flags.
    const SHOW_AHS = 0x1;
    const RAY_FLAG_FORCE_OPAQUE = 0x1;
    // nvrhi::rt::InstanceFlags::DisableOMMs (D3D12_RAYTRACING_INSTANCE_FLAG_DISABLE_OMMS).
    const INSTANCE_FLAG_DISABLE_OMMS = 32;
    // nvrhi::rt::GeometryFlags: opaque, or none (the any-hit shader runs).
    const GEOMETRY_FLAG_NONE = 0;
    const GEOMETRY_FLAG_OPAQUE = 1;
    // nvrhi::rt::OpacityMicromapBuildFlags::FastTrace (PREFER_FAST_TRACE).
    const OMM_BUILD_FAST_TRACE = 1;

    const MAX_SUBDIVISION_LEVELS = 12;
    // In this model the leaves are always geometry 2, the only alpha-tested one.
    const ALPHA_TESTED_GEOMETRY = 2;
    // float3 colorRGB + uint flags.
    const PAYLOAD_SIZE = 16 + 4;
    // Primary rays + shadow rays.
    const MAX_RECURSION_DEPTH = 2;

    // SceneConstantBuffer (projectionToWorld, cameraPosition) and the root constants (configFlags,
    // the extra ray flags), each padded to a constant buffer's 256 bytes.
    const SCENE_CB_SIZE = 256;
    const PARAMS_SIZE = 256;
    const FOV_ZOOM_SPEED = 10.0;
    const MAX_USAGE_COUNTS = 64;

    // A micromap set of one subdivision level and state count: its file's descs, raw data and
    // per-triangle indices on the GPU, the counts the builds need, and its array once built.
    class OmmSet {
        loaded: boolean;
        descBuffer: BufferHandle;
        arrayBuffer: BufferHandle;
        indexBuffer: BufferHandle;
        indexFormat: Format;
        // The array's histogram and the leaves' usage counts: entries of (count, subdivision
        // level, format).
        histogram: int[];
        histogramCount: int;
        usage: int[];
        usageCount: int;
        built: boolean;
        omm: OpacityMicromapHandle;

        constructor() {
            this.loaded = false;
            this.indexFormat = Format.R32_UINT;
            this.histogram = [];
            this.histogramCount = 0;
            this.usage = [];
            this.usageCount = 0;
            this.built = false;
        }
    }

    // --- Passes -----------------------------------------------------------------------------

    // Port of DirectX-Graphics-Samples' D3D12RaytracingOpacityMicromaps: a tree whose leaves are
    // alpha tested by an any-hit shader, ray traced with a shadow ray per hit; the leaves'
    // triangles carry opacity micromaps (baked offline, 2- or 4-state, subdivision levels 1-12)
    // that resolve most of their hits as opaque or transparent without the any-hit shader. Keys as
    // the sample's: O micromaps, Q/W level, F state count, R camera rotation, Z/X zoom, A any-hit
    // shader, H shows where it ran, B rebuilds the acceleration structures every frame.
    class OpacityMicromapsPass {
        private app: App;
        private bindingLayout: BindingLayoutHandle;
        private shaderTable: ShaderTable;
        private sampler: SamplerHandle;
        private textures: TextureHandle[];
        private positionBuffer: BufferHandle;
        private normalBuffer: BufferHandle;
        private texCoordBuffer: BufferHandle;
        private positionIndexBuffer: BufferHandle;
        private normalIndexBuffer: BufferHandle;
        private texCoordIndexBuffer: BufferHandle;
        private geometryInfoBuffer: BufferHandle;
        private sceneBuffer: BufferHandle;
        private paramsBuffer: BufferHandle;
        private vertexCount: int;
        private indicesPerGeometry: int[];
        private ommSets: OmmSet[];
        private blas: TriangleBlas;
        private hasBlas: boolean;
        private topLevelAS: SceneAccelStructs;
        // Created on the first frame (it has the frame's size), dropped on resize.
        private storageImage: TextureHandle;
        private hasStorageImage: boolean;
        private bindingSet: BindingSet;
        private sceneData: f32[];
        private params: int[];
        private transform: f32[];

        // The sample's state (its constructor's defaults).
        private eye: number[];
        private at: number[];
        private up: number[];
        private fov: number;
        rotateCamera: boolean;
        ommEnabled: boolean;
        use4State: boolean;
        currentSubDLevel: int;
        configFlags: int;
        extraPrimaryRayFlags: int;
        extraShadowRayFlags: int;
        private rebuildASNextFrame: boolean;
        private rebuildASEveryFrame: boolean;
        private zoomIn: boolean;
        private zoomOut: boolean;

        // CalculateFrameStats.
        private statsSeconds: number;
        private statsFrames: int;
        private titleInfo: string;
        private width: int;
        private height: int;

        // The text.
        imguiPass: ImGuiPass;
        font: ImGuiFont;

        // -benchmark: 1/60 s per frame (for comparisons).
        benchmark: boolean;

        constructor(app: App) {
            this.app = app;
            this.textures = [];
            this.vertexCount = 0;
            this.indicesPerGeometry = [];
            this.ommSets = [];
            this.hasBlas = false;
            this.hasStorageImage = false;
            this.bindingSet = new BindingSet(null);
            this.sceneData = [];
            for (let i = 0; i < SCENE_CB_SIZE / 4; i++) {
                this.sceneData.push(0.0);
            }
            this.params = [];
            for (let i = 0; i < PARAMS_SIZE / 4; i++) {
                this.params.push(0);
            }
            this.transform = [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0];
            this.eye = [];
            this.at = [];
            this.up = [];
            this.fov = 45.0;
            this.rotateCamera = true;
            this.ommEnabled = true;
            this.use4State = true;
            this.currentSubDLevel = 3;
            this.configFlags = 0;
            this.extraPrimaryRayFlags = 0;
            this.extraShadowRayFlags = 0;
            this.rebuildASNextFrame = true;
            this.rebuildASEveryFrame = false;
            this.zoomIn = false;
            this.zoomOut = false;
            this.statsSeconds = 0.0;
            this.statsFrames = 0;
            this.titleInfo = "";
            this.width = 1280;
            this.height = 720;
            this.benchmark = false;
        }

        // The storage image has the back buffers' size.
        onBackBufferResizing(): void {
            const bindingSet = this.bindingSet;
            if (!bindingSet.isNull()) {
                this.app.releaseResource(bindingSet.handle);
                this.bindingSet = new BindingSet(null);
            }
            if (this.hasStorageImage) {
                this.app.releaseResource(this.storageImage);
                this.hasStorageImage = false;
            }
        }

        ommSet(subDLevel: int, use4State: boolean): OmmSet {
            const state: int = use4State ? 1 : 0;
            return this.ommSets[subDLevel * 2 + state];
        }

        // The sample's OnUpdate keys.
        onKey(key: int, scancode: int, action: int, mods: int): int {
            if (key == KEY_Z || key == KEY_X) {
                const held = action != ACTION_RELEASE;
                if (key == KEY_Z) {
                    this.zoomIn = held;
                } else {
                    this.zoomOut = held;
                }
                return 0;
            }
            if (action != ACTION_PRESS) {
                return 0;
            }
            if (key == KEY_O) {
                this.ommEnabled = !this.ommEnabled;
                this.rebuildASNextFrame = true;
            } else if (key == KEY_R) {
                this.rotateCamera = !this.rotateCamera;
            } else if (key == KEY_F) {
                this.use4State = !this.use4State;
                this.rebuildASNextFrame = true;
            } else if (key == KEY_Q || key == KEY_W) {
                const sign: int = key == KEY_Q ? -1 : 1;
                // The next level with a set loaded.
                for (let i = 0; i < MAX_SUBDIVISION_LEVELS; i++) {
                    this.currentSubDLevel = (this.currentSubDLevel + sign + MAX_SUBDIVISION_LEVELS) % MAX_SUBDIVISION_LEVELS;
                    if (this.ommSet(this.currentSubDLevel, this.use4State).loaded) {
                        break;
                    }
                }
                this.rebuildASNextFrame = true;
            } else if (key == KEY_H) {
                this.configFlags = this.configFlags ^ SHOW_AHS;
            } else if (key == KEY_A) {
                this.extraPrimaryRayFlags = this.extraPrimaryRayFlags ^ RAY_FLAG_FORCE_OPAQUE;
                this.extraShadowRayFlags = this.extraShadowRayFlags ^ RAY_FLAG_FORCE_OPAQUE;
            } else if (key == KEY_B) {
                this.rebuildASEveryFrame = !this.rebuildASEveryFrame;
            }
            return 0;
        }

        // The rest of the sample's OnUpdate, in float as its: the zoom and the camera's rotation
        // about y (360 degrees a minute).
        onAnimate(elapsedSeconds: number): void {
            const elapsedTime: number = this.benchmark ? Math.fround(1.0 / 60.0) : Math.fround(elapsedSeconds);
            this.updateFrameStats(elapsedSeconds);

            if (this.zoomIn) {
                this.fov = Math.fround(this.fov - Math.fround(FOV_ZOOM_SPEED * elapsedTime));
            }
            if (this.zoomOut) {
                this.fov = Math.fround(this.fov + Math.fround(FOV_ZOOM_SPEED * elapsedTime));
            }
            if (this.fov < 1.0) {
                this.fov = 1.0;
            }
            if (this.fov > 75.0) {
                this.fov = 75.0;
            }

            if (this.rotateCamera) {
                const secondsToRotateAround = 60.0;
                const deltaAngle = Math.fround(360.0 * Math.fround(elapsedTime / secondsToRotateAround));
                const rotate = matrixRotationY(radians(deltaAngle));
                this.eye = transform3(this.eye, rotate);
                this.up = transform3(this.up, rotate);
                this.at = transform3(this.at, rotate);
            }
        }

        // CalculateFrameStats: the frame rate and primary rays per second, once a second.
        updateFrameStats(elapsedSeconds: number): void {
            this.statsSeconds += elapsedSeconds;
            this.statsFrames++;
            if (this.statsSeconds >= 1.0) {
                const fps = this.statsFrames / this.statsSeconds;
                const mraysPerSecond = this.width * this.height * fps / 1.0e6;
                this.titleInfo = `    fps: ${fps.toFixed(2)}     ~Million Primary Rays/s: ${mraysPerSecond.toFixed(2)}    GPU: ${this.app.getRendererString()}`;
                this.statsSeconds = 0.0;
                this.statsFrames = 0;
            }
            Donut_SetWindowTitle(this.app.handle, WINDOW_TITLE + this.titleInfo);
        }

        // UpdateCameraMatrices and the root constants: projectionToWorld (fov vertically, depth 1 to
        // 1000), the camera position, the config and extra ray flags.
        writeParams(commandList: CommandList): void {
            const view = matrixLookAtLH(this.eye, this.at, this.up);
            const proj = matrixPerspectiveFovLH(radians(this.fov), Math.fround(this.width / this.height), 1.0, 1000.0);
            const projectionToWorld = matrixInverse(matrixMultiply(view, proj));
            for (let i = 0; i < 16; i++) {
                this.sceneData[i] = projectionToWorld[i];
            }
            for (let i = 0; i < 4; i++) {
                this.sceneData[16 + i] = this.eye[i];
            }
            commandList.writeBuffer(this.sceneBuffer, Ref(this.sceneData[0]), SCENE_CB_SIZE);
            this.params[0] = this.configFlags;
            this.params[1] = this.extraPrimaryRayFlags;
            this.params[2] = this.extraShadowRayFlags;
            commandList.writeBuffer(this.paramsBuffer, Ref(this.params[0]), PARAMS_SIZE);
        }

        // BuildAccelerationStructures: the selected set's micromap array, a BLAS of the three
        // geometries (the leaves non-opaque, linked to the array), and the TLAS's one instance
        // (micromaps disabled by its flags when they're off). Built anew when the set changes,
        // again in place when rebuilding every frame.
        buildAccelerationStructures(frame: Frame): boolean {
            const commandList = frame.getCommandList();
            const set = this.ommSet(this.currentSubDLevel, this.use4State);
            if (!set.loaded) {
                return false;
            }
            const setChanged = !set.built || this.rebuildASNextFrame;
            if (!set.built) {
                const omm = this.app.createOpacityMicromap(commandList, set.arrayBuffer, 0, set.descBuffer, 0,
                    Ref(set.histogram[0]), set.histogramCount, OMM_BUILD_FAST_TRACE, "OMMArray");
                if (!omm) {
                    return false;
                }
                set.omm = omm as OpacityMicromapHandle;
                set.built = true;
            } else if (!setChanged) {
                commandList.buildOpacityMicromap(set.omm);
            }

            if (setChanged || !this.hasBlas) {
                if (this.hasBlas) {
                    this.app.releaseObject(this.blas.handle);
                }
                const blas = this.app.createEmptyTriangleBlas("BottomLevelAccelerationStructure");
                let indexOffset = 0;
                for (let i = 0; i < this.indicesPerGeometry.length; i++) {
                    blas.addGeometry(this.positionIndexBuffer, indexOffset * 4, this.indicesPerGeometry[i],
                        this.positionBuffer, 0, this.vertexCount, 12, null);
                    if (i == ALPHA_TESTED_GEOMETRY) {
                        blas.setGeometryFlags(i, GEOMETRY_FLAG_NONE);
                        // Its triangles' micromap indices start the set's (the only alpha-tested
                        // geometry).
                        blas.setGeometryOpacityMicromap(i, set.omm, set.indexBuffer, 0, set.indexFormat,
                            Ref(set.usage[0]), set.usageCount);
                    } else {
                        blas.setGeometryFlags(i, GEOMETRY_FLAG_OPAQUE);
                    }
                    indexOffset += this.indicesPerGeometry[i];
                }
                if (blas.build(this.app, commandList, AccelStructBuildFlags.PreferFastTrace) == 0) {
                    return false;
                }
                this.blas = blas;
                this.hasBlas = true;
            } else {
                this.blas.rebuild(commandList);
            }

            // Identity transform, mask 1.
            const flags: int = this.ommEnabled ? 0 : INSTANCE_FLAG_DISABLE_OMMS;
            this.topLevelAS.addInstanceWithHitGroup(this.blas.getAccelStruct(), 1, 0, 0, flags, Ref(this.transform[0]));
            frame.buildTopLevelAS(this.topLevelAS);
            return true;
        }

        onRender(frameHandle: FrameHandle): void {
            const frame = new Frame(frameHandle);
            const commandList = frame.getCommandList();
            this.width = frame.getWidth();
            this.height = frame.getHeight();

            if (this.rebuildASEveryFrame || this.rebuildASNextFrame) {
                if (!this.buildAccelerationStructures(frame)) {
                    console.log("Cannot build the acceleration structures");
                    Donut_CloseWindow(this.app.handle);
                    return;
                }
                this.rebuildASNextFrame = false;
            }

            let bindingSet = this.bindingSet;
            if (!this.hasStorageImage || bindingSet.isNull()) {
                // The output the ray generation shader writes: the back buffer's R10G10B10A2_UNORM,
                // for the copy below.
                this.storageImage = this.app.createUAVTextureForFrameCopy(frame, "Output");
                this.hasStorageImage = true;

                const bindingSetDesc = BindingSetDesc.create();
                bindingSetDesc.bindAccelStruct(0, this.topLevelAS.getTopLevelAS());
                bindingSetDesc.bindTextureUAV(0, this.storageImage);
                bindingSetDesc.bindEntireConstantBuffer(0, this.sceneBuffer);
                bindingSetDesc.bindEntireConstantBuffer(1, this.paramsBuffer);
                bindingSetDesc.bindSampler(0, this.sampler);
                for (let i = 0; i < this.textures.length; i++) {
                    bindingSetDesc.bindTextureSRV(1 + i, this.textures[i]);
                }
                bindingSetDesc.bindRawBufferSRV(5, this.positionBuffer);
                bindingSetDesc.bindRawBufferSRV(6, this.normalBuffer);
                bindingSetDesc.bindRawBufferSRV(7, this.texCoordBuffer);
                bindingSetDesc.bindRawBufferSRV(8, this.positionIndexBuffer);
                bindingSetDesc.bindRawBufferSRV(9, this.normalIndexBuffer);
                bindingSetDesc.bindRawBufferSRV(10, this.texCoordIndexBuffer);
                bindingSetDesc.bindStructuredBufferSRV(11, this.geometryInfoBuffer);
                bindingSet = this.app.createBindingSetForLayout(bindingSetDesc, this.bindingLayout);
                this.bindingSet = bindingSet;
            }

            this.writeParams(commandList);
            frame.dispatchRays(this.shaderTable, bindingSet, this.width, this.height);

            // CopyRaytracingOutputToBackbuffer: as the sample's CopyResource, bit for bit.
            frame.copyTextureToFrame(this.storageImage);
        }

        // RenderUI: white lines from (30, 30), the any-hit legend in its colors.
        line(y: number, text: string, r: number, g: number, b: number): void {
            const scale = this.height / LAYOUT_HEIGHT;
            this.font.push();
            Donut_ImGuiDrawText(30.0 * scale, y * scale, text, r, g, b, 1.0, 0);
            Donut_ImGuiPopFont();
        }

        onOff(value: boolean): string {
            if (value) {
                return "On";
            }
            return "Off";
        }

        buildUI(): void {
            let y = 30.0;
            this.line(y, "D3D12: Opacity Micromaps", 1.0, 1.0, 1.0);
            y += LINE_SPACING * 2.0;
            let ommState = "Disabled";
            if (this.ommEnabled) {
                ommState = "Enabled";
            }
            this.line(y, `OMM: ${ommState} - Press 'O'`, 1.0, 1.0, 1.0);
            y += LINE_SPACING;
            this.line(y, `OMM: Subdivision Level (${this.currentSubDLevel + 1}) - Press 'Q/W'`, 1.0, 1.0, 1.0);
            y += LINE_SPACING;
            let states = "2";
            if (this.use4State) {
                states = "4";
            }
            this.line(y, `OMM: ${states} State - Press 'F'`, 1.0, 1.0, 1.0);
            y += LINE_SPACING;
            this.line(y, `Rotate Camera (${this.onOff(this.rotateCamera)}) - Press 'R'`, 1.0, 1.0, 1.0);
            y += LINE_SPACING;
            this.line(y, `Zoom (${this.fov.toFixed(1)} deg) - Hold 'Z/X'`, 1.0, 1.0, 1.0);
            y += LINE_SPACING;
            this.line(y, `AHS (${this.onOff((this.extraPrimaryRayFlags & RAY_FLAG_FORCE_OPAQUE) == 0)}) - Press 'A'`, 1.0, 1.0, 1.0);
            y += LINE_SPACING;
            const showAhs = (this.configFlags & SHOW_AHS) != 0;
            this.line(y, `Show AHS Invocations (${this.onOff(showAhs)}) - Press 'H'`, 1.0, 1.0, 1.0);
            y += LINE_SPACING;
            if (showAhs) {
                const scale = this.height / LAYOUT_HEIGHT;
                this.font.push();
                Donut_ImGuiDrawText(60.0 * scale, y * scale, "Hits not needing AHS: Normal material colour", 0.25, 0.75, 0.25, 1.0, 0);
                Donut_ImGuiDrawText(60.0 * scale, (y + LINE_SPACING) * scale, "Hits needing AHS: Magenta-tinted material colour", 0.65, 0.25, 0.65, 1.0, 0);
                Donut_ImGuiDrawText(60.0 * scale, (y + LINE_SPACING * 2.0) * scale, "Misses needing AHS: Magenta", 1.0, 0.0, 1.0, 1.0, 0);
                Donut_ImGuiPopFont();
                y += LINE_SPACING * 3.0;
            }
            this.line(y, `Build OMM/BLAS/TLAS every frame (${this.onOff(this.rebuildASEveryFrame)}) - Press 'B'`, 1.0, 1.0, 1.0);
            y += LINE_SPACING;
            if (this.currentSubDLevel + 1 > 8) {
                y += LINE_SPACING;
                this.line(y, "Warning: Subdivision levels > 8 shows little/no change on this model!", 1.0, 1.0, 0.0);
            }
        }

        // LoadModel: positions, normals and texture coordinates, then the geometries' index counts
        // and the position, normal and texture coordinate indices of all, each indexed separately.
        loadModel(commandList: CommandList): boolean {
            const file = this.app.loadBinaryFile(MEDIA_DIR + "treeModel.bin");
            if (file.isNull()) {
                return false;
            }
            let header: int[] = [0, 0, 0];
            file.copyUInts(0, 3, Ref(header[0]));
            const positionCount = header[0];
            const normalCount = header[1];
            const texCoordCount = header[2];
            let offset = 12;
            const positionSize = positionCount * 12;
            const normalSize = normalCount * 12;
            const texCoordSize = texCoordCount * 8;

            this.positionBuffer = this.app.createAccelStructInputRawBuffer(positionSize, "Position Buffer");
            this.normalBuffer = this.app.createAccelStructInputRawBuffer(normalSize, "Normal Buffer");
            this.texCoordBuffer = this.app.createAccelStructInputRawBuffer(texCoordSize, "TexCoord Buffer");
            file.writeBufferFromBinaryFile(commandList, this.positionBuffer, 0, offset, positionSize);
            offset += positionSize;
            file.writeBufferFromBinaryFile(commandList, this.normalBuffer, 0, offset, normalSize);
            offset += normalSize;
            file.writeBufferFromBinaryFile(commandList, this.texCoordBuffer, 0, offset, texCoordSize);
            offset += texCoordSize;
            this.vertexCount = positionCount;

            let count: int[] = [0];
            file.copyUInts(offset, 1, Ref(count[0]));
            offset += 4;
            const numGeoms = count[0];
            let perGeometry: int[] = [];
            for (let i = 0; i < numGeoms; i++) {
                perGeometry.push(0);
            }
            file.copyUInts(offset, numGeoms, Ref(perGeometry[0]));
            offset += numGeoms * 4;
            this.indicesPerGeometry = perGeometry;
            file.copyUInts(offset, 1, Ref(count[0]));
            offset += 4;
            const totalIndices = count[0];
            const indexSize = totalIndices * 4;

            this.positionIndexBuffer = this.app.createAccelStructInputRawBuffer(indexSize, "Position Index Buffer");
            this.normalIndexBuffer = this.app.createAccelStructInputRawBuffer(indexSize, "Normal Index Buffer");
            this.texCoordIndexBuffer = this.app.createAccelStructInputRawBuffer(indexSize, "TexCoord Index Buffer");
            file.writeBufferFromBinaryFile(commandList, this.positionIndexBuffer, 0, offset, indexSize);
            offset += indexSize;
            file.writeBufferFromBinaryFile(commandList, this.normalIndexBuffer, 0, offset, indexSize);
            offset += indexSize;
            file.writeBufferFromBinaryFile(commandList, this.texCoordIndexBuffer, 0, offset, indexSize);
            this.app.releaseObject(file.handle);

            // Each geometry's offset in the index buffers (in triangles) and textures: the
            // diffuse texture i + 1, the alpha texture 0 for the leaves (-1: none).
            let geometryInfos: int[] = [];
            let primitiveOffset: int = 0;
            for (let i = 0; i < numGeoms; i++) {
                const alphaTextureIndex: int = i == ALPHA_TESTED_GEOMETRY ? 0 : -1;
                geometryInfos.push(primitiveOffset);
                geometryInfos.push(i + 1);
                geometryInfos.push(alphaTextureIndex);
                const triangles: int = Math.floor(perGeometry[i] / 3);
                primitiveOffset += triangles;
            }
            this.geometryInfoBuffer = this.app.createStructuredBuffer(12, numGeoms, "Geometry Info Buffer");
            commandList.writeBuffer(this.geometryInfoBuffer, Ref(geometryInfos[0]), numGeoms * 12);
            return true;
        }

        // LoadOMM: a set's counts, its descs, raw data, histogram and per-triangle indices.
        loadOmmSet(commandList: CommandList, path: string, set: OmmSet): void {
            const file = this.app.loadBinaryFile(path);
            if (file.isNull()) {
                return;
            }
            let counts: int[] = [0, 0, 0, 0, 0];
            file.copyUInts(0, 5, Ref(counts[0]));
            const arrayDataSize = counts[0];
            const descCount = counts[1];
            const histogramCount = counts[2];
            set.indexFormat = counts[3] == 0 ? Format.R16_UINT : Format.R32_UINT;
            const indexCount = counts[4];
            const indexSize = indexCount * (counts[3] == 0 ? 2 : 4);

            const descOffset = 20;
            const descSize = descCount * 8;
            const arrayOffset = descOffset + descSize;
            const histogramOffset = arrayOffset + arrayDataSize;
            const indexOffset = histogramOffset + histogramCount * 12;

            set.descBuffer = this.app.createAccelStructInputBuffer(descSize, "OMM Desc Buffer");
            set.arrayBuffer = this.app.createAccelStructInputBuffer(arrayDataSize, "OMM Array Buffer");
            set.indexBuffer = this.app.createAccelStructInputBuffer(indexSize, "OMM Index Buffer");
            file.writeBufferFromBinaryFile(commandList, set.descBuffer, 0, descOffset, descSize);
            file.writeBufferFromBinaryFile(commandList, set.arrayBuffer, 0, arrayOffset, arrayDataSize);
            file.writeBufferFromBinaryFile(commandList, set.indexBuffer, 0, indexOffset, indexSize);

            for (let i = 0; i < histogramCount * 3; i++) {
                set.histogram.push(0);
            }
            file.copyUInts(histogramOffset, histogramCount * 3, Ref(set.histogram[0]));
            set.histogramCount = histogramCount;
            for (let i = 0; i < MAX_USAGE_COUNTS * 3; i++) {
                set.usage.push(0);
            }
            set.usageCount = file.countOpacityMicromapUsage(indexOffset, indexCount, set.indexFormat, descOffset, descCount,
                Ref(set.usage[0]), MAX_USAGE_COUNTS);
            this.app.releaseObject(file.handle);
            set.loaded = set.usageCount <= MAX_USAGE_COUNTS;
        }

        // CreateRaytracingPipelineStateObject and BuildShaderTables: one hit group (closest hit and
        // any hit), micromaps allowed.
        createRayTracingPipeline(): boolean {
            const shaderLibrary = this.app.createShaderLibrary("opacity_micromaps.hlsl");
            if (!shaderLibrary) {
                return false;
            }
            const pipelineDesc = RtPipelineDesc.create(PAYLOAD_SIZE, MAX_RECURSION_DEPTH);
            pipelineDesc.setAllowOpacityMicromaps(1);
            pipelineDesc.addGlobalBindingLayout(this.bindingLayout);
            pipelineDesc.addShader(shaderLibrary, "MyRaygenShader", ShaderType.RayGeneration);
            pipelineDesc.addShader(shaderLibrary, "MyMissShader", ShaderType.Miss);
            pipelineDesc.addHitGroup(shaderLibrary, "MyHitGroup", "MyClosestHitShader", "MyAnyHitShader", null);
            const pipeline = this.app.createRayTracingPipelineFromDesc(pipelineDesc);
            if (!pipeline) {
                return false;
            }
            const shaderTable = this.app.createEmptyShaderTable(pipeline);
            // The shader table keeps the pipeline alive.
            this.app.releaseResource(pipeline);
            shaderTable.setRayGeneration("MyRaygenShader");
            shaderTable.addMiss("MyMissShader");
            shaderTable.addHitGroup("MyHitGroup", null);
            this.shaderTable = shaderTable;
            return true;
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(): boolean {
            // The sample's static sampler: anisotropic (16), wrapping. Before any command list is
            // open: it creates Donut's common passes.
            this.sampler = this.app.getCommonSampler(CommonSampler.AnisotropicWrap);

            const layoutDesc = BindingLayoutDesc.create();
            layoutDesc.layoutAccelStruct(0);
            layoutDesc.layoutTextureUAV(0);
            layoutDesc.layoutVolatileConstantBuffer(0);
            layoutDesc.layoutVolatileConstantBuffer(1);
            layoutDesc.layoutSampler(0);
            for (let slot = 1; slot <= 4; slot++) {
                layoutDesc.layoutTextureSRV(slot);
            }
            for (let slot = 5; slot <= 10; slot++) {
                layoutDesc.layoutRawBufferSRV(slot);
            }
            layoutDesc.layoutStructuredBufferSRV(11);
            this.bindingLayout = this.app.createBindingLayout(layoutDesc, ShaderType.All);

            if (!this.createRayTracingPipeline()) {
                return false;
            }

            // InitializeScene's camera: from (0, 7, -24) towards (0, 8.7, 0), its up vector
            // perpendicular to the view direction and x, both turned 45 degrees about y.
            this.eye = [0.0, 7.0, -24.0, 1.0];
            this.at = [0.0, Math.fround(8.7), 0.0, 1.0];
            const direction = normalize4(vsub(this.at, this.eye));
            this.up = normalize3(cross3(direction, [1.0, 0.0, 0.0, 0.0]));
            const rotate = matrixRotationY(radians(45.0));
            this.eye = transform3(this.eye, rotate);
            this.up = transform3(this.up, rotate);

            this.sceneBuffer = this.app.createVolatileConstantBuffer(SCENE_CB_SIZE, "SceneConstants");
            this.paramsBuffer = this.app.createVolatileConstantBuffer(PARAMS_SIZE, "Params");
            this.topLevelAS = this.app.createTopLevelASWithFlags(1, AccelStructBuildFlags.PreferFastTrace);
            if (this.topLevelAS.isNull()) {
                return false;
            }

            const commandList = this.app.createCommandList();
            commandList.open();
            let loaded = this.loadModel(commandList);
            // LoadTextures: the leaves' alpha, the trunk's, branches' and leaves' colors (BC4, BC1;
            // not sRGB).
            const textureNames = [
                "jacaranda_tree_leaves_alpha_4k.dds",
                "jacaranda_tree_trunk_diff_4k.dds",
                "jacaranda_tree_branches_diff_4k.dds",
                "jacaranda_tree_leaves_diff_4k.dds",
            ];
            for (let i = 0; loaded && i < textureNames.length; i++) {
                const texture = this.app.loadTexture(commandList, MEDIA_DIR + textureNames[i], 0);
                if (!texture) {
                    loaded = false;
                } else {
                    this.textures.push(texture);
                }
            }
            // LoadAndBuildAccelerationStructures: every level's 2- and 4-state sets.
            for (let level = 0; level < MAX_SUBDIVISION_LEVELS; level++) {
                for (let state = 0; state <= 1; state++) {
                    const set = new OmmSet();
                    if (loaded) {
                        const states: int = state == 0 ? 2 : 4;
                        this.loadOmmSet(commandList, `${MEDIA_DIR}treeOMM_SubD${level + 1}_${states}State.bin`, set);
                    }
                    this.ommSets.push(set);
                }
            }
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.releaseResource(commandList.handle);
            if (!loaded || !this.ommSet(this.currentSubDLevel, this.use4State).loaded) {
                console.log("Cannot load the model, textures or micromaps: set DIRECTX_GRAPHICS_SAMPLES_DIR when configuring");
                return false;
            }

            const pass = this.app.addPass();
            pass.setAnimateCallback(this.onAnimate);
            pass.setKeyboardCallback(this.onKey);
            pass.setBackBufferResizingCallback(this.onBackBufferResizing);
            pass.setRenderCallback(this.onRender);

            const imguiPass = this.app.addImGuiPass(this.buildUI);
            if (imguiPass.isNull()) {
                return false;
            }
            this.imguiPass = imguiPass;
            const font = imguiPass.createFont(FONT_PATH, FONT_SIZE);
            if (font.isNull()) {
                console.log("Cannot load the font");
                return false;
            }
            this.font = font;
            return true;
        }
    }

    export function main(argc: int, argv: Ref<string>): int {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("opacity_micromaps");

        // -debug: the graphics API's debug layer and NVRHI's validation layer.
        // -benchmark: 1/60 s per frame.
        // R10G10B10A2_UNORM back buffers (in sRGB), as the sample's.
        let options = AppOptions.RayTracing | AppOptions.HdrBackBuffer;
        let benchmark = false;
        for (let i = 1; i < argc; i++) {
            const arg = Donut_GetArg(argv, i);
            if (arg == "-debug") {
                options = options | AppOptions.DebugRuntime;
            } else if (arg == "-benchmark") {
                benchmark = true;
            }
        }

        // The sample's window.
        const api = Donut_GetGraphicsAPIFromCommandLine(argc, argv);
        const app = App.createWithOptions(api, WINDOW_TITLE, 1280, 720, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        if (!app.isFeatureSupported(Feature.RayTracingPipeline)) {
            console.log("The graphics device does not support Ray Tracing Pipelines");
            app.destroy();
            return 1;
        }
        if (!app.isFeatureSupported(Feature.RayTracingOpacityMicromap)) {
            console.log("The graphics device does not support opacity micromaps (D3D12: raytracing tier 1.2; Vulkan: VK_EXT_opacity_micromap)");
            app.destroy();
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        const pass = new OpacityMicromapsPass(app);
        pass.benchmark = benchmark;
        if (!pass.init()) {
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
    return OpacityMicromaps.main(argc, argv);
}
