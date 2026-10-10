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
    "App": "AppHandle",
    "FrameContext": "FrameHandle",
    "TsRenderPass": "PassHandle",
    "AdapterList": "AdapterListHandle",
    "nvrhi::IResource": "ResourceHandle",
    "nvrhi::ICommandList": "CommandListHandle",
    "nvrhi::IBuffer": "BufferHandle",
    "nvrhi::ITexture": "TextureHandle",
    "nvrhi::IStagingTexture": "StagingTextureHandle",
    "nvrhi::ISampler": "SamplerHandle",
    "nvrhi::IHeap": "HeapHandle",
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
