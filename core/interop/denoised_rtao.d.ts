/// <reference path="../donut_handles.d.ts" />
// PBRT scenes and RTAO sample sets (core/denoised_rtao.cpp; the denoised_rtao example links it)

// Handles of the module's objects (see donut_handles.d.ts).
@cpp declare class PbrtSceneHandle { private readonly __pbrtScene: index; }

// Loads a PBRT scene (DirectX-Graphics-Samples' D3D12RaytracingRealTimeDenoisedAmbientOcclusion's
// subset: shapes in PLY files, named materials, image map textures, transforms) with that sample's
// parser: the meshes with vertices and indices, positions and normals transformed by their
// transform. Null (after printing why) on failure; free it with Donut_DestroyPbrtScene.
@nodrops declare function Donut_LoadPbrtScene(path: string): PbrtSceneHandle | null;
@nodrops declare function Donut_DestroyPbrtScene(pbrtScene: PbrtSceneHandle): void;
@nodrops declare function Donut_GetPbrtSceneMeshCount(pbrtScene: PbrtSceneHandle): int;
@nodrops declare function Donut_GetPbrtMeshVertexCount(pbrtScene: PbrtSceneHandle, mesh: int): int;
@nodrops declare function Donut_GetPbrtMeshIndexCount(pbrtScene: PbrtSceneHandle, mesh: int): int;
// Copies a mesh's vertices into dst (Ref of a `let` f32 array element): 11 floats each (position,
// normal, texture coordinates, tangent: the sample's VertexPositionNormalTextureTangent).
@nodrops declare function Donut_CopyPbrtMeshVertices(pbrtScene: PbrtSceneHandle, mesh: int, dst: Ref<f32>): void;
// Copies a mesh's 32-bit indices into dst (Ref of a `let` int array element).
@nodrops declare function Donut_CopyPbrtMeshIndices(pbrtScene: PbrtSceneHandle, mesh: int, dst: Ref<int>): void;
// Copies a mesh's material into dst (Ref of a `let` f32 array element): the sample's
// PrimitiveMaterialBuffer, 24 values (Kd, Ks, Kr, Kt, opacity, eta as float3s, roughness, then the
// int bits of hasDiffuseTexture, hasNormalTexture, hasPerVertexTangents, type, and padding).
@nodrops declare function Donut_CopyPbrtMeshMaterial(pbrtScene: PbrtSceneHandle, mesh: int, dst: Opaque): void;
// Non-zero if a mesh is opaque as the sample flags its geometry: unless see-through (opacity
// below 0.99) or a perfect mirror (AO rays skip those).
@nodrops declare function Donut_IsPbrtMeshOpaque(pbrtScene: PbrtSceneHandle, mesh: int): int;
// A mesh's diffuse / normal map texture file as the scene names it (its directory prepended), ""
// for none. Valid as long as the scene.
@nodrops declare function Donut_GetPbrtMeshDiffuseTexture(pbrtScene: PbrtSceneHandle, mesh: int): string;
@nodrops declare function Donut_GetPbrtMeshNormalTexture(pbrtScene: PbrtSceneHandle, mesh: int): string;
// Decodes an image file with WIC into 8-bit RGBA, as DirectXTK's WIC texture loader does (its JPEG
// decoder differs a little from Donut's): width x height x 4 bytes into dst (Ref of a `let` int
// array element; null for only the size). Returns width | height << 16, 0 on failure.
@nodrops declare function Donut_DecodeWicImageRGBA8(path: string, dst: Ref<int> | null): int;
// The sample's RTAO sample sets: numSampleSets sets of samplesPerSet multi-jittered samples on the
// cosine-weighted hemisphere (its Samplers::MultiJittered, seeded with 1729), in the order the
// sample fills its buffer with them: 4 floats each (x, y, z, 0) into dst (Ref of a `let` f32 array
// element).
@nodrops declare function Donut_GenerateRtaoHemisphereSamples(samplesPerSet: int, numSampleSets: int, dst: Ref<f32>): void;
