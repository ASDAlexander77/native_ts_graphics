// NVRHI under the MSVC x64 ABI, for core/nvrhi.ts (its import of "./nvrhi_abi" takes this file on
// Windows, core/nvrhi_abi.linux.ts on Android): the interfaces' vtables, and the structs holding an
// std::string, which is the release CRT's here.
//
// A @cppvtable class is laid over the C++ object, and its methods are the C++ vtable's slots in
// declaration order, a base class's first: slot N is called as fn(this, args). MSVC has one
// destructor slot, and orders an overloaded method's slots its own way. Every slot is declared,
// because a missing one moves every slot after it, and calls a different C++ method with no error:
// tools/check_nvrhi_slots.py compares the classes with the vtables MSVC builds (run it after
// changing them or updating NVRHI). Only the methods examples/nvrhi_direct.ts calls have real
// signatures; the others are placeholders named `_` + the C++ name, and an overloaded C++ method's
// slots `_<name>_<slot>`. Give a placeholder its C++ signature to call it:
// - a C++ class or struct returned by value is a tuple with its layout (RefCountPtr, NativeObject):
//   MSVC returns it through a hidden pointer after `this`, which tslang passes. Mark a method
//   returning one with a destructor (RefCountPtr<T>) @cppnontrivial, as the Itanium ABI needs it;
// - a struct passed by reference, or by value and bigger than 8 bytes (MSVC passes a pointer to a
//   copy), is a Ref to a tuple with the C++ layout, which depends on the C++ build (std::string's
//   on the CRT): check its size with Donut_GetNvrhiStructSize, as nvrhi.layoutMatches() does;
// - an enum class is its underlying type (most are uint8_t; ResourceStates, ObjectType uint32_t);
// - a bool parameter is a u8: a boolean argument's upper bits are undefined in tslang's indirect
//   calls, and MSVC reads the whole byte. A bool or narrower-than-64-bit result is fine as its
//   exact type (boolean, u8, u32).

import "./nvrhi_types";

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

    // An std::string's size
    export function stdStringSize(value: StdString): int {
        return <int>value.size;
    }

    // Whether two short std::strings (see stdString) hold the same characters
    export function sameShortStdString(a: StdString, b: StdString): boolean {
        return a.size == b.size && a.size <= 15 && a.buffer0 == b.buffer0 && a.buffer1 == b.buffer1;
    }

    // ICommandList::clearTextureFloat: the TextureSubresourceSet by value, which MSVC passes as a
    // pointer to a copy
    export function clearTextureFloat(commandList: ICommandList, texture: ITexture, subresources: TextureSubresourceSet, color: Color): void {
        let subresourcesValue = subresources;
        let colorValue = color;
        commandList.clearTextureFloat(texture, Ref(subresourcesValue), Ref(colorValue));
    }

    // nvrhi::IResource
    @cppvtable
    export class IResource {
        _destructor(): void;                             // 0
        AddRef(): u32;                                   // 1
        Release(): u32;                                  // 2
        GetRefCount(): u32;                              // 3
        getNativeObject(objectType: u32): NativeObject;  // 4
        _queryMemoryRequirements(): void;                // 5
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
        _createHeap(): void;                                                                             // 6
        _queryTopLevelAccelStructPrebuildInfo(): void;                                                   // 7
        @cppnontrivial
        createTexture(desc: Ref<TextureDesc>): RefCountPtr;                                              // 8
        _getTextureMemoryRequirements(): void;                                                           // 9
        _bindTextureMemory(): void;                                                                      // 10
        _createHandleForNativeTexture(): void;                                                           // 11
        _createStagingTexture(): void;                                                                   // 12
        _mapStagingTexture(): void;                                                                      // 13
        _unmapStagingTexture(): void;                                                                    // 14
        _getTextureTiling(): void;                                                                       // 15
        _updateTextureTileMappings(): void;                                                              // 16
        _createSamplerFeedbackTexture(): void;                                                           // 17
        _createSamplerFeedbackForNativeTexture(): void;                                                  // 18
        @cppnontrivial
        createBuffer(desc: Ref<BufferDesc>): RefCountPtr;                                                // 19
        mapBuffer(buffer: IBuffer, cpuAccess: u8): Opaque;                                               // 20
        unmapBuffer(buffer: IBuffer): void;                                                              // 21
        _getBufferMemoryRequirements(): void;                                                            // 22
        _bindBufferMemory(): void;                                                                       // 23
        _createHandleForNativeBuffer(): void;                                                            // 24
        _createShader(): void;                                                                           // 25
        _createShaderSpecialization(): void;                                                             // 26
        _createShaderLibrary(): void;                                                                    // 27
        _createSampler(): void;                                                                          // 28
        _createInputLayout(): void;                                                                      // 29
        _createEventQuery(): void;                                                                       // 30
        _setEventQuery(): void;                                                                          // 31
        _pollEventQuery(): void;                                                                         // 32
        _waitEventQuery(): void;                                                                         // 33
        _resetEventQuery(): void;                                                                        // 34
        _createTimerQuery(): void;                                                                       // 35
        _pollTimerQuery(): void;                                                                         // 36
        _getTimerQueryTime(): void;                                                                      // 37
        _resetTimerQuery(): void;                                                                        // 38
        getGraphicsAPI(): u8;                                                                            // 39
        _createFramebuffer(): void;                                                                      // 40
        _createGraphicsPipeline_41(): void;                                                              // 41
        _createGraphicsPipeline_42(): void;                                                              // 42
        @cppnontrivial
        createComputePipeline(desc: Ref<ComputePipelineDesc>): RefCountPtr;                              // 43
        _createMeshletPipeline_44(): void;                                                               // 44
        _createMeshletPipeline_45(): void;                                                               // 45
        _createRayTracingPipeline(): void;                                                               // 46
        _createBindingLayout(): void;                                                                    // 47
        _createBindlessLayout(): void;                                                                   // 48
        _createBindingSet(): void;                                                                       // 49
        _createDescriptorTable(): void;                                                                  // 50
        _resizeDescriptorTable(): void;                                                                  // 51
        _writeDescriptorTable(): void;                                                                   // 52
        _createOpacityMicromap(): void;                                                                  // 53
        _createAccelStruct(): void;                                                                      // 54
        _getAccelStructMemoryRequirements(): void;                                                       // 55
        _getClusterOperationSizeInfo(): void;                                                            // 56
        _bindAccelStructMemory(): void;                                                                  // 57
        @cppnontrivial
        createCommandList(params: Ref<CommandListParameters>): RefCountPtr;                              // 58
        executeCommandLists(commandLists: Ref<Opaque>, numCommandLists: index, executionQueue: u8): u64; // 59
        _queueWaitForCommandList(): void;                                                                // 60
        waitForIdle(): boolean;                                                                          // 61
        _createCommandListLifetimeTracker(): void;                                                       // 62
        runGarbageCollection(): void;                                                                    // 63
        queryFeatureSupport(feature: u8, pInfo: Opaque | null, infoSize: index): boolean;                // 64
        _queryFormatSupport(): void;                                                                     // 65
        _queryCoopVecFeatures(): void;                                                                   // 66
        _queryCoopVecMatMulFormatSupport(): void;                                                        // 67
        _queryCoopVecTrainingFormatSupport(): void;                                                      // 68
        _getCoopVecMatrixSize(): void;                                                                   // 69
        getNativeQueue(objectType: u32, queue: u8): NativeObject;                                        // 70
        _getMessageCallback(): void;                                                                     // 71
        _isAftermathEnabled(): void;                                                                     // 72
        _getAftermathCrashDumpHelper(): void;                                                            // 73
    }
}
