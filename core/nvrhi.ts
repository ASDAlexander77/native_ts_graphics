// NVRHI's interfaces, called directly: nvrhi::IDevice, ICommandList, IBuffer, ITexture, IShader,
// IBindingLayout, IBindingSet and IComputePipeline over IResource as @cppvtable classes (tslang
// pre-alpha94 or later). A @cppvtable class is laid over the C++ object, and its methods are the
// C++ vtable's slots in declaration order, a base class's first: slot N is called as
// fn(this, args), MSVC x64's member function convention. Import with
// `import { nvrhi } from "../core/nvrhi";` (from examples/) and list core/nvrhi.ts in the
// example's add_tslang_example sources (for the functions below); get the device with
// `<nvrhi.IDevice>app.getNvrhiDevice()`. Donut's handles (donut_handles.d.ts) are these objects'
// pointers: `<nvrhi.IBuffer><Opaque>bufferHandle`, `<BufferHandle><Opaque>buffer`.
//
// Every slot is declared, because a missing one moves every slot after it, and calls a different
// C++ method with no error: tools/check_nvrhi_slots.py compares the classes with the vtables MSVC
// builds (run it after changing them or updating NVRHI). Only the methods examples/nvrhi_direct.ts
// calls have real signatures; the others are placeholders named `_` + the C++ name, and an
// overloaded C++ method's slots `_<name>_<slot>` (MSVC orders overloads its own way). Give a
// placeholder its C++ signature to call it:
// - a C++ class or struct returned by value (RefCountPtr<T>, nvrhi::Object) comes back through a
//   hidden pointer, the parameter after `this`, which the method also returns;
// - a struct passed by reference, or by value and bigger than 8 bytes (MSVC passes a pointer to a
//   copy), is a Ref to a tuple with the C++ layout, which depends on the C++ build (std::string's
//   on the CRT): check its size with Donut_GetNvrhiStructSize, as layoutMatches() does;
// - an enum class is its underlying type (most are uint8_t; ResourceStates, ObjectType uint32_t);
// - a bool parameter is a u8: a boolean argument's upper bits are undefined in tslang's indirect
//   calls, and MSVC reads the whole byte. A bool or narrower-than-64-bit result is fine as its
//   exact type (boolean, u8, u32).
//
// Objects returned with a reference (createBuffer, createTexture, createCommandList,
// createComputePipeline) are released with Release(). The functions below hide the hidden return
// pointers.

/// <reference path="donut_interop.d.ts" />

export namespace nvrhi {

    // std::string with the release CRT the project builds with (32 bytes): the short-string buffer
    // (16 bytes, what fits in it is stored there), the size and the capacity (15 while short).
    export type StdString = [buffer0: u64, buffer1: u64, size: u64, capacity: u64];

    // nvrhi::BufferDesc (80 bytes)
    export type BufferDesc = [
        byteSize: u64, structStride: u32, maxVersions: u32, debugName: StdString,
        format: u8, canHaveUAVs: boolean, canHaveTypedViews: boolean, canHaveRawViews: boolean,
        isVertexBuffer: boolean, isIndexBuffer: boolean, isConstantBuffer: boolean, isDrawIndirectArgs: boolean,
        isAccelStructBuildInput: boolean, isAccelStructStorage: boolean, isShaderBindingTable: boolean,
        isVolatile: boolean, isVirtual: boolean,
        initialState: u32, keepInitialState: boolean, cpuAccess: u8, sharedResourceFlags: u32
    ];

    // nvrhi::TextureDesc (112 bytes). defaultComponentMapping is four ComponentSwizzle, clearValue
    // an nvrhi::Color.
    export type TextureDesc = [
        width: u32, height: u32, depth: u32, arraySize: u32, mipLevels: u32, sampleCount: u32,
        sampleQuality: u32, format: u8, dimension: u8, debugName: StdString,
        swizzleR: u8, swizzleG: u8, swizzleB: u8, swizzleA: u8,
        isShaderResource: boolean, isRenderTarget: boolean, isUAV: boolean, isTypeless: boolean,
        isShadingRateSurface: boolean, sharedResourceFlags: u32, isVirtual: boolean, isTiled: boolean,
        clearR: f32, clearG: f32, clearB: f32, clearA: f32, useClearValue: boolean,
        initialState: u32, keepInitialState: boolean
    ];

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

    // nvrhi::IResource
    @cppvtable
    export class IResource {
        _destructor(): void;                                                           // 0
        AddRef(): u32;                                                                 // 1
        Release(): u32;                                                                // 2
        GetRefCount(): u32;                                                            // 3
        getNativeObject(ret: Ref<Opaque | null>, objectType: u32): Ref<Opaque | null>; // 4
        _queryMemoryRequirements(): void;                                              // 5
    }

    // nvrhi::IBuffer
    @cppvtable
    export class IBuffer extends IResource {
        getDesc(): Ref<BufferDesc>;  // 6
        getGpuVirtualAddress(): u64; // 7
    }

    // nvrhi::ITexture
    @cppvtable
    export class ITexture extends IResource {
        getDesc(): Ref<TextureDesc>; // 6
        _getNativeView(): void;      // 7
    }

    // nvrhi::IShader
    @cppvtable
    export class IShader extends IResource {
        _getDesc(): void;                                                     // 6
        getBytecode(ppBytecode: Ref<Opaque | null>, pSize: Ref<index>): void; // 7
    }

    // nvrhi::IBindingLayout
    @cppvtable
    export class IBindingLayout extends IResource {
        _getDesc(): void;         // 6
        _getBindlessDesc(): void; // 7
    }

    // nvrhi::IBindingSet
    @cppvtable
    export class IBindingSet extends IResource {
        _getDesc(): void;            // 6
        getLayout(): IBindingLayout; // 7
    }

    // nvrhi::IComputePipeline
    @cppvtable
    export class IComputePipeline extends IResource {
        _getDesc(): void; // 6
    }

    // nvrhi::ICommandList
    @cppvtable
    export class ICommandList extends IResource {
        open(): void;                                                                                                 // 6
        close(): void;                                                                                                // 7
        clearState(): void;                                                                                           // 8
        clearTextureFloat(texture: ITexture, subresources: Ref<TextureSubresourceSet>, clearColor: Ref<Color>): void; // 9
        _clearDepthStencilTexture(): void;                                                                            // 10
        _clearTextureUInt(): void;                                                                                    // 11
        _copyTexture_12(): void;                                                                                      // 12
        _copyTexture_13(): void;                                                                                      // 13
        _copyTexture_14(): void;                                                                                      // 14
        _writeTexture(): void;                                                                                        // 15
        _resolveTexture(): void;                                                                                      // 16
        writeBuffer(buffer: IBuffer, data: Opaque, dataSize: index, destOffsetBytes: u64): void;                      // 17
        clearBufferUInt(buffer: IBuffer, clearValue: u32): void;                                                      // 18
        copyBuffer(dest: IBuffer, destOffsetBytes: u64, src: IBuffer, srcOffsetBytes: u64, dataSizeBytes: u64): void; // 19
        _clearSamplerFeedbackTexture(): void;                                                                         // 20
        _decodeSamplerFeedbackTexture(): void;                                                                        // 21
        _setSamplerFeedbackTextureState(): void;                                                                      // 22
        _setPushConstants(): void;                                                                                    // 23
        _setGraphicsState(): void;                                                                                    // 24
        _draw(): void;                                                                                                // 25
        _drawIndexed(): void;                                                                                         // 26
        _drawIndirect(): void;                                                                                        // 27
        _drawIndexedIndirect(): void;                                                                                 // 28
        _drawIndexedIndirectCount(): void;                                                                            // 29
        setComputeState(state: Ref<ComputeState>): void;                                                              // 30
        dispatch(groupsX: u32, groupsY: u32, groupsZ: u32): void;                                                     // 31
        _dispatchIndirect(): void;                                                                                    // 32
        _setMeshletState(): void;                                                                                     // 33
        _dispatchMesh(): void;                                                                                        // 34
        _dispatchMeshIndirect(): void;                                                                                // 35
        _dispatchMeshIndirectCount(): void;                                                                           // 36
        _setRayTracingState(): void;                                                                                  // 37
        _dispatchRays(): void;                                                                                        // 38
        _buildOpacityMicromap(): void;                                                                                // 39
        _buildBottomLevelAccelStruct(): void;                                                                         // 40
        _compactBottomLevelAccelStructs(): void;                                                                      // 41
        _copyRaytracingAccelerationStructure(): void;                                                                 // 42
        _buildTopLevelAccelStruct(): void;                                                                            // 43
        _executeMultiIndirectClusterOperation(): void;                                                                // 44
        _buildTopLevelAccelStructFromBuffer(): void;                                                                  // 45
        _convertCoopVecMatrices(): void;                                                                              // 46
        _beginTimerQuery(): void;                                                                                     // 47
        _endTimerQuery(): void;                                                                                       // 48
        beginMarker(name: string): void;                                                                              // 49
        endMarker(): void;                                                                                            // 50
        setEnableAutomaticBarriers(enable: u8): void;                                                                 // 51
        _setResourceStatesForBindingSet(): void;                                                                      // 52
        _setEnableUavBarriersForTexture(): void;                                                                      // 53
        _setEnableUavBarriersForBuffer(): void;                                                                       // 54
        _beginTrackingTextureState(): void;                                                                           // 55
        _beginTrackingBufferState(): void;                                                                            // 56
        _setTextureState(): void;                                                                                     // 57
        setBufferState(buffer: IBuffer, stateBits: u32): void;                                                        // 58
        _setAccelStructState(): void;                                                                                 // 59
        _setPermanentTextureState(): void;                                                                            // 60
        _setPermanentBufferState(): void;                                                                             // 61
        commitBarriers(): void;                                                                                       // 62
        _getTextureSubresourceState(): void;                                                                          // 63
        _getBufferState(): void;                                                                                      // 64
        getDevice(): IDevice;                                                                                         // 65
        _getDesc(): void;                                                                                             // 66
    }

    // nvrhi::IDevice
    @cppvtable
    export class IDevice extends IResource {
        _createHeap(): void;                                                                                // 6
        _queryTopLevelAccelStructPrebuildInfo(): void;                                                      // 7
        createTexture(ret: Ref<Opaque | null>, desc: Ref<TextureDesc>): Ref<Opaque | null>;                 // 8
        _getTextureMemoryRequirements(): void;                                                              // 9
        _bindTextureMemory(): void;                                                                         // 10
        _createHandleForNativeTexture(): void;                                                              // 11
        _createStagingTexture(): void;                                                                      // 12
        _mapStagingTexture(): void;                                                                         // 13
        _unmapStagingTexture(): void;                                                                       // 14
        _getTextureTiling(): void;                                                                          // 15
        _updateTextureTileMappings(): void;                                                                 // 16
        _createSamplerFeedbackTexture(): void;                                                              // 17
        _createSamplerFeedbackForNativeTexture(): void;                                                     // 18
        createBuffer(ret: Ref<Opaque | null>, desc: Ref<BufferDesc>): Ref<Opaque | null>;                   // 19
        mapBuffer(buffer: IBuffer, cpuAccess: u8): Opaque;                                                  // 20
        unmapBuffer(buffer: IBuffer): void;                                                                 // 21
        _getBufferMemoryRequirements(): void;                                                               // 22
        _bindBufferMemory(): void;                                                                          // 23
        _createHandleForNativeBuffer(): void;                                                               // 24
        _createShader(): void;                                                                              // 25
        _createShaderSpecialization(): void;                                                                // 26
        _createShaderLibrary(): void;                                                                       // 27
        _createSampler(): void;                                                                             // 28
        _createInputLayout(): void;                                                                         // 29
        _createEventQuery(): void;                                                                          // 30
        _setEventQuery(): void;                                                                             // 31
        _pollEventQuery(): void;                                                                            // 32
        _waitEventQuery(): void;                                                                            // 33
        _resetEventQuery(): void;                                                                           // 34
        _createTimerQuery(): void;                                                                          // 35
        _pollTimerQuery(): void;                                                                            // 36
        _getTimerQueryTime(): void;                                                                         // 37
        _resetTimerQuery(): void;                                                                           // 38
        getGraphicsAPI(): u8;                                                                               // 39
        _createFramebuffer(): void;                                                                         // 40
        _createGraphicsPipeline_41(): void;                                                                 // 41
        _createGraphicsPipeline_42(): void;                                                                 // 42
        createComputePipeline(ret: Ref<Opaque | null>, desc: Ref<ComputePipelineDesc>): Ref<Opaque | null>; // 43
        _createMeshletPipeline_44(): void;                                                                  // 44
        _createMeshletPipeline_45(): void;                                                                  // 45
        _createRayTracingPipeline(): void;                                                                  // 46
        _createBindingLayout(): void;                                                                       // 47
        _createBindlessLayout(): void;                                                                      // 48
        _createBindingSet(): void;                                                                          // 49
        _createDescriptorTable(): void;                                                                     // 50
        _resizeDescriptorTable(): void;                                                                     // 51
        _writeDescriptorTable(): void;                                                                      // 52
        _createOpacityMicromap(): void;                                                                     // 53
        _createAccelStruct(): void;                                                                         // 54
        _getAccelStructMemoryRequirements(): void;                                                          // 55
        _getClusterOperationSizeInfo(): void;                                                               // 56
        _bindAccelStructMemory(): void;                                                                     // 57
        createCommandList(ret: Ref<Opaque | null>, params: Ref<CommandListParameters>): Ref<Opaque | null>; // 58
        executeCommandLists(commandLists: Ref<Opaque>, numCommandLists: index, executionQueue: u8): u64;    // 59
        _queueWaitForCommandList(): void;                                                                   // 60
        waitForIdle(): boolean;                                                                             // 61
        _createCommandListLifetimeTracker(): void;                                                          // 62
        runGarbageCollection(): void;                                                                       // 63
        queryFeatureSupport(feature: u8, pInfo: Opaque | null, infoSize: index): boolean;                   // 64
        _queryFormatSupport(): void;                                                                        // 65
        _queryCoopVecFeatures(): void;                                                                      // 66
        _queryCoopVecMatMulFormatSupport(): void;                                                           // 67
        _queryCoopVecTrainingFormatSupport(): void;                                                         // 68
        _getCoopVecMatrixSize(): void;                                                                      // 69
        getNativeQueue(ret: Ref<Opaque | null>, objectType: u32, queue: u8): Ref<Opaque | null>;            // 70
        _getMessageCallback(): void;                                                                        // 71
        _isAftermathEnabled(): void;                                                                        // 72
        _getAftermathCrashDumpHelper(): void;                                                               // 73
    }

    // Whether this build can call NVRHI through these classes: MSVC x64's vtables (not Android's
    // Itanium ABI) and the tuples' layouts. Code that also runs elsewhere keeps another path.
    export function supported(): boolean {
        return Donut_CanCallNvrhiDirectly() != 0 && layoutMatches();
    }

    // Whether the tuples above have the sizes of the C++ structs: a C++ build with another layout
    // (the debug CRT's std::string) would have NVRHI read the fields at other offsets.
    export function layoutMatches(): boolean {
        return sizeof<BufferDesc>() == Donut_GetNvrhiStructSize("BufferDesc")
            && sizeof<TextureDesc>() == Donut_GetNvrhiStructSize("TextureDesc")
            && sizeof<TextureSubresourceSet>() == Donut_GetNvrhiStructSize("TextureSubresourceSet")
            && sizeof<Color>() == Donut_GetNvrhiStructSize("Color")
            && sizeof<CommandListParameters>() == Donut_GetNvrhiStructSize("CommandListParameters")
            && sizeof<ComputePipelineDesc>() == Donut_GetNvrhiStructSize("ComputePipelineDesc")
            && sizeof<ComputeState>() == Donut_GetNvrhiStructSize("ComputeState");
    }

    // An std::string holding name, for a desc's debugName: only a short string (15 characters or
    // fewer) can be made here, as a longer one is allocated by C++; empty for a longer name.
    export function stdString(name: string): StdString {
        const empty: StdString = [0, 0, 0, 15];
        const chars = <Ref<u8>><Opaque>name;
        let size = 0;
        while (Deref(chars[size]) != 0) {
            size++;
            if (size > 15) {
                return empty;
            }
        }

        let buffer0: u64 = 0;
        let buffer1: u64 = 0;
        let shift: u64 = 1;
        for (let i = 0; i < size; i++) {
            if (i == 8) {
                shift = 1;
            }
            const char: u64 = Deref(chars[i]);
            if (i < 8) {
                buffer0 += char * shift;
            } else {
                buffer1 += char * shift;
            }
            shift *= 256;
        }

        return [buffer0, buffer1, size, 15];
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
            0, 1, 2, 3, true, false, false, false, false, 0, false, false, 0, 0, 0, 0, false,
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

    // A ComputePipelineDesc of a shader and one binding layout
    export function computePipelineDesc(shader: IShader, bindingLayout: IBindingLayout): ComputePipelineDesc {
        return [<Opaque>shader, <Opaque>bindingLayout, null, null, null, null, null, null, null, 1];
    }

    // A ComputeState of a pipeline and one binding set
    export function computeState(pipeline: IComputePipeline, bindingSet: IBindingSet): ComputeState {
        return [<Opaque>pipeline, <Opaque>bindingSet, null, null, null, null, null, null, null, 1, null];
    }

    // IDevice::createBuffer; null on failure. Release() it.
    export function createBuffer(device: IDevice, desc: BufferDesc): IBuffer | null {
        let descValue = desc;
        let ret: Opaque | null = null;
        device.createBuffer(Ref(ret), Ref(descValue));
        return ret ? <IBuffer><Opaque>ret : null;
    }

    // IDevice::createTexture; null on failure. Release() it.
    export function createTexture(device: IDevice, desc: TextureDesc): ITexture | null {
        let descValue = desc;
        let ret: Opaque | null = null;
        device.createTexture(Ref(ret), Ref(descValue));
        return ret ? <ITexture><Opaque>ret : null;
    }

    // IDevice::createCommandList; null on failure. Release() it.
    export function createCommandList(device: IDevice, params: CommandListParameters): ICommandList | null {
        let paramsValue = params;
        let ret: Opaque | null = null;
        device.createCommandList(Ref(ret), Ref(paramsValue));
        return ret ? <ICommandList><Opaque>ret : null;
    }

    // IDevice::createComputePipeline; null on failure. Release() it.
    export function createComputePipeline(device: IDevice, desc: ComputePipelineDesc): IComputePipeline | null {
        let descValue = desc;
        let ret: Opaque | null = null;
        device.createComputePipeline(Ref(ret), Ref(descValue));
        return ret ? <IComputePipeline><Opaque>ret : null;
    }

    // ICommandList::setComputeState
    export function setComputeState(commandList: ICommandList, state: ComputeState): void {
        let stateValue = state;
        commandList.setComputeState(Ref(stateValue));
    }

    // ICommandList::clearTextureFloat
    export function clearTextureFloat(commandList: ICommandList, texture: ITexture, subresources: TextureSubresourceSet, color: Color): void {
        let subresourcesValue = subresources;
        let colorValue = color;
        commandList.clearTextureFloat(texture, Ref(subresourcesValue), Ref(colorValue));
    }

    // IDevice::executeCommandList: one command list on the graphics queue; returns its submission
    // fence value.
    export function executeCommandList(device: IDevice, commandList: ICommandList): u64 {
        let lists: Opaque[] = [<Opaque>commandList];
        return device.executeCommandLists(Ref(lists[0]), 1, COMMAND_QUEUE_GRAPHICS);
    }

    // IDevice::getNativeQueue: a queue's API object (ObjectTypes), not AddRef'd; null if the device
    // has no such queue.
    export function getNativeQueue(device: IDevice, objectType: u32, queue: u8): Opaque | null {
        let ret: Opaque | null = null;
        device.getNativeQueue(Ref(ret), objectType, queue);
        return ret;
    }

    // IResource::getNativeObject: the API object (ObjectTypes), not AddRef'd; null if unavailable.
    export function getNativeObject(resource: IResource, objectType: u32): Opaque | null {
        let ret: Opaque | null = null;
        resource.getNativeObject(Ref(ret), objectType);
        return ret;
    }
}
