"""Fetches the media of the external sample repositories the examples use (tools/media.json:
for each CMake variable, the repository, the commit and the paths the build reads), as sparse,
blob-less clones of just those paths, Git LFS objects included, and prints the CMake variables
for them.

    python tools/fetch_media.py <folder>

The folder keeps a clone per repository: a later run at the same commit and paths does nothing.
Regenerate media.json with tools/media_manifest.py after changing what the build copies.
"""
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def git(cwd, *args):
    subprocess.run(["git", *args], cwd=cwd, check=True)


def fetch(folder, name, repo):
    path = os.path.join(folder, name)
    stamp = os.path.join(path, ".fetched")
    key = repo["commit"] + "\n" + "\n".join(repo["paths"])
    if os.path.exists(stamp) and open(stamp).read() == key:
        print(f"fetch_media: {name} up to date", flush=True)
        return path

    os.makedirs(path, exist_ok=True)
    if not os.path.isdir(os.path.join(path, ".git")):
        git(path, "init", "-q")
        git(path, "remote", "add", "origin", repo["url"])
    git(path, "config", "core.sparseCheckout", "true")
    # DirectX-Graphics-Samples' paths go past Windows' MAX_PATH under most folders.
    git(path, "config", "core.longpaths", "true")
    # Without LFS's smudge filter on checkout: `git lfs pull` gets just the paths' objects after.
    env = dict(os.environ, GIT_LFS_SKIP_SMUDGE="1")
    # Folders end with /: everything under them.
    subprocess.run(["git", "sparse-checkout", "set", "--no-cone", *["/" + p for p in repo["paths"]]],
                   cwd=path, check=True, env=env)
    subprocess.run(["git", "fetch", "-q", "--depth", "1", "--filter=blob:none", "origin", repo["commit"]],
                   cwd=path, check=True, env=env)
    subprocess.run(["git", "checkout", "-q", "--force", "FETCH_HEAD"], cwd=path, check=True, env=env)
    if subprocess.run(["git", "lfs", "version"], cwd=path, capture_output=True).returncode == 0:
        git(path, "lfs", "pull", "--include", ",".join(p + "**" if p.endswith("/") else p for p in repo["paths"]))
    with open(stamp, "w") as f:
        f.write(key)
    print(f"fetch_media: {name} at {repo['commit'][:10]}, {len(repo['paths'])} paths", flush=True)
    return path


def main():
    folder = os.path.abspath(sys.argv[1])
    manifest = json.load(open(os.path.join(ROOT, "tools", "media.json")))
    defines = []
    for variable, repo in manifest.items():
        path = os.path.join(fetch(folder, variable.lower(), repo), repo.get("folder", ""))
        defines.append(f"-D{variable}={os.path.normpath(path).replace(os.sep, '/')}")
    print(" ".join(defines))


if __name__ == "__main__":
    main()
