/// <reference path="../donut_handles.d.ts" />
/// <reference path="pipelines.d.ts" />
// Command lists and recording: draws, dispatches, clears, copies, barriers, markers, timer
// and occlusion queries, predication, mesh-shader draws and the async compute loop

// nvrhi::ResourceStates bits (Donut_SetBufferState).
enum ResourceState {
    ConstantBuffer = 0x2,
    VertexBuffer = 0x4,
    IndexBuffer = 0x8,
    IndirectArgument = 0x10,
    ShaderResource = 0x60,
    UnorderedAccess = 0x80,
    RenderTarget = 0x100,
    CopyDest = 0x1000,
    CopySource = 0x2000,
}
// The state a buffer must be in next (ResourceState bits), the barrier placed by
// Donut_CommitBarriers or the next draw or dispatch: for accesses NVRHI doesn't see (device
// addresses).
@nodrops declare function Donut_SetBufferState(commandList: CommandListHandle, buffer: BufferHandle, state: ResourceState): void;
// A render target (resources.d.ts' textures) cleared to 0 (fast), resting at initialState; also a UAV if
// isUAV != 0.
@nodrops declare function Donut_CreateRenderTargetTextureInState(app: AppHandle, width: int, height: int, format: Format, isUAV: int,
    initialState: ResourceState, debugName: string): TextureHandle;
@nodrops declare function Donut_CommitBarriers(commandList: CommandListHandle): void;
// A barrier between the draws or dispatches before and after that write and read a UAV texture
// (NVRHI only places one where the texture is bound anew).
@nodrops declare function Donut_UavBarrier(commandList: CommandListHandle, texture: TextureHandle): void;
// Copies width x height texels at (srcX, srcY) of a staging texture to (dstX, dstY) of level dstMip.
@nodrops declare function Donut_CopyStagingTextureRegion(commandList: CommandListHandle, dstTexture: TextureHandle, dstMip: int, dstX: int, dstY: int,
    stagingTexture: StagingTextureHandle, srcX: int, srcY: int, width: int, height: int): void;
// Same, between levels of textures (the same texture's other levels too).
@nodrops declare function Donut_CopyTextureRegion(commandList: CommandListHandle, dstTexture: TextureHandle, dstMip: int, dstX: int, dstY: int,
    srcTexture: TextureHandle, srcMip: int, srcX: int, srcY: int, width: int, height: int): void;

// Async compute: every intervalMicroseconds, a C++ worker thread dispatches groupsX x groupsY
// groups of a compute pipeline on the compute queue (needs AppOptions.ComputeQueue) into one of
// its textures (RWTexture2D at u0, the run index as a uint push constant at b0; the layout must
// hold exactly those), and hands it to the render thread. Null if there's no compute queue.
@nodrops declare function Donut_CreateAsyncComputeLoop(app: AppHandle, computePipeline: ComputePipelineHandle, bindingLayout: BindingLayoutHandle,
    groupsX: int, groupsY: int, intervalMicroseconds: int): AsyncComputeLoopHandle;
// Before starting it.
@nodrops declare function Donut_AddAsyncComputeTexture(asyncComputeLoop: AsyncComputeLoopHandle, texture: TextureHandle): void;
// Same, with the binding set (from the loop's layout) to write it with: its UAV at u0, the push
// constants at b0 and anything else the shader reads, instead of the loop's own set of those two.
@nodrops declare function Donut_AddAsyncComputeTextureWithBindingSet(asyncComputeLoop: AsyncComputeLoopHandle, texture: TextureHandle, bindingSet: BindingSetHandle): void;
// The push constants of the runs from now on, instead of the run index: byteSize bytes from data
// (Ref of a `let` array element), copied during the call; the layout's push constants' size.
@nodrops declare function Donut_SetAsyncComputePushConstants(asyncComputeLoop: AsyncComputeLoopHandle, data: Opaque, byteSize: int): void;
// Non-zero: no more runs start until resumed (one under way finishes).
@nodrops declare function Donut_SetAsyncComputeLoopPaused(asyncComputeLoop: AsyncComputeLoopHandle, paused: boolean): void;
// Runs submitted so far.
@nodrops declare function Donut_GetAsyncComputeRunCount(asyncComputeLoop: AsyncComputeLoopHandle): int;
@nodrops declare function Donut_StartAsyncComputeLoop(asyncComputeLoop: AsyncComputeLoopHandle): void;
// Joins the worker thread; call before Donut_DestroyApp.
@nodrops declare function Donut_StopAsyncComputeLoop(asyncComputeLoop: AsyncComputeLoopHandle): void;
// In a render callback: switches to the newest finished texture, if any (the frame waits for the
// compute queue), handing the previous one back. The texture to show; null until the first.
@nodrops declare function Donut_AcquireAsyncComputeTexture(asyncComputeLoop: AsyncComputeLoopHandle, frame: FrameHandle): TextureHandle | null;

// Command lists, for work outside render passes (e.g. in a headless app).
@nodrops declare function Donut_CreateCommandList(app: AppHandle): CommandListHandle;
@nodrops declare function Donut_OpenCommandList(commandList: CommandListHandle): void;
@nodrops declare function Donut_CloseCommandList(commandList: CommandListHandle): void;
// The app holds the command list until the GPU has finished it, so it can be released right after
// (its upload and scratch memory, e.g. for texture uploads and acceleration structure builds, goes
// with it).
@nodrops declare function Donut_ExecuteCommandList(app: AppHandle, commandList: CommandListHandle): void;
// Draws vertexCount vertices (no vertex buffers: e.g. a triangle over the target from SV_VertexID)
// with a graphics pipeline into all of a framebuffer, with one binding set (null for none): for
// drawing outside the frames, e.g. into a texture's levels at load time.
@nodrops declare function Donut_CommandListDraw(commandList: CommandListHandle, pipeline: GraphicsPipelineHandle, framebuffer: FramebufferHandle, bindingSet: BindingSetHandle | null,
    vertexCount: int): void;
// A command list for the compute queue (needs AppOptions.ComputeQueue), recorded each frame and
// run with Donut_ExecuteFrameComputeWork; null if there's no compute queue.
@nodrops declare function Donut_CreateComputeQueueCommandList(app: AppHandle): CommandListHandle | null;
// Blocks until the GPU has finished all submitted work.
@nodrops declare function Donut_WaitForIdle(app: AppHandle): void;
// Uploads byteSize bytes from data, copied during the call. Pass `Ref(array[0])` of a `let`
// int[] / f32[] array.
@nodrops declare function Donut_WriteBuffer(commandList: CommandListHandle, buffer: BufferHandle, data: Opaque, byteSize: int): void;
// Same, at byteOffset of a non-volatile buffer (e.g. a constant buffer's uints after its floats;
// D3D11 drops partial constant buffer writes).
@nodrops declare function Donut_WriteBufferAt(commandList: CommandListHandle, buffer: BufferHandle, byteOffset: int, data: Opaque, byteSize: int): void;
@nodrops declare function Donut_CopyBuffer(commandList: CommandListHandle, dst: BufferHandle, dstOffset: int, src: BufferHandle, srcOffset: int, byteSize: int): void;
@nodrops declare function Donut_Dispatch(commandList: CommandListHandle, computePipeline: ComputePipelineHandle, bindingSet: BindingSetHandle, groupsX: int, groupsY: int, groupsZ: int): void;
// Same, with two binding sets (a pipeline of two binding layouts).
@nodrops declare function Donut_DispatchWithBindingSets(commandList: CommandListHandle, computePipeline: ComputePipelineHandle, bindingSet: BindingSetHandle,
    secondBindingSet: BindingSetHandle, groupsX: int, groupsY: int, groupsZ: int): void;
// Same, with a descriptor table bound after the binding set.
@nodrops declare function Donut_DispatchWithDescriptorTable(commandList: CommandListHandle, computePipeline: ComputePipelineHandle, bindingSet: BindingSetHandle,
    descriptorTable: DescriptorTableHandle, groupsX: int, groupsY: int, groupsZ: int): void;
// Same as Donut_Dispatch, with byteSize bytes of push constants from data (Ref of a `let` array
// element) for the binding set's Donut_BindPushConstants item.
@nodrops declare function Donut_DispatchWithPushConstants(commandList: CommandListHandle, computePipeline: ComputePipelineHandle, bindingSet: BindingSetHandle,
    data: Opaque, byteSize: int, groupsX: int, groupsY: int, groupsZ: int): void;
// Same, with a descriptor table bound after the binding set (Donut_DispatchWithDescriptorTable's).
@nodrops declare function Donut_DispatchWithDescriptorTableAndPushConstants(commandList: CommandListHandle, computePipeline: ComputePipelineHandle,
    bindingSet: BindingSetHandle, descriptorTable: DescriptorTableHandle, data: Opaque, byteSize: int, groupsX: int, groupsY: int, groupsZ: int): void;
// Fills a depth texture (Donut_CreateRenderTargetTexture) with `depth`.
@nodrops declare function Donut_ClearDepth(commandList: CommandListHandle, depthTexture: TextureHandle, depth: number): void;
// Fills a color texture (Donut_CreateRenderTargetTexture) with r, g, b, a.
@nodrops declare function Donut_ClearTextureFloat(commandList: CommandListHandle, texture: TextureHandle, r: number, g: number, b: number, a: number): void;
// Names the commands until the matching Donut_EndMarker, for GPU debuggers and profilers.
@nodrops declare function Donut_BeginMarker(commandList: CommandListHandle, name: string): void;
@nodrops declare function Donut_EndMarker(commandList: CommandListHandle): void;

// GPU timer queries: the GPU time between Begin and End, readable once polled.
@nodrops declare function Donut_CreateTimerQuery(app: AppHandle): TimerQueryHandle;
// Before measuring again.
@nodrops declare function Donut_ResetTimerQuery(app: AppHandle, timerQuery: TimerQueryHandle): void;
@nodrops declare function Donut_BeginTimerQuery(commandList: CommandListHandle, timerQuery: TimerQueryHandle): void;
@nodrops declare function Donut_EndTimerQuery(commandList: CommandListHandle, timerQuery: TimerQueryHandle): void;
// Non-zero once the GPU has finished the measured commands.
@nodrops declare function Donut_PollTimerQuery(app: AppHandle, timerQuery: TimerQueryHandle): int;
// Seconds; waits for the GPU unless polled first.
@nodrops declare function Donut_GetTimerQueryTime(app: AppHandle, timerQuery: TimerQueryHandle): number;
// The draw state's shading rate (after Donut_BeginDraw*): the per-draw rate, combined with the
// primitives' by primitiveCombiner, then with the framebuffer's shading rate surface by
// imageCombiner (Passthrough keeps the rate so far, Override takes the new one).
// The draw's depth bounds (after Donut_BeginDraw), for a pipeline with the depth bounds test: depth
// target values from minDepth to maxDepth pass (0 to 1 by default).
@nodrops declare function Donut_DrawSetDepthBounds(frame: FrameHandle, minDepth: number, maxDepth: number): void;
@nodrops declare function Donut_DrawSetVariableRateShading(frame: FrameHandle, enabled: boolean, shadingRate: VariableShadingRate,
    primitiveCombiner: ShadingRateCombiner, imageCombiner: ShadingRateCombiner): void;

// Valid only inside a render callback.
@nodrops declare function Donut_ClearColor(frame: FrameHandle, r: number, g: number, b: number, a: number): void;
// Draws vertexCount vertices with no vertex buffers, over the whole framebuffer.
@nodrops declare function Donut_Draw(frame: FrameHandle, pipeline: GraphicsPipelineHandle, vertexCount: int): void;
// Launches groupsX amplification-shader groups of a meshlet pipeline, over the whole framebuffer.
@nodrops declare function Donut_DispatchMesh(frame: FrameHandle, meshletPipeline: MeshletPipelineHandle, groupsX: int): void;
// Stretches a texture over the whole framebuffer. Call Donut_ClearBindingCache after releasing
// textures blitted before.
@nodrops declare function Donut_BlitTexture(app: AppHandle, frame: FrameHandle, texture: TextureHandle): void;
// One array slice of a texture, stretched into a rectangle of the framebuffer (pixels).
@nodrops declare function Donut_BlitTextureSlice(app: AppHandle, frame: FrameHandle, texture: TextureHandle, arraySlice: int, left: number, top: number, width: number, height: number): void;
// The frame's open command list, for the command list functions (e.g. Donut_WriteBuffer). Don't
// open, close or execute it.
@nodrops declare function Donut_GetFrameCommandList(frame: FrameHandle): CommandListHandle;
// A draw: begin with a pipeline (whole framebuffer by default), add state, then issue it.
@nodrops declare function Donut_BeginDraw(frame: FrameHandle, pipeline: GraphicsPipelineHandle): void;
// Same, into another framebuffer (Donut_CreateFramebuffer; a pipeline for its layout).
@nodrops declare function Donut_BeginDrawToFramebuffer(frame: FrameHandle, pipeline: GraphicsPipelineHandle, framebuffer: FramebufferHandle): void;
@nodrops declare function Donut_DrawAddBindingSet(frame: FrameHandle, bindingSet: BindingSetHandle): void;
// A descriptor table (Donut_CreateDescriptorTable, Donut_GetDescriptorTable) for the draw, in the
// pipeline's binding layout order as Donut_DrawAddBindingSet.
@nodrops declare function Donut_DrawAddDescriptorTable(frame: FrameHandle, descriptorTable: DescriptorTableHandle): void;
// R32_UINT indices.
@nodrops declare function Donut_DrawSetIndexBuffer(frame: FrameHandle, indexBuffer: BufferHandle): void;
// R16_UINT indices.
@nodrops declare function Donut_DrawSetIndexBuffer16(frame: FrameHandle, indexBuffer: BufferHandle): void;
// Binds a vertex buffer, from byteOffset, to an input layout slot.
@nodrops declare function Donut_DrawAddVertexBuffer(frame: FrameHandle, vertexBuffer: BufferHandle, slot: int, byteOffset: int): void;
// Draws into this rectangle of the framebuffer (pixels) instead of all of it.
@nodrops declare function Donut_DrawSetViewport(frame: FrameHandle, left: number, top: number, width: number, height: number): void;
// The draw's scissor rectangle in pixels (after Donut_DrawSetViewport, or for the whole framebuffer).
@nodrops declare function Donut_DrawSetScissor(frame: FrameHandle, left: int, top: int, right: int, bottom: int): void;
// One more viewport (with its scissor rectangle) for the draw, after those set or added before:
// geometry shaders pick one per primitive (SV_ViewportArrayIndex).
@nodrops declare function Donut_DrawAddViewport(frame: FrameHandle, left: number, top: number, width: number, height: number): void;
@nodrops declare function Donut_DrawIndexed(frame: FrameHandle, indexCount: int): void;
// Same, instanceCount times (instance attributes advance per instance).
@nodrops declare function Donut_DrawIndexedInstanced(frame: FrameHandle, indexCount: int, instanceCount: int): void;
// The buffer indirect draws read their arguments from (Donut_CreateDrawIndexedIndirectBuffer).
@nodrops declare function Donut_DrawSetIndirectBuffer(frame: FrameHandle, indirectBuffer: BufferHandle): void;
// drawCount indexed draws, their arguments read from the indirect buffer from offsetBytes on (20
// bytes each); the draw described stays, so it can repeat with other offsets.
@nodrops declare function Donut_DrawIndexedIndirect(frame: FrameHandle, offsetBytes: int, drawCount: int): void;
// Up to maxDrawCount indexed draws from the indirect buffer at offsetBytes, their count a uint in
// countBuffer at countOffsetBytes. Needs IndirectDrawSupport.Count.
@nodrops declare function Donut_DrawIndexedIndirectCount(frame: FrameHandle, countBuffer: BufferHandle, offsetBytes: int, countOffsetBytes: int, maxDrawCount: int): void;
// Same, with byteSize bytes of push constants from data (the binding set's Donut_BindPushConstants
// item); the draw described stays, so it can repeat with other push constants.
@nodrops declare function Donut_DrawIndexedWithPushConstants(frame: FrameHandle, indexCount: int, data: Opaque, byteSize: int): void;
// Values that decide whether draws happen (D3D12 predication, Vulkan conditional rendering): count
// of them, each 0 (skip) or not (draw), all 1 at first, in memory the CPU writes and the GPU reads
// when it executes the draws. Requires Donut_HasConditionalRendering. Null on failure.
@nodrops declare function Donut_CreatePredicationBuffer(app: AppHandle, count: int): PredicationBufferHandle | null;
@nodrops declare function Donut_SetPredicationValue(predicationBuffer: PredicationBufferHandle, index: int, value: int): void;
// Binary occlusion queries whose results the GPU resolves into predication values (the CPU's
// Donut_SetPredicationValue's are the predication buffer's): count queries, every result 0
// (occluded) at first. D3D12's occlusion query heap and predication, Vulkan's occlusion query pool
// and conditional rendering (requires Donut_HasConditionalRendering). Null otherwise.
@nodrops declare function Donut_CreateOcclusionPredication(app: AppHandle, count: int): OcclusionPredicationHandle | null;
// Donut_DrawVertices inside occlusion query `index`: whether any of the vertices' samples pass the
// depth and stencil tests.
@nodrops declare function Donut_DrawVerticesWithOcclusionQuery(frame: FrameHandle, vertexCount: int, occlusionPredication: OcclusionPredicationHandle, index: int): void;
// The queries' results into the predication values (1: samples passed; 0: none did) for the draws
// after it, e.g. the next frame's.
@nodrops declare function Donut_ResolveOcclusionQueries(frame: FrameHandle, occlusionPredication: OcclusionPredicationHandle): void;
// Donut_DrawVertices, skipped if resolved result `index` is 0 when the GPU gets to it.
@nodrops declare function Donut_DrawVerticesOcclusionPredicated(frame: FrameHandle, vertexCount: int, occlusionPredication: OcclusionPredicationHandle, index: int): void;
// Donut_DrawIndexedRangeWithPushConstants, drawn only if value `index` of the predication buffer
// isn't 0 when the GPU gets to it.
@nodrops declare function Donut_DrawIndexedRangeWithPushConstantsPredicated(frame: FrameHandle, indexCount: int, startIndex: int, baseVertex: int,
    data: Opaque, byteSize: int, predicationBuffer: PredicationBufferHandle, index: int): void;
// Same, instanceCount times.
@nodrops declare function Donut_DrawIndexedInstancedWithPushConstants(frame: FrameHandle, indexCount: int, instanceCount: int, data: Opaque, byteSize: int): void;
// Same, indexCount indices from startIndex of the index buffer, added to baseVertex.
@nodrops declare function Donut_DrawIndexedRangeWithPushConstants(frame: FrameHandle, indexCount: int, startIndex: int, baseVertex: int,
    data: Opaque, byteSize: int): void;
// Same, without push constants.
@nodrops declare function Donut_DrawIndexedRange(frame: FrameHandle, indexCount: int, startIndex: int, baseVertex: int): void;
// Copies a texture of the back buffer's size and a compatible format (e.g. RGBA8_UNORM) into the
// back buffer, as is.
@nodrops declare function Donut_CopyTextureToFrame(frame: FrameHandle, texture: TextureHandle): void;
// Same, without an index buffer.
@nodrops declare function Donut_DrawVertices(frame: FrameHandle, vertexCount: int): void;
// Same, with byteSize bytes of push constants from data (the binding set's Donut_BindPushConstants
// item); the draw described stays, so it can repeat with other push constants.
@nodrops declare function Donut_DrawVerticesWithPushConstants(frame: FrameHandle, vertexCount: int, data: Opaque, byteSize: int): void;
// Same, from vertex startVertex on.
@nodrops declare function Donut_DrawVerticesRangeWithPushConstants(frame: FrameHandle, vertexCount: int, startVertex: int, data: Opaque, byteSize: int): void;
// Executes what the frame's command list holds so far, and reopens it for the rest of the frame
// (e.g. so that copies out of a tiled texture run before Donut_ApplyTileMappings remaps it).
@nodrops declare function Donut_SubmitFrameCommandList(app: AppHandle, frame: FrameHandle): void;
// A mesh shader draw: begin with a meshlet pipeline (whole framebuffer by default), add binding sets
// (Donut_DrawAddBindingSet) and a viewport, then launch groupsX groups of its first shader
// (amplification, or mesh without one).
@nodrops declare function Donut_BeginMeshDraw(frame: FrameHandle, meshletPipeline: MeshletPipelineHandle): void;
@nodrops declare function Donut_BeginMeshDrawToFramebuffer(frame: FrameHandle, meshletPipeline: MeshletPipelineHandle, framebuffer: FramebufferHandle): void;
@nodrops declare function Donut_DrawMeshTasks(frame: FrameHandle, groupsX: int): void;
// Same, with byteSize bytes of push constants from data (the binding set's push constants slot).
@nodrops declare function Donut_DrawMeshTasksWithPushConstants(frame: FrameHandle, groupsX: int, data: Opaque, byteSize: int): void;
// Same, groupsX x groupsY groups.
@nodrops declare function Donut_DrawMeshTasks2D(frame: FrameHandle, groupsX: int, groupsY: int): void;
// Pipeline statistics of mesh shader draws (pixel, amplification and mesh shader invocations), read
// back a few frames late without waiting. Null when the device can't count mesh shader work (D3D11,
// D3D12 without MeshShaderPipelineStatsSupported, Vulkan without pipelineStatisticsQuery and
// meshShaderQueries).
@nodrops declare function Donut_CreateMeshPipelineStatistics(app: AppHandle): MeshPipelineStatisticsHandle | null;
// Before the frame's first draw: reads back the results of the query the frame reuses.
@nodrops declare function Donut_BeginMeshPipelineStatisticsFrame(frame: FrameHandle, meshPipelineStatistics: MeshPipelineStatisticsHandle): void;
// Donut_DrawMeshTasks2D, counted by the frame's statistics.
@nodrops declare function Donut_DrawMeshTasksWithStatistics(frame: FrameHandle, groupsX: int, groupsY: int, meshPipelineStatistics: MeshPipelineStatisticsHandle): void;
// The latest results: which 0 for pixel, 1 for amplification (task), 2 for mesh shader invocations.
@nodrops declare function Donut_GetMeshPipelineStatistic(meshPipelineStatistics: MeshPipelineStatisticsHandle, which: int): number;
@nodrops declare function Donut_GetFrameWidth(frame: FrameHandle): int;
@nodrops declare function Donut_GetFrameHeight(frame: FrameHandle): int;

// Submits what the frame has recorded so far and goes on recording: work after it (e.g.
// Donut_ReadPixelUInts) sees the GPU results.
@nodrops declare function Donut_FlushFrameCommandList(app: AppHandle, frame: FrameHandle): void;
// Async compute: submits what the frame has recorded so far to the graphics queue, then a closed
// compute queue command list (Donut_CreateComputeQueueCommandList) that waits for it on the GPU,
// and goes on recording work that waits for the compute work.
@nodrops declare function Donut_ExecuteFrameComputeWork(app: AppHandle, frame: FrameHandle, commandList: CommandListHandle): void;
// Saves the frame's color as recorded so far (BMP, PNG, JPG or TGA, by extension); non-zero on success.
@nodrops declare function Donut_SaveFrameToFile(app: AppHandle, frame: FrameHandle, path: string): int;
// Resolves a multisampled texture's mip 0 / slice 0 into a single-sample one.
@nodrops declare function Donut_ResolveTexture(commandList: CommandListHandle, dstTexture: TextureHandle, srcTexture: TextureHandle): void;
@nodrops declare function Donut_ClearTextureUInt(commandList: CommandListHandle, texture: TextureHandle, value: int): void;
