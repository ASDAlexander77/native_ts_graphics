// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";

namespace SparseImage {
    const WINDOW_TITLE = "Donut Example: Sparse Image";

    // The sample's texture (Vulkan-Samples' asset, converted to DDS at build time: see
    // VULKAN_SAMPLES_ASSETS_DIR in CMakeLists.txt): its first level, kept on the CPU's side.
    const TEXTURE_PATH = "media/sparse_image/vulkan_logo_full.dds";

    // The sample's state machine (Stages).
    const STAGE_IDLE = 0;
    const STAGE_CALCULATE_MIPS_TABLE = 1;
    const STAGE_COMPARE_MIPS_TABLE = 2;
    const STAGE_FREE_MEMORY = 3;
    const STAGE_PROCESS_TEXTURE_BLOCKS = 4;
    const STAGE_UPDATE_AND_GENERATE = 5;

    const FRAME_COUNTER_CAP = 10;
    const MEMORY_FRAGMENTATION_CAP = 20;
    const PAGES_PER_ALLOC = 50;
    const FOV_DEGREES = 60.0;
    // The number of levels is arbitrary: 5 fit the design (a 6th would be used from too far away).
    // More would need the mip tail handled.
    const MIP_LEVELS = 5;
    // RGBA8.
    const TEXEL_SIZE = 4;

    // The plane: 200 x 200 units at z = 0, the texture over it.
    const PLANE_HALF_SIZE = 100.0;

    // struct MVP { float4x4 model, view, proj; }, as f32 offsets.
    const MVP_MODEL = 0;
    const MVP_VIEW = 16;
    const MVP_PROJ = 32;
    const MVP_FLOATS = 48;
    // struct SettingsData { uint colorHighlight; int minLOD, maxLOD; }, padded to 16 bytes.
    const SETTINGS_INTS = 4;

    // The sample's camera: first person, 50 units back, 60 degrees vertically, depth from 0.1 to
    // 1024; WASD moves it 20 units per second.
    const CAMERA_POSITION = [0.0, 0.0, -50.0];
    const Z_NEAR = 0.1;
    const Z_FAR = 1024.0;
    const TRANSLATION_SPEED = 20.0;
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
    const MOUSE_BUTTON_LEFT = 0;
    const MOUSE_BUTTON_RIGHT = 1;
    const MOUSE_BUTTON_MIDDLE = 2;
    const ACTION_RELEASE = 0;
    const ACTION_PRESS = 1;

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

    // glm::perspective(fov, aspect, near, far): right-handed, depth from 0 to 1.
    function perspective(fov: number, aspect: number, zNear: number, zFar: number): number[] {
        const tanHalfFovy = Math.tan(0.5 * fov);
        return [
            1.0 / (aspect * tanHalfFovy), 0.0,               0.0,                              0.0,
            0.0,                          1.0 / tanHalfFovy, 0.0,                              0.0,
            0.0,                          0.0,               zFar / (zNear - zFar),            -1.0,
            0.0,                          0.0,               -(zFar * zNear) / (zFar - zNear), 0.0,
        ];
    }

    // std::max and std::min, which keep their first argument when a comparison involves NaN (as
    // the sample's mip level arithmetic can).
    function stdMax(a: number, b: number): number {
        return a < b ? b : a;
    }

    function stdMin(a: number, b: number): number {
        return b < a ? b : a;
    }

    // --- Sorted int arrays (the sample's std::set) ----------------------------------------------

    // The first position whose value isn't below value.
    function lowerBound(values: int[], value: int): int {
        let low = 0;
        let high = values.length;
        while (low < high) {
            const middle = Math.floor((low + high) / 2);
            if (values[middle] < value) {
                low = middle + 1;
            } else {
                high = middle;
            }
        }
        return low;
    }

    function sortedInsert(values: int[], value: int): void {
        const position = lowerBound(values, value);
        if (position < values.length && values[position] == value) {
            return;
        }
        values.push(value);
        for (let i = values.length - 1; i > position; i--) {
            values[i] = values[i - 1];
        }
        values[position] = value;
    }

    function sortedRemove(values: int[], value: int): void {
        const position = lowerBound(values, value);
        if (position >= values.length || values[position] != value) {
            return;
        }
        for (let i = position; i < values.length - 1; i++) {
            values[i] = values[i + 1];
        }
        values.pop();
    }

    // --- The sample's data ----------------------------------------------------------------------

    class MipProperties {
        numRows: int;
        numColumns: int;
        mipNumPages: int;
        mipBasePageIndex: int;
        width: int;
        height: int;

        constructor() {
            this.numRows = 0;
            this.numColumns = 0;
            this.mipNumPages = 0;
            this.mipBasePageIndex = 0;
            this.width = 0;
            this.height = 0;
        }
    }

    // A BLOCK whose required level or visibility changed.
    class TextureBlock {
        row: int;
        column: int;
        oldMipLevel: number;
        newMipLevel: number;
        onScreen: boolean;

        constructor(row: int, column: int, oldMipLevel: number, newMipLevel: number, onScreen: boolean) {
            this.row = row;
            this.column = column;
            this.oldMipLevel = oldMipLevel;
            this.newMipLevel = newMipLevel;
            this.onScreen = onScreen;
        }
    }

    // TextureBlock::operator<: by new level, then column, then row.
    function blockLess(a: TextureBlock, b: TextureBlock): boolean {
        if (a.newMipLevel == b.newMipLevel) {
            if (a.column == b.column) {
                return a.row < b.row;
            }
            return a.column < b.column;
        }
        return a.newMipLevel < b.newMipLevel;
    }

    // In the set's order: a merge sort.
    function sortBlocks(blocks: TextureBlock[]): TextureBlock[] {
        let source = blocks;
        for (let width = 1; width < source.length; width *= 2) {
            let merged: TextureBlock[] = [];
            for (let start = 0; start < source.length; start += 2 * width) {
                const middle = Math.min(start + width, source.length);
                const end = Math.min(start + 2 * width, source.length);
                let i = start;
                let j = middle;
                while (i < middle && j < end) {
                    if (blockLess(source[j], source[i])) {
                        merged.push(source[j]);
                        j++;
                    } else {
                        merged.push(source[i]);
                        i++;
                    }
                }
                while (i < middle) {
                    merged.push(source[i]);
                    i++;
                }
                while (j < end) {
                    merged.push(source[j]);
                    j++;
                }
            }
            source = merged;
        }
        return source;
    }

    // A sector: one allocation of PAGES_PER_ALLOC pages (a heap). The sample's shared_ptr: the
    // pages using it (and, while defragmenting, the sectors being emptied) hold references; with
    // none left it is gone (its weak_ptr in the list expired).
    class MemSector {
        heap: HeapHandle;
        // Free page offsets in bytes, and the pages using the others: sorted.
        availableOffsets: int[];
        virtPageIndices: int[];
        references: int;

        constructor(heap: HeapHandle, pageSize: int) {
            this.heap = heap;
            this.availableOffsets = [];
            for (let i = 0; i < PAGES_PER_ALLOC; i++) {
                this.availableOffsets.push(pageSize * i);
            }
            this.virtPageIndices = [];
            this.references = 0;
        }
    }

    // --- The pass -------------------------------------------------------------------------------

    // Port of Vulkan-Samples' sparse_image: a 3624 x 3624 texture with 5 levels on a large plane,
    // its memory mapped page by page (64 KiB tiles) as the view needs them. Each frame does one step
    // of a state machine: estimate the level each block of the plane needs from how the camera sees
    // it, compare that with what is there, free the pages nobody needs (moving pages out of sparse
    // sectors, with defragmentation on), then process some blocks: the pages they need are mapped
    // and filled, level 0 from the CPU-side data, the others from the level above. The fragment
    // shader uses the most detailed level that is mapped at each pixel.
    class SparseImagePass {
        private app: App;

        // The sample's settings.
        colorHighlight: boolean;
        colorHighlightChanged: boolean;
        memoryDefragmentation: boolean;
        frameCounterFeature: boolean;
        blocksToUpdatePerCycle: int;
        numVerticalBlocksUpd: int;
        numHorizontalBlocksUpd: int;
        private numVerticalBlocks: int;
        private numHorizontalBlocks: int;

        private updateRequired: boolean;
        private frameCounterPerTransfer: int;
        private nextStage: int;

        // The sample's camera: rotation (degrees about x, y, z) and position; keys and mouse.
        private cameraRotation: number[];
        private cameraPosition: number[];
        private keyUp: boolean;
        private keyDown: boolean;
        private keyLeft: boolean;
        private keyRight: boolean;
        private leftButton: boolean;
        private rightButton: boolean;
        private middleButton: boolean;
        private mouseX: number;
        private mouseY: number;
        // proj * view * model, the sample's (Vulkan's clip space), for the level estimate.
        private currentMvpTransform: number[];

        // The texture and its pages.
        private texture: TextureHandle;
        private stagingTexture: StagingTextureHandle;
        private width: int;
        private height: int;
        private tileWidth: int;
        private tileHeight: int;
        private pageSize: int;
        private mipProperties: MipProperties[];
        private pageCount: int;
        // Per page: its level, tile column and row, and texel rectangle (cut at the level's edge).
        private pageMip: int[];
        private pageTileX: int[];
        private pageTileY: int[];
        private pageOffsetX: int[];
        private pageOffsetY: int[];
        private pageExtentWidth: int[];
        private pageExtentHeight: int[];
        // The page table: mapped and filled; needed to generate a level below; never freed (the
        // least detailed level); its memory (sector, -1 for none, and offset); the BLOCKS (level,
        // column, row, as keys) that need it to be valid for rendering.
        private pageValid: boolean[];
        private pageGenMipRequired: boolean[];
        private pageFixed: boolean[];
        private pageSector: int[];
        private pageMemoryOffset: int[];
        private pageRenderRequired: int[][];
        // What the last binding mapped each page to (vkQueueBindSparse's binds, kept across calls).
        private bindSector: int[];
        private bindOffset: int[];
        // Pages to fill (the sample's update_set): flags, walked in page order.
        private pageInUpdateSet: boolean[];

        // Sectors, by index; the sample's list of them (weak_ptrs), front first.
        private sectors: MemSector[];
        private sectorList: int[];
        // Heaps of sectors that are gone, released once nothing is mapped to them any more.
        private heapsToRelease: HeapHandle[];

        // Per BLOCK (row-major): the level present and the level needed, and on screen.
        private currentMipLevel: number[];
        private currentOnScreen: boolean[];
        private newMipLevel: number[];
        private newOnScreen: boolean[];
        // The blocks to update (texture_block_update_set): sorted, from updateBlocksStart on.
        private updateBlocks: TextureBlock[];
        private updateBlocksStart: int;

        // CalculateMipLevelData: the plane's grid of (blocks + 1)^2 nodes on screen, the slopes of
        // its lines, and the screen's size when it was set up (the sample keeps it after resizes).
        private meshX: number[];
        private meshY: number[];
        private meshOnScreen: boolean[];
        private axVertical: number[];
        private axHorizontal: number[];
        private meshMipLevel: number[];
        private meshOnScreenBlock: boolean[];
        private screenWidth: int;
        private screenHeight: int;

        // Drawing.
        private sceneVS: ShaderHandle;
        private scenePS: ShaderHandle;
        private mipVS: ShaderHandle;
        private mipPS: ShaderHandle;
        private inputLayout: InputLayoutHandle;
        private sceneBindingLayout: BindingLayoutHandle;
        private mipBindingLayout: BindingLayoutHandle;
        private mvpBuffer: BufferHandle;
        private settingsBuffer: BufferHandle;
        private sceneBindingSet: BindingSet;
        private vertexBuffer: BufferHandle;
        private indexBuffer: BufferHandle;
        // Per level: a framebuffer of it (from 1), and a binding set reading it (to 3).
        private mipFramebuffers: Opaque[];
        private mipBindingSets: BindingSet[];
        private mipPipeline: Opaque;
        private scenePipelineCreated: boolean;
        private scenePipeline: Opaque;
        // The frame's command list holds work not executed yet.
        private pendingCommands: boolean;
        private started: boolean;

        private mvp: f32[];
        private settings: int[];

        constructor(app: App) {
            this.app = app;
            this.colorHighlight = true;
            this.colorHighlightChanged = false;
            this.memoryDefragmentation = true;
            this.frameCounterFeature = true;
            this.blocksToUpdatePerCycle = 25;
            this.numVerticalBlocks = 50;
            this.numHorizontalBlocks = 50;
            this.numVerticalBlocksUpd = 50;
            this.numHorizontalBlocksUpd = 50;
            this.updateRequired = false;
            this.frameCounterPerTransfer = 0;
            this.nextStage = STAGE_IDLE;

            this.cameraRotation = [0.0, 0.0, 0.0];
            this.cameraPosition = [CAMERA_POSITION[0], CAMERA_POSITION[1], CAMERA_POSITION[2]];
            this.keyUp = false;
            this.keyDown = false;
            this.keyLeft = false;
            this.keyRight = false;
            this.leftButton = false;
            this.rightButton = false;
            this.middleButton = false;
            this.mouseX = 0.0;
            this.mouseY = 0.0;
            this.currentMvpTransform = [];

            this.width = 0;
            this.height = 0;
            this.tileWidth = 0;
            this.tileHeight = 0;
            this.pageSize = 0;
            this.mipProperties = [];
            this.pageCount = 0;
            this.pageMip = [];
            this.pageTileX = [];
            this.pageTileY = [];
            this.pageOffsetX = [];
            this.pageOffsetY = [];
            this.pageExtentWidth = [];
            this.pageExtentHeight = [];
            this.pageValid = [];
            this.pageGenMipRequired = [];
            this.pageFixed = [];
            this.pageSector = [];
            this.pageMemoryOffset = [];
            this.pageRenderRequired = [];
            this.bindSector = [];
            this.bindOffset = [];
            this.pageInUpdateSet = [];
            this.sectors = [];
            this.sectorList = [];
            this.heapsToRelease = [];

            this.currentMipLevel = [];
            this.currentOnScreen = [];
            this.newMipLevel = [];
            this.newOnScreen = [];
            this.updateBlocks = [];
            this.updateBlocksStart = 0;

            this.meshX = [];
            this.meshY = [];
            this.meshOnScreen = [];
            this.axVertical = [];
            this.axHorizontal = [];
            this.meshMipLevel = [];
            this.meshOnScreenBlock = [];
            this.screenWidth = 0;
            this.screenHeight = 0;

            this.mipFramebuffers = [];
            this.mipBindingSets = [];
            this.scenePipelineCreated = false;
            this.pendingCommands = false;
            this.started = false;

            this.mvp = [];
            for (let i = 0; i < MVP_FLOATS; i++) {
                this.mvp.push(0.0);
            }
            this.settings = [];
            for (let i = 0; i < SETTINGS_INTS; i++) {
                this.settings.push(0);
            }
        }

        // --- Input ------------------------------------------------------------------------------

        // ApiVulkanSample's keys: WASD move the camera while held.
        onKeyboard(key: int, scancode: int, action: int, mods: int): int {
            if (action != ACTION_PRESS && action != ACTION_RELEASE) {
                return 0;
            }
            const pressed = action == ACTION_PRESS;
            if (key == KEY_W) {
                this.keyUp = pressed;
            } else if (key == KEY_S) {
                this.keyDown = pressed;
            } else if (key == KEY_A) {
                this.keyLeft = pressed;
            } else if (key == KEY_D) {
                this.keyRight = pressed;
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

        // The framework's first person camera: WASD along the view direction and sideways.
        onAnimate(elapsedSeconds: number): void {
            if (this.keyUp || this.keyDown || this.keyLeft || this.keyRight) {
                const rx = radians(this.cameraRotation[0]);
                const ry = radians(this.cameraRotation[1]);
                let fx = -Math.cos(rx) * Math.sin(ry);
                let fy = Math.sin(rx);
                let fz = Math.cos(rx) * Math.cos(ry);
                const length = Math.sqrt(fx * fx + fy * fy + fz * fz);
                fx /= length;
                fy /= length;
                fz /= length;
                // normalize(cross(front, (0, 1, 0)))
                const sideLength = Math.sqrt(fz * fz + fx * fx);
                const sx = -fz / sideLength;
                const sz = fx / sideLength;

                const moveSpeed = elapsedSeconds * TRANSLATION_SPEED;
                const p = this.cameraPosition;
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
                    p[0] -= sx * moveSpeed;
                    p[2] -= sz * moveSpeed;
                }
                if (this.keyRight) {
                    p[0] += sx * moveSpeed;
                    p[2] += sz * moveSpeed;
                }
            }
            this.app.setInformativeWindowTitle(WINDOW_TITLE);
        }

        // --- Pages ------------------------------------------------------------------------------

        // get_mip_level: the level a page belongs to.
        getMipLevel(pageIndex: int): int {
            for (let i = 0; i < MIP_LEVELS; i++) {
                const mip = this.mipProperties[i];
                if (pageIndex < mip.mipBasePageIndex + mip.mipNumPages) {
                    return i;
                }
            }
            return 255;
        }

        getPageIndex(mipLevel: int, x: int, y: int): int {
            const mip = this.mipProperties[mipLevel];
            return mip.mipBasePageIndex + mip.numColumns * y + x;
        }

        // The keys of render_required_set: (level, column, row).
        blockKey(mipLevel: int, column: int, row: int): int {
            return mipLevel * 65536 + column * 256 + row;
        }

        // MemAllocInfo::get_allocation: a free page in the front sector, or in a new sector put in
        // front when that one is gone or full.
        getAllocation(pageIndex: int): void {
            let sectorIndex = -1;
            if (this.sectorList.length > 0) {
                const front = this.sectors[this.sectorList[0]];
                if (front.references > 0 && front.availableOffsets.length > 0) {
                    sectorIndex = this.sectorList[0];
                }
            }
            if (sectorIndex < 0) {
                const heap = this.app.createTileHeap(this.pageSize * PAGES_PER_ALLOC, "MemSector");
                sectorIndex = this.sectors.length;
                this.sectors.push(new MemSector(heap, this.pageSize));
                this.sectorList.push(0);
                for (let i = this.sectorList.length - 1; i > 0; i--) {
                    this.sectorList[i] = this.sectorList[i - 1];
                }
                this.sectorList[0] = sectorIndex;
            }
            const sector = this.sectors[sectorIndex];
            this.setPageSector(pageIndex, sectorIndex);
            this.pageMemoryOffset[pageIndex] = sector.availableOffsets[0];
            sortedRemove(sector.availableOffsets, this.pageMemoryOffset[pageIndex]);
            sortedInsert(sector.virtPageIndices, pageIndex);
        }

        // A page's memory_sector (shared_ptr) set to a sector or reset (-1).
        setPageSector(pageIndex: int, sectorIndex: int): void {
            if (sectorIndex >= 0) {
                this.sectors[sectorIndex].references++;
            }
            const previous = this.pageSector[pageIndex];
            this.pageSector[pageIndex] = sectorIndex;
            if (previous >= 0) {
                this.releaseSector(previous);
            }
        }

        // One reference to a sector dropped: with none left its memory goes (once unmapped).
        releaseSector(sectorIndex: int): void {
            const sector = this.sectors[sectorIndex];
            sector.references--;
            if (sector.references == 0) {
                this.heapsToRelease.push(sector.heap);
            }
        }

        // bind_sparse_image: maps the pages needed and not mapped yet, unmaps the others. Work
        // recorded before runs first.
        bindSparseImage(frame: Frame): void {
            if (this.pendingCommands) {
                this.app.submitFrameCommandList(frame);
                this.pendingCommands = false;
            }

            for (let pageIndex = 0; pageIndex < this.pageCount; pageIndex++) {
                if (!this.pageGenMipRequired[pageIndex] && this.pageRenderRequired[pageIndex].length == 0) {
                    this.bindSector[pageIndex] = -1;
                    continue;
                }
                if (this.pageValid[pageIndex]) {
                    continue;
                }
                this.getAllocation(pageIndex);
                this.bindSector[pageIndex] = this.pageSector[pageIndex];
                this.bindOffset[pageIndex] = this.pageMemoryOffset[pageIndex];
            }

            const mappings = TileMappings.create();
            for (let pageIndex = 0; pageIndex < this.pageCount; pageIndex++) {
                const sectorIndex = this.bindSector[pageIndex];
                if (sectorIndex >= 0) {
                    mappings.add(this.pageMip[pageIndex], this.pageTileX[pageIndex], this.pageTileY[pageIndex],
                        this.sectors[sectorIndex].heap, this.bindOffset[pageIndex]);
                } else {
                    mappings.add(this.pageMip[pageIndex], this.pageTileX[pageIndex], this.pageTileY[pageIndex], null, 0);
                }
            }
            this.app.applyTileMappings(this.texture, mappings);

            // The sample's MemSector destructor waits for the device before freeing its memory.
            if (this.heapsToRelease.length > 0) {
                this.app.waitForIdle();
                for (let i = 0; i < this.heapsToRelease.length; i++) {
                    this.app.releaseResource(this.heapsToRelease[i]);
                }
                this.heapsToRelease = [];
            }
        }

        // get_memory_dependency_for_the_block: the pages of a level a BLOCK covers.
        getMemoryDependencyForTheBlock(column: int, row: int, mipLevel: int): int[] {
            let dependencies: int[] = [];

            const heightOnScreenDivider = 1.0 / this.numVerticalBlocks;
            const widthOnScreenDivider = 1.0 / this.numHorizontalBlocks;

            const xLow = widthOnScreenDivider * column;
            const xHigh = widthOnScreenDivider * (column + 1);
            const yLow = heightOnScreenDivider * row;
            const yHigh = heightOnScreenDivider * (row + 1);

            const mip = this.mipProperties[mipLevel];
            const inMemoryRowPages = mip.height / this.tileHeight;
            const inMemoryColumnPages = mip.width / this.tileWidth;

            const memXLow = Math.floor(xLow * inMemoryColumnPages);
            const memXHigh = Math.ceil(xHigh * inMemoryColumnPages);
            const memYLow = Math.floor(yLow * inMemoryRowPages);
            const memYHigh = Math.ceil(yHigh * inMemoryRowPages);

            for (let y = memYLow; y < memYHigh; y++) {
                for (let x = memXLow; x < memXHigh; x++) {
                    dependencies.push(mip.mipBasePageIndex + mip.numColumns * y + x);
                }
            }
            return dependencies;
        }

        // check_mip_page_requirements: the 2 x 2 pages of the level above that a page is generated
        // from, marked as needed (and to fill if not valid), down to level 0.
        checkMipPageRequirements(required: int[], mipLevel: int, x: int, y: int): void {
            if (mipLevel == 0) {
                return;
            }
            const above = mipLevel - 1;
            const aboveMip = this.mipProperties[above];
            for (let dy = 0; dy < 2; dy++) {
                for (let dx = 0; dx < 2; dx++) {
                    const reqX = Math.min(x * 2 + dx, aboveMip.numColumns - 1);
                    const reqY = Math.min(y * 2 + dy, aboveMip.numRows - 1);
                    const pageIndex = this.getPageIndex(above, reqX, reqY);

                    this.pageGenMipRequired[pageIndex] = true;
                    if (!this.pageValid[pageIndex]) {
                        if (above > 0) {
                            required.push(pageIndex);
                        }
                        this.pageInUpdateSet[pageIndex] = true;
                    }
                }
            }
        }

        // process_texture_block: a BLOCK no longer needs its old level's pages; if on screen, it
        // needs its new level's, and those not valid are to be filled, with what they're generated
        // from.
        processTextureBlock(block: TextureBlock): void {
            const oldMip: int = Math.floor(block.oldMipLevel);
            let pageIndices = this.getMemoryDependencyForTheBlock(block.column, block.row, oldMip);
            const oldKey = this.blockKey(oldMip, block.column, block.row);
            for (let i = 0; i < pageIndices.length; i++) {
                const pageIndex = pageIndices[i];
                if (!this.pageFixed[pageIndex]) {
                    sortedRemove(this.pageRenderRequired[pageIndex], oldKey);
                }
            }

            if (!block.onScreen) {
                return;
            }

            const newMip: int = Math.floor(block.newMipLevel);
            pageIndices = this.getMemoryDependencyForTheBlock(block.column, block.row, newMip);
            const newKey = this.blockKey(newMip, block.column, block.row);
            for (let i = 0; i < pageIndices.length; i++) {
                const pageIndex = pageIndices[i];
                sortedInsert(this.pageRenderRequired[pageIndex], newKey);

                if (!this.pageValid[pageIndex]) {
                    this.pageInUpdateSet[pageIndex] = true;

                    // A stack of pages (by index) whose sources to check.
                    let required: int[] = [pageIndex];
                    while (required.length > 0) {
                        const page = required[required.length - 1];
                        required.pop();
                        this.checkMipPageRequirements(required, this.pageMip[page], this.pageTileX[page], this.pageTileY[page]);
                    }
                }
            }
        }

        // compare_mips_table: the BLOCKS whose visibility or required level changed.
        compareMipsTable(): void {
            let blocks: TextureBlock[] = [];
            for (let y = 0; y < this.numVerticalBlocks; y++) {
                for (let x = 0; x < this.numHorizontalBlocks; x++) {
                    const i = y * this.numHorizontalBlocks + x;
                    if (!this.newOnScreen[i] && this.currentOnScreen[i]) {
                        // Visible before, not any more: out of all render_required sets.
                        this.processTextureBlock(new TextureBlock(y, x, this.currentMipLevel[i], this.newMipLevel[i], false));
                        this.currentMipLevel[i] = this.newMipLevel[i];
                        this.currentOnScreen[i] = this.newOnScreen[i];
                        this.updateRequired = true;
                    } else if (this.newOnScreen[i] && (!this.currentOnScreen[i]
                        || Math.floor(this.newMipLevel[i]) != Math.floor(this.currentMipLevel[i]))) {
                        // Visible, and it wasn't, or it needs another level.
                        blocks.push(new TextureBlock(y, x, this.currentMipLevel[i], this.newMipLevel[i], true));
                        this.updateRequired = true;
                    }
                }
            }
            this.updateBlocks = sortBlocks(blocks);
            this.updateBlocksStart = 0;
        }

        updateBlockCount(): int {
            return this.updateBlocks.length - this.updateBlocksStart;
        }

        // process_texture_blocks: the next blocks_to_update_per_cycle of them.
        processTextureBlocks(): void {
            let blockCounter = Math.min(this.blocksToUpdatePerCycle, this.updateBlockCount());
            // uint8_t
            this.frameCounterPerTransfer = (this.frameCounterPerTransfer + 1) % 256;
            for (; blockCounter > 0; blockCounter--) {
                const block = this.updateBlocks[this.updateBlocksStart];
                this.processTextureBlock(block);
                const i = block.row * this.numHorizontalBlocks + block.column;
                this.currentMipLevel[i] = this.newMipLevel[i];
                this.currentOnScreen[i] = this.newOnScreen[i];
                this.updateBlocksStart++;
            }
        }

        // update_and_generate: maps the pages, then fills those to fill, in page order (so by
        // level): level 0 from the CPU-side data, the others from the level above.
        updateAndGenerate(frame: Frame): void {
            this.bindSparseImage(frame);

            const commandList = frame.getCommandList();
            for (let pageIndex = 0; pageIndex < this.pageCount; pageIndex++) {
                if (!this.pageInUpdateSet[pageIndex]) {
                    continue;
                }
                const mipLevel = this.pageMip[pageIndex];
                const x = this.pageOffsetX[pageIndex];
                const y = this.pageOffsetY[pageIndex];
                const w = this.pageExtentWidth[pageIndex];
                const h = this.pageExtentHeight[pageIndex];
                if (mipLevel == 0) {
                    commandList.copyStagingTextureRegion(this.texture, 0, x, y, this.stagingTexture, x, y, w, h);
                } else {
                    frame.beginDrawToFramebuffer(this.mipPipeline, this.mipFramebuffers[mipLevel]);
                    frame.drawAddBindingSet(this.mipBindingSets[mipLevel - 1]);
                    frame.drawSetViewport(x, y, w, h);
                    frame.drawVertices(3);
                }
                this.pageValid[pageIndex] = true;
                this.pageInUpdateSet[pageIndex] = false;
                this.pendingCommands = true;
            }

            for (let pageIndex = 0; pageIndex < this.pageCount; pageIndex++) {
                this.pageGenMipRequired[pageIndex] = false;
            }
        }

        // MemSectorCompare in std::list::sort (stable): sectors that are gone last, the others by
        // free pages, most first.
        sectorLess(left: int, right: int): boolean {
            const l = this.sectors[left];
            const r = this.sectors[right];
            if (l.references == 0) {
                return false;
            } else if (r.references == 0) {
                return true;
            }
            return l.availableOffsets.length > r.availableOffsets.length;
        }

        sortSectors(): void {
            const list = this.sectorList;
            for (let i = 1; i < list.length; i++) {
                const value = list[i];
                let j = i;
                while (j > 0 && this.sectorLess(value, list[j - 1])) {
                    list[j] = list[j - 1];
                    j--;
                }
                list[j] = value;
            }
        }

        // free_unused_memory: frees the pages no BLOCK needs for rendering, drops the sectors that
        // are gone, and with defragmentation moves the pages of sparse sectors (but the first) to
        // others; then maps.
        freeUnusedMemory(frame: Frame): void {
            for (let pageIndex = 0; pageIndex < this.pageCount; pageIndex++) {
                if (this.pageRenderRequired[pageIndex].length == 0 && this.pageValid[pageIndex]) {
                    this.pageValid[pageIndex] = false;
                    const sector = this.sectors[this.pageSector[pageIndex]];
                    sortedInsert(sector.availableOffsets, this.pageMemoryOffset[pageIndex]);
                    sortedRemove(sector.virtPageIndices, pageIndex);
                    this.setPageSector(pageIndex, -1);
                }
            }

            let reallocate: boolean[] = [];
            for (let pageIndex = 0; pageIndex < this.pageCount; pageIndex++) {
                reallocate.push(false);
            }
            let anyToReallocate = false;
            let sectorsToReallocate = 0;

            let kept: int[] = [];
            for (let i = 0; i < this.sectorList.length; i++) {
                const sector = this.sectors[this.sectorList[i]];
                if (sector.references == 0) {
                    continue;
                }
                kept.push(this.sectorList[i]);
                if (this.memoryDefragmentation && sector.availableOffsets.length > MEMORY_FRAGMENTATION_CAP) {
                    if (sectorsToReallocate > 0) {
                        // No more pages from this sector.
                        sector.availableOffsets = [];
                        for (let k = 0; k < sector.virtPageIndices.length; k++) {
                            reallocate[sector.virtPageIndices[k]] = true;
                            anyToReallocate = true;
                        }
                    }
                    sectorsToReallocate = (sectorsToReallocate + 1) % 256;
                }
            }
            this.sectorList = kept;

            if (!(this.memoryDefragmentation && anyToReallocate)) {
                this.sortSectors();
                this.bindSparseImage(frame);
                return;
            }

            // The pages to move: copied out to a texture of whole tiles (the sample's buffer), the
            // sectors kept until they're copied back.
            let pages: int[] = [];
            for (let pageIndex = 0; pageIndex < this.pageCount; pageIndex++) {
                if (reallocate[pageIndex]) {
                    pages.push(pageIndex);
                }
            }
            const columns = 16;
            const rows = Math.floor((pages.length + columns - 1) / columns);
            const reallocation = this.app.createRenderTargetTexture(columns * this.tileWidth, rows * this.tileHeight,
                Format.SRGBA8_UNORM, "ReallocationBuffer");
            const commandList = frame.getCommandList();
            for (let i = 0; i < pages.length; i++) {
                const pageIndex = pages[i];
                commandList.copyTextureRegion(reallocation, 0, (i % columns) * this.tileWidth, Math.floor(i / columns) * this.tileHeight,
                    this.texture, this.pageMip[pageIndex], this.pageOffsetX[pageIndex], this.pageOffsetY[pageIndex],
                    this.pageExtentWidth[pageIndex], this.pageExtentHeight[pageIndex]);
            }
            this.pendingCommands = true;

            let tempSectors: int[] = [];
            for (let i = 0; i < pages.length; i++) {
                const pageIndex = pages[i];
                const sectorIndex = this.pageSector[pageIndex];
                this.sectors[sectorIndex].references++;
                tempSectors.push(sectorIndex);
                sortedRemove(this.sectors[sectorIndex].virtPageIndices, pageIndex);
                this.setPageSector(pageIndex, -1);
                this.pageValid[pageIndex] = false;
            }

            this.sortSectors();
            this.bindSparseImage(frame);

            for (let i = 0; i < pages.length; i++) {
                const pageIndex = pages[i];
                commandList.copyTextureRegion(this.texture, this.pageMip[pageIndex], this.pageOffsetX[pageIndex], this.pageOffsetY[pageIndex],
                    reallocation, 0, (i % columns) * this.tileWidth, Math.floor(i / columns) * this.tileHeight,
                    this.pageExtentWidth[pageIndex], this.pageExtentHeight[pageIndex]);
                this.pageValid[pageIndex] = true;
            }
            this.app.releaseResource(reallocation);

            for (let i = 0; i < tempSectors.length; i++) {
                this.releaseSector(tempSectors[i]);
            }
        }

        // --- The level estimate -----------------------------------------------------------------

        // reset_mip_table: both tables at the block counts, nothing on screen yet; the pages' BLOCK
        // sets emptied (but the fixed ones').
        resetMipTable(): void {
            const count = this.numVerticalBlocks * this.numHorizontalBlocks;
            this.currentMipLevel = [];
            this.currentOnScreen = [];
            this.newMipLevel = [];
            this.newOnScreen = [];
            for (let i = 0; i < count; i++) {
                this.currentMipLevel.push(0.0);
                this.currentOnScreen.push(false);
                this.newMipLevel.push(0.0);
                this.newOnScreen.push(true);
            }
            for (let pageIndex = 0; pageIndex < this.pageCount; pageIndex++) {
                if (!this.pageFixed[pageIndex]) {
                    this.pageRenderRequired[pageIndex] = [];
                }
            }
        }

        // calculate_mesh_coordinates: the plane's grid nodes on screen (pixels from the center),
        // through the sample's MVP, and the slopes of its first row and column of edges.
        calculateMeshCoordinates(): void {
            const vertical = this.numVerticalBlocks;
            const horizontal = this.numHorizontalBlocks;
            const hInterval = (2.0 * PLANE_HALF_SIZE) / horizontal;
            const vInterval = (2.0 * PLANE_HALF_SIZE) / vertical;
            const halfWidth = this.screenWidth / 2.0;
            const halfHeight = this.screenHeight / 2.0;
            const m = this.currentMvpTransform;

            this.meshX = [];
            this.meshY = [];
            this.meshOnScreen = [];
            for (let v = 0; v < vertical + 1; v++) {
                for (let h = 0; h < horizontal + 1; h++) {
                    const xNorm = -PLANE_HALF_SIZE + h * hInterval;
                    const yNorm = -PLANE_HALF_SIZE + v * vInterval;

                    // mvp * (xNorm, yNorm, 0, 1)
                    const rx = m[0] * xNorm + m[4] * yNorm + m[12];
                    const ry = m[1] * xNorm + m[5] * yNorm + m[13];
                    const rw = m[3] * xNorm + m[7] * yNorm + m[15];

                    const x = 0.5 * this.screenWidth * rx / Math.abs(rw);
                    const y = 0.5 * this.screenHeight * ry / Math.abs(rw);
                    this.meshX.push(x);
                    this.meshY.push(y);
                    this.meshOnScreen.push((-halfWidth < x) && (x < halfWidth) && (-halfHeight < y) && (y < halfHeight) && (0.0 < rw));
                }
            }

            const stride = horizontal + 1;
            this.axHorizontal = [];
            for (let v = 0; v < vertical + 1; v++) {
                const dx = this.meshX[v * stride] - this.meshX[v * stride + 1];
                if (Math.abs(dx) < 0.01) {
                    this.axHorizontal.push(1000.0);
                } else {
                    this.axHorizontal.push((this.meshY[v * stride] - this.meshY[v * stride + 1]) / dx);
                }
            }
            this.axVertical = [];
            for (let h = 0; h < horizontal + 1; h++) {
                const dx = this.meshX[h] - this.meshX[stride + h];
                if (Math.abs(dx) < 0.01) {
                    this.axVertical.push(1000.0);
                } else {
                    this.axVertical.push((this.meshY[h] - this.meshY[stride + h]) / dx);
                }
            }
        }

        // calculate_mip_levels: per BLOCK, the level from how many texels a pixel step on screen
        // covers on the texture (log2 of the largest ratio along the block's edges), see the
        // sample's comments; on screen if any of its corners is.
        calculateMipLevels(): void {
            const numRows = this.numVerticalBlocks;
            const numColumns = this.numHorizontalBlocks;
            const stride = numColumns + 1;
            const mx = this.meshX;
            const my = this.meshY;

            // Single, on-texture step in texels (an integer division in the sample: unsigned sizes)
            const dTu = Math.floor(this.width / numColumns);
            const dTv = Math.floor(this.height / numRows);

            this.meshMipLevel = [];
            this.meshOnScreenBlock = [];
            for (let row = 0; row < numRows; row++) {
                for (let column = 0; column < numColumns; column++) {
                    const a = row * stride + column;
                    const b = (row + 1) * stride + column;
                    const c = row * stride + column + 1;
                    const d = (row + 1) * stride + column + 1;

                    // Single, on-screen step in pixels
                    const dIxVertical = mx[a] - mx[b];
                    const dIyVertical = my[a] - my[b];
                    const dIxHorizontal = mx[a] - mx[c];
                    const dIyHorizontal = my[a] - my[c];

                    // On-screen distance between starting node (A) and the next horizontal (C) or vertical (B) one
                    const abVertical = Math.sqrt(dIxVertical * dIxVertical + dIyVertical * dIyVertical);
                    const acHorizontal = Math.sqrt(dIxHorizontal * dIxHorizontal + dIyHorizontal * dIyHorizontal);

                    // Coordinates of point H
                    const pHVerticalX = mx[a];
                    const pHVerticalY = my[b];
                    const pHHorizontalX = mx[c];
                    const pHHorizontalY = my[a];

                    // Distance from horizontal and vertical point H, to A and C
                    const pHVerticalToA = Math.sqrt((mx[a] - pHVerticalX) * (mx[a] - pHVerticalX) + (my[a] - pHVerticalY) * (my[a] - pHVerticalY));
                    const pHVerticalToB = Math.sqrt((mx[b] - pHVerticalX) * (mx[b] - pHVerticalX) + (my[b] - pHVerticalY) * (my[b] - pHVerticalY));
                    const pHHorizontalToA = Math.sqrt((mx[a] - pHHorizontalX) * (mx[a] - pHHorizontalX) + (my[a] - pHHorizontalY) * (my[a] - pHHorizontalY));
                    const pHHorizontalToC = Math.sqrt((mx[c] - pHHorizontalX) * (mx[c] - pHHorizontalX) + (my[c] - pHHorizontalY) * (my[c] - pHHorizontalY));

                    // 'a' coefficient of the linear equation ax + b = y
                    const aVertical = this.axVertical[column];
                    const aHorizontal = this.axHorizontal[row];

                    // Where the lines AB or AC meet the lines through H parallel to AC or AB
                    const xVerticalVertical = (aVertical * mx[a] + pHVerticalY - (pHVerticalX * aHorizontal) - my[a]) / (aVertical - aHorizontal);
                    const yVerticalVertical = (xVerticalVertical - mx[a]) * aVertical + my[a];

                    const xVerticalHorizontalTop = (aHorizontal * mx[a] + pHVerticalY - (pHVerticalX * aVertical) - my[a]) / (aHorizontal - aVertical);
                    const yVerticalHorizontalTop = (xVerticalHorizontalTop - mx[a]) * aHorizontal + my[a];
                    const xVerticalHorizontalBottom = (aHorizontal * mx[b] + pHVerticalY - (pHVerticalX * aVertical) - my[b]) / (aHorizontal - aVertical);
                    const yVerticalHorizontalBottom = (xVerticalHorizontalBottom - mx[b]) * aHorizontal + my[b];

                    const xHorizontalHorizontal = (aHorizontal * mx[a] + pHHorizontalY - (pHHorizontalX * aVertical) - my[a]) / (aHorizontal - aVertical);
                    const yHorizontalHorizontal = (xHorizontalHorizontal - mx[a]) * aHorizontal + my[a];

                    const xHorizontalVerticalLeft = (aVertical * mx[a] + pHHorizontalY - (pHHorizontalX * aHorizontal) - my[a]) / (aVertical - aHorizontal);
                    const yHorizontalVerticalLeft = (xHorizontalVerticalLeft - mx[a]) * aVertical + my[a];
                    const xHorizontalVerticalRight = (aVertical * mx[c] + pHHorizontalY - (pHHorizontalX * aHorizontal) - my[c]) / (aVertical - aHorizontal);
                    const yHorizontalVerticalRight = (xHorizontalVerticalRight - mx[c]) * aVertical + my[c];

                    // On-screen distances from point H (vertical and horizontal) to the points above
                    const onScreenPHVerticalVertical = Math.sqrt((pHVerticalX - xVerticalVertical) * (pHVerticalX - xVerticalVertical)
                        + (pHVerticalY - yVerticalVertical) * (pHVerticalY - yVerticalVertical));
                    const onScreenPHVerticalHorizontalTop = Math.sqrt((pHVerticalX - xVerticalHorizontalTop) * (pHVerticalX - xVerticalHorizontalTop)
                        + (pHVerticalY - yVerticalHorizontalTop) * (pHVerticalY - yVerticalHorizontalTop));
                    const onScreenPHVerticalHorizontalBottom = Math.sqrt((pHVerticalX - xVerticalHorizontalBottom) * (pHVerticalX - xVerticalHorizontalBottom)
                        + (pHVerticalY - yVerticalHorizontalBottom) * (pHVerticalY - yVerticalHorizontalBottom));
                    const onScreenPHHorizontalHorizontal = Math.sqrt((pHHorizontalX - xHorizontalHorizontal) * (pHHorizontalX - xHorizontalHorizontal)
                        + (pHHorizontalY - yHorizontalHorizontal) * (pHHorizontalY - yHorizontalHorizontal));
                    const onScreenPHHorizontalVerticalLeft = Math.sqrt((pHHorizontalX - xHorizontalVerticalLeft) * (pHHorizontalX - xHorizontalVerticalLeft)
                        + (pHHorizontalY - yHorizontalVerticalLeft) * (pHHorizontalY - yHorizontalVerticalLeft));
                    const onScreenPHHorizontalVerticalRight = Math.sqrt((pHHorizontalX - xHorizontalVerticalRight) * (pHHorizontalX - xHorizontalVerticalRight)
                        + (pHHorizontalY - yHorizontalVerticalRight) * (pHHorizontalY - yHorizontalVerticalRight));

                    // On-texture counterparts of the distances above
                    const onTexturePHVerticalVertical = onScreenPHVerticalVertical / acHorizontal * dTu;
                    const onTexturePHVerticalHorizontalTop = onScreenPHVerticalHorizontalTop / abVertical * dTv;
                    const onTexturePHVerticalHorizontalBottom = onScreenPHVerticalHorizontalBottom / abVertical * dTv;
                    const onTexturePHHorizontalHorizontal = onScreenPHHorizontalHorizontal / abVertical * dTv;
                    const onTexturePHHorizontalVerticalLeft = onScreenPHHorizontalVerticalLeft / acHorizontal * dTu;
                    const onTexturePHHorizontalVerticalRight = onScreenPHHorizontalVerticalRight / acHorizontal * dTu;

                    // Texel-to-pixel ratios
                    const xTextureToScreenVerticalRatio = Math.abs(pHVerticalToA) < 1.0 ? 0.0
                        : Math.sqrt(onTexturePHVerticalVertical * onTexturePHVerticalVertical + onTexturePHVerticalHorizontalTop * onTexturePHVerticalHorizontalTop) / Math.abs(pHVerticalToA);
                    const yTextureToScreenVerticalRatio = Math.abs(pHVerticalToB) < 1.0 ? 0.0
                        : Math.sqrt(onTexturePHVerticalVertical * onTexturePHVerticalVertical + onTexturePHVerticalHorizontalBottom * onTexturePHVerticalHorizontalBottom) / Math.abs(pHVerticalToB);
                    const xTextureToScreenHorizontalRatio = Math.abs(pHHorizontalToA) < 1.0 ? 0.0
                        : Math.sqrt(onTexturePHHorizontalHorizontal * onTexturePHHorizontalHorizontal + onTexturePHHorizontalVerticalLeft * onTexturePHHorizontalVerticalLeft) / Math.abs(pHHorizontalToA);
                    const yTextureToScreenHorizontalRatio = Math.abs(pHHorizontalToC) < 1.0 ? 0.0
                        : Math.sqrt(onTexturePHHorizontalHorizontal * onTexturePHHorizontalHorizontal + onTexturePHHorizontalVerticalRight * onTexturePHHorizontalVerticalRight) / Math.abs(pHHorizontalToC);

                    // Using the log2 formula to calculate the required level
                    const delta = stdMax(stdMax(xTextureToScreenHorizontalRatio, yTextureToScreenHorizontalRatio),
                        stdMax(xTextureToScreenVerticalRatio, yTextureToScreenVerticalRatio));
                    const mipLevel = stdMin(MIP_LEVELS - 1, stdMax(Math.log2(delta), 0.0));

                    this.meshMipLevel.push(mipLevel);
                    this.meshOnScreenBlock.push(this.meshOnScreen[a] || this.meshOnScreen[b] || this.meshOnScreen[c] || this.meshOnScreen[d]);
                }
            }
        }

        // calculate_mips_table: the grid (set up again if the block counts changed), then the
        // level each BLOCK needs.
        calculateMipsTable(): void {
            if (this.numVerticalBlocks != this.numVerticalBlocksUpd || this.numHorizontalBlocks != this.numHorizontalBlocksUpd) {
                this.numVerticalBlocks = this.numVerticalBlocksUpd;
                this.numHorizontalBlocks = this.numHorizontalBlocksUpd;
                this.resetMipTable();
            }

            this.calculateMeshCoordinates();
            this.calculateMipLevels();

            for (let i = 0; i < this.meshMipLevel.length; i++) {
                this.newMipLevel[i] = this.meshMipLevel[i];
                this.newOnScreen[i] = this.meshOnScreenBlock[i];
            }
        }

        // process_stage: the state machine, one step per frame.
        processStage(frame: Frame): void {
            const stage = this.nextStage;
            if (stage == STAGE_IDLE) {
                this.nextStage = STAGE_FREE_MEMORY;
            } else if (stage == STAGE_CALCULATE_MIPS_TABLE) {
                this.bindSparseImage(frame);
                this.calculateMipsTable();
                this.frameCounterPerTransfer = 0;
                this.nextStage = STAGE_COMPARE_MIPS_TABLE;
            } else if (stage == STAGE_COMPARE_MIPS_TABLE) {
                this.bindSparseImage(frame);
                this.compareMipsTable();
                this.nextStage = this.updateRequired ? STAGE_FREE_MEMORY : STAGE_CALCULATE_MIPS_TABLE;
            } else if (stage == STAGE_FREE_MEMORY) {
                this.freeUnusedMemory(frame);
                if (this.updateBlockCount() == 0) {
                    this.nextStage = STAGE_CALCULATE_MIPS_TABLE;
                    this.updateRequired = false;
                } else if (this.frameCounterFeature && this.frameCounterPerTransfer > FRAME_COUNTER_CAP) {
                    this.nextStage = STAGE_CALCULATE_MIPS_TABLE;
                } else {
                    this.nextStage = STAGE_PROCESS_TEXTURE_BLOCKS;
                }
            } else if (stage == STAGE_PROCESS_TEXTURE_BLOCKS) {
                this.bindSparseImage(frame);
                this.processTextureBlocks();
                this.nextStage = STAGE_UPDATE_AND_GENERATE;
            } else if (stage == STAGE_UPDATE_AND_GENERATE) {
                this.updateAndGenerate(frame);
                this.nextStage = STAGE_FREE_MEMORY;
            }
        }

        // load_least_detailed_level: the least detailed level made required by every BLOCK and
        // never freed, then filled (and with it, at first, every level: its pages are generated
        // from them).
        loadLeastDetailedLevel(frame: Frame): void {
            const least = this.mipProperties[MIP_LEVELS - 1];
            for (let pageIndex = least.mipBasePageIndex; pageIndex < least.mipBasePageIndex + least.mipNumPages; pageIndex++) {
                this.pageFixed[pageIndex] = true;
            }
            for (let i = 0; i < this.newMipLevel.length; i++) {
                this.newMipLevel[i] = MIP_LEVELS - 1;
            }

            this.compareMipsTable();
            while (this.updateBlockCount() > 0) {
                this.processTextureBlocks();
            }
            this.updateAndGenerate(frame);
        }

        // --- Frames -----------------------------------------------------------------------------

        // update_mvp: the camera's matrices; the shader gets the projection with clip y negated.
        updateMvp(width: int, height: int): void {
            const projection = perspective(radians(FOV_DEGREES), width / height, Z_NEAR, Z_FAR);
            const r = this.cameraRotation;
            let view = multiply(rotation(radians(r[0]), 1.0, 0.0, 0.0), rotation(radians(r[1]), 0.0, 1.0, 0.0));
            view = multiply(view, rotation(radians(r[2]), 0.0, 0.0, 1.0));
            const p = this.cameraPosition;
            // A first person camera: rotation * translation.
            view = multiply(view, translation(p[0], p[1], p[2]));
            for (let i = 0; i < 16; i++) {
                this.mvp[MVP_MODEL + i] = (i % 5 == 0) ? 1.0 : 0.0;
                this.mvp[MVP_VIEW + i] = view[i];
                this.mvp[MVP_PROJ + i] = (i % 4 == 1) ? -projection[i] : projection[i];
            }
            this.currentMvpTransform = multiply(projection, view);
        }

        // update_frag_settings.
        updateFragSettings(commandList: CommandList): void {
            this.settings[0] = this.colorHighlight ? 1 : 0;
            this.settings[1] = 0;
            this.settings[2] = MIP_LEVELS - 1;
            commandList.writeBuffer(this.settingsBuffer, Ref(this.settings[0]), SETTINGS_INTS * 4);
        }

        onRender(frameHandle: FrameHandle): void {
            const frame = new Frame(frameHandle);
            const width = frame.getWidth();
            const height = frame.getHeight();
            const commandList = frame.getCommandList();

            if (!this.scenePipelineCreated) {
                const desc = GraphicsPipelineDesc.create(this.sceneVS, this.scenePS);
                desc.setInputLayout(this.inputLayout);
                desc.addBindingLayout(this.sceneBindingLayout);
                desc.setDepthState(0, 0, ComparisonFunc.Never);
                desc.setRasterState(CullMode.Back, FillMode.Solid, 0);
                this.scenePipeline = this.app.createGraphicsPipelineFromDescForFrame(desc, frame);
                this.scenePipelineCreated = true;
            }

            this.updateMvp(width, height);

            if (!this.started) {
                // The sample's prepare: the screen's size for the level estimate, the least
                // detailed level.
                this.screenWidth = width;
                this.screenHeight = height;
                this.updateFragSettings(commandList);
                this.loadLeastDetailedLevel(frame);
                this.nextStage = STAGE_IDLE;
                this.started = true;
            }
            if (this.colorHighlightChanged) {
                this.updateFragSettings(commandList);
                this.colorHighlightChanged = false;
            }

            this.processStage(frame);

            // After the step: it may have submitted the frame's command list so far, and a volatile
            // constant buffer's contents belong to the command list's current recording.
            commandList.writeBuffer(this.mvpBuffer, Ref(this.mvp[0]), MVP_FLOATS * 4);
            frame.clearColor(0.0, 0.0, 0.0, 0.0);
            frame.beginDraw(this.scenePipeline);
            frame.drawAddBindingSet(this.sceneBindingSet);
            frame.drawAddVertexBuffer(this.vertexBuffer, 0, 0);
            frame.drawSetIndexBuffer(this.indexBuffer);
            frame.drawIndexed(6);
            this.pendingCommands = false;
        }

        allocatedPages(): int {
            return this.sectorList.length * PAGES_PER_ALLOC;
        }

        virtualPages(): int {
            return this.pageCount;
        }

        // create_sparse_texture_image: the texture, its tiling, and the pages of each level (rows
        // and columns of tiles, the edge ones cut at the level's edge).
        createSparseTexture(): boolean {
            this.texture = this.app.createTiledTexture(this.width, this.height, MIP_LEVELS, Format.SRGBA8_UNORM, "SparseTexture");
            if (!this.texture) {
                return false;
            }
            let tiling: int[] = [0, 0, 0, 0];
            this.app.getTextureTiling(this.texture, Ref(tiling[0]));
            this.tileWidth = tiling[0];
            this.tileHeight = tiling[1];
            if (this.tileWidth <= 1 || this.tileHeight <= 1 || tiling[2] < MIP_LEVELS) {
                console.log("The texture's levels can't be mapped page by page on this device");
                return false;
            }
            this.pageSize = this.tileWidth * this.tileHeight * TEXEL_SIZE;

            let mipHeight = this.height;
            let mipWidth = this.width;
            let pageCount = 0;
            for (let mipLevel = 0; mipLevel < MIP_LEVELS; mipLevel++) {
                const mip = new MipProperties();
                mip.numRows = Math.floor(mipHeight / this.tileHeight) + (mipHeight % this.tileHeight == 0 ? 0 : 1);
                mip.numColumns = Math.floor(mipWidth / this.tileWidth) + (mipWidth % this.tileWidth == 0 ? 0 : 1);
                mip.mipNumPages = mip.numRows * mip.numColumns;
                mip.mipBasePageIndex = pageCount;
                mip.width = mipWidth;
                mip.height = mipHeight;
                this.mipProperties.push(mip);
                pageCount += mip.mipNumPages;

                if (mipHeight > 1) {
                    mipHeight = Math.floor(mipHeight / 2);
                }
                if (mipWidth > 1) {
                    mipWidth = Math.floor(mipWidth / 2);
                }
            }
            this.pageCount = pageCount;

            for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
                const mipLevel = this.getMipLevel(pageIndex);
                const mip = this.mipProperties[mipLevel];
                const local = pageIndex - mip.mipBasePageIndex;
                const tileX = local % mip.numColumns;
                const tileY = Math.floor(local / mip.numColumns);
                const offsetX = tileX * this.tileWidth;
                const offsetY = tileY * this.tileHeight;
                this.pageMip.push(mipLevel);
                this.pageTileX.push(tileX);
                this.pageTileY.push(tileY);
                this.pageOffsetX.push(offsetX);
                this.pageOffsetY.push(offsetY);
                this.pageExtentWidth.push(Math.min(mip.width - offsetX, this.tileWidth));
                this.pageExtentHeight.push(Math.min(mip.height - offsetY, this.tileHeight));
                this.pageValid.push(false);
                this.pageGenMipRequired.push(false);
                this.pageFixed.push(false);
                this.pageSector.push(-1);
                this.pageMemoryOffset.push(0);
                this.pageRenderRequired.push([]);
                this.bindSector.push(-1);
                this.bindOffset.push(0);
                this.pageInUpdateSet.push(false);
            }

            this.resetMipTable();
            return true;
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(): boolean {
            if (this.app.hasSparseResidency() == 0) {
                console.log("Sparse binding not supported: this example needs tiled textures with residency queries (D3D12 or Vulkan)");
                return false;
            }

            const shader = "sparse_image.hlsl";
            this.sceneVS = this.app.createShader(shader, "scene_vs", ShaderType.Vertex);
            this.scenePS = this.app.createShader(shader, "scene_ps", ShaderType.Pixel);
            this.mipVS = this.app.createShader(shader, "mip_vs", ShaderType.Vertex);
            this.mipPS = this.app.createShader(shader, "mip_ps", ShaderType.Pixel);
            if (!this.sceneVS || !this.scenePS || !this.mipVS || !this.mipPS) {
                return false;
            }

            // The sample's raw_data_image: the texture's first level, on the CPU's side.
            this.stagingTexture = this.app.loadStagingTexture(TEXTURE_PATH);
            if (!this.stagingTexture) {
                console.log("Cannot load the texture: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return false;
            }
            this.width = Donut_GetStagingTextureWidth(this.stagingTexture);
            this.height = Donut_GetStagingTextureHeight(this.stagingTexture);
            if (!this.createSparseTexture()) {
                return false;
            }

            // The plane: positions (x, y) and texture coordinates.
            const layoutDesc = InputLayoutDesc.create();
            layoutDesc.addVertexAttribute("POSITION", Format.RG32_FLOAT, 0, 0, 16);
            layoutDesc.addVertexAttribute("TEXCOORD", Format.RG32_FLOAT, 8, 0, 16);
            this.inputLayout = this.app.createInputLayout(layoutDesc, this.sceneVS);

            this.mvpBuffer = this.app.createVolatileConstantBuffer(MVP_FLOATS * 4, "MVP");
            this.settingsBuffer = this.app.createConstantBuffer(SETTINGS_INTS * 4, "FragSettingsData");

            // The sample's sampler: linear within levels, nearest between them, repeating.
            const sampler = this.app.createSampler(1, 0, 1);

            const sceneLayoutDesc = BindingLayoutDesc.create();
            sceneLayoutDesc.layoutVolatileConstantBuffer(0);
            sceneLayoutDesc.layoutConstantBuffer(1);
            sceneLayoutDesc.layoutTextureSRV(0);
            sceneLayoutDesc.layoutSampler(0);
            this.sceneBindingLayout = this.app.createBindingLayout(sceneLayoutDesc, ShaderType.All);

            const sceneSetDesc = BindingSetDesc.create();
            sceneSetDesc.bindEntireConstantBuffer(0, this.mvpBuffer);
            sceneSetDesc.bindEntireConstantBuffer(1, this.settingsBuffer);
            sceneSetDesc.bindTextureSRV(0, this.texture);
            sceneSetDesc.bindSampler(0, sampler);
            this.sceneBindingSet = this.app.createBindingSetForLayout(sceneSetDesc, this.sceneBindingLayout);

            // Mip generation: a framebuffer per level from 1, the level above it read alone.
            const mipLayoutDesc = BindingLayoutDesc.create();
            mipLayoutDesc.layoutTextureSRV(0);
            this.mipBindingLayout = this.app.createBindingLayout(mipLayoutDesc, ShaderType.Pixel);
            for (let mipLevel = 0; mipLevel < MIP_LEVELS; mipLevel++) {
                this.mipFramebuffers.push(this.app.createFramebufferForMip(this.texture, mipLevel));
                if (mipLevel + 1 < MIP_LEVELS) {
                    const mipSetDesc = BindingSetDesc.create();
                    mipSetDesc.bindTextureSRVMip(0, this.texture, mipLevel);
                    this.mipBindingSets.push(this.app.createBindingSetForLayout(mipSetDesc, this.mipBindingLayout));
                }
            }
            const mipDesc = GraphicsPipelineDesc.create(this.mipVS, this.mipPS);
            mipDesc.addBindingLayout(this.mipBindingLayout);
            mipDesc.setDepthState(0, 0, ComparisonFunc.Never);
            mipDesc.setRasterState(CullMode.None, FillMode.Solid, 0);
            this.mipPipeline = this.app.createGraphicsPipelineFromDesc(mipDesc, this.mipFramebuffers[1]);

            // The plane's vertices and indices.
            let vertices: f32[] = [
                -PLANE_HALF_SIZE, -PLANE_HALF_SIZE, 0.0, 0.0,
                PLANE_HALF_SIZE, -PLANE_HALF_SIZE, 1.0, 0.0,
                PLANE_HALF_SIZE, PLANE_HALF_SIZE, 1.0, 1.0,
                -PLANE_HALF_SIZE, PLANE_HALF_SIZE, 0.0, 1.0,
            ];
            let indices: int[] = [0, 1, 2, 2, 3, 0];

            // The blit's common passes (for the UI), created on first use, upload their textures on
            // a command list of their own: create them before ours is open.
            this.app.getCommonSampler(CommonSampler.PointClamp);

            const commandList = this.app.createCommandList();
            commandList.open();
            this.vertexBuffer = this.app.createStaticVertexBuffer(commandList, Ref(vertices[0]), 4 * 16, "VertexBuffer");
            this.indexBuffer = this.app.createStaticIndexBuffer(commandList, Ref(indices[0]), 6 * 4, "IndexBuffer");
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.waitForIdle();
            this.app.releaseResource(commandList.handle);

            const pass = this.app.addPass();
            pass.setKeyboardCallback(this.onKeyboard);
            pass.setMousePosCallback(this.onMousePos);
            pass.setMouseButtonCallback(this.onMouseButton);
            pass.setAnimateCallback(this.onAnimate);
            pass.setRenderCallback(this.onRender);
            return true;
        }
    }

    // The sample's overlay.
    class UserInterface {
        private sample: SparseImagePass;

        constructor(sample: SparseImagePass) {
            this.sample = sample;
        }

        buildUI(): void {
            const sample = this.sample;
            Donut_ImGuiSetNextWindowPos(10.0, 10.0);
            // The sample's title (ApiVulkanSample's default).
            Donut_ImGuiBegin("Vulkan Example", 1);
            if (Donut_ImGuiCollapsingHeaderDefaultOpen("Settings") != 0) {
                const colorHighlight = Donut_ImGuiCheckbox("Color highlight", sample.colorHighlight ? 1 : 0) != 0;
                sample.colorHighlightChanged = colorHighlight != sample.colorHighlight;
                sample.colorHighlight = colorHighlight;
                sample.memoryDefragmentation = Donut_ImGuiCheckbox("Memory defragmentation", sample.memoryDefragmentation ? 1 : 0) != 0;
                sample.frameCounterFeature = Donut_ImGuiCheckbox("Update prioritization", sample.frameCounterFeature ? 1 : 0) != 0;
                sample.blocksToUpdatePerCycle = Donut_ImGuiSliderInt("Blocks per cycle", sample.blocksToUpdatePerCycle, 1, 50);
                sample.numVerticalBlocksUpd = Donut_ImGuiSliderInt("Vertical blocks", sample.numVerticalBlocksUpd, 1, 100);
                sample.numHorizontalBlocksUpd = Donut_ImGuiSliderInt("Horizontal blocks", sample.numHorizontalBlocksUpd, 1, 100);
            }
            if (Donut_ImGuiCollapsingHeaderDefaultOpen("Statistics") != 0) {
                Donut_ImGuiText("Memory usage in pages:");
                Donut_ImGuiText(`* Virtual: ${sample.virtualPages()} `);
                Donut_ImGuiText(`* Allocated: ${sample.allocatedPages()} `);
            }
            Donut_ImGuiEnd();
        }

        // Declared after buildUI: tslang resolves `this.buildUI` only for members declared earlier.
        init(app: App): boolean {
            return !app.addImGuiPass(this.buildUI).isNull();
        }
    }

    export function main(argc: int, argv: Ref<string>): int {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("sparse_image");

        // -debug: the graphics API's debug layer and NVRHI's validation layer.
        // -noui: without the settings window.
        // -nohighlight: without the color highlight of the levels.
        let options = AppOptions.None;
        let withUI = true;
        let colorHighlight = true;
        for (let i = 1; i < argc; i++) {
            const arg = Donut_GetArg(argv, i);
            if (arg == "-debug") {
                options = AppOptions.DebugRuntime;
            } else if (arg == "-noui") {
                withUI = false;
            } else if (arg == "-nohighlight") {
                colorHighlight = false;
            }
        }

        const api = Donut_GetGraphicsAPIFromCommandLine(argc, argv);
        const app = App.createWithOptions(api, WINDOW_TITLE, 1280, 720, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        const sample = new SparseImagePass(app);
        sample.colorHighlight = colorHighlight;
        if (!sample.init()) {
            app.destroy();
            return 1;
        }

        // Drawn after (over) the scene, and sees the mouse first.
        const gui = new UserInterface(sample);
        if (withUI && !gui.init(app)) {
            console.log("Cannot initialize the user interface");
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
    return SparseImage.main(argc, argv);
}
