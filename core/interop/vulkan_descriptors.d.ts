/// <reference path="../donut_handles.d.ts" />
/// <reference path="resources.d.ts" />
/// <reference path="pipelines.d.ts" />
// Raw Vulkan descriptors: push descriptors and descriptor buffers

// Donut_AddPushDescriptorBinding's and Donut_AddDescriptorBufferSet's types: the binding's Vulkan
// descriptor type.
enum RawDescriptorType {
    // VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER.
    ConstantBuffer = 0,
    // VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER ([[vk::combinedImageSampler]] in HLSL).
    TextureSampler = 1,
    // VK_DESCRIPTOR_TYPE_SAMPLED_IMAGE.
    Texture = 2,
    // VK_DESCRIPTOR_TYPE_SAMPLER.
    Sampler = 3,
}
// Non-zero if descriptors can be pushed into command buffers (Vulkan's VK_KHR_push_descriptor;
// not D3D): Donut_CreatePushDescriptorPipeline.
@nodrops declare function Donut_HasPushDescriptors(app: AppHandle): int;
// The most descriptors one push can set (maxPushDescriptors); 0 without push descriptors.
@nodrops declare function Donut_GetMaxPushDescriptors(app: AppHandle): int;
// A graphics pipeline whose descriptors are pushed with each draw (VK_KHR_push_descriptor, raw
// Vulkan recorded into NVRHI's command buffer): a vertex and a pixel shader, the vertex input from
// inputLayout (attribute i at location i, one vertex buffer), triangle lists, for framebuffers like
// framebuffer; cull mode, winding, depth test, write and comparison; no blending. Add its bindings,
// then build it. Null without push descriptors; release it with Donut_ReleaseObject.
@nodrops declare function Donut_CreatePushDescriptorPipeline(app: AppHandle, vertexShader: ShaderHandle, pixelShader: ShaderHandle,
    inputLayout: InputLayoutHandle, framebuffer: FramebufferHandle, cullMode: CullMode, frontCounterClockwise: int,
    depthTest: int, depthWrite: int, depthFunc: ComparisonFunc): PushDescriptorPipelineHandle | null;
// A binding of its one set: its number (the shader's [[vk::binding(n)]]), its type, the stages that
// see it (ShaderType bits).
@nodrops declare function Donut_AddPushDescriptorBinding(pushDescriptorPipeline: PushDescriptorPipelineHandle, binding: int,
    type: RawDescriptorType, shaderType: int): void;
// Creates its set layout (push descriptor flag: no set is ever allocated), layout and pipeline;
// 0 on failure.
@nodrops declare function Donut_BuildPushDescriptorPipeline(pushDescriptorPipeline: PushDescriptorPipelineHandle): int;
// Starts a pass of draws into framebuffer with commandList; Donut_EndPushDescriptorPass records it.
@nodrops declare function Donut_BeginPushDescriptorPass(pushDescriptorPipeline: PushDescriptorPipelineHandle,
    commandList: CommandListHandle, framebuffer: FramebufferHandle): void;
// Pushes a descriptor for the next draws: a static constant buffer (volatile ones have no fixed
// place), or a texture and a sampler (at a TextureSampler binding both, else the binding's one).
@nodrops declare function Donut_PushDescriptorBuffer(pushDescriptorPipeline: PushDescriptorPipelineHandle, binding: int,
    buffer: BufferHandle): void;
@nodrops declare function Donut_PushDescriptorTexture(pushDescriptorPipeline: PushDescriptorPipelineHandle, binding: int,
    texture: TextureHandle, sampler: SamplerHandle): void;
// An indexed draw (indices from 0, 32-bit unless the buffer is R16_UINT) with the descriptors
// pushed so far, pushed into the command buffer (vkCmdPushDescriptorSetKHR) right before it.
@nodrops declare function Donut_PushDescriptorDrawIndexed(pushDescriptorPipeline: PushDescriptorPipelineHandle,
    vertexBuffer: BufferHandle, indexBuffer: BufferHandle, indexCount: int): void;
// Records the pass: barriers for what it reads and draws into, the framebuffer's rendering scope
// (contents kept), then per draw its pushes and the draw. NVRHI's next draw binds everything anew.
@nodrops declare function Donut_EndPushDescriptorPass(pushDescriptorPipeline: PushDescriptorPipelineHandle): void;

// Non-zero if descriptor sets can live in buffers (Vulkan's VK_EXT_descriptor_buffer, for apps
// created with AppOptions.DescriptorBuffers; not D3D): Donut_CreateDescriptorBufferPipeline.
@nodrops declare function Donut_HasDescriptorBuffers(app: AppHandle): int;
// How many descriptor buffers with resource descriptors a pass can bind; 0 without them.
@nodrops declare function Donut_GetMaxResourceDescriptorBufferBindings(app: AppHandle): int;
// A buffer of byteSize bytes of descriptors, resource ones and (samplers != 0) sampler ones
// (combined image samplers included), written by the CPU. Null without descriptor buffers;
// release it with Donut_ReleaseObject.
@nodrops declare function Donut_CreateDescriptorBuffer(app: AppHandle, byteSize: int, samplers: int): DescriptorBufferHandle | null;
// A graphics pipeline whose descriptor sets live in descriptor buffers (raw Vulkan recorded into
// NVRHI's command buffer), its states as Donut_CreatePushDescriptorPipeline's. Add its sets, then
// build it. Null without descriptor buffers; release it with Donut_ReleaseObject.
@nodrops declare function Donut_CreateDescriptorBufferPipeline(app: AppHandle, vertexShader: ShaderHandle, pixelShader: ShaderHandle,
    inputLayout: InputLayoutHandle, framebuffer: FramebufferHandle, cullMode: CullMode, frontCounterClockwise: int,
    depthTest: int, depthWrite: int, depthFunc: ComparisonFunc): DescriptorBufferPipelineHandle | null;
// The next set (numbered from 0): one binding, binding 0 ([[vk::binding(0, set)]]), of a type,
// seen by the stages in shaderType (ShaderType bits).
@nodrops declare function Donut_AddDescriptorBufferSet(descriptorBufferPipeline: DescriptorBufferPipelineHandle, type: RawDescriptorType,
    shaderType: int): void;
// Creates its set layouts and pipeline (descriptor buffer flags) and finds the sets' sizes in a
// descriptor buffer; 0 on failure.
@nodrops declare function Donut_BuildDescriptorBufferPipeline(descriptorBufferPipeline: DescriptorBufferPipelineHandle): int;
// A set's size in a descriptor buffer (bytes, aligned to where sets can start): the stride of its
// elements.
@nodrops declare function Donut_GetDescriptorBufferSetSize(descriptorBufferPipeline: DescriptorBufferPipelineHandle, set: int): int;
// Writes a constant buffer's descriptor (a static buffer's address and size) for a set's binding
// at element of a descriptor buffer (byte offset element * the set's size).
@nodrops declare function Donut_WriteDescriptorBufferConstantBuffer(descriptorBuffer: DescriptorBufferHandle,
    descriptorBufferPipeline: DescriptorBufferPipelineHandle, set: int, element: int, buffer: BufferHandle): void;
// Same, a texture and a sampler (a TextureSampler binding both, else the binding's one).
@nodrops declare function Donut_WriteDescriptorBufferTexture(descriptorBuffer: DescriptorBufferHandle,
    descriptorBufferPipeline: DescriptorBufferPipelineHandle, set: int, element: int, texture: TextureHandle,
    sampler: SamplerHandle): void;
// Starts a pass of draws into framebuffer with commandList; Donut_EndDescriptorBufferPass records it.
@nodrops declare function Donut_BeginDescriptorBufferPass(descriptorBufferPipeline: DescriptorBufferPipelineHandle,
    commandList: CommandListHandle, framebuffer: FramebufferHandle): void;
// Binds a descriptor buffer for the pass as the next buffer index (from 0).
@nodrops declare function Donut_BindDescriptorBuffer(descriptorBufferPipeline: DescriptorBufferPipelineHandle,
    descriptorBuffer: DescriptorBufferHandle): void;
// Where a set's descriptors are for the next draws: the bufferIndex-th bound buffer, at element
// (byte offset element * the set's size).
@nodrops declare function Donut_SetDescriptorBufferOffset(descriptorBufferPipeline: DescriptorBufferPipelineHandle, set: int,
    bufferIndex: int, element: int): void;
// An indexed draw (indices from 0, 32-bit unless the buffer is R16_UINT) with the sets where they
// are so far.
@nodrops declare function Donut_DescriptorBufferDrawIndexed(descriptorBufferPipeline: DescriptorBufferPipelineHandle,
    vertexBuffer: BufferHandle, indexBuffer: BufferHandle, indexCount: int): void;
// Records the pass: barriers for what the bound buffers' descriptors point at and the framebuffer,
// its rendering scope, the buffers bound, then per draw the sets' offsets and the draw.
@nodrops declare function Donut_EndDescriptorBufferPass(descriptorBufferPipeline: DescriptorBufferPipelineHandle): void;
