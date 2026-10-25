// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";
import { Args } from "../core/args";
import { PagedImageSet } from "../core/paged_images";

namespace MemoryManagement {
    const WINDOW_TITLE = "Donut Example: Memory Management";

    // The sample's file image (DirectX-Graphics-Samples' TileGrid.dds, copied at build time: see
    // DIRECTX_GRAPHICS_SAMPLES_DIR in CMakeLists.txt) and its generated ones.
    const TILE_GRID_PATH = "media/memory_management/TileGrid.dds";
    const MAX_GENERATED_IMAGES = 8;

    // The images' layout: 256 x 256 cells (smaller images scaled down), 8 apart, in columns of 4.
    const RENDER_TILE_SIZE = 256.0;
    const RENDER_TILE_PADDING = 8.0;
    const NUM_ROWS = 4;
    // How far around the scene camera's view images are prefetched (screen units).
    const PREFETCH_DISTANCE = 600.0;
    const UNDEFINED_MIPMAP_INDEX = 15;

    // The mip colors (rainbow order), as RGBA; index 15 (none) is transparent.
    const MIP_COLORS = [
        1.0, 0.0, 0.0, 0.5,
        1.0, 0.5, 0.0, 0.5,
        1.0, 1.0, 0.0, 0.5,
        0.0, 1.0, 0.0, 0.5,
        0.0, 1.0, 1.0, 0.5,
        0.0, 0.5, 0.5, 0.5,
        0.0, 0.0, 1.0, 0.5,
        0.5, 0.0, 1.0, 0.5,
        1.0, 0.0, 1.0, 0.5,
        0.6, 0.3, 0.0, 0.5,
        0.4, 0.4, 0.0, 0.5,
        1.0, 1.0, 1.0, 0.5,
        0.7, 0.7, 0.7, 0.5,
        0.3, 0.3, 0.3, 0.5,
        0.0, 0.0, 0.0, 0.5,
        0.0, 0.0, 0.0, 0.0,
    ];

    // The memory graph: its place (top right), size and segments, sampled 64 times every 10 s.
    const GRAPH_PADDING = 16.0;
    const GRAPH_WIDTH = 512.0;
    const GRAPH_HEIGHT = 96.0;
    const GRAPH_HEIGHT_RATIO = 90.0;
    const GRAPH_SEGMENTS = 64;
    const NUM_GRAPH_POINTS = GRAPH_SEGMENTS + 1;
    const GRAPH_NOTCH_COUNT = 4;
    const GRAPH_SAMPLE_SECONDS = 1.0 / GRAPH_SEGMENTS * 10.0;
    const STATISTIC_COUNT = 60;

    const MB = 1024.0 * 1024.0;
    const BUDGET_STEP = 128.0 * MB;

    // The push constants: float4 rect; float4 color; float4 camera.
    const PUSH_FLOATS = 12;
    const PUSH_SIZE = PUSH_FLOATS * 4;

    // Test mode: the frames rendered (each waits for the paging thread to go idle first).
    const TEST_FRAMES = 30;

    // The sample's 2D camera: a position, a zoom, an orthographic projection of a rectangle the
    // window's size around it (y down).
    class Camera {
        x: number;
        y: number;
        zoom: number;
        left: number;
        top: number;
        right: number;
        bottom: number;

        constructor(x: number, y: number, zoom: number) {
            this.x = x;
            this.y = y;
            this.zoom = zoom;
            this.left = -640.0;
            this.top = -360.0;
            this.right = 640.0;
            this.bottom = 360.0;
        }

        copyFrom(other: Camera) {
            this.x = other.x;
            this.y = other.y;
            this.zoom = other.zoom;
            this.left = other.left;
            this.top = other.top;
            this.right = other.right;
            this.bottom = other.bottom;
        }

        setProjection(width: number, height: number) {
            this.left = -width / 2.0;
            this.top = -height / 2.0;
            this.right = width / 2.0;
            this.bottom = height / 2.0;
        }

        // GenerateViewportBounds: the world rectangle in view (left, top, right, bottom).
        bounds() {
            return [this.left / this.zoom + this.x, this.top / this.zoom + this.y,
                this.right / this.zoom + this.x, this.bottom / this.zoom + this.y];
        }

        onMouseMove(dx: number, dy: number) {
            this.x -= dx / this.zoom;
            this.y -= dy / this.zoom;
        }

        // OnMouseWheel: 10% per notch (WHEEL_DELTA), between 0.1 and 100.
        onMouseWheel(notches: number) {
            const steps = Math.abs(notches);
            if (steps < 1.0) {
                return;
            }
            const deltaZoom = 1.0 - steps / 10.0;
            let newZoom = this.zoom;
            if (notches < 0.0) {
                newZoom *= deltaZoom;
            } else {
                newZoom /= deltaZoom;
            }
            if (newZoom < 0.1) {
                newZoom = 0.1;
            }
            if (newZoom > 100.0) {
                newZoom = 100.0;
            }
            this.zoom = newZoom;
        }
    }

    function rectIntersects(a: number[], b: number[]) {
        return a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
    }

    function rectNearlyIntersects(a: number[], b: number[], tolerance: number) {
        return a[0] - tolerance < b[2] && a[2] + tolerance > b[0] && a[1] - tolerance < b[3] && a[3] + tolerance > b[1];
    }

    // --- Pass -------------------------------------------------------------------------------

    // Port of DirectX-Graphics-Samples' D3D12MemoryManagement: a grid of large images (a file's and
    // 4096 x 4096 generated checkerboards of 13 levels) streamed into video memory a mip level at a
    // time by a paging thread, under the process's DXGI memory budget: each image a reserved texture
    // whose levels are backed by heaps of their own, mapped and filled on a copy queue, made
    // resident again or evicted by priority (the level visible at the camera's zoom, then the one
    // above it and the visible ones of images near the view, then everything round-robin), each
    // drawn from its most detailed level resident (core/paged_images.cpp). The UI: mip overlays
    // (m), statistics with a memory graph (s), budget overrides in 128 MB steps (+/-), a detached
    // paging camera (d) and which camera the mouse moves (c), v-sync (v). D3D12 only (residency is
    // D3D12's: MakeResident / Evict).
    class MemoryManagementPass {
        private app: App;
        private images: PagedImageSet;
        private imageCount: int;
        private bounds: number[][];
        private mipCounts: int[];
        private widths: int[];
        // Each image's visible level this frame.
        private visibleMips: int[];

        // The cameras: the viewport camera draws; the scene camera (the debug one when detached)
        // decides paging; the captured one is the mouse's.
        private viewportCamera: Camera;
        private debugCamera: Camera;
        private sceneIsDebug: boolean;
        private capturedIsDebug: boolean;
        private lastWidth: int;
        private lastHeight: int;

        drawMipColors: boolean;
        renderStats: boolean;
        vsync: boolean;
        waitForIdle: boolean;
        // A budget override (bytes) to set at a frame (-budgetFrame), and the frames so far.
        delayedBudget: number;
        delayedBudgetFrame: int;
        private frameIndex: int;

        private textureLayout: BindingLayoutHandle;
        private colorLayout: BindingLayoutHandle;
        private colorBindingSet: BindingSet;
        private sampler: SamplerHandle;
        private texturePipeline: GraphicsPipelineHandle;
        private colorPipeline: GraphicsPipelineHandle;
        private pipelinesCreated: boolean;
        private vs: ShaderHandle;
        private texturePS: ShaderHandle;
        private colorPS: ShaderHandle;
        // A binding set per image and level (the SRV from that level on), made when first drawn.
        private bindingSets: BindingSet[];
        private bindingSetMade: boolean[];

        private push: f32[];
        private cameraScale: number[];

        // Mouse dragging.
        private mouseDown: boolean;
        private mouseX: number;
        private mouseY: number;

        // Statistics: frame times, the memory graph's samples.
        private frameTimes: number[];
        private statIndex: int;
        private graphPoints: number[];
        private currentGraphPoint: int;
        private graphTime: number;

        constructor(app: App, images: PagedImageSet) {
            this.app = app;
            this.images = images;
            this.imageCount = images.getCount();
            this.bounds = [];
            this.mipCounts = [];
            this.widths = [];
            // InitializeImage: row and column by index, centered vertically, scaled to the cell.
            for (let i = 0; i < this.imageCount; i++) {
                const width = images.getWidth(i);
                const height = images.getHeight(i);
                let scaleX = 1.0;
                let scaleY = 1.0;
                if (width < 256) {
                    scaleX = width / 256.0;
                }
                if (height < 256) {
                    scaleY = height / 256.0;
                }
                if (width > height) {
                    scaleY *= height / width;
                } else {
                    scaleX *= width / height;
                }
                const row = i % NUM_ROWS;
                const col = Math.floor(i / NUM_ROWS);
                const heightOffset = Math.floor(((NUM_ROWS - 1) * RENDER_TILE_SIZE + (NUM_ROWS - 1) * RENDER_TILE_PADDING) / 2.0);
                const x = col * (RENDER_TILE_SIZE + RENDER_TILE_PADDING);
                const y = row * (RENDER_TILE_SIZE + RENDER_TILE_PADDING) - heightOffset;
                const halfWidth = RENDER_TILE_SIZE * scaleX / 2.0;
                const halfHeight = RENDER_TILE_SIZE * scaleY / 2.0;
                this.bounds.push([x - halfWidth, y - halfHeight, x + halfWidth, y + halfHeight]);
                this.mipCounts.push(images.getMipCount(i));
                this.widths.push(width);
            }
            this.viewportCamera = new Camera(600.0, 0.0, 0.6);
            this.debugCamera = new Camera(600.0, 0.0, 0.6);
            this.sceneIsDebug = false;
            this.capturedIsDebug = false;
            this.lastWidth = 0;
            this.lastHeight = 0;
            this.drawMipColors = false;
            this.renderStats = false;
            this.vsync = true;
            this.waitForIdle = false;
            this.delayedBudget = 0.0;
            this.delayedBudgetFrame = -1;
            this.frameIndex = 0;
            this.pipelinesCreated = false;
            this.bindingSets = [];
            this.bindingSetMade = [];
            this.push = [];
            for (let i = 0; i < PUSH_FLOATS; i++) {
                this.push.push(0.0);
            }
            this.cameraScale = [0.0, 0.0, 0.0, 0.0];
            this.mouseDown = false;
            this.mouseX = 0.0;
            this.mouseY = 0.0;
            this.frameTimes = [];
            for (let i = 0; i < STATISTIC_COUNT; i++) {
                this.frameTimes.push(0.0);
            }
            this.statIndex = 0;
            this.graphPoints = [];
            for (let i = 0; i < NUM_GRAPH_POINTS; i++) {
                this.graphPoints.push(0.0);
            }
            this.currentGraphPoint = 0;
            this.graphTime = 0.0;
        }

        init() {
            this.visibleMips = [];
            for (let i = 0; i < this.imageCount; i++) {
                this.visibleMips.push(UNDEFINED_MIPMAP_INDEX);
            }
            const shader = "memory_management.hlsl";
            this.vs = this.app.createShader(shader, "rect_vs", ShaderType.Vertex);
            this.texturePS = this.app.createShader(shader, "texture_ps", ShaderType.Pixel);
            this.colorPS = this.app.createShader(shader, "color_ps", ShaderType.Pixel);
            if (!this.vs || !this.texturePS || !this.colorPS) {
                return false;
            }
            const textureLayoutDesc = BindingLayoutDesc.create();
            textureLayoutDesc.layoutTextureSRV(0);
            textureLayoutDesc.layoutSampler(0);
            textureLayoutDesc.layoutPushConstants(0, PUSH_SIZE);
            this.textureLayout = this.app.createBindingLayout(textureLayoutDesc, ShaderType.All);
            const colorLayoutDesc = BindingLayoutDesc.create();
            colorLayoutDesc.layoutPushConstants(0, PUSH_SIZE);
            this.colorLayout = this.app.createBindingLayout(colorLayoutDesc, ShaderType.All);
            const colorSetDesc = BindingSetDesc.create();
            colorSetDesc.bindPushConstants(0, PUSH_SIZE);
            this.colorBindingSet = this.app.createBindingSetForLayout(colorSetDesc, this.colorLayout);
            // The sample's static sampler: anisotropic (16), clamped.
            this.sampler = this.app.createSamplerWithDesc(1, 1, 1, SamplerAddressMode.Clamp, 0.0, 0.0, 1000.0, 16.0);

            const pass = this.app.addPass();
            pass.setKeyboardCallback(this.onKey);
            pass.setMouseButtonCallback(this.onMouseButton);
            pass.setMousePosCallback(this.onMousePos);
            pass.setMouseScrollCallback(this.onMouseScroll);
            pass.setAnimateCallback(this.onAnimate);
            pass.setRenderCallback(this.onRender);
            return true;
        }

        sceneCamera() {
            return this.sceneIsDebug ? this.debugCamera : this.viewportCamera;
        }

        capturedCamera() {
            return this.capturedIsDebug ? this.debugCamera : this.viewportCamera;
        }

        getFrameTime() {
            let total = 0.0;
            for (let i = 0; i < STATISTIC_COUNT; i++) {
                total += this.frameTimes[i];
            }
            return total / STATISTIC_COUNT;
        }

        onKey(key: Key, scancode: int, action: Action, mods: KeyMods) {
            if (action == Action.Release) {
                return 0;
            }
            if (key == Key.S) {
                this.renderStats = !this.renderStats;
            } else if (key == Key.M) {
                this.drawMipColors = !this.drawMipColors;
            } else if (key == Key.V) {
                this.vsync = !this.vsync;
                this.app.setVsyncEnabled(this.vsync);
            } else if (key == Key.C) {
                this.capturedIsDebug = !this.capturedIsDebug;
            } else if (key == Key.D) {
                if (!this.sceneIsDebug) {
                    this.sceneIsDebug = true;
                } else {
                    this.sceneIsDebug = false;
                    this.capturedIsDebug = false;
                }
            } else if (key == Key.Equal || key == Key.KpAdd) {
                this.images.setBudgetOverride(this.images.getBudgetOverride() + BUDGET_STEP);
            } else if (key == Key.Minus || key == Key.KpSubtract) {
                const current = this.images.getBudgetOverride();
                this.images.setBudgetOverride(current > BUDGET_STEP ? current - BUDGET_STEP : 0.0);
            } else {
                return 0;
            }
            return 1;
        }

        onMouseButton(button: MouseButton, action: Action, mods: KeyMods) {
            if (button == 0) {
                this.mouseDown = action == 1;
            }
            return 1;
        }

        // Dragging moves the captured camera; the debug camera moves the other way, scaled to the
        // viewport camera's zoom.
        onMousePos(x: number, y: number) {
            if (this.mouseDown) {
                const dx = Math.floor(x) - Math.floor(this.mouseX);
                const dy = Math.floor(y) - Math.floor(this.mouseY);
                const camera = this.capturedCamera();
                if (!this.capturedIsDebug) {
                    camera.onMouseMove(dx, dy);
                } else {
                    const zoom = camera.zoom / this.viewportCamera.zoom;
                    camera.onMouseMove(-dx * zoom, -dy * zoom);
                }
            }
            this.mouseX = x;
            this.mouseY = y;
            return 1;
        }

        onMouseScroll(xoffset: number, yoffset: number) {
            this.capturedCamera().onMouseWheel(yoffset);
            return 1;
        }

        onAnimate(elapsedSeconds: number) {
            this.app.setInformativeWindowTitle(WINDOW_TITLE);
            this.frameTimes[this.statIndex] = elapsedSeconds;
            this.statIndex = (this.statIndex + 1) % STATISTIC_COUNT;
            // The memory graph's samples.
            this.graphTime += elapsedSeconds;
            if (this.graphTime > GRAPH_SAMPLE_SECONDS) {
                this.graphPoints[this.currentGraphPoint % NUM_GRAPH_POINTS] = this.images.getUsage();
                this.currentGraphPoint++;
                this.graphTime = 0.0;
            }
        }

        // CalculateRequiredMipLevel: log2 of texels per pixel, the image being a screen-space quad.
        requiredMip(image: int, imageScale: number): int {
            const d = this.widths[image] / imageScale;
            const dSqr = d * d;
            const logValue = Math.log(dSqr) / Math.log(2.0);
            const mip = 0.5 * logValue;
            if (mip < 0.0) {
                return 0;
            }
            return Math.floor(mip);
        }

        bindingSetFor(image: int, mip: int) {
            const key = image * 16 + mip;
            while (this.bindingSetMade.length <= key) {
                this.bindingSetMade.push(false);
                this.bindingSets.push(this.colorBindingSet);
            }
            if (!this.bindingSetMade[key]) {
                const desc = BindingSetDesc.create();
                desc.bindTextureSRVMips(0, this.images.getTexture(image), mip, this.mipCounts[image] - mip);
                desc.bindSampler(0, this.sampler);
                desc.bindPushConstants(0, PUSH_SIZE);
                this.bindingSets[key] = this.app.createBindingSetForLayout(desc, this.textureLayout);
                this.bindingSetMade[key] = true;
            }
            return this.bindingSets[key];
        }

        setPush(r: number[], red: number, green: number, blue: number, alpha: number) {
            const p = this.push;
            p[0] = r[0];
            p[1] = r[1];
            p[2] = r[2];
            p[3] = r[3];
            p[4] = red;
            p[5] = green;
            p[6] = blue;
            p[7] = alpha;
            p[8] = this.cameraScale[0];
            p[9] = this.cameraScale[1];
            p[10] = this.cameraScale[2];
            p[11] = this.cameraScale[3];
        }

        fillRectangle(frame: Frame, r: number[], red: number, green: number, blue: number, alpha: number) {
            this.setPush(r, red, green, blue, alpha);
            frame.beginDraw(this.colorPipeline);
            frame.drawAddBindingSet(this.colorBindingSet);
            frame.drawVerticesWithPushConstants(6, Ref(this.push[0]), PUSH_SIZE);
        }

        // DrawRectangle: four filled rectangles around r, stroke wide.
        drawRectangle(frame: Frame, r: number[], stroke: number, red: number, green: number, blue: number, alpha: number) {
            this.fillRectangle(frame, [r[0] - stroke, r[1] - stroke, r[0], r[3] + stroke], red, green, blue, alpha);
            this.fillRectangle(frame, [r[2], r[1] - stroke, r[2] + stroke, r[3] + stroke], red, green, blue, alpha);
            this.fillRectangle(frame, [r[0], r[1] - stroke, r[2], r[1]], red, green, blue, alpha);
            this.fillRectangle(frame, [r[0], r[3], r[2], r[3] + stroke], red, green, blue, alpha);
        }

        // FillRectangle with an image: gray until something is resident, else the image from the
        // level ReferenceResource allows for its visible one.
        fillImage(frame: Frame, image: int, r: number[]) {
            if (this.images.getResidentMip(image) == this.mipCounts[image]) {
                this.fillRectangle(frame, r, 0.5, 0.5, 0.5, 1.0);
                return;
            }
            const mip = this.images.reference(image, this.visibleMips[image]);
            this.setPush(r, 1.0, 1.0, 1.0, 1.0);
            frame.beginDraw(this.texturePipeline);
            frame.drawAddBindingSet(this.bindingSetFor(image, mip));
            frame.drawVerticesWithPushConstants(6, Ref(this.push[0]), PUSH_SIZE);
        }

        createPipelines(frame: Frame) {
            const textureDesc = GraphicsPipelineDesc.create(this.vs, this.texturePS);
            textureDesc.addBindingLayout(this.textureLayout);
            textureDesc.setRasterState(CullMode.None, FillMode.Solid, 0);
            textureDesc.setDepthState(0, 0, ComparisonFunc.Always);
            textureDesc.setBlendState(true, BlendFactor.SrcAlpha, BlendFactor.InvSrcAlpha, BlendOp.Add, BlendFactor.One,
                BlendFactor.Zero, BlendOp.Add);
            this.texturePipeline = this.app.createGraphicsPipelineFromDescForFrame(textureDesc, frame);
            const colorDesc = GraphicsPipelineDesc.create(this.vs, this.colorPS);
            colorDesc.addBindingLayout(this.colorLayout);
            colorDesc.setRasterState(CullMode.None, FillMode.Solid, 0);
            colorDesc.setDepthState(0, 0, ComparisonFunc.Always);
            colorDesc.setBlendState(true, BlendFactor.SrcAlpha, BlendFactor.InvSrcAlpha, BlendOp.Add, BlendFactor.One,
                BlendFactor.Zero, BlendOp.Add);
            this.colorPipeline = this.app.createGraphicsPipelineFromDescForFrame(colorDesc, frame);
            this.pipelinesCreated = true;
        }

        // RenderInternal and RenderScene: the paging camera's view decides each image's visible
        // and prefetched levels (the paging thread reprioritizes the images whose levels change);
        // the images in the viewport camera's view are drawn (with mip overlays), then the paging
        // camera's view outlined by its prefetching region.
        onRender(frameHandle: FrameHandle) {
            const frame = new Frame(frameHandle);
            if (!this.pipelinesCreated) {
                this.createPipelines(frame);
            }
            this.images.beginFrame();
            if (this.frameIndex == this.delayedBudgetFrame) {
                this.images.setBudgetOverride(this.delayedBudget);
            }
            this.frameIndex++;

            // The window's size (new): the captured camera's projection, as the sample's WM_SIZE.
            const width = frame.getWidth();
            const height = frame.getHeight();
            if (width != this.lastWidth || height != this.lastHeight) {
                this.capturedCamera().setProjection(width, height);
                this.lastWidth = width;
                this.lastHeight = height;
            }

            const viewport = this.viewportCamera;
            this.cameraScale[0] = viewport.x;
            this.cameraScale[1] = viewport.y;
            this.cameraScale[2] = 2.0 * viewport.zoom / (viewport.right - viewport.left);
            this.cameraScale[3] = -2.0 * viewport.zoom / (viewport.bottom - viewport.top);

            // PrepareFrame: cleared to 0.35 gray.
            frame.clearColor(0.35, 0.35, 0.35, 1.0);

            const scene = this.sceneCamera();
            const sceneBounds = scene.bounds();
            const viewportBounds = viewport.bounds();
            const scaledPrefetchDistance = PREFETCH_DISTANCE / scene.zoom;
            for (let i = 0; i < this.imageCount; i++) {
                // CalculateImagePagingData.
                const b = this.bounds[i];
                const required = this.requiredMip(i, (b[2] - b[0]) * scene.zoom);
                let visibleMip = UNDEFINED_MIPMAP_INDEX;
                let prefetchMip = UNDEFINED_MIPMAP_INDEX;
                if (rectIntersects(sceneBounds, b)) {
                    visibleMip = required;
                    prefetchMip = required > 0 ? required - 1 : 0;
                } else if (rectNearlyIntersects(sceneBounds, b, scaledPrefetchDistance)) {
                    prefetchMip = required;
                }
                this.images.setMips(i, visibleMip, prefetchMip);
                this.visibleMips[i] = visibleMip;
            }
            // Test mode: everything paged in for this view before drawing.
            if (this.waitForIdle) {
                this.images.waitIdle(60000);
            }

            for (let i = 0; i < this.imageCount; i++) {
                const b = this.bounds[i];
                if (!rectIntersects(b, viewportBounds)) {
                    continue;
                }
                this.fillImage(frame, i, b);
                if (this.drawMipColors) {
                    // The overlay: the visible level's color; the outline: the resident one's.
                    const v = this.visibleMips[i] * 4;
                    this.fillRectangle(frame, b, MIP_COLORS[v], MIP_COLORS[v + 1], MIP_COLORS[v + 2], MIP_COLORS[v + 3]);
                    const resident = Math.min(this.images.getResidentMip(i), UNDEFINED_MIPMAP_INDEX) * 4;
                    this.drawRectangle(frame, b, 2.0, MIP_COLORS[resident], MIP_COLORS[resident + 1], MIP_COLORS[resident + 2],
                        MIP_COLORS[resident + 3]);
                }
            }

            // The paging camera's view, outlined by its prefetching region.
            this.drawRectangle(frame, sceneBounds, scaledPrefetchDistance, 1.0, 0.0, 0.0, 0.25);
        }

        // RenderUI: the statistics (frame times) and the memory graph (top right): usage over the
        // last 10 seconds, the current usage (yellow) and budget (red) lines.
        renderStatistics(width: number) {
            if (!this.renderStats) {
                return;
            }
            const frameTime = this.getFrameTime();
            const fps = frameTime > 0.0 ? Math.floor(1.0 / frameTime) : 0;
            const ms = frameTime * 1000.0;
            Donut_ImGuiDrawText(8.0, 8.0, `FPS: ${fps} (${ms.toFixed(2)}ms)`, 1.0, 1.0, 1.0, 1.0, 0);

            const usage = this.images.getUsage();
            const budget = this.images.getBudget();
            let largest = 0.0;
            for (let i = 0; i < NUM_GRAPH_POINTS; i++) {
                if (this.graphPoints[i] > largest) {
                    largest = this.graphPoints[i];
                }
            }
            if (largest == 0.0) {
                return;
            }
            // The graph's scale: 100 MB times the next power of two above the largest sample.
            const largestMB = Math.floor(largest / MB);
            let scaleIndex = 0;
            let hundreds = Math.floor(largestMB / 100);
            if (hundreds > 0) {
                while (hundreds > 1) {
                    hundreds = Math.floor(hundreds / 2);
                    scaleIndex++;
                }
                scaleIndex++;
            }
            const graphSizeMB = (1 << scaleIndex) * 100;
            const heightPadded = GRAPH_HEIGHT * GRAPH_HEIGHT_RATIO / 100.0;
            const paddingTop = GRAPH_HEIGHT - heightPadded;
            const right = width - GRAPH_PADDING;
            const left = right - GRAPH_WIDTH;
            const top = GRAPH_PADDING;
            const bottom = top + GRAPH_HEIGHT;
            Donut_ImGuiDrawRect(left, top, right, bottom, 0.1, 0.1, 0.1, 0.85);
            // The usage history, oldest first, as strips.
            const step = GRAPH_WIDTH / GRAPH_SEGMENTS;
            for (let i = 0; i < GRAPH_SEGMENTS; i++) {
                const a = this.graphPoints[(i + this.currentGraphPoint) % NUM_GRAPH_POINTS];
                const b = this.graphPoints[(i + 1 + this.currentGraphPoint) % NUM_GRAPH_POINTS];
                const value = (a + b) / 2.0 / MB;
                const y = bottom - value / graphSizeMB * heightPadded;
                Donut_ImGuiDrawRect(left + i * step, y, left + (i + 1) * step, bottom, 0.5, 0.5, 0.0, 0.75);
            }
            // The border.
            Donut_ImGuiDrawRect(left - 1.0, top - 1.0, right + 1.0, top + 1.0, 0.75, 0.75, 0.75, 0.75);
            Donut_ImGuiDrawRect(left - 1.0, bottom - 1.0, right + 1.0, bottom + 1.0, 0.75, 0.75, 0.75, 0.75);
            Donut_ImGuiDrawRect(left - 1.0, top - 1.0, left + 1.0, bottom + 1.0, 0.75, 0.75, 0.75, 0.75);
            Donut_ImGuiDrawRect(right - 1.0, top - 1.0, right + 1.0, bottom + 1.0, 0.75, 0.75, 0.75, 0.75);
            // The notches.
            const sizePerNotch = Math.floor(graphSizeMB / GRAPH_NOTCH_COUNT);
            for (let i = 0; i <= GRAPH_NOTCH_COUNT; i++) {
                const y = top + paddingTop + (GRAPH_NOTCH_COUNT - i) * (heightPadded / GRAPH_NOTCH_COUNT);
                Donut_ImGuiDrawText(left - 5.0, y - 8.0, `${sizePerNotch * i}MB`, 1.0, 1.0, 1.0, 1.0, 1);
                if (i > 0) {
                    Donut_ImGuiDrawRect(left, y, right, y + 1.0, 0.75, 0.75, 0.75, 0.4);
                }
            }
            // The current usage and budget.
            const usageMB = Math.floor(usage / MB);
            const usageY = bottom - usageMB / graphSizeMB * heightPadded;
            Donut_ImGuiDrawRect(left, usageY, right, usageY + 1.0, 0.8, 0.8, 0.0, 1.0);
            Donut_ImGuiDrawText(right - 5.0, usageY, `${usageMB}MB`, 1.0, 1.0, 1.0, 1.0, 1);
            const budgetMB = Math.floor(budget / MB);
            let budgetY = bottom - budgetMB / graphSizeMB * heightPadded;
            if (budgetY < top) {
                budgetY = top;
            }
            Donut_ImGuiDrawRect(left, budgetY, right, budgetY + 1.0, 0.8, 0.0, 0.0, 1.0);
            Donut_ImGuiDrawText(right - 5.0, budgetY - 16.0, `${budgetMB}MB`, 1.0, 1.0, 1.0, 1.0, 1);
        }
    }

    class UserInterface {
        private sample: MemoryManagementPass;
        private app: App;

        constructor(sample: MemoryManagementPass, app: App) {
            this.sample = sample;
            this.app = app;
        }

        init() {
            return !this.app.addImGuiPass(this.buildUI).isNull();
        }

        buildUI() {
            this.sample.renderStatistics(this.app.getWindowWidth());
        }
    }

    // -test: checks the paging after the frames. Without a budget override every image ends fully
    // resident and the frame shows them; with -budget, the usage stays under it, every image has
    // some level resident, and some aren't fully resident.
    function checkResult(app: App, images: PagedImageSet, budgetOverride: number) {
        const count = images.getCount();
        let fullyResident = 0;
        let report = "Resident levels:";
        for (let i = 0; i < count; i++) {
            const mip = images.getResidentMip(i);
            report += ` ${mip}`;
            if (mip == images.getMipCount(i)) {
                return `image ${i} has no level resident`;
            }
            if (mip == 0) {
                fullyResident++;
            }
        }
        const usageMB = Math.floor(images.getUsage() / MB);
        const budgetMB = Math.floor(images.getBudget() / MB);
        console.log(report);
        console.log(`Usage ${usageMB} MB, budget ${budgetMB} MB`);
        if (budgetOverride > 0.0) {
            if (images.getUsage() > images.getBudget()) {
                return `usage ${usageMB} MB over the ${budgetMB} MB budget`;
            }
            if (fullyResident == count) {
                return "every image is fully resident under the budget override";
            }
            return "";
        }
        if (fullyResident != count) {
            return `${count - fullyResident} images aren't fully resident`;
        }
        // The frame: the background, and the images (not the gray of an image with nothing).
        const width = app.getWindowWidth();
        const height = app.getWindowHeight();
        const pixels: int[] = [];
        for (let i = 0; i < width * height; i++) {
            pixels.push(0);
        }
        if (app.readBackBufferRGBA8(Ref(pixels[0]), pixels.length) == 0) {
            return "cannot read the back buffer";
        }
        const background = pixels[0] & 0xFFFFFF;
        let covered = 0;
        for (let i = 0; i < width * height; i++) {
            if ((pixels[i] & 0xFFFFFF) != background) {
                covered++;
            }
        }
        const coverage = covered / (width * height);
        console.log(`Image coverage ${coverage}`);
        if (coverage < 0.2) {
            return `the images cover only ${coverage} of the frame`;
        }
        return "";
    }

    class MemoryManagementArgs extends Args {
        // -budget <MB>: the budget override to start with (0: the kernel's); with -budgetFrame <n>,
        // set at frame n instead (e.g. after everything is paged in, to trim).
        budgetMB = 0.0;
        budgetFrame = 0;
        // -mips, -stats: the mip overlays and the statistics on from the start.
        mips = false;
        stats = false;

        protected parseOptions() {
            for (let i = 1; i < this.argc; i++) {
                const arg = this[i];
                if (arg == "-budget" && i + 1 < this.argc) {
                    this.budgetMB = parseFloat(this[i + 1]);
                    i++;
                } else if (arg == "-budgetFrame" && i + 1 < this.argc) {
                    this.budgetFrame = parseInt(this[i + 1]);
                    i++;
                } else if (arg == "-mips") {
                    this.mips = true;
                } else if (arg == "-stats") {
                    this.stats = true;
                }
            }
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("memory_management");

        // -test [-testOutput <file>]: render a few frames without a window, each after the paging
        // thread goes idle, and check the result (see checkResult).
        const args = new MemoryManagementArgs(argc, argv, TEST_FRAMES);
        args.parseArgs();

        // Residency (MakeResident / Evict) is D3D12's.
        if (args.api != GraphicsAPI.D3D12) {
            console.log("The Memory Management example can only run on D3D12.");
            return 1;
        }
        // UNORM back buffers, as the sample's R8G8B8A8_UNORM.
        const options = AppOptions.UnormBackBuffer | args.options;
        const app = App.createWithOptions(args.api, WINDOW_TITLE, 1280, 720, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }
        console.log(`Renderer: ${app.getRendererString()}`);

        const images = PagedImageSet.create();
        if (images.init(app.getNvrhiDevice(), TILE_GRID_PATH, MAX_GENERATED_IMAGES) == 0 || images.getCount() == 0) {
            console.log("Cannot create the paged images (tiled resources on D3D12)");
            images.destroy();
            app.destroy();
            return 1;
        }
        const budgetOverride = args.budgetMB * MB;
        if (args.budgetFrame == 0) {
            images.setBudgetOverride(budgetOverride);
        }

        const sample = new MemoryManagementPass(app, images);
        sample.drawMipColors = args.mips;
        sample.renderStats = args.stats;
        sample.waitForIdle = args.test;
        if (args.budgetFrame > 0) {
            sample.delayedBudget = budgetOverride;
            sample.delayedBudgetFrame = args.budgetFrame;
        }
        if (!sample.init()) {
            images.destroy();
            app.destroy();
            return 1;
        }
        const gui = new UserInterface(sample, app);
        if (!gui.init()) {
            console.log("Cannot initialize the user interface");
            images.destroy();
            app.destroy();
            return 1;
        }

        const input = new InputPass(app.handle);

        app.run();
        let result = 0;
        if (args.test) {
            result =app.finishTest(checkResult(app, images, budgetOverride));
        }
        images.destroy();
        app.destroy();
        return result;
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return MemoryManagement.main(argc, argv);
}
