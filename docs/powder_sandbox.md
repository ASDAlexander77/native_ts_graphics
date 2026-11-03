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
- **Tests:** `-test` (U-tube levels), `-scene 2` (showcase), `-scene 3` (lava), `-scene 4` (metal,
  acid, salt), `-scene 5` (gunpowder), `-scene 6` (honey), `-scene 7`
  (surface tension), `-roundTrip` (undo,
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

- **Zoom and pan.** Two fingers pinch to zoom (around their midpoint, up to 8x) and drag to pan;
  on a desktop, Ctrl+wheel zooms and the middle button drags (the plain wheel still sizes the
  brush). The Android window already reports two fingers that way: the middle button held, the
  cursor between them, the pinch as wheel notches. A second finger down within 0.3 s of the first
  takes back what the first had begun painting (it was a pinch, not a stroke). The view keeps the
  grid filling the screen where it can; a regrid shows the whole grid again. `-zoom Z` starts
  zoomed (for a test's frame).
- **Inspect**, a tile: touching paints nothing, a crosshair marks the cell under the finger and the
  HUD reads it (temperature, pressure, contents). A long press couldn't do it: holding still is
  how you pour.

Still to do:

- Zoom, pan and Inspect by hand on a phone (built and checked headless only).
- Rotation on a phone.
- The step's time on a slower phone (the HUD shows it).

### 4. More materials (done)

Each is mostly a rule in the shader. Particle types are now 1 .. 11 (each with a count section);
the probe's readback puts the counts below the salinity, so 11 is as many as it holds. The save
format is unchanged (version 2): the new state lives in the particles.

- **Metal**: a solid cell that conducts heat at 1.0, as fast as the explicit diffusion allows
  (stone 0.3, glass 0.5). Later, electricity: wires, heaters and switches.
- **Acid**: a FLIP liquid (type 9, density 1.3). Each step an acid particle tries the face it's
  moving through; a solid behind it (not glass, nor the wall around the grid) is eaten at
  `ACID_RATE` 2 a second, using the particle up. The cell is claimed with a compare-exchange, so
  one particle eats it.
- **Salt / salt water**: salt is a powder (type 10, density 2.2, piles like sand). A WATER
  particle's `life` is its salinity, 0 to 1, and makes it up to 25% denser, so salt water sinks
  under fresh. Salt in a cell whose water is under 90% salinity dissolves at 1 a second, into a
  water particle at salinity 1. The water in a cell evens its salinity out (`SALT_MIX` 0.3 a
  second). Salty water that boils leaves salt as often as it is salty. The Salt water tile paints
  water at salinity 1; the display tints salty water greener; Inspect shows a cell's salinity.
- **Gunpowder**: a powder (type 11, density 1.7) that goes off at 250 °C. Particle-to-grid counts
  the cell's grains going off (`I_BLAST`), the divergence takes `BLAST_VOLUME` 1.5 cells of gas
  per grain, and the pressure solve pushes the material around away. Each grain becomes fire at
  1500 °C, flung outward. It's in its own scene: next to the others, its fire lit the acid tub's
  wood and boiled the salt tank.
- **Heat and Cool fix**: the brushes painted their tool ids (33, 34) into the cells, making
  unknown solids under the stroke. They heat and cool now.
- **Test scene 4**: a metal and a stone bar heated at one end (the metal 100 °C at the probe, the
  stone 50 °C), acid over wood in a glass tub (all the wood eaten, the glass kept), salt poured
  into a tank of fresh water (all dissolved; the bottom third about 10% salt, the top under 1%).
- **Test scene 5**: gunpowder under a layer of sand, against a glass wall with a pool behind it,
  lit from its side. It all goes off, the blast throws at least a tenth of the sand clear of the
  pile, the wall holds, and no particle ends up inside a solid.

### 5. Physics (in progress)

- **Viscosity** (done): honey (type 12, density 1.4, viscosity 10,000 cells²/s) and lava (200
  cold, 40 at 1200 °C) diffuse their velocity, replacing lava's sideways damping.
  - Particle-to-grid sums each face's viscosity (from the viscous particles only), and
    `viscosity_cs` solves the implicit diffusion `(1 + n a) u - a sum(neighbors) = u*` (`a` the
    face's viscosity times dt) by red-black Gauss-Seidel, 4 sweep pairs a step (`-viscosity N`, 0
    off). Solid neighbors count at 0 (no slip), air ones not at all (a free surface).
  - Faces without viscosity are skipped, so water is untouched, and the sweeps run only while a
    viscous particle exists (a flag read back with the HUD probe): no cost without honey or lava.
  - Viscous particles take the grid's velocity (PIC): FLIP's own velocity would undo the diffusion.
  - Gauss-Seidel carries the diffusion a few cells a step, so the liquid is rigid over a few cells:
    poured honey lands and piles, a large body slumps to a thick slab. Holding a tall column would
    need a multigrid solve per velocity component.
  - The probe's counts are packed two to an int (room for 22 types); `u_Alloc` is saved, so its
    free list stays at 16 and saves are still version 2.
  - **Test scene 6**: a block of water and one of honey let go side by side. The honey's mean height
    must be 1.3 times the water's and its front under 0.6 times as far (5.1 vs 3.3 cells, 62 vs 144);
    with `-viscosity 0` the honey runs like water (3.0 cells, 143) and the test fails.
- **Surface tension** (done), for thin liquid only: drops, streams and films.
  - A liquid particle drifts toward the side of its 3 x 3 cells holding more liquid (particle-to-grid
    counts each cell's liquid particles, capped at the rest count), at up to 150 cells a second.
  - It fades out as the 5 x 5 cells around fill up to 12 cells' worth. A body of liquid, its surface
    too, is past that: there the pull only fought the pressure solve (the U-tube's levels sank 5
    cells and its residual rose a hundredfold when it acted on every surface).
  - Uncapped counts made it unstable: full cells pulled harder, packing the water into a few cells.
  - Bulk particles (their 3 x 3 cells full) return early; it costs nothing measurable.
  - **Test scene 7**: a film of water one cell thick on the floor pulls into beads, covering at most
    60% of its columns (36 of 115; without surface tension it stays a film over 110).
- **Air as a fluid**: wind and fans, blast waves moving gases and light powders.
- **Rigid bodies**: blocks that float and tip over.

### 6. Engine side

- **Scenes as data**: levels and challenges in JSON files instead of code.
- **Sound**: splashes, fizzing, fire, driven by particle events.
- **Auto quality**: substeps and grid size chosen from measured frame time.
