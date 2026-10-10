// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";

namespace OitLinkedLists {
    const WINDOW_TITLE = "Donut Example: OIT Linked Lists";

    // The sample's model and background (Vulkan-Samples' assets), the KTX texture converted to DDS
    // at build time (see VULKAN_SAMPLES_ASSETS_DIR in CMakeLists.txt).
    const MODEL_PATH = "media/oit_linked_lists/geosphere.gltf";
    const BACKGROUND_PATH = "media/oit_linked_lists/vulkan_logo_full.dds";

    // Donut_LoadGltfMesh's vertices: float3 position, float3 normal, float2 texture coordinates.
    const VERTEX_SIZE = 32;

    // The sample's grid of transparent spheres: rows (x) by columns (y) by layers (z), one unit
    // apart and centered on the origin; INSTANCE_COUNT in oit_linked_lists.hlsl.
    const INSTANCE_ROW_COUNT = 4;
    const INSTANCE_COLUMN_COUNT = 4;
    const INSTANCE_LAYER_COUNT = 4;
    const INSTANCE_COUNT = INSTANCE_ROW_COUNT * INSTANCE_COLUMN_COUNT * INSTANCE_LAYER_COUNT;
    const INSTANCE_SCALE = 0.02;
    // struct Instance { float4x4 model; float4 color; }.
    const INSTANCE_FLOATS = 20;

    // The fragment buffer holds this many fragments per pixel on average; past that, fragments
    // are dropped.
    const FRAGMENTS_PER_PIXEL_AVERAGE = 8;
    // struct { uint next, color, depth; }.
    const FRAGMENT_SIZE = 12;
    const LINKED_LIST_END_SENTINEL = -1; // 0xFFFFFFFF

    const SORTED_FRAGMENT_MIN_COUNT = 1;
    const SORTED_FRAGMENT_MAX_COUNT = 16;

    // struct SceneConstants { float4x4 projection, view; float backgroundGrayscale; uint
    // sortFragments, fragmentMaxCount, sortedFragmentCount; }, as f32 offsets.
    const CONST_PROJECTION = 0;
    const CONST_VIEW = 16;
    const CONST_BACKGROUND_GRAYSCALE = 32;
    const CONST_SORT_FRAGMENTS = 33;
    const CONST_FRAGMENT_MAX_COUNT = 34;
    const CONST_SORTED_FRAGMENT_COUNT = 35;
    const CONST_FLOATS = 36;

    // The sample's camera: a "look at" camera 4 units back, 60 degrees vertically, reversed depth
    // from 256 to 0.1 (glm::perspective with near and far swapped).
    const CAMERA_POSITION = [0.0, 0.0, -4.0];
    const CAMERA_FOV = 60.0;
    const Z_NEAR = 256.0;
    const Z_FAR = 0.1;
    // ApiVulkanSample's mouse controls: degrees per pixel dragged with the left button, zoom per
    // pixel with the right one, panning per pixel with the middle one; and the auto-rotation's
    // degrees per second.
    const ROTATION_SPEED = 1.0;
    const ZOOM_SPEED = 0.005;
    const PAN_SPEED = 0.01;
    const AUTO_ROTATION_SPEED = 5.0;

    // The sample's benchmark mode (--benchmark): simulated at 60 frames per second.
    const BENCHMARK_FRAME_TIME = 1.0 / 60.0;

    // GLFW mouse buttons and actions.
    const MOUSE_BUTTON_LEFT = 0;
    const MOUSE_BUTTON_RIGHT = 1;
    const MOUSE_BUTTON_MIDDLE = 2;
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

    // MSVC's rand(), from its default seed, which the sample's colors come from: RAND_MAX 32767.
    class MsvcRandom {
        private state: number;

        constructor() {
            this.state = 1;
        }

        next(): number {
            this.state = (this.state * 214013 + 2531011) % 4294967296;
            return Math.floor(this.state / 65536) % 32768;
        }

        // static_cast<float>(rand()) / RAND_MAX.
        nextFloat(): number {
            return this.next() / 32767.0;
        }
    }

    // --- Passes -------------------------------------------------------------------------------

    // Port of Vulkan-Samples' oit_linked_lists: order-independent transparency with per-pixel
    // linked lists. A gather pass draws 64 transparent spheres without writing any color: each
    // fragment's pixel shader takes the next slot of a fragment buffer (an atomic counter) and
    // swaps it in as the head of its pixel's list (an atomic exchange on an R32_UINT texture). A
    // combine pass then walks each pixel's list, sorts its nearest fragments, and blends them over
    // the background, resetting the list and the counter for the next frame as it goes.
    class OitLinkedListsPass {
        private app: App;

        // The sample's settings.
        sortFragments: boolean;
        cameraAutoRotation: boolean;
        sortedFragmentCount: int;
        backgroundGrayscale: number;
        // Fixed simulation steps, as the sample's benchmark mode.
        benchmark: boolean;

        // The sample's camera: rotation (degrees about x, y, z) and position.
        private cameraRotation: number[];
        private cameraPosition: number[];
        // The mouse: buttons held, last position.
        private leftButton: boolean;
        private rightButton: boolean;
        private middleButton: boolean;
        private mouseX: number;
        private mouseY: number;

        private gatherVS: ShaderHandle;
        private gatherPS: ShaderHandle;
        private fullscreenVS: ShaderHandle;
        private backgroundPS: ShaderHandle;
        private combineVS: ShaderHandle;
        private combinePS: ShaderHandle;
        private inputLayout: InputLayoutHandle;
        private gatherBindingLayout: BindingLayoutHandle;
        private backgroundBindingLayout: BindingLayoutHandle;
        private combineBindingLayout: BindingLayoutHandle;
        private sceneConstantBuffer: BufferHandle;
        private instanceConstantBuffer: BufferHandle;
        private backgroundBindingSet: BindingSet;
        private vertexBuffer: BufferHandle;
        private indexBuffer: BufferHandle;
        private indexCount: int;

        // Created on the first frame (the back buffer's layout).
        private pipelinesCreated: boolean;
        private gatherPipeline: GraphicsPipelineHandle;
        private backgroundPipeline: GraphicsPipelineHandle;
        private combinePipeline: GraphicsPipelineHandle;

        // The back buffer's size: the lists and the fragment buffer (0 x 0 until the first frame,
        // and after a resize).
        private width: int;
        private height: int;
        private fragmentMaxCount: int;
        private linkedListHead: TextureHandle;
        private fragmentBuffer: BufferHandle;
        private fragmentCounter: BufferHandle;
        private gatherBindingSet: BindingSet;
        private combineBindingSet: BindingSet;

        // The UBO contents.
        private constants: f32[];

        constructor(app: App) {
            this.app = app;
            this.sortFragments = true;
            this.cameraAutoRotation = false;
            this.sortedFragmentCount = SORTED_FRAGMENT_MAX_COUNT;
            this.backgroundGrayscale = 0.3;
            this.benchmark = false;
            this.cameraRotation = [0.0, 0.0, 0.0];
            this.cameraPosition = [CAMERA_POSITION[0], CAMERA_POSITION[1], CAMERA_POSITION[2]];
            this.leftButton = false;
            this.rightButton = false;
            this.middleButton = false;
            this.mouseX = 0.0;
            this.mouseY = 0.0;
            this.indexCount = 0;
            this.pipelinesCreated = false;
            this.width = 0;
            this.height = 0;
            this.fragmentMaxCount = 0;

            this.constants = [];
            for (let i = 0; i < CONST_FLOATS; i++) {
                this.constants.push(0.0);
            }
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

        onAnimate(elapsedSeconds: number): void {
            if (this.cameraAutoRotation) {
                const deltaTime = this.benchmark ? BENCHMARK_FRAME_TIME : elapsedSeconds;
                this.cameraRotation[0] += deltaTime * AUTO_ROTATION_SPEED;
                this.cameraRotation[1] += deltaTime * AUTO_ROTATION_SPEED;
            }
            this.app.setInformativeWindowTitle(WINDOW_TITLE);
        }

        releaseSizedResources(): void {
            if (this.width == 0) {
                return;
            }
            const resources: (ResourceHandle | null)[] = [this.gatherBindingSet.handle, this.combineBindingSet.handle, this.linkedListHead,
                this.fragmentBuffer, this.fragmentCounter];
            for (let i = 0; i < resources.length; i++) {
                const resource = resources[i];
                if (resource) {
                    this.app.releaseResource(resource);
                }
            }
            this.width = 0;
            this.height = 0;
            this.fragmentMaxCount = 0;
        }

        onBackBufferResizing(): void {
            this.releaseSizedResources();
        }

        // The sample's create_fragment_resources and clear_sized_resources: a list head per pixel
        // (all empty), room for FRAGMENTS_PER_PIXEL_AVERAGE fragments per pixel, and the counter (0),
        // cleared by an open command list.
        createSizedResources(commandList: CommandList, width: int, height: int): void {
            this.width = width;
            this.height = height;
            this.fragmentMaxCount = width * height * FRAGMENTS_PER_PIXEL_AVERAGE;
            this.linkedListHead = this.app.createUAVTextureWithFormat(width, height, Format.R32_UINT, "Linked List Head");
            this.fragmentBuffer = this.app.createRWStructuredBuffer(FRAGMENT_SIZE, this.fragmentMaxCount, "Fragment Buffer");
            this.fragmentCounter = this.app.createRWStructuredBuffer(4, 1, "Fragment Counter");

            commandList.clearTextureUInt(this.linkedListHead, LINKED_LIST_END_SENTINEL);
            let zero: int[] = [0];
            commandList.writeBuffer(this.fragmentCounter, Ref(zero[0]), 4);

            const gatherSetDesc = BindingSetDesc.create();
            gatherSetDesc.bindEntireConstantBuffer(0, this.sceneConstantBuffer);
            gatherSetDesc.bindConstantBuffer(1, this.instanceConstantBuffer, 0, INSTANCE_COUNT * INSTANCE_FLOATS * 4);
            gatherSetDesc.bindTextureUAV(1, this.linkedListHead);
            gatherSetDesc.bindStructuredBufferUAV(2, this.fragmentBuffer);
            gatherSetDesc.bindStructuredBufferUAV(3, this.fragmentCounter);
            this.gatherBindingSet = this.app.createBindingSetForLayout(gatherSetDesc, this.gatherBindingLayout);

            // A binding set of its own: NVRHI puts UAV barriers between the gather pass's writes
            // and the combine pass's reads when the binding set changes (the sample's buffer
            // barrier).
            const combineSetDesc = BindingSetDesc.create();
            combineSetDesc.bindEntireConstantBuffer(0, this.sceneConstantBuffer);
            combineSetDesc.bindTextureUAV(1, this.linkedListHead);
            combineSetDesc.bindStructuredBufferUAV(2, this.fragmentBuffer);
            combineSetDesc.bindStructuredBufferUAV(3, this.fragmentCounter);
            this.combineBindingSet = this.app.createBindingSetForLayout(combineSetDesc, this.combineBindingLayout);
        }

        // The sample's pipelines, for the back buffer: no vertex input but the gather pass's
        // positions, no culling, no depth test.
        createPipelines(frame: Frame): void {
            const gatherDesc = GraphicsPipelineDesc.create(this.gatherVS, this.gatherPS);
            gatherDesc.setInputLayout(this.inputLayout);
            gatherDesc.addBindingLayout(this.gatherBindingLayout);
            gatherDesc.setDepthState(0, 0, ComparisonFunc.Greater);
            gatherDesc.setRasterState(CullMode.None, FillMode.Solid, 1);
            // The sample's gather render pass has no attachments: write no color.
            gatherDesc.setColorWriteMask(ColorMask.None);
            this.gatherPipeline = this.app.createGraphicsPipelineFromDescForFrame(gatherDesc, frame);

            const backgroundDesc = GraphicsPipelineDesc.create(this.fullscreenVS, this.backgroundPS);
            backgroundDesc.addBindingLayout(this.backgroundBindingLayout);
            backgroundDesc.setDepthState(0, 0, ComparisonFunc.Greater);
            backgroundDesc.setRasterState(CullMode.None, FillMode.Solid, 1);
            this.backgroundPipeline = this.app.createGraphicsPipelineFromDescForFrame(backgroundDesc, frame);

            // The combined fragments blend over the background.
            const combineDesc = GraphicsPipelineDesc.create(this.combineVS, this.combinePS);
            combineDesc.addBindingLayout(this.combineBindingLayout);
            combineDesc.setDepthState(0, 0, ComparisonFunc.Greater);
            combineDesc.setRasterState(CullMode.None, FillMode.Solid, 1);
            combineDesc.setBlendMode(BlendMode.AlphaOver);
            this.combinePipeline = this.app.createGraphicsPipelineFromDescForFrame(combineDesc, frame);
            this.pipelinesCreated = true;
        }

        // The sample's update_scene_constants: its camera's matrices and the settings.
        updateSceneConstants(width: int, height: int): void {
            const c = this.constants;
            const projection = samplePerspective(radians(CAMERA_FOV), width / height, Z_NEAR, Z_FAR);
            // A "look at" camera: translation * rotation (about x, then y, then z).
            const r = this.cameraRotation;
            let rotationMatrix = multiply(rotation(radians(r[0]), 1.0, 0.0, 0.0), rotation(radians(r[1]), 0.0, 1.0, 0.0));
            rotationMatrix = multiply(rotationMatrix, rotation(radians(r[2]), 0.0, 0.0, 1.0));
            const p = this.cameraPosition;
            const view = multiply(translation(p[0], p[1], p[2]), rotationMatrix);
            for (let i = 0; i < 16; i++) {
                c[CONST_PROJECTION + i] = projection[i];
                c[CONST_VIEW + i] = view[i];
            }
            c[CONST_BACKGROUND_GRAYSCALE] = this.backgroundGrayscale;
            Donut_StoreInt32(Ref(c[CONST_SORT_FRAGMENTS]), this.sortFragments ? 1 : 0);
            Donut_StoreInt32(Ref(c[CONST_FRAGMENT_MAX_COUNT]), this.fragmentMaxCount);
            Donut_StoreInt32(Ref(c[CONST_SORTED_FRAGMENT_COUNT]), this.sortedFragmentCount);
        }

        onRender(frameHandle: FrameHandle): void {
            const frame = new Frame(frameHandle);
            const width = frame.getWidth();
            const height = frame.getHeight();
            const commandList = frame.getCommandList();

            if (!this.pipelinesCreated) {
                this.createPipelines(frame);
            }
            if (this.width != width || this.height != height) {
                this.releaseSizedResources();
                this.createSizedResources(commandList, width, height);
            }

            this.updateSceneConstants(width, height);
            commandList.writeBuffer(this.sceneConstantBuffer, Ref(this.constants[0]), CONST_FLOATS * 4);

            // Gather pass: every sphere's fragments into the lists.
            commandList.beginMarker("Gather");
            frame.beginDraw(this.gatherPipeline);
            frame.drawAddBindingSet(this.gatherBindingSet);
            frame.drawSetIndexBuffer(this.indexBuffer);
            frame.drawAddVertexBuffer(this.vertexBuffer, 0, 0);
            frame.drawIndexedInstanced(this.indexCount, INSTANCE_COUNT);
            commandList.endMarker();

            // Combine pass: the background, then the lists blended over it.
            commandList.beginMarker("Combine");
            frame.beginDraw(this.backgroundPipeline);
            frame.drawAddBindingSet(this.backgroundBindingSet);
            frame.drawVertices(3);

            frame.beginDraw(this.combinePipeline);
            frame.drawAddBindingSet(this.combineBindingSet);
            frame.drawVertices(3);
            commandList.endMarker();
        }

        // The sample's fill_instance_data: the grid's transforms and random colors (alpha 0.2 to 1).
        fillInstanceData(commandList: CommandList): void {
            const random = new MsvcRandom();
            let instances: f32[] = [];
            for (let l = 0; l < INSTANCE_LAYER_COUNT; l++) {
                for (let c = 0; c < INSTANCE_COLUMN_COUNT; c++) {
                    for (let r = 0; r < INSTANCE_ROW_COUNT; r++) {
                        const x = r - (INSTANCE_ROW_COUNT - 1) * 0.5;
                        const y = c - (INSTANCE_COLUMN_COUNT - 1) * 0.5;
                        const z = l - (INSTANCE_LAYER_COUNT - 1) * 0.5;
                        // glm::scale(glm::translate(mat4(1), (x, y, z)), vec3(scale))
                        const model = [INSTANCE_SCALE, 0.0, 0.0, 0.0, 0.0, INSTANCE_SCALE, 0.0, 0.0,
                            0.0, 0.0, INSTANCE_SCALE, 0.0, x, y, z, 1.0];
                        for (let i = 0; i < 16; i++) {
                            instances.push(model[i]);
                        }
                        instances.push(random.nextFloat());
                        instances.push(random.nextFloat());
                        instances.push(random.nextFloat());
                        instances.push(random.nextFloat() * 0.8 + 0.2);
                    }
                }
            }
            commandList.writeBuffer(this.instanceConstantBuffer, Ref(instances[0]), INSTANCE_COUNT * INSTANCE_FLOATS * 4);
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(): boolean {
            if (this.app.hasFragmentStoresAndAtomics() == 0) {
                console.log("This example requires support for buffers and images stores and atomic operations in the fragment shader stage");
                return false;
            }

            const shader = "oit_linked_lists.hlsl";
            this.gatherVS = this.app.createShader(shader, "gather_vs", ShaderType.Vertex);
            this.gatherPS = this.app.createShader(shader, "gather_ps", ShaderType.Pixel);
            this.fullscreenVS = this.app.createShader(shader, "fullscreen_vs", ShaderType.Vertex);
            this.backgroundPS = this.app.createShader(shader, "background_ps", ShaderType.Pixel);
            this.combineVS = this.app.createShader(shader, "combine_vs", ShaderType.Vertex);
            this.combinePS = this.app.createShader(shader, "combine_ps", ShaderType.Pixel);
            if (!this.gatherVS || !this.gatherPS || !this.fullscreenVS || !this.backgroundPS || !this.combineVS || !this.combinePS) {
                return false;
            }

            // The gather pass's vertex input: positions.
            const layoutDesc = InputLayoutDesc.create();
            layoutDesc.addVertexAttribute("POSITION", Format.RGB32_FLOAT, 0, 0, VERTEX_SIZE);
            this.inputLayout = this.app.createInputLayout(layoutDesc, this.gatherVS);

            this.sceneConstantBuffer = this.app.createVolatileConstantBuffer(CONST_FLOATS * 4, "SceneConstants");
            this.instanceConstantBuffer = this.app.createConstantBuffer(INSTANCE_COUNT * INSTANCE_FLOATS * 4, "InstanceData");

            // The sample's descriptor set, split by pass: the gather pass's scene and instance
            // uniforms, list heads, fragment buffer and counter; the background's scene uniform,
            // texture and sampler; the combine pass's scene uniform, list heads, fragments and
            // counter.
            const gatherLayoutDesc = BindingLayoutDesc.create();
            gatherLayoutDesc.layoutVolatileConstantBuffer(0);
            gatherLayoutDesc.layoutConstantBuffer(1);
            gatherLayoutDesc.layoutTextureUAV(1);
            gatherLayoutDesc.layoutStructuredBufferUAV(2);
            gatherLayoutDesc.layoutStructuredBufferUAV(3);
            this.gatherBindingLayout = this.app.createBindingLayout(gatherLayoutDesc, ShaderType.All);

            const backgroundLayoutDesc = BindingLayoutDesc.create();
            backgroundLayoutDesc.layoutVolatileConstantBuffer(0);
            backgroundLayoutDesc.layoutTextureSRV(0);
            backgroundLayoutDesc.layoutSampler(0);
            this.backgroundBindingLayout = this.app.createBindingLayout(backgroundLayoutDesc, ShaderType.Pixel);

            const combineLayoutDesc = BindingLayoutDesc.create();
            combineLayoutDesc.layoutVolatileConstantBuffer(0);
            combineLayoutDesc.layoutTextureUAV(1);
            combineLayoutDesc.layoutStructuredBufferUAV(2);
            combineLayoutDesc.layoutStructuredBufferUAV(3);
            this.combineBindingLayout = this.app.createBindingLayout(combineLayoutDesc, ShaderType.Pixel);

            // The background's sampler: linear, repeating (one mip level, as the sample's texture).
            // Donut's common passes, which hold it, upload their textures on a command list of
            // their own: before ours is open.
            const sampler = this.app.getCommonSampler(CommonSampler.LinearWrap);

            const commandList = this.app.createCommandList();
            commandList.open();
            const mesh = this.app.loadGltfMesh(commandList, MODEL_PATH);
            const background = this.app.loadTexture(commandList, BACKGROUND_PATH, 1);
            this.fillInstanceData(commandList);
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.waitForIdle();
            this.app.releaseResource(commandList.handle);
            if (mesh.isNull() || !background) {
                console.log("Cannot load the model and the background: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return false;
            }
            this.vertexBuffer = mesh.getVertexBuffer();
            this.indexBuffer = mesh.getIndexBuffer();
            this.indexCount = mesh.getIndexCount();

            const backgroundSetDesc = BindingSetDesc.create();
            backgroundSetDesc.bindEntireConstantBuffer(0, this.sceneConstantBuffer);
            backgroundSetDesc.bindTextureSRV(0, background);
            backgroundSetDesc.bindSampler(0, sampler);
            this.backgroundBindingSet = this.app.createBindingSetForLayout(backgroundSetDesc, this.backgroundBindingLayout);

            const pass = this.app.addPass();
            pass.setMousePosCallback(this.onMousePos);
            pass.setMouseButtonCallback(this.onMouseButton);
            pass.setAnimateCallback(this.onAnimate);
            pass.setBackBufferResizingCallback(this.onBackBufferResizing);
            pass.setRenderCallback(this.onRender);
            return true;
        }
    }

    // The sample's overlay.
    class UserInterface {
        private oit: OitLinkedListsPass;

        constructor(oit: OitLinkedListsPass) {
            this.oit = oit;
        }

        buildUI(): void {
            const oit = this.oit;
            Donut_ImGuiSetNextWindowPos(10.0, 10.0);
            // The sample's title (ApiVulkanSample's default).
            Donut_ImGuiBegin("Vulkan Example", 1);
            if (Donut_ImGuiCollapsingHeaderDefaultOpen("Settings") != 0) {
                oit.sortFragments = Donut_ImGuiCheckbox("Sort fragments", oit.sortFragments ? 1 : 0) != 0;
                oit.cameraAutoRotation = Donut_ImGuiCheckbox("Camera auto-rotation", oit.cameraAutoRotation ? 1 : 0) != 0;
                oit.sortedFragmentCount = Donut_ImGuiSliderInt("Sorted fragments per pixel", oit.sortedFragmentCount,
                    SORTED_FRAGMENT_MIN_COUNT, SORTED_FRAGMENT_MAX_COUNT);
                oit.backgroundGrayscale = Donut_ImGuiSliderFloat("Background grayscale", oit.backgroundGrayscale, 0.0, 1.0);
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
        Donut_SetAppName("oit_linked_lists");

        // -debug: the graphics API's debug layer and NVRHI's validation layer.
        // -noui: without the settings window.
        // -nosort: fragments blended unsorted; -sorted <1..16>: sorted fragments per pixel;
        // -rotate: camera auto-rotation; -grayscale <0..1>: the background's brightness.
        // -benchmark: simulated at 60 frames per second whatever the frame rate, as the sample's
        // --benchmark.
        let options = AppOptions.None;
        let withUI = true;
        let sortFragments = true;
        let sortedFragmentCount = SORTED_FRAGMENT_MAX_COUNT;
        let cameraAutoRotation = false;
        let backgroundGrayscale = 0.3;
        let benchmark = false;
        for (let i = 1; i < argc; i++) {
            const arg = Donut_GetArg(argv, i);
            if (arg == "-debug") {
                options = AppOptions.DebugRuntime;
            } else if (arg == "-noui") {
                withUI = false;
            } else if (arg == "-nosort") {
                sortFragments = false;
            } else if (arg == "-rotate") {
                cameraAutoRotation = true;
            } else if (arg == "-benchmark") {
                benchmark = true;
            } else if (arg == "-sorted" && i + 1 < argc) {
                i++;
                sortedFragmentCount = Math.min(Math.max(parseInt(Donut_GetArg(argv, i)), SORTED_FRAGMENT_MIN_COUNT), SORTED_FRAGMENT_MAX_COUNT);
            } else if (arg == "-grayscale" && i + 1 < argc) {
                i++;
                backgroundGrayscale = Math.min(Math.max(parseFloat(Donut_GetArg(argv, i)), 0.0), 1.0);
            }
        }

        const api = Donut_GetGraphicsAPIFromCommandLine(argc, argv);
        const app = App.createWithOptions(api, WINDOW_TITLE, 1280, 720, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        const oit = new OitLinkedListsPass(app);
        oit.sortFragments = sortFragments;
        oit.sortedFragmentCount = sortedFragmentCount;
        oit.cameraAutoRotation = cameraAutoRotation;
        oit.backgroundGrayscale = backgroundGrayscale;
        oit.benchmark = benchmark;
        if (!oit.init()) {
            app.destroy();
            return 1;
        }

        // Drawn after (over) the scene, and sees the mouse first.
        const gui = new UserInterface(oit);
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
    return OitLinkedLists.main(argc, argv);
}
