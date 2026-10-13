"""Generates core/nvrhi_classes.win32.ts and core/nvrhi_classes.linux.ts: NVRHI's interfaces
(nvrhi::I*) as tslang @cpp classes, and the structs they take, for the C++ ABI of each target, with
tsbindgen.

tsbindgen asks clang for each class's vtable under the target's ABI, so the @slot numbers, the
overloads' order, the @cppnontrivial marks and the integer widths are the C++ compiler's:
- win32: MSVC x64 (x86_64-pc-windows-msvc);
- linux: the Itanium ABI of Android's clang and libc++, the same on x86-64 and AArch64 (both are
  generated, and must agree but for plain char's sign, which doesn't change a layout). Needs the
  Android NDK's sysroot: ANDROID_NDK_HOME, or --ndk.
Run it after updating NVRHI or tslang, and commit what it writes; never edit the output.

tsbindgen also lays out the structs the classes take, with the C++ library's layout of their
std::string, static_vector and RefCountPtr fields (BufferDesc's debugName is a basic_string_char,
ComputeState's bindings a static_vector_IBindingSet_8). Its output is then made to fit core/nvrhi.ts:
- the namespace is exported, and imports core/nvrhi_types.ts;
- RefCountPtr<T> and nvrhi::Object returned by value are nvrhi.RefCountPtr and nvrhi.NativeObject;
- the methods tsbindgen skips because they take a struct by value are written here, for those in
  BY_VALUE, as each ABI passes it, with a function calling it.
It needs a tsbindgen that lays out std::string and static_vector fields (tslang newer than
pre-alpha99): it stops if a struct in TUPLES isn't a tuple.
"""

import argparse
import os
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NVRHI_INCLUDE = os.path.join(ROOT, "external", "Donut", "nvrhi", "include")
OUTPUT = os.path.join(ROOT, "core", "nvrhi_classes.{os}.ts")

# The targets of each output: the first one's bindings are written, the others' must be the same.
# Android's triples need an API level (its headers reject an unversioned one).
TARGETS = {
    "win32": ["x86_64-pc-windows-msvc"],
    "linux": ["x86_64-linux-android26", "aarch64-linux-android26"],
}

# the structs core/nvrhi.ts and core/nvrhi_abi.<os>.ts build, which tsbindgen has to lay out
TUPLES = ["BufferDesc", "TextureDesc", "TextureSubresourceSet", "Color", "CommandListParameters",
          "ComputePipelineDesc", "ComputeState", "basic_string_char"]

# Methods taking a struct by value, which tsbindgen skips: {(class, method): {os: (declaration,
# function)}}. The declaration's slot is the one tsbindgen leaves free where it skips the method,
# `{slot}` in the text. The function calls it with the struct, as its ABI passes it:
# - MSVC passes a pointer to a copy;
# - the Itanium ABI passes a struct of up to 16 bytes of integers in one or two 64-bit registers.
BY_VALUE = {
    ("ICommandList", "clearTextureFloat"): {
        "win32": (
            "@slot({slot}) clearTextureFloat(t: ITexture, subresources: Ref<TextureSubresourceSet>, clearColor: Ref<Color>): void;",
            """\
    // ICommandList::clearTextureFloat: the TextureSubresourceSet by value, which MSVC passes as a
    // pointer to a copy
    export function clearTextureFloat(commandList: ICommandList, texture: ITexture, subresources: TextureSubresourceSet, color: Color): void {
        let subresourcesValue = subresources;
        let colorValue = color;
        commandList.clearTextureFloat(texture, Ref(subresourcesValue), Ref(colorValue));
    }"""),
        "linux": (
            "@slot({slot}) clearTextureFloat(t: ITexture, mips: u64, arraySlices: u64, clearColor: Ref<Color>): void;",
            """\
    // ICommandList::clearTextureFloat: the TextureSubresourceSet by value, its two halves in two
    // registers (baseMipLevel and numMipLevels, baseArraySlice and numArraySlices)
    export function clearTextureFloat(commandList: ICommandList, texture: ITexture, subresources: TextureSubresourceSet, color: Color): void {
        const mips: u64 = <u64>subresources.baseMipLevel + <u64>subresources.numMipLevels * 0x100000000;
        const arraySlices: u64 = <u64>subresources.baseArraySlice + <u64>subresources.numArraySlices * 0x100000000;
        let colorValue = color;
        commandList.clearTextureFloat(texture, mips, arraySlices, Ref(colorValue));
    }"""),
    },
}


def find_tsbindgen(given):
    path = given or shutil.which("tsbindgen")
    if not path:
        tslang = shutil.which("tslang")
        if tslang:
            path = os.path.join(os.path.dirname(tslang), "tsbindgen.exe" if os.name == "nt" else "tsbindgen")
    if not path or not os.path.exists(path):
        sys.exit("gen_nvrhi_classes: no tsbindgen: put tslang's folder on PATH or pass --tsbindgen")
    return path


def ndk_sysroot(ndk):
    ndk = ndk or os.environ.get("ANDROID_NDK_HOME") or os.environ.get("ANDROID_NDK_ROOT")
    if not ndk:
        sys.exit("gen_nvrhi_classes: the linux bindings need the Android NDK: set ANDROID_NDK_HOME or pass --ndk")
    prebuilt = os.path.join(ndk, "toolchains", "llvm", "prebuilt")
    for host in sorted(os.listdir(prebuilt)) if os.path.isdir(prebuilt) else []:
        sysroot = os.path.join(prebuilt, host, "sysroot")
        if os.path.isdir(sysroot):
            return sysroot.replace("\\", "/")
    sys.exit(f"gen_nvrhi_classes: no sysroot in {prebuilt}")


def run_tsbindgen(tsbindgen, target, sysroot):
    """tsbindgen's bindings of nvrhi::I* for the target, and the command line (relative paths)."""
    with tempfile.TemporaryDirectory() as tmp:
        header = os.path.join(tmp, "nvrhi_classes.hpp")
        with open(header, "w") as f:
            f.write("#include <nvrhi/nvrhi.h>\n")
        include = os.path.relpath(NVRHI_INCLUDE, ROOT).replace("\\", "/")
        args = ["nvrhi_classes.hpp", f"--target={target}", "-I", include, "--filter=nvrhi::I*",
                "--namespace=nvrhi", "--", "-std=c++17"]
        if sysroot:
            args.append(f"--sysroot={sysroot}")
        result = subprocess.run([tsbindgen, header] + args[1:], capture_output=True, text=True, cwd=ROOT)
        if result.returncode != 0:
            sys.exit(f"gen_nvrhi_classes: tsbindgen failed ({target}):\n" + result.stderr)
        command = "tsbindgen " + " ".join(a if " " not in a else f"'{a}'" for a in args)
        if sysroot:
            command = command.replace(sysroot, "<NDK sysroot>")
        return result.stdout, command


def classes_body(text):
    """The lines inside tsbindgen's `namespace nvrhi { ... }`."""
    lines = text.splitlines()
    start = next(i for i, line in enumerate(lines) if line.startswith("namespace nvrhi {"))
    end = max(i for i, line in enumerate(lines) if line == "}")
    return lines[start + 1:end]


def same_layouts(a, b):
    """Whether two targets' bindings agree but for plain char's sign (s8 on x86-64, u8 on AArch64)."""
    unsigned = lambda body: [re.sub(r"\bs8\b", "u8", line) for line in body]
    return unsigned(a) == unsigned(b)


def adapt(body, os_name):
    """tsbindgen's classes made to fit core/nvrhi.ts (see the module's doc), and the functions of
    BY_VALUE's methods."""
    out = []
    functions = []
    cls = None
    used = set()
    last_slot = None
    tuples = set()
    for line in body:
        m = re.match(r"\s*export type (\w+) = \[", line)
        if m:
            tuples.add(m.group(1))

        m = re.match(r"\s*@cpp$|\s*export class (\w+)", line)
        if m and m.group(1):
            cls = m.group(1)
            used = set()
            last_slot = None

        m = re.search(r"@slot\((\d+)\)", line)
        if m:
            used.add(int(m.group(1)))
            last_slot = int(m.group(1))

        line = line.replace("Reference<", "Ref<")
        line = re.sub(r"\[ptr_: Opaque \| null\]", "RefCountPtr", line)
        line = re.sub(r"\[integer: Opaque \| null\]", "NativeObject", line)

        m = re.match(r"(\s*)// skipped: (\w+) ", line)
        if m and (cls, m.group(2)) in BY_VALUE:
            # the slot tsbindgen skipped: the one after the previous method's, which must be free
            # and not follow an overload (MSVC orders those its own way)
            declaration, function = BY_VALUE[(cls, m.group(2))][os_name]
            slot = last_slot + 1
            previous = out[-1].strip()
            if slot in used or not re.match(r"@slot\(\d+\) \w+\(", previous) or re.search(r"_\d+\(", previous):
                sys.exit(f"gen_nvrhi_classes: can't tell the slot of {cls}::{m.group(2)} ({os_name})")
            line = m.group(1) + declaration.format(slot=slot)
            used.add(slot)
            last_slot = slot
            functions.append(function)

        out.append(line)

    missing = [f"{c}::{n}" for (c, n) in BY_VALUE if not any(f" {n}(" in line for line in out)]
    if missing:
        sys.exit(f"gen_nvrhi_classes: not in tsbindgen's output: {', '.join(missing)}")
    untupled = [name for name in TUPLES if name not in tuples]
    if untupled:
        sys.exit(f"gen_nvrhi_classes: tsbindgen didn't lay out {', '.join(untupled)}: it needs a tsbindgen that "
                 "lays out std::string and static_vector fields (tslang newer than pre-alpha99)")
    return out, functions


HEADER = """\
// Generated by tools/gen_nvrhi_classes.py from tsbindgen's bindings; do not edit: run it again.
// {command}
//
// NVRHI's interfaces as @cpp classes under {abi}, and the structs they take as tuples with this
// ABI's C++ layout, its C++ library's std::string included, for core/nvrhi.ts (its import of
// "./nvrhi_abi" brings this file on {platform}). Each @slot is the C++ compiler's. A method taking
// a struct by value is left out, except those tools/gen_nvrhi_classes.py writes, with a function
// calling it.
//
// Not checked by TypeScript's editor tooling (@ts-nocheck): a @slot method has no body, which it
// reports twice per method (TS2391, TS1249), whatever the class's form. tslang ignores the line.
// @ts-nocheck

import "./nvrhi_types";

export namespace nvrhi {{
"""

ABIS = {
    "win32": ("MSVC x64's ABI", "Windows"),
    "linux": ("the Itanium ABI of Android's clang (x86-64 and AArch64)", "Android"),
}


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--tsbindgen", help="tsbindgen's path (default: on PATH, or next to tslang)")
    parser.add_argument("--ndk", help="the Android NDK (default: ANDROID_NDK_HOME)")
    parser.add_argument("--os", choices=sorted(TARGETS), action="append", help="only this output (default: all)")
    args = parser.parse_args()

    tsbindgen = find_tsbindgen(args.tsbindgen)
    for os_name in args.os or sorted(TARGETS):
        sysroot = ndk_sysroot(args.ndk) if os_name == "linux" else None
        bodies = []
        command = None
        for target in TARGETS[os_name]:
            text, target_command = run_tsbindgen(tsbindgen, target, sysroot)
            bodies.append(classes_body(text))
            command = command or target_command
        if any(not same_layouts(body, bodies[0]) for body in bodies[1:]):
            sys.exit(f"gen_nvrhi_classes: the bindings of {', '.join(TARGETS[os_name])} differ")

        body, functions = adapt(bodies[0], os_name)
        abi, platform = ABIS[os_name]
        text = HEADER.format(command=command, abi=abi, platform=platform)
        text += "\n".join(body) + "\n"
        for function in functions:
            text += "\n" + function + "\n"
        text += "}\n"

        path = OUTPUT.format(os=os_name)
        with open(path, "w", newline="\n") as f:
            f.write(text)
        print(f"gen_nvrhi_classes: wrote {os.path.relpath(path, ROOT)}")


if __name__ == "__main__":
    main()
