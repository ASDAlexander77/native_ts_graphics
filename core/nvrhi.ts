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
//   C++ library's std::string (basic_string_char), static_vector and RefCountPtr included;
// - core/nvrhi_abi.<os>.ts: debug names, std::strings made the C++ library's way;
// - this file: the functions below, the same for both.
//
// Objects returned with a reference (createBuffer, createTexture, createCommandList,
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
            && sizeof<ComputeState>() == Donut_GetNvrhiStructSize("ComputeState");
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
        return handle.pointer ? <IBuffer><Opaque>handle.pointer : null;
    }

    // IDevice::createTexture; null on failure. Release() it.
    export function createTexture(device: IDevice, desc: TextureDesc): ITexture | null {
        let descValue = desc;
        const handle = device.createTexture(Ref(descValue));
        return handle.pointer ? <ITexture><Opaque>handle.pointer : null;
    }

    // IDevice::createCommandList; null on failure. Release() it.
    export function createCommandList(device: IDevice, params: CommandListParameters): ICommandList | null {
        let paramsValue = params;
        const handle = device.createCommandList(Ref(paramsValue));
        return handle.pointer ? <ICommandList><Opaque>handle.pointer : null;
    }

    // IDevice::createComputePipeline; null on failure. Release() it.
    export function createComputePipeline(device: IDevice, desc: ComputePipelineDesc): IComputePipeline | null {
        let descValue = desc;
        const handle = device.createComputePipeline(Ref(descValue));
        return handle.pointer ? <IComputePipeline><Opaque>handle.pointer : null;
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
