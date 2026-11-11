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

--abi-libs adds another ABI's build of the same app (the list add_tslang_android_release writes in
each Android build folder: its ABI, then lib<name>.so and the libraries it loads), so one APK and one
bundle carry both (arm64-v8a and x86_64): the store hands each device its own.

--gradle <module> packages an app with Java code (Powder Sandbox's support ads, powder_sandbox/android)
with that Gradle module instead of aapt2: the assets and the stripped libraries are staged the same
way, with the app's settings in build.properties, and Gradle (fetched to --gradle-home) builds the
APK, and for --release the bundle too, signed as above. Its AdMob IDs are Google's test IDs, or for a
release POWDER_ADMOB_APP_ID and POWDER_ADMOB_REWARDED_ID's.
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

GRADLE_VERSION = "8.13"
GRADLE_URL = f"https://services.gradle.org/distributions/gradle-{GRADLE_VERSION}-bin.zip"

# Google's published test IDs (https://developers.google.com/admob/android/test-ads): what the
# Gradle-packaged debug builds always show, and a release built without the real ones.
ADMOB_TEST_APP_ID = "ca-app-pub-3940256099942544~3347511713"
ADMOB_TEST_REWARDED_ID = "ca-app-pub-3940256099942544/5224354917"

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


def fetch_gradle(folder):
    """A Gradle distribution unpacked in the folder (fetched once); returns its gradle launcher."""
    home = os.path.join(folder, f"gradle-{GRADLE_VERSION}")
    launcher = os.path.join(home, "bin", "gradle.bat" if os.name == "nt" else "gradle")
    if os.path.isfile(launcher):
        return launcher
    os.makedirs(folder, exist_ok=True)
    print(f"package_apk: fetching Gradle {GRADLE_VERSION} ({GRADLE_URL})")
    partial = os.path.join(folder, f"gradle-{GRADLE_VERSION}-bin.zip.part")
    urllib.request.urlretrieve(GRADLE_URL, partial)
    with zipfile.ZipFile(partial) as archive:
        archive.extractall(folder)
    os.remove(partial)
    if os.name != "nt":
        os.chmod(launcher, 0o755)
    return launcher


def admob_ids(release):
    """The AdMob app and rewarded ad unit IDs: Google's test IDs, except for a release given the
    real ones in POWDER_ADMOB_APP_ID and POWDER_ADMOB_REWARDED_ID (never in the repository)."""
    if not release:
        return ADMOB_TEST_APP_ID, ADMOB_TEST_REWARDED_ID, False
    app_id = os.environ.get("POWDER_ADMOB_APP_ID", "").strip()
    rewarded_id = os.environ.get("POWDER_ADMOB_REWARDED_ID", "").strip()
    if app_id and rewarded_id:
        return app_id, rewarded_id, True
    print("package_apk: WARNING: POWDER_ADMOB_APP_ID / POWDER_ADMOB_REWARDED_ID not set - "
          "this release shows Google's TEST ads", flush=True)
    return ADMOB_TEST_APP_ID, ADMOB_TEST_REWARDED_ID, False


def build_with_gradle(args, env, package, assets_folder, libraries, work):
    """The app packaged by the Gradle module in --gradle (powder_sandbox/android): the staged assets
    and the stripped libraries in its input folder with build.properties, then Gradle's APK (and,
    for a release, its bundle) copied to --out (and --bundle)."""
    input_folder = os.path.join(work, "gradle-input")
    os.makedirs(input_folder)
    shutil.move(assets_folder, os.path.join(input_folder, "assets"))
    for abi, packaged, _, library in libraries:
        target = os.path.join(input_folder, "jniLibs", abi, packaged)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        shutil.copyfile(library, target)
    app_id, rewarded_id, _ = admob_ids(args.release)
    settings = {
        "package": package, "libName": args.name, "label": args.label or args.name,
        "versionCode": args.version_code, "versionName": args.version_name,
        "minSdk": args.min_sdk, "targetSdk": args.target_sdk,
        "vulkanVersion": args.vulkan_version or "0x401000", "appCategory": args.app_category or "game",
        "admobAppId": app_id, "admobRewardedId": rewarded_id,
        "keystore": os.path.abspath(args.keystore).replace("\\", "/"),
    }
    if args.release:
        settings.update(keyAlias=args.key_alias, storePassEnv=password_env(args.store_pass_env),
                        keyPassEnv=password_env(args.key_pass_env))
    else:
        settings.update(keyAlias=KEY_ALIAS, storePass=KEY_PASSWORD, keyPass=KEY_PASSWORD)
    with open(os.path.join(input_folder, "build.properties"), "w", encoding="utf-8", newline="\n") as file:
        for key, value in settings.items():
            # a .properties file: backslashes and colons escaped
            file.write(f"{key}={str(value).replace(chr(92), chr(92) * 2).replace(':', chr(92) + ':')}\n")

    gradle_env = dict(env)
    gradle_env["ANDROID_HOME"] = args.sdk
    gradle_env.pop("ANDROID_SDK_ROOT", None)
    gradle = fetch_gradle(args.gradle_home or os.path.join(work, "gradle"))
    build_folder = os.path.join(work, "gradle-build")
    tasks = ["bundleRelease", "assembleRelease"] if args.release else ["assembleDebug"]
    if args.gradle_test:
        tasks.insert(0, "testDebugUnitTest")
    run([gradle, "--no-daemon", "--console=plain", "-p", args.gradle,
         "--project-cache-dir", os.path.join(work, "gradle-cache"),
         f"-PpowderInput={input_folder}", f"-PpowderBuildDir={build_folder}"] + tasks, env=gradle_env)

    variant = "release" if args.release else "debug"
    apk = os.path.join(build_folder, "outputs", "apk", variant, f"{os.path.basename(args.gradle.rstrip('/'))}-{variant}.apk")
    found = glob.glob(os.path.join(build_folder, "outputs", "apk", variant, "*.apk"))
    if not os.path.isfile(apk) and len(found) == 1:
        apk = found[0]
    if not os.path.isfile(apk):
        fail(f"Gradle made no {variant} APK in {os.path.dirname(apk)}")
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    shutil.copyfile(apk, args.out)
    if args.bundle:
        bundles = glob.glob(os.path.join(build_folder, "outputs", "bundle", variant, "*.aab"))
        if len(bundles) != 1:
            fail(f"Gradle made no single {variant} bundle in {build_folder}/outputs/bundle/{variant}")
        os.makedirs(os.path.dirname(os.path.abspath(args.bundle)), exist_ok=True)
        shutil.copyfile(bundles[0], args.bundle)
        print(f"package_apk: {args.bundle}")


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
        for abi, packaged, _, library in libraries:
            base.write(library, f"lib/{abi}/{packaged}")
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


def read_abi_libs(path, name, abi):
    """Another build's libraries of the app, from the list add_tslang_android_release writes: its
    ABI on the first line, then lib<name>.so and the libraries it loads."""
    if not os.path.isfile(path):
        fail(f"no {path}: configure and build {name}_apk in that Android build folder first")
    with open(path, encoding="utf-8") as listing:
        lines = [line.strip() for line in listing if line.strip()]
    if len(lines) < 2:
        fail(f"{path} lists no libraries")
    other_abi, libs = lines[0], lines[1:]
    if other_abi == abi:
        fail(f"{path} is the {abi} build's own list: name another ABI's build folder")
    for lib in libs:
        if not os.path.isfile(lib):
            fail(f"no {lib}: build {name}_apk in the {other_abi} build folder first")
    return other_abi, libs


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
    parser.add_argument("--abi-libs", action="append", default=[], metavar="LIST",
                        help="another ABI's libraries of the app to package too: the list file "
                             "add_tslang_android_release writes (its ABI, then the libraries)")
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
    parser.add_argument("--gradle", help="package with this Gradle module instead of aapt2 (powder_sandbox/android: "
                                         "the app with Java code, its ads)")
    parser.add_argument("--gradle-home", help="the folder Gradle's distribution is fetched to and kept in")
    parser.add_argument("--gradle-test", action="store_true", help="run the module's unit tests first")
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

    if args.gradle:
        libraries = prepare_libraries(args, work)
        build_with_gradle(args, env, package, assets_folder, libraries, work)
        finish(args, package if args.release else package + ".debug", libraries, files)
        return

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

    libraries = prepare_libraries(args, work)

    # aapt2 has no say over native libraries: copy its entries as they are and add the library
    unaligned = os.path.join(work, "unaligned.apk")
    with zipfile.ZipFile(base) as source, zipfile.ZipFile(unaligned, "w") as apk:
        for entry in source.infolist():
            apk.writestr(entry, source.read(entry), compress_type=entry.compress_type)
        for abi, packaged, _, library in libraries:
            apk.write(library, f"lib/{abi}/{packaged}", compress_type=zipfile.ZIP_STORED)

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

    finish(args, package, libraries, files)


def prepare_libraries(args, work):
    """Each library under its ABI and name in the APK, stripped if asked: (abi, name, source, packaged copy)."""
    sources = [(args.abi, f"lib{args.name}.so", args.lib)] + [(args.abi, os.path.basename(lib), lib) for lib in args.extra_lib]
    for listing in args.abi_libs:
        other_abi, libs = read_abi_libs(listing, args.name, args.abi)
        if any(abi == other_abi for abi, _, _ in sources):
            fail(f"{other_abi} is given twice")
        sources += [(other_abi, f"lib{args.name}.so", libs[0])] + [(other_abi, os.path.basename(lib), lib) for lib in libs[1:]]
    libraries = []
    for abi, packaged, source in sources:
        library = source
        if args.strip:
            library = os.path.join(work, abi, packaged)
            os.makedirs(os.path.dirname(library), exist_ok=True)
            run([args.strip, "--strip-unneeded", "-o", library, source])
        libraries.append((abi, packaged, source, library))
    return libraries


def finish(args, package, libraries, files):
    """The symbols zip (--symbols), and the summary line."""
    if args.symbols:
        os.makedirs(os.path.dirname(os.path.abspath(args.symbols)), exist_ok=True)
        with zipfile.ZipFile(args.symbols, "w", zipfile.ZIP_DEFLATED) as symbols:
            for abi, packaged, source, _ in libraries:
                symbols.write(source, f"{abi}/{packaged}")
        print(f"package_apk: {args.symbols}")

    abis = ", ".join(dict.fromkeys(abi for abi, _, _, _ in libraries))
    print(f"package_apk: {args.out} ({package}, {abis}, {len(files)} assets)")


if __name__ == "__main__":
    main()
