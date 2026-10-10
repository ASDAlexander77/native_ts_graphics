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
