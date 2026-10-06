"""Packages an example built for Android as an APK: lib<name>.so in a NativeActivity app, with the
shaders and media it reads (see core/android_main.cpp), signed with a debug key.

Run by the <example>_apk targets (CMakeLists.txt); with the SDK's build tools, no Gradle:

    python tools/package_apk.py --name basic_triangle --lib libbasic_triangle.so --abi x86_64
        --assets bin/shaders/framework=shaders/framework --assets bin/shaders/basic_triangle=shaders/basic_triangle
        --sdk C:/Android/sdk --keystore debug.keystore --out bin/basic_triangle.apk

1. the assets are staged with assets.txt, the list core/android_main.cpp extracts by, whose first
   line tells this build from the last one;
2. aapt2 links the manifest (tools/android/AndroidManifest.xml.in) and the assets;
3. the library goes in stripped (with --strip) and uncompressed (the manifest has
   extractNativeLibs="false"), and zipalign aligns it to 16 KiB pages;
4. apksigner signs it with the debug keystore, made by the JDK's keytool if there is none.
"""

import argparse
import glob
import os
import shutil
import subprocess
import sys
import time
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MANIFEST_TEMPLATE = os.path.join(ROOT, "tools", "android", "AndroidManifest.xml.in")

# the SDK's debug signing conventions
KEY_ALIAS = "androiddebugkey"
KEY_PASSWORD = "android"


def fail(message):
    print(f"package_apk: error: {message}", file=sys.stderr)
    sys.exit(1)


def run(command, env=None):
    result = subprocess.run(command, env=env)
    if result.returncode != 0:
        fail(f"{os.path.basename(command[0])} failed with exit code {result.returncode}")


def version_key(path):
    """Sorts build-tools/35.0.0 and platforms/android-34 by their numbers."""
    name = os.path.basename(path).replace("android-", "")
    return [int(part) if part.isdigit() else 0 for part in name.split(".")]


def find_build_tool(sdk, name):
    candidates = []
    for folder in sorted(glob.glob(os.path.join(sdk, "build-tools", "*")), key=version_key, reverse=True):
        for suffix in ("", ".exe", ".bat"):
            path = os.path.join(folder, name + suffix)
            if os.path.isfile(path):
                candidates.append(path)
                break
    if not candidates:
        fail(f"no {name} in {sdk}/build-tools: install the SDK's build tools")
    return candidates[0]


def find_platform_jar(sdk, target_sdk):
    jar = os.path.join(sdk, "platforms", f"android-{target_sdk}", "android.jar")
    if not os.path.isfile(jar):
        fail(f"no {jar}: install the SDK platform {target_sdk} or pass another --target-sdk")
    return jar


def java_environment(java_home):
    env = dict(os.environ)
    if java_home:
        env["JAVA_HOME"] = java_home
        env["PATH"] = os.path.join(java_home, "bin") + os.pathsep + env.get("PATH", "")
    return env


def make_debug_keystore(keystore, java_home, env):
    keytool = shutil.which("keytool", path=env["PATH"])
    if not keytool:
        fail("no keytool to make a debug keystore with: pass --java-home (a JDK)")
    os.makedirs(os.path.dirname(os.path.abspath(keystore)), exist_ok=True)
    run([keytool, "-genkeypair", "-keystore", keystore, "-storepass", KEY_PASSWORD, "-keypass", KEY_PASSWORD,
         "-alias", KEY_ALIAS, "-keyalg", "RSA", "-keysize", "2048", "-validity", "10000",
         "-dname", "CN=Android Debug,O=Android,C=US"], env=env)


def stage_assets(assets, folder):
    """Copies each source=destination file or folder into the staging folder; returns their file
    list."""
    files = []
    for spec in assets:
        source, _, destination = spec.partition("=")
        if os.path.isfile(source):
            target = os.path.join(folder, destination)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            shutil.copyfile(source, target)
            files.append(destination.replace("\\", "/"))
            continue
        if not os.path.isdir(source):
            fail(f"no file or folder {source} to package")
        for directory, _, names in os.walk(source):
            for name in sorted(names):
                path = os.path.join(directory, name)
                relative = os.path.join(destination, os.path.relpath(path, source)).replace("\\", "/")
                target = os.path.join(folder, relative)
                os.makedirs(os.path.dirname(target), exist_ok=True)
                shutil.copyfile(path, target)
                files.append(relative)
    return files


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--name", required=True, help="the example: lib<name>.so, the app's label")
    parser.add_argument("--package", help="the application ID (default: org.powdertoy_game.<name>)")
    parser.add_argument("--lib", required=True, help="the example's shared library")
    parser.add_argument("--abi", required=True, help="its Android ABI: arm64-v8a or x86_64")
    parser.add_argument("--assets", action="append", default=[], metavar="SOURCE=PATH",
                        help="a file or folder to package, and its path among the assets")
    parser.add_argument("--sdk", required=True, help="the Android SDK")
    parser.add_argument("--java-home", help="a JDK, for apksigner and keytool (default: JAVA_HOME)")
    parser.add_argument("--min-sdk", default="29")
    parser.add_argument("--target-sdk", default="29")
    parser.add_argument("--keystore", required=True, help="the debug keystore, made if it isn't there")
    parser.add_argument("--strip", help="llvm-strip, to package the library without its debug info "
                                        "(the build's copy keeps it, for symbolizing crashes)")
    parser.add_argument("--work", help="the folder to build it in (default: next to --out)")
    parser.add_argument("--out", required=True, help="the APK")
    args = parser.parse_args()

    package = args.package or f"org.powdertoy_game.{args.name}"
    work = args.work or os.path.splitext(args.out)[0] + "_apk"
    env = java_environment(args.java_home)

    aapt2 = find_build_tool(args.sdk, "aapt2")
    zipalign = find_build_tool(args.sdk, "zipalign")
    apksigner = find_build_tool(args.sdk, "apksigner")
    android_jar = find_platform_jar(args.sdk, args.target_sdk)

    if os.path.isdir(work):
        shutil.rmtree(work)
    assets_folder = os.path.join(work, "assets")
    os.makedirs(assets_folder)

    files = stage_assets(args.assets, assets_folder)
    with open(os.path.join(assets_folder, "assets.txt"), "w", newline="\n") as listing:
        listing.write(f"{args.name} {time.time_ns()}\n")
        for path in files:
            listing.write(path + "\n")

    with open(MANIFEST_TEMPLATE, encoding="utf-8") as template:
        manifest = template.read()
    for key, value in {"@PACKAGE@": package, "@NAME@": args.name, "@LABEL@": args.name,
                       "@MIN_SDK@": args.min_sdk, "@TARGET_SDK@": args.target_sdk}.items():
        manifest = manifest.replace(key, value)
    manifest_path = os.path.join(work, "AndroidManifest.xml")
    with open(manifest_path, "w", encoding="utf-8", newline="\n") as file:
        file.write(manifest)

    base = os.path.join(work, "base.apk")
    run([aapt2, "link", "-o", base, "--manifest", manifest_path, "-I", android_jar, "-A", assets_folder,
         "--debug-mode"])

    library = args.lib
    if args.strip:
        library = os.path.join(work, f"lib{args.name}.so")
        run([args.strip, "--strip-unneeded", "-o", library, args.lib])

    # aapt2 has no say over native libraries: copy its entries as they are and add the library
    unaligned = os.path.join(work, "unaligned.apk")
    with zipfile.ZipFile(base) as source, zipfile.ZipFile(unaligned, "w") as apk:
        for entry in source.infolist():
            apk.writestr(entry, source.read(entry), compress_type=entry.compress_type)
        apk.write(library, f"lib/{args.abi}/lib{args.name}.so", compress_type=zipfile.ZIP_STORED)

    aligned = os.path.join(work, "aligned.apk")
    run([zipalign, "-f", "-P", "16", "4", unaligned, aligned])

    if not os.path.isfile(args.keystore):
        make_debug_keystore(args.keystore, args.java_home, env)

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    run([apksigner, "sign", "--ks", args.keystore, "--ks-key-alias", KEY_ALIAS,
         "--ks-pass", f"pass:{KEY_PASSWORD}", "--key-pass", f"pass:{KEY_PASSWORD}",
         "--out", args.out, aligned], env=env)

    print(f"package_apk: {args.out} ({package}, {len(files)} assets)")


if __name__ == "__main__":
    main()
