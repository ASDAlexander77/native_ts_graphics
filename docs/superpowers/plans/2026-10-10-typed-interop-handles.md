# Typed Interop Handles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `void*` / `Opaque` handles of the TypeScript <-> C++ interop with named handle types that tslang, tsc and the C++ compiler all check, without changing the calling convention.

**Architecture:**
- **TypeScript:** each kind of C++ object gets a declared class with a private brand field (`declare class TextureHandle extends ResourceHandle { private readonly __texture: int; }`) in `core/donut_handles.d.ts`. These lower to a plain `ptr` in tslang and are nominal in both tslang and tsc.
- **C++:** the `extern "C"` functions take and return real pointer types.
- **Consistency:** `tools/check_interop_types.py`, run by the build, keeps `core/donut_interop.d.ts` matching the C++ through one C++->TS table (`HANDLES`).
- **Rollout:** stage by stage, one handle family per task. `Opaque` is `any`, so unconverted code keeps working in between.

**Tech Stack:** C++20 (MSVC 18 / clang for Android), nvrhi / Donut, tslang (TypeScript to native), tsc 7 (editor checking), Python 3 (tools), PowerShell 7 (smoke runs), CMake + Ninja.

**Spec:** `docs/superpowers/specs/2026-10-10-typed-interop-handles-design.md`. Read it first; this plan argues from it. Its "Revisions" section lists what changed while planning.

## Global Constraints

- **Branch:** all work on `typed-handles`, one commit per task. Every commit builds and every example runs.
- **ABI:** no ABI change. Every handle stays one pointer, `XxxHandle` or `XxxHandle | null` in TypeScript. Never put a union of two handle classes in a signature: it lowers to a tagged struct.
- **Brand fields:** `private readonly __<name>: int;`, unique per class. A `void` brand crashes tslang.
- **Names:** handle types are named `XxxHandle`. A wrapper class `Xxx` in `core/donut.ts` holds an `XxxHandle`.
- **Bases:** resources owned through `App::Own` extend `ResourceHandle`. Objects owned through `App::OwnObject` extend `ObjectHandle`. Others extend nothing.
- **Raw memory** (`dst`, `data`, `Ref(...)`, matrices, native OS handles) stays `Opaque` / `void*`.
- **Mismatches** the compiler finds get fixed, not cast away, and listed in the task's commit message.
- **Build:** Debug, Ninja, `build/`, VS 18 `vcvars64`:
  `cmd /c '"C:\Program Files\Microsoft Visual Studio\18\Professional\VC\Auxiliary\Build\vcvars64.bat" >nul && cmake --build I:\native_ts_graphics\build 2>&1'`
  (from PowerShell; VS 2022's linker fails on the libraries.)
- **tsc** runs as `npx --no-install tsc --noEmit -p . --incremental false`. Without the flag it writes `tsconfig.tsbuildinfo` into the repo. Its only allowed error in `core/` or `examples/` is the existing TS2367 in `examples/compute_shader_derivatives.ts`; tslang's own default library has many, which are ignored.
- **Smoke runs** start example windows. Leave the desktop alone while they run, because an example only renders while focused. Launch processes with `Start-Process -NoNewWindow` (the smoke script does), never in new consoles.
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never stage `external/Donut`: it shows as modified because of the build's patches.

## Review Focus

Failure modes the spec implies that no task's tests pin directly, most likely first, each with where it's covered:

1. **A heterogeneous array of handles typed by its first element.** For example, `Opaque[]` of buffers *and* textures to release later, retyped `BufferHandle[]`. Expected: such arrays become `ResourceHandle[]` (or `ObjectHandle[]`). Covered by the "Retype holders" step of each family task: decide by every value pushed, not the first.
2. **Comparing `XxxHandle` with `XxxHandle | null`.** This overflows tslang's stack (0xC00000FD, no message), the same as with `Opaque` today. Expected: compare only after narrowing away `null`. Covered by the full build, which compiles every example with tslang after each task. A silent 0xC00000FD from tslang means bisect the method as described in memory.
3. **Platform-conditional C++ types in signatures.** For example, `D3D12WorkGraph` is defined inside `#if DONUT_WITH_DX12` (`core/donut_interop.cpp:1314`); `SharedTexture` and `TextureHeap` are similar. Expected: a forward declaration outside the `#if`, so the Android build still compiles. Covered by Task 11 Step 3 and the Android build in Task 12.
4. **Downcasts behind a base handle.** `CameraHandle` is a `BaseCamera*`, but third-person functions need a `ThirdPersonCamera*`; `ViewHandle` is an `IView*`, but planar/stereo functions need a `PlanarView*` / `StereoPlanarView*`. Expected: those functions take the base pointer and `static_cast` inside, exactly as today. Covered by Task 9 Step 3 and smoke runs of `feature_demo`, `deferred_shading`, `compute_nbody`, `msaa`.
5. **A wrapper object stored where a handle is expected, or the reverse.** `examples/mobile_nerf_rayquery.ts:797` and `examples/ray_queries.ts:500` keep a `BindingSet` wrapper in an `Opaque` field. Expected: the field's type is the wrapper class (`BindingSet`), not `BindingSetHandle`. Covered by Task 6 Step 7, where `find_untyped_handles.py` lists both lines today.

## File Structure

| File | Responsibility | Tasks |
|---|---|---|
| `core/donut_handles.d.ts` (new) | Declares the handle classes, nothing else. | 1 (empty), 2-11 add classes |
| `core/donut_interop.d.ts` | Declares the interop functions; references `donut_handles.d.ts`. | 1 (reference), 2-11 (`--fix`) |
| `core/donut_interop.cpp`, `sdkmesh.cpp`, `video_player.cpp`, `basis_transcoder.cpp`, `fast_block_compress.cpp` | The `extern "C"` functions: typed signatures. | 1 (aliases, `Own`), 2-11 |
| `tools/check_interop_types.py` (new) | Compares C++ signatures with `.d.ts` declarations; `--fix`, `--strict`, `--stamp`. Holds `HANDLES`, `OVERRIDES`, `RAW_MEMORY`. | 1, 2-12 add table rows |
| `tools/test_check_interop_types.py` (new) | Unit tests of the check script on fixture trees. | 1 |
| `tools/generate_donut_wrappers.py` | Generates `core/donut.ts`: wrapper handles typed, typed parameters mapped to wrappers. | 1 |
| `tools/test_generate_donut_wrappers.py` (new) | Unit tests of the generator's typed-handle handling. | 1 |
| `tools/find_untyped_handles.py` (new) | tsc with `Opaque` as a class: lists untyped holders of handles. | 1 |
| `tools/smoke_examples.ps1` (new) | Runs built examples briefly per API with `-debug`, reports failures. | 1 |
| `CMakeLists.txt` | Runs the check before building `donut_interop`; `donut_handles.d.ts` in `TSLANG_DONUT_DECLARATIONS`. | 1, 12 (`--strict`) |
| `core/donut.ts`, `core/donut_globals.d.ts` | Generated; committed. | 1-11 |
| `core/input_pass.ts`, `examples/*.ts` | Fields, locals, parameters retyped from `Opaque`. | 2-11 |

## The type map

`HANDLES` in `tools/check_interop_types.py` maps a C++ pointee type, written as the C++ source writes it, to its TypeScript class. Each family task adds its rows and its classes:

| Task | C++ type | TypeScript class | Extends |
|---|---|---|---|
| 2 | `App` | `AppHandle` | |
| 2 | `FrameContext` | `FrameHandle` | |
| 2 | `TsRenderPass` | `PassHandle` | |
| 2 | `AdapterList` | `AdapterListHandle` | |
| 2 | `nvrhi::IResource` | `ResourceHandle` | |
| 2 | `nvrhi::ICommandList` | `CommandListHandle` | `ResourceHandle` |
| 3 | `nvrhi::IBuffer` | `BufferHandle` | `ResourceHandle` |
| 4 | `nvrhi::ITexture` | `TextureHandle` | `ResourceHandle` |
| 4 | `nvrhi::IStagingTexture` | `StagingTextureHandle` | `ResourceHandle` |
| 4 | `nvrhi::ISampler` | `SamplerHandle` | `ResourceHandle` |
| 4 | `nvrhi::IHeap` | `HeapHandle` | `ResourceHandle` |
| 5 | `nvrhi::IShader` | `ShaderHandle` | `ResourceHandle` |
| 5 | `nvrhi::IShaderLibrary` | `ShaderLibraryHandle` | `ResourceHandle` |
| 5 | `nvrhi::IInputLayout` | `InputLayoutHandle` | `ResourceHandle` |
| 5 | `InputLayoutDesc` | `InputLayoutDescHandle` | |
| 6 | `nvrhi::IBindingLayout` | `BindingLayoutHandle` | `ResourceHandle` |
| 6 | `nvrhi::IBindingSet` | `BindingSetHandle` | `ResourceHandle` |
| 6 | `nvrhi::IDescriptorTable` | `DescriptorTableHandle` | `BindingSetHandle` |
| 6 | `nvrhi::BindingSetDesc` | `BindingSetDescHandle` | |
| 6 | `nvrhi::BindingLayoutDesc` | `BindingLayoutDescHandle` | |
| 6 | `nvrhi::BindlessLayoutDesc` | `BindlessLayoutDescHandle` | |
| 6 | `donut::engine::DescriptorTableManager` | `DescriptorTableManagerHandle` | `ObjectHandle` |
| 6 | (base only) | `ObjectHandle` | |
| 7 | `nvrhi::IFramebuffer` | `FramebufferHandle` | `ResourceHandle` |
| 7 | `FramebufferFactoryRef` | `FramebufferFactoryHandle` | |
| 7 | `nvrhi::IGraphicsPipeline` | `GraphicsPipelineHandle` | `ResourceHandle` |
| 7 | `nvrhi::IComputePipeline` | `ComputePipelineHandle` | `ResourceHandle` |
| 7 | `nvrhi::IMeshletPipeline` | `MeshletPipelineHandle` | `ResourceHandle` |
| 7 | `PipelineDesc` | `GraphicsPipelineDescHandle` | |
| 8 | `nvrhi::rt::IAccelStruct` | `AccelStructHandle` | `ResourceHandle` |
| 8 | `nvrhi::rt::IOpacityMicromap` | `OpacityMicromapHandle` | `ResourceHandle` |
| 8 | `nvrhi::rt::IShaderTable` | `ShaderTableHandle` | `ResourceHandle` |
| 8 | `nvrhi::rt::IPipeline` | `RtPipelineHandle` | `ResourceHandle` |
| 8 | `nvrhi::rt::PipelineDesc` | `RtPipelineDescHandle` | |
| 8 | `TriangleBlas` | `TriangleBlasHandle` | `ObjectHandle` |
| 8 | `SceneAccelStructs` | `SceneAccelStructsHandle` | `ObjectHandle` |
| 9 | `donut::engine::Scene` | `SceneHandle` | `ObjectHandle` |
| 9 | `donut::engine::SceneGraph` | `SceneGraphHandle` | `ObjectHandle` |
| 9 | `donut::engine::SceneGraphNode` | `NodeHandle` | |
| 9 | `donut::engine::Light` | `LightHandle` | |
| 9 | `donut::engine::Material` | `MaterialHandle` | `ObjectHandle` |
| 9 | `donut::engine::SceneCamera` | `SceneCameraHandle` | |
| 9 | `donut::engine::MeshInfo` | `MeshHandle` | `ObjectHandle` |
| 9 | `donut::engine::LoadedTexture` | `LoadedTextureHandle` | `ObjectHandle` |
| 9 | `donut::app::BaseCamera` | `CameraHandle` | `ObjectHandle` |
| 9 | `donut::engine::IView` | `ViewHandle` | `ObjectHandle` |
| 9 | `SceneLoader` | `SceneLoaderHandle` | `ObjectHandle` |
| 9 | `StringList` | `StringListHandle` | `ObjectHandle` |
| 9 | `DynamicMesh` | `DynamicMeshHandle` | `ObjectHandle` |
| 10 | `CubemapTarget` | `CubemapTargetHandle` | `ObjectHandle` |
| 10 | `GBufferTargets` | `GBufferTargetsHandle` | `ObjectHandle` |
| 10 | `TemporalTargets` | `TemporalTargetsHandle` | `ObjectHandle` |
| 10 | `SceneRenderTargets` | `SceneRenderTargetsHandle` | `ObjectHandle` |
| 10 | `ShadowMapTarget` | `ShadowMapHandle` | `ObjectHandle` |
| 10 | `LightProbeSet` | `LightProbeSetHandle` | `ObjectHandle` |
| 10 | `LightProbeCapture` | `LightProbeCaptureHandle` | `ObjectHandle` |
| 10 | `donut::render::ForwardShadingPass` | `ForwardShadingPassHandle` | `ObjectHandle` |
| 10 | `donut::render::ForwardShadingPass::Context` | `ForwardShadingContextHandle` | `ObjectHandle` |
| 10 | `donut::render::GBufferFillPass` | `GBufferFillPassHandle` | `ObjectHandle` |
| 10 | `donut::render::DeferredLightingPass` | `DeferredLightingPassHandle` | `ObjectHandle` |
| 10 | `donut::render::TemporalAntiAliasingPass` | `TemporalAntiAliasingPassHandle` | `ObjectHandle` |
| 10 | `donut::render::ToneMappingPass` | `ToneMappingPassHandle` | `ObjectHandle` |
| 10 | `donut::render::DepthPass` | `DepthPassHandle` | `ObjectHandle` |
| 10 | `donut::render::PixelReadbackPass` | `PixelReadbackPassHandle` | `ObjectHandle` |
| 10 | `donut::render::MipMapGenPass` | `MipMapGenPassHandle` | `ObjectHandle` |
| 10 | `donut::render::MaterialIDPass` | `MaterialIdPassHandle` | `ObjectHandle` |
| 10 | `donut::render::SsaoPass` | `SsaoPassHandle` | `ObjectHandle` |
| 10 | `donut::render::EnvironmentMapPass` | `EnvironmentMapPassHandle` | `ObjectHandle` |
| 10 | `donut::render::SkyPass` | `SkyPassHandle` | `ObjectHandle` |
| 10 | `donut::render::BloomPass` | `BloomPassHandle` | `ObjectHandle` |
| 10 | `donut::render::LightProbeProcessingPass` | `LightProbeProcessingPassHandle` | `ObjectHandle` |
| 10 | `donut::render::DLSS` | `DlssHandle` | `ObjectHandle` |
| 11 | `TsImGuiPass` | `ImGuiPassHandle` | |
| 11 | `donut::app::RegisteredFont` | `ImGuiFontHandle` | |
| 11 | `VideoPlayer` | `VideoPlayerHandle` | |
| 11 | `SdkMesh` | `SdkMeshHandle` | |
| 11 | `GltfModel` | `GltfModelHandle` | `ObjectHandle` |
| 11 | `GltfMesh` | `GltfMeshHandle` | `ObjectHandle` |
| 11 | `BinaryFile` | `BinaryFileHandle` | `ObjectHandle` |
| 11 | `TranscodedTexture` | `TranscodedTextureHandle` | |
| 11 | `FbcTexture` | `FbcTextureHandle` | |
| 11 | `AsyncComputeLoop` | `AsyncComputeLoopHandle` | `ObjectHandle` |
| 11 | `TileMappings` | `TileMappingsHandle` | |
| 11 | `TextureHeap` | `TextureHeapHandle` | `ObjectHandle` |
| 11 | `SharedTexture` | `SharedTextureHandle` | `ObjectHandle` |
| 11 | `D3D12WorkGraph` | `D3D12WorkGraphHandle` | `ObjectHandle` |
| 11 | `OcclusionPredication` | `OcclusionPredicationHandle` | `ObjectHandle` |
| 11 | `PredicationBuffer` | `PredicationBufferHandle` | `ObjectHandle` |
| 11 | `MeshPipelineStatistics` | `MeshPipelineStatisticsHandle` | `ObjectHandle` |
| 11 | `RandomEngine` | `RandomEngineHandle` | `ObjectHandle` |
| 11 | `nvrhi::ITimerQuery` | `TimerQueryHandle` | `ResourceHandle` |

Class names follow the generator's wrapper classes where one exists (`CLASSES` in `tools/generate_donut_wrappers.py`: `ShadowMap`, `Dlss`, `Camera`, `View`, `Node`, `GraphicsPipelineDesc`, `RtPipelineDesc`, `ImGuiPass`, `ImGuiFont`, `StringList`, ...). The generator pairs a class `Xxx` with the handle `XxxHandle` by name. The `MaterialIDPass` handle is `MaterialIdPassHandle`, because the generator's parameter name is `materialIdPass` and there is no wrapper class.

If the compiler shows a pointee the table above lacks (a type the inventory missed), add a row and a class in the task where it shows up, following the same rules.

## The family procedure

Tasks 2-11 each run this procedure on their own family. The task gives the concrete inputs: the table rows, the classes, the `As*` helpers to delete, the functions whose return type changes, and the examples to smoke-run. Every step below appears in each of those tasks with that task's values filled in.

---

### Task 1: Tooling and C++ preparation (stage 0, no behavior change)

**Files:**
- Create: `core/donut_handles.d.ts`, `tools/check_interop_types.py`, `tools/test_check_interop_types.py`, `tools/test_generate_donut_wrappers.py`, `tools/find_untyped_handles.py`, `tools/smoke_examples.ps1`
- Modify: `core/donut_interop.d.ts:1` (reference), `tools/generate_donut_wrappers.py`, `CMakeLists.txt` (after line 358; `TSLANG_DONUT_DECLARATIONS` at line 511), `core/donut_interop.cpp` (`App::Own` near line 409; aliases before `extern "C"` at line 1745)
- Regenerate: `core/donut.ts`, `core/donut_globals.d.ts`

**Interfaces:**
- Produces:
  - `check_interop_types.HANDLES: dict[str, str]`, `OVERRIDES: dict[tuple[str, str], tuple[str, str]]`, `RAW_MEMORY: set[tuple[str, str]]` (all empty).
  - `check_interop_types.check(root, strict, fixes=None) -> list[str]` and `apply_fixes(root, fixes)`.
  - CLI: `python tools/check_interop_types.py [--fix] [--strict] [--stamp FILE] [--root DIR]`.
  - `python tools/find_untyped_handles.py` (exit 1 when it finds anything).
  - `pwsh -File tools/smoke_examples.ps1 [-Examples a,b] [-Apis dx12,vk] [-Seconds 8]`.
  - C++: `App::Own<T>(T*) -> T*`, `App::Own<T>(const nvrhi::RefCountPtr<T>&) -> T*`; aliases `InputLayoutDesc`, `StringList`, `RandomEngine`, `FramebufferFactoryRef`.

- [ ] **Step 1: Write the check script's tests**

Create `tools/test_check_interop_types.py`:

```python
"""Tests for check_interop_types.py, on small fixture trees.

    python -m unittest tools/test_check_interop_types.py
"""

import os
import sys
import tempfile
import textwrap
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import check_interop_types as checker  # noqa: E402

CPP = """\
namespace
{
    using RenderFn = void (*)(void* thisVal, {frame_type} frame);
}

extern "C"
{
    {create_type} Donut_CreateThing(App* app, int count, const char* name)
    {
        return nullptr;
    }

    void Donut_UseThing(App* app, {use_type} thing, double scale)
    {
    }

    void Donut_SetRenderCallback(TsRenderPass* pass, RenderFn method, void* thisVal)
    {
    }

    void Donut_ReadThing(App* app, void* dst)
    {
    }
}
"""

DTS = """\
type RenderCallback = (frame: {ts_frame}) => void;

enum Mode {{
    A = 0
}}

declare function Donut_CreateThing(app: AppHandle, count: int, name: string): {ts_create};
declare function Donut_UseThing(app: AppHandle, thing: {ts_use}, scale: number): void;
declare function Donut_SetRenderCallback(pass: PassHandle, handler: RenderCallback): void;
declare function Donut_ReadThing(app: AppHandle, dst: Opaque): void;
"""

HANDLES_DTS = """\
declare class AppHandle { private readonly __app: int; }
declare class PassHandle { private readonly __pass: int; }
declare class FrameHandle { private readonly __frame: int; }
declare class ResourceHandle { private readonly __resource: int; }
declare class ThingHandle extends ResourceHandle { private readonly __thing: int; }
"""

HANDLES = {
    "App": "AppHandle",
    "TsRenderPass": "PassHandle",
    "FrameContext": "FrameHandle",
    "nvrhi::IResource": "ResourceHandle",
    "Thing": "ThingHandle",
}


class CheckTest(unittest.TestCase):
    def setUp(self):
        self.saved = dict(checker.HANDLES), set(checker.RAW_MEMORY), dict(checker.OVERRIDES)
        checker.HANDLES.clear()
        checker.HANDLES.update(HANDLES)
        checker.RAW_MEMORY.clear()

    def tearDown(self):
        checker.HANDLES.clear()
        checker.HANDLES.update(self.saved[0])
        checker.RAW_MEMORY.clear()
        checker.RAW_MEMORY.update(self.saved[1])
        checker.OVERRIDES.clear()
        checker.OVERRIDES.update(self.saved[2])

    def run_check(self, strict=False, frame_type="FrameContext*", create_type="Thing*",
                  use_type="Thing*", ts_frame="FrameHandle", ts_create="ThingHandle | null",
                  ts_use="ThingHandle", dts_extra="", handles_extra=""):
        with tempfile.TemporaryDirectory() as root:
            os.makedirs(os.path.join(root, "core"))
            cpp = CPP.replace("{frame_type}", frame_type).replace("{create_type}", create_type) \
                .replace("{use_type}", use_type)
            with open(os.path.join(root, "core", "interop.cpp"), "w") as f:
                f.write(cpp)
            with open(os.path.join(root, "core", "donut_interop.d.ts"), "w") as f:
                f.write(DTS.format(ts_frame=ts_frame, ts_create=ts_create, ts_use=ts_use) + dts_extra)
            with open(os.path.join(root, "core", "donut_handles.d.ts"), "w") as f:
                f.write(HANDLES_DTS + handles_extra)
            return checker.check(root, strict)

    def test_matching_declarations_pass(self):
        self.assertEqual(self.run_check(), [])

    def test_wrong_handle_type_is_reported(self):
        problems = self.run_check(ts_use="AppHandle")
        self.assertEqual(len(problems), 1)
        self.assertIn("Donut_UseThing: parameter 'thing': C++ 'Thing*' is declared 'AppHandle', expected ThingHandle",
                      problems[0])
        self.assertIn("core/interop.cpp:", problems[0])
        self.assertIn("core/donut_interop.d.ts:", problems[0])

    def test_typed_cpp_with_opaque_ts_is_reported(self):
        problems = self.run_check(ts_use="Opaque")
        self.assertEqual(len(problems), 1)
        self.assertIn("expected ThingHandle", problems[0])

    def test_void_cpp_with_typed_ts_is_reported(self):
        problems = self.run_check(use_type="void*")
        self.assertEqual(len(problems), 1)
        self.assertIn("C++ 'void*' is declared 'ThingHandle', expected Opaque", problems[0])

    def test_unmapped_cpp_type_is_reported(self):
        problems = self.run_check(use_type="Gadget*")
        self.assertEqual(len(problems), 1)
        self.assertIn("C++ type 'Gadget*' has no TypeScript mapping", problems[0])

    def test_nullable_return_is_accepted_and_nonnullable_too(self):
        self.assertEqual(self.run_check(ts_create="ThingHandle"), [])

    def test_wrong_return_type_is_reported(self):
        problems = self.run_check(ts_create="AppHandle | null")
        self.assertEqual(len(problems), 1)
        self.assertIn("Donut_CreateThing: return", problems[0])

    def test_callback_parameter_type_is_checked(self):
        problems = self.run_check(ts_frame="Opaque")
        self.assertTrue(any("RenderCallback: parameter 'frame': C++ 'FrameContext*' is declared 'Opaque'" in p
                            for p in problems), problems)

    def test_function_missing_from_ts_is_reported(self):
        problems = self.run_check(dts_extra="declare function Donut_Extra(): void;\n")
        self.assertEqual(len(problems), 1)
        self.assertIn("Donut_Extra has no C++ definition", problems[0])

    def test_unused_handle_class_is_reported(self):
        problems = self.run_check(
            handles_extra="declare class GizmoHandle { private readonly __gizmo: int; }\n")
        self.assertEqual(len(problems), 1)
        self.assertIn("GizmoHandle is used by no function", problems[0])

    def test_base_class_used_only_as_base_is_not_reported(self):
        # ResourceHandle appears in no signature, but ThingHandle extends it.
        self.assertEqual(self.run_check(), [])

    def test_strict_reports_void_star_unless_listed_as_raw_memory(self):
        problems = self.run_check(strict=True)
        self.assertEqual(len(problems), 1)
        self.assertIn("Donut_ReadThing: parameter 'dst' is void*", problems[0])
        checker.RAW_MEMORY.add(("Donut_ReadThing", "dst"))
        self.assertEqual(self.run_check(strict=True), [])

    def test_fix_rewrites_opaque_declarations_of_typed_cpp(self):
        with tempfile.TemporaryDirectory() as root:
            os.makedirs(os.path.join(root, "core"))
            cpp = CPP.replace("{frame_type}", "FrameContext*").replace("{create_type}", "Thing*") \
                .replace("{use_type}", "Thing*")
            with open(os.path.join(root, "core", "interop.cpp"), "w") as f:
                f.write(cpp)
            dts = DTS.format(ts_frame="Opaque", ts_create="Opaque | null", ts_use="Opaque")
            # A declaration over two lines, as some in donut_interop.d.ts are.
            dts = dts.replace("(app: AppHandle, thing: Opaque, scale: number)",
                              "(app: AppHandle,\n    thing: Opaque, scale: number)")
            with open(os.path.join(root, "core", "donut_interop.d.ts"), "w") as f:
                f.write(dts)
            with open(os.path.join(root, "core", "donut_handles.d.ts"), "w") as f:
                f.write(HANDLES_DTS)
            fixes = []
            checker.check(root, False, fixes)
            self.assertEqual(len(fixes), 3)
            checker.apply_fixes(root, fixes)
            self.assertEqual(checker.check(root, False), [])
            with open(os.path.join(root, "core", "donut_interop.d.ts")) as f:
                text = f.read()
            self.assertIn("type RenderCallback = (frame: FrameHandle) => void;", text)
            self.assertIn("string): ThingHandle | null;", text)
            self.assertIn("    thing: ThingHandle, scale: number): void;", text)
            # Raw memory isn't touched.
            self.assertIn("dst: Opaque", text)

    def test_override_lets_void_star_be_declared_as_a_handle(self):
        dts = "declare function Donut_ReleaseObject(app: AppHandle, object: ObjectHandle): void;\n"
        cpp = textwrap.dedent("""\
            extern "C"
            {
                void Donut_ReleaseObject(App* app, void* object)
                {
                }
            }
            """)
        checker.HANDLES.clear()
        checker.HANDLES["App"] = "AppHandle"
        checker.OVERRIDES[("Donut_ReleaseObject", "object")] = ("void*", "ObjectHandle")
        with tempfile.TemporaryDirectory() as root:
            os.makedirs(os.path.join(root, "core"))
            with open(os.path.join(root, "core", "interop.cpp"), "w") as f:
                f.write(cpp)
            with open(os.path.join(root, "core", "donut_interop.d.ts"), "w") as f:
                f.write(dts)
            with open(os.path.join(root, "core", "donut_handles.d.ts"), "w") as f:
                f.write("declare class AppHandle { private readonly __app: int; }\n"
                        "declare class ObjectHandle { private readonly __object: int; }\n")
            self.assertEqual(checker.check(root, True), [])
            with open(os.path.join(root, "core", "donut_interop.d.ts"), "w") as f:
                f.write(dts.replace("object: ObjectHandle", "object: AppHandle"))
            problems = checker.check(root, True)
            self.assertEqual(len(problems), 2, problems)  # the override, and ObjectHandle now unused
            self.assertIn("parameter 'object' must be C++ 'void*', TypeScript 'ObjectHandle'", problems[0])

    def test_int_accepts_declared_enums(self):
        checker.HANDLES.clear()
        checker.HANDLES["App"] = "AppHandle"
        dts = "declare function Donut_SetMode(app: AppHandle, mode: Mode): void;\n"
        cpp_extra = textwrap.dedent("""\
            extern "C"
            {
                void Donut_SetMode(App* app, int mode)
                {
                }
            }
            """)
        with tempfile.TemporaryDirectory() as root:
            os.makedirs(os.path.join(root, "core"))
            with open(os.path.join(root, "core", "interop.cpp"), "w") as f:
                f.write(cpp_extra)
            with open(os.path.join(root, "core", "donut_interop.d.ts"), "w") as f:
                f.write("enum Mode {\n    A = 0\n}\n" + dts)
            with open(os.path.join(root, "core", "donut_handles.d.ts"), "w") as f:
                f.write("declare class AppHandle { private readonly __app: int; }\n")
            self.assertEqual(checker.check(root, False), [])


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run them to see them fail**

Run: `python -m unittest tools/test_check_interop_types.py`
Expected: `ModuleNotFoundError: No module named 'check_interop_types'`.

- [ ] **Step 3: Write the check script**

Create `tools/check_interop_types.py`:

```python
"""Checks that core/donut_interop.d.ts declares the interop functions as the C++ defines them.

Every Donut_* function defined in an `extern "C"` block of core/*.cpp must be declared in
donut_interop.d.ts with the same parameters, and each C++ type must map to the TypeScript type
TYPES (or HANDLES, for object pointers) gives it. The callback types (RenderFn <->
RenderCallback, ...) are compared the same way.

    python tools/check_interop_types.py [--fix] [--strict] [--stamp FILE] [--root DIR]

--fix:    where C++ takes or returns a handle type that the .d.ts still declares Opaque, rewrite
          the .d.ts with the handle type (keeping `| null`), then check again.
--root:   the repository to check (default: this script's); the tests point it at fixtures.
--strict: a void* parameter or return is an error unless RAW_MEMORY lists it.
--stamp:  written on success (the build's dependency on this check).

Exit status 1, with one line per problem, when they disagree.
"""

import glob
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# C++ types of plain values and raw memory -> the TypeScript types they may be declared as.
# `int` may also be any enum declared in donut_interop.d.ts.
TYPES = {
    "void": {"void"},
    "int": {"int"},
    "double": {"number"},
    "const char*": {"string"},
    "const char* const*": {"Ref<string>"},
    "void*": {"Opaque"},
    "const void*": {"Opaque"},
    "float*": {"Opaque"},
    "const float*": {"Opaque"},
    "int*": {"Opaque"},
    "const int*": {"Opaque"},
    "uint8_t*": {"Opaque"},
}

# Pointers to C++ objects -> handle types (declared in donut_handles.d.ts). Filled in stage by
# stage as functions move from void* to these.
HANDLES = {
}

# Parameters declared narrower than their C++ type: (function, parameter) -> (C++ type, TypeScript
# type). Donut_ReleaseObject takes any object App::OwnObject registered, kept type-erased in C++.
OVERRIDES = {
}

# Functions with no TypeScript declaration: called from C++ only.
CPP_ONLY = {"Donut_SetExecutablePath"}

# (function, parameter) pairs that are raw memory and stay void* under --strict; a parameter name
# of "*" stands for the return value.
RAW_MEMORY = set()


class Problem(Exception):
    pass


def normalize(cpp_type):
    t = " ".join(cpp_type.split())
    t = re.sub(r"\s*\*", "*", t)
    return t


def split_params(text):
    text = " ".join(text.split())
    return [p.strip() for p in text.split(",")] if text else []


def cpp_param(text):
    """("type", "name") of a C++ parameter."""
    m = re.match(r"(.*?)(\w+)$", text)
    return normalize(m.group(1)), m.group(2)


def parse_cpp(root):
    """Donut_* functions: name -> (file, line, return type, [(type, name)])."""
    functions = {}
    callbacks = {}
    for path in sorted(glob.glob(os.path.join(root, "core", "*.cpp"))):
        with open(path, encoding="utf-8") as f:
            text = f.read()
        rel = os.path.relpath(path, root).replace("\\", "/")
        for m in re.finditer(r"^\s*using (\w+)Fn = (\w[\w:\*\s]*?)\s*\(\*\)\(([^)]*)\);", text, re.M):
            line = text[:m.start()].count("\n") + 1
            callbacks[m.group(1)] = (rel, line, normalize(m.group(2)), [cpp_param(p) for p in split_params(m.group(3))])
        for block in re.finditer(r'^extern "C"\s*\n\{\n(.*?)^\}', text, re.S | re.M):
            body = block.group(1)
            first_line = text[:block.start(1)].count("\n") + 1
            for m in re.finditer(r"^    ([A-Za-z_][\w:<>\s\*&]*?[\s\*&])(Donut_\w+)\(([^)]*)\)\s*\n    \{", body, re.M):
                line = first_line + body[:m.start()].count("\n")
                functions[m.group(2)] = (rel, line, normalize(m.group(1)),
                                         [cpp_param(p) for p in split_params(m.group(3))])
    return functions, callbacks


def parse_ts(root):
    """Declared functions: name -> (file, line, return type, [(type, name)]); also the enums and
    callback types."""
    with open(os.path.join(root, "core", "donut_interop.d.ts"), encoding="utf-8") as f:
        lines = f.read().splitlines()
    rel = "core/donut_interop.d.ts"
    functions, callbacks, enums = {}, {}, set()
    i = 0
    while i < len(lines):
        line = lines[i]
        m = re.match(r"(?:declare )?(?:const )?enum (\w+)", line)
        if m:
            enums.add(m.group(1))
        m = re.match(r"type (\w+)Callback = \(([^)]*)\) => (\w+);", line)
        if m:
            callbacks[m.group(1)] = (rel, i + 1, m.group(3), [ts_param(p) for p in split_params(m.group(2))])
        if line.startswith("declare function "):
            start = i
            text = line
            while not text.rstrip().endswith(";"):
                i += 1
                text += " " + lines[i].strip()
            m = re.match(r"declare function (\w+)\((.*)\)\s*:\s*(.+);$", text)
            if not m:
                raise Problem(f"{rel}:{start + 1}: can't parse: {text}")
            functions[m.group(1)] = (rel, start + 1, " ".join(m.group(3).split()),
                                     [ts_param(p) for p in split_params(m.group(2))])
        i += 1
    return functions, callbacks, enums


def ts_param(text):
    name, type_ = text.split(":", 1)
    return " ".join(type_.split()), name.strip()


def handle_classes(root):
    """Handle classes in donut_handles.d.ts: name -> base class (or None)."""
    path = os.path.join(root, "core", "donut_handles.d.ts")
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as f:
        text = f.read()
    return {m.group(1): m.group(2) for m in
            re.finditer(r"^declare class (\w+)(?: extends (\w+))? \{", text, re.M)}


def accepted(cpp_type, enums):
    """The TypeScript types a C++ type may be declared as (without `| null`)."""
    if cpp_type in TYPES:
        types = set(TYPES[cpp_type])
        if cpp_type == "int":
            types |= enums
        return types
    if cpp_type.endswith("*") and cpp_type[:-1] in HANDLES:
        return {HANDLES[cpp_type[:-1]]}
    return None


def compare(where, cpp_type, ts_type, enums, problems):
    expected = accepted(cpp_type, enums)
    if expected is None:
        problems.append(f"{where}: C++ type '{cpp_type}' has no TypeScript mapping (add it to TYPES or HANDLES)")
        return
    base = ts_type[:-len(" | null")] if ts_type.endswith(" | null") else ts_type
    if base != ts_type and not cpp_type.endswith("*"):
        problems.append(f"{where}: '{ts_type}' is nullable but C++ '{cpp_type}' isn't a pointer")
    if base not in expected:
        problems.append(f"{where}: C++ '{cpp_type}' is declared '{ts_type}', expected {' or '.join(sorted(expected))}")


def fixable(cpp_type, ts_type):
    """The handle type an Opaque declaration should become, if that's the only problem."""
    base = ts_type[:-len(" | null")] if ts_type.endswith(" | null") else ts_type
    if base == "Opaque" and cpp_type.endswith("*") and cpp_type[:-1] in HANDLES:
        return HANDLES[cpp_type[:-1]]
    return None


def collapse_callbacks(params, where, problems):
    """C++ passes a callback as (XxxFn method, void* thisVal); TypeScript as one XxxCallback."""
    out = []
    i = 0
    while i < len(params):
        type_, name = params[i]
        if type_.endswith("Fn"):
            if i + 1 >= len(params) or params[i + 1] != ("void*", "thisVal"):
                problems.append(f"{where}: callback '{name}' isn't followed by 'void* thisVal'")
            out.append((type_[:-len("Fn")] + "Callback", name))
            i += 2
            continue
        out.append(params[i])
        i += 1
    return out


def check(root, strict, fixes=None):
    """The problems found; with a `fixes` list, also appends (line, parameter or None for the
    return value, handle type) for each Opaque declaration --fix can rewrite."""
    if fixes is None:
        fixes = []
    cpp, cpp_callbacks = parse_cpp(root)
    ts, ts_callbacks, enums = parse_ts(root)
    problems = []

    for name in sorted(set(cpp) - set(ts) - CPP_ONLY):
        path, line, _, _ = cpp[name]
        problems.append(f"{path}:{line}: {name} isn't declared in donut_interop.d.ts")
    for name in sorted(set(ts) - set(cpp)):
        path, line, _, _ = ts[name]
        problems.append(f"{path}:{line}: {name} has no C++ definition")

    used = set()
    for name in sorted(set(cpp) & set(ts)):
        cpath, cline, cret, cparams = cpp[name]
        tpath, tline, tret, tparams = ts[name]
        where = f"{cpath}:{cline}: {tpath}:{tline}: {name}"
        cparams = collapse_callbacks(cparams, where, problems)
        if len(cparams) != len(tparams):
            problems.append(f"{where}: {len(cparams)} parameters in C++, {len(tparams)} in TypeScript")
            continue
        compare(f"{where}: return", cret, tret, enums, problems)
        if fixable(cret, tret):
            fixes.append((tline, None, fixable(cret, tret)))
        used.add(tret.replace(" | null", ""))
        if strict and cret == "void*" and (name, "*") not in RAW_MEMORY:
            problems.append(f"{where}: returns void* (type it, or list it in RAW_MEMORY)")
        for (ctype, cname), (ttype, tname) in zip(cparams, tparams):
            used.add(ttype.replace(" | null", ""))
            if ctype.endswith("Callback"):
                if ttype != ctype:
                    problems.append(f"{where}: parameter '{cname}' is a {ctype}, declared '{ttype}'")
                continue
            if (name, cname) in OVERRIDES:
                expected_cpp, expected_ts = OVERRIDES[(name, cname)]
                if (ctype, ttype.replace(" | null", "")) != (expected_cpp, expected_ts):
                    problems.append(f"{where}: parameter '{cname}' must be C++ '{expected_cpp}', "
                                    f"TypeScript '{expected_ts}' (OVERRIDES)")
                continue
            compare(f"{where}: parameter '{cname}'", ctype, ttype, enums, problems)
            if fixable(ctype, ttype):
                fixes.append((tline, tname, fixable(ctype, ttype)))
            if strict and ctype == "void*" and (name, cname) not in RAW_MEMORY:
                problems.append(f"{where}: parameter '{cname}' is void* (type it, or list it in RAW_MEMORY)")

    for kind in sorted(set(cpp_callbacks) | set(ts_callbacks)):
        if kind not in cpp_callbacks or kind not in ts_callbacks:
            problems.append(f"callback {kind}: defined on one side only (C++ {kind}Fn, TypeScript {kind}Callback)")
            continue
        cpath, cline, cret, cparams = cpp_callbacks[kind]
        tpath, tline, tret, tparams = ts_callbacks[kind]
        where = f"{cpath}:{cline}: {tpath}:{tline}: {kind}Callback"
        if not cparams or cparams[0] != ("void*", "thisVal"):
            problems.append(f"{where}: C++ {kind}Fn doesn't start with 'void* thisVal'")
            continue
        cparams = cparams[1:]
        if len(cparams) != len(tparams):
            problems.append(f"{where}: {len(cparams)} parameters in C++, {len(tparams)} in TypeScript")
            continue
        compare(f"{where}: return", cret, tret, enums, problems)
        for (ctype, cname), (ttype, tname) in zip(cparams, tparams):
            used.add(ttype.replace(" | null", ""))
            compare(f"{where}: parameter '{cname}'", ctype, ttype, enums, problems)
            if fixable(ctype, ttype):
                fixes.append((tline, tname, fixable(ctype, ttype)))

    classes = handle_classes(root)
    for cls in HANDLES.values():
        if cls not in classes:
            problems.append(f"HANDLES maps to '{cls}', which donut_handles.d.ts doesn't declare")
    bases = {base for base in classes.values() if base}
    for cls in sorted(classes):
        if cls not in used and cls not in bases:
            problems.append(f"core/donut_handles.d.ts: {cls} is used by no function")
    return problems


def apply_fixes(root, fixes):
    """Rewrites the Opaque declarations `fixes` lists with their handle types."""
    path = os.path.join(root, "core", "donut_interop.d.ts")
    with open(path, encoding="utf-8") as f:
        lines = f.read().split("\n")
    for line, param, handle in fixes:
        # The declaration's lines: from `line` to the one ending with ';'.
        end = line - 1
        while not lines[end].rstrip().endswith(";"):
            end += 1
        if param is None:
            lines[end] = re.sub(r"\): Opaque( \| null)?;$", lambda m: f"): {handle}{m.group(1) or ''};", lines[end])
            continue
        pattern = re.compile(r"\b" + re.escape(param) + r": Opaque(?=( \| null)?[,)])")
        for i in range(line - 1, end + 1):
            if pattern.search(lines[i]):
                lines[i] = pattern.sub(f"{param}: {handle}", lines[i], count=1)
                break
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write("\n".join(lines))


def main():
    args = sys.argv[1:]
    strict = "--strict" in args
    stamp = args[args.index("--stamp") + 1] if "--stamp" in args else None
    root = args[args.index("--root") + 1] if "--root" in args else ROOT
    try:
        if "--fix" in args:
            fixes = []
            check(root, strict, fixes)
            apply_fixes(root, fixes)
            print(f"check_interop_types: rewrote {len(fixes)} declaration(s)")
        problems = check(root, strict)
    except Problem as e:
        problems = [str(e)]
    for p in problems:
        print(p)
    if problems:
        print(f"check_interop_types: {len(problems)} problem(s)")
        sys.exit(1)
    if stamp:
        with open(stamp, "w") as f:
            f.write("ok\n")


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Run the tests and the check**

Run: `python -m unittest tools/test_check_interop_types.py`
Expected: `Ran 15 tests ... OK`.

Run: `python tools/check_interop_types.py; echo $?`
Expected: no output, `0`. The current tree has `void*` <-> `Opaque` everywhere, and `Donut_SetExecutablePath` is in `CPP_ONLY`.

Run: `python tools/check_interop_types.py --strict | tail -1`
Expected: `check_interop_types: 1298 problem(s)`. That's the untyped sites the following tasks remove.

- [ ] **Step 5: Write the generator's tests**

Create `tools/test_generate_donut_wrappers.py`:

```python
"""Tests for generate_donut_wrappers.py's handling of typed handles.

    python -m unittest tools/test_generate_donut_wrappers.py
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import generate_donut_wrappers as gen  # noqa: E402

DTS = """\
declare function Donut_CreateApp(title: string): AppHandle | null;
declare function Donut_CreateRWStructuredBuffer(app: AppHandle, stride: int, count: int, debugName: string): BufferHandle;
declare function Donut_ClearColor(frame: FrameHandle, r: number): void;
declare function Donut_SaveFrameToFile(app: AppHandle, frame: FrameHandle, path: string): int;
declare function Donut_CopyTextureToFrame(frame: FrameHandle, texture: TextureHandle | null): void;
declare function Donut_GetAdapterCount(list: Opaque): int;
"""


class GenerateTest(unittest.TestCase):
    def generate(self, handles):
        return gen.generate(gen.parse(DTS), handles)

    def test_wrapper_holds_its_typed_handle(self):
        text = self.generate({"AppHandle", "FrameHandle", "BufferHandle", "TextureHandle"})
        self.assertIn("export class App {\n    readonly handle: AppHandle;\n\n"
                      "    constructor(handle: AppHandle | null) {\n"
                      "        this.handle = handle as AppHandle;", text)

    def test_wrapper_handle_stays_opaque_until_declared(self):
        text = self.generate(set())
        self.assertIn("export class App {\n    readonly handle: Opaque;", text)

    def test_typed_parameter_takes_the_wrapper_class(self):
        text = self.generate({"AppHandle", "FrameHandle"})
        self.assertIn("saveFrameToFile(frame: Frame, path: string): int {", text)
        self.assertIn("Donut_SaveFrameToFile(this.handle, frame.handle, path)", text)

    def test_typed_return_makes_the_wrapper(self):
        text = self.generate({"AppHandle"})
        self.assertIn("static create(title: string): App {", text)
        self.assertIn("return new App(Donut_CreateApp(title));", text)

    def test_handle_without_wrapper_class_stays_a_handle(self):
        text = self.generate({"AppHandle", "BufferHandle"})
        self.assertIn("createRWStructuredBuffer(stride: int, count: int, debugName: string): BufferHandle {", text)

    def test_nullable_handle_without_wrapper_passes_through(self):
        text = self.generate({"FrameHandle", "TextureHandle"})
        self.assertIn("copyTextureToFrame(texture: TextureHandle | null): void {", text)
        self.assertIn("Donut_CopyTextureToFrame(this.handle, texture);", text)


if __name__ == "__main__":
    unittest.main()
```

Run: `python -m unittest tools/test_generate_donut_wrappers.py`
Expected: FAIL with `TypeError: generate() takes 1 positional argument but 2 were given`.

- [ ] **Step 6: Teach the generator typed handles**

Edit `tools/generate_donut_wrappers.py` with these seven replacements (old text -> new text):

1. After `GLOBALS = os.path.join(ROOT, "core", "donut_globals.d.ts")` add the line:
   ```python
   HANDLES = os.path.join(ROOT, "core", "donut_handles.d.ts")
   ```
2. In `HEADER`, replace
   ```
   // and return the classes too; anything else stays an Opaque handle, e.g. shaders and pipelines.
   ```
   with
   ```
   // and return the classes too; other objects stay typed handles (TextureHandle, ShaderHandle, ...,
   // declared in donut_handles.d.ts).
   ```
3. Before `class Param:` add:
   ```python
   def wrapper_class(type_, name=None):
       """The wrapper class for a declared type: XxxHandle (or `XxxHandle | null`) for a class Xxx;
       an Opaque handle goes by its parameter's name (functions not converted to typed handles yet)."""
       base = type_[:-len(" | null")] if type_.endswith(" | null") else type_
       if base.endswith("Handle") and base[:-len("Handle")] in CLASSES.values():
           return base[:-len("Handle")]
       if base == "Opaque" and name:
           return CLASSES.get(name) or PARAMETER_ALIASES.get(name)
       return None


   ```
4. In `Param.__init__`, replace
   ```python
           self.nullable = self.type == "Opaque | null"
   ```
   with
   ```python
           self.nullable = self.type.endswith(" | null")
   ```
   and replace
   ```python
           self.cls = None
           if self.type in ("Opaque", "Opaque | null"):
               self.cls = CLASSES.get(self.name) or PARAMETER_ALIASES.get(self.name)
   ```
   with
   ```python
           self.cls = wrapper_class(self.type, self.name)
   ```
5. In `Function.__init__`, replace `        self.returns_class = None` with
   ```python
           self.returns_class = wrapper_class(self.returns)
   ```
   (the following `if self.returns in ("Opaque", "Opaque | null"):` block stays).
6. Replace `def generate(functions):` with
   ```python
   def handle_type(cls, handles):
       """The type of a wrapper's handle: XxxHandle once donut_handles.d.ts declares it."""
       return f"{cls}Handle" if f"{cls}Handle" in handles else "Opaque"


   def generate(functions, handles):
   ```
   and inside it replace
   ```python
           out.append(f"export class {cls} {{")
           out.append("    readonly handle: Opaque;")
           out.append("")
           out.append("    constructor(handle: Opaque | null) {")
           out.append("        this.handle = handle as Opaque;")
   ```
   with
   ```python
           handle = handle_type(cls, handles)
           out.append(f"export class {cls} {{")
           out.append(f"    readonly handle: {handle};")
           out.append("")
           out.append(f"    constructor(handle: {handle} | null) {{")
           out.append(f"        this.handle = handle as {handle};")
   ```
7. In `main()`, replace
   ```python
       if "--report" in sys.argv:
           report(functions)
       text = generate(functions)
   ```
   with
   ```python
       handles = set()
       if os.path.exists(HANDLES):
           with open(HANDLES, encoding="utf-8") as f:
               handles = set(re.findall(r"^declare class (\w+)", f.read(), re.M))
       if "--report" in sys.argv:
           report(functions)
       text = generate(functions, handles)
   ```

Run: `python -m unittest tools/test_generate_donut_wrappers.py`
Expected: `Ran 6 tests ... OK`.

- [ ] **Step 7: Add the empty handle declarations and reference them**

Create `core/donut_handles.d.ts`:

```ts
// Handle types: one class per kind of C++ object the interop functions (donut_interop.d.ts) take
// or return. Declared, never defined: a handle is the C++ object's pointer, and its class only
// gives it a type of its own, so tslang and tsc reject one kind of handle where another is
// expected. The private brand member, named differently in each class, is what makes two classes
// incompatible; it's an int because tslang can't compile a void member here.
//
// tools/check_interop_types.py maps each C++ type to its class (HANDLES there) and checks every
// declaration in donut_interop.d.ts against its C++ definition.
//
// Handles to nvrhi resources extend ResourceHandle (Donut_ReleaseResource takes any of them);
// handles to objects App::OwnObject keeps extend ObjectHandle (Donut_ReleaseObject).
// Never declare a parameter as a union of two of these: tslang passes a union as a tagged struct,
// not a pointer. Take their base class instead.
```

Insert as the first line of `core/donut_interop.d.ts`:

```ts
/// <reference path="donut_handles.d.ts" />
```

Run: `python tools/check_interop_types.py; echo $?`
Expected: `0`.

- [ ] **Step 8: Regenerate the wrappers and check that only the header comment changed**

Run: `python tools/generate_donut_wrappers.py && git diff --ignore-cr-at-eol --stat core/`
Expected: `core/donut.ts | 3 ++-` only (the `HEADER` comment) and `core/donut_interop.d.ts` (the reference).

- [ ] **Step 9: Add the finder and the smoke script**

Create `tools/find_untyped_handles.py`:

```python
"""Lists the places in core/*.ts and examples/*.ts where Opaque stands for a handle: fields,
locals, parameters and callbacks still typed Opaque that hold, receive or pass typed handles.

    python tools/find_untyped_handles.py

Opaque is `any`, so tslang and tsc accept those silently. This runs tsc with Opaque declared as a
class of its own instead, so that each of them is an error, and prints the errors in the
repository's files (tslang's default library has errors of its own under tsc; they're skipped).
Exit status 1 when it finds any.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Errors that aren't about Opaque: tsc's view of a tslang enum comparison.
KNOWN = {("examples/compute_shader_derivatives.ts", "TS2367")}


def run_tsc():
    with tempfile.TemporaryDirectory() as tmp:
        types = os.path.join(tmp, "tslang")
        shutil.copytree(os.path.join(ROOT, "types", "tslang"), types)
        index = os.path.join(types, "index.d.ts")
        with open(index, encoding="utf-8") as f:
            text = f.read()
        if "declare type Opaque = any;" not in text:
            sys.exit("find_untyped_handles: types/tslang/index.d.ts no longer declares Opaque as any")
        text = text.replace("declare type Opaque = any;",
                            "declare class Opaque { private readonly __opaque: int; }")
        with open(index, "w", encoding="utf-8") as f:
            f.write(text)
        # tsconfig.json's "types", with its ./types/tslang swapped for the copy.
        with open(os.path.join(ROOT, "tsconfig.json"), encoding="utf-8") as f:
            entries = re.search(r'"types":\s*(\[[^\]]*\])', f.read()).group(1)
        entries = entries.replace('"./types/tslang"', json.dumps(types.replace("\\", "/")))
        config = os.path.join(tmp, "tsconfig.json")
        with open(config, "w", encoding="utf-8") as f:
            f.write('{"extends": %s, "compilerOptions": {"types": %s, "incremental": false}, "include": %s}' % (
                json.dumps(os.path.join(ROOT, "tsconfig.json").replace("\\", "/")), entries,
                json.dumps([os.path.join(ROOT, d, "*.ts").replace("\\", "/") for d in ("core", "examples")])))
        result = subprocess.run("npx --no-install tsc --noEmit -p " + config,
                                cwd=ROOT, capture_output=True, text=True, shell=True)
    return result.stdout


def main():
    pattern = re.compile(r"^((?:core|examples)/[^(]+)\((\d+),\d+\): error (TS\d+): (.*)$")
    found = 0
    for line in run_tsc().splitlines():
        m = pattern.match(line.replace("\\", "/"))
        if not m or (m.group(1), m.group(3)) in KNOWN:
            continue
        print(f"{m.group(1)}:{m.group(2)}: {m.group(4)}")
        found += 1
    print(f"find_untyped_handles: {found} place(s)")
    sys.exit(1 if found else 0)


if __name__ == "__main__":
    main()
```

Create `tools/smoke_examples.ps1`:

```powershell
# Starts built examples briefly on each graphics API with the debug layers and reports the ones
# that crash, exit with an error, or log errors (Donut's "ERROR:" lines, validation messages).
#
#   pwsh -File tools/smoke_examples.ps1 [-Examples basic_triangle,compute_nbody] [-Apis dx12,vk] [-Seconds 8]
#
# With no -Examples, runs every examples/*.ts that has a built executable in build/bin. An example
# still running after -Seconds passes (it is stopped then); one that exits sooner passes only with
# exit code 0. The output of each run is kept in build/smoke/<example>.<api>.{out,err}.txt.
# Examples start as normal windows: leave the desktop alone while it runs, as an example only
# renders while its window has focus.
param(
    # Comma- or space-separated (pwsh -File hands a list over as one string).
    [string]$Examples = "",
    [string]$Apis = "dx12,vk",
    [int]$Seconds = 8
)

$exampleList = @($Examples -split "[,\s]+" | Where-Object { $_ })
$apiList = @($Apis -split "[,\s]+" | Where-Object { $_ })

$root = Split-Path -Parent $PSScriptRoot
$bin = Join-Path $root "build/bin"
$logs = Join-Path $root "build/smoke"
New-Item -ItemType Directory -Force $logs | Out-Null

if ($exampleList.Count -eq 0) {
    $exampleList = @(Get-ChildItem (Join-Path $root "examples/*.ts") |
        ForEach-Object { $_.BaseName } |
        Where-Object { Test-Path (Join-Path $bin "$_.exe") })
}

# Arguments some examples need on every run.
$extraArgs = @{
    "video_texture" = @("-mute")
}

$failures = @()
foreach ($example in $exampleList) {
    $exe = Join-Path $bin "$example.exe"
    if (-not (Test-Path $exe)) {
        $failures += "${example}: not built"
        continue
    }
    foreach ($api in $apiList) {
        $out = Join-Path $logs "$example.$api.out.txt"
        $err = Join-Path $logs "$example.$api.err.txt"
        $arguments = @("-$api", "-debug") + $extraArgs[$example]
        $p = Start-Process -FilePath $exe -ArgumentList $arguments -WorkingDirectory $bin -NoNewWindow -PassThru `
            -RedirectStandardOutput $out -RedirectStandardError $err
        $finished = $p.WaitForExit($Seconds * 1000)
        if (-not $finished) {
            Stop-Process -Id $p.Id -Force
            $p.WaitForExit()
        }
        $problem = $null
        if ($finished -and $p.ExitCode -ne 0) {
            $problem = "exited with code $($p.ExitCode)"
        }
        $errors = @(Get-Content $out, $err -ErrorAction SilentlyContinue |
            Where-Object { $_ -match "ERROR|Validation Error|D3D12 ERROR|D3D11 ERROR" })
        if ($errors.Count -gt 0) {
            $problem = (@($problem) + "$($errors.Count) error line(s), first: $($errors[0])" | Where-Object { $_ }) -join "; "
        }
        if ($problem) {
            $failures += "$example ($api): $problem"
            Write-Host "FAIL $example ($api): $problem"
        } else {
            Write-Host "ok   $example ($api)"
        }
    }
}

if ($failures.Count -gt 0) {
    Write-Host ""
    Write-Host "smoke_examples: $($failures.Count) failure(s)"
    $failures | ForEach-Object { Write-Host "  $_" }
    exit 1
}
Write-Host "smoke_examples: all passed"
```

Run: `python tools/find_untyped_handles.py | tail -1`
Expected: `find_untyped_handles: 11 place(s)`. These are the existing untyped holders in `feature_demo.ts`, `mobile_nerf_rayquery.ts` and `ray_queries.ts`; later tasks remove them.

- [ ] **Step 10: Wire the check into CMake**

In `CMakeLists.txt`, after

```cmake
add_library(donut_interop STATIC core/donut_interop.cpp)
configure_donut_interop(donut_interop)
```

add:

```cmake

# core/donut_interop.d.ts declares the functions core/*.cpp define, by hand: check that each
# declaration matches its definition, handle types included, before building the C++.
find_package(Python3 REQUIRED COMPONENTS Interpreter)
file(GLOB INTEROP_CPP_SOURCES CONFIGURE_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/core/*.cpp")
add_custom_command(
    OUTPUT "${CMAKE_CURRENT_BINARY_DIR}/check_interop_types.stamp"
    COMMAND "${Python3_EXECUTABLE}" "${CMAKE_CURRENT_SOURCE_DIR}/tools/check_interop_types.py"
        --stamp "${CMAKE_CURRENT_BINARY_DIR}/check_interop_types.stamp"
    DEPENDS
        "${CMAKE_CURRENT_SOURCE_DIR}/tools/check_interop_types.py"
        "${CMAKE_CURRENT_SOURCE_DIR}/core/donut_interop.d.ts"
        "${CMAKE_CURRENT_SOURCE_DIR}/core/donut_handles.d.ts"
        ${INTEROP_CPP_SOURCES}
    COMMENT "Checking core/donut_interop.d.ts against the C++ interop functions"
    VERBATIM)
add_custom_target(check_interop_types DEPENDS "${CMAKE_CURRENT_BINARY_DIR}/check_interop_types.stamp")
add_dependencies(donut_interop check_interop_types)
```

In `set(TSLANG_DONUT_DECLARATIONS ...)` add `"${CMAKE_CURRENT_SOURCE_DIR}/core/donut_handles.d.ts"` after the `donut_interop.d.ts` line. Also change the comment above it, from "references core/donut_interop.d.ts." to "references core/donut_interop.d.ts, which references core/donut_handles.d.ts."

- [ ] **Step 11: Prove the build fails on a mismatch**

Temporarily append `declare function Donut_Bogus(): void;` to `core/donut_interop.d.ts`, then build `donut_interop`:

`cmd /c '"C:\Program Files\Microsoft Visual Studio\18\Professional\VC\Auxiliary\Build\vcvars64.bat" >nul && cmake --build I:\native_ts_graphics\build --target donut_interop 2>&1'`

Expected: FAILED, with `core/donut_interop.d.ts:<n>: Donut_Bogus has no C++ definition`. Remove the line again (`git diff core/donut_interop.d.ts` shows only the reference line).

- [ ] **Step 12: Type `App::Own` and add the C++ aliases**

In `core/donut_interop.cpp`, replace

```cpp
        void* Own(nvrhi::IResource* resource)
        {
            if (!resource)
                return nullptr;
            resources.emplace(resource, resource);
            return resource;
        }
```

with

```cpp
        // Holds a reference to a GPU resource handed to TypeScript as a raw pointer, returned
        // with its own type (Donut_ReleaseResource drops the reference).
        template <typename T>
        T* Own(T* resource)
        {
            if (!resource)
                return nullptr;
            resources.emplace(resource, resource);
            return resource;
        }

        template <typename T>
        T* Own(const nvrhi::RefCountPtr<T>& resource)
        {
            return Own(resource.Get());
        }
```

Immediately before the line `extern "C"` that opens the interop functions (line 1745, at file scope: the anonymous namespace above it closes at line 1696), add:

```cpp
namespace
{
    // Names for the C++ types handed to TypeScript as handles that have none of their own;
    // tools/check_interop_types.py maps handle types by these names.
    using InputLayoutDesc = std::vector<nvrhi::VertexAttributeDesc>;
    using StringList = std::vector<std::string>;
    using RandomEngine = std::default_random_engine;
    using FramebufferFactoryRef = std::shared_ptr<donut::engine::FramebufferFactory>;
}

```

- [ ] **Step 13: Build everything, run tsc and a smoke run**

Run the full build (Global Constraints). Expected: success, including `Checking core/donut_interop.d.ts against the C++ interop functions`.

Run: `npx --no-install tsc --noEmit -p . --incremental false 2>&1 | grep "error TS" | grep -v "tslang/defaultlib"`
Expected: only `examples/compute_shader_derivatives.ts(114,17): error TS2367`.

Run: `pwsh -File tools/smoke_examples.ps1 -Examples basic_triangle,compute_nbody,headless`
Expected: `smoke_examples: all passed`.

Record the baseline that later smoke runs are compared with. This runs every built example on both APIs, about 25 minutes:

`pwsh -File tools/smoke_examples.ps1 *> build/smoke-baseline.txt`

Expected: whatever fails here fails before any handle is typed. That includes examples needing a feature an API lacks (D3D12-only samples on Vulkan, for instance), which exit with code 1 and say why. Read the `FAIL` lines and keep the file (it's in `build/`, not committed).

- [ ] **Step 14: Commit**

```bash
git add core/donut_handles.d.ts core/donut_interop.d.ts core/donut_interop.cpp core/donut.ts core/donut_globals.d.ts CMakeLists.txt tools/check_interop_types.py tools/test_check_interop_types.py tools/generate_donut_wrappers.py tools/test_generate_donut_wrappers.py tools/find_untyped_handles.py tools/smoke_examples.ps1
git commit -m "Check donut_interop.d.ts against the C++ interop functions

tools/check_interop_types.py compares every extern \"C\" Donut_* function with its declaration
through one C++ -> TypeScript type table, and the build runs it before donut_interop. The
generator types a wrapper's handle once donut_handles.d.ts declares XxxHandle. No handle types
yet: the next commits add them one family at a time.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: App, Frame, Pass, CommandList and the callbacks (stage 1)

**Files:**
- Modify: `core/donut_handles.d.ts`, `tools/check_interop_types.py` (`HANDLES`), the `core/*.cpp` files whose functions take or return these types, `core/donut_interop.d.ts` (via `--fix`), examples holding these handles
- Regenerate: `core/donut.ts`, `core/donut_globals.d.ts`

**Interfaces:**
- Consumes: Task 1's tools; the classes of earlier tasks (`ResourceHandle`).
- Produces: `AppHandle`, `FrameHandle`, `PassHandle`, `AdapterListHandle`, `ResourceHandle`, `CommandListHandle`; C++ functions taking and returning `App*`, `FrameContext*`, `TsRenderPass*`, `AdapterList*`, `nvrhi::IResource*`, `nvrhi::ICommandList*`.

- [ ] **Step 1: Declare the classes and map the C++ types**

Append to `core/donut_handles.d.ts`:

```ts
declare class AppHandle { private readonly __app: int; }
declare class FrameHandle { private readonly __frame: int; }
declare class PassHandle { private readonly __pass: int; }
declare class AdapterListHandle { private readonly __adapterList: int; }
declare class ResourceHandle { private readonly __resource: int; }
declare class CommandListHandle extends ResourceHandle { private readonly __commandList: int; }
```

Add to `HANDLES` in `tools/check_interop_types.py`:

```python
    "App": "AppHandle",
    "FrameContext": "FrameHandle",
    "TsRenderPass": "PassHandle",
    "AdapterList": "AdapterListHandle",
    "nvrhi::IResource": "ResourceHandle",
    "nvrhi::ICommandList": "CommandListHandle",
```

- [ ] **Step 2: Run the check to see it fail**

Run: `python tools/check_interop_types.py`
Expected: FAIL. There is one `... is used by no function` line per new class (a class only extended by another is exempt), and nothing else.

- [ ] **Step 3: Type the C++ parameters**

List the places that cast a `void*` to these types:

```bash
grep -nE "AsApp\(|AsFrame\(|AsPass\(|AsAdapterList\(|AsCommandList\(|static_cast<App ?\*>|static_cast<FrameContext ?\*>|static_cast<TsRenderPass ?\*>|static_cast<AdapterList ?\*>|static_cast<nvrhi::ICommandList ?\*>" core/*.cpp
```

At each hit whose argument is a `void*` parameter of an `extern "C"` function, change that parameter to the typed pointer and drop the cast or helper call. For example:

```cpp
    void Donut_SetRunWhenUnfocused(void* pass, int enabled)
    {
        AsPass(pass)->m_RunWhenUnfocused = enabled != 0;
    }
```

becomes

```cpp
    void Donut_SetRunWhenUnfocused(TsRenderPass* pass, int enabled)
    {
        pass->m_RunWhenUnfocused = enabled != 0;
    }
```

Then delete these helpers: `AsApp`, `AsFrame`, `AsPass`, `AsAdapterList`, `AsCommandList`. Re-run the grep: what's left is a cast of something other than a parameter (a local, a member). Leave those.

The parameters are named consistently (`app`, `frame`, `pass`, `commandList`), so one sed retypes most of them. Only signature lines are touched; a parameter on a continuation line is left for the compiler to point out once the helpers are gone:

```bash
sed -i -E 's/^(    [A-Za-z][^(]* Donut_\w+\((.*, )?)void\* app([,)])/\1App* app\3/; s/^(    [A-Za-z][^(]* Donut_\w+\((.*, )?)void\* frame([,)])/\1FrameContext* frame\3/; s/^(    [A-Za-z][^(]* Donut_\w+\((.*, )?)void\* commandList([,)])/\1nvrhi::ICommandList* commandList\3/; s/^(    [A-Za-z][^(]* Donut_\w+\((.*, )?)void\* pass([,)])/\1TsRenderPass* pass\3/' core/donut_interop.cpp
```

Then `AsApp(app)` and the like become plain `app`.

Also type these, which the helpers don't find:
- `Donut_ReleaseResource(void* app, void* resource)` becomes `(App* app, nvrhi::IResource* resource)`, and its body erases `resource` directly.
- The render callback: in `using RenderFn = void (*)(void* thisVal, void* frame);` (`core/donut_interop.cpp:132`) the frame becomes `FrameContext* frame`. `FrameContext` is defined below that line (line 140), so add `struct FrameContext;` above the `using` lines.
- `MakeApp` already returns `App*`.

- [ ] **Step 4: Type the C++ returns**

Change the `void*` return type of these functions:

- `TsRenderPass*`: Donut_AddPass
- `App*`: Donut_CreateApp, Donut_CreateAppForAPI, Donut_CreateAppWithOptions, Donut_CreateHeadlessApp, Donut_CreateHeadlessAppWithOptions
- `nvrhi::ICommandList*`: Donut_CreateCommandList, Donut_CreateComputeQueueCommandList, Donut_CreateDeferredCommandList, Donut_GetFrameCommandList
- `AdapterList*`: Donut_EnumerateAdapters

- [ ] **Step 5: Bring the `.d.ts` along**

Run: `python tools/check_interop_types.py --fix`
Expected: `check_interop_types: rewrote <N> declaration(s)` and no problem lines. `--fix` reads only the C++ text, so it runs before the C++ compiles. Any remaining problem names a declaration `--fix` doesn't handle (an override, a parameter count). Fix it by hand, then re-run without `--fix` until it prints nothing.

- [ ] **Step 6: Build the interop**

Run the build command from Global Constraints with `--target donut_interop donut_interop_shared` added after `build`.
Expected: the check passes and the C++ compiles. Fix every compiler error at its cause:
- a caller passing the wrong kind of pointer: fix the caller;
- a parameter still `void*` where a deleted helper used to convert it (signatures spread over several lines are easy to miss): type it;
- a helper still taking `void*`: type it.

After each C++ fix, re-run Step 5's `--fix`. A real mismatch between kinds goes in the commit message.

- [ ] **Step 7: Regenerate the wrappers and check that no method changed**

```bash
N='s/\b[A-Za-z0-9]+Handle\b/Opaque/g'
git show HEAD:core/donut.ts | grep -E "^export class |^    (static )?\w+\(.*\{$" | sed -E "$N" > "$TEMP/methods.before"
python tools/generate_donut_wrappers.py
grep -E "^export class |^    (static )?\w+\(.*\{$" core/donut.ts | sed -E "$N" > "$TEMP/methods.after"
diff "$TEMP/methods.before" "$TEMP/methods.after" && echo "same methods"
```

Expected: `same methods`. With handle types read as `Opaque`, every class and method signature in `core/donut.ts` is unchanged.

A difference means a typed declaration maps differently than before:
- **A method moved class or got renamed.** A type in the `.d.ts` doesn't match the generator's `CLASSES`: fix the class name (the `XxxHandle` of a wrapper `Xxx`), not the generator.
- **A parameter or return turned from a handle into a wrapper class.** The generator now maps it by its type where it used to miss it by name. Keep it: the build in Step 9 points at the callers to update.

- [ ] **Step 8: Retype the holders in TypeScript**

Run: `python tools/find_untyped_handles.py | grep -E "'(App|Frame|Pass|AdapterList|Resource|CommandList)(Handle)?( \| null)?'"`

Each line points at a field, local, parameter, array or callback typed `Opaque` that holds one of these handles. Retype its declaration:
- the handle class;
- the wrapper class, if it holds the wrapper object (Review Focus 5);
- the base class (`ResourceHandle[]`, `ObjectHandle[]`), if it holds several kinds (Review Focus 1).

Repeat until the grep prints nothing. Also:
- `core/input_pass.ts`: the `Opaque` app handle its constructor takes becomes `AppHandle`.
- Every example's `onRender(frameHandle: Opaque)` becomes `onRender(frameHandle: FrameHandle)`. The finder reports them as callbacks whose parameter types don't match `RenderCallback`.

- [ ] **Step 9: Build, check, smoke-run**

Run the full build (Global Constraints). Expected: success.

Run the tsc check (Global Constraints). Expected: only the TS2367 line.

Run: `pwsh -File tools/smoke_examples.ps1 -Examples basic_triangle,compute_nbody,headless,async_compute,threaded_rendering,16bit_arithmetic,multi_draw_indirect`
Expected: `smoke_examples: all passed`, apart from failures already listed in `build/smoke-baseline.txt` (Task 1 Step 13) for the same example and API.

- [ ] **Step 10: Commit**

```bash
git add core/donut_handles.d.ts core/donut_interop.d.ts core/donut.ts core/donut_globals.d.ts core/*.cpp core/input_pass.ts tools/check_interop_types.py examples/
git commit -m "Type App, Frame, Pass and CommandList handles

No mismatches between handle kinds found.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

If Step 6 or Step 8 found a real mismatch, replace the middle paragraph with one line per mismatch: where it was and how it was fixed.

---
### Task 3: Buffers (stage 2)

**Files:**
- Modify: `core/donut_handles.d.ts`, `tools/check_interop_types.py` (`HANDLES`), the `core/*.cpp` files whose functions take or return these types, `core/donut_interop.d.ts` (via `--fix`), examples holding these handles
- Regenerate: `core/donut.ts`, `core/donut_globals.d.ts`

**Interfaces:**
- Consumes: Task 1's tools; the classes of earlier tasks (`ResourceHandle`).
- Produces: `BufferHandle`; C++ functions taking and returning `nvrhi::IBuffer*`.

- [ ] **Step 1: Declare the classes and map the C++ types**

Append to `core/donut_handles.d.ts`:

```ts
declare class BufferHandle extends ResourceHandle { private readonly __buffer: int; }
```

Add to `HANDLES` in `tools/check_interop_types.py`:

```python
    "nvrhi::IBuffer": "BufferHandle",
```

- [ ] **Step 2: Run the check to see it fail**

Run: `python tools/check_interop_types.py`
Expected: FAIL. There is one `... is used by no function` line per new class (a class only extended by another is exempt), and nothing else.

- [ ] **Step 3: Type the C++ parameters**

List the places that cast a `void*` to these types:

```bash
grep -nE "AsBuffer\(|static_cast<nvrhi::IBuffer ?\*>" core/*.cpp
```

At each hit whose argument is a `void*` parameter of an `extern "C"` function, change that parameter to the typed pointer and drop the cast or helper call. For example:

```cpp
    void Donut_BindStructuredBufferUAV(void* bindingSetDesc, int slot, void* buffer)
    {
        static_cast<nvrhi::BindingSetDesc*>(bindingSetDesc)->addItem(
            nvrhi::BindingSetItem::StructuredBuffer_UAV(static_cast<uint32_t>(slot), AsBuffer(buffer)));
    }
```

becomes

```cpp
    void Donut_BindStructuredBufferUAV(void* bindingSetDesc, int slot, nvrhi::IBuffer* buffer)
    {
        static_cast<nvrhi::BindingSetDesc*>(bindingSetDesc)->addItem(
            nvrhi::BindingSetItem::StructuredBuffer_UAV(static_cast<uint32_t>(slot), buffer));
    }
```

Then delete these helpers: `AsBuffer`. Re-run the grep: what's left is a cast of something other than a parameter (a local, a member). Leave those.

Also: the file-local helper `CreateStaticBuffer` returns `void*`. Make it return `nvrhi::IBuffer*`.

- [ ] **Step 4: Type the C++ returns**

Change the `void*` return type of these functions:

- `nvrhi::IBuffer*`: Donut_CreateAccelStructInputBuffer, Donut_CreateAccelStructInputRawBuffer, Donut_CreateAccelStructInputStructuredBuffer, Donut_CreateConstantBuffer, Donut_CreateDrawIndexedIndirectBuffer, Donut_CreateDynamicVertexBuffer, Donut_CreateRWStructuredBuffer, Donut_CreateReadbackBuffer, Donut_CreateStaticGeometryBuffer, Donut_CreateStaticIndexBuffer, Donut_CreateStaticRawVertexBuffer, Donut_CreateStaticVertexBuffer, Donut_CreateStructuredBuffer, Donut_CreateUIntBuffer, Donut_CreateVolatileConstantBuffer, Donut_GetGltfMeshIndexBuffer, Donut_GetGltfMeshVertexBuffer, Donut_GetSceneBuffer

- [ ] **Step 5: Bring the `.d.ts` along**

Run: `python tools/check_interop_types.py --fix`
Expected: `check_interop_types: rewrote <N> declaration(s)` and no problem lines. `--fix` reads only the C++ text, so it runs before the C++ compiles. Any remaining problem names a declaration `--fix` doesn't handle (an override, a parameter count). Fix it by hand, then re-run without `--fix` until it prints nothing.

- [ ] **Step 6: Build the interop**

Run the build command from Global Constraints with `--target donut_interop donut_interop_shared` added after `build`.
Expected: the check passes and the C++ compiles. Fix every compiler error at its cause:
- a caller passing the wrong kind of pointer: fix the caller;
- a parameter still `void*` where a deleted helper used to convert it (signatures spread over several lines are easy to miss): type it;
- a helper still taking `void*`: type it.

After each C++ fix, re-run Step 5's `--fix`. A real mismatch between kinds goes in the commit message.

- [ ] **Step 7: Regenerate the wrappers and check that no method changed**

```bash
N='s/\b[A-Za-z0-9]+Handle\b/Opaque/g'
git show HEAD:core/donut.ts | grep -E "^export class |^    (static )?\w+\(.*\{$" | sed -E "$N" > "$TEMP/methods.before"
python tools/generate_donut_wrappers.py
grep -E "^export class |^    (static )?\w+\(.*\{$" core/donut.ts | sed -E "$N" > "$TEMP/methods.after"
diff "$TEMP/methods.before" "$TEMP/methods.after" && echo "same methods"
```

Expected: `same methods`. With handle types read as `Opaque`, every class and method signature in `core/donut.ts` is unchanged.

A difference means a typed declaration maps differently than before:
- **A method moved class or got renamed.** A type in the `.d.ts` doesn't match the generator's `CLASSES`: fix the class name (the `XxxHandle` of a wrapper `Xxx`), not the generator.
- **A parameter or return turned from a handle into a wrapper class.** The generator now maps it by its type where it used to miss it by name. Keep it: the build in Step 9 points at the callers to update.

- [ ] **Step 8: Retype the holders in TypeScript**

Run: `python tools/find_untyped_handles.py | grep -E "'(Buffer)(Handle)?( \| null)?'"`

Each line points at a field, local, parameter, array or callback typed `Opaque` that holds one of these handles. Retype its declaration:
- the handle class;
- the wrapper class, if it holds the wrapper object (Review Focus 5);
- the base class (`ResourceHandle[]`, `ObjectHandle[]`), if it holds several kinds (Review Focus 1).

Repeat until the grep prints nothing. 

- [ ] **Step 9: Build, check, smoke-run**

Run the full build (Global Constraints). Expected: success.

Run the tsc check (Global Constraints). Expected: only the TS2367 line.

Run: `pwsh -File tools/smoke_examples.ps1 -Examples compute_nbody,compute_nbody_collisions,oit_linked_lists,vertex_buffer,dynamic_uniform_buffers,multi_draw_indirect,conditional_rendering`
Expected: `smoke_examples: all passed`, apart from failures already listed in `build/smoke-baseline.txt` (Task 1 Step 13) for the same example and API.

- [ ] **Step 10: Commit**

```bash
git add core/donut_handles.d.ts core/donut_interop.d.ts core/donut.ts core/donut_globals.d.ts core/*.cpp core/input_pass.ts tools/check_interop_types.py examples/
git commit -m "Type buffer handles

No mismatches between handle kinds found.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

If Step 6 or Step 8 found a real mismatch, replace the middle paragraph with one line per mismatch: where it was and how it was fixed.

---
### Task 4: Textures, staging textures, samplers, heaps (stage 3)

**Files:**
- Modify: `core/donut_handles.d.ts`, `tools/check_interop_types.py` (`HANDLES`), the `core/*.cpp` files whose functions take or return these types, `core/donut_interop.d.ts` (via `--fix`), examples holding these handles
- Regenerate: `core/donut.ts`, `core/donut_globals.d.ts`

**Interfaces:**
- Consumes: Task 1's tools; the classes of earlier tasks (`ResourceHandle`).
- Produces: `TextureHandle`, `StagingTextureHandle`, `SamplerHandle`, `HeapHandle`; C++ functions taking and returning `nvrhi::ITexture*`, `nvrhi::IStagingTexture*`, `nvrhi::ISampler*`, `nvrhi::IHeap*`.

- [ ] **Step 1: Declare the classes and map the C++ types**

Append to `core/donut_handles.d.ts`:

```ts
declare class TextureHandle extends ResourceHandle { private readonly __texture: int; }
declare class StagingTextureHandle extends ResourceHandle { private readonly __stagingTexture: int; }
declare class SamplerHandle extends ResourceHandle { private readonly __sampler: int; }
declare class HeapHandle extends ResourceHandle { private readonly __heap: int; }
```

Add to `HANDLES` in `tools/check_interop_types.py`:

```python
    "nvrhi::ITexture": "TextureHandle",
    "nvrhi::IStagingTexture": "StagingTextureHandle",
    "nvrhi::ISampler": "SamplerHandle",
    "nvrhi::IHeap": "HeapHandle",
```

- [ ] **Step 2: Run the check to see it fail**

Run: `python tools/check_interop_types.py`
Expected: FAIL. There is one `... is used by no function` line per new class (a class only extended by another is exempt), and nothing else.

- [ ] **Step 3: Type the C++ parameters**

List the places that cast a `void*` to these types:

```bash
grep -nE "static_cast<nvrhi::ITexture ?\*>|static_cast<nvrhi::IStagingTexture ?\*>|static_cast<nvrhi::ISampler ?\*>|static_cast<nvrhi::IHeap ?\*>" core/*.cpp
```

At each hit whose argument is a `void*` parameter of an `extern "C"` function, change that parameter to the typed pointer and drop the cast or helper call. For example:

```cpp
    void Donut_BindSampler(void* bindingSetDesc, int slot, void* sampler)
    {
        static_cast<nvrhi::BindingSetDesc*>(bindingSetDesc)->addItem(
            nvrhi::BindingSetItem::Sampler(static_cast<uint32_t>(slot), static_cast<nvrhi::ISampler*>(sampler)));
    }
```

becomes

```cpp
    void Donut_BindSampler(void* bindingSetDesc, int slot, nvrhi::ISampler* sampler)
    {
        static_cast<nvrhi::BindingSetDesc*>(bindingSetDesc)->addItem(
            nvrhi::BindingSetItem::Sampler(static_cast<uint32_t>(slot), sampler));
    }
```

Then delete these helpers: none. Re-run the grep: what's left is a cast of something other than a parameter (a local, a member). Leave those.

Some of these getters take an object handle of a later family (`Donut_GetCubemapColorTexture(void* cubemapTarget)`, ...). Only their return type changes now; the object parameter stays `void*` until its own task.

- [ ] **Step 4: Type the C++ returns**

Change the `void*` return type of these functions:

- `nvrhi::ITexture*`: Donut_AcquireAsyncComputeTexture, Donut_CreateComputeReadableRenderTarget, Donut_CreateComputeTexture, Donut_CreateDepthTexture, Donut_CreateMipmappedRenderTarget, Donut_CreateMultisampledTexture, Donut_CreatePlacedTexture, Donut_CreateRenderTargetTexture, Donut_CreateRenderTargetUAVTexture, Donut_CreateShadingRateSurface, Donut_CreateTextureWithLevels, Donut_CreateTiledTexture, Donut_CreateTypelessRenderTargetTexture, Donut_CreateUAVTexture, Donut_CreateUAVTextureArray, Donut_CreateUAVTextureForFrame, Donut_CreateUAVTextureForFrameCopy, Donut_CreateUAVTextureForFrameWithFormat, Donut_CreateUAVTextureWithFormat, Donut_GetBackBuffer, Donut_GetCubemapColorTexture, Donut_GetGBufferShadedColor, Donut_GetGBufferTexture, Donut_GetSceneRenderTargetsTexture, Donut_GetShadowMapTexture, Donut_GetSharedTexture, Donut_GetTemporalTargetsTexture, Donut_LoadTexture
- `nvrhi::ISampler*`: Donut_CreateBorderSampler, Donut_CreateComparisonSampler, Donut_CreateSampler, Donut_CreateSamplerWithDesc, Donut_GetCommonSampler
- `nvrhi::IHeap*`: Donut_CreateTileHeap
- `nvrhi::IStagingTexture*`: Donut_LoadStagingTexture

- [ ] **Step 5: Bring the `.d.ts` along**

Run: `python tools/check_interop_types.py --fix`
Expected: `check_interop_types: rewrote <N> declaration(s)` and no problem lines. `--fix` reads only the C++ text, so it runs before the C++ compiles. Any remaining problem names a declaration `--fix` doesn't handle (an override, a parameter count). Fix it by hand, then re-run without `--fix` until it prints nothing.

- [ ] **Step 6: Build the interop**

Run the build command from Global Constraints with `--target donut_interop donut_interop_shared` added after `build`.
Expected: the check passes and the C++ compiles. Fix every compiler error at its cause:
- a caller passing the wrong kind of pointer: fix the caller;
- a parameter still `void*` where a deleted helper used to convert it (signatures spread over several lines are easy to miss): type it;
- a helper still taking `void*`: type it.

After each C++ fix, re-run Step 5's `--fix`. A real mismatch between kinds goes in the commit message.

- [ ] **Step 7: Regenerate the wrappers and check that no method changed**

```bash
N='s/\b[A-Za-z0-9]+Handle\b/Opaque/g'
git show HEAD:core/donut.ts | grep -E "^export class |^    (static )?\w+\(.*\{$" | sed -E "$N" > "$TEMP/methods.before"
python tools/generate_donut_wrappers.py
grep -E "^export class |^    (static )?\w+\(.*\{$" core/donut.ts | sed -E "$N" > "$TEMP/methods.after"
diff "$TEMP/methods.before" "$TEMP/methods.after" && echo "same methods"
```

Expected: `same methods`. With handle types read as `Opaque`, every class and method signature in `core/donut.ts` is unchanged.

A difference means a typed declaration maps differently than before:
- **A method moved class or got renamed.** A type in the `.d.ts` doesn't match the generator's `CLASSES`: fix the class name (the `XxxHandle` of a wrapper `Xxx`), not the generator.
- **A parameter or return turned from a handle into a wrapper class.** The generator now maps it by its type where it used to miss it by name. Keep it: the build in Step 9 points at the callers to update.

- [ ] **Step 8: Retype the holders in TypeScript**

Run: `python tools/find_untyped_handles.py | grep -E "'(Texture|StagingTexture|Sampler|Heap)(Handle)?( \| null)?'"`

Each line points at a field, local, parameter, array or callback typed `Opaque` that holds one of these handles. Retype its declaration:
- the handle class;
- the wrapper class, if it holds the wrapper object (Review Focus 5);
- the base class (`ResourceHandle[]`, `ObjectHandle[]`), if it holds several kinds (Review Focus 1).

Repeat until the grep prints nothing. 

- [ ] **Step 9: Build, check, smoke-run**

Run the full build (Global Constraints). Expected: success.

Run the tsc check (Global Constraints). Expected: only the TS2367 line.

Run: `pwsh -File tools/smoke_examples.ps1 -Examples texture_loading,texture_mipmap_generation,sparse_image,msaa,hdr,separate_image_sampler,fragment_shading_rate,small_resources`
Expected: `smoke_examples: all passed`, apart from failures already listed in `build/smoke-baseline.txt` (Task 1 Step 13) for the same example and API.

- [ ] **Step 10: Commit**

```bash
git add core/donut_handles.d.ts core/donut_interop.d.ts core/donut.ts core/donut_globals.d.ts core/*.cpp core/input_pass.ts tools/check_interop_types.py examples/
git commit -m "Type texture, staging texture, sampler and heap handles

No mismatches between handle kinds found.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

If Step 6 or Step 8 found a real mismatch, replace the middle paragraph with one line per mismatch: where it was and how it was fixed.

---
### Task 5: Shaders, shader libraries, input layouts (stage 4)

**Files:**
- Modify: `core/donut_handles.d.ts`, `tools/check_interop_types.py` (`HANDLES`), the `core/*.cpp` files whose functions take or return these types, `core/donut_interop.d.ts` (via `--fix`), examples holding these handles
- Regenerate: `core/donut.ts`, `core/donut_globals.d.ts`

**Interfaces:**
- Consumes: Task 1's tools; the classes of earlier tasks (`ResourceHandle`).
- Produces: `ShaderHandle`, `ShaderLibraryHandle`, `InputLayoutHandle`, `InputLayoutDescHandle`; C++ functions taking and returning `nvrhi::IShader*`, `nvrhi::IShaderLibrary*`, `nvrhi::IInputLayout*`, `InputLayoutDesc*`.

- [ ] **Step 1: Declare the classes and map the C++ types**

Append to `core/donut_handles.d.ts`:

```ts
declare class ShaderHandle extends ResourceHandle { private readonly __shader: int; }
declare class ShaderLibraryHandle extends ResourceHandle { private readonly __shaderLibrary: int; }
declare class InputLayoutHandle extends ResourceHandle { private readonly __inputLayout: int; }
declare class InputLayoutDescHandle { private readonly __inputLayoutDesc: int; }
```

Add to `HANDLES` in `tools/check_interop_types.py`:

```python
    "nvrhi::IShader": "ShaderHandle",
    "nvrhi::IShaderLibrary": "ShaderLibraryHandle",
    "nvrhi::IInputLayout": "InputLayoutHandle",
    "InputLayoutDesc": "InputLayoutDescHandle",
```

- [ ] **Step 2: Run the check to see it fail**

Run: `python tools/check_interop_types.py`
Expected: FAIL. There is one `... is used by no function` line per new class (a class only extended by another is exempt), and nothing else.

- [ ] **Step 3: Type the C++ parameters**

List the places that cast a `void*` to these types:

```bash
grep -nE "static_cast<nvrhi::IShader ?\*>|static_cast<nvrhi::IShaderLibrary ?\*>|static_cast<nvrhi::IInputLayout ?\*>|static_cast<std::vector<nvrhi::VertexAttributeDesc> ?\*>" core/*.cpp
```

At each hit whose argument is a `void*` parameter of an `extern "C"` function, change that parameter to the typed pointer and drop the cast or helper call. For example:

```cpp
    void* Donut_SpecializeShaderFloat(void* app, void* shader, int constantId, double value)
    {
        ...
        nvrhi::ShaderHandle specialized = a->device()->createShaderSpecialization(
            static_cast<nvrhi::IShader*>(shader), &constant, 1);
```

becomes

```cpp
    nvrhi::IShader* Donut_SpecializeShaderFloat(App* app, nvrhi::IShader* shader, int constantId, double value)
    {
        ...
        nvrhi::ShaderHandle specialized = a->device()->createShaderSpecialization(
            shader, &constant, 1);
```

Then delete these helpers: none. Re-run the grep: what's left is a cast of something other than a parameter (a local, a member). Leave those.

Write the input layout description's type as the alias `InputLayoutDesc*` from Task 1, not `std::vector<nvrhi::VertexAttributeDesc>*`. The table knows it by that name.

- [ ] **Step 4: Type the C++ returns**

Change the `void*` return type of these functions:

- `nvrhi::IShader*`: Donut_CreateShader, Donut_CreateShaderWithDefine, Donut_SpecializeShaderFloat, Donut_SpecializeShaderUInt
- `nvrhi::IShaderLibrary*`: Donut_CreateShaderLibrary, Donut_CreateShaderLibraryWithDefine
- `nvrhi::IInputLayout*`: Donut_CreateInputLayout
- `InputLayoutDesc*`: Donut_CreateInputLayoutDesc

- [ ] **Step 5: Bring the `.d.ts` along**

Run: `python tools/check_interop_types.py --fix`
Expected: `check_interop_types: rewrote <N> declaration(s)` and no problem lines. `--fix` reads only the C++ text, so it runs before the C++ compiles. Any remaining problem names a declaration `--fix` doesn't handle (an override, a parameter count). Fix it by hand, then re-run without `--fix` until it prints nothing.

- [ ] **Step 6: Build the interop**

Run the build command from Global Constraints with `--target donut_interop donut_interop_shared` added after `build`.
Expected: the check passes and the C++ compiles. Fix every compiler error at its cause:
- a caller passing the wrong kind of pointer: fix the caller;
- a parameter still `void*` where a deleted helper used to convert it (signatures spread over several lines are easy to miss): type it;
- a helper still taking `void*`: type it.

After each C++ fix, re-run Step 5's `--fix`. A real mismatch between kinds goes in the commit message.

- [ ] **Step 7: Regenerate the wrappers and check that no method changed**

```bash
N='s/\b[A-Za-z0-9]+Handle\b/Opaque/g'
git show HEAD:core/donut.ts | grep -E "^export class |^    (static )?\w+\(.*\{$" | sed -E "$N" > "$TEMP/methods.before"
python tools/generate_donut_wrappers.py
grep -E "^export class |^    (static )?\w+\(.*\{$" core/donut.ts | sed -E "$N" > "$TEMP/methods.after"
diff "$TEMP/methods.before" "$TEMP/methods.after" && echo "same methods"
```

Expected: `same methods`. With handle types read as `Opaque`, every class and method signature in `core/donut.ts` is unchanged.

A difference means a typed declaration maps differently than before:
- **A method moved class or got renamed.** A type in the `.d.ts` doesn't match the generator's `CLASSES`: fix the class name (the `XxxHandle` of a wrapper `Xxx`), not the generator.
- **A parameter or return turned from a handle into a wrapper class.** The generator now maps it by its type where it used to miss it by name. Keep it: the build in Step 9 points at the callers to update.

- [ ] **Step 8: Retype the holders in TypeScript**

Run: `python tools/find_untyped_handles.py | grep -E "'(Shader|ShaderLibrary|InputLayout|InputLayoutDesc)(Handle)?( \| null)?'"`

Each line points at a field, local, parameter, array or callback typed `Opaque` that holds one of these handles. Retype its declaration:
- the handle class;
- the wrapper class, if it holds the wrapper object (Review Focus 5);
- the base class (`ResourceHandle[]`, `ObjectHandle[]`), if it holds several kinds (Review Focus 1).

Repeat until the grep prints nothing. 

- [ ] **Step 9: Build, check, smoke-run**

Run the full build (Global Constraints). Expected: success.

Run the tsc check (Global Constraints). Expected: only the TS2367 line.

Run: `pwsh -File tools/smoke_examples.ps1 -Examples shader_specializations,instancing,vertex_buffer,ray_tracing_reflection,gshader_to_mshader,terrain_tessellation`
Expected: `smoke_examples: all passed`, apart from failures already listed in `build/smoke-baseline.txt` (Task 1 Step 13) for the same example and API.

- [ ] **Step 10: Commit**

```bash
git add core/donut_handles.d.ts core/donut_interop.d.ts core/donut.ts core/donut_globals.d.ts core/*.cpp core/input_pass.ts tools/check_interop_types.py examples/
git commit -m "Type shader, shader library and input layout handles

No mismatches between handle kinds found.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

If Step 6 or Step 8 found a real mismatch, replace the middle paragraph with one line per mismatch: where it was and how it was fixed.

---
### Task 6: Binding layouts, binding sets, descriptor tables and their descs (stage 5)

**Files:**
- Modify: `core/donut_handles.d.ts`, `tools/check_interop_types.py` (`HANDLES`), the `core/*.cpp` files whose functions take or return these types, `core/donut_interop.d.ts` (via `--fix`), examples holding these handles
- Regenerate: `core/donut.ts`, `core/donut_globals.d.ts`

**Interfaces:**
- Consumes: Task 1's tools; the classes of earlier tasks (`ResourceHandle`).
- Produces: `BindingLayoutHandle`, `BindingSetHandle`, `DescriptorTableHandle`, `BindingSetDescHandle`, `BindingLayoutDescHandle`, `BindlessLayoutDescHandle`, `ObjectHandle`, `DescriptorTableManagerHandle`; C++ functions taking and returning `nvrhi::IBindingLayout*`, `nvrhi::IBindingSet*`, `nvrhi::IDescriptorTable*`, `nvrhi::BindingSetDesc*`, `nvrhi::BindingLayoutDesc*`, `nvrhi::BindlessLayoutDesc*`, `donut::engine::DescriptorTableManager*`.

- [ ] **Step 1: Declare the classes and map the C++ types**

Append to `core/donut_handles.d.ts`:

```ts
declare class BindingLayoutHandle extends ResourceHandle { private readonly __bindingLayout: int; }
declare class BindingSetHandle extends ResourceHandle { private readonly __bindingSet: int; }
declare class DescriptorTableHandle extends BindingSetHandle { private readonly __descriptorTable: int; }
declare class BindingSetDescHandle { private readonly __bindingSetDesc: int; }
declare class BindingLayoutDescHandle { private readonly __bindingLayoutDesc: int; }
declare class BindlessLayoutDescHandle { private readonly __bindlessLayoutDesc: int; }
declare class ObjectHandle { private readonly __object: int; }
declare class DescriptorTableManagerHandle extends ObjectHandle { private readonly __descriptorTableManager: int; }
```

Add to `HANDLES` in `tools/check_interop_types.py`:

```python
    "nvrhi::IBindingLayout": "BindingLayoutHandle",
    "nvrhi::IBindingSet": "BindingSetHandle",
    "nvrhi::IDescriptorTable": "DescriptorTableHandle",
    "nvrhi::BindingSetDesc": "BindingSetDescHandle",
    "nvrhi::BindingLayoutDesc": "BindingLayoutDescHandle",
    "nvrhi::BindlessLayoutDesc": "BindlessLayoutDescHandle",
    "donut::engine::DescriptorTableManager": "DescriptorTableManagerHandle",
```

- [ ] **Step 2: Run the check to see it fail**

Run: `python tools/check_interop_types.py`
Expected: FAIL. There is one `... is used by no function` line per new class (a class only extended by another is exempt), and nothing else.

- [ ] **Step 3: Type the C++ parameters**

List the places that cast a `void*` to these types:

```bash
grep -nE "static_cast<nvrhi::IBindingLayout ?\*>|static_cast<nvrhi::IBindingSet ?\*>|static_cast<nvrhi::IDescriptorTable ?\*>|static_cast<nvrhi::BindingSetDesc ?\*>|static_cast<nvrhi::BindingLayoutDesc ?\*>|static_cast<nvrhi::BindlessLayoutDesc ?\*>|static_cast<donut::engine::DescriptorTableManager ?\*>" core/*.cpp
```

At each hit whose argument is a `void*` parameter of an `extern "C"` function, change that parameter to the typed pointer and drop the cast or helper call. For example:

```cpp
    void* Donut_GetBindingLayout(void* bindingSet)
    {
        return static_cast<nvrhi::IBindingSet*>(bindingSet)->getLayout();
    }
```

becomes

```cpp
    nvrhi::IBindingLayout* Donut_GetBindingLayout(nvrhi::IBindingSet* bindingSet)
    {
        return bindingSet->getLayout();
    }
```

Then delete these helpers: none. Re-run the grep: what's left is a cast of something other than a parameter (a local, a member). Leave those.

Also:
- `ObjectHandle` arrives here as the base of `DescriptorTableManagerHandle`. Type `Donut_ReleaseObject`'s `object` in the `.d.ts` as `ObjectHandle`; the C++ keeps `void*`. Add to `OVERRIDES` in `tools/check_interop_types.py`:
  ```python
      ("Donut_ReleaseObject", "object"): ("void*", "ObjectHandle"),
  ```
  `--fix` doesn't rewrite overrides, so edit that one declaration by hand.
- Parameters that reach a descriptor table manager through `a->SharedObject<...>(descriptorTableManager)` (`Donut_LoadSceneWithDescriptorTable`, `Donut_LoadBindlessTexture`, `Donut_CreateDynamicMesh`) are typed `donut::engine::DescriptorTableManager*` too: `SharedObject` takes `void*`, which the typed pointer converts to.

- [ ] **Step 4: Type the C++ returns**

Change the `void*` return type of these functions:

- `nvrhi::IBindingLayout*`: Donut_CreateBindingLayout, Donut_CreateBindlessLayout, Donut_GetBindingLayout
- `nvrhi::BindingLayoutDesc*`: Donut_CreateBindingLayoutDesc
- `nvrhi::IBindingSet*`: Donut_CreateBindingSet, Donut_CreateBindingSetForLayout, Donut_GetCachedBindingSet
- `nvrhi::BindingSetDesc*`: Donut_CreateBindingSetDesc
- `nvrhi::BindlessLayoutDesc*`: Donut_CreateBindlessLayoutDesc
- `nvrhi::IDescriptorTable*`: Donut_CreateDescriptorTable, Donut_GetDescriptorTable
- `donut::engine::DescriptorTableManager*`: Donut_CreateDescriptorTableManager

- [ ] **Step 5: Bring the `.d.ts` along**

Run: `python tools/check_interop_types.py --fix`
Expected: `check_interop_types: rewrote <N> declaration(s)` and no problem lines. `--fix` reads only the C++ text, so it runs before the C++ compiles. Any remaining problem names a declaration `--fix` doesn't handle (an override, a parameter count). Fix it by hand, then re-run without `--fix` until it prints nothing.

- [ ] **Step 6: Build the interop**

Run the build command from Global Constraints with `--target donut_interop donut_interop_shared` added after `build`.
Expected: the check passes and the C++ compiles. Fix every compiler error at its cause:
- a caller passing the wrong kind of pointer: fix the caller;
- a parameter still `void*` where a deleted helper used to convert it (signatures spread over several lines are easy to miss): type it;
- a helper still taking `void*`: type it.

After each C++ fix, re-run Step 5's `--fix`. A real mismatch between kinds goes in the commit message.

- [ ] **Step 7: Regenerate the wrappers and check that no method changed**

```bash
N='s/\b[A-Za-z0-9]+Handle\b/Opaque/g'
git show HEAD:core/donut.ts | grep -E "^export class |^    (static )?\w+\(.*\{$" | sed -E "$N" > "$TEMP/methods.before"
python tools/generate_donut_wrappers.py
grep -E "^export class |^    (static )?\w+\(.*\{$" core/donut.ts | sed -E "$N" > "$TEMP/methods.after"
diff "$TEMP/methods.before" "$TEMP/methods.after" && echo "same methods"
```

Expected: `same methods`. With handle types read as `Opaque`, every class and method signature in `core/donut.ts` is unchanged.

A difference means a typed declaration maps differently than before:
- **A method moved class or got renamed.** A type in the `.d.ts` doesn't match the generator's `CLASSES`: fix the class name (the `XxxHandle` of a wrapper `Xxx`), not the generator.
- **A parameter or return turned from a handle into a wrapper class.** The generator now maps it by its type where it used to miss it by name. Keep it: the build in Step 9 points at the callers to update.

- [ ] **Step 8: Retype the holders in TypeScript**

Run: `python tools/find_untyped_handles.py | grep -E "'(BindingLayout|BindingSet|DescriptorTable|BindingSetDesc|BindingLayoutDesc|BindlessLayoutDesc|Object|DescriptorTableManager)(Handle)?( \| null)?'"`

Each line points at a field, local, parameter, array or callback typed `Opaque` that holds one of these handles. Retype its declaration:
- the handle class;
- the wrapper class, if it holds the wrapper object (Review Focus 5);
- the base class (`ResourceHandle[]`, `ObjectHandle[]`), if it holds several kinds (Review Focus 1).

Repeat until the grep prints nothing. Also (Review Focus 5): `examples/mobile_nerf_rayquery.ts:797` and `examples/ray_queries.ts:500` store a `BindingSet` *wrapper* in an `Opaque` field. Type those fields `BindingSet`, not `BindingSetHandle`, and check that each use of the field expects the wrapper.

- [ ] **Step 9: Build, check, smoke-run**

Run the full build (Global Constraints). Expected: success.

Run the tsc check (Global Constraints). Expected: only the TS2367 line.

Run: `pwsh -File tools/smoke_examples.ps1 -Examples descriptor_indexing,bindless_rendering,rt_bindless,mobile_nerf_rayquery,ray_queries,compute_nbody,dynamic_uniform_buffers`
Expected: `smoke_examples: all passed`, apart from failures already listed in `build/smoke-baseline.txt` (Task 1 Step 13) for the same example and API.

- [ ] **Step 10: Commit**

```bash
git add core/donut_handles.d.ts core/donut_interop.d.ts core/donut.ts core/donut_globals.d.ts core/*.cpp core/input_pass.ts tools/check_interop_types.py examples/
git commit -m "Type binding layout, binding set and descriptor table handles

No mismatches between handle kinds found.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

If Step 6 or Step 8 found a real mismatch, replace the middle paragraph with one line per mismatch: where it was and how it was fixed.

---
### Task 7: Framebuffers, framebuffer factories, pipelines and their descs (stage 6)

**Files:**
- Modify: `core/donut_handles.d.ts`, `tools/check_interop_types.py` (`HANDLES`), the `core/*.cpp` files whose functions take or return these types, `core/donut_interop.d.ts` (via `--fix`), examples holding these handles
- Regenerate: `core/donut.ts`, `core/donut_globals.d.ts`

**Interfaces:**
- Consumes: Task 1's tools; the classes of earlier tasks (`ResourceHandle`, `ObjectHandle`).
- Produces: `FramebufferHandle`, `FramebufferFactoryHandle`, `GraphicsPipelineHandle`, `ComputePipelineHandle`, `MeshletPipelineHandle`, `GraphicsPipelineDescHandle`; C++ functions taking and returning `nvrhi::IFramebuffer*`, `FramebufferFactoryRef*`, `nvrhi::IGraphicsPipeline*`, `nvrhi::IComputePipeline*`, `nvrhi::IMeshletPipeline*`, `PipelineDesc*`.

- [ ] **Step 1: Declare the classes and map the C++ types**

Append to `core/donut_handles.d.ts`:

```ts
declare class FramebufferHandle extends ResourceHandle { private readonly __framebuffer: int; }
declare class FramebufferFactoryHandle { private readonly __framebufferFactory: int; }
declare class GraphicsPipelineHandle extends ResourceHandle { private readonly __graphicsPipeline: int; }
declare class ComputePipelineHandle extends ResourceHandle { private readonly __computePipeline: int; }
declare class MeshletPipelineHandle extends ResourceHandle { private readonly __meshletPipeline: int; }
declare class GraphicsPipelineDescHandle { private readonly __graphicsPipelineDesc: int; }
```

Add to `HANDLES` in `tools/check_interop_types.py`:

```python
    "nvrhi::IFramebuffer": "FramebufferHandle",
    "FramebufferFactoryRef": "FramebufferFactoryHandle",
    "nvrhi::IGraphicsPipeline": "GraphicsPipelineHandle",
    "nvrhi::IComputePipeline": "ComputePipelineHandle",
    "nvrhi::IMeshletPipeline": "MeshletPipelineHandle",
    "PipelineDesc": "GraphicsPipelineDescHandle",
```

- [ ] **Step 2: Run the check to see it fail**

Run: `python tools/check_interop_types.py`
Expected: FAIL. There is one `... is used by no function` line per new class (a class only extended by another is exempt), and nothing else.

- [ ] **Step 3: Type the C++ parameters**

List the places that cast a `void*` to these types:

```bash
grep -nE "AsFramebufferFactory\(|static_cast<nvrhi::IFramebuffer ?\*>|static_cast<nvrhi::IGraphicsPipeline ?\*>|static_cast<nvrhi::IComputePipeline ?\*>|static_cast<nvrhi::IMeshletPipeline ?\*>|static_cast<PipelineDesc ?\*>" core/*.cpp
```

At each hit whose argument is a `void*` parameter of an `extern "C"` function, change that parameter to the typed pointer and drop the cast or helper call. For example:

```cpp
    void Donut_DispatchMesh(void* frame, void* meshletPipeline, int groupsX)
    {
        FrameContext* ctx = AsFrame(frame);

        nvrhi::MeshletState state;
        state.pipeline = static_cast<nvrhi::IMeshletPipeline*>(meshletPipeline);
```

becomes

```cpp
    void Donut_DispatchMesh(FrameContext* frame, nvrhi::IMeshletPipeline* meshletPipeline, int groupsX)
    {
        FrameContext* ctx = frame;

        nvrhi::MeshletState state;
        state.pipeline = meshletPipeline;
```

Then delete these helpers: `AsFramebufferFactory`. Re-run the grep: what's left is a cast of something other than a parameter (a local, a member). Leave those.

Framebuffer *factories* are the other kind of framebuffer handle, `std::shared_ptr<donut::engine::FramebufferFactory>*`:
- Parameters that went through `AsFramebufferFactory(framebuffer)` become `FramebufferFactoryRef* framebuffer`, and `AsFramebufferFactory(framebuffer)` becomes `*framebuffer`.
- `Donut_GetSceneRenderTargetsFramebuffer` and `Donut_GetLightProbeCaptureFramebuffer` return `FramebufferFactoryRef*`.

Where a function now takes an `nvrhi::IFramebuffer*` and an example passed a factory (or the reverse), the compiler won't see it, but the finder will. Such a call was a latent bug: fix the example and note it in the commit message.

- [ ] **Step 4: Type the C++ returns**

Change the `void*` return type of these functions:

- `nvrhi::IComputePipeline*`: Donut_CreateComputePipeline, Donut_CreateComputePipelineWithLayout, Donut_CreateComputePipelineWithLayouts
- `nvrhi::IFramebuffer*`: Donut_CreateDepthFramebuffer, Donut_CreateFramebuffer, Donut_CreateFramebufferForMip, Donut_CreateFramebufferWithColorFormat, Donut_CreateFramebufferWithShadingRate, Donut_CreateFramebufferWithThreeTargets, Donut_CreateFramebufferWithTwoTargets, Donut_CreateResolveFramebuffer
- `nvrhi::IGraphicsPipeline*`: Donut_CreateGraphicsPipeline, Donut_CreateGraphicsPipelineForFramebuffer, Donut_CreateGraphicsPipelineFromDesc, Donut_CreateGraphicsPipelineFromDescForFrame, Donut_CreateGraphicsPipelineWithBlend, Donut_CreateGraphicsPipelineWithLayouts, Donut_CreateGraphicsPipelineWithTopology
- `PipelineDesc*`: Donut_CreateGraphicsPipelineDesc, Donut_CreateMeshletPipelineDesc
- `nvrhi::IMeshletPipeline*`: Donut_CreateMeshletPipeline, Donut_CreateMeshletPipelineFromDesc, Donut_CreateMeshletPipelineFromDescForFrame
- `FramebufferFactoryRef*`: Donut_GetLightProbeCaptureFramebuffer, Donut_GetSceneRenderTargetsFramebuffer

- [ ] **Step 5: Bring the `.d.ts` along**

Run: `python tools/check_interop_types.py --fix`
Expected: `check_interop_types: rewrote <N> declaration(s)` and no problem lines. `--fix` reads only the C++ text, so it runs before the C++ compiles. Any remaining problem names a declaration `--fix` doesn't handle (an override, a parameter count). Fix it by hand, then re-run without `--fix` until it prints nothing.

- [ ] **Step 6: Build the interop**

Run the build command from Global Constraints with `--target donut_interop donut_interop_shared` added after `build`.
Expected: the check passes and the C++ compiles. Fix every compiler error at its cause:
- a caller passing the wrong kind of pointer: fix the caller;
- a parameter still `void*` where a deleted helper used to convert it (signatures spread over several lines are easy to miss): type it;
- a helper still taking `void*`: type it.

After each C++ fix, re-run Step 5's `--fix`. A real mismatch between kinds goes in the commit message.

- [ ] **Step 7: Regenerate the wrappers and check that no method changed**

```bash
N='s/\b[A-Za-z0-9]+Handle\b/Opaque/g'
git show HEAD:core/donut.ts | grep -E "^export class |^    (static )?\w+\(.*\{$" | sed -E "$N" > "$TEMP/methods.before"
python tools/generate_donut_wrappers.py
grep -E "^export class |^    (static )?\w+\(.*\{$" core/donut.ts | sed -E "$N" > "$TEMP/methods.after"
diff "$TEMP/methods.before" "$TEMP/methods.after" && echo "same methods"
```

Expected: `same methods`. With handle types read as `Opaque`, every class and method signature in `core/donut.ts` is unchanged.

A difference means a typed declaration maps differently than before:
- **A method moved class or got renamed.** A type in the `.d.ts` doesn't match the generator's `CLASSES`: fix the class name (the `XxxHandle` of a wrapper `Xxx`), not the generator.
- **A parameter or return turned from a handle into a wrapper class.** The generator now maps it by its type where it used to miss it by name. Keep it: the build in Step 9 points at the callers to update.

- [ ] **Step 8: Retype the holders in TypeScript**

Run: `python tools/find_untyped_handles.py | grep -E "'(Framebuffer|FramebufferFactory|GraphicsPipeline|ComputePipeline|MeshletPipeline|GraphicsPipelineDesc)(Handle)?( \| null)?'"`

Each line points at a field, local, parameter, array or callback typed `Opaque` that holds one of these handles. Retype its declaration:
- the handle class;
- the wrapper class, if it holds the wrapper object (Review Focus 5);
- the base class (`ResourceHandle[]`, `ObjectHandle[]`), if it holds several kinds (Review Focus 1).

Repeat until the grep prints nothing. 

- [ ] **Step 9: Build, check, smoke-run**

Run the full build (Global Constraints). Expected: success.

Run the tsc check (Global Constraints). Expected: only the TS2367 line.

Run: `pwsh -File tools/smoke_examples.ps1 -Examples basic_triangle,meshlets,mesh_shading,graphics_pipeline_library,dynamic_rendering,deferred_shading,feature_demo,environment_map`
Expected: `smoke_examples: all passed`, apart from failures already listed in `build/smoke-baseline.txt` (Task 1 Step 13) for the same example and API.

- [ ] **Step 10: Commit**

```bash
git add core/donut_handles.d.ts core/donut_interop.d.ts core/donut.ts core/donut_globals.d.ts core/*.cpp core/input_pass.ts tools/check_interop_types.py examples/
git commit -m "Type framebuffer, framebuffer factory and pipeline handles

No mismatches between handle kinds found.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

If Step 6 or Step 8 found a real mismatch, replace the middle paragraph with one line per mismatch: where it was and how it was fixed.

---
### Task 8: Ray tracing (stage 7)

**Files:**
- Modify: `core/donut_handles.d.ts`, `tools/check_interop_types.py` (`HANDLES`), the `core/*.cpp` files whose functions take or return these types, `core/donut_interop.d.ts` (via `--fix`), examples holding these handles
- Regenerate: `core/donut.ts`, `core/donut_globals.d.ts`

**Interfaces:**
- Consumes: Task 1's tools; the classes of earlier tasks (`ResourceHandle`, `ObjectHandle`).
- Produces: `AccelStructHandle`, `OpacityMicromapHandle`, `ShaderTableHandle`, `RtPipelineHandle`, `RtPipelineDescHandle`, `TriangleBlasHandle`, `SceneAccelStructsHandle`; C++ functions taking and returning `nvrhi::rt::IAccelStruct*`, `nvrhi::rt::IOpacityMicromap*`, `nvrhi::rt::IShaderTable*`, `nvrhi::rt::IPipeline*`, `nvrhi::rt::PipelineDesc*`, `TriangleBlas*`, `SceneAccelStructs*`.

- [ ] **Step 1: Declare the classes and map the C++ types**

Append to `core/donut_handles.d.ts`:

```ts
declare class AccelStructHandle extends ResourceHandle { private readonly __accelStruct: int; }
declare class OpacityMicromapHandle extends ResourceHandle { private readonly __opacityMicromap: int; }
declare class ShaderTableHandle extends ResourceHandle { private readonly __shaderTable: int; }
declare class RtPipelineHandle extends ResourceHandle { private readonly __rtPipeline: int; }
declare class RtPipelineDescHandle { private readonly __rtPipelineDesc: int; }
declare class TriangleBlasHandle extends ObjectHandle { private readonly __triangleBlas: int; }
declare class SceneAccelStructsHandle extends ObjectHandle { private readonly __sceneAccelStructs: int; }
```

Add to `HANDLES` in `tools/check_interop_types.py`:

```python
    "nvrhi::rt::IAccelStruct": "AccelStructHandle",
    "nvrhi::rt::IOpacityMicromap": "OpacityMicromapHandle",
    "nvrhi::rt::IShaderTable": "ShaderTableHandle",
    "nvrhi::rt::IPipeline": "RtPipelineHandle",
    "nvrhi::rt::PipelineDesc": "RtPipelineDescHandle",
    "TriangleBlas": "TriangleBlasHandle",
    "SceneAccelStructs": "SceneAccelStructsHandle",
```

- [ ] **Step 2: Run the check to see it fail**

Run: `python tools/check_interop_types.py`
Expected: FAIL. There is one `... is used by no function` line per new class (a class only extended by another is exempt), and nothing else.

- [ ] **Step 3: Type the C++ parameters**

List the places that cast a `void*` to these types:

```bash
grep -nE "static_cast<nvrhi::rt::IAccelStruct ?\*>|static_cast<nvrhi::rt::IOpacityMicromap ?\*>|static_cast<nvrhi::rt::IShaderTable ?\*>|static_cast<nvrhi::rt::IPipeline ?\*>|static_cast<nvrhi::rt::PipelineDesc ?\*>|static_cast<TriangleBlas ?\*>|static_cast<SceneAccelStructs ?\*>" core/*.cpp
```

At each hit whose argument is a `void*` parameter of an `extern "C"` function, change that parameter to the typed pointer and drop the cast or helper call. For example:

```cpp
    void Donut_BindAccelStruct(void* bindingSetDesc, int slot, void* accelStruct)
    {
        static_cast<nvrhi::BindingSetDesc*>(bindingSetDesc)->addItem(
            nvrhi::BindingSetItem::RayTracingAccelStruct(static_cast<uint32_t>(slot),
                static_cast<nvrhi::rt::IAccelStruct*>(accelStruct)));
    }
```

becomes

```cpp
    void Donut_BindAccelStruct(nvrhi::BindingSetDesc* bindingSetDesc, int slot, nvrhi::rt::IAccelStruct* accelStruct)
    {
        bindingSetDesc->addItem(
            nvrhi::BindingSetItem::RayTracingAccelStruct(static_cast<uint32_t>(slot), accelStruct));
    }
```

Then delete these helpers: none. Re-run the grep: what's left is a cast of something other than a parameter (a local, a member). Leave those.

`Donut_AddTopLevelASInstanceWithHitGroup`'s `bottomLevelAS` isn't cast in its body (it's passed on). It is an `nvrhi::rt::IAccelStruct*` like the other `bottomLevelAS` parameters.

- [ ] **Step 4: Type the C++ returns**

Change the `void*` return type of these functions:

- `SceneAccelStructs*`: Donut_BuildSceneAccelStructs, Donut_BuildSceneAccelStructsWithHitGroupStride, Donut_CreateAnimatedSceneAccelStructs, Donut_CreateTopLevelAS, Donut_CreateTopLevelASWithFlags
- `nvrhi::rt::IAccelStruct*`: Donut_BuildSingleInstanceTLAS, Donut_BuildTriangleBLAS, Donut_CreateUnitAABBBlas, Donut_GetSceneTopLevelAS, Donut_GetTriangleBlasAccelStruct
- `nvrhi::rt::IShaderTable*`: Donut_CreateCachedShaderTable, Donut_CreateEmptyShaderTable, Donut_CreateShaderTable
- `TriangleBlas*`: Donut_CreateEmptyTriangleBlas, Donut_CreateTriangleBlas
- `nvrhi::rt::IOpacityMicromap*`: Donut_CreateOpacityMicromap
- `nvrhi::rt::IPipeline*`: Donut_CreateRayTracingPipeline, Donut_CreateRayTracingPipelineFromDesc, Donut_CreateRayTracingPipelineWithLayouts
- `nvrhi::rt::PipelineDesc*`: Donut_CreateRayTracingPipelineDesc

- [ ] **Step 5: Bring the `.d.ts` along**

Run: `python tools/check_interop_types.py --fix`
Expected: `check_interop_types: rewrote <N> declaration(s)` and no problem lines. `--fix` reads only the C++ text, so it runs before the C++ compiles. Any remaining problem names a declaration `--fix` doesn't handle (an override, a parameter count). Fix it by hand, then re-run without `--fix` until it prints nothing.

- [ ] **Step 6: Build the interop**

Run the build command from Global Constraints with `--target donut_interop donut_interop_shared` added after `build`.
Expected: the check passes and the C++ compiles. Fix every compiler error at its cause:
- a caller passing the wrong kind of pointer: fix the caller;
- a parameter still `void*` where a deleted helper used to convert it (signatures spread over several lines are easy to miss): type it;
- a helper still taking `void*`: type it.

After each C++ fix, re-run Step 5's `--fix`. A real mismatch between kinds goes in the commit message.

- [ ] **Step 7: Regenerate the wrappers and check that no method changed**

```bash
N='s/\b[A-Za-z0-9]+Handle\b/Opaque/g'
git show HEAD:core/donut.ts | grep -E "^export class |^    (static )?\w+\(.*\{$" | sed -E "$N" > "$TEMP/methods.before"
python tools/generate_donut_wrappers.py
grep -E "^export class |^    (static )?\w+\(.*\{$" core/donut.ts | sed -E "$N" > "$TEMP/methods.after"
diff "$TEMP/methods.before" "$TEMP/methods.after" && echo "same methods"
```

Expected: `same methods`. With handle types read as `Opaque`, every class and method signature in `core/donut.ts` is unchanged.

A difference means a typed declaration maps differently than before:
- **A method moved class or got renamed.** A type in the `.d.ts` doesn't match the generator's `CLASSES`: fix the class name (the `XxxHandle` of a wrapper `Xxx`), not the generator.
- **A parameter or return turned from a handle into a wrapper class.** The generator now maps it by its type where it used to miss it by name. Keep it: the build in Step 9 points at the callers to update.

- [ ] **Step 8: Retype the holders in TypeScript**

Run: `python tools/find_untyped_handles.py | grep -E "'(AccelStruct|OpacityMicromap|ShaderTable|RtPipeline|RtPipelineDesc|TriangleBlas|SceneAccelStructs)(Handle)?( \| null)?'"`

Each line points at a field, local, parameter, array or callback typed `Opaque` that holds one of these handles. Retype its declaration:
- the handle class;
- the wrapper class, if it holds the wrapper object (Review Focus 5);
- the base class (`ResourceHandle[]`, `ObjectHandle[]`), if it holds several kinds (Review Focus 1).

Repeat until the grep prints nothing. 

- [ ] **Step 9: Build, check, smoke-run**

Run the full build (Global Constraints). Expected: success.

Run the tsc check (Global Constraints). Expected: only the TS2367 line.

Run: `pwsh -File tools/smoke_examples.ps1 -Examples rt_triangle,rt_shadows,rt_reflections,ray_tracing_reflection,ray_queries,opacity_micromaps,procedural_geometry,ray_tracing_position_fetch`
Expected: `smoke_examples: all passed`, apart from failures already listed in `build/smoke-baseline.txt` (Task 1 Step 13) for the same example and API.

- [ ] **Step 10: Commit**

```bash
git add core/donut_handles.d.ts core/donut_interop.d.ts core/donut.ts core/donut_globals.d.ts core/*.cpp core/input_pass.ts tools/check_interop_types.py examples/
git commit -m "Type ray tracing handles

No mismatches between handle kinds found.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

If Step 6 or Step 8 found a real mismatch, replace the middle paragraph with one line per mismatch: where it was and how it was fixed.

---
### Task 9: Scene objects, cameras and views (stage 8)

**Files:**
- Modify: `core/donut_handles.d.ts`, `tools/check_interop_types.py` (`HANDLES`), the `core/*.cpp` files whose functions take or return these types, `core/donut_interop.d.ts` (via `--fix`), examples holding these handles
- Regenerate: `core/donut.ts`, `core/donut_globals.d.ts`

**Interfaces:**
- Consumes: Task 1's tools; the classes of earlier tasks (`ResourceHandle`, `ObjectHandle`).
- Produces: `SceneHandle`, `SceneGraphHandle`, `NodeHandle`, `LightHandle`, `MaterialHandle`, `SceneCameraHandle`, `MeshHandle`, `LoadedTextureHandle`, `CameraHandle`, `ViewHandle`, `SceneLoaderHandle`, `StringListHandle`, `DynamicMeshHandle`; C++ functions taking and returning `donut::engine::Scene*`, `donut::engine::SceneGraph*`, `donut::engine::SceneGraphNode*`, `donut::engine::Light*`, `donut::engine::Material*`, `donut::engine::SceneCamera*`, `donut::engine::MeshInfo*`, `donut::engine::LoadedTexture*`, `donut::app::BaseCamera*`, `donut::engine::IView*`, `SceneLoader*`, `StringList*`, `DynamicMesh*`.

- [ ] **Step 1: Declare the classes and map the C++ types**

Append to `core/donut_handles.d.ts`:

```ts
declare class SceneHandle extends ObjectHandle { private readonly __scene: int; }
declare class SceneGraphHandle extends ObjectHandle { private readonly __sceneGraph: int; }
declare class NodeHandle { private readonly __node: int; }
declare class LightHandle { private readonly __light: int; }
declare class MaterialHandle extends ObjectHandle { private readonly __material: int; }
declare class SceneCameraHandle { private readonly __sceneCamera: int; }
declare class MeshHandle extends ObjectHandle { private readonly __mesh: int; }
declare class LoadedTextureHandle extends ObjectHandle { private readonly __loadedTexture: int; }
declare class CameraHandle extends ObjectHandle { private readonly __camera: int; }
declare class ViewHandle extends ObjectHandle { private readonly __view: int; }
declare class SceneLoaderHandle extends ObjectHandle { private readonly __sceneLoader: int; }
declare class StringListHandle extends ObjectHandle { private readonly __stringList: int; }
declare class DynamicMeshHandle extends ObjectHandle { private readonly __dynamicMesh: int; }
```

Add to `HANDLES` in `tools/check_interop_types.py`:

```python
    "donut::engine::Scene": "SceneHandle",
    "donut::engine::SceneGraph": "SceneGraphHandle",
    "donut::engine::SceneGraphNode": "NodeHandle",
    "donut::engine::Light": "LightHandle",
    "donut::engine::Material": "MaterialHandle",
    "donut::engine::SceneCamera": "SceneCameraHandle",
    "donut::engine::MeshInfo": "MeshHandle",
    "donut::engine::LoadedTexture": "LoadedTextureHandle",
    "donut::app::BaseCamera": "CameraHandle",
    "donut::engine::IView": "ViewHandle",
    "SceneLoader": "SceneLoaderHandle",
    "StringList": "StringListHandle",
    "DynamicMesh": "DynamicMeshHandle",
```

- [ ] **Step 2: Run the check to see it fail**

Run: `python tools/check_interop_types.py`
Expected: FAIL. There is one `... is used by no function` line per new class (a class only extended by another is exempt), and nothing else.

- [ ] **Step 3: Type the C++ parameters**

List the places that cast a `void*` to these types:

```bash
grep -nE "AsCamera\(|AsView\(|AsSceneGraph\(|static_cast<donut::engine::Scene ?\*>|static_cast<donut::engine::SceneGraph ?\*>|static_cast<donut::engine::SceneGraphNode ?\*>|static_cast<donut::engine::Light ?\*>|static_cast<donut::engine::Material ?\*>|static_cast<donut::engine::SceneCamera ?\*>|static_cast<donut::engine::MeshInfo ?\*>|static_cast<donut::engine::LoadedTexture ?\*>|static_cast<SceneLoader ?\*>|static_cast<std::vector<std::string> ?\*>|static_cast<DynamicMesh ?\*>" core/*.cpp
```

At each hit whose argument is a `void*` parameter of an `extern "C"` function, change that parameter to the typed pointer and drop the cast or helper call. For example:

```cpp
    void* Donut_GetRootNode(void* sceneGraph)
    {
        return static_cast<donut::engine::SceneGraph*>(sceneGraph)->GetRootNode().get();
    }
```

becomes

```cpp
    donut::engine::SceneGraphNode* Donut_GetRootNode(donut::engine::SceneGraph* sceneGraph)
    {
        return sceneGraph->GetRootNode().get();
    }
```

Then delete these helpers: `AsCamera`, `AsView`, `AsSceneGraph`. Re-run the grep: what's left is a cast of something other than a parameter (a local, a member). Leave those.

Downcasts stay downcasts (Review Focus 4):
- **Cameras.** Functions taking a camera take `donut::app::BaseCamera*`. Keep `AsThirdPersonCamera`, but change its parameter to `donut::app::BaseCamera* camera`, and have it return `static_cast<donut::app::ThirdPersonCamera*>(camera)`.
- **Views.** Functions taking a view take `donut::engine::IView*`. Where the body needs a planar or stereo view, keep its `static_cast<donut::engine::PlanarView*>(view)` / `static_cast<donut::engine::StereoPlanarView*>(view)`: a downcast from `IView*` is valid.
- **Creation.** `Donut_CreatePlanarView` / `Donut_CreateStereoView` return `donut::engine::IView*`; the `PlanarView*` from `OwnObject` converts to it implicitly.

Also:
- The file-local helper `LoadScene` returns `void*` (`core/donut_interop.cpp:1133`). Make it `donut::engine::Scene*`.
- These parameters aren't cast in their bodies but are scene objects: `Donut_BindGeometry*`'s `scene` (`donut::engine::Scene*`), `Donut_CreateMesh`'s `material` (`donut::engine::Material*`), `Donut_AddMeshNode`'s `mesh` (`donut::engine::MeshInfo*`), `Donut_SetDynamicMeshTexture`'s `loadedTexture` (`donut::engine::LoadedTexture*`).
- String lists: write `StringList*`, the alias from Task 1.

- [ ] **Step 4: Type the C++ returns**

Change the `void*` return type of these functions:

- `donut::engine::Light*`: Donut_AddDirectionalLight, Donut_GetSceneGraphLight
- `donut::engine::SceneGraphNode*`: Donut_AddMeshNode, Donut_GetMeshInstanceNode, Donut_GetRootNode
- `DynamicMesh*`: Donut_CreateDynamicMesh
- `donut::app::BaseCamera*`: Donut_CreateFirstPersonCamera, Donut_CreateThirdPersonCamera
- `donut::engine::MeshInfo*`: Donut_CreateMesh
- `donut::engine::IView*`: Donut_CreatePlanarView, Donut_CreateStereoView, Donut_GetLightProbeCaptureView, Donut_GetStereoLeftView
- `donut::engine::SceneGraph*`: Donut_CreateSceneGraph, Donut_GetSceneGraph
- `SceneLoader*`: Donut_CreateSceneLoader
- `donut::engine::Material*`: Donut_CreateTexturedMaterial, Donut_GetSceneGraphMaterial
- `StringList*`: Donut_FindScenes
- `donut::engine::Scene*`: Donut_GetLoadedScene, Donut_LoadScene, Donut_LoadSceneWithDescriptorTable
- `donut::engine::SceneCamera*`: Donut_GetSceneGraphCamera
- `donut::engine::LoadedTexture*`: Donut_LoadBindlessTexture

- [ ] **Step 5: Bring the `.d.ts` along**

Run: `python tools/check_interop_types.py --fix`
Expected: `check_interop_types: rewrote <N> declaration(s)` and no problem lines. `--fix` reads only the C++ text, so it runs before the C++ compiles. Any remaining problem names a declaration `--fix` doesn't handle (an override, a parameter count). Fix it by hand, then re-run without `--fix` until it prints nothing.

- [ ] **Step 6: Build the interop**

Run the build command from Global Constraints with `--target donut_interop donut_interop_shared` added after `build`.
Expected: the check passes and the C++ compiles. Fix every compiler error at its cause:
- a caller passing the wrong kind of pointer: fix the caller;
- a parameter still `void*` where a deleted helper used to convert it (signatures spread over several lines are easy to miss): type it;
- a helper still taking `void*`: type it.

After each C++ fix, re-run Step 5's `--fix`. A real mismatch between kinds goes in the commit message.

- [ ] **Step 7: Regenerate the wrappers and check that no method changed**

```bash
N='s/\b[A-Za-z0-9]+Handle\b/Opaque/g'
git show HEAD:core/donut.ts | grep -E "^export class |^    (static )?\w+\(.*\{$" | sed -E "$N" > "$TEMP/methods.before"
python tools/generate_donut_wrappers.py
grep -E "^export class |^    (static )?\w+\(.*\{$" core/donut.ts | sed -E "$N" > "$TEMP/methods.after"
diff "$TEMP/methods.before" "$TEMP/methods.after" && echo "same methods"
```

Expected: `same methods`. With handle types read as `Opaque`, every class and method signature in `core/donut.ts` is unchanged.

A difference means a typed declaration maps differently than before:
- **A method moved class or got renamed.** A type in the `.d.ts` doesn't match the generator's `CLASSES`: fix the class name (the `XxxHandle` of a wrapper `Xxx`), not the generator.
- **A parameter or return turned from a handle into a wrapper class.** The generator now maps it by its type where it used to miss it by name. Keep it: the build in Step 9 points at the callers to update.

- [ ] **Step 8: Retype the holders in TypeScript**

Run: `python tools/find_untyped_handles.py | grep -E "'(Scene|SceneGraph|Node|Light|Material|SceneCamera|Mesh|LoadedTexture|Camera|View|SceneLoader|StringList|DynamicMesh)(Handle)?( \| null)?'"`

Each line points at a field, local, parameter, array or callback typed `Opaque` that holds one of these handles. Retype its declaration:
- the handle class;
- the wrapper class, if it holds the wrapper object (Review Focus 5);
- the base class (`ResourceHandle[]`, `ObjectHandle[]`), if it holds several kinds (Review Focus 1).

Repeat until the grep prints nothing. Also: `examples/feature_demo.ts:785-862` pass `Opaque | null` views to `Opaque` parameters, and the finder lists them today. Narrow them (`if (viewPrevious) ...`) or pass the non-null view the call needs; never compare a `ViewHandle` with a `ViewHandle | null` (Review Focus 2).

- [ ] **Step 9: Build, check, smoke-run**

Run the full build (Global Constraints). Expected: success.

Run the tsc check (Global Constraints). Expected: only the TS2367 line.

Run: `pwsh -File tools/smoke_examples.ps1 -Examples deferred_shading,feature_demo,simple_pbr,environment_map,bindless_rendering,rt_bindless,variable_shading,async_compute_bloom,compute_nbody`
Expected: `smoke_examples: all passed`, apart from failures already listed in `build/smoke-baseline.txt` (Task 1 Step 13) for the same example and API.

- [ ] **Step 10: Commit**

```bash
git add core/donut_handles.d.ts core/donut_interop.d.ts core/donut.ts core/donut_globals.d.ts core/*.cpp core/input_pass.ts tools/check_interop_types.py examples/
git commit -m "Type scene, scene graph, camera and view handles

No mismatches between handle kinds found.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

If Step 6 or Step 8 found a real mismatch, replace the middle paragraph with one line per mismatch: where it was and how it was fixed.

---
### Task 10: Render passes and render targets (stage 9)

**Files:**
- Modify: `core/donut_handles.d.ts`, `tools/check_interop_types.py` (`HANDLES`), the `core/*.cpp` files whose functions take or return these types, `core/donut_interop.d.ts` (via `--fix`), examples holding these handles
- Regenerate: `core/donut.ts`, `core/donut_globals.d.ts`

**Interfaces:**
- Consumes: Task 1's tools; the classes of earlier tasks (`ResourceHandle`, `ObjectHandle`).
- Produces: `CubemapTargetHandle`, `GBufferTargetsHandle`, `TemporalTargetsHandle`, `SceneRenderTargetsHandle`, `ShadowMapHandle`, `LightProbeSetHandle`, `LightProbeCaptureHandle`, `ForwardShadingPassHandle`, `ForwardShadingContextHandle`, `GBufferFillPassHandle`, `DeferredLightingPassHandle`, `TemporalAntiAliasingPassHandle`, `ToneMappingPassHandle`, `DepthPassHandle`, `PixelReadbackPassHandle`, `MipMapGenPassHandle`, `MaterialIdPassHandle`, `SsaoPassHandle`, `EnvironmentMapPassHandle`, `SkyPassHandle`, `BloomPassHandle`, `LightProbeProcessingPassHandle`, `DlssHandle`; C++ functions taking and returning `CubemapTarget*`, `GBufferTargets*`, `TemporalTargets*`, `SceneRenderTargets*`, `ShadowMapTarget*`, `LightProbeSet*`, `LightProbeCapture*`, `donut::render::ForwardShadingPass*`, `donut::render::ForwardShadingPass::Context*`, `donut::render::GBufferFillPass*`, `donut::render::DeferredLightingPass*`, `donut::render::TemporalAntiAliasingPass*`, `donut::render::ToneMappingPass*`, `donut::render::DepthPass*`, `donut::render::PixelReadbackPass*`, `donut::render::MipMapGenPass*`, `donut::render::MaterialIDPass*`, `donut::render::SsaoPass*`, `donut::render::EnvironmentMapPass*`, `donut::render::SkyPass*`, `donut::render::BloomPass*`, `donut::render::LightProbeProcessingPass*`, `donut::render::DLSS*`.

- [ ] **Step 1: Declare the classes and map the C++ types**

Append to `core/donut_handles.d.ts`:

```ts
declare class CubemapTargetHandle extends ObjectHandle { private readonly __cubemapTarget: int; }
declare class GBufferTargetsHandle extends ObjectHandle { private readonly __gbufferTargets: int; }
declare class TemporalTargetsHandle extends ObjectHandle { private readonly __temporalTargets: int; }
declare class SceneRenderTargetsHandle extends ObjectHandle { private readonly __sceneRenderTargets: int; }
declare class ShadowMapHandle extends ObjectHandle { private readonly __shadowMap: int; }
declare class LightProbeSetHandle extends ObjectHandle { private readonly __lightProbeSet: int; }
declare class LightProbeCaptureHandle extends ObjectHandle { private readonly __lightProbeCapture: int; }
declare class ForwardShadingPassHandle extends ObjectHandle { private readonly __forwardShadingPass: int; }
declare class ForwardShadingContextHandle extends ObjectHandle { private readonly __forwardShadingContext: int; }
declare class GBufferFillPassHandle extends ObjectHandle { private readonly __gbufferFillPass: int; }
declare class DeferredLightingPassHandle extends ObjectHandle { private readonly __deferredLightingPass: int; }
declare class TemporalAntiAliasingPassHandle extends ObjectHandle { private readonly __temporalAntiAliasingPass: int; }
declare class ToneMappingPassHandle extends ObjectHandle { private readonly __toneMappingPass: int; }
declare class DepthPassHandle extends ObjectHandle { private readonly __depthPass: int; }
declare class PixelReadbackPassHandle extends ObjectHandle { private readonly __pixelReadbackPass: int; }
declare class MipMapGenPassHandle extends ObjectHandle { private readonly __mipMapGenPass: int; }
declare class MaterialIdPassHandle extends ObjectHandle { private readonly __materialIdPass: int; }
declare class SsaoPassHandle extends ObjectHandle { private readonly __ssaoPass: int; }
declare class EnvironmentMapPassHandle extends ObjectHandle { private readonly __environmentMapPass: int; }
declare class SkyPassHandle extends ObjectHandle { private readonly __skyPass: int; }
declare class BloomPassHandle extends ObjectHandle { private readonly __bloomPass: int; }
declare class LightProbeProcessingPassHandle extends ObjectHandle { private readonly __lightProbeProcessingPass: int; }
declare class DlssHandle extends ObjectHandle { private readonly __dlss: int; }
```

Add to `HANDLES` in `tools/check_interop_types.py`:

```python
    "CubemapTarget": "CubemapTargetHandle",
    "GBufferTargets": "GBufferTargetsHandle",
    "TemporalTargets": "TemporalTargetsHandle",
    "SceneRenderTargets": "SceneRenderTargetsHandle",
    "ShadowMapTarget": "ShadowMapHandle",
    "LightProbeSet": "LightProbeSetHandle",
    "LightProbeCapture": "LightProbeCaptureHandle",
    "donut::render::ForwardShadingPass": "ForwardShadingPassHandle",
    "donut::render::ForwardShadingPass::Context": "ForwardShadingContextHandle",
    "donut::render::GBufferFillPass": "GBufferFillPassHandle",
    "donut::render::DeferredLightingPass": "DeferredLightingPassHandle",
    "donut::render::TemporalAntiAliasingPass": "TemporalAntiAliasingPassHandle",
    "donut::render::ToneMappingPass": "ToneMappingPassHandle",
    "donut::render::DepthPass": "DepthPassHandle",
    "donut::render::PixelReadbackPass": "PixelReadbackPassHandle",
    "donut::render::MipMapGenPass": "MipMapGenPassHandle",
    "donut::render::MaterialIDPass": "MaterialIdPassHandle",
    "donut::render::SsaoPass": "SsaoPassHandle",
    "donut::render::EnvironmentMapPass": "EnvironmentMapPassHandle",
    "donut::render::SkyPass": "SkyPassHandle",
    "donut::render::BloomPass": "BloomPassHandle",
    "donut::render::LightProbeProcessingPass": "LightProbeProcessingPassHandle",
    "donut::render::DLSS": "DlssHandle",
```

- [ ] **Step 2: Run the check to see it fail**

Run: `python tools/check_interop_types.py`
Expected: FAIL. There is one `... is used by no function` line per new class (a class only extended by another is exempt), and nothing else.

- [ ] **Step 3: Type the C++ parameters**

List the places that cast a `void*` to these types:

```bash
grep -nE "AsSceneRenderTargets\(|static_cast<CubemapTarget ?\*>|static_cast<GBufferTargets ?\*>|static_cast<TemporalTargets ?\*>|static_cast<SceneRenderTargets ?\*>|static_cast<ShadowMapTarget ?\*>|static_cast<LightProbeSet ?\*>|static_cast<LightProbeCapture ?\*>|static_cast<donut::render::" core/*.cpp
```

At each hit whose argument is a `void*` parameter of an `extern "C"` function, change that parameter to the typed pointer and drop the cast or helper call. For example:

```cpp
    void Donut_ResetExposure(void* commandList, void* toneMappingPass, double initialExposure)
    {
        static_cast<donut::render::ToneMappingPass*>(toneMappingPass)->ResetExposure(AsCommandList(commandList), float(initialExposure));
    }
```

becomes

```cpp
    void Donut_ResetExposure(nvrhi::ICommandList* commandList, donut::render::ToneMappingPass* toneMappingPass, double initialExposure)
    {
        toneMappingPass->ResetExposure(commandList, float(initialExposure));
    }
```

Then delete these helpers: `AsSceneRenderTargets`. Re-run the grep: what's left is a cast of something other than a parameter (a local, a member). Leave those.

`Donut_CreateDlss` and the DLSS functions are compiled only with `DONUT_WITH_DLSS`; type them the same way in that `#if` branch. The check script reads the text either way.

- [ ] **Step 4: Type the C++ returns**

Change the `void*` return type of these functions:

- `donut::render::BloomPass*`: Donut_CreateBloomPass
- `ShadowMapTarget*`: Donut_CreateCascadedShadowMap, Donut_CreatePlanarShadowMap
- `CubemapTarget*`: Donut_CreateCubemapTarget
- `donut::render::DeferredLightingPass*`: Donut_CreateDeferredLightingPass
- `donut::render::DLSS*`: Donut_CreateDlss
- `donut::render::EnvironmentMapPass*`: Donut_CreateEnvironmentMapPass
- `donut::render::ForwardShadingPass::Context*`: Donut_CreateForwardShadingContext
- `donut::render::ForwardShadingPass*`: Donut_CreateForwardShadingPass, Donut_CreateForwardShadingPassWithOptions
- `donut::render::GBufferFillPass*`: Donut_CreateGBufferFillPass, Donut_CreateGBufferFillPassWithOptions
- `GBufferTargets*`: Donut_CreateGBufferTargets
- `LightProbeCapture*`: Donut_CreateLightProbeCapture
- `donut::render::LightProbeProcessingPass*`: Donut_CreateLightProbeProcessingPass
- `LightProbeSet*`: Donut_CreateLightProbeSet
- `donut::render::MaterialIDPass*`: Donut_CreateMaterialIDPass
- `donut::render::MipMapGenPass*`: Donut_CreateMipMapGenPass
- `donut::render::PixelReadbackPass*`: Donut_CreatePixelReadbackPass
- `SceneRenderTargets*`: Donut_CreateSceneRenderTargets
- `donut::render::TemporalAntiAliasingPass*`: Donut_CreateSceneTemporalAntiAliasingPass, Donut_CreateTemporalAntiAliasingPass
- `donut::render::DepthPass*`: Donut_CreateShadowDepthPass
- `donut::render::SkyPass*`: Donut_CreateSkyPass
- `donut::render::SsaoPass*`: Donut_CreateSsaoPass
- `TemporalTargets*`: Donut_CreateTemporalTargets
- `donut::render::ToneMappingPass*`: Donut_CreateToneMappingPass

- [ ] **Step 5: Bring the `.d.ts` along**

Run: `python tools/check_interop_types.py --fix`
Expected: `check_interop_types: rewrote <N> declaration(s)` and no problem lines. `--fix` reads only the C++ text, so it runs before the C++ compiles. Any remaining problem names a declaration `--fix` doesn't handle (an override, a parameter count). Fix it by hand, then re-run without `--fix` until it prints nothing.

- [ ] **Step 6: Build the interop**

Run the build command from Global Constraints with `--target donut_interop donut_interop_shared` added after `build`.
Expected: the check passes and the C++ compiles. Fix every compiler error at its cause:
- a caller passing the wrong kind of pointer: fix the caller;
- a parameter still `void*` where a deleted helper used to convert it (signatures spread over several lines are easy to miss): type it;
- a helper still taking `void*`: type it.

After each C++ fix, re-run Step 5's `--fix`. A real mismatch between kinds goes in the commit message.

- [ ] **Step 7: Regenerate the wrappers and check that no method changed**

```bash
N='s/\b[A-Za-z0-9]+Handle\b/Opaque/g'
git show HEAD:core/donut.ts | grep -E "^export class |^    (static )?\w+\(.*\{$" | sed -E "$N" > "$TEMP/methods.before"
python tools/generate_donut_wrappers.py
grep -E "^export class |^    (static )?\w+\(.*\{$" core/donut.ts | sed -E "$N" > "$TEMP/methods.after"
diff "$TEMP/methods.before" "$TEMP/methods.after" && echo "same methods"
```

Expected: `same methods`. With handle types read as `Opaque`, every class and method signature in `core/donut.ts` is unchanged.

A difference means a typed declaration maps differently than before:
- **A method moved class or got renamed.** A type in the `.d.ts` doesn't match the generator's `CLASSES`: fix the class name (the `XxxHandle` of a wrapper `Xxx`), not the generator.
- **A parameter or return turned from a handle into a wrapper class.** The generator now maps it by its type where it used to miss it by name. Keep it: the build in Step 9 points at the callers to update.

- [ ] **Step 8: Retype the holders in TypeScript**

Run: `python tools/find_untyped_handles.py | grep -E "'(CubemapTarget|GBufferTargets|TemporalTargets|SceneRenderTargets|ShadowMap|LightProbeSet|LightProbeCapture|ForwardShadingPass|ForwardShadingContext|GBufferFillPass|DeferredLightingPass|TemporalAntiAliasingPass|ToneMappingPass|DepthPass|PixelReadbackPass|MipMapGenPass|MaterialIdPass|SsaoPass|EnvironmentMapPass|SkyPass|BloomPass|LightProbeProcessingPass|Dlss)(Handle)?( \| null)?'"`

Each line points at a field, local, parameter, array or callback typed `Opaque` that holds one of these handles. Retype its declaration:
- the handle class;
- the wrapper class, if it holds the wrapper object (Review Focus 5);
- the base class (`ResourceHandle[]`, `ObjectHandle[]`), if it holds several kinds (Review Focus 1).

Repeat until the grep prints nothing. 

- [ ] **Step 9: Build, check, smoke-run**

Run the full build (Global Constraints). Expected: success.

Run the tsc check (Global Constraints). Expected: only the TS2367 line.

Run: `pwsh -File tools/smoke_examples.ps1 -Examples feature_demo,deferred_shading,environment_map,simple_hdr,variable_shading,async_compute_bloom,msaa,simple_pbr`
Expected: `smoke_examples: all passed`, apart from failures already listed in `build/smoke-baseline.txt` (Task 1 Step 13) for the same example and API.

- [ ] **Step 10: Commit**

```bash
git add core/donut_handles.d.ts core/donut_interop.d.ts core/donut.ts core/donut_globals.d.ts core/*.cpp core/input_pass.ts tools/check_interop_types.py examples/
git commit -m "Type render pass and render target handles

No mismatches between handle kinds found.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

If Step 6 or Step 8 found a real mismatch, replace the middle paragraph with one line per mismatch: where it was and how it was fixed.

---
### Task 11: Everything else (stage 10)

**Files:**
- Modify: `core/donut_handles.d.ts`, `tools/check_interop_types.py` (`HANDLES`), the `core/*.cpp` files whose functions take or return these types, `core/donut_interop.d.ts` (via `--fix`), examples holding these handles
- Regenerate: `core/donut.ts`, `core/donut_globals.d.ts`

**Interfaces:**
- Consumes: Task 1's tools; the classes of earlier tasks (`ResourceHandle`, `ObjectHandle`).
- Produces: `ImGuiPassHandle`, `ImGuiFontHandle`, `VideoPlayerHandle`, `SdkMeshHandle`, `GltfModelHandle`, `GltfMeshHandle`, `BinaryFileHandle`, `TranscodedTextureHandle`, `FbcTextureHandle`, `AsyncComputeLoopHandle`, `TileMappingsHandle`, `TextureHeapHandle`, `SharedTextureHandle`, `D3D12WorkGraphHandle`, `OcclusionPredicationHandle`, `PredicationBufferHandle`, `MeshPipelineStatisticsHandle`, `RandomEngineHandle`, `TimerQueryHandle`; C++ functions taking and returning `TsImGuiPass*`, `donut::app::RegisteredFont*`, `VideoPlayer*`, `SdkMesh*`, `GltfModel*`, `GltfMesh*`, `BinaryFile*`, `TranscodedTexture*`, `FbcTexture*`, `AsyncComputeLoop*`, `TileMappings*`, `TextureHeap*`, `SharedTexture*`, `D3D12WorkGraph*`, `OcclusionPredication*`, `PredicationBuffer*`, `MeshPipelineStatistics*`, `RandomEngine*`, `nvrhi::ITimerQuery*`.

- [ ] **Step 1: Declare the classes and map the C++ types**

Append to `core/donut_handles.d.ts`:

```ts
declare class ImGuiPassHandle { private readonly __imguiPass: int; }
declare class ImGuiFontHandle { private readonly __imguiFont: int; }
declare class VideoPlayerHandle { private readonly __videoPlayer: int; }
declare class SdkMeshHandle { private readonly __sdkMesh: int; }
declare class GltfModelHandle extends ObjectHandle { private readonly __gltfModel: int; }
declare class GltfMeshHandle extends ObjectHandle { private readonly __gltfMesh: int; }
declare class BinaryFileHandle extends ObjectHandle { private readonly __binaryFile: int; }
declare class TranscodedTextureHandle { private readonly __transcodedTexture: int; }
declare class FbcTextureHandle { private readonly __fbcTexture: int; }
declare class AsyncComputeLoopHandle extends ObjectHandle { private readonly __asyncComputeLoop: int; }
declare class TileMappingsHandle { private readonly __tileMappings: int; }
declare class TextureHeapHandle extends ObjectHandle { private readonly __textureHeap: int; }
declare class SharedTextureHandle extends ObjectHandle { private readonly __sharedTexture: int; }
declare class D3D12WorkGraphHandle extends ObjectHandle { private readonly __workGraph: int; }
declare class OcclusionPredicationHandle extends ObjectHandle { private readonly __occlusionPredication: int; }
declare class PredicationBufferHandle extends ObjectHandle { private readonly __predicationBuffer: int; }
declare class MeshPipelineStatisticsHandle extends ObjectHandle { private readonly __meshPipelineStatistics: int; }
declare class RandomEngineHandle extends ObjectHandle { private readonly __randomEngine: int; }
declare class TimerQueryHandle extends ResourceHandle { private readonly __timerQuery: int; }
```

Add to `HANDLES` in `tools/check_interop_types.py`:

```python
    "TsImGuiPass": "ImGuiPassHandle",
    "donut::app::RegisteredFont": "ImGuiFontHandle",
    "VideoPlayer": "VideoPlayerHandle",
    "SdkMesh": "SdkMeshHandle",
    "GltfModel": "GltfModelHandle",
    "GltfMesh": "GltfMeshHandle",
    "BinaryFile": "BinaryFileHandle",
    "TranscodedTexture": "TranscodedTextureHandle",
    "FbcTexture": "FbcTextureHandle",
    "AsyncComputeLoop": "AsyncComputeLoopHandle",
    "TileMappings": "TileMappingsHandle",
    "TextureHeap": "TextureHeapHandle",
    "SharedTexture": "SharedTextureHandle",
    "D3D12WorkGraph": "D3D12WorkGraphHandle",
    "OcclusionPredication": "OcclusionPredicationHandle",
    "PredicationBuffer": "PredicationBufferHandle",
    "MeshPipelineStatistics": "MeshPipelineStatisticsHandle",
    "RandomEngine": "RandomEngineHandle",
    "nvrhi::ITimerQuery": "TimerQueryHandle",
```

- [ ] **Step 2: Run the check to see it fail**

Run: `python tools/check_interop_types.py`
Expected: FAIL. There is one `... is used by no function` line per new class (a class only extended by another is exempt), and nothing else.

- [ ] **Step 3: Type the C++ parameters**

List the places that cast a `void*` to these types:

```bash
grep -nE "AsSdkMesh\(|static_cast<TsImGuiPass ?\*>|static_cast<donut::app::RegisteredFont ?\*>|static_cast<VideoPlayer ?\*>|static_cast<SdkMesh ?\*>|static_cast<GltfModel ?\*>|static_cast<GltfMesh ?\*>|static_cast<BinaryFile ?\*>|static_cast<TranscodedTexture ?\*>|static_cast<FbcTexture ?\*>|static_cast<AsyncComputeLoop ?\*>|static_cast<TileMappings ?\*>|static_cast<TextureHeap ?\*>|static_cast<SharedTexture ?\*>|static_cast<D3D12WorkGraph ?\*>|static_cast<OcclusionPredication ?\*>|static_cast<PredicationBuffer ?\*>|static_cast<MeshPipelineStatistics ?\*>|static_cast<std::default_random_engine ?\*>|static_cast<nvrhi::ITimerQuery ?\*>" core/*.cpp
```

At each hit whose argument is a `void*` parameter of an `extern "C"` function, change that parameter to the typed pointer and drop the cast or helper call. For example:

```cpp
    int Donut_GetVideoWidth(void* videoPlayer)
    {
        return static_cast<int>(static_cast<VideoPlayer*>(videoPlayer)->width);
    }
```

becomes

```cpp
    int Donut_GetVideoWidth(VideoPlayer* videoPlayer)
    {
        return static_cast<int>(videoPlayer->width);
    }
```

Then delete these helpers: `AsSdkMesh`. Re-run the grep: what's left is a cast of something other than a parameter (a local, a member). Leave those.

Platform-conditional types (Review Focus 3):
- `D3D12WorkGraph` (`core/donut_interop.cpp:1314`), `SharedTexture` (line 8640) and `TextureHeap` (line 4605) may be defined inside `#if DONUT_WITH_DX12` / `#ifdef _WIN32`. Check with `grep -n "^#if\|^#endif" core/donut_interop.cpp` around each.
- For each one defined inside such a block, add a forward declaration (`struct D3D12WorkGraph;`) outside it, in the same namespace, before the first signature using it. Then the functions' non-D3D12 branches still compile on Android.

Random engines: write `RandomEngine*`, the alias from Task 1. `Donut_GetSharedTextureHandle` returns a native OS handle and stays `void*` (raw memory, Task 12).

- [ ] **Step 4: Type the C++ returns**

Change the `void*` return type of these functions:

- `TsImGuiPass*`: Donut_AddImGuiPass
- `AsyncComputeLoop*`: Donut_CreateAsyncComputeLoop
- `D3D12WorkGraph*`: Donut_CreateD3D12WorkGraph
- `MeshPipelineStatistics*`: Donut_CreateMeshPipelineStatistics
- `OcclusionPredication*`: Donut_CreateOcclusionPredication
- `PredicationBuffer*`: Donut_CreatePredicationBuffer
- `RandomEngine*`: Donut_CreateRandomEngine
- `SharedTexture*`: Donut_CreateSharedTexture
- `TextureHeap*`: Donut_CreateTextureHeap
- `TileMappings*`: Donut_CreateTileMappings
- `nvrhi::ITimerQuery*`: Donut_CreateTimerQuery
- `VideoPlayer*`: Donut_CreateVideoPlayer
- `FbcTexture*`: Donut_FbcCompressCpu, Donut_FbcDecodeDds
- `donut::app::RegisteredFont*`: Donut_ImGuiCreateFont
- `BinaryFile*`: Donut_LoadBinaryFile
- `GltfMesh*`: Donut_LoadGltfMesh
- `GltfModel*`: Donut_LoadGltfModel
- `SdkMesh*`: Donut_LoadSdkMesh
- `TranscodedTexture*`: Donut_TranscodeKtx2

- [ ] **Step 5: Bring the `.d.ts` along**

Run: `python tools/check_interop_types.py --fix`
Expected: `check_interop_types: rewrote <N> declaration(s)` and no problem lines. `--fix` reads only the C++ text, so it runs before the C++ compiles. Any remaining problem names a declaration `--fix` doesn't handle (an override, a parameter count). Fix it by hand, then re-run without `--fix` until it prints nothing.

- [ ] **Step 6: Build the interop**

Run the build command from Global Constraints with `--target donut_interop donut_interop_shared` added after `build`.
Expected: the check passes and the C++ compiles. Fix every compiler error at its cause:
- a caller passing the wrong kind of pointer: fix the caller;
- a parameter still `void*` where a deleted helper used to convert it (signatures spread over several lines are easy to miss): type it;
- a helper still taking `void*`: type it.

After each C++ fix, re-run Step 5's `--fix`. A real mismatch between kinds goes in the commit message.

- [ ] **Step 7: Regenerate the wrappers and check that no method changed**

```bash
N='s/\b[A-Za-z0-9]+Handle\b/Opaque/g'
git show HEAD:core/donut.ts | grep -E "^export class |^    (static )?\w+\(.*\{$" | sed -E "$N" > "$TEMP/methods.before"
python tools/generate_donut_wrappers.py
grep -E "^export class |^    (static )?\w+\(.*\{$" core/donut.ts | sed -E "$N" > "$TEMP/methods.after"
diff "$TEMP/methods.before" "$TEMP/methods.after" && echo "same methods"
```

Expected: `same methods`. With handle types read as `Opaque`, every class and method signature in `core/donut.ts` is unchanged.

A difference means a typed declaration maps differently than before:
- **A method moved class or got renamed.** A type in the `.d.ts` doesn't match the generator's `CLASSES`: fix the class name (the `XxxHandle` of a wrapper `Xxx`), not the generator.
- **A parameter or return turned from a handle into a wrapper class.** The generator now maps it by its type where it used to miss it by name. Keep it: the build in Step 9 points at the callers to update.

- [ ] **Step 8: Retype the holders in TypeScript**

Run: `python tools/find_untyped_handles.py | grep -E "'(ImGuiPass|ImGuiFont|VideoPlayer|SdkMesh|GltfModel|GltfMesh|BinaryFile|TranscodedTexture|FbcTexture|AsyncComputeLoop|TileMappings|TextureHeap|SharedTexture|D3D12WorkGraph|OcclusionPredication|PredicationBuffer|MeshPipelineStatistics|RandomEngine|TimerQuery)(Handle)?( \| null)?'"`

Each line points at a field, local, parameter, array or callback typed `Opaque` that holds one of these handles. Retype its declaration:
- the handle class;
- the wrapper class, if it holds the wrapper object (Review Focus 5);
- the base class (`ResourceHandle[]`, `ObjectHandle[]`), if it holds several kinds (Review Focus 1).

Repeat until the grep prints nothing. Also check every `releaseObject(...)` call: its argument must now be an `ObjectHandle`. A resource or a standalone object passed there was a silent no-op; for example, `loadBinaryFile`'s result released with `releaseResource` was fixed on 2026-10-09. Fix any you find and list them in the commit message.

- [ ] **Step 9: Build, check, smoke-run**

Run the full build (Global Constraints). Expected: success.

Run the tsc check (Global Constraints). Expected: only the TS2367 line.

Run: `pwsh -File tools/smoke_examples.ps1 -Examples 16bit_arithmetic,video_texture,bokeh,mouse_cursor,raytracing_ao,texture_compression_basisu,fast_block_compress,async_compute,simple_compute,conditional_rendering,predication_queries,timestamp_queries,mesh_shader_culling,sparse_image,mobile_nerf,collision`
Expected: `smoke_examples: all passed`, apart from failures already listed in `build/smoke-baseline.txt` (Task 1 Step 13) for the same example and API.

- [ ] **Step 10: Commit**

```bash
git add core/donut_handles.d.ts core/donut_interop.d.ts core/donut.ts core/donut_globals.d.ts core/*.cpp core/input_pass.ts tools/check_interop_types.py examples/
git commit -m "Type the remaining handles

No mismatches between handle kinds found.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

If Step 6 or Step 8 found a real mismatch, replace the middle paragraph with one line per mismatch: where it was and how it was fixed.

---

### Task 12: Strict mode, full verification, pull request

**Files:**
- Modify: `tools/check_interop_types.py` (`RAW_MEMORY`), `CMakeLists.txt` (`--strict`), `docs/superpowers/specs/2026-10-10-typed-interop-handles-design.md` (status line)

**Interfaces:**
- Consumes: everything above; `HANDLES` complete.
- Produces: a build that rejects any new `void*` handle.

- [ ] **Step 1: See what strict mode still reports**

Run: `python tools/check_interop_types.py --strict`
Expected: only raw memory. That is:
- `void*` parameters that point at bytes, floats or ints the function reads or writes (`dst`, and the like);
- the callbacks' `thisVal`;
- `Donut_TransferVideoFrame`'s `sharedHandle`;
- the return of `Donut_GetSharedTextureHandle` (a native OS handle).

`Donut_ReleaseObject`'s `object` is covered by `OVERRIDES` and isn't reported. A reported `void*` whose function body casts it to a C++ class is a handle the family tasks missed. Type it now, following the family task for its type, before continuing.

- [ ] **Step 2: List the raw memory**

Copy each remaining `(function, parameter)` into `RAW_MEMORY` in `tools/check_interop_types.py`, one per line, sorted, using `"*"` as the parameter for a return value. Generate the list rather than typing it:

```bash
python tools/check_interop_types.py --strict | sed -nE "s/.*: (Donut_\w+): parameter '(\w+)' is void\*.*/    (\"\1\", \"\2\"),/p; s/.*: (Donut_\w+): returns void\*.*/    (\"\1\", \"*\"),/p" | sort
```

Paste the output between `RAW_MEMORY = {` and `}` (turn `RAW_MEMORY = set()` into a set literal), with the comment above it unchanged.

Run: `python tools/check_interop_types.py --strict; echo $?`
Expected: `0`.

- [ ] **Step 3: Make the build strict**

In `CMakeLists.txt`'s `add_custom_command` for the check, add `--strict` after the script path. Full build. Expected: success.

- [ ] **Step 4: Nothing untyped left in TypeScript**

Run: `python tools/find_untyped_handles.py`
Expected: `find_untyped_handles: 0 place(s)`, exit 0.

Run the tsc check (Global Constraints). Expected: only the TS2367 line.

- [ ] **Step 5: Every example on both APIs**

Run: `pwsh -File tools/smoke_examples.ps1`
Expected: `smoke_examples: all passed`.

Some may fail as they did before this branch. Compare with `build/smoke-baseline.txt` (Task 1 Step 13):
- A failure listed there for the same example and API goes in the PR description as pre-existing.
- Any other failure is a regression: find it with the task commits (`git log --oneline`), fix it, and run the full smoke again.

- [ ] **Step 6: Android build**

Run: `python tools/android.py build --abi x86_64 basic_triangle compute_nbody`
Expected: `headless` and both APKs build. This compiles `core/donut_interop.cpp` with the NDK's clang, so it covers every typed signature. A failure naming a type defined inside `#if DONUT_WITH_DX12` / `_WIN32` needs a forward declaration outside that `#if` (Review Focus 3).

- [ ] **Step 7: Mark the spec done and commit**

In the spec, set `Status:` to `implemented on typed-handles`.

```bash
git add tools/check_interop_types.py CMakeLists.txt docs/superpowers/specs/2026-10-10-typed-interop-handles-design.md
git commit -m "Allow void* in the interop only for raw memory

check_interop_types.py --strict, now run by the build, rejects a void* parameter or return
unless RAW_MEMORY lists it: every handle has a type.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 8: Pull request**

```bash
git push -u origin typed-handles
gh pr create --base main --title "Typed interop handles" --body-file "$TEMP/typed-handles-pr.md"
```

Write `$TEMP/typed-handles-pr.md` first. It should give:
- a summary of the type system;
- the tools added;
- each latent bug the compiler found, listed from the commit messages;
- the known pre-existing smoke failures;
- the test plan, with the results of Steps 4-6;
- `🤖 Generated with [Claude Code](https://claude.com/claude-code)` at the end.
