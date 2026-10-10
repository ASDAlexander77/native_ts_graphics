# Typed interop handles

Date: 2026-10-10. Status: implemented on typed-handles; revised while planning (see "Revisions" at the end).

## Goal

Every object that crosses the TypeScript / C++ boundary is a `void*` in C++ and an `Opaque`
(`= any`, `types/tslang/index.d.ts:32`) in TypeScript. Nothing catches a handle of the wrong kind:
a shader passed where a buffer is expected compiles in tslang, type-checks in the editor and
reaches a `static_cast` in `donut_interop.cpp` unchecked.

After this change, passing the wrong kind of handle is a compile error in all three places:

- tslang, when an example or `core/*.ts` is built;
- `tsc` (the editor, `tsconfig.json`);
- the C++ compiler, inside the interop implementation.

The calling convention does not change: every handle is still one pointer.

Non-goals: typing raw memory (`Ref(...)`, `dst`, `data`, matrices, native OS handles stay
`Opaque`), encoding ownership (owned vs borrowed handles) in the types, generating the `.d.ts`
from C++.

## Findings this design rests on

Checked with tslang (`--emit=llvm`) and `tsc` 7.0.2 on scratch files:

| TypeScript form | tslang | tsc | Lowered to |
|---|---|---|---|
| `type Texture = Opaque` | no check | no check (`any`) | `ptr` |
| `Opaque & { __brand }` | compile error (`never`) | - | - |
| `type Texture = { data: Opaque }` | no check (same shape = same type) | no check | struct by value |
| `interface` with a brand member | checks | checks | `{ ptr, ptr, ptr }` (ABI change) |
| `declare class TextureHandle { private readonly __texture: int; }` | error on mismatch | error on mismatch | `ptr` |

With the declared-class form:

- `X | null` parameters and returns, `if (!x)`, class fields, arrays and `as Opaque` / `as X`
  casts all compile, to the same `ptr` code as `Opaque`.
- `declare class TextureHandle extends ResourceHandle` makes a `TextureHandle` acceptable where a
  `ResourceHandle` is expected; the call still passes a `ptr`.
- A union of two handle classes lowers to a tagged struct: never use one in a signature.
- A brand field of type `void` crashes tslang: brands are `int`.
- tslang accepts a base handle where a derived one is expected (`ResourceHandle` ->
  `TextureHandle`); `tsc` rejects it. `tsc` is therefore part of the verification.
- Comparing `XxxHandle` with `XxxHandle | null` overflows tslang's stack, as it already does for
  `Opaque`. Not a regression; narrow the `null` away before comparing.
- `tsc --noEmit -p .` currently reports one error in the repository's own files
  (`examples/compute_shader_derivatives.ts`), the rest in tslang's default library: "no new
  errors in `core/` and `examples/`" is a usable check.

On the C++ side, a `typedef void* Texture` is the same type as `void*` and checks nothing, and a
`struct { void* data; }` passed by value changes the calling convention for no benefit over real
pointer types. The interop functions are `extern "C"` and may take and return pointers to C++
classes.

## Design

### 1. Handle types (TypeScript)

A new `core/donut_handles.d.ts` declares one class per handle kind. `donut_interop.d.ts` pulls
it in with `/// <reference path="donut_handles.d.ts" />` (as `donut.ts` does for
`donut_interop.d.ts`), and it joins `TSLANG_DONUT_DECLARATIONS` (`CMakeLists.txt:511`) so that
editing it rebuilds the examples. If tslang does not follow a reference from a `.d.ts`, stage 0
puts the declarations at the top of `donut_interop.d.ts` instead.

Example:

```ts
declare class ResourceHandle { private readonly __resource: int; }
declare class TextureHandle extends ResourceHandle { private readonly __texture: int; }
```

Each class has a brand field named after it, so no two classes are structurally compatible.
Names end in `Handle`; the existing wrapper classes (`App`, `Frame`, `CommandList`, ...) keep
their names.

Hierarchy:

- `ResourceHandle`: nvrhi objects owned through `App::Own` and freed with `releaseResource`.
  Derived: `TextureHandle`, `StagingTextureHandle`, `BufferHandle`, `SamplerHandle`,
  `HeapHandle`, `ShaderHandle`, `ShaderLibraryHandle`, `InputLayoutHandle`,
  `BindingLayoutHandle`, `BindingSetHandle` (`DescriptorTableHandle` extends it),
  `FramebufferHandle`, `GraphicsPipelineHandle`, `ComputePipelineHandle`,
  `MeshletPipelineHandle`, `RtPipelineHandle`, `ShaderTableHandle`, `AccelStructHandle`,
  `OpacityMicromapHandle`, `TimerQueryHandle`, `CommandListHandle`.
- `ObjectHandle`: interop and engine objects owned through `App::OwnObject` and freed with
  `releaseObject`. One derived class per object kind (`TriangleBlasHandle`, `GltfMeshHandle`,
  `BinaryFileHandle`, `SceneHandle`, `SceneGraphHandle`, `ForwardShadingPassHandle`, ...).
- Handles with their own lifetime, deriving from neither: `AppHandle`, `FrameHandle`,
  `PassHandle`, `AdapterListHandle`, `ImGuiFontHandle`, `NodeHandle`, `LightHandle`, ...
- Description objects created with `new` (`BindingSetDescHandle`, `BindingLayoutDescHandle`,
  `GraphicsPipelineDescHandle`, `InputLayoutDescHandle`, ...).
- `FramebufferFactoryHandle` for Donut's `FramebufferFactory` (returned by
  `Donut_GetSceneRenderTargetsFramebuffer` and `Donut_GetLightProbeCaptureFramebuffer`), distinct
  from `FramebufferHandle` (`nvrhi::IFramebuffer`).

The list above is indicative. The final list is the set of C++ types the interop functions
actually take and return; where a single TS name above turns out to cover two C++ types, it is
split, as framebuffers are.

Rules for `donut_interop.d.ts`:

- Handle parameters and returns are `XxxHandle` or `XxxHandle | null`, never a union of handle
  classes.
- Functions accepting any resource take `ResourceHandle`; any owned object, `ObjectHandle`.
- Callback types are typed (`RenderCallback = (frame: FrameHandle) => void`).
- Raw memory stays `Opaque`.

### 2. C++ side

- The `extern "C"` functions in `core/donut_interop.cpp`, `core/sdkmesh.cpp`,
  `core/video_player.cpp`, `core/basis_transcoder.cpp`, `core/fast_block_compress.cpp` and
  `core/directx_collision.cpp` take and return the real pointer types (`App*`, `FrameContext*`,
  `TsRenderPass*`, `nvrhi::IBuffer*`, `nvrhi::ITexture*`, `nvrhi::rt::IAccelStruct*`,
  `donut::engine::Scene*`, `TriangleBlas*`, ...) instead of `void*`.
- The `As*()` helpers and the `static_cast`s from `void*` go. Conversions to a base
  (`nvrhi::IBuffer*` to `nvrhi::IResource*` in `Donut_ReleaseResource`) become implicit.
- `Donut_ReleaseObject` keeps a `void*` parameter (its registry is type-erased); the `.d.ts`
  restricts it to `ObjectHandle`.
- The interop structs (`App`, `FrameContext`, `TsRenderPass`, ...) stay in their anonymous
  namespace: MSVC gives `extern "C"` functions taking them external linkage and they link (checked
  with `dumpbin /symbols`), and clang only warns under `-Wmissing-prototypes`, as it already does
  for the current `void*` functions.
- C++ types without a name of their own get one, so the check script's table can name them:
  `InputLayoutDesc` (`std::vector<nvrhi::VertexAttributeDesc>`), `StringList`
  (`std::vector<std::string>`), `RandomEngine` (`std::default_random_engine`) and
  `FramebufferFactoryRef` (`std::shared_ptr<donut::engine::FramebufferFactory>`, the pointee of a
  framebuffer factory handle).
- `App::Own` becomes a template returning the resource with its own type, so `return a->Own(...)`
  type-checks against a typed return.
- Where the compiler finds a real mismatch, it is fixed, not cast away, and listed in that
  stage's commit message.

### 3. Generator and consistency check

`tools/generate_donut_wrappers.py`:

- Each wrapper class holds a typed handle (`App.handle: AppHandle`,
  `CommandList.handle: CommandListHandle`, ...); its constructor takes `XxxHandle | null`.
- Methods copy parameter and return types from `donut_interop.d.ts`.
- `CLASSES` maps a parameter name to the wrapper class and its handle type.
- `donut.ts` and `donut_globals.d.ts` are regenerated and committed as today.

New `tools/check_interop_types.py`:

- Parses the `extern "C"` function definitions in `core/*.cpp` and the `declare function`s in
  `core/donut_interop.d.ts`.
- Maps C++ types to TypeScript types through one table (`nvrhi::ITexture*` -> `TextureHandle`,
  `App*` -> `AppHandle`, `int` -> `int`, `const char*` -> `string`, `void*` -> `Opaque`, ...).
- Reports, with `file:line` on both sides:
  - a function declared on one side only;
  - a parameter count that differs;
  - a parameter or return type that disagrees with the table;
  - a C++ type missing from the table;
  - a handle class in `donut_handles.d.ts` that no signature uses.
- Runs as a CMake custom command producing a stamp file that `donut_interop` depends on, so a
  mismatch fails the build. It re-runs only when its inputs change.
- `--fix` rewrites the `.d.ts` declarations still `Opaque` where the C++ is typed, so the `.d.ts`
  side of each stage is mechanical.

New `tools/find_untyped_handles.py`: runs `tsc` with `Opaque` declared as a class of its own
instead of `any`, and lists the resulting errors in `core/` and `examples/`. Each is a field,
local, parameter or callback still typed `Opaque` that holds or passes a typed handle: the list of
example changes a stage needs.

New `tools/smoke_examples.ps1`: starts examples on D3D12 and Vulkan with `-debug` for a few
seconds each and reports crashes, error exits and logged errors.

### 4. Rollout

All on the `typed-handles` branch, one commit per stage. The build and the examples work after
every commit: `Opaque` is `any`, so typed handles still flow through code not yet converted.

0. Infrastructure, no behavior change:
   - `donut_handles.d.ts`;
   - the check script, with a table that accepts today's `void*` / `Opaque` pairs;
   - CMake wiring;
   - generator support for typed handles;
   - `find_untyped_handles.py`, `smoke_examples.ps1`;
   - the C++ type aliases and the `App::Own` template.
1. App, Frame, Pass, CommandList, callbacks.
2. Buffers.
3. Textures, staging textures, samplers, heaps.
4. Shaders, shader libraries, input layouts.
5. Binding layouts, binding sets, descriptor tables, their descs.
6. Framebuffers, framebuffer factories, pipelines, their descs.
7. Ray tracing: accel structs, opacity micromaps, shader tables, ray tracing pipelines, BLAS
   objects.
8. Scene objects: scene, scene graph, nodes, lights, materials, scene cameras, meshes, loaded
   textures, scene loader, string lists, cameras, views, dynamic meshes.
9. Render passes and render targets.
10. The rest: ImGui, video, SDKMESH, glTF, Basis, FBC, timer queries, anything left.
11. Strict mode: the check script allows `void*` only for parameters listed as raw memory.

Each family stage converts, together:

- the C++ signatures;
- `donut_interop.d.ts`;
- the regenerated `donut.ts`;
- the fields, locals and parameters in `core/*.ts` and every example that hold that family.

## Verification

After every stage:

- Full Windows build of all targets (Debug, Ninja, VS 18 `vcvars64`). This covers the C++
  compiler, the check script and tslang.
- `npx tsc --noEmit -p . --incremental false`: no errors in `core/` or `examples/` beyond the
  existing one in `compute_shader_derivatives.ts`.
- `find_untyped_handles.py`: nothing left that involves the stage's handle types; nothing at all
  after the last stage.
- A smoke run on D3D12 and Vulkan with `-debug` of the examples using that stage's family, read
  for validation errors on stdout and stderr.

At the end:

- Every example started on D3D12 and Vulkan and run briefly.
- One Android x86_64 build.
- A pull request from `typed-handles`.

## Risks

- tslang crashes on new type patterns. Mitigation: the patterns used here were checked; a
  crash met during the work gets bisected on a scratch file and worked around.
- A C++ mismatch reveals an actual bug in an example. Mitigation: fix it in that stage and
  verify that example on both APIs.
- The `.d.ts` and the C++ drift apart again later. Mitigation: the check script in the build.

## Revisions

Made while writing the implementation plan, from measurements:

- The interop structs are not moved to a named namespace (section 2): unnecessary, see there.
- Stage 8 is split into scene objects (8) and render passes and targets (9); the rest becomes
  stage 10 and strict mode stage 11.
- Added: the check script's `--fix`, `find_untyped_handles.py`, `smoke_examples.ps1`, the C++
  type aliases and the `App::Own` template.
