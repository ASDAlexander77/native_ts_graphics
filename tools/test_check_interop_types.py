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
