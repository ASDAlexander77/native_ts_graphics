/// <reference path="../donut_handles.d.ts" />
// RTX Mega Geometry (core/rtxmg.cpp; the rtxmg_demo example links it)

// Handles of the module's objects (see donut_handles.d.ts).
@cpp declare class RtxmgDemoHandle { private readonly __rtxmgDemo: index; }

// The demo's cluster tessellation path: its library's scene, cluster tessellator, HiZ buffer and TLAS,
// and the environment map's sampling tables, with the shader factory, bindless descriptor table and
// texture cache they need. `device` is Donut_GetNvrhiDevice's. Null without cluster acceleration
// structures (Vulkan's; D3D12's need NVAPI or NVRHI's DXR cluster build) or if its shaders aren't built.
@nodrops declare function Donut_RtxmgCreate(device: Opaque): RtxmgDemoHandle;
// Also releases the library's profiler (its GPU timers), a process-wide singleton: once per process, before
// the device goes.
@nodrops declare function Donut_RtxmgDestroy(rtxmgDemo: RtxmgDemoHandle): void;
// Loads sceneFile, relative to mediaDirectory (RTXMG_DIR/assets for its scenes), and its "settings";
// makes the tessellator, the TLAS and the environment map's tables, and points the camera at the
// scene's view. Waits for the GPU. False if it can't load.
@nodrops declare function Donut_RtxmgLoadScene(rtxmgDemo: RtxmgDemoHandle, mediaDirectory: string, sceneFile: string): boolean;
// The scene file's exposure (the blit's), the path tracer's bounces (its pipeline recursion is one
// more) and its ray payload's size in bytes.
@nodrops declare function Donut_RtxmgGetExposure(rtxmgDemo: RtxmgDemoHandle): number;
@nodrops declare function Donut_RtxmgGetMaxBounces(rtxmgDemo: RtxmgDemoHandle): int;
@nodrops declare function Donut_RtxmgGetPayloadSize(rtxmgDemo: RtxmgDemoHandle): int;
// The path tracer's samples per pixel and bounces (the scene file's until set) and firefly clamp (none until
// set, as the demo's frames; 0 is none); negative keeps one. Before the pipeline, whose recursion depth is the bounces + 1.
@nodrops declare function Donut_RtxmgSetPathTracing(rtxmgDemo: RtxmgDemoHandle, spp: int, maxBounces: int, fireflyMaxIntensity: number): void;
// The demo's shading mode (0 primary rays, 1 ambient occlusion, 2 path tracing, the default) and color mode
// (0 base color, the default; the demo's ColorMode); the accumulation starts over.
@nodrops declare function Donut_RtxmgSetShadingMode(rtxmgDemo: RtxmgDemoHandle, shadingMode: int, colorMode: int): void;
// The camera from "[eye][lookat][up]fovY" (the demo's -p); false if malformed.
@nodrops declare function Donut_RtxmgSetCamera(rtxmgDemo: RtxmgDemoHandle, camera: string): boolean;
// Makes the outputs at the render size and the HiZ buffer; the accumulation starts over.
@nodrops declare function Donut_RtxmgSetSize(rtxmgDemo: RtxmgDemoHandle, width: int, height: int): void;
// Records the frame's work before the path tracer (poses, HiZ prepass, clusters and acceleration
// structures while the tessellation changes, constants) into an open command list. Returns the
// binding generation: a new one when a resource the path tracer binds was made again.
@nodrops declare function Donut_RtxmgBeginFrame(rtxmgDemo: RtxmgDemoHandle, openCommandList: CommandListHandle, frameIndex: int): int;
// After the path tracer's dispatch: the next frame accumulates one more subframe.
@nodrops declare function Donut_RtxmgEndFrame(rtxmgDemo: RtxmgDemoHandle): void;
// Writes the blit's constants (ACES tone mapping at exposure) into an open command list.
@nodrops declare function Donut_RtxmgWriteBlitParams(rtxmgDemo: RtxmgDemoHandle, openCommandList: CommandListHandle, exposure: number): void;
// A buffer the path tracer or the blit binds (RTXMG_BUFFER_* in examples/rtxmg_demo.ts), a dummy for
// one the scene hasn't; null for an unknown index.
@nodrops declare function Donut_RtxmgGetBuffer(rtxmgDemo: RtxmgDemoHandle, which: int): BufferHandle;
// A texture they bind (RTXMG_TEXTURE_*): the environment map (black without one) and the outputs.
@nodrops declare function Donut_RtxmgGetTexture(rtxmgDemo: RtxmgDemoHandle, which: int): TextureHandle;
@nodrops declare function Donut_RtxmgGetTlas(rtxmgDemo: RtxmgDemoHandle): AccelStructHandle;
// The bindless layout and descriptor table every pipeline binds after its own layout (space 1).
@nodrops declare function Donut_RtxmgGetBindlessLayout(rtxmgDemo: RtxmgDemoHandle): BindingLayoutHandle;
@nodrops declare function Donut_RtxmgGetDescriptorTable(rtxmgDemo: RtxmgDemoHandle): DescriptorTableHandle;
// 0: linear wrap (the path tracer's s0), 1: linear clamp (the blit's).
@nodrops declare function Donut_RtxmgGetSampler(rtxmgDemo: RtxmgDemoHandle, which: int): SamplerHandle;
// The path tracer's shader library (the cluster tessellation permutation) and the blit's shader,
// owned by rtxmgDemo; null if they don't load.
@nodrops declare function Donut_RtxmgGetPathTracerLibrary(rtxmgDemo: RtxmgDemoHandle): ShaderLibraryHandle;
@nodrops declare function Donut_RtxmgGetBlitShader(rtxmgDemo: RtxmgDemoHandle): ShaderHandle;
