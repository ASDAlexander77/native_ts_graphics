// Imported only for its declarations: input_pass.ts brings in donut.ts (the class wrappers over
// donut_interop.d.ts), whose code every example links from its object. Referencing donut.ts here
// would compile that code into this object too, defining its symbols twice.
import { InputPass } from "../core/input_pass";
import { nvrhi } from "../core/nvrhi";

namespace NvrhiDirect {
    // Calls NVRHI's C++ interfaces directly, with no wrapper in donut_interop.cpp: core/nvrhi.ts
    // lays tslang @cppvtable classes over nvrhi::IDevice, ICommandList, IBuffer, ITexture and the
    // compute pipeline's objects, and each call below goes through the C++ object's own vtable. Not
    // a port of a sample: a test of those bindings, of every method core/nvrhi.ts gives a
    // signature. Headless, like headless.ts.
    //
    // One command list:
    // - uploads numbers into a buffer and clears another to a value;
    // - runs a compute shader (output = input * 2 + 1) over the uploaded numbers, its pipeline made
    //   here and its binding set by Donut over buffers made here (Donut's handles are NVRHI's
    //   pointers);
    // - copies the three into a readback buffer, the last copy with the state changes made by hand
    //   instead of NVRHI's automatic barriers;
    // - clears a texture, read back through Donut.
    // It checks what it reads, and on the way the device's graphics API, its native objects,
    // reference counting, debug names, the desc NVRHI keeps and the layouts of the structs it passes.

    const COUNT = 64;
    const UINT_SIZE = 4;
    const SIZE = COUNT * UINT_SIZE;
    const CLEAR_VALUE: u32 = 0x5eed1234;
    const TEXTURE_SIZE = 4;

    let failures = 0;

    function check(condition: boolean, what: string): void {
        if (!condition) {
            console.log(`FAILED: ${what}`);
            failures++;
        }
    }

    function near(value: int, expected: int): boolean {
        return value >= expected - 1 && value <= expected + 1;
    }

    // NVRHI's messages, through an nvrhi::IMessageCallback implemented here: a @cppvtable class
    // whose message() has a body, which NVRHI calls through the vtable tslang makes for it. Each
    // goes on to Donut's handling (it logs them, and CTest fails on an error it logs), except the
    // one the test provokes.
    const PROVOKED_MESSAGE = "Cannot close a command list before it is opened";

    @cppvtable
    class MessageLog extends nvrhi.IMessageCallback {
        expecting = false;
        provoked = 0;

        message(severity: u8, text: string): void {
            if (this.expecting && severity == nvrhi.MESSAGE_SEVERITY_ERROR && text == PROVOKED_MESSAGE) {
                this.provoked++;
                return;
            }

            Donut_LogNvrhiMessage(severity, text);
        }
    }

    // A global: NVRHI keeps a pointer to it where the collector doesn't look, for as long as the
    // device lives.
    let messageLog = new MessageLog();

    function renderTargetDesc(): nvrhi.TextureDesc {
        let desc = nvrhi.textureDesc(TEXTURE_SIZE, TEXTURE_SIZE, Format.RGBA8_UNORM, "Cleared texture",
            nvrhi.RESOURCE_STATE_RENDER_TARGET);
        desc.isRenderTarget = true;
        return desc;
    }

    function runTest(app: App, api: GraphicsAPI, validation: boolean): void {
        // the tuples NVRHI reads as its structs: the same sizes as the C++ build's
        check(nvrhi.layoutMatches(), "the tuples have the C++ structs' sizes");

        const device = <nvrhi.IDevice>app.getNvrhiDevice();

        // IDevice::getMessageCallback: the MessageLog the device was made with
        check(<index><Opaque>device.getMessageCallback() == <index><Opaque>messageLog,
            "the device's IMessageCallback is the one implemented here");

        // IDevice::getGraphicsAPI; IResource::getNativeObject and IDevice::getNativeQueue (an
        // nvrhi::Object returned by value); IDevice::queryFeatureSupport, which says whether the
        // device has a compute queue (Donut's headless device has one on Vulkan, not on D3D12), as
        // getNativeQueue does; runGarbageCollection
        const deviceApi: int = device.getGraphicsAPI();
        console.log(`IDevice::getGraphicsAPI: ${deviceApi}`);
        check(deviceApi == <int>api, "the device's graphics API is the one asked for");
        const isD3D12 = api == GraphicsAPI.D3D12;
        check(nvrhi.getNativeObject(device, isD3D12 ? nvrhi.OBJECT_TYPE_D3D12_DEVICE : nvrhi.OBJECT_TYPE_VK_DEVICE) != null,
            "the device has its native device");
        const queueType = isD3D12 ? nvrhi.OBJECT_TYPE_D3D12_COMMAND_QUEUE : nvrhi.OBJECT_TYPE_VK_QUEUE;
        check(nvrhi.getNativeQueue(device, queueType, nvrhi.COMMAND_QUEUE_GRAPHICS) != null, "the device has its graphics queue");
        const hasComputeQueue = device.queryFeatureSupport(nvrhi.FEATURE_COMPUTE_QUEUE, null, 0);
        console.log(`IDevice::queryFeatureSupport(ComputeQueue): ${hasComputeQueue}`);
        // NVRHI's Vulkan getNativeQueue dereferences a queue the device doesn't have (the Android
        // emulator's has no compute queue): ask Vulkan only for one it has
        if (hasComputeQueue || isD3D12) {
            check(hasComputeQueue == (nvrhi.getNativeQueue(device, queueType, nvrhi.COMMAND_QUEUE_COMPUTE) != null),
                "IDevice::queryFeatureSupport(ComputeQueue) and getNativeQueue agree");
        }
        device.runGarbageCollection();

        // IResource::AddRef, Release, GetRefCount
        const refCount: int = device.GetRefCount();
        const added: int = device.AddRef();
        const released: int = device.Release();
        console.log(`IDevice reference count: ${refCount}, AddRef ${added}, Release ${released}`);
        check(added == refCount + 1 && released == refCount, "AddRef and Release count");

        // IDevice::createBuffer: the shader's input (uploaded) and output, one to clear, one to read
        // the three back from
        let inputDesc = nvrhi.bufferDesc(SIZE, "Input", nvrhi.RESOURCE_STATE_COPY_DEST, nvrhi.CPU_ACCESS_NONE);
        inputDesc.format = <u8>Format.R32_UINT;
        inputDesc.canHaveTypedViews = true;
        let outputDesc = nvrhi.bufferDesc(SIZE, "Output", nvrhi.RESOURCE_STATE_UNORDERED_ACCESS, nvrhi.CPU_ACCESS_NONE);
        outputDesc.format = <u8>Format.R32_UINT;
        outputDesc.canHaveTypedViews = true;
        outputDesc.canHaveUAVs = true;
        let clearedDesc = nvrhi.bufferDesc(SIZE, "Cleared", nvrhi.RESOURCE_STATE_COPY_DEST, nvrhi.CPU_ACCESS_NONE);
        clearedDesc.canHaveUAVs = true;
        const input = nvrhi.createBuffer(device, inputDesc);
        const output = nvrhi.createBuffer(device, outputDesc);
        const cleared = nvrhi.createBuffer(device, clearedDesc);
        const readback = nvrhi.createBuffer(device, nvrhi.bufferDesc(3 * SIZE, "Readback", nvrhi.RESOURCE_STATE_COPY_DEST, nvrhi.CPU_ACCESS_READ));
        if (!input || !output || !cleared || !readback) {
            check(false, "IDevice::createBuffer");
            return;
        }

        // IBuffer::getDesc: NVRHI's copy of the desc, debug name included; getGpuVirtualAddress (D3D12)
        const desc = Deref(cleared.getDesc());
        const name = nvrhi.stdString("Cleared");
        check(desc.byteSize == SIZE && desc.canHaveUAVs && desc.initialState == nvrhi.RESOURCE_STATE_COPY_DEST
            && desc.keepInitialState && desc.cpuAccess == nvrhi.CPU_ACCESS_NONE, "IBuffer::getDesc");
        check(nvrhi.stdStringSize(desc.debugName) == 7 && nvrhi.sameShortStdString(desc.debugName, name),
            "the buffer's debug name");
        if (isD3D12) {
            check(input.getGpuVirtualAddress() != 0, "IBuffer::getGpuVirtualAddress");
        }

        // IDevice::createTexture, ITexture::getDesc, getNativeObject
        const texture = nvrhi.createTexture(device, renderTargetDesc());
        if (!texture) {
            check(false, "IDevice::createTexture");
            return;
        }
        const textureDesc = Deref(texture.getDesc());
        check(textureDesc.width == TEXTURE_SIZE && textureDesc.height == TEXTURE_SIZE
            && textureDesc.format == <u8>Format.RGBA8_UNORM && textureDesc.isRenderTarget
            && nvrhi.stdStringSize(textureDesc.debugName) == 15, "ITexture::getDesc");
        check(nvrhi.getNativeObject(texture, isD3D12 ? nvrhi.OBJECT_TYPE_D3D12_RESOURCE : nvrhi.OBJECT_TYPE_VK_IMAGE) != null,
            "the texture has its native resource");

        // The compute pipeline: the shader through Donut's shader factory, IShader::getBytecode; the
        // binding set and its layout through Donut (nvrhi::utils::CreateBindingSetAndLayout, C++
        // code, not a method); IBindingSet::getLayout, IDevice::createComputePipeline
        const shader = <nvrhi.IShader><Opaque>app.createShader("nvrhi_direct.hlsl", "main", ShaderType.Compute);
        if (!shader) {
            check(false, "the compute shader");
            return;
        }
        // NVRHI keeps the bytecode on D3D12 only; on Vulkan it writes null and 0
        let bytecode: Opaque | null = null;
        let bytecodeSize: index = 12345;
        shader.getBytecode(Ref(bytecode), Ref(bytecodeSize));
        check(isD3D12 ? bytecode != null && bytecodeSize > 0 : bytecodeSize == 0, "IShader::getBytecode");

        const bindingSetDesc = BindingSetDesc.create();
        bindingSetDesc.bindTypedBufferSRV(0, <BufferHandle><Opaque>input);
        bindingSetDesc.bindTypedBufferUAV(0, <BufferHandle><Opaque>output);
        const donutBindingSet = app.createBindingSet(bindingSetDesc, ShaderType.Compute);
        if (donutBindingSet.isNull()) {
            check(false, "the binding set");
            return;
        }
        const bindingSet = <nvrhi.IBindingSet><Opaque>donutBindingSet.handle;
        const pipeline = nvrhi.createComputePipeline(device, nvrhi.computePipelineDesc(shader, bindingSet.getLayout()));
        if (!pipeline) {
            check(false, "IDevice::createComputePipeline");
            return;
        }

        // IDevice::createCommandList; ICommandList::open, clearState, beginMarker, writeBuffer,
        // clearBufferUInt, setComputeState, dispatch, setEnableAutomaticBarriers, setBufferState,
        // commitBarriers, copyBuffer, clearTextureFloat, endMarker, getDevice, close
        const commandList = nvrhi.createCommandList(device, nvrhi.commandListParameters());
        if (!commandList) {
            check(false, "IDevice::createCommandList");
            return;
        }
        check(<index><Opaque>commandList.getDevice() == <index><Opaque>device, "ICommandList::getDevice");

        // IMessageCallback::message, called by NVRHI: its validation layer (-debug) reports closing
        // a command list never opened as an error, and does nothing else (without it, the backend
        // would close a list it has none of)
        if (validation) {
            messageLog.expecting = true;
            commandList.close();
            messageLog.expecting = false;
            check(messageLog.provoked == 1, "NVRHI calls the IMessageCallback implemented here");
        }

        let data: u32[] = [];
        for (let i = 0; i < COUNT; i++) {
            data.push(i * 3 + 1);
        }

        commandList.open();
        commandList.clearState();
        commandList.beginMarker("nvrhi_direct");
        commandList.writeBuffer(input, <Opaque>Ref(data[0]), SIZE, 0);
        commandList.clearBufferUInt(cleared, CLEAR_VALUE);
        nvrhi.setComputeState(commandList, nvrhi.computeState(pipeline, bindingSet));
        commandList.dispatch(1, 1, 1);
        commandList.copyBuffer(readback, 0, input, 0, SIZE);
        commandList.copyBuffer(readback, SIZE, cleared, 0, SIZE);

        // the output's copy with the barriers made by hand
        commandList.setEnableAutomaticBarriers(0);
        commandList.setBufferState(output, nvrhi.RESOURCE_STATE_COPY_SOURCE);
        commandList.setBufferState(readback, nvrhi.RESOURCE_STATE_COPY_DEST);
        commandList.commitBarriers();
        commandList.copyBuffer(readback, 2 * SIZE, output, 0, SIZE);
        commandList.setEnableAutomaticBarriers(1);

        nvrhi.clearTextureFloat(commandList, texture, nvrhi.allSubresources(), [1.0, 0.5, 0.25, 1.0]);
        commandList.endMarker();
        commandList.close();

        // IDevice::executeCommandLists, waitForIdle
        nvrhi.executeCommandList(device, commandList);
        check(device.waitForIdle(), "IDevice::waitForIdle");

        // IDevice::mapBuffer, unmapBuffer
        const mapped = <Ref<u32>>device.mapBuffer(readback, nvrhi.CPU_ACCESS_READ);
        let uploadMismatches = 0;
        let clearMismatches = 0;
        let computeMismatches = 0;
        for (let i = 0; i < COUNT; i++) {
            if (Deref(mapped[i]) != data[i]) {
                uploadMismatches++;
            }
            if (Deref(mapped[COUNT + i]) != CLEAR_VALUE) {
                clearMismatches++;
            }
            if (Deref(mapped[2 * COUNT + i]) != data[i] * 2 + 1) {
                computeMismatches++;
            }
        }
        console.log(`Read back: [${Deref(mapped[0])}, ${Deref(mapped[1])}, ..., ${Deref(mapped[COUNT - 1])}], `
            + `cleared to ${Deref(mapped[COUNT])}, computed [${Deref(mapped[2 * COUNT])}, ..., ${Deref(mapped[3 * COUNT - 1])}]`);
        device.unmapBuffer(readback);
        check(uploadMismatches == 0, `ICommandList::writeBuffer and copyBuffer (${uploadMismatches} of ${COUNT} differ)`);
        check(clearMismatches == 0, `ICommandList::clearBufferUInt (${clearMismatches} of ${COUNT} differ)`);
        check(computeMismatches == 0, `the compute dispatch (${computeMismatches} of ${COUNT} differ)`);

        // the texture, read back through Donut (a staging texture)
        let pixels: u8[] = [];
        pixels.length = TEXTURE_SIZE * TEXTURE_SIZE * 4;
        if (app.readTextureLevel(<TextureHandle><Opaque>texture, 0, <Opaque>Ref(pixels[0]), pixels.length) == 0) {
            check(false, "the texture's readback");
        } else {
            let pixelMismatches = 0;
            for (let i = 0; i < TEXTURE_SIZE * TEXTURE_SIZE; i++) {
                if (!near(pixels[4 * i], 255) || !near(pixels[4 * i + 1], 128) || !near(pixels[4 * i + 2], 64)
                    || !near(pixels[4 * i + 3], 255)) {
                    pixelMismatches++;
                }
            }
            console.log(`Texture cleared to (${pixels[0]}, ${pixels[1]}, ${pixels[2]}, ${pixels[3]})`);
            check(pixelMismatches == 0, `ICommandList::clearTextureFloat (${pixelMismatches} of ${TEXTURE_SIZE * TEXTURE_SIZE} pixels differ)`);
        }

        // IResource::Release on what the create functions returned with a reference
        commandList.Release();
        pipeline.Release();
        texture.Release();
        input.Release();
        output.Release();
        cleared.Release();
        readback.Release();
    }

    export function main(argc: int, argv: Ref<string>): int {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("nvrhi_direct");
        Donut_SetLogMinSeverity(LogSeverity.Warning);

        const api = Donut_GetGraphicsAPIFromCommandLine(argc, argv);
        let options = AppOptions.None;
        for (let i = 1; i < argc; i++) {
            const arg = Donut_GetArg(argv, i);
            if (arg == "--help") {
                console.log(`Usage: ${Donut_GetArg(argv, 0)} [options]
 -dx12            Use DX12 API (default)
 -vk              Use Vulkan API
 -debug           Enable the graphics API's debug layer and NVRHI's validation layer
 -test            Accepted for the test runner: it always runs headless`);
                return 0;
            }

            if (arg == "-debug") {
                options = AppOptions.DebugRuntime;
            }
        }

        // the devices made from here on report to messageLog
        Donut_SetNvrhiMessageCallback(<Opaque>messageLog);

        const app = App.createHeadlessWithOptions(api, -1, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        console.log(`Using ${Donut_GraphicsAPIToString(api)} API with ${app.getRendererString()}.`);

        runTest(app, api, options == AppOptions.DebugRuntime);
        app.destroy();
        Donut_SetNvrhiMessageCallback(null);

        if (failures > 0) {
            console.log("Test FAILED!");
            return 1;
        }

        console.log("Test PASSED");
        return 0;
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>): int {
    return NvrhiDirect.main(argc, argv);
}
