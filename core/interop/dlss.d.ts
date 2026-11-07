/// <reference path="../donut_handles.d.ts" />
// NVIDIA DLSS: super resolution, neural rendering, ray reconstruction

// NVIDIA DLSS (loads nvngx_dlss.dll from the executable's directory); null when built without
// DONUT_WITH_DLSS or the device can't create it.
@nodrops declare function Donut_CreateDlss(app: AppHandle): DlssHandle;
// For inputWidth x inputHeight images upscaled to outputWidth x outputHeight; autoExposure: DLSS measures the exposure
// (without an exposure buffer, as Donut_EvaluateDlssTextures; Streamline does so). Non-zero if ready.
@nodrops declare function Donut_InitDlss(dlss: DlssHandle, inputWidth: int, inputHeight: int, outputWidth: int, outputHeight: int, autoExposure: int): int;
@nodrops declare function Donut_IsDlssInitialized(dlss: DlssHandle): int;
// HDR color into resolved color (instead of TAA), with the tone mapping pass's exposure. Planar views only.
@nodrops declare function Donut_EvaluateDlss(commandList: CommandListHandle, dlss: DlssHandle, view: ViewHandle, sceneRenderTargets: SceneRenderTargetsHandle, toneMappingPass: ToneMappingPassHandle): void;
// Donut_EvaluateDlss over textures of an example's own, 1:1 (width x height): inputColor (HDR) into outputColor (a UAV texture of
// the same size), from depth (reverse-Z) and motionVectors (pixels, previous minus current), with this frame's jitter (the
// sub-pixel offset of the projection). reset: no history.
@nodrops declare function Donut_EvaluateDlssTextures(commandList: CommandListHandle, dlss: DlssHandle, depth: TextureHandle, motionVectors: TextureHandle, inputColor: TextureHandle, outputColor: TextureHandle,
    width: int, height: int, jitterX: number, jitterY: number, reset: int): void;
// DLSS 5, DLSS 3D-Guided Neural Rendering (loads nvngx_dlssnr.dll), over dlss's NGX instance; null
// unless built with DONUT_WITH_DLSS_NR, on Vulkan, where DLSS-NR is available.
@nodrops declare function Donut_CreateDlssNeuralRendering(app: AppHandle, dlss: DlssHandle): DlssNeuralRenderingHandle;
// For width x height images; non-zero if ready.
@nodrops declare function Donut_InitDlssNeuralRendering(dlssNeuralRendering: DlssNeuralRenderingHandle, width: int, height: int): int;
@nodrops declare function Donut_IsDlssNeuralRenderingInitialized(dlssNeuralRendering: DlssNeuralRenderingHandle): int;
// The targets' LdrColor in place (after tone mapping), from their depth and motion vectors (TAA and
// DLSS modes). model: 0..2 (A, B, C); strengths 0..1; reset: no history.
@nodrops declare function Donut_EvaluateDlssNeuralRendering(commandList: CommandListHandle, dlssNeuralRendering: DlssNeuralRenderingHandle, view: ViewHandle, sceneRenderTargets: SceneRenderTargetsHandle,
    intensity: number, toneStrength: number, structureStrength: number, model: int, useAutoMask: int, skinStructureStrength: number, reset: int): void;
// Donut_EvaluateDlssNeuralRendering over textures of an example's own: ldrColor (gamma-encoded RGBA8 / SRGBA8, in place), depth (float,
// reverse-Z if depthInverted), motionVectors (RG float, pixels, previous minus current), this frame's jitter.
@nodrops declare function Donut_EvaluateDlssNeuralRenderingTextures(commandList: CommandListHandle, dlssNeuralRendering: DlssNeuralRenderingHandle, ldrColor: TextureHandle, depth: TextureHandle,
    motionVectors: TextureHandle, jitterX: number, jitterY: number, depthInverted: int, intensity: number, toneStrength: number, structureStrength: number, model: int, useAutoMask: int,
    skinStructureStrength: number, reset: int): void;
// DLSS's render size for an outputWidth x outputHeight image at a quality (0 performance, 1 balanced, 2 quality, 3 ultra
// performance, 4 ultra quality, 5 DLAA), as NGX recommends it: width | height << 16, or 0 without DLSS.
@nodrops declare function Donut_GetDlssOptimalRenderSize(app: AppHandle, dlss: DlssHandle, outputWidth: int, outputHeight: int, quality: int): int;
// DLSS Ray Reconstruction (loads nvngx_dlssd.dll), over dlss's NGX instance; null unless built with DONUT_WITH_DLSS, on
// Vulkan or D3D12, where DLSS-RR is available.
@nodrops declare function Donut_CreateDlssRayReconstruction(app: AppHandle, dlss: DlssHandle): DlssRayReconstructionHandle;
// For renderWidth x renderHeight frames into outputWidth x outputHeight ones at a quality (as above), with a render preset
// (0 default, 4 D, 5 E, 6 F); non-zero if ready.
@nodrops declare function Donut_InitDlssRayReconstruction(dlssRayReconstruction: DlssRayReconstructionHandle, renderWidth: int, renderHeight: int,
    outputWidth: int, outputHeight: int, quality: int, preset: int): int;
@nodrops declare function Donut_IsDlssRayReconstructionInitialized(dlssRayReconstruction: DlssRayReconstructionHandle): int;
// Denoises, anti-aliases and upscales color (HDR, render size) into output (UAV, output size), guided by depth (reverse-Z),
// motionVectors (pixels, previous minus current), diffuse and specular albedo, normalRoughness (roughness in .w) and specular
// motion vectors, the view's worldToView and unjittered viewToClip matrices (16 floats, row-major) and the jitter. reset: no history.
@nodrops declare function Donut_EvaluateDlssRayReconstruction(commandList: CommandListHandle, dlssRayReconstruction: DlssRayReconstructionHandle,
    color: TextureHandle, output: TextureHandle, depth: TextureHandle, motionVectors: TextureHandle, diffuseAlbedo: TextureHandle,
    specularAlbedo: TextureHandle, normalRoughness: TextureHandle, specularMotionVectors: TextureHandle, worldToView: Ref<f32>, viewToClip: Ref<f32>,
    jitterX: number, jitterY: number, reset: int): void;
