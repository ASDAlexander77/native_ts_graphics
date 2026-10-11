// NVRHI's structs and constants that are the same under every C++ ABI the project builds with -
// MSVC x64 and the Itanium ABI of Android's clang (libc++) - for core/nvrhi.ts. The classes and the
// structs whose layout depends on the ABI (std::string's, in BufferDesc and TextureDesc) are in
// core/nvrhi_abi.win32.ts and core/nvrhi_abi.linux.ts.

/// <reference path="donut_interop.d.ts" />

export namespace nvrhi {

    // nvrhi::RefCountPtr<T> by value, as a method returns it: the object's pointer, holding a
    // reference. It has a destructor, so a method returning it is @cppnontrivial.
    export type RefCountPtr = [pointer: Opaque | null];

    // nvrhi::Object by value (getNativeObject, getNativeQueue): the API object's pointer.
    export type NativeObject = [pointer: Opaque | null];

    // nvrhi::TextureSubresourceSet (16 bytes)
    export type TextureSubresourceSet = [baseMipLevel: u32, numMipLevels: u32, baseArraySlice: u32, numArraySlices: u32];

    // nvrhi::Color (16 bytes)
    export type Color = [r: f32, g: f32, b: f32, a: f32];

    // nvrhi::CommandListParameters (48 bytes)
    export type CommandListParameters = [
        enableImmediateExecution: boolean, uploadChunkSize: index, scratchChunkSize: index,
        scratchMaxMemory: index, queueType: u8, lifetimeTracker: Opaque | null
    ];

    // nvrhi::ComputePipelineDesc (80 bytes): the shader and a static_vector of c_MaxBindingLayouts (8)
    // binding layouts (the elements, then the count). They are RefCountPtrs in C++: NVRHI copies
    // the desc, adding the references it keeps, and nothing destroys this tuple's, so plain
    // pointers here are balanced.
    export type ComputePipelineDesc = [
        CS: Opaque | null,
        bindingLayout0: Opaque | null, bindingLayout1: Opaque | null, bindingLayout2: Opaque | null, bindingLayout3: Opaque | null,
        bindingLayout4: Opaque | null, bindingLayout5: Opaque | null, bindingLayout6: Opaque | null, bindingLayout7: Opaque | null,
        bindingLayoutCount: index
    ];

    // nvrhi::ComputeState (88 bytes): the pipeline, a static_vector of 8 binding sets, the
    // indirect arguments' buffer
    export type ComputeState = [
        pipeline: Opaque | null,
        binding0: Opaque | null, binding1: Opaque | null, binding2: Opaque | null, binding3: Opaque | null,
        binding4: Opaque | null, binding5: Opaque | null, binding6: Opaque | null, binding7: Opaque | null,
        bindingCount: index, indirectParams: Opaque | null
    ];

    // nvrhi::GraphicsAPI
    export const GRAPHICS_API_D3D11: u8 = 0;
    export const GRAPHICS_API_D3D12: u8 = 1;
    export const GRAPHICS_API_VULKAN: u8 = 2;

    // nvrhi::CpuAccessMode
    export const CPU_ACCESS_NONE: u8 = 0;
    export const CPU_ACCESS_READ: u8 = 1;
    export const CPU_ACCESS_WRITE: u8 = 2;

    // nvrhi::CommandQueue
    export const COMMAND_QUEUE_GRAPHICS: u8 = 0;
    export const COMMAND_QUEUE_COMPUTE: u8 = 1;
    export const COMMAND_QUEUE_COPY: u8 = 2;

    // nvrhi::TextureDimension (some)
    export const TEXTURE_DIMENSION_2D: u8 = 3;

    // nvrhi::Feature (some)
    export const FEATURE_COMPUTE_QUEUE: u8 = 0;

    // nvrhi::ResourceStates (some)
    export const RESOURCE_STATE_UNKNOWN: u32 = 0;
    export const RESOURCE_STATE_COMMON: u32 = 0x1;
    export const RESOURCE_STATE_SHADER_RESOURCE: u32 = 0x60;
    export const RESOURCE_STATE_UNORDERED_ACCESS: u32 = 0x80;
    export const RESOURCE_STATE_RENDER_TARGET: u32 = 0x100;
    export const RESOURCE_STATE_COPY_DEST: u32 = 0x1000;
    export const RESOURCE_STATE_COPY_SOURCE: u32 = 0x2000;

    // nvrhi::ObjectTypes (some)
    export const OBJECT_TYPE_D3D11_DEVICE: u32 = 0x00010001;
    export const OBJECT_TYPE_D3D12_DEVICE: u32 = 0x00020001;
    export const OBJECT_TYPE_D3D12_COMMAND_QUEUE: u32 = 0x00020002;
    export const OBJECT_TYPE_D3D12_RESOURCE: u32 = 0x00020004;
    export const OBJECT_TYPE_VK_DEVICE: u32 = 0x00030001;
    export const OBJECT_TYPE_VK_QUEUE: u32 = 0x00030004;
    export const OBJECT_TYPE_VK_IMAGE: u32 = 0x00030008;
}
