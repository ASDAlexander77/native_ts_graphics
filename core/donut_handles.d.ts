// Handle types: one class per kind of C++ object the interop functions (donut_interop.d.ts) take
// or return. Declared, never defined: a handle is the C++ object's pointer, and its class only
// gives it a type of its own, so tslang and tsc reject one kind of handle where another is
// expected. The private brand member, named differently in each class, is what makes two classes
// incompatible; it's an int because tslang can't compile a void member here.
//
// Each is @cpp, which tells tslang the reference is a C++ pointer it doesn't manage: under
// -mm=rc (and own) a plain class reference is counted, with the count in the 8 bytes before the
// object and a free when it drops to 0 - for a C++ object that writes into its heap block's
// header and frees it a second time.
//
// tools/check_interop_types.py maps each C++ type to its class (HANDLES there) and checks every
// declaration in donut_interop.d.ts against its C++ definition.
//
// Handles to nvrhi resources extend ResourceHandle (Donut_ReleaseResource takes any of them);
// handles to objects App::OwnObject keeps extend ObjectHandle (Donut_ReleaseObject).
// Never declare a parameter as a union of two of these: tslang passes a union as a tagged struct,
// not a pointer. Take their base class instead.

@cpp declare class AppHandle { private readonly __app: int; }
@cpp declare class FrameHandle { private readonly __frame: int; }
@cpp declare class PassHandle { private readonly __pass: int; }
@cpp declare class AdapterListHandle { private readonly __adapterList: int; }
@cpp declare class ResourceHandle { private readonly __resource: int; }
@cpp declare class CommandListHandle extends ResourceHandle { private readonly __commandList: int; }
@cpp declare class BufferHandle extends ResourceHandle { private readonly __buffer: int; }
@cpp declare class TextureHandle extends ResourceHandle { private readonly __texture: int; }
@cpp declare class StagingTextureHandle extends ResourceHandle { private readonly __stagingTexture: int; }
@cpp declare class SamplerHandle extends ResourceHandle { private readonly __sampler: int; }
@cpp declare class HeapHandle extends ResourceHandle { private readonly __heap: int; }
@cpp declare class ShaderHandle extends ResourceHandle { private readonly __shader: int; }
@cpp declare class ShaderLibraryHandle extends ResourceHandle { private readonly __shaderLibrary: int; }
@cpp declare class InputLayoutHandle extends ResourceHandle { private readonly __inputLayout: int; }
@cpp declare class InputLayoutDescHandle { private readonly __inputLayoutDesc: int; }
@cpp declare class BindingLayoutHandle extends ResourceHandle { private readonly __bindingLayout: int; }
@cpp declare class BindingSetHandle extends ResourceHandle { private readonly __bindingSet: int; }
@cpp declare class DescriptorTableHandle extends BindingSetHandle { private readonly __descriptorTable: int; }
@cpp declare class BindingSetDescHandle { private readonly __bindingSetDesc: int; }
@cpp declare class BindingLayoutDescHandle { private readonly __bindingLayoutDesc: int; }
@cpp declare class BindlessLayoutDescHandle { private readonly __bindlessLayoutDesc: int; }
@cpp declare class ObjectHandle { private readonly __object: int; }
@cpp declare class DescriptorTableManagerHandle extends ObjectHandle { private readonly __descriptorTableManager: int; }
@cpp declare class FramebufferHandle extends ResourceHandle { private readonly __framebuffer: int; }
@cpp declare class FramebufferFactoryHandle { private readonly __framebufferFactory: int; }
@cpp declare class GraphicsPipelineHandle extends ResourceHandle { private readonly __graphicsPipeline: int; }
@cpp declare class ComputePipelineHandle extends ResourceHandle { private readonly __computePipeline: int; }
@cpp declare class MeshletPipelineHandle extends ResourceHandle { private readonly __meshletPipeline: int; }
@cpp declare class GraphicsPipelineDescHandle { private readonly __graphicsPipelineDesc: int; }
@cpp declare class AccelStructHandle extends ResourceHandle { private readonly __accelStruct: int; }
@cpp declare class OpacityMicromapHandle extends ResourceHandle { private readonly __opacityMicromap: int; }
@cpp declare class ShaderTableHandle extends ResourceHandle { private readonly __shaderTable: int; }
@cpp declare class RtPipelineHandle extends ResourceHandle { private readonly __rtPipeline: int; }
@cpp declare class RtPipelineDescHandle { private readonly __rtPipelineDesc: int; }
@cpp declare class TriangleBlasHandle extends ObjectHandle { private readonly __triangleBlas: int; }
@cpp declare class SceneAccelStructsHandle extends ObjectHandle { private readonly __sceneAccelStructs: int; }
@cpp declare class SceneHandle extends ObjectHandle { private readonly __scene: int; }
@cpp declare class SceneGraphHandle extends ObjectHandle { private readonly __sceneGraph: int; }
@cpp declare class NodeHandle { private readonly __node: int; }
@cpp declare class LightHandle { private readonly __light: int; }
@cpp declare class MaterialHandle extends ObjectHandle { private readonly __material: int; }
@cpp declare class SceneCameraHandle { private readonly __sceneCamera: int; }
@cpp declare class MeshHandle extends ObjectHandle { private readonly __mesh: int; }
@cpp declare class LoadedTextureHandle extends ObjectHandle { private readonly __loadedTexture: int; }
@cpp declare class CameraHandle extends ObjectHandle { private readonly __camera: int; }
@cpp declare class ViewHandle extends ObjectHandle { private readonly __view: int; }
@cpp declare class SceneLoaderHandle extends ObjectHandle { private readonly __sceneLoader: int; }
@cpp declare class StringListHandle extends ObjectHandle { private readonly __stringList: int; }
@cpp declare class DynamicMeshHandle extends ObjectHandle { private readonly __dynamicMesh: int; }
@cpp declare class CubemapTargetHandle extends ObjectHandle { private readonly __cubemapTarget: int; }
@cpp declare class DrawBatchHandle extends ObjectHandle { private readonly __drawBatch: int; }
@cpp declare class GBufferTargetsHandle extends ObjectHandle { private readonly __gbufferTargets: int; }
@cpp declare class TemporalTargetsHandle extends ObjectHandle { private readonly __temporalTargets: int; }
@cpp declare class SceneRenderTargetsHandle extends ObjectHandle { private readonly __sceneRenderTargets: int; }
@cpp declare class ShadowMapHandle extends ObjectHandle { private readonly __shadowMap: int; }
@cpp declare class LightProbeSetHandle extends ObjectHandle { private readonly __lightProbeSet: int; }
@cpp declare class LightProbeCaptureHandle extends ObjectHandle { private readonly __lightProbeCapture: int; }
@cpp declare class ForwardShadingPassHandle extends ObjectHandle { private readonly __forwardShadingPass: int; }
@cpp declare class ForwardShadingContextHandle extends ObjectHandle { private readonly __forwardShadingContext: int; }
@cpp declare class GBufferFillPassHandle extends ObjectHandle { private readonly __gbufferFillPass: int; }
@cpp declare class DeferredLightingPassHandle extends ObjectHandle { private readonly __deferredLightingPass: int; }
@cpp declare class TemporalAntiAliasingPassHandle extends ObjectHandle { private readonly __temporalAntiAliasingPass: int; }
@cpp declare class ToneMappingPassHandle extends ObjectHandle { private readonly __toneMappingPass: int; }
@cpp declare class DepthPassHandle extends ObjectHandle { private readonly __depthPass: int; }
@cpp declare class PixelReadbackPassHandle extends ObjectHandle { private readonly __pixelReadbackPass: int; }
@cpp declare class MipMapGenPassHandle extends ObjectHandle { private readonly __mipMapGenPass: int; }
@cpp declare class MaterialIdPassHandle extends ObjectHandle { private readonly __materialIdPass: int; }
@cpp declare class SsaoPassHandle extends ObjectHandle { private readonly __ssaoPass: int; }
@cpp declare class EnvironmentMapPassHandle extends ObjectHandle { private readonly __environmentMapPass: int; }
@cpp declare class SkyPassHandle extends ObjectHandle { private readonly __skyPass: int; }
@cpp declare class BloomPassHandle extends ObjectHandle { private readonly __bloomPass: int; }
@cpp declare class LightProbeProcessingPassHandle extends ObjectHandle { private readonly __lightProbeProcessingPass: int; }
@cpp declare class DlssHandle extends ObjectHandle { private readonly __dlss: int; }
@cpp declare class ImGuiPassHandle { private readonly __imguiPass: int; }
@cpp declare class ImGuiFontHandle { private readonly __imguiFont: int; }
@cpp declare class VideoPlayerHandle { private readonly __videoPlayer: int; }
@cpp declare class SdkMeshHandle { private readonly __sdkMesh: int; }
@cpp declare class MeshletModelHandle { private readonly __meshletModel: int; }
@cpp declare class ObjModelHandle { private readonly __objModel: int; }
@cpp declare class PbrtSceneHandle { private readonly __pbrtScene: int; }
@cpp declare class GltfModelHandle extends ObjectHandle { private readonly __gltfModel: int; }
@cpp declare class GltfMeshHandle extends ObjectHandle { private readonly __gltfMesh: int; }
@cpp declare class BinaryFileHandle extends ObjectHandle { private readonly __binaryFile: int; }
@cpp declare class TranscodedTextureHandle { private readonly __transcodedTexture: int; }
@cpp declare class FbcTextureHandle { private readonly __fbcTexture: int; }
@cpp declare class AsyncComputeLoopHandle extends ObjectHandle { private readonly __asyncComputeLoop: int; }
@cpp declare class TileMappingsHandle { private readonly __tileMappings: int; }
@cpp declare class TextureHeapHandle extends ObjectHandle { private readonly __textureHeap: int; }
@cpp declare class SharedTextureHandle extends ObjectHandle { private readonly __sharedTexture: int; }
@cpp declare class D3D12WorkGraphHandle extends ObjectHandle { private readonly __workGraph: int; }
@cpp declare class D3D12LibraryRtPipelineHandle extends ObjectHandle { private readonly __libraryRtPipeline: int; }
@cpp declare class CalibratedTimestampsHandle extends ObjectHandle { private readonly __calibratedTimestamps: int; }
@cpp declare class HostCopiedTextureHandle extends ObjectHandle { private readonly __hostCopiedTexture: int; }
@cpp declare class D3D12GenericProgramHandle extends ObjectHandle { private readonly __genericProgram: int; }
@cpp declare class PushDescriptorPipelineHandle extends ObjectHandle { private readonly __pushDescriptorPipeline: int; }
@cpp declare class DescriptorBufferHandle extends ObjectHandle { private readonly __descriptorBuffer: int; }
@cpp declare class DescriptorBufferPipelineHandle extends ObjectHandle { private readonly __descriptorBufferPipeline: int; }
@cpp declare class PagedImageSetHandle extends ObjectHandle { private readonly __pagedImageSet: int; }
@cpp declare class OcclusionPredicationHandle extends ObjectHandle { private readonly __occlusionPredication: int; }
@cpp declare class PredicationBufferHandle extends ObjectHandle { private readonly __predicationBuffer: int; }
@cpp declare class MeshPipelineStatisticsHandle extends ObjectHandle { private readonly __meshPipelineStatistics: int; }
@cpp declare class RandomEngineHandle extends ObjectHandle { private readonly __randomEngine: int; }
@cpp declare class TimerQueryHandle extends ResourceHandle { private readonly __timerQuery: int; }
