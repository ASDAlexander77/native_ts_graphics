/// <reference path="../donut_handles.d.ts" />
/// <reference path="resources.d.ts" />
// Shaders, graphics/meshlet/compute pipelines and their descriptions, input layouts and
// variable-rate shading

// nvrhi::VariableShadingRate values: pixels per shading, width x height.
enum VariableShadingRate {
    Rate1x1 = 0,
    Rate1x2 = 1,
    Rate2x1 = 2,
    Rate2x2 = 3,
    Rate2x4 = 4,
    Rate4x2 = 5,
    Rate4x4 = 6
}

// nvrhi::ShadingRateCombiner values (Vulkan's VkFragmentShadingRateCombinerOpKHR).
enum ShadingRateCombiner {
    Passthrough = 0, // KEEP
    Override = 1, // REPLACE
    Min = 2,
    Max = 3,
    ApplyRelative = 4 // MUL
}

// nvrhi::PrimitiveType values (only the ones used so far).
enum PrimitiveType {
    PointList = 0,
    LineList = 1,
    LineStrip = 2,
    TriangleList = 3,
    TriangleStrip = 4,
    PatchList = 8
}

// nvrhi::RasterCullMode values.
enum CullMode {
    Back = 0,
    Front = 1,
    None = 2
}

// nvrhi::RasterFillMode values.
enum FillMode {
    Solid = 0,
    Wireframe = 1
}

// The framebuffer blending of Donut_CreateGraphicsPipelineWithBlend.
enum BlendMode {
    None = 0,
    // Color One + One, alpha SrcAlpha + DstAlpha.
    Additive = 1,
    // Color SrcAlpha + InvSrcAlpha, alpha InvSrcAlpha + Zero.
    AlphaBlend = 2,
    // Color SrcAlpha + InvSrcAlpha, alpha One + InvSrcAlpha ("over").
    AlphaOver = 3,
    // Premultiplied alpha: color and alpha One + InvSrcAlpha.
    Premultiplied = 4
}

// nvrhi::BlendFactor values (D3D's numbering; Vulkan's names in the comments).
enum BlendFactor {
    Zero = 1,
    One = 2,
    SrcColor = 3,
    InvSrcColor = 4, // ONE_MINUS_SRC_COLOR
    SrcAlpha = 5,
    InvSrcAlpha = 6, // ONE_MINUS_SRC_ALPHA
    DstAlpha = 7,
    InvDstAlpha = 8, // ONE_MINUS_DST_ALPHA
    DstColor = 9,
    InvDstColor = 10, // ONE_MINUS_DST_COLOR
    SrcAlphaSaturate = 11,
    // The graphics state's blend constant (0 in Donut's draws).
    ConstantColor = 14,
    InvConstantColor = 15 // ONE_MINUS_CONSTANT_COLOR
}

// nvrhi::BlendOp values.
enum BlendOp {
    Add = 1,
    Subtract = 2,
    ReverseSubtract = 3,
    Min = 4,
    Max = 5
}

// How lines are rasterized (Donut_GraphicsPipelineSetLineRasterization): Vulkan's
// VkLineRasterizationModeEXT.
enum LineRasterizationMode {
    Default = 0,
    Rectangular = 1,
    Bresenham = 2,
    Smooth = 3
}

// Logic operations between a pixel shader's output (s) and the target's bits (d)
// (Donut_GraphicsPipelineSetLogicOp): nvrhi::LogicOp, in Vulkan's order.
enum LogicOp {
    Clear = 0, // 0
    And = 1, // s & d
    AndReverse = 2, // s & ~d
    Copy = 3, // s
    AndInverted = 4, // ~s & d
    NoOp = 5, // d
    Xor = 6, // s ^ d
    Or = 7, // s | d
    Nor = 8, // ~(s | d)
    Equivalent = 9, // ~(s ^ d)
    Invert = 10, // ~d
    OrReverse = 11, // s | ~d
    CopyInverted = 12, // ~s
    OrInverted = 13, // ~s | d
    Nand = 14, // ~(s & d)
    Set = 15 // all ones
}

// nvrhi::ColorMask bits: the channels a pipeline writes (Donut_GraphicsPipelineSetColorWriteMask).
enum ColorMask {
    None = 0,
    Red = 1,
    Green = 2,
    Blue = 4,
    Alpha = 8,
    All = 15
}

// nvrhi::ShaderType values.
enum ShaderType {
    Vertex = 0x0001,
    Hull = 0x0002,
    Domain = 0x0004,
    Geometry = 0x0008,
    Pixel = 0x0010,
    Compute = 0x0020,
    Amplification = 0x0040,
    Mesh = 0x0080,
    RayGeneration = 0x0100,
    AnyHit = 0x0200,
    ClosestHit = 0x0400,
    Miss = 0x0800,
    Intersection = 0x1000,
    Callable = 0x2000,
    All = 0x3FFF
}

// Resources are owned by the app until released or the app is destroyed; null on failure.
// Shaders come from the example's shaders/<example>.cfg, compiled at build time.
@nodrops declare function Donut_CreateShader(app: AppHandle, fileName: string, entryName: string, shaderType: ShaderType): ShaderHandle;
// Specializes one constant ([[vk::constant_id(constantId)]] in HLSL) of a SPIR-V shader;
// requires Feature.ShaderSpecializations (Vulkan only). The UInt variant uses value's bits as-is.
@nodrops declare function Donut_SpecializeShaderFloat(app: AppHandle, shader: ShaderHandle, constantId: int, value: number): ShaderHandle;
@nodrops declare function Donut_SpecializeShaderUInt(app: AppHandle, shader: ShaderHandle, constantId: int, value: int): ShaderHandle;
// Shader library, compiled with -T lib.
@nodrops declare function Donut_CreateShaderLibrary(app: AppHandle, fileName: string): ShaderLibraryHandle;
// The permutations compiled with -D defineName=defineValue in the .cfg.
@nodrops declare function Donut_CreateShaderWithDefine(app: AppHandle, fileName: string, entryName: string, shaderType: ShaderType,
    defineName: string, defineValue: string): ShaderHandle;
@nodrops declare function Donut_CreateShaderLibraryWithDefine(app: AppHandle, fileName: string, defineName: string, defineValue: string): ShaderLibraryHandle;
// Same with several defines, "NAME=value;NAME=value".
@nodrops declare function Donut_CreateShaderLibraryWithDefines(app: AppHandle, fileName: string, defines: string): ShaderLibraryHandle;
// Triangle list, no depth test, for the frame's framebuffer layout.
@nodrops declare function Donut_CreateGraphicsPipeline(app: AppHandle, frame: FrameHandle, vertexShader: ShaderHandle, pixelShader: ShaderHandle): GraphicsPipelineHandle;
// Same, with an input layout and one binding layout.
@nodrops declare function Donut_CreateGraphicsPipelineWithLayouts(app: AppHandle, frame: FrameHandle, vertexShader: ShaderHandle, pixelShader: ShaderHandle, inputLayout: InputLayoutHandle, bindingLayout: BindingLayoutHandle): GraphicsPipelineHandle;
// Same, drawing primitiveType, with each layout optional (null for none).
@nodrops declare function Donut_CreateGraphicsPipelineWithTopology(app: AppHandle, frame: FrameHandle, vertexShader: ShaderHandle, pixelShader: ShaderHandle,
    inputLayout: InputLayoutHandle | null, bindingLayout: BindingLayoutHandle | null, primitiveType: PrimitiveType): GraphicsPipelineHandle;
// Same, blending into the framebuffer with blendMode.
@nodrops declare function Donut_CreateGraphicsPipelineWithBlend(app: AppHandle, frame: FrameHandle, vertexShader: ShaderHandle, pixelShader: ShaderHandle,
    inputLayout: InputLayoutHandle | null, bindingLayout: BindingLayoutHandle | null, primitiveType: PrimitiveType, blendMode: BlendMode): GraphicsPipelineHandle;
// Same, with amplification + mesh + pixel shaders; requires Feature.Meshlets.
@nodrops declare function Donut_CreateMeshletPipeline(app: AppHandle, frame: FrameHandle, amplificationShader: ShaderHandle, meshShader: ShaderHandle, pixelShader: ShaderHandle): MeshletPipelineHandle;

// Non-zero if shaders' printf output reaches Donut_UpdateShaderPrintfOutput: Vulkan apps created
// with AppOptions.ShaderPrintf where the validation layer is installed (not D3D).
@nodrops declare function Donut_HasShaderPrintf(app: AppHandle): int;
// Takes the shaders' printf messages the validation layer delivered since the last call (once the
// GPU finished the commands that printed them); returns their count.
@nodrops declare function Donut_UpdateShaderPrintfOutput(app: AppHandle): int;
// The index-th message the last Donut_UpdateShaderPrintfOutput took (the layer's text, ending in
// the shader's formatted output); valid until the next Donut_UpdateShaderPrintfOutput.
@nodrops declare function Donut_GetShaderPrintfLine(app: AppHandle, index: int): string;
// Triangle list for a framebuffer's layout, NVRHI's default render state: depth test (less) and
// writes, back faces culled (clockwise triangles are front faces).
@nodrops declare function Donut_CreateGraphicsPipelineForFramebuffer(app: AppHandle, framebuffer: FramebufferHandle, vertexShader: ShaderHandle,
    pixelShader: ShaderHandle, inputLayout: InputLayoutHandle, bindingLayout: BindingLayoutHandle): GraphicsPipelineHandle;
// Graphics pipelines of any shape: a description built with the Donut_GraphicsPipeline* functions,
// freed by Donut_CreateGraphicsPipelineFromDesc. It starts as a triangle list with NVRHI's default
// render state: depth test (less) and writes, back faces culled (clockwise triangles are front
// faces), solid fill, no blending.
// A null pixel shader: depth only (e.g. a shadow map's pass).
@nodrops declare function Donut_CreateGraphicsPipelineDesc(vertexShader: ShaderHandle, pixelShader: ShaderHandle | null): GraphicsPipelineDescHandle;
// Same, for a meshlet pipeline (Donut_CreateMeshletPipelineFromDesc): amplification (null for none),
// mesh and pixel shaders, the rest set with the same functions. Its primitive type is what the mesh
// shader outputs (its outputtopology).
@nodrops declare function Donut_CreateMeshletPipelineDesc(amplificationShader: ShaderHandle | null, meshShader: ShaderHandle, pixelShader: ShaderHandle): GraphicsPipelineDescHandle;
@nodrops declare function Donut_GraphicsPipelineAddBindingLayout(graphicsPipelineDesc: GraphicsPipelineDescHandle, bindingLayout: BindingLayoutHandle): void;
@nodrops declare function Donut_GraphicsPipelineSetInputLayout(graphicsPipelineDesc: GraphicsPipelineDescHandle, inputLayout: InputLayoutHandle): void;
@nodrops declare function Donut_GraphicsPipelineSetPrimitiveType(graphicsPipelineDesc: GraphicsPipelineDescHandle, primitiveType: PrimitiveType): void;
// A geometry shader between the vertex (or domain) shader and the rasterizer.
@nodrops declare function Donut_GraphicsPipelineSetGeometryShader(graphicsPipelineDesc: GraphicsPipelineDescHandle, geometryShader: ShaderHandle): void;
// Hull and domain shaders, drawing patches of controlPoints vertices.
@nodrops declare function Donut_GraphicsPipelineSetTessellation(graphicsPipelineDesc: GraphicsPipelineDescHandle, hullShader: ShaderHandle, domainShader: ShaderHandle,
    controlPoints: int): void;
@nodrops declare function Donut_GraphicsPipelineSetDepthState(graphicsPipelineDesc: GraphicsPipelineDescHandle, testEnable: int, writeEnable: int,
    depthFunc: ComparisonFunc): void;
// The depth bounds test: pixels whose depth target value is outside the draw's bounds
// (Donut_DrawSetDepthBounds) are discarded (requires Donut_HasDepthBoundsTest).
@nodrops declare function Donut_GraphicsPipelineSetDepthBoundsTest(graphicsPipelineDesc: GraphicsPipelineDescHandle, enable: boolean): void;
@nodrops declare function Donut_GraphicsPipelineSetRasterState(graphicsPipelineDesc: GraphicsPipelineDescHandle, cullMode: CullMode, fillMode: FillMode,
    frontCounterClockwise: int): void;
// Whether draws are clipped to their scissor rectangle (Donut_DrawSetScissor; D3D needs it on).
@nodrops declare function Donut_GraphicsPipelineSetScissorEnable(graphicsPipelineDesc: GraphicsPipelineDescHandle, enable: boolean): void;
// Primitives clipped at the near and far planes (as Vulkan by default), or not (the default here:
// on D3D what lies beyond them is drawn, its depth clamped).
@nodrops declare function Donut_GraphicsPipelineSetDepthClip(graphicsPipelineDesc: GraphicsPipelineDescHandle, enable: boolean): void;
// depthBias units of the depth format's resolution plus slopeScaledDepthBias times the depth
// slope, clamped to depthBiasClamp in magnitude (0: no clamp).
@nodrops declare function Donut_GraphicsPipelineSetDepthBias(graphicsPipelineDesc: GraphicsPipelineDescHandle, depthBias: int, depthBiasClamp: number,
    slopeScaledDepthBias: number): void;
// Blending of every color target.
@nodrops declare function Donut_GraphicsPipelineSetBlendMode(graphicsPipelineDesc: GraphicsPipelineDescHandle, blendMode: BlendMode): void;
// Blending of every color target, on or off, by the blend factors and operations of the color and
// of the alpha; the color write mask stays.
@nodrops declare function Donut_GraphicsPipelineSetBlendState(graphicsPipelineDesc: GraphicsPipelineDescHandle, enable: boolean, srcBlend: BlendFactor,
    destBlend: BlendFactor, blendOp: BlendOp, srcBlendAlpha: BlendFactor, destBlendAlpha: BlendFactor, blendOpAlpha: BlendOp): void;
// An advanced blend operation for the targets that blend, instead of their factors and operations
// (Vulkan, with Donut_GetAdvancedBlendOperations): its number from VK_BLEND_OP_ZERO_EXT (0 Zero ...
// 45 Blue, -1 for none), whether the source and destination colors are premultiplied by their
// alpha, and how they overlap (0 uncorrelated, 1 disjoint, 2 conjoint).
@nodrops declare function Donut_GraphicsPipelineSetAdvancedBlendOp(graphicsPipelineDesc: GraphicsPipelineDescHandle, advancedBlendOp: int,
    srcPremultiplied: int, dstPremultiplied: int, overlap: int): void;
// A logic operation between the pixel shader's output and the targets' bits instead of blending
// (requires Donut_HasLogicOps; UINT and UNORM targets).
@nodrops declare function Donut_GraphicsPipelineSetLogicOp(graphicsPipelineDesc: GraphicsPipelineDescHandle, enable: boolean, logicOp: LogicOp): void;
// Conservative rasterization (requires Feature.ConservativeRasterization): every pixel a triangle
// touches is drawn; extraOverestimation enlarges triangles further, in pixels, on Vulkan only
// (clamped to the device's maximum).
@nodrops declare function Donut_GraphicsPipelineSetConservativeRaster(graphicsPipelineDesc: GraphicsPipelineDescHandle, enable: boolean, extraOverestimation: number): void;
// Primitive restart: strips restart at the largest index of indexFormat (R16_UINT: 0xFFFF, R32_UINT:
// 0xFFFFFFFF; UNKNOWN for none), the format of the index buffers the pipeline draws with (D3D12
// needs it; D3D11 always restarts strips).
@nodrops declare function Donut_GraphicsPipelineSetPrimitiveRestart(graphicsPipelineDesc: GraphicsPipelineDescHandle, indexFormat: Format): void;
// How lines are drawn: their rasterization mode (one Donut_GetLineRasterizationModes has), width (up to
// Donut_GetMaxLineWidth) and stipple (stippleEnable non-zero, with the mode's stippled bit: each bit
// of the 16-bit pattern, from the lowest, a run of stippleFactor pixels drawn if set). D3D has no
// width or stipple.
@nodrops declare function Donut_GraphicsPipelineSetLineRasterization(graphicsPipelineDesc: GraphicsPipelineDescHandle, mode: LineRasterizationMode,
    width: number, stippleEnable: int, stippleFactor: int, stipplePattern: int): void;
// The channels every color target writes (ColorMask bits; None for a pass that only writes UAVs).
@nodrops declare function Donut_GraphicsPipelineSetColorWriteMask(graphicsPipelineDesc: GraphicsPipelineDescHandle, mask: ColorMask): void;
// The channels one render target (SV_Target<target>) is written in (0 writes nothing to it).
@nodrops declare function Donut_GraphicsPipelineSetTargetColorWriteMask(graphicsPipelineDesc: GraphicsPipelineDescHandle, target: int, mask: ColorMask): void;
// For a framebuffer's layout.
@nodrops declare function Donut_CreateGraphicsPipelineFromDesc(app: AppHandle, graphicsPipelineDesc: GraphicsPipelineDescHandle, framebuffer: FramebufferHandle): GraphicsPipelineHandle;
// Same, for the frame's framebuffer (the back buffer's layout).
@nodrops declare function Donut_CreateGraphicsPipelineFromDescForFrame(app: AppHandle, graphicsPipelineDesc: GraphicsPipelineDescHandle, frame: FrameHandle): GraphicsPipelineHandle;
// A meshlet pipeline from a Donut_CreateMeshletPipelineDesc description, for a framebuffer's layout,
// or the frame's; requires Feature.Meshlets.
@nodrops declare function Donut_CreateMeshletPipelineFromDesc(app: AppHandle, graphicsPipelineDesc: GraphicsPipelineDescHandle, framebuffer: FramebufferHandle): MeshletPipelineHandle;
@nodrops declare function Donut_CreateMeshletPipelineFromDescForFrame(app: AppHandle, graphicsPipelineDesc: GraphicsPipelineDescHandle, frame: FrameHandle): MeshletPipelineHandle;

// Built up with Donut_AddVertexAttribute, then consumed (freed) by Donut_CreateInputLayout.
@nodrops declare function Donut_CreateInputLayoutDesc(): InputLayoutDescHandle;
// Vertex shader input `name` (its semantic), read from vertex buffer slot bufferIndex at byte
// offset `offset` of each elementStride-byte element.
@nodrops declare function Donut_AddVertexAttribute(inputLayoutDesc: InputLayoutDescHandle, name: string, format: Format, offset: int, bufferIndex: int, elementStride: int): void;
// Same, read once per instance instead of once per vertex.
@nodrops declare function Donut_AddInstanceVertexAttribute(inputLayoutDesc: InputLayoutDescHandle, name: string, format: Format, offset: int, bufferIndex: int, elementStride: int): void;
@nodrops declare function Donut_CreateInputLayout(app: AppHandle, inputLayoutDesc: InputLayoutDescHandle, vertexShader: ShaderHandle): InputLayoutHandle;
// Uses the layout of bindingSet.
@nodrops declare function Donut_CreateComputePipeline(app: AppHandle, computeShader: ShaderHandle, bindingSet: BindingSetHandle): ComputePipelineHandle;
// Same, from a binding layout.
@nodrops declare function Donut_CreateComputePipelineWithLayout(app: AppHandle, computeShader: ShaderHandle, bindingLayout: BindingLayoutHandle): ComputePipelineHandle;
// Same, with a second binding layout (e.g. bindless; null for none).
@nodrops declare function Donut_CreateComputePipelineWithLayouts(app: AppHandle, computeShader: ShaderHandle, bindingLayout: BindingLayoutHandle,
    secondBindingLayout: BindingLayoutHandle | null): ComputePipelineHandle;

// Variable rate shading. Pixels per shading rate surface texel, as NVRHI reports it, or (the
// second one) straight from D3D12, 0 on other APIs.
@nodrops declare function Donut_GetShadingRateTileSize(app: AppHandle): int;
// R8_UINT surface of width x height tiles, written by compute shaders as RWTexture2D<uint>.
@nodrops declare function Donut_CreateShadingRateSurface(app: AppHandle, width: int, height: int): TextureHandle;
// The fragment sizes (shading rates) the device has, as width, height pairs into dst (Ref of a
// `let` int array of 32), largest first (Vulkan's order; D3D12's tier rates); returns their count,
// 0 without variable rate shading.
@nodrops declare function Donut_GetFragmentShadingRates(app: AppHandle, dst: Ref<int>): int;
// Variable rate shading in a pipeline: its draws take the draw state's shading rate
// (Donut_DrawSetVariableRateShading) combined with the framebuffer's shading rate surface.
@nodrops declare function Donut_GraphicsPipelineSetVariableRateShading(graphicsPipelineDesc: GraphicsPipelineDescHandle, enabled: boolean): void;
// Framebuffer of one or two color targets (colorTexture1 null for one) and a depth buffer (null for
// none) whose draws can take their shading rates from shadingRateSurface (null for none).
@nodrops declare function Donut_CreateFramebufferWithShadingRate(app: AppHandle, colorTexture0: TextureHandle, colorTexture1: TextureHandle | null,
    depthTexture: TextureHandle | null, shadingRateSurface: TextureHandle | null): FramebufferHandle;
// enabled != 0: the view's draws use the framebuffer's shading rate surface alone; 0: full rate.
@nodrops declare function Donut_SetViewVariableRateShading(view: ViewHandle, enabled: boolean): void;
// Drops the cached compiled shaders: passes created after this load them from disk again.
@nodrops declare function Donut_ClearShaderCache(app: AppHandle): void;
