/// <reference path="../donut_handles.d.ts" />
// OBJ models (core/obj_model.cpp)

// Handles of the module's objects (see donut_handles.d.ts).
@cpp declare class ObjModelHandle { private readonly __objModel: index; }

// Wavefront OBJ models (core/obj_model.cpp, linked only into the examples that list it):
// DirectX-Graphics-Samples' D3D12RaytracingSakuraForestSER loader (ObjModelLoader), objects by their
// `o` names, then an object's triangles as three vertices each. Free it with Donut_DestroyObjModel.
@nodrops declare function Donut_CreateObjModel(): ObjModelHandle;
@nodrops declare function Donut_DestroyObjModel(objModel: ObjModelHandle): void;
// Parses an OBJ file's text (byteSize bytes from data, e.g. a binary file's) into the loader.
@nodrops declare function Donut_ParseObjModel(objModel: ObjModelHandle, data: Ref<u8>, byteSize: int): void;
// Makes the mesh of an object, its positions multiplied by scale: three vertices per triangle,
// indices 0, 1, 2, ... Returns its vertex count, -1 if the object is missing or broken.
@nodrops declare function Donut_BuildObjModelMesh(objModel: ObjModelHandle, name: string, scale: number): int;
@nodrops declare function Donut_GetObjModelMeshIndexCount(objModel: ObjModelHandle): int;
// The mesh's vertices into dst (Ref of an f32 array element): 9 floats each, position, normal and
// uv as float3s (36 bytes); its 32-bit indices (Ref of an int array element).
@nodrops declare function Donut_CopyObjModelMeshVertices(objModel: ObjModelHandle, dst: Ref<f32>): void;
@nodrops declare function Donut_CopyObjModelMeshIndices(objModel: ObjModelHandle, dst: Ref<int>): void;
