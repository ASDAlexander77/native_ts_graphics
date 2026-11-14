/// <reference path="../../core/nri/nri_interop.d.ts" />
import { NriFrameRing } from "../../core/nri_frame_ring";
import { NriSwapChain } from "../../core/nri_swap_chain";
import { SdkMesh } from "../../core/sdk_mesh";
import { transpose, inverse, cross3, dot3, normalize3, multiplyF32 } from "../../core/matrix";
import { formatFixed } from "../../core/text_format";
import { Nri, NriAccelerationStructure, NriBlasDesc, NriBuffer, NriCommandBuffer, NriDescriptor, NriDescriptorPool, NriDescriptorSet, NriDevice, NriFile, NriImgui, NriImguiFont, NriPipeline, NriPipelineDesc, NriPipelineLayout, NriPipelineLayoutDesc, NriQueue, NriRandomEngine, NriRayTracingPipelineDesc, NriSample, NriShaderTable, NriTexture, NriTopLevelAS } from "../../core/nri";

namespace RaytracingAoNri {
    // raytracing_ao, rendered with NRI (NVIDIA Rendering Interface) and NRIFramework instead of Donut
    // and NVRHI: the same shaders (raytracing_ao.hlsl's library, the G-buffer and SSAO passes), through
    // the NRI calls core/nri/nri_interop.d.ts binds, with NRIFramework's ImGui drawing the sample's
    // HUD as Donut's does. This example creates everything it runs, and does the rendering.

    // Test mode: the frames rendered.
    const TEST_FRAMES = 120;
    // core/test_check.ts' TEST_SKIPPED (CTest's SKIP_RETURN_CODE): no ray tracing.
    const TEST_SKIPPED = 77;

    const WINDOW_TITLE = "NRI Example: Raytracing AO";
    const MEDIA_DIR = "media/raytracing_ao/";
    const FONT_PATH = "media/fonts/OpenSans/OpenSans-Regular.ttf";
    // The sample's SegoeUI_18 sprite font, its lines (and measured strings) 32 pixels high. ImGui
    // sizes a font by its ascent + descent (1.3618 OpenSans ems), so the 23 pixel em that gives its
    // strings' widths is 31.5.
    const FONT_SIZE = 31.5;
    const LINE_SPACING = 31.921875;

    // RaytracingAOPC12.cpp.
    const MESH_FILES = ["Dragon.sdkmesh", "Maze1.sdkmesh"];
    const CAM_STEP = 0.1;
    const INITIAL_RADIUS = -20.0;

    // GlobalSharedHlslCompat.h, AORaytracingHlslCompat.h, SSAOHlslCompat.h.
    const NEAR_PLANE = 1.0;
    const FAR_PLANE = 200.0;
    const NOISE_W = 100.0;
    const MAX_OCCLUSION_RAYS = 225;
    const NUM_BUFFERS = 4;
    // The vertices: position, normal, texture coordinates, tangent.
    const VERTEX_STRIDE = 44;

    // SceneConstantBuffer, in floats: worldView, worldViewProjection, projectionToWorld (each
    // transposed), cameraPosition, frustumPoint, frustumHDelta, frustumVDelta, noiseTile.
    const SCENE_FLOATS = 68;
    const SCENE_CAMERA = 48;
    // The SSAO dispatches' constants, a 256-byte slice each: SSAORenderConstantBuffer for the four
    // atlas (tiled) and four downsized (high quality) dispatches, BlurAndUpscaleConstantBuffer for
    // the four blur and upsample ones.
    const SSAO_SLICE_FLOATS = 64;
    const SSAO_TILED_SLICE = 0;
    const SSAO_HIGH_QUALITY_SLICE = 4;
    const SSAO_BLUR_SLICE = 8;
    const SSAO_SLICES = 12;

    // A frame in flight's constants, one host buffer region each (constant buffer views 256-byte
    // aligned and sized): the scene's, AO's sample table (its 3600 bytes rounded up) and options, the
    // SSAO slices.
    const SCENE_CB_OFFSET = 0;
    const SCENE_CB_SIZE = 512;
    const AO_RAYS_CB_OFFSET = 512;
    const AO_RAYS_CB_SIZE = 3840;
    const AO_OPTIONS_CB_OFFSET = 4352;
    const AO_OPTIONS_CB_SIZE = 256;
    const SSAO_CB_OFFSET = 4608;
    const SSAO_SLICE_SIZE = 256;
    const FRAME_CB_SIZE = 7680;
    // MaterialConstantBuffer: 48 bytes in a 256-byte buffer.
    const MATERIAL_CB_SIZE = 256;

    // AO's ray tracing pipeline: a float4 payload, the triangles' barycentrics, recursion depth 2;
    // its groups in the order they're added.
    const PAYLOAD_SIZE = 16;
    const ATTRIBUTE_SIZE = 8;
    const MAX_RECURSION_DEPTH = 2;
    const RAYGEN_GROUP = 0;
    const MISS_GROUP = 1;
    const BOUNCE_MISS_GROUP = 2;
    const HIT_GROUP = 3;
    const BOUNCE_HIT_GROUP = 4;

    // Menus.h: the lighting model shown when not split.
    enum LightingMode {
        Ao = 0,
        Ssao = 1
    }
    const LIGHTING_MODEL_COUNT = 2;
    const MENU_LINE_THICKNESS = 20.0;
    const MENU_BORDER = 20.0;

    // ATG::Colors.
    const OFF_WHITE = 0.635294139;
    const WHITE = 0.980392158;
    const DARK_GREY = 0.200000003;
    const GREEN = [0.062745102, 0.486274511, 0.062745102];
    const ORANGE = [0.764705896, 0.176470593, 0.019607844];

    // The sample updates once per frame (its timer isn't fixed-step): its per-frame steps are
    // scaled to the frame's time at 60 Hz here.
    const STEPS_PER_SECOND = 60.0;

    // GLFW's key codes (Donut's Key) of the sample's controls.
    const KEY_SPACE = 32;
    const KEY_A = 65;
    const KEY_D = 68;
    const KEY_F = 70;
    const KEY_R = 82;
    const KEY_S = 83;
    const KEY_TAB = 258;
    const KEY_RIGHT = 262;
    const KEY_LEFT = 263;
    const KEY_DOWN = 264;
    const KEY_UP = 265;
    const KEY_F1 = 290;
    // The keys whose presses (and Left / Right's releases) act, watched for their changes.
    const WATCHED_KEYS = [KEY_SPACE, KEY_S, KEY_F1, KEY_TAB, KEY_F, KEY_UP, KEY_DOWN, KEY_LEFT, KEY_RIGHT, KEY_R];

    // Donut's blit constants (shaders/framework's BlitConstants: the whole source into the whole
    // target, sharpenFactor 0).
    const BLIT_CONSTANTS: f32[] = [0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0];

    // The callbacks given to C++, kept for as long as it may call them.
    let retainedInitializeCallbacks: NriInitializeCallback[] = [];
    let retainedFrameCallbacks: NriFrameCallback[] = [];

    // GeneralHelper.h's GetNumGrps.
    function numGroups(size: int, threads: int): int {
        return Math.floor((size + threads - 1) / threads);
    }

    // min(max(value, lo), hi) (tslang's Math.max is wrong for negative numbers).
    function clamp(value: number, lo: number, hi: number) {
        if (value < lo) {
            return lo;
        }
        if (value > hi) {
            return hi;
        }
        return value;
    }

    // --- DirectXMath, row-major for mul(vector, matrix) --------------------------------------

    // XMVector4Transform of (x, y, z, w).
    function transform4(v: number[], m: number[]) {
        let r: number[] = [];
        for (let column = 0; column < 4; column++) {
            r.push(Math.fround(v[0] * m[column] + v[1] * m[4 + column] + v[2] * m[8 + column] + v[3] * m[12 + column]));
        }
        return r;
    }

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
        const height = Math.fround(Math.cos(0.5 * fovY) / Math.sin(0.5 * fovY));
        const width = Math.fround(height / aspect);
        const range = Math.fround(farZ / (farZ - nearZ));
        return [width, 0.0, 0.0, 0.0, 0.0, height, 0.0, 0.0, 0.0, 0.0, range, 1.0, 0.0, 0.0, Math.fround(-range * nearZ), 0.0];
    }

    // --- Menus.h's Option ---------------------------------------------------------------------

    // A menu value, its bounds and step (the sample's float literals, held as doubles).
    class Option {
        start: number;
        current: number;
        min: number;
        max: number;
        inc: number;
        isInt: boolean;

        constructor(start: number, min: number, max: number, inc: number, isInt: boolean) {
            this.start = Math.fround(start);
            this.current = this.start;
            this.min = Math.fround(min);
            this.max = Math.fround(max);
            this.inc = Math.fround(inc);
            this.isInt = isInt;
        }

        increment() {
            const previous = this.current;
            this.current = clamp(this.current + this.inc, this.min, this.max);
            return previous != this.current;
        }

        decrement() {
            const previous = this.current;
            this.current = clamp(this.current - this.inc, this.min, this.max);
            return previous != this.current;
        }

        isLowerLimit() {
            return this.current == this.min;
        }

        isUpperLimit() {
            return this.current == this.max;
        }

        reset() {
            this.current = this.start;
        }

        value() {
            return this.current;
        }
    }

    // --- Textures and their states ------------------------------------------------------------

    // A texture the frame writes and reads, its views (a storage view for compute or ray generation
    // shaders to write, a shader resource view, attachment views), and the state the frame's
    // barriers last left it in.
    class Target {
        storageView: NriDescriptor | null = null;
        readView: NriDescriptor | null = null;
        attachment: NriDescriptor | null = null;

        constructor(public texture: NriTexture, public state: NriTextureState) {
        }

        // Moves it to state (if it isn't there already).
        use(commandBuffer: NriCommandBuffer, state: NriTextureState) {
            if (this.state != state) {
                commandBuffer.textureBarrier(this.texture, this.state, state);
                this.state = state;
            }
        }

        destroy() {
            const storageView = this.storageView;
            if (storageView) {
                storageView.destroy();
            }
            const readView = this.readView;
            if (readView) {
                readView.destroy();
            }
            const attachment = this.attachment;
            if (attachment) {
                attachment.destroy();
            }
            this.texture.destroy();
        }
    }

    // --- Meshes -------------------------------------------------------------------------------

    // A SDKMESH file as the sample's Mesh loads it (DirectXTK's Model::CreateFromSDKMESH, the
    // frames' transforms not applied): its one opaque part (32-bit indices, triangle list, the
    // sample's 44-byte vertices; its files have one each), as vertex and index buffers for the
    // G-buffer pass and as raw buffers (stride-4 structured: ByteAddressBuffer) for the hit shader;
    // its material's constants and textures; its BLAS, and a TLAS of one instance of it.
    class Mesh {
        vertexBuffer: NriBuffer | null = null;
        indexBuffer: NriBuffer | null = null;
        rawVertexBuffer: NriBuffer | null = null;
        rawIndexBuffer: NriBuffer | null = null;
        rawVertexView: NriDescriptor | null = null;
        rawIndexView: NriDescriptor | null = null;
        indexCount: int = 0;
        vertexCount: int = 0;
        materialBuffer: NriBuffer | null = null;
        materialView: NriDescriptor | null = null;
        // Its textures and their views (where the material has none, the placeholder's view is used).
        textures: NriTexture[] = [];
        textureViews: NriDescriptor[] = [];
        diffuseView: NriDescriptor | null = null;
        specularView: NriDescriptor | null = null;
        normalView: NriDescriptor | null = null;
        blas: NriAccelerationStructure | null = null;
        topLevelAS: NriTopLevelAS | null = null;
        topLevelASView: NriDescriptor | null = null;

        // A material texture (DirectXTK's EffectTextureFactory: DDS files as they are), or the
        // placeholder for none; null if it can't be loaded.
        loadTexture(device: NriDevice, queue: NriQueue, name: string, placeholder: NriDescriptor): NriDescriptor | null {
            // (Wrappers of their own, destroying nothing: the views stay the placeholder's owner's and
            // textureViews'.)
            if (name == "") {
                return new NriDescriptor(placeholder.handle);
            }
            const texture = device.loadDdsTexture(queue, MEDIA_DIR + name, 0);
            if (!texture) {
                console.log(`Cannot load the material's texture ${name}`);
                return null;
            }
            this.textures.push(texture);
            const view = texture.createView(texture.getFormat());
            const result = new NriDescriptor(view.handle);
            this.textureViews.push(view);
            return result;
        }

        // False (after printing why) on failure.
        load(device: NriDevice, queue: NriQueue, file: string, placeholder: NriDescriptor) {
            const binaryFile = NriFile.load(MEDIA_DIR + file);
            if (!binaryFile) {
                return false;
            }
            const mesh = SdkMesh.load(binaryFile.getData(), binaryFile.getSize());
            if (mesh.isNull()) {
                binaryFile.destroy();
                return false;
            }

            // Mesh::Mesh's checks.
            let ok = true;
            if (mesh.getMeshCount() != 1 || mesh.getMeshSubsetCount(0) != 1) {
                console.log(`${file}: the port takes meshes of one part`);
                ok = false;
            }
            const subset = mesh.getMeshSubset(0, 0);
            const vb = mesh.getMeshVertexBuffer(0);
            const ib = mesh.getMeshIndexBuffer(0);
            if (!mesh.isIndexBuffer32Bit(ib)) {
                console.log(`${file}: Only 32bit unsigned int indices can be used for this sample.`);
                ok = false;
            }
            if (mesh.getSubsetPrimitiveType(subset) != 0) {
                console.log(`${file}: Only triangle lists are supported for this sample.`);
                ok = false;
            }
            if (mesh.getVertexBufferStride(vb) != VERTEX_STRIDE) {
                console.log(`${file}: Vertex format does not mach that of the sample.`);
                ok = false;
            }

            const vertexData = mesh.getVertexBufferData(vb);
            const vertexSize = mesh.getVertexBufferSize(vb);
            const indexData = mesh.getIndexBufferData(ib);
            const indexSize = mesh.getIndexBufferSize(ib);
            this.vertexBuffer = device.createUploadedBufferFromPointer(queue, vertexData, vertexSize, NriBufferUsage.VertexBuffer);
            this.indexBuffer = device.createUploadedBufferFromPointer(queue, indexData, indexSize, NriBufferUsage.IndexBuffer);
            const rawVertexBuffer = device.createUploadedStructuredBufferFromPointer(queue, vertexData, vertexSize, 4);
            const rawIndexBuffer = device.createUploadedStructuredBufferFromPointer(queue, indexData, indexSize, 4);
            this.rawVertexBuffer = rawVertexBuffer;
            this.rawIndexBuffer = rawIndexBuffer;
            if (!this.vertexBuffer || !this.indexBuffer || !rawVertexBuffer || !rawIndexBuffer) {
                console.log(`${file}: cannot create its buffers`);
                mesh.destroy();
                binaryFile.destroy();
                return false;
            }
            this.rawVertexView = rawVertexBuffer.createStructuredView(0);
            this.rawIndexView = rawIndexBuffer.createStructuredView(0);
            this.indexCount = mesh.getSubsetIndexCount(subset);
            this.vertexCount = mesh.getSubsetVertexCount(subset);

            // DirectXTK's InitMaterial (material colors not sRGB) into MaterialConstantBuffer:
            // ambient, isDiffuseTexture, diffuse, isSpecularTexture, specular, isNormalTexture.
            const material = mesh.getSubsetMaterial(subset);
            const colors: f32[] = [];
            for (let i = 0; i < 17; i++) {
                colors.push(0.0);
            }
            mesh.copyMaterialColors(material, Ref(colors[0]));
            const constants: f32[] = [];
            for (let i = 0; i < 12; i++) {
                constants.push(0.0);
            }
            let uninitialized = true;
            for (let i = 0; i < 8; i++) {
                if (colors[i] != 0.0) {
                    uninitialized = false;
                }
            }
            if (uninitialized) {
                // SDKMESH material color block is uninitalized; assume defaults
                constants[4] = 1.0;
                constants[5] = 1.0;
                constants[6] = 1.0;
            } else {
                for (let i = 0; i < 3; i++) {
                    constants[i] = colors[4 + i];
                    constants[4 + i] = colors[i];
                    if (colors[16] > 0.0) {
                        constants[8 + i] = colors[8 + i];
                    }
                }
            }
            const diffuseName = mesh.getMaterialTexture(material, 0);
            const specularName = mesh.getMaterialTexture(material, 2);
            const normalName = mesh.getMaterialTexture(material, 1);
            Nri.storeInt32(Ref(constants[3]), diffuseName != "" ? 1 : 0);
            Nri.storeInt32(Ref(constants[7]), specularName != "" ? 1 : 0);
            Nri.storeInt32(Ref(constants[11]), normalName != "" ? 1 : 0);
            const materialBuffer = device.createHostBuffer(MATERIAL_CB_SIZE, NriBufferUsage.ConstantBuffer);
            this.materialBuffer = materialBuffer;
            if (!materialBuffer) {
                ok = false;
            } else {
                materialBuffer.write(0, Ref(constants[0]), 48);
                this.materialView = materialBuffer.createConstantView(0, MATERIAL_CB_SIZE);
            }

            this.diffuseView = this.loadTexture(device, queue, diffuseName, placeholder);
            this.specularView = this.loadTexture(device, queue, specularName, placeholder);
            this.normalView = this.loadTexture(device, queue, normalName, placeholder);
            if (!this.diffuseView || !this.specularView || !this.normalView) {
                ok = false;
            }

            // AO::BuildAccelerationStructures: opaque geometry, preferring fast tracing; its one
            // instance (identity transform, mask 1), built once.
            const blasDesc = NriBlasDesc.create();
            blasDesc.addTrianglesFromPointer(vertexData, this.vertexCount, VERTEX_STRIDE, indexData, this.indexCount);
            const blas = device.buildBlasFromDesc(queue, blasDesc, NriAccelerationStructureFlags.PreferFastTrace);
            blasDesc.destroy();
            this.blas = blas;
            mesh.destroy();
            binaryFile.destroy();
            if (!blas) {
                console.log(`${file}: cannot build its bottom level acceleration structure`);
                return false;
            }
            const topLevelAS = device.createTopLevelAS(1, NriAccelerationStructureFlags.PreferFastTrace, 1);
            this.topLevelAS = topLevelAS;
            if (!topLevelAS) {
                console.log(`${file}: cannot create its top level acceleration structure`);
                return false;
            }
            const transform: f32[] = [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0];
            topLevelAS.addInstance(blas, Ref(transform[0]), 0, 1, 0, 0);
            if (queue.buildTopLevelAS(topLevelAS) == 0) {
                console.log(`${file}: cannot build its top level acceleration structure`);
                return false;
            }
            this.topLevelASView = topLevelAS.getTopLevelAccelerationStructure().createDescriptor();
            return ok;
        }

        destroy() {
            const views = [this.rawVertexView, this.rawIndexView, this.materialView, this.topLevelASView];
            for (const view of views) {
                if (view) {
                    view.destroy();
                }
            }
            for (const view of this.textureViews) {
                view.destroy();
            }
            for (const texture of this.textures) {
                texture.destroy();
            }
            const buffers = [this.vertexBuffer, this.indexBuffer, this.rawVertexBuffer, this.rawIndexBuffer, this.materialBuffer];
            for (const buffer of buffers) {
                if (buffer) {
                    buffer.destroy();
                }
            }
            const topLevelAS = this.topLevelAS;
            if (topLevelAS) {
                topLevelAS.destroy();
            }
            const blas = this.blas;
            if (blas) {
                blas.destroy();
            }
        }
    }

    // A frame in flight's own data: the views of its constants.
    class QueuedFrame {
        sceneView: NriDescriptor | null = null;
        aoRaysView: NriDescriptor | null = null;
        aoOptionsView: NriDescriptor | null = null;
        ssaoViews: NriDescriptor[] = [];
    }

    // The checks of Donut's TestCheck over pixels read back (0xAABBGGRR).
    class FramePixels {
        constructor(public pixels: int[], public width: int, public height: int) {
        }

        rgb(x: int, y: int) {
            return this.pixels[y * this.width + x] & 0xFFFFFF;
        }

        countSpread(spread: int, gray: boolean, level: int, x: int, y: int, width: int, height: int): int {
            let count = 0;
            for (let j = y; j < y + height; j++) {
                for (let i = x; i < x + width; i++) {
                    const p = this.rgb(i, j);
                    const r = p & 0xFF;
                    const g = (p >> 8) & 0xFF;
                    const b = (p >> 16) & 0xFF;
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
                    if (gray ? (high - low < spread && low >= level) : (high - low >= spread)) {
                        count++;
                    }
                }
            }
            return count;
        }

        share(count: int, total: int, min: number, max: number, what: string) {
            const percent = 100.0 * count / total;
            console.log(`${what}: ${percent}% (${count} of ${total} pixels)`);
            if (percent < min || percent > max) {
                return `${what}: ${percent}% of the pixels, not ${min}% to ${max}%`;
            }
            return "";
        }
    }

    // -test: checks the last frame, as the Donut example does. The bottom corners are the blue
    // background; the gray dragon fills about half of each side, SSAO's on the left and ray traced
    // AO's on the right.
    function checkFrame(pixels: int[], width: int, height: int) {
        if (pixels.length == 0) {
            return "cannot read the back buffer";
        }
        const check = new FramePixels(pixels, width, height);
        if (check.rgb(0, height - 1) != 0x663300 || check.rgb(width - 1, height - 1) != 0x663300) {
            return "the bottom corners aren't the blue background";
        }
        const half: int = Math.floor(width / 2);
        const left = check.share(check.countSpread(12, true, 61, 0, 0, half, height), half * height, 30.0, 75.0, "Dragon, SSAO");
        if (left != "") {
            return left;
        }
        return check.share(check.countSpread(12, true, 61, half, 0, half, height), half * height, 30.0, 75.0, "Dragon, ray traced AO");
    }

    // --- The sample ---------------------------------------------------------------------------

    // Port of the Xbox ATG RaytracingAO_PC12 sample (as examples/raytracing_ao.ts ports it) to NRI:
    // ambient occlusion by ray tracing beside screen-space ambient occlusion, on a dragon or a maze.
    //
    // AO (AO.cpp, raytracing_ao.hlsl): a primary ray per pixel; at each hit numSamples^2 rays in a
    // hemisphere around the (normal-mapped) normal, from a stratified uniform or cosine sample table
    // made on the CPU with std::mt19937 seeded 0, turned by a per-pixel random tangent frame; the
    // occlusion darkens the material's diffuse color. SSAO (SSAO.cpp, MiniEngine's SSAO): a G-buffer
    // of normals, diffuse color and depth; the depth linearized, downsampled to 1/2 .. 1/16 and
    // deinterleaved into 16-slice atlases (the normals likewise); SSAO at each resolution, from the
    // atlases and from the downsampled buffers; blurred and bilaterally upsampled level by level;
    // then times the diffuse color. Split, SSAO renders the left half and AO the right, each at
    // half the width (the sample's projection then has half the aspect ratio).
    //
    // The output textures are RGBA8_UNORM and are blitted into the swap chain texture as the Donut
    // example's are (Donut's blit shaders), the HUD (ImGui) over them.
    class RaytracingAoSample {
        private device: NriDevice | null = null;
        private queue: NriQueue;
        private frames: NriFrameRing = new NriFrameRing();
        private swapChain: NriSwapChain = new NriSwapChain();
        private swapChainFormat: NriFormat = NriFormat.Unknown;
        private queuedFrames: QueuedFrame[] = [];
        private unsupportedReason: string = "";
        private shaderFolder: string = "";

        private meshes: Mesh[] = [];
        private placeholderTexture: NriTexture | null = null;
        private placeholderView: NriDescriptor | null = null;
        private pointWrapSampler: NriDescriptor | null = null;
        private linearClampSampler: NriDescriptor | null = null;
        private pointClampSampler: NriDescriptor | null = null;
        private frameConstantBuffer: NriBuffer | null = null;
        private sceneConstants: f32[] = [];
        private aoRays: f32[] = [];
        private aoOptions: f32[] = [0.0, 0.0, 0.0, 0.0];
        private ssaoConstants: f32[] = [];
        private sampleThickness: number[] = [];

        private aoLayout: NriPipelineLayout | null = null;
        private gbufferLayout: NriPipelineLayout | null = null;
        private prepare1Layout: NriPipelineLayout | null = null;
        private prepare2Layout: NriPipelineLayout | null = null;
        private renderLayout: NriPipelineLayout | null = null;
        private blurBlendOutLayout: NriPipelineLayout | null = null;
        private blurLayout: NriPipelineLayout | null = null;
        private compositeLayout: NriPipelineLayout | null = null;
        private blitLayout: NriPipelineLayout | null = null;
        private aoPipeline: NriPipeline | null = null;
        private shaderTable: NriShaderTable | null = null;
        private gbufferPipeline: NriPipeline | null = null;
        private prepare1Pipeline: NriPipeline | null = null;
        private prepare2Pipeline: NriPipeline | null = null;
        private render1Pipeline: NriPipeline | null = null;
        private render2Pipeline: NriPipeline | null = null;
        private blurPreMinBlendOutPipeline: NriPipeline | null = null;
        private blurPreMinPipeline: NriPipeline | null = null;
        private compositePipeline: NriPipeline | null = null;
        private blitPipeline: NriPipeline | null = null;
        private blitConstants: f32[] = [];
        private imgui: boolean = false;
        private font: NriImguiFont | null = null;

        // Made for the output's size (the frame's, half its width when split).
        private outputWidth: int = 0;
        private outputHeight: int = 0;
        private targets: Target[] = [];
        private aoOutput: Target | null = null;
        private ssaoOutput: Target | null = null;
        private gbufferNormals: Target | null = null;
        private gbufferDiffuse: Target | null = null;
        private gbufferDepth: Target | null = null;
        private clearGBuffer: boolean = false;
        private linearDepth: Target | null = null;
        private depthDownsize: Target[] = [];
        private depthTiled: Target[] = [];
        private normalDownsize: Target[] = [];
        private normalTiled: Target[] = [];
        private merged: Target[] = [];
        private smooth: Target[] = [];
        private highQuality: Target[] = [];
        private ssao: Target | null = null;
        private bufferWidth: int[] = [];
        private bufferHeight: int[] = [];
        private descriptorPool: NriDescriptorPool | null = null;
        // Per frame in flight: a set per mesh (AO, G-buffer), per level (SSAO's render passes,
        // blurs); framesets[queued frame * count + index].
        private aoSets: NriDescriptorSet[] = [];
        private gbufferSets: NriDescriptorSet[] = [];
        private render1Sets: NriDescriptorSet[] = [];
        private render2Sets: NriDescriptorSet[] = [];
        private blurSets: NriDescriptorSet[] = [];
        private prepare1Set: NriDescriptorSet | null = null;
        private prepare2Set: NriDescriptorSet | null = null;
        private compositeSet: NriDescriptorSet | null = null;
        private blitSsaoSet: NriDescriptorSet | null = null;
        private blitAoSet: NriDescriptorSet | null = null;

        frameWidth: int = 1280;
        frameHeight: int = 720;
        fps: int = 0;
        private fpsFrames: int = 0;
        private fpsTime: number = 0.0;

        // The sample's state (Sample and Menus).
        meshIndex: int = 0;
        isSplit: boolean = true;
        radius: number = INITIAL_RADIUS;
        lightingModel: LightingMode = LightingMode.Ao;
        showFPS: boolean = true;
        showHelp: boolean = false;
        selection: int = 0;
        private delta: number = 0.0;
        private updateOptions: boolean = true;
        aoDistance: Option;
        aoFalloff: Option;
        aoNumSamples: Option;
        aoSampleType: Option;
        ssaoNoiseFilterTolerance: Option;
        ssaoBlurTolerance: Option;
        ssaoUpsampleTolerance: Option;
        ssaoNormalMultiply: Option;
        options: Option[];
        // The keys of WATCHED_KEYS down last frame (1), or not (0).
        private keysDown: int[] = [];

        // The HUD's menu lines and colors (Menus::DrawMainMenu).
        private menuLines: string[] = [];
        private menuColors: number[] = [];
        private menuIndex: int = 0;

        // -test: the last frame is read back into readbackBuffer, rows rowPitch bytes apart.
        private test: boolean = false;
        private readbackBuffer: NriBuffer | null = null;
        private rowPitch: int = 0;

        constructor(private sample: NriSample) {
            for (let i = 0; i < SCENE_FLOATS; i++) {
                this.sceneConstants.push(0.0);
            }
            for (let i = 0; i < MAX_OCCLUSION_RAYS * 4; i++) {
                this.aoRays.push(0.0);
            }
            for (let i = 0; i < SSAO_SLICE_FLOATS * SSAO_SLICES; i++) {
                this.ssaoConstants.push(0.0);
            }
            for (const value of BLIT_CONSTANTS) {
                this.blitConstants.push(value);
            }
            for (let i = 0; i < WATCHED_KEYS.length; i++) {
                this.keysDown.push(0);
            }
            // SSAO::SSAO: the sample thicknesses.
            const offsets = [0.2, 0.0, 0.4, 0.0, 0.6, 0.0, 0.8, 0.0, 0.2, 0.2, 0.2, 0.4, 0.2, 0.6, 0.2, 0.8, 0.4, 0.4, 0.4, 0.6,
                0.4, 0.8, 0.6, 0.6];
            for (let i = 0; i < 12; i++) {
                const a = Math.fround(offsets[i * 2]);
                const b = Math.fround(offsets[i * 2 + 1]);
                const value = Math.fround(Math.fround(1.0 - Math.fround(a * a)) - Math.fround(b * b));
                this.sampleThickness.push(Math.fround(Math.sqrt(value)));
            }
            // Menus.h
            this.aoDistance = new Option(10.0, 0.1, 10000.0, 0.1, false);
            this.aoFalloff = new Option(0.0, -10.0, 10.0, 0.1, false);
            this.aoNumSamples = new Option(12.0, 1.0, 15.0, 1.0, true);
            this.aoSampleType = new Option(0.0, 0.0, 1.0, 1.0, true);
            this.ssaoNoiseFilterTolerance = new Option(-3.0, -8.0, 0.0, 0.1, false);
            this.ssaoBlurTolerance = new Option(-5.0, -8.0, -1.0, 0.1, false);
            this.ssaoUpsampleTolerance = new Option(-7.0, -12.0, -1.0, 0.1, false);
            this.ssaoNormalMultiply = new Option(1.0, 0.0, 5.0, 0.125, false);
            this.options = [this.aoDistance, this.aoFalloff, this.aoNumSamples, this.aoSampleType, this.ssaoNoiseFilterTolerance,
                this.ssaoBlurTolerance, this.ssaoUpsampleTolerance, this.ssaoNormalMultiply];
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

        // Sample::CreateDeviceDependentResources, AO::Setup, SSAO::Setup.
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

            // The sample's back buffers (UNORM: its outputs blitted as they are).
            const queuedFrameNum = this.sample.getQueuedFrameNum();
            this.swapChain.init(this.sample, device, this.queue, false);
            this.sizeToSwapChain();
            this.frames.init(device, this.queue, queuedFrameNum);
            for (let i = 0; i < queuedFrameNum; i++) {
                this.queuedFrames.push(new QueuedFrame());
            }

            // Ray tracing pipelines: D3D12 or Vulkan (the Donut example's shaders have no DXBC).
            if (graphicsAPI == NriGraphicsAPI.D3D11) {
                this.unsupportedReason = "This example needs ray tracing: D3D12 or Vulkan";
                return 0;
            }
            if (device.isFeatureSupported(NriFeature.RayTracing) == 0) {
                this.unsupportedReason = "The graphics device doesn't support ray tracing pipelines";
                return 0;
            }
            this.shaderFolder = graphicsAPI == NriGraphicsAPI.D3D12 ? "dxil" : "spirv";

            // The samplers: point wrap (AO's noise), linear clamp, point clamp (Donut's common ones).
            this.pointWrapSampler = device.createSampler(NriFilter.Nearest, NriAddressMode.Repeat, 1);
            this.linearClampSampler = device.createSampler(NriFilter.Linear, NriAddressMode.ClampToEdge, 1);
            this.pointClampSampler = device.createSampler(NriFilter.Nearest, NriAddressMode.ClampToEdge, 1);

            if (!this.createLayouts(device) || !this.createPipelines(device)) {
                return 0;
            }

            // Each frame in flight's constants.
            const frameConstantBuffer = device.createHostBuffer(FRAME_CB_SIZE * queuedFrameNum, NriBufferUsage.ConstantBuffer);
            this.frameConstantBuffer = frameConstantBuffer;
            if (!frameConstantBuffer) {
                console.log("Cannot create the constant buffers");
                return 0;
            }
            for (let i = 0; i < queuedFrameNum; i++) {
                const queuedFrame = this.queuedFrames[i];
                const base = i * FRAME_CB_SIZE;
                queuedFrame.sceneView = frameConstantBuffer.createConstantView(base + SCENE_CB_OFFSET, SCENE_CB_SIZE);
                queuedFrame.aoRaysView = frameConstantBuffer.createConstantView(base + AO_RAYS_CB_OFFSET, AO_RAYS_CB_SIZE);
                queuedFrame.aoOptionsView = frameConstantBuffer.createConstantView(base + AO_OPTIONS_CB_OFFSET, AO_OPTIONS_CB_SIZE);
                for (let s = 0; s < SSAO_SLICES; s++) {
                    const view = frameConstantBuffer.createConstantView(base + SSAO_CB_OFFSET + s * SSAO_SLICE_SIZE, SSAO_SLICE_SIZE);
                    if (!view) {
                        console.log("Cannot create the constant buffer views");
                        return 0;
                    }
                    queuedFrame.ssaoViews.push(view as NriDescriptor);
                }
                if (!queuedFrame.sceneView || !queuedFrame.aoRaysView || !queuedFrame.aoOptionsView) {
                    console.log("Cannot create the constant buffer views");
                    return 0;
                }
            }

            // Both meshes up front (the sample loads one at a time, Space reloading); a white
            // texture where a material has none (the sample leaves those descriptors unwritten).
            const placeholderTexture = device.createCommittedTexture(1, 1, NriFormat.RGBA8_UNORM);
            this.placeholderTexture = placeholderTexture;
            if (!placeholderTexture) {
                console.log("Cannot create the placeholder texture");
                return 0;
            }
            const white: int[] = [-1];
            this.queue.uploadTexture(placeholderTexture, Ref(white[0]), 4);
            const placeholderView = placeholderTexture.createView(NriFormat.RGBA8_UNORM);
            this.placeholderView = placeholderView;
            let loaded = true;
            for (const meshFile of MESH_FILES) {
                const mesh = new Mesh();
                if (!mesh.load(device, this.queue, meshFile, placeholderView)) {
                    loaded = false;
                }
                this.meshes.push(mesh);
            }
            if (!loaded) {
                console.log("Cannot load the sample's meshes: set XBOX_ATG_SAMPLES_DIR when configuring");
                return 0;
            }

            // The HUD.
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

            if (this.test) {
                const alignment = device.getUploadBufferTextureRowAlignment();
                this.rowPitch = Math.floor((this.frameWidth * 4 + alignment - 1) / alignment) * alignment;
                this.readbackBuffer = device.createReadbackBuffer(this.rowPitch * this.frameHeight);
            }
            return 1;
        }

        // A layout of the description's ranges; null (after printing why) on failure.
        finishLayout(device: NriDevice, desc: NriPipelineLayoutDesc): NriPipelineLayout | null {
            const layout = device.createPipelineLayoutFromDesc(desc);
            desc.destroy();
            if (!layout) {
                console.log("Cannot create the pipeline layouts");
            }
            return layout;
        }

        // The sample's root signatures as each pass uses them (one set each). False on failure.
        createLayouts(device: NriDevice): boolean {
            const rt = NriStage.RayTracing;
            const cs = NriStage.Compute;
            const none = NriRangeFlags.None;

            // AO's global root signature, with its local one's mesh arguments: the output (u0), the
            // scene (t0), the scene's, sample table's, options' and material's constants (b0 to b3),
            // the samplers (s0, s1), the indices and vertices (t1, t2), the textures (t3 to t5).
            const aoDesc = NriPipelineLayoutDesc.create();
            aoDesc.addRange(0, 0, 1, NriDescriptorType.StorageTexture, rt, none);
            aoDesc.addRange(0, 0, 1, NriDescriptorType.AccelerationStructure, rt, none);
            aoDesc.addRange(0, 0, 4, NriDescriptorType.ConstantBuffer, rt, none);
            aoDesc.addRange(0, 0, 2, NriDescriptorType.Sampler, rt, none);
            aoDesc.addRange(0, 1, 2, NriDescriptorType.StructuredBuffer, rt, none);
            aoDesc.addRange(0, 3, 3, NriDescriptorType.Texture, rt, none);
            this.aoLayout = this.finishLayout(device, aoDesc);

            // The G-buffer pass: the scene's and material's constants (b0, b2), the textures (t0 to
            // t2), linear clamp sampling (s2).
            const gbufferDesc = NriPipelineLayoutDesc.create();
            gbufferDesc.addRange(0, 0, 1, NriDescriptorType.ConstantBuffer, NriStage.VertexPixel, none);
            gbufferDesc.addRange(0, 2, 1, NriDescriptorType.ConstantBuffer, NriStage.VertexPixel, none);
            gbufferDesc.addRange(0, 0, 3, NriDescriptorType.Texture, NriStage.VertexPixel, none);
            gbufferDesc.addRange(0, 2, 1, NriDescriptorType.Sampler, NriStage.VertexPixel, none);
            this.gbufferLayout = this.finishLayout(device, gbufferDesc);

            // SSAO's: the depth preparation passes (t0, t1; u0 to u8, u0 to u7), the render passes
            // (b0, b1, t0, t1, u0, s3), the blurs (b1, s0, t0 to t4 or t3, u0), the composite (t0 to
            // t2, u0).
            const prepare1Desc = NriPipelineLayoutDesc.create();
            prepare1Desc.addRange(0, 0, 2, NriDescriptorType.Texture, cs, none);
            prepare1Desc.addRange(0, 0, 9, NriDescriptorType.StorageTexture, cs, none);
            this.prepare1Layout = this.finishLayout(device, prepare1Desc);
            const prepare2Desc = NriPipelineLayoutDesc.create();
            prepare2Desc.addRange(0, 0, 2, NriDescriptorType.Texture, cs, none);
            prepare2Desc.addRange(0, 0, 8, NriDescriptorType.StorageTexture, cs, none);
            this.prepare2Layout = this.finishLayout(device, prepare2Desc);
            const renderDesc = NriPipelineLayoutDesc.create();
            renderDesc.addRange(0, 0, 2, NriDescriptorType.ConstantBuffer, cs, none);
            renderDesc.addRange(0, 0, 2, NriDescriptorType.Texture, cs, none);
            renderDesc.addRange(0, 0, 1, NriDescriptorType.StorageTexture, cs, none);
            renderDesc.addRange(0, 3, 1, NriDescriptorType.Sampler, cs, none);
            this.renderLayout = this.finishLayout(device, renderDesc);
            for (let b = 0; b < 2; b++) {
                const blurDesc = NriPipelineLayoutDesc.create();
                blurDesc.addRange(0, 1, 1, NriDescriptorType.ConstantBuffer, cs, none);
                blurDesc.addRange(0, 0, 1, NriDescriptorType.Sampler, cs, none);
                blurDesc.addRange(0, 0, b == 0 ? 5 : 4, NriDescriptorType.Texture, cs, none);
                blurDesc.addRange(0, 0, 1, NriDescriptorType.StorageTexture, cs, none);
                if (b == 0) {
                    this.blurBlendOutLayout = this.finishLayout(device, blurDesc);
                } else {
                    this.blurLayout = this.finishLayout(device, blurDesc);
                }
            }
            const compositeDesc = NriPipelineLayoutDesc.create();
            compositeDesc.addRange(0, 0, 3, NriDescriptorType.Texture, cs, none);
            compositeDesc.addRange(0, 0, 1, NriDescriptorType.StorageTexture, cs, none);
            this.compositeLayout = this.finishLayout(device, compositeDesc);

            // Donut's blit: its constants (b0), the source (t0), linear clamp sampling (s0).
            const blitDesc = NriPipelineLayoutDesc.create();
            blitDesc.addRootConstants(0, BLIT_CONSTANTS.length * 4, NriStage.Vertex);
            blitDesc.addRange(0, 0, 1, NriDescriptorType.Texture, NriStage.Pixel, none);
            blitDesc.addRange(0, 0, 1, NriDescriptorType.Sampler, NriStage.Pixel, none);
            this.blitLayout = this.finishLayout(device, blitDesc);

            return !(!this.aoLayout || !this.gbufferLayout || !this.prepare1Layout || !this.prepare2Layout || !this.renderLayout
                || !this.blurBlendOutLayout || !this.blurLayout || !this.compositeLayout || !this.blitLayout);
        }

        // AO::CreateRaytracingPipelineStateObject and BuildShaderTables, SSAO::SetupPipelines, the
        // blit. False (after printing why) on failure.
        createPipelines(device: NriDevice): boolean {
            const aoLayout = this.aoLayout;
            const gbufferLayout = this.gbufferLayout;
            const prepare1Layout = this.prepare1Layout;
            const prepare2Layout = this.prepare2Layout;
            const renderLayout = this.renderLayout;
            const blurBlendOutLayout = this.blurBlendOutLayout;
            const blurLayout = this.blurLayout;
            const compositeLayout = this.compositeLayout;
            const blitLayout = this.blitLayout;
            if (!aoLayout || !gbufferLayout || !prepare1Layout || !prepare2Layout || !renderLayout || !blurBlendOutLayout || !blurLayout
                || !compositeLayout || !blitLayout) {
                return false;
            }
            const folder = `shaders/raytracing_ao/${this.shaderFolder}/`;

            // AO: a float4 payload, recursion depth 2; the primary and bounce entries (geometry stride
            // 2) of the one part.
            const rtDesc = NriRayTracingPipelineDesc.create();
            rtDesc.addGroup(rtDesc.addShader(NriStage.RayGen, "AORaygenShader"), -1, -1);
            rtDesc.addGroup(rtDesc.addShader(NriStage.Miss, "AOMissShader"), -1, -1);
            rtDesc.addGroup(rtDesc.addShader(NriStage.Miss, "AOBounceMissShader"), -1, -1);
            rtDesc.addGroup(rtDesc.addShader(NriStage.ClosestHit, "AOClosestHitShader"),
                -1, -1);
            rtDesc.addGroup(rtDesc.addShader(NriStage.ClosestHit,
                "AOBounceClosestHitShader"), -1, -1);
            const aoPipeline = device.createRayTracingPipelineFromDesc(aoLayout, `${folder}raytracing_ao.bin`, rtDesc, PAYLOAD_SIZE,
                ATTRIBUTE_SIZE, MAX_RECURSION_DEPTH);
            rtDesc.destroy();
            this.aoPipeline = aoPipeline;
            if (!aoPipeline) {
                console.log("Cannot initialize the ray tracing pipeline");
                return false;
            }
            const missGroups: int[] = [MISS_GROUP, BOUNCE_MISS_GROUP];
            const hitGroups: int[] = [HIT_GROUP, BOUNCE_HIT_GROUP];
            this.shaderTable = device.createShaderTableFromGroups(this.queue, aoPipeline, RAYGEN_GROUP, Ref(missGroups[0]),
                missGroups.length, Ref(hitGroups[0]), hitGroups.length);
            if (!this.shaderTable) {
                console.log("Cannot create the shader table");
                return false;
            }

            // The G-buffer pass: the vertices, depth tested (less) and written, back faces culled,
            // normals and diffuse color (R11G11B10) out.
            const gbufferDesc = NriPipelineDesc.create();
            let loaded = gbufferDesc.addShader(NriShaderStage.Vertex, `${folder}raytracing_ao_gbuffer_gbuffer_vs.bin`,
                "gbuffer_vs") != 0;
            if (loaded) {
                loaded = gbufferDesc.addShader(NriShaderStage.Pixel, `${folder}raytracing_ao_gbuffer_gbuffer_ps.bin`,
                    "gbuffer_ps") != 0;
            }
            gbufferDesc.addVertexAttribute("POSITION", NriFormat.RGB32_SFLOAT, 0);
            gbufferDesc.addVertexAttribute("NORMAL", NriFormat.RGB32_SFLOAT, 12);
            gbufferDesc.addVertexAttribute("TEXCOORD", NriFormat.RG32_SFLOAT, 24);
            gbufferDesc.addVertexAttribute("TANGENT", NriFormat.RGB32_SFLOAT, 32);
            gbufferDesc.setCullMode(NriCullMode.Back);
            gbufferDesc.setDepthClip(0);
            gbufferDesc.setColor(NriFormat.R11_G11_B10_UFLOAT, NriColorWrite.RGBA);
            gbufferDesc.addColor(NriFormat.R11_G11_B10_UFLOAT, NriColorWrite.RGBA);
            gbufferDesc.setDepth(NriFormat.D32_SFLOAT, NriCompareOp.Less, 1, 0);
            this.gbufferPipeline = loaded ? device.createPipelineFromDesc(gbufferLayout, gbufferDesc) : null;
            gbufferDesc.destroy();

            this.prepare1Pipeline = device.createComputePipeline(prepare1Layout, `${folder}raytracing_ao_ssao_prepare1.bin`, "main");
            this.prepare2Pipeline = device.createComputePipeline(prepare2Layout, `${folder}raytracing_ao_ssao_prepare2.bin`, "main");
            this.render1Pipeline = device.createComputePipelinePermutation(renderLayout, `${folder}raytracing_ao_ssao_render.bin`, "main",
                "INTERLEAVE_RESULT=1");
            this.render2Pipeline = device.createComputePipelinePermutation(renderLayout, `${folder}raytracing_ao_ssao_render.bin`, "main",
                "INTERLEAVE_RESULT=0");
            this.blurPreMinBlendOutPipeline = device.createComputePipelinePermutation(blurBlendOutLayout,
                `${folder}raytracing_ao_ssao_blur.bin`, "main", "BLEND_WITH_HIGHER_RESOLUTION=1");
            this.blurPreMinPipeline = device.createComputePipelinePermutation(blurLayout, `${folder}raytracing_ao_ssao_blur.bin`, "main",
                "BLEND_WITH_HIGHER_RESOLUTION=0");
            this.compositePipeline = device.createComputePipeline(compositeLayout, `${folder}raytracing_ao_ssao_composite.bin`, "main");

            // Donut's blit (shaders/framework's rect_vs and blit_ps) into the swap chain texture.
            const blitFolder = `shaders/framework/${this.shaderFolder}/`;
            const blitDesc = NriPipelineDesc.create();
            let blitLoaded = blitDesc.addShader(NriShaderStage.Vertex, `${blitFolder}rect_vs.bin`, "main") != 0;
            if (blitLoaded) {
                blitLoaded = blitDesc.addShaderPermutation(NriShaderStage.Pixel, `${blitFolder}blit_ps.bin`, "main",
                    "TEXTURE_ARRAY=0") != 0;
            }
            blitDesc.setTopology(NriTopology.TriangleStrip);
            blitDesc.setColor(this.swapChainFormat, NriColorWrite.RGBA);
            this.blitPipeline = blitLoaded ? device.createPipelineFromDesc(blitLayout, blitDesc) : null;
            blitDesc.destroy();

            if (!this.gbufferPipeline || !this.prepare1Pipeline || !this.prepare2Pipeline || !this.render1Pipeline || !this.render2Pipeline
                || !this.blurPreMinBlendOutPipeline || !this.blurPreMinPipeline || !this.compositePipeline || !this.blitPipeline) {
                console.log("Cannot load the raytracing AO shaders");
                return false;
            }
            return true;
        }

        // Waits for the frame that last used this frame's command allocator.
        latencySleep(frameIndex: int) {
            this.frames.wait(frameIndex);
        }

        // Sample::Update's keys and Menus::ProcessKeys (presses, and Left / Right's releases).
        handleKeys() {
            if (this.test) {
                return;
            }
            for (let k = 0; k < WATCHED_KEYS.length; k++) {
                const key = WATCHED_KEYS[k];
                const down = this.sample.isKeyPressed(key) != 0;
                const wasDown = this.keysDown[k] != 0;
                this.keysDown[k] = down ? 1 : 0;
                if (down && !wasDown) {
                    if (key == KEY_SPACE) {
                        this.meshIndex = (this.meshIndex + 1) % MESH_FILES.length;
                    } else if (key == KEY_S) {
                        this.isSplit = !this.isSplit;
                    } else if (key == KEY_F1) {
                        this.showHelp = !this.showHelp;
                    } else if (key == KEY_TAB) {
                        this.lightingModel = (this.lightingModel + 1) % LIGHTING_MODEL_COUNT;
                    } else if (key == KEY_F) {
                        this.showFPS = !this.showFPS;
                    } else if (this.showHelp) {
                        // The sample's option list has a ninth slot that is null (selecting it and
                        // pressing Left or Right would crash it); it selects nothing here.
                        if (key == KEY_UP) {
                            this.selection = (this.selection + 8) % 9;
                        } else if (key == KEY_DOWN) {
                            this.selection = (this.selection + 1) % 9;
                        } else if (key == KEY_LEFT) {
                            this.delta = -1.0;
                        } else if (key == KEY_RIGHT) {
                            this.delta = 1.0;
                        } else if (key == KEY_R) {
                            for (const option of this.options) {
                                option.reset();
                            }
                            this.updateOptions = true;
                        }
                    }
                } else if (!down && wasDown && (key == KEY_LEFT || key == KEY_RIGHT)) {
                    this.delta = 0.0;
                }
            }
        }

        // Sample::Update: the camera radius (A / D held), the menu's held Left / Right, the frame
        // rate.
        animate(elapsedSeconds: number) {
            this.handleKeys();
            const steps = elapsedSeconds * STEPS_PER_SECOND;
            if (!this.test && this.sample.isKeyPressed(KEY_A) != 0) {
                this.radius += CAM_STEP * steps;
            } else if (!this.test && this.sample.isKeyPressed(KEY_D) != 0) {
                this.radius -= CAM_STEP * steps;
            }
            // Held, the selected option steps every frame as in the sample (here at most once per
            // 1/60 s: a step can't be split).
            if (this.showHelp && this.delta != 0.0 && this.selection < this.options.length) {
                const option = this.options[this.selection];
                if (this.delta > 0.0 ? option.increment() : option.decrement()) {
                    this.updateOptions = true;
                }
            }

            // StepTimer::GetFramesPerSecond: frames counted over each second.
            this.fpsFrames++;
            this.fpsTime += elapsedSeconds;
            if (this.fpsTime >= 1.0) {
                this.fps = this.fpsFrames;
                this.fpsFrames = 0;
                this.fpsTime -= Math.floor(this.fpsTime);
            }
        }

        // AO::OnOptionUpdate and SSAO::OnOptionUpdate: the AO options and its sample table
        // (Sampler::SetSeed(0), then a stratified sampler of numSamples x numSamples cells).
        applyOptions() {
            const numSamples: int = this.aoNumSamples.value();
            const sampleType: int = this.aoSampleType.value();
            this.aoOptions[0] = this.aoDistance.value();
            this.aoOptions[1] = this.aoFalloff.value();
            Nri.storeInt32(Ref(this.aoOptions[2]), numSamples);
            Nri.storeInt32(Ref(this.aoOptions[3]), sampleType);

            // std::uniform_real_distribution<float>(0, nextafter(1.f)) over std::mt19937(0).
            const engine = NriRandomEngine.create(0);
            const upper = 1.00000011920928955;
            const offset = Math.fround(1.0 / numSamples);
            const twoPi = Math.fround(6.283185307);
            for (let i = 0; i < MAX_OCCLUSION_RAYS * 4; i++) {
                this.aoRays[i] = 0.0;
            }
            for (let i = 0; i < numSamples; i++) {
                for (let j = 0; j < numSamples; j++) {
                    const u = Math.fround(Math.fround(i * offset) + Math.fround(engine.randomUniformFloat(0.0, upper) * offset));
                    const v = Math.fround(Math.fround(j * offset) + Math.fround(engine.randomUniformFloat(0.0, upper) * offset));
                    let x = 0.0;
                    let y = 0.0;
                    let z = 0.0;
                    const phi = Math.fround(v * twoPi);
                    if (sampleType == 0) {
                        // UniformHemiSampler
                        const sintheta = Math.fround(Math.sqrt(u));
                        const cosTheta = Math.fround(Math.sqrt(Math.fround(1.0 - Math.fround(sintheta * sintheta))));
                        x = Math.fround(sintheta * Math.fround(Math.cos(phi)));
                        y = Math.fround(sintheta * Math.fround(Math.sin(phi)));
                        z = cosTheta;
                    } else {
                        // CosineHemiSampler
                        const sintheta = Math.fround(Math.acos(Math.fround(Math.sqrt(u))));
                        x = Math.fround(sintheta * Math.fround(Math.cos(phi)));
                        y = Math.fround(sintheta * Math.fround(Math.sin(phi)));
                        z = Math.fround(Math.sqrt(Math.fround(Math.fround(1.0 - Math.fround(x * x)) - Math.fround(y * y))));
                    }
                    const index = (i * numSamples + j) * 4;
                    this.aoRays[index] = x;
                    this.aoRays[index + 1] = y;
                    this.aoRays[index + 2] = z;
                }
            }
            engine.destroy();
        }

        // The outputs' share of the frame's width: half when split.
        widthScale() {
            const scale = this.isSplit ? 0.5 : 1.0;
            return scale;
        }

        // Sample::UpdateCameraMatrices: the camera on the z axis looking at the origin, the
        // frustum's far corners for SSAO's position reconstruction.
        updateScene(width: int, height: int) {
            const screenWidth = Math.fround(width * this.widthScale());
            const screenHeight = height;
            const eye = [0.0, 0.0, this.radius];
            const view = lookAtLH(eye, [0.0, 0.0, 0.0], [0.0, 1.0, 0.0]);
            const aspectRatio = Math.fround(screenWidth / screenHeight);
            const proj = perspectiveFovLH(Math.fround(45.0 * (Math.PI / 180.0)), aspectRatio, NEAR_PLANE, FAR_PLANE);
            const viewProj = multiplyF32(view, proj);
            const c = this.sceneConstants;
            const worldView = transpose(view);
            const worldViewProjection = transpose(viewProj);
            const projectionToWorld = transpose(inverse(viewProj));
            for (let i = 0; i < 16; i++) {
                c[i] = worldView[i];
                c[16 + i] = worldViewProjection[i];
                c[32 + i] = projectionToWorld[i];
            }
            c[SCENE_CAMERA] = eye[0];
            c[SCENE_CAMERA + 1] = eye[1];
            c[SCENE_CAMERA + 2] = eye[2];
            c[SCENE_CAMERA + 3] = 1.0;

            // BoundingFrustum::CreateFromMatrix(proj): the slopes and far plane from the inverse
            // projection, then GetCorners' 4 (left top far), 6 (right bottom far) and 7 (left
            // bottom far), into world space.
            const invProj = inverse(proj);
            const right = transform4([1.0, 0.0, 1.0, 1.0], invProj);
            const left = transform4([-1.0, 0.0, 1.0, 1.0], invProj);
            const top = transform4([0.0, 1.0, 1.0, 1.0], invProj);
            const bottom = transform4([0.0, -1.0, 1.0, 1.0], invProj);
            const far = transform4([0.0, 0.0, 1.0, 1.0], invProj);
            const rightSlope = Math.fround(right[0] / right[2]);
            const leftSlope = Math.fround(left[0] / left[2]);
            const topSlope = Math.fround(top[1] / top[2]);
            const bottomSlope = Math.fround(bottom[1] / bottom[2]);
            const farZ = Math.fround(far[2] / far[3]);
            const viewToWorld = inverse(view);
            const lowerLeft = transform4([Math.fround(leftSlope * farZ), Math.fround(bottomSlope * farZ), farZ, 1.0], viewToWorld);
            const lowerRight = transform4([Math.fround(rightSlope * farZ), Math.fround(bottomSlope * farZ), farZ, 1.0], viewToWorld);
            const topLeft = transform4([Math.fround(leftSlope * farZ), Math.fround(topSlope * farZ), farZ, 1.0], viewToWorld);
            for (let i = 0; i < 3; i++) {
                c[SCENE_CAMERA + 4 + i] = Math.fround(topLeft[i] - eye[i]);
                c[SCENE_CAMERA + 8 + i] = Math.fround(lowerRight[i] - lowerLeft[i]);
                c[SCENE_CAMERA + 12 + i] = Math.fround(lowerLeft[i] - topLeft[i]);
            }
            // Update's noise tile (unused by the shaders): its height halved too when split.
            c[SCENE_CAMERA + 16] = Math.fround(screenWidth / NOISE_W);
            c[SCENE_CAMERA + 17] = Math.fround(Math.fround(height * this.widthScale()) / NOISE_W);
            return proj;
        }

        // SSAO::UpdateSSAOConstant into a slice of the SSAO constants.
        updateSsaoRenderConstants(slice: int, width: int, height: int, depth: int, tanHalfFovH: number) {
            const base = slice * SSAO_SLICE_FLOATS;
            const c = this.ssaoConstants;
            // The shaders are set up to sample a circular region within a 5-pixel radius.
            const screenspaceDiameter = 10.0;
            let thicknessMultiplier = Math.fround(Math.fround(Math.fround(2.0 * tanHalfFovH) * screenspaceDiameter) / width);
            if (depth == 1) {
                thicknessMultiplier = Math.fround(thicknessMultiplier * 2.0);
            }
            // This will transform a depth value from [0, thickness] to [0, 1].
            const inverseRangeFactor = Math.fround(1.0 / thicknessMultiplier);
            for (let i = 0; i < 12; i++) {
                c[base + i] = Math.fround(inverseRangeFactor / this.sampleThickness[i]);
            }
            const t = this.sampleThickness;
            const weights = [
                Math.fround(4.0 * t[0]), Math.fround(4.0 * t[1]), Math.fround(4.0 * t[2]), Math.fround(4.0 * t[3]),
                Math.fround(4.0 * t[4]), Math.fround(8.0 * t[5]), Math.fround(8.0 * t[6]), Math.fround(8.0 * t[7]),
                Math.fround(4.0 * t[8]), Math.fround(8.0 * t[9]), Math.fround(8.0 * t[10]), Math.fround(4.0 * t[11]),
            ];
            // Not SAMPLE_EXHAUSTIVELY: every other cell.
            weights[0] = 0.0;
            weights[2] = 0.0;
            weights[5] = 0.0;
            weights[7] = 0.0;
            weights[9] = 0.0;
            let netWeight = 0.0;
            for (let i = 0; i < 12; i++) {
                netWeight = Math.fround(netWeight + weights[i]);
            }
            for (let i = 0; i < 12; i++) {
                c[base + 12 + i] = Math.fround(weights[i] / netWeight);
            }
            c[base + 24] = Math.fround(1.0 / width);
            c[base + 25] = Math.fround(1.0 / height);
            const normalToDepthBrightnessEqualize = 2.0;
            c[base + 26] = Math.fround(normalToDepthBrightnessEqualize * Math.fround(this.ssaoNormalMultiply.value()));
        }

        // SSAO::UpdateBlurAndUpsampleConstant into a slice of the SSAO constants.
        updateBlurConstants(slice: int, lowWidth: int, lowHeight: int, highWidth: int, highHeight: int) {
            const base = slice * SSAO_SLICE_FLOATS;
            const c = this.ssaoConstants;
            const screenWidth = this.outputWidth;
            let blurTolerance = Math.fround(1.0 - Math.fround(Math.fround(Math.pow(10.0, Math.fround(this.ssaoBlurTolerance.value())))
                * screenWidth) / lowWidth);
            blurTolerance = Math.fround(blurTolerance * blurTolerance);
            const upsampleTolerance = Math.fround(Math.pow(10.0, Math.fround(this.ssaoUpsampleTolerance.value())));
            const noiseFilterWeight = Math.fround(1.0 / Math.fround(Math.fround(Math.pow(10.0,
                Math.fround(this.ssaoNoiseFilterTolerance.value()))) + upsampleTolerance));
            c[base] = Math.fround(1.0 / lowWidth);
            c[base + 1] = Math.fround(1.0 / lowHeight);
            c[base + 2] = Math.fround(1.0 / highWidth);
            c[base + 3] = Math.fround(1.0 / highHeight);
            c[base + 4] = noiseFilterWeight;
            c[base + 5] = Math.fround(screenWidth / lowWidth);
            c[base + 6] = blurTolerance;
            c[base + 7] = upsampleTolerance;
        }

        // SSAO::OnCameraChanged and UpdateConstants: the dispatches' constants for this output.
        updateSsaoConstants(proj: number[]) {
            // The first element of the projection: the cotangent of half the horizontal FOV.
            const fovTangent = Math.fround(1.0 / proj[0]);
            for (let i = 0; i < NUM_BUFFERS; i++) {
                this.updateSsaoRenderConstants(SSAO_TILED_SLICE + i, this.bufferWidth[i + 2], this.bufferHeight[i + 2], 16, fovTangent);
                this.updateSsaoRenderConstants(SSAO_HIGH_QUALITY_SLICE + i, this.bufferWidth[i], this.bufferHeight[i], 1, fovTangent);
                const highWidth = i == 0 ? this.outputWidth : this.bufferWidth[i - 1];
                const highHeight = i == 0 ? this.outputHeight : this.bufferHeight[i - 1];
                this.updateBlurConstants(SSAO_BLUR_SLICE + i, this.bufferWidth[i], this.bufferHeight[i], highWidth, highHeight);
            }
        }

        // --- The output-sized resources ---------------------------------------------------------

        // A storage texture (in NriTextureState.Storage) with a storage view and a view to read.
        storageTarget(device: NriDevice, width: int, height: int, format: NriFormat): Target | null {
            const texture = device.createStorageTexture(this.queue, width, height, format);
            if (!texture) {
                return null;
            }
            const target = new Target(texture, NriTextureState.Storage);
            target.storageView = texture.createStorageView(format);
            target.readView = texture.createView(format);
            this.targets.push(target);
            return target;
        }

        // A storage texture array of 16 layers (a deinterleaved atlas), in NriTextureState.Storage.
        storageArrayTarget(device: NriDevice, width: int, height: int, format: NriFormat): Target | null {
            const texture = device.createStorageTextureArray(this.queue, width, height, 16, format);
            if (!texture) {
                return null;
            }
            const target = new Target(texture, NriTextureState.Storage);
            target.storageView = texture.createStorageArrayView(format);
            target.readView = texture.createArrayView(format);
            this.targets.push(target);
            return target;
        }

        // A render target (in NriTextureState.ShaderResource) with its attachment view and a view
        // to read.
        renderTarget(device: NriDevice, width: int, height: int, format: NriFormat): Target | null {
            const texture = device.createRenderTargetTexture(this.queue, width, height, format);
            if (!texture) {
                return null;
            }
            const target = new Target(texture, NriTextureState.ShaderResource);
            target.attachment = texture.createColorAttachmentView(format);
            target.readView = texture.createView(format);
            this.targets.push(target);
            return target;
        }

        // The swap chain's size and formats (its views in the textures' format).
        sizeToSwapChain() {
            this.frameWidth = this.swapChain.width();
            this.frameHeight = this.swapChain.height();
            this.swapChainFormat = this.swapChain.format();
        }

        // The window was resized (NriSample.useResizableWindow): once the GPU is done with them, the back
        // buffers made again at its size. The frame resources follow in renderFrame, which remakes
        // them when the output size (from frameWidth x frameHeight) changes.
        resizeIfNeeded() {
            const device = this.device;
            if (!device) {
                return;
            }
            if (!this.swapChain.resized()) {
                return;
            }
            this.swapChain.recreate();
            this.sizeToSwapChain();
        }

        releaseFrameResources() {
            const descriptorPool = this.descriptorPool;
            if (descriptorPool) {
                descriptorPool.destroy();
            }
            this.descriptorPool = null;
            for (const target of this.targets) {
                target.destroy();
            }
            this.targets = [];
            this.aoSets = [];
            this.gbufferSets = [];
            this.render1Sets = [];
            this.render2Sets = [];
            this.blurSets = [];
            this.prepare1Set = null;
            this.prepare2Set = null;
            this.compositeSet = null;
            this.blitSsaoSet = null;
            this.blitAoSet = null;
            this.depthDownsize = [];
            this.depthTiled = [];
            this.normalDownsize = [];
            this.normalTiled = [];
            this.merged = [];
            this.smooth = [];
            this.highQuality = [];
            this.aoOutput = null;
            this.ssaoOutput = null;
            this.gbufferNormals = null;
            this.gbufferDiffuse = null;
            this.gbufferDepth = null;
            this.linearDepth = null;
            this.ssao = null;
            this.outputWidth = 0;
            this.outputHeight = 0;
        }

        // A set of the layout from the frame resources' pool; null (after printing why) on failure.
        allocateSet(layout: NriPipelineLayout | null): NriDescriptorSet | null {
            const descriptorPool = this.descriptorPool;
            if (!descriptorPool || !layout) {
                return null;
            }
            const set = descriptorPool.allocateDescriptorSet(layout, 0, 0);
            if (!set) {
                console.log("Cannot allocate the descriptor sets");
            }
            return set;
        }

        // Puts views into the set's range, from element 0 on.
        updateRange(set: NriDescriptorSet, range: int, views: (NriDescriptor | null)[]) {
            for (let i = 0; i < views.length; i++) {
                const view = views[i];
                if (view) {
                    set.updateDescriptor(range, i, view);
                }
            }
        }

        // AO::CreateRaytracingOutputResource and SSAO::CreateResources / BindResources for an output
        // of width x height, and each pass's sets. False (after printing why) on failure.
        createFrameResources(width: int, height: int): boolean {
            const device = this.device;
            if (!device) {
                return false;
            }
            this.outputWidth = width;
            this.outputHeight = height;
            this.aoOutput = this.storageTarget(device, width, height, NriFormat.RGBA8_UNORM);
            this.ssaoOutput = this.storageTarget(device, width, height, NriFormat.RGBA8_UNORM);
            // The ray generation shader writes it first (the Storage and RayTracingStorage states are
            // the same layout: no barrier between them, which D3D12 would take as the same state).
            const aoOutputCreated = this.aoOutput;
            if (aoOutputCreated) {
                aoOutputCreated.state = NriTextureState.RayTracingStorage;
            }

            // The G-buffer: normals and diffuse color (the sample's two R11G11B10 slices), depth;
            // cleared once (Donut's targets start zeroed; the background is never drawn).
            this.gbufferNormals = this.renderTarget(device, width, height, NriFormat.R11_G11_B10_UFLOAT);
            this.gbufferDiffuse = this.renderTarget(device, width, height, NriFormat.R11_G11_B10_UFLOAT);
            this.clearGBuffer = true;
            const depthTexture = device.createSampledDepthTexture(this.queue, width, height, NriFormat.D32_SFLOAT);
            if (depthTexture) {
                const depth = new Target(depthTexture, NriTextureState.ShaderResource);
                depth.attachment = depthTexture.createDepthAttachmentView(NriFormat.D32_SFLOAT);
                depth.readView = depthTexture.createView(NriFormat.D32_SFLOAT);
                this.targets.push(depth);
                this.gbufferDepth = depth;
            }

            // Buffer sizes: 1/2, 1/4 ... 1/64, rounded up.
            this.bufferWidth = [];
            this.bufferHeight = [];
            for (let i = 0; i < NUM_BUFFERS + 2; i++) {
                const power = 1 << (i + 1);
                this.bufferWidth.push(Math.floor((width + power - 1) / power));
                this.bufferHeight.push(Math.floor((height + power - 1) / power));
            }
            this.linearDepth = this.storageTarget(device, width, height, NriFormat.R16_SFLOAT);
            let ok = true;
            for (let i = 0; i < NUM_BUFFERS; i++) {
                const w = this.bufferWidth[i];
                const h = this.bufferHeight[i];
                const tiledW = this.bufferWidth[i + 2];
                const tiledH = this.bufferHeight[i + 2];
                const depthDownsize = this.storageTarget(device, w, h, NriFormat.R32_SFLOAT);
                const depthTiled = this.storageArrayTarget(device, tiledW, tiledH, NriFormat.R16_SFLOAT);
                const normalDownsize = this.storageTarget(device, w, h, NriFormat.R10_G10_B10_A2_UNORM);
                const normalTiled = this.storageArrayTarget(device, tiledW, tiledH, NriFormat.R10_G10_B10_A2_UNORM);
                const merged = this.storageTarget(device, w, h, NriFormat.R8_UNORM);
                const highQuality = this.storageTarget(device, w, h, NriFormat.R8_UNORM);
                if (!depthDownsize || !depthTiled || !normalDownsize || !normalTiled || !merged || !highQuality) {
                    ok = false;
                    break;
                }
                this.depthDownsize.push(depthDownsize as Target);
                this.depthTiled.push(depthTiled as Target);
                this.normalDownsize.push(normalDownsize as Target);
                this.normalTiled.push(normalTiled as Target);
                this.merged.push(merged as Target);
                this.highQuality.push(highQuality as Target);
                if (i < NUM_BUFFERS - 1) {
                    const smooth = this.storageTarget(device, w, h, NriFormat.R8_UNORM);
                    if (!smooth) {
                        ok = false;
                        break;
                    }
                    this.smooth.push(smooth as Target);
                }
            }
            this.ssao = this.storageTarget(device, width, height, NriFormat.R8_UNORM);
            const aoOutput = this.aoOutput;
            const ssaoOutput = this.ssaoOutput;
            const gbufferNormals = this.gbufferNormals;
            const gbufferDiffuse = this.gbufferDiffuse;
            const gbufferDepth = this.gbufferDepth;
            const linearDepth = this.linearDepth;
            const ssao = this.ssao;
            if (!ok || !aoOutput || !ssaoOutput || !gbufferNormals || !gbufferDiffuse || !gbufferDepth || !linearDepth || !ssao) {
                console.log("Cannot create the output-sized textures");
                return false;
            }

            // The sets' pool: per frame in flight, AO's and the G-buffer pass's per mesh, the render
            // passes' and blurs' per level; the preparation passes', the composite's and the blits'.
            const queuedFrameNum = this.queuedFrames.length;
            const meshNum = this.meshes.length;
            const perFrameSets = meshNum * 2 + NUM_BUFFERS * 3;
            const setNum = perFrameSets * queuedFrameNum + 5;
            const samplerNum = (meshNum * 3 + NUM_BUFFERS * 3) * queuedFrameNum + 2;
            const constantBufferNum = (meshNum * 6 + NUM_BUFFERS * 5) * queuedFrameNum;
            const textureNum = (meshNum * 6 + NUM_BUFFERS * 9) * queuedFrameNum + 9;
            const storageTextureNum = (meshNum + NUM_BUFFERS * 3) * queuedFrameNum + 18;
            this.descriptorPool = device.createDescriptorPoolWithAccelerationStructures(setNum, samplerNum, constantBufferNum,
                textureNum, storageTextureNum, meshNum * 2 * queuedFrameNum, meshNum * queuedFrameNum);
            if (!this.descriptorPool) {
                console.log("Cannot create the descriptor pool");
                return false;
            }

            for (let f = 0; f < queuedFrameNum; f++) {
                const queuedFrame = this.queuedFrames[f];
                // AO: per mesh (its geometry and material are global bindings here).
                for (const mesh of this.meshes) {
                    const set = this.allocateSet(this.aoLayout);
                    if (!set) {
                        return false;
                    }
                    this.updateRange(set, 0, [aoOutput.storageView]);
                    this.updateRange(set, 1, [mesh.topLevelASView]);
                    this.updateRange(set, 2, [queuedFrame.sceneView, queuedFrame.aoRaysView, queuedFrame.aoOptionsView, mesh.materialView]);
                    this.updateRange(set, 3, [this.pointWrapSampler, this.linearClampSampler]);
                    this.updateRange(set, 4, [mesh.rawIndexView, mesh.rawVertexView]);
                    this.updateRange(set, 5, [mesh.diffuseView, mesh.specularView, mesh.normalView]);
                    this.aoSets.push(set as NriDescriptorSet);
                }
                // SSAO::SetMesh: each mesh's G-buffer pass bindings.
                for (const mesh of this.meshes) {
                    const set = this.allocateSet(this.gbufferLayout);
                    if (!set) {
                        return false;
                    }
                    this.updateRange(set, 0, [queuedFrame.sceneView]);
                    this.updateRange(set, 1, [mesh.materialView]);
                    this.updateRange(set, 2, [mesh.diffuseView, mesh.specularView, mesh.normalView]);
                    this.updateRange(set, 3, [this.linearClampSampler]);
                    this.gbufferSets.push(set as NriDescriptorSet);
                }
                // Phase 3: SSAO for each atlas (into the merged buffers) and each downsized buffer
                // (into the high quality ones).
                for (let i = 0; i < NUM_BUFFERS; i++) {
                    const tiled = this.allocateSet(this.renderLayout);
                    const downsized = this.allocateSet(this.renderLayout);
                    if (!tiled || !downsized) {
                        return false;
                    }
                    this.updateRange(tiled, 0, [queuedFrame.sceneView, queuedFrame.ssaoViews[SSAO_TILED_SLICE + i]]);
                    this.updateRange(tiled, 1, [this.depthTiled[i].readView, this.normalTiled[i].readView]);
                    this.updateRange(tiled, 2, [this.merged[i].storageView]);
                    this.updateRange(tiled, 3, [this.pointClampSampler]);
                    this.render1Sets.push(tiled as NriDescriptorSet);
                    this.updateRange(downsized, 0, [queuedFrame.sceneView, queuedFrame.ssaoViews[SSAO_HIGH_QUALITY_SLICE + i]]);
                    this.updateRange(downsized, 1, [this.depthDownsize[i].readView, this.normalDownsize[i].readView]);
                    this.updateRange(downsized, 2, [this.highQuality[i].storageView]);
                    this.updateRange(downsized, 3, [this.pointClampSampler]);
                    this.render2Sets.push(downsized as NriDescriptorSet);
                }
                // Phase 4: blur and upsample, from the lowest resolution up (blurSets[f * 4 + i] for
                // level i).
                for (let i = 0; i < NUM_BUFFERS; i++) {
                    const blur = this.allocateSet(i == 0 ? this.blurLayout : this.blurBlendOutLayout);
                    if (!blur) {
                        return false;
                    }
                    this.updateRange(blur, 0, [queuedFrame.ssaoViews[SSAO_BLUR_SLICE + i]]);
                    this.updateRange(blur, 1, [this.linearClampSampler]);
                    if (i == 0) {
                        this.updateRange(blur, 2, [this.depthDownsize[0].readView, linearDepth.readView, this.smooth[0].readView,
                            this.highQuality[0].readView]);
                        this.updateRange(blur, 3, [ssao.storageView]);
                    } else {
                        const lower = i == NUM_BUFFERS - 1 ? this.merged[i] : this.smooth[i];
                        this.updateRange(blur, 2, [this.depthDownsize[i].readView, this.depthDownsize[i - 1].readView, lower.readView,
                            this.highQuality[i].readView, this.merged[i - 1].readView]);
                        this.updateRange(blur, 3, [this.smooth[i - 1].storageView]);
                    }
                    this.blurSets.push(blur as NriDescriptorSet);
                }
            }

            // Phase 2: decompress, linearize, downsample and deinterleave the depth buffer.
            const prepare1 = this.allocateSet(this.prepare1Layout);
            const prepare2 = this.allocateSet(this.prepare2Layout);
            const composite = this.allocateSet(this.compositeLayout);
            const blitSsao = this.allocateSet(this.blitLayout);
            const blitAo = this.allocateSet(this.blitLayout);
            if (!prepare1 || !prepare2 || !composite || !blitSsao || !blitAo) {
                return false;
            }
            this.updateRange(prepare1, 0, [gbufferDepth.readView, gbufferNormals.readView]);
            this.updateRange(prepare1, 1, [linearDepth.storageView, this.depthDownsize[0].storageView, this.depthTiled[0].storageView,
                this.depthDownsize[1].storageView, this.depthTiled[1].storageView, this.normalDownsize[0].storageView,
                this.normalTiled[0].storageView, this.normalDownsize[1].storageView, this.normalTiled[1].storageView]);
            this.prepare1Set = prepare1;
            this.updateRange(prepare2, 0, [this.depthDownsize[1].readView, this.normalDownsize[1].readView]);
            this.updateRange(prepare2, 1, [this.depthDownsize[2].storageView, this.depthTiled[2].storageView, this.depthDownsize[3].storageView,
                this.depthTiled[3].storageView, this.normalDownsize[2].storageView, this.normalTiled[2].storageView,
                this.normalDownsize[3].storageView, this.normalTiled[3].storageView]);
            this.prepare2Set = prepare2;
            // Phase 5: the SSAO times the diffuse color.
            this.updateRange(composite, 0, [ssao.readView, gbufferDiffuse.readView, gbufferDepth.readView]);
            this.updateRange(composite, 1, [ssaoOutput.storageView]);
            this.compositeSet = composite;
            // The blits of the outputs into the swap chain texture.
            this.updateRange(blitSsao, 0, [ssaoOutput.readView]);
            this.updateRange(blitSsao, 1, [this.linearClampSampler]);
            this.blitSsaoSet = blitSsao;
            this.updateRange(blitAo, 0, [aoOutput.readView]);
            this.updateRange(blitAo, 1, [this.linearClampSampler]);
            this.blitAoSet = blitAo;
            return true;
        }

        // --- Recording ----------------------------------------------------------------------------

        // A compute dispatch of pipeline with set (its textures moved to the states it needs first:
        // reads to ComputeShaderResource, writes to Storage).
        dispatch(commandBuffer: NriCommandBuffer, layout: NriPipelineLayout | null, pipeline: NriPipeline | null,
            set: NriDescriptorSet | null, reads: Target[], writes: Target[], x: int, y: int, z: int) {
            if (!layout || !pipeline || !set) {
                return;
            }
            for (const target of reads) {
                target.use(commandBuffer, NriTextureState.ComputeShaderResource);
            }
            for (const target of writes) {
                target.use(commandBuffer, NriTextureState.Storage);
            }
            commandBuffer.setComputePipelineLayout(layout);
            commandBuffer.setPipeline(pipeline);
            commandBuffer.setComputeDescriptorSet(0, set);
            commandBuffer.dispatch(x, y, z);
        }

        // AO::RunAORaytracing: the primary and AO rays into the AO output.
        runAo(commandBuffer: NriCommandBuffer, queuedFrameIndex: int) {
            const aoLayout = this.aoLayout;
            const aoPipeline = this.aoPipeline;
            const shaderTable = this.shaderTable;
            const aoOutput = this.aoOutput;
            if (!aoLayout || !aoPipeline || !shaderTable || !aoOutput) {
                return;
            }
            aoOutput.use(commandBuffer, NriTextureState.RayTracingStorage);
            commandBuffer.setRayTracingPipelineLayout(aoLayout);
            commandBuffer.setPipeline(aoPipeline);
            commandBuffer.setRayTracingDescriptorSet(0, this.aoSets[queuedFrameIndex * this.meshes.length + this.meshIndex]);
            commandBuffer.dispatchRays(shaderTable, this.outputWidth, this.outputHeight);
        }

        // SSAO::Run: the G-buffer, then the SSAO dispatches, into the SSAO output.
        runSsao(commandBuffer: NriCommandBuffer, queuedFrameIndex: int) {
            const mesh = this.meshes[this.meshIndex];
            const gbufferNormals = this.gbufferNormals;
            const gbufferDiffuse = this.gbufferDiffuse;
            const gbufferDepth = this.gbufferDepth;
            const gbufferLayout = this.gbufferLayout;
            const gbufferPipeline = this.gbufferPipeline;
            const vertexBuffer = mesh.vertexBuffer;
            const indexBuffer = mesh.indexBuffer;
            const linearDepth = this.linearDepth;
            const ssao = this.ssao;
            const ssaoOutput = this.ssaoOutput;
            if (!gbufferNormals || !gbufferDiffuse || !gbufferDepth || !gbufferLayout || !gbufferPipeline || !vertexBuffer || !indexBuffer
                || !linearDepth || !ssao || !ssaoOutput) {
                return;
            }
            const normalsAttachment = gbufferNormals.attachment;
            const diffuseAttachment = gbufferDiffuse.attachment;
            const depthAttachment = gbufferDepth.attachment;
            if (!normalsAttachment || !diffuseAttachment || !depthAttachment) {
                return;
            }

            // Phase 1: Render GBuffer.
            gbufferNormals.use(commandBuffer, NriTextureState.ColorAttachment);
            gbufferDiffuse.use(commandBuffer, NriTextureState.ColorAttachment);
            gbufferDepth.use(commandBuffer, NriTextureState.DepthAttachment);
            if (this.clearGBuffer) {
                commandBuffer.beginRendering(normalsAttachment);
                commandBuffer.clearColor(0.0, 0.0, 0.0, 0.0);
                commandBuffer.endRendering();
                commandBuffer.beginRendering(diffuseAttachment);
                commandBuffer.clearColor(0.0, 0.0, 0.0, 0.0);
                commandBuffer.endRendering();
                this.clearGBuffer = false;
            }
            commandBuffer.beginRenderingWithTwoColorsAndDepth(normalsAttachment, diffuseAttachment, depthAttachment);
            commandBuffer.clearDepth(1.0);
            commandBuffer.setViewport(0.0, 0.0, this.outputWidth, this.outputHeight);
            commandBuffer.setScissor(0, 0, this.outputWidth, this.outputHeight);
            commandBuffer.setPipelineLayout(gbufferLayout);
            commandBuffer.setPipeline(gbufferPipeline);
            commandBuffer.setDescriptorSet(0, this.gbufferSets[queuedFrameIndex * this.meshes.length + this.meshIndex]);
            commandBuffer.setVertexBuffer(0, vertexBuffer, 0, VERTEX_STRIDE);
            commandBuffer.setIndexBuffer(indexBuffer, 0, NriIndexType.UInt32);
            commandBuffer.drawIndexed(mesh.indexCount, 1, 0, 0, 0);
            commandBuffer.endRendering();

            const dd = this.depthDownsize;
            const dt = this.depthTiled;
            const nd = this.normalDownsize;
            const nt = this.normalTiled;
            const bw = this.bufferWidth;
            const bh = this.bufferHeight;

            // Phase 2: Decompress, linearize, downsample, and deinterleave the depth buffer.
            this.dispatch(commandBuffer, this.prepare1Layout, this.prepare1Pipeline, this.prepare1Set, [gbufferDepth, gbufferNormals],
                [linearDepth, dd[0], dt[0], dd[1], dt[1], nd[0], nt[0], nd[1], nt[1]], numGroups(bw[3] * 8, 8), numGroups(bh[3] * 8, 8), 1);
            this.dispatch(commandBuffer, this.prepare2Layout, this.prepare2Pipeline, this.prepare2Set, [dd[1], nd[1]],
                [dd[2], dt[2], dd[3], dt[3], nd[2], nt[2], nd[3], nt[3]], numGroups(bw[5] * 8, 8), numGroups(bh[5] * 8, 8), 1);

            // Phase 3: Render SSAO for each sub-tile.
            for (let i = 0; i < NUM_BUFFERS; i++) {
                this.dispatch(commandBuffer, this.renderLayout, this.render1Pipeline, this.render1Sets[queuedFrameIndex * NUM_BUFFERS + i],
                    [dt[i], nt[i]], [this.merged[i]], numGroups(bw[i + 2], 8), numGroups(bh[i + 2], 8), 16);
            }
            for (let i = 0; i < NUM_BUFFERS; i++) {
                this.dispatch(commandBuffer, this.renderLayout, this.render2Pipeline, this.render2Sets[queuedFrameIndex * NUM_BUFFERS + i],
                    [dd[i], nd[i]], [this.highQuality[i]], numGroups(bw[i], 16), numGroups(bh[i], 16), 1);
            }

            // Phase 4: Iteratively blur and upsample, combining each result.
            for (let i = NUM_BUFFERS - 1; i >= 0; i--) {
                const highWidth = i == 0 ? this.outputWidth : bw[i - 1];
                const highHeight = i == 0 ? this.outputHeight : bh[i - 1];
                const set = this.blurSets[queuedFrameIndex * NUM_BUFFERS + i];
                if (i == 0) {
                    this.dispatch(commandBuffer, this.blurLayout, this.blurPreMinPipeline, set, [dd[0], linearDepth, this.smooth[0],
                        this.highQuality[0]], [ssao], numGroups(highWidth + 2, 16), numGroups(highHeight + 2, 16), 1);
                } else {
                    const lower = i == NUM_BUFFERS - 1 ? this.merged[i] : this.smooth[i];
                    this.dispatch(commandBuffer, this.blurBlendOutLayout, this.blurPreMinBlendOutPipeline, set, [dd[i], dd[i - 1], lower,
                        this.highQuality[i], this.merged[i - 1]], [this.smooth[i - 1]], numGroups(highWidth + 2, 16),
                        numGroups(highHeight + 2, 16), 1);
                }
            }

            // Phase 5: Render.
            this.dispatch(commandBuffer, this.compositeLayout, this.compositePipeline, this.compositeSet, [ssao, gbufferDiffuse, gbufferDepth],
                [ssaoOutput], numGroups(bw[1] * 8, 8), numGroups(bh[1] * 8, 8), 1);
        }

        // Donut's blit (CommonRenderPasses::BlitTexture) of set's source into the viewport (left,
        // top, width, height) of the swap chain texture (between NriCommandBuffer.beginRendering and
        // NriCommandBuffer.endRendering).
        blit(commandBuffer: NriCommandBuffer, set: NriDescriptorSet | null, left: int, top: int, width: int, height: int) {
            const blitLayout = this.blitLayout;
            const blitPipeline = this.blitPipeline;
            if (!blitLayout || !blitPipeline || !set) {
                return;
            }
            commandBuffer.setViewport(left, top, width, height);
            commandBuffer.setScissor(left, top, width, height);
            commandBuffer.setPipelineLayout(blitLayout);
            commandBuffer.setPipeline(blitPipeline);
            commandBuffer.setRootConstants(0, Ref(this.blitConstants[0]), BLIT_CONSTANTS.length * 4);
            commandBuffer.setDescriptorSet(0, set);
            commandBuffer.draw(4, 1, 0, 0);
        }

        // --- The HUD (the sample's Menus) ---------------------------------------------------------

        box(x0: number, y0: number, x1: number, y1: number, value: number, alpha: number) {
            NriImgui.drawRect(x0, y0, x1, y1, value, value, value, alpha);
        }

        // A label in a 0.2-grey box MENU_BORDER around it (DrawSplitLabels, DrawLabel).
        label(text: string, x: number, y: number, r: number, g: number, b: number) {
            const width = NriImgui.calcTextWidth(text);
            this.box(x - MENU_BORDER, y - MENU_BORDER, x + width + MENU_BORDER, y + LINE_SPACING + MENU_BORDER, 0.2, 1.0);
            NriImgui.drawText(x, y, text, r, g, b, 1.0, 0);
        }

        // Menus::DrawMainMenu's RenderString: a line, its color by whether it is an option (and
        // option `option`, -1 for none) and the selection.
        addMenuLine(text: string, isOption: boolean, option: int) {
            this.menuLines.push(text);
            let r = DARK_GREY;
            let g = DARK_GREY;
            let b = DARK_GREY;
            if (!isOption) {
                r = OFF_WHITE;
                g = OFF_WHITE;
                b = OFF_WHITE;
            } else if (this.menuIndex == this.selection) {
                r = WHITE;
                g = WHITE;
                b = WHITE;
                // Option::SlectionColor
                if (option >= 0 && this.options[option].isLowerLimit()) {
                    r = ORANGE[0];
                    g = ORANGE[1];
                    b = ORANGE[2];
                } else if (option >= 0 && this.options[option].isUpperLimit()) {
                    r = GREEN[0];
                    g = GREEN[1];
                    b = GREEN[2];
                }
            }
            this.menuColors.push(r);
            this.menuColors.push(g);
            this.menuColors.push(b);
            if (isOption) {
                this.menuIndex++;
            }
        }

        optionValue(option: int) {
            const o = this.options[option];
            return formatFixed(o.value(), o.isInt ? 0 : 2);
        }

        // Menus::DrawMainMenu: centered when split, at the title-safe corner otherwise.
        mainMenu(center: boolean) {
            const screenWidth = this.frameWidth;
            const screenHeight = this.frameHeight;
            this.menuLines = [];
            this.menuColors = [];
            this.menuIndex = 0;
            // AO
            this.addMenuLine("AO:", false, -1);
            this.addMenuLine("  Attenuation:", false, -1);
            this.addMenuLine(`      Distance: ${this.optionValue(0)}`, true, 0);
            this.addMenuLine(`      Falloff: ${this.optionValue(1)}`, true, 1);
            this.addMenuLine("  Sampling: ", false, -1);
            this.addMenuLine(`      Num Samples (n^2): ${this.optionValue(2)}`, true, 2);
            this.addMenuLine(`      Type: ${this.aoSampleType.value() == 0.0 ? "Uniform" : "Cosine"}`, true, -1);
            // SSAO
            this.addMenuLine("SSAO:", false, -1);
            this.addMenuLine("  Tolerance:", false, -1);
            this.addMenuLine(`     Noise Threshold (log10): ${this.optionValue(4)}`, true, 4);
            this.addMenuLine(`     Blur Tolerance (log10): ${this.optionValue(5)}`, true, 5);
            this.addMenuLine(`     Upsample Tolerance (log10): ${this.optionValue(6)}`, true, 6);
            this.addMenuLine("  Misc: ", false, -1);
            this.addMenuLine(`     Normal Factor: ${this.optionValue(7)}`, true, 7);

            let wExtent = 0.0;
            for (const menuLine of this.menuLines) {
                const width = NriImgui.calcTextWidth(menuLine);
                if (width > wExtent) {
                    wExtent = width;
                }
            }
            const height = this.menuLines.length * LINE_SPACING;
            let startX = 0.0;
            let startY = 0.0;
            if (center) {
                startX = (screenWidth - wExtent) / 2.0;
                startY = (screenHeight - height) / 2.0;
            } else {
                // SimpleMath::Viewport::ComputeTitleSafeArea
                startX = Math.floor(Math.fround((screenWidth + 19.0) / 20.0));
                startY = Math.floor(Math.fround((screenHeight + 19.0) / 20.0));
            }
            // Backing: 80% black.
            this.box(startX - MENU_BORDER, startY - MENU_BORDER, startX + wExtent + MENU_BORDER, startY + height + MENU_BORDER, 0.0, 0.8);
            for (let i = 0; i < this.menuLines.length; i++) {
                NriImgui.drawText(startX, startY + i * LINE_SPACING, this.menuLines[i], this.menuColors[i * 3], this.menuColors[i * 3 + 1],
                    this.menuColors[i * 3 + 2], 1.0, 0);
            }
        }

        // Menus::Draw.
        buildUI() {
            this.sample.imguiNewFrame();
            const font = this.font;
            if (font) {
                const screenWidth = this.frameWidth;
                const screenHeight = this.frameHeight;
                font.pushFont();
                if (this.isSplit) {
                    // DrawSplitLabels
                    const ssaoWidth = NriImgui.calcTextWidth("SSAO");
                    this.label("SSAO", ((screenWidth - MENU_LINE_THICKNESS) / 2.0 - ssaoWidth) / 2.0 + MENU_LINE_THICKNESS / 2.0 - MENU_BORDER,
                        screenHeight - LINE_SPACING - MENU_BORDER, WHITE, WHITE, WHITE);
                    const aoWidth = NriImgui.calcTextWidth("AO");
                    this.label("AO", ((screenWidth - MENU_LINE_THICKNESS) / 2.0 - aoWidth) / 2.0 + (screenWidth + MENU_LINE_THICKNESS) / 2.0
                        - MENU_BORDER, screenHeight - LINE_SPACING - MENU_BORDER, WHITE, WHITE, WHITE);
                    // DrawCenterLine
                    const start = (screenWidth - MENU_LINE_THICKNESS) / 2.0;
                    this.box(start, 0.0, start + MENU_LINE_THICKNESS, screenHeight, 0.1, 1.0);
                } else {
                    // DrawLabel
                    const text = this.lightingModel == LightingMode.Ao ? "AO" : "SSAO";
                    const width = NriImgui.calcTextWidth(text);
                    this.label(text, (screenWidth - width) / 2.0, screenHeight - LINE_SPACING - MENU_BORDER, WHITE, WHITE, WHITE);
                }
                if (this.showFPS) {
                    // DrawFrameRate
                    const dim = NriImgui.calcTextWidth("FPS: 0000");
                    const text = `FPS: ${this.fps}`;
                    const x = screenWidth - dim - MENU_BORDER;
                    this.box(x - MENU_BORDER, 0.0, x + dim + MENU_BORDER, MENU_BORDER + LINE_SPACING + MENU_BORDER, 0.2, 1.0);
                    NriImgui.drawText(x + (dim - NriImgui.calcTextWidth(text)) / 2.0, MENU_BORDER, text, GREEN[0], GREEN[1], GREEN[2], 1.0, 0);
                }
                if (this.showHelp) {
                    this.mainMenu(this.isSplit);
                }
                NriImgui.popFont();
            }
            this.sample.imguiRender();
        }

        // --- The frame ----------------------------------------------------------------------------

        // Sample::Render (the HUD is ImGui's, over the blitted outputs).
        renderFrame(frameIndex: int) {
            this.resizeIfNeeded();
            const queuedFrameIndex = frameIndex % this.queuedFrames.length;
            const device = this.device;
            const frameConstantBuffer = this.frameConstantBuffer;
            if (!device || !frameConstantBuffer) {
                return;
            }
            // Animate first, as Donut's onAnimate before onRender (its test mode steps float(1/60) s).
            this.animate(this.test ? Math.fround(1.0 / 60.0) : this.sample.getFrameTime());
            const width = this.frameWidth;
            const height = this.frameHeight;

            // Lighting::ChangeScreenScale: the outputs at half the width when split.
            const outputWidth: int = Math.floor(width * this.widthScale());
            if (outputWidth != this.outputWidth || height != this.outputHeight) {
                device.waitIdle();
                this.releaseFrameResources();
                if (!this.createFrameResources(outputWidth, height)) {
                    this.frames.signal(frameIndex);
                    return;
                }
            }

            if (this.updateOptions) {
                this.applyOptions();
                this.updateOptions = false;
            }
            const proj = this.updateScene(width, height);
            this.updateSsaoConstants(proj);
            const base = queuedFrameIndex * FRAME_CB_SIZE;
            frameConstantBuffer.write(base + SCENE_CB_OFFSET, Ref(this.sceneConstants[0]), SCENE_FLOATS * 4);
            frameConstantBuffer.write(base + AO_RAYS_CB_OFFSET, Ref(this.aoRays[0]), MAX_OCCLUSION_RAYS * 16);
            frameConstantBuffer.write(base + AO_OPTIONS_CB_OFFSET, Ref(this.aoOptions[0]), 16);
            frameConstantBuffer.write(base + SSAO_CB_OFFSET, Ref(this.ssaoConstants[0]), SSAO_SLICE_FLOATS * SSAO_SLICES * 4);

            if (this.imgui) {
                this.buildUI();
            }

            const descriptorPool = this.descriptorPool;
            const aoOutput = this.aoOutput;
            const ssaoOutput = this.ssaoOutput;
            if (!descriptorPool || !aoOutput || !ssaoOutput) {
                this.frames.signal(frameIndex);
                return;
            }

            // Acquire a swap chain texture
            const index = this.swapChain.acquire(frameIndex);
            if (index >= 0) {
                const texture = this.swapChain.texture(index);
                const commandBuffer = this.frames.commandBuffer(frameIndex);

                commandBuffer.begin();
                if (this.imgui) {
                    this.sample.copyImguiData(commandBuffer);
                }
                commandBuffer.setDescriptorPool(descriptorPool);

                // Apply lighting model: split, SSAO left and AO right.
                const runAo = this.isSplit || this.lightingModel == LightingMode.Ao;
                const runSsao = this.isSplit || this.lightingModel == LightingMode.Ssao;
                if (runAo) {
                    this.runAo(commandBuffer, queuedFrameIndex);
                }
                if (runSsao) {
                    this.runSsao(commandBuffer, queuedFrameIndex);
                }

                // The outputs blitted into the swap chain texture, the HUD over them.
                if (runAo) {
                    aoOutput.use(commandBuffer, NriTextureState.ShaderResource);
                }
                if (runSsao) {
                    ssaoOutput.use(commandBuffer, NriTextureState.ShaderResource);
                }
                commandBuffer.textureBarrier(texture, NriTextureState.Undefined, NriTextureState.ColorAttachment);
                commandBuffer.beginRendering(this.swapChain.colorAttachment(index));
                if (this.isSplit) {
                    this.blit(commandBuffer, this.blitSsaoSet, 0, 0, outputWidth, height);
                    this.blit(commandBuffer, this.blitAoSet, width - outputWidth, 0, outputWidth, height);
                } else {
                    this.blit(commandBuffer, runAo ? this.blitAoSet : this.blitSsaoSet, 0, 0, width, height);
                }
                if (this.imgui) {
                    this.sample.drawImguiUnconverted(commandBuffer, this.swapChainFormat);
                }
                commandBuffer.endRendering();

                // The test's last frame: read back
                let presentFrom = NriTextureState.ColorAttachment;
                const readbackBuffer = this.readbackBuffer;
                if (readbackBuffer) {
                    if (frameIndex == TEST_FRAMES - 1) {
                        commandBuffer.textureBarrier(texture, NriTextureState.ColorAttachment, NriTextureState.CopySource);
                        commandBuffer.readbackTextureToBuffer(readbackBuffer, this.rowPitch, texture, width, height);
                        presentFrom = NriTextureState.CopySource;
                    }
                }
                commandBuffer.textureBarrier(texture, presentFrom, NriTextureState.Present);
                commandBuffer.end();

                // Submit and present
                this.swapChain.submit(commandBuffer, index);
                if (this.imgui) {
                    this.sample.imguiEndFrame();
                }
                this.swapChain.present(index);
            }

            // Signaled after the present, as NRISamples do
            this.frames.signal(frameIndex);
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
                this.releaseFrameResources();
                for (const queuedFrame of this.queuedFrames) {
                    this.destroyDescriptor(queuedFrame.sceneView);
                    this.destroyDescriptor(queuedFrame.aoRaysView);
                    this.destroyDescriptor(queuedFrame.aoOptionsView);
                    for (const view of queuedFrame.ssaoViews) {
                        view.destroy();
                    }
                }
                this.swapChain.destroy();
                for (const mesh of this.meshes) {
                    mesh.destroy();
                }
                this.destroyDescriptor(this.placeholderView);
                const placeholderTexture = this.placeholderTexture;
                if (placeholderTexture) {
                    placeholderTexture.destroy();
                }
                this.destroyDescriptor(this.pointWrapSampler);
                this.destroyDescriptor(this.linearClampSampler);
                this.destroyDescriptor(this.pointClampSampler);
                const frameConstantBuffer = this.frameConstantBuffer;
                if (frameConstantBuffer) {
                    frameConstantBuffer.destroy();
                }
                const readbackBuffer = this.readbackBuffer;
                if (readbackBuffer) {
                    readbackBuffer.destroy();
                }
                const shaderTable = this.shaderTable;
                if (shaderTable) {
                    shaderTable.destroy();
                }
                const pipelines = [this.aoPipeline, this.gbufferPipeline, this.prepare1Pipeline, this.prepare2Pipeline, this.render1Pipeline,
                    this.render2Pipeline, this.blurPreMinBlendOutPipeline, this.blurPreMinPipeline, this.compositePipeline, this.blitPipeline];
                for (const pipeline of pipelines) {
                    if (pipeline) {
                        pipeline.destroy();
                    }
                }
                const layouts = [this.aoLayout, this.gbufferLayout, this.prepare1Layout, this.prepare2Layout, this.renderLayout,
                    this.blurBlendOutLayout, this.blurLayout, this.compositeLayout, this.blitLayout];
                for (const layout of layouts) {
                    if (layout) {
                        layout.destroy();
                    }
                }
                this.frames.destroy();
                device.destroy();
            }
            this.sample.destroy();
        }

        destroyDescriptor(descriptor: NriDescriptor | null) {
            if (descriptor) {
                descriptor.destroy();
            }
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        const sample = NriSample.create();
        const raytracingAo = new RaytracingAoSample(sample);
        // -maze: start with the maze (Space toggles). -full: start not split (S toggles). -ssao: SSAO
        // rather than AO (Tab toggles). -help: start with the options menu (F1). -noUI: accepted
        // (the HUD is drawn anyway, as the Donut example draws it with -noUI).
        sample.addExampleOption("-maze");
        sample.addExampleOption("-full");
        sample.addExampleOption("-ssao");
        sample.addExampleOption("-help");
        sample.addExampleOption("-noUI");
        sample.useImgui();
        sample.useResizableWindow();
        for (let i = 1; i < argc; i++) {
            const arg = Nri.getArg(argc, argv, i);
            if (arg == "-maze") {
                raytracingAo.meshIndex = 1;
            } else if (arg == "-full") {
                raytracingAo.isSplit = false;
            } else if (arg == "-ssao") {
                raytracingAo.lightingModel = LightingMode.Ssao;
            } else if (arg == "-help") {
                raytracingAo.showHelp = true;
            }
        }
        return raytracingAo.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return RaytracingAoNri.main(argc, argv);
}
