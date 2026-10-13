// NVRHI's constants, and the records its methods return by value, for core/nvrhi.ts: the same under
// every C++ ABI the project builds with (MSVC x64, and the Itanium ABI of Android's clang). The
// classes and the structs they take are generated for each ABI in core/nvrhi_classes.<os>.ts.

/// <reference path="donut_interop.d.ts" />

export namespace nvrhi {

    // nvrhi::RefCountPtr<T> by value: the object's pointer, holding a reference. It has a
    // destructor, so a method returning it is @cppnontrivial; returned, its T is Opaque.
    export type RefCountPtr<T> = [ptr_: T | null];

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
    export const TEXTURE_DIMENSION_2D_MS: u8 = 7;

    // nvrhi::Feature (some)
    export const FEATURE_COMPUTE_QUEUE: u8 = 0;

    // nvrhi::ResourceStates (some)
    export const RESOURCE_STATE_UNKNOWN: u32 = 0;
    export const RESOURCE_STATE_COMMON: u32 = 0x1;
    export const RESOURCE_STATE_CONSTANT_BUFFER: u32 = 0x2;
    export const RESOURCE_STATE_VERTEX_BUFFER: u32 = 0x4;
    export const RESOURCE_STATE_INDEX_BUFFER: u32 = 0x8;
    export const RESOURCE_STATE_INDIRECT_ARGUMENT: u32 = 0x10;
    export const RESOURCE_STATE_SHADER_RESOURCE: u32 = 0x60;
    export const RESOURCE_STATE_UNORDERED_ACCESS: u32 = 0x80;
    export const RESOURCE_STATE_RENDER_TARGET: u32 = 0x100;
    export const RESOURCE_STATE_DEPTH_WRITE: u32 = 0x200;
    export const RESOURCE_STATE_COPY_DEST: u32 = 0x1000;
    export const RESOURCE_STATE_COPY_SOURCE: u32 = 0x2000;

    // nvrhi::ShaderType (a bit mask)
    export const SHADER_TYPE_VERTEX: u16 = 0x01;
    export const SHADER_TYPE_PIXEL: u16 = 0x10;
    export const SHADER_TYPE_COMPUTE: u16 = 0x20;

    // nvrhi::SamplerAddressMode (some)
    export const SAMPLER_ADDRESS_CLAMP: u8 = 0;
    export const SAMPLER_ADDRESS_WRAP: u8 = 1;

    // nvrhi::RasterCullMode
    export const CULL_BACK: u8 = 0;
    export const CULL_FRONT: u8 = 1;
    export const CULL_NONE: u8 = 2;

    // nvrhi::ComparisonFunc (some)
    export const COMPARISON_EQUAL: u8 = 3;
    export const COMPARISON_ALWAYS: u8 = 8;

    // nvrhi::StencilOp (some)
    export const STENCIL_OP_KEEP: u8 = 1;
    export const STENCIL_OP_REPLACE: u8 = 3;

    // nvrhi::BlendFactor (some)
    export const BLEND_ZERO: u8 = 1;
    export const BLEND_ONE: u8 = 2;
    export const BLEND_SRC_ALPHA: u8 = 5;
    export const BLEND_INV_SRC_ALPHA: u8 = 6;

    // nvrhi::BlendOp (some)
    export const BLEND_OP_ADD: u8 = 1;

    // nvrhi::ColorMask
    export const COLOR_MASK_RED: u8 = 1;
    export const COLOR_MASK_GREEN: u8 = 2;
    export const COLOR_MASK_BLUE: u8 = 4;
    export const COLOR_MASK_ALPHA: u8 = 8;
    export const COLOR_MASK_ALL: u8 = 0xf;

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
    export const RESOURCE_TYPE_PUSH_CONSTANTS: u8 = 13;

    // nvrhi::ObjectTypes (some)
    export const OBJECT_TYPE_D3D11_DEVICE: u32 = 0x00010001;
    export const OBJECT_TYPE_D3D12_DEVICE: u32 = 0x00020001;
    export const OBJECT_TYPE_D3D12_COMMAND_QUEUE: u32 = 0x00020002;
    export const OBJECT_TYPE_D3D12_RESOURCE: u32 = 0x00020004;
    export const OBJECT_TYPE_VK_DEVICE: u32 = 0x00030001;
    export const OBJECT_TYPE_VK_QUEUE: u32 = 0x00030004;
    export const OBJECT_TYPE_VK_IMAGE: u32 = 0x00030008;
}
