// Handle types: one class per kind of C++ object the interop functions (donut_interop.d.ts) take
// or return. Declared, never defined: a handle is the C++ object's pointer, and its class only
// gives it a type of its own, so tslang and tsc reject one kind of handle where another is
// expected. The private brand member, named differently in each class, is what makes two classes
// incompatible; it's an int because tslang can't compile a void member here.
//
// tools/check_interop_types.py maps each C++ type to its class (HANDLES there) and checks every
// declaration in donut_interop.d.ts against its C++ definition.
//
// Handles to nvrhi resources extend ResourceHandle (Donut_ReleaseResource takes any of them);
// handles to objects App::OwnObject keeps extend ObjectHandle (Donut_ReleaseObject).
// Never declare a parameter as a union of two of these: tslang passes a union as a tagged struct,
// not a pointer. Take their base class instead.

declare class AppHandle { private readonly __app: int; }
declare class FrameHandle { private readonly __frame: int; }
declare class PassHandle { private readonly __pass: int; }
declare class AdapterListHandle { private readonly __adapterList: int; }
declare class ResourceHandle { private readonly __resource: int; }
declare class CommandListHandle extends ResourceHandle { private readonly __commandList: int; }
declare class BufferHandle extends ResourceHandle { private readonly __buffer: int; }
declare class TextureHandle extends ResourceHandle { private readonly __texture: int; }
declare class StagingTextureHandle extends ResourceHandle { private readonly __stagingTexture: int; }
declare class SamplerHandle extends ResourceHandle { private readonly __sampler: int; }
declare class HeapHandle extends ResourceHandle { private readonly __heap: int; }
declare class ShaderHandle extends ResourceHandle { private readonly __shader: int; }
declare class ShaderLibraryHandle extends ResourceHandle { private readonly __shaderLibrary: int; }
declare class InputLayoutHandle extends ResourceHandle { private readonly __inputLayout: int; }
declare class InputLayoutDescHandle { private readonly __inputLayoutDesc: int; }
declare class BindingLayoutHandle extends ResourceHandle { private readonly __bindingLayout: int; }
declare class BindingSetHandle extends ResourceHandle { private readonly __bindingSet: int; }
declare class DescriptorTableHandle extends BindingSetHandle { private readonly __descriptorTable: int; }
declare class BindingSetDescHandle { private readonly __bindingSetDesc: int; }
declare class BindingLayoutDescHandle { private readonly __bindingLayoutDesc: int; }
declare class BindlessLayoutDescHandle { private readonly __bindlessLayoutDesc: int; }
declare class ObjectHandle { private readonly __object: int; }
declare class DescriptorTableManagerHandle extends ObjectHandle { private readonly __descriptorTableManager: int; }
declare class FramebufferHandle extends ResourceHandle { private readonly __framebuffer: int; }
declare class FramebufferFactoryHandle { private readonly __framebufferFactory: int; }
declare class GraphicsPipelineHandle extends ResourceHandle { private readonly __graphicsPipeline: int; }
declare class ComputePipelineHandle extends ResourceHandle { private readonly __computePipeline: int; }
declare class MeshletPipelineHandle extends ResourceHandle { private readonly __meshletPipeline: int; }
declare class GraphicsPipelineDescHandle { private readonly __graphicsPipelineDesc: int; }
declare class AccelStructHandle extends ResourceHandle { private readonly __accelStruct: int; }
declare class OpacityMicromapHandle extends ResourceHandle { private readonly __opacityMicromap: int; }
declare class ShaderTableHandle extends ResourceHandle { private readonly __shaderTable: int; }
declare class RtPipelineHandle extends ResourceHandle { private readonly __rtPipeline: int; }
declare class RtPipelineDescHandle { private readonly __rtPipelineDesc: int; }
declare class TriangleBlasHandle extends ObjectHandle { private readonly __triangleBlas: int; }
declare class SceneAccelStructsHandle extends ObjectHandle { private readonly __sceneAccelStructs: int; }
declare class SceneHandle extends ObjectHandle { private readonly __scene: int; }
declare class SceneGraphHandle extends ObjectHandle { private readonly __sceneGraph: int; }
declare class NodeHandle { private readonly __node: int; }
declare class LightHandle { private readonly __light: int; }
declare class MaterialHandle extends ObjectHandle { private readonly __material: int; }
declare class SceneCameraHandle { private readonly __sceneCamera: int; }
declare class MeshHandle extends ObjectHandle { private readonly __mesh: int; }
declare class LoadedTextureHandle extends ObjectHandle { private readonly __loadedTexture: int; }
declare class CameraHandle extends ObjectHandle { private readonly __camera: int; }
declare class ViewHandle extends ObjectHandle { private readonly __view: int; }
declare class SceneLoaderHandle extends ObjectHandle { private readonly __sceneLoader: int; }
declare class StringListHandle extends ObjectHandle { private readonly __stringList: int; }
declare class DynamicMeshHandle extends ObjectHandle { private readonly __dynamicMesh: int; }
