/// <reference path="../donut_handles.d.ts" />
// RTX Character Rendering (core/rtxcr.cpp; the rtxcr_pathtracer and rtxcr_raster examples link it)

// Handles of the module's objects (see donut_handles.d.ts).
@cpp declare class RtxcrSceneHandle { private readonly __rtxcrScene: index; }
@cpp declare class RtxcrNrdHandle { private readonly __rtxcrNrd: index; }

// Takes a scene loaded by Donut_LoadSceneWithDescriptorTableDeferred: tessellates its hair curves into
// polytubes, DOTS and LSS (hairRadiusScale scales their radii), makes tessellationType (0 polytubes,
// 1 DOTS, 2 LSS) the scene's and uploads its buffers. `device` is Donut_GetNvrhiDevice's.
@nodrops declare function Donut_RtxcrCreateScene(device: Opaque, loadedScene: SceneHandle, descriptorTables: DescriptorTableManagerHandle,
    hairRadiusScale: number, tessellationType: int): RtxcrSceneHandle;
@nodrops declare function Donut_RtxcrDestroyScene(rtxcrScene: RtxcrSceneHandle): void;
// Makes the hair type (0 polytubes, 1 DOTS, 2 LSS) and uploads the scene's buffers again; then make the
// morph targets and the acceleration structures again, and what binds the scene's buffers. 1 if it changed.
@nodrops declare function Donut_RtxcrSetTessellationType(rtxcrScene: RtxcrSceneHandle, type: int, frameIndex: int): int;
@nodrops declare function Donut_RtxcrGetCurveMeshCount(rtxcrScene: RtxcrSceneHandle): int;
// The scene's bottom level structures (all of them if rebuild, else the missing ones) and its top level
// one, recorded into an open command list.
@nodrops declare function Donut_RtxcrBuildAccelStructs(rtxcrScene: RtxcrSceneHandle, openCommandList: CommandListHandle, rebuild: boolean): void;
// Builds the top level structure over the scene's instances (mask 4 for mirrors, 2 for emissive
// surfaces unless showEmissiveSurfaces, else 1).
@nodrops declare function Donut_RtxcrBuildTlas(rtxcrScene: RtxcrSceneHandle, openCommandList: CommandListHandle, showEmissiveSurfaces: boolean): void;
// The morph target meshes' vertex buffers aren't in a permanent state: a command list that rasterizes them says
// they rest as at its start (Begin) and puts them back at its end (End).
@nodrops declare function Donut_RtxcrBeginMorphVertexBuffers(rtxcrScene: RtxcrSceneHandle, openCommandList: CommandListHandle): void;
@nodrops declare function Donut_RtxcrEndMorphVertexBuffers(rtxcrScene: RtxcrSceneHandle, openCommandList: CommandListHandle): void;
@nodrops declare function Donut_RtxcrGetTlas(rtxcrScene: RtxcrSceneHandle): AccelStructHandle;
// Makes the animated hair's keyframe, line segment and constant buffers (for the meshes with morph targets)
// and the per-instance mask of them; the number of such meshes.
@nodrops declare function Donut_RtxcrCreateMorphTargets(rtxcrScene: RtxcrSceneHandle): int;
// One uint per mesh instance, 1 where its mesh has morph targets (the shaders' instance meta data).
@nodrops declare function Donut_RtxcrGetMorphTargetMask(rtxcrScene: RtxcrSceneHandle): BufferHandle;
// The morph target pass's compute shader for the scene's tessellation.
@nodrops declare function Donut_RtxcrSetMorphTargetShader(rtxcrScene: RtxcrSceneHandle, shader: ShaderHandle): void;
// Restarts the morph target animation.
@nodrops declare function Donut_RtxcrResetMorphTargetAnimation(rtxcrScene: RtxcrSceneHandle): void;
// Blends the keyframes around the animation's time (animationTimestampPerFrame seconds apart; the last
// blends back to the first over animationSmoothingFactor of them) into the hair's vertex buffers and
// updates their bottom level structures, into an open command list. The frame's vertex buffer is the one the
// parity of frameIndex picks (the hit shaders read the global GlobalConstants' frameIndex % 2). With
// enableDebugOverride the keyframe and weight are the given ones. Returns the number of meshes animated.
@nodrops declare function Donut_RtxcrAnimateMorphTargets(rtxcrScene: RtxcrSceneHandle, openCommandList: CommandListHandle, frameIndex: int, elapsedSeconds: number,
    animationTimestampPerFrame: number, enableDebugOverride: boolean, overrideKeyFrameIndex: int, overrideKeyFrameWeight: number,
    animationSmoothingFactor: number): int;
// The sample's sky constants (GlobalConstants::skyParams, 96 bytes into dst) for a directional light.
// skyType: 0 constant, 1 procedural, 2 environment map.
@nodrops declare function Donut_RtxcrFillSkyParameters(rtxcrScene: RtxcrSceneHandle, sun: LightHandle, skyR: number, skyG: number, skyB: number, enableSky: boolean, skyType: int, dst: Opaque): void;

// Denoising with NRD (core/rtxcr.cpp, built with RTXCR_DIR): ReBLUR (mode 0) or ReLAX (mode 1) over the noisy
// diffuse and specular radiance for textures of width x height. `device` is Donut_GetNvrhiDevice's. A null
// handle if NRD or its shaders (bin/shaders/nrd) don't load.
@nodrops declare function Donut_RtxcrNrdCreate(device: Opaque, mode: int, width: int, height: int): RtxcrNrdHandle;
@nodrops declare function Donut_RtxcrNrdDestroy(rtxcrNrd: RtxcrNrdHandle): void;
// The denoiser's textures at a new size (its history is gone: pass reset to the next denoise). 0 if they can't be made.
@nodrops declare function Donut_RtxcrNrdResize(rtxcrNrd: RtxcrNrdHandle, width: int, height: int): int;
// Settings by key: 0 disocclusion threshold, 1 maximum accumulated frames, 2 anti-firefly (0 or 1), 3 validation
// overlay (0 or 1), 4 split screen (0 to 1: noisy on the left, denoised on the right).
@nodrops declare function Donut_RtxcrNrdSetSetting(rtxcrNrd: RtxcrNrdHandle, key: int, value: number): void;
// ReBLUR's hit distance parameter A (index 0), B (1) or C (2), which the shaders normalize the hit distance with.
@nodrops declare function Donut_RtxcrNrdGetHitDistanceParameter(rtxcrNrd: RtxcrNrdHandle, index: int): number;
// Denoises the packed noisy radiance into the two denoised textures with an open command list. The G-buffer is
// the sample's: motion in pixels (depth change in z), normal and roughness packed for NRD, linear view Z. view and
// previousView are this frame's and the one before's (planar, unjittered); the jitter is the pixel offset the rays
// were traced with. reset starts the history over (first frame, camera cut, resize, a changed scene).
@nodrops declare function Donut_RtxcrNrdDenoise(rtxcrNrd: RtxcrNrdHandle, openCommandList: CommandListHandle, motion: TextureHandle,
    normalRoughness: TextureHandle, viewZ: TextureHandle, noisyDiffuse: TextureHandle, noisySpecular: TextureHandle,
    denoisedDiffuse: TextureHandle, denoisedSpecular: TextureHandle, validation: TextureHandle, view: ViewHandle,
    previousView: ViewHandle, jitterX: number, jitterY: number, previousJitterX: number, previousJitterY: number,
    frameIndex: int, reset: boolean): void;
