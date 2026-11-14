/// <reference path="../../core/nri/nri_interop.d.ts" />
import { NriFrameRing } from "../../core/nri_frame_ring";
import { NriSwapChain } from "../../core/nri_swap_chain";
import { SdkMesh } from "../../core/sdk_mesh";
import { identity, multiplyF32, inverse } from "../../core/matrix";
import { Nri, NriBuffer, NriCommandBuffer, NriDescriptor, NriDescriptorPool, NriDescriptorSet, NriDevice, NriFile, NriImgui, NriImguiFont, NriPipeline, NriPipelineDesc, NriPipelineLayout, NriPipelineLayoutDesc, NriQueue, NriSample, NriTexture } from "../../core/nri";

namespace MouseCursorNri {
    // mouse_cursor, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead of Donut
    // and NVRHI: the same shaders (mouse_cursor.hlsl's: the sample's SpriteBatch and DirectXTK
    // effects) and SDKMESH reader (core/sdkmesh.cpp, which nri_interop.dll holds), through the NRI
    // calls core/nri/nri_interop.d.ts binds, with NRIFramework's ImGui for the sample's text and
    // cursor (their colors stored as they are, as Donut's ImGui renderer stores them in the UNORM back
    // buffer). The window's mouse and keys are polled each frame (NRIFramework has no callbacks); its
    // Key values come from donut_interop.d.ts (declarations only, through core/sdk_mesh.ts). This
    // example creates everything it runs, and does the rendering.

    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;

    const WINDOW_TITLE = "NRI Example: Mouse Cursor";
    const MEDIA_DIR = "media/mouse_cursor/";
    const FONT_PATH = "media/fonts/OpenSans/OpenSans-Regular.ttf";

    // The sample's sprite fonts (SegoeUI_34, _24 and _22) as OpenSans sizes giving its strings'
    // widths: 42.3, 30.9 and 27.7 pixel ems, times 1.3618 as ImGui sizes a font by its ascent +
    // descent (OpenSans: (2189 + 600) / 2048 em); and the sprite fonts' line spacings.
    const TITLE_FONT_SIZE = 57.6;
    const SUBTITLE_FONT_SIZE = 42.1;
    const TILE_FONT_SIZE = 37.7;
    const TITLE_LINE_SPACING = 60.3;
    const SUBTITLE_LINE_SPACING = 42.6;
    const TILE_LINE_SPACING = 39.0;

    // DirectX::Colors::CornflowerBlue, cleared in the UNORM swap chain texture as the sample's.
    const CORNFLOWER_BLUE = [0.392156899, 0.584313750, 0.929411829];

    const ROTATION_GAIN = 0.004; // sensitivity adjustment
    const PI = 3.14159274;

    // The sample's modes.
    const ABSOLUTE_MOUSE = 0;
    const RELATIVE_MOUSE = 1;
    const CLIPCURSOR_MOUSE = 2;

    // SpriteConstants (mouse_cursor.hlsl, push constants): rect, target size, padding, color.
    const SPRITE_FLOATS = 12;
    // Parameters (mouse_cursor.hlsl): DiffuseColor, EmissiveColor, SpecularColor and
    // SpecularPower, the three lights' directions, diffuse and specular colors, EyePosition,
    // World, WorldInverseTranspose, WorldViewProj; a material's slice of a queued frame's constants
    // PARAMETERS_SLICE_SIZE bytes (a multiple of 256, D3D12's).
    const PARAMETERS_FLOATS = 100;
    const PARAMETERS_EMISSIVE = 4;
    const PARAMETERS_SPECULAR = 8;
    const PARAMETERS_LIGHTS = 12;
    const PARAMETERS_EYE = 48;
    const PARAMETERS_WORLD = 52;
    const PARAMETERS_WORLD_INVERSE_TRANSPOSE = 68;
    const PARAMETERS_WORLD_VIEW_PROJ = 84;
    const PARAMETERS_SLICE_SIZE = 512;

    // DirectXTK's EffectLights::EnableDefaultLighting.
    const DEFAULT_DIRECTIONS = [
        -0.5265408, -0.5735765, -0.6275069,
        0.7198464, 0.3420201, 0.6040227,
        0.4545195, -0.7660444, 0.4545195,
    ];
    const DEFAULT_DIFFUSE = [
        1.0000000, 0.9607844, 0.8078432,
        0.9647059, 0.7607844, 0.4078432,
        0.3231373, 0.3607844, 0.3937255,
    ];
    const DEFAULT_SPECULAR = [
        1.0000000, 0.9607844, 0.8078432,
        0.0000000, 0.0000000, 0.0000000,
        0.3231373, 0.3607844, 0.3937255,
    ];
    const DEFAULT_AMBIENT = [0.05333332, 0.09882354, 0.1819608];

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // What a frame in flight records into: its command buffer; per material of each model (the
    // FPS room's, then the RTS map's) its set (its slice of the constants, its textures, the
    // sampler) and the slice's view.
    class QueuedFrame {
        materialSets: NriDescriptorSet[] = [];
        materialViews: NriDescriptor[] = [];

        constructor(public commandBuffer: NriCommandBuffer) {
        }
    }

    // -test: checks the last frame, read back, as the Donut example does: the menu over the gray
    // background, its two green buttons about 7% of the frame.
    function checkFrame(pixels: int[], width: int, height: int) {
        if (pixels.length == 0) {
            return "cannot read the back buffer";
        }
        const total = width * height;
        let dark = 0;
        let buttons = 0;
        for (let i = 0; i < total; i++) {
            const p = pixels[i];
            const r = p & 0xFF;
            const g = (p >> 8) & 0xFF;
            const b = (p >> 16) & 0xFF;
            if (r <= 20 && g <= 20 && b <= 20) {
                dark++;
            }
            if (r <= 89 && g >= 121 && b <= 89) {
                buttons++;
            }
        }
        const lit = 100.0 * (total - dark) / total;
        console.log(`Lit: ${lit}% (${total - dark} of ${total} pixels)`);
        if (lit < 95.0 || lit > 100.0) {
            return `Lit: ${lit}% of the pixels, not 95% to 100%`;
        }
        const buttonsPercent = 100.0 * buttons / total;
        console.log(`Buttons: ${buttonsPercent}% (${buttons} of ${total} pixels)`);
        if (buttonsPercent < 5.0 || buttonsPercent > 10.0) {
            return `Buttons: ${buttonsPercent}% of the pixels, not 5% to 10%`;
        }
        return "";
    }

    // --- Math (DirectXMath's layout: 4 x 4 matrices by rows, for row vectors) ----------------

    function f(x: number) {
        return Math.fround(x);
    }

    function transpose(a: number[]) {
        let result: number[] = [];
        for (let row = 0; row < 4; row++) {
            for (let column = 0; column < 4; column++) {
                result.push(a[column * 4 + row]);
            }
        }
        return result;
    }

    // XMMatrixRotationX.
    function rotationX(angle: number) {
        const c = f(Math.cos(angle));
        const s = f(Math.sin(angle));
        return [1.0, 0.0, 0.0, 0.0, 0.0, c, s, 0.0, 0.0, -s, c, 0.0, 0.0, 0.0, 0.0, 1.0];
    }

    // XMMatrixRotationY.
    function rotationY(angle: number) {
        const c = f(Math.cos(angle));
        const s = f(Math.sin(angle));
        return [c, 0.0, -s, 0.0, 0.0, 1.0, 0.0, 0.0, s, 0.0, c, 0.0, 0.0, 0.0, 0.0, 1.0];
    }

    function normalize3(v: number[]) {
        const length = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
        return [f(v[0] / length), f(v[1] / length), f(v[2] / length)];
    }

    function cross3(a: number[], b: number[]) {
        return [f(a[1] * b[2] - a[2] * b[1]), f(a[2] * b[0] - a[0] * b[2]), f(a[0] * b[1] - a[1] * b[0])];
    }

    function dot3(a: number[], b: number[]) {
        return f(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]);
    }

    // XMMatrixLookToLH.
    function lookToLH(eye: number[], direction: number[], up: number[]) {
        const r2 = normalize3(direction);
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

    // SimpleMath's Matrix::CreateLookAt: XMMatrixLookAtRH (XMMatrixLookToLH along eye - target).
    function lookAtRH(eye: number[], target: number[], up: number[]) {
        return lookToLH(eye, [f(eye[0] - target[0]), f(eye[1] - target[1]), f(eye[2] - target[2])], up);
    }

    // XMMatrixPerspectiveFovLH.
    function perspectiveFovLH(fovY: number, aspect: number, nearZ: number, farZ: number) {
        const height = f(Math.cos(0.5 * fovY) / Math.sin(0.5 * fovY));
        const width = f(height / aspect);
        const range = f(farZ / (farZ - nearZ));
        return [
            width, 0.0, 0.0, 0.0,
            0.0, height, 0.0, 0.0,
            0.0, 0.0, range, 1.0,
            0.0, 0.0, f(-range * nearZ), 0.0,
        ];
    }

    // value clamped to [0, max] (explicit: tslang's Math.max gets negative numbers wrong).
    function clampTo(value: number, max: number) {
        return value < 0.0 ? 0.0 : value > max ? max : value;
    }

    // Whether the camera may go to eye (the RTS map's bounds).
    function inBounds(eye: number[]) {
        return eye[2] < -1.0 * eye[0] + 400.0 && eye[2] < eye[0] + 800.0
            && eye[2] > -1.0 * eye[0] - 300.0 && eye[2] > eye[0] - 800.0;
    }

    // Whether (x, y) is inside a tile (left, top, right, bottom), its edges excluded.
    function inTile(tile: int[], x: number, y: number) {
        return x < tile[2] && x > tile[0] && y > tile[1] && y < tile[3];
    }

    // --- Models -------------------------------------------------------------------------------

    // A SDKMESH model as DirectXTK's Model::CreateFromSDKMESH makes it (core/sdkmesh.cpp parses the
    // file): its vertex and index buffers, its mesh parts (one per subset), and per material the
    // effect's diffuse color, specular color and power, emissive color, and textures (the diffuse
    // texture; the specular texture, which is DualTextureEffect's second texture) with their views.
    class Model {
        vertexBuffers: NriBuffer[] = [];
        indexBuffers: NriBuffer[] = [];
        index32: boolean[] = [];
        partVertexBuffers: int[] = [];
        partIndexBuffers: int[] = [];
        partMaterials: int[] = [];
        partIndexCounts: int[] = [];
        partStartIndices: int[] = [];
        partVertexOffsets: int[] = [];
        materialColors: number[] = [];
        materialSpecular: number[] = [];
        materialEmissive: number[] = [];
        materialTextures: NriTexture[] = [];
        materialTextures2: NriTexture[] = [];
        materialViews: NriDescriptor[] = [];
        materialViews2: NriDescriptor[] = [];
        stride: int = 0;

        // The file's buffers uploaded on the queue, its materials' textures loaded (DDS files as
        // they are). dualTexture: the materials' specular textures too, and the vertices must have
        // two texture coordinates. False (after printing why) on failure.
        load(device: NriDevice, queue: NriQueue, file: string, stride: int, dualTexture: boolean) {
            this.stride = stride;
            const binaryFile = NriFile.load(MEDIA_DIR + file);
            if (!binaryFile) {
                console.log(`Cannot load ${file}: set XBOX_ATG_SAMPLES_DIR when configuring`);
                return false;
            }
            const mesh = SdkMesh.load(binaryFile.getData(), binaryFile.getSize());
            if (mesh.isNull()) {
                binaryFile.destroy();
                console.log(`${file}: not a SDKMESH file`);
                return false;
            }

            // Position, normal, texture coordinates (and a second set for the dual texture effect).
            let ok = true;
            for (let i = 0; i < mesh.getVertexBufferCount(); i++) {
                let layoutOk = mesh.getVertexBufferStride(i) == stride
                    && mesh.getVertexElementOffset(i, 3, 0) == 12 && mesh.getVertexElementOffset(i, 5, 0) == 24;
                if (dualTexture && mesh.getVertexElementOffset(i, 5, 1) != 32) {
                    layoutOk = false;
                }
                if (!layoutOk) {
                    console.log(`${file}: unexpected vertex layout`);
                    ok = false;
                }
                const buffer = device.createUploadedBufferFromPointer(queue, mesh.getVertexBufferData(i), mesh.getVertexBufferSize(i),
                    NriBufferUsage.VertexBuffer);
                if (!buffer) {
                    ok = false;
                } else {
                    this.vertexBuffers.push(buffer);
                }
            }
            for (let i = 0; i < mesh.getIndexBufferCount(); i++) {
                const buffer = device.createUploadedBufferFromPointer(queue, mesh.getIndexBufferData(i), mesh.getIndexBufferSize(i),
                    NriBufferUsage.IndexBuffer);
                if (!buffer) {
                    ok = false;
                } else {
                    this.indexBuffers.push(buffer);
                }
                this.index32.push(mesh.isIndexBuffer32Bit(i));
            }

            // LoadMaterial: a material whose ambient and diffuse colors are all zero is white; the
            // specular color only with a positive power.
            const colors: f32[] = [];
            for (let i = 0; i < 17; i++) {
                colors.push(0.0);
            }
            for (let m = 0; m < mesh.getMaterialCount(); m++) {
                mesh.copyMaterialColors(m, Ref(colors[0]));
                let allZero = true;
                for (let i = 0; i < 8; i++) {
                    if (colors[i] != 0.0) {
                        allZero = false;
                    }
                }
                if (allZero) {
                    this.materialColors.push(1.0);
                    this.materialColors.push(1.0);
                    this.materialColors.push(1.0);
                    this.materialColors.push(1.0);
                    this.materialSpecular.push(0.0);
                    this.materialSpecular.push(0.0);
                    this.materialSpecular.push(0.0);
                    this.materialSpecular.push(1.0);
                    for (let i = 0; i < 3; i++) {
                        this.materialEmissive.push(0.0);
                    }
                } else {
                    for (let i = 0; i < 3; i++) {
                        this.materialEmissive.push(colors[12 + i]);
                    }
                    this.materialColors.push(colors[0]);
                    this.materialColors.push(colors[1]);
                    this.materialColors.push(colors[2]);
                    this.materialColors.push(colors[3] != 1.0 && colors[3] != 0.0 ? colors[3] : 1.0);
                    // Donut_CopySdkMeshMaterialColors: diffuse, ambient, specular, emissive, power.
                    const power = colors[16];
                    if (power > 0.0 && (colors[8] != 0.0 || colors[9] != 0.0 || colors[10] != 0.0)) {
                        this.materialSpecular.push(colors[8]);
                        this.materialSpecular.push(colors[9]);
                        this.materialSpecular.push(colors[10]);
                        this.materialSpecular.push(power);
                    } else {
                        // DisableSpecular: black, power 1.
                        this.materialSpecular.push(0.0);
                        this.materialSpecular.push(0.0);
                        this.materialSpecular.push(0.0);
                        this.materialSpecular.push(1.0);
                    }
                }
                const textureName = mesh.getMaterialTexture(m, 0);
                const texture = textureName == "" ? null : device.loadTexture(queue, MEDIA_DIR + textureName, 0);
                if (!texture) {
                    console.log(`${file}: cannot load the material's texture ${textureName}`);
                    ok = false;
                } else {
                    this.materialTextures.push(texture);
                    this.materialViews.push(texture.createView(texture.getFormat()));
                }
                if (dualTexture) {
                    // The SDKMESH material's specular texture (Donut_GetSdkMeshMaterialTexture's 2).
                    const texture2Name = mesh.getMaterialTexture(m, 2);
                    const texture2 = texture2Name == "" ? null : device.loadTexture(queue, MEDIA_DIR + texture2Name, 0);
                    if (!texture2) {
                        console.log(`${file}: cannot load the material's second texture ${texture2Name}`);
                        ok = false;
                    } else {
                        this.materialTextures2.push(texture2);
                        this.materialViews2.push(texture2.createView(texture2.getFormat()));
                    }
                }
            }

            for (let m = 0; m < mesh.getMeshCount(); m++) {
                for (let j = 0; j < mesh.getMeshSubsetCount(m); j++) {
                    const subset = mesh.getMeshSubset(m, j);
                    if (mesh.getSubsetPrimitiveType(subset) != 0) {
                        console.log(`${file}: only triangle lists are supported`);
                        ok = false;
                    }
                    this.partVertexBuffers.push(mesh.getMeshVertexBuffer(m));
                    this.partIndexBuffers.push(mesh.getMeshIndexBuffer(m));
                    this.partMaterials.push(mesh.getSubsetMaterial(subset));
                    this.partIndexCounts.push(mesh.getSubsetIndexCount(subset));
                    this.partStartIndices.push(mesh.getSubsetIndexStart(subset));
                    this.partVertexOffsets.push(mesh.getSubsetVertexStart(subset));
                }
            }

            mesh.destroy();
            binaryFile.destroy();
            return ok;
        }

        // The material's second texture's view: its specular texture (dual texture effect), or its
        // texture again.
        secondView(material: int) {
            return this.materialViews2.length > 0 ? this.materialViews2[material] : this.materialViews[material];
        }

        destroy() {
            for (const buffer of this.vertexBuffers) {
                buffer.destroy();
            }
            for (const buffer of this.indexBuffers) {
                buffer.destroy();
            }
            for (const view of this.materialViews) {
                view.destroy();
            }
            for (const view of this.materialViews2) {
                view.destroy();
            }
            for (const texture of this.materialTextures) {
                texture.destroy();
            }
            for (const texture of this.materialTextures2) {
                texture.destroy();
            }
        }
    }

    // A sprite: its texture, its view and its set (the view, SpriteBatch's sampler).
    class Sprite {
        set: NriDescriptorSet | null = null;

        constructor(public texture: NriTexture, public view: NriDescriptor) {
        }
    }

    // --- The sample ---------------------------------------------------------------------------

    // Port of the Xbox ATG MouseCursor UWP sample (UWPSamples/System/MouseCursor; examples/
    // mouse_cursor.ts ports it to Donut) to NRI: a menu of two game modes, picked with the
    // (absolute) mouse cursor. The first-person shooter mode captures the mouse and turns the camera
    // by its relative motion (move-look) in a room; the real-time strategy mode captures it too and
    // moves a cursor of its own (the sample's clip cursor mode), scrolling the map when it nears the
    // window's edges. Escape, or the window losing the focus, returns to the menu.
    //
    // The sample's Main.cpp handles the UWP window's pointer events; that's onMousePos,
    // onMouseButton and onEscape here, called as the polled mouse and keys change, with GLFW's
    // disabled cursor mode for the captured mouse (raw mouse motion as UWP's MouseMoved). Its Sample
    // class is the rest. The test (as the Donut example's, which gets no input) reads none.
    class MouseCursor {
        private device: NriDevice | null = null;
        private queue: NriQueue;
        private frames: NriFrameRing = new NriFrameRing();
        private swapChain: NriSwapChain = new NriSwapChain();
        private queuedFrames: QueuedFrame[] = [];
        private swapChainFormat: NriFormat = NriFormat.Unknown;

        // Main.cpp's state: the mode, the virtual cursor's on-screen position.
        private absolute: boolean = true;
        private relative: boolean = false;
        private clipCursor: boolean = false;
        private virtualX: number = 0.0;
        private virtualY: number = 0.0;
        // The mouse's last position (in the captured modes, GLFW's virtual position), and whether
        // the next one only resynchronizes it (after the cursor mode changed).
        private mouseX: number = 0.0;
        private mouseY: number = 0.0;
        private resyncMouse: boolean = true;
        // The polled input: the mouse's position, its buttons and Escape last frame.
        private polledX: number = -1.0;
        private polledY: number = -1.0;
        private buttonsDown: boolean[] = [false, false, false];
        private escapeDown: boolean = false;

        // Sample's state.
        isAbsolute: boolean = true;
        isRelative: boolean = false;
        isClipCursor: boolean = false;
        highlightFPS: boolean = false;
        highlightRTS: boolean = false;
        private eyeFPS: number[] = [0.0, 20.0, -20.0];
        private targetFPS: number[] = [0.0, 20.0, 0.0];
        private eyeRTS: number[] = [0.0, 300.0, 0.0];
        private targetRTS: number[] = [0.01, 300.1, 0.01];
        private eye: number[] = [0.0, 20.0, 0.0];
        private target: number[] = [0.01, 20.1, 0.01];
        private pitch: number = 0.0;
        private yaw: number = 0.0;
        private world: number[] = identity();
        private view: number[] = identity();
        private proj: number[] = identity();
        screenX: number = 0.0;
        screenY: number = 0.0;
        // Left, top, right, bottom.
        fpsTile: int[] = [0, 0, 0, 0];
        rtsTile: int[] = [0, 0, 0, 0];
        fontPosTitle: number[] = [0.0, 0.0];
        fontPosSubtitle: number[] = [0.0, 0.0];
        fontPosFPS: number[] = [0.0, 0.0];
        fontPosRTS: number[] = [0.0, 0.0];
        frameWidth: int = 0;
        frameHeight: int = 0;

        private modelFPS: Model = new Model();
        private modelRTS: Model = new Model();
        private background: Sprite | null = null;
        private tile: Sprite | null = null;
        private tileBorder: Sprite | null = null;
        private spriteSampler: NriDescriptor | null = null;
        private linearWrapSampler: NriDescriptor | null = null;
        private spriteLayout: NriPipelineLayout | null = null;
        private modelLayout: NriPipelineLayout | null = null;
        private spritePipeline: NriPipeline | null = null;
        private dualPipeline: NriPipeline | null = null;
        private basicPipeline: NriPipeline | null = null;
        private constantBuffer: NriBuffer | null = null;
        private descriptorPool: NriDescriptorPool | null = null;
        // The depth buffer (D24S8, as the sample's).
        private depth: NriTexture | null = null;
        private depthAttachment: NriDescriptor | null = null;
        private spriteConstants: f32[] = [];
        private parameters: f32[] = [];
        private imgui: boolean = false;
        private titleFont: NriImguiFont | null = null;
        private subtitleFont: NriImguiFont | null = null;
        private tileFont: NriImguiFont | null = null;

        // -test: the last frame is read back into readbackBuffer, rows rowPitch bytes apart.
        private test: boolean = false;
        private readbackBuffer: NriBuffer | null = null;
        private rowPitch: int = 0;

        constructor(private sample: NriSample) {
            for (let i = 0; i < SPRITE_FLOATS; i++) {
                this.spriteConstants.push(0.0);
            }
            for (let i = 0; i < PARAMETERS_FLOATS; i++) {
                this.parameters.push(0.0);
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
            this.sample.setInitializeCallback(initialize);
            this.sample.setLatencySleepCallback(latencySleep);
            this.sample.setRenderFrameCallback(renderFrame);

            // On a wrapper of its own: the callbacks Nri_RunSample runs may overwrite this.sample.
            let result = new NriSample(this.sample.handle).run(argc, argv, WINDOW_TITLE, TEST_FRAMES);
            if (result == 0 && this.test) {
                const failure = checkFrame(this.readBack(), this.frameWidth, this.frameHeight);
                console.log(failure == "" ? "Test PASSED" : `Test FAILED: ${failure}`);
                result = failure == "" ? 0 : 1;
            }
            this.destroy();
            return result;
        }

        initialize(graphicsAPI: NriGraphicsAPI): int {
            const device = this.sample.createDevice(graphicsAPI);
            if (!device) {
                console.log("Cannot initialize a graphics device with the requested parameters");
                return 0;
            }
            this.device = device;
            console.log(`Renderer: ${Nri.getGraphicsAPIString(graphicsAPI)} (${device.getAdapterName()})`);

            this.queue = device.getGraphicsQueue();
            this.test = this.sample.isTest() != 0;

            // Swap chain: rendered through UNORM views, as the sample's B8G8R8A8_UNORM back buffers.
            const queuedFrameNum = this.sample.getQueuedFrameNum();
            this.swapChain.init(this.sample, device, this.queue, false);
            this.sizeToSwapChain();
            const width = this.frameWidth;
            const height = this.frameHeight;
            this.frames.init(device, this.queue, queuedFrameNum);
            for (let i = 0; i < queuedFrameNum; i++) {
                this.queuedFrames.push(new QueuedFrame(new NriCommandBuffer(this.frames.commandBuffer(i).handle)));
            }

            // Model::Draw's LinearWrap (Donut's: trilinear, wrapped); SpriteBatch's LinearClamp (the
            // images' one level).
            const linearWrapSampler = device.createSampler(NriFilter.Linear, NriAddressMode.Repeat, 1);
            const spriteSampler = device.createSampler(NriFilter.Linear, NriAddressMode.ClampToEdge, 1);
            this.linearWrapSampler = linearWrapSampler;
            this.spriteSampler = spriteSampler;
            if (!linearWrapSampler || !spriteSampler) {
                console.log("Cannot create the samplers");
                return 0;
            }

            let ok = this.modelFPS.load(device, this.queue, "FPSRoom.sdkmesh", 64, true);
            // Note that this model uses 32-bit index buffers so it can't be used w/ Feature Level 9.1
            ok = this.modelRTS.load(device, this.queue, "3DRTSMap.sdkmesh", 56, false) && ok;
            this.background = this.loadSprite(device, "background_flat.png");
            this.tile = this.loadSprite(device, "green_tile.png");
            this.tileBorder = this.loadSprite(device, "green_tile_border.png");
            const background = this.background;
            const tile = this.tile;
            const tileBorder = this.tileBorder;
            if (!ok || !background || !tile || !tileBorder) {
                return 0;
            }

            // The depth buffer, for the window's size (made again when it changes).
            if (!this.createDepth(device)) {
                console.log("Cannot create the depth buffer");
                return 0;
            }

            // The sprites' layout: SpriteConstants (push constants, b0), the texture (t0), the sampler
            // (s0). The models': the parameters (b0), the textures (t0, t1), the sampler (s0).
            const spriteLayoutDesc = NriPipelineLayoutDesc.create();
            spriteLayoutDesc.addRange(0, 0, 1, NriDescriptorType.Texture, NriStage.VertexPixel, NriRangeFlags.None);
            spriteLayoutDesc.addRange(0, 0, 1, NriDescriptorType.Sampler, NriStage.VertexPixel, NriRangeFlags.None);
            spriteLayoutDesc.addRootConstants(0, SPRITE_FLOATS * 4, NriStage.VertexPixel);
            this.spriteLayout = device.createPipelineLayoutFromDesc(spriteLayoutDesc);
            spriteLayoutDesc.destroy();
            const modelLayoutDesc = NriPipelineLayoutDesc.create();
            modelLayoutDesc.addRange(0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.VertexPixel, NriRangeFlags.None);
            modelLayoutDesc.addRange(0, 0, 2, NriDescriptorType.Texture, NriStage.VertexPixel, NriRangeFlags.None);
            modelLayoutDesc.addRange(0, 0, 1, NriDescriptorType.Sampler, NriStage.VertexPixel, NriRangeFlags.None);
            this.modelLayout = device.createPipelineLayoutFromDesc(modelLayoutDesc);
            modelLayoutDesc.destroy();
            const spriteLayout = this.spriteLayout;
            const modelLayout = this.modelLayout;
            if (!spriteLayout || !modelLayout) {
                console.log("Cannot create the pipeline layouts");
                return 0;
            }

            // mouse_cursor.hlsl's shaders, as compiled for the Donut example.
            const folder = graphicsAPI == NriGraphicsAPI.D3D11 ? "dxbc" : (graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv");
            const shaders = `shaders/mouse_cursor/${folder}/mouse_cursor`;
            this.createPipelines(device, spriteLayout, modelLayout, shaders);
            if (!this.spritePipeline || !this.dualPipeline || !this.basicPipeline) {
                console.log("Cannot load the mouse cursor shaders");
                return 0;
            }

            // The parameters, a slice per material of each model a queued frame; per queued frame a
            // set per material, and the sprites' sets.
            const materialNum = this.modelFPS.materialViews.length + this.modelRTS.materialViews.length;
            const constantBuffer = device.createHostBuffer(queuedFrameNum * materialNum * PARAMETERS_SLICE_SIZE,
                NriBufferUsage.ConstantBuffer);
            this.constantBuffer = constantBuffer;
            const descriptorPool = device.createDescriptorPool(3 + queuedFrameNum * materialNum, 3 + queuedFrameNum * materialNum,
                queuedFrameNum * materialNum, 3 + 2 * queuedFrameNum * materialNum, 0, 0);
            this.descriptorPool = descriptorPool;
            if (!constantBuffer || !descriptorPool) {
                console.log("Cannot create the constant buffer");
                return 0;
            }
            for (let q = 0; q < queuedFrameNum; q++) {
                const queuedFrame = this.queuedFrames[q];
                for (let m = 0; m < materialNum; m++) {
                    const fps = m < this.modelFPS.materialViews.length;
                    const model = fps ? this.modelFPS : this.modelRTS;
                    const material = fps ? m : m - this.modelFPS.materialViews.length;
                    const view = constantBuffer.createConstantView((q * materialNum + m) * PARAMETERS_SLICE_SIZE, PARAMETERS_SLICE_SIZE);
                    const set = descriptorPool.allocateDescriptorSet(modelLayout, 0, 0);
                    if (!view || !set) {
                        console.log("Cannot create the descriptor sets");
                        return 0;
                    }
                    queuedFrame.materialViews.push(view);
                    queuedFrame.materialSets.push(set);
                    // The parameters, its texture(s) (the first again where there's no second),
                    // Model::Draw's LinearWrap sampler.
                    set.updateDescriptor(0, 0, view);
                    set.updateDescriptor(1, 0, model.materialViews[material]);
                    set.updateDescriptor(1, 1, model.secondView(material));
                    set.updateDescriptor(2, 0, linearWrapSampler);
                }
            }
            for (const sprite of [background, tile, tileBorder]) {
                const set = descriptorPool.allocateDescriptorSet(spriteLayout, 0, 0);
                if (!set) {
                    console.log("Cannot create the descriptor sets");
                    return 0;
                }
                set.updateDescriptor(0, 0, sprite.view);
                set.updateDescriptor(1, 0, spriteSampler);
                sprite.set = set;
            }

            // The sample's text, in its three fonts.
            if (this.sample.initImgui(device) == 0) {
                console.log("Cannot initialize the user interface");
                return 0;
            }
            this.imgui = true;
            this.titleFont = NriImgui.createFont(FONT_PATH, TITLE_FONT_SIZE);
            this.subtitleFont = NriImgui.createFont(FONT_PATH, SUBTITLE_FONT_SIZE);
            this.tileFont = NriImgui.createFont(FONT_PATH, TILE_FONT_SIZE);
            if (!this.titleFont || !this.subtitleFont || !this.tileFont) {
                console.log("Cannot load the font: set DONUT_SAMPLES_MEDIA_DIR when configuring");
                return 0;
            }

            // Main.cpp's OnWindowSizeChanged and the sample's CreateWindowSizeDependentResources (again
            // on a resize: resizeIfNeeded).
            this.layout(width, height);

            if (this.test) {
                const alignment = device.getUploadBufferTextureRowAlignment();
                this.rowPitch = Math.floor((width * 4 + alignment - 1) / alignment) * alignment;
                this.readbackBuffer = device.createReadbackBuffer(this.rowPitch * height);
            }
            return 1;
        }

        // A sprite texture (CreateWICTextureFromFile: as stored, UNORM) and its view; null on failure.
        loadSprite(device: NriDevice, file: string): Sprite | null {
            const texture = device.loadImageTexture(this.queue, MEDIA_DIR + file, 0);
            if (!texture) {
                console.log(`Cannot load ${file}: set XBOX_ATG_SAMPLES_DIR when configuring`);
                return null;
            }
            return new Sprite(texture, texture.createView(NriFormat.RGBA8_UNORM));
        }

        createPipelines(device: NriDevice, spriteLayout: NriPipelineLayout, modelLayout: NriPipelineLayout, shaders: string) {
            const format = this.swapChainFormat;

            // SpriteBatch: premultiplied alpha blending (CommonStates::AlphaBlend), no depth, no culling.
            const spriteDesc = NriPipelineDesc.create();
            let loaded = spriteDesc.addShader(NriShaderStage.Vertex, `${shaders}_sprite_vs.bin`, "sprite_vs") != 0;
            if (loaded) {
                loaded = spriteDesc.addShader(NriShaderStage.Pixel, `${shaders}_sprite_ps.bin`, "sprite_ps") != 0;
            }
            spriteDesc.setDepthClip(0);
            spriteDesc.setColor(format, NriColorWrite.RGBA);
            spriteDesc.setBlend(NriBlendFactor.One, NriBlendFactor.OneMinusSrcAlpha, NriBlendOp.Add, NriBlendFactor.One,
                NriBlendFactor.OneMinusSrcAlpha, NriBlendOp.Add);
            // (Drawn into the color and depth attachments: the depth unused.)
            spriteDesc.setDepth(NriFormat.D24_UNORM_S8_UINT, NriCompareOp.None, 0, 0);
            if (loaded) {
                this.spritePipeline = device.createPipelineFromDesc(spriteLayout, spriteDesc);
            }
            spriteDesc.destroy();

            this.dualPipeline = this.createModelPipeline(device, modelLayout, shaders, "dual_texture", true);
            this.basicPipeline = this.createModelPipeline(device, modelLayout, shaders, "basic", false);
        }

        // Model::Draw's opaque parts: no blending, DepthDefault (less or equal), clockwise front
        // faces with the back ones culled (ModelLoader_CounterClockwise -> CullCounterClockwise),
        // depth clip on. The FPS room's vertices: position, normal, two texture coordinates, tangent,
        // binormal (64 bytes); the RTS map's position, normal, texture coordinates, tangent, binormal
        // (56 bytes).
        createModelPipeline(device: NriDevice, layout: NriPipelineLayout, shaders: string, name: string, dualTexture: boolean) {
            const desc = NriPipelineDesc.create();
            let loaded = desc.addShader(NriShaderStage.Vertex, `${shaders}_${name}_vs.bin`, `${name}_vs`) != 0;
            if (loaded) {
                loaded = desc.addShader(NriShaderStage.Pixel, `${shaders}_${name}_ps.bin`, `${name}_ps`) != 0;
            }
            desc.addVertexAttribute("POSITION", NriFormat.RGB32_SFLOAT, 0);
            if (dualTexture) {
                desc.addVertexAttribute("TEXCOORD", NriFormat.RG32_SFLOAT, 24);
                desc.addVertexAttribute("LIGHTMAPCOORD", NriFormat.RG32_SFLOAT, 32);
            } else {
                desc.addVertexAttribute("NORMAL", NriFormat.RGB32_SFLOAT, 12);
                desc.addVertexAttribute("TEXCOORD", NriFormat.RG32_SFLOAT, 24);
            }
            desc.setCullMode(NriCullMode.Back);
            desc.setDepthClip(1);
            desc.setColor(this.swapChainFormat, NriColorWrite.RGBA);
            desc.setDepth(NriFormat.D24_UNORM_S8_UINT, NriCompareOp.LessEqual, 1, 0);
            let pipeline: NriPipeline | null = null;
            if (loaded) {
                pipeline = device.createPipelineFromDesc(layout, desc);
            }
            desc.destroy();
            return pipeline;
        }

        // --- Sample: mouse cursor camera and target updates -------------------------------------

        // Update the pointer location in clip cursor mode
        updatePointer(x: number, y: number) {
            this.screenX = x;
            this.screenY = y;
        }

        // Change the target value based on the mouse movement for move-look/relative mouse mode
        updateCamera(dx: number, dy: number) {
            // Adjust pitch and yaw based on the mouse movement
            this.pitch = f(this.pitch + f(dy * ROTATION_GAIN));
            this.yaw = f(this.yaw + f(dx * ROTATION_GAIN));

            // Limit to avoid looking directly up or down
            const limit = f(PI / 2.0 - 0.01);
            // (Explicit: tslang's Math.max gets negative numbers wrong.)
            if (this.pitch < -limit) {
                this.pitch = -limit;
            }
            if (this.pitch > limit) {
                this.pitch = limit;
            }

            if (this.yaw > PI) {
                this.yaw = f(this.yaw - PI * 2.0);
            } else if (this.yaw < -PI) {
                this.yaw = f(this.yaw + PI * 2.0);
            }

            const y = f(Math.sin(this.pitch));
            const r = f(Math.cos(this.pitch));
            const z = f(r * f(Math.cos(this.yaw)));
            const x = f(r * f(Math.sin(this.yaw)));

            this.target = [f(this.eye[0] + x), f(this.eye[1] + y), f(this.eye[2] + z)];

            this.setView();
        }

        // Move the camera forward or backward
        moveForward(amount: number) {
            const movement = [f(this.target[0] - this.eye[0]), 0.0, f(this.target[2] - this.eye[2])];
            const eyeTemp = [f(this.eye[0] - f(amount * movement[0])), this.eye[1], f(this.eye[2] - f(amount * movement[2]))];
            if (inBounds(eyeTemp)) {
                this.eye = eyeTemp;
                this.target = [f(this.target[0] - f(amount * movement[0])), this.target[1], f(this.target[2] - f(amount * movement[2]))];
                this.setView();
            }
        }

        // Move the camera to the right or left
        moveRight(amount: number) {
            const movement = [-f(this.target[2] - this.eye[2]), 0.0, f(this.target[0] - this.eye[0])];
            const eyeTemp = [f(this.eye[0] + f(amount * movement[0])), this.eye[1], f(this.eye[2] + f(amount * movement[2]))];
            if (inBounds(eyeTemp)) {
                this.eye = eyeTemp;
                this.target = [f(this.target[0] + f(amount * movement[0])), this.target[1], f(this.target[2] + f(amount * movement[2]))];
                this.setView();
            }
        }

        // Update the viewport based on the updated eye and target values
        setView() {
            this.view = lookAtRH(this.eye, this.target, [0.0, 1.0, 0.0]);
            this.proj = perspectiveFovLH(f(PI / 4.0), f(f(this.frameWidth) / f(this.frameHeight)), 0.1, 10000.0);
        }

        // Set mode to relative ( 1 ), absolute ( 0 ), or clip cursor ( 2 )
        setMode(x: number, y: number) {
            // If entering FPS or relative mode
            if (inTile(this.fpsTile, x, y)) {
                this.screenX = this.frameWidth / 2.0;
                this.screenY = this.frameHeight / 2.0;

                this.isRelative = true;
                this.isAbsolute = false;
                this.isClipCursor = false;
                this.highlightFPS = false;
                this.highlightRTS = false;
                this.world = multiplyF32(rotationX(f(PI / 2.0)), rotationY(PI));
                this.eye = [this.eyeFPS[0], this.eyeFPS[1], this.eyeFPS[2]];
                this.target = [this.targetFPS[0], this.targetFPS[1], this.targetFPS[2]];
                this.updateCamera(0.0, 0.0);
                this.setView();
                return RELATIVE_MOUSE;
            }
            // If entering RTS or clipCursor mode
            if (inTile(this.rtsTile, x, y)) {
                this.isRelative = false;
                this.isAbsolute = false;
                this.isClipCursor = true;
                this.highlightFPS = false;
                this.highlightRTS = false;
                this.world = multiplyF32(rotationX(f(PI / 2.0)), rotationY(f(5.0 * PI / 4.0)));
                this.eye = [this.eyeRTS[0], this.eyeRTS[1], this.eyeRTS[2]];
                this.target = [this.targetRTS[0], this.targetRTS[1], this.targetRTS[2]];
                this.setView();
                return CLIPCURSOR_MOUSE;
            }
            // Entering absolute mode
            if (this.isClipCursor) {
                this.eyeRTS = [this.eye[0], this.eye[1], this.eye[2]];
                this.targetRTS = [this.target[0], this.target[1], this.target[2]];
            }
            this.isRelative = false;
            this.isAbsolute = true;
            this.isClipCursor = false;
            return ABSOLUTE_MOUSE;
        }

        // When the mouse moves, check to see if it is on top of the FPS or RTS selection tiles
        checkLocation(x: number, y: number) {
            if (this.isAbsolute) {
                // If hovering over FPS or relative selection
                if (inTile(this.fpsTile, x, y)) {
                    this.highlightFPS = true;
                    this.highlightRTS = false;
                } else if (inTile(this.rtsTile, x, y)) {
                    // If hovering over RTS or clipCursor selection
                    this.highlightRTS = true;
                    this.highlightFPS = false;
                } else {
                    this.highlightFPS = false;
                    this.highlightRTS = false;
                }
            }
        }

        // Sample::CreateWindowSizeDependentResources: the menu's layout.
        layout(width: int, height: int) {
            // Update pointer location
            if (this.isRelative) {
                this.screenX = width / 2.0;
                this.screenY = height / 2.0;
            }

            // Initialize UI tiles and font locations (LONG casts truncate)
            const fps = this.fpsTile;
            fps[0] = Math.trunc(f(0.325 * width));
            fps[1] = Math.trunc(f(0.44 * height));
            fps[2] = Math.trunc(f(0.495 * width));
            fps[3] = Math.trunc(f(0.66 * height));
            fps[3] = Math.max(fps[3], fps[1] + 150);
            fps[0] = Math.min(fps[0], Math.trunc(fps[2] - (fps[3] - fps[1]) * 4 / 3.0));

            const rts = this.rtsTile;
            rts[0] = Math.trunc(f(0.505 * width));
            rts[1] = fps[1];
            rts[2] = Math.trunc(f(0.675 * width));
            rts[3] = fps[3];
            rts[2] = Math.max(rts[2], Math.trunc(rts[0] + (rts[3] - rts[1]) * 4 / 3.0));

            this.fontPosTitle = [width / 2.0, f(height * 0.27)];
            this.fontPosSubtitle = [width / 2.0, f(height * 0.36)];
            this.fontPosFPS = [fps[0] + (fps[2] - fps[0]) / 2.0, fps[1] + (fps[3] - fps[1]) / 2.0];
            this.fontPosRTS = [rts[0] + (rts[2] - rts[0]) / 2.0, this.fontPosFPS[1]];
        }

        // --- Main.cpp: the window's pointer and keyboard events --------------------------------

        // The mouse is captured and hidden: the sample draws its own cursor.
        capture(x: number, y: number) {
            this.sample.setCursorDisabled(1);
            this.resyncMouse = true;
            // Save the pointers position
            this.virtualX = clampTo(x, this.frameWidth);
            this.virtualY = clampTo(y, this.frameHeight);
        }

        // Back to the menu: the system cursor returns where the sample's was.
        release() {
            this.sample.setCursorDisabled(0);
            this.resyncMouse = true;
            this.sample.setCursorPosition(Math.trunc(this.virtualX), Math.trunc(this.virtualY));
            this.clipCursor = false;
            this.relative = false;
            this.absolute = true;
            this.setMode(0.0, 0.0);
        }

        // OnPointerMoved in absolute mode (hover), OnMouseMoved in the captured ones.
        onMousePos(x: number, y: number) {
            const dx = x - this.mouseX;
            const dy = y - this.mouseY;
            const resync = this.resyncMouse;
            this.mouseX = x;
            this.mouseY = y;
            this.resyncMouse = false;
            if (this.absolute) {
                this.checkLocation(x, y);
            } else if (resync) {
                return;
            } else if (this.clipCursor) {
                this.virtualX = clampTo(this.virtualX + dx, this.frameWidth);
                this.virtualY = clampTo(this.virtualY + dy, this.frameHeight);
                this.updatePointer(this.virtualX, this.virtualY);
            } else if (this.relative) {
                this.updateCamera(dx, dy);
            }
        }

        // OnPointerPressed: in absolute mode, a tile clicked enters its mode.
        onMouseButton() {
            if (this.absolute) {
                const mode = this.setMode(this.mouseX, this.mouseY);
                if (mode == RELATIVE_MOUSE) {
                    this.absolute = false;
                    this.relative = true;
                    this.capture(this.mouseX, this.mouseY);
                } else if (mode == CLIPCURSOR_MOUSE) {
                    this.absolute = false;
                    this.clipCursor = true;
                    this.capture(this.mouseX, this.mouseY);
                }
            }
        }

        // OnKeyDown: Escape leaves the captured modes.
        onEscape() {
            if (!this.absolute) {
                this.release();
            }
        }

        // The polled mouse and keys, as the events Main.cpp gets: the cursor moved, a button
        // pressed, Escape pressed.
        pollInput() {
            const x = this.sample.getMouseX();
            const y = this.sample.getMouseY();
            if (x != this.polledX || y != this.polledY) {
                this.polledX = x;
                this.polledY = y;
                this.onMousePos(x, y);
            }
            let pressed = false;
            for (let button = 0; button < 3; button++) {
                const down = this.sample.isButtonPressed(button) != 0;
                if (down && !this.buttonsDown[button]) {
                    pressed = true;
                }
                this.buttonsDown[button] = down;
            }
            if (pressed) {
                this.onMouseButton();
            }
            const escape = this.sample.isKeyPressed(Key.Escape) != 0;
            if (escape && !this.escapeDown) {
                this.onEscape();
            }
            this.escapeDown = escape;
        }

        // Sample::Update: in clip cursor mode, scrolling when the cursor nears the window's edges
        // (each frame, as the sample).
        update() {
            // In clip cursor mode implement screen scrolling when the mouse is near the edge of the screen
            if (this.isClipCursor) {
                if (this.screenX < 20.0) {
                    this.moveRight(-25.0);
                } else if (this.screenX > this.frameWidth - 20.0) {
                    this.moveRight(25.0);
                }
                if (this.screenY < 20.0) {
                    this.moveForward(25.0);
                } else if (this.screenY > this.frameHeight - 20.0) {
                    this.moveForward(-25.0);
                }
            }
        }

        // --- Rendering ----------------------------------------------------------------------------

        // The swap chain's size and formats (its views in the textures' format).
        sizeToSwapChain() {
            this.frameWidth = this.swapChain.width();
            this.frameHeight = this.swapChain.height();
            this.swapChainFormat = this.swapChain.format();
        }

        // The depth buffer at the swap chain's size; false if it can't be made.
        createDepth(device: NriDevice): boolean {
            const depth = device.createDepthTexture(this.queue, this.frameWidth, this.frameHeight, NriFormat.D24_UNORM_S8_UINT);
            this.depth = depth;
            if (!depth) {
                return false;
            }
            this.depthAttachment = depth.createDepthAttachmentView(NriFormat.D24_UNORM_S8_UINT);
            return true;
        }

        destroyDepth() {
            this.destroyDescriptor(this.depthAttachment);
            this.depthAttachment = null;
            const depth = this.depth;
            if (depth) {
                depth.destroy();
            }
            this.depth = null;
        }

        // The window was resized (NriSample.useResizableWindow): the swap chain and depth buffer made again at
        // its size, once the GPU is done with the old ones, and Main.cpp's OnWindowSizeChanged (the
        // menu's layout, the projection's aspect ratio).
        resizeIfNeeded() {
            const device = this.device;
            if (!device) {
                return;
            }
            if (!this.swapChain.resized()) {
                return;
            }
            device.waitIdle();
            this.destroyDepth();
            this.swapChain.recreate();
            this.sizeToSwapChain();
            this.createDepth(device);
            this.layout(this.frameWidth, this.frameHeight);
            this.setView();
        }

        // Waits for the frame that last used this frame's command allocator (and its constants).
        // OnPointerCaptureLost: the captured modes end when the window loses the focus (checked
        // here: NRIFramework calls this while the unfocused window waits, not renderFrame).
        latencySleep(frameIndex: int) {
            this.frames.wait(frameIndex);
            if (!this.test && !this.absolute && this.sample.isWindowFocused() == 0) {
                this.release();
            }
        }

        // The sample's SpriteFont text (centered on its positions, white): the menu's title, subtitle
        // and tile labels; the cursor ("+" in Courier_36) in the captured modes, drawn here as the
        // glyph's two antialiased strokes (a 1 pixel line with third-covered sides, offset from the
        // position as the glyph is).
        //
        // SpriteFont::DrawString with its origin at MeasureString / 2: the lines' block centered
        // on (x, y), each line placed in its sprite font line.
        centered(x: number, y: number, lines: string[], fontSize: number, lineSpacing: number) {
            let width = 0.0;
            for (const line of lines) {
                width = Math.max(width, NriImgui.calcTextWidth(line));
            }
            const left = x - width / 2.0;
            const top = y - lines.length * lineSpacing / 2.0 + (lineSpacing - fontSize) / 2.0;
            for (let i = 0; i < lines.length; i++) {
                NriImgui.drawText(left, top + i * lineSpacing, lines[i], 1.0, 1.0, 1.0, 1.0, 0);
            }
        }

        cursor(x: number, y: number) {
            const cx = Math.floor(x) + 4.0;
            const cy = Math.floor(y) - 1.0;
            const side = 0.333;
            NriImgui.drawRect(cx, cy - 11.0, cx + 1.0, cy + 12.0, 1.0, 1.0, 1.0, 1.0);
            NriImgui.drawRect(cx - 1.0, cy - 11.0, cx, cy + 12.0, 1.0, 1.0, 1.0, side);
            NriImgui.drawRect(cx + 1.0, cy - 11.0, cx + 2.0, cy + 12.0, 1.0, 1.0, 1.0, side);
            NriImgui.drawRect(cx - 10.0, cy, cx, cy + 1.0, 1.0, 1.0, 1.0, 1.0);
            NriImgui.drawRect(cx + 1.0, cy, cx + 11.0, cy + 1.0, 1.0, 1.0, 1.0, 1.0);
            NriImgui.drawRect(cx - 10.0, cy - 1.0, cx - 1.0, cy, 1.0, 1.0, 1.0, side);
            NriImgui.drawRect(cx + 2.0, cy - 1.0, cx + 11.0, cy, 1.0, 1.0, 1.0, side);
            NriImgui.drawRect(cx - 10.0, cy + 1.0, cx - 1.0, cy + 2.0, 1.0, 1.0, 1.0, side);
            NriImgui.drawRect(cx + 2.0, cy + 1.0, cx + 11.0, cy + 2.0, 1.0, 1.0, 1.0, side);
        }

        buildUI() {
            this.sample.imguiNewFrame();
            const titleFont = this.titleFont;
            const subtitleFont = this.subtitleFont;
            const tileFont = this.tileFont;
            if (!titleFont || !subtitleFont || !tileFont) {
                this.sample.imguiRender();
                return;
            }
            if (this.isAbsolute) {
                titleFont.pushFont();
                this.centered(this.fontPosTitle[0], this.fontPosTitle[1], ["Mouse Cursor Sample: 0"], TITLE_FONT_SIZE, TITLE_LINE_SPACING);
                NriImgui.popFont();
                subtitleFont.pushFont();
                this.centered(this.fontPosSubtitle[0], this.fontPosSubtitle[1], ["Choose a game mode"], SUBTITLE_FONT_SIZE,
                    SUBTITLE_LINE_SPACING);
                NriImgui.popFont();
                tileFont.pushFont();
                this.centered(this.fontPosFPS[0], this.fontPosFPS[1], ["First-person ", "   Shooter"], TILE_FONT_SIZE, TILE_LINE_SPACING);
                this.centered(this.fontPosRTS[0], this.fontPosRTS[1], ["Real-time ", " Strategy"], TILE_FONT_SIZE, TILE_LINE_SPACING);
                NriImgui.popFont();
            } else {
                this.cursor(this.screenX, this.screenY);
            }
            this.sample.imguiRender();
        }

        renderFrame(frameIndex: int) {
            this.resizeIfNeeded();
            const queuedFrameIndex = frameIndex % this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            if (!this.test) {
                this.pollInput();
            }
            this.update();
            if (this.imgui) {
                this.buildUI();
            }

            // Acquire a swap chain texture
            const index = this.swapChain.acquire(frameIndex);
            if (index >= 0) {
                this.recordAndPresent(frameIndex, queuedFrame, queuedFrameIndex, index);
            }

            // Signaled after the present, as NRISamples do
            this.frames.signal(frameIndex);
        }

        // SpriteBatch::Draw(texture, destinationRectangle), white (between NriCommandBuffer.beginRendering* and
        // NriCommandBuffer.endRendering, the sprite pipeline set).
        drawSprite(commandBuffer: NriCommandBuffer, sprite: Sprite | null, left: number, top: number, right: number, bottom: number) {
            if (!sprite) {
                return;
            }
            const set = sprite.set;
            if (!set) {
                return;
            }
            const c = this.spriteConstants;
            c[0] = left;
            c[1] = top;
            c[2] = right;
            c[3] = bottom;
            c[4] = this.frameWidth;
            c[5] = this.frameHeight;
            c[8] = 1.0;
            c[9] = 1.0;
            c[10] = 1.0;
            c[11] = 1.0;
            commandBuffer.setDescriptorSet(0, set);
            commandBuffer.setRootConstants(0, Ref(c[0]), SPRITE_FLOATS * 4);
            commandBuffer.draw(6, 1, 0, 0);
        }

        // Model::Draw(context, states, world, view, proj): each part with its material's effect
        // (Model::UpdateEffectMatrices, EffectLights::SetConstants: ambient folded into emissive,
        // diffuse premultiplied by alpha), the materials' parameters written into this queued
        // frame's slices first (firstMaterial: the model's first in the queued frame's sets).
        drawModel(commandBuffer: NriCommandBuffer, queuedFrame: QueuedFrame, queuedFrameIndex: int, model: Model, firstMaterial: int,
            pipeline: NriPipeline | null) {
            const constantBuffer = this.constantBuffer;
            const modelLayout = this.modelLayout;
            if (!constantBuffer || !modelLayout || !pipeline) {
                return;
            }
            const p = this.parameters;
            const viewInverse = inverse(this.view);
            const worldInverseTranspose = transpose(inverse(this.world));
            const worldViewProj = multiplyF32(multiplyF32(this.world, this.view), this.proj);
            for (let i = 0; i < 16; i++) {
                p[PARAMETERS_WORLD + i] = this.world[i];
                p[PARAMETERS_WORLD_INVERSE_TRANSPOSE + i] = worldInverseTranspose[i];
                p[PARAMETERS_WORLD_VIEW_PROJ + i] = worldViewProj[i];
            }
            for (let i = 0; i < 3; i++) {
                p[PARAMETERS_EYE + i] = viewInverse[12 + i];
            }
            for (let light = 0; light < 3; light++) {
                for (let i = 0; i < 3; i++) {
                    p[PARAMETERS_LIGHTS + light * 4 + i] = DEFAULT_DIRECTIONS[light * 3 + i];
                    p[PARAMETERS_LIGHTS + 12 + light * 4 + i] = DEFAULT_DIFFUSE[light * 3 + i];
                    p[PARAMETERS_LIGHTS + 24 + light * 4 + i] = DEFAULT_SPECULAR[light * 3 + i];
                }
            }
            const materialNum = queuedFrame.materialSets.length;
            for (let material = 0; material < model.materialViews.length; material++) {
                const alpha = model.materialColors[material * 4 + 3];
                for (let i = 0; i < 3; i++) {
                    const diffuse = model.materialColors[material * 4 + i];
                    p[i] = f(diffuse * alpha);
                    p[PARAMETERS_EMISSIVE + i] = f((model.materialEmissive[material * 3 + i] + DEFAULT_AMBIENT[i] * diffuse) * alpha);
                    p[PARAMETERS_SPECULAR + i] = model.materialSpecular[material * 4 + i];
                }
                p[3] = alpha;
                p[PARAMETERS_SPECULAR + 3] = model.materialSpecular[material * 4 + 3];
                constantBuffer.write((queuedFrameIndex * materialNum + firstMaterial + material) * PARAMETERS_SLICE_SIZE, Ref(p[0]),
                    PARAMETERS_FLOATS * 4);
            }

            commandBuffer.setPipelineLayout(modelLayout);
            commandBuffer.setPipeline(pipeline);
            for (let part = 0; part < model.partMaterials.length; part++) {
                commandBuffer.setDescriptorSet(0, queuedFrame.materialSets[firstMaterial + model.partMaterials[part]]);
                const ib = model.partIndexBuffers[part];
                commandBuffer.setIndexBuffer(model.indexBuffers[ib], 0, model.index32[ib] ? NriIndexType.UInt32 : NriIndexType.UInt16);
                commandBuffer.setVertexBuffer(0, model.vertexBuffers[model.partVertexBuffers[part]], 0, model.stride);
                commandBuffer.drawIndexed(model.partIndexCounts[part], 1, model.partStartIndices[part], model.partVertexOffsets[part], 0);
            }
        }

        // Sample::Render: Sample::Clear, the menu's sprites (its text and the cursor are the UI's), or
        // the mode's model; the text and cursor over them.
        recordAndPresent(frameIndex: int, queuedFrame: QueuedFrame, queuedFrameIndex: int, index: int) {
            const descriptorPool = this.descriptorPool;
            const depthAttachment = this.depthAttachment;
            const spriteLayout = this.spriteLayout;
            const spritePipeline = this.spritePipeline;
            if (!descriptorPool || !depthAttachment || !spriteLayout || !spritePipeline) {
                return;
            }
            const width = this.frameWidth;
            const height = this.frameHeight;
            const commandBuffer = queuedFrame.commandBuffer;

            commandBuffer.begin();
            if (this.imgui) {
                this.sample.copyImguiData(commandBuffer);
            }
            commandBuffer.setDescriptorPool(descriptorPool);
            commandBuffer.textureBarrier(this.swapChain.texture(index), NriTextureState.Undefined, NriTextureState.ColorAttachment);
            commandBuffer.beginRenderingWithDepth(this.swapChain.colorAttachment(index), depthAttachment);
            commandBuffer.clearColor(CORNFLOWER_BLUE[0], CORNFLOWER_BLUE[1], CORNFLOWER_BLUE[2], 1.0);
            commandBuffer.clearDepth(1.0);
            commandBuffer.setViewport(0.0, 0.0, width, height);
            commandBuffer.setScissor(0, 0, width, height);

            if (this.isAbsolute) {
                commandBuffer.setPipelineLayout(spriteLayout);
                commandBuffer.setPipeline(spritePipeline);
                this.drawSprite(commandBuffer, this.background, 0.0, 0.0, width, height);
                const fps = this.fpsTile;
                const rts = this.rtsTile;
                this.drawSprite(commandBuffer, this.tile, fps[0], fps[1], fps[2], fps[3]);
                this.drawSprite(commandBuffer, this.tile, rts[0], rts[1], rts[2], rts[3]);
                if (this.highlightFPS) {
                    this.drawSprite(commandBuffer, this.tileBorder, fps[0], fps[1], fps[2], fps[3]);
                } else if (this.highlightRTS) {
                    this.drawSprite(commandBuffer, this.tileBorder, rts[0], rts[1], rts[2], rts[3]);
                }
            } else if (this.isRelative) {
                this.drawModel(commandBuffer, queuedFrame, queuedFrameIndex, this.modelFPS, 0, this.dualPipeline);
            } else if (this.isClipCursor) {
                this.drawModel(commandBuffer, queuedFrame, queuedFrameIndex, this.modelRTS, this.modelFPS.materialViews.length,
                    this.basicPipeline);
            }
            commandBuffer.endRendering();
            // The text in a pass of its own: NRIFramework's ImGui pipeline has no depth attachment.
            if (this.imgui) {
                commandBuffer.beginRendering(this.swapChain.colorAttachment(index));
                this.sample.drawImguiUnconverted(commandBuffer, this.swapChainFormat);
                commandBuffer.endRendering();
            }

            // The test's last frame: read back
            let presentFrom = NriTextureState.ColorAttachment;
            const readbackBuffer = this.readbackBuffer;
            if (readbackBuffer) {
                if (frameIndex == TEST_FRAMES - 1) {
                    commandBuffer.textureBarrier(this.swapChain.texture(index), NriTextureState.ColorAttachment, NriTextureState.CopySource);
                    commandBuffer.readbackTextureToBuffer(readbackBuffer, this.rowPitch, this.swapChain.texture(index), width, height);
                    presentFrom = NriTextureState.CopySource;
                }
            }
            commandBuffer.textureBarrier(this.swapChain.texture(index), presentFrom, NriTextureState.Present);
            commandBuffer.end();

            // Submit and present
            this.swapChain.submit(commandBuffer, index);
            if (this.imgui) {
                this.sample.imguiEndFrame();
            }
            this.swapChain.present(index);
        }

        // The last frame's pixels (0xAABBGGRR), empty if it can't be read.
        readBack(): int[] {
            const device = this.device;
            const readbackBuffer = this.readbackBuffer;
            if (!device || !readbackBuffer) {
                return [];
            }
            device.waitIdle();
            const pixels: int[] = [];
            for (let i = 0; i < this.frameWidth * this.frameHeight; i++) {
                pixels.push(0);
            }
            if (readbackBuffer.readRGBA8(this.rowPitch, this.frameWidth, this.frameHeight, this.swapChainFormat,
                Ref(pixels[0]), pixels.length) == 0) {
                return [];
            }
            return pixels;
        }

        destroy() {
            const device = this.device;
            if (device) {
                device.waitIdle();
                if (this.imgui) {
                    this.sample.destroyImgui();
                }
                for (const queuedFrame of this.queuedFrames) {
                    for (const view of queuedFrame.materialViews) {
                        view.destroy();
                    }
                }
                const descriptorPool = this.descriptorPool;
                if (descriptorPool) {
                    descriptorPool.destroy();
                }
                this.modelFPS.destroy();
                this.modelRTS.destroy();
                this.destroySprite(this.background);
                this.destroySprite(this.tile);
                this.destroySprite(this.tileBorder);
                this.destroyDepth();
                this.destroyDescriptor(this.spriteSampler);
                this.destroyDescriptor(this.linearWrapSampler);
                this.destroyBuffer(this.constantBuffer);
                this.destroyBuffer(this.readbackBuffer);
                this.destroyPipeline(this.spritePipeline);
                this.destroyPipeline(this.dualPipeline);
                this.destroyPipeline(this.basicPipeline);
                const spriteLayout = this.spriteLayout;
                if (spriteLayout) {
                    spriteLayout.destroy();
                }
                const modelLayout = this.modelLayout;
                if (modelLayout) {
                    modelLayout.destroy();
                }
                this.frames.destroy();
                this.swapChain.destroy();
                device.destroy();
            }
            this.sample.destroy();
        }

        destroySprite(sprite: Sprite | null) {
            if (!sprite) {
                return;
            }
            sprite.view.destroy();
            sprite.texture.destroy();
        }

        destroyDescriptor(descriptor: NriDescriptor | null) {
            if (descriptor) {
                descriptor.destroy();
            }
        }

        destroyBuffer(buffer: NriBuffer | null) {
            if (buffer) {
                buffer.destroy();
            }
        }

        destroyPipeline(pipeline: NriPipeline | null) {
            if (pipeline) {
                pipeline.destroy();
            }
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = NriSample.create();
        sample.useResizableWindow();
        const mouseCursor = new MouseCursor(sample);
        // -noUI: accepted, as Donut's examples accept it (the menu's text is the scene's, drawn anyway).
        sample.addExampleOption("-noUI");
        sample.useImgui();
        return mouseCursor.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return MouseCursorNri.main(argc, argv);
}
