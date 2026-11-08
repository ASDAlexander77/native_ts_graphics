// RTXDI's ReSTIR DI (github.com/NVIDIA-RTX/RTXDI) on Donut, the parts its samples share: the ReSTIR DI
// context and resources with the light preparation (core/rtxdi.cpp, over RTXDI's runtime library), the G-buffer
// render targets of the current and the previous frame, and the PrepareLights pass, which turns the scene's
// emissive triangles into RTXDI's light buffer; and the Minimal Sample's fused Render pass with its settings.
// Written from the Minimal Sample's RtxdiResources, RenderTargets, PrepareLightsPass and RenderPass; the
// shaders are the sample's, compiled in place from RTXDI_DIR (rtxdi_minimal_shaders in CMakeLists.txt).
//
// Imported with `import { RtxdiDI, ... } from "../core/rtxdi_di";` (from examples/); list core/rtxdi_di.ts with
// core/rtxdi.cpp in the example's add_tslang_example sources.
//
// The sample is under the NVIDIA RTX SDKs License. This software contains source code provided by NVIDIA
// Corporation.

/// <reference path="donut_interop.d.ts" />

import { App, BindingLayoutDesc, BindingSet, BindingSetDesc, CommandList, Scene } from "./donut";

// PrepareLights.hlsl's [numthreads(256, 1, 1)]: a thread per light (emissive triangle).
const PREPARE_LIGHTS_GROUP_SIZE = 256;
// sizeof(PrepareLightsConstants) in the sample's ShaderParameters.h: numTasks, a uint.
const PREPARE_LIGHTS_CONSTANTS_SIZE = 4;
// RTXDI_SCREEN_SPACE_GROUP_SIZE, Render.hlsl's [numthreads(8, 8, 1)]: defined (8) in the Minimal Sample's
// Shaders/ShaderParameters.h; RTXDI's library headers (Libraries/Rtxdi/Include) don't define it.
const RTXDI_SCREEN_SPACE_GROUP_SIZE = 8;

// RTXDI's ReSTIR DI context for a render size and the resources sized for a scene (the sample's
// ReSTIRDIContext and RtxdiResources): the light buffers PrepareLightsPass fills, the neighbor offsets, the
// reservoirs and the resampling constant buffer. Made again on resize (dispose, then a new one), as the
// sample drops both in BackBufferResized. isNull() when the resources couldn't be made (logged).
export class RtxdiDI {
    readonly context: RtxdiDIContextHandle;
    readonly resources: RtxdiResourcesHandle;

    // public readonly: tslang makes no parameter property of `readonly` alone.
    constructor(app: App, private scene: Scene, public readonly width: int, public readonly height: int) {
        this.context = Rtxdi_CreateDIContext(width, height);
        this.resources = Rtxdi_CreateResources(app.handle, this.context, scene.handle) as RtxdiResourcesHandle;
        if (this.resources) {
            Rtxdi_CreateConstantBuffers(app.handle, this.resources);
        }
    }

    isNull(): boolean {
        return !this.resources;
    }

    // The neighbor offsets of the spatial resampling, written on the command list the first time.
    initializeNeighborOffsets(commandList: CommandList): void {
        Rtxdi_InitializeNeighborOffsets(this.resources, this.context, commandList.handle);
    }

    // The frame the context's runtime parameters are for (the random seed, the reservoir buffers read and
    // written): the app's frame index, before the frame's resampling constants.
    setFrameIndex(frameIndex: int): void {
        Rtxdi_SetFrameIndex(this.context, frameIndex);
    }

    // The CPU part of the light preparation, on the command list: the tasks (one per emissive geometry) and the
    // geometry instance to light map. Returns the number of lights, the threads of the PrepareLights dispatch.
    prepareLights(commandList: CommandList): int {
        return Rtxdi_PrepareLights(this.resources, this.scene.handle, commandList.handle);
    }

    // The task count of the last prepareLights: PrepareLights' push constant.
    taskCount(): int {
        return Rtxdi_GetPrepareLightsTaskCount(this.resources);
    }

    // One of the resources' buffers (theirs: don't release it).
    buffer(which: RtxdiBuffer): BufferHandle {
        return Rtxdi_GetBuffer(this.resources, which);
    }

    resamplingConstantBuffer(): BufferHandle {
        return Rtxdi_GetResamplingConstantBuffer(this.resources);
    }

    // Frees the resources and the context; NVRHI keeps the buffers alive while the GPU uses them. Before the app.
    dispose(): void {
        if (this.resources) {
            Rtxdi_DestroyResources(this.resources);
        }
        Rtxdi_DestroyDIContext(this.context);
    }
}

// The G-buffer the sample's RenderTargets keeps a current and a previous one of (swapped every frame): depth
// (R32_FLOAT), normals, geometry normals, diffuse albedo and specular / roughness (R32_UINT, packed). UAV
// textures resting at UnorderedAccess, as the sample's.
export class RtxdiGBuffer {
    readonly depth: TextureHandle;
    readonly normals: TextureHandle;
    readonly geoNormals: TextureHandle;
    readonly diffuseAlbedo: TextureHandle;
    readonly specularRough: TextureHandle;

    // prefix: "" for the current frame's, "Prev" for the previous one's (the sample's debug names).
    constructor(app: App, width: int, height: int, prefix: string) {
        this.depth = app.createUAVTextureWithFormat(width, height, Format.R32_FLOAT, `${prefix}DepthBuffer`);
        this.diffuseAlbedo = app.createUAVTextureWithFormat(width, height, Format.R32_UINT, `${prefix}GBufferDiffuseAlbedo`);
        this.specularRough = app.createUAVTextureWithFormat(width, height, Format.R32_UINT, `${prefix}GBufferSpecularRough`);
        this.normals = app.createUAVTextureWithFormat(width, height, Format.R32_UINT, `${prefix}GBufferNormals`);
        this.geoNormals = app.createUAVTextureWithFormat(width, height, Format.R32_UINT, `${prefix}GBufferGeoNormals`);
    }

    release(app: App): void {
        app.releaseResource(this.depth);
        app.releaseResource(this.diffuseAlbedo);
        app.releaseResource(this.specularRough);
        app.releaseResource(this.normals);
        app.releaseResource(this.geoNormals);
    }
}

// The sample's RenderTargets: the G-buffers of this frame and the last (swap() after each frame, its
// NextFrame) and the HDR color the shading writes (RGBA16_FLOAT, one: it isn't kept across frames).
export class RtxdiRenderTargets {
    current: RtxdiGBuffer;
    previous: RtxdiGBuffer;
    readonly hdrColor: TextureHandle;

    // public readonly: tslang makes no parameter property of `readonly` alone.
    constructor(app: App, public readonly width: int, public readonly height: int) {
        this.current = new RtxdiGBuffer(app, width, height, "");
        this.previous = new RtxdiGBuffer(app, width, height, "Prev");
        this.hdrColor = app.createUAVTextureWithFormat(width, height, Format.RGBA16_FLOAT, "HdrColor");
    }

    swap(): void {
        const current = this.current;
        this.current = this.previous;
        this.previous = current;
    }

    release(app: App): void {
        this.current.release(app);
        this.previous.release(app);
        app.releaseResource(this.hdrColor);
    }
}

// The sample's PrepareLightsPass: its compute shader (rtxdi_minimal's PrepareLights.hlsl) writes a
// RAB_LightInfo per emissive triangle of the scene into the light data buffer, from the tasks
// RtxdiDI.prepareLights wrote, the scene's instances, geometries and materials and, through the bindless
// descriptor table the scene was loaded with, its vertex and index buffers and emissive textures.
// Registers as PrepareLights.hlsl's: b0 the push constants (numTasks), u0 the light data, t0 the tasks,
// t2 / t3 / t4 the instance, geometry and material buffers, s0 the anisotropic wrap sampler.
export class PrepareLightsPass {
    private bindingLayout: BindingLayoutHandle;
    private pipeline: ComputePipelineHandle | null = null;
    private bindingSet: BindingSet = new BindingSet(null);
    // PrepareLightsConstants, pushed with the dispatch.
    private constants: int[] = [0];

    // descriptorTable: the table of the descriptor table manager the scene was loaded with (over bindlessLayout).
    constructor(private app: App, private bindlessLayout: BindingLayoutHandle, private scene: Scene,
        private descriptorTable: DescriptorTableHandle) {
        const layoutDesc = BindingLayoutDesc.create();
        layoutDesc.layoutPushConstants(0, PREPARE_LIGHTS_CONSTANTS_SIZE);
        layoutDesc.layoutStructuredBufferUAV(0);
        layoutDesc.layoutStructuredBufferSRV(0);
        layoutDesc.layoutStructuredBufferSRV(2);
        layoutDesc.layoutStructuredBufferSRV(3);
        layoutDesc.layoutStructuredBufferSRV(4);
        layoutDesc.layoutSampler(0);
        this.bindingLayout = app.createBindingLayout(layoutDesc, ShaderType.Compute);
    }

    // The pipeline (CreatePipeline); false if the shader isn't there (logged by Donut).
    createPipeline(): boolean {
        const shader = this.app.createShader("PrepareLights.hlsl", "main", ShaderType.Compute);
        if (!shader) {
            return false;
        }
        const pipeline = this.app.createComputePipelineWithLayouts(shader, this.bindingLayout, this.bindlessLayout);
        if (!pipeline) {
            return false;
        }
        this.pipeline = pipeline;
        return true;
    }

    // The binding set over di's buffers (CreateBindingSet): after each new RtxdiDI.
    createBindingSet(di: RtxdiDI): void {
        this.releaseBindingSet();
        const setDesc = BindingSetDesc.create();
        setDesc.bindPushConstants(0, PREPARE_LIGHTS_CONSTANTS_SIZE);
        setDesc.bindStructuredBufferUAV(0, di.buffer(RtxdiBuffer.LightData));
        setDesc.bindStructuredBufferSRV(0, di.buffer(RtxdiBuffer.Tasks));
        setDesc.bindStructuredBufferSRV(2, this.scene.getBuffer(SceneBuffer.Instances));
        setDesc.bindStructuredBufferSRV(3, this.scene.getBuffer(SceneBuffer.Geometries));
        setDesc.bindStructuredBufferSRV(4, this.scene.getBuffer(SceneBuffer.Materials));
        setDesc.bindSampler(0, this.app.getCommonSampler(CommonSampler.AnisotropicWrap));
        this.bindingSet = this.app.createBindingSetForLayout(setDesc, this.bindingLayout);
    }

    releaseBindingSet(): void {
        const bindingSet = this.bindingSet;
        if (!bindingSet.isNull()) {
            this.app.releaseResource(bindingSet.handle);
            this.bindingSet = new BindingSet(null);
        }
    }

    // PrepareLightsPass::Process: di's light preparation on the command list, then the shader over the lights,
    // a thread each (no dispatch without lights). Returns the number of lights.
    dispatch(commandList: CommandList, di: RtxdiDI): int {
        commandList.beginMarker("PrepareLights");
        const lightCount = di.prepareLights(commandList);
        const pipeline = this.pipeline;
        if (lightCount > 0 && pipeline) {
            this.constants[0] = di.taskCount();
            const groups: int = Math.floor((lightCount + PREPARE_LIGHTS_GROUP_SIZE - 1) / PREPARE_LIGHTS_GROUP_SIZE);
            commandList.dispatchWithDescriptorTableAndPushConstants(pipeline, this.bindingSet, this.descriptorTable,
                Ref(this.constants[0]), PREPARE_LIGHTS_CONSTANTS_SIZE, groups, 1, 1);
        }
        commandList.endMarker();
        return lightCount;
    }
}

// The Minimal Sample's RenderPass::Settings, which its UI changes: resampling on or off, unbiased mode (ray traced
// bias correction in the spatio-temporal resampling, else basic), the initial local light and BRDF samples, the
// BRDF cutoff and the spatial samples. The four numbers default to the sample's (Rtxdi_GetDefaultSettings).
export class RtxdiMinimalSettings {
    enableResampling: boolean = true;
    unbiasedMode: boolean = false;
    numLocalLightSamples: int = 0;
    numBrdfSamples: int = 0;
    brdfCutoff: number = 0.0;
    numSpatialSamples: int = 0;

    constructor() {
        const defaults: f32[] = [0.0, 0.0, 0.0, 0.0];
        Rtxdi_GetDefaultSettings(Ref(defaults[0]));
        this.numLocalLightSamples = Math.round(defaults[0]);
        this.numBrdfSamples = Math.round(defaults[1]);
        this.brdfCutoff = defaults[2];
        this.numSpatialSamples = Math.round(defaults[3]);
    }
}

// The Minimal Sample's RenderPass: Render.hlsl (rtxdi_minimal's), a thread per pixel tracing the primary ray,
// writing the G-buffer, sampling the lights, resampling with the last frame's reservoirs and G-buffer (fused
// spatio-temporal) and shading into the HDR color. Two binding sets over the render targets (registers as
// RAB_Buffers.hlsli's): the active one reads the previous G-buffer (t0..t4) and writes the current one (u2..u6),
// the other the reverse; nextFrame() swaps them as RtxdiRenderTargets.swap() swaps the targets, so the active
// set always reads the previous frame's. Besides: t30 the TLAS, t32 / t33 / t34 the scene's instances,
// geometries and materials, t20 the light data, t21 the neighbor offsets (typed), t22 the geometry instance to
// light map, u0 the light reservoirs, u1 the HDR color, b0 the resampling constants (volatile), s0 and s1
// linear wrap samplers (the sample binds both; the shader reads s0).
export class RenderPass {
    private bindingLayout: BindingLayoutHandle;
    private pipeline: ComputePipelineHandle | null = null;
    private bindingSet: BindingSet = new BindingSet(null);
    private prevBindingSet: BindingSet = new BindingSet(null);

    // descriptorTable: the table of the descriptor table manager the scene was loaded with (over bindlessLayout).
    constructor(private app: App, private bindlessLayout: BindingLayoutHandle, private scene: Scene,
        private descriptorTable: DescriptorTableHandle) {
        const layoutDesc = BindingLayoutDesc.create();
        for (let slot = 0; slot <= 4; slot++) {
            layoutDesc.layoutTextureSRV(slot);
        }
        layoutDesc.layoutAccelStruct(30);
        layoutDesc.layoutStructuredBufferSRV(32);
        layoutDesc.layoutStructuredBufferSRV(33);
        layoutDesc.layoutStructuredBufferSRV(34);
        layoutDesc.layoutStructuredBufferSRV(20);
        layoutDesc.layoutTypedBufferSRV(21);
        layoutDesc.layoutStructuredBufferSRV(22);
        layoutDesc.layoutStructuredBufferUAV(0);
        for (let slot = 1; slot <= 6; slot++) {
            layoutDesc.layoutTextureUAV(slot);
        }
        layoutDesc.layoutVolatileConstantBuffer(0);
        layoutDesc.layoutSampler(0);
        layoutDesc.layoutSampler(1);
        this.bindingLayout = app.createBindingLayout(layoutDesc, ShaderType.Compute);
    }

    // The pipeline (CreatePipeline); false if the shader isn't there (logged by Donut).
    createPipeline(): boolean {
        const shader = this.app.createShader("Render.hlsl", "main", ShaderType.Compute);
        if (!shader) {
            return false;
        }
        const pipeline = this.app.createComputePipelineWithLayouts(shader, this.bindingLayout, this.bindlessLayout);
        if (!pipeline) {
            return false;
        }
        this.pipeline = pipeline;
        return true;
    }

    // The two binding sets (CreateBindingSet), after new render targets or RTXDI resources: the active one reads
    // targets.previous and writes targets.current.
    createBindingSets(tlas: AccelStructHandle, targets: RtxdiRenderTargets, di: RtxdiDI): void {
        this.releaseBindingSets();
        this.bindingSet = this.createBindingSet(tlas, targets, di, targets.previous, targets.current);
        this.prevBindingSet = this.createBindingSet(tlas, targets, di, targets.current, targets.previous);
    }

    private createBindingSet(tlas: AccelStructHandle, targets: RtxdiRenderTargets, di: RtxdiDI,
        read: RtxdiGBuffer, write: RtxdiGBuffer): BindingSet {
        const setDesc = BindingSetDesc.create();
        setDesc.bindTextureSRV(0, read.depth);
        setDesc.bindTextureSRV(1, read.normals);
        setDesc.bindTextureSRV(2, read.geoNormals);
        setDesc.bindTextureSRV(3, read.diffuseAlbedo);
        setDesc.bindTextureSRV(4, read.specularRough);

        setDesc.bindAccelStruct(30, tlas);
        setDesc.bindStructuredBufferSRV(32, this.scene.getBuffer(SceneBuffer.Instances));
        setDesc.bindStructuredBufferSRV(33, this.scene.getBuffer(SceneBuffer.Geometries));
        setDesc.bindStructuredBufferSRV(34, this.scene.getBuffer(SceneBuffer.Materials));

        setDesc.bindStructuredBufferSRV(20, di.buffer(RtxdiBuffer.LightData));
        setDesc.bindTypedBufferSRV(21, di.buffer(RtxdiBuffer.NeighborOffsets));
        setDesc.bindStructuredBufferSRV(22, di.buffer(RtxdiBuffer.GeometryInstanceToLight));

        setDesc.bindStructuredBufferUAV(0, di.buffer(RtxdiBuffer.LightReservoirs));
        setDesc.bindTextureUAV(1, targets.hdrColor);
        setDesc.bindTextureUAV(2, write.depth);
        setDesc.bindTextureUAV(3, write.normals);
        setDesc.bindTextureUAV(4, write.geoNormals);
        setDesc.bindTextureUAV(5, write.diffuseAlbedo);
        setDesc.bindTextureUAV(6, write.specularRough);

        setDesc.bindEntireConstantBuffer(0, di.resamplingConstantBuffer());
        const sampler = this.app.getCommonSampler(CommonSampler.LinearWrap);
        setDesc.bindSampler(0, sampler);
        setDesc.bindSampler(1, sampler);
        return this.app.createBindingSetForLayout(setDesc, this.bindingLayout);
    }

    releaseBindingSets(): void {
        const bindingSet = this.bindingSet;
        if (!bindingSet.isNull()) {
            this.app.releaseResource(bindingSet.handle);
            this.bindingSet = new BindingSet(null);
        }
        const prevBindingSet = this.prevBindingSet;
        if (!prevBindingSet.isNull()) {
            this.app.releaseResource(prevBindingSet.handle);
            this.prevBindingSet = new BindingSet(null);
        }
    }

    // RenderPass::Render: the resampling constants (the views, the settings, the context's frame index and
    // reservoir buffers, the light buffer parameters of the frame's light preparation: after
    // RtxdiDI.setFrameIndex and PrepareLightsPass.dispatch), then a thread per pixel of width x height.
    render(commandList: CommandList, di: RtxdiDI, view: ViewHandle, prevView: ViewHandle, s: RtxdiMinimalSettings,
        width: int, height: int): void {
        Rtxdi_WriteResamplingConstants(di.resources, di.context, commandList.handle, view, prevView,
            s.enableResampling ? 1 : 0, s.unbiasedMode ? 1 : 0, s.numLocalLightSamples, s.numBrdfSamples,
            s.brdfCutoff, s.numSpatialSamples);

        commandList.beginMarker("Render");
        const pipeline = this.pipeline;
        if (pipeline) {
            const groupsX: int = Math.floor((width + RTXDI_SCREEN_SPACE_GROUP_SIZE - 1) / RTXDI_SCREEN_SPACE_GROUP_SIZE);
            const groupsY: int = Math.floor((height + RTXDI_SCREEN_SPACE_GROUP_SIZE - 1) / RTXDI_SCREEN_SPACE_GROUP_SIZE);
            commandList.dispatchWithDescriptorTable(pipeline, this.bindingSet, this.descriptorTable, groupsX, groupsY, 1);
        }
        commandList.endMarker();
    }

    // NextFrame: the other binding set, after the frame (with RtxdiRenderTargets.swap()).
    nextFrame(): void {
        const bindingSet = this.bindingSet;
        this.bindingSet = this.prevBindingSet;
        this.prevBindingSet = bindingSet;
    }
}
