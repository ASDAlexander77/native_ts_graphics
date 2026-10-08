"""Generates donut.ts, the class wrappers over donut_interop.d.ts.

Every Donut_* function whose first parameter is a C++ object handle (`app: Opaque`,
`frame: Opaque`, ...) becomes a method of the class for that object (App, Frame, ...), which holds
the handle. Handle-less functions returning such an object become static methods of its class
(App.create, BindingSetDesc.create, ...); the other handle-less functions (ImGui, command line
helpers, ...) stay free functions only.

    python tools/generate_donut_wrappers.py

Run it after changing donut_interop.d.ts, and commit donut.ts and donut_globals.d.ts with it.
"""

import os
import re
import sys
import textwrap

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCE = os.path.join(ROOT, "core", "donut_interop.d.ts")
OUTPUT = os.path.join(ROOT, "core", "donut.ts")
GLOBALS = os.path.join(ROOT, "core", "donut_globals.d.ts")

# Handle parameter name -> wrapper class, in the order the classes are emitted. A function goes to
# the class of its first parameter; any other parameter with one of these names takes the class too.
CLASSES = {
    "app": "App",
    "pass": "Pass",
    "frame": "Frame",
    "commandList": "CommandList",
    "adapterList": "AdapterList",
    "inputLayoutDesc": "InputLayoutDesc",
    "bindingSetDesc": "BindingSetDesc",
    "bindingSet": "BindingSet",
    "bindingLayoutDesc": "BindingLayoutDesc",
    "bindlessLayoutDesc": "BindlessLayoutDesc",
    "descriptorTableManager": "DescriptorTableManager",
    "pipelineDesc": "RtPipelineDesc",
    "graphicsPipelineDesc": "GraphicsPipelineDesc",
    "shaderTable": "ShaderTable",
    "asyncComputeLoop": "AsyncComputeLoop",
    "imguiPass": "ImGuiPass",
    "font": "ImGuiFont",
    "sceneLoader": "SceneLoader",
    "stringList": "StringList",
    "scene": "Scene",
    "sceneGraph": "SceneGraph",
    "node": "Node",
    "light": "Light",
    "material": "Material",
    "sceneCamera": "SceneCamera",
    "sceneAccelStructs": "SceneAccelStructs",
    "loadedTexture": "LoadedTexture",
    "camera": "Camera",
    "view": "View",
    "cubemapTarget": "CubemapTarget",
    "gbufferTargets": "GBufferTargets",
    "temporalTargets": "TemporalTargets",
    "sceneRenderTargets": "SceneRenderTargets",
    "shadowMap": "ShadowMap",
    "depthPass": "DepthPass",
    "forwardShadingPass": "ForwardShadingPass",
    "gbufferFillPass": "GBufferFillPass",
    "deferredLightingPass": "DeferredLightingPass",
    "temporalAntiAliasingPass": "TemporalAntiAliasingPass",
    "toneMappingPass": "ToneMappingPass",
    "pixelReadbackPass": "PixelReadbackPass",
    "dlss": "Dlss",
    "lightProbeSet": "LightProbeSet",
    "lightProbeCapture": "LightProbeCapture",
    "lightProbeProcessingPass": "LightProbeProcessingPass",
    "gltfMesh": "GltfMesh",
    "gltfModel": "GltfModel",
    "triangleBlas": "TriangleBlas",
}

# Further parameter names that hold one of those objects.
PARAMETER_ALIASES = {
    "srcView": "View",
    "dstView": "View",
    "previousView": "View",
    "parentNode": "Node",
    "meshNode": "Node",
    "localBindingSet": "BindingSet",
    "previousToneMappingPass": "ToneMappingPass",
}

# Words dropped from a function's name to make its method's name, besides the class name itself
# (Donut_GetShadowMapTexture -> shadowMap.getTexture).
NOUNS = {
    "BindlessLayoutDesc": ["BindlessLayout"],
    "RtPipelineDesc": ["RtPipeline"],
    "GraphicsPipelineDesc": ["GraphicsPipeline"],
    "ImGuiPass": ["ImGui"],
    "ImGuiFont": ["ImGui"],
    "CubemapTarget": ["Cubemap"],
    "GBufferTargets": ["GBuffer"],
    "LightProbeSet": ["LightProbe"],
    "LoadedTexture": ["Texture"],
    "ForwardShadingPass": ["ForwardShading"],
    "GBufferFillPass": ["GBufferFill"],
    "DeferredLightingPass": ["DeferredLighting"],
    "TemporalAntiAliasingPass": ["Temporal"],
    "ToneMappingPass": ["ToneMapping"],
    "LightProbeProcessingPass": ["LightProbeProcessing"],
    "AdapterList": ["Adapters", "Adapter"],
    "AsyncComputeLoop": ["AsyncCompute"],
    "BindingLayoutDesc": ["BindingLayout"],
    # Views are planar or stereo: keep "PlanarView" / "StereoView" in the names.
    "View": [],
}

# Method names that the rules above get wrong.
METHOD_NAMES = {
    "Donut_SetViewVariableRateShading": "setVariableRateShading",
    "Donut_CreateRayTracingPipelineDesc": "create",
    "Donut_CreateGraphicsPipelineDesc": "create",
    "Donut_ImGuiPushFont": "push",
    "Donut_GetSceneTopLevelAS": "getTopLevelAS",
    "Donut_AddSceneTopLevelASInstances": "addSceneInstances",
    "Donut_AddTopLevelASInstance": "addInstance",
    "Donut_AddTopLevelASInstanceWithTransform": "addInstanceWithTransform",
}

# Functions returning an object with a wrapper class, beyond those named <verb><Class> (AddPass,
# LoadScene, CreateBindingSetForLayout, ...).
RETURNS = {
    "Donut_EnumerateAdapters": "AdapterList",
    "Donut_CreateHeadlessApp": "App",
    "Donut_CreateDeferredCommandList": "CommandList",
    "Donut_CreateComputeQueueCommandList": "CommandList",
    "Donut_GetFrameCommandList": "CommandList",
    "Donut_GetCachedBindingSet": "BindingSet",
    "Donut_CreateRayTracingPipelineDesc": "RtPipelineDesc",
    "Donut_CreateEmptyShaderTable": "ShaderTable",
    "Donut_CreateCachedShaderTable": "ShaderTable",
    "Donut_ImGuiCreateFont": "ImGuiFont",
    "Donut_FindScenes": "StringList",
    "Donut_GetLoadedScene": "Scene",
    "Donut_GetRootNode": "Node",
    "Donut_AddMeshNode": "Node",
    "Donut_GetMeshInstanceNode": "Node",
    "Donut_GetSceneGraphLight": "Light",
    "Donut_AddDirectionalLight": "Light",
    "Donut_GetSceneGraphMaterial": "Material",
    "Donut_CreateTexturedMaterial": "Material",
    "Donut_GetSceneGraphCamera": "SceneCamera",
    "Donut_BuildSceneAccelStructs": "SceneAccelStructs",
    "Donut_CreateAnimatedSceneAccelStructs": "SceneAccelStructs",
    "Donut_CreateTopLevelAS": "SceneAccelStructs",
    "Donut_LoadBindlessTexture": "LoadedTexture",
    "Donut_CreateFirstPersonCamera": "Camera",
    "Donut_CreateThirdPersonCamera": "Camera",
    "Donut_CreatePlanarView": "View",
    "Donut_CreateStereoView": "View",
    "Donut_GetStereoLeftView": "View",
    "Donut_GetLightProbeCaptureView": "View",
    "Donut_CreateCascadedShadowMap": "ShadowMap",
    "Donut_CreateShadowDepthPass": "DepthPass",
    "Donut_CreateSceneTemporalAntiAliasingPass": "TemporalAntiAliasingPass",
}

VERBS = ("Create", "Get", "Load", "Add", "Build", "Enumerate")
VARIANT_SUFFIX = re.compile(r"(With|For|From)[A-Z]\w*$")
# A name ending in one of these before the class noun keeps the noun (CopyTextureToFrame).
PREPOSITIONS = ("To", "From", "For", "With", "Of", "Into")

HEADER = """\
// Generated by tools/generate_donut_wrappers.py from donut_interop.d.ts: don't edit, regenerate.
//
// Classes over the Donut_* functions, one per kind of C++ object: each holds the object's handle
// and has the functions taking it first as methods (Donut_SetRenderCallback(pass, handler) ->
// pass.setRenderCallback(handler)). Other parameters and return values holding such objects take
// and return the classes too; anything else stays an Opaque handle, e.g. shaders and pipelines.
//
// - Functions that can fail return an object whose handle is null: check it with isNull().
// - A handle from somewhere else, e.g. the frame a render callback gets, is wrapped with
//   `new Frame(frame)`; that allocates, so a render callback wraps its frame once.
// - Wrapping a handle doesn't own it: the objects are owned as the functions' comments say.
//
// It's included through input_pass.ts, which references it: importing InputPass brings these
// classes and donut_interop.d.ts in as well. The classes are exported only so that
// input_pass.dll exports their code, for programs using them under the JIT.

/// <reference path="donut_interop.d.ts" />
"""


class Param:
    def __init__(self, text):
        name, type_ = text.split(":", 1)
        self.name = name.strip()
        self.type = " ".join(type_.split())
        self.nullable = self.type == "Opaque | null"
        # A method of a TypeScript object (RenderCallback, KeyboardCallback, ...), which Donut keeps
        self.is_callback = self.type.endswith("Callback")
        self.cls = None
        if self.type in ("Opaque", "Opaque | null"):
            self.cls = CLASSES.get(self.name) or PARAMETER_ALIASES.get(self.name)

    def declaration(self):
        if self.cls:
            return f"{self.name}: {self.cls}{' | null' if self.nullable else ''}"
        return f"{self.name}: {self.type}"

    def argument(self):
        if not self.cls:
            return self.name
        if self.nullable:
            # tslang doesn't narrow `x` inside `x ? x.handle : null`; the cast does.
            return f"{self.name} ? ({self.name} as {self.cls}).handle : null"
        return f"{self.name}.handle"


class Function:
    def __init__(self, name, params, returns, comments):
        self.name = name
        self.params = [Param(p) for p in split_params(params)]
        self.returns = " ".join(returns.split())
        self.comments = comments
        self.returns_class = None
        if self.returns in ("Opaque", "Opaque | null"):
            self.returns_class = RETURNS.get(name) or returned_class(name)
        # The class it goes to (None: a free function only), as a method of the object passed
        # first or as a static method making one.
        first = self.params[0] if self.params else None
        self.is_method = bool(first and first.cls and not first.nullable)
        self.target = first.cls if self.is_method else self.returns_class
        # The function declared before it.
        self.previous = None


def split_params(text):
    text = " ".join(text.split())
    return [p.strip() for p in text.split(",")] if text else []


def returned_class(function_name):
    base = VARIANT_SUFFIX.sub("", function_name[len("Donut_"):])
    for verb in VERBS:
        if base.startswith(verb) and base[len(verb):] in CLASSES.values():
            return base[len(verb):]
    return None


def parse(source):
    """The declared functions, with the comment lines right above each."""
    functions = []
    comments = []
    lines = source.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        if line.startswith("declare function "):
            text = line
            while not text.rstrip().endswith(";"):
                i += 1
                text += " " + lines[i].strip()
            match = re.match(r"declare function (Donut_\w+)\((.*)\)\s*:\s*(.+);$", text)
            if not match:
                sys.exit(f"can't parse: {text}")
            function = Function(match.group(1), match.group(2), match.group(3), comments)
            function.previous = functions[-1] if functions else None
            functions.append(function)
            comments = []
        elif line.startswith("//"):
            comments.append(line)
        else:
            comments = []
        i += 1
    return functions


def lower_first(name):
    return name[0].lower() + name[1:]


def method_name(function, cls):
    if function.name in METHOD_NAMES:
        return METHOD_NAMES[function.name]
    base = function.name[len("Donut_"):]
    longer = [c for c in CLASSES.values() if c != cls]
    # An empty NOUNS entry keeps the names whole.
    nouns = [] if NOUNS.get(cls) == [] else [cls] + NOUNS.get(cls, [])
    for noun in nouns:
        for match in re.finditer(noun, base):
            start, end = match.start(), match.end()
            # A whole word: the noun ends the name or the next word starts there.
            if end < len(base) and not (base[end].isupper() or base[end].isdigit()):
                continue
            # Part of another class's name (Scene in GetSceneGraph).
            if any(len(c) > len(noun) and base.startswith(c, start) for c in longer):
                continue
            rest = base[:start] + base[end:]
            if not rest or (end == len(base) and rest.endswith(PREPOSITIONS)):
                continue
            return lower_first(rest)
    return lower_first(base)


# "null" said of a function's result, when the result is a wrapper: "Returns null on failure",
# "Null if ...", "or null;"; not "if parentNode is null" or "(or null)", said of parameters.
NULL_RESULT = re.compile(r"\b([Nn])ull\b(?= \(after logging why\)| on failure| if | when |;)")


def comments_for(function, previous):
    comments = list(function.comments)
    # "Same, ..." refers to the function declared before, which may be in another class now.
    if comments and comments[0].startswith("// Same,") and previous and previous.target != function.target:
        comments[0] = comments[0].replace("// Same,", f"// Same as {previous.name},", 1)
    if function.returns_class:
        comments = [NULL_RESULT.sub(lambda m: ("A" if m.group(1) == "N" else "a") + " null handle", c)
                    for c in comments]
    if comments != function.comments:
        # Rewrapped to the width of the rest (100 columns, indented by 4).
        text = " ".join(c[len("// "):] for c in comments)
        comments = ["// " + line for line in textwrap.wrap(text, 100 - 4 - len("// "))]
    return comments


def emit_method(out, function, cls, is_static):
    params = function.params if is_static else function.params[1:]
    args = [p.argument() for p in function.params]
    if not is_static:
        args[0] = "this.handle"
    call = f"{function.name}({', '.join(args)})"
    if function.returns_class:
        returns = function.returns_class
        body = [f"return new {returns}({call});"]
    else:
        returns = function.returns
        body = [f"{call};" if returns == "void" else f"return {call};"]
    body = [f"{retained_array(p.type)}.push({p.name});" for p in params if p.is_callback] + body
    name = method_name(function, cls)
    signature = f"{'static ' if is_static else ''}{name}({', '.join(p.declaration() for p in params)}): {returns}"

    out.append("")
    for comment in comments_for(function, function.previous):
        out.append(f"    {comment}")
    out.append(f"    {signature} {{")
    for line in body:
        out.append(f"        {line}")
    out.append("    }")
    return name


def retained_array(callback_type):
    return f"retained{callback_type}s"


RETAINED_COMMENT = """\
// The callbacks handed to Donut, kept for as long as the program runs: a callback is a method of
// an object (an InputPass, a render pass) that Donut's C++ memory may be the only one to reference
// once it is set, and the collector doesn't scan that memory on Linux or Android (on Windows it
// scans all writable memory, so it found them there)."""


def generate(functions):
    methods = {cls: [] for cls in CLASSES.values()}
    statics = {cls: [] for cls in CLASSES.values()}
    for function in functions:
        if function.target and function.is_method:
            methods[function.target].append(function)
        elif function.target:
            statics[function.target].append(function)

    out = [HEADER.rstrip("\n")]

    callback_types = sorted({p.type for f in functions if f.target for p in f.params if p.is_callback})
    if callback_types:
        out.append("")
        out.append(RETAINED_COMMENT)
        for callback_type in callback_types:
            out.append(f"let {retained_array(callback_type)}: {callback_type}[] = [];")

    for cls in CLASSES.values():
        if not methods[cls] and not statics[cls]:
            continue
        out.append("")
        out.append(f"export class {cls} {{")
        out.append("    readonly handle: Opaque;")
        out.append("")
        out.append("    constructor(handle: Opaque | null) {")
        out.append("        this.handle = handle as Opaque;")
        out.append("    }")
        out.append("")
        out.append("    // True if the function that returned it failed.")
        out.append("    isNull(): boolean {")
        out.append("        return !this.handle;")
        out.append("    }")
        names = set()
        for function in statics[cls]:
            name = emit_method(out, function, cls, True)
            if name in names:
                sys.exit(f"{cls}.{name} twice ({function.name})")
            names.add(name)
        for function in methods[cls]:
            name = emit_method(out, function, cls, False)
            if name in names:
                sys.exit(f"{cls}.{name} twice ({function.name})")
            names.add(name)
        out.append("}")
    return "\n".join(out) + "\n"


GLOBALS_HEADER = """// Generated by tools/generate_donut_wrappers.py with donut.ts: don't edit, regenerate.
//
// For the editor (tsc, through tsconfig.json) only; tslang never reads it, as nothing references
// it. tslang makes donut.ts's classes global through the `/// <reference path="donut.ts" />` in
// input_pass.ts, exports and all; tsc treats donut.ts as a module because of the exports (which
// input_pass.dll needs, for the JIT), so this declares the classes as globals for it.

import * as Donut from "./donut";

declare global {"""


def generate_globals(classes):
    out = [GLOBALS_HEADER]
    for cls in classes:
        out.append(f"    type {cls} = Donut.{cls};")
        out.append(f"    var {cls}: typeof Donut.{cls};")
    out.append("}")
    return "\n".join(out) + "\n"


def report(functions):
    """Prints what stays a free function only, and the handles returned as Opaque."""
    for function in functions:
        if not function.target:
            print(f"free function only: {function.name}")
    for function in functions:
        if function.returns in ("Opaque", "Opaque | null") and not function.returns_class:
            print(f"returns Opaque: {function.name}")


def main():
    with open(SOURCE, encoding="utf-8") as f:
        functions = parse(f.read())
    if "--report" in sys.argv:
        report(functions)
    text = generate(functions)
    with open(OUTPUT, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    classes = re.findall(r"^export class (\w+)", text, re.M)
    with open(GLOBALS, "w", encoding="utf-8", newline="\n") as f:
        f.write(generate_globals(classes))


if __name__ == "__main__":
    main()
