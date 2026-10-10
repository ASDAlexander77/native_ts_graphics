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
