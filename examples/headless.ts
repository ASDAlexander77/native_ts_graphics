// Imported only for its declarations: input_pass.ts brings in donut.ts (the class wrappers over
// donut_interop.d.ts), whose code every example links from its object. Referencing donut.ts here
// would compile that code into this object too, defining its symbols twice.
import { InputPass } from "../core/input_pass";
import { Args } from "../core/args";
import { nvrhi } from "../core/nvrhi";

namespace Headless {
    // Port of Donut-Samples' headless.cpp: runs a compute shader on a device without a window and
    // checks its result on the CPU.
    //
    // headless.cpp calls NVRHI's interfaces directly, and so does runTestNvrhi, through
    // core/nvrhi.ts, where the build can (MSVC x64, Android: nvrhi.supported()). Elsewhere, or
    // with -donut, runTestDonut does the same through Donut's wrappers.

    // The shader is performing a reduction operation within one thread group, adding all uint's in
    // the input buffer. The number of uint's is the same as the thread group size.
    const NUM_INPUT_VALUES = 256;
    const UINT_SIZE = 4;

    // The comparison headless.cpp ends with
    function reportResult(expectedResult: int, computedResult: int) {
        console.log(`Expected result: ${expectedResult}, computed result: ${computedResult}`);
        if (computedResult == expectedResult) {
            console.log("Test PASSED");
            return true;
        }

        console.log("Test FAILED!");
        return false;
    }

    // headless.cpp's RunTest, line for line: NVRHI's interfaces called directly, with Donut's
    // shader factory for the shader and Donut's binding set helper (nvrhi::utils::
    // CreateBindingSetAndLayout's, C++ code rather than an interface) for the binding set.
    function runTestNvrhi(app: App) {
        const device = <nvrhi.IDevice>app.getNvrhiDevice();

        const computeShader = <nvrhi.IShader><Opaque>app.createShader("headless.hlsl", "main", ShaderType.Compute);
        if (!computeShader) {
            return false;
        }

        // Create the input, output, and readback buffers...

        let inputBufferDesc = nvrhi.bufferDesc(UINT_SIZE * NUM_INPUT_VALUES, "InputBuffer", nvrhi.RESOURCE_STATE_COPY_DEST,
            nvrhi.CPU_ACCESS_NONE);
        inputBufferDesc.canHaveTypedViews = true;
        inputBufferDesc.format = <u8>Format.R32_UINT;

        let outputBufferDesc = nvrhi.bufferDesc(UINT_SIZE, "OutputBuffer", nvrhi.RESOURCE_STATE_UNORDERED_ACCESS,
            nvrhi.CPU_ACCESS_NONE);
        outputBufferDesc.canHaveTypedViews = true;
        outputBufferDesc.canHaveUAVs = true;
        outputBufferDesc.format = <u8>Format.R32_UINT;

        const readbackBufferDesc = nvrhi.bufferDesc(UINT_SIZE, "ReadbackBuffer", nvrhi.RESOURCE_STATE_COPY_DEST,
            nvrhi.CPU_ACCESS_READ);

        const inputBuffer = nvrhi.createBuffer(device, inputBufferDesc);
        const outputBuffer = nvrhi.createBuffer(device, outputBufferDesc);
        const readbackBuffer = nvrhi.createBuffer(device, readbackBufferDesc);
        if (!inputBuffer || !outputBuffer || !readbackBuffer) {
            return false;
        }

        // Create the binding layout and binding set...

        const bindingSetDesc = BindingSetDesc.create();
        bindingSetDesc.bindTypedBufferSRV(0, <BufferHandle><Opaque>inputBuffer);
        bindingSetDesc.bindTypedBufferUAV(0, <BufferHandle><Opaque>outputBuffer);

        const donutBindingSet = app.createBindingSet(bindingSetDesc, ShaderType.Compute);
        if (donutBindingSet.isNull()) {
            return false;
        }
        const bindingSet = <nvrhi.IBindingSet><Opaque>donutBindingSet.handle;

        // Create the compute pipeline...

        const computePipeline = nvrhi.createComputePipeline(device, nvrhi.computePipelineDesc(computeShader, bindingSet.getLayout()));
        if (!computePipeline) {
            return false;
        }

        // Create a command list and begin recording

        const commandList = nvrhi.createCommandList(device, nvrhi.commandListParameters());
        if (!commandList) {
            return false;
        }
        commandList.open();

        // Fill the input buffer with some numbers and compute the expected result of shader operation.
        // `let`, not `const`: tslang takes the address of the array's storage only for non-const arrays.

        let inputData: u32[] = [];
        let expectedResult = 0;
        for (let i = 0; i < NUM_INPUT_VALUES; i++) {
            inputData.push(i + 1);
            expectedResult += i + 1;
        }
        commandList.writeBuffer(inputBuffer, <Opaque>Ref(inputData[0]), NUM_INPUT_VALUES * UINT_SIZE, 0);

        // Run the shader

        nvrhi.setComputeState(commandList, nvrhi.computeState(computePipeline, bindingSet));
        commandList.dispatch(1, 1, 1);

        // Copy the shader output into the staging buffer

        commandList.copyBuffer(readbackBuffer, 0, outputBuffer, 0, readbackBufferDesc.byteSize);

        // Close and execute the command list, wait on the CPU side for it to be finished

        commandList.close();
        nvrhi.executeCommandList(device, commandList);
        device.waitForIdle();

        // Read the shader output

        const outputData = <Ref<u32>>device.mapBuffer(readbackBuffer, nvrhi.CPU_ACCESS_READ);
        const computedResult = Deref(outputData[0]);
        device.unmapBuffer(readbackBuffer);

        // The references the create functions returned (headless.cpp's handles release theirs)

        commandList.Release();
        computePipeline.Release();
        inputBuffer.Release();
        outputBuffer.Release();
        readbackBuffer.Release();

        // Compare the result to the expected one to see if the test passes

        return reportResult(expectedResult, computedResult);
    }

    // The same through Donut's wrappers, for builds that can't call NVRHI directly
    function runTestDonut(app: App) {
        const computeShader = app.createShader("headless.hlsl", "main", ShaderType.Compute);
        if (!computeShader) {
            return false;
        }

        // Create the input, output, and readback buffers...

        const inputBuffer = app.createUIntBuffer(NUM_INPUT_VALUES, 0, "InputBuffer");
        const outputBuffer = app.createUIntBuffer(1, 1, "OutputBuffer");
        const readbackBuffer = app.createReadbackBuffer(UINT_SIZE, "ReadbackBuffer");

        // Create the binding layout and binding set...

        const bindingSetDesc = BindingSetDesc.create();
        bindingSetDesc.bindTypedBufferSRV(0, inputBuffer);
        bindingSetDesc.bindTypedBufferUAV(0, outputBuffer);

        const bindingSet = app.createBindingSet(bindingSetDesc, ShaderType.Compute);
        if (bindingSet.isNull()) {
            return false;
        }

        // Create the compute pipeline...

        const computePipeline = app.createComputePipeline(computeShader, bindingSet);

        // Create a command list and begin recording

        const commandList = app.createCommandList();
        commandList.open();

        // Fill the input buffer with some numbers and compute the expected result of shader operation.
        // `let`, not `const`: tslang takes the address of the array's storage only for non-const arrays.

        let inputData: int[] = [];
        let expectedResult = 0;
        for (let i = 0; i < NUM_INPUT_VALUES; i++) {
            inputData.push(i + 1);
            expectedResult += i + 1;
        }
        commandList.writeBuffer(inputBuffer, Ref(inputData[0]), NUM_INPUT_VALUES * UINT_SIZE);

        // Run the shader

        commandList.dispatch(computePipeline, bindingSet, 1, 1, 1);

        // Copy the shader output into the staging buffer

        commandList.copyBuffer(readbackBuffer, 0, outputBuffer, 0, UINT_SIZE);

        // Close and execute the command list, wait on the CPU side for it to be finished

        commandList.close();
        app.executeCommandList(commandList);
        app.waitForIdle();

        // Read the shader output

        let outputData: int[] = [0];
        if (!app.readBuffer(readbackBuffer, Ref(outputData[0]), UINT_SIZE)) {
            return false;
        }
        const computedResult = outputData[0];

        // Compare the result to the expected one to see if the test passes

        return reportResult(expectedResult, computedResult);
    }

    function runTest(app: App, forceDonut: boolean) {
        if (!forceDonut && nvrhi.supported()) {
            console.log("Calling NVRHI directly (core/nvrhi.ts).");
            return runTestNvrhi(app);
        }

        console.log("Calling NVRHI through Donut's wrappers.");
        return runTestDonut(app);
    }

    function listAdapters(api: GraphicsAPI) {
        const adapters = AdapterList.enumerate(api);
        if (adapters.isNull()) {
            return 1;
        }

        const count = adapters.getCount();
        for (let adapterIndex = 0; adapterIndex < count; adapterIndex++) {
            console.log(`Adapter ${adapterIndex}: ${adapters.getName(adapterIndex)} (${adapters.getMemoryMB(adapterIndex)} MB VRAM)`);
        }

        adapters.destroy();
        return 0;
    }

    // What the command line asks for instead of the test (the first of them on the command line).
    const EXIT_NONE = 0;
    const EXIT_HELP = 1;
    const EXIT_LIST_ADAPTERS = 2;
    const EXIT_ADAPTER_MISSING = 3;

    class HeadlessArgs extends Args {
        // --adapter <n>: use graphics adapter with index <n> as reported by --list-adapters.
        adapterIndex = -1;
        // -donut: call NVRHI through Donut's wrappers even where it can be called directly.
        forceDonut = false;
        // --help, --list-adapters and --adapter without its value: the first of them, which ends the
        // program before the test.
        firstExit = EXIT_NONE;

        protected parseOptions() {
            for (let i = 1; i < this.argc; i++) {
                const arg = this[i];
                if (arg == "--help") {
                    if (this.firstExit == EXIT_NONE) {
                        this.firstExit = EXIT_HELP;
                    }
                }

                if (arg == "-donut") {
                    this.forceDonut = true;
                }

                if (arg == "--list-adapters") {
                    if (this.firstExit == EXIT_NONE) {
                        this.firstExit = EXIT_LIST_ADAPTERS;
                    }
                }

                if (arg == "--adapter") {
                    if (i + 1 >= this.argc) {
                        if (this.firstExit == EXIT_NONE) {
                            this.firstExit = EXIT_ADAPTER_MISSING;
                        }
                    } else {
                        this.adapterIndex = parseInt(this[i + 1]);
                        i++;
                    }
                }
            }
        }
    }

    export function main(argc: int, argv: Ref<string>): int {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("headless");

        const args = new HeadlessArgs(argc, argv);
        args.parseArgs();

        // The C++ sample does this in release builds only.
        Donut_SetLogMinSeverity(LogSeverity.Warning);

        if (args.firstExit == EXIT_HELP) {
            console.log(`Usage: ${args[0]} [options]
 -dx11            Use DX11 API
 -dx12            Use DX12 API (default)
 -vk              Use Vulkan API
 --list-adapters  Enumerate the graphics adapters present in the system
 --adapter <n>    Use graphics adapter with index <n> as reported by --list-adapters
 -debug           Enable the graphics API's debug layer and NVRHI's validation layer
 -donut           Call NVRHI through Donut's wrappers even where it can be called directly`);
            return 0;
        }

        if (args.firstExit == EXIT_LIST_ADAPTERS) {
            return listAdapters(args.api);
        }

        if (args.firstExit == EXIT_ADAPTER_MISSING) {
            console.log("--adapter requires a parameter");
            return 1;
        }

        const app = App.createHeadlessWithOptions(args.api, args.adapterIndex, args.options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        console.log(`Using ${Donut_GraphicsAPIToString(args.api)} API with ${app.getRendererString()}.`);

        const passed = runTest(app, args.forceDonut);
        app.destroy();
        return passed ? 0 : 1;
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return Headless.main(argc, argv);
}
