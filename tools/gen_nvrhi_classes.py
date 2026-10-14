"""Generates core/nvrhi_classes.win32.ts and core/nvrhi_classes.linux.ts: NVRHI's interfaces
(nvrhi::I*) as tslang @cpp classes, and the structs they take, for the C++ ABI of each target, with
tsbindgen.

tsbindgen asks clang for each class's vtable under the target's ABI, so the @slot numbers, the
overloads' order, the @cppnontrivial marks and the integer widths are the C++ compiler's:
- win32: MSVC x64 (x86_64-pc-windows-msvc);
- linux: the Itanium ABI of Android's clang and libc++, the same on x86-64 and AArch64 (both are
  generated, and must agree but for plain char's sign, which doesn't change a layout). Needs the
  Android NDK's sysroot: ANDROID_NDK_HOME, or --ndk.
Run it after updating NVRHI or tslang, and commit what it writes; never edit the output.

tsbindgen also lays out the structs the classes take, with the C++ library's layout of their
std::string, static_vector and RefCountPtr fields (BufferDesc's debugName is a basic_string_char,
ComputeState's bindings a static_vector_IBindingSet_8). Its output is then made to fit core/nvrhi.ts:
- the namespace is exported, and imports core/nvrhi_types.ts;
- RefCountPtr<T> and nvrhi::Object returned by value are nvrhi.RefCountPtr<Opaque> and
  nvrhi.NativeObject;
- the specializations of std::vector, nvrhi::static_vector and RefCountPtr are generic types
  (vector<T>, static_vector8<T>, RefCountPtr<T>; see VECTOR);
- the methods tsbindgen skips because they take a struct by value are written here, for those in
  BY_VALUE, as each ABI passes it, with a function calling it.
It needs a tsbindgen that lays out std::string and static_vector fields (tslang newer than
pre-alpha99): it stops if a struct in TUPLES isn't a tuple.
"""

import argparse
import os
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NVRHI_INCLUDE = os.path.join(ROOT, "external", "Donut", "nvrhi", "include")
OUTPUT = os.path.join(ROOT, "core", "nvrhi_classes.{os}.ts")

# The targets of each output: the first one's bindings are written, the others' must be the same.
# Android's triples need an API level (its headers reject an unversioned one).
TARGETS = {
    "win32": ["x86_64-pc-windows-msvc"],
    "linux": ["x86_64-linux-android26", "aarch64-linux-android26"],
}

# the structs core/nvrhi.ts and core/nvrhi_abi.<os>.ts build, which tsbindgen has to lay out
TUPLES = ["BufferDesc", "TextureDesc", "TextureSubresourceSet", "Color", "CommandListParameters",
          "ComputePipelineDesc", "ComputeState", "HeapDesc", "BindlessLayoutDesc", "ShaderSpecialization",
          "MeshletPipelineDesc", "MeshletState", "SamplerFeedbackTextureDesc", "TextureTilesMapping",
          "AccelStructDesc", "GeometryDesc", "InstanceDesc", "PipelineDesc", "PipelineShaderDesc",
          "PipelineHitGroupDesc", "ShaderTableDesc", "State", "OpacityMicromapDesc", "OperationParams",
          "OperationDesc", "MatMulFormatCombo", "ConvertMatrixLayoutDesc", "basic_string_char"]

# Methods taking a struct by value, or returning a small one of bools, which tsbindgen skips:
# {(class, method): {os: (declaration, function)}}. The declaration's slot is the one tsbindgen
# leaves free where it skips the method, `{slot}` in the text. The function calls it with the struct,
# as its ABI passes it:
# - MSVC passes a pointer to a copy, and returns a struct through a hidden pointer (which
#   tsbindgen writes: declaration None, the function only);
# - the Itanium ABI passes a struct of up to 16 bytes of integers in one or two 64-bit registers,
#   and returns one so (a struct of bools: a byte each, from the lowest).
BY_VALUE = {
    ("ICommandList", "clearTextureFloat"): {
        "win32": (
            "@slot({slot}) clearTextureFloat(t: ITexture, subresources: Ref<TextureSubresourceSet>, clearColor: Ref<Color>): void;",
            """\
    // ICommandList::clearTextureFloat: the TextureSubresourceSet by value, which MSVC passes as a
    // pointer to a copy
    export function clearTextureFloat(commandList: ICommandList, texture: ITexture, subresources: TextureSubresourceSet, color: Color): void {
        let subresourcesValue = subresources;
        let colorValue = color;
        commandList.clearTextureFloat(texture, Ref(subresourcesValue), Ref(colorValue));
    }"""),
        "linux": (
            "@slot({slot}) clearTextureFloat(t: ITexture, mips: u64, arraySlices: u64, clearColor: Ref<Color>): void;",
            """\
    // ICommandList::clearTextureFloat: the TextureSubresourceSet by value, its two halves in two
    // registers (baseMipLevel and numMipLevels, baseArraySlice and numArraySlices)
    export function clearTextureFloat(commandList: ICommandList, texture: ITexture, subresources: TextureSubresourceSet, color: Color): void {
        const mips: u64 = <u64>subresources.baseMipLevel + <u64>subresources.numMipLevels * 0x100000000;
        const arraySlices: u64 = <u64>subresources.baseArraySlice + <u64>subresources.numArraySlices * 0x100000000;
        let colorValue = color;
        commandList.clearTextureFloat(texture, mips, arraySlices, Ref(colorValue));
    }"""),
    },
    ("ICommandList", "clearDepthStencilTexture"): {
        "win32": (
            "@slot({slot}) clearDepthStencilTexture(t: ITexture, subresources: Ref<TextureSubresourceSet>, clearDepth: boolean, depth: f32, clearStencil: boolean, stencil: u8): void;",
            """\
    // ICommandList::clearDepthStencilTexture: the TextureSubresourceSet by value, which MSVC passes
    // as a pointer to a copy
    export function clearDepthStencilTexture(commandList: ICommandList, texture: ITexture, subresources: TextureSubresourceSet,
        clearDepth: boolean, depth: f32, clearStencil: boolean, stencil: u8): void {
        let subresourcesValue = subresources;
        commandList.clearDepthStencilTexture(texture, Ref(subresourcesValue), clearDepth, depth, clearStencil, stencil);
    }"""),
        "linux": (
            "@slot({slot}) clearDepthStencilTexture(t: ITexture, mips: u64, arraySlices: u64, clearDepth: boolean, depth: f32, clearStencil: boolean, stencil: u8): void;",
            """\
    // ICommandList::clearDepthStencilTexture: the TextureSubresourceSet by value, its two halves in
    // two registers (as in clearTextureFloat)
    export function clearDepthStencilTexture(commandList: ICommandList, texture: ITexture, subresources: TextureSubresourceSet,
        clearDepth: boolean, depth: f32, clearStencil: boolean, stencil: u8): void {
        const mips: u64 = <u64>subresources.baseMipLevel + <u64>subresources.numMipLevels * 0x100000000;
        const arraySlices: u64 = <u64>subresources.baseArraySlice + <u64>subresources.numArraySlices * 0x100000000;
        commandList.clearDepthStencilTexture(texture, mips, arraySlices, clearDepth, depth, clearStencil, stencil);
    }"""),
    },
    ("ICommandList", "clearTextureUInt"): {
        "win32": (
            "@slot({slot}) clearTextureUInt(t: ITexture, subresources: Ref<TextureSubresourceSet>, clearColor: u32): void;",
            """\
    // ICommandList::clearTextureUInt: the TextureSubresourceSet by value, which MSVC passes as a
    // pointer to a copy
    export function clearTextureUInt(commandList: ICommandList, texture: ITexture, subresources: TextureSubresourceSet, value: u32): void {
        let subresourcesValue = subresources;
        commandList.clearTextureUInt(texture, Ref(subresourcesValue), value);
    }"""),
        "linux": (
            "@slot({slot}) clearTextureUInt(t: ITexture, mips: u64, arraySlices: u64, clearColor: u32): void;",
            """\
    // ICommandList::clearTextureUInt: the TextureSubresourceSet by value, its two halves in two
    // registers (as in clearTextureFloat)
    export function clearTextureUInt(commandList: ICommandList, texture: ITexture, subresources: TextureSubresourceSet, value: u32): void {
        const mips: u64 = <u64>subresources.baseMipLevel + <u64>subresources.numMipLevels * 0x100000000;
        const arraySlices: u64 = <u64>subresources.baseArraySlice + <u64>subresources.numArraySlices * 0x100000000;
        commandList.clearTextureUInt(texture, mips, arraySlices, value);
    }"""),
    },
    ("ICommandList", "beginTrackingTextureState"): {
        "win32": (
            "@slot({slot}) beginTrackingTextureState(texture: ITexture, subresources: Ref<TextureSubresourceSet>, stateBits: u32): void;",
            """\
    // ICommandList::beginTrackingTextureState: the TextureSubresourceSet by value, which MSVC passes
    // as a pointer to a copy
    export function beginTrackingTextureState(commandList: ICommandList, texture: ITexture, subresources: TextureSubresourceSet,
        stateBits: u32): void {
        let subresourcesValue = subresources;
        commandList.beginTrackingTextureState(texture, Ref(subresourcesValue), stateBits);
    }"""),
        "linux": (
            "@slot({slot}) beginTrackingTextureState(texture: ITexture, mips: u64, arraySlices: u64, stateBits: u32): void;",
            """\
    // ICommandList::beginTrackingTextureState: the TextureSubresourceSet by value, its two halves in
    // two registers (as in clearTextureFloat)
    export function beginTrackingTextureState(commandList: ICommandList, texture: ITexture, subresources: TextureSubresourceSet,
        stateBits: u32): void {
        const mips: u64 = <u64>subresources.baseMipLevel + <u64>subresources.numMipLevels * 0x100000000;
        const arraySlices: u64 = <u64>subresources.baseArraySlice + <u64>subresources.numArraySlices * 0x100000000;
        commandList.beginTrackingTextureState(texture, mips, arraySlices, stateBits);
    }"""),
    },
    ("ICommandList", "setTextureState"): {
        "win32": (
            "@slot({slot}) setTextureState(texture: ITexture, subresources: Ref<TextureSubresourceSet>, stateBits: u32): void;",
            """\
    // ICommandList::setTextureState: the TextureSubresourceSet by value, which MSVC passes as a
    // pointer to a copy
    export function setTextureState(commandList: ICommandList, texture: ITexture, subresources: TextureSubresourceSet,
        stateBits: u32): void {
        let subresourcesValue = subresources;
        commandList.setTextureState(texture, Ref(subresourcesValue), stateBits);
    }"""),
        "linux": (
            "@slot({slot}) setTextureState(texture: ITexture, mips: u64, arraySlices: u64, stateBits: u32): void;",
            """\
    // ICommandList::setTextureState: the TextureSubresourceSet by value, its two halves in two
    // registers (as in clearTextureFloat)
    export function setTextureState(commandList: ICommandList, texture: ITexture, subresources: TextureSubresourceSet,
        stateBits: u32): void {
        const mips: u64 = <u64>subresources.baseMipLevel + <u64>subresources.numMipLevels * 0x100000000;
        const arraySlices: u64 = <u64>subresources.baseArraySlice + <u64>subresources.numArraySlices * 0x100000000;
        commandList.setTextureState(texture, mips, arraySlices, stateBits);
    }"""),
    },
    ("ITexture", "getNativeView"): {
        "win32": (
            "@slot({slot}) getNativeView(objectType: u32, format: u8, subresources: Ref<TextureSubresourceSet>, dimension: u8, "
            "isReadOnlyDSV: boolean, overrideComponentMapping: Ref<u64>): NativeObject;",
            """\
    // ITexture::getNativeView: a view of the texture's subresources in a format and dimension
    // (Format.UNKNOWN, TEXTURE_DIMENSION_UNKNOWN: the texture's), not AddRef'd; null if unavailable.
    // MSVC passes the TextureSubresourceSet and the std::optional<ComponentMapping> (5 bytes; none
    // here: the texture's own mapping) as pointers to copies.
    export function getNativeView(texture: ITexture, objectType: u32, format: u8, subresources: TextureSubresourceSet,
        dimension: u8): Opaque | null {
        let subresourcesValue = subresources;
        let noComponentMapping: u64 = 0;
        return texture.getNativeView(objectType, format, Ref(subresourcesValue), dimension, false, Ref(noComponentMapping)).pointer;
    }"""),
        "linux": (
            "@slot({slot}) getNativeView(objectType: u32, format: u8, mips: u64, arraySlices: u64, dimension: u8, "
            "isReadOnlyDSV: boolean, overrideComponentMapping: u64): NativeObject;",
            """\
    // ITexture::getNativeView: a view of the texture's subresources in a format and dimension
    // (Format.UNKNOWN, TEXTURE_DIMENSION_UNKNOWN: the texture's), not AddRef'd; null if unavailable.
    // The TextureSubresourceSet's two halves in two registers (as in clearTextureFloat), the
    // std::optional<ComponentMapping> (trivially copyable, 5 bytes) in one: 0, none (its engaged
    // flag, byte 4, clear), the texture's own mapping.
    export function getNativeView(texture: ITexture, objectType: u32, format: u8, subresources: TextureSubresourceSet,
        dimension: u8): Opaque | null {
        const mips: u64 = <u64>subresources.baseMipLevel + <u64>subresources.numMipLevels * 0x100000000;
        const arraySlices: u64 = <u64>subresources.baseArraySlice + <u64>subresources.numArraySlices * 0x100000000;
        return texture.getNativeView(objectType, format, mips, arraySlices, dimension, false, 0).pointer;
    }"""),
    },
    ("IDevice", "createHandleForNativeTexture"): {
        # an nvrhi::Object (8 bytes, trivially copyable) goes in a register under both ABIs
        "win32": (
            "@cppnontrivial\n        @slot({slot}) createHandleForNativeTexture(objectType: u32, texture: Opaque | null, desc: Ref<TextureDesc>): RefCountPtr<Opaque>;",
            """\
    // IDevice::createHandleForNativeTexture: an ITexture over an API texture (ObjectTypes: a
    // D3D12 resource, a VkImage) described by desc; null on failure. Release() it. The
    // nvrhi::Object holding the API object (8 bytes) goes in a register.
    export function createHandleForNativeTexture(device: IDevice, objectType: u32, nativeTexture: Opaque, desc: TextureDesc): ITexture | null {
        let descValue = desc;
        const handle = device.createHandleForNativeTexture(objectType, nativeTexture, Ref(descValue));
        return handle.ptr_ ? <ITexture><Opaque>handle.ptr_ : null;
    }"""),
        "linux": (
            "@cppnontrivial\n        @slot({slot}) createHandleForNativeTexture(objectType: u32, texture: Opaque | null, desc: Ref<TextureDesc>): RefCountPtr<Opaque>;",
            """\
    // IDevice::createHandleForNativeTexture: an ITexture over an API texture (ObjectTypes: a
    // VkImage) described by desc; null on failure. Release() it. The nvrhi::Object holding the API
    // object (8 bytes, trivially copyable) goes in a register.
    export function createHandleForNativeTexture(device: IDevice, objectType: u32, nativeTexture: Opaque, desc: TextureDesc): ITexture | null {
        let descValue = desc;
        const handle = device.createHandleForNativeTexture(objectType, nativeTexture, Ref(descValue));
        return handle.ptr_ ? <ITexture><Opaque>handle.ptr_ : null;
    }"""),
    },
    ("IDevice", "createHandleForNativeBuffer"): {
        "win32": (
            "@cppnontrivial\n        @slot({slot}) createHandleForNativeBuffer(objectType: u32, buffer: Opaque | null, desc: Ref<BufferDesc>): RefCountPtr<Opaque>;",
            """\
    // IDevice::createHandleForNativeBuffer: an IBuffer over an API buffer (ObjectTypes: a D3D12
    // resource, a VkBuffer) described by desc; null on failure. Release() it. The nvrhi::Object
    // goes in a register, as in createHandleForNativeTexture.
    export function createHandleForNativeBuffer(device: IDevice, objectType: u32, nativeBuffer: Opaque, desc: BufferDesc): IBuffer | null {
        let descValue = desc;
        const handle = device.createHandleForNativeBuffer(objectType, nativeBuffer, Ref(descValue));
        return handle.ptr_ ? <IBuffer><Opaque>handle.ptr_ : null;
    }"""),
        "linux": (
            "@cppnontrivial\n        @slot({slot}) createHandleForNativeBuffer(objectType: u32, buffer: Opaque | null, desc: Ref<BufferDesc>): RefCountPtr<Opaque>;",
            """\
    // IDevice::createHandleForNativeBuffer: an IBuffer over an API buffer (ObjectTypes: a VkBuffer)
    // described by desc; null on failure. Release() it. The nvrhi::Object goes in a register, as
    // in createHandleForNativeTexture.
    export function createHandleForNativeBuffer(device: IDevice, objectType: u32, nativeBuffer: Opaque, desc: BufferDesc): IBuffer | null {
        let descValue = desc;
        const handle = device.createHandleForNativeBuffer(objectType, nativeBuffer, Ref(descValue));
        return handle.ptr_ ? <IBuffer><Opaque>handle.ptr_ : null;
    }"""),
    },    ("IDevice", "createSamplerFeedbackForNativeTexture"): {
        "win32": (
            "@cppnontrivial\n        @slot({slot}) createSamplerFeedbackForNativeTexture(objectType: u32, texture: Opaque | null, pairedTexture: ITexture | null): RefCountPtr<Opaque>;",
            """\
    // IDevice::createSamplerFeedbackForNativeTexture: an ISamplerFeedbackTexture over an API
    // sampler feedback texture (ObjectTypes: a D3D12 resource) for its paired texture; null on
    // failure. Release() it. The nvrhi::Object goes in a register, as in
    // createHandleForNativeTexture.
    export function createSamplerFeedbackForNativeTexture(device: IDevice, objectType: u32, nativeTexture: Opaque,
        pairedTexture: ITexture): ISamplerFeedbackTexture | null {
        const handle = device.createSamplerFeedbackForNativeTexture(objectType, nativeTexture, pairedTexture);
        return handle.ptr_ ? <ISamplerFeedbackTexture><Opaque>handle.ptr_ : null;
    }"""),
        "linux": (
            "@cppnontrivial\n        @slot({slot}) createSamplerFeedbackForNativeTexture(objectType: u32, texture: Opaque | null, pairedTexture: ITexture | null): RefCountPtr<Opaque>;",
            """\
    // IDevice::createSamplerFeedbackForNativeTexture: an ISamplerFeedbackTexture over an API
    // sampler feedback texture for its paired texture (D3D12 only: null here); null on failure.
    // Release() it. The nvrhi::Object goes in a register, as in createHandleForNativeTexture.
    export function createSamplerFeedbackForNativeTexture(device: IDevice, objectType: u32, nativeTexture: Opaque,
        pairedTexture: ITexture): ISamplerFeedbackTexture | null {
        const handle = device.createSamplerFeedbackForNativeTexture(objectType, nativeTexture, pairedTexture);
        return handle.ptr_ ? <ISamplerFeedbackTexture><Opaque>handle.ptr_ : null;
    }"""),
    },    ("IDevice", "queryCoopVecMatMulFormatSupport"): {
        "win32": (None, """\
    // IDevice::queryCoopVecMatMulFormatSupport of a combination of formats
    export function queryCoopVecMatMulFormatSupport(device: IDevice, combination: MatMulFormatCombo): MatMulFormatSupport {
        let combinationValue = combination;
        return device.queryCoopVecMatMulFormatSupport(Ref(combinationValue));
    }"""),
        "linux": (
            "@slot({slot}) queryCoopVecMatMulFormatSupport(combination: Ref<MatMulFormatCombo>): u32;",
            """\
    // IDevice::queryCoopVecMatMulFormatSupport of a combination of formats: its
    // coopvec::MatMulFormatSupport of three bools comes back in a register, a byte each
    export function queryCoopVecMatMulFormatSupport(device: IDevice, combination: MatMulFormatCombo): MatMulFormatSupport {
        let combinationValue = combination;
        const bits = device.queryCoopVecMatMulFormatSupport(Ref(combinationValue));
        return [(bits & 0xff) != 0, (bits & 0xff00) != 0, (bits & 0xff0000) != 0];
    }"""),
    },
    ("IDevice", "queryCoopVecTrainingFormatSupport"): {
        "win32": (None, """\
    // IDevice::queryCoopVecTrainingFormatSupport of a component type (coopvec::DataType)
    export function queryCoopVecTrainingFormatSupport(device: IDevice, componentType: s32): TrainingFormatSupport {
        return device.queryCoopVecTrainingFormatSupport(componentType);
    }"""),
        "linux": (
            "@slot({slot}) queryCoopVecTrainingFormatSupport(componentType: s32): u32;",
            """\
    // IDevice::queryCoopVecTrainingFormatSupport of a component type (coopvec::DataType): its
    // coopvec::TrainingFormatSupport of four bools comes back in a register, a byte each
    export function queryCoopVecTrainingFormatSupport(device: IDevice, componentType: s32): TrainingFormatSupport {
        const bits = device.queryCoopVecTrainingFormatSupport(componentType);
        return [(bits & 0xff) != 0, (bits & 0xff00) != 0, (bits & 0xff0000) != 0, (bits & 0xff000000) != 0];
    }"""),
    },
}


def find_tsbindgen(given):
    path = given or shutil.which("tsbindgen")
    if not path:
        tslang = shutil.which("tslang")
        if tslang:
            path = os.path.join(os.path.dirname(tslang), "tsbindgen.exe" if os.name == "nt" else "tsbindgen")
    if not path or not os.path.exists(path):
        sys.exit("gen_nvrhi_classes: no tsbindgen: put tslang's folder on PATH or pass --tsbindgen")
    return path


def ndk_sysroot(ndk):
    ndk = ndk or os.environ.get("ANDROID_NDK_HOME") or os.environ.get("ANDROID_NDK_ROOT")
    if not ndk:
        sys.exit("gen_nvrhi_classes: the linux bindings need the Android NDK: set ANDROID_NDK_HOME or pass --ndk")
    prebuilt = os.path.join(ndk, "toolchains", "llvm", "prebuilt")
    for host in sorted(os.listdir(prebuilt)) if os.path.isdir(prebuilt) else []:
        sysroot = os.path.join(prebuilt, host, "sysroot")
        if os.path.isdir(sysroot):
            return sysroot.replace("\\", "/")
    sys.exit(f"gen_nvrhi_classes: no sysroot in {prebuilt}")


def run_tsbindgen(tsbindgen, target, sysroot):
    """tsbindgen's bindings of nvrhi::I* for the target, and the command line (relative paths)."""
    with tempfile.TemporaryDirectory() as tmp:
        header = os.path.join(tmp, "nvrhi_classes.hpp")
        with open(header, "w") as f:
            f.write("#include <nvrhi/nvrhi.h>\n")
        include = os.path.relpath(NVRHI_INCLUDE, ROOT).replace("\\", "/")
        args = ["nvrhi_classes.hpp", f"--target={target}", "-I", include, "--filter=nvrhi::I*",
                "--namespace=nvrhi", "--", "-std=c++17"]
        if sysroot:
            args.append(f"--sysroot={sysroot}")
        result = subprocess.run([tsbindgen, header] + args[1:], capture_output=True, text=True, cwd=ROOT)
        if result.returncode != 0:
            sys.exit(f"gen_nvrhi_classes: tsbindgen failed ({target}):\n" + result.stderr)
        command = "tsbindgen " + " ".join(a if " " not in a else f"'{a}'" for a in args)
        if sysroot:
            command = command.replace(sysroot, "<NDK sysroot>")
        return result.stdout, command


def classes_body(text):
    """The lines inside tsbindgen's `namespace nvrhi { ... }`."""
    lines = text.splitlines()
    start = next(i for i, line in enumerate(lines) if line.startswith("namespace nvrhi {"))
    end = max(i for i, line in enumerate(lines) if line == "}")
    return lines[start + 1:end]


def same_layouts(a, b):
    """Whether two targets' bindings agree but for plain char's sign (s8 on x86-64, u8 on AArch64)."""
    unsigned = lambda body: [re.sub(r"\bs8\b", "u8", line) for line in body]
    return unsigned(a) == unsigned(b)


def adapt(body, os_name):
    """tsbindgen's classes made to fit core/nvrhi.ts (see the module's doc), and the functions of
    BY_VALUE's methods."""
    out = []
    functions = []
    cls = None
    used = set()
    last_slot = None
    tuples = set()
    for line in body:
        m = re.match(r"\s*export type (\w+) = \[", line)
        if m:
            tuples.add(m.group(1))

        m = re.match(r"\s*@cpp$|\s*export class (\w+)", line)
        if m and m.group(1):
            cls = m.group(1)
            used = set()
            last_slot = None

        m = re.search(r"@slot\((\d+)\)", line)
        if m:
            used.add(int(m.group(1)))
            last_slot = int(m.group(1))

        line = line.replace("Reference<", "Ref<")
        line = re.sub(r"\[ptr_: Opaque \| null\]", "RefCountPtr<Opaque>", line)
        line = re.sub(r"\[integer: Opaque \| null\]", "NativeObject", line)

        m = re.match(r"(\s*)// skipped: (\w+) ", line)
        if m and (cls, m.group(2)) in BY_VALUE:
            # the slot tsbindgen skipped: the one after the previous method's, which must be free
            # and not follow an overload (MSVC orders those its own way)
            declaration, function = BY_VALUE[(cls, m.group(2))][os_name]
            slot = last_slot + 1
            previous = out[-1].strip()
            if slot in used or not re.match(r"@slot\(\d+\) \w+\(", previous) or re.search(r"_\d+\(", previous):
                sys.exit(f"gen_nvrhi_classes: can't tell the slot of {cls}::{m.group(2)} ({os_name})")
            line = m.group(1) + declaration.format(slot=slot)
            used.add(slot)
            last_slot = slot
            functions.append(function)

        out.append(line)

    # the functions of methods tsbindgen writes for this ABI
    functions += [entry[os_name][1] for entry in BY_VALUE.values() if entry[os_name][0] is None]

    missing = [f"{c}::{n}" for (c, n) in BY_VALUE if not any(f" {n}(" in line for line in out)]
    if missing:
        sys.exit(f"gen_nvrhi_classes: not in tsbindgen's output: {', '.join(missing)}")
    untupled = [name for name in TUPLES if name not in tuples]
    if untupled:
        sys.exit(f"gen_nvrhi_classes: tsbindgen didn't lay out {', '.join(untupled)}: it needs a tsbindgen that "
                 "lays out std::string and static_vector fields (tslang newer than pre-alpha99)")
    return out, functions


HEADER = """\
// Generated by tools/gen_nvrhi_classes.py from tsbindgen's bindings; do not edit: run it again.
// {command}
//
// NVRHI's interfaces as @cpp classes under {abi}, and the structs they take as tuples with this
// ABI's C++ layout, its C++ library's std::string included, for core/nvrhi.ts (its import of
// "./nvrhi_abi" brings this file on {platform}). Each @slot is the C++ compiler's. A method taking
// a struct by value is left out, except those tools/gen_nvrhi_classes.py writes, with a function
// calling it.
//
// Not checked by TypeScript's editor tooling (@ts-nocheck): a @slot method has no body, which it
// reports twice per method (TS2391, TS1249), whatever the class's form. tslang ignores the line.
// @ts-nocheck

import "./nvrhi_types";

export namespace nvrhi {{
"""

ABIS = {
    "win32": ("MSVC x64's ABI", "Windows"),
    "linux": ("the Itanium ABI of Android's clang (x86-64 and AArch64)", "Android"),
}


# The C++ library's templates as generic tuples. A tsbindgen newer than pre-alpha100 writes them so
# itself; an older one lays out each specialization on its own (vector_BindingSetItem,
# static_vector_IBindingSet_8, RefCountPtr_IShader), which is made generic here. Either way, they are:
# std::vector<T> as each library lays it out (MSVC's in its two helper structs, which go too);
# nvrhi::static_vector<T, N> as static_vector<N><T>, as tslang has no type of N elements;
# nvrhi::RefCountPtr<T> in core/nvrhi_types.ts, the same for both.
VECTOR = {
    "win32": "[_Mypair: [_Myval2: [_Myfirst: Ref<T> | null, _Mylast: Ref<T> | null, _Myend: Ref<T> | null]]]",
    "linux": "[__begin_: Ref<T> | null, __end_: Ref<T> | null, __cap_: Ref<T> | null]",
}
STATIC_VECTOR_ELEMENTS = {"win32": "_Elems", "linux": "__elems_"}


def static_vector(os_name, size, element):
    elements = ", ".join(f"_{i}: {element}" for i in range(size))
    return f"[{STATIC_VECTOR_ELEMENTS[os_name]}: [{elements}], current_size: index]"


def generic_templates(body, os_name):
    """body with the specializations of VECTOR's, static_vector's and RefCountPtr's templates
    replaced by the generic types, which it declares first (see VECTOR). The generics a newer
    tsbindgen declares itself are checked and declared there the same way."""
    # tsbindgen's own generics: laid out as the ones written here, or it stops
    known = {"vector": VECTOR[os_name], "RefCountPtr": "[ptr_: T | null]"}
    kept = []
    for line in body:
        m = re.match(r"\s*export type (\w+)<(\w+)> = (.*);$", line)
        if not m:
            kept.append(line)
            continue
        name, parameter, definition = m.groups()
        size = re.match(r"static_vector(\d+)$", name)
        expected = static_vector(os_name, int(size.group(1)), "T") if size else known.get(name)
        if parameter != "T" or definition != expected:
            sys.exit(f"gen_nvrhi_classes: tsbindgen's {name}<{parameter}> isn't the generic expected ({os_name}):\n"
                     f"  {definition}\n  {expected}")
    body = kept

    aliases = {}
    for line in body:
        m = re.match(r"\s*export type (\w+) = (.*);$", line)
        if m:
            aliases[m.group(1)] = m.group(2)

    def expand(text):
        # the MSVC library's helper structs (_Vector_val..., _Compressed_pair...) inlined
        return re.sub(r"\b_\w+\b", lambda m: expand(aliases[m.group(0)]) if m.group(0) in aliases else m.group(0), text)

    generic = {}
    for name, definition in aliases.items():
        m = re.match(r"vector_(\w+)$", name)
        if m:
            expected, generic[name] = VECTOR[os_name].replace("<T>", f"<{m.group(1)}>"), f"vector<{m.group(1)}>"
        m = re.match(r"static_vector_\w+_(\d+)$", name)
        if m:
            element = re.match(r"\[\w+: \[_0: (.*?), _1: ", definition)
            if not element:
                sys.exit(f"gen_nvrhi_classes: {name} isn't a static_vector: {definition}")
            size = int(m.group(1))
            expected, generic[name] = static_vector(os_name, size, element.group(1)), f"static_vector{size}<{element.group(1)}>"
        m = re.match(r"RefCountPtr_(\w+)$", name)
        if m:
            expected, generic[name] = f"[ptr_: {m.group(1)} | null]", f"RefCountPtr<{m.group(1)}>"
        if name in generic and expand(definition) != expected:
            sys.exit(f"gen_nvrhi_classes: {name} isn't laid out as the generic type ({os_name}):\n"
                     f"  {expand(definition)}\n  {expected}")

    pattern = re.compile(r"\b(" + "|".join(sorted(generic, key=len, reverse=True)) + r")\b") if generic else None
    out = []
    for line in body:
        m = re.match(r"\s*export type (\w+) = ", line)
        if m and m.group(1) in generic:
            continue
        while pattern and pattern.search(line):
            line = pattern.sub(lambda m: generic[m.group(1)], line)
        out.append(line)

    # the helper structs nothing refers to any more
    while True:
        text = "\n".join(out)
        unused = [name for name in aliases if name.startswith("_") and name not in generic
                  and len(re.findall(rf"\b{name}\b", text)) == 1]
        if not unused:
            break
        out = [line for line in out if not re.match(rf"\s*export type ({'|'.join(unused)}) = ", line)]

    left = re.findall(r"\b(?:vector|static_vector|RefCountPtr)_\w+", "\n".join(out))
    if left:
        sys.exit(f"gen_nvrhi_classes: not made generic: {', '.join(sorted(set(left)))}")

    # the generics used, first, in one order whichever wrote them (RefCountPtr<T> is nvrhi_types.ts')
    text = "\n".join(out)
    declarations = [f"    export type vector<T> = {VECTOR[os_name]};"] if re.search(r"\bvector<", text) else []
    declarations += [f"    export type static_vector{size}<T> = {static_vector(os_name, size, 'T')};"
                     for size in sorted({int(size) for size in re.findall(r"\bstatic_vector(\d+)<", text)})]
    return declarations + out


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--tsbindgen", help="tsbindgen's path (default: on PATH, or next to tslang)")
    parser.add_argument("--ndk", help="the Android NDK (default: ANDROID_NDK_HOME)")
    parser.add_argument("--os", choices=sorted(TARGETS), action="append", help="only this output (default: all)")
    args = parser.parse_args()

    tsbindgen = find_tsbindgen(args.tsbindgen)
    for os_name in args.os or sorted(TARGETS):
        sysroot = ndk_sysroot(args.ndk) if os_name == "linux" else None
        bodies = []
        command = None
        for target in TARGETS[os_name]:
            text, target_command = run_tsbindgen(tsbindgen, target, sysroot)
            bodies.append(classes_body(text))
            command = command or target_command
        if any(not same_layouts(body, bodies[0]) for body in bodies[1:]):
            sys.exit(f"gen_nvrhi_classes: the bindings of {', '.join(TARGETS[os_name])} differ")

        body, functions = adapt(bodies[0], os_name)
        body = generic_templates(body, os_name)
        abi, platform = ABIS[os_name]
        text = HEADER.format(command=command, abi=abi, platform=platform)
        text += "\n".join(body) + "\n"
        for function in functions:
            text += "\n" + function + "\n"
        text += "}\n"

        path = OUTPUT.format(os=os_name)
        with open(path, "w", newline="\n") as f:
            f.write(text)
        print(f"gen_nvrhi_classes: wrote {os.path.relpath(path, ROOT)}")


if __name__ == "__main__":
    main()
