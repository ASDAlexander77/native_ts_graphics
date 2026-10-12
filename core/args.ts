/// <reference path="./donut_interop.d.ts" />

// The command line of an example (main's argc and argv): the options all of them take, parsed into
// properties by parseArgs. An example with options of its own derives a class from it, which parses
// them in parseOptions, after these.
export class Args {
    // -dx11, -dx12, -vk: the graphics API (the platform's default if none is given).
    api: GraphicsAPI = GraphicsAPI.D3D12;
    // -debug: the graphics API's debug layer and NVRHI's validation layer (AppOptions.DebugRuntime),
    // to be combined with the options of the example.
    options: AppOptions = AppOptions.None;
    // -noui: without the settings window.
    noUI: boolean = false;
    // -benchmark: a fixed time step a frame, as the samples' benchmark mode (the examples which
    // animate by the time elapsed).
    benchmark: boolean = false;
    // --scene <path>: relative to the executable's directory, or absolute (empty: the example's
    // own scene).
    scenePath: string = "";
    // -test [-testOutput <file>]: render testFrames frames without a window and check the last one;
    // an example takes the option by passing its testFrames (the frames it needs to settle).
    test: boolean = false;

    // An example takes -test by passing the frames it renders (the frames it needs to settle); the
    // option is not recognized otherwise.
    constructor(protected argc: int, protected argv: Ref<string>, private testFrames: int = 0) {
    }

    // to be able to assign get/set to xxx[number]
    [index1: number]: string;

    get(index: number): string {
        if (index < 0 || index >= this.argc) {
            throw new Error(`Index out of bounds: ${index}`);
        }

        return Donut_GetArg(this.argv, index);
    }

    // Parses the options all the examples take, then (parseOptions) the example's own.
    parseArgs(): void {
        this.api = Donut_GetGraphicsAPIFromCommandLine(this.argc, this.argv);
        for (let i = 1; i < this.argc; i++) {
            const arg = this[i];
            if (arg == "-debug") {
                this.options = AppOptions.DebugRuntime;
            } else if (arg == "-noui") {
                this.noUI = true;
            } else if (arg == "-benchmark") {
                this.benchmark = true;
            } else if (arg == "--scene" && i + 1 < this.argc) {
                i++;
                this.scenePath = this[i];
            }
        }

        if (this.testFrames > 0) {
            this.test = Donut_ParseTestArgs(this.argc, this.argv, this.testFrames, 1.0 / 60.0) != 0;
        }

        this.parseOptions();
    }

    // The example's own options: its class derived from Args parses them here, from this[1] to
    // this[argc - 1] (the options of Args are in properties already).
    protected parseOptions(): void {
    }
}
