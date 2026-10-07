"""Builds the examples for Android and runs them on an emulator or a device.

    python tools/android.py build [--abi x86_64|arm64] [<example>...]
    python tools/android.py emulator [--avd <name>] [--no-window]
    python tools/android.py run <example> [--screenshot <file.png>]
    python tools/android.py headless
    python tools/android.py test [--seconds N] [<example>...]

build      configures the android-<abi> preset if its folder has none, then builds headless and the
           APKs (<example>_apk, all of them if none are named). It finds the NDK for the preset
           (ANDROID_NDK_HOME is set for it if it isn't), and builds the desktop ShaderMake the
           shaders are compiled with first if there is none, in the Visual Studio environment.
emulator   starts an Android Virtual Device unless a device is connected, and waits for it to boot.
run        installs bin/<example>.apk, starts it and follows its log (Ctrl+C stops following, the
           app keeps running); with --screenshot, takes one after --seconds and stops there.
headless   pushes headless and its shaders to /data/local/tmp/native_ts_graphics and runs it.
test       a smoke test: headless, then each example's APK installed and started, alive after
           --seconds, a screenshot, then Back, which has to close it without a crash. Starts an
           emulator if no device is connected. The screenshots and logs go to
           <build folder>/android-test. With no examples, the ones that run on the emulator.

The SDK, the NDK and the AVDs are found from ANDROID_HOME / ANDROID_SDK_ROOT, ANDROID_NDK_HOME,
the android-* build folders' caches, or next to each other; --sdk and --ndk override them.
"""

import argparse
import glob
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IS_WINDOWS = os.name == "nt"
EXE = ".exe" if IS_WINDOWS else ""

ABIS = {"x86_64": "x86_64", "arm64": "arm64-v8a"}

# Examples with an APK target that can't run on Vulkan, which build leaves out.
NOT_ON_VULKAN = {"rt_reflections"}  # D3D12-only, no SPIR-V shaders

# What test runs by default: the examples that run on the emulator's CPU Vulkan (lavapipe), which
# has no ray tracing or mesh shaders.
EMULATOR_EXAMPLES = ["basic_triangle", "vertex_buffer", "deferred_shading", "shader_specializations",
                     "threaded_rendering", "async_compute", "feature_demo"]

REMOTE_FOLDER = "/data/local/tmp/native_ts_graphics"


def fail(message):
    print(f"android: error: {message}", file=sys.stderr)
    sys.exit(1)


def log(message):
    print(f"android: {message}", flush=True)


def run(command, env=None, cwd=None):
    log(" ".join(f'"{part}"' if " " in part else part for part in command))
    result = subprocess.run(command, env=env, cwd=cwd)
    if result.returncode != 0:
        fail(f"{os.path.basename(command[0])} failed with exit code {result.returncode}")


def version_key(path):
    """Sorts android-ndk-r30 after r29 and 35.0.0 after 34.0.0 by their numbers."""
    return [int(number) for number in re.findall(r"\d+", os.path.basename(path))]


def build_folder(abi):
    return os.path.join(ROOT, f"build-android-{abi}")


def read_cache(folder):
    values = {}
    try:
        with open(os.path.join(folder, "CMakeCache.txt"), encoding="utf-8", errors="replace") as cache:
            for line in cache:
                match = re.match(r"([A-Za-z0-9_]+):[A-Z]+=(.*)", line.strip())
                if match:
                    values[match.group(1)] = match.group(2)
    except OSError:
        pass
    return values


def caches():
    return [read_cache(build_folder(abi)) for abi in ABIS]


def is_ndk(path):
    return bool(path) and os.path.isfile(os.path.join(path, "build", "cmake", "android.toolchain.cmake"))


def is_sdk(path):
    return bool(path) and os.path.isdir(os.path.join(path, "platform-tools"))


def find_ndk(given):
    candidates = [given, os.environ.get("ANDROID_NDK_HOME"), os.environ.get("ANDROID_NDK_ROOT"),
                  os.environ.get("ANDROID_NDK")]
    # the one an android-* folder was configured with: its tools are in <ndk>/toolchains/llvm
    for cache in caches():
        tool = cache.get("CMAKE_AR", "")
        if "/toolchains/llvm/" in tool:
            candidates.append(tool.split("/toolchains/llvm/")[0])
    for candidate in candidates:
        if is_ndk(candidate):
            return os.path.normpath(candidate)
    return None


def find_sdk(given, ndk):
    candidates = [given, os.environ.get("ANDROID_HOME"), os.environ.get("ANDROID_SDK_ROOT")]
    candidates += [cache.get("ANDROID_SDK_DIR") for cache in caches()]
    if ndk:
        # as CMakeLists.txt looks: next to the NDK, or the NDK in it (<sdk>/ndk/<version>)
        candidates += [os.path.join(ndk, "..", "sdk"), os.path.join(ndk, "..", "..")]
    home = os.path.expanduser("~")
    candidates += [os.path.join(os.environ.get("LOCALAPPDATA", home), "Android", "Sdk"),
                   os.path.join(home, "Android", "Sdk"), os.path.join(home, "Library", "Android", "sdk")]
    for candidate in candidates:
        if is_sdk(candidate):
            return os.path.normpath(candidate)
    return None


class Tools:
    def __init__(self, args):
        self.ndk = find_ndk(args.ndk)
        self.sdk = find_sdk(args.sdk, self.ndk)
        if not self.ndk and self.sdk:
            # the SDK manager's, or one unpacked next to the SDK
            installed = (glob.glob(os.path.join(self.sdk, "ndk", "*")) +
                         glob.glob(os.path.join(self.sdk, "..", "android-ndk-*")))
            installed = [path for path in installed if is_ndk(path)]
            if installed:
                self.ndk = os.path.normpath(max(installed, key=version_key))
        self.serial = args.serial

    def need_ndk(self):
        if not self.ndk:
            fail("no Android NDK: set ANDROID_NDK_HOME or pass --ndk")
        return self.ndk

    def sdk_tool(self, folder, name):
        if not self.sdk:
            fail("no Android SDK: set ANDROID_HOME or pass --sdk")
        path = os.path.join(self.sdk, folder, name + EXE)
        if not os.path.isfile(path):
            fail(f"no {path}: install the SDK's {folder} package")
        return path

    def adb_command(self, *arguments):
        command = [self.sdk_tool("platform-tools", "adb")]
        if self.serial:
            command += ["-s", self.serial]
        return command + list(arguments)

    def adb(self, *arguments, check=True, capture=True, binary=False):
        result = subprocess.run(self.adb_command(*arguments), capture_output=capture, text=not binary)
        if check and result.returncode != 0:
            output = (result.stdout or "") + (result.stderr or "") if capture and not binary else ""
            fail(f"adb {' '.join(arguments)} failed with exit code {result.returncode}\n{output}".rstrip())
        return result

    def shell(self, command, check=False):
        return self.adb("shell", command, check=check)

    def devices(self):
        output = subprocess.run([self.sdk_tool("platform-tools", "adb"), "devices"],
                                capture_output=True, text=True).stdout
        return [line.split("\t")[0] for line in output.splitlines()[1:] if line.endswith("\tdevice")]

    def have_device(self):
        devices = self.devices()
        if self.serial:
            return self.serial in devices
        if len(devices) > 1:
            fail(f"more than one device connected ({', '.join(devices)}): pass --serial")
        return len(devices) == 1


# --- build -----------------------------------------------------------------------------------

def find_vcvars():
    vswhere = os.path.join(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"),
                           "Microsoft Visual Studio", "Installer", "vswhere.exe")
    if not os.path.isfile(vswhere):
        return None
    installation = subprocess.run([vswhere, "-latest", "-products", "*", "-property", "installationPath"],
                                  capture_output=True, text=True).stdout.strip()
    vcvars = os.path.join(installation, "VC", "Auxiliary", "Build", "vcvars64.bat")
    return vcvars if installation and os.path.isfile(vcvars) else None


def ensure_host_shadermake():
    """The Android build compiles its shaders with ShaderMake from a desktop build (see
    CMakeLists.txt): build the release preset's if there is none."""
    if os.environ.get("DONUT_HOST_SHADERMAKE"):
        return
    for folder in ("build-release", "build"):
        if os.path.isfile(os.path.join(ROOT, folder, "bin", "ShaderMake" + EXE)):
            return
    log("no desktop ShaderMake yet: building the release preset's")
    configure = [] if os.path.isfile(os.path.join(ROOT, "build-release", "CMakeCache.txt")) else \
        ["cmake --preset release"]
    commands = configure + ["cmake --build --preset release --target ShaderMake"]
    if IS_WINDOWS and not shutil.which("cl"):
        # cl only works in the Visual Studio environment
        vcvars = find_vcvars()
        if not vcvars:
            fail("no Visual Studio found to build ShaderMake with: run these in a developer prompt\n  " +
                 "\n  ".join(commands))
        # in a batch file: cmd doesn't take the quotes Python would put around the call's path
        script = os.path.join(tempfile.gettempdir(), f"native_ts_graphics-shadermake-{os.getpid()}.bat")
        with open(script, "w") as file:
            file.write(f'@call "{vcvars}" > nul || exit /b 1\n')
            for command in commands:
                file.write(f"{command} || exit /b 1\n")
        try:
            run(["cmd", "/c", script], cwd=ROOT)
        finally:
            os.remove(script)
    else:
        for command in commands:
            run(command.split(), cwd=ROOT)


def apk_targets(folder):
    """The <example>_apk targets the build folder has."""
    ninja = read_cache(folder).get("CMAKE_MAKE_PROGRAM") or "ninja"
    output = subprocess.run([ninja, "-C", folder, "-t", "targets", "all"], capture_output=True, text=True).stdout
    return sorted({match.group(1) for match in re.finditer(r"^(\w+)_apk:", output, re.MULTILINE)})


def command_build(tools, args):
    environment = dict(os.environ, ANDROID_NDK_HOME=tools.need_ndk())
    folder = build_folder(args.abi)
    preset = f"android-{args.abi}"

    if not os.environ.get("VULKAN_SDK"):
        log("warning: no VULKAN_SDK: the shaders need its DXC")
    ensure_host_shadermake()
    if not os.path.isfile(os.path.join(folder, "CMakeCache.txt")):
        run(["cmake", "--preset", preset], env=environment, cwd=ROOT)

    available = apk_targets(folder)
    if not available:
        fail(f"no *_apk targets in {folder}: is the SDK found (see the configure output)?")
    examples = args.examples or [name for name in available if name not in NOT_ON_VULKAN]
    unknown = [name for name in examples if name not in available]
    if unknown:
        fail(f"no APK target for {', '.join(unknown)}; there are: {', '.join(available)}")

    run(["cmake", "--build", "--preset", preset, "--target", "headless"] + [f"{name}_apk" for name in examples],
        env=environment, cwd=ROOT)
    log(f"APKs in {os.path.join(folder, 'bin')}")


# --- devices ---------------------------------------------------------------------------------

def wait_for_boot(tools, timeout):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if tools.have_device() and tools.shell("getprop sys.boot_completed").stdout.strip() == "1":
            return
        time.sleep(2)
    fail(f"the device didn't finish booting in {timeout} s")


def start_emulator(tools, avd, window, timeout):
    if tools.have_device():
        log("a device is already connected")
        return
    emulator = tools.sdk_tool("emulator", "emulator")
    avds = subprocess.run([emulator, "-list-avds"], capture_output=True, text=True).stdout.split()
    avds = [name for name in avds if not name.startswith("INFO")]
    if not avds:
        fail("no Android Virtual Devices: make one with the SDK's avdmanager or Android Studio")
    if avd and avd not in avds:
        fail(f"no AVD {avd}; there are: {', '.join(avds)}")
    # by default the one with the highest number in its name, the newest API by the usual names
    avd = avd or max(avds, key=version_key)

    command = [emulator, "-avd", avd, "-no-audio", "-no-boot-anim"] + ([] if window else ["-no-window"])
    log(f"starting {avd}")
    output = open(os.path.join(tempfile.gettempdir(), "native_ts_graphics-emulator.log"), "w")
    if IS_WINDOWS:
        subprocess.Popen(command, stdout=output, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                         creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP)
    else:
        subprocess.Popen(command, stdout=output, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                         start_new_session=True)
    wait_for_boot(tools, timeout)
    log(f"{avd} is up (adb emu kill stops it)")


def command_emulator(tools, args):
    start_emulator(tools, args.avd, not args.no_window, args.boot_timeout)


def ensure_device(tools, args):
    if not tools.have_device():
        start_emulator(tools, args.avd, not args.no_window, args.boot_timeout)


# --- apps ------------------------------------------------------------------------------------

def package_of(example):
    return f"org.native_ts_graphics.{example}"


def install(tools, abi, example):
    apk = os.path.join(build_folder(abi), "bin", f"{example}.apk")
    if not os.path.isfile(apk):
        fail(f"no {apk}: build it first (python tools/android.py build --abi {abi} {example})")
    log(f"installing {example}.apk")
    result = tools.adb("install", "-r", apk, check=False)
    if "INSTALL_FAILED_UPDATE_INCOMPATIBLE" in result.stdout + result.stderr:
        # installed from another build folder, signed with its debug key
        log("signed with another key: uninstalling the installed one first")
        tools.adb("uninstall", package_of(example), check=False)
        result = tools.adb("install", apk, check=False)
    if result.returncode != 0:
        fail(f"installing {apk} failed:\n{(result.stdout + result.stderr).strip()}")


def start(tools, example):
    tools.adb("logcat", "-c", check=False)
    tools.adb("shell", "am", "start", "-W", "-n", f"{package_of(example)}/android.app.NativeActivity")


def is_running(tools, example):
    return tools.shell(f"pidof {package_of(example)}").returncode == 0


def screenshot(tools, path):
    data = tools.adb("exec-out", "screencap", "-p", binary=True).stdout
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "wb") as file:
        file.write(data)


def crash_lines(log_text):
    return [line for line in log_text.splitlines()
            if "Fatal signal" in line or "Abort message" in line or "FATAL EXCEPTION" in line]


def command_run(tools, args):
    ensure_device(tools, args)
    install(tools, args.abi, args.example)
    start(tools, args.example)
    if args.screenshot:
        time.sleep(args.seconds)
        if not is_running(tools, args.example):
            print(tools.adb("logcat", "-d", "-s", args.example, "DEBUG", "libc").stdout)
            fail(f"{args.example} isn't running any more")
        screenshot(tools, args.screenshot)
        log(f"screenshot in {args.screenshot}")
        return
    # its output, and the crash dump of a native crash
    try:
        subprocess.run(tools.adb_command("logcat", "-s", args.example, "DEBUG", "libc"))
    except KeyboardInterrupt:
        pass


def run_headless(tools, abi):
    """Pushes headless and its shaders, as they are laid out in bin/, and runs it."""
    binaries = os.path.join(build_folder(abi), "bin")
    executable = os.path.join(binaries, "headless")
    if not os.path.isfile(executable):
        fail(f"no {executable}: build it first (python tools/android.py build --abi {abi})")
    tools.shell(f"rm -rf {REMOTE_FOLDER} && mkdir -p {REMOTE_FOLDER}/shaders", check=True)
    tools.adb("push", executable, f"{REMOTE_FOLDER}/headless")
    for shaders in ("framework", "headless"):
        tools.adb("push", os.path.join(binaries, "shaders", shaders), f"{REMOTE_FOLDER}/shaders/")
    result = tools.shell(f"cd {REMOTE_FOLDER} && chmod +x headless && ./headless")
    print((result.stdout + result.stderr).rstrip())
    return result.returncode == 0 and "Test PASSED" in result.stdout


def command_headless(tools, args):
    ensure_device(tools, args)
    if not run_headless(tools, args.abi):
        fail("headless failed")
    log("headless passed")


def smoke_test(tools, abi, example, seconds, output):
    """Starts the example, checks it's alive after the given time, takes a screenshot, and
    presses Back, which has to close it. Returns the failure, or None."""
    install(tools, abi, example)
    start(tools, example)
    failure = None
    deadline = time.time() + seconds
    while time.time() < deadline:
        time.sleep(1)
        if not is_running(tools, example):
            failure = f"stopped within {seconds} s"
            break
    if not failure:
        screenshot(tools, os.path.join(output, f"{example}.png"))
        tools.shell("input keyevent KEYCODE_BACK")
        deadline = time.time() + 15
        while is_running(tools, example) and time.time() < deadline:
            time.sleep(1)
        if is_running(tools, example):
            failure = "still running 15 s after Back"
            tools.shell(f"am force-stop {package_of(example)}")

    log_text = tools.adb("logcat", "-d", check=False).stdout
    with open(os.path.join(output, f"{example}.log"), "w", encoding="utf-8") as file:
        file.write(log_text)
    crashes = crash_lines(log_text)
    if crashes:
        failure = "crashed: " + crashes[0].strip()
    elif failure:
        # what it printed last, which says why it stopped ("meshlets exited with 1" after the reason)
        printed = [line.split(f" {example}: ", 1)[1] for line in log_text.splitlines() if f" {example}: " in line]
        if printed:
            failure += " (" + " / ".join(printed[-2:]) + ")"
    return failure


def command_test(tools, args):
    ensure_device(tools, args)
    output = os.path.join(build_folder(args.abi), "android-test")
    os.makedirs(output, exist_ok=True)

    results = [("headless", None if run_headless(tools, args.abi) else "failed")]
    for example in args.examples or EMULATOR_EXAMPLES:
        log(f"testing {example}")
        results.append((example, smoke_test(tools, args.abi, example, args.seconds, output)))

    print()
    for name, failure in results:
        print(f"  {'FAIL' if failure else 'ok  '}  {name}{': ' + failure if failure else ''}")
    print(f"\nscreenshots and logs in {output}")
    if any(failure for _, failure in results):
        sys.exit(1)


def main():
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--abi", choices=list(ABIS), default="x86_64",
                        help="x86_64 for the emulator (default), arm64 for devices")
    common.add_argument("--sdk", help="the Android SDK")
    common.add_argument("--ndk", help="the Android NDK")
    common.add_argument("--serial", help="the device to use, as adb devices lists it")
    devices = argparse.ArgumentParser(add_help=False)
    devices.add_argument("--avd", help="the emulator to start if no device is connected "
                                       "(default: the newest by name)")
    devices.add_argument("--no-window", action="store_true", help="start the emulator without its window")
    devices.add_argument("--boot-timeout", type=int, default=300, help="seconds to wait for it to boot")

    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)

    build = commands.add_parser("build", parents=[common], help="build headless and the APKs")
    build.add_argument("examples", nargs="*", help="the examples to package (default: all)")
    build.set_defaults(handler=command_build)

    emulator = commands.add_parser("emulator", parents=[common, devices], help="start an emulator")
    emulator.set_defaults(handler=command_emulator)

    run_parser = commands.add_parser("run", parents=[common, devices], help="install and start an example")
    run_parser.add_argument("example")
    run_parser.add_argument("--screenshot", metavar="FILE", help="take a screenshot after --seconds and stop")
    run_parser.add_argument("--seconds", type=int, default=10)
    run_parser.set_defaults(handler=command_run)

    headless = commands.add_parser("headless", parents=[common, devices], help="run headless on the device")
    headless.set_defaults(handler=command_headless)

    test = commands.add_parser("test", parents=[common, devices], help="smoke-test headless and the examples")
    test.add_argument("examples", nargs="*", help=f"default: {' '.join(EMULATOR_EXAMPLES)}")
    test.add_argument("--seconds", type=int, default=20, help="how long each has to keep running")
    test.set_defaults(handler=command_test)

    args = parser.parse_args()
    args.handler(Tools(args), args)


if __name__ == "__main__":
    main()
