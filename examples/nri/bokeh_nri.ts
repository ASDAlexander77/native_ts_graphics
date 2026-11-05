/// <reference path="../../core/nri/nri_interop.d.ts" />
import { NriFrameRing } from "../../core/nri_frame_ring";
import { NriSwapChain } from "../../core/nri_swap_chain";
import { SdkMesh } from "../../core/sdk_mesh";
import {
    rotationY, transpose, inverse, cross3, dot3, normalize3, multiplyF32,
} from "../../core/matrix";
import { formatFixed } from "../../core/text_format";
import { Nri, NriBuffer, NriCommandBuffer, NriDescriptor, NriDescriptorPool, NriDescriptorSet, NriDevice, NriFile, NriImgui, NriImguiFont, NriPipeline, NriPipelineDesc, NriPipelineLayout, NriPipelineLayoutDesc, NriQueryPool, NriQueue, NriSample, NriTexture } from "../../core/nri";

namespace BokehNri {
    // bokeh, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead of Donut and
    // NVRHI: the same shaders (bokeh.hlsl's, bokeh_energy.hlsl's and bokeh_scene.hlsl's, the Xbox ATG
    // Bokeh12 sample's) and SDKMESH reader (core/sdkmesh.cpp, which nri_interop.dll holds), through
    // the NRI calls core/nri/nri_interop.d.ts binds, with NRIFramework's ImGui for the sample's HUD
    // (its colors stored as they are, as Donut's ImGui renderer stores them in the UNORM back buffer).
    // Its Key values come from donut_interop.d.ts (declarations only, through core/sdk_mesh.ts). This
    // example creates everything it runs, and does the rendering.

    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;
    // core/test_check.ts' TEST_SKIPPED (CTest's SKIP_RETURN_CODE): D3D11 (see initialize).
    const TEST_SKIPPED = 77;

    const WINDOW_TITLE = "NRI Example: Bokeh";
    const MEDIA_DIR = "media/bokeh/";
    const FONT_PATH = "media/fonts/OpenSans/OpenSans-Regular.ttf";
    // The sample's SegoeUI_18 sprite font (the one it takes up to 1080 lines),
    // its lines 32 pixels apart.
    // ImGui sizes a font by its ascent + descent (1.3618 OpenSans ems), so the 23 pixel em that gives
    // its strings' widths is 31.5.
    const FONT_SIZE = 31.5;
    const LINE_SPACING = 32.0;

    // ATG::Colors::Green (#107c10), stored as is in the UNORM back buffer as the sample's.
    const GREEN_R = 0.062745102;
    const GREEN_G = 0.486274511;
    const GREEN_B = 0.062745102;

    // shadersettings.h.
    const FIRST_DOWNSAMPLE = 2;
    const NUM_RADII_WEIGHTS = 64;

    const PRESET_SCENE_COUNT = 4;

    // Bokeh12.cpp: the models, and the scene's objects: six microscopes around the city's column.
    const MODEL_FILES = ["scanner.sdkmesh", "occcity.sdkmesh", "column.sdkmesh"];
    const OBJECT_COUNT = 8;
    const OBJECT_MODELS = [0, 0, 0, 0, 0, 0, 1, 2];
    const OBJECT_TURNS = [0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 0.0, 0.0];

    // BokehCB of BokehEffect12.h (bokeh.hlsl's cbuffer bokeh), in floats; its view's 256 bytes.
    const BOKEH_CB_FLOATS = 60;
    const BOKEH_CB_VIEWPORTS = 12;
    const BOKEH_CB_SWITCHOVER = 36;
    const BOKEH_CB_ENERGY_SCALE = 40;
    const BOKEH_CB_INV_PROJ = 44;
    const BOKEH_CB_SIZE = 256;

    // BasicEffect's constant buffer (bokeh_scene.hlsl): DiffuseColor, EmissiveColor, SpecularColor
    // and SpecularPower, the three lights' directions, diffuse and specular colors, EyePosition,
    // World, WorldInverseTranspose, WorldViewProj; one 512-byte slice per object.
    const PARAMETERS_EMISSIVE = 4;
    const PARAMETERS_SPECULAR = 8;
    const PARAMETERS_LIGHTS = 12;
    const PARAMETERS_EYE = 48;
    const PARAMETERS_WORLD = 52;
    const PARAMETERS_WORLD_INVERSE_TRANSPOSE = 68;
    const PARAMETERS_WORLD_VIEW_PROJ = 84;
    const PARAMETERS_SLICE_FLOATS = 128;
    const PARAMETERS_SLICE_SIZE = PARAMETERS_SLICE_FLOATS * 4;

    // A queued frame's constants: the objects' slices, then BokehCB (multiples of 256, D3D12's).
    const FRAME_CONSTANTS_SIZE = OBJECT_COUNT * PARAMETERS_SLICE_SIZE + BOKEH_CB_SIZE;

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

    // GPU timers (the sample's TimerIndex): a timestamp at the start and the end of each, a queued
    // frame's in turn, read when its turn comes again.
    const TI_FRAME = 0;
    const TI_SCENE = 1;
    const TI_BOKEH = 2;
    const TI_COPY = 3;
    const TIMER_COUNT = 4;
    const TIMESTAMPS = 2 * TIMER_COUNT;

    // The sample's Update runs once per frame on the console, at 60 Hz: its per-frame steps are
    // scaled to the frame's time here.
    const STEPS_PER_SECOND = 60.0;

    // The held keys polled (GLFW's key codes, Donut's Key values): the gamepad's sticks, shoulder
    // buttons and triggers, D-pad left and right; Up and Down act when pressed.
    const HELD_KEYS = [Key.A, Key.D, Key.W, Key.S, Key.Q, Key.E, Key.Left, Key.Right, Key.Num1, Key.Num1 + 1, Key.Num1 + 2,
        Key.Num1 + 3, Key.Num1 + 4, Key.Num1 + 5, Key.Num1 + 6, Key.Num1 + 7];
    const PRESS_KEYS = [Key.Up, Key.Down];

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // A frame in flight's own data: its sets (the objects' BasicEffect
    // slices and textures; the bokeh passes' BokehCB and textures), the views of its constants, the
    // buffer its timestamps are copied into and whether it holds ones not read yet.
    class QueuedFrame {
        objectSets: NriDescriptorSet[] = [];
        constantViews: NriDescriptor[] = [];
        rgbzSet: NriDescriptorSet | null = null;
        downsampleSet: NriDescriptorSet | null = null;
        quadPointSet: NriDescriptorSet | null = null;
        recombineSet: NriDescriptorSet | null = null;
        timestampsPending: boolean = false;

        constructor(public commandBuffer: NriCommandBuffer,
            public timestampBuffer: NriBuffer | null) {
        }
    }

    // A render target and its views: rendered into and read by shaders; the state it's in.
    class Target {
        state: NriTextureState = NriTextureState.ShaderResource;

        constructor(public texture: NriTexture, public attachment: NriDescriptor, public shaderResource: NriDescriptor) {
        }
    }

    // -test: checks the last frame, read back, as the Donut example does: the scene, blurred by the
    // bokeh depth of field, fills it, its golden pillar about 5% colored.
    function checkFrame(pixels: int[], width: int, height: int) {
        if (pixels.length == 0) {
            return "cannot read the back buffer";
        }
        const total = width * height;
        let dark = 0;
        let colored = 0;
        for (let i = 0; i < total; i++) {
            const p = pixels[i];
            const r = p & 0xFF;
            const g = (p >> 8) & 0xFF;
            const b = (p >> 16) & 0xFF;
            if (r <= 20 && g <= 20 && b <= 20) {
                dark++;
            }
            let high = r;
            let low = r;
            if (g > high) {
                high = g;
            }
            if (b > high) {
                high = b;
            }
            if (g < low) {
                low = g;
            }
            if (b < low) {
                low = b;
            }
            if (high - low >= 61) {
                colored++;
            }
        }
        const lit = 100.0 * (total - dark) / total;
        console.log(`Lit: ${lit}% (${total - dark} of ${total} pixels)`);
        if (lit < 95.0 || lit > 100.0) {
            return `Lit: ${lit}% of the pixels, not 95% to 100%`;
        }
        const coloredPercent = 100.0 * colored / total;
        console.log(`Colored: ${coloredPercent}% (${colored} of ${total} pixels)`);
        if (coloredPercent < 2.0 || coloredPercent > 10.0) {
            return `Colored: ${coloredPercent}% of the pixels, not 2% to 10%`;
        }
        return "";
    }

    // --- DirectXMath, row-major for mul(vector, matrix) --------------------------------------

    // XMMatrixLookAtLH: XMMatrixLookToLH towards the focus.
    function lookAtLH(eye: number[], focus: number[], up: number[]) {
        const r2 = normalize3([focus[0] - eye[0], focus[1] - eye[1], focus[2] - eye[2]]);
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

    // XMMatrixPerspectiveFovLH.
    function perspectiveFovLH(fovY: number, aspect: number, nearZ: number, farZ: number) {
        const height = Math.cos(0.5 * fovY) / Math.sin(0.5 * fovY);
        const width = height / aspect;
        const range = farZ / (farZ - nearZ);
        return [width, 0.0, 0.0, 0.0, 0.0, height, 0.0, 0.0, 0.0, 0.0, range, 1.0, 0.0, 0.0, -range * nearZ, 0.0];
    }

    // value clamped to [min, max] (explicit: tslang's Math.max gets negative numbers wrong).
    function clamp(value: number, min: number, max: number) {
        return value < min ? min : value > max ? max : value;
    }

    // --- Models -----------------------------------------------------------------------------

    // A SDKMESH model as DirectXTK's Model::CreateFromSDKMESH makes it (core/sdkmesh.cpp parses the
    // file): its vertex and index buffers, its mesh parts (one per subset, drawn with their mesh's
    // buffers), and its materials' diffuse colors and textures.
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
        // Per material: the diffuse color (RGB) and alpha, the diffuse texture and its view.
        materialColors: number[] = [];
        materialTextures: NriTexture[] = [];
        materialViews: NriDescriptor[] = [];
        vertexStride: int = 0;

        // The file's buffers uploaded on the queue, its materials' textures loaded (DirectXTK's
        // EffectTextureFactory: DDS files as they are). False (after printing why) on failure.
        load(device: NriDevice, queue: NriQueue, file: string) {
            const binaryFile = NriFile.load(MEDIA_DIR + file);
            if (!binaryFile) {
                return false;
            }
            const mesh = SdkMesh.load(binaryFile.getData(), binaryFile.getSize());
            if (mesh.isNull()) {
                binaryFile.destroy();
                return false;
            }

            // The sample's models are position, normal and texture coordinates (DirectXTK's
            // VertexPositionNormalTexture layout), which bokeh_scene.hlsl reads.
            this.vertexStride = mesh.getVertexBufferStride(0);
            let ok = true;
            for (let i = 0; i < mesh.getVertexBufferCount(); i++) {
                if (mesh.getVertexElementOffset(i, 3, 0) != 12 || mesh.getVertexElementOffset(i, 5, 0) != 24
                    || mesh.getVertexBufferStride(i) != this.vertexStride) {
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

            // InitMaterial: a material whose colors are all zero is white.
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
                } else {
                    this.materialColors.push(colors[0]);
                    this.materialColors.push(colors[1]);
                    this.materialColors.push(colors[2]);
                    this.materialColors.push(colors[3] != 1.0 && colors[3] != 0.0 ? colors[3] : 1.0);
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
            for (const texture of this.materialTextures) {
                texture.destroy();
            }
        }
    }

    // --- The sample -------------------------------------------------------------------------

    // Port of the Xbox ATG Bokeh12 sample (XDKSamples/Graphics/Bokeh12; examples/bokeh.ts ports it to
    // Donut) to NRI: depth of field rendered with point sprites. The scene (six microscopes around a
    // city) renders into an FP16 target; BokehEffect then copies it with linear depth (RGBZ),
    // downsamples that, and expands a point per 2 x 2 (or 4 x 1) block of the downsampled copy into
    // sprites the size of each pixel's circle of confusion, shaped by an iris texture, in a geometry
    // shader, additively into near and far layers at three resolutions (six viewports of one target,
    // SV_ViewportArrayIndex); the layers and the in-focus scene are recombined, and the result copied
    // to the swap chain texture. A compute shader finds the iris texture's energy weights every
    // frame, as the sample.
    //
    // The sample's gamepad controls are keys here (see buildUI); its HUD's timings are the GPU's,
    // from timestamp queries.
    class Bokeh {
        private device: NriDevice | null = null;
        private queue: NriQueue;
        private frames: NriFrameRing = new NriFrameRing();
        private swapChain: NriSwapChain = new NriSwapChain();
        private queuedFrames: QueuedFrame[] = [];
        private swapChainFormat: NriFormat = NriFormat.Unknown;
        private unsupportedReason: string = "";
        private models: Model[] = [];
        private irisTexture: NriTexture | null = null;
        private irisView: NriDescriptor | null = null;
        // The 1D weights texture (64 x 1 here) and the energy shader's 8x8x64 scratch memory.
        private energiesTexture: NriTexture | null = null;
        private energiesView: NriDescriptor | null = null;
        private energiesStorageView: NriDescriptor | null = null;
        private energiesState: NriTextureState = NriTextureState.Storage;
        private scratchBuffer: NriBuffer | null = null;
        private scratchView: NriDescriptor | null = null;
        private anisotropicSampler: NriDescriptor | null = null;
        private bokehSampler: NriDescriptor | null = null;
        private bilinearBorderSampler: NriDescriptor | null = null;
        private constantBuffer: NriBuffer | null = null;
        private descriptorPool: NriDescriptorPool | null = null;
        private sceneLayout: NriPipelineLayout | null = null;
        private rgbzLayout: NriPipelineLayout | null = null;
        private downsampleLayout: NriPipelineLayout | null = null;
        private quadPointLayout: NriPipelineLayout | null = null;
        private recombineLayout: NriPipelineLayout | null = null;
        private copyLayout: NriPipelineLayout | null = null;
        private energyLayout: NriPipelineLayout | null = null;
        private scenePipeline: NriPipeline | null = null;
        private rgbzPipeline: NriPipeline | null = null;
        private downsamplePipeline: NriPipeline | null = null;
        private quadPointPipeline: NriPipeline | null = null;
        private quadPointFastPipeline: NriPipeline | null = null;
        private recombinePipeline: NriPipeline | null = null;
        private copyPipeline: NriPipeline | null = null;
        private energyPipeline: NriPipeline | null = null;
        private energySet: NriDescriptorSet | null = null;
        private copySet: NriDescriptorSet | null = null;
        // The window-sized targets: the scene's FP16 color and depth, the DOF target (the layers' six
        // viewports), the RGBZ copies at full and quarter size.
        private sceneColor: Target | null = null;
        private sceneDepth: NriTexture | null = null;
        private sceneDepthAttachment: NriDescriptor | null = null;
        private sceneDepthView: NriDescriptor | null = null;
        private dofColor: Target | null = null;
        private rgbzCopy: Target | null = null;
        private rgbzHalfCopy: Target | null = null;
        private dofHeight: int = 0;
        private imgui: boolean = false;
        private font: NriImguiFont | null = null;

        private queryPool: NriQueryPool | null = null;
        private querySize: int = 0;
        private timerSums: number[] = [0.0, 0.0, 0.0, 0.0];
        private timerSamples: int = 0;
        private timerWindow: number = 0.0;

        private bokehConstants: f32[] = [];
        private parameters: f32[] = [];

        frameWidth: int = 1280;
        frameHeight: int = 720;
        // The HUD's numbers: CPU frame time and GPU times (frame, scene, bokeh, copy) in ms.
        cpuFrameMs: number = 0.0;
        gpuMs: number[] = [0.0, 0.0, 0.0, 0.0];

        // ATG::BokehEffect::Parameters and the camera.
        // Sample::Sample: performance / quality tradeoff
        maxCoCSizeNear: number = 32.0;       // maximum allowed radius
        maxCoCSizeFar: number = 32.0;
        switchover1: number[] = [16.0, 16.0];  // near/far 1/2 -> 1/4 switchover threshold in pixels (radius)
        switchover2: number[] = [16.0, 16.0];  // near 1/4 -> 1/8
        // edges blend
        initialEnergyScale: number = 1.72;
        useFastShader: boolean = true;
        focusLength: number = 0.075;
        fNumber: number = 2.8;
        focalPlane: number = 0.5;
        presetScene: int = 0;
        cameraAngle: number = 0.0;
        cameraElevation: number = 5.0;
        cameraDistance: number = 5.0;
        // -noUI: no HUD.
        noUI: boolean = false;

        // Held keys (by Key value), and whether the press keys were down last frame.
        private held: boolean[] = [];
        private wasDown: boolean[] = [false, false];

        // -test: the last frame is read back into readbackBuffer, rows rowPitch bytes apart.
        private test: boolean = false;
        private readbackBuffer: NriBuffer | null = null;
        private rowPitch: int = 0;

        constructor(private sample: NriSample) {
            for (let i = 0; i < BOKEH_CB_FLOATS + 4; i++) {
                this.bokehConstants.push(0.0);
            }
            for (let i = 0; i < PARAMETERS_SLICE_FLOATS * OBJECT_COUNT; i++) {
                this.parameters.push(0.0);
            }
            for (let i = 0; i < 512; i++) {
                this.held.push(false);
            }
            this.setPredefinedScene(0);
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

            let result = this.sample.run(argc, argv, WINDOW_TITLE, TEST_FRAMES);
            if (this.unsupportedReason != "") {
                const test = this.sample.isTest() != 0;
                console.log(test ? `Test SKIPPED: ${this.unsupportedReason}` : this.unsupportedReason);
                result = test ? TEST_SKIPPED : 1;
            } else if (result == 0 && this.test) {
                const failure = checkFrame(this.readBack(), this.frameWidth, this.frameHeight);
                console.log(failure == "" ? "Test PASSED" : `Test FAILED: ${failure}`);
                result = failure == "" ? 0 : 1;
            }
            this.destroy();
            return result;
        }

        // Sample::CreateDeviceDependentResources, BokehEffect's resources and
        // CreateWindowSizeDependentResources (the window keeps its size).
        initialize(graphicsAPI: NriGraphicsAPI): int {
            // NRI's D3D11 backend makes buffers of 4-byte structures raw buffers, which the energy
            // shader's RWStructuredBuffer<float> can't be bound to.
            if (graphicsAPI == NriGraphicsAPI.D3D11) {
                this.unsupportedReason = "NRI's D3D11 backend has no structured buffers of 4-byte structures (the energy shader's scratch memory)";
                return 0;
            }
            const device = this.sample.createDevice(graphicsAPI);
            if (!device) {
                console.log("Cannot initialize a graphics device with the requested parameters");
                return 0;
            }
            this.device = device;
            console.log(`Renderer: ${Nri.getGraphicsAPIString(graphicsAPI)} (${device.getAdapterName()})`);

            this.queue = device.getGraphicsQueue();
            this.test = this.sample.isTest() != 0;

            // Swap chain: rendered through UNORM views, as the sample's R8G8B8A8_UNORM back buffers
            // (its FP16 scene copied as is).
            const queuedFrameNum = this.sample.getQueuedFrameNum();
            this.swapChain.init(this.sample, device, this.queue, false);
            this.sizeToSwapChain();
            const width = this.frameWidth;
            const height = this.frameHeight;
            const format = this.swapChainFormat;

            // Donut's AnisotropicWrap (trilinear, the device's maximum anisotropy) for the scene;
            // BokehRS's s0: FILTER_MIN_MAG_LINEAR_MIP_POINT, CreateEnergyTexRS's:
            // FILTER_MIN_MAG_MIP_LINEAR, both bordered in transparent black.
            const anisotropicSampler = device.createSamplerWithMipFilter(NriFilter.Linear, NriFilter.Linear, NriAddressMode.Repeat,
                device.getMaxSamplerAnisotropy());
            const bokehSampler = device.createBorderSamplerWithMipFilter(NriFilter.Linear, NriFilter.Nearest, 0);
            const bilinearBorderSampler = device.createBorderSampler(NriFilter.Linear, 0);
            this.anisotropicSampler = anisotropicSampler;
            this.bokehSampler = bokehSampler;
            this.bilinearBorderSampler = bilinearBorderSampler;
            if (!anisotropicSampler || !bokehSampler || !bilinearBorderSampler) {
                console.log("Cannot create the samplers");
                return 0;
            }

            // Load models from disk, and the iris texture.
            let loaded = true;
            for (const modelFile of MODEL_FILES) {
                const model = new Model();
                if (!model.load(device, this.queue, modelFile)) {
                    loaded = false;
                }
                this.models.push(model);
            }
            const irisTexture = device.loadDdsTexture(this.queue, MEDIA_DIR + "irishexa32.dds", 0);
            this.irisTexture = irisTexture;
            if (!loaded || !irisTexture) {
                console.log("Cannot load the sample's models and textures: set XBOX_ATG_SAMPLES_DIR when configuring");
                return 0;
            }
            const irisView = irisTexture.createView(irisTexture.getFormat());
            this.irisView = irisView;

            // The energy weights (written by the compute shader, read by the geometry shader) and the
            // scratch memory (zeroed: the shader's last groups may read sums still in flight).
            const energiesTexture = device.createStorageTexture(this.queue, NUM_RADII_WEIGHTS, 1, NriFormat.R32_SFLOAT);
            this.energiesTexture = energiesTexture;
            const scratchCount = (NUM_RADII_WEIGHTS / 8) * (NUM_RADII_WEIGHTS / 8) * NUM_RADII_WEIGHTS;
            const zeros: int[] = [];
            for (let i = 0; i < scratchCount; i++) {
                zeros.push(0);
            }
            const scratchBuffer = device.createStorageBufferFromInts(this.queue, Ref(zeros[0]), scratchCount * 4, 4, NriBufferState.Storage);
            this.scratchBuffer = scratchBuffer;
            if (!energiesTexture || !scratchBuffer) {
                console.log("Cannot create the energy weights");
                return 0;
            }
            const energiesView = energiesTexture.createView(NriFormat.R32_SFLOAT);
            const energiesStorageView = energiesTexture.createStorageView(NriFormat.R32_SFLOAT);
            const scratchView = scratchBuffer.createStructuredView(1);
            this.energiesView = energiesView;
            this.energiesStorageView = energiesStorageView;
            this.scratchView = scratchView;

            // The frame-sized targets (createSizeTargets).
            if (!this.createSizeTargets(device)) {
                console.log("Cannot create the render targets");
                return 0;
            }
            const sceneColor = this.sceneColor;
            const dofColor = this.dofColor;
            const rgbzCopy = this.rgbzCopy;
            const rgbzHalfCopy = this.rgbzHalfCopy;
            const sceneDepthView = this.sceneDepthView;
            if (!sceneColor || !dofColor || !rgbzCopy || !rgbzHalfCopy || !sceneDepthView) {
                return 0;
            }

            // The layouts, as the Donut example's binding layouts: the scene's BasicEffect constants,
            // texture and sampler; the bokeh passes' BokehCB, textures and BokehRS's sampler (the
            // quad point passes' read in the geometry shader too); the copy's texture; the energy
            // shader's iris texture and sampler, scratch memory and weights.
            this.sceneLayout = this.createLayout(device,
                [NriDescriptorType.ConstantBuffer, NriDescriptorType.Texture, NriDescriptorType.Sampler],
                [0, 0, 0], NriStage.VertexPixel);
            this.rgbzLayout = this.createLayout(device,
                [NriDescriptorType.ConstantBuffer, NriDescriptorType.Texture, NriDescriptorType.Texture, NriDescriptorType.Sampler],
                [0, 0, 2, 0], NriStage.VertexPixel);
            this.downsampleLayout = this.createLayout(device,
                [NriDescriptorType.ConstantBuffer, NriDescriptorType.Texture, NriDescriptorType.Sampler],
                [0, 0, 0], NriStage.VertexPixel);
            this.quadPointLayout = this.createLayout(device,
                [NriDescriptorType.ConstantBuffer, NriDescriptorType.Texture, NriDescriptorType.Texture, NriDescriptorType.Texture,
                    NriDescriptorType.Sampler],
                [0, 0, 1, 4, 0], NriStage.VertexGeometry | NriStage.Pixel);
            this.recombineLayout = this.createLayout(device,
                [NriDescriptorType.ConstantBuffer, NriDescriptorType.Texture, NriDescriptorType.Texture, NriDescriptorType.Texture,
                    NriDescriptorType.Sampler],
                [0, 0, 2, 3, 0], NriStage.VertexPixel);
            this.copyLayout = this.createLayout(device, [NriDescriptorType.Texture], [0], NriStage.VertexPixel);
            this.energyLayout = this.createLayout(device,
                [NriDescriptorType.Texture, NriDescriptorType.Sampler, NriDescriptorType.StorageStructuredBuffer,
                    NriDescriptorType.StorageTexture],
                [0, 0, 0, 1], NriStage.Compute);
            const sceneLayout = this.sceneLayout;
            const rgbzLayout = this.rgbzLayout;
            const downsampleLayout = this.downsampleLayout;
            const quadPointLayout = this.quadPointLayout;
            const recombineLayout = this.recombineLayout;
            const copyLayout = this.copyLayout;
            const energyLayout = this.energyLayout;
            if (!sceneLayout || !rgbzLayout || !downsampleLayout || !quadPointLayout || !recombineLayout || !copyLayout || !energyLayout) {
                console.log("Cannot create the pipeline layouts");
                return 0;
            }

            // BokehEffect::CreatePSO and the scene's EffectPipelineStateDescription: the shaders as
            // compiled for the Donut example.
            const folder = graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv";
            const shaders = `shaders/bokeh/${folder}/`;
            this.scenePipeline = this.createScenePipeline(device, sceneLayout, shaders);
            this.rgbzPipeline = this.createFullscreenPipeline(device, rgbzLayout, shaders, "create_rgbz_ps", NriFormat.RGBA16_SFLOAT);
            this.downsamplePipeline = this.createFullscreenPipeline(device, downsampleLayout, shaders, "downsample_rgbz_ps",
                NriFormat.RGBA16_SFLOAT);
            this.recombinePipeline = this.createFullscreenPipeline(device, recombineLayout, shaders, "recombine_ps", NriFormat.RGBA16_SFLOAT);
            this.copyPipeline = this.createFullscreenPipeline(device, copyLayout, shaders, "copy_ps", format);
            this.quadPointPipeline = this.createQuadPointPipeline(device, quadPointLayout, shaders, "OPTIMISE=0");
            this.quadPointFastPipeline = this.createQuadPointPipeline(device, quadPointLayout, shaders, "OPTIMISE=1");
            this.energyPipeline = device.createComputePipeline(energyLayout, `${shaders}bokeh_energy_create_energy_tex_cs.bin`,
                "create_energy_tex_cs");
            if (!this.scenePipeline || !this.rgbzPipeline || !this.downsamplePipeline || !this.recombinePipeline || !this.copyPipeline
                || !this.quadPointPipeline || !this.quadPointFastPipeline || !this.energyPipeline) {
                console.log("Cannot load the bokeh shaders");
                return 0;
            }

            // A queued frame's timestamps.
            const queryPool = device.createTimestampQueryPool(queuedFrameNum * TIMESTAMPS);
            this.queryPool = queryPool;
            if (!queryPool) {
                console.log("Cannot create the timestamp queries");
                return 0;
            }
            this.querySize = queryPool.getQuerySize();

            // The constants, a queued frame's each; per queued frame the objects' sets and the bokeh
            // passes' sets; the copy's and the energy shader's sets.
            const constantBuffer = device.createHostBuffer(queuedFrameNum * FRAME_CONSTANTS_SIZE, NriBufferUsage.ConstantBuffer);
            this.constantBuffer = constantBuffer;
            const setNum = queuedFrameNum * (OBJECT_COUNT + 4) + 2;
            const descriptorPool = device.createDescriptorPoolWithBuffers(setNum, queuedFrameNum * (OBJECT_COUNT + 4) + 1,
                queuedFrameNum * (OBJECT_COUNT + 4), queuedFrameNum * (OBJECT_COUNT + 9) + 2, 1, 0, 1, 0);
            this.descriptorPool = descriptorPool;
            if (!constantBuffer || !descriptorPool || !energiesView || !energiesStorageView || !scratchView) {
                console.log("Cannot create the constant buffer");
                return 0;
            }
            this.frames.init(device, this.queue, queuedFrameNum);
            for (let q = 0; q < queuedFrameNum; q++) {
                // (A buffer each: on D3D11 a buffer holds only its last copy of queries.)
                const timestampBuffer = device.createReadbackBuffer(TIMESTAMPS * this.querySize);
                const queuedFrame = new QueuedFrame(this.frames.commandBuffer(q), timestampBuffer);
                this.queuedFrames.push(queuedFrame);
                const base = q * FRAME_CONSTANTS_SIZE;
                for (let o = 0; o < OBJECT_COUNT; o++) {
                    const view = constantBuffer.createConstantView(base + o * PARAMETERS_SLICE_SIZE, PARAMETERS_SLICE_SIZE);
                    const set = descriptorPool.allocateDescriptorSet(sceneLayout, 0, 0);
                    if (!view || !set) {
                        console.log("Cannot create the descriptor sets");
                        return 0;
                    }
                    queuedFrame.constantViews.push(view);
                    queuedFrame.objectSets.push(set);
                    set.updateDescriptor(0, 0, view);
                    set.updateDescriptor(1, 0, this.models[OBJECT_MODELS[o]].materialViews[0]);
                    set.updateDescriptor(2, 0, anisotropicSampler);
                }
                const bokehView = constantBuffer.createConstantView(base + OBJECT_COUNT * PARAMETERS_SLICE_SIZE, BOKEH_CB_SIZE);
                if (!bokehView || !timestampBuffer) {
                    console.log("Cannot create the descriptor sets");
                    return 0;
                }
                queuedFrame.constantViews.push(bokehView);
                // The sample's descriptor tables, as each pass binds them.
                queuedFrame.rgbzSet = this.createSet(descriptorPool, rgbzLayout, [bokehView, sceneColor.shaderResource, sceneDepthView,
                    bokehSampler]);
                queuedFrame.downsampleSet = this.createSet(descriptorPool, downsampleLayout, [bokehView, rgbzCopy.shaderResource, bokehSampler]);
                queuedFrame.quadPointSet = this.createSet(descriptorPool, quadPointLayout, [bokehView, rgbzHalfCopy.shaderResource, irisView,
                    energiesView, bokehSampler]);
                queuedFrame.recombineSet = this.createSet(descriptorPool, recombineLayout, [bokehView, dofColor.shaderResource, sceneDepthView,
                    rgbzCopy.shaderResource, bokehSampler]);
                if (!queuedFrame.rgbzSet || !queuedFrame.downsampleSet || !queuedFrame.quadPointSet || !queuedFrame.recombineSet) {
                    console.log("Cannot create the descriptor sets");
                    return 0;
                }
            }
            this.copySet = this.createSet(descriptorPool, copyLayout, [sceneColor.shaderResource]);
            this.energySet = this.createSet(descriptorPool, energyLayout, [irisView, bilinearBorderSampler, scratchView, energiesStorageView]);
            if (!this.copySet || !this.energySet) {
                console.log("Cannot create the descriptor sets");
                return 0;
            }

            // The sample's HUD, in the sample's font.
            if (!this.noUI) {
                if (this.sample.initImgui(device) == 0) {
                    console.log("Cannot initialize the user interface");
                    return 0;
                }
                this.imgui = true;
                this.font = NriImgui.createFont(FONT_PATH, FONT_SIZE);
                if (!this.font) {
                    console.log("Cannot load the font: set DONUT_SAMPLES_MEDIA_DIR when configuring");
                    return 0;
                }
            }

            if (this.test) {
                const alignment = device.getUploadBufferTextureRowAlignment();
                this.rowPitch = Math.floor((width * 4 + alignment - 1) / alignment) * alignment;
                this.readbackBuffer = device.createReadbackBuffer(this.rowPitch * height);
            }
            return 1;
        }

        // The frame-sized targets (BokehEffect::ResizeResources): the scene's FP16 color and depth,
        // the DOF target (two viewports at a quarter of the size one below the other, two at a
        // sixteenth and two at a 64th along the bottom), the RGBZ copies; false on failure.
        createSizeTargets(device: NriDevice): boolean {
            const width = this.frameWidth;
            const height = this.frameHeight;
            this.dofHeight = Math.floor(2 * height / FIRST_DOWNSAMPLE) + Math.floor(height / (2 * FIRST_DOWNSAMPLE))
                + Math.floor(height / (4 * FIRST_DOWNSAMPLE));
            const sceneColor = this.createTarget(device, width, height);
            const dofColor = this.createTarget(device, width, this.dofHeight);
            const rgbzCopy = this.createTarget(device, width, height);
            const rgbzHalfCopy = this.createTarget(device, Math.floor(width / FIRST_DOWNSAMPLE), Math.floor(height / FIRST_DOWNSAMPLE));
            this.sceneColor = sceneColor;
            this.dofColor = dofColor;
            this.rgbzCopy = rgbzCopy;
            this.rgbzHalfCopy = rgbzHalfCopy;
            const sceneDepth = device.createSampledDepthTexture(this.queue, width, height, NriFormat.D32_SFLOAT);
            this.sceneDepth = sceneDepth;
            if (!sceneColor || !dofColor || !rgbzCopy || !rgbzHalfCopy || !sceneDepth) {
                return false;
            }
            this.sceneDepthAttachment = sceneDepth.createDepthAttachmentView(NriFormat.D32_SFLOAT);
            this.sceneDepthView = sceneDepth.createView(NriFormat.D32_SFLOAT);
            return true;
        }

        destroySizeTargets() {
            this.destroyTarget(this.sceneColor);
            this.destroyTarget(this.dofColor);
            this.destroyTarget(this.rgbzCopy);
            this.destroyTarget(this.rgbzHalfCopy);
            this.sceneColor = null;
            this.dofColor = null;
            this.rgbzCopy = null;
            this.rgbzHalfCopy = null;
            this.destroyDescriptor(this.sceneDepthAttachment);
            this.destroyDescriptor(this.sceneDepthView);
            this.destroyTexture(this.sceneDepth);
            this.sceneDepthAttachment = null;
            this.sceneDepthView = null;
            this.sceneDepth = null;
        }

        // The sets' slots of the frame-sized targets pointed at the current ones: every queued frame's
        // bokeh passes' sets and the copy's.
        updateSizeDescriptors() {
            const sceneColor = this.sceneColor;
            const dofColor = this.dofColor;
            const rgbzCopy = this.rgbzCopy;
            const rgbzHalfCopy = this.rgbzHalfCopy;
            const sceneDepthView = this.sceneDepthView;
            if (!sceneColor || !dofColor || !rgbzCopy || !rgbzHalfCopy || !sceneDepthView) {
                return;
            }
            for (const queuedFrame of this.queuedFrames) {
                const rgbzSet = queuedFrame.rgbzSet;
                if (rgbzSet) {
                    rgbzSet.updateDescriptor(1, 0, sceneColor.shaderResource);
                    rgbzSet.updateDescriptor(2, 0, sceneDepthView);
                }
                const downsampleSet = queuedFrame.downsampleSet;
                if (downsampleSet) {
                    downsampleSet.updateDescriptor(1, 0, rgbzCopy.shaderResource);
                }
                const quadPointSet = queuedFrame.quadPointSet;
                if (quadPointSet) {
                    quadPointSet.updateDescriptor(1, 0, rgbzHalfCopy.shaderResource);
                }
                const recombineSet = queuedFrame.recombineSet;
                if (recombineSet) {
                    recombineSet.updateDescriptor(1, 0, dofColor.shaderResource);
                    recombineSet.updateDescriptor(2, 0, sceneDepthView);
                    recombineSet.updateDescriptor(3, 0, rgbzCopy.shaderResource);
                }
            }
            const copySet = this.copySet;
            if (copySet) {
                copySet.updateDescriptor(0, 0, sceneColor.shaderResource);
            }
        }

        // A width x height FP16 render target, left as a shader resource; null on failure.
        createTarget(device: NriDevice, width: int, height: int): Target | null {
            const texture = device.createRenderTargetTexture(this.queue, width, height, NriFormat.RGBA16_SFLOAT);
            if (!texture) {
                return null;
            }
            return new Target(texture, texture.createColorAttachmentView(NriFormat.RGBA16_SFLOAT),
                texture.createView(NriFormat.RGBA16_SFLOAT));
        }

        // A layout of one set: ranges of types at registers (one descriptor each) seen by stages.
        createLayout(device: NriDevice, types: NriDescriptorType[], registers: int[], stages: NriStage) {
            const desc = NriPipelineLayoutDesc.create();
            for (let i = 0; i < types.length; i++) {
                desc.addRange(0, registers[i], 1, types[i], stages, NriRangeFlags.None);
            }
            const layout = device.createPipelineLayoutFromDesc(desc);
            desc.destroy();
            return layout;
        }

        // A set of the layout with the descriptors, range by range; null on failure.
        createSet(descriptorPool: NriDescriptorPool, layout: NriPipelineLayout, descriptors: NriDescriptor[]) {
            const set = descriptorPool.allocateDescriptorSet(layout, 0, 0);
            if (!set) {
                return null;
            }
            for (let i = 0; i < descriptors.length; i++) {
                set.updateDescriptor(i, 0, descriptors[i]);
            }
            return set;
        }

        // The scene's: opaque, DepthDefault (less or equal), CullCounterClockwise (clockwise front
        // faces, the back ones culled); depth clip off (the Donut example's default).
        createScenePipeline(device: NriDevice, layout: NriPipelineLayout, shaders: string) {
            const desc = NriPipelineDesc.create();
            let loaded = desc.addShader(NriShaderStage.Vertex, `${shaders}bokeh_scene_scene_vs.bin`, "scene_vs") != 0;
            if (loaded) {
                loaded = desc.addShader(NriShaderStage.Pixel, `${shaders}bokeh_scene_scene_ps.bin`, "scene_ps") != 0;
            }
            // The models' vertices: position, normal, texture coordinates.
            desc.addVertexAttribute("POSITION", NriFormat.RGB32_SFLOAT, 0);
            desc.addVertexAttribute("NORMAL", NriFormat.RGB32_SFLOAT, 12);
            desc.addVertexAttribute("TEXCOORD", NriFormat.RG32_SFLOAT, 24);
            desc.setCullMode(NriCullMode.Back);
            desc.setDepthClip(0);
            desc.setColor(NriFormat.RGBA16_SFLOAT, NriColorWrite.RGBA);
            desc.setDepth(NriFormat.D32_SFLOAT, NriCompareOp.LessEqual, 1, 0);
            let pipeline: NriPipeline | null = null;
            if (loaded) {
                pipeline = device.createPipelineFromDesc(layout, desc);
            }
            desc.destroy();
            return pipeline;
        }

        // The full-screen passes (quad_vs and the pixel shader ps) into a color target of format: no
        // depth, nothing culled (the triangles face the camera anyway).
        createFullscreenPipeline(device: NriDevice, layout: NriPipelineLayout, shaders: string, ps: string, format: NriFormat) {
            const desc = NriPipelineDesc.create();
            let loaded = desc.addShader(NriShaderStage.Vertex, `${shaders}bokeh_quad_vs.bin`, "quad_vs") != 0;
            if (loaded) {
                loaded = desc.addShader(NriShaderStage.Pixel, `${shaders}bokeh_${ps}.bin`, ps) != 0;
            }
            desc.setDepthClip(0);
            desc.setColor(format, NriColorWrite.RGBA);
            let pipeline: NriPipeline | null = null;
            if (loaded) {
                pipeline = device.createPipelineFromDesc(layout, desc);
            }
            desc.destroy();
            return pipeline;
        }

        // The quad point PSOs (the geometry shader's permutation "OPTIMISE=0" or "=1"): points
        // expanded by the geometry shader, added together (One + One).
        createQuadPointPipeline(device: NriDevice, layout: NriPipelineLayout, shaders: string, permutation: string) {
            const desc = NriPipelineDesc.create();
            let loaded = desc.addShader(NriShaderStage.Vertex, `${shaders}bokeh_quad_point_vs.bin`, "quad_point_vs") != 0;
            if (loaded) {
                loaded = desc.addShaderPermutation(NriShaderStage.Geometry, `${shaders}bokeh_quad_point_gs.bin`, "quad_point_gs",
                    permutation) != 0;
            }
            if (loaded) {
                loaded = desc.addShader(NriShaderStage.Pixel, `${shaders}bokeh_quad_point_ps.bin`, "quad_point_ps") != 0;
            }
            desc.setTopology(NriTopology.PointList);
            desc.setDepthClip(0);
            desc.setColor(NriFormat.RGBA16_SFLOAT, NriColorWrite.RGBA);
            desc.setBlend(NriBlendFactor.One, NriBlendFactor.One, NriBlendOp.Add, NriBlendFactor.One, NriBlendFactor.One,
                NriBlendOp.Add);
            let pipeline: NriPipeline | null = null;
            if (loaded) {
                pipeline = device.createPipelineFromDesc(layout, desc);
            }
            desc.destroy();
            return pipeline;
        }

        // Sample::SetPredefinedScene.
        setPredefinedScene(index: int) {
            if (index == 1) {
                // default scene
                this.focusLength = 0.075;    // 75 mm lens
                this.fNumber = 2.8;          // F/2.8 aperture
                this.focalPlane = 2.5;       // focus distance
                this.cameraAngle = -0.8;     // radians
                this.cameraElevation = 0.8;
                this.cameraDistance = 2.3;
            } else if (index == 2) {
                // defocused background
                this.focusLength = 0.075;    // 75 mm lens
                this.fNumber = 2.8;          // F/2.8 aperture
                this.focalPlane = 1.0;       // focus distance
                this.cameraAngle = -2.4;     // radians
                this.cameraElevation = 0.8;
                this.cameraDistance = 2.5;
            } else if (index == 3) {
                // doll house
                this.focusLength = 0.175;    // 175 mm lens
                this.fNumber = 2.8;          // F/2.8 aperture
                this.focalPlane = 2.5;       // focus distance
                this.cameraAngle = -1.28;    // radians
                this.cameraElevation = 0.8;
                this.cameraDistance = 3.1;
            } else {
                // macro scene
                this.focusLength = 0.075;    // 75 mm lens
                this.fNumber = 2.8;          // F/2.8 aperture
                this.focalPlane = 0.5;       // focus distance
                this.cameraAngle = -0.8;     // radians
                this.cameraElevation = 0.8;
                this.cameraDistance = 1.1;
            }
        }

        // The Donut example's onKey: Up and Down when pressed, the held keys' state.
        pollKeys() {
            for (const key of HELD_KEYS) {
                this.held[key] = this.sample.isKeyPressed(key) != 0;
            }
            for (let i = 0; i < PRESS_KEYS.length; i++) {
                const down = this.sample.isKeyPressed(PRESS_KEYS[i]) != 0;
                if (down && !this.wasDown[i]) {
                    if (PRESS_KEYS[i] == Key.Up) {
                        // Toggle fast bokeh shader
                        this.useFastShader = !this.useFastShader;
                    } else {
                        // Iterate through preset parameters & cam position
                        this.presetScene = (this.presetScene + 1) % PRESET_SCENE_COUNT;
                        this.setPredefinedScene(this.presetScene);
                    }
                }
                this.wasDown[i] = down;
            }
        }

        // A stick axis from two keys: 1, -1 or 0.
        axis(positiveKey: int, negativeKey: int) {
            let value = 0.0;
            if (this.held[positiveKey]) {
                value += 1.0;
            }
            if (this.held[negativeKey]) {
                value -= 1.0;
            }
            return value;
        }

        // Sample::Update: the held controls, a step per 1/60 s (the test takes 1/60 second a frame,
        // as Donut's test mode, without input).
        animate() {
            const elapsedSeconds = Math.fround(this.test ? 1.0 / 60.0 : this.sample.getFrameTime());
            if (!this.test) {
                this.pollKeys();
            }
            this.cpuFrameMs = 1000.0 * elapsedSeconds;
            const steps = elapsedSeconds * STEPS_PER_SECOND;

            // The left stick (A / D, W / S) and the right stick's Y (Q / E).
            const leftX = this.axis(Key.D, Key.A);
            const leftY = this.axis(Key.W, Key.S);
            const rightY = this.axis(Key.Q, Key.E);
            this.cameraAngle -= leftX * 0.2 * steps;
            this.cameraElevation = clamp(this.cameraElevation - leftY * 0.2 * steps, -10.0, 10.0);
            this.cameraDistance = clamp(this.cameraDistance - rightY * 0.2 * steps, 1.0, 10.0);

            // Focus Length
            if (this.held[Key.Left]) {
                // longest super telephoto Canon F/11 lens is 1.2 meter
                // so let's limit it to 200mm because even that can produce blurs of radius of 100+ in the near plane
                this.focusLength = Math.min(0.2, this.focusLength + 0.01 * steps);
            }
            if (this.held[Key.Right]) {
                this.focusLength = Math.max(0.025, this.focusLength - 0.01 * steps);
            }

            // FNumber: [A] 2, [B] 1.
            if (this.held[Key.Num1 + 1]) {
                this.fNumber = Math.min(64.0, this.fNumber + 0.1 * steps);
            }
            if (this.held[Key.Num1]) {
                this.fNumber = Math.max(1.0, this.fNumber - 0.1 * steps);
            }

            // Focal Plane: [Y] 4, [X] 3.
            if (this.held[Key.Num1 + 3]) {
                this.focalPlane = Math.min(10.0, this.focalPlane + 0.01 * steps);
            }
            if (this.held[Key.Num1 + 2]) {
                this.focalPlane = Math.max(0.5, this.focalPlane - 0.01 * steps);
            }

            // Max Near CoC Size: [LB] 5, [LT] 6.
            if (this.held[Key.Num1 + 4]) {
                this.maxCoCSizeNear = Math.max(1.0, this.maxCoCSizeNear - 1.0 * steps);
            }
            if (this.held[Key.Num1 + 5]) {
                this.maxCoCSizeNear = Math.min(128.0, this.maxCoCSizeNear + 1.0 * steps);
            }

            // Max Far CoC Size: [RB] 7, [RT] 8.
            if (this.held[Key.Num1 + 6]) {
                this.maxCoCSizeFar = Math.max(1.0, this.maxCoCSizeFar - 1.0 * steps);
            }
            if (this.held[Key.Num1 + 7]) {
                this.maxCoCSizeFar = Math.min(128.0, this.maxCoCSizeFar + 1.0 * steps);
            }

            // GPUTimer's averages, over half a second here.
            this.timerWindow += elapsedSeconds;
            if (this.timerWindow >= 0.5 && this.timerSamples > 0) {
                for (let i = 0; i < TIMER_COUNT; i++) {
                    this.gpuMs[i] = this.timerSums[i] / this.timerSamples;
                    this.timerSums[i] = 0.0;
                }
                this.timerSamples = 0;
                this.timerWindow = 0.0;
            }
        }

        // Sample::CalculateCameraMatrix and Model::UpdateEffectMatrices: each object's BasicEffect
        // constants (EffectMatrices and EffectLights::SetConstants: ambient folded into emissive,
        // diffuse premultiplied by alpha; the sample sets every effect's emissive color to white).
        updateScene(view: number[], proj: number[]) {
            const viewInverse = inverse(view);
            for (let o = 0; o < OBJECT_COUNT; o++) {
                const model = this.models[OBJECT_MODELS[o]];
                const base = o * PARAMETERS_SLICE_FLOATS;
                // One material per model in the sample's files.
                const alpha = model.materialColors[3];
                for (let i = 0; i < 3; i++) {
                    const diffuse = model.materialColors[i];
                    this.parameters[base + i] = Math.fround(diffuse * alpha);
                    this.parameters[base + PARAMETERS_EMISSIVE + i] = Math.fround((DEFAULT_AMBIENT[i] * diffuse + 1.0) * alpha);
                    // DisableSpecular: black, power 1.
                    this.parameters[base + PARAMETERS_SPECULAR + i] = 0.0;
                }
                this.parameters[base + 3] = alpha;
                this.parameters[base + PARAMETERS_SPECULAR + 3] = 1.0;
                for (let light = 0; light < 3; light++) {
                    for (let i = 0; i < 3; i++) {
                        this.parameters[base + PARAMETERS_LIGHTS + light * 4 + i] = DEFAULT_DIRECTIONS[light * 3 + i];
                        this.parameters[base + PARAMETERS_LIGHTS + 12 + light * 4 + i] = DEFAULT_DIFFUSE[light * 3 + i];
                        this.parameters[base + PARAMETERS_LIGHTS + 24 + light * 4 + i] = DEFAULT_SPECULAR[light * 3 + i];
                    }
                }
                for (let i = 0; i < 3; i++) {
                    this.parameters[base + PARAMETERS_EYE + i] = viewInverse[12 + i];
                }

                const world = rotationY(Math.fround(Math.fround(2.0 * Math.PI) * Math.fround(OBJECT_TURNS[o] / 6.0)));
                const worldInverseTranspose = transpose(inverse(world));
                const worldViewProj = multiplyF32(multiplyF32(world, view), proj);
                for (let i = 0; i < 16; i++) {
                    this.parameters[base + PARAMETERS_WORLD + i] = world[i];
                    this.parameters[base + PARAMETERS_WORLD_INVERSE_TRANSPOSE + i] = worldInverseTranspose[i];
                    this.parameters[base + PARAMETERS_WORLD_VIEW_PROJ + i] = worldViewProj[i];
                }
            }
        }

        // BokehEffect::StartRendering's constants.
        updateBokehConstants(width: int, height: int, invProj: number[]) {
            const c = this.bokehConstants;
            c[0] = this.maxCoCSizeNear;
            c[1] = this.focusLength;
            c[2] = this.focalPlane;
            c[3] = this.fNumber;
            c[4] = width;
            c[5] = height;
            c[6] = width;
            c[7] = this.dofHeight;
            c[8] = width;
            c[9] = height;
            c[10] = this.maxCoCSizeFar;
            // 0.5 / the iris texture's width (32).
            c[11] = 0.5 / 32.0;
            for (let i = 0; i < 6; i++) {
                c[BOKEH_CB_VIEWPORTS + i * 4] = this.viewportValue(i, 0, width, height);
                c[BOKEH_CB_VIEWPORTS + i * 4 + 1] = this.viewportValue(i, 1, width, height);
                c[BOKEH_CB_VIEWPORTS + i * 4 + 2] = this.viewportValue(i, 2, width, height);
                c[BOKEH_CB_VIEWPORTS + i * 4 + 3] = this.viewportValue(i, 3, width, height);
            }
            c[BOKEH_CB_SWITCHOVER] = this.switchover1[0];
            c[BOKEH_CB_SWITCHOVER + 1] = this.switchover1[1];
            c[BOKEH_CB_SWITCHOVER + 2] = this.switchover2[0];
            c[BOKEH_CB_SWITCHOVER + 3] = this.switchover2[1];
            c[BOKEH_CB_ENERGY_SCALE] = this.initialEnergyScale;
            // XMMatrixTranspose(matInvProj), read by the shader's column-major matrix.
            const invProjT = transpose(invProj);
            for (let i = 0; i < 16; i++) {
                c[BOKEH_CB_INV_PROJ + i] = invProjT[i];
            }
        }

        // BokehEffect::StartRendering's output viewports: x, y, width, height (which 0..3).
        viewportValue(index: int, which: int, width: int, height: int) {
            const vpSx = Math.fround(width / FIRST_DOWNSAMPLE);
            const vpSy = Math.fround(height / FIRST_DOWNSAMPLE);
            const vpSx2 = Math.fround(width / (2 * FIRST_DOWNSAMPLE));
            const vpSy2 = Math.fround(height / (2 * FIRST_DOWNSAMPLE));
            const vpSx4 = Math.fround(width / (4 * FIRST_DOWNSAMPLE));
            const vpSy4 = Math.fround(height / (4 * FIRST_DOWNSAMPLE));
            let x = 0.0;
            let y = 0.0;
            let w = vpSx;
            let h = vpSy;
            if (index == 1) {
                y = vpSy;
            } else if (index == 2 || index == 3) {
                x = index == 3 ? vpSx2 : 0.0;
                y = Math.fround(vpSy * 2.0);
                w = vpSx2;
                h = vpSy2;
            } else if (index == 4 || index == 5) {
                x = index == 5 ? vpSx4 : 0.0;
                y = Math.fround(Math.fround(vpSy * 2.0) + vpSy2);
                w = vpSx4;
                h = vpSy4;
            }
            return which == 0 ? x : which == 1 ? y : which == 2 ? w : h;
        }

        // The sample's HUD (SpriteFont text in the title-safe area): its timings at the top, its
        // controls at the bottom, here as keys.
        line(x: number, y: number, text: string) {
            NriImgui.drawText(x, y, text, GREEN_R, GREEN_G, GREEN_B, 1.0, 0);
        }

        buildUI() {
            this.sample.imguiNewFrame();
            const font = this.font;
            if (!font) {
                this.sample.imguiRender();
                return;
            }
            // SimpleMath::Viewport::ComputeTitleSafeArea
            const safeW = Math.fround((this.frameWidth + 19.0) / 20.0);
            const safeH = Math.fround((this.frameHeight + 19.0) / 20.0);
            const left: int = Math.floor(safeW);
            const top: int = Math.floor(safeH);
            const bottom: int = Math.floor(this.frameHeight - safeH + 0.5);

            font.pushFont();
            let y = top + 0.0;
            this.line(left, y, "Bokeh Sample");
            y += LINE_SPACING;
            this.line(left, y, `Frame CPU: ${formatFixed(this.cpuFrameMs, 2)} ms `);
            this.line(left, y + LINE_SPACING, `Frame GPU: ${formatFixed(this.gpuMs[TI_FRAME], 2)} ms `);
            this.line(left, y + LINE_SPACING * 2.0, `Scene: ${formatFixed(this.gpuMs[TI_SCENE], 2)} ms `);
            this.line(left, y + LINE_SPACING * 3.0, `Bokeh: ${formatFixed(this.gpuMs[TI_BOKEH], 2)} ms `);
            this.line(left, y + LINE_SPACING * 4.0, `Final copy: ${formatFixed(this.gpuMs[TI_COPY], 2)} ms`);

            y = bottom - LINE_SPACING * 8.0;
            this.line(left, y, `[Up]/[Down]   Fast Bokeh: ${this.useFastShader ? "true" : "false"}, next preset`);
            this.line(left, y + LINE_SPACING, `[Left]/[Right]   Lens: ${formatFixed(this.focusLength * 1000.0, 2)}mm`);
            this.line(left, y + LINE_SPACING * 2.0, `[2][1] F/${formatFixed(this.fNumber, 1)}`);
            this.line(left, y + LINE_SPACING * 3.0, `[3][4] Focal Plane: ${formatFixed(this.focalPlane, 2)}m`);
            this.line(left, y + LINE_SPACING * 4.0, `[5][6] CoC Near: ${formatFixed(this.maxCoCSizeNear, 1)}`);
            this.line(left, y + LINE_SPACING * 5.0, `[7][8] CoC Far: ${formatFixed(this.maxCoCSizeFar, 1)}`);
            this.line(left, y + LINE_SPACING * 6.0, "[A][D] [W][S] [Q][E] Camera");
            this.line(left, y + LINE_SPACING * 7.0, "[Esc] Exit");
            NriImgui.popFont();
            this.sample.imguiRender();
        }

        // Waits for the frame that last used this frame's command allocator (and its constants).
        latencySleep(frameIndex: int) {
            this.frames.wait(frameIndex);
        }

        // The GPU times this queued frame measured when it was last recorded (the GPU has finished
        // it: latencySleep waited for it), added to the averages, unless it hasn't been yet.
        readTimestamps(queuedFrame: QueuedFrame) {
            const device = this.device;
            const timestampBuffer = queuedFrame.timestampBuffer;
            if (!device || !timestampBuffer || !queuedFrame.timestampsPending) {
                return;
            }
            for (let i = 0; i < TIMER_COUNT; i++) {
                const ms = device.readTimestampIntervalMs(timestampBuffer, 2 * i * this.querySize, (2 * i + 1) * this.querySize);
                if (ms >= 0.0) {
                    this.timerSums[i] += ms;
                }
            }
            this.timerSamples++;
            queuedFrame.timestampsPending = false;
        }

        // Writes this queued frame's timestamp for timer's start (end: 0) or end (1).
        writeTimestamp(commandBuffer: NriCommandBuffer, queuedFrameIndex: int, timer: int, end: int) {
            const queryPool = this.queryPool;
            if (!queryPool) {
                return;
            }
            commandBuffer.writeTimestamp(queryPool, queuedFrameIndex * TIMESTAMPS + 2 * timer + end);
        }

        // The swap chain's size and formats (its views in the textures' format).
        sizeToSwapChain() {
            this.frameWidth = this.swapChain.width();
            this.frameHeight = this.swapChain.height();
            this.swapChainFormat = this.swapChain.format();
        }

        // The window was resized (NriSample.useResizableWindow): the swap chain and the frame-sized targets
        // (BokehEffect::ResizeResources) made again at its size, once the GPU is done with the old
        // ones, and the sets pointed at them. The new targets start as shader resources, as their
        // Targets' states say; the passes' viewports, the DOF slices and the HUD read the size every
        // frame.
        resizeIfNeeded() {
            const device = this.device;
            if (!device) {
                return;
            }
            if (!this.swapChain.resized()) {
                return;
            }
            device.waitIdle();
            this.destroySizeTargets();
            this.swapChain.recreate();
            this.sizeToSwapChain();
            if (!this.createSizeTargets(device)) {
                return;
            }
            this.updateSizeDescriptors();
        }

        renderFrame(frameIndex: int) {
            this.resizeIfNeeded();
            const queuedFrameIndex = frameIndex % this.queuedFrames.length;
            const queuedFrame = this.queuedFrames[queuedFrameIndex];
            this.readTimestamps(queuedFrame);
            this.animate();
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

        // Moves a target to state (if it isn't in it: D3D12 rejects barriers between equal states).
        transition(commandBuffer: NriCommandBuffer, target: Target, state: NriTextureState) {
            if (target.state != state) {
                commandBuffer.textureBarrier(target.texture, target.state, state);
                target.state = state;
            }
        }

        // A full-screen triangle into the target (cleared first if clear), of the pipeline with the
        // set; the target's size the viewport.
        drawFullscreen(commandBuffer: NriCommandBuffer, target: Target, width: int, height: int, layout: NriPipelineLayout | null,
            pipeline: NriPipeline | null, set: NriDescriptorSet | null) {
            if (!layout || !pipeline || !set) {
                return;
            }
            this.transition(commandBuffer, target, NriTextureState.ColorAttachment);
            commandBuffer.beginRendering(target.attachment);
            commandBuffer.setViewport(0.0, 0.0, width, height);
            commandBuffer.setScissor(0, 0, width, height);
            commandBuffer.setPipelineLayout(layout);
            commandBuffer.setPipeline(pipeline);
            commandBuffer.setDescriptorSet(0, set);
            commandBuffer.draw(3, 1, 0, 0);
            commandBuffer.endRendering();
        }

        // The scene: the city and the microscopes into the FP16 target and the depth, cleared.
        recordScene(commandBuffer: NriCommandBuffer, queuedFrame: QueuedFrame) {
            const sceneColor = this.sceneColor;
            const sceneDepth = this.sceneDepth;
            const sceneDepthAttachment = this.sceneDepthAttachment;
            const sceneLayout = this.sceneLayout;
            const scenePipeline = this.scenePipeline;
            if (!sceneColor || !sceneDepth || !sceneDepthAttachment || !sceneLayout || !scenePipeline) {
                return;
            }
            this.transition(commandBuffer, sceneColor, NriTextureState.ColorAttachment);
            commandBuffer.textureBarrier(sceneDepth, NriTextureState.ShaderResource, NriTextureState.DepthAttachment);
            commandBuffer.beginRenderingWithDepth(sceneColor.attachment, sceneDepthAttachment);
            commandBuffer.clearColor(0.0, 0.0, 0.0, 0.0);
            commandBuffer.clearDepth(1.0);
            commandBuffer.setViewport(0.0, 0.0, this.frameWidth, this.frameHeight);
            commandBuffer.setScissor(0, 0, this.frameWidth, this.frameHeight);
            commandBuffer.setPipelineLayout(sceneLayout);
            commandBuffer.setPipeline(scenePipeline);
            // render the city and microscopes
            for (let o = 0; o < OBJECT_COUNT; o++) {
                const model = this.models[OBJECT_MODELS[o]];
                commandBuffer.setDescriptorSet(0, queuedFrame.objectSets[o]);
                for (let p = 0; p < model.partIndexCounts.length; p++) {
                    commandBuffer.setVertexBuffer(0, model.vertexBuffers[model.partVertexBuffers[p]], 0, model.vertexStride);
                    const ib = model.partIndexBuffers[p];
                    commandBuffer.setIndexBuffer(model.indexBuffers[ib], 0, model.index32[ib] ? NriIndexType.UInt32 : NriIndexType.UInt16);
                    commandBuffer.drawIndexed(model.partIndexCounts[p], 1, model.partStartIndices[p], model.partVertexOffsets[p], 0);
                }
            }
            commandBuffer.endRendering();
            commandBuffer.textureBarrier(sceneDepth, NriTextureState.DepthAttachment, NriTextureState.ShaderResource);
            this.transition(commandBuffer, sceneColor, NriTextureState.ShaderResource);
        }

        // find iris texture weights
        recordEnergy(commandBuffer: NriCommandBuffer) {
            const energiesTexture = this.energiesTexture;
            const scratchBuffer = this.scratchBuffer;
            const energyLayout = this.energyLayout;
            const energyPipeline = this.energyPipeline;
            const energySet = this.energySet;
            if (!energiesTexture || !scratchBuffer || !energyLayout || !energyPipeline || !energySet) {
                return;
            }
            if (this.energiesState != NriTextureState.Storage) {
                commandBuffer.textureBarrier(energiesTexture, this.energiesState, NriTextureState.Storage);
            }
            // The previous frame's scratch writes before this frame's.
            commandBuffer.bufferBarrier(scratchBuffer, NriBufferState.Storage, NriBufferState.Storage);
            commandBuffer.setComputePipelineLayout(energyLayout);
            commandBuffer.setPipeline(energyPipeline);
            commandBuffer.setComputeDescriptorSet(0, energySet);
            commandBuffer.dispatch(NUM_RADII_WEIGHTS / 8, NUM_RADII_WEIGHTS / 8, NUM_RADII_WEIGHTS);
            // Read by the quad point passes' geometry shader.
            commandBuffer.textureBarrier(energiesTexture, NriTextureState.Storage, NriTextureState.GeometryShaderResource);
            this.energiesState = NriTextureState.GeometryShaderResource;
        }

        // BokehEffect::Render: the energy weights; the RGBZ copy and its downsampled copy; the
        // multi-viewport DOF target, split into slices, the CoC DOF; the viewports combined into the
        // scene's target.
        recordBokeh(commandBuffer: NriCommandBuffer, queuedFrame: QueuedFrame) {
            const dofColor = this.dofColor;
            const rgbzCopy = this.rgbzCopy;
            const rgbzHalfCopy = this.rgbzHalfCopy;
            const sceneColor = this.sceneColor;
            const quadPointLayout = this.quadPointLayout;
            const quadPointPipeline = this.useFastShader ? this.quadPointFastPipeline : this.quadPointPipeline;
            const quadPointSet = queuedFrame.quadPointSet;
            if (!dofColor || !rgbzCopy || !rgbzHalfCopy || !sceneColor || !quadPointLayout || !quadPointPipeline || !quadPointSet) {
                return;
            }
            const width = this.frameWidth;
            const height = this.frameHeight;

            this.recordEnergy(commandBuffer);

            // copy out the source
            this.drawFullscreen(commandBuffer, rgbzCopy, width, height, this.rgbzLayout, this.rgbzPipeline, queuedFrame.rgbzSet);
            this.transition(commandBuffer, rgbzCopy, NriTextureState.ShaderResource);

            // downsample (read by the quad point passes' geometry shader)
            this.drawFullscreen(commandBuffer, rgbzHalfCopy, Math.floor(width / FIRST_DOWNSAMPLE), Math.floor(height / FIRST_DOWNSAMPLE),
                this.downsampleLayout, this.downsamplePipeline, queuedFrame.downsampleSet);
            this.transition(commandBuffer, rgbzHalfCopy, NriTextureState.GeometryShaderResource);

            // prepare the multi-viewport dof render target: split into slices, do the CoC DOF
            this.transition(commandBuffer, dofColor, NriTextureState.ColorAttachment);
            commandBuffer.beginRendering(dofColor.attachment);
            commandBuffer.clearColor(0.0, 0.0, 0.0, 0.0);
            const viewports: f32[] = [];
            for (let i = 0; i < 6; i++) {
                for (let which = 0; which < 4; which++) {
                    viewports.push(this.viewportValue(i, which, width, height));
                }
            }
            commandBuffer.setViewportsAndScissors(Ref(viewports[0]), 6);
            commandBuffer.setPipelineLayout(quadPointLayout);
            commandBuffer.setPipeline(quadPointPipeline);
            commandBuffer.setDescriptorSet(0, quadPointSet);
            // each GS can output up to 4 triangles
            commandBuffer.draw(Math.floor(width * height / (FIRST_DOWNSAMPLE * FIRST_DOWNSAMPLE * 2 * 2)), 1, 0, 0);
            commandBuffer.endRendering();
            this.transition(commandBuffer, dofColor, NriTextureState.ShaderResource);

            // combine the resulting viewports
            this.drawFullscreen(commandBuffer, sceneColor, width, height, this.recombineLayout, this.recombinePipeline, queuedFrame.recombineSet);
            this.transition(commandBuffer, sceneColor, NriTextureState.ShaderResource);
        }

        // Records the frame into the swap chain texture, submits it and presents it.
        recordAndPresent(frameIndex: int, queuedFrame: QueuedFrame, queuedFrameIndex: int, index: int) {
            const descriptorPool = this.descriptorPool;
            const constantBuffer = this.constantBuffer;
            const copyLayout = this.copyLayout;
            const copyPipeline = this.copyPipeline;
            const copySet = this.copySet;
            if (!descriptorPool || !constantBuffer || !copyLayout || !copyPipeline || !copySet) {
                return;
            }
            const width = this.frameWidth;
            const height = this.frameHeight;

            // Sample::CalculateCameraMatrix
            const eye = [Math.fround(Math.sin(this.cameraAngle)) * this.cameraDistance, this.cameraElevation,
                Math.fround(Math.cos(this.cameraAngle)) * this.cameraDistance];
            const view = lookAtLH(eye, [0.0, 0.0, 0.0], [0.0, 1.0, 0.0]);
            const proj = perspectiveFovLH(Math.PI / 4.0, width / height, 0.05, 100.0);
            this.updateScene(view, proj);
            this.updateBokehConstants(width, height, inverse(proj));
            const base = queuedFrameIndex * FRAME_CONSTANTS_SIZE;
            constantBuffer.write(base, Ref(this.parameters[0]), PARAMETERS_SLICE_SIZE * OBJECT_COUNT);
            constantBuffer.write(base + OBJECT_COUNT * PARAMETERS_SLICE_SIZE, Ref(this.bokehConstants[0]), BOKEH_CB_SIZE);

            const commandBuffer = queuedFrame.commandBuffer;
            commandBuffer.begin();
            if (this.imgui) {
                this.sample.copyImguiData(commandBuffer);
            }
            commandBuffer.setDescriptorPool(descriptorPool);
            const queryPool = this.queryPool;
            if (queryPool) {
                commandBuffer.resetQueries(queryPool, queuedFrameIndex * TIMESTAMPS, TIMESTAMPS);
            }
            this.writeTimestamp(commandBuffer, queuedFrameIndex, TI_FRAME, 0);

            //------------------------------
            // Scene
            this.writeTimestamp(commandBuffer, queuedFrameIndex, TI_SCENE, 0);
            this.recordScene(commandBuffer, queuedFrame);
            this.writeTimestamp(commandBuffer, queuedFrameIndex, TI_SCENE, 1);

            //------------------------------
            // Bokeh
            this.writeTimestamp(commandBuffer, queuedFrameIndex, TI_BOKEH, 0);
            this.recordBokeh(commandBuffer, queuedFrame);
            this.writeTimestamp(commandBuffer, queuedFrameIndex, TI_BOKEH, 1);

            //------------------------------
            // Copy (the HUD over it)
            commandBuffer.textureBarrier(this.swapChain.texture(index), NriTextureState.Undefined, NriTextureState.ColorAttachment);
            this.writeTimestamp(commandBuffer, queuedFrameIndex, TI_COPY, 0);
            commandBuffer.beginRendering(this.swapChain.colorAttachment(index));
            commandBuffer.setViewport(0.0, 0.0, width, height);
            commandBuffer.setScissor(0, 0, width, height);
            commandBuffer.setPipelineLayout(copyLayout);
            commandBuffer.setPipeline(copyPipeline);
            commandBuffer.setDescriptorSet(0, copySet);
            commandBuffer.draw(3, 1, 0, 0);
            this.writeTimestamp(commandBuffer, queuedFrameIndex, TI_COPY, 1);
            this.writeTimestamp(commandBuffer, queuedFrameIndex, TI_FRAME, 1);
            if (this.imgui) {
                this.sample.drawImguiUnconverted(commandBuffer, this.swapChainFormat);
            }
            commandBuffer.endRendering();

            // The timestamps, into this queued frame's buffer, read when its turn comes again.
            const timestampBuffer = queuedFrame.timestampBuffer;
            if (queryPool) {
                if (timestampBuffer) {
                    commandBuffer.copyQueries(queryPool, queuedFrameIndex * TIMESTAMPS, TIMESTAMPS, timestampBuffer, 0);
                    queuedFrame.timestampsPending = true;
                }
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
                    for (const view of queuedFrame.constantViews) {
                        view.destroy();
                    }
                    this.destroyBuffer(queuedFrame.timestampBuffer);
                }
                const descriptorPool = this.descriptorPool;
                if (descriptorPool) {
                    descriptorPool.destroy();
                }
                for (const model of this.models) {
                    model.destroy();
                }
                this.destroySizeTargets();
                this.destroyDescriptor(this.irisView);
                this.destroyTexture(this.irisTexture);
                this.destroyDescriptor(this.energiesView);
                this.destroyDescriptor(this.energiesStorageView);
                this.destroyTexture(this.energiesTexture);
                this.destroyDescriptor(this.scratchView);
                this.destroyBuffer(this.scratchBuffer);
                this.destroyDescriptor(this.anisotropicSampler);
                this.destroyDescriptor(this.bokehSampler);
                this.destroyDescriptor(this.bilinearBorderSampler);
                this.destroyBuffer(this.constantBuffer);
                this.destroyBuffer(this.readbackBuffer);
                const queryPool = this.queryPool;
                if (queryPool) {
                    queryPool.destroy();
                }
                this.destroyPipeline(this.scenePipeline);
                this.destroyPipeline(this.rgbzPipeline);
                this.destroyPipeline(this.downsamplePipeline);
                this.destroyPipeline(this.quadPointPipeline);
                this.destroyPipeline(this.quadPointFastPipeline);
                this.destroyPipeline(this.recombinePipeline);
                this.destroyPipeline(this.copyPipeline);
                this.destroyPipeline(this.energyPipeline);
                this.destroyPipelineLayout(this.sceneLayout);
                this.destroyPipelineLayout(this.rgbzLayout);
                this.destroyPipelineLayout(this.downsampleLayout);
                this.destroyPipelineLayout(this.quadPointLayout);
                this.destroyPipelineLayout(this.recombineLayout);
                this.destroyPipelineLayout(this.copyLayout);
                this.destroyPipelineLayout(this.energyLayout);
                this.frames.destroy();
                this.swapChain.destroy();
                device.destroy();
            }
            this.sample.destroy();
        }

        destroyTarget(target: Target | null) {
            if (!target) {
                return;
            }
            target.attachment.destroy();
            target.shaderResource.destroy();
            target.texture.destroy();
        }

        destroyDescriptor(descriptor: NriDescriptor | null) {
            if (descriptor) {
                descriptor.destroy();
            }
        }

        destroyTexture(texture: NriTexture | null) {
            if (texture) {
                texture.destroy();
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

        destroyPipelineLayout(pipelineLayout: NriPipelineLayout | null) {
            if (pipelineLayout) {
                pipelineLayout.destroy();
            }
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = NriSample.create();
        const bokeh = new Bokeh(sample);
        // -preset N: start with preset scene N (0..3; Down cycles them); -slow: start with the full
        // (not the fast) bokeh geometry shader (Up toggles it); -noUI: no HUD.
        sample.addExampleOptionWithValues("-preset", 1);
        sample.addExampleOption("-slow");
        sample.addExampleOption("-noUI");
        sample.useImgui();
        sample.useResizableWindow();
        for (let i = 1; i < argc; i++) {
            const arg = Nri.getArg(argc, argv, i);
            if (arg == "-preset" && i + 1 < argc) {
                i++;
                bokeh.presetScene = Math.floor(parseFloat(Nri.getArg(argc, argv, i))) % PRESET_SCENE_COUNT;
            } else if (arg == "-slow") {
                bokeh.useFastShader = false;
            } else if (arg == "-noUI") {
                bokeh.noUI = true;
            }
        }
        bokeh.setPredefinedScene(bokeh.presetScene);
        return bokeh.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return BokehNri.main(argc, argv);
}
