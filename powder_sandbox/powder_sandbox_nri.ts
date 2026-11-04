/// <reference path="../core/nri/nri_interop.d.ts" />
import {
    DEFAULT_GRID_HEIGHT, MIN_GRID_HEIGHT, SOLVER_SOR, SOLVER_MULTIGRID, GRAVITY_NAMES
} from "./defs";
import { PowderSandbox } from "./checks";

namespace PowderSandboxNri {
    // A falling-sand sandbox in the spirit of The Powder Toy, with real fluid physics: pick a
    // material from the toolbar and paint with the mouse or a finger. Liquids and sand are FLIP
    // particles with an incompressible pressure solve (water levels out in connected vessels), fire,
    // smoke and steam rise, uranium gives off neutrons and heat, and temperature is tracked
    // everywhere. The simulation and drawing are shaders/powder_sandbox.hlsl's; this folder's
    // files run them with NRI and draw the toolbar with NRIFramework's ImGui (sandbox.ts: the app;
    // checks.ts: its -test checks; defs.ts: the constants and small classes they share). This file
    // reads the command line and starts it.

    export function main(argc: int, argv: Ref<string>) {
        const sample = Nri_CreateSample();
        Nri_UseResizableWindow(sample);
        const sandbox = new PowderSandbox(sample);
        Nri_AddExampleOption(sample, "-utube");
        Nri_AddExampleOption(sample, "-roundTrip");
        Nri_AddExampleOptionWithValues(sample, "-regrid", 1);
        Nri_AddExampleOptionWithValues(sample, "-scene", 1);
        Nri_AddExampleOptionWithValues(sample, "-sceneFile", 1);
        Nri_AddExampleOptionWithValues(sample, "-solve", 1);
        Nri_AddExampleOptionWithValues(sample, "-testStars", 1);
        Nri_AddExampleOptionWithValues(sample, "-gridHeight", 1);
        Nri_AddExampleOptionWithValues(sample, "-quality", 1);
        Nri_AddExampleOptionWithValues(sample, "-stepBudget", 1);
        Nri_AddExampleOptionWithValues(sample, "-view", 1);
        Nri_AddExampleOptionWithValues(sample, "-substeps", 1);
        Nri_AddExampleOptionWithValues(sample, "-iterations", 1);
        Nri_AddExampleOptionWithValues(sample, "-solver", 1);
        Nri_AddExampleOptionWithValues(sample, "-zoom", 1);
        Nri_AddExampleOptionWithValues(sample, "-vcycles", 1);
        Nri_AddExampleOptionWithValues(sample, "-smooth", 1);
        Nri_AddExampleOptionWithValues(sample, "-viscosity", 1);
        Nri_AddExampleOptionWithValues(sample, "-air", 1);
        Nri_AddExampleOptionWithValues(sample, "-bodies", 1);
        Nri_AddExampleOption(sample, "-mute");
        Nri_AddExampleOption(sample, "-profile");
        Nri_AddExampleOptionWithValues(sample, "-gravity", 1);
        Nri_AddExampleOptionWithValues(sample, "-tilt", 2);
        Nri_AddExampleOptionWithValues(sample, "-window", 2);
        Nri_AddExampleOption(sample, "-sound");
        Nri_AddExampleOptionWithValues(sample, "-testFrames", 1);
        for (let i = 1; i < argc; i++) {
            const arg = Nri_GetArg(argc, argv, i);
            if (arg == "-utube") {
                sandbox.scene = 1;
            } else if (arg == "-roundTrip") {
                sandbox.roundTrip = true;
            } else if (arg == "-regrid" && i + 1 < argc) {
                sandbox.regrid = Math.min(Math.max(parseInt(Nri_GetArg(argc, argv, i + 1)), 0), 2);
                i++;
            } else if (arg == "-substeps" && i + 1 < argc) {
                sandbox.substeps = Math.max(parseInt(Nri_GetArg(argc, argv, i + 1)), 1);
                i++;
            } else if (arg == "-view" && i + 1 < argc) {
                sandbox.overlay = Math.min(Math.max(parseInt(Nri_GetArg(argc, argv, i + 1)), 0), 2);
                i++;
            } else if (arg == "-gridHeight" && i + 1 < argc) {
                sandbox.gridHeight = Math.min(Math.max(parseInt(Nri_GetArg(argc, argv, i + 1)), MIN_GRID_HEIGHT), DEFAULT_GRID_HEIGHT);
                sandbox.gridHeightSet = true;
                i++;
            } else if (arg == "-quality" && i + 1 < argc) {
                sandbox.quality = Nri_GetArg(argc, argv, i + 1);
                i++;
            } else if (arg == "-stepBudget" && i + 1 < argc) {
                sandbox.stepBudget = Math.max(parseFloat(Nri_GetArg(argc, argv, i + 1)), 0.001);
                i++;
            } else if (arg == "-sceneFile" && i + 1 < argc) {
                sandbox.sceneFile = Nri_GetArg(argc, argv, i + 1);
                i++;
            } else if (arg == "-solve" && i + 1 < argc) {
                sandbox.solveTime = Math.max(parseFloat(Nri_GetArg(argc, argv, i + 1)), 0.0);
                i++;
            } else if (arg == "-testStars" && i + 1 < argc) {
                sandbox.testStars = Math.min(Math.max(parseInt(Nri_GetArg(argc, argv, i + 1)), 0), 3);
                i++;
            } else if (arg == "-scene" && i + 1 < argc) {
                sandbox.scene = parseInt(Nri_GetArg(argc, argv, i + 1));
                i++;
            } else if (arg == "-testFrames" && i + 1 < argc) {
                sandbox.testFrames = Math.max(parseInt(Nri_GetArg(argc, argv, i + 1)), 1);
                i++;
            } else if (arg == "-iterations" && i + 1 < argc) {
                sandbox.iterations = Math.max(parseInt(Nri_GetArg(argc, argv, i + 1)), 1);
                i++;
            } else if (arg == "-zoom" && i + 1 < argc) {
                sandbox.startZoom = parseFloat(Nri_GetArg(argc, argv, i + 1));
                i++;
            } else if (arg == "-solver" && i + 1 < argc) {
                sandbox.solver = Nri_GetArg(argc, argv, i + 1) == "sor" ? SOLVER_SOR : SOLVER_MULTIGRID;
                i++;
            } else if (arg == "-vcycles" && i + 1 < argc) {
                sandbox.vcycles = Math.max(parseInt(Nri_GetArg(argc, argv, i + 1)), 1);
                i++;
            } else if (arg == "-profile") {
                sandbox.profile = true;
            } else if (arg == "-mute") {
                sandbox.mute = true;
            } else if (arg == "-tilt" && i + 2 < argc) {
                sandbox.setTilt(parseFloat(Nri_GetArg(argc, argv, i + 1)), parseFloat(Nri_GetArg(argc, argv, i + 2)));
                i += 2;
            } else if (arg == "-window" && i + 2 < argc) {
                // (the window's size: -window 540 1170 is a phone held upright)
                Nri_SetWindowSize(sample, Math.max(parseInt(Nri_GetArg(argc, argv, i + 1)), 64), Math.max(parseInt(Nri_GetArg(argc, argv, i + 2)), 64));
                i += 2;
            } else if (arg == "-gravity" && i + 1 < argc) {
                sandbox.gravityMode = Math.max(GRAVITY_NAMES.indexOf(Nri_GetArg(argc, argv, i + 1)), 0);
                i++;
            } else if (arg == "-sound") {
                sandbox.soundCheck = true;
            } else if (arg == "-bodies" && i + 1 < argc) {
                sandbox.bodies = parseInt(Nri_GetArg(argc, argv, i + 1)) != 0;
                i++;
            } else if (arg == "-air" && i + 1 < argc) {
                sandbox.air = parseInt(Nri_GetArg(argc, argv, i + 1)) != 0;
                i++;
            } else if (arg == "-viscosity" && i + 1 < argc) {
                sandbox.viscositySweeps = Math.max(parseInt(Nri_GetArg(argc, argv, i + 1)), 0);
                i++;
            } else if (arg == "-smooth" && i + 1 < argc) {
                sandbox.smooth = Math.max(parseInt(Nri_GetArg(argc, argv, i + 1)), 0);
                i++;
            }
        }
        Nri_UseImgui(sample);
        return sandbox.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return PowderSandboxNri.main(argc, argv);
}
