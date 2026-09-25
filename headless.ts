/// <reference path="donut_interop.d.ts" />

// Port of Donut-Samples' headless.cpp: runs a compute shader on a device without a window and
// checks its result on the CPU.

// The shader is performing a reduction operation within one thread group, adding all uint's in
// the input buffer. The number of uint's is the same as the thread group size.
const NUM_INPUT_VALUES = 256;
const UINT_SIZE = 4;

function runTest(app: Opaque): boolean {
    const computeShader = Donut_CreateShader(app, "headless.hlsl", "main", ShaderType.Compute);
    if (!computeShader) {
        return false;
    }

    // Create the input, output, and readback buffers...

    const inputBuffer = Donut_CreateUIntBuffer(app, NUM_INPUT_VALUES, 0, "InputBuffer");
    const outputBuffer = Donut_CreateUIntBuffer(app, 1, 1, "OutputBuffer");
    const readbackBuffer = Donut_CreateReadbackBuffer(app, UINT_SIZE, "ReadbackBuffer");

    // Create the binding layout and binding set...

    const bindingSetDesc = Donut_CreateBindingSetDesc();
    Donut_BindTypedBufferSRV(bindingSetDesc, 0, inputBuffer);
    Donut_BindTypedBufferUAV(bindingSetDesc, 0, outputBuffer);

    const bindingSet = Donut_CreateBindingSet(app, bindingSetDesc, ShaderType.Compute);
    if (!bindingSet) {
        return false;
    }

    // Create the compute pipeline...

    const computePipeline = Donut_CreateComputePipeline(app, computeShader, bindingSet);

    // Create a command list and begin recording

    const commandList = Donut_CreateCommandList(app);
    Donut_OpenCommandList(commandList);

    // Fill the input buffer with some numbers and compute the expected result of shader operation.
    // `let`, not `const`: tslang takes the address of the array's storage only for non-const arrays.

    let inputData: int[] = [];
    let expectedResult = 0;
    for (let i = 0; i < NUM_INPUT_VALUES; i++) {
        inputData.push(i + 1);
        expectedResult += i + 1;
    }
    Donut_WriteBuffer(commandList, inputBuffer, Ref(inputData[0]), NUM_INPUT_VALUES * UINT_SIZE);

    // Run the shader

    Donut_Dispatch(commandList, computePipeline, bindingSet, 1, 1, 1);

    // Copy the shader output into the staging buffer

    Donut_CopyBuffer(commandList, readbackBuffer, 0, outputBuffer, 0, UINT_SIZE);

    // Close and execute the command list, wait on the CPU side for it to be finished

    Donut_CloseCommandList(commandList);
    Donut_ExecuteCommandList(app, commandList);
    Donut_WaitForIdle(app);

    // Read the shader output

    let outputData: int[] = [0];
    if (!Donut_ReadBuffer(app, readbackBuffer, Ref(outputData[0]), UINT_SIZE)) {
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
    const adapters = Donut_EnumerateAdapters(api);
    if (!adapters) {
        return 1;
    }

    const count = Donut_GetAdapterCount(adapters);
    for (let adapterIndex = 0; adapterIndex < count; adapterIndex++) {
        console.log(`Adapter ${adapterIndex}: ${Donut_GetAdapterName(adapters, adapterIndex)} (${Donut_GetAdapterMemoryMB(adapters, adapterIndex)} MB VRAM)`);
    }

    Donut_DestroyAdapterList(adapters);
    return 0;
}

function main(argc: int, argv: Opaque): int {
    // The C++ sample does this in release builds only.
    Donut_SetLogMinSeverity(LogSeverity.Warning);

    const api = Donut_GetGraphicsAPIFromCommandLine(argc, argv);
    let adapterIndex = -1;

    for (let i = 1; i < argc; i++) {
        const arg = Donut_GetArg(argv, i);
        if (arg == "--help") {
            console.log(`Usage: ${Donut_GetArg(argv, 0)} [options]
 -dx11            Use DX11 API
 -dx12            Use DX12 API (default)
 -vk              Use Vulkan API
 --list-adapters  Enumerate the graphics adapters present in the system
 --adapter <n>    Use graphics adapter with index <n> as reported by --list-adapters`);
            return 0;
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

    const app = Donut_CreateHeadlessApp(api, adapterIndex);
    if (!app) {
        console.log("Cannot initialize a graphics device with the requested parameters");
        return 1;
    }

    console.log(`Using ${Donut_GraphicsAPIToString(api)} API with ${Donut_GetRendererString(app)}.`);

    const passed = runTest(app);
    Donut_DestroyApp(app);
    return passed ? 0 : 1;
}
