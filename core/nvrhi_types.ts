// NVRHI's constants, and the records its methods return by value, for core/nvrhi.ts: the same under
// every C++ ABI the project builds with (MSVC x64, and the Itanium ABI of Android's clang). The
// classes and the structs they take are generated for each ABI in core/nvrhi_classes.<os>.ts.

/// <reference path="donut_interop.d.ts" />

export namespace nvrhi {

    // nvrhi::RefCountPtr<T> by value, as a method returns it: the object's pointer, holding a
    // reference. It has a destructor, so a method returning it is @cppnontrivial.
    export type RefCountPtr = [pointer: Opaque | null];

    // nvrhi::Object by value (getNativeObject, getNativeQueue): the API object's pointer.
    export type NativeObject = [pointer: Opaque | null];

    // nvrhi::MessageSeverity
    export const MESSAGE_SEVERITY_INFO: u8 = 0;
    export const MESSAGE_SEVERITY_WARNING: u8 = 1;
    export const MESSAGE_SEVERITY_ERROR: u8 = 2;
    export const MESSAGE_SEVERITY_FATAL: u8 = 3;

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

    // nvrhi::ShaderType (a bit mask)
    export const SHADER_TYPE_COMPUTE: u16 = 0x20;

    // nvrhi::ResourceType
    export const RESOURCE_TYPE_NONE: u8 = 0;
    export const RESOURCE_TYPE_TEXTURE_SRV: u8 = 1;
    export const RESOURCE_TYPE_TEXTURE_UAV: u8 = 2;
    export const RESOURCE_TYPE_TYPED_BUFFER_SRV: u8 = 3;
    export const RESOURCE_TYPE_TYPED_BUFFER_UAV: u8 = 4;
    export const RESOURCE_TYPE_STRUCTURED_BUFFER_SRV: u8 = 5;
    export const RESOURCE_TYPE_STRUCTURED_BUFFER_UAV: u8 = 6;
    export const RESOURCE_TYPE_RAW_BUFFER_SRV: u8 = 7;
    export const RESOURCE_TYPE_RAW_BUFFER_UAV: u8 = 8;
    export const RESOURCE_TYPE_CONSTANT_BUFFER: u8 = 9;
    export const RESOURCE_TYPE_VOLATILE_CONSTANT_BUFFER: u8 = 10;
    export const RESOURCE_TYPE_SAMPLER: u8 = 11;

    // nvrhi::ObjectTypes (some)
    export const OBJECT_TYPE_D3D11_DEVICE: u32 = 0x00010001;
    export const OBJECT_TYPE_D3D12_DEVICE: u32 = 0x00020001;
    export const OBJECT_TYPE_D3D12_COMMAND_QUEUE: u32 = 0x00020002;
    export const OBJECT_TYPE_D3D12_RESOURCE: u32 = 0x00020004;
    export const OBJECT_TYPE_VK_DEVICE: u32 = 0x00030001;
    export const OBJECT_TYPE_VK_QUEUE: u32 = 0x00030004;
    export const OBJECT_TYPE_VK_IMAGE: u32 = 0x00030008;
}
