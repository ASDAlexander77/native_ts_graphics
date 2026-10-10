// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";

namespace FastBlockCompress {
    const WINDOW_TITLE = "Donut Example: Fast Block Compress";
    const MEDIA_DIR = "media/fast_block_compress/";

    // The sample's images, each with the format it compresses to: opaque_1024 (1024x1024 RGB:
    // photo of recycle bin and book), opaque_512 (512x512 RGB: photo of Microsoft building
    // interior), alpha (1024x1024 RGBA: the recycle bin and book with alpha), normal (1024x1024 RG:
    // normal map texture). Each comes with offline BC and BC7 versions, named after it.
    const IMAGE_NAMES = ["opaque_1024", "opaque_512", "alpha", "normal"];
    const IMAGE_EXTENSIONS = [".DDS", ".dds", ".DDS", ".dds"];
    const IMAGE_BC7_EXTENSIONS = [".dds", ".dds", ".dds", ".dds"];
    const IMAGE_FORMATS = [Format.BC1_UNORM, Format.BC1_UNORM, Format.BC3_UNORM, Format.BC5_UNORM];

    // The sample's methods: run-time compression on the GPU and on the CPU, offline compression
    // (into the image's format and into BC7).
    const RTC_GPU = 0;
    const RTC_CPU = 1;
    const OFFLINE = 2;
    const OFFLINE_BC7 = 3;
    const MAX_METHOD = 4;

    // FBC_GPU.cpp's constants.
    const COMPRESS_TWO_MIPS_SIZE_THRESHOLD = 512;
    const COMPRESS_ONE_MIP_THREADGROUP_WIDTH = 8;
    const COMPRESS_TWO_MIPS_THREADGROUP_WIDTH = 16;

    // The compression shaders: one mip, two mips at once (through group shared memory), the tail
    // mips (16x16 to 1x1) in one group; the views they write.
    const KIND_ONE_MIP = 0;
    const KIND_TWO_MIPS = 1;
    const KIND_TAIL = 2;
    const KIND_ENTRIES = ["compress_cs", "compress_2mips_cs", "compress_tail_cs"];
    const KIND_OUTPUTS = [1, 2, 5];

    // RMS computation (FastBlockCompress.cpp): the reduce buffers' size for textures up to
    // MAX_TEXTURE_WIDTH, the shaders' group width.
    const MAX_TEXTURE_WIDTH = 2048;
    const RMS_THREADGROUP_WIDTH = 64;
    // RMS results are read this many frames after their computation.
    const READBACK_FRAMES = 3;

    // Push constants: BlockCompressConstants, RMSConstants (16 bytes each), QuadWithCameraConstants
    // (40).
    const COMPRESS_CONSTANTS_SIZE = 16;
    const RMS_CONSTANTS_SIZE = 16;
    const QUAD_CONSTANTS_FLOATS = 10;

    // Timer queries of the GPU method (top mip, all mips) are read this many frames later.
    const TIMER_FRAMES = 3;

    // ATG::Colors: the background (#414141), the labels' green (#107c10), the text's light grey
    // (#7a7a7a).
    const BACKGROUND = 0.254901975;
    const GREEN = [0.062745102, 0.486274511, 0.062745102];
    const LIGHT_GREY = [0.478431374, 0.478431374, 0.478431374];

    // The mouse wheel's zoom step (the sample zooms with the triggers).
    const ZOOM_PER_NOTCH = 1.1;

    // The sample's layout, for its 1920x1080 screen: the side-by-side viewports and the fullscreen
    // one.
    const LAYOUT_WIDTH = 1920.0;
    const LAYOUT_HEIGHT = 1080.0;

    // ImGui combo items: the names separated by '|'.
    function comboItems(names: string[]): string {
        let items = "";
        for (let i = 0; i < names.length; i++) {
            items += (i > 0 ? "|" : "") + names[i];
        }
        return items;
    }

    function formatFixed(value: number, digits: int): string {
        let scale = 1.0;
        for (let i = 0; i < digits; i++) {
            scale *= 10.0;
        }
        const scaled = Math.round(Math.abs(value) * scale);
        const whole: int = Math.floor(scaled / scale);
        const fraction: int = scaled - whole * scale;
        let fractionText = `${fraction}`;
        while (fractionText.length < digits) {
            fractionText = "0" + fractionText;
        }
        const sign = value < 0.0 && scaled > 0.0 ? "-" : "";
        return `${sign}${whole}.${fractionText}`;
    }

    function formatName(format: Format): string {
        return format == Format.BC1_UNORM ? "BC1" : format == Format.BC3_UNORM ? "BC3" : "BC5";
    }

    // One dispatch of the GPU compression.
    class CompressPass {
        pipeline: Opaque;
        bindingSet: BindingSet;
        groups: int;
        // BlockCompressConstants: 1 / the level's width.
        constants: f32[];

        constructor(pipeline: Opaque, bindingSet: BindingSet, groups: int, oneOverTextureWidth: number) {
            this.pipeline = pipeline;
            this.bindingSet = bindingSet;
            this.groups = groups;
            this.constants = [oneOverTextureWidth, 0.0, 0.0, 0.0];
        }
    }

    // The sample's Image: the source levels (RGBA8, also kept on the CPU for its CPU compressor),
    // the offline BC and BC7 versions, and here the textures the run-time compressions go into.
    class Image {
        format: Format;
        width: int;
        levels: int;
        // Donut_FbcDecodeDds's levels.
        rgba: Opaque;
        source: TextureHandle;
        offlineBC: TextureHandle;
        offlineBC7: TextureHandle;
        // GPU compression: the blocks of each level (R32G32_UINT or R32G32B32A32_UINT, a texel per
        // block), copied into gpuBC; its dispatches, the top level alone first.
        intermediates: TextureHandle[];
        gpuBC: TextureHandle;
        topPass: CompressPass;
        passes: CompressPass[];
        // CPU compression's result.
        cpuBC: TextureHandle;
        // RMS error binding sets (source and each method's texture) and display ones (the
        // original twice, then each method's texture with the original).
        rmsSets: BindingSet[];
        quadSets: BindingSet[];

        constructor(format: Format) {
            this.format = format;
            this.width = 0;
            this.levels = 0;
            this.intermediates = [];
            this.passes = [];
            this.rmsSets = [];
            this.quadSets = [];
        }
    }

    // --- Passes -----------------------------------------------------------------------------

    // Port of the Xbox ATG FastBlockCompress sample (XDKSamples/Graphics/FastBlockCompress): BC1,
    // BC3 and BC5 compression at run time on the GPU (compute shaders, two mips at a time for the
    // large ones, the tail mips in one dispatch) and on the CPU (the sample's SSE2 compressor),
    // every frame, timed, against offline BC and BC7 compression: the original image and the
    // method's side by side (or one of them full size), RMS errors, differences 10x, block
    // highlights, every mip level, zoom and pan.
    //
    // On Xbox One the sample aliases the BC texture's memory with the R32G32(B32A32)_UINT one the
    // shaders write; here each level's blocks are copied into the BC texture (D3D and Vulkan copy
    // between BC formats and uncompressed ones of the block's size). The gamepad's controls are
    // ImGui ones and the mouse (wheel: zoom, left drag: pan).
    class FastBlockCompressPass {
        private app: App;
        images: Image[];
        private pointSampler: SamplerHandle;
        // [format][kind]: format 0 BC1, 1 BC3, 2 BC5.
        private compressPipelines: Opaque[];
        private compressLayouts: Opaque[];
        private rmsLayout: Opaque;
        private rmsReduceLayout: Opaque;
        private rmsErrorPipeline: Opaque;
        private rmsReducePipeline: Opaque;
        private reduceBufferA: BufferHandle;
        private reduceBufferB: BufferHandle;
        // Reduce passes from A into B, and from B into A.
        private reduceSets: BindingSet[];
        private rmsReadbacks: BufferHandle[];
        private rmsReadbackWidth: int[];
        private rmsResult: f32[];
        private rmsConstants: f32[];
        private quadLayout: Opaque;
        private quadVS: Opaque;
        private quadPS: Opaque;
        private quadPipeline: Opaque | null;
        private quadConstants: f32[];
        private timers: Opaque[];
        private timerPending: boolean[];
        private cpuStats: f32[];
        private frameIndex: int;

        // The sample's state: what is shown and how.
        currentImage: int;
        currentMethod: int;
        mipLevel: int;
        fullscreen: boolean;
        toggleOriginal: boolean;
        highlightBlocks: boolean;
        colorDiffs: boolean;
        alphaDiffs: boolean;
        zoom: number;
        offsetX: number;
        offsetY: number;
        // RMS error (RGB, alpha) and the method's times (top mip, all mips), in ms.
        rmsError: number[];
        times: number[];

        private dragging: boolean;
        private mouseX: number;
        private mouseY: number;
        // The last frame's size, for the layout.
        frameWidth: int;
        frameHeight: int;

        constructor(app: App) {
            this.app = app;
            this.images = [];
            this.compressPipelines = [];
            this.compressLayouts = [];
            this.reduceSets = [];
            this.rmsReadbacks = [];
            this.rmsReadbackWidth = [];
            this.rmsResult = [0.0, 0.0];
            this.rmsConstants = [0.0, 0.0, 0.0, 0.0];
            this.quadPipeline = null;
            this.quadConstants = [];
            for (let i = 0; i < QUAD_CONSTANTS_FLOATS; i++) {
                this.quadConstants.push(0.0);
            }
            this.timers = [];
            this.timerPending = [];
            this.cpuStats = [0.0, 0.0];
            this.frameIndex = 0;
            this.currentImage = 0;
            this.currentMethod = 0;
            this.mipLevel = 0;
            this.fullscreen = false;
            this.toggleOriginal = false;
            this.highlightBlocks = false;
            this.colorDiffs = false;
            this.alphaDiffs = false;
            this.zoom = 1.0;
            this.offsetX = 0.0;
            this.offsetY = 0.0;
            this.rmsError = [0.0, 0.0];
            this.times = [0.0, 0.0];
            this.dragging = false;
            this.mouseX = 0.0;
            this.mouseY = 0.0;
            this.frameWidth = 1280;
            this.frameHeight = 720;
        }

        // The texture the current method shows.
        compressedTexture(image: Image): TextureHandle {
            const method = this.currentMethod;
            return method == RTC_GPU ? image.gpuBC : method == RTC_CPU ? image.cpuBC
                : method == OFFLINE ? image.offlineBC : image.offlineBC7;
        }

        methodLabel(method: int): string {
            const bc = formatName(this.images[this.currentImage].format);
            return method == RTC_GPU ? `GPU (${bc})` : method == RTC_CPU ? `CPU (${bc})`
                : method == OFFLINE ? `Offline (${bc})` : "Offline (BC7)";
        }

        // The viewports of the sample's layout (left, top, width, height), scaled to the frame, their
        // edges on whole pixels as the sample's (APIs differ on the pixels at fractional edges).
        // Side by side: the original, then the method's. Fullscreen: one.
        viewport(index: int): number[] {
            const sx = this.frameWidth / LAYOUT_WIDTH;
            const sy = this.frameHeight / LAYOUT_HEIGHT;
            const left: number = this.fullscreen ? 448.0 : index == 0 ? 96.0 : 1014.0;
            const top: number = this.fullscreen ? 28.0 : 216.0;
            const size: number = this.fullscreen ? 1024.0 : 810.0;
            const x0 = Math.round(left * sx);
            const y0 = Math.round(top * sy);
            return [x0, y0, Math.round((left + size) * sx) - x0, Math.round((top + size) * sy) - y0];
        }

        // Clamps the zoom and the offsets as the sample's Update.
        clampCamera(): void {
            this.zoom = Math.max(this.zoom, 1.0);
            const oneOverZoom = 1.0 / this.zoom;
            this.offsetX = Math.min(Math.max(this.offsetX, 0.0), 1.0 - oneOverZoom);
            this.offsetY = Math.min(Math.max(this.offsetY, 0.0), 1.0 - oneOverZoom);
        }

        resetCamera(): void {
            this.zoom = 1.0;
            this.offsetX = 0.0;
            this.offsetY = 0.0;
        }

        onMousePos(x: number, y: number): int {
            if (this.dragging) {
                // The image follows the mouse: a viewport's width is the visible part of the image.
                const vp = this.viewport(this.fullscreen ? 0 : 1);
                const oneOverZoom = 1.0 / this.zoom;
                this.offsetX -= (x - this.mouseX) / vp[2] * oneOverZoom;
                this.offsetY -= (y - this.mouseY) / vp[3] * oneOverZoom;
                this.clampCamera();
            }
            this.mouseX = x;
            this.mouseY = y;
            return 1;
        }

        onMouseButton(button: int, action: int, mods: int): int {
            // GLFW_MOUSE_BUTTON_LEFT, GLFW_PRESS.
            if (button == 0) {
                this.dragging = action == 1;
            }
            return 1;
        }

        onMouseScroll(xOffset: number, yOffset: number): int {
            this.zoom *= Math.pow(ZOOM_PER_NOTCH, yOffset);
            this.clampCamera();
            return 1;
        }

        onAnimate(elapsedSeconds: number): void {
            this.app.setInformativeWindowTitle(WINDOW_TITLE);
        }

        // The sample's Update for the GPU method: the top mip alone, timed, then all mips, timed;
        // then (not on Xbox One) the blocks copied into the BC texture.
        compressGPU(commandList: CommandList, image: Image): void {
            const timerBase = (this.frameIndex % TIMER_FRAMES) * 2;
            if (this.timerPending[this.frameIndex % TIMER_FRAMES]) {
                this.times[0] = this.app.getTimerQueryTime(this.timers[timerBase]) * 1000.0;
                this.times[1] = this.app.getTimerQueryTime(this.timers[timerBase + 1]) * 1000.0;
            }
            this.app.resetTimerQuery(this.timers[timerBase]);
            this.app.resetTimerQuery(this.timers[timerBase + 1]);
            this.timerPending[this.frameIndex % TIMER_FRAMES] = true;

            commandList.beginMarker("GPU Compress");
            const top = image.topPass;
            commandList.beginTimerQuery(this.timers[timerBase]);
            commandList.dispatchWithPushConstants(top.pipeline, top.bindingSet, Ref(top.constants[0]),
                COMPRESS_CONSTANTS_SIZE, top.groups, top.groups, 1);
            commandList.endTimerQuery(this.timers[timerBase]);

            commandList.beginTimerQuery(this.timers[timerBase + 1]);
            for (let i = 0; i < image.passes.length; i++) {
                const pass = image.passes[i];
                commandList.dispatchWithPushConstants(pass.pipeline, pass.bindingSet, Ref(pass.constants[0]),
                    COMPRESS_CONSTANTS_SIZE, pass.groups, pass.groups, 1);
            }
            commandList.endTimerQuery(this.timers[timerBase + 1]);

            for (let level = 0; level < image.levels; level++) {
                const blocks = Math.max((image.width >> level) / 4, 1);
                commandList.copyTextureRegion(image.gpuBC, level, 0, 0, image.intermediates[level], 0, 0, 0, blocks, blocks);
            }
            commandList.endMarker();
        }

        // The sample's Update for the CPU method: compressed, timed, then uploaded.
        compressCPU(commandList: CommandList, image: Image): void {
            const result = Donut_FbcCompressCpu(image.rgba, image.format, Ref(this.cpuStats[0]));
            if (!result) {
                return;
            }
            const compressed = result as Opaque;
            this.times[0] = this.cpuStats[0];
            this.times[1] = this.cpuStats[1];
            for (let level = 0; level < image.levels; level++) {
                commandList.writeTextureLevel(image.cpuBC, level, Donut_GetFbcTextureLevelData(compressed, level),
                    Donut_GetFbcTextureLevelRowPitch(compressed, level));
            }
            Donut_DestroyFbcTexture(compressed);
        }

        // The sample's RMSError: the squared errors of the shown level, reduced to one value and
        // copied for reading READBACK_FRAMES frames later (the sample polls a fence instead).
        computeRMS(commandList: CommandList, image: Image): void {
            const slot = this.frameIndex % READBACK_FRAMES;
            const pendingWidth = this.rmsReadbackWidth[slot];
            if (pendingWidth > 0) {
                if (this.app.readBuffer(this.rmsReadbacks[slot], Ref(this.rmsResult[0]), 8) != 0) {
                    // RMSComputeResult: RGB and alpha.
                    this.rmsError[0] = (1.0 / 3.0) * Math.sqrt(this.rmsResult[0] / (pendingWidth * pendingWidth));
                    this.rmsError[1] = Math.sqrt(this.rmsResult[1] / (pendingWidth * pendingWidth));
                }
                this.rmsReadbackWidth[slot] = 0;
            }
            if (this.fullscreen && this.toggleOriginal) {
                return;
            }

            // We pass in the width of the full texture, but we need the width of the current mip level
            const width = image.width >> this.mipLevel;
            Donut_StoreInt32(Ref(this.rmsConstants[0]), width);
            Donut_StoreInt32(Ref(this.rmsConstants[1]), this.mipLevel);
            Donut_StoreInt32(Ref(this.rmsConstants[2]), 0);
            Donut_StoreInt32(Ref(this.rmsConstants[3]), image.format == Format.BC5_UNORM ? 1 : 0);

            commandList.beginMarker("RMS Error");
            let groupsX = Math.max(1, Math.floor(width / 2 / RMS_THREADGROUP_WIDTH));
            commandList.dispatchWithPushConstants(this.rmsErrorPipeline, image.rmsSets[this.currentMethod],
                Ref(this.rmsConstants[0]), RMS_CONSTANTS_SIZE, groupsX, width /* We only support square textures */, 1);

            // Reduce
            let numReduceBufferElements = Math.max(2, Math.floor(width * width / 4));
            let fromA = true;
            while (numReduceBufferElements > 1) {
                groupsX = Math.max(1, Math.floor(numReduceBufferElements / 2 / RMS_THREADGROUP_WIDTH));
                commandList.dispatch(this.rmsReducePipeline, this.reduceSets[fromA ? 0 : 1], groupsX, 1, 1);
                numReduceBufferElements = Math.max(1, Math.floor(numReduceBufferElements / 4));
                fromA = !fromA;
            }

            // Readback
            commandList.copyBuffer(this.rmsReadbacks[slot], 0, fromA ? this.reduceBufferA : this.reduceBufferB, 0, 8);
            this.rmsReadbackWidth[slot] = width;
            commandList.endMarker();
        }

        drawQuad(frame: Frame, viewportIndex: int, bindingSet: BindingSet, image: Image, diffs: boolean): void {
            // QuadWithCameraConstants: the camera, the level's size (square), the level, the options.
            this.quadConstants[0] = 1.0 / this.zoom;
            this.quadConstants[1] = this.offsetX;
            this.quadConstants[2] = this.offsetY;
            this.quadConstants[3] = image.width / Math.pow(2.0, this.mipLevel);
            this.quadConstants[4] = this.quadConstants[3];
            Donut_StoreInt32(Ref(this.quadConstants[5]), this.mipLevel);
            Donut_StoreInt32(Ref(this.quadConstants[6]), this.highlightBlocks ? 1 : 0);
            Donut_StoreInt32(Ref(this.quadConstants[7]), diffs && this.colorDiffs ? 1 : 0);
            Donut_StoreInt32(Ref(this.quadConstants[8]), diffs && this.alphaDiffs ? 1 : 0);
            Donut_StoreInt32(Ref(this.quadConstants[9]), image.format == Format.BC5_UNORM ? 1 : 0);

            const vp = this.viewport(viewportIndex);
            frame.beginDraw(this.quadPipeline as Opaque);
            frame.drawAddBindingSet(bindingSet);
            frame.drawSetViewport(vp[0], vp[1], vp[2], vp[3]);
            frame.drawVerticesWithPushConstants(3, Ref(this.quadConstants[0]), QUAD_CONSTANTS_FLOATS * 4);
        }

        onRender(frameHandle: FrameHandle): void {
            const frame = new Frame(frameHandle);
            this.frameWidth = frame.getWidth();
            this.frameHeight = frame.getHeight();
            const commandList = frame.getCommandList();
            const image = this.images[this.currentImage];
            // Make sure we're not trying to display a mip that is unavailable in the source image
            this.mipLevel = Math.min(this.mipLevel, image.levels - 1);

            if (this.currentMethod == RTC_GPU) {
                this.compressGPU(commandList, image);
            } else if (this.currentMethod == RTC_CPU) {
                this.compressCPU(commandList, image);
            }

            this.computeRMS(commandList, image);

            frame.clearColor(BACKGROUND, BACKGROUND, BACKGROUND, 1.0);
            let quadPipeline = this.quadPipeline;
            if (!quadPipeline) {
                const desc = GraphicsPipelineDesc.create(this.quadVS, this.quadPS);
                desc.addBindingLayout(this.quadLayout);
                desc.setDepthState(0, 0, ComparisonFunc.Always);
                desc.setRasterState(CullMode.None, FillMode.Solid, 0);
                quadPipeline = this.app.createGraphicsPipelineFromDescForFrame(desc, frame);
                this.quadPipeline = quadPipeline;
            }

            const methodSet = image.quadSets[1 + this.currentMethod];
            if (this.fullscreen) {
                this.drawQuad(frame, 0, this.toggleOriginal ? image.quadSets[0] : methodSet, image, !this.toggleOriginal);
            } else {
                // Draw the original image on the left, the compressed image on the right
                this.drawQuad(frame, 0, image.quadSets[0], image, false);
                this.drawQuad(frame, 1, methodSet, image, true);
            }

            this.frameIndex++;
        }

        // The frame's framebuffer layout changes with the back buffers' format only, not their
        // size: the pipeline stays.
        onBackBufferResizing(): void {
        }

        // The sample's Image constructor: the source levels (decoded on the CPU, for its CPU
        // compressor too) and the offline versions; here also the run-time compressions' textures,
        // dispatches and binding sets.
        loadImage(commandList: CommandList, index: int): Image | null {
            const image = new Image(IMAGE_FORMATS[index]);
            const name = IMAGE_NAMES[index];
            const file = this.app.loadBinaryFile(MEDIA_DIR + name + IMAGE_EXTENSIONS[index]);
            if (file.isNull()) {
                return null;
            }
            const rgba = Donut_FbcDecodeDds(file.getData(), file.getSize());
            this.app.releaseObject(file.handle);
            if (!rgba) {
                return null;
            }
            image.rgba = rgba as Opaque;
            image.width = Donut_GetFbcTextureWidth(image.rgba);
            image.levels = Donut_GetFbcTextureLevelCount(image.rgba);
            const width = image.width;
            const levels = image.levels;

            image.source = this.app.createTextureWithLevels(width, width, levels, Format.RGBA8_UNORM, name);
            for (let level = 0; level < levels; level++) {
                commandList.writeTextureLevel(image.source, level, Donut_GetFbcTextureLevelData(image.rgba, level),
                    Donut_GetFbcTextureLevelRowPitch(image.rgba, level));
            }

            const bcName = formatName(image.format).toLowerCase();
            const offlineBC = this.app.loadTexture(commandList, MEDIA_DIR + name + "_offline_" + bcName + IMAGE_EXTENSIONS[index], 0);
            const offlineBC7 = this.app.loadTexture(commandList, MEDIA_DIR + name + "_offline_bc7" + IMAGE_BC7_EXTENSIONS[index], 0);
            if (!offlineBC || !offlineBC7) {
                return null;
            }
            image.offlineBC = offlineBC;
            image.offlineBC7 = offlineBC7;

            // A texel per block; the 2x2 and 1x1 levels are one block each.
            const intermediateFormat = image.format == Format.BC1_UNORM ? Format.RG32_UINT : Format.RGBA32_UINT;
            for (let level = 0; level < levels; level++) {
                const blocks = Math.max((width >> level) / 4, 1);
                image.intermediates.push(this.app.createUAVTextureWithFormat(blocks, blocks, intermediateFormat, `${name} blocks ${level}`));
            }
            image.gpuBC = this.app.createTextureWithLevels(width, width, levels, image.format, `${name} GPU`);
            image.cpuBC = this.app.createTextureWithLevels(width, width, levels, image.format, `${name} CPU`);

            this.createPasses(image);

            const methodTextures = [image.gpuBC, image.cpuBC, image.offlineBC, image.offlineBC7];
            for (let method = 0; method < MAX_METHOD; method++) {
                const rmsDesc = BindingSetDesc.create();
                rmsDesc.bindPushConstants(0, RMS_CONSTANTS_SIZE);
                rmsDesc.bindTextureSRV(0, image.source);
                rmsDesc.bindTextureSRV(1, methodTextures[method]);
                rmsDesc.bindStructuredBufferUAV(0, this.reduceBufferA);
                image.rmsSets.push(this.app.createBindingSetForLayout(rmsDesc, this.rmsLayout));
            }
            for (let set = 0; set <= MAX_METHOD; set++) {
                const quadDesc = BindingSetDesc.create();
                quadDesc.bindPushConstants(0, QUAD_CONSTANTS_FLOATS * 4);
                quadDesc.bindSampler(0, this.pointSampler);
                quadDesc.bindTextureSRV(0, set == 0 ? image.source : methodTextures[set - 1]);
                quadDesc.bindTextureSRV(1, image.source);
                image.quadSets.push(this.app.createBindingSetForLayout(quadDesc, this.quadLayout));
            }
            return image;
        }

        compressPass(image: Image, kind: int, level: int, groups: int, oneOverTextureWidth: number): CompressPass {
            const formatIndex = image.format == Format.BC1_UNORM ? 0 : image.format == Format.BC3_UNORM ? 1 : 2;
            const desc = BindingSetDesc.create();
            desc.bindPushConstants(0, COMPRESS_CONSTANTS_SIZE);
            if (kind == KIND_TAIL) {
                // The tail shader samples levels 0 to 4 of its view.
                desc.bindTextureSRVMips(0, image.source, level, image.levels - level);
            } else {
                desc.bindTextureSRVMip(0, image.source, level);
            }
            for (let i = 0; i < KIND_OUTPUTS[kind]; i++) {
                desc.bindTextureUAV(i, image.intermediates[level + i]);
            }
            desc.bindSampler(0, this.pointSampler);
            const bindingSet = this.app.createBindingSetForLayout(desc, this.compressLayouts[kind]);
            return new CompressPass(this.compressPipelines[formatIndex * 3 + kind], bindingSet, groups, oneOverTextureWidth);
        }

        // CompressorGPU::Compress's dispatches: for the top mip alone (generateMips false), then for
        // all of them.
        createPasses(image: Image): void {
            const texSize = image.width;
            image.topPass = this.compressPass(image, KIND_ONE_MIP, 0,
                Math.max(1, Math.floor(texSize / 4 / COMPRESS_ONE_MIP_THREADGROUP_WIDTH)), 1.0 / texSize);

            const numMips = image.levels;
            // For BC3, using the "compress two mips" shader seems to decrease performance
            let twoMips = image.format != Format.BC3_UNORM;
            // We run several compute shader passes to generate all of our mips
            for (let i = 0; i < numMips; i += (twoMips ? 2 : 1)) {
                const mipWidth = Math.max(texSize >> i, 1);

                // If we've reached the 16x16 mip, use our "tail mips" shader that compresses the remaining
                //  mips (from 16x16 to 1x1) in one pass
                if (mipWidth == 16) {
                    image.passes.push(this.compressPass(image, KIND_TAIL, i, 1, 1.0 / mipWidth));
                    break;
                }

                // If we've been using the "compress two mips" shader, determine whether we've reached
                //  the threshold where we want to switch to the "compress one mip" shader
                if (twoMips && mipWidth < COMPRESS_TWO_MIPS_SIZE_THRESHOLD) {
                    twoMips = false;
                }

                const dispatchWidth = Math.max(1,
                    Math.floor(mipWidth / 4 / (twoMips ? COMPRESS_TWO_MIPS_THREADGROUP_WIDTH : COMPRESS_ONE_MIP_THREADGROUP_WIDTH)));
                image.passes.push(this.compressPass(image, twoMips ? KIND_TWO_MIPS : KIND_ONE_MIP, i, dispatchWidth, 1.0 / mipWidth));
            }
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(): boolean {
            this.pointSampler = this.app.getCommonSampler(CommonSampler.PointClamp);

            for (let kind = 0; kind < 3; kind++) {
                const layoutDesc = BindingLayoutDesc.create();
                layoutDesc.layoutPushConstants(0, COMPRESS_CONSTANTS_SIZE);
                layoutDesc.layoutTextureSRV(0);
                for (let i = 0; i < KIND_OUTPUTS[kind]; i++) {
                    layoutDesc.layoutTextureUAV(i);
                }
                layoutDesc.layoutSampler(0);
                this.compressLayouts.push(this.app.createBindingLayout(layoutDesc, ShaderType.Compute));
            }
            const formats = ["1", "3", "5"];
            for (let f = 0; f < 3; f++) {
                for (let kind = 0; kind < 3; kind++) {
                    const shader = this.app.createShaderWithDefine("fast_block_compress.hlsl", KIND_ENTRIES[kind], ShaderType.Compute,
                        "FORMAT", formats[f]);
                    if (!shader) {
                        return false;
                    }
                    this.compressPipelines.push(this.app.createComputePipelineWithLayout(shader, this.compressLayouts[kind]));
                }
            }

            const rmsLayoutDesc = BindingLayoutDesc.create();
            rmsLayoutDesc.layoutPushConstants(0, RMS_CONSTANTS_SIZE);
            rmsLayoutDesc.layoutTextureSRV(0);
            rmsLayoutDesc.layoutTextureSRV(1);
            rmsLayoutDesc.layoutStructuredBufferUAV(0);
            this.rmsLayout = this.app.createBindingLayout(rmsLayoutDesc, ShaderType.Compute);
            const reduceLayoutDesc = BindingLayoutDesc.create();
            reduceLayoutDesc.layoutStructuredBufferUAV(0);
            reduceLayoutDesc.layoutStructuredBufferUAV(1);
            this.rmsReduceLayout = this.app.createBindingLayout(reduceLayoutDesc, ShaderType.Compute);
            const rmsErrorShader = this.app.createShader("fast_block_compress_rms.hlsl", "rms_error_cs", ShaderType.Compute);
            const rmsReduceShader = this.app.createShader("fast_block_compress_rms.hlsl", "rms_reduce_cs", ShaderType.Compute);
            this.quadVS = this.app.createShader("fast_block_compress_quad.hlsl", "quad_vs", ShaderType.Vertex);
            this.quadPS = this.app.createShader("fast_block_compress_quad.hlsl", "quad_ps", ShaderType.Pixel);
            if (!rmsErrorShader || !rmsReduceShader || !this.quadVS || !this.quadPS) {
                return false;
            }
            this.rmsErrorPipeline = this.app.createComputePipelineWithLayout(rmsErrorShader, this.rmsLayout);
            this.rmsReducePipeline = this.app.createComputePipelineWithLayout(rmsReduceShader, this.rmsReduceLayout);

            const quadLayoutDesc = BindingLayoutDesc.create();
            quadLayoutDesc.layoutPushConstants(0, QUAD_CONSTANTS_FLOATS * 4);
            quadLayoutDesc.layoutSampler(0);
            quadLayoutDesc.layoutTextureSRV(0);
            quadLayoutDesc.layoutTextureSRV(1);
            this.quadLayout = this.app.createBindingLayout(quadLayoutDesc, ShaderType.All);

            // The reduce buffers: a float2 per 4 texels, then a quarter of that.
            const numElements = MAX_TEXTURE_WIDTH * MAX_TEXTURE_WIDTH / 4;
            this.reduceBufferA = this.app.createRWStructuredBuffer(8, numElements, "RMS Reduce A");
            this.reduceBufferB = this.app.createRWStructuredBuffer(8, Math.max(numElements / 4, 1), "RMS Reduce B");
            for (let i = 0; i < 2; i++) {
                const desc = BindingSetDesc.create();
                desc.bindStructuredBufferUAV(0, i == 0 ? this.reduceBufferA : this.reduceBufferB);
                desc.bindStructuredBufferUAV(1, i == 0 ? this.reduceBufferB : this.reduceBufferA);
                this.reduceSets.push(this.app.createBindingSetForLayout(desc, this.rmsReduceLayout));
            }
            for (let i = 0; i < READBACK_FRAMES; i++) {
                this.rmsReadbacks.push(this.app.createReadbackBuffer(8, "RMS Result"));
                this.rmsReadbackWidth.push(0);
            }
            for (let i = 0; i < TIMER_FRAMES; i++) {
                this.timers.push(this.app.createTimerQuery());
                this.timers.push(this.app.createTimerQuery());
                this.timerPending.push(false);
            }

            const commandList = this.app.createCommandList();
            commandList.open();
            let loaded = true;
            for (let i = 0; i < IMAGE_NAMES.length && loaded; i++) {
                const image = this.loadImage(commandList, i);
                if (image) {
                    this.images.push(image as Image);
                } else {
                    loaded = false;
                }
            }
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.waitForIdle();
            this.app.releaseResource(commandList.handle);
            if (!loaded) {
                console.log("Cannot load the sample's images: set XBOX_ATG_SAMPLES_DIR when configuring");
                return false;
            }

            const pass = this.app.addPass();
            pass.setMousePosCallback(this.onMousePos);
            pass.setMouseButtonCallback(this.onMouseButton);
            pass.setMouseScrollCallback(this.onMouseScroll);
            pass.setAnimateCallback(this.onAnimate);
            pass.setBackBufferResizingCallback(this.onBackBufferResizing);
            pass.setRenderCallback(this.onRender);
            return true;
        }
    }

    // The sample's controls (gamepad buttons there) and text.
    class UserInterface {
        private sample: FastBlockCompressPass;

        constructor(sample: FastBlockCompressPass) {
            this.sample = sample;
        }

        label(text: string, x: number, y: number): void {
            Donut_ImGuiBeginOverlay(text, x, y, 300.0, Donut_ImGuiGetFontSize() * 1.6);
            Donut_ImGuiPushTextColor(GREEN[0], GREEN[1], GREEN[2], 1.0);
            Donut_ImGuiText(text);
            Donut_ImGuiPopStyleColor();
            Donut_ImGuiEnd();
        }

        buildUI(): void {
            const sample = this.sample;
            // Three rows above the images, as the sample's text.
            Donut_ImGuiSetNextWindowPos(10.0, 4.0);
            Donut_ImGuiBegin("Fast Block Compress", 1);
            Donut_ImGuiText("[LB/RB] Image");
            Donut_ImGuiSameLine();
            Donut_ImGuiPushItemWidth(110.0);
            const image = Donut_ImGuiCombo("##image", sample.currentImage, comboItems(IMAGE_NAMES));
            Donut_ImGuiPopItemWidth();
            if (image != sample.currentImage) {
                sample.currentImage = image;
                sample.currentMethod = 0;
                sample.toggleOriginal = false;
            }
            let methods: string[] = [];
            for (let m = 0; m < MAX_METHOD; m++) {
                methods.push(sample.methodLabel(m));
            }
            Donut_ImGuiSameLine();
            Donut_ImGuiText("[DPad L/R]");
            Donut_ImGuiSameLine();
            Donut_ImGuiPushItemWidth(110.0);
            sample.currentMethod = Donut_ImGuiCombo("##method", sample.currentMethod, comboItems(methods));
            Donut_ImGuiPopItemWidth();
            Donut_ImGuiSameLine();
            Donut_ImGuiText("[DPad U/D] Mip Level");
            Donut_ImGuiSameLine();
            Donut_ImGuiPushItemWidth(80.0);
            const levels = sample.images[sample.currentImage].levels;
            sample.mipLevel = Donut_ImGuiSliderInt("##mip", sample.mipLevel, 0, levels - 1);
            Donut_ImGuiPopItemWidth();

            sample.highlightBlocks = Donut_ImGuiCheckbox("[A] Highlight blocks", sample.highlightBlocks ? 1 : 0) != 0;
            Donut_ImGuiSameLine();
            const fullscreen = Donut_ImGuiCheckbox("[X] Fullscreen", sample.fullscreen ? 1 : 0) != 0;
            if (fullscreen != sample.fullscreen) {
                sample.fullscreen = fullscreen;
                sample.toggleOriginal = false;
            }
            if (sample.fullscreen) {
                Donut_ImGuiSameLine();
                sample.toggleOriginal = Donut_ImGuiCheckbox("Original image", sample.toggleOriginal ? 1 : 0) != 0;
            }

            Donut_ImGuiText("[Y] Diffs (10x scale):");
            Donut_ImGuiSameLine();
            if (Donut_ImGuiRadioButton("None", !sample.colorDiffs && !sample.alphaDiffs ? 1 : 0) != 0) {
                sample.colorDiffs = false;
                sample.alphaDiffs = false;
            }
            Donut_ImGuiSameLine();
            if (Donut_ImGuiRadioButton("Color", sample.colorDiffs ? 1 : 0) != 0) {
                sample.colorDiffs = true;
                sample.alphaDiffs = false;
            }
            Donut_ImGuiSameLine();
            if (Donut_ImGuiRadioButton("Alpha", sample.alphaDiffs ? 1 : 0) != 0) {
                sample.colorDiffs = false;
                sample.alphaDiffs = true;
            }
            Donut_ImGuiSameLine();
            if (Donut_ImGuiButton("[RS] Reset camera") != 0) {
                sample.resetCamera();
            }
            Donut_ImGuiSameLine();
            Donut_ImGuiText("(mouse wheel: zoom, left drag: pan)");
            Donut_ImGuiEnd();

            // The sample's right column of text.
            const shown = sample.images[sample.currentImage];
            const sx = sample.frameWidth / LAYOUT_WIDTH;
            Donut_ImGuiBeginOverlay("Stats", 1490.0 * sx, 4.0, 420.0 * sx, Donut_ImGuiGetFontSize() * 7.0);
            Donut_ImGuiPushTextColor(LIGHT_GREY[0], LIGHT_GREY[1], LIGHT_GREY[2], 1.0);
            Donut_ImGuiText(`Texture dimensions: ${shown.width} x ${shown.width}`);
            if (!sample.fullscreen || !sample.toggleOriginal) {
                Donut_ImGuiText(`RGB RMS Error (Mip ${sample.mipLevel}): ${formatFixed(sample.rmsError[0], 6)}`);
                Donut_ImGuiText(`Alpha RMS Error (Mip ${sample.mipLevel}): ${formatFixed(sample.rmsError[1], 6)}`);
                if (sample.currentMethod == RTC_GPU || sample.currentMethod == RTC_CPU) {
                    Donut_ImGuiText(`Time (Top) ${formatFixed(sample.times[0], 3)} ms; (All) ${formatFixed(sample.times[1], 3)} ms`);
                }
            }
            Donut_ImGuiPopStyleColor();
            Donut_ImGuiEnd();

            const sy = sample.frameHeight / LAYOUT_HEIGHT;
            const lineHeight = Donut_ImGuiGetFontSize() * 1.6;
            if (sample.fullscreen) {
                this.label(sample.toggleOriginal ? "Original Image" : sample.methodLabel(sample.currentMethod), 448.0 * sx, 28.0 * sy - lineHeight);
            } else {
                this.label("Original Image", 96.0 * sx, 216.0 * sy - lineHeight);
                this.label(sample.methodLabel(sample.currentMethod), 1014.0 * sx, 216.0 * sy - lineHeight);
            }
        }

        // Declared after buildUI: tslang resolves `this.buildUI` only for members declared earlier.
        init(app: App): boolean {
            return !app.addImGuiPass(this.buildUI).isNull();
        }
    }

    export function main(argc: int, argv: Ref<string>): int {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("fast_block_compress");

        // -debug: the graphics API's debug layer and NVRHI's validation layer.
        // -noui: without the controls and text.
        // -image <n>, -method <n> (0 GPU, 1 CPU, 2 offline, 3 offline BC7), -mip <n>: what is shown.
        // -fullscreen [original]: one image full size (the method's, or the original).
        // -highlight: block boundaries highlighted. -diffs <n>: 1 color, 2 alpha differences.
        // The back buffers are UNORM, as the sample's (B8G8R8A8_UNORM): values shown as stored.
        let options = AppOptions.UnormBackBuffer;
        let withUI = true;
        let image = 0;
        let method = 0;
        let mip = 0;
        let fullscreen = false;
        let original = false;
        let highlight = false;
        let diffs = 0;
        for (let i = 1; i < argc; i++) {
            const arg = Donut_GetArg(argv, i);
            if (arg == "-debug") {
                options = options | AppOptions.DebugRuntime;
            } else if (arg == "-noui") {
                withUI = false;
            } else if (arg == "-image" && i + 1 < argc) {
                i++;
                image = Math.min(Math.max(parseInt(Donut_GetArg(argv, i)), 0), IMAGE_NAMES.length - 1);
            } else if (arg == "-method" && i + 1 < argc) {
                i++;
                method = Math.min(Math.max(parseInt(Donut_GetArg(argv, i)), 0), MAX_METHOD - 1);
            } else if (arg == "-mip" && i + 1 < argc) {
                i++;
                mip = Math.max(parseInt(Donut_GetArg(argv, i)), 0);
            } else if (arg == "-fullscreen") {
                fullscreen = true;
                if (i + 1 < argc && Donut_GetArg(argv, i + 1) == "original") {
                    i++;
                    original = true;
                }
            } else if (arg == "-highlight") {
                highlight = true;
            } else if (arg == "-diffs" && i + 1 < argc) {
                i++;
                diffs = parseInt(Donut_GetArg(argv, i));
            }
        }

        // The sample's 1920 x 1080, in a smaller window.
        const api = Donut_GetGraphicsAPIFromCommandLine(argc, argv);
        const app = App.createWithOptions(api, WINDOW_TITLE, 1280, 720, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        const pass = new FastBlockCompressPass(app);
        if (!pass.init()) {
            app.destroy();
            return 1;
        }
        pass.currentImage = image;
        pass.currentMethod = method;
        pass.mipLevel = mip;
        pass.fullscreen = fullscreen;
        pass.toggleOriginal = original;
        pass.highlightBlocks = highlight;
        pass.colorDiffs = diffs == 1;
        pass.alphaDiffs = diffs == 2;

        if (withUI) {
            const ui = new UserInterface(pass);
            if (!ui.init(app)) {
                app.destroy();
                return 1;
            }
        }

        const input = new InputPass(app.handle);

        app.run();
        app.destroy();
        return 0;
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>): int {
    return FastBlockCompress.main(argc, argv);
}
