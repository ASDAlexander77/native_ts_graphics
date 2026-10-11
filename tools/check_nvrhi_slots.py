"""Checks core/nvrhi.ts's @cppvtable classes against the vtables MSVC builds for NVRHI's interfaces.

A @cppvtable class's methods are the C++ vtable's slots in declaration order (a base class's
first), so a method missing, added or out of order calls a different C++ method, with no error
at all. This asks the compiler for the real layout (cl /d1reportSingleClassLayout<Name>) and
compares it, slot by slot, with the methods the TypeScript classes declare.

The TypeScript name of a slot is the C++ name (a bound method), or `_` + the C++ name (a slot
declared only to keep the count). The C++ destructor is `_destructor`. An overloaded C++ method
has one slot per overload, which MSVC orders in its own way, so those slots are only
placeholders, `_<name>_<slot>`.

Needs MSVC: run from a developer command prompt, or let it find vcvars64.bat with vswhere.
"""

import os
import re
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NVRHI_INCLUDE = os.path.join(ROOT, "external", "Donut", "nvrhi", "include")
BINDINGS = os.path.join(ROOT, "core", "nvrhi.ts")

# the classes in core/nvrhi.ts's `nvrhi` namespace, named as NVRHI's interfaces
CLASSES = ["IResource", "IBuffer", "ITexture", "ICommandList", "IDevice"]


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


def cpp_layouts(names):
    """{interface: [slot name, ...]} from MSVC's class layout report, one cl run a class (cl
    reports only the last /d1reportSingleClassLayout it is given)."""
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


def ts_classes():
    """{class: (base or None, [method name, ...])} for the @cppvtable classes in core/nvrhi.ts."""
    text = open(BINDINGS, encoding="utf-8").read()
    classes = {}
    for m in re.finditer(r"@cppvtable\s+export\s+class\s+(\w+)(?:\s+extends\s+(\w+))?\s*\{(.*?)\n    \}", text, re.S):
        name, base, body = m.group(1), m.group(2), m.group(3)
        methods = re.findall(r"^\s+(\w+)\s*\(", body, re.M)
        classes[name] = (base, methods)
    return classes


def main():
    classes = ts_classes()
    missing = [name for name in CLASSES if name not in classes]
    if missing:
        sys.exit(f"check_nvrhi_slots: no @cppvtable class {', '.join(missing)} in core/nvrhi.ts")

    layouts = cpp_layouts(CLASSES)
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
        overloads = {n for n in cpp if cpp.count(n) > 1}
        if len(slots) != len(cpp):
            problems.append(f"{name}: {len(slots)} slots, nvrhi::{name} has {len(cpp)}")
        for slot, cpp_name in enumerate(cpp):
            ts_name = slots[slot] if slot < len(slots) else "(none)"
            if cpp_name == "{dtor}":
                wanted = ["_destructor"]
            elif cpp_name in overloads:
                wanted = [f"_{cpp_name}_{slot}"]
            else:
                wanted = [cpp_name, "_" + cpp_name]
            if ts_name not in wanted:
                problems.append(f"{name} slot {slot}: '{ts_name}', nvrhi::{name} has {cpp_name} "
                                f"(expected {' or '.join(wanted)})")

    if problems:
        print("\n".join(problems))
        return 1
    print(f"core/nvrhi.ts: {len(CLASSES)} classes match NVRHI's vtables "
          f"({', '.join(f'{name} {len(layouts[name])}' for name in CLASSES)} slots)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
