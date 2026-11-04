# Powder sandbox: state and roadmap

`powder_sandbox_nri` (this folder: the app's `.ts` files, `shaders/powder_sandbox.hlsl`, the levels
in `media/`, the build and tests in `powder_sandbox.cmake`) is a falling-sand sandbox in the spirit of The Powder Toy, and the
first game of a small engine built from this repo's NRI layer. The game is its own editor: you pick
a material and paint, so there is no separate editor to write. Android is the main target; Windows (D3D12, Vulkan) is for testing.

What sets it apart from The Powder Toy is the physics: the liquids are incompressible, so water
levels out in connected vessels. That's the U-tube test, and every change has to keep passing it.

## Where it stands

- **Simulation:** water, oil, sand (and, from this roadmap, lava) are FLIP particles on a MAC grid.
  A variable-density pressure solve (multigrid, warm-started from the last step) plus a
  particle-density correction keeps their volume. Sand takes the grid's velocity and holds a pile
  by static friction. Fire, smoke and steam rise by their heat; neutrons fly straight.
- **Fixed time step:** 1 / (60 substeps) s per step, from accumulated frame time. The warm-started
  pressure is in units of dt, so a dt that follows the frame time (on some setups frame times
  alternate 0.5 / 13 ms) tears the water apart.
- **Temperature:** in every particle and cell, diffused across the grid. It drives boiling and
  condensing, oil igniting, wood burning, uranium heating up.
- **Toolbar:** two rows: tabs for the groups (Liquid, Powder, Gas, Solid, Power, Special, Tools,
  Game), and the chosen group's tiles under them; each row scrolls sideways when it doesn't fit. The
  tab whose group holds the tool in hand is underlined in its color. (One row of all 50-odd tiles
  meant scrolling through six screens of it on an upright phone.) The taller toolbar made the test
  window's grid wider (308 cells, from 290), and three tests had only passed at some widths: the cup's
  goal is 900 now, the black hole's bin narrower, the coal scene's fire lasts 10 frames; each now
  passes from a 277- to a 326-cell-wide grid.
- **Brush menu:** a press held still on the grid for 0.45 s opens the brush shapes in a ring around
  it (Circle up, Square right, Line down, Box left), the one in use lit; released on one, or a tap on
  one next, picks it; a tap elsewhere closes it. What the held press painted is taken back (so holding
  still to pour now opens the menu: keep the finger moving). While the brush is a circle, a square or a
  line, a slider along the top sizes it (0.5 to 30 cells: a line's half width); the HUD sits under
  it.
- **Painting:** materials and tools (Heat, Cool, Erase); circle, square, line and box
  brushes with an outline cursor; mouse or touch.
- **Window:** resizable; the grid keeps its cells and is fitted to the window, and is remade when
  the window turns (a phone turned), keeping what it holds.
- **Tests:** `-test` (U-tube levels), `-scene 2` (showcase), `-scene 3` (lava), `-scene 4` (metal,
  acid, salt), `-scene 5` (gunpowder), `-scene 6` (honey), `-scene 7` (surface tension), `-scene 8`
  (wind), `-scene 9` (blocks), `-scene 10` (acid in water), `-scene 11` (oil and petrol burning),
  `-scene 12` (gases), `-scene 13 -gravity off|point|tilt` (no gravity, an attraction point, tilted),
  `-scene 14` (circuits), `-scene 15` .. `20` (electrolysis and neon, hydrogen and a fuse, thermite,
  nitroglycerin, C-4, coal), `-scene 21` .. `24` (clone, holes, sponge and seeds, switches),
  `-sceneFile test_fill` (a level's goal), `-sceneFile <challenge> -solve 1 -testStars 3` and
  `-testStars 0` (each challenge solved, and untouched), `-stepBudget 0.01` (auto
  quality), `-roundTrip` (undo, save/load), `-regrid 1` / `-regrid 2` (the grid remade), on D3D12 and
  Vulkan, on the Android emulator and on a phone.

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
    (saves were version 2 then; the blocks of step 5 made them 3). A wider window shows margins.
  - `regrid_grid_cs` and `regrid_particles_cs` move the cells, their temperatures and the particles
    (from a copy in the int sections, which every step remakes); the old grid's walls aren't carried
    over, and particles that end in a wall are freed.
  - Tests: `-utube -regrid 1` remakes the grid 20 cells taller and back (every particle kept),
    `-utube -regrid 2` turns it (cropped, the U-tube still levels out); both check the wall around
    the grid and that no particle is in a solid cell.
  - On the S23 (turned by its rotation setting, both ways sideways and back upright): each turn
    remakes the grid (80 x 151 to 198 x 80 and back, at auto quality), the toolbar and the HUD are
    laid out again, what it held stays on the floor and what's past the new sides is cropped.

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
  how you pour. Holding still with Inspect (or while placing the attraction point) doesn't open the
  brush menu: neither has a brush, and on the S23 the menu came up over the cell being read.
- **Profile** (`-profile`): every 30 frames, a timestamp after each of the simulation's dispatches;
  every 8 such frames, each kernel's mean milliseconds a frame, the costliest first. On the S23
  (Adreno 740) a kernel's time shows on the one after it: the timestamps don't wait for the kernel
  before (cutting a kernel's work drops the next one's figure).
- **g2p on the S23** (found with it): the U-tube took 74 ms a frame on the 144-row grid (about 25 ms a
  step; 7.5 ms once), 64 of them in g2p_cs. `fluidCell` summed a cell's twelve FLIP types' counts,
  8 times a velocity sample, three samples a liquid particle a step: about 300 reads of counts a
  particle. p2g_cs now counts the FLIP particles once into their own section (`I_FLIP`), and
  `flipCount` reads that: 16.8 ms a frame, g2p_cs 7.5 ms. (On the desktop's GPU it hardly showed.)

- **The whole suite on the S23** (2026-11-04): every test passes, the levels and challenges
  included (the upright-window ones are for a desktop: the phone is upright already).
  `turned` lost 2 of 61,344 particles every run, the same 2: on the phone's upright grid
  (144 x 271) the U-tube's first surge throws water up to the ceiling, and two particles were left
  clinging in its top corner for many seconds; turned on its side, the grid's top is cropped and
  them with it. A drop pressed against a ceiling lets go slowly: a velocity sampled near the
  ceiling is interpolated toward its face's zero, and the pressure solve sends half the pull of
  gravity out the cell's other open side. The test now allows a few (`CLINGING_DROPS`, 16).
- **Frame rate**: the simulation's 180 steps a second take most of the S23's GPU in the showcase
  (3.4 ms a step at 12,000 particles: 38 fps; 1.7 ms at 2,300: 100 fps). Rotation doesn't change it.
- **Zoom and pan by hand** on the S23: pinch-zoom and the two-finger pan work (adb can't do it: it
  injects one finger only, and `sendevent` is denied on a phone that isn't rooted).
- **Sound**: on the S23 the app plays an AAudio stream (media, 48 kHz stereo, low latency); the
  tests count the events.

Still to do:

- Listen to the sound on a phone.
- The step's time on a slower phone (the HUD shows it).
- Drops clinging under a ceiling (above): letting them fall would mean sampling a solid face's
  velocity from the free side, which every wall in every scene goes through.

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
  lit from its side. It all goes off, the blast throws at least a twentieth of the sand clear of the
  pile, the wall holds, and no particle ends up inside a solid.

### 5. Physics (done)

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
  - A liquid particle is pulled toward the side of its 3 x 3 cells holding more liquid
    (particle-to-grid counts each cell's liquid particles, capped at the rest count), at up to 4000
    cells a second squared, on its velocity. It first moved the particle's position instead (150
    cells a second): a drift like that carries no momentum, so it held small drops up in the air,
    and an emitter's water never fell; pulled on their velocities, a drop's particles' pulls cancel
    out and it falls, and the U-tube's pressure residual is as without it (0.37, against 4.8).
  - It fades out as the 5 x 5 cells around fill up to 12 cells' worth. A body of liquid, its surface
    too, is past that: there the pull only fought the pressure solve (the U-tube's levels sank 5
    cells and its residual rose a hundredfold when it acted on every surface).
  - Uncapped counts made it unstable: full cells pulled harder, packing the water into a few cells.
  - Bulk particles (their 3 x 3 cells full) return early; it costs nothing measurable.
  - **Test scene 7**: a film of water one cell thick on the floor pulls into beads, covering at most
    60% of its columns (27 of 115; without surface tension it stays a film over 110).
- **Air as a fluid** (done): wind, fans, and blasts that move gases and airborne grains.
  - A coarse grid, a cell 8 x 8 of the simulation's (37 x 18 at 290 x 144), its face velocities at
    the start of the multigrid buffer, not saved: the wind starts calm after a load and a regrid.
  - `air_cs` moves it once a frame, over the frame's steps, in one workgroup: an air cell is blocked
    when as many of its cells as two lines across it are solid (fans let air through) or hold
    liquid; fans push it, damping slows it (1 a second), it carries itself along
    (semi-Lagrangian), and a red-black pressure solve in groupshared memory (20 sweeps, from the
    last frame's) keeps it incompressible but for gunpowder's gas. The liquids' solve is untouched.
  - Past the grid's edge the air is open, at pressure 0. In a closed box a fan only drove one swirl
    round the box: the air it pushed came back over it, and sand falling through both went nowhere.
  - Once a frame, not a step: stepped 180 times a second, the coarse grid's interpolation blurred a
    fan's jet away before it reached anything.
  - Gases relax toward the wind as they slowed toward rest before (3% a step), so still air changes
    nothing; airborne grains (under the rest count in their cell) are dragged at 3 a second.
  - **Fan**: a solid tile that blows the way the pointer moves while painting it (up for a tap); it
    shows stripes moving that way. Inspect shows the wind at a cell.
  - Costs 0.014 ms a step on desktop. `-air 0` turns it off.
  - The coarse grid misses detail: air under a ceiling sits in a blocked cell, so smoke collecting
    there isn't blown along.
  - **Test scene 8**: a fan blowing across a stream of sand falling inside its jet: the sand lands
    56 to 76 cells right of the emitter, at least 5% of the grid's width (1 with `-air 0`).
- **Rigid bodies** (done): blocks that float and tip over.
  - Up to 16 rectangles, their records (center, angle, velocity, spin, half extents, density) in a
    13th float section: saved, undone and regridded with the rest. Saves are version 3: version 2
    files are refused ("from another version").
  - `bodies_cs`, a workgroup a body after the pressure solve: the liquid's pressure on its cells'
    faces (buoyancy falls out of it), gravity, drag where wet; contacts with solids and other bodies
    at points a cell apart along its edges, pushed out the shortest way into a free cell, the
    closing velocity taken off (restitution 0.1) with friction (0.6). A contact off the center turns
    it, so a block half over a ledge tips off.
  - It then clears its old cells and draws itself where it is (BLOCK, the body in bits 8..11), not
    over solids or other bodies. Particles in its cells are pushed out past its nearest edge at its
    velocity instead of being freed.
  - **Block**: a tile that's always a box: dragging it makes a body that size (density 0.6, so it
    floats with 60% under). Erasing over a block's center removes it; Clear removes them all.
  - Only the first workgroup makes new bodies: each looking for the first free record, a group
    could see another's new body and make a second copy.
  - The liquid isn't pushed by a moving block's faces (they count as still walls); it's moved by
    the particles pushed out, which makes a falling block splash less than it should.
  - **Test scene 9**: a block dropped into a pool floats (its center 0.5 to 1 cell under the
    surface, within half its height), and a tall one standing half over a ledge tips off it
    (turned 1.57 radians, lying on the floor). Also checked through a regrid and on D3D12.

### 6. Engine side (done)

- **Scenes as data** (done): levels in JSON files, `media/scenes/<name>.json` here (copied
  beside the executable, to `media/powder_sandbox/scenes/`, and into the APK's assets:
  `add_tslang_nri_example` takes `MEDIA` folders now, and an NRI app's APK waits for `copy_media`
  when it has some). Run on the S23: the
  level and challenge tests pass there.
  - A level: `{ "name": "...", "goal": { "text": "...", "material": "water", "box": [x0, y0, x1,
    y1], "count": N }, "strokes": [{ "tool": "glass", "box": [...], "emit": "sand", "blow": "right",
    "repeat": N }, ...] }`, boxes in fractions of the grid; tools and materials by their names
    (Inspect's), plus `erase`, `heat`, `cool` and `salt water`. A file that doesn't read, or names
    something unknown, is refused with a message saying what.
  - The goal: so many particles of a material (cells, for a solid) in the box. `goal_cs` counts it
    once a frame (one workgroup), read back with the HUD's probe; the HUD shows it, and "done" once
    it's reached.
  - The **Levels** tile goes through `index.json`'s list (`cup`: fill the cup from a pool behind a
    wooden dam; `stone`: get the lava on a shelf into the pool, where it sets: untouched it doesn't),
    clearing the grid for each. `-sceneFile name`
    starts on one; in a test its goal must be reached.
  - `core/json_reader.ts`: a small reader over a file's bytes, read in order by a caller who knows
    the shape it expects (no tree); strings are ASCII (tslang has no `String.fromCharCode`: they're
    built from a printable-character table).
  - The test scenes (`-scene 2` to `9`) stay in code: their checks share their geometry.
  - **Test** `level`: `test_fill.json`, an emitter over a cup (with a fan and fire, for the format's
    other fields): the cup gets its 400 particles of water.
- **Sound** (done; playing on the S23, not yet listened to there): splashes, fizzing, fire and booms, from the
  simulation's events.
  - `core/nri/nri_audio.cpp`: a playback device on the default output (miniaudio 0.11.21, one header,
    public domain or MIT-0, fetched by core/nri's CMake: WASAPI on Windows, AAudio or OpenSL ES on
    Android, loaded at run time) and four sounds synthesized from noise and a sine, no audio files:
    a splash (noise low-passed, its cutoff falling), a fizz (noise high-passed, flickering),
    crackle (sparse clicks), a boom (a falling low sine under rumble). Up to 24 voices, soft-clipped;
    `Nri_PlaySound` hands a voice to the callback, which only tries the lock.
  - Events: g2p counts each step's liquid impacts (a particle's velocity changed by over 50 cells a
    second in a step), acid eating a cell or water boiling, fire particles, and gunpowder going off,
    in an int section, one atomic a wave (`WaveActiveCountBits`); the frame's last step's are read
    back with the probe, times its steps.
  - Each sound plays when its event count is over its least (8 impacts, 30 fire particles, 3 grains
    going off, one fizz), louder by the count's log, then waits its cooldown (0.07 to 0.6 s); booms
    lower the bigger they are.
  - None in tests (`-sound` opens the device, playing nothing) nor with `-mute`. Tests log the event
    totals, and the showcase (splash, fire), scene 4 (fizz) and scene 5 (fire, boom) need theirs.
- **Auto quality** (done): the grid's size chosen from the GPU's measured step time.
  - Once, at the first start: the U-tube's water for 90 frames (an empty grid's step says little of
    a painted one's), its mean step time from frame 30 on; over the budget (2 ms a step: 6 ms of a
    60 Hz frame at 3 steps) the grid is made smaller, its cells fewer by that ratio (72 cells along
    its shorter side at the least). The session then starts at that size (a regrid would crop what's
    there). The size is cached in `powder_sandbox.quality` beside the save, so later starts skip it.
  - Only the grid: the substeps stay, as heat and the pressure solve are tuned per step and the
    heat's explicit diffusion is at its stability limit (fewer, longer steps would need it implicit).
  - `-gridHeight N` sets the size (no auto quality); `-quality fixed` turns it off, `calibrate`
    measures again. Tests don't measure (or read the cache) unless asked: `-stepBudget ms` measures
    against that budget without caching it.
  - On the desktop the step is 0.2 to 0.3 ms, so the grid stays 144 high. The Galaxy S23 takes
    7.5 ms a step at 144 x 279 (viscosity, air and blocks about 0.15 ms of it), so it calibrates to
    80 x 155.
  - **Test** `quality`: a budget of 0.01 ms: the showcase starts on a 145 x 72 grid.

### 7. Chemistry (done)

- **Acid in water**: acid sharing a cell with water dilutes into it at `DILUTE_RATE` 0.5 a second,
  becoming water `DILUTE_HEAT` 80 °C warmer (a fizz). It sinks under the water and is used up from
  where they meet; much acid in little water boils it.
- **Oil burns**: it catches from fire in its cell or beside it, or from heat (250 °C), only where
  it's open to the air (a side with no liquid or powder in it). Fire's heat alone lit a pool through
  at once; and a particle lit there turns to fire `CATCH_OIL` once a second on average (its fire
  living 3 to 5 s), so a burning slick burns down from its surface over many seconds.
- **Petrol** (type 13, density 0.7: it floats on oil): catches from fire `CATCH_PETROL` 40 times a
  second, and from 200 °C heat anywhere, so a pool goes up in a second or two. Lit, it burns hot
  (1200 °C) and short, flung up, and one particle in `PETROL_WHOOSH` 8 blasts as gunpowder's grains
  do (a whoosh that pushes the air, and a boom).
- The probe's readback packs the counts three to an int (10 bits each), room for 18 types. The save
  format is unchanged (version 3): the counts aren't saved.
- **Test scene 10**: acid poured over water in one glass tub and into an empty one. After 5 s the
  water's tub keeps about a ninth of the other's acid and is about 40 °C; with dilution off both
  keep it all and the test fails.
- **Test scene 11**: oil and petrol pools, both lit at their surface, and oil sealed under a glass
  lid. After 5 s the petrol is gone, the open oil keeps about two thirds of the sealed oil's; with
  catching off the oil doesn't burn and the test fails.

### 8. Gases and gravity (done)

- **Gas lift from heat**: a gas is lighter than the air around it by (T - ambient) / T (absolute),
  and steam by 0.38 more (its molar mass 18 to air's 29), so it rises against the gravity that much:
  fire about 0.73 g, smoke at 300 °C 0.49 g, cooled smoke nothing. Gases but fire cool toward
  ambient (`GAS_COOLING` 0.4 a second) and slow as they do. Smoke lingers 6 to 12 s.
- **Gases spread**: a gas particle is pushed from where its neighbors hold more gas
  (`GAS_SPREAD` 60 cells/s² a particle of difference), so smoke under a ceiling spreads into a layer
  (without it, a fire's smoke packed into a cell or two); the wander is in both directions now.
- **Plumes move the air**: the air grid takes the gases' lift (each coarse cell's, over `GAS_FULL`
  2 particles a cell), so a fire drives a plume: air drawn in at its base, turning over at the top,
  carrying the smoke.
- **Gravity**: down, off, or toward a point, as strong everywhere (a planet's), easing off within 2
  cells of it. It's applied on both velocity faces, to the blocks, to the drift of lighter and
  heavier liquids, against the gases' lift, and as the powders' down: the neighbor (of eight) the
  gravity points nearest, with the slides 45 degrees either side of it (with four, a slab of sand at
  45 degrees to the point never slid). With none, a powder rests on nothing.
  - The Gravity tile cycles Gravity, No gravity and Attract; with Attract a tap or drag on the grid
    moves the point (a ring), until another tool is picked. `-gravity down|off|point` (the point
    the grid's center).
  - In the constants the mode is in `brushShape`'s bits 8 and 9, the point in the last two floats.
    The save is version 4: its header holds the gravity's mode and point. Version 3 saves still
    load, their gravity down.
- **Test scene 12**: a wood fire under a glass ceiling. After 5 s the air above it rises at about
  60 cells a second and the smoke under the ceiling spans about a third of the width; with the air's
  lift off the air is still (and the test fails), with spreading off the smoke spans 3%.
- **Test scene 13**: a block of water and one of sand in mid-air. With no gravity their centers
  move under 2 cells in 5 s. Toward the point, in 10 s their mean distance from it falls from 38 to
  about 22 cells (the water round the sand, the sand in a mound); with gravity down they fall 70 to
  80 cells, failing both.

### 9. Look and feel (done)

- **Glow**: what's bright lights its surroundings. Each frame, after the last step, `glow_emit_cs`
  puts each cell's light in three fixed-point sections past the int grid's (the int buffer isn't
  part of the saved state, so the save format is unchanged): incandescence (`heatColor` of a solid
  or of a cell with particles, not hot air), fire, embers, burning wood and uranium. `glow_x_cs` and
  `glow_y_cs` blur it with a Gaussian (`GLOW_SIGMA` 7 cells, out to 18), and the display adds it
  `GLOW_STRENGTH` 3 times over.
- **Hot air shimmers**: in a non-solid cell above 60 °C the display's lookup wavers, up to 0.3 cells
  at 360 °C, so what's seen through a fire's plume ripples.
- **Embers** (particle type 14): a fire particle throws one 0.4 times a second, and lava's surface
  (lava with nothing above it, against the gravity) 0.15 times a second a cell. They're dragged by
  the air (up a plume), fall at a quarter of the gravity, wander, and live 0.6 to 1.8 s; water puts
  them out. They're only shown and glow: they give the cells no heat, so they light nothing.
- **Test scene 12** (above) also checks the glow: its red 6 cells beside the burning wood is about
  0.35, at the grid's side 0; and that the fire threw embers (about 960 at 5 s). With the cells'
  light and the embers off, both are 0 and the test fails.
- **Tilt**: a fourth gravity mode (the Gravity tile cycles Gravity, No gravity, Attract, Tilt):
  the gravity, as strong, points the phone's down across the screen. `Nri_GetGravity` reads the
  gravity sensor (else the accelerometer, low-passed) through a callback queue on the main thread's
  looper (GLFW's event pump runs its callbacks; a plain ident's events would never be taken off
  it), only while the mode is on, and turns the reading into the window's frame by the display's
  rotation (`Display.getRotation`, through JNI every half second). While the phone lies flat (under
  0.15 g across the screen) the last direction is kept. On desktop there's no sensor: Tilt is down,
  or `-tilt x y`'s direction. Saves keep the mode (a tilted save loads tilted).
- **Test** `tilted`: scene 13 with `-gravity tilt -tilt 1 0`. In 3 s the water's center moves about
  145 cells right and the sand's 91, under 5 across; with the shader's tilt ignored (gravity down)
  the water moves -44 along it and 73 across, and the test fails.

### 10. Electricity (done)

- **Conductors**: metal (the wire), lamps, and salt water (a cell with 2 water particles or more, a
  quarter as salty as it gets or more); fresh water doesn't conduct.
- **Sparks** run along conductors a cell an iteration, `spark_cs` twice a frame after the steps
  (120 cells a second). A sparked cell rests 4 iterations after, so a pulse runs on, not back. The
  state is in two int sections past the glow's, taking turns (not saved state; zeroed at the grid's
  init and when it's remade): a conductor's phase in bits 0..7, a lamp's light in 8..15.
- **Battery** (a solid): it sparks the conductors beside it every 12 iterations (5 pulses a second).
- **Lamp** (a solid, a conductor): shines (and glows) for 30 iterations after a spark, so a battery's
  pulses keep it lit.
- **Spark** (a tool): sparks the conductors under the brush.
- **What a spark does**: it lights gunpowder, petrol and oil in its cell or beside it (heated to
  where they catch). Sparks show blue-white along the wire, fading as they rest, and glow.
- **Test scene 14**: three circuits (a battery, a wire, a lamp: bare, through a tub of salt water,
  through one of fresh water) and gunpowder dropped on a live wire, beside a pile on a wall ledge.
  After 5 s the first two lamps shine and the third doesn't; none of the wire's gunpowder is left,
  the ledge's all is. With the batteries never firing no lamp shines and the gunpowder stays; with
  salt water not conducting its lamp is dark: both fail.

### 11. Chemistry, group A (done)

Behaviour after The Powder Toy's elements (its source as the reference; none of its code used).

- **New particle ids** past the tools' (40 on: hydrogen, oxygen, neon, thermite, nitroglycerin):
  only 15 was free under the solids' 16. Their count sections follow EMBER's (`countSection`), so
  no existing id, and no save, changed. The probe packs the counts four to an int (8 bits).
- **Electrolysis**: water beside a sparked metal cell (the electrode) splits, 3% a step, two in
  three into hydrogen, the rest oxygen. Only at the electrode: with every sparked cell of a pool of
  salt water splitting, the pool that carried the current was soon gone (and faster, the bubbles at
  the electrode broke its contact). Salt water conducts from one particle in a cell now.
- **Hydrogen** (a gas, 0.93 lighter than air) beside a flame, or at 500 °C, lights (40 a second;
  not at a spark, which would light it at the electrode as it's made): it burns at 1500 °C with a whoosh (one in 4 blasts) into steam. **Oxygen** (a
  little heavier than air) flares into fire.
- **Neon** (a gas) conducts where a cell holds any, and glows red-orange for a while after a spark.
- **Thermite** (a powder) catches from a flame or lava touching it, or at 1000 °C, burning into
  molten iron (lava at 3500 °C, held there for 1.5 to 4.5 s). Molten iron over 1550 °C cuts the
  metal it touches (the cell opened, the iron sinking into it: melted into cooler lava, it filled
  the hole and stopped the iron). **Metal** now melts at 1500 °C too (150 degrees latent).
- **Nitroglycerin** (a liquid, 1.6) goes off like gunpowder, twice the blast, at 200 °C, at a
  spark or a flame, or at a shock: its velocity changed by over 150 cells/s in a step (a fall).
- **C-4** (a solid) goes off at 400 °C, a flame or a spark beside it: its cell becomes 6 grains of
  gunpowder going off. **Coal** (a solid) catches at 500 °C or now and then from a flame, burning 25
  to 37 s. A **fuse** (a solid) catches at 700 °C, a flame or a spark, and from a fuse beside it
  that's burned 0.05 s, so it burns along at about 16 cells a second.
- **Tests** (each with an untouched twin as its control):
  - `electrolysis` (scene 15): a wired tub of salt water makes about 110 hydrogen and 45 oxygen
    in 5 s, the unwired one none; a wired neon tube shines, the other doesn't.
  - `combustion` (scene 16): a lit box of hydrogen burns away into steam, the unlit one keeps all
    of it; a lit fuse burns at about 16 cells a second, the unlit one stays.
  - `thermite` (scene 17): lit thermite cuts its plate to about 60 of 350 cells in 10 s; the unlit one's
    plate stays whole.
  - `nitroglycerin` (scene 18): nitroglycerin dropped into a tub goes off; that at rest in another,
    behind a wall, stays (without the wall, the blast's fire set it off now and then).
  - `c4` (scene 19): C-4 wired to a battery goes off, the unwired block, behind a wall, stays.
  - `coal` (scene 20): lit wood burns away in 5 s while lit coal is all there, some of it alight.
  - With electrolysis, catching, the fuse's spread, thermite's catching and the shock off, the
    first four fail.

### 12. Tools, group B (done)

After The Powder Toy's elements again (its source as the reference; none of its code used).

- **New ids**: solids from 48 (past the particle types; only 31 was free under the tools' 32), a
  seed particle at 45. Painting takes the solids from 48 as it does those under 32.
- **Clone**: the first particle type to touch it (neutrons and embers aside) is learned into its
  cell, and it emits that from then on, as an emitter does.
- **Black and white holes**: a fourth glow channel blurs the holes (a black hole's cell +1, a white
  hole's -1) the same way, once a frame, into the hole field; its gradient (times 400,000, at most 4
  gravities) is added to the gravity everywhere it's used, so liquids, powders, gases and blocks fall
  into black holes and away from white ones (and powders rest toward them). A black hole swallows
  what touches it. The glow's sections are zeroed at the grid's init and when it's remade now, as the
  steps read the field.
- **Sponge**: water touching it is soaked up (40 a second, a cell holding 8), the water in it
  spreading to its drier cells (a particle a step, across any difference: across a difference of 2
  or more only, it stalled a few cells in); hot (over 60 °C), it lets the water out.
- **Seeds and plants**: a seed (a powder) in water's cell or beside it sprouts into a plant cell with
  6 energy; a plant drinks touching water (2 a second, an energy each) and, with energy, grows a cell
  4 times a second, up or 45 degrees either side of up, the new cell taking the rest. Plants burn as
  wood does, in about a second.
- **Switch**: a conductor while it's on; the Spark tool's touch toggles it (once a touch: bit 9
  holds while it's touched). The scenes' strokes reach `spark_cs` too now, so a level can toggle one.
- **Detector**: sparks the conductors beside it on the battery's beat while a particle (but a
  neutron or an ember) is beside it.
- **Heater**: a conductor; powered (lit, as a lamp is), it warms 300 °C a second up to 600 °C.
- **Tests** (each with an untouched twin as its control):
  - `clone` (scene 21): water dropped on a clone, in a tub, becomes about 2,400 particles in 5 s;
    that dropped on a wall block stays about 750.
  - `holes` (scene 22): of sand dropped toward a black hole, a few grains are left (2,576 by the
    wall); none rests on the white hole (255 on the wall).
  - `plants` (scene 23): a sponge in a tub of water leaves about a fifth of its twin tub's water;
    seeds dropped into a pool grow about 220 plant cells, some above the water; seeds on a dry ledge
    none.
  - `switches` (scene 24): a switch toggled on by a Spark stroke lights its lamp, the one left off
    doesn't; sand on a detector lights its lamp, the bare one doesn't; a powered heater reaches
    600 °C, the other stays at 20.
  - With learning, the holes' pull, soaking, sprouting, the heater's warming and the switch's
    toggling off, all four fail.

### 13. Challenges (done)

The levels (step 6) as challenges: goals of more kinds, a clock and stars.

- **Goals**: besides so many particles (or cells) of a material in a box, `"lit": true` counts only
  lit cells (a lamp's: `goal_cs` reads the spark section's light), and `"atMost": true` turns the
  count into a most, `"hold": S` asking for it to hold S seconds (a dry cup, burned logs). The goal is
  judged from the probe of the frame it counted, at that frame's time. `goal_cs` now counts the
  particle types from 40 up too (it took ids over 20 for solids).
- **Clock and stars**: a level's clock starts once its strokes are painted and runs with the
  simulation (not while paused), stopping when the goal's reached. `"stars": [T3, T2]`: 3 stars
  within T3 seconds, 2 within T2, else 1. The HUD shows the goal, the time and the stars' times;
  reached, the stars earned.
- **Best stars**: kept for index.json's levels in `powder_sandbox.stars` beside the save (not by
  tests); the Levels tile shows a level's best as it starts it.
- **The challenges** (index.json's order): Light the lamp (bridge a gap in the wire), Fill the cup
  (open the dam), Grow a garden (water the seeds), Burn the logs, Feed the black hole (the sand in
  a bin), Keep the cup dry (10 s under a tank an emitter fills: from it, not the emitter, the water reaches the cup a few seconds in, so there is time to act; falling straight from the emitter, on the S23's grid, it was there within a second), Melt the ice (switch on the heaters around a
  tub of it), Set the lava (into the pool under its shelf: the pool moved there, as lava led to one
  beside the shelf cooled into a plug at the shelf's edge).
- **Upright**: a level's grid is wider than tall whichever way the window is (on a phone held
  upright, turned and drawn as a band, as the test scenes' are), since its boxes are laid out for one.
  On the S23, held upright (a 144 x 279 grid), three challenges' solutions fell short before: the
  lava fell twice as far and set on the way, the garden's bed was narrower, the dry cup's roof sat
  too high above it. `-window W H` sizes the desktop's window (`-window 540 1170`: a phone's shape).
- **Solutions**: a level's `"solution"` strokes (one way to reach its goal), painted at `-solve S`
  seconds in a test.
- **Tests**: each challenge solved a second in earns 3 stars (`challenge_<name>`); untouched, its goal
  isn't reached (`unsolved_<name>`); Light the lamp solved at 4 s earns 2 stars, at 7 s 1. A goal
  reached before the solution fails the test. `challenge_dry_upright` and `challenge_stone_upright`:
  solved in an upright window (both fail with levels on an upright grid).

### 14. Code split (done; the engine's parts next)

The app was one 4,900-line file in `examples/nri/`. Everything of the sandbox's is in this folder
now (sources, shaders, media, this file, its CMake and tests); the app moves into files here, a
group at a time, each a pure move with the whole suite passing on D3D12 and Vulkan; later, the
parts that aren't the game's (the frames-in-flight and readback ring, compute dispatch and
barriers, the GPU profiler, the toolbar, tabs, slider and radial menu, touch gestures) move into
`core/nri/` as the engine.

- **Its own folder** (done): `powder_sandbox/` beside `examples/`; `add_tslang_nri_example`'s
  `SOURCE` names the entry file, and `copy_media` copies `media/` here to the binaries'
  `media/powder_sandbox/` (where the app reads its levels, as before).
- **Test checks** (done): `checks.ts`'s `PowderSandbox` extends the app with the checks (about
  1,200 lines), overriding `checkTest`; `defs.ts` holds the constants and small classes, exported;
  `powder_sandbox_nri.ts` reads the command line. A subclass, not a module of functions: the checks
  call the app's own methods (`addStroke`, `gravityPointX`), and a module of functions taking the
  app would need the app's file to import it back.
- **Scenes and levels** (done): the fields are `state.ts`'s `SandboxState` (`protected`, with
  `showMessage`); `levels.ts`'s `SandboxLevels` extends it with the test scenes, the levels' files,
  goals, clock and stars (about 600 lines); `sandbox.ts`'s `SandboxApp` extends that, each file
  using only what's below it.
- Each module is rebuilt when one it imports changes (`add_tslang_nri_example` gives every module
  its imports as dependencies; before, only the entry file had them, so a changed base class left
  a stale subclass object that failed to link).
- **The state's GPU work** (done): `saves.ts`'s `SandboxSaves` (undo snapshots, save/load, the
  regrid and the round trip, about 290 lines). What it records with went below it: the grid's size
  and place on screen (`fitGrid`, `layout`, the view and the toolbar's height) is `view.ts`'s
  `SandboxView`, and the constants, barriers and `dispatch` are the state's. With the view below the
  levels, `nextLevel` turns the grid for a level itself again. The chain: state, view, levels,
  saves, app, checks.
- **The toolbar and input** (done): `ui.ts`'s `SandboxUI` extends the saves with the tabs and
  tiles, the size slider, the radial menu, the readout (`buildUI`) and `handleInput` with the tilt
  (about 600 lines). It uses only what's below it (the view's `layout` and `zoomAt`, `nextLevel`,
  `setFloat`, `showMessage`); the app extends it.
- **The simulation's recording** (done): `simulation.ts`'s `SandboxSimulation` extends the saves
  with `fillConstants`, the steps' dispatches (`recordSimulation`, the pressure solve and its
  smoothing, the sparks and glow), the profiler and step timer, auto quality, the sounds, and the
  tilt sensor (only the constants read it), about 430 lines. The UI extends it.
- The app (`sandbox.ts`, about 660 lines) is what's left: the device, pipelines and buffers, the
  swapchain, `renderFrame` and `destroy`. The chain: state, view, levels, saves, simulation, ui,
  app, checks; each file uses only what's below it.
- **The shader** (done): `shaders/powder_sandbox.hlsl` (4,200 lines) is now its header and the
  includes, in order: `common.hlsli` (the root constants, the materials, the sections, shared by the
  simulation and the display), the simulation's `sim_*.hlsli` (the buffers and grid accessors,
  setup and regrid, the transfer to the grid, viscosity, air, bodies, the goal, heat, the pressure
  solve, the projection, sparks, g2p, spawn, glow, the probe), and `display.hlsli`. Each a run of
  the old file's lines in its order: the compiled DXIL and SPIR-V are byte for byte the same.
  ShaderMake rebuilds when an include changes.
- **Engine parts into `core/`**, one at a time, each a class the sandbox holds (no reference back
  to it), its behavior unchanged:
  - **GPU profiler** (done): `core/nri_gpu_profiler.ts`'s `NriGpuProfiler` (`init` with the names
    of what's timed, `begin`, `mark` after each piece of work, `end`, `read` once the GPU's done,
    `report`). `dispatch` marks each entry; the report reads as before. **Test** `profile`: the
    showcase with `-profile` must report at least once (no test ran it before).
  - **Frames in flight** (done): `core/nri_frame_ring.ts`'s `NriFrameRing`, a command allocator
    and buffer for each queued frame and the fence (`init`, `wait` for the latency sleep,
    `commandBuffer`, `signal` after the present, `slot`, `destroy`). The sandbox's `QueuedFrame`
    keeps only its own per-frame data (the probe's and timestamps' readbacks, the steps, the
    level's time). The 93 other NRI examples each have the same ring written out; they could use it.
  - **Compute kernels** (done): `core/nri_compute_kernels.ts`'s `NriComputeKernels`, pipelines
    sharing one descriptor set and one block of root constants (`init` sizes the constants, `bind`
    gives it the pipelines, the set and the buffers barrier masks name; `setFloat`, `setInt`,
    `dispatch` with a barrier mask, `barriers`, `setGraphicsConstants` for the draw, `setProfiler`
    to mark each dispatch). The sandbox still owns and destroys the pipelines and buffers.
  - **Slider and tab row** (done): `core/nri_slider.ts`'s `NriSlider` (`place`, `contains` with a
    row's height of slack past the track's ends, `fraction`, `draw`) and `core/nri_tab_row.ts`'s
    `NriTabRow` (`layout` from the labels' widths, `offset`, `scrollTo`, `tabAt`, `left`/`right`,
    marks under tabs, `draw` with its scroll bar). What they mean stays the sandbox's: when the
    slider shows (not for a box), its fraction as a brush size, the mark under the tab holding the
    tool. Checked by the test frames: the slider's row and the toolbar are byte for byte the same
    as before, wide and upright (540 x 1170, both rows scrolled), on D3D12 and Vulkan. On the S23
    by hand (adb): dragging the slider sizes the brush (3 to 22, nothing painted), and tapping a
    tab shows its group (the mark stays under the tool's tab); scrolling, checked on the S23 by
    hand, works too. (Only the sandbox uses them so far: later UI parts stay in `powder_sandbox/`
    till a second app needs them.)
  - **Swap chain** (done): `core/nri_swap_chain.ts`'s `NriSwapChain`, made at the window's size
    with a color attachment view and a pair of semaphores for each texture (`init`, sRGB views or
    the texture's own format; `width`, `height`, `viewFormat`; `resized` and `recreate`; `acquire`,
    `texture`, `colorAttachment`, `submit`, `present`; `destroy`). The sandbox keeps what it fits
    to the window (the grid, the toolbar). The 93 other NRI examples each make theirs the same way.
  - Still to do: the radial menu (never open in a test: it needs a phone to check), touch
    gestures. The tiles' row stays the sandbox's (its labels, swatches and selection are the
    game's).
