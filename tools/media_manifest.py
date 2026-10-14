"""Writes tools/media.json, which tools/fetch_media.py fetches on a machine without the sample
repositories (a CI runner, a new checkout): for each external sample repository the build reads
media from (VULKAN_SAMPLES_ASSETS_DIR, DIRECTX_GRAPHICS_SAMPLES_DIR, XBOX_ATG_SAMPLES_DIR), its
origin, the commit checked out and the files and folders (with a trailing /) the build reads, from
a configured build folder whose cache has those variables.

    python tools/media_manifest.py [build folder, default build]
"""
import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VARIABLES = ["VULKAN_SAMPLES_ASSETS_DIR", "DIRECTX_GRAPHICS_SAMPLES_DIR", "XBOX_ATG_SAMPLES_DIR"]


def git(cwd, *args):
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()


def main():
    build = os.path.join(ROOT, sys.argv[1] if len(sys.argv) > 1 else "build")
    cache = open(os.path.join(build, "CMakeCache.txt"), encoding="utf-8").read()
    ninja = open(os.path.join(build, "build.ninja"), encoding="utf-8", errors="replace").read()
    manifest = {}
    for variable in VARIABLES:
        m = re.search(rf"^{variable}:PATH=(.+)$", cache, re.M)
        if not m or not m.group(1).strip():
            sys.exit(f"media_manifest: {variable} isn't set in {build}")
        folder = m.group(1).strip().replace("\\", "/").rstrip("/") + "/"
        # The repository's root, which the folder may be inside (Vulkan-Samples' assets).
        top = git(folder, "rev-parse", "--show-toplevel").replace("\\", "/").rstrip("/") + "/"
        prefix = folder[len(top):] if folder.lower().startswith(top.lower()) else ""
        paths = set()
        for path in re.findall(re.escape(folder) + r"[^\s\"$|]+", ninja, re.I):
            rel = path[len(folder):]
            paths.add(rel + "/" if os.path.isdir(path) else rel)
        manifest[variable] = {
            "url": git(folder, "remote", "get-url", "origin"),
            "commit": git(folder, "rev-parse", "HEAD"),
            # In the repository (prefix): the variable is the folder within it.
            "folder": prefix.rstrip("/"),
            "paths": sorted(prefix + p for p in paths),
        }
        print(f"{variable}: {len(paths)} paths")
    with open(os.path.join(ROOT, "tools", "media.json"), "w", newline="\n") as f:
        json.dump(manifest, f, indent=1)
        f.write("\n")


if __name__ == "__main__":
    main()
