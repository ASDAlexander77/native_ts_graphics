"""Packages an example built for Android as an APK: lib<name>.so in a NativeActivity app, with the
shaders and media it reads (see core/android_main.cpp), signed with a debug key.

Run by the <example>_apk targets (CMakeLists.txt); with the SDK's build tools, no Gradle:

    python tools/package_apk.py --name basic_triangle --lib libbasic_triangle.so --abi x86_64
        --assets bin/shaders/framework=shaders/framework --assets bin/shaders/basic_triangle=shaders/basic_triangle
        --sdk C:/Android/sdk --keystore debug.keystore --out bin/basic_triangle.apk

1. the assets are staged with assets.txt, the list core/android_main.cpp extracts by, whose first
   line tells this build from the last one;
2. aapt2 links the manifest (tools/android/AndroidManifest.xml.in) and the assets;
3. the library, and the libraries it loads given with --extra-lib (an NRI example's
   libnri_interop.so), go in stripped (with --strip) and uncompressed (the manifest has
   extractNativeLibs="false"), and zipalign aligns them to 16 KiB pages;
4. apksigner signs it with the debug keystore, made by the JDK's keytool if there is none.

For a store (--release): not debuggable, the app's label, version, icon (--res, --icon) and the
manifest's further attributes, signed with the release keystore (--keystore, --key-alias; its
passwords from the environment variables --store-pass-env and --key-pass-env name, never on the
command line), and with --bundle an Android App Bundle (.aab, what Google Play takes) too, built by
bundletool (--bundletool, fetched if it isn't there) and signed by the JDK's jarsigner; with
--symbols the libraries' debug symbols zipped for the store's crash reports.
"""

import argparse
import glob
import os
import shutil
import subprocess
import sys
import time
import urllib.request
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MANIFEST_TEMPLATE = os.path.join(ROOT, "tools", "android", "AndroidManifest.xml.in")

# the SDK's debug signing conventions
KEY_ALIAS = "androiddebugkey"
KEY_PASSWORD = "android"

BUNDLETOOL_VERSION = "1.18.1"
BUNDLETOOL_URL = (f"https://github.com/google/bundletool/releases/download/{BUNDLETOOL_VERSION}/"
                  f"bundletool-all-{BUNDLETOOL_VERSION}.jar")


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
    # The APK targets build in parallel, and each makes it if it isn't there: make it under another
    # name and link it into place, which fails for all but the first, so all sign with that one.
    made = f"{keystore}.{os.getpid()}"
    run([keytool, "-genkeypair", "-keystore", made, "-storepass", KEY_PASSWORD, "-keypass", KEY_PASSWORD,
         "-alias", KEY_ALIAS, "-keyalg", "RSA", "-keysize", "2048", "-validity", "10000",
         "-dname", "CN=Android Debug,O=Android,C=US"], env=env)
    try:
        os.link(made, keystore)
    except FileExistsError:
        pass
    os.remove(made)


def java_tool(env, name):
    tool = shutil.which(name, path=env["PATH"])
    if not tool:
        fail(f"no {name}: pass --java-home (a JDK)")
    return tool


def password_env(name):
    """The name of an environment variable holding a password, checked to be set."""
    if not name or not os.environ.get(name):
        fail(f"set the environment variable {name or '(none given)'} to the keystore's password")
    return name


def fetch_bundletool(path):
    if os.path.isfile(path):
        return path
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    print(f"package_apk: fetching bundletool {BUNDLETOOL_VERSION} ({BUNDLETOOL_URL})")
    partial = path + ".part"
    urllib.request.urlretrieve(BUNDLETOOL_URL, partial)
    os.replace(partial, path)
    return path


def build_bundle(args, env, aapt2, link_args, libraries, work):
    """The App Bundle: aapt2's proto-format link of the same manifest, resources and assets, its
    entries laid out as bundletool's base module with the libraries, built into an .aab and signed."""
    proto = os.path.join(work, "proto.zip")
    run([aapt2, "link", "--proto-format", "-o", proto] + link_args)
    module = os.path.join(work, "base.zip")
    with zipfile.ZipFile(proto) as source, zipfile.ZipFile(module, "w", zipfile.ZIP_DEFLATED) as base:
        for entry in source.infolist():
            name = entry.filename
            if name == "AndroidManifest.xml":
                name = "manifest/AndroidManifest.xml"
            base.writestr(name, source.read(entry))
        for packaged, library in libraries.items():
            base.write(library, f"lib/{args.abi}/{packaged}")
    bundletool = fetch_bundletool(args.bundletool or os.path.join(work, f"bundletool-{BUNDLETOOL_VERSION}.jar"))
    unsigned = os.path.join(work, "unsigned.aab")
    if os.path.isfile(unsigned):
        os.remove(unsigned)
    run([java_tool(env, "java"), "-jar", bundletool, "build-bundle", f"--modules={module}",
         f"--output={unsigned}"], env=env)
    signed = os.path.join(work, "signed.aab")
    shutil.copyfile(unsigned, signed)
    run([java_tool(env, "jarsigner"), "-keystore", args.keystore,
         "-storepass:env", password_env(args.store_pass_env), "-keypass:env", password_env(args.key_pass_env),
         "-sigalg", "SHA256withRSA", "-digestalg", "SHA-256", signed, args.key_alias], env=env)
    os.makedirs(os.path.dirname(os.path.abspath(args.bundle)), exist_ok=True)
    shutil.copyfile(signed, args.bundle)
    print(f"package_apk: {args.bundle}")


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


def default_package(name):
    """org.native_ts_graphics.<name>; a part of a package name has to start with a letter, so a name
    that doesn't (16bit_arithmetic) is example_<name>. tools/android.py's package_of is the same."""
    return "org.native_ts_graphics." + (name if name[:1].isalpha() else "example_" + name)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--name", required=True, help="the example: lib<name>.so, the app's label")
    parser.add_argument("--package", help="the application ID (default: org.native_ts_graphics.<name>)")
    parser.add_argument("--lib", required=True, help="the example's shared library")
    parser.add_argument("--extra-lib", action="append", default=[], metavar="LIB",
                        help="a shared library the example's loads, packaged next to it under its own name")
    parser.add_argument("--abi", required=True, help="its Android ABI: arm64-v8a, armeabi-v7a or x86_64")
    parser.add_argument("--assets", action="append", default=[], metavar="SOURCE=PATH",
                        help="a file or folder to package, and its path among the assets")
    parser.add_argument("--sdk", required=True, help="the Android SDK")
    parser.add_argument("--java-home", help="a JDK, for apksigner and keytool (default: JAVA_HOME)")
    parser.add_argument("--min-sdk", default="29")
    parser.add_argument("--target-sdk", default="29")
    parser.add_argument("--keystore", required=True, help="the debug keystore, made if it isn't there "
                                                          "(with --release: the release keystore)")
    parser.add_argument("--label", help="the app's name on the launcher (default: --name)")
    parser.add_argument("--version-code", default="1", help="the version's number (one more each release)")
    parser.add_argument("--version-name", default="1.0", help="the version users see")
    parser.add_argument("--res", help="a resources folder (res/: drawable, mipmap-anydpi-v26, ...)")
    parser.add_argument("--icon", help="the launcher icon among them (@mipmap/ic_launcher)")
    parser.add_argument("--app-category", help="the store's category hint (game, audio, ...)")
    parser.add_argument("--vulkan-version", help="the Vulkan version the device must have (0x402000: 1.2)")
    parser.add_argument("--release", action="store_true", help="for a store: not debuggable, release-signed")
    parser.add_argument("--key-alias", default=KEY_ALIAS, help="the release key's alias")
    parser.add_argument("--store-pass-env", help="the environment variable with the keystore's password")
    parser.add_argument("--key-pass-env", help="the environment variable with the key's password")
    parser.add_argument("--bundle", help="an Android App Bundle (.aab) to make as well")
    parser.add_argument("--bundletool", help="bundletool's jar (fetched there if it isn't)")
    parser.add_argument("--symbols", help="a zip of the libraries' debug symbols (unstripped), for the store")
    parser.add_argument("--strip", help="llvm-strip, to package the library without its debug info "
                                        "(the build's copy keeps it, for symbolizing crashes)")
    parser.add_argument("--work", help="the folder to build it in (default: next to --out)")
    parser.add_argument("--out", required=True, help="the APK")
    args = parser.parse_args()

    package = args.package or default_package(args.name)
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
    application = ""
    if args.icon:
        application += f'\n        android:icon="{args.icon}"\n        android:roundIcon="{args.icon}"'
    if args.app_category:
        application += f'\n        android:appCategory="{args.app_category}"'
    if args.release:
        application += '\n        android:allowBackup="false"'
    features = ""
    if args.vulkan_version:
        features = (f'    <uses-feature android:name="android.hardware.vulkan.version" '
                    f'android:version="{args.vulkan_version}" android:required="true" />')
    for key, value in {"@PACKAGE@": package, "@NAME@": args.name, "@LABEL@": args.label or args.name,
                       "@VERSION_CODE@": args.version_code, "@VERSION_NAME@": args.version_name,
                       "@USES_FEATURES@": features, "@APPLICATION_ATTRIBUTES@": application,
                       "@MIN_SDK@": args.min_sdk, "@TARGET_SDK@": args.target_sdk}.items():
        manifest = manifest.replace(key, value)
    manifest_path = os.path.join(work, "AndroidManifest.xml")
    with open(manifest_path, "w", encoding="utf-8", newline="\n") as file:
        file.write(manifest)

    link_args = ["--manifest", manifest_path, "-I", android_jar, "-A", assets_folder]
    if args.res:
        compiled = os.path.join(work, "res.zip")
        run([aapt2, "compile", "--dir", args.res, "-o", compiled])
        link_args += ["-R", compiled, "--auto-add-overlay"]
    if not args.release:
        link_args.append("--debug-mode")
    base = os.path.join(work, "base.apk")
    run([aapt2, "link", "-o", base] + link_args)

    # each library under its name in the APK, stripped if asked
    libraries = {}
    for source, packaged in [(args.lib, f"lib{args.name}.so")] + [(lib, os.path.basename(lib)) for lib in args.extra_lib]:
        library = source
        if args.strip:
            library = os.path.join(work, packaged)
            run([args.strip, "--strip-unneeded", "-o", library, source])
        libraries[packaged] = library

    # aapt2 has no say over native libraries: copy its entries as they are and add the library
    unaligned = os.path.join(work, "unaligned.apk")
    with zipfile.ZipFile(base) as source, zipfile.ZipFile(unaligned, "w") as apk:
        for entry in source.infolist():
            apk.writestr(entry, source.read(entry), compress_type=entry.compress_type)
        for packaged, library in libraries.items():
            apk.write(library, f"lib/{args.abi}/{packaged}", compress_type=zipfile.ZIP_STORED)

    aligned = os.path.join(work, "aligned.apk")
    run([zipalign, "-f", "-P", "16", "4", unaligned, aligned])

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    if args.release:
        if not os.path.isfile(args.keystore):
            fail(f"no release keystore {args.keystore}: make it with the JDK's keytool (see "
                 "powder_sandbox/store/README.md), and keep it: every update must be signed with it")
        run([apksigner, "sign", "--ks", args.keystore, "--ks-key-alias", args.key_alias,
             "--ks-pass", f"env:{password_env(args.store_pass_env)}",
             "--key-pass", f"env:{password_env(args.key_pass_env)}",
             "--out", args.out, aligned], env=env)
    else:
        if not os.path.isfile(args.keystore):
            make_debug_keystore(args.keystore, args.java_home, env)
        run([apksigner, "sign", "--ks", args.keystore, "--ks-key-alias", KEY_ALIAS,
             "--ks-pass", f"pass:{KEY_PASSWORD}", "--key-pass", f"pass:{KEY_PASSWORD}",
             "--out", args.out, aligned], env=env)

    if args.bundle:
        build_bundle(args, env, aapt2, link_args, libraries, work)

    if args.symbols:
        os.makedirs(os.path.dirname(os.path.abspath(args.symbols)), exist_ok=True)
        with zipfile.ZipFile(args.symbols, "w", zipfile.ZIP_DEFLATED) as symbols:
            for source, packaged in [(args.lib, f"lib{args.name}.so")] + [(lib, os.path.basename(lib)) for lib in args.extra_lib]:
                symbols.write(source, f"{args.abi}/{packaged}")
        print(f"package_apk: {args.symbols}")

    print(f"package_apk: {args.out} ({package}, {len(files)} assets)")


if __name__ == "__main__":
    main()
