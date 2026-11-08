// RTXDI's ReSTIR DI (github.com/NVIDIA-RTX/RTXDI) on Donut, the parts its samples share: the ReSTIR DI
// context and resources with the light preparation (core/rtxdi.cpp, over RTXDI's runtime library), the G-buffer
// render targets of the current and the previous frame, and the PrepareLights pass, which turns the scene's
// emissive triangles into RTXDI's light buffer. Written from the Minimal Sample's RtxdiResources,
// RenderTargets and PrepareLightsPass; the shaders are the sample's, compiled in place from RTXDI_DIR
// (rtxdi_minimal_shaders in CMakeLists.txt).
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

// RTXDI's ReSTIR DI context for a render size and the resources sized for a scene (the sample's
// ReSTIRDIContext and RtxdiResources): the light buffers PrepareLightsPass fills, the neighbor offsets, the
// reservoirs and the resampling constant buffer. Made again on resize (dispose, then a new one), as the
// sample drops both in BackBufferResized. isNull() when the resources couldn't be made (logged).
export class RtxdiDI {
    readonly context: RtxdiDIContextHandle;
    readonly resources: RtxdiResourcesHandle;

    constructor(app: App, private scene: Scene, readonly width: int, readonly height: int) {
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

    constructor(app: App, readonly width: int, readonly height: int) {
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
