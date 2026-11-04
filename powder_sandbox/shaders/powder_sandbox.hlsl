// powder_sandbox_nri: a falling-sand sandbox with real fluid physics. Liquids and powders are FLIP
// particles on a staggered (MAC) grid with a variable-density pressure projection, so water is
// incompressible: it levels out in connected vessels, sloshes and keeps its momentum. Oil (lighter)
// floats, sand (heavier) sinks and piles. Fire, smoke and steam are free particles that rise; neutrons
// fly straight from uranium. Every particle and cell carries a temperature that diffuses through the
// grid and drives boiling, condensation, ignition and burning.
//
// The grid is gridW x gridH cells, a cell one unit, y down (gravity +y). Every grid array is a
// section of `stride` = (gridW + 1) * (gridH + 1) elements of one of three buffers, so a cell, a
// u face (at x = i, y = j + 0.5) or a v face (at x = i + 0.5, y = j) all fit in a section.

#include <donut/shaders/binding_helpers.hlsli>

#include "common.hlsli"

// --- Simulation (compute) ------------------------------------------------------------------

#ifdef SIMULATION
#include "sim_grid.hlsli"
#include "sim_setup.hlsli"
#include "sim_transfer.hlsli"
#include "sim_viscosity.hlsli"
#include "sim_air.hlsli"
#include "sim_bodies.hlsli"
#include "sim_goal.hlsli"
#include "sim_heat.hlsli"
#include "sim_pressure.hlsli"
#include "sim_project.hlsli"
#include "sim_sparks.hlsli"
#include "sim_g2p.hlsli"
#include "sim_spawn.hlsli"
#include "sim_glow.hlsli"
#include "sim_probe.hlsli"
#endif // SIMULATION

// --- Display ---------------------------------------------------------------------------------

#ifndef SIMULATION
#include "display.hlsli"
#endif // !SIMULATION
