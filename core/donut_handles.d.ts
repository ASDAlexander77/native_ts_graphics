// Handle types: one class per kind of C++ object the interop functions (donut_interop.d.ts) take
// or return. Declared, never defined: a handle is the C++ object's pointer, and its class only
// gives it a type of its own, so tslang and tsc reject one kind of handle where another is
// expected. The private brand member, named differently in each class, is what makes two classes
// incompatible; it's an index (a pointer-sized integer) because tslang can't compile a void member here.
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

@cpp declare class AppHandle { private readonly __app: index; }
@cpp declare class FrameHandle { private readonly __frame: index; }
@cpp declare class PassHandle { private readonly __pass: index; }
@cpp declare class AdapterListHandle { private readonly __adapterList: index; }
@cpp declare class ResourceHandle { private readonly __resource: index; }
@cpp declare class CommandListHandle extends ResourceHandle { private readonly __commandList: index; }
@cpp declare class BufferHandle extends ResourceHandle { private readonly __buffer: index; }
@cpp declare class TextureHandle extends ResourceHandle { private readonly __texture: index; }
@cpp declare class StagingTextureHandle extends ResourceHandle { private readonly __stagingTexture: index; }
@cpp declare class SamplerHandle extends ResourceHandle { private readonly __sampler: index; }
@cpp declare class HeapHandle extends ResourceHandle { private readonly __heap: index; }
@cpp declare class ShaderHandle extends ResourceHandle { private readonly __shader: index; }
@cpp declare class ShaderLibraryHandle extends ResourceHandle { private readonly __shaderLibrary: index; }
@cpp declare class InputLayoutHandle extends ResourceHandle { private readonly __inputLayout: index; }
@cpp declare class InputLayoutDescHandle { private readonly __inputLayoutDesc: index; }
@cpp declare class BindingLayoutHandle extends ResourceHandle { private readonly __bindingLayout: index; }
@cpp declare class BindingSetHandle extends ResourceHandle { private readonly __bindingSet: index; }
@cpp declare class DescriptorTableHandle extends BindingSetHandle { private readonly __descriptorTable: index; }
@cpp declare class BindingSetDescHandle { private readonly __bindingSetDesc: index; }
@cpp declare class BindingLayoutDescHandle { private readonly __bindingLayoutDesc: index; }
@cpp declare class BindlessLayoutDescHandle { private readonly __bindlessLayoutDesc: index; }
@cpp declare class ObjectHandle { private readonly __object: index; }
@cpp declare class DescriptorTableManagerHandle extends ObjectHandle { private readonly __descriptorTableManager: index; }
@cpp declare class FramebufferHandle extends ResourceHandle { private readonly __framebuffer: index; }
@cpp declare class FramebufferFactoryHandle { private readonly __framebufferFactory: index; }
@cpp declare class GraphicsPipelineHandle extends ResourceHandle { private readonly __graphicsPipeline: index; }
@cpp declare class ComputePipelineHandle extends ResourceHandle { private readonly __computePipeline: index; }
@cpp declare class MeshletPipelineHandle extends ResourceHandle { private readonly __meshletPipeline: index; }
@cpp declare class GraphicsPipelineDescHandle { private readonly __graphicsPipelineDesc: index; }
@cpp declare class AccelStructHandle extends ResourceHandle { private readonly __accelStruct: index; }
@cpp declare class OpacityMicromapHandle extends ResourceHandle { private readonly __opacityMicromap: index; }
@cpp declare class ShaderTableHandle extends ResourceHandle { private readonly __shaderTable: index; }
@cpp declare class RtPipelineHandle extends ResourceHandle { private readonly __rtPipeline: index; }
@cpp declare class RtPipelineDescHandle { private readonly __rtPipelineDesc: index; }
@cpp declare class TriangleBlasHandle extends ObjectHandle { private readonly __triangleBlas: index; }
@cpp declare class SceneAccelStructsHandle extends ObjectHandle { private readonly __sceneAccelStructs: index; }
@cpp declare class SceneHandle extends ObjectHandle { private readonly __scene: index; }
@cpp declare class SceneGraphHandle extends ObjectHandle { private readonly __sceneGraph: index; }
@cpp declare class NodeHandle { private readonly __node: index; }
@cpp declare class LightHandle { private readonly __light: index; }
@cpp declare class MaterialHandle extends ObjectHandle { private readonly __material: index; }
@cpp declare class SceneCameraHandle { private readonly __sceneCamera: index; }
@cpp declare class MeshHandle extends ObjectHandle { private readonly __mesh: index; }
@cpp declare class LoadedTextureHandle extends ObjectHandle { private readonly __loadedTexture: index; }
@cpp declare class CameraHandle extends ObjectHandle { private readonly __camera: index; }
@cpp declare class ViewHandle extends ObjectHandle { private readonly __view: index; }
@cpp declare class SceneLoaderHandle extends ObjectHandle { private readonly __sceneLoader: index; }
@cpp declare class StringListHandle extends ObjectHandle { private readonly __stringList: index; }
@cpp declare class DynamicMeshHandle extends ObjectHandle { private readonly __dynamicMesh: index; }
@cpp declare class CubemapTargetHandle extends ObjectHandle { private readonly __cubemapTarget: index; }
@cpp declare class DrawBatchHandle extends ObjectHandle { private readonly __drawBatch: index; }
@cpp declare class GBufferTargetsHandle extends ObjectHandle { private readonly __gbufferTargets: index; }
@cpp declare class TemporalTargetsHandle extends ObjectHandle { private readonly __temporalTargets: index; }
@cpp declare class SceneRenderTargetsHandle extends ObjectHandle { private readonly __sceneRenderTargets: index; }
@cpp declare class ShadowMapHandle extends ObjectHandle { private readonly __shadowMap: index; }
@cpp declare class LightProbeSetHandle extends ObjectHandle { private readonly __lightProbeSet: index; }
@cpp declare class LightProbeCaptureHandle extends ObjectHandle { private readonly __lightProbeCapture: index; }
@cpp declare class ForwardShadingPassHandle extends ObjectHandle { private readonly __forwardShadingPass: index; }
@cpp declare class ForwardShadingContextHandle extends ObjectHandle { private readonly __forwardShadingContext: index; }
@cpp declare class GBufferFillPassHandle extends ObjectHandle { private readonly __gbufferFillPass: index; }
@cpp declare class DeferredLightingPassHandle extends ObjectHandle { private readonly __deferredLightingPass: index; }
@cpp declare class TemporalAntiAliasingPassHandle extends ObjectHandle { private readonly __temporalAntiAliasingPass: index; }
@cpp declare class ToneMappingPassHandle extends ObjectHandle { private readonly __toneMappingPass: index; }
@cpp declare class DepthPassHandle extends ObjectHandle { private readonly __depthPass: index; }
@cpp declare class PixelReadbackPassHandle extends ObjectHandle { private readonly __pixelReadbackPass: index; }
@cpp declare class MipMapGenPassHandle extends ObjectHandle { private readonly __mipMapGenPass: index; }
@cpp declare class MaterialIdPassHandle extends ObjectHandle { private readonly __materialIdPass: index; }
@cpp declare class SsaoPassHandle extends ObjectHandle { private readonly __ssaoPass: index; }
@cpp declare class EnvironmentMapPassHandle extends ObjectHandle { private readonly __environmentMapPass: index; }
@cpp declare class SkyPassHandle extends ObjectHandle { private readonly __skyPass: index; }
@cpp declare class BloomPassHandle extends ObjectHandle { private readonly __bloomPass: index; }
@cpp declare class LightProbeProcessingPassHandle extends ObjectHandle { private readonly __lightProbeProcessingPass: index; }
@cpp declare class DlssHandle extends ObjectHandle { private readonly __dlss: index; }
@cpp declare class DlssNeuralRenderingHandle extends ObjectHandle { private readonly __dlssNeuralRendering: index; }
@cpp declare class DlssRayReconstructionHandle extends ObjectHandle { private readonly __dlssRayReconstruction: index; }
@cpp declare class ImGuiPassHandle { private readonly __imguiPass: index; }
@cpp declare class ImGuiFontHandle { private readonly __imguiFont: index; }
@cpp declare class VideoPlayerHandle { private readonly __videoPlayer: index; }
@cpp declare class SdkMeshHandle { private readonly __sdkMesh: index; }
@cpp declare class MeshletModelHandle { private readonly __meshletModel: index; }
@cpp declare class ObjModelHandle { private readonly __objModel: index; }
@cpp declare class PbrtSceneHandle { private readonly __pbrtScene: index; }
@cpp declare class RtxcrSceneHandle { private readonly __rtxcrScene: index; }
@cpp declare class RtxcrNrdHandle { private readonly __rtxcrNrd: index; }
@cpp declare class RtxptRendererHandle { private readonly __rtxptRenderer: index; }
@cpp declare class GltfModelHandle extends ObjectHandle { private readonly __gltfModel: index; }
@cpp declare class GltfMeshHandle extends ObjectHandle { private readonly __gltfMesh: index; }
@cpp declare class BinaryFileHandle extends ObjectHandle { private readonly __binaryFile: index; }
@cpp declare class TranscodedTextureHandle { private readonly __transcodedTexture: index; }
@cpp declare class FbcTextureHandle { private readonly __fbcTexture: index; }
@cpp declare class AsyncComputeLoopHandle extends ObjectHandle { private readonly __asyncComputeLoop: index; }
@cpp declare class TileMappingsHandle { private readonly __tileMappings: index; }
@cpp declare class TextureHeapHandle extends ObjectHandle { private readonly __textureHeap: index; }
@cpp declare class SharedTextureHandle extends ObjectHandle { private readonly __sharedTexture: index; }
@cpp declare class D3D12WorkGraphHandle extends ObjectHandle { private readonly __workGraph: index; }
@cpp declare class D3D12LibraryRtPipelineHandle extends ObjectHandle { private readonly __libraryRtPipeline: index; }
@cpp declare class CalibratedTimestampsHandle extends ObjectHandle { private readonly __calibratedTimestamps: index; }
@cpp declare class HostCopiedTextureHandle extends ObjectHandle { private readonly __hostCopiedTexture: index; }
@cpp declare class D3D12GenericProgramHandle extends ObjectHandle { private readonly __genericProgram: index; }
@cpp declare class PushDescriptorPipelineHandle extends ObjectHandle { private readonly __pushDescriptorPipeline: index; }
@cpp declare class DescriptorBufferHandle extends ObjectHandle { private readonly __descriptorBuffer: index; }
@cpp declare class DescriptorBufferPipelineHandle extends ObjectHandle { private readonly __descriptorBufferPipeline: index; }
@cpp declare class PagedImageSetHandle extends ObjectHandle { private readonly __pagedImageSet: index; }
@cpp declare class OmmBakerHandle extends ObjectHandle { private readonly __ommBaker: index; }
@cpp declare class OcclusionPredicationHandle extends ObjectHandle { private readonly __occlusionPredication: index; }
@cpp declare class PredicationBufferHandle extends ObjectHandle { private readonly __predicationBuffer: index; }
@cpp declare class MeshPipelineStatisticsHandle extends ObjectHandle { private readonly __meshPipelineStatistics: index; }
@cpp declare class RandomEngineHandle extends ObjectHandle { private readonly __randomEngine: index; }
@cpp declare class TimerQueryHandle extends ResourceHandle { private readonly __timerQuery: index; }
