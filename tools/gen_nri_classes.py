#!/usr/bin/env python3
"""Generates core/nri.ts: the Nri_* functions of core/nri/nri_interop.d.ts as methods of classes,
one class per NRI object (NriDevice, NriCommandBuffer, NriTexture, ...), each holding its handle.

A function whose first parameter is an object's handle is that object's method
(Nri_CmdSetPipeline(commandBuffer, pipeline) -> commandBuffer.setPipeline(pipeline)); the others
are static: ImGui's on NriImgui, a factory on the class of what it makes (Nri_CreateSample() ->
NriSample.create()), the rest on Nri. Handles in and out are the classes (a handle | null is a
class | null); everything else is passed as it is.

Method names: the function's name without Nri_, without Cmd on NriCommandBuffer, without the
object's own name (once) and Imgui on NriImgui, in lowerCamelCase. A clash within a class keeps
the longer of the names.

Usage:
  python tools/gen_nri_classes.py --table   the name table (class | method | function), to review
  python tools/gen_nri_classes.py           writes core/nri.ts
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DTS = os.path.join(ROOT, 'core', 'nri', 'nri_interop.d.ts')
OUT = os.path.join(ROOT, 'core', 'nri.ts')

# Core classes (core/*.ts) whose names a generated class can't take: the generated one gets
# OBJECT_SUFFIX.
OBJECT_SUFFIX = 'Object'

# Names the rules make awkward.
RENAMES = {
    'Nri_QueuePresent': 'Present',                          # swapChain.present(...)
    'Nri_BuildTopLevelASOnQueue': 'BuildTopLevelAS',        # queue.buildTopLevelAS(...)
    'Nri_BuildUpdatableBlasOnQueue': 'BuildUpdatableBlas',  # queue.buildUpdatableBlas(...)
}


# More words a class's methods drop (once), after its own noun: asyncLoop.acquireTexture, not
# acquireAsyncComputeTexture.
EXTRA_NOUNS = {
    'AsyncComputeLoop': ['AsyncCompute'],
    'CalibratedTimestamps': ['Calibrated'],
    'DonutAnimatedScene': ['Donut'],
    'DonutAnimatedSceneAccelStructs': ['DonutAnimatedScene'],
    'DonutSceneAccelStructs': ['DonutScene'],
    'ImguiFont': ['Imgui'],
}


def core_class_names():
    names = set()
    for f in os.listdir(os.path.join(ROOT, 'core')):
        if f.endswith('.ts') and f != 'nri.ts':
            text = open(os.path.join(ROOT, 'core', f), encoding='utf-8').read()
            names.update(re.findall(r'^(?:@final\s+)?export class (\w+)', text, re.M))
    return names


class Function:
    def __init__(self, name, params, ret, comment):
        self.name = name          # Nri_CmdSetPipeline
        self.params = params      # [(name, type)]
        self.ret = ret            # 'void', 'NriTextureHandle | null', ...
        self.comment = comment    # the // lines above it
        self.cls = None
        self.method = None
        self.static = False


def split_params(text):
    params, depth, cur = [], 0, ''
    for ch in text:
        if ch in '<([':
            depth += 1
        elif ch in '>)]':
            depth -= 1
        if ch == ',' and depth == 0:
            params.append(cur)
            cur = ''
        else:
            cur += ch
    if cur.strip():
        params.append(cur)
    out = []
    for p in params:
        name, typ = p.split(':', 1)
        out.append((name.strip(), typ.strip()))
    return out


def parse():
    lines = open(DTS, encoding='utf-8').read().replace('\r\n', '\n').split('\n')
    handles = []
    functions = []
    comment = []
    i = 0
    while i < len(lines):
        line = lines[i]
        m = re.match(r'@cpp declare class (Nri\w+Handle) \{', line)
        if m:
            handles.append(m.group(1))
        if line.startswith('//'):
            comment.append(line)
            i += 1
            continue
        m = re.match(r'(?:@nodrops )?declare function (Nri_\w+)\(', line)
        if m:
            text = line
            while not text.rstrip().endswith(';'):
                i += 1
                text += ' ' + lines[i].strip()
            m = re.match(r'(?:@nodrops )?declare function (Nri_\w+)\((.*)\): (.*);$', text)
            if not m:
                sys.exit(f"can't parse: {text}")
            functions.append(Function(m.group(1), split_params(m.group(2)), m.group(3).strip(), comment))
        comment = []
        i += 1
    return handles, functions


def base_type(t):
    return t.replace(' | null', '').strip()


def camel(name):
    return name[:1].lower() + name[1:] if name else name


def strip_noun(name, noun):
    """Name without the object's noun once: GetTextureFormat - Texture -> GetFormat."""
    i = name.find(noun)
    while i >= 0:
        after = name[i + len(noun):]
        # a whole word: followed by an upper-case letter, a digit or the end
        if not after or after[0].isupper() or after[0].isdigit():
            return name[:i] + after
        i = name.find(noun, i + 1)
    return name


def assign(handles, functions):
    reserved = core_class_names()
    cls_of = {}
    for h in handles:
        c = h[:-len('Handle')]
        cls_of[h] = c + OBJECT_SUFFIX if c in reserved else c
    for f in functions:
        name = f.name[len('Nri_'):]
        first = base_type(f.params[0][1]) if f.params else None
        if first in cls_of:
            f.cls = cls_of[first]
            noun = first[len('Nri'):-len('Handle')]
            if name.startswith('Cmd'):
                name = name[3:]
            else:
                name = strip_noun(name, noun)
            for extra in EXTRA_NOUNS.get(noun, []):
                name = strip_noun(name, extra)
            name = RENAMES.get(f.name, name)
        elif name.startswith('Imgui'):
            f.cls, f.static = 'NriImgui', True
            name = name[len('Imgui'):]
        elif base_type(f.ret) in cls_of:
            f.cls, f.static = cls_of[base_type(f.ret)], True
            name = strip_noun(name, base_type(f.ret)[len('Nri'):-len('Handle')])
        else:
            f.cls, f.static = 'Nri', True
        f.method = camel(name) or 'call'
    # Clashes within a class: the function's whole name (without Nri_), for each of them.
    by = {}
    for f in functions:
        by.setdefault((f.cls, f.method), []).append(f)
    for (cls, method), fs in by.items():
        if len(fs) > 1:
            for f in fs:
                f.method = camel(f.name[len('Nri_'):])
    seen = {}
    for f in functions:
        key = (f.cls, f.method)
        if key in seen:
            sys.exit(f"clash in {f.cls}: {f.method} ({seen[key].name}, {f.name})")
        seen[key] = f
    # Reserved words and the handle field.
    for f in functions:
        if f.method in ('handle', 'constructor', 'delete', 'new', 'default', 'function', 'return'):
            f.method = camel(f.name[len('Nri_'):])
    return cls_of


def main():
    handles, functions = parse()
    cls_of = assign(handles, functions)
    if '--table' in sys.argv:
        for f in sorted(functions, key=lambda f: (f.cls, f.method)):
            print(f"{f.cls} | {'static ' if f.static else ''}{f.method} | {f.name}")
        print(f"\n{len(functions)} functions, {len(set(f.cls for f in functions))} classes")
        return
    text = generate(handles, functions, cls_of)
    old = open(OUT, encoding='utf-8', newline='').read() if os.path.exists(OUT) else ''
    if '\r\n' in old:
        text = text.replace('\n', '\r\n')
    open(OUT, 'w', encoding='utf-8', newline='').write(text)
    print(f"wrote {OUT}: {len(functions)} methods in {len(set(f.cls for f in functions))} classes")


def ts_type(t, cls_of):
    """A parameter's or result's type, a handle's as its class."""
    nullable = t.endswith(' | null')
    b = base_type(t)
    if b in cls_of:
        return cls_of[b] + (' | null' if nullable else '')
    return t


def arg(name, t, cls_of):
    b = base_type(t)
    if b in cls_of:
        return f"{name} ? {name}.handle : null" if t.endswith(' | null') else f"{name}.handle"
    return name


def generate(handles, functions, cls_of):
    out = []
    out.append('// GENERATED by tools/gen_nri_classes.py from core/nri/nri_interop.d.ts: do not edit by hand (change')
    out.append('// the .d.ts, or the generator, and run it again).')
    out.append('//')
    out.append("// The Nri_* functions as methods of classes, one per NRI object, each holding its handle:")
    out.append('// Nri_CmdSetPipeline(commandBuffer, pipeline) is commandBuffer.setPipeline(pipeline), with')
    out.append('// commandBuffer an NriCommandBuffer and pipeline an NriPipeline. Functions of no object are')
    out.append("// static: ImGui's on NriImgui, a factory on the class of what it makes (NriSample.create()),")
    out.append('// the rest on Nri. Each method says the function it calls; its comment is the function\'s.')
    out.append('//')
    out.append('// Imported with `import { NriDevice, NriCommandBuffer } from "../core/nri";` (the example\'s')
    out.append('// add_tslang_nri_example adds the module to its sources). A class is made around a handle')
    out.append('// with `new NriTexture(handle)`; `.handle` gives it back.')
    out.append('')
    out.append('/// <reference path="nri/nri_interop.d.ts" />')
    by_cls = {}
    for f in functions:
        by_cls.setdefault(f.cls, []).append(f)
    handle_of = {c: h for h, c in cls_of.items()}
    order = ['Nri', 'NriImgui'] + sorted(c for c in by_cls if c not in ('Nri', 'NriImgui'))
    # Classes of handles no function takes first (made or returned only) are classes too.
    for h, c in sorted(cls_of.items(), key=lambda x: x[1]):
        if c not in by_cls:
            order.append(c)
            by_cls[c] = []
    for c in order:
        out.append('')
        h = handle_of.get(c)
        if h:
            out.append(f'// An {h}.' if h[3] in 'AEIOU' else f'// A {h}.')
        elif c == 'Nri':
            out.append('// The functions of no NRI object.')
        else:
            out.append("// ImGui's functions (the frame's, between Nri_ImguiNewFrame and Nri_ImguiRender).")
        out.append('@final')
        out.append(f'export class {c} {{')
        body = []
        if h:
            body.append(f'    constructor(public readonly handle: {h}) {{')
            body.append('    }')
        for f in sorted(by_cls[c], key=lambda f: f.method):
            params = f.params if f.static else f.params[1:]
            sig = ', '.join(f"{n}: {ts_type(t, cls_of)}" for n, t in params)
            args = ([] if f.static else ['this.handle']) + [arg(n, t, cls_of) for n, t in params]
            call = f"{f.name}({', '.join(args)})"
            ret = f.ret
            rb = base_type(ret)
            if body:
                body.append('')
            for line in f.comment:
                body.append('    ' + line)
            body.append(f'    // ({f.name})')
            static = 'static ' if f.static else ''
            if ret == 'void':
                body.append(f'    {static}{f.method}({sig}) {{')
                body.append(f'        {call};')
            elif rb in cls_of and ret.endswith(' | null'):
                body.append(f'    {static}{f.method}({sig}): {ts_type(ret, cls_of)} {{')
                body.append(f'        const result = {call};')
                body.append(f'        return result ? new {cls_of[rb]}(result) : null;')
            elif rb in cls_of:
                body.append(f'    {static}{f.method}({sig}): {cls_of[rb]} {{')
                body.append(f'        return new {cls_of[rb]}({call});')
            else:
                body.append(f'    {static}{f.method}({sig}): {ret} {{')
                body.append(f'        return {call};')
            body.append('    }')
        out.extend(body)
        out.append('}')
    out.append('')
    return '\n'.join(out)


if __name__ == '__main__':
    main()
