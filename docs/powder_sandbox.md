# Powder sandbox: state and roadmap

`powder_sandbox_nri` (`examples/nri/powder_sandbox_nri.ts`, `shaders/powder_sandbox.hlsl`) is a
falling-sand sandbox in the spirit of The Powder Toy, and the first game of a small engine built
from this repo's NRI layer. The game is its own editor: you pick a material and paint, so there is
no separate editor to write. Android is the main target; Windows (D3D12, Vulkan) is for testing.

What sets it apart from The Powder Toy is the physics: the liquids are incompressible, so water
levels out in connected vessels. That's the U-tube test, and every change has to keep passing it.

## Where it stands

- **Simulation:** water, oil, sand (and, from this roadmap, lava) are FLIP particles on a MAC grid.
  A variable-density pressure solve (multigrid, warm-started from the last step) plus a
  particle-density correction keeps their volume. Sand takes the grid's velocity and holds a pile
  by static friction. Fire, smoke and steam rise by buoyancy; neutrons fly straight.
- **Fixed time step:** 1 / (60 substeps) s per step, from accumulated frame time. The warm-started
  pressure is in units of dt, so a dt that follows the frame time (on some setups frame times
  alternate 0.5 / 13 ms) tears the water apart.
- **Temperature:** in every particle and cell, diffused across the grid. It drives boiling and
  condensing, oil igniting, wood burning, uranium heating up.
- **Painting:** a toolbar of materials and tools (Heat, Cool, Erase); circle, square, line and box
  brushes with an outline cursor; mouse or touch.
- **Window:** resizable; the grid keeps its cells and is fitted to the window, and is remade when
  the window turns (a phone turned), keeping what it holds.
- **Tests:** `-test` (U-tube levels), `-scene 2` (showcase), `-scene 3` (lava), `-roundTrip` (undo,
  save/load), `-regrid 1` / `-regrid 2` (the grid remade), on D3D12 and Vulkan, on the Android
  emulator and on a phone.

## Roadmap

In order. Each step lands with its own test or scene where the behavior can be checked.

### 1. Lava, ice and stone (done)

The temperature system already moves heat around; these make it visible and give every existing
material something to react with.

- **Lava**: a FLIP liquid (particle type 8), dense (2.6, sinks through water), at 1200 °C. It's
  thick: the hotter, the runnier (its sideways velocity is damped at a rate that falls with
  temperature; it still falls freely). It sets wood and oil alight and boils water through the heat it gives off.
  Emitters can emit it.
- **Stone**: a solid cell. A cell holding lava that has cooled below 700 °C turns to stone (its
  lava particles are absorbed). Stone above 1000 °C melts back into lava.
- **Ice**: a solid cell, painted at -30 °C. A cell holding water below -0.5 °C freezes to ice.
  Ice above 0 °C melts into water, but only after taking in its **latent heat**: the heat above
  0 °C goes into melting (80 degree-equivalents, as water's latent heat is about 80 times its
  specific heat), so ice holds at 0 °C while it melts instead of vanishing on contact with warm
  water. Stone melts the same way (200).
- Freezing and solidifying run in `spawn_cs` (cell rules), melting in `heat_diffuse_cs` (it marks
  the cell, `spawn_cs` turns it into particles).
- **Test scene 3**: lava poured into a pool next to an ice block and wood. `-scene 3 -test` checks
  that stone formed and some ice melted.
- Two changes to the heat model came with it:
  - **Air holds little heat.** Empty air conducted 0.08 per step, as if it held as much heat as
    rock: lava lost about 12,000 °C/s into it, set at once, and the air above it glowed. It's 0.002
    now, so lava cools in air over seconds and still crusts at once in water.
  - **Particles sharing a cell even out** toward the cell's mean (which keeps the heat). Before,
    heat moved only between cells, so water in the same cell as lava never boiled.

### 2. Undo and save/load (done)

What players build is worth keeping, and on a phone a mistaken stroke is easy.

- **The state**: the particles, the grid's float sections (temperatures, the pressure the next
  step starts from, burning and melting), the cells and the free list, one after another: about
  11.6 MB. The int sections are counts every step remakes, so they're left out.
- **Undo**: 4 snapshots on the GPU (46 MB), taken as a stroke begins and before Clear and Load;
  the Undo tile or Ctrl+Z restores the newest (and drops scene strokes still to be painted).
- **Save/load**: one slot, `powder_sandbox.save` beside the executable (the app's data directory
  on Android): a header (magic, version, grid width and height, particle slots), then the state.
  The file is written to a temporary first, so a failed save keeps the old one. A save from a grid
  of another size loads at its size (with margins), or is remade to the window's if it's the other
  way around (see Rotation below).
- Interop: `Nri_CmdCopyBufferRegion`, `Nri_SaveBufferToFile`, `Nri_CreateStorageBufferFromFile`.
- **Test**: `-utube -roundTrip` clears the U-tube halfway (without repainting) and undoes it, then
  saves, clears and loads; if either restore failed the U-tube would end empty.

### 3. Real-phone pass (in progress)

Run so far on two phones:

- **Galaxy S23 Ultra** (Adreno 740, Vulkan 1.3, Android 16): all four tests pass (U-tube, showcase,
  lava, round trip); interactive at 120 fps (its display's rate) with the showcase's ~35,000
  particles; touch picks tiles and paints. Two fixes came out of it:
  - Adreno's compiler fails on `OpCopyLogical`, which DXC emits for a whole-struct load or store
    of a structured buffer (`u_Particles[i] = p`); particles are now read and written member by
    member (`loadParticle`, `storeParticle`). The SPIR-V was valid (spirv-val, Vulkan 1.3).
  - The HUD wraps onto more lines where the window is narrow (it was cut off in portrait).
- **Galaxy S21 Ultra** (Exynos 2100, Mali-G78): its driver is Vulkan 1.1 with no dynamic
  rendering, synchronization2 or extended dynamic state, all of which NRI requires: NRI can't
  create a device. Phones like it are out of reach unless NRI's Vulkan backend gets fallbacks for
  those (render passes, the older barriers, static pipeline state).
- Testing on a phone needs its screen on and unlocked (Developer options > Stay awake): a dozing
  phone destroys the window, and the tests then fail with no particles. A Family Link supervised
  phone suspends a newly installed APK.

- **Rotation**: the window gets the new size (the manifest's `configChanges`), and when it turns
  from wider than tall to taller than wide (or back) the grid is remade in its shape: 144 cells
  along the shorter side, as at startup. What it held keeps its place on the floor, centered across;
  what falls outside the new walls is lost (turning back doesn't bring it back). Undo goes back to
  before the turn (shown with margins, not remade again). Within one orientation a resize keeps the
  grid and shows margins, so dragging a desktop window's edge doesn't crop it again and again.
  - The grid's buffers are sized for the longest grid (432 cells, a window about 3 to 1), whichever
    way it's turned, so a regrid needs no new buffers and the snapshots and saves stay one size
    (saves are version 2). A wider window shows margins.
  - `regrid_grid_cs` and `regrid_particles_cs` move the cells, their temperatures and the particles
    (from a copy in the int sections, which every step remakes); the old grid's walls aren't carried
    over, and particles that end in a wall are freed.
  - Tests: `-utube -regrid 1` remakes the grid 20 cells taller and back (every particle kept),
    `-utube -regrid 2` turns it (cropped, the U-tube still levels out); both check the wall around
    the grid and that no particle is in a solid cell.
  - Not yet tried by turning a phone (none was connected).

- **The GPU's time per step** is measured (two timestamps around the simulation) and shown in
  the HUD: about 0.2 ms on a desktop GPU.
- **A faster pressure solve, for slower phones.** The 40 red-black SOR sweeps were two thirds of a
  step. Fewer sweeps (tried as an automatic quality setting) leave the U-tube sloshing, up to
  2.5 cells apart: a sweep only evens the pressure out between neighbors, so the pressure across
  a whole vessel takes many. Fewer steps would change the heat, which moves per step (at one step
  a frame the ice no longer melts). So the solve is now multigrid: one V-cycle a step, 2 red-black
  sweeps on each level going down and again coming up, the coarsest level (at most 256 cells)
  solved in one workgroup. Level 0 is the grid itself (`pressure_cs` smooths it, not
  over-relaxed); the coarser levels live in a sixth buffer (not part of the state) and are set up
  each step from the finer ones (a coarse cell is air if any of its four is, solid if all are; a
  coarse face is the mean of its two finer ones). 45 dispatches a step instead of 80.
  - Measured on a desktop GPU (Vulkan, D3D12): 10 to 30% less GPU time a step, the pressure
    equation's mean residual 3 to 10 times smaller (`-test` logs it), and the U-tube's sides
    within 0.06 cells of each other from 40 s on (SOR: 0.27 at 60 s). On a phone the saving
    should be larger (it's the dispatches and barriers that cost there), but that's not measured
    yet.
  - `-solver sor` (with `-iterations N`) keeps the old solve; `-vcycles N` and `-smooth N` tune the
    new one.

Still to do:

- Rotation on a phone.
- The step's time on a slower phone (the HUD shows it).
- Tap-and-hold to read a cell (touch has no hover); pinch to zoom and two-finger pan.

### 4. More materials

Each is mostly a rule in the shader:

- **Salt / salt water**: salt dissolves; salt water is denser, so it sinks below fresh water.
- **Acid**: eats solids except glass.
- **Gunpowder / explosives**: a burst of heat and of pressure, carried by the pressure solve.
- **Metal**: conducts heat (later electricity, for wires, heaters and switches).

### 5. Physics

- **Viscosity** as a real diffusion of velocity (honey), replacing lava's damping.
- **Air as a fluid**: wind and fans, blast waves moving gases and light powders.
- **Rigid bodies**: blocks that float and tip over.
- **Surface tension**: droplets and thin streams.

### 6. Engine side

- **Scenes as data**: levels and challenges in JSON files instead of code.
- **Sound**: splashes, fizzing, fire, driven by particle events.
- **Auto quality**: substeps and grid size chosen from measured frame time.
