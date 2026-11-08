/// <reference path="../donut_handles.d.ts" />
// RTXDI (core/rtxdi.cpp; the RTXDI examples link it): what doesn't depend on a sample's shaders. The Minimal
// Sample's resources, light preparation and constants are core/interop/rtxdi_minimal.d.ts'.

// Handles of the module's objects (see donut_handles.d.ts).
@cpp declare class RtxdiDIContextHandle { private readonly __rtxdiDIContext: index; }
@cpp declare class RtxdiSceneAccelStructsHandle { private readonly __rtxdiSceneAccelStructs: index; }

// RTXDI's runtime library (RTXDI_DIR's, rtxdi_runtime in CMakeLists.txt) over Donut's scene and NVRHI: the
// ReSTIR DI context, the scene's acceleration structures and a float dump of a render target. Free the
// context and the acceleration structures with the Destroy functions before the app.

// A ReSTIR DI context (rtxdi::ReSTIRDIContext) for width x height frames; every other static parameter is
// the library's default (8192 neighbor offsets, no checkerboard). Resize: destroy it and the resources, create
// them again.
@nodrops declare function Rtxdi_CreateDIContext(width: int, height: int): RtxdiDIContextHandle;
@nodrops declare function Rtxdi_DestroyDIContext(context: RtxdiDIContextHandle): void;
// The frame the context's runtime parameters (the random seed, which reservoir buffer is read and which
// written) are for: before the frame's Rtxdi_WriteResamplingConstants. Logs and does nothing without a context.
@nodrops declare function Rtxdi_SetFrameIndex(context: RtxdiDIContextHandle, frameIndex: int): void;
// Writes the context's neighbor offsets (RTXDI's FillNeighborOffsetBuffer: two signed normalized bytes each,
// for an RG8_SNORM typed buffer) into buffer on the command list. Once is enough: they don't change. Logs and
// writes nothing without a context, command list or buffer, or for a buffer too small.
@nodrops declare function Rtxdi_InitializeNeighborOffsets(context: RtxdiDIContextHandle, commandList: CommandListHandle,
    buffer: BufferHandle): void;

// The scene's acceleration structures, recorded into an open command list: a BLAS per mesh but the skinned ones
// (vertex joint weights; each geometry opaque only for an opaque material; PreferFastTrace, AllowCompaction
// without a skin) and the TLAS over the instances that have one (AllowUpdate; the instance mask the OR of
// opaqueMask, alphaTestedMask and transparentMask for the content the instance has, triangle culling off with
// a double-sided material, the instance index as the ID). Donut_BuildSceneAccelStructs makes every geometry
// opaque, every mask 1 and no IDs. Every acceleration structure is created before a build is recorded: null
// (after logging why) leaves the command list as it was (close it without executing it). Null too without
// a command list or scene.
@nodrops declare function Rtxdi_BuildSceneAccelStructs(app: AppHandle, commandList: CommandListHandle, scene: SceneHandle,
    opaqueMask: int, alphaTestedMask: int, transparentMask: int): RtxdiSceneAccelStructsHandle | null;
// After the GPU is idle (App.waitForIdle): the BLASes don't track liveness, so command lists don't keep them
// alive.
@nodrops declare function Rtxdi_DestroySceneAccelStructs(accelStructs: RtxdiSceneAccelStructsHandle): void;
// For Donut_BindAccelStruct; valid as long as the acceleration structures.
@nodrops declare function Rtxdi_GetTopLevelAS(accelStructs: RtxdiSceneAccelStructsHandle): AccelStructHandle;

// Writes an RGBA16_FLOAT (or RGBA32_FLOAT) texture to a file, for comparing frames: width and height (int32),
// then width x height RGBA float32 pixels, little-endian, top row first (Donut_ReadTextureLevel's wait for
// the GPU: call it while no other immediate command list is open). Non-zero on success; logs why not.
@nodrops declare function Rtxdi_SaveTextureRGBA32F(app: AppHandle, texture: TextureHandle, path: string): int;
