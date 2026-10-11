"""Checks the @cppvtable classes of core/nvrhi_abi.<os>.ts against the vtables C++ builds for NVRHI's
interfaces.

A @cppvtable class's methods are the C++ vtable's slots in declaration order (a base class's
first), so a method missing, added or out of order calls a different C++ method, with no error
at all. This asks the compiler for the real layout and compares it, slot by slot, with the methods
the TypeScript classes declare:
- `--abi msvc` (the default): core/nvrhi_abi.win32.ts against MSVC's
  (cl /d1reportSingleClassLayout<Name>). Needs MSVC: run from a developer command prompt, or let it
  find vcvars64.bat with vswhere.
- `--abi itanium`: core/nvrhi_abi.linux.ts against the Itanium ABI of Android's clang, for x86-64
  and AArch64 (clang -fdump-vtable-layouts). Needs the Android NDK: ANDROID_NDK_HOME, or --ndk.

The TypeScript name of a slot is the C++ name (a bound method), or `_` + the C++ name (a slot
declared only to keep the count). The C++ destructor is `_destructor` (MSVC's one slot), or
`_completeDestructor` and `_deletingDestructor` (the Itanium ABI's two). An overloaded C++ method
has one slot per overload, which MSVC orders in its own way, so those slots are only placeholders,
`_<name>_<slot>`.
"""

import argparse
import os
import re
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NVRHI_INCLUDE = os.path.join(ROOT, "external", "Donut", "nvrhi", "include")
BINDINGS = {
    "msvc": os.path.join(ROOT, "core", "nvrhi_abi.win32.ts"),
    "itanium": os.path.join(ROOT, "core", "nvrhi_abi.linux.ts"),
}

# the classes in the `nvrhi` namespace, named as NVRHI's interfaces
CLASSES = ["IMessageCallback", "IResource", "IBuffer", "ITexture", "IShader", "IBindingLayout", "IBindingSet",
           "IComputePipeline", "ICommandList", "IDevice"]

# the Android targets the Itanium layouts are taken for (the same, but both are checked)
ANDROID_TARGETS = ["x86_64-linux-android29", "aarch64-linux-android29"]


def vcvars():
    vswhere = os.path.join(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"),
                           "Microsoft Visual Studio", "Installer", "vswhere.exe")
    if not os.path.exists(vswhere):
        return None
    path = subprocess.run([vswhere, "-latest", "-products", "*", "-requires",
                           "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"],
                          capture_output=True, text=True).stdout.strip()
    bat = os.path.join(path, "VC", "Auxiliary", "Build", "vcvars64.bat")
    return bat if path and os.path.exists(bat) else None


def run_cl(cl, tmp):
    if subprocess.run("where cl", shell=True, capture_output=True).returncode == 0:
        return subprocess.run(cl, capture_output=True, text=True, cwd=tmp)
    bat = vcvars()
    if not bat:
        sys.exit("check_nvrhi_slots: no cl on PATH and no vcvars64.bat found: run from a developer prompt")
    # through a batch file: cmd's quoting of a `call "<path>"` on its command line is its own
    script = os.path.join(tmp, "layout.bat")
    with open(script, "w") as f:
        f.write('@call "' + bat + '" >nul\n')
        f.write("@" + subprocess.list2cmdline(cl) + "\n")
    return subprocess.run(["cmd", "/c", script], capture_output=True, text=True, cwd=tmp)


def msvc_layouts(names):
    """{interface: [slot name, ...]} from MSVC's class layout report, one cl run a class (cl
    reports only the last /d1reportSingleClassLayout it is given). The destructor is `{dtor}`."""
    layouts = {}
    with tempfile.TemporaryDirectory() as tmp:
        source = os.path.join(tmp, "layout.cpp")
        with open(source, "w") as f:
            f.write("#include <nvrhi/nvrhi.h>\n")
            for name in names:
                f.write(f"nvrhi::{name}* p{name};\n")
        for name in names:
            # the CRT the project builds with (CMAKE_MSVC_RUNTIME_LIBRARY MultiThreaded)
            cl = ["cl", "/nologo", "/std:c++17", "/c", "/Zs", "/MT", f"/I{NVRHI_INCLUDE}",
                  f"/d1reportSingleClassLayout{name}", source]
            result = run_cl(cl, tmp)
            if result.returncode != 0:
                sys.exit("check_nvrhi_slots: cl failed:\n" + result.stdout + result.stderr)
            section = re.search(r"^nvrhi::" + name + r"::\$vftable@:\n(.*?)\n\n", result.stdout, re.M | re.S)
            if not section:
                sys.exit(f"check_nvrhi_slots: no vtable for nvrhi::{name} in cl's report")
            slots = []
            for line in section.group(1).splitlines():
                m = re.match(r"\s*(\d+)\s*\|\s*&nvrhi::\w+::(\S+)", line)
                if m:
                    assert int(m.group(1)) == len(slots), line
                    slots.append(m.group(2))
            layouts[name] = slots
    return layouts


def ndk_clang(ndk):
    ndk = ndk or os.environ.get("ANDROID_NDK_HOME") or os.environ.get("ANDROID_NDK_ROOT")
    if not ndk:
        sys.exit("check_nvrhi_slots: --abi itanium needs the Android NDK: set ANDROID_NDK_HOME or pass --ndk")
    prebuilt = os.path.join(ndk, "toolchains", "llvm", "prebuilt")
    hosts = os.listdir(prebuilt) if os.path.isdir(prebuilt) else []
    for host in hosts:
        for exe in ("clang++.exe", "clang++"):
            path = os.path.join(prebuilt, host, "bin", exe)
            if os.path.exists(path):
                return path
    sys.exit(f"check_nvrhi_slots: no clang++ in {prebuilt}")


def itanium_layouts(names, clang, target):
    """{interface: [slot name, ...]} from clang's vtable dump for the Android target. A class whose
    vtable the file emits is derived from each interface (its key function defined there); its
    entries 0 and 1 are the offset to top and the RTTI, so slot N is entry N + 2. The destructors
    are `{complete}` and `{deleting}`."""
    with tempfile.TemporaryDirectory() as tmp:
        source = os.path.join(tmp, "layout.cpp")
        with open(source, "w") as f:
            f.write("#include <nvrhi/nvrhi.h>\n")
            for name in names:
                f.write(f"struct Probe_{name} : nvrhi::{name} {{ virtual void probeKey_(); }};\n"
                        f"void Probe_{name}::probeKey_() {{}}\n")
        result = subprocess.run([clang, f"--target={target}", "-std=c++17", f"-I{NVRHI_INCLUDE}", "-S", "-emit-llvm",
                                 "-o", os.devnull, "-Xclang", "-fdump-vtable-layouts", source],
                                capture_output=True, text=True)
        if result.returncode != 0:
            sys.exit(f"check_nvrhi_slots: clang failed ({target}):\n" + result.stdout + result.stderr)
    layouts = {}
    for name in names:
        section = re.search(r"^Vtable for 'Probe_" + name + r"' \(\d+ entries\)\.\n(.*?)\n\n", result.stdout, re.M | re.S)
        if not section:
            sys.exit(f"check_nvrhi_slots: no vtable for nvrhi::{name} in clang's dump ({target})")
        slots = []
        for line in section.group(1).splitlines():
            m = re.match(r"\s*(\d+) \| (.*)$", line)
            if not m or int(m.group(1)) < 2 or "probeKey_" in m.group(2):
                continue
            assert int(m.group(1)) - 2 == len(slots), line
            text = m.group(2)
            if "[complete]" in text:
                slots.append("{complete}")
            elif "[deleting]" in text:
                slots.append("{deleting}")
            else:
                slots.append(re.search(r"nvrhi::\w+::(\w+)\(", text).group(1))
        layouts[name] = slots
    return layouts


def ts_classes(path):
    """{class: (base or None, [method name, ...])} for the @cppvtable classes in path."""
    text = open(path, encoding="utf-8").read()
    classes = {}
    for m in re.finditer(r"@cppvtable\s+export\s+class\s+(\w+)(?:\s+extends\s+(\w+))?\s*\{(.*?)\n    \}", text, re.S):
        name, base, body = m.group(1), m.group(2), m.group(3)
        methods = re.findall(r"^\s+(\w+)\s*\(", body, re.M)
        classes[name] = (base, methods)
    return classes


DESTRUCTORS = {"{dtor}": "_destructor", "{complete}": "_completeDestructor", "{deleting}": "_deletingDestructor"}


def compare(classes, layouts, label):
    problems = []
    for name in CLASSES:
        # a class's slots: its base's, then its own
        slots = []
        chain = name
        while chain:
            base, methods = classes[chain]
            slots[:0] = methods
            chain = base
        cpp = layouts[name]
        overloads = {n for n in cpp if cpp.count(n) > 1 and n not in DESTRUCTORS}
        if len(slots) != len(cpp):
            problems.append(f"{label} {name}: {len(slots)} slots, nvrhi::{name} has {len(cpp)}")
        for slot, cpp_name in enumerate(cpp):
            ts_name = slots[slot] if slot < len(slots) else "(none)"
            if cpp_name in DESTRUCTORS:
                wanted = [DESTRUCTORS[cpp_name]]
            elif cpp_name in overloads:
                wanted = [f"_{cpp_name}_{slot}"]
            else:
                wanted = [cpp_name, "_" + cpp_name]
            if ts_name not in wanted:
                problems.append(f"{label} {name} slot {slot}: '{ts_name}', nvrhi::{name} has {cpp_name} "
                                f"(expected {' or '.join(wanted)})")
    return problems


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--abi", choices=["msvc", "itanium"], default="msvc")
    parser.add_argument("--ndk", help="the Android NDK (default: ANDROID_NDK_HOME)")
    args = parser.parse_args()

    bindings = BINDINGS[args.abi]
    classes = ts_classes(bindings)
    relative = os.path.relpath(bindings, ROOT).replace("\\", "/")
    missing = [name for name in CLASSES if name not in classes]
    if missing:
        sys.exit(f"check_nvrhi_slots: no @cppvtable class {', '.join(missing)} in {relative}")

    if args.abi == "msvc":
        checked = [("MSVC x64", msvc_layouts(CLASSES))]
    else:
        clang = ndk_clang(args.ndk)
        checked = [(target, itanium_layouts(CLASSES, clang, target)) for target in ANDROID_TARGETS]

    problems = []
    for label, layouts in checked:
        problems += compare(classes, layouts, label)
    if problems:
        print("\n".join(problems))
        return 1
    layouts = checked[0][1]
    print(f"{relative}: {len(CLASSES)} classes match NVRHI's vtables ({', '.join(label for label, _ in checked)}; "
          f"{', '.join(f'{name} {len(layouts[name])}' for name in CLASSES)} slots)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
