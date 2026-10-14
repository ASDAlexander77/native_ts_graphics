// NVRHI's interfaces, called directly: nvrhi::IDevice, ICommandList, IBuffer, ITexture and the other
// nvrhi::I* classes as tslang @cpp classes, whose methods are called through the C++ object's own
// vtable. Import with `import { nvrhi } from "../core/nvrhi";` (from examples/) and list
// NVRHI_TS_SOURCES in the example's add_tslang_example sources; get the device with
// `<nvrhi.IDevice>app.getNvrhiDevice()`. Donut's handles (donut_handles.d.ts) are these objects'
// pointers: `<nvrhi.IBuffer><Opaque>bufferHandle`, `<BufferHandle><Opaque>buffer`.
//
// The `nvrhi` namespace is made of four modules, as the default library is of lib.ts and
// lib.<os>.ts; the imports of "./nvrhi_abi" and "./nvrhi_classes" take the target's files, for
// the C++ ABI of MSVC x64 on Windows (win32), the Itanium ABI of Android's clang (linux):
// - core/nvrhi_types.ts: the constants, and the records methods return, the same for every ABI;
// - core/nvrhi_classes.<os>.ts: the classes and the structs they take, generated from NVRHI's
//   headers by tools/gen_nvrhi_classes.py (with tsbindgen; run it again after updating NVRHI or
//   tslang): every method with its C++ compiler's slot, every struct with the ABI's layout, the
//   C++ library's std::string (basic_string_char) and std::vector (vector<T>), static_vector
//   (static_vector8<T>, static_vector16<T>) and RefCountPtr<T> included;
// - core/nvrhi_abi.<os>.ts: std::strings and std::vectors made the C++ library's way;
// - this file: the functions below, the same for both.
//
// Objects returned with a reference (createBuffer, createTexture, createShader, createCommandList,
// createComputePipeline, ...) are released with Release().
//
// nvrhi.IMessageCallback is implemented here, not called: a @cpp class extending it whose
// message() has a body is one NVRHI calls (examples/nvrhi_direct.ts' MessageLog). Hand it to
// Donut_SetNvrhiMessageCallback before creating the app, and keep it in a global while the device
// lives: NVRHI holds a pointer the collector doesn't see. The text is NVRHI's, valid during the
// call only.

/// <reference path="donut_interop.d.ts" />

import "./nvrhi_abi";

export namespace nvrhi {

    // Whether this build can call NVRHI through these classes: a C++ ABI they are written for
    // (MSVC x64, Android's clang on x86-64 or AArch64) and the tuples' layouts. Code that also
    // runs elsewhere keeps another path.
    export function supported(): boolean {
        return Donut_CanCallNvrhiDirectly() != 0 && layoutMatches();
    }

    // Whether the tuples have the sizes of the C++ structs: a C++ build with another layout (the
    // debug CRT's std::string) would have NVRHI read the fields at other offsets.
    export function layoutMatches(): boolean {
        return sizeof<BufferDesc>() == Donut_GetNvrhiStructSize("BufferDesc")
            && sizeof<TextureDesc>() == Donut_GetNvrhiStructSize("TextureDesc")
            && sizeof<TextureSubresourceSet>() == Donut_GetNvrhiStructSize("TextureSubresourceSet")
            && sizeof<Color>() == Donut_GetNvrhiStructSize("Color")
            && sizeof<CommandListParameters>() == Donut_GetNvrhiStructSize("CommandListParameters")
            && sizeof<ComputePipelineDesc>() == Donut_GetNvrhiStructSize("ComputePipelineDesc")
            && sizeof<ComputeState>() == Donut_GetNvrhiStructSize("ComputeState")
            && sizeof<BindingLayoutItem>() == Donut_GetNvrhiStructSize("BindingLayoutItem")
            && sizeof<BindingLayoutDesc>() == Donut_GetNvrhiStructSize("BindingLayoutDesc")
            && sizeof<BindingSetItem>() == Donut_GetNvrhiStructSize("BindingSetItem")
            && sizeof<BindingSetDesc>() == Donut_GetNvrhiStructSize("BindingSetDesc")
            && sizeof<ShaderDesc>() == Donut_GetNvrhiStructSize("ShaderDesc")
            && sizeof<FramebufferDesc>() == Donut_GetNvrhiStructSize("FramebufferDesc")
            && sizeof<GraphicsPipelineDesc>() == Donut_GetNvrhiStructSize("GraphicsPipelineDesc")
            && sizeof<GraphicsState>() == Donut_GetNvrhiStructSize("GraphicsState")
            && sizeof<DrawArguments>() == Donut_GetNvrhiStructSize("DrawArguments")
            && sizeof<SamplerDesc>() == Donut_GetNvrhiStructSize("SamplerDesc")
            && sizeof<VertexAttributeDesc>() == Donut_GetNvrhiStructSize("VertexAttributeDesc")
            && sizeof<TextureSlice>() == Donut_GetNvrhiStructSize("TextureSlice")
            && sizeof<HeapDesc>() == Donut_GetNvrhiStructSize("HeapDesc")
            && sizeof<MemoryRequirements>() == Donut_GetNvrhiStructSize("MemoryRequirements")
            && sizeof<BindlessLayoutDesc>() == Donut_GetNvrhiStructSize("BindlessLayoutDesc")
            && sizeof<ShaderSpecialization>() == Donut_GetNvrhiStructSize("ShaderSpecialization")
            && sizeof<MeshletPipelineDesc>() == Donut_GetNvrhiStructSize("MeshletPipelineDesc")
            && sizeof<MeshletState>() == Donut_GetNvrhiStructSize("MeshletState")
            && sizeof<SamplerFeedbackTextureDesc>() == Donut_GetNvrhiStructSize("SamplerFeedbackTextureDesc")
            && sizeof<TextureTilesMapping>() == Donut_GetNvrhiStructSize("TextureTilesMapping")
            && sizeof<TiledTextureCoordinate>() == Donut_GetNvrhiStructSize("TiledTextureCoordinate")
            && sizeof<TiledTextureRegion>() == Donut_GetNvrhiStructSize("TiledTextureRegion")
            && sizeof<PackedMipDesc>() == Donut_GetNvrhiStructSize("PackedMipDesc")
            && sizeof<SubresourceTiling>() == Donut_GetNvrhiStructSize("SubresourceTiling")
            && sizeof<AccelStructDesc>() == Donut_GetNvrhiStructSize("AccelStructDesc")
            && sizeof<GeometryDesc>() == Donut_GetNvrhiStructSize("GeometryDesc")
            && sizeof<InstanceDesc>() == Donut_GetNvrhiStructSize("InstanceDesc")
            && sizeof<AccelStructPrebuildInfo>() == Donut_GetNvrhiStructSize("AccelStructPrebuildInfo")
            && sizeof<PipelineDesc>() == Donut_GetNvrhiStructSize("PipelineDesc")
            && sizeof<PipelineShaderDesc>() == Donut_GetNvrhiStructSize("PipelineShaderDesc")
            && sizeof<PipelineHitGroupDesc>() == Donut_GetNvrhiStructSize("PipelineHitGroupDesc")
            && sizeof<ShaderTableDesc>() == Donut_GetNvrhiStructSize("ShaderTableDesc")
            && sizeof<State>() == Donut_GetNvrhiStructSize("rt::State")
            && sizeof<DispatchRaysArguments>() == Donut_GetNvrhiStructSize("DispatchRaysArguments");
    }

    // A BufferDesc as nvrhi::BufferDesc's defaults make it, with byteSize, a debug name (see
    // stdString), the state NVRHI keeps the buffer in between command lists and CPU access.
    export function bufferDesc(byteSize: int, debugName: string, initialState: u32, cpuAccess: u8): BufferDesc {
        return [byteSize, 0, 0, stdString(debugName),
            0, false, false, false, false, false, false, false, false, false, false, false, false,
            initialState, initialState != RESOURCE_STATE_UNKNOWN, cpuAccess, 0];
    }

    // A 2D TextureDesc as nvrhi::TextureDesc's defaults make it, with its size, format (Donut's
    // Format is NVRHI's), a debug name (see stdString) and the state NVRHI keeps it in.
    export function textureDesc(width: int, height: int, format: Format, debugName: string, initialState: u32): TextureDesc {
        return [width, height, 1, 1, 1, 1, 0, <u8>format, TEXTURE_DIMENSION_2D, stdString(debugName),
            [0, 1, 2, 3], true, false, false, false, false, 0, false, false, [0, 0, 0, 0], false,
            initialState, initialState != RESOURCE_STATE_UNKNOWN];
    }

    // nvrhi::AllSubresources
    export function allSubresources(): TextureSubresourceSet {
        return [0, 0xffffffff, 0, 0xffffffff];
    }

    // nvrhi::CommandListParameters's defaults
    export function commandListParameters(): CommandListParameters {
        return [true, 64 * 1024, 64 * 1024, 1024 * 1024 * 1024, COMMAND_QUEUE_GRAPHICS, null];
    }

    // A ComputePipelineDesc of a shader and one binding layout. Its RefCountPtrs hold no reference
    // here: NVRHI copies the desc, adding the references it keeps, and nothing destroys this one.
    export function computePipelineDesc(shader: IShader, bindingLayout: IBindingLayout): ComputePipelineDesc {
        return [[shader], [[[bindingLayout], [null], [null], [null], [null], [null], [null], [null]], 1]];
    }

    // A ComputeState of a pipeline and one binding set
    export function computeState(pipeline: IComputePipeline, bindingSet: IBindingSet): ComputeState {
        return [pipeline, [[bindingSet, null, null, null, null, null, null, null], 1], null];
    }

    // IDevice::createBuffer; null on failure. Release() it.
    export function createBuffer(device: IDevice, desc: BufferDesc): IBuffer | null {
        let descValue = desc;
        const handle = device.createBuffer(Ref(descValue));
        return handle.ptr_ ? <IBuffer><Opaque>handle.ptr_ : null;
    }

    // IDevice::createTexture; null on failure. Release() it.
    export function createTexture(device: IDevice, desc: TextureDesc): ITexture | null {
        let descValue = desc;
        const handle = device.createTexture(Ref(descValue));
        return handle.ptr_ ? <ITexture><Opaque>handle.ptr_ : null;
    }

    // nvrhi::TextureSlice's defaults: the whole of mip level 0 of array slice 0 (its -1 sizes are the
    // texture's, as TextureSlice::resolve makes them)
    export function entireTexture(): TextureSlice {
        return [0, 0, 0, 0xffffffff, 0xffffffff, 0xffffffff, 0, 0];
    }

    // A TextureSlice of the whole of a mip level of an array slice
    export function subresourceSlice(mipLevel: u32, arraySlice: u32): TextureSlice {
        return [0, 0, 0, 0xffffffff, 0xffffffff, 0xffffffff, mipLevel, arraySlice];
    }

    // A TextureSlice of a width x height region at (x, y) of a mip level of an array slice
    export function textureRegion(x: u32, y: u32, width: u32, height: u32, mipLevel: u32, arraySlice: u32): TextureSlice {
        return [x, y, 0, width, height, 1, mipLevel, arraySlice];
    }

    // IDevice::createStagingTexture: a texture of desc's size and format that the CPU maps with
    // cpuAccess (CPU_ACCESS_READ, CPU_ACCESS_WRITE); null on failure. Release() it.
    export function createStagingTexture(device: IDevice, desc: TextureDesc, cpuAccess: u8): IStagingTexture | null {
        let descValue = desc;
        const handle = device.createStagingTexture(Ref(descValue), cpuAccess);
        return handle.ptr_ ? <IStagingTexture><Opaque>handle.ptr_ : null;
    }

    // IDevice::mapStagingTexture: the slice's first byte, its rows rowPitch bytes apart; null on
    // failure. unmapStagingTexture it.
    export function mapStagingTexture(device: IDevice, texture: IStagingTexture, slice: TextureSlice, cpuAccess: u8,
        rowPitch: Ref<index>): Opaque | null {
        let sliceValue = slice;
        return device.mapStagingTexture(texture, Ref(sliceValue), cpuAccess, rowPitch);
    }

    // ICommandList::copyTexture between two textures
    export function copyTexture(commandList: ICommandList, dest: ITexture, destSlice: TextureSlice,
        src: ITexture, srcSlice: TextureSlice): void {
        // (passed as the overload's `| null`: a class fits no overload, TSLANG_ISSUES.md #19)
        const destArg: ITexture | null = dest;
        const srcArg: ITexture | null = src;
        let destSliceValue = destSlice;
        let srcSliceValue = srcSlice;
        commandList.copyTexture(destArg, Ref(destSliceValue), srcArg, Ref(srcSliceValue));
    }

    // ICommandList::copyTexture of a texture into a staging texture, to read it back
    export function copyTextureToStaging(commandList: ICommandList, dest: IStagingTexture, destSlice: TextureSlice,
        src: ITexture, srcSlice: TextureSlice): void {
        // (as in copyTexture: TSLANG_ISSUES.md #19)
        const destArg: IStagingTexture | null = dest;
        const srcArg: ITexture | null = src;
        let destSliceValue = destSlice;
        let srcSliceValue = srcSlice;
        commandList.copyTexture(destArg, Ref(destSliceValue), srcArg, Ref(srcSliceValue));
    }

    // ICommandList::resolveTexture: a multisampled texture's samples averaged into a texture, all
    // their subresources
    export function resolveTexture(commandList: ICommandList, dest: ITexture, src: ITexture): void {
        let destSubresources = allSubresources();
        let srcSubresources = allSubresources();
        commandList.resolveTexture(dest, Ref(destSubresources), src, Ref(srcSubresources));
    }

    // ICommandList::copyTexture of a staging texture into a texture, to upload it
    export function copyTextureFromStaging(commandList: ICommandList, dest: ITexture, destSlice: TextureSlice,
        src: IStagingTexture, srcSlice: TextureSlice): void {
        // (as in copyTexture: TSLANG_ISSUES.md #19)
        const destArg: ITexture | null = dest;
        const srcArg: IStagingTexture | null = src;
        let destSliceValue = destSlice;
        let srcSliceValue = srcSlice;
        commandList.copyTexture(destArg, Ref(destSliceValue), srcArg, Ref(srcSliceValue));
    }

    // A ShaderDesc as nvrhi::ShaderDesc's defaults make it, with the shader's stage (SHADER_TYPE_*),
    // a debug name and its entry point's name (see stdString).
    export function shaderDesc(shaderType: u16, debugName: string, entryName: string): ShaderDesc {
        return [shaderType, stdString(debugName), stdString(entryName), -1, false, 0, null, 0, null];
    }

    // IDevice::createShader of the API's bytecode (DXIL, SPIR-V: a file ShaderMake compiled, without
    // permutations), which NVRHI copies; null on failure. Release() it.
    export function createShader(device: IDevice, desc: ShaderDesc, bytecode: Opaque, byteSize: index): IShader | null {
        let descValue = desc;
        const handle = device.createShader(Ref(descValue), bytecode, byteSize);
        return handle.ptr_ ? <IShader><Opaque>handle.ptr_ : null;
    }

    // nvrhi::BindingLayoutItem's initializers (Texture_SRV(slot), TypedBuffer_UAV(slot), ...): a
    // resource of a type in a slot, an array of one. Its type, unused byte and size are bit fields
    // of one 32-bit word.
    export function bindingLayoutItem(slot: u32, type: u8): BindingLayoutItem {
        return [slot, [<u32>type + 0x10000]];
    }

    // nvrhi::BindingSetItem::TypedBuffer_SRV and the like (a buffer of the type's kind in a slot), the
    // whole buffer, its format the buffer's. The type, the texture dimension (0), the format (0), and
    // an unused byte are bit fields of one word; the buffer range (offset 0, size ~0, which
    // BufferRange resolves to the buffer's) shares its bytes with a texture's subresources.
    export function bufferBindingSetItem(slot: u32, type: u8, buffer: IBuffer): BindingSetItem {
        return [buffer, slot, 0, [<u32>type], 0, 0, [0, 0xffffffffffffffff]];
    }

    // nvrhi::BindingSetItem::Texture_SRV(slot, texture): all its mips and array slices
    // (AllSubresources, two u32s in each of the union's words), its own format and dimension
    export function textureBindingSetItem(slot: u32, texture: ITexture): BindingSetItem {
        return [texture, slot, 0, [<u32>RESOURCE_TYPE_TEXTURE_SRV], 0, 0, [0xffffffff00000000, 0xffffffff00000000]];
    }

    // nvrhi::BindingSetItem::Texture_UAV(slot, texture): mip level 0 (one level) of all its array
    // slices, its own format and dimension
    export function textureUavBindingSetItem(slot: u32, texture: ITexture): BindingSetItem {
        return [texture, slot, 0, [<u32>RESOURCE_TYPE_TEXTURE_UAV], 0, 0, [0x100000000, 0xffffffff00000000]];
    }

    // nvrhi::BindingSetItem::Sampler(slot, sampler)
    export function samplerBindingSetItem(slot: u32, sampler: ISampler): BindingSetItem {
        return [sampler, slot, 0, [<u32>RESOURCE_TYPE_SAMPLER], 0, 0, [0, 0]];
    }

    // nvrhi::BindingLayoutItem::PushConstants(slot, byteSize): byteSize bytes of push constants
    // (D3D12 root constants), the size in the word's top 16 bits
    export function pushConstantsLayoutItem(slot: u32, byteSize: u32): BindingLayoutItem {
        return [slot, [<u32>RESOURCE_TYPE_PUSH_CONSTANTS + byteSize * 0x10000]];
    }

    // nvrhi::BindingSetItem::PushConstants(slot, byteSize): no resource, the size in the buffer range
    export function pushConstantsBindingSetItem(slot: u32, byteSize: u32): BindingSetItem {
        return [null, slot, 0, [<u32>RESOURCE_TYPE_PUSH_CONSTANTS], 0, 0, [0, byteSize]];
    }

    // IDevice::createBindingLayout of the items, visible to the shader stages in visibility
    // (SHADER_TYPE_*); null on failure. Release() it.
    export function createBindingLayout(device: IDevice, visibility: u16, items: BindingLayoutItem[]): IBindingLayout | null {
        let desc: BindingLayoutDesc = [visibility, 0, false, stdVector(items), [0, 128, 256, 384]];
        const handle = device.createBindingLayout(Ref(desc));
        const layout = handle.ptr_ ? <IBindingLayout><Opaque>handle.ptr_ : null;
        return layout;
    }

    // IDevice::createBindingSet of the items on the layout, which NVRHI keeps alive; null on
    // failure. Release() it.
    export function createBindingSet(device: IDevice, layout: IBindingLayout, items: BindingSetItem[]): IBindingSet | null {
        let desc: BindingSetDesc = [stdVector(items), true];
        const handle = device.createBindingSet(Ref(desc), layout);
        const set = handle.ptr_ ? <IBindingSet><Opaque>handle.ptr_ : null;
        return set;
    }

    // A FramebufferAttachment of the texture's first mip and array slice in its own format (null:
    // none)
    function framebufferAttachment(texture: ITexture | null): FramebufferAttachment {
        return [texture, [0, 1, 0, 1], 0, false];
    }

    // Color attachment i of a FramebufferDesc of colorTextures: none past the last
    function colorAttachment(colorTextures: ITexture[], i: int): FramebufferAttachment {
        return framebufferAttachment(i < colorTextures.length ? colorTextures[i] : null);
    }

    // A FramebufferDesc of up to 8 color attachments (render targets 0, 1, ... in order) and up to
    // one depth attachment (null: none), as nvrhi::FramebufferDesc().addColorAttachment(...)
    // .setDepthAttachment(depthTexture) makes it.
    export function framebufferDesc(colorTextures: ITexture[], depthTexture: ITexture | null): FramebufferDesc {
        const none = framebufferAttachment(null);
        return [[[colorAttachment(colorTextures, 0), colorAttachment(colorTextures, 1), colorAttachment(colorTextures, 2),
            colorAttachment(colorTextures, 3), colorAttachment(colorTextures, 4), colorAttachment(colorTextures, 5),
            colorAttachment(colorTextures, 6), colorAttachment(colorTextures, 7)], <index>Math.min(colorTextures.length, 8)],
            framebufferAttachment(depthTexture), none,
            [[none, none, none, none, none, none, none, none], 0], none, 0];
    }

    // nvrhi::SamplerDesc's defaults: linear filtering, clamped, border color white
    export function samplerDesc(): SamplerDesc {
        return [[1, 1, 1, 1], 1, 0, true, true, true, SAMPLER_ADDRESS_CLAMP, SAMPLER_ADDRESS_CLAMP, SAMPLER_ADDRESS_CLAMP,
            0, 0, 3.402823466e+38];
    }

    // IDevice::createSampler; null on failure. Release() it.
    export function createSampler(device: IDevice, desc: SamplerDesc): ISampler | null {
        let descValue = desc;
        const handle = device.createSampler(Ref(descValue));
        return handle.ptr_ ? <ISampler><Opaque>handle.ptr_ : null;
    }

    // A VertexAttributeDesc: the shader input's semantic name (see stdString), its format (Donut's
    // Format is NVRHI's), the vertex buffer slot it is read from, its offset there and the
    // vertex's stride
    export function vertexAttributeDesc(name: string, format: Format, bufferIndex: u32, offset: u32, elementStride: u32): VertexAttributeDesc {
        return [stdString(name), <u8>format, 1, bufferIndex, offset, elementStride, false];
    }

    // IDevice::createInputLayout of the attributes, for the vertex shader; null on failure.
    // Release() it.
    export function createInputLayout(device: IDevice, attributes: VertexAttributeDesc[], vertexShader: IShader): IInputLayout | null {
        const handle = device.createInputLayout(Ref(attributes[0]), attributes.length, vertexShader);
        return handle.ptr_ ? <IInputLayout><Opaque>handle.ptr_ : null;
    }

    // IDevice::createFramebuffer; null on failure. Release() it.
    export function createFramebuffer(device: IDevice, desc: FramebufferDesc): IFramebuffer | null {
        let descValue = desc;
        const handle = device.createFramebuffer(Ref(descValue));
        return handle.ptr_ ? <IFramebuffer><Opaque>handle.ptr_ : null;
    }

    // nvrhi::RenderState's defaults: no blending, depth test and writes (Less), back faces culled
    export function renderState(): RenderState {
        const target: RenderTarget = [false, 2, 1, 1, 2, 1, 1, 0xf];   // One, Zero, Add; One, Zero, Add; All
        const keep: StencilOpDesc = [1, 1, 1, 8];                      // Keep, Keep, Keep, Always
        return [
            [[target, target, target, target, target, target, target, target], false, false, 3, -1, true, true, 0],
            [true, true, 2, false, 0xff, 0xff, 0, false, keep, keep, false],
            [0, CULL_BACK, false, false, false, false, false, 0, 0, 0, 0, false, false, 0, false,
                [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
                0, 1, false, 1, 0xffff],
            [false, false, 0]];
    }

    // A GraphicsPipelineDesc of a triangle list, an input layout (null: none, the vertex shader
    // makes its vertices), a vertex and a pixel shader and up to one binding layout, with the given
    // render state. Its RefCountPtrs hold no reference, as in computePipelineDesc.
    export function graphicsPipelineDesc(inputLayout: IInputLayout | null, vertexShader: IShader, pixelShader: IShader,
        bindingLayout: IBindingLayout | null, state: RenderState): GraphicsPipelineDesc {
        return [3, 0, [inputLayout], [vertexShader], [null], [null], [null], [pixelShader], state, [false, 0, 0, 0],
            [[[bindingLayout], [null], [null], [null], [null], [null], [null], [null]], bindingLayout ? 1 : 0], 0];
    }

    // IDevice::createGraphicsPipeline for the framebuffer's formats; null on failure. Release() it.
    export function createGraphicsPipeline(device: IDevice, desc: GraphicsPipelineDesc, framebuffer: IFramebuffer): IGraphicsPipeline | null {
        let descValue = desc;
        // (passed as the overload's `IFramebuffer | null`: an IFramebuffer fits no overload,
        // TSLANG_ISSUES.md #19)
        const framebufferArg: IFramebuffer | null = framebuffer;
        const handle = device.createGraphicsPipeline(Ref(descValue), framebufferArg);
        return handle.ptr_ ? <IGraphicsPipeline><Opaque>handle.ptr_ : null;
    }

    // A ViewportState of one viewport and its scissor rectangle
    // (ViewportState::addViewportAndScissorRect: without one, D3D12 draws nothing and Vulkan's is
    // unset)
    function viewportState(viewport: Viewport): ViewportState {
        const noViewport: Viewport = [0, 0, 0, 0, 0, 0];
        const noRect: Rect = [0, 0, 0, 0];
        // nvrhi::Rect(viewport): the pixels it covers
        const scissor: Rect = [<s32>Math.floor(viewport.minX), <s32>Math.ceil(viewport.maxX),
            <s32>Math.floor(viewport.minY), <s32>Math.ceil(viewport.maxY)];
        return [[[viewport, noViewport, noViewport, noViewport, noViewport, noViewport, noViewport, noViewport,
            noViewport, noViewport, noViewport, noViewport, noViewport, noViewport, noViewport, noViewport], 1],
            [[scissor, noRect, noRect, noRect, noRect, noRect, noRect, noRect,
                noRect, noRect, noRect, noRect, noRect, noRect, noRect, noRect], 1]];
    }

    // A GraphicsState drawing into the framebuffer with the pipeline, through one viewport and its
    // scissor rectangle (viewportState), with up to one binding set, a vertex buffer (slot 0) and an
    // index buffer of indexFormat (R16_UINT, R32_UINT) - null for none.
    export function graphicsState(pipeline: IGraphicsPipeline, framebuffer: IFramebuffer, viewport: Viewport,
        bindingSet: IBindingSet | null, vertexBuffer: IBuffer | null, indexBuffer: IBuffer | null, indexFormat: Format): GraphicsState {
        const noBuffer: VertexBufferBinding = [null, 0, 0];
        const vertexBinding: VertexBufferBinding = [vertexBuffer, 0, 0];

        return [pipeline, framebuffer, viewportState(viewport),
            [false, 0, 0, 0], [0, 0, 0, 0], 0, 0, 1,
            [[bindingSet, null, null, null, null, null, null, null], bindingSet ? 1 : 0],
            [[vertexBinding, noBuffer, noBuffer, noBuffer, noBuffer, noBuffer, noBuffer, noBuffer,
                noBuffer, noBuffer, noBuffer, noBuffer, noBuffer, noBuffer, noBuffer, noBuffer], vertexBuffer ? 1 : 0],
            [indexBuffer, <u8>indexFormat, 0], null, null];
    }

    // ICommandList::setGraphicsState
    export function setGraphicsState(commandList: ICommandList, state: GraphicsState): void {
        let stateValue = state;
        commandList.setGraphicsState(Ref(stateValue));
    }

    // ICommandList::draw of vertexCount vertices, one instance
    export function draw(commandList: ICommandList, vertexCount: u32): void {
        let args: DrawArguments = [vertexCount, 1, 0, 0, 0];
        commandList.draw(Ref(args));
    }

    // ICommandList::draw of vertexCount vertices, instanceCount instances
    export function drawInstanced(commandList: ICommandList, vertexCount: u32, instanceCount: u32): void {
        let args: DrawArguments = [vertexCount, instanceCount, 0, 0, 0];
        commandList.draw(Ref(args));
    }

    // ICommandList::drawIndexed of indexCount indices, one instance (DrawArguments' vertexCount is
    // the index count)
    export function drawIndexed(commandList: ICommandList, indexCount: u32): void {
        let args: DrawArguments = [indexCount, 1, 0, 0, 0];
        commandList.drawIndexed(Ref(args));
    }

    // IDevice::createHeap of capacity bytes of a type of memory (HEAP_TYPE_*), with a debug name
    // (see stdString); null on failure. Release() it.
    export function createHeap(device: IDevice, capacity: u64, type: u8, debugName: string): IHeap | null {
        let desc: HeapDesc = [capacity, type, stdString(debugName)];
        const handle = device.createHeap(Ref(desc));
        return handle.ptr_ ? <IHeap><Opaque>handle.ptr_ : null;
    }

    // IDevice::createShaderSpecialization: the base shader with its specialization constants set
    // (Vulkan only: FEATURE_SHADER_SPECIALIZATIONS); null on failure. Release() it.
    export function createShaderSpecialization(device: IDevice, baseShader: IShader, constants: ShaderSpecialization[]): IShader | null {
        const handle = device.createShaderSpecialization(baseShader, Ref(constants[0]), constants.length);
        return handle.ptr_ ? <IShader><Opaque>handle.ptr_ : null;
    }

    // IDevice::createBindlessLayout of one register space (an unbounded array of a resource type
    // in the space, its Vulkan binding the item's place in registerSpaces: 0), at most maxCapacity
    // descriptors, visible to the stages in visibility; null on failure. Release() it.
    export function createBindlessLayout(device: IDevice, visibility: u16, maxCapacity: u32, space: BindingLayoutItem): IBindingLayout | null {
        const none: BindingLayoutItem = [0, [0]];
        let desc: BindlessLayoutDesc = [visibility, 0, maxCapacity,
            [[space, none, none, none, none, none, none, none, none, none, none, none, none, none, none, none], 1],
            BINDLESS_LAYOUT_IMMUTABLE];
        const handle = device.createBindlessLayout(Ref(desc));
        return handle.ptr_ ? <IBindingLayout><Opaque>handle.ptr_ : null;
    }

    // IDevice::createDescriptorTable of a bindless layout; null on failure. Release() it.
    export function createDescriptorTable(device: IDevice, layout: IBindingLayout): IDescriptorTable | null {
        const handle = device.createDescriptorTable(layout);
        return handle.ptr_ ? <IDescriptorTable><Opaque>handle.ptr_ : null;
    }

    // IDevice::writeDescriptorTable: the item into the table, at its slot
    export function writeDescriptorTable(device: IDevice, table: IDescriptorTable, item: BindingSetItem): boolean {
        let itemValue = item;
        return device.writeDescriptorTable(table, Ref(itemValue));
    }

    // IDevice::createCommandListLifetimeTracker for a queue; null on failure. Release() it.
    export function createCommandListLifetimeTracker(device: IDevice, queue: u8): ICommandListLifetimeTracker | null {
        const handle = device.createCommandListLifetimeTracker(queue);
        return handle.ptr_ ? <ICommandListLifetimeTracker><Opaque>handle.ptr_ : null;
    }

    // A MeshletPipelineDesc of a triangle list, a mesh and a pixel shader (no amplification shader)
    // and up to one binding layout, with the given render state. Its RefCountPtrs hold no
    // reference, as in computePipelineDesc.
    export function meshletPipelineDesc(meshShader: IShader, pixelShader: IShader, bindingLayout: IBindingLayout | null,
        state: RenderState): MeshletPipelineDesc {
        return [3, [null], [meshShader], [pixelShader], state,
            [[[bindingLayout], [null], [null], [null], [null], [null], [null], [null]], bindingLayout ? 1 : 0]];
    }

    // IDevice::createMeshletPipeline for the framebuffer's formats; null on failure. Release() it.
    export function createMeshletPipeline(device: IDevice, desc: MeshletPipelineDesc, framebuffer: IFramebuffer): IMeshletPipeline | null {
        let descValue = desc;
        // (passed as the overload's `IFramebuffer | null`: TSLANG_ISSUES.md #19)
        const framebufferArg: IFramebuffer | null = framebuffer;
        const handle = device.createMeshletPipeline(Ref(descValue), framebufferArg);
        return handle.ptr_ ? <IMeshletPipeline><Opaque>handle.ptr_ : null;
    }

    // IDevice::createMeshletPipeline for a FramebufferInfo (the overload taking one: the formats
    // and sample count); null on failure. Release() it.
    export function createMeshletPipelineForInfo(device: IDevice, desc: MeshletPipelineDesc, info: FramebufferInfo): IMeshletPipeline | null {
        let descValue = desc;
        let infoValue = info;
        const handle = device.createMeshletPipeline(Ref(descValue), Ref(infoValue));
        return handle.ptr_ ? <IMeshletPipeline><Opaque>handle.ptr_ : null;
    }

    // A MeshletState drawing into the framebuffer with the pipeline, through one viewport and its
    // scissor rectangle (viewportState), with up to one binding set
    export function meshletState(pipeline: IMeshletPipeline, framebuffer: IFramebuffer, viewport: Viewport,
        bindingSet: IBindingSet | null): MeshletState {
        return [pipeline, framebuffer, viewportState(viewport), [0, 0, 0, 0], 0,
            [[bindingSet, null, null, null, null, null, null, null], bindingSet ? 1 : 0], null, null];
    }

    // ICommandList::setMeshletState
    export function setMeshletState(commandList: ICommandList, state: MeshletState): void {
        let stateValue = state;
        commandList.setMeshletState(Ref(stateValue));
    }

    // IDevice::createSamplerFeedbackTexture: the feedback (SAMPLER_FEEDBACK_FORMAT_*) of a paired
    // texture's sampling, in regions of regionSize x regionSize texels (D3D12 only); null on
    // failure. Release() it.
    export function createSamplerFeedbackTexture(device: IDevice, pairedTexture: ITexture, format: u8, regionSize: u32,
        initialState: u32): ISamplerFeedbackTexture | null {
        let desc: SamplerFeedbackTextureDesc = [format, regionSize, regionSize, 1, initialState, initialState != RESOURCE_STATE_UNKNOWN];
        const handle = device.createSamplerFeedbackTexture(pairedTexture, Ref(desc));
        return handle.ptr_ ? <ISamplerFeedbackTexture><Opaque>handle.ptr_ : null;
    }

    // nvrhi::BindingSetItem::SamplerFeedbackTexture_UAV(slot, texture): all its subresources
    export function samplerFeedbackBindingSetItem(slot: u32, texture: ISamplerFeedbackTexture): BindingSetItem {
        return [texture, slot, 0, [<u32>RESOURCE_TYPE_SAMPLER_FEEDBACK_TEXTURE_UAV], 0, 0, [0xffffffff00000000, 0xffffffff00000000]];
    }

    // An rt::GeometryDesc of opaque triangles: indexCount R32_UINT indices and vertexCount
    // RGB32_FLOAT vertices, from the start of their buffers, untransformed
    export function triangleGeometryDesc(indexBuffer: IBuffer, indexCount: u32, vertexBuffer: IBuffer, vertexCount: u32): GeometryDesc {
        return [[indexBuffer, vertexBuffer, <u8>Format.R32_UINT, <u8>Format.RGB32_FLOAT, 0, 0, indexCount, vertexCount, 12,
            null, null, 0, <u8>Format.UNKNOWN, null, 0],
            false, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], GEOMETRY_FLAGS_OPAQUE, GEOMETRY_TYPE_TRIANGLES];
    }

    // An rt::AccelStructDesc: a bottom level one of the geometries (topLevelMaxInstances 0) or a
    // top level one of up to topLevelMaxInstances instances (no geometries), with build flags
    // (ACCEL_STRUCT_BUILD_*) and a debug name (see stdString); its geometries point at the array's
    // elements, for the call only (see stdVector).
    export function accelStructDesc(geometries: GeometryDesc[], topLevelMaxInstances: index, buildFlags: u8, debugName: string,
        isVirtual: boolean): AccelStructDesc {
        return [topLevelMaxInstances, stdVector(geometries), buildFlags, stdString(debugName), false,
            topLevelMaxInstances != 0, isVirtual];
    }

    // IDevice::createAccelStruct; null on failure. Release() it.
    export function createAccelStruct(device: IDevice, desc: AccelStructDesc): IAccelStruct | null {
        let descValue = desc;
        const handle = device.createAccelStruct(Ref(descValue));
        return handle.ptr_ ? <IAccelStruct><Opaque>handle.ptr_ : null;
    }

    // An rt::InstanceDesc of a bottom level structure: the identity transform, instance ID 0,
    // instance mask 0xff (the 24-bit ID, the mask, the hit group index contribution and the flags
    // are bit fields of one 64-bit word), no flags
    export function instanceDesc(bottomLevelAS: IAccelStruct): InstanceDesc {
        return [[1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0], [0xff000000], bottomLevelAS];
    }

    // nvrhi::BindingSetItem::RayTracingAccelStruct(slot, as)
    export function accelStructBindingSetItem(slot: u32, accelStruct: IAccelStruct): BindingSetItem {
        return [accelStruct, slot, 0, [<u32>RESOURCE_TYPE_RAY_TRACING_ACCEL_STRUCT], 0, 0, [0, 0]];
    }

    // IDevice::createShaderLibrary of a library's bytecode (DXIL, SPIR-V), which NVRHI copies; null
    // on failure. Release() it.
    export function createShaderLibrary(device: IDevice, bytecode: Opaque, byteSize: index): IShaderLibrary | null {
        const handle = device.createShaderLibrary(bytecode, byteSize);
        return handle.ptr_ ? <IShaderLibrary><Opaque>handle.ptr_ : null;
    }

    // IShaderLibrary::getShader: the library's entry point of a stage (SHADER_TYPE_*); null on
    // failure. Release() it.
    export function getLibraryShader(library: IShaderLibrary, entryName: string, shaderType: u16): IShader | null {
        const handle = library.getShader(entryName, shaderType);
        return handle.ptr_ ? <IShader><Opaque>handle.ptr_ : null;
    }

    // An rt::PipelineShaderDesc of a shader under its own entry point's name, with no local binding
    // layout
    export function pipelineShaderDesc(shader: IShader): PipelineShaderDesc {
        return [stdString(""), [shader], [null]];
    }

    // An rt::PipelineHitGroupDesc of a closest hit shader for triangles, exported as exportName
    // (see stdString)
    export function pipelineHitGroupDesc(exportName: string, closestHitShader: IShader): PipelineHitGroupDesc {
        return [stdString(exportName), [closestHitShader], [null], [null], [null], false];
    }

    // IDevice::createRayTracingPipeline of the shaders (ray generation, miss, callable) and hit
    // groups, with one global binding layout, payloads of up to maxPayloadSize bytes, triangle
    // attributes (8 bytes) and no recursion; the descs' arrays for the call only (see stdVector).
    // Null on failure. Release() it.
    export function createRayTracingPipeline(device: IDevice, shaders: PipelineShaderDesc[], hitGroups: PipelineHitGroupDesc[],
        bindingLayout: IBindingLayout, maxPayloadSize: u32): IPipeline | null {
        let desc: PipelineDesc = [stdVector(shaders), stdVector(hitGroups),
            [[[bindingLayout], [null], [null], [null], [null], [null], [null], [null]], 1], maxPayloadSize, 8, 1, -1, false];
        const handle = device.createRayTracingPipeline(Ref(desc));
        return handle.ptr_ ? <IPipeline><Opaque>handle.ptr_ : null;
    }

    // rt::IPipeline::createShaderTable, uncached (built when a command list first uses it), with a
    // debug name (see stdString); null on failure. Release() it.
    export function createShaderTable(pipeline: IPipeline, debugName: string): IShaderTable | null {
        let desc: ShaderTableDesc = [false, 0, stdString(debugName)];
        const handle = pipeline.createShaderTable(Ref(desc));
        return handle.ptr_ ? <IShaderTable><Opaque>handle.ptr_ : null;
    }

    // ICommandList::setRayTracingState of the shader table and one binding set
    export function setRayTracingState(commandList: ICommandList, shaderTable: IShaderTable, bindingSet: IBindingSet): void {
        let state: State = [shaderTable, [[bindingSet, null, null, null, null, null, null, null], 1]];
        commandList.setRayTracingState(Ref(state));
    }

    // ICommandList::dispatchRays of width x height rays
    export function dispatchRays(commandList: ICommandList, width: u32, height: u32): void {
        let args: DispatchRaysArguments = [width, height, 1];
        commandList.dispatchRays(Ref(args));
    }

    // IDevice::createEventQuery; null on failure. Release() it.
    export function createEventQuery(device: IDevice): IEventQuery | null {
        const handle = device.createEventQuery();
        return handle.ptr_ ? <IEventQuery><Opaque>handle.ptr_ : null;
    }

    // IDevice::createTimerQuery; null on failure. Release() it.
    export function createTimerQuery(device: IDevice): ITimerQuery | null {
        const handle = device.createTimerQuery();
        return handle.ptr_ ? <ITimerQuery><Opaque>handle.ptr_ : null;
    }

    // IDevice::createCommandList; null on failure. Release() it.
    export function createCommandList(device: IDevice, params: CommandListParameters): ICommandList | null {
        let paramsValue = params;
        const handle = device.createCommandList(Ref(paramsValue));
        return handle.ptr_ ? <ICommandList><Opaque>handle.ptr_ : null;
    }

    // IDevice::createComputePipeline; null on failure. Release() it.
    export function createComputePipeline(device: IDevice, desc: ComputePipelineDesc): IComputePipeline | null {
        let descValue = desc;
        const handle = device.createComputePipeline(Ref(descValue));
        return handle.ptr_ ? <IComputePipeline><Opaque>handle.ptr_ : null;
    }

    // ICommandList::setComputeState
    export function setComputeState(commandList: ICommandList, state: ComputeState): void {
        let stateValue = state;
        commandList.setComputeState(Ref(stateValue));
    }

    // IDevice::executeCommandList: one command list on the graphics queue; returns its submission
    // fence value.
    export function executeCommandList(device: IDevice, commandList: ICommandList): u64 {
        let lists: ICommandList[] = [commandList];
        return device.executeCommandLists(Ref(lists[0]), 1, COMMAND_QUEUE_GRAPHICS);
    }

    // IDevice::executeCommandLists of one command list on a queue (COMMAND_QUEUE_*: the one it was
    // made for, CommandListParameters::queueType); returns its submission fence value, which
    // queueWaitForCommandList takes.
    export function executeCommandListOn(device: IDevice, commandList: ICommandList, queue: u8): u64 {
        let lists: ICommandList[] = [commandList];
        return device.executeCommandLists(Ref(lists[0]), 1, queue);
    }

    // IDevice::executeCommandLists: the command lists in one submission to the graphics queue, run
    // in order; returns its fence value.
    export function executeCommandLists(device: IDevice, commandLists: ICommandList[]): u64 {
        return device.executeCommandLists(Ref(commandLists[0]), commandLists.length, COMMAND_QUEUE_GRAPHICS);
    }

    // IDevice::getNativeQueue: a queue's API object (ObjectTypes), not AddRef'd; null if the device
    // has no such queue.
    export function getNativeQueue(device: IDevice, objectType: u32, queue: u8): Opaque | null {
        return device.getNativeQueue(objectType, queue).pointer;
    }

    // IResource::getNativeObject: the API object (ObjectTypes), not AddRef'd; null if unavailable.
    export function getNativeObject(resource: IResource, objectType: u32): Opaque | null {
        return resource.getNativeObject(objectType).pointer;
    }
}
