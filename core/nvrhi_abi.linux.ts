// NVRHI under the Itanium C++ ABI of Android's clang, with its libc++, on x86-64 and AArch64, for
// core/nvrhi.ts (its import of "./nvrhi_abi" takes this file on Android, core/nvrhi_abi.win32.ts
// on Windows): the interfaces' vtables, and the structs holding an std::string, which is libc++'s
// here.
//
// A @cppvtable class is laid over the C++ object, and its methods are the C++ vtable's slots in
// declaration order, a base class's first: slot N is called as fn(this, args). The Itanium ABI
// has two destructor slots (the complete and the deleting destructor), and keeps an overloaded
// method's slots in declaration order. Every slot is declared, because a missing one moves every
// slot after it, and calls a different C++ method with no error: tools/check_nvrhi_slots.py
// compares the classes with the vtables Android's clang builds (`--abi itanium`; run it after
// changing them or updating NVRHI). The methods are core/nvrhi_abi.win32.ts's, which says how to
// give a placeholder its C++ signature; under this ABI:
// - a C++ class or struct returned by value is a tuple with its layout: one with a destructor
//   (RefCountPtr<T>) comes back through a hidden pointer before `this`, which tslang passes for a
//   method marked @cppnontrivial; a trivial one of one or two 8-byte fields (NativeObject) in
//   registers;
// - a struct passed by value, which MSVC passes as a pointer to a copy, goes in registers or memory
//   by its fields: one of up to 16 bytes of integers in one or two 64-bit registers, so it is
//   declared as one or two u64 parameters (clearTextureFloat's TextureSubresourceSet).

import "./nvrhi_types";

export namespace nvrhi {

    // libc++'s std::string (24 bytes): short, the first byte is the size times two (its low bit
    // set would make the string long), followed by up to 22 characters and their terminating zero.
    export type StdString = [word0: u64, word1: u64, word2: u64];

    // nvrhi::BufferDesc (72 bytes)
    export type BufferDesc = [
        byteSize: u64, structStride: u32, maxVersions: u32, debugName: StdString,
        format: u8, canHaveUAVs: boolean, canHaveTypedViews: boolean, canHaveRawViews: boolean,
        isVertexBuffer: boolean, isIndexBuffer: boolean, isConstantBuffer: boolean, isDrawIndirectArgs: boolean,
        isAccelStructBuildInput: boolean, isAccelStructStorage: boolean, isShaderBindingTable: boolean,
        isVolatile: boolean, isVirtual: boolean,
        initialState: u32, keepInitialState: boolean, cpuAccess: u8, sharedResourceFlags: u32
    ];

    // nvrhi::TextureDesc (104 bytes). defaultComponentMapping is four ComponentSwizzle, clearValue
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

    // An std::string holding name, for a desc's debugName: only a short string (22 characters or
    // fewer) can be made here, as a longer one is allocated by C++; empty for a longer name.
    export function stdString(name: string): StdString {
        const empty: StdString = [0, 0, 0];
        const chars = <Ref<u8>><Opaque>name;
        let size = 0;
        while (Deref(chars[size]) != 0) {
            size++;
            if (size > 22) {
                return empty;
            }
        }

        // byte 0 is the size times two, byte k + 1 character k
        let word0: u64 = size * 2;
        let word1: u64 = 0;
        let word2: u64 = 0;
        let shift: u64 = 256;
        for (let i = 0; i < size; i++) {
            const byte = i + 1;
            if (byte == 8 || byte == 16) {
                shift = 1;
            }
            const char: u64 = Deref(chars[i]);
            if (byte < 8) {
                word0 += char * shift;
            } else if (byte < 16) {
                word1 += char * shift;
            } else {
                word2 += char * shift;
            }
            shift *= 256;
        }

        return [word0, word1, word2];
    }

    // An std::string's size: a long one's (the first byte's low bit set) is its second word
    export function stdStringSize(value: StdString): int {
        if ((value.word0 & 1) != 0) {
            return <int>value.word1;
        }

        return <int>((value.word0 & 0xff) >> 1);
    }

    // Whether two short std::strings (see stdString) hold the same characters
    export function sameShortStdString(a: StdString, b: StdString): boolean {
        return (a.word0 & 1) == 0 && a.word0 == b.word0 && a.word1 == b.word1 && a.word2 == b.word2;
    }

    // ICommandList::clearTextureFloat: the TextureSubresourceSet by value, its two halves in two
    // registers
    export function clearTextureFloat(commandList: ICommandList, texture: ITexture, subresources: TextureSubresourceSet, color: Color): void {
        // (a multiplication: `<<` works as in JavaScript even on a u64, on a 32-bit integer, by its
        // count modulo 32)
        const high: u64 = 0x100000000;
        const mips: u64 = <u64>subresources.baseMipLevel + <u64>subresources.numMipLevels * high;
        const arraySlices: u64 = <u64>subresources.baseArraySlice + <u64>subresources.numArraySlices * high;
        let colorValue = color;
        commandList.clearTextureFloat(texture, mips, arraySlices, Ref(colorValue));
    }

    // nvrhi::IResource
    @cppvtable
    export class IResource {
        _completeDestructor(): void;                    // 0
        _deletingDestructor(): void;                    // 1
        AddRef(): u32;                                  // 2
        Release(): u32;                                 // 3
        GetRefCount(): u32;                             // 4
        getNativeObject(objectType: u32): NativeObject; // 5
        _queryMemoryRequirements(): void;               // 6
    }

    // nvrhi::IBuffer
    @cppvtable
    export class IBuffer extends IResource {
        getDesc(): Ref<BufferDesc>;  // 7
        getGpuVirtualAddress(): u64; // 8
    }

    // nvrhi::ITexture
    @cppvtable
    export class ITexture extends IResource {
        getDesc(): Ref<TextureDesc>; // 7
        _getNativeView(): void;      // 8
    }

    // nvrhi::IShader
    @cppvtable
    export class IShader extends IResource {
        _getDesc(): void;                                                     // 7
        getBytecode(ppBytecode: Ref<Opaque | null>, pSize: Ref<index>): void; // 8
    }

    // nvrhi::IBindingLayout
    @cppvtable
    export class IBindingLayout extends IResource {
        _getDesc(): void;         // 7
        _getBindlessDesc(): void; // 8
    }

    // nvrhi::IBindingSet
    @cppvtable
    export class IBindingSet extends IResource {
        _getDesc(): void;            // 7
        getLayout(): IBindingLayout; // 8
    }

    // nvrhi::IComputePipeline
    @cppvtable
    export class IComputePipeline extends IResource {
        _getDesc(): void; // 7
    }

    // nvrhi::ICommandList
    @cppvtable
    export class ICommandList extends IResource {
        open(): void;                                                                                                 // 7
        close(): void;                                                                                                // 8
        clearState(): void;                                                                                           // 9
        clearTextureFloat(texture: ITexture, mips: u64, arraySlices: u64, clearColor: Ref<Color>): void;            // 10
        _clearDepthStencilTexture(): void;                                                                            // 11
        _clearTextureUInt(): void;                                                                                    // 12
        _copyTexture_13(): void;                                                                                      // 13
        _copyTexture_14(): void;                                                                                      // 14
        _copyTexture_15(): void;                                                                                      // 15
        _writeTexture(): void;                                                                                        // 16
        _resolveTexture(): void;                                                                                      // 17
        writeBuffer(buffer: IBuffer, data: Opaque, dataSize: index, destOffsetBytes: u64): void;                      // 18
        clearBufferUInt(buffer: IBuffer, clearValue: u32): void;                                                      // 19
        copyBuffer(dest: IBuffer, destOffsetBytes: u64, src: IBuffer, srcOffsetBytes: u64, dataSizeBytes: u64): void; // 20
        _clearSamplerFeedbackTexture(): void;                                                                         // 21
        _decodeSamplerFeedbackTexture(): void;                                                                        // 22
        _setSamplerFeedbackTextureState(): void;                                                                      // 23
        _setPushConstants(): void;                                                                                    // 24
        _setGraphicsState(): void;                                                                                    // 25
        _draw(): void;                                                                                                // 26
        _drawIndexed(): void;                                                                                         // 27
        _drawIndirect(): void;                                                                                        // 28
        _drawIndexedIndirect(): void;                                                                                 // 29
        _drawIndexedIndirectCount(): void;                                                                            // 30
        setComputeState(state: Ref<ComputeState>): void;                                                              // 31
        dispatch(groupsX: u32, groupsY: u32, groupsZ: u32): void;                                                     // 32
        _dispatchIndirect(): void;                                                                                    // 33
        _setMeshletState(): void;                                                                                     // 34
        _dispatchMesh(): void;                                                                                        // 35
        _dispatchMeshIndirect(): void;                                                                                // 36
        _dispatchMeshIndirectCount(): void;                                                                           // 37
        _setRayTracingState(): void;                                                                                  // 38
        _dispatchRays(): void;                                                                                        // 39
        _buildOpacityMicromap(): void;                                                                                // 40
        _buildBottomLevelAccelStruct(): void;                                                                         // 41
        _compactBottomLevelAccelStructs(): void;                                                                      // 42
        _copyRaytracingAccelerationStructure(): void;                                                                 // 43
        _buildTopLevelAccelStruct(): void;                                                                            // 44
        _executeMultiIndirectClusterOperation(): void;                                                                // 45
        _buildTopLevelAccelStructFromBuffer(): void;                                                                  // 46
        _convertCoopVecMatrices(): void;                                                                              // 47
        _beginTimerQuery(): void;                                                                                     // 48
        _endTimerQuery(): void;                                                                                       // 49
        beginMarker(name: string): void;                                                                              // 50
        endMarker(): void;                                                                                            // 51
        setEnableAutomaticBarriers(enable: u8): void;                                                                 // 52
        _setResourceStatesForBindingSet(): void;                                                                      // 53
        _setEnableUavBarriersForTexture(): void;                                                                      // 54
        _setEnableUavBarriersForBuffer(): void;                                                                       // 55
        _beginTrackingTextureState(): void;                                                                           // 56
        _beginTrackingBufferState(): void;                                                                            // 57
        _setTextureState(): void;                                                                                     // 58
        setBufferState(buffer: IBuffer, stateBits: u32): void;                                                        // 59
        _setAccelStructState(): void;                                                                                 // 60
        _setPermanentTextureState(): void;                                                                            // 61
        _setPermanentBufferState(): void;                                                                             // 62
        commitBarriers(): void;                                                                                       // 63
        _getTextureSubresourceState(): void;                                                                          // 64
        _getBufferState(): void;                                                                                      // 65
        getDevice(): IDevice;                                                                                         // 66
        _getDesc(): void;                                                                                             // 67
    }

    // nvrhi::IDevice
    @cppvtable
    export class IDevice extends IResource {
        _createHeap(): void;                                                                             // 7
        _queryTopLevelAccelStructPrebuildInfo(): void;                                                   // 8
        @cppnontrivial
        createTexture(desc: Ref<TextureDesc>): RefCountPtr;                                              // 9
        _getTextureMemoryRequirements(): void;                                                           // 10
        _bindTextureMemory(): void;                                                                      // 11
        _createHandleForNativeTexture(): void;                                                           // 12
        _createStagingTexture(): void;                                                                   // 13
        _mapStagingTexture(): void;                                                                      // 14
        _unmapStagingTexture(): void;                                                                    // 15
        _getTextureTiling(): void;                                                                       // 16
        _updateTextureTileMappings(): void;                                                              // 17
        _createSamplerFeedbackTexture(): void;                                                           // 18
        _createSamplerFeedbackForNativeTexture(): void;                                                  // 19
        @cppnontrivial
        createBuffer(desc: Ref<BufferDesc>): RefCountPtr;                                                // 20
        mapBuffer(buffer: IBuffer, cpuAccess: u8): Opaque;                                               // 21
        unmapBuffer(buffer: IBuffer): void;                                                              // 22
        _getBufferMemoryRequirements(): void;                                                            // 23
        _bindBufferMemory(): void;                                                                       // 24
        _createHandleForNativeBuffer(): void;                                                            // 25
        _createShader(): void;                                                                           // 26
        _createShaderSpecialization(): void;                                                             // 27
        _createShaderLibrary(): void;                                                                    // 28
        _createSampler(): void;                                                                          // 29
        _createInputLayout(): void;                                                                      // 30
        _createEventQuery(): void;                                                                       // 31
        _setEventQuery(): void;                                                                          // 32
        _pollEventQuery(): void;                                                                         // 33
        _waitEventQuery(): void;                                                                         // 34
        _resetEventQuery(): void;                                                                        // 35
        _createTimerQuery(): void;                                                                       // 36
        _pollTimerQuery(): void;                                                                         // 37
        _getTimerQueryTime(): void;                                                                      // 38
        _resetTimerQuery(): void;                                                                        // 39
        getGraphicsAPI(): u8;                                                                            // 40
        _createFramebuffer(): void;                                                                      // 41
        _createGraphicsPipeline_42(): void;                                                              // 42
        _createGraphicsPipeline_43(): void;                                                              // 43
        @cppnontrivial
        createComputePipeline(desc: Ref<ComputePipelineDesc>): RefCountPtr;                              // 44
        _createMeshletPipeline_45(): void;                                                               // 45
        _createMeshletPipeline_46(): void;                                                               // 46
        _createRayTracingPipeline(): void;                                                               // 47
        _createBindingLayout(): void;                                                                    // 48
        _createBindlessLayout(): void;                                                                   // 49
        _createBindingSet(): void;                                                                       // 50
        _createDescriptorTable(): void;                                                                  // 51
        _resizeDescriptorTable(): void;                                                                  // 52
        _writeDescriptorTable(): void;                                                                   // 53
        _createOpacityMicromap(): void;                                                                  // 54
        _createAccelStruct(): void;                                                                      // 55
        _getAccelStructMemoryRequirements(): void;                                                       // 56
        _getClusterOperationSizeInfo(): void;                                                            // 57
        _bindAccelStructMemory(): void;                                                                  // 58
        @cppnontrivial
        createCommandList(params: Ref<CommandListParameters>): RefCountPtr;                              // 59
        executeCommandLists(commandLists: Ref<Opaque>, numCommandLists: index, executionQueue: u8): u64; // 60
        _queueWaitForCommandList(): void;                                                                // 61
        waitForIdle(): boolean;                                                                          // 62
        _createCommandListLifetimeTracker(): void;                                                       // 63
        runGarbageCollection(): void;                                                                    // 64
        queryFeatureSupport(feature: u8, pInfo: Opaque | null, infoSize: index): boolean;                // 65
        _queryFormatSupport(): void;                                                                     // 66
        _queryCoopVecFeatures(): void;                                                                   // 67
        _queryCoopVecMatMulFormatSupport(): void;                                                        // 68
        _queryCoopVecTrainingFormatSupport(): void;                                                      // 69
        _getCoopVecMatrixSize(): void;                                                                   // 70
        getNativeQueue(objectType: u32, queue: u8): NativeObject;                                        // 71
        _getMessageCallback(): void;                                                                     // 72
        _isAftermathEnabled(): void;                                                                     // 73
        _getAftermathCrashDumpHelper(): void;                                                            // 74
    }
}
