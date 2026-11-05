/// <reference path="../core/nri/nri_interop.d.ts" />
import {
    DEFAULT_GRID_HEIGHT, MIN_GRID_HEIGHT, SOLVER_SOR, SOLVER_MULTIGRID, GRAVITY_NAMES
} from "./defs";
import { PowderSandbox } from "./checks";
import { Nri, NriSample } from "../core/nri";

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
        const sample = NriSample.create();
        sample.useResizableWindow();
        const sandbox = new PowderSandbox(sample);
        sample.addExampleOption("-utube");
        sample.addExampleOption("-roundTrip");
        sample.addExampleOptionWithValues("-regrid", 1);
        sample.addExampleOptionWithValues("-scene", 1);
        sample.addExampleOptionWithValues("-sceneFile", 1);
        sample.addExampleOptionWithValues("-solve", 1);
        sample.addExampleOptionWithValues("-testStars", 1);
        sample.addExampleOptionWithValues("-gridHeight", 1);
        sample.addExampleOptionWithValues("-quality", 1);
        sample.addExampleOptionWithValues("-stepBudget", 1);
        sample.addExampleOptionWithValues("-view", 1);
        sample.addExampleOptionWithValues("-substeps", 1);
        sample.addExampleOptionWithValues("-iterations", 1);
        sample.addExampleOptionWithValues("-solver", 1);
        sample.addExampleOptionWithValues("-zoom", 1);
        sample.addExampleOptionWithValues("-vcycles", 1);
        sample.addExampleOptionWithValues("-smooth", 1);
        sample.addExampleOptionWithValues("-viscosity", 1);
        sample.addExampleOptionWithValues("-air", 1);
        sample.addExampleOptionWithValues("-bodies", 1);
        sample.addExampleOption("-mute");
        sample.addExampleOption("-profile");
        sample.addExampleOptionWithValues("-gravity", 1);
        sample.addExampleOptionWithValues("-tilt", 2);
        sample.addExampleOptionWithValues("-window", 2);
        sample.addExampleOption("-sound");
        sample.addExampleOptionWithValues("-testFrames", 1);
        for (let i = 1; i < argc; i++) {
            const arg = Nri.getArg(argc, argv, i);
            if (arg == "-utube") {
                sandbox.scene = 1;
            } else if (arg == "-roundTrip") {
                sandbox.roundTrip = true;
            } else if (arg == "-regrid" && i + 1 < argc) {
                sandbox.regrid = Math.min(Math.max(parseInt(Nri.getArg(argc, argv, i + 1)), 0), 2);
                i++;
            } else if (arg == "-substeps" && i + 1 < argc) {
                sandbox.substeps = Math.max(parseInt(Nri.getArg(argc, argv, i + 1)), 1);
                i++;
            } else if (arg == "-view" && i + 1 < argc) {
                sandbox.overlay = Math.min(Math.max(parseInt(Nri.getArg(argc, argv, i + 1)), 0), 2);
                i++;
            } else if (arg == "-gridHeight" && i + 1 < argc) {
                sandbox.gridHeight = Math.min(Math.max(parseInt(Nri.getArg(argc, argv, i + 1)), MIN_GRID_HEIGHT), DEFAULT_GRID_HEIGHT);
                sandbox.gridHeightSet = true;
                i++;
            } else if (arg == "-quality" && i + 1 < argc) {
                sandbox.quality = Nri.getArg(argc, argv, i + 1);
                i++;
            } else if (arg == "-stepBudget" && i + 1 < argc) {
                sandbox.stepBudget = Math.max(parseFloat(Nri.getArg(argc, argv, i + 1)), 0.001);
                i++;
            } else if (arg == "-sceneFile" && i + 1 < argc) {
                sandbox.sceneFile = Nri.getArg(argc, argv, i + 1);
                i++;
            } else if (arg == "-solve" && i + 1 < argc) {
                sandbox.solveTime = Math.max(parseFloat(Nri.getArg(argc, argv, i + 1)), 0.0);
                i++;
            } else if (arg == "-testStars" && i + 1 < argc) {
                sandbox.testStars = Math.min(Math.max(parseInt(Nri.getArg(argc, argv, i + 1)), 0), 3);
                i++;
            } else if (arg == "-scene" && i + 1 < argc) {
                sandbox.scene = parseInt(Nri.getArg(argc, argv, i + 1));
                i++;
            } else if (arg == "-testFrames" && i + 1 < argc) {
                sandbox.testFrames = Math.max(parseInt(Nri.getArg(argc, argv, i + 1)), 1);
                i++;
            } else if (arg == "-iterations" && i + 1 < argc) {
                sandbox.iterations = Math.max(parseInt(Nri.getArg(argc, argv, i + 1)), 1);
                i++;
            } else if (arg == "-zoom" && i + 1 < argc) {
                sandbox.startZoom = parseFloat(Nri.getArg(argc, argv, i + 1));
                i++;
            } else if (arg == "-solver" && i + 1 < argc) {
                sandbox.solver = Nri.getArg(argc, argv, i + 1) == "sor" ? SOLVER_SOR : SOLVER_MULTIGRID;
                i++;
            } else if (arg == "-vcycles" && i + 1 < argc) {
                sandbox.vcycles = Math.max(parseInt(Nri.getArg(argc, argv, i + 1)), 1);
                i++;
            } else if (arg == "-profile") {
                sandbox.profile = true;
            } else if (arg == "-mute") {
                sandbox.mute = true;
            } else if (arg == "-tilt" && i + 2 < argc) {
                sandbox.setTilt(parseFloat(Nri.getArg(argc, argv, i + 1)), parseFloat(Nri.getArg(argc, argv, i + 2)));
                i += 2;
            } else if (arg == "-window" && i + 2 < argc) {
                // (the window's size: -window 540 1170 is a phone held upright)
                sample.setWindowSize(Math.max(parseInt(Nri.getArg(argc, argv, i + 1)), 64), Math.max(parseInt(Nri.getArg(argc, argv, i + 2)), 64));
                i += 2;
            } else if (arg == "-gravity" && i + 1 < argc) {
                sandbox.gravityMode = Math.max(GRAVITY_NAMES.indexOf(Nri.getArg(argc, argv, i + 1)), 0);
                i++;
            } else if (arg == "-sound") {
                sandbox.soundCheck = true;
            } else if (arg == "-bodies" && i + 1 < argc) {
                sandbox.bodies = parseInt(Nri.getArg(argc, argv, i + 1)) != 0;
                i++;
            } else if (arg == "-air" && i + 1 < argc) {
                sandbox.air = parseInt(Nri.getArg(argc, argv, i + 1)) != 0;
                i++;
            } else if (arg == "-viscosity" && i + 1 < argc) {
                sandbox.viscositySweeps = Math.max(parseInt(Nri.getArg(argc, argv, i + 1)), 0);
                i++;
            } else if (arg == "-smooth" && i + 1 < argc) {
                sandbox.smooth = Math.max(parseInt(Nri.getArg(argc, argv, i + 1)), 0);
                i++;
            }
        }
        sample.useImgui();
        return sandbox.run(argc, argv);
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>) {
    return PowderSandboxNri.main(argc, argv);
}
