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
- RefCountPtr<T> and nvrhi::Object returned by value are nvrhi.RefCountPtr<Opaque> and
  nvrhi.NativeObject;
- the specializations of std::vector, nvrhi::static_vector and RefCountPtr are generic types
  (vector<T>, static_vector8<T>, RefCountPtr<T>; see VECTOR).
A method taking a struct by value (TextureSubresourceSet, nvrhi::Object) or returning a small one
in registers is tsbindgen's too, which tslang calls as each ABI passes the struct.
It needs a tsbindgen that lays out std::string and static_vector fields (tslang newer than
pre-alpha99), and one that binds methods taking structs by value (pre-alpha102 or newer): it
stops if a struct in TUPLES isn't a tuple, or a method is skipped for a struct by value.
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
          "ComputePipelineDesc", "ComputeState", "HeapDesc", "BindlessLayoutDesc", "ShaderSpecialization",
          "MeshletPipelineDesc", "MeshletState", "SamplerFeedbackTextureDesc", "TextureTilesMapping",
          "AccelStructDesc", "GeometryDesc", "InstanceDesc", "PipelineDesc", "PipelineShaderDesc",
          "PipelineHitGroupDesc", "ShaderTableDesc", "State", "OpacityMicromapDesc", "OperationParams",
          "OperationDesc", "MatMulFormatCombo", "ConvertMatrixLayoutDesc", "basic_string_char"]

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


def adapt(body):
    """tsbindgen's classes made to fit core/nvrhi.ts (see the module's doc)."""
    out = []
    tuples = set()
    byValue = []
    for line in body:
        m = re.match(r"\s*export type (\w+) = \[", line)
        if m:
            tuples.add(m.group(1))

        # a method an older tsbindgen leaves out for a struct passed by value or returned in registers
        m = re.match(r"\s*// skipped: (\w+) .*(struct passed by value|returned by value in registers)", line)
        if m:
            byValue.append(m.group(1))

        line = line.replace("Reference<", "Ref<")
        line = re.sub(r"\[ptr_: Opaque \| null\]", "RefCountPtr<Opaque>", line)
        line = re.sub(r"\[integer: Opaque \| null\]", "NativeObject", line)
        out.append(line)

    if byValue:
        sys.exit(f"gen_nvrhi_classes: tsbindgen left out {', '.join(byValue)} for a struct by value: it needs a "
                 "tsbindgen that binds them (tslang pre-alpha102 or newer)")
    untupled = [name for name in TUPLES if name not in tuples]
    if untupled:
        sys.exit(f"gen_nvrhi_classes: tsbindgen didn't lay out {', '.join(untupled)}: it needs a tsbindgen that "
                 "lays out std::string and static_vector fields (tslang newer than pre-alpha99)")
    return out


HEADER = """\
// Generated by tools/gen_nvrhi_classes.py from tsbindgen's bindings; do not edit: run it again.
// {command}
//
// NVRHI's interfaces as @cpp classes under {abi}, and the structs they take as tuples with this
// ABI's C++ layout, its C++ library's std::string included, for core/nvrhi.ts (its import of
// "./nvrhi_abi" brings this file on {platform}). Each @slot is the C++ compiler's. A method taking
// a struct by value takes its tuple, which tslang passes as this ABI passes the struct.
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


# The C++ library's templates as generic tuples. A tsbindgen newer than pre-alpha100 writes them so
# itself; an older one lays out each specialization on its own (vector_BindingSetItem,
# static_vector_IBindingSet_8, RefCountPtr_IShader), which is made generic here. Either way, they are:
# std::vector<T> as each library lays it out (MSVC's in its two helper structs, which go too);
# nvrhi::static_vector<T, N> as static_vector<N><T>, as tslang has no type of N elements;
# nvrhi::RefCountPtr<T> in core/nvrhi_types.ts, the same for both.
VECTOR = {
    "win32": "[_Mypair: [_Myval2: [_Myfirst: Ref<T> | null, _Mylast: Ref<T> | null, _Myend: Ref<T> | null]]]",
    "linux": "[__begin_: Ref<T> | null, __end_: Ref<T> | null, __cap_: Ref<T> | null]",
}
STATIC_VECTOR_ELEMENTS = {"win32": "_Elems", "linux": "__elems_"}


def static_vector(os_name, size, element):
    elements = ", ".join(f"_{i}: {element}" for i in range(size))
    return f"[{STATIC_VECTOR_ELEMENTS[os_name]}: [{elements}], current_size: index]"


def generic_templates(body, os_name):
    """body with the specializations of VECTOR's, static_vector's and RefCountPtr's templates
    replaced by the generic types, which it declares first (see VECTOR). The generics a newer
    tsbindgen declares itself are checked and declared there the same way."""
    # tsbindgen's own generics: laid out as the ones written here, or it stops
    known = {"vector": VECTOR[os_name], "RefCountPtr": "[ptr_: T | null]"}
    kept = []
    for line in body:
        m = re.match(r"\s*export type (\w+)<(\w+)> = (.*);$", line)
        if not m:
            kept.append(line)
            continue
        name, parameter, definition = m.groups()
        size = re.match(r"static_vector(\d+)$", name)
        expected = static_vector(os_name, int(size.group(1)), "T") if size else known.get(name)
        if parameter != "T" or definition != expected:
            sys.exit(f"gen_nvrhi_classes: tsbindgen's {name}<{parameter}> isn't the generic expected ({os_name}):\n"
                     f"  {definition}\n  {expected}")
    body = kept

    aliases = {}
    for line in body:
        m = re.match(r"\s*export type (\w+) = (.*);$", line)
        if m:
            aliases[m.group(1)] = m.group(2)

    def expand(text):
        # the MSVC library's helper structs (_Vector_val..., _Compressed_pair...) inlined
        return re.sub(r"\b_\w+\b", lambda m: expand(aliases[m.group(0)]) if m.group(0) in aliases else m.group(0), text)

    generic = {}
    for name, definition in aliases.items():
        m = re.match(r"vector_(\w+)$", name)
        if m:
            expected, generic[name] = VECTOR[os_name].replace("<T>", f"<{m.group(1)}>"), f"vector<{m.group(1)}>"
        m = re.match(r"static_vector_\w+_(\d+)$", name)
        if m:
            element = re.match(r"\[\w+: \[_0: (.*?), _1: ", definition)
            if not element:
                sys.exit(f"gen_nvrhi_classes: {name} isn't a static_vector: {definition}")
            size = int(m.group(1))
            expected, generic[name] = static_vector(os_name, size, element.group(1)), f"static_vector{size}<{element.group(1)}>"
        m = re.match(r"RefCountPtr_(\w+)$", name)
        if m:
            expected, generic[name] = f"[ptr_: {m.group(1)} | null]", f"RefCountPtr<{m.group(1)}>"
        if name in generic and expand(definition) != expected:
            sys.exit(f"gen_nvrhi_classes: {name} isn't laid out as the generic type ({os_name}):\n"
                     f"  {expand(definition)}\n  {expected}")

    pattern = re.compile(r"\b(" + "|".join(sorted(generic, key=len, reverse=True)) + r")\b") if generic else None
    out = []
    for line in body:
        m = re.match(r"\s*export type (\w+) = ", line)
        if m and m.group(1) in generic:
            continue
        while pattern and pattern.search(line):
            line = pattern.sub(lambda m: generic[m.group(1)], line)
        out.append(line)

    # the helper structs nothing refers to any more
    while True:
        text = "\n".join(out)
        unused = [name for name in aliases if name.startswith("_") and name not in generic
                  and len(re.findall(rf"\b{name}\b", text)) == 1]
        if not unused:
            break
        out = [line for line in out if not re.match(rf"\s*export type ({'|'.join(unused)}) = ", line)]

    left = re.findall(r"\b(?:vector|static_vector|RefCountPtr)_\w+", "\n".join(out))
    if left:
        sys.exit(f"gen_nvrhi_classes: not made generic: {', '.join(sorted(set(left)))}")

    # the generics used, first, in one order whichever wrote them (RefCountPtr<T> is nvrhi_types.ts')
    text = "\n".join(out)
    declarations = [f"    export type vector<T> = {VECTOR[os_name]};"] if re.search(r"\bvector<", text) else []
    declarations += [f"    export type static_vector{size}<T> = {static_vector(os_name, size, 'T')};"
                     for size in sorted({int(size) for size in re.findall(r"\bstatic_vector(\d+)<", text)})]
    return declarations + out


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

        body = adapt(bodies[0])
        body = generic_templates(body, os_name)
        abi, platform = ABIS[os_name]
        text = HEADER.format(command=command, abi=abi, platform=platform)
        text += "\n".join(body) + "\n"
        text += "}\n"

        path = OUTPUT.format(os=os_name)
        with open(path, "w", newline="\n") as f:
            f.write(text)
        print(f"gen_nvrhi_classes: wrote {os.path.relpath(path, ROOT)}")


if __name__ == "__main__":
    main()
