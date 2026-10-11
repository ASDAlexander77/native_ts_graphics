// Imported only for its declarations: input_pass.ts brings in donut.ts (the class wrappers over
// donut_interop.d.ts), whose code every example links from its object. Referencing donut.ts here
// would compile that code into this object too, defining its symbols twice.
import { InputPass } from "../core/input_pass";
import { nvrhi } from "../core/nvrhi";

namespace NvrhiDirect {
    // Calls NVRHI's C++ interfaces directly, with no wrapper in donut_interop.cpp: core/nvrhi.ts
    // lays tslang @cppvtable classes over nvrhi::IDevice, ICommandList and IBuffer, and each call
    // below goes through the C++ object's own vtable. Not a port of a sample: a test of those
    // bindings, of every method core/nvrhi.ts gives a signature. Headless, like headless.ts.
    //
    // It uploads numbers into one buffer and clears another to a value, copies both into a
    // readback buffer and checks what it maps; on the way it checks the device's graphics API,
    // its native device, reference counting and the layouts of the structs it passes.

    const COUNT = 64;
    const UINT_SIZE = 4;
    const SIZE = COUNT * UINT_SIZE;
    const CLEAR_VALUE: u32 = 0x5eed1234;

    let failures = 0;

    function check(condition: boolean, what: string): void {
        if (!condition) {
            console.log(`FAILED: ${what}`);
            failures++;
        }
    }

    function nativeDeviceType(api: GraphicsAPI): u32 {
        if (api == GraphicsAPI.D3D11) {
            return nvrhi.OBJECT_TYPE_D3D11_DEVICE;
        }
        if (api == GraphicsAPI.D3D12) {
            return nvrhi.OBJECT_TYPE_D3D12_DEVICE;
        }
        return nvrhi.OBJECT_TYPE_VK_DEVICE;
    }

    function runTest(app: App, api: GraphicsAPI): void {
        // the tuples NVRHI reads as its structs: the same sizes as the C++ build's
        check(nvrhi.layoutMatches(), "BufferDesc and CommandListParameters have the C++ structs' sizes");

        const device = <nvrhi.IDevice>app.getNvrhiDevice();

        // IDevice::getGraphicsAPI, IResource::getNativeObject (an nvrhi::Object returned by value)
        const deviceApi: int = device.getGraphicsAPI();
        console.log(`IDevice::getGraphicsAPI: ${deviceApi}`);
        check(deviceApi == <int>api, "the device's graphics API is the one asked for");
        check(nvrhi.getNativeObject(device, nativeDeviceType(api)) != null, "the device has its native device");

        // IResource::AddRef, Release, GetRefCount
        const refCount: int = device.GetRefCount();
        const added: int = device.AddRef();
        const released: int = device.Release();
        console.log(`IDevice reference count: ${refCount}, AddRef ${added}, Release ${released}`);
        check(added == refCount + 1 && released == refCount, "AddRef and Release count");

        // IDevice::createBuffer: one to upload into, one to clear, one to read both back from
        let clearedDesc = nvrhi.bufferDesc(SIZE, nvrhi.RESOURCE_STATE_COPY_DEST, nvrhi.CPU_ACCESS_NONE);
        clearedDesc.canHaveUAVs = true;
        const uploaded = nvrhi.createBuffer(device, nvrhi.bufferDesc(SIZE, nvrhi.RESOURCE_STATE_COPY_DEST, nvrhi.CPU_ACCESS_NONE));
        const cleared = nvrhi.createBuffer(device, clearedDesc);
        const readback = nvrhi.createBuffer(device, nvrhi.bufferDesc(2 * SIZE, nvrhi.RESOURCE_STATE_COPY_DEST, nvrhi.CPU_ACCESS_READ));
        if (!uploaded || !cleared || !readback) {
            check(false, "IDevice::createBuffer");
            return;
        }

        // IBuffer::getDesc: NVRHI's copy of the desc (NVRHI's validation layer names an unnamed buffer,
        // so its debugName isn't checked)
        const desc = Deref(cleared.getDesc());
        check(desc.byteSize == SIZE && desc.canHaveUAVs && desc.initialState == nvrhi.RESOURCE_STATE_COPY_DEST
            && desc.keepInitialState && desc.cpuAccess == nvrhi.CPU_ACCESS_NONE, "IBuffer::getDesc");

        // IDevice::createCommandList, ICommandList::open, clearState, writeBuffer, clearBufferUInt,
        // copyBuffer, close
        const commandList = nvrhi.createCommandList(device, nvrhi.commandListParameters());
        if (!commandList) {
            check(false, "IDevice::createCommandList");
            return;
        }

        let data: u32[] = [];
        for (let i = 0; i < COUNT; i++) {
            data.push(i * 3 + 1);
        }

        commandList.open();
        commandList.clearState();
        commandList.writeBuffer(uploaded, <Opaque>Ref(data[0]), SIZE, 0);
        commandList.clearBufferUInt(cleared, CLEAR_VALUE);
        commandList.copyBuffer(readback, 0, uploaded, 0, SIZE);
        commandList.copyBuffer(readback, SIZE, cleared, 0, SIZE);
        commandList.close();

        // IDevice::executeCommandLists, waitForIdle
        nvrhi.executeCommandList(device, commandList);
        check(device.waitForIdle(), "IDevice::waitForIdle");

        // IDevice::mapBuffer, unmapBuffer
        const mapped = <Ref<u32>>device.mapBuffer(readback, nvrhi.CPU_ACCESS_READ);
        let uploadMismatches = 0;
        let clearMismatches = 0;
        for (let i = 0; i < COUNT; i++) {
            if (Deref(mapped[i]) != data[i]) {
                uploadMismatches++;
            }
            if (Deref(mapped[COUNT + i]) != CLEAR_VALUE) {
                clearMismatches++;
            }
        }
        console.log(`Read back: [${Deref(mapped[0])}, ${Deref(mapped[1])}, ..., ${Deref(mapped[COUNT - 1])}], `
            + `cleared to ${Deref(mapped[COUNT])}`);
        device.unmapBuffer(readback);
        check(uploadMismatches == 0, `ICommandList::writeBuffer and copyBuffer (${uploadMismatches} of ${COUNT} differ)`);
        check(clearMismatches == 0, `ICommandList::clearBufferUInt (${clearMismatches} of ${COUNT} differ)`);

        // IResource::Release on what createBuffer and createCommandList returned with a reference
        commandList.Release();
        uploaded.Release();
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
 -dx11            Use DX11 API
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

        const app = App.createHeadlessWithOptions(api, -1, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        console.log(`Using ${Donut_GraphicsAPIToString(api)} API with ${app.getRendererString()}.`);

        runTest(app, api);
        app.destroy();

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
