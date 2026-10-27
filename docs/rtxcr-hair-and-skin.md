# Hair and skin with RTXCR

How to render hair and skin in an example of this repository with NVIDIA's
[RTX Character Rendering](https://github.com/NVIDIA-RTX/RTXCR) (RTXCR) SDK, as
`rtxcr_pathtracer` and `rtxcr_raster` do.

## License first

RTXCR, its libraries, its NRD copy and its assets are under the NVIDIA RTX SDKs License, which
doesn't allow open-source-licensed use. This repository is public, so **nothing of RTXCR is copied
into it**:

- CMake takes a checkout through `-DRTXCR_DIR=<path>` (submodules and assets pulled). Without it,
  nothing below is built.
- C++ that includes RTXCR headers lives in [core/rtxcr.cpp](../core/rtxcr.cpp), which carries
  NVIDIA's notice and gets the checkout's include paths from CMake.
- Shaders include RTXCR's `.hlsli` files from the checkout (include directories in CMakeLists.txt);
  the sample's own shaders compile in place (`--sourceDir`, listed by
  [shaders/rtxcr_pathtracer.cfg](../shaders/rtxcr_pathtracer.cfg)).
- Scenes and textures are loaded from `RTXCR_DIR/assets` with `--scene <path>`.

New code that uses RTXCR follows the same rules.

## What RTXCR provides

| Library | Part | Hair | Skin |
| --- | --- | --- | --- |
| `libraries/rtxcr/geometry` | `CurveTessellation.h` (C++) | strands to polytubes, DOTS or linear swept spheres | — |
| | `geometry.hlsli` | curve hit attributes | — |
| `libraries/rtxcr/material` | `HairChiangBSDF.hlsli` | near-field BSDF (sample + eval), for path tracing | — |
| | `HairFarFieldBCSDF.hlsli` | far-field BCSDF, eval only: works in raster | — |
| | `HairMaterial.hlsli` | material data, absorption models | — |
| | `SubsurfaceMaterial.hlsli`, `SubsurfaceScattering.hlsli` | — | ray-traced subsurface scattering (Burley diffusion profile, BSSRDF, single-scattering transmission) |

The hair half works in both a path tracer and a rasterizer. The skin half is **ray-traced**:
its samples are placed on the surface by tracing rays, so in a rasterizer only the profile math
is reusable (see [Skin in a rasterizer](#skin-in-a-rasterizer)).

## 1. Content: material extensions and curve meshes

Donut's glTF importer reads two NVIDIA material extensions
([GltfImporter.cpp](../external/Donut/src/engine/GltfImporter.cpp), comments above
`cgltf_parse_json_subsurface` and `cgltf_parse_json_hair` describe every field):

```json
"extensions": {
  "NV_materials_hair": {
    "melanin": 0.6, "melaninRedness": 0.0,
    "longitudinalRoughness": 0.354, "azimuthalRoughness": 0.6,
    "ior": 1.55, "cuticleAngle": 3.0,
    "diffuseReflectionWeight": 0.0
  },
  "NV_materials_subsurface": {
    "transmissionColor": [1.0, 1.0, 1.0],
    "scatteringColor": [0.856, 0.34, 0.3],
    "scale": 20.0, "anisotropy": -0.5
  }
}
```

They end up as:

- CPU: `Material::enableHair` / `Material::hair` and `Material::enableSubsurfaceScattering` /
  `Material::subsurface` ([SceneTypes.h](../external/Donut/include/donut/engine/SceneTypes.h)).
- GPU: `MaterialFlags_Hair` / `MaterialFlags_SubsurfaceScattering` and the `hair*` fields of
  `MaterialConstants` ([material_cb.h](../external/Donut/include/donut/shaders/material_cb.h)),
  available in shaders as `MaterialSample::hairParams`.

Hair geometry must be glTF `lines` or `line_strip` primitives (one strip per strand). Donut loads
them as `MeshType::CurvePolytubes`; they render nothing until tessellated (next section).

## 2. Hair

### Geometry: `RtxcrScene`

[core/rtxcr_scene.ts](../core/rtxcr_scene.ts) wraps the `Donut_Rtxcr*` functions of
[core/rtxcr.cpp](../core/rtxcr.cpp). After the scene is loaded and its buffers created:

```ts
import { RtxcrScene } from "../core/rtxcr_scene";

this.rtxcrScene = RtxcrScene.create(device, scene.handle, descriptorTableManager.handle,
                                    hairRadiusScale, tessellationType); // 0 polytubes, 1 DOTS, 2 LSS
```

This splits the curve meshes into line segments and replaces their geometry with the tessellated
triangles in place, so Donut's passes (forward, G-buffer, shadow depth) draw the hair as ordinary
meshes. Then:

| Need | Call |
| --- | --- |
| Switch tessellation at run time | `setTessellationType(type, frameIndex)` — in the animate callback, not inside render (two immediate command lists can't be open) |
| Ray tracing | `buildAccelStructs(cmd, rebuild)`, `buildTlas(cmd, showEmissive)`, `getTlas()` |
| Morph-target hair animation | `createMorphTargets()`, `setMorphTargetShader(...)` (the sample's `morphTargetAnimation.cs.hlsl` with `RTXCR_CURVE_TESSELLATION_TYPE`), per frame `animateMorphTargets(cmd, ...)`, then `beginMorphVertexBuffers(cmd)` before the draws and `endMorphVertexBuffers(cmd)` after them |
| Teardown | `destroy()` |

The animated hair alternates between two vertex buffers: frame N's morph target pass writes buffer
`N & 1` while the GPU may still draw the previous frame from the other. What follows from that:

- Pass the same frame counter to `animateMorphTargets` every frame; it switches the mesh's
  `BufferGroup::vertexBuffer`.
- Anything that cached a binding set over the old buffer must rebuild it. Donut's forward and depth
  passes now do so (`patches/Donut-input-binding-set-vertex-buffer-change.patch`).
- Shadow maps must be re-rendered every animated frame. The hair's bounds already cover all
  keyframes, because the glTF loader includes the morph target positions in them.
- Without ray tracing there is no BLAS: `animateMorphTargets` updates one only where
  `buildAccelStructs` made it.
- Donut's motion vectors come from the camera only, so TAA and DLSS see the strands as static.

`rtxcr_raster -enableAnimation 1 --scene <RTXCR_DIR>/assets/claire.animation.scene.json` runs all of
this in a rasterizer.

Choosing the tessellation:

- **Polytubes** (0): real tubes; the right choice for raster.
- **DOTS** (1): camera-facing strips; cheaper but go edge-on in raster (thin temples, missing
  ponytail). It is what the sample's Vulkan path tracer uses.
- **Linear swept spheres** (2): no triangles, intersected by the hardware; D3D12 only, through NVAPI
  (with `RTXCR_DIR` the build switches NVRHI to the checkout's NVAPI).

### Shading in a rasterizer: far-field BCSDF

Include `<rtxcr/HairFarFieldBCSDF.hlsli>` and branch on `MaterialFlags_Hair`.
`EvalHair` in [shaders/rtxcr_raster_ps.hlsl](../shaders/rtxcr_raster_ps.hlsl) is a complete
version; its shape:

1. Fill `RTXCR_HairMaterialData` from `MaterialSample::hairParams` (base color, roughnesses, ior,
   `eta = 1/ior`, melanin, redness, cuticle angle, absorption model and Fresnel approximation).
2. Build a frame from the strand tangent and the shading normal, and transform the view and light
   directions into it (the BCSDF works with tangent = x, normal = z).
3. `RTXCR_CreateHairMaterialInteractionBcsdf(...)`, then per light
   `RTXCR_HairFarFieldBcsdfEval(surface, interaction, lightDir, viewDir, specular, diffuse, pdf)`.
   The result includes the cosine: multiply by the light's radiance and shadow.

The tangent comes from Donut's vertex data; no extra attributes are needed.

What made raster hair look right (all in `rtxcr_raster`):

- **Shadow every light** that reaches the hair. An unshadowed rim light lights every strand and
  the hair turns grey. `rtxcr_raster` puts all lights in one sliced shadow map, with a per-object
  slice fitted to the hair.
- **Light through hair**: attenuate by the depth past the first occluder in the hair's slice
  (`LightThroughHair`, TressFX style), instead of a binary shadow.
- **Anti-aliasing**: strands are sub-pixel, so use MSAA (`-msaa`, 8 by default) or temporal
  anti-aliasing (`-taa`, `-dlss`).
- **Ambient**: the forward pass's light probes don't apply to hair; `HairAmbient` evaluates the
  BCSDF against the sky from six directions instead.

### Shading in a path tracer

Use `HairChiangBSDF.hlsli` (importance sampling + evaluation) on curve hits. The sample's
`samples/pathtracer/shaders` do this and `rtxcr_pathtracer` runs them unchanged; a new path tracer
can follow `PathtracingPass.rgs.hlsl` there. RTXCR's `docs/RtxcrHairGuide.md` covers the model.

## 3. Skin

### Skin in a path tracer

Follow `docs/RtxcrSssGuide.md` in the checkout. Per hit on a `MaterialFlags_SubsurfaceScattering`
surface:

1. `RTXCR_SubsurfaceMaterialData` from `Material::subsurface` (transmission color, scattering
   color, scale, anisotropy `g`) and `RTXCR_CreateSubsurfaceInteraction(...)` at the hit.
2. `RTXCR_EvalBurleyDiffusionProfile(...)` gives a sample position on a disk around the hit and its
   profile weight.
3. Trace a ray to project that position onto the surface; light the hit there.
4. `radiance += RTXCR_EvalBssrdf(sample, lightRadiance, cosThetaI)`.
5. Optional transmission (thin parts: ears, nostrils): `RTXCR_CalculateRefractionRay`,
   `RTXCR_SampleDistance`, `RTXCR_SampleDirectionHG`, trace, `RTXCR_EvaluateSingleScattering`.

The sample's `subsurface.hlsli` / `subsurfaceMaterial.hlsli` implement this, and
`rtxcr_pathtracer` exposes its settings (the `G_ENABLE_SSS*` and `G_SSS_*` constants in
[examples/rtxcr_pathtracer.ts](../examples/rtxcr_pathtracer.ts)).

### Skin in a rasterizer

Steps 3 and 5 trace rays, and the guide's screen-space alternative replaces only the ray of step 3:
the irradiance and normal at the sample still have to come from somewhere. So there is no drop-in
raster path; `rtxcr_raster` shades skin with Donut's forward shader. The workable route is
screen-space subsurface scattering:

1. Write the diffuse lighting of skin pixels (separately from specular) to its own target, plus a
   skin mask from `MaterialFlags_SubsurfaceScattering`.
2. Blur it in screen space with a kernel built from `RTXCR_EvalBurleyDiffusionProfile` /
   `RTXCR_EvalBssrdf` (no rays involved), its radius scaled by view depth and
   `subsurface.scale`, and weighted by depth differences so it doesn't leak across edges.
3. Add the specular back.

This is not implemented yet; it would approximate the path tracer's look, not reproduce it.

## Examples to start from

| Example | Hair | Skin |
| --- | --- | --- |
| [rtxcr_pathtracer](../examples/rtxcr_pathtracer.ts) | Chiang BSDF; polytubes, DOTS, LSS; animation | ray-traced SSS + transmission |
| [rtxcr_raster](../examples/rtxcr_raster.ts) | far-field BCSDF; polytubes or DOTS; animation; sliced shadows, MSAA/TAA/DLSS | Donut forward shading (no SSS) |

Build and run (README, "rtxcr_pathtracer" section):

```bat
cmake --preset default -DRTXCR_DIR=E:/RTXCR
build/bin/rtxcr_raster.exe --scene E:/RTXCR/assets/claire.scene.json
build/bin/rtxcr_pathtracer.exe --scene E:/RTXCR/assets/claire.animation.scene.json -enableAnimation 1
```
