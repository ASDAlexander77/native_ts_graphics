# Powder sandbox: state and roadmap

`powder_sandbox_nri` (`examples/nri/powder_sandbox_nri.ts`, `shaders/powder_sandbox.hlsl`) is a
falling-sand sandbox in the spirit of The Powder Toy, and the first game of a small engine built
from this repo's NRI layer. The game is its own editor: you pick a material and paint, so there is
no separate editor to write. Android is the main target; Windows (D3D12, Vulkan) is for testing.

What sets it apart from The Powder Toy is the physics: the liquids are incompressible, so water
levels out in connected vessels. That's the U-tube test, and every change has to keep passing it.

## Where it stands

- **Simulation:** water, oil, sand (and, from this roadmap, lava) are FLIP particles on a MAC grid.
  A variable-density pressure solve (red-black SOR, warm-started from the last step) plus a
  particle-density correction keeps their volume. Sand takes the grid's velocity and holds a pile
  by static friction. Fire, smoke and steam rise by buoyancy; neutrons fly straight.
- **Fixed time step:** 1 / (60 substeps) s per step, from accumulated frame time. The warm-started
  pressure is in units of dt, so a dt that follows the frame time (on some setups frame times
  alternate 0.5 / 13 ms) tears the water apart.
- **Temperature:** in every particle and cell, diffused across the grid. It drives boiling and
  condensing, oil igniting, wood burning, uranium heating up.
- **Painting:** a toolbar of materials and tools (Heat, Cool, Erase); circle, square, line and box
  brushes with an outline cursor; mouse or touch.
- **Window:** resizable; the grid keeps its cells and is fitted to the window.
- **Tests:** `-test` (U-tube levels) and `-scene 2 -test` (showcase), on D3D12 and Vulkan, and on
  the Android emulator.

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

### 2. Undo and save/load

What players build is worth keeping, and on a phone a mistaken stroke is easy.

- **Undo**: a ring of snapshots (cells, particles, the grid's temperatures) taken on GPU, one per
  stroke start, a few deep; an Undo tile restores the last.
- **Save/load**: the same snapshot read back and written to a file (app storage on Android), with
  a small header (version, grid size). A grid of another size is loaded centered.

### 3. Real-phone pass

So far only the emulator and the desktop have run it.

- Run the arm64 APK on a phone; check frame rate with the fixed step (a 30 fps phone now runs 6
  steps a frame) and add an automatic substep reduction if it can't keep up.
- DPI-scaled font and tiles; re-fit the layout on rotation.
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
