/// <reference path="../donut_handles.d.ts" />
/// <reference path="app.d.ts" />
// Donut's scene: loading, the scene graph, nodes, meshes, lights, materials, cameras and views

// Vertex attributes of Donut_BindGeometryVertexAttribute, with their Buffer<...> element types.
enum GeometryAttribute {
    Position = 0,  // float3
    TexCoord1 = 1, // float2
    Normal = 2,    // float4 (RGBA8_SNORM)
    Tangent = 3    // float4 (RGBA8_SNORM)
}

// Material textures of Donut_BindGeometryMaterialTexture, and what to bind if there's none.
enum MaterialTexture {
    BaseOrDiffuse = 0,
    MetalRoughOrSpecular = 1,
    Normal = 2,
    Emissive = 3,
    Occlusion = 4,
    Transmission = 5,
    Opacity = 6
}

enum FallbackTexture {
    White = 0,
    Black = 1
}

// Buffers of Donut_GetSceneBuffer.
enum SceneBuffer {
    Instances = 0,
    Geometries = 1,
    Materials = 2
}

// Functions taking a `view` accept a planar view (Donut_CreatePlanarView) or a stereo one
// (Donut_CreateStereoView) alike. They record into `commandList`: the frame's
// (Donut_GetFrameCommandList) or one opened with Donut_OpenCommandList. Framebuffer handles are
// valid as long as the object they came from.

// Values returned by Donut_UpdateSceneLoader.
enum SceneLoaderState {
    // No scene to render yet: draw a splash screen.
    Loading = 0,
    // The scene has just finished loading, this frame.
    Loaded = 1,
    Ready = 2
}

// LightType_* values (light_types.h).
enum LightType {
    Directional = 1,
    Spot = 2,
    Point = 3
}

// glTF or .scene.json, path relative to the executable's directory or absolute; loaded on the
// app's thread pool, textures uploaded. Null (after logging why) on failure.
@nodrops declare function Donut_LoadScene(app: AppHandle, path: string): SceneHandle;

// Donut's first person camera: WASD / arrows move, dragging with the left button looks around.
@nodrops declare function Donut_CreateFirstPersonCamera(app: AppHandle): CameraHandle;
// First person cameras only.
@nodrops declare function Donut_CameraLookAt(camera: CameraHandle, posX: number, posY: number, posZ: number, targetX: number, targetY: number, targetZ: number): void;
// Donut's third person (orbit) camera: dragging with the left button orbits the target, the wheel
// zooms, WASD / arrows move the target. The Donut_Camera* functions below work for both kinds.
@nodrops declare function Donut_CreateThirdPersonCamera(app: AppHandle): CameraHandle;
@nodrops declare function Donut_ThirdPersonCameraSetTarget(camera: CameraHandle, x: number, y: number, z: number): void;
@nodrops declare function Donut_ThirdPersonCameraSetDistance(camera: CameraHandle, distance: number): void;
// Radians.
@nodrops declare function Donut_ThirdPersonCameraSetRotation(camera: CameraHandle, yaw: number, pitch: number): void;
// Radians: the orbit angles as the user's dragging left them.
@nodrops declare function Donut_ThirdPersonCameraGetYaw(camera: CameraHandle): number;
@nodrops declare function Donut_ThirdPersonCameraGetPitch(camera: CameraHandle): number;
// Orbits the target from the position.
@nodrops declare function Donut_ThirdPersonCameraLookAt(camera: CameraHandle, posX: number, posY: number, posZ: number, targetX: number, targetY: number, targetZ: number): void;
// Every frame, after Donut_SetPlanarView of the view it renders.
@nodrops declare function Donut_ThirdPersonCameraSetView(camera: CameraHandle, view: ViewHandle): void;
// Forward / up directions: 3 floats into dst (Ref of a `let` f32 array element).
@nodrops declare function Donut_GetCameraDirection(camera: CameraHandle, dst: Ref<f32>): void;
@nodrops declare function Donut_GetCameraUp(camera: CameraHandle, dst: Ref<f32>): void;
// Units per second.
@nodrops declare function Donut_CameraSetMoveSpeed(camera: CameraHandle, speed: number): void;
// Mouse sensitivity, radians per pixel.
@nodrops declare function Donut_CameraSetRotateSpeed(camera: CameraHandle, speed: number): void;
// Forward the pass input callbacks' arguments to these.
@nodrops declare function Donut_CameraKeyboardUpdate(camera: CameraHandle, key: Key, scancode: ScanCode, action: Action, mods: KeyMods): void;
@nodrops declare function Donut_CameraMousePosUpdate(camera: CameraHandle, x: number, y: number): void;
@nodrops declare function Donut_CameraMouseButtonUpdate(camera: CameraHandle, button: MouseButton, action: Action, mods: KeyMods): void;
@nodrops declare function Donut_CameraMouseScrollUpdate(camera: CameraHandle, xOffset: number, yOffset: number): void;
@nodrops declare function Donut_CameraAnimate(camera: CameraHandle, elapsedSeconds: number): void;
// World-to-view matrix into dst: Ref(arr[0]) of a `let` f32[16] array, row-major, row-vector
// convention (as Donut_SetPlanarView takes it).
@nodrops declare function Donut_GetCameraWorldToView(camera: CameraHandle, dst: Ref<f32>): void;

// Loaded scenes. Both valid as long as the scene.
@nodrops declare function Donut_GetSceneGraph(scene: SceneHandle): SceneGraphHandle;
@nodrops declare function Donut_GetRootNode(sceneGraph: SceneGraphHandle): NodeHandle;
// Like Donut_LoadScene, registering the scene's buffers and textures in a descriptor table; the
// scene's geometry and material buffers index into it.
@nodrops declare function Donut_LoadSceneWithDescriptorTable(app: AppHandle, path: string, descriptorTableManager: DescriptorTableManagerHandle): SceneHandle;
// Same, leaving the scene's meshes in CPU memory, unuploaded, for core/rtxcr.cpp's Donut_RtxcrCreateScene to edit.
@nodrops declare function Donut_LoadSceneWithDescriptorTableDeferred(app: AppHandle, path: string, descriptorTableManager: DescriptorTableManagerHandle): SceneHandle;
// InstanceData / GeometryData / MaterialConstants structured buffers; valid as long as the scene.
@nodrops declare function Donut_GetSceneBuffer(scene: SceneHandle, which: SceneBuffer): BufferHandle;
// Geometries of a loaded scene, addressed by global geometry index (0 .. count - 1).
@nodrops declare function Donut_GetSceneGeometryCount(scene: SceneHandle): int;
// Per-geometry bindings, e.g. for local binding sets: Buffer<uint> of the geometry's indices;
// Buffer<...> of one vertex attribute; a material texture (or Donut's white / black texture if the
// material has none); the MaterialConstants cbuffer.
@nodrops declare function Donut_BindGeometryIndexBuffer(bindingSetDesc: BindingSetDescHandle, slot: int, scene: SceneHandle, geometryIndex: int): void;
@nodrops declare function Donut_BindGeometryVertexAttribute(bindingSetDesc: BindingSetDescHandle, slot: int, scene: SceneHandle, geometryIndex: int,
    attribute: GeometryAttribute): void;
@nodrops declare function Donut_BindGeometryMaterialTexture(app: AppHandle, bindingSetDesc: BindingSetDescHandle, slot: int, scene: SceneHandle, geometryIndex: int,
    which: MaterialTexture, fallback: FallbackTexture): void;
@nodrops declare function Donut_BindGeometryMaterialConstants(bindingSetDesc: BindingSetDescHandle, slot: int, scene: SceneHandle, geometryIndex: int): void;
// Animations, e.g. glTF skeletal ones. Durations in seconds; apply poses the nodes at `time`.
@nodrops declare function Donut_GetSceneAnimationCount(scene: SceneHandle): int;
@nodrops declare function Donut_GetSceneAnimationDuration(scene: SceneHandle, index: int): number;
@nodrops declare function Donut_ApplySceneAnimation(scene: SceneHandle, index: int, time: number): void;
// Valid only inside a render callback. Updates the scene graph and GPU buffers (transforms,
// skinning) after animations.
@nodrops declare function Donut_RefreshScene(app: AppHandle, frame: FrameHandle, scene: SceneHandle): void;

// A texture file (relative to the executable's directory) loaded and uploaded (mipmaps generated
// if it has none), registered in a descriptor table for bindless access. It submits its own
// command list: call it while no other one is open. Null (after logging why) on failure.
@nodrops declare function Donut_LoadBindlessTexture(app: AppHandle, descriptorTableManager: DescriptorTableManagerHandle, path: string, sRGB: int): LoadedTextureHandle;
// Its index in the descriptor table (the shaders' array index).
@nodrops declare function Donut_GetTextureDescriptorIndex(loadedTexture: LoadedTextureHandle): int;
// The texture itself; valid as long as the loaded texture.
@nodrops declare function Donut_GetLoadedTextureTexture(loadedTexture: LoadedTextureHandle): TextureHandle;
@nodrops declare function Donut_GetSceneInstanceCount(scene: SceneHandle): int;
// A node's world-space position into dst (3 floats); 0 if there's no node at path ("/Emitter").
@nodrops declare function Donut_GetSceneNodePosition(scene: SceneHandle, path: string, dst: Ref<f32>): int;

// Dynamic meshes: one alpha-blended geometry whose vertices (positions, texture coordinates) and
// indices are replaced every frame, with room for maxVertices / maxIndices, buffers registered in
// a descriptor table. Attach to a loaded scene before creating binding sets of its buffers.
@nodrops declare function Donut_CreateDynamicMesh(app: AppHandle, descriptorTableManager: DescriptorTableManagerHandle, maxVertices: int, maxIndices: int, name: string): DynamicMeshHandle;
@nodrops declare function Donut_AttachDynamicMesh(app: AppHandle, scene: SceneHandle, dynamicMesh: DynamicMeshHandle): void;
// A Donut_LoadBindlessTexture texture; the scene picks it up at the next Donut_RefreshScene.
@nodrops declare function Donut_SetDynamicMeshTexture(app: AppHandle, dynamicMesh: DynamicMeshHandle, loadedTexture: LoadedTextureHandle): void;
// Valid only inside a render callback: positions (3 x f32 per vertex), texCoords (2 x f32), int
// indices, as Ref of `let` array elements; rebuilds the mesh's BLAS.
@nodrops declare function Donut_UpdateDynamicMesh(frame: FrameHandle, dynamicMesh: DynamicMeshHandle, positions: Ref<f32>, texCoords: Ref<f32>, vertexCount: int,
    indices: Ref<int>, indexCount: int): void;

// Scenes built in code. Material with a diffuse texture (relative to the executable's directory,
// sRGB), uploads recorded into an open command list; specularGloss != 0 selects the
// specular-glossiness model. Null (after logging why) if the texture can't be loaded.
@nodrops declare function Donut_CreateTexturedMaterial(app: AppHandle, commandList: CommandListHandle, name: string, diffuseTexturePath: string, specularGloss: int): MaterialHandle;
// One geometry, identity instance transform, uploads recorded into an open command list. Per
// vertex: position (3 x f32), texture coordinates (2 x f32), normal and tangent (int each,
// packed as by vectorToSnorm8); then indexCount int indices. Arrays: Ref(arr[0]) of `let` arrays.
@nodrops declare function Donut_CreateMesh(app: AppHandle, commandList: CommandListHandle, name: string, material: MaterialHandle,
    positions: Ref<f32>, texCoords: Ref<f32>, normals: Ref<int>, tangents: Ref<int>, vertexCount: int,
    indices: Ref<int>, indexCount: int): MeshHandle;
@nodrops declare function Donut_CreateSceneGraph(app: AppHandle): SceneGraphHandle;
// Adds a node holding an instance of mesh under parentNode, or as the root if parentNode is
// null. Returns the node, valid as long as the scene graph.
@nodrops declare function Donut_AddMeshNode(app: AppHandle, sceneGraph: SceneGraphHandle, parentNode: NodeHandle | null, mesh: MeshHandle, name: string): NodeHandle;
// Directional light in a new node under parentNode, shining along dir; angularSize in degrees.
// Returns the light, valid as long as the scene graph; refresh the graph before using it.
@nodrops declare function Donut_AddDirectionalLight(sceneGraph: SceneGraphHandle, parentNode: NodeHandle, name: string,
    dirX: number, dirY: number, dirZ: number, angularSize: number, irradiance: number): LightHandle;
// For constant buffers that embed a LightConstants (donut/shaders/light_cb.h): its size in
// bytes (a multiple of 16), and a light's constants written to dst (Ref of a `let` array element).
@nodrops declare function Donut_GetLightConstantsSize(): int;
@nodrops declare function Donut_FillLightConstants(light: LightHandle, dst: Opaque): void;
// After adding or changing nodes.
@nodrops declare function Donut_RefreshSceneGraph(app: AppHandle, sceneGraph: SceneGraphHandle): void;
@nodrops declare function Donut_PrintSceneGraph(sceneGraph: SceneGraphHandle): void;
@nodrops declare function Donut_CreatePlanarView(app: AppHandle): ViewHandle;
// Matrices: Ref(arr[0]) of `let` f32[16] arrays, row-major, row-vector convention (as the math
// functions in the examples build them); viewport of width x height pixels.
@nodrops declare function Donut_SetPlanarView(view: ViewHandle, viewMatrix: Ref<f32>, projMatrix: Ref<f32>, width: int, height: int): void;
// For constant buffers that embed a PlanarViewConstants (donut/shaders/view_cb.h): its size in
// bytes (a multiple of 16), and the view's constants written to dst (Ref of a `let` array element).
@nodrops declare function Donut_GetPlanarViewConstantsSize(): int;
@nodrops declare function Donut_FillPlanarViewConstants(view: ViewHandle, dst: Opaque): void;
// Viewport, matrices and derived state, e.g. to keep the previous frame's view.
@nodrops declare function Donut_CopyPlanarView(dstView: ViewHandle, srcView: ViewHandle): void;

// Scene loading on a thread, as donut::app::ApplicationBase does it asynchronously.
@nodrops declare function Donut_CreateSceneLoader(app: AppHandle): SceneLoaderHandle;
// Non-zero once a scene has loaded, until the next Donut_BeginLoadingScene: unload what
// references it (the passes' binding caches) before starting another load.
@nodrops declare function Donut_IsSceneLoaded(sceneLoader: SceneLoaderHandle): int;
// Non-zero while the loading thread runs.
@nodrops declare function Donut_IsSceneLoading(sceneLoader: SceneLoaderHandle): int;
// Starts loading a scene (absolute path, or relative to the executable's directory), dropping
// the current one: its handle is invalid afterwards.
@nodrops declare function Donut_BeginLoadingScene(sceneLoader: SceneLoaderHandle, path: string): void;
// In a render callback, every frame, first thing: uploads loaded textures and finishes the scene.
// Submits what the frame has recorded so far.
@nodrops declare function Donut_UpdateSceneLoader(sceneLoader: SceneLoaderHandle, frame: FrameHandle): SceneLoaderState;
// The loaded scene, or null; valid until the next Donut_BeginLoadingScene.
@nodrops declare function Donut_GetLoadedScene(sceneLoader: SceneLoaderHandle): SceneHandle;
// 4 ints into dst: objects loaded, objects total, textures loaded, textures requested.
@nodrops declare function Donut_GetSceneLoadingStats(sceneLoader: SceneLoaderHandle, dst: Ref<int>): void;
// The scene files (glTF, .scene.json) under a directory, recursively, as a string list.
@nodrops declare function Donut_FindScenes(app: AppHandle, directory: string): StringListHandle;
@nodrops declare function Donut_GetStringListCount(stringList: StringListHandle): int;
@nodrops declare function Donut_GetStringListItem(stringList: StringListHandle, index: int): string;

// Scene graph queries; the handles are valid as long as the scene.
@nodrops declare function Donut_GetSceneGraphLightCount(sceneGraph: SceneGraphHandle): int;
@nodrops declare function Donut_GetSceneGraphLight(sceneGraph: SceneGraphHandle, index: int): LightHandle;
@nodrops declare function Donut_GetLightType(light: LightHandle): LightType;
@nodrops declare function Donut_GetLightName(light: LightHandle): string;
// Directional lights only.
@nodrops declare function Donut_GetDirectionalLightIrradiance(light: LightHandle): number;
@nodrops declare function Donut_SetDirectionalLightIrradiance(light: LightHandle, irradiance: number): void;
@nodrops declare function Donut_GetSceneGraphCameraCount(sceneGraph: SceneGraphHandle): int;
@nodrops declare function Donut_GetSceneGraphCamera(sceneGraph: SceneGraphHandle, index: int): SceneCameraHandle;
@nodrops declare function Donut_GetSceneCameraName(sceneCamera: SceneCameraHandle): string;
// 16 floats into dst (row-major, row-vector convention).
@nodrops declare function Donut_GetSceneCameraWorldToView(sceneCamera: SceneCameraHandle, dst: Ref<f32>): void;
@nodrops declare function Donut_GetSceneCameraViewToWorld(sceneCamera: SceneCameraHandle, dst: Ref<f32>): void;
// Of a perspective camera (radians); negative for other cameras.
@nodrops declare function Donut_GetSceneCameraVerticalFov(sceneCamera: SceneCameraHandle): number;
@nodrops declare function Donut_GetSceneCameraZNear(sceneCamera: SceneCameraHandle): number;
// World-space bounds as 6 floats into dst: min x, y, z, max x, y, z.
@nodrops declare function Donut_GetNodeBoundingBox(node: NodeHandle, dst: Ref<f32>): void;
// Like "/Sponza/Mesh_12"; valid until the next call.
@nodrops declare function Donut_GetNodePath(node: NodeHandle): string;
// Makes the scene re-sort the node's content (e.g. after a material changes domain).
@nodrops declare function Donut_InvalidateNodeContent(node: NodeHandle): void;
// Scene graph editing, JSON and files, for a game over a loaded scene (core/rtxpt_game.ts). A new empty node under
// parent (null: the root); attaching a subtree under parent (itself, or a copy if it has a parent already).
@nodrops declare function Donut_CreateSceneNode(sceneGraph: SceneGraphHandle, parent: NodeHandle | null, name: string): NodeHandle;
@nodrops declare function Donut_AttachSceneNode(sceneGraph: SceneGraphHandle, parent: NodeHandle, node: NodeHandle): NodeHandle;
@nodrops declare function Donut_GetNodeName(node: NodeHandle): string;
@nodrops declare function Donut_GetNodeChildCount(node: NodeHandle): int;
@nodrops declare function Donut_GetNodeChild(node: NodeHandle, index: int): NodeHandle | null;
// The local transform: translation, rotation (x, y, z, w), scaling; one value: 0-2 translation, 3-6 rotation, 7-9 scaling.
@nodrops declare function Donut_SetNodeTransform(node: NodeHandle, tx: number, ty: number, tz: number, rx: number, ry: number, rz: number, rw: number,
    sx: number, sy: number, sz: number): void;
@nodrops declare function Donut_SetNodeRotation(node: NodeHandle, x: number, y: number, z: number, w: number): void;
@nodrops declare function Donut_GetNodeTransform(node: NodeHandle, component: int): number;
// The scale (axis 0-2) of the world transform from the last scene refresh.
@nodrops declare function Donut_GetNodeWorldScale(node: NodeHandle, axis: int): number;
// 9 floats (position, direction, up) from the node's local space into its parent's, in place.
@nodrops declare function Donut_TransformPoseByNode(node: NodeHandle, posDirUp: Ref<f32>): void;
@nodrops declare function Donut_IsLightNode(node: NodeHandle): boolean;
// A light's color; a spot or point light's intensity and radius; a spot light's inner and outer angles (degrees, as given).
@nodrops declare function Donut_SetNodeLight(node: NodeHandle, red: number, green: number, blue: number, intensity: number, radius: number,
    innerAngle: number, outerAngle: number): void;
// The scene file's "models": their count, and each one's import root (null without one).
@nodrops declare function Donut_GetSceneModelCount(scene: SceneHandle): int;
@nodrops declare function Donut_GetSceneModelRoot(scene: SceneHandle, index: int): NodeHandle | null;
@nodrops declare function Donut_GetSceneGraphMaterialCount(sceneGraph: SceneGraphHandle): int;
@nodrops declare function Donut_GetSceneGraphMaterial(sceneGraph: SceneGraphHandle, index: int): MaterialHandle;
@nodrops declare function Donut_GetMaterialID(material: MaterialHandle): int;
@nodrops declare function Donut_GetMaterialName(material: MaterialHandle): string;
// A donut::engine::MaterialDomain value.
@nodrops declare function Donut_GetMaterialDomain(material: MaterialHandle): int;
@nodrops declare function Donut_SetMaterialDirty(material: MaterialHandle, dirty: boolean): void;
@nodrops declare function Donut_GetSceneGraphMeshInstanceCount(sceneGraph: SceneGraphHandle): int;
// The instance index (what material ID passes write) and node of the index-th mesh instance.
@nodrops declare function Donut_GetMeshInstanceIndex(sceneGraph: SceneGraphHandle, index: int): int;
@nodrops declare function Donut_GetMeshInstanceNode(sceneGraph: SceneGraphHandle, index: int): NodeHandle;
// The geometries of the index-th mesh instance's mesh, and how many indices one of them has.
@nodrops declare function Donut_GetMeshInstanceGeometryCount(sceneGraph: SceneGraphHandle, index: int): int;
@nodrops declare function Donut_GetMeshInstanceGeometryIndexCount(sceneGraph: SceneGraphHandle, index: int, geometry: int): int;

// Views.
@nodrops declare function Donut_CreateStereoView(app: AppHandle): ViewHandle;
// Donut_SetPlanarView with a sub-pixel projection jitter, in pixels.
@nodrops declare function Donut_SetPlanarViewJittered(view: ViewHandle, viewMatrix: Ref<f32>, projMatrix: Ref<f32>, width: int, height: int, pixelOffsetX: number, pixelOffsetY: number): void;
// Left eye in the left half of width x height pixels, right eye in the right half.
@nodrops declare function Donut_SetStereoView(view: ViewHandle, leftViewMatrix: Ref<f32>, rightViewMatrix: Ref<f32>, projMatrix: Ref<f32>, width: int, height: int, pixelOffsetX: number, pixelOffsetY: number): void;
@nodrops declare function Donut_CopyStereoView(dstView: ViewHandle, srcView: ViewHandle): void;
// The left eye's planar view, e.g. for Donut_ThirdPersonCameraSetView.
@nodrops declare function Donut_GetStereoLeftView(view: ViewHandle): ViewHandle;
// First person cameras only.
@nodrops declare function Donut_CameraLookAtWithUp(camera: CameraHandle, posX: number, posY: number, posZ: number, targetX: number, targetY: number, targetZ: number, upX: number, upY: number, upZ: number): void;
@nodrops declare function Donut_CameraLookTo(camera: CameraHandle, posX: number, posY: number, posZ: number, dirX: number, dirY: number, dirZ: number, upX: number, upY: number, upZ: number): void;
// 3 floats into dst.
@nodrops declare function Donut_GetCameraPosition(camera: CameraHandle, dst: Ref<f32>): void;
