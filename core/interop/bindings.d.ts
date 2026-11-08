/// <reference path="../donut_handles.d.ts" />
/// <reference path="pipelines.d.ts" />
// Binding layouts and sets, bindless layouts and descriptor tables

// Built up with Donut_Bind*, then consumed (freed) by Donut_CreateBindingSet.
@nodrops declare function Donut_CreateBindingSetDesc(): BindingSetDescHandle;
// Buffer<uint> at t<slot>.
@nodrops declare function Donut_BindTypedBufferSRV(bindingSetDesc: BindingSetDescHandle, slot: int, buffer: BufferHandle): void;
// RWBuffer<uint> at u<slot>; the buffer must be writable.
@nodrops declare function Donut_BindTypedBufferUAV(bindingSetDesc: BindingSetDescHandle, slot: int, buffer: BufferHandle): void;
// An empty RWBuffer<T> at u<slot>: the slot NVAPI's shader extensions use (Donut_RtPipelineSetHlslExtensionsUAV), which no buffer backs.
@nodrops declare function Donut_BindNullTypedBufferUAV(bindingSetDesc: BindingSetDescHandle, slot: int): void;
// cbuffer at b<slot>: byteSize bytes of a constant buffer from byteOffset (multiples of 256).
@nodrops declare function Donut_BindConstantBuffer(bindingSetDesc: BindingSetDescHandle, slot: int, constantBuffer: BufferHandle, byteOffset: int, byteSize: int): void;
// cbuffer at b<slot>: all of a constant buffer (required for volatile ones).
@nodrops declare function Donut_BindEntireConstantBuffer(bindingSetDesc: BindingSetDescHandle, slot: int, constantBuffer: BufferHandle): void;
// StructuredBuffer at t<slot>, e.g. from Donut_GetSceneBuffer.
@nodrops declare function Donut_BindStructuredBufferSRV(bindingSetDesc: BindingSetDescHandle, slot: int, buffer: BufferHandle): void;
// RWStructuredBuffer at u<slot>, from Donut_CreateRWStructuredBuffer.
@nodrops declare function Donut_BindStructuredBufferUAV(bindingSetDesc: BindingSetDescHandle, slot: int, buffer: BufferHandle): void;
// ByteAddressBuffer at t<slot> (e.g. Donut_CreateStaticRawVertexBuffer).
@nodrops declare function Donut_BindRawBufferSRV(bindingSetDesc: BindingSetDescHandle, slot: int, buffer: BufferHandle): void;
// RWByteAddressBuffer at u<slot> (e.g. Donut_CreateDrawIndexedIndirectBuffer).
@nodrops declare function Donut_BindRawBufferUAV(bindingSetDesc: BindingSetDescHandle, slot: int, buffer: BufferHandle): void;
// Element arrayElement of a Donut_LayoutTextureSRVArray array of Texture2D at t<slot>.
@nodrops declare function Donut_BindTextureSRVArrayElement(bindingSetDesc: BindingSetDescHandle, slot: int, arrayElement: int, texture: TextureHandle): void;
// Element arrayElement of a Donut_LayoutConstantBufferArray / RawBufferSRVArray / StructuredBufferSRVArray array.
@nodrops declare function Donut_BindConstantBufferArrayElement(bindingSetDesc: BindingSetDescHandle, slot: int, arrayElement: int, constantBuffer: BufferHandle): void;
@nodrops declare function Donut_BindRawBufferSRVArrayElement(bindingSetDesc: BindingSetDescHandle, slot: int, arrayElement: int, buffer: BufferHandle): void;
@nodrops declare function Donut_BindStructuredBufferSRVArrayElement(bindingSetDesc: BindingSetDescHandle, slot: int, arrayElement: int, buffer: BufferHandle): void;
// Push constants (Donut_LayoutPushConstants) at b<slot>; their values come with each dispatch or
// draw (Donut_DispatchWithPushConstants, Donut_DrawIndexedWithPushConstants).
@nodrops declare function Donut_BindPushConstants(bindingSetDesc: BindingSetDescHandle, slot: int, byteSize: int): void;
// Texture2D at t<slot>.
@nodrops declare function Donut_BindTextureSRV(bindingSetDesc: BindingSetDescHandle, slot: int, texture: TextureHandle): void;
// Same, one level of the texture only.
@nodrops declare function Donut_BindTextureSRVMip(bindingSetDesc: BindingSetDescHandle, slot: int, texture: TextureHandle, mipLevel: int): void;
// Same, mipCount levels from firstMip on: the shader's level 0 is firstMip (SampleLevel(..., n)
// reads level firstMip + n, Load and Gather firstMip).
@nodrops declare function Donut_BindTextureSRVMips(bindingSetDesc: BindingSetDescHandle, slot: int, texture: TextureHandle, firstMip: int, mipCount: int): void;
// SamplerState at s<slot>.
@nodrops declare function Donut_BindSampler(bindingSetDesc: BindingSetDescHandle, slot: int, sampler: SamplerHandle): void;
// RWTexture2D<float4> at u<slot>.
@nodrops declare function Donut_BindTextureUAV(bindingSetDesc: BindingSetDescHandle, slot: int, texture: TextureHandle): void;
// Binding set plus matching layout (register space 0) visible to shaderType's stages.
@nodrops declare function Donut_CreateBindingSet(app: AppHandle, bindingSetDesc: BindingSetDescHandle, shaderType: ShaderType): BindingSetHandle;
// Binding set for an existing layout.
@nodrops declare function Donut_CreateBindingSetForLayout(app: AppHandle, bindingSetDesc: BindingSetDescHandle, bindingLayout: BindingLayoutHandle): BindingSetHandle;
// The layout a binding set was created with; valid as long as the binding set.
@nodrops declare function Donut_GetBindingLayout(bindingSet: BindingSetHandle): BindingLayoutHandle;

// For a layout needed before its resources exist (e.g. by a pipeline): built up with
// Donut_Layout*, then consumed (freed) by Donut_CreateBindingLayout.
@nodrops declare function Donut_CreateBindingLayoutDesc(): BindingLayoutDescHandle;
@nodrops declare function Donut_LayoutTextureUAV(bindingLayoutDesc: BindingLayoutDescHandle, slot: int): void;
@nodrops declare function Donut_LayoutTextureSRV(bindingLayoutDesc: BindingLayoutDescHandle, slot: int): void;
@nodrops declare function Donut_LayoutVolatileConstantBuffer(bindingLayoutDesc: BindingLayoutDescHandle, slot: int): void;
@nodrops declare function Donut_LayoutSampler(bindingLayoutDesc: BindingLayoutDescHandle, slot: int): void;
@nodrops declare function Donut_LayoutStructuredBufferSRV(bindingLayoutDesc: BindingLayoutDescHandle, slot: int): void;
@nodrops declare function Donut_LayoutTypedBufferSRV(bindingLayoutDesc: BindingLayoutDescHandle, slot: int): void;
// RWBuffer<T> at u<slot>.
@nodrops declare function Donut_LayoutTypedBufferUAV(bindingLayoutDesc: BindingLayoutDescHandle, slot: int): void;
// A non-volatile cbuffer.
@nodrops declare function Donut_LayoutConstantBuffer(bindingLayoutDesc: BindingLayoutDescHandle, slot: int): void;
@nodrops declare function Donut_LayoutStructuredBufferUAV(bindingLayoutDesc: BindingLayoutDescHandle, slot: int): void;
@nodrops declare function Donut_LayoutRawBufferSRV(bindingLayoutDesc: BindingLayoutDescHandle, slot: int): void;
@nodrops declare function Donut_LayoutRawBufferUAV(bindingLayoutDesc: BindingLayoutDescHandle, slot: int): void;
// An array of `count` Texture2D at t<slot> (t<slot> .. t<slot + count - 1> on D3D12, one binding on
// Vulkan); not on D3D11.
@nodrops declare function Donut_LayoutTextureSRVArray(bindingLayoutDesc: BindingLayoutDescHandle, slot: int, count: int): void;
// Arrays of `count` buffers: ConstantBuffer<...> at b<slot>, ByteAddressBuffer and StructuredBuffer<...>
// at t<slot> (D3D12: consecutive registers; Vulkan: one binding); not on D3D11. Each element bound
// with the matching Donut_Bind*ArrayElement.
@nodrops declare function Donut_LayoutConstantBufferArray(bindingLayoutDesc: BindingLayoutDescHandle, slot: int, count: int): void;
@nodrops declare function Donut_LayoutRawBufferSRVArray(bindingLayoutDesc: BindingLayoutDescHandle, slot: int, count: int): void;
@nodrops declare function Donut_LayoutStructuredBufferSRVArray(bindingLayoutDesc: BindingLayoutDescHandle, slot: int, count: int): void;
// Register space of the layout's items (D3D12 only; 0 by default).
@nodrops declare function Donut_SetBindingLayoutRegisterSpace(bindingLayoutDesc: BindingLayoutDescHandle, space: int): void;
// Same, on Vulkan too, where the space is the descriptor set: the layout must be the pipeline's
// binding layout of that index (e.g. space 1 for the second).
@nodrops declare function Donut_SetBindingLayoutDescriptorSet(bindingLayoutDesc: BindingLayoutDescHandle, space: int): void;
// The Vulkan binding numbers of the layout's registers: t<n> at shaderResource + n, and so on, as the
// SPIR-V was compiled (ShaderMake's --tRegShift etc.; NVRHI's defaults are 0, 128, 256, 384).
@nodrops declare function Donut_SetBindingLayoutVulkanOffsets(bindingLayoutDesc: BindingLayoutDescHandle, shaderResource: int, sampler: int,
    constantBuffer: int, unorderedAccess: int): void;

// Bindless: a layout of unbounded resource arrays, one register space each (visible to
// shaderType's stages), freed by Donut_CreateBindlessLayout.
@nodrops declare function Donut_CreateBindlessLayoutDesc(firstSlot: int, maxCapacity: int, shaderType: ShaderType): BindlessLayoutDescHandle;
// ByteAddressBuffer[] / Texture2D[] in register space `space`.
@nodrops declare function Donut_BindlessLayoutAddRawBuffers(bindlessLayoutDesc: BindlessLayoutDescHandle, space: int): void;
@nodrops declare function Donut_BindlessLayoutAddTextures(bindlessLayoutDesc: BindlessLayoutDescHandle, space: int): void;
@nodrops declare function Donut_CreateBindlessLayout(app: AppHandle, bindlessLayoutDesc: BindlessLayoutDescHandle): BindingLayoutHandle;
// Donut's DescriptorTableManager over a bindless layout; scenes loaded with
// Donut_LoadSceneWithDescriptorTable register their buffers and textures in it.
@nodrops declare function Donut_CreateDescriptorTableManager(app: AppHandle, bindlessLayout: BindingLayoutHandle): DescriptorTableManagerHandle;
// The table, to bind after a binding set; valid as long as the manager.
@nodrops declare function Donut_GetDescriptorTable(descriptorTableManager: DescriptorTableManagerHandle): DescriptorTableHandle;
// A descriptor table of a bindless layout without a manager: room for `capacity` descriptors in
// each of its arrays, written slot by slot with Donut_WriteDescriptorTableTexture.
@nodrops declare function Donut_CreateDescriptorTable(app: AppHandle, bindlessLayout: BindingLayoutHandle, capacity: int): DescriptorTableHandle;
// Writes a texture's descriptor into slot `slot` of a descriptor table's Texture2D array, at once
// (also into a table bound by command lists still recording or running: the bindless layouts are
// update-after-bind on Vulkan). 0 if the slot is past the table's capacity.
@nodrops declare function Donut_WriteDescriptorTableTexture(app: AppHandle, descriptorTable: DescriptorTableHandle, slot: int, texture: TextureHandle): int;
// byteSize bytes of push constants (DECLARE_PUSH_CONSTANTS in HLSL) at b<slot>.
@nodrops declare function Donut_LayoutPushConstants(bindingLayoutDesc: BindingLayoutDescHandle, slot: int, byteSize: int): void;
// Register space 0, visible to shaderType's stages.
@nodrops declare function Donut_CreateBindingLayout(app: AppHandle, bindingLayoutDesc: BindingLayoutDescHandle, shaderType: ShaderType): BindingLayoutHandle;
// A binding set from the app's binding cache (the description is freed): created once, reused for
// identical descriptions. Valid until Donut_ClearBindingCache.
@nodrops declare function Donut_GetCachedBindingSet(app: AppHandle, bindingSetDesc: BindingSetDescHandle, bindingLayout: BindingLayoutHandle): BindingSetHandle;
@nodrops declare function Donut_ClearBindingCache(app: AppHandle): void;
