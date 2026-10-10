// Imported only for its declarations: input_pass.ts brings in donut.ts (the class wrappers over
// donut_interop.d.ts), whose code every example links from its object. Referencing donut.ts here
// would compile that code into this object too, defining its symbols twice.
import { InputPass } from "../core/input_pass";

namespace Headless {
    // Port of Donut-Samples' headless.cpp: runs a compute shader on a device without a window and
    // checks its result on the CPU.

    // The shader is performing a reduction operation within one thread group, adding all uint's in
    // the input buffer. The number of uint's is the same as the thread group size.
    const NUM_INPUT_VALUES = 256;
    const UINT_SIZE = 4;

    function runTest(app: App): boolean {
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

        console.log(`Expected result: ${expectedResult}, computed result: ${computedResult}`);
        if (computedResult == expectedResult) {
            console.log("Test PASSED");
            return true;
        }

        console.log("Test FAILED!");
        return false;
    }

    function listAdapters(api: GraphicsAPI): int {
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

    export function main(argc: int, argv: Ref<string>): int {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("headless");
        // The C++ sample does this in release builds only.
        Donut_SetLogMinSeverity(LogSeverity.Warning);

        const api = Donut_GetGraphicsAPIFromCommandLine(argc, argv);
        let adapterIndex = -1;
        let options = AppOptions.None;

        for (let i = 1; i < argc; i++) {
            const arg = Donut_GetArg(argv, i);
            if (arg == "--help") {
                console.log(`Usage: ${Donut_GetArg(argv, 0)} [options]
 -dx11            Use DX11 API
 -dx12            Use DX12 API (default)
 -vk              Use Vulkan API
 --list-adapters  Enumerate the graphics adapters present in the system
 --adapter <n>    Use graphics adapter with index <n> as reported by --list-adapters
 -debug           Enable the graphics API's debug layer and NVRHI's validation layer`);
                return 0;
            }

            if (arg == "-debug") {
                options = AppOptions.DebugRuntime;
            }

            if (arg == "--list-adapters") {
                return listAdapters(api);
            }

            if (arg == "--adapter") {
                if (i + 1 >= argc) {
                    console.log("--adapter requires a parameter");
                    return 1;
                }
                adapterIndex = parseInt(Donut_GetArg(argv, i + 1));
                i++;
            }
        }

        const app = App.createHeadlessWithOptions(api, adapterIndex, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        console.log(`Using ${Donut_GraphicsAPIToString(api)} API with ${app.getRendererString()}.`);

        const passed = runTest(app);
        app.destroy();
        return passed ? 0 : 1;
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>): int {
    return Headless.main(argc, argv);
}
