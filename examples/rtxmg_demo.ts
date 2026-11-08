// Port of NVIDIA's RTX Mega Geometry demo (github.com/NVIDIA-RTX/RTXMG), its cluster tessellation path:
// Catmull-Clark subdivision surfaces, tessellated into clusters every frame (their CLASes and BLASes
// rebuilt on the GPU), path traced with accumulation and tone mapped as the demo does.
//
// The library's work (scene, cluster tessellator, HiZ culling, TLAS, the environment map's sampling
// tables) is core/rtxmg.cpp's, over RTXMG_DIR's library; this file is the demo's app: the path tracer's
// pipeline, shader table and binding set, the trace, the blit and the window. Vulkan (its
// VK_NV_cluster_acceleration_structure) or D3D12 with NVRHI's DXR cluster build (NVRHI_D3D12_WITH_DXRCLUSTER:
// the preview Agility SDK, shader model 6.10, Windows' Developer Mode and driver 621.01+). Run with:
//   rtxmg_demo --media <RTXMG_DIR>/assets --scene subdivision/amy_kitchenset.scene.json
// RTXMG is under the NVIDIA RTX SDKs License: nothing of it is in this repository.

import { Args } from "../core/args";
import { TestCheck, unsupported } from "../core/test_check";
import { RtxmgDemo } from "../core/rtxmg";

namespace RtxmgDemoExample {
    const WINDOW_TITLE = "RTX Mega Geometry";
    const TEST_FRAMES = 64;
    // RTXMG_NVAPI_SHADER_EXT_SLOT (demo/render_params.h): the UAV of NVAPI's shader extensions, which the
    // D3D12 path tracer declares (no NVAPI here: only its root signature slot, never written).
    const NVAPI_SHADER_EXT_SLOT = 1000;

    // core/rtxmg.cpp's RtxmgResource and RtxmgTexture.
    const RTXMG_BUFFER_LIGHTING = 0;
    const RTXMG_BUFFER_RENDER_PARAMS = 1;
    const RTXMG_BUFFER_INSTANCES = 2;
    const RTXMG_BUFFER_MATERIALS = 3;
    const RTXMG_BUFFER_ENVMAP_CONDITIONAL_CDF = 4;
    const RTXMG_BUFFER_ENVMAP_MARGINAL_CDF = 5;
    const RTXMG_BUFFER_ENVMAP_CONDITIONAL_FUNC = 6;
    const RTXMG_BUFFER_ENVMAP_MARGINAL_FUNC = 7;
    const RTXMG_BUFFER_CLUSTER_SHADING_DATA = 8;
    const RTXMG_BUFFER_CLUSTER_VERTEX_POSITIONS = 9;
    const RTXMG_BUFFER_CLUSTER_VERTEX_NORMALS = 10;
    const RTXMG_BUFFER_SUBD_INSTANCES = 11;
    const RTXMG_BUFFER_DUMMY = 12;
    const RTXMG_BUFFER_HIT_RESULT = 13;
    const RTXMG_BUFFER_PIXEL_DEBUG = 14;
    const RTXMG_BUFFER_TIME_VIEW = 15;
    const RTXMG_BUFFER_BLIT_PARAMS = 16;
    const RTXMG_BUFFER_EXPOSURE = 17;
    const RTXMG_BUFFER_PIXEL_PICK = 18;
    const RTXMG_TEXTURE_ENVMAP = 0;
    const RTXMG_TEXTURE_ACCUMULATION = 1;
    const RTXMG_TEXTURE_DEPTH = 2;
    const RTXMG_TEXTURE_NORMALS = 3;
    const RTXMG_TEXTURE_ALBEDO = 4;
    const RTXMG_TEXTURE_SPECULAR = 5;
    const RTXMG_TEXTURE_SPECULAR_HIT_T = 6;
    const RTXMG_TEXTURE_ROUGHNESS = 7;
    const RTXMG_TEXTURE_DISPLAY = 8;

    class Renderer {
        private app: App;
        private rtxmg: RtxmgDemo;
        private exposure: number;
        // D3D12: the path tracer's RayGen declares NVAPI's extension UAV (its timer), bound null here.
        private d3d12: boolean;
        private layout: BindingLayoutHandle;
        private bindingSet: BindingSet;
        private bindingGeneration: int = -1;
        private shaderTable: ShaderTable;
        private blitLayout: BindingLayoutHandle;
        private blitPipeline: ComputePipelineHandle;
        private blitSet: BindingSet;
        private width: int = 0;
        private height: int = 0;
        private frameIndex: int = 0;

        constructor(app: App, rtxmg: RtxmgDemo, exposure: number, d3d12: boolean) {
            this.app = app;
            this.rtxmg = rtxmg;
            this.exposure = exposure;
            this.d3d12 = d3d12;
        }

        // The path tracer's pipeline over its two layouts: the demo's space 0 (constants, scene, outputs) and
        // the library's bindless descriptor table (space 1); its rays: the primary and shadow ones, with the
        // subdivision surfaces' hit groups and cluster LOD's, which this scene doesn't use.
        init(): boolean {
            const desc = BindingLayoutDesc.create();
            desc.layoutVolatileConstantBuffer(0);
            desc.layoutVolatileConstantBuffer(1);
            desc.layoutAccelStruct(0);
            for (let slot = 1; slot <= 2; slot++) {
                desc.layoutStructuredBufferSRV(slot);
            }
            desc.layoutTextureSRV(3);
            for (let slot = 4; slot <= 15; slot++) {
                desc.layoutStructuredBufferSRV(slot);
            }
            desc.layoutSampler(0);
            for (let slot = 0; slot <= 6; slot++) {
                desc.layoutTextureUAV(slot);
            }
            desc.layoutStructuredBufferUAV(7);
            desc.layoutStructuredBufferUAV(12);
            desc.layoutTypedBufferUAV(13);
            desc.layoutStructuredBufferUAV(14);
            if (this.d3d12) {
                desc.layoutTypedBufferUAV(NVAPI_SHADER_EXT_SLOT);
            }
            this.layout = this.app.createBindingLayout(desc, ShaderType.All);

            const library = this.rtxmg.getPathTracerLibrary();
            if (!library) {
                console.log("rtxmg_demo: the path tracer's shaders don't load");
                return false;
            }
            const pipelineDesc = RtPipelineDesc.create(this.rtxmg.getPayloadSize(), this.rtxmg.getMaxBounces() + 1);
            pipelineDesc.addGlobalBindingLayout(this.layout);
            pipelineDesc.addGlobalBindingLayout(this.rtxmg.getBindlessLayout());
            pipelineDesc.addShader(library, "RayGen", ShaderType.RayGeneration);
            pipelineDesc.addShader(library, "Miss", ShaderType.Miss);
            pipelineDesc.addShader(library, "ShadowMiss", ShaderType.Miss);
            pipelineDesc.addHitGroup(library, "HitGroup", "ClosestHit", "", null);
            pipelineDesc.addHitGroup(library, "ShadowHitGroup", "", "", null);
            pipelineDesc.addHitGroup(library, "ClusterLodHitGroup", "ClusterLodClosestHit", "ClusterLodAnyHit", null);
            pipelineDesc.addHitGroup(library, "ClusterLodShadowHitGroup", "ClusterLodShadowClosestHit", "ClusterLodShadowAnyHit", null);
            pipelineDesc.setAllowClusteredGeometry(true);
            const pipeline = this.app.createRayTracingPipelineFromDesc(pipelineDesc);
            if (!pipeline) {
                console.log("rtxmg_demo: cannot create the path tracing pipeline");
                return false;
            }
            const table = this.app.createEmptyShaderTable(pipeline);
            table.setRayGeneration("RayGen");
            table.addHitGroup("HitGroup", null);
            table.addHitGroup("ShadowHitGroup", null);
            table.addHitGroup("ClusterLodHitGroup", null);
            table.addHitGroup("ClusterLodShadowHitGroup", null);
            table.addMiss("Miss");
            table.addMiss("ShadowMiss");
            this.shaderTable = table;

            // The blit: the accumulation exposed, tone mapped (ACES) and sRGB encoded into the display texture.
            const blitDesc = BindingLayoutDesc.create();
            blitDesc.layoutVolatileConstantBuffer(0);
            blitDesc.layoutTextureUAV(0);
            blitDesc.layoutTextureSRV(0);
            blitDesc.layoutTextureSRV(1);
            blitDesc.layoutTypedBufferSRV(2);
            blitDesc.layoutStructuredBufferSRV(3);
            blitDesc.layoutSampler(0);
            this.blitLayout = this.app.createBindingLayout(blitDesc, ShaderType.Compute);
            const blitShader = this.rtxmg.getBlitShader();
            if (!blitShader) {
                console.log("rtxmg_demo: the blit shader doesn't load");
                return false;
            }
            this.blitPipeline = this.app.createComputePipelineWithLayout(blitShader, this.blitLayout);

            const pass = this.app.addPass();
            pass.setRenderCallback(this.onRender);
            return true;
        }

        // The binding sets over what core/rtxmg.cpp holds now (it makes some of it again as the tessellation
        // grows or the window resizes).
        private createBindingSets() {
            const r = this.rtxmg;
            const desc = BindingSetDesc.create();
            desc.bindEntireConstantBuffer(0, r.getBuffer(RTXMG_BUFFER_LIGHTING));
            desc.bindEntireConstantBuffer(1, r.getBuffer(RTXMG_BUFFER_RENDER_PARAMS));
            desc.bindAccelStruct(0, r.getTlas());
            desc.bindStructuredBufferSRV(1, r.getBuffer(RTXMG_BUFFER_INSTANCES));
            desc.bindStructuredBufferSRV(2, r.getBuffer(RTXMG_BUFFER_MATERIALS));
            desc.bindTextureSRV(3, r.getTexture(RTXMG_TEXTURE_ENVMAP));
            desc.bindStructuredBufferSRV(4, r.getBuffer(RTXMG_BUFFER_ENVMAP_CONDITIONAL_CDF));
            desc.bindStructuredBufferSRV(5, r.getBuffer(RTXMG_BUFFER_ENVMAP_MARGINAL_CDF));
            desc.bindStructuredBufferSRV(6, r.getBuffer(RTXMG_BUFFER_ENVMAP_CONDITIONAL_FUNC));
            desc.bindStructuredBufferSRV(7, r.getBuffer(RTXMG_BUFFER_ENVMAP_MARGINAL_FUNC));
            desc.bindStructuredBufferSRV(8, r.getBuffer(RTXMG_BUFFER_CLUSTER_SHADING_DATA));
            desc.bindStructuredBufferSRV(9, r.getBuffer(RTXMG_BUFFER_CLUSTER_VERTEX_POSITIONS));
            desc.bindStructuredBufferSRV(10, r.getBuffer(RTXMG_BUFFER_CLUSTER_VERTEX_NORMALS));
            desc.bindStructuredBufferSRV(11, r.getBuffer(RTXMG_BUFFER_SUBD_INSTANCES));
            // Cluster LOD's instances, geometries, resident clusters and material indices: none here.
            for (let slot = 12; slot <= 15; slot++) {
                desc.bindStructuredBufferSRV(slot, r.getBuffer(RTXMG_BUFFER_DUMMY));
            }
            desc.bindSampler(0, r.getSampler(0));
            desc.bindTextureUAV(0, r.getTexture(RTXMG_TEXTURE_ACCUMULATION));
            desc.bindTextureUAV(1, r.getTexture(RTXMG_TEXTURE_DEPTH));
            desc.bindTextureUAV(2, r.getTexture(RTXMG_TEXTURE_NORMALS));
            desc.bindTextureUAV(3, r.getTexture(RTXMG_TEXTURE_ALBEDO));
            desc.bindTextureUAV(4, r.getTexture(RTXMG_TEXTURE_SPECULAR));
            desc.bindTextureUAV(5, r.getTexture(RTXMG_TEXTURE_SPECULAR_HIT_T));
            desc.bindTextureUAV(6, r.getTexture(RTXMG_TEXTURE_ROUGHNESS));
            desc.bindStructuredBufferUAV(7, r.getBuffer(RTXMG_BUFFER_HIT_RESULT));
            desc.bindStructuredBufferUAV(12, r.getBuffer(RTXMG_BUFFER_PIXEL_DEBUG));
            desc.bindTypedBufferUAV(13, r.getBuffer(RTXMG_BUFFER_TIME_VIEW));
            desc.bindStructuredBufferUAV(14, r.getBuffer(RTXMG_BUFFER_PIXEL_PICK));
            if (this.d3d12) {
                desc.bindNullTypedBufferUAV(NVAPI_SHADER_EXT_SLOT);
            }
            this.bindingSet = this.app.createBindingSetForLayout(desc, this.layout);

            const blitDesc = BindingSetDesc.create();
            blitDesc.bindEntireConstantBuffer(0, r.getBuffer(RTXMG_BUFFER_BLIT_PARAMS));
            blitDesc.bindTextureUAV(0, r.getTexture(RTXMG_TEXTURE_DISPLAY));
            blitDesc.bindTextureSRV(0, r.getTexture(RTXMG_TEXTURE_ACCUMULATION));
            // The denoised output (DLSS's): unused without the denoiser.
            blitDesc.bindTextureSRV(1, r.getTexture(RTXMG_TEXTURE_ACCUMULATION));
            blitDesc.bindTypedBufferSRV(2, r.getBuffer(RTXMG_BUFFER_EXPOSURE));
            blitDesc.bindStructuredBufferSRV(3, r.getBuffer(RTXMG_BUFFER_HIT_RESULT));
            blitDesc.bindSampler(0, r.getSampler(1));
            this.blitSet = this.app.createBindingSetForLayout(blitDesc, this.blitLayout);
        }

        // The frame: the library's work (poses, HiZ, clusters, acceleration structures), one path traced
        // subframe accumulated, the blit, and the display texture onto the back buffer.
        onRender(frameHandle: FrameHandle) {
            const frame = new Frame(frameHandle);
            const width = frame.getWidth();
            const height = frame.getHeight();
            if (width != this.width || height != this.height) {
                this.rtxmg.setSize(width, height);
                this.width = width;
                this.height = height;
            }
            const commandList = frame.getCommandList();
            const generation = this.rtxmg.beginFrame(commandList.handle, this.frameIndex);
            if (generation != this.bindingGeneration) {
                this.createBindingSets();
                this.bindingGeneration = generation;
            }
            frame.dispatchRaysWithDescriptorTable(this.shaderTable, this.bindingSet, this.rtxmg.getDescriptorTable(), width, height);
            this.rtxmg.endFrame();
            this.rtxmg.writeBlitParams(commandList.handle, this.exposure);
            commandList.dispatch(this.blitPipeline, this.blitSet, Math.ceil(width / 32), Math.ceil(height / 32), 1);
            this.app.blitTexture(frame, this.rtxmg.getTexture(RTXMG_TEXTURE_DISPLAY));
            this.frameIndex++;
        }
    }

    // Lit: the kitchen fills the frame, so most pixels are far from black.
    function checkFrame(app: App) {
        const check = new TestCheck(app);
        if (check.frameRead() != "") {
            return check.frameRead();
        }
        const total = check.width * check.height;
        return check.share(total - check.countInRange(0, 3, 0, 3, 0, 3, 0, 0, check.width, check.height), total,
            90.0, 100.0, "Lit");
    }

    class RtxmgArgs extends Args {
        width: int = 1280;
        height: int = 720;
        mediaPath: string = "";
        camera: string = "";
        exposure: number = -1.0;
        // -mode pt|primary|ao: the demo's shading modes (primary rays and AO show the base color).
        shadingMode: int = 2;
        // -spp, -maxBounces: the path tracer's, over the scene file's; -firefly: a clamp (the demo's frames have none).
        spp: int = -1;
        maxBounces: int = -1;
        firefly: number = -1.0;

        protected parseOptions() {
            for (let i = 1; i + 1 < this.argc; i++) {
                const arg = this[i];
                if (arg == "-width") {
                    this.width = parseInt(this[i + 1]);
                } else if (arg == "-height") {
                    this.height = parseInt(this[i + 1]);
                } else if (arg == "--media") {
                    this.mediaPath = this[i + 1];
                } else if (arg == "-p" || arg == "--cameraPos") {
                    this.camera = this[i + 1];
                } else if (arg == "-mode") {
                    const mode = this[i + 1];
                    this.shadingMode = mode == "primary" ? 0 : (mode == "ao" ? 1 : 2);
                } else if (arg == "-spp") {
                    this.spp = parseInt(this[i + 1]);
                } else if (arg == "-maxBounces") {
                    this.maxBounces = parseInt(this[i + 1]);
                } else if (arg == "-firefly") {
                    this.firefly = parseFloat(this[i + 1]);
                } else if (arg == "-exposure") {
                    this.exposure = parseFloat(this[i + 1]);
                }
            }
        }
    }

    export function main(argc: int, argv: Ref<string>) {
        Program.setAppName("rtxmg_demo");

        let testFrames = TEST_FRAMES;
        for (let i = 1; i + 1 < argc; i++) {
            if (CommandLine.getArg(argv, i) == "-frames") {
                testFrames = parseInt(CommandLine.getArg(argv, i + 1));
            }
        }
        const args = new RtxmgArgs(argc, argv, testFrames);
        args.parseArgs();
        if (args.scenePath == "" || args.mediaPath == "") {
            console.log("Pass the scene with --media <RTXMG_DIR>/assets --scene subdivision/amy_kitchenset.scene.json");
            return 1;
        }
        // UNORM back buffers, as the demo's: the blit writes sRGB itself. The library's D3D12 shaders read its
        // bindless table through ResourceDescriptorHeap[].
        const app = App.createWithOptions(args.api, WINDOW_TITLE, args.width, args.height,
            AppOptions.RayTracing | AppOptions.UnormBackBuffer | AppOptions.HeapDirectlyIndexed | args.options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }
        if (!app.isFeatureSupported(Feature.RayTracingPipeline)) {
            app.destroy();
            return unsupported(args.test, "The graphics device does not support ray tracing pipelines");
        }
        console.log(`Renderer: ${app.getRendererString()}`);

        const rtxmg = RtxmgDemo.create(app.getNvrhiDevice());
        if (rtxmg.isNull()) {
            app.destroy();
            return unsupported(args.test, "The graphics device does not support cluster acceleration structures");
        }
        if (!rtxmg.loadScene(args.mediaPath, args.scenePath)) {
            console.log(`Cannot load ${args.scenePath} from ${args.mediaPath}`);
            rtxmg.destroy();
            app.destroy();
            return 1;
        }
        if (args.camera != "" && !rtxmg.setCamera(args.camera)) {
            console.log(`Ignoring the malformed camera "${args.camera}" ([eye][lookat][up]fovY)`);
        }

        rtxmg.setShadingMode(args.shadingMode, 0);
        rtxmg.setPathTracing(args.spp, args.maxBounces, args.firefly);
        // The demo's primary ray and AO modes decode flat values: exposure 1 (as its shot lists' captures).
        const sceneExposure = args.shadingMode == 2 ? rtxmg.getExposure() : 1.0;
        const renderer = new Renderer(app, rtxmg, args.exposure >= 0.0 ? args.exposure : sceneExposure, args.api == GraphicsAPI.D3D12);
        if (!renderer.init()) {
            rtxmg.destroy();
            app.destroy();
            return 1;
        }

        app.run();
        let result = 0;
        if (args.test) {
            result = app.finishTest(checkFrame(app));
        }
        app.waitForIdle();
        rtxmg.destroy();
        app.destroy();
        return result;
    }
}

function main(argc: int, argv: Ref<string>) {
    return RtxmgDemoExample.main(argc, argv);
}
