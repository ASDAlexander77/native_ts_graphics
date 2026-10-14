// Imported only for its declarations: input_pass.ts brings in donut.ts (the class wrappers over
// donut_interop.d.ts), whose code every example links from its object. Referencing donut.ts here
// would compile that code into this object too, defining its symbols twice.
import { InputPass } from "../core/input_pass";
import { Args } from "../core/args";
import { nvrhi } from "../core/nvrhi";

namespace NvrhiDirect {
    // Calls NVRHI's C++ interfaces directly, with no wrapper in donut_interop.cpp: core/nvrhi.ts
    // lays tslang @cpp classes over nvrhi::IDevice, ICommandList, IBuffer, ITexture and the
    // compute pipeline's objects, and each call below goes through the C++ object's own vtable. Not
    // a port of a sample: a test of those bindings, through a method of each kind of signature
    // (struct returns and arguments, narrow arguments, callbacks). Headless, like headless.ts.
    //
    // One command list:
    // - uploads numbers into a buffer and clears another to a value;
    // - runs a compute shader (output = input * 2 + 1) over the uploaded numbers, its shader, binding
    //   layout, binding set and pipeline made here, the shader from the bytecode ShaderMake compiled
    //   (read through Donut);
    // - copies the three into a readback buffer, the last copy with the state changes made by hand
    //   instead of NVRHI's automatic barriers;
    // - clears a texture, then draws into its left half with a graphics pipeline made here (a
    //   framebuffer over the texture, vertex and pixel shaders, the render state with no depth test
    //   and no culling, a viewport), and into its top right quarter an indexed quad from a vertex
    //   buffer (an input layout), sampling a 2 x 2 texture (writeTexture, a sampler) scaled by a
    //   constant buffer, the bottom right quarter as cleared;
    // - copies the texture into another (copyTexture), and that into a staging texture, mapped to
    //   read it back.
    // Then another, the depth test (testDepth): two triangles drawn into a color texture with a
    // depth texture, the nearer drawn first; and another, the blend state (testBlend): a half
    // transparent color drawn over a cleared texture, alpha blended and added under a write mask;
    // and another, push constants (testPushConstants): a color set before each of two draws; and
    // another, indirect draws (testDrawIndirect): two draws' arguments from a buffer; and another,
    // indirect dispatches (testDispatchIndirect) of the compute pipeline above; and another, an
    // upload through a staging texture the CPU writes (testStagingUpload); and another, multiple
    // render targets (testMultipleRenderTargets); and another, multisampling and its resolve
    // (testMultisampleResolve); and another, event and timer queries (testQueries); and another,
    // the stencil test (testStencil); and another, instancing (testInstancing); and another, a
    // compute shader writing a texture (testTextureUav); and another, structured and raw buffers
    // (testStructuredAndRawBuffers); and another, a texture array's mip levels and a region copy
    // (testTextureSubresources). Then more of a feature each, each its own command list but
    // testFormatSupport: clearTextureUInt (testClearTextureUInt), a texture's and a buffer's states
    // tracked by hand (testTextureStateTracking, testBufferStateTracking), resources placed in heaps
    // (testPlacedResources), indexed indirect draws (testDrawIndexedIndirect), format support
    // (testFormatSupport), two command lists in one submission (testExecuteCommandLists), a command
    // list lifetime tracker (testLifetimeTracker), shader specialization (testShaderSpecialization),
    // a bindless descriptor table (testBindless), native views (testNativeViews), handles of API
    // objects (testNativeHandles), a resource's memory requirements (testResourceMemoryRequirements),
    // queries reset and used again (testQueryResets), the compute queue (testComputeQueue), UAV
    // barriers turned off (testUavBarrierControl), a binding set's states set at once
    // (testBindingSetStates) and indexed indirect draws with a count (testDrawIndexedIndirectCount).
    // It checks what it reads, and on the way the device's graphics API, its native objects,
    // reference counting, debug names, the desc NVRHI keeps and the layouts of the structs it passes.

    const COUNT = 64;
    const UINT_SIZE = 4;
    const SIZE = COUNT * UINT_SIZE;
    const CLEAR_VALUE: u32 = 0x5eed1234;
    const TEXTURE_SIZE = 4;

    let failures = 0;

    function check(condition: boolean, what: string): void {
        if (!condition) {
            console.log(`FAILED: ${what}`);
            failures++;
        }
    }

    function near(value: int, expected: int): boolean {
        return value >= expected - 1 && value <= expected + 1;
    }

    // Whether the RGBA8 pixel at pixels[i] is (r, g, b) and opaque, give or take one
    function sameColor(pixels: u8[], i: int, r: int, g: int, b: int): boolean {
        return near(pixels[i], r) && near(pixels[i + 1], g) && near(pixels[i + 2], b) && near(pixels[i + 3], 255);
    }

    // The textured draw's vertex: position, texture coordinates (two floats each)
    const QUAD_VERTEX_SIZE = 16;
    // Its 2 x 2 texels (RGBA8, row by row): red, blue; yellow, cyan (green 254, which halves exactly)
    const TEXELS: u8[] = [255, 0, 0, 255, 0, 0, 255, 255, 255, 254, 0, 255, 0, 254, 255, 255];

    // NVRHI's messages, through an nvrhi::IMessageCallback implemented here: a @cpp class
    // whose message() has a body, which NVRHI calls through the vtable tslang makes for it. Each
    // goes on to Donut's handling (it logs them, and CTest fails on an error it logs), except the
    // one the test provokes.
    const PROVOKED_MESSAGE = "Cannot close a command list before it is opened";

    @cpp
    class MessageLog extends nvrhi.IMessageCallback {
        expecting = false;
        provoked = 0;

        message(severity: u8, text: string): void {
            if (this.expecting && severity == nvrhi.MESSAGE_SEVERITY_ERROR && text == PROVOKED_MESSAGE) {
                this.provoked++;
                return;
            }

            Donut_LogNvrhiMessage(severity, text);
        }
    }

    // A global: NVRHI keeps a pointer to it where the collector doesn't look, for as long as the
    // device lives.
    let messageLog = new MessageLog();

    function renderTargetDesc(): nvrhi.TextureDesc {
        let desc = nvrhi.textureDesc(TEXTURE_SIZE, TEXTURE_SIZE, Format.RGBA8_UNORM, "Cleared texture",
            nvrhi.RESOURCE_STATE_RENDER_TARGET);
        desc.isRenderTarget = true;
        return desc;
    }

    // IDevice::createShader of a shader ShaderMake compiled from shaders/<fileName>.hlsl (its
    // entry point's name in the file's: nvrhi_direct_main_vs.bin)
    function loadShader(app: App, device: nvrhi.IDevice, isD3D12: boolean, fileName: string, entryName: string,
        shaderType: u16): nvrhi.IShader | null {
        const file = app.loadBinaryFile(`shaders/nvrhi_direct/${isD3D12 ? "dxil" : "spirv"}/${fileName}_${entryName}.bin`);
        if (file.isNull()) {
            return null;
        }

        return nvrhi.createShader(device, nvrhi.shaderDesc(shaderType, entryName, entryName), file.getData(), file.getSize());
    }

    // The pixels of a TEXTURE_SIZE x TEXTURE_SIZE RGBA8 staging texture: IDevice::mapStagingTexture
    // (its rows rowPitch bytes apart: 256 on D3D12), unmapStagingTexture. None on failure, reported.
    function readStaging(device: nvrhi.IDevice, staging: nvrhi.IStagingTexture): u8[] {
        let pixels: u8[] = [];
        let rowPitch: index = 0;
        const mapped = nvrhi.mapStagingTexture(device, staging, nvrhi.entireTexture(), nvrhi.CPU_ACCESS_READ, Ref(rowPitch));
        if (!mapped) {
            check(false, "IDevice::mapStagingTexture");
            return pixels;
        }
        if (rowPitch < TEXTURE_SIZE * 4) {
            check(false, `IDevice::mapStagingTexture's row pitch (${rowPitch})`);
        } else {
            pixels.length = TEXTURE_SIZE * TEXTURE_SIZE * 4;
            const rows = <Ref<u8>>mapped;
            for (let y = 0; y < TEXTURE_SIZE; y++) {
                for (let i = 0; i < TEXTURE_SIZE * 4; i++) {
                    pixels[y * TEXTURE_SIZE * 4 + i] = Deref(rows[y * rowPitch + i]);
                }
            }
        }
        device.unmapStagingTexture(staging);
        return pixels;
    }

    // The depth test, with a command list of its own: a color texture and a D32 depth texture
    // (IDevice::createTexture), a framebuffer of both; ICommandList::clearDepthStencilTexture to 1;
    // a pipeline with the default render state (depth test Less, depth writes) but for culling. One
    // draw of a near red quad over the left half, then a far blue triangle over the whole texture
    // (triangles are drawn in order): the left half stays red. Read back through a staging texture.
    function testDepth(app: App, device: nvrhi.IDevice, isD3D12: boolean): void {
        const color = nvrhi.createTexture(device, renderTargetDesc());
        let depthDesc = nvrhi.textureDesc(TEXTURE_SIZE, TEXTURE_SIZE, Format.D32, "Depth texture",
            nvrhi.RESOURCE_STATE_DEPTH_WRITE);
        depthDesc.isRenderTarget = true;
        const depth = nvrhi.createTexture(device, depthDesc);
        const staging = nvrhi.createStagingTexture(device, renderTargetDesc(), nvrhi.CPU_ACCESS_READ);
        const vertexShader = loadShader(app, device, isD3D12, "nvrhi_direct_depth", "main_vs", nvrhi.SHADER_TYPE_VERTEX);
        const pixelShader = loadShader(app, device, isD3D12, "nvrhi_direct_depth", "main_ps", nvrhi.SHADER_TYPE_PIXEL);
        const commandList = nvrhi.createCommandList(device, nvrhi.commandListParameters());
        if (!color || !depth || !staging || !vertexShader || !pixelShader || !commandList) {
            check(false, "the depth test's textures, shaders and command list");
            return;
        }
        const keptDepthDesc = Deref(depth.getDesc());
        check(keptDepthDesc.format == <u8>Format.D32 && keptDepthDesc.isRenderTarget
            && nvrhi.stdStringIs(keptDepthDesc.debugName, "Depth texture"), "the depth texture's desc");

        // IFramebuffer::getFramebufferInfo: the depth format; the pipeline for it
        const framebuffer = nvrhi.createFramebuffer(device, nvrhi.framebufferDesc([color], depth));
        if (!framebuffer) {
            check(false, "IDevice::createFramebuffer with a depth attachment");
            return;
        }
        check(Deref(framebuffer.getFramebufferInfo()).depthFormat == <u8>Format.D32, "IFramebuffer::getFramebufferInfo's depth format");
        let renderState = nvrhi.renderState();
        renderState.rasterState.cullMode = nvrhi.CULL_NONE;
        const pipeline = nvrhi.createGraphicsPipeline(device,
            nvrhi.graphicsPipelineDesc(null, vertexShader, pixelShader, null, renderState), framebuffer);
        if (!pipeline) {
            check(false, "IDevice::createGraphicsPipeline with the depth test");
            return;
        }

        commandList.open();
        nvrhi.clearTextureFloat(commandList, color, nvrhi.allSubresources(), [0.0, 0.0, 0.0, 1.0]);
        nvrhi.clearDepthStencilTexture(commandList, depth, nvrhi.allSubresources(), true, 1.0, false, 0);
        nvrhi.setGraphicsState(commandList, nvrhi.graphicsState(pipeline, framebuffer,
            [0, TEXTURE_SIZE, 0, TEXTURE_SIZE, 0, 1], null, null, null, Format.UNKNOWN));
        nvrhi.draw(commandList, 9);
        nvrhi.copyTextureToStaging(commandList, staging, nvrhi.entireTexture(), color, nvrhi.entireTexture());
        commandList.close();
        nvrhi.executeCommandList(device, commandList);
        check(device.waitForIdle(), "IDevice::waitForIdle after the depth test");

        const pixels = readStaging(device, staging);
        if (pixels.length != 0) {
            let nearMismatches = 0;
            let farMismatches = 0;
            for (let y = 0; y < TEXTURE_SIZE; y++) {
                for (let x = 0; x < TEXTURE_SIZE; x++) {
                    const i = 4 * (y * TEXTURE_SIZE + x);
                    if (x < TEXTURE_SIZE / 2) {
                        if (!sameColor(pixels, i, 255, 0, 0)) {
                            nearMismatches++;
                        }
                    } else if (!sameColor(pixels, i, 0, 0, 255)) {
                        farMismatches++;
                    }
                }
            }
            const right = 4 * (TEXTURE_SIZE - 1);
            console.log(`Depth tested: near (${pixels[0]}, ${pixels[1]}, ${pixels[2]}), `
                + `far (${pixels[right]}, ${pixels[right + 1]}, ${pixels[right + 2]})`);
            const half = TEXTURE_SIZE * TEXTURE_SIZE / 2;
            check(nearMismatches == 0, `the depth test keeps the nearer triangle (${nearMismatches} of ${half} pixels differ)`);
            check(farMismatches == 0, `the farther triangle where the depth is cleared (${farMismatches} of ${half} pixels differ)`);
        }

        commandList.Release();
        pipeline.Release();
        framebuffer.Release();
        vertexShader.Release();
        pixelShader.Release();
        staging.Release();
        depth.Release();
        color.Release();
    }

    // Whether the RGBA8 pixel at pixels[i] is (r, g, b, a), give or take one
    function sameColorAlpha(pixels: u8[], i: int, r: int, g: int, b: int, a: int): boolean {
        return near(pixels[i], r) && near(pixels[i + 1], g) && near(pixels[i + 2], b) && near(pixels[i + 3], a);
    }

    // A pipeline drawing over the viewport (nvrhi_direct.hlsl's vertex shader) the pixel shader's
    // (0, 0.5, 0.5, 0.5) into the framebuffer, blended as target, without culling or a depth test
    function blendPipeline(device: nvrhi.IDevice, vertexShader: nvrhi.IShader, pixelShader: nvrhi.IShader,
        framebuffer: nvrhi.IFramebuffer, target: nvrhi.RenderTarget): nvrhi.IGraphicsPipeline | null {
        let renderState = nvrhi.renderState();
        renderState.blendState.targets._0 = target;
        renderState.depthStencilState.depthTestEnable = false;
        renderState.depthStencilState.depthWriteEnable = false;
        renderState.rasterState.cullMode = nvrhi.CULL_NONE;
        return nvrhi.createGraphicsPipeline(device,
            nvrhi.graphicsPipelineDesc(null, vertexShader, pixelShader, null, renderState), framebuffer);
    }

    // The blend state, with a command list of its own: a texture cleared to (1, 0, 0.25, 1), its
    // left half drawn over with alpha blending (SrcAlpha, InvSrcAlpha; the alpha One, Zero), its
    // right half added (One, One) under a write mask of red and blue only. Read back through a
    // staging texture; IGraphicsPipeline::getDesc keeps the blend state.
    function testBlend(app: App, device: nvrhi.IDevice, isD3D12: boolean): void {
        const color = nvrhi.createTexture(device, renderTargetDesc());
        const staging = nvrhi.createStagingTexture(device, renderTargetDesc(), nvrhi.CPU_ACCESS_READ);
        const vertexShader = loadShader(app, device, isD3D12, "nvrhi_direct", "main_vs", nvrhi.SHADER_TYPE_VERTEX);
        const pixelShader = loadShader(app, device, isD3D12, "nvrhi_direct_blend", "main_ps", nvrhi.SHADER_TYPE_PIXEL);
        const commandList = nvrhi.createCommandList(device, nvrhi.commandListParameters());
        if (!color || !staging || !vertexShader || !pixelShader || !commandList) {
            check(false, "the blend test's textures, shaders and command list");
            return;
        }
        const framebuffer = nvrhi.createFramebuffer(device, nvrhi.framebufferDesc([color], null));
        if (!framebuffer) {
            check(false, "IDevice::createFramebuffer for the blend test");
            return;
        }
        const alphaBlend = blendPipeline(device, vertexShader, pixelShader, framebuffer, [true,
            nvrhi.BLEND_SRC_ALPHA, nvrhi.BLEND_INV_SRC_ALPHA, nvrhi.BLEND_OP_ADD,
            nvrhi.BLEND_ONE, nvrhi.BLEND_ZERO, nvrhi.BLEND_OP_ADD, nvrhi.COLOR_MASK_ALL]);
        const addMasked = blendPipeline(device, vertexShader, pixelShader, framebuffer, [true,
            nvrhi.BLEND_ONE, nvrhi.BLEND_ONE, nvrhi.BLEND_OP_ADD,
            nvrhi.BLEND_ONE, nvrhi.BLEND_ONE, nvrhi.BLEND_OP_ADD, nvrhi.COLOR_MASK_RED | nvrhi.COLOR_MASK_BLUE]);
        if (!alphaBlend || !addMasked) {
            check(false, "IDevice::createGraphicsPipeline with blending");
            return;
        }
        const kept = Deref(addMasked.getDesc()).renderState.blendState.targets._0;
        check(kept.blendEnable && kept.srcBlend == nvrhi.BLEND_ONE && kept.destBlend == nvrhi.BLEND_ONE
            && kept.colorWriteMask == (nvrhi.COLOR_MASK_RED | nvrhi.COLOR_MASK_BLUE), "IGraphicsPipeline::getDesc's blend state");

        commandList.open();
        nvrhi.clearTextureFloat(commandList, color, nvrhi.allSubresources(), [1.0, 0.0, 0.25, 1.0]);
        nvrhi.setGraphicsState(commandList, nvrhi.graphicsState(alphaBlend, framebuffer,
            [0, TEXTURE_SIZE / 2, 0, TEXTURE_SIZE, 0, 1], null, null, null, Format.UNKNOWN));
        nvrhi.draw(commandList, 3);
        nvrhi.setGraphicsState(commandList, nvrhi.graphicsState(addMasked, framebuffer,
            [TEXTURE_SIZE / 2, TEXTURE_SIZE, 0, TEXTURE_SIZE, 0, 1], null, null, null, Format.UNKNOWN));
        nvrhi.draw(commandList, 3);
        nvrhi.copyTextureToStaging(commandList, staging, nvrhi.entireTexture(), color, nvrhi.entireTexture());
        commandList.close();
        nvrhi.executeCommandList(device, commandList);
        check(device.waitForIdle(), "IDevice::waitForIdle after the blend test");

        // the left half (0.5, 0.25, 0.375, 0.5): the color half and half; the right half (1, 0,
        // 0.75, 1): blue added, green and alpha masked
        const pixels = readStaging(device, staging);
        if (pixels.length != 0) {
            let blendMismatches = 0;
            let addMismatches = 0;
            for (let y = 0; y < TEXTURE_SIZE; y++) {
                for (let x = 0; x < TEXTURE_SIZE; x++) {
                    const i = 4 * (y * TEXTURE_SIZE + x);
                    if (x < TEXTURE_SIZE / 2) {
                        if (!sameColorAlpha(pixels, i, 128, 64, 96, 128)) {
                            blendMismatches++;
                        }
                    } else if (!sameColorAlpha(pixels, i, 255, 0, 191, 255)) {
                        addMismatches++;
                    }
                }
            }
            const right = 4 * (TEXTURE_SIZE - 1);
            console.log(`Blended (${pixels[0]}, ${pixels[1]}, ${pixels[2]}, ${pixels[3]}), `
                + `added (${pixels[right]}, ${pixels[right + 1]}, ${pixels[right + 2]}, ${pixels[right + 3]})`);
            const half = TEXTURE_SIZE * TEXTURE_SIZE / 2;
            check(blendMismatches == 0, `alpha blending (${blendMismatches} of ${half} pixels differ)`);
            check(addMismatches == 0, `additive blending under a write mask (${addMismatches} of ${half} pixels differ)`);
        }

        commandList.Release();
        alphaBlend.Release();
        addMasked.Release();
        framebuffer.Release();
        vertexShader.Release();
        pixelShader.Release();
        staging.Release();
        color.Release();
    }

    // Push constants, with a command list of its own: a binding layout of 16 bytes of push
    // constants for the pixel shader (nvrhi_direct_push_constants.hlsl, the color), its binding set,
    // a pipeline of both. ICommandList::setPushConstants before each draw, after the graphics state
    // (which discards them): one color into the left half, another into the right half. Read back
    // through a staging texture; IBindingLayout::getDesc keeps the item's type and size.
    function testPushConstants(app: App, device: nvrhi.IDevice, isD3D12: boolean): void {
        const color = nvrhi.createTexture(device, renderTargetDesc());
        const staging = nvrhi.createStagingTexture(device, renderTargetDesc(), nvrhi.CPU_ACCESS_READ);
        const vertexShader = loadShader(app, device, isD3D12, "nvrhi_direct", "main_vs", nvrhi.SHADER_TYPE_VERTEX);
        const pixelShader = loadShader(app, device, isD3D12, "nvrhi_direct_push_constants", "main_ps", nvrhi.SHADER_TYPE_PIXEL);
        const commandList = nvrhi.createCommandList(device, nvrhi.commandListParameters());
        const layout = nvrhi.createBindingLayout(device, nvrhi.SHADER_TYPE_PIXEL, [nvrhi.pushConstantsLayoutItem(0, 16)]);
        if (!color || !staging || !vertexShader || !pixelShader || !commandList || !layout) {
            check(false, "the push constant test's textures, shaders, command list and binding layout");
            return;
        }
        const layoutItems = Deref(layout.getDesc()).bindings;
        const item = Deref(nvrhi.stdVectorAt(layoutItems, 0));
        check(nvrhi.stdVectorSize(layoutItems) == 1 && item.type._0 == <u32>nvrhi.RESOURCE_TYPE_PUSH_CONSTANTS + 16 * 0x10000,
            "IBindingLayout::getDesc's push constants");
        const bindingSet = nvrhi.createBindingSet(device, layout, [nvrhi.pushConstantsBindingSetItem(0, 16)]);
        const framebuffer = nvrhi.createFramebuffer(device, nvrhi.framebufferDesc([color], null));
        if (!bindingSet || !framebuffer) {
            check(false, "IDevice::createBindingSet and createFramebuffer for the push constant test");
            return;
        }
        let renderState = nvrhi.renderState();
        renderState.depthStencilState.depthTestEnable = false;
        renderState.depthStencilState.depthWriteEnable = false;
        renderState.rasterState.cullMode = nvrhi.CULL_NONE;
        const pipeline = nvrhi.createGraphicsPipeline(device,
            nvrhi.graphicsPipelineDesc(null, vertexShader, pixelShader, layout, renderState), framebuffer);
        if (!pipeline) {
            check(false, "IDevice::createGraphicsPipeline with push constants");
            return;
        }

        let left: f32[] = [0.25, 0.5, 0.75, 1];
        let right: f32[] = [1, 0.25, 0, 1];
        commandList.open();
        nvrhi.clearTextureFloat(commandList, color, nvrhi.allSubresources(), [0.0, 0.0, 0.0, 1.0]);
        nvrhi.setGraphicsState(commandList, nvrhi.graphicsState(pipeline, framebuffer,
            [0, TEXTURE_SIZE / 2, 0, TEXTURE_SIZE, 0, 1], bindingSet, null, null, Format.UNKNOWN));
        commandList.setPushConstants(<Opaque>Ref(left[0]), 16);
        nvrhi.draw(commandList, 3);
        nvrhi.setGraphicsState(commandList, nvrhi.graphicsState(pipeline, framebuffer,
            [TEXTURE_SIZE / 2, TEXTURE_SIZE, 0, TEXTURE_SIZE, 0, 1], bindingSet, null, null, Format.UNKNOWN));
        commandList.setPushConstants(<Opaque>Ref(right[0]), 16);
        nvrhi.draw(commandList, 3);
        nvrhi.copyTextureToStaging(commandList, staging, nvrhi.entireTexture(), color, nvrhi.entireTexture());
        commandList.close();
        nvrhi.executeCommandList(device, commandList);
        check(device.waitForIdle(), "IDevice::waitForIdle after the push constant test");

        const pixels = readStaging(device, staging);
        if (pixels.length != 0) {
            let leftMismatches = 0;
            let rightMismatches = 0;
            for (let y = 0; y < TEXTURE_SIZE; y++) {
                for (let x = 0; x < TEXTURE_SIZE; x++) {
                    const i = 4 * (y * TEXTURE_SIZE + x);
                    if (x < TEXTURE_SIZE / 2) {
                        if (!sameColor(pixels, i, 64, 128, 191)) {
                            leftMismatches++;
                        }
                    } else if (!sameColor(pixels, i, 255, 64, 0)) {
                        rightMismatches++;
                    }
                }
            }
            const last = 4 * (TEXTURE_SIZE - 1);
            console.log(`Push constants: (${pixels[0]}, ${pixels[1]}, ${pixels[2]}), `
                + `then (${pixels[last]}, ${pixels[last + 1]}, ${pixels[last + 2]})`);
            const half = TEXTURE_SIZE * TEXTURE_SIZE / 2;
            check(leftMismatches == 0, `ICommandList::setPushConstants, the first draw's (${leftMismatches} of ${half} pixels differ)`);
            check(rightMismatches == 0, `ICommandList::setPushConstants, the second draw's (${rightMismatches} of ${half} pixels differ)`);
        }

        commandList.Release();
        pipeline.Release();
        framebuffer.Release();
        bindingSet.Release();
        layout.Release();
        vertexShader.Release();
        pixelShader.Release();
        staging.Release();
        color.Release();
    }

    // Indirect draws, with a command list of its own: a buffer of draw arguments
    // (isDrawIndirectArgs), written by the command list, the graphics state's indirectParams.
    // ICommandList::drawIndirect into the left half from the second arguments (offset 16: three
    // vertices, one instance), then into the right half from the first (no instance): the left
    // half drawn green (nvrhi_direct.hlsl), the right half as cleared. Read back through a staging
    // texture.
    function testDrawIndirect(app: App, device: nvrhi.IDevice, isD3D12: boolean): void {
        const color = nvrhi.createTexture(device, renderTargetDesc());
        const staging = nvrhi.createStagingTexture(device, renderTargetDesc(), nvrhi.CPU_ACCESS_READ);
        const vertexShader = loadShader(app, device, isD3D12, "nvrhi_direct", "main_vs", nvrhi.SHADER_TYPE_VERTEX);
        const pixelShader = loadShader(app, device, isD3D12, "nvrhi_direct", "main_ps", nvrhi.SHADER_TYPE_PIXEL);
        const commandList = nvrhi.createCommandList(device, nvrhi.commandListParameters());
        let argumentsDesc = nvrhi.bufferDesc(32, "Draw arguments", nvrhi.RESOURCE_STATE_INDIRECT_ARGUMENT, nvrhi.CPU_ACCESS_NONE);
        argumentsDesc.isDrawIndirectArgs = true;
        const argumentsBuffer = nvrhi.createBuffer(device, argumentsDesc);
        if (!color || !staging || !vertexShader || !pixelShader || !commandList || !argumentsBuffer) {
            check(false, "the indirect draw test's textures, shaders, command list and argument buffer");
            return;
        }
        check(Deref(argumentsBuffer.getDesc()).isDrawIndirectArgs, "IBuffer::getDesc's isDrawIndirectArgs");
        const framebuffer = nvrhi.createFramebuffer(device, nvrhi.framebufferDesc([color], null));
        if (!framebuffer) {
            check(false, "IDevice::createFramebuffer for the indirect draw test");
            return;
        }
        let renderState = nvrhi.renderState();
        renderState.depthStencilState.depthTestEnable = false;
        renderState.depthStencilState.depthWriteEnable = false;
        renderState.rasterState.cullMode = nvrhi.CULL_NONE;
        const pipeline = nvrhi.createGraphicsPipeline(device,
            nvrhi.graphicsPipelineDesc(null, vertexShader, pixelShader, null, renderState), framebuffer);
        if (!pipeline) {
            check(false, "IDevice::createGraphicsPipeline for the indirect draw test");
            return;
        }

        // two DrawIndirectArguments (vertexCount, instanceCount, startVertexLocation,
        // startInstanceLocation): no instance, then one
        let drawArguments: u32[] = [3, 0, 0, 0, 3, 1, 0, 0];
        commandList.open();
        nvrhi.clearTextureFloat(commandList, color, nvrhi.allSubresources(), [0.0, 0.0, 0.0, 1.0]);
        commandList.writeBuffer(argumentsBuffer, <Opaque>Ref(drawArguments[0]), 32, 0);
        let left = nvrhi.graphicsState(pipeline, framebuffer, [0, TEXTURE_SIZE / 2, 0, TEXTURE_SIZE, 0, 1],
            null, null, null, Format.UNKNOWN);
        left.indirectParams = argumentsBuffer;
        nvrhi.setGraphicsState(commandList, left);
        commandList.drawIndirect(16, 1);
        let right = nvrhi.graphicsState(pipeline, framebuffer, [TEXTURE_SIZE / 2, TEXTURE_SIZE, 0, TEXTURE_SIZE, 0, 1],
            null, null, null, Format.UNKNOWN);
        right.indirectParams = argumentsBuffer;
        nvrhi.setGraphicsState(commandList, right);
        commandList.drawIndirect(0, 1);
        nvrhi.copyTextureToStaging(commandList, staging, nvrhi.entireTexture(), color, nvrhi.entireTexture());
        commandList.close();
        nvrhi.executeCommandList(device, commandList);
        check(device.waitForIdle(), "IDevice::waitForIdle after the indirect draw test");

        const pixels = readStaging(device, staging);
        if (pixels.length != 0) {
            let drawnMismatches = 0;
            let skippedMismatches = 0;
            for (let y = 0; y < TEXTURE_SIZE; y++) {
                for (let x = 0; x < TEXTURE_SIZE; x++) {
                    const i = 4 * (y * TEXTURE_SIZE + x);
                    if (x < TEXTURE_SIZE / 2) {
                        if (!sameColor(pixels, i, 0, 255, 0)) {
                            drawnMismatches++;
                        }
                    } else if (!sameColor(pixels, i, 0, 0, 0)) {
                        skippedMismatches++;
                    }
                }
            }
            const last = 4 * (TEXTURE_SIZE - 1);
            console.log(`Drawn indirectly (${pixels[0]}, ${pixels[1]}, ${pixels[2]}), `
                + `no instance (${pixels[last]}, ${pixels[last + 1]}, ${pixels[last + 2]})`);
            const half = TEXTURE_SIZE * TEXTURE_SIZE / 2;
            check(drawnMismatches == 0, `ICommandList::drawIndirect from offset 16 (${drawnMismatches} of ${half} pixels differ)`);
            check(skippedMismatches == 0, `ICommandList::drawIndirect of no instance (${skippedMismatches} of ${half} pixels differ)`);
        }

        commandList.Release();
        pipeline.Release();
        framebuffer.Release();
        argumentsBuffer.Release();
        vertexShader.Release();
        pixelShader.Release();
        staging.Release();
        color.Release();
    }

    // Indirect dispatches, with a command list of its own, of runTest's compute pipeline over its
    // input buffer (holding data): two output buffers, each in a binding set, cleared; a buffer of
    // dispatch arguments (isDrawIndirectArgs, as NVRHI has it for both), written by the command
    // list, the compute state's indirectParams. ICommandList::dispatchIndirect into the first output
    // from the second arguments (offset 12: one group), into the second from the first (no group):
    // the first computed, the second as cleared. Read back through a buffer.
    function testDispatchIndirect(device: nvrhi.IDevice, pipeline: nvrhi.IComputePipeline,
        bindingLayout: nvrhi.IBindingLayout, input: nvrhi.IBuffer, data: u32[]): void {
        let outputDesc = nvrhi.bufferDesc(SIZE, "Dispatched", nvrhi.RESOURCE_STATE_UNORDERED_ACCESS, nvrhi.CPU_ACCESS_NONE);
        outputDesc.format = <u8>Format.R32_UINT;
        outputDesc.canHaveTypedViews = true;
        outputDesc.canHaveUAVs = true;
        const dispatched = nvrhi.createBuffer(device, outputDesc);
        outputDesc.debugName = nvrhi.stdString("Not dispatched");
        const skipped = nvrhi.createBuffer(device, outputDesc);
        let argumentsDesc = nvrhi.bufferDesc(24, "Dispatch args", nvrhi.RESOURCE_STATE_INDIRECT_ARGUMENT, nvrhi.CPU_ACCESS_NONE);
        argumentsDesc.isDrawIndirectArgs = true;
        const argumentsBuffer = nvrhi.createBuffer(device, argumentsDesc);
        const readback = nvrhi.createBuffer(device, nvrhi.bufferDesc(2 * SIZE, "Readback", nvrhi.RESOURCE_STATE_COPY_DEST,
            nvrhi.CPU_ACCESS_READ));
        const commandList = nvrhi.createCommandList(device, nvrhi.commandListParameters());
        if (!dispatched || !skipped || !argumentsBuffer || !readback || !commandList) {
            check(false, "the indirect dispatch test's buffers and command list");
            return;
        }
        const dispatchedSet = nvrhi.createBindingSet(device, bindingLayout, [
            nvrhi.bufferBindingSetItem(0, nvrhi.RESOURCE_TYPE_TYPED_BUFFER_SRV, input),
            nvrhi.bufferBindingSetItem(0, nvrhi.RESOURCE_TYPE_TYPED_BUFFER_UAV, dispatched)]);
        const skippedSet = nvrhi.createBindingSet(device, bindingLayout, [
            nvrhi.bufferBindingSetItem(0, nvrhi.RESOURCE_TYPE_TYPED_BUFFER_SRV, input),
            nvrhi.bufferBindingSetItem(0, nvrhi.RESOURCE_TYPE_TYPED_BUFFER_UAV, skipped)]);
        if (!dispatchedSet || !skippedSet) {
            check(false, "IDevice::createBindingSet for the indirect dispatch test");
            return;
        }

        // two DispatchIndirectArguments (groupsX, groupsY, groupsZ): no group, then one
        let dispatchArguments: u32[] = [0, 1, 1, 1, 1, 1];
        commandList.open();
        commandList.clearBufferUInt(dispatched, CLEAR_VALUE);
        commandList.clearBufferUInt(skipped, CLEAR_VALUE);
        commandList.writeBuffer(argumentsBuffer, <Opaque>Ref(dispatchArguments[0]), 24, 0);
        let first = nvrhi.computeState(pipeline, dispatchedSet);
        first.indirectParams = argumentsBuffer;
        nvrhi.setComputeState(commandList, first);
        commandList.dispatchIndirect(12);
        let second = nvrhi.computeState(pipeline, skippedSet);
        second.indirectParams = argumentsBuffer;
        nvrhi.setComputeState(commandList, second);
        commandList.dispatchIndirect(0);
        commandList.copyBuffer(readback, 0, dispatched, 0, SIZE);
        commandList.copyBuffer(readback, SIZE, skipped, 0, SIZE);
        commandList.close();
        nvrhi.executeCommandList(device, commandList);
        check(device.waitForIdle(), "IDevice::waitForIdle after the indirect dispatch test");

        const mapped = <Ref<u32>>device.mapBuffer(readback, nvrhi.CPU_ACCESS_READ);
        let dispatchedMismatches = 0;
        let skippedMismatches = 0;
        for (let i = 0; i < COUNT; i++) {
            if (Deref(mapped[i]) != data[i] * 2 + 1) {
                dispatchedMismatches++;
            }
            if (Deref(mapped[COUNT + i]) != CLEAR_VALUE) {
                skippedMismatches++;
            }
        }
        console.log(`Dispatched indirectly [${Deref(mapped[0])}, ..., ${Deref(mapped[COUNT - 1])}], `
            + `no group [${Deref(mapped[COUNT])}, ...]`);
        device.unmapBuffer(readback);
        check(dispatchedMismatches == 0, `ICommandList::dispatchIndirect from offset 12 (${dispatchedMismatches} of ${COUNT} differ)`);
        check(skippedMismatches == 0, `ICommandList::dispatchIndirect of no group (${skippedMismatches} of ${COUNT} differ)`);

        commandList.Release();
        dispatchedSet.Release();
        skippedSet.Release();
        readback.Release();
        argumentsBuffer.Release();
        dispatched.Release();
        skipped.Release();
    }

    // The upload staging texture's pixel (x, y): a different color for each
    function uploadedPixel(x: int, y: int): u8[] {
        return [<u8>(40 + 50 * x), <u8>(40 + 50 * y), <u8>(220 - 20 * x - 30 * y), 255];
    }

    // An upload through a staging texture, with a command list of its own: a staging texture the
    // CPU writes (IDevice::createStagingTexture with CPU_ACCESS_WRITE, mapStagingTexture for writing,
    // its rows rowPitch bytes apart), ICommandList::copyTexture from it into a texture (the third
    // overload), and that read back through a staging texture: the same pixels.
    function testStagingUpload(device: nvrhi.IDevice): void {
        const upload = nvrhi.createStagingTexture(device, nvrhi.textureDesc(TEXTURE_SIZE, TEXTURE_SIZE,
            Format.RGBA8_UNORM, "Upload texture", nvrhi.RESOURCE_STATE_COPY_SOURCE), nvrhi.CPU_ACCESS_WRITE);
        const uploaded = nvrhi.createTexture(device, nvrhi.textureDesc(TEXTURE_SIZE, TEXTURE_SIZE,
            Format.RGBA8_UNORM, "Uploaded", nvrhi.RESOURCE_STATE_COPY_DEST));
        const readback = nvrhi.createStagingTexture(device, renderTargetDesc(), nvrhi.CPU_ACCESS_READ);
        const commandList = nvrhi.createCommandList(device, nvrhi.commandListParameters());
        if (!upload || !uploaded || !readback || !commandList) {
            check(false, "the staging upload test's textures and command list");
            return;
        }

        let rowPitch: index = 0;
        const mapped = nvrhi.mapStagingTexture(device, upload, nvrhi.entireTexture(), nvrhi.CPU_ACCESS_WRITE, Ref(rowPitch));
        if (!mapped || rowPitch < TEXTURE_SIZE * 4) {
            check(false, `IDevice::mapStagingTexture for writing (row pitch ${rowPitch})`);
            if (mapped) {
                device.unmapStagingTexture(upload);
            }
            return;
        }
        const rows = <Ref<u8>>mapped;
        for (let y = 0; y < TEXTURE_SIZE; y++) {
            for (let x = 0; x < TEXTURE_SIZE; x++) {
                const pixel = uploadedPixel(x, y);
                for (let c = 0; c < 4; c++) {
                    Deref(rows[y * rowPitch + 4 * x + c]) = pixel[c];
                }
            }
        }
        device.unmapStagingTexture(upload);

        commandList.open();
        nvrhi.copyTextureFromStaging(commandList, uploaded, nvrhi.entireTexture(), upload, nvrhi.entireTexture());
        nvrhi.copyTextureToStaging(commandList, readback, nvrhi.entireTexture(), uploaded, nvrhi.entireTexture());
        commandList.close();
        nvrhi.executeCommandList(device, commandList);
        check(device.waitForIdle(), "IDevice::waitForIdle after the staging upload test");

        const pixels = readStaging(device, readback);
        if (pixels.length != 0) {
            let mismatches = 0;
            for (let y = 0; y < TEXTURE_SIZE; y++) {
                for (let x = 0; x < TEXTURE_SIZE; x++) {
                    const i = 4 * (y * TEXTURE_SIZE + x);
                    const pixel = uploadedPixel(x, y);
                    if (pixels[i] != pixel[0] || pixels[i + 1] != pixel[1] || pixels[i + 2] != pixel[2] || pixels[i + 3] != pixel[3]) {
                        mismatches++;
                    }
                }
            }
            const last = 4 * (TEXTURE_SIZE * TEXTURE_SIZE - 1);
            console.log(`Uploaded (${pixels[0]}, ${pixels[1]}, ${pixels[2]}), ..., (${pixels[last]}, ${pixels[last + 1]}, ${pixels[last + 2]})`);
            check(mismatches == 0, `ICommandList::copyTexture from a staging texture the CPU wrote (${mismatches} of ${TEXTURE_SIZE * TEXTURE_SIZE} pixels differ)`);
        }

        commandList.Release();
        readback.Release();
        uploaded.Release();
        upload.Release();
    }

    // Multiple render targets, with a command list of its own: a framebuffer of two color
    // textures (IFramebuffer::getFramebufferInfo: two color formats), a pipeline whose pixel shader
    // (nvrhi_direct_mrt.hlsl) writes a color to each, one draw over both. Each read back through a
    // staging texture.
    function testMultipleRenderTargets(app: App, device: nvrhi.IDevice, isD3D12: boolean): void {
        const first = nvrhi.createTexture(device, renderTargetDesc());
        const second = nvrhi.createTexture(device, renderTargetDesc());
        const firstStaging = nvrhi.createStagingTexture(device, renderTargetDesc(), nvrhi.CPU_ACCESS_READ);
        const secondStaging = nvrhi.createStagingTexture(device, renderTargetDesc(), nvrhi.CPU_ACCESS_READ);
        const vertexShader = loadShader(app, device, isD3D12, "nvrhi_direct", "main_vs", nvrhi.SHADER_TYPE_VERTEX);
        const pixelShader = loadShader(app, device, isD3D12, "nvrhi_direct_mrt", "main_ps", nvrhi.SHADER_TYPE_PIXEL);
        const commandList = nvrhi.createCommandList(device, nvrhi.commandListParameters());
        if (!first || !second || !firstStaging || !secondStaging || !vertexShader || !pixelShader || !commandList) {
            check(false, "the render target test's textures, shaders and command list");
            return;
        }
        const framebuffer = nvrhi.createFramebuffer(device, nvrhi.framebufferDesc([first, second], null));
        if (!framebuffer) {
            check(false, "IDevice::createFramebuffer of two color textures");
            return;
        }
        check(Deref(framebuffer.getFramebufferInfo()).colorFormats.current_size == 2, "IFramebuffer::getFramebufferInfo's two color formats");
        let renderState = nvrhi.renderState();
        renderState.depthStencilState.depthTestEnable = false;
        renderState.depthStencilState.depthWriteEnable = false;
        renderState.rasterState.cullMode = nvrhi.CULL_NONE;
        const pipeline = nvrhi.createGraphicsPipeline(device,
            nvrhi.graphicsPipelineDesc(null, vertexShader, pixelShader, null, renderState), framebuffer);
        if (!pipeline) {
            check(false, "IDevice::createGraphicsPipeline for two render targets");
            return;
        }

        commandList.open();
        nvrhi.clearTextureFloat(commandList, first, nvrhi.allSubresources(), [0.0, 0.0, 0.0, 1.0]);
        nvrhi.clearTextureFloat(commandList, second, nvrhi.allSubresources(), [0.0, 0.0, 0.0, 1.0]);
        nvrhi.setGraphicsState(commandList, nvrhi.graphicsState(pipeline, framebuffer,
            [0, TEXTURE_SIZE, 0, TEXTURE_SIZE, 0, 1], null, null, null, Format.UNKNOWN));
        nvrhi.draw(commandList, 3);
        nvrhi.copyTextureToStaging(commandList, firstStaging, nvrhi.entireTexture(), first, nvrhi.entireTexture());
        nvrhi.copyTextureToStaging(commandList, secondStaging, nvrhi.entireTexture(), second, nvrhi.entireTexture());
        commandList.close();
        nvrhi.executeCommandList(device, commandList);
        check(device.waitForIdle(), "IDevice::waitForIdle after the render target test");

        // render target 0 (1, 0.5, 0), render target 1 (0, 0.25, 1)
        const firstPixels = readStaging(device, firstStaging);
        const secondPixels = readStaging(device, secondStaging);
        if (firstPixels.length != 0 && secondPixels.length != 0) {
            let firstMismatches = 0;
            let secondMismatches = 0;
            for (let i = 0; i < TEXTURE_SIZE * TEXTURE_SIZE * 4; i += 4) {
                if (!sameColor(firstPixels, i, 255, 128, 0)) {
                    firstMismatches++;
                }
                if (!sameColor(secondPixels, i, 0, 64, 255)) {
                    secondMismatches++;
                }
            }
            console.log(`Render targets (${firstPixels[0]}, ${firstPixels[1]}, ${firstPixels[2]}) and `
                + `(${secondPixels[0]}, ${secondPixels[1]}, ${secondPixels[2]})`);
            const all = TEXTURE_SIZE * TEXTURE_SIZE;
            check(firstMismatches == 0, `render target 0 (${firstMismatches} of ${all} pixels differ)`);
            check(secondMismatches == 0, `render target 1 (${secondMismatches} of ${all} pixels differ)`);
        }

        commandList.Release();
        pipeline.Release();
        framebuffer.Release();
        vertexShader.Release();
        pixelShader.Release();
        secondStaging.Release();
        firstStaging.Release();
        second.Release();
        first.Release();
    }

    // Multisampling, with a command list of its own: a texture of 4 samples a pixel (sampleCount,
    // TEXTURE_DIMENSION_2D_MS), a framebuffer over it (getFramebufferInfo: its sample count), a
    // triangle drawn green over its bottom left half (nvrhi_direct_msaa.hlsl), its edge through the
    // centers of the diagonal's pixels; ICommandList::resolveTexture into a texture of one sample,
    // read back through a staging texture. Below the diagonal green, above it as cleared (black),
    // on it half and half: 2 of the standard positions' 4 samples are covered.
    function testMultisampleResolve(app: App, device: nvrhi.IDevice, isD3D12: boolean): void {
        let multisampledDesc = renderTargetDesc();
        multisampledDesc.sampleCount = 4;
        multisampledDesc.dimension = nvrhi.TEXTURE_DIMENSION_2D_MS;
        multisampledDesc.debugName = nvrhi.stdString("Multisampled");
        const multisampled = nvrhi.createTexture(device, multisampledDesc);
        const resolved = nvrhi.createTexture(device, nvrhi.textureDesc(TEXTURE_SIZE, TEXTURE_SIZE, Format.RGBA8_UNORM,
            "Resolved", nvrhi.RESOURCE_STATE_COPY_SOURCE));
        const staging = nvrhi.createStagingTexture(device, renderTargetDesc(), nvrhi.CPU_ACCESS_READ);
        const vertexShader = loadShader(app, device, isD3D12, "nvrhi_direct_msaa", "main_vs", nvrhi.SHADER_TYPE_VERTEX);
        const pixelShader = loadShader(app, device, isD3D12, "nvrhi_direct", "main_ps", nvrhi.SHADER_TYPE_PIXEL);
        const commandList = nvrhi.createCommandList(device, nvrhi.commandListParameters());
        if (!multisampled || !resolved || !staging || !vertexShader || !pixelShader || !commandList) {
            check(false, "the multisample test's textures, shaders and command list");
            return;
        }
        const keptDesc = Deref(multisampled.getDesc());
        check(keptDesc.sampleCount == 4 && keptDesc.dimension == nvrhi.TEXTURE_DIMENSION_2D_MS, "the multisampled texture's desc");
        const framebuffer = nvrhi.createFramebuffer(device, nvrhi.framebufferDesc([multisampled], null));
        if (!framebuffer) {
            check(false, "IDevice::createFramebuffer over a multisampled texture");
            return;
        }
        check(Deref(framebuffer.getFramebufferInfo()).sampleCount == 4, "IFramebuffer::getFramebufferInfo's sample count");
        let renderState = nvrhi.renderState();
        renderState.depthStencilState.depthTestEnable = false;
        renderState.depthStencilState.depthWriteEnable = false;
        renderState.rasterState.cullMode = nvrhi.CULL_NONE;
        const pipeline = nvrhi.createGraphicsPipeline(device,
            nvrhi.graphicsPipelineDesc(null, vertexShader, pixelShader, null, renderState), framebuffer);
        if (!pipeline) {
            check(false, "IDevice::createGraphicsPipeline for 4 samples");
            return;
        }

        commandList.open();
        nvrhi.clearTextureFloat(commandList, multisampled, nvrhi.allSubresources(), [0.0, 0.0, 0.0, 1.0]);
        nvrhi.setGraphicsState(commandList, nvrhi.graphicsState(pipeline, framebuffer,
            [0, TEXTURE_SIZE, 0, TEXTURE_SIZE, 0, 1], null, null, null, Format.UNKNOWN));
        nvrhi.draw(commandList, 3);
        nvrhi.resolveTexture(commandList, resolved, multisampled);
        nvrhi.copyTextureToStaging(commandList, staging, nvrhi.entireTexture(), resolved, nvrhi.entireTexture());
        commandList.close();
        nvrhi.executeCommandList(device, commandList);
        check(device.waitForIdle(), "IDevice::waitForIdle after the multisample test");

        const pixels = readStaging(device, staging);
        if (pixels.length != 0) {
            let coveredMismatches = 0;
            let edgeMismatches = 0;
            let emptyMismatches = 0;
            for (let y = 0; y < TEXTURE_SIZE; y++) {
                for (let x = 0; x < TEXTURE_SIZE; x++) {
                    const i = 4 * (y * TEXTURE_SIZE + x);
                    if (x < y) {
                        if (!sameColor(pixels, i, 0, 255, 0)) {
                            coveredMismatches++;
                        }
                    } else if (x == y) {
                        if (!sameColor(pixels, i, 0, 128, 0)) {
                            edgeMismatches++;
                        }
                    } else if (!sameColor(pixels, i, 0, 0, 0)) {
                        emptyMismatches++;
                    }
                }
            }
            const bottomLeft = 4 * (TEXTURE_SIZE - 1) * TEXTURE_SIZE;
            console.log(`Resolved: covered (${pixels[bottomLeft]}, ${pixels[bottomLeft + 1]}, ${pixels[bottomLeft + 2]}), `
                + `on the edge (${pixels[0]}, ${pixels[1]}, ${pixels[2]}), `
                + `empty (${pixels[4 * (TEXTURE_SIZE - 1)]}, ${pixels[4 * (TEXTURE_SIZE - 1) + 1]}, ${pixels[4 * (TEXTURE_SIZE - 1) + 2]})`);
            const triangle = TEXTURE_SIZE * (TEXTURE_SIZE - 1) / 2;
            check(coveredMismatches == 0, `the resolved covered pixels (${coveredMismatches} of ${triangle} differ)`);
            check(edgeMismatches == 0, `the resolved edge pixels, half their samples covered (${edgeMismatches} of ${TEXTURE_SIZE} differ)`);
            check(emptyMismatches == 0, `the resolved empty pixels (${emptyMismatches} of ${triangle} differ)`);
        }

        commandList.Release();
        pipeline.Release();
        framebuffer.Release();
        vertexShader.Release();
        pixelShader.Release();
        staging.Release();
        resolved.Release();
        multisampled.Release();
    }

    // Event and timer queries, with a command list of its own: IDevice::createEventQuery,
    // createTimerQuery; ICommandList::beginTimerQuery and endTimerQuery around work to time (a
    // 1024 x 1024 texture cleared 16 times). After executing it, IDevice::setEventQuery on the
    // graphics queue and waitEventQuery, without waitForIdle: pollEventQuery says it is done (not
    // yet without the wait). pollTimerQuery, getTimerQueryTime: the time the work took, in seconds,
    // more than 0 and less than 1. (Not a readback: mapBuffer waits for the buffer by itself.)
    function testQueries(device: nvrhi.IDevice): void {
        const WORK_SIZE = 1024;
        const eventQuery = nvrhi.createEventQuery(device);
        const timerQuery = nvrhi.createTimerQuery(device);
        let workDesc = nvrhi.textureDesc(WORK_SIZE, WORK_SIZE, Format.RGBA8_UNORM, "Timed work", nvrhi.RESOURCE_STATE_RENDER_TARGET);
        workDesc.isRenderTarget = true;
        const work = nvrhi.createTexture(device, workDesc);
        const commandList = nvrhi.createCommandList(device, nvrhi.commandListParameters());
        if (!eventQuery || !timerQuery || !work || !commandList) {
            check(false, "the query test's queries, texture and command list");
            return;
        }

        commandList.open();
        commandList.beginTimerQuery(timerQuery);
        for (let i = 0; i < 16; i++) {
            nvrhi.clearTextureFloat(commandList, work, nvrhi.allSubresources(), [i / 16, 0.5, 0.25, 1.0]);
        }
        commandList.endTimerQuery(timerQuery);
        commandList.close();
        nvrhi.executeCommandList(device, commandList);
        device.setEventQuery(eventQuery, nvrhi.COMMAND_QUEUE_GRAPHICS);
        device.waitEventQuery(eventQuery);
        check(device.pollEventQuery(eventQuery), "IDevice::pollEventQuery after waitEventQuery");

        check(device.pollTimerQuery(timerQuery), "IDevice::pollTimerQuery after the command list");
        const seconds = device.getTimerQueryTime(timerQuery);
        console.log(`Timer query: ${seconds * 1000000} microseconds`);
        check(seconds > 0 && seconds < 1, `IDevice::getTimerQueryTime (${seconds} s)`);

        commandList.Release();
        work.Release();
        timerQuery.Release();
        eventQuery.Release();
    }

    // A pipeline drawing nvrhi_direct.hlsl's green over the viewport into the framebuffer with the
    // stencil test of stencilFunc and passOp against reference 1 (failing pixels keep the
    // stencil), its color writes as colorWriteMask, no depth test or culling
    function stencilPipeline(device: nvrhi.IDevice, vertexShader: nvrhi.IShader, pixelShader: nvrhi.IShader,
        framebuffer: nvrhi.IFramebuffer, stencilFunc: u8, passOp: u8, colorWriteMask: u8): nvrhi.IGraphicsPipeline | null {
        let renderState = nvrhi.renderState();
        renderState.blendState.targets._0.colorWriteMask = colorWriteMask;
        renderState.depthStencilState.depthTestEnable = false;
        renderState.depthStencilState.depthWriteEnable = false;
        renderState.depthStencilState.stencilEnable = true;
        renderState.depthStencilState.stencilRefValue = 1;
        const ops: nvrhi.StencilOpDesc = [nvrhi.STENCIL_OP_KEEP, nvrhi.STENCIL_OP_KEEP, passOp, stencilFunc];
        renderState.depthStencilState.frontFaceStencil = ops;
        renderState.depthStencilState.backFaceStencil = ops;
        renderState.rasterState.cullMode = nvrhi.CULL_NONE;
        return nvrhi.createGraphicsPipeline(device,
            nvrhi.graphicsPipelineDesc(null, vertexShader, pixelShader, null, renderState), framebuffer);
    }

    // The stencil test, with a command list of its own: a color texture and a D32S8 depth stencil
    // texture, a framebuffer of both; ICommandList::clearDepthStencilTexture of the stencil to 0.
    // A draw over the left half that writes 1 into the stencil (Always, Replace) and no color, then
    // one over the whole texture where the stencil is 1 (Equal): the left half green, the right
    // half as cleared. Read back through a staging texture.
    function testStencil(app: App, device: nvrhi.IDevice, isD3D12: boolean): void {
        const color = nvrhi.createTexture(device, renderTargetDesc());
        let depthStencilDesc = nvrhi.textureDesc(TEXTURE_SIZE, TEXTURE_SIZE, Format.D32S8, "Stencil texture",
            nvrhi.RESOURCE_STATE_DEPTH_WRITE);
        depthStencilDesc.isRenderTarget = true;
        const depthStencil = nvrhi.createTexture(device, depthStencilDesc);
        const staging = nvrhi.createStagingTexture(device, renderTargetDesc(), nvrhi.CPU_ACCESS_READ);
        const vertexShader = loadShader(app, device, isD3D12, "nvrhi_direct", "main_vs", nvrhi.SHADER_TYPE_VERTEX);
        const pixelShader = loadShader(app, device, isD3D12, "nvrhi_direct", "main_ps", nvrhi.SHADER_TYPE_PIXEL);
        const commandList = nvrhi.createCommandList(device, nvrhi.commandListParameters());
        if (!color || !depthStencil || !staging || !vertexShader || !pixelShader || !commandList) {
            check(false, "the stencil test's textures, shaders and command list");
            return;
        }
        const framebuffer = nvrhi.createFramebuffer(device, nvrhi.framebufferDesc([color], depthStencil));
        if (!framebuffer) {
            check(false, "IDevice::createFramebuffer with a depth stencil attachment");
            return;
        }
        const mark = stencilPipeline(device, vertexShader, pixelShader, framebuffer,
            nvrhi.COMPARISON_ALWAYS, nvrhi.STENCIL_OP_REPLACE, 0);
        const masked = stencilPipeline(device, vertexShader, pixelShader, framebuffer,
            nvrhi.COMPARISON_EQUAL, nvrhi.STENCIL_OP_KEEP, nvrhi.COLOR_MASK_ALL);
        if (!mark || !masked) {
            check(false, "IDevice::createGraphicsPipeline with the stencil test");
            return;
        }
        const kept = Deref(masked.getDesc()).renderState.depthStencilState;
        check(kept.stencilEnable && kept.stencilRefValue == 1 && kept.frontFaceStencil.stencilFunc == nvrhi.COMPARISON_EQUAL,
            "IGraphicsPipeline::getDesc's stencil state");

        commandList.open();
        nvrhi.clearTextureFloat(commandList, color, nvrhi.allSubresources(), [0.0, 0.0, 0.0, 1.0]);
        nvrhi.clearDepthStencilTexture(commandList, depthStencil, nvrhi.allSubresources(), true, 1.0, true, 0);
        nvrhi.setGraphicsState(commandList, nvrhi.graphicsState(mark, framebuffer,
            [0, TEXTURE_SIZE / 2, 0, TEXTURE_SIZE, 0, 1], null, null, null, Format.UNKNOWN));
        nvrhi.draw(commandList, 3);
        nvrhi.setGraphicsState(commandList, nvrhi.graphicsState(masked, framebuffer,
            [0, TEXTURE_SIZE, 0, TEXTURE_SIZE, 0, 1], null, null, null, Format.UNKNOWN));
        nvrhi.draw(commandList, 3);
        nvrhi.copyTextureToStaging(commandList, staging, nvrhi.entireTexture(), color, nvrhi.entireTexture());
        commandList.close();
        nvrhi.executeCommandList(device, commandList);
        check(device.waitForIdle(), "IDevice::waitForIdle after the stencil test");

        const pixels = readStaging(device, staging);
        if (pixels.length != 0) {
            let passedMismatches = 0;
            let failedMismatches = 0;
            for (let y = 0; y < TEXTURE_SIZE; y++) {
                for (let x = 0; x < TEXTURE_SIZE; x++) {
                    const i = 4 * (y * TEXTURE_SIZE + x);
                    if (x < TEXTURE_SIZE / 2) {
                        if (!sameColor(pixels, i, 0, 255, 0)) {
                            passedMismatches++;
                        }
                    } else if (!sameColor(pixels, i, 0, 0, 0)) {
                        failedMismatches++;
                    }
                }
            }
            const last = 4 * (TEXTURE_SIZE - 1);
            console.log(`Stencil test: passed (${pixels[0]}, ${pixels[1]}, ${pixels[2]}), `
                + `failed (${pixels[last]}, ${pixels[last + 1]}, ${pixels[last + 2]})`);
            const half = TEXTURE_SIZE * TEXTURE_SIZE / 2;
            check(passedMismatches == 0, `the stencil test where the stencil was written (${passedMismatches} of ${half} pixels differ)`);
            check(failedMismatches == 0, `the stencil test where it was cleared (${failedMismatches} of ${half} pixels differ)`);
        }

        commandList.Release();
        masked.Release();
        mark.Release();
        framebuffer.Release();
        vertexShader.Release();
        pixelShader.Release();
        staging.Release();
        depthStencil.Release();
        color.Release();
    }

    // An instance's attributes in the instancing test: its offset (x, y) and color (RGBA, floats)
    const INSTANCE_SIZE = 24;

    // Instancing, with a command list of its own: a vertex buffer of two instances' attributes,
    // an input layout reading them once an instance (VertexAttributeDesc::isInstanced), one draw of
    // two instances of a quad over the left half (nvrhi_direct_instanced.hlsl, its vertices from
    // SV_VertexID): the first left in red, the second moved right in blue. Read back through a
    // staging texture.
    function testInstancing(app: App, device: nvrhi.IDevice, isD3D12: boolean): void {
        const color = nvrhi.createTexture(device, renderTargetDesc());
        const staging = nvrhi.createStagingTexture(device, renderTargetDesc(), nvrhi.CPU_ACCESS_READ);
        const vertexShader = loadShader(app, device, isD3D12, "nvrhi_direct_instanced", "main_vs", nvrhi.SHADER_TYPE_VERTEX);
        const pixelShader = loadShader(app, device, isD3D12, "nvrhi_direct_instanced", "main_ps", nvrhi.SHADER_TYPE_PIXEL);
        const commandList = nvrhi.createCommandList(device, nvrhi.commandListParameters());
        let instanceBufferDesc = nvrhi.bufferDesc(2 * INSTANCE_SIZE, "Instances", nvrhi.RESOURCE_STATE_VERTEX_BUFFER,
            nvrhi.CPU_ACCESS_NONE);
        instanceBufferDesc.isVertexBuffer = true;
        const instanceBuffer = nvrhi.createBuffer(device, instanceBufferDesc);
        if (!color || !staging || !vertexShader || !pixelShader || !commandList || !instanceBuffer) {
            check(false, "the instancing test's textures, shaders, command list and instance buffer");
            return;
        }
        let offset = nvrhi.vertexAttributeDesc("OFFSET", Format.RG32_FLOAT, 0, 0, INSTANCE_SIZE);
        offset.isInstanced = true;
        let instanceColor = nvrhi.vertexAttributeDesc("COLOR", Format.RGBA32_FLOAT, 0, 8, INSTANCE_SIZE);
        instanceColor.isInstanced = true;
        const inputLayout = nvrhi.createInputLayout(device, [offset, instanceColor], vertexShader);
        const framebuffer = nvrhi.createFramebuffer(device, nvrhi.framebufferDesc([color], null));
        if (!inputLayout || !framebuffer) {
            check(false, "IDevice::createInputLayout of instance attributes and createFramebuffer");
            return;
        }
        check(inputLayout.getNumAttributes() == 2 && Deref(inputLayout.getAttributeDesc(1)).isInstanced,
            "IInputLayout::getAttributeDesc's isInstanced");
        let renderState = nvrhi.renderState();
        renderState.depthStencilState.depthTestEnable = false;
        renderState.depthStencilState.depthWriteEnable = false;
        renderState.rasterState.cullMode = nvrhi.CULL_NONE;
        const pipeline = nvrhi.createGraphicsPipeline(device,
            nvrhi.graphicsPipelineDesc(inputLayout, vertexShader, pixelShader, null, renderState), framebuffer);
        if (!pipeline) {
            check(false, "IDevice::createGraphicsPipeline for instancing");
            return;
        }

        // the instances: no offset, red; one to the right (clip space x + 1), blue
        let instances: f32[] = [0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 1, 1];
        commandList.open();
        nvrhi.clearTextureFloat(commandList, color, nvrhi.allSubresources(), [0.0, 0.0, 0.0, 1.0]);
        commandList.writeBuffer(instanceBuffer, <Opaque>Ref(instances[0]), 2 * INSTANCE_SIZE, 0);
        nvrhi.setGraphicsState(commandList, nvrhi.graphicsState(pipeline, framebuffer,
            [0, TEXTURE_SIZE, 0, TEXTURE_SIZE, 0, 1], null, instanceBuffer, null, Format.UNKNOWN));
        nvrhi.drawInstanced(commandList, 6, 2);
        nvrhi.copyTextureToStaging(commandList, staging, nvrhi.entireTexture(), color, nvrhi.entireTexture());
        commandList.close();
        nvrhi.executeCommandList(device, commandList);
        check(device.waitForIdle(), "IDevice::waitForIdle after the instancing test");

        const pixels = readStaging(device, staging);
        if (pixels.length != 0) {
            let firstMismatches = 0;
            let secondMismatches = 0;
            for (let y = 0; y < TEXTURE_SIZE; y++) {
                for (let x = 0; x < TEXTURE_SIZE; x++) {
                    const i = 4 * (y * TEXTURE_SIZE + x);
                    if (x < TEXTURE_SIZE / 2) {
                        if (!sameColor(pixels, i, 255, 0, 0)) {
                            firstMismatches++;
                        }
                    } else if (!sameColor(pixels, i, 0, 0, 255)) {
                        secondMismatches++;
                    }
                }
            }
            const last = 4 * (TEXTURE_SIZE - 1);
            console.log(`Instances (${pixels[0]}, ${pixels[1]}, ${pixels[2]}) and `
                + `(${pixels[last]}, ${pixels[last + 1]}, ${pixels[last + 2]})`);
            const half = TEXTURE_SIZE * TEXTURE_SIZE / 2;
            check(firstMismatches == 0, `the first instance (${firstMismatches} of ${half} pixels differ)`);
            check(secondMismatches == 0, `the second instance (${secondMismatches} of ${half} pixels differ)`);
        }

        commandList.Release();
        pipeline.Release();
        framebuffer.Release();
        inputLayout.Release();
        instanceBuffer.Release();
        vertexShader.Release();
        pixelShader.Release();
        staging.Release();
        color.Release();
    }

    // A compute shader writing a texture, with a command list of its own: a texture with UAVs
    // (TextureDesc::isUAV), a binding layout and set of its UAV (Texture_UAV, mip level 0), a
    // compute pipeline (nvrhi_direct_texture_uav.hlsl), one group of 4 x 4 threads, each writing a
    // pixel (64 x, 64 y, 128). Read back through a staging texture, exactly.
    function testTextureUav(app: App, device: nvrhi.IDevice, isD3D12: boolean): void {
        let outputDesc = nvrhi.textureDesc(TEXTURE_SIZE, TEXTURE_SIZE, Format.RGBA8_UNORM, "Texture UAV",
            nvrhi.RESOURCE_STATE_UNORDERED_ACCESS);
        outputDesc.isUAV = true;
        const output = nvrhi.createTexture(device, outputDesc);
        const staging = nvrhi.createStagingTexture(device, renderTargetDesc(), nvrhi.CPU_ACCESS_READ);
        const shader = loadShader(app, device, isD3D12, "nvrhi_direct_texture_uav", "main_cs", nvrhi.SHADER_TYPE_COMPUTE);
        const layout = nvrhi.createBindingLayout(device, nvrhi.SHADER_TYPE_COMPUTE,
            [nvrhi.bindingLayoutItem(0, nvrhi.RESOURCE_TYPE_TEXTURE_UAV)]);
        const commandList = nvrhi.createCommandList(device, nvrhi.commandListParameters());
        if (!output || !staging || !shader || !layout || !commandList) {
            check(false, "the texture UAV test's textures, shader, binding layout and command list");
            return;
        }
        check(Deref(output.getDesc()).isUAV, "ITexture::getDesc's isUAV");
        const bindingSet = nvrhi.createBindingSet(device, layout, [nvrhi.textureUavBindingSetItem(0, output)]);
        if (!bindingSet) {
            check(false, "IDevice::createBindingSet of a texture UAV");
            return;
        }
        const pipeline = nvrhi.createComputePipeline(device, nvrhi.computePipelineDesc(shader, layout));
        if (!pipeline) {
            check(false, "IDevice::createComputePipeline writing a texture");
            return;
        }

        commandList.open();
        nvrhi.setComputeState(commandList, nvrhi.computeState(pipeline, bindingSet));
        commandList.dispatch(1, 1, 1);
        nvrhi.copyTextureToStaging(commandList, staging, nvrhi.entireTexture(), output, nvrhi.entireTexture());
        commandList.close();
        nvrhi.executeCommandList(device, commandList);
        check(device.waitForIdle(), "IDevice::waitForIdle after the texture UAV test");

        const pixels = readStaging(device, staging);
        if (pixels.length != 0) {
            let mismatches = 0;
            for (let y = 0; y < TEXTURE_SIZE; y++) {
                for (let x = 0; x < TEXTURE_SIZE; x++) {
                    const i = 4 * (y * TEXTURE_SIZE + x);
                    if (pixels[i] != 64 * x || pixels[i + 1] != 64 * y || pixels[i + 2] != 128 || pixels[i + 3] != 255) {
                        mismatches++;
                    }
                }
            }
            const last = 4 * (TEXTURE_SIZE * TEXTURE_SIZE - 1);
            console.log(`Texture UAV (${pixels[0]}, ${pixels[1]}, ${pixels[2]}), ..., (${pixels[last]}, ${pixels[last + 1]}, ${pixels[last + 2]})`);
            check(mismatches == 0, `a compute shader writing a texture UAV (${mismatches} of ${TEXTURE_SIZE * TEXTURE_SIZE} pixels differ)`);
        }

        commandList.Release();
        pipeline.Release();
        bindingSet.Release();
        layout.Release();
        shader.Release();
        staging.Release();
        output.Release();
    }

    // Structured and raw buffers, with a command list of its own: a structured buffer of 16 items
    // of two uints (BufferDesc::structStride 8) and a raw buffer (canHaveRawViews), a binding
    // layout and set of their views (StructuredBuffer_SRV, RawBuffer_UAV), a compute pipeline
    // (nvrhi_direct_buffers.hlsl) storing item i's a * 100 + b at byte 4 i. Read back through a
    // buffer.
    function testStructuredAndRawBuffers(app: App, device: nvrhi.IDevice, isD3D12: boolean): void {
        const ITEMS = 16;
        let itemsDesc = nvrhi.bufferDesc(ITEMS * 8, "Items", nvrhi.RESOURCE_STATE_SHADER_RESOURCE, nvrhi.CPU_ACCESS_NONE);
        itemsDesc.structStride = 8;
        const items = nvrhi.createBuffer(device, itemsDesc);
        let rawDesc = nvrhi.bufferDesc(ITEMS * 4, "Raw output", nvrhi.RESOURCE_STATE_UNORDERED_ACCESS, nvrhi.CPU_ACCESS_NONE);
        rawDesc.canHaveRawViews = true;
        rawDesc.canHaveUAVs = true;
        const raw = nvrhi.createBuffer(device, rawDesc);
        const readback = nvrhi.createBuffer(device, nvrhi.bufferDesc(ITEMS * 4, "Raw readback", nvrhi.RESOURCE_STATE_COPY_DEST,
            nvrhi.CPU_ACCESS_READ));
        const shader = loadShader(app, device, isD3D12, "nvrhi_direct_buffers", "main_cs", nvrhi.SHADER_TYPE_COMPUTE);
        const layout = nvrhi.createBindingLayout(device, nvrhi.SHADER_TYPE_COMPUTE, [
            nvrhi.bindingLayoutItem(0, nvrhi.RESOURCE_TYPE_STRUCTURED_BUFFER_SRV),
            nvrhi.bindingLayoutItem(0, nvrhi.RESOURCE_TYPE_RAW_BUFFER_UAV)]);
        const commandList = nvrhi.createCommandList(device, nvrhi.commandListParameters());
        if (!items || !raw || !readback || !shader || !layout || !commandList) {
            check(false, "the structured and raw buffer test's buffers, shader, binding layout and command list");
            return;
        }
        check(Deref(items.getDesc()).structStride == 8 && Deref(raw.getDesc()).canHaveRawViews,
            "IBuffer::getDesc's structStride and canHaveRawViews");
        const bindingSet = nvrhi.createBindingSet(device, layout, [
            nvrhi.bufferBindingSetItem(0, nvrhi.RESOURCE_TYPE_STRUCTURED_BUFFER_SRV, items),
            nvrhi.bufferBindingSetItem(0, nvrhi.RESOURCE_TYPE_RAW_BUFFER_UAV, raw)]);
        if (!bindingSet) {
            check(false, "IDevice::createBindingSet of a structured and a raw buffer");
            return;
        }
        const pipeline = nvrhi.createComputePipeline(device, nvrhi.computePipelineDesc(shader, layout));
        if (!pipeline) {
            check(false, "IDevice::createComputePipeline over structured and raw buffers");
            return;
        }

        // item i: a = i, b = 2 i + 1
        let itemData: u32[] = [];
        for (let i = 0; i < ITEMS; i++) {
            itemData.push(i);
            itemData.push(2 * i + 1);
        }
        commandList.open();
        commandList.writeBuffer(items, <Opaque>Ref(itemData[0]), ITEMS * 8, 0);
        nvrhi.setComputeState(commandList, nvrhi.computeState(pipeline, bindingSet));
        commandList.dispatch(1, 1, 1);
        commandList.copyBuffer(readback, 0, raw, 0, ITEMS * 4);
        commandList.close();
        nvrhi.executeCommandList(device, commandList);
        check(device.waitForIdle(), "IDevice::waitForIdle after the structured and raw buffer test");

        const mapped = <Ref<u32>>device.mapBuffer(readback, nvrhi.CPU_ACCESS_READ);
        let mismatches = 0;
        for (let i = 0; i < ITEMS; i++) {
            if (Deref(mapped[i]) != i * 100 + 2 * i + 1) {
                mismatches++;
            }
        }
        console.log(`Structured into raw: [${Deref(mapped[0])}, ${Deref(mapped[1])}, ..., ${Deref(mapped[ITEMS - 1])}]`);
        device.unmapBuffer(readback);
        check(mismatches == 0, `a structured buffer read into a raw buffer (${mismatches} of ${ITEMS} differ)`);

        commandList.Release();
        pipeline.Release();
        bindingSet.Release();
        layout.Release();
        shader.Release();
        readback.Release();
        raw.Release();
        items.Release();
    }

    // The texture array's mip levels and array slices in testTextureSubresources
    const MIP_LEVELS = 3;
    const ARRAY_SIZE = 2;

    // The color of a mip level of an array slice in testTextureSubresources
    function subresourceColor(mipLevel: int, arraySlice: int): u8[] {
        return [<u8>(50 + 100 * arraySlice), <u8>(40 + 80 * mipLevel), <u8>(7 + 20 * arraySlice + 30 * mipLevel), 255];
    }

    // A texture array's subresources and a region copy, with a command list of its own: a 4 x 4
    // texture of 3 mip levels and 2 array slices (TEXTURE_DIMENSION_2D_ARRAY), each of its 6
    // subresources filled with a color by ICommandList::writeTexture (its array slice and mip
    // level); copyTexture of mip level 1 of array slice 1 (2 x 2) into a region at (1, 1) of a
    // cleared texture; copyTexture of each subresource into a staging texture of the same shape,
    // mapped a subresource at a time (mapStagingTexture of its slice). Each subresource its color;
    // the region its color in the cleared texture.
    function testTextureSubresources(device: nvrhi.IDevice): void {
        let arrayDesc = nvrhi.textureDesc(TEXTURE_SIZE, TEXTURE_SIZE, Format.RGBA8_UNORM, "Texture array",
            nvrhi.RESOURCE_STATE_COPY_DEST);
        arrayDesc.mipLevels = MIP_LEVELS;
        arrayDesc.arraySize = ARRAY_SIZE;
        arrayDesc.dimension = nvrhi.TEXTURE_DIMENSION_2D_ARRAY;
        const textureArray = nvrhi.createTexture(device, arrayDesc);
        arrayDesc.debugName = nvrhi.stdString("Array staging");
        const arrayStaging = nvrhi.createStagingTexture(device, arrayDesc, nvrhi.CPU_ACCESS_READ);
        const regionTarget = nvrhi.createTexture(device, renderTargetDesc());
        const regionStaging = nvrhi.createStagingTexture(device, renderTargetDesc(), nvrhi.CPU_ACCESS_READ);
        const commandList = nvrhi.createCommandList(device, nvrhi.commandListParameters());
        if (!textureArray || !arrayStaging || !regionTarget || !regionStaging || !commandList) {
            check(false, "the subresource test's textures and command list");
            return;
        }
        const keptDesc = Deref(textureArray.getDesc());
        check(keptDesc.mipLevels == MIP_LEVELS && keptDesc.arraySize == ARRAY_SIZE
            && keptDesc.dimension == nvrhi.TEXTURE_DIMENSION_2D_ARRAY, "the texture array's desc");

        commandList.open();
        for (let arraySlice = 0; arraySlice < ARRAY_SIZE; arraySlice++) {
            for (let mipLevel = 0; mipLevel < MIP_LEVELS; mipLevel++) {
                const size = TEXTURE_SIZE >> mipLevel;
                const color = subresourceColor(mipLevel, arraySlice);
                let texels: u8[] = [];
                for (let i = 0; i < size * size; i++) {
                    texels.push(color[0]);
                    texels.push(color[1]);
                    texels.push(color[2]);
                    texels.push(color[3]);
                }
                commandList.writeTexture(textureArray, arraySlice, mipLevel, <Opaque>Ref(texels[0]), size * 4, 0);
                nvrhi.copyTextureToStaging(commandList, arrayStaging, nvrhi.subresourceSlice(mipLevel, arraySlice),
                    textureArray, nvrhi.subresourceSlice(mipLevel, arraySlice));
            }
        }
        nvrhi.clearTextureFloat(commandList, regionTarget, nvrhi.allSubresources(), [0.0, 0.0, 0.0, 1.0]);
        nvrhi.copyTexture(commandList, regionTarget, nvrhi.textureRegion(1, 1, 2, 2, 0, 0),
            textureArray, nvrhi.textureRegion(0, 0, 2, 2, 1, 1));
        nvrhi.copyTextureToStaging(commandList, regionStaging, nvrhi.entireTexture(), regionTarget, nvrhi.entireTexture());
        commandList.close();
        nvrhi.executeCommandList(device, commandList);
        check(device.waitForIdle(), "IDevice::waitForIdle after the subresource test");

        // each subresource, mapped by its slice
        let subresourceMismatches = 0;
        for (let arraySlice = 0; arraySlice < ARRAY_SIZE; arraySlice++) {
            for (let mipLevel = 0; mipLevel < MIP_LEVELS; mipLevel++) {
                const size = TEXTURE_SIZE >> mipLevel;
                const color = subresourceColor(mipLevel, arraySlice);
                let rowPitch: index = 0;
                const mapped = nvrhi.mapStagingTexture(device, arrayStaging, nvrhi.subresourceSlice(mipLevel, arraySlice),
                    nvrhi.CPU_ACCESS_READ, Ref(rowPitch));
                if (!mapped || rowPitch < size * 4) {
                    check(false, `IDevice::mapStagingTexture of mip level ${mipLevel} of array slice ${arraySlice} (row pitch ${rowPitch})`);
                    if (mapped) {
                        device.unmapStagingTexture(arrayStaging);
                    }
                    continue;
                }
                const rows = <Ref<u8>>mapped;
                let differs = false;
                for (let y = 0; y < size; y++) {
                    for (let i = 0; i < size * 4; i++) {
                        if (Deref(rows[y * rowPitch + i]) != color[i % 4]) {
                            differs = true;
                        }
                    }
                }
                if (differs) {
                    console.log(`Mip level ${mipLevel} of array slice ${arraySlice}: (${Deref(rows[0])}, ${Deref(rows[1])}, ${Deref(rows[2])}), `
                        + `expected (${color[0]}, ${color[1]}, ${color[2]})`);
                    subresourceMismatches++;
                }
                device.unmapStagingTexture(arrayStaging);
            }
        }
        check(subresourceMismatches == 0, `ICommandList::writeTexture and copyTexture of each subresource (${subresourceMismatches} of ${MIP_LEVELS * ARRAY_SIZE} differ)`);

        // the region: mip level 1 of array slice 1 at (1, 1) to (2, 2), the rest as cleared
        const pixels = readStaging(device, regionStaging);
        if (pixels.length != 0) {
            const color = subresourceColor(1, 1);
            let regionMismatches = 0;
            let outsideMismatches = 0;
            for (let y = 0; y < TEXTURE_SIZE; y++) {
                for (let x = 0; x < TEXTURE_SIZE; x++) {
                    const i = 4 * (y * TEXTURE_SIZE + x);
                    if (x >= 1 && x <= 2 && y >= 1 && y <= 2) {
                        if (!sameColor(pixels, i, color[0], color[1], color[2])) {
                            regionMismatches++;
                        }
                    } else if (!sameColor(pixels, i, 0, 0, 0)) {
                        outsideMismatches++;
                    }
                }
            }
            const inside = 4 * (TEXTURE_SIZE + 1);
            console.log(`Subresources: region (${pixels[inside]}, ${pixels[inside + 1]}, ${pixels[inside + 2]}), `
                + `outside (${pixels[0]}, ${pixels[1]}, ${pixels[2]})`);
            check(regionMismatches == 0, `ICommandList::copyTexture of a region (${regionMismatches} of 4 pixels differ)`);
            check(outsideMismatches == 0, `ICommandList::copyTexture outside its region (${outsideMismatches} of 12 pixels differ)`);
        }

        commandList.Release();
        regionStaging.Release();
        regionTarget.Release();
        arrayStaging.Release();
        textureArray.Release();
    }

    // The u32 texels of a size x size R32_UINT staging texture's mip level (of array slice 0):
    // IDevice::mapStagingTexture of its slice, unmapStagingTexture. None on failure, reported.
    function readStagingUInts(device: nvrhi.IDevice, staging: nvrhi.IStagingTexture, mipLevel: u32, size: int): u32[] {
        let texels: u32[] = [];
        let rowPitch: index = 0;
        const mapped = nvrhi.mapStagingTexture(device, staging, nvrhi.subresourceSlice(mipLevel, 0), nvrhi.CPU_ACCESS_READ, Ref(rowPitch));
        if (!mapped) {
            check(false, `IDevice::mapStagingTexture of mip level ${mipLevel}`);
            return texels;
        }
        if (rowPitch < size * 4) {
            check(false, `IDevice::mapStagingTexture's row pitch (${rowPitch})`);
        } else {
            const rows = <Ref<u32>>mapped;
            for (let y = 0; y < size; y++) {
                for (let x = 0; x < size; x++) {
                    texels.push(Deref(rows[y * (rowPitch / 4) + x]));
                }
            }
        }
        device.unmapStagingTexture(staging);
        return texels;
    }

    // The values testClearTextureUInt clears to: all subresources, then mip level 1
    const UINT_CLEAR_ALL: u32 = 0x12345678;
    const UINT_CLEAR_MIP: u32 = 0xc0ffee42;

    // ICommandList::clearTextureUInt, with a command list of its own: an R32_UINT texture with UAVs
    // and 2 mip levels, cleared whole to UINT_CLEAR_ALL, then its mip level 1 alone to
    // UINT_CLEAR_MIP (a TextureSubresourceSet by value, as clearTextureFloat's). Each mip level read
    // back through a staging texture: exactly its value.
    function testClearTextureUInt(device: nvrhi.IDevice): void {
        let desc = nvrhi.textureDesc(TEXTURE_SIZE, TEXTURE_SIZE, Format.R32_UINT, "UInt texture",
            nvrhi.RESOURCE_STATE_UNORDERED_ACCESS);
        desc.mipLevels = 2;
        desc.isUAV = true;
        const texture = nvrhi.createTexture(device, desc);
        desc.debugName = nvrhi.stdString("UInt staging");
        const staging = nvrhi.createStagingTexture(device, desc, nvrhi.CPU_ACCESS_READ);
        const commandList = nvrhi.createCommandList(device, nvrhi.commandListParameters());
        if (!texture || !staging || !commandList) {
            check(false, "the clearTextureUInt test's textures and command list");
            return;
        }

        commandList.open();
        nvrhi.clearTextureUInt(commandList, texture, nvrhi.allSubresources(), UINT_CLEAR_ALL);
        nvrhi.clearTextureUInt(commandList, texture, [1, 1, 0, 1], UINT_CLEAR_MIP);
        for (let mipLevel = 0; mipLevel < 2; mipLevel++) {
            nvrhi.copyTextureToStaging(commandList, staging, nvrhi.subresourceSlice(mipLevel, 0),
                texture, nvrhi.subresourceSlice(mipLevel, 0));
        }
        commandList.close();
        nvrhi.executeCommandList(device, commandList);
        check(device.waitForIdle(), "IDevice::waitForIdle after the clearTextureUInt test");

        const mip0 = readStagingUInts(device, staging, 0, TEXTURE_SIZE);
        const mip1 = readStagingUInts(device, staging, 1, TEXTURE_SIZE / 2);
        if (mip0.length != 0 && mip1.length != 0) {
            let allMismatches = 0;
            for (let i = 0; i < mip0.length; i++) {
                if (mip0[i] != UINT_CLEAR_ALL) {
                    allMismatches++;
                }
            }
            let mipMismatches = 0;
            for (let i = 0; i < mip1.length; i++) {
                if (mip1[i] != UINT_CLEAR_MIP) {
                    mipMismatches++;
                }
            }
            console.log(`clearTextureUInt: mip level 0 ${mip0[0]}, mip level 1 ${mip1[0]}`);
            check(allMismatches == 0, `ICommandList::clearTextureUInt of all subresources (${allMismatches} of ${mip0.length} texels differ)`);
            check(mipMismatches == 0, `ICommandList::clearTextureUInt of mip level 1 (${mipMismatches} of ${mip1.length} texels differ)`);
        }

        commandList.Release();
        staging.Release();
        texture.Release();
    }

    // A texture's state tracked by hand, with a command list of its own and automatic barriers off:
    // a render target with no initial state (keepInitialState false), which NVRHI doesn't track
    // until ICommandList::beginTrackingTextureState (Common: as D3D12 creates it, Vulkan's undefined
    // layout); setTextureState to the state its clear needs (D3D12's render target view clear,
    // Vulkan's transfer) and commitBarriers; clearTextureFloat; setPermanentTextureState to
    // CopySource, which NVRHI keeps from then on. getTextureSubresourceState after each. Read back
    // through a staging texture (automatic barriers on again): the clear color.
    function testTextureStateTracking(device: nvrhi.IDevice, isD3D12: boolean): void {
        let desc = nvrhi.textureDesc(TEXTURE_SIZE, TEXTURE_SIZE, Format.RGBA8_UNORM, "Tracked texture", nvrhi.RESOURCE_STATE_UNKNOWN);
        desc.isRenderTarget = true;
        const texture = nvrhi.createTexture(device, desc);
        const staging = nvrhi.createStagingTexture(device, renderTargetDesc(), nvrhi.CPU_ACCESS_READ);
        const commandList = nvrhi.createCommandList(device, nvrhi.commandListParameters());
        if (!texture || !staging || !commandList) {
            check(false, "the texture state test's textures and command list");
            return;
        }
        check(!Deref(texture.getDesc()).keepInitialState, "ITexture::getDesc's keepInitialState");
        const clearState = isD3D12 ? nvrhi.RESOURCE_STATE_RENDER_TARGET : nvrhi.RESOURCE_STATE_COPY_DEST;

        commandList.open();
        commandList.setEnableAutomaticBarriers(false);
        nvrhi.beginTrackingTextureState(commandList, texture, nvrhi.allSubresources(), nvrhi.RESOURCE_STATE_COMMON);
        const begun = commandList.getTextureSubresourceState(texture, 0, 0);
        nvrhi.setTextureState(commandList, texture, nvrhi.allSubresources(), clearState);
        commandList.commitBarriers();
        const afterSet = commandList.getTextureSubresourceState(texture, 0, 0);
        nvrhi.clearTextureFloat(commandList, texture, nvrhi.allSubresources(), [0.0, 0.5, 1.0, 1.0]);
        commandList.setPermanentTextureState(texture, nvrhi.RESOURCE_STATE_COPY_SOURCE);
        commandList.commitBarriers();
        const permanent = commandList.getTextureSubresourceState(texture, 0, 0);
        commandList.setEnableAutomaticBarriers(true);
        nvrhi.copyTextureToStaging(commandList, staging, nvrhi.entireTexture(), texture, nvrhi.entireTexture());
        commandList.close();
        nvrhi.executeCommandList(device, commandList);
        check(device.waitForIdle(), "IDevice::waitForIdle after the texture state test");

        console.log(`Texture states: begun ${begun}, set ${afterSet}, permanent ${permanent}`);
        check(begun == nvrhi.RESOURCE_STATE_COMMON, "ICommandList::beginTrackingTextureState");
        check(afterSet == clearState, "ICommandList::setTextureState");
        check(permanent == nvrhi.RESOURCE_STATE_COPY_SOURCE, "ICommandList::setPermanentTextureState");
        const pixels = readStaging(device, staging);
        if (pixels.length != 0) {
            let mismatches = 0;
            for (let i = 0; i < pixels.length; i += 4) {
                if (!sameColor(pixels, i, 0, 128, 255)) {
                    mismatches++;
                }
            }
            check(mismatches == 0, `a clear between barriers made by hand (${mismatches} of ${TEXTURE_SIZE * TEXTURE_SIZE} pixels differ)`);
        }

        commandList.Release();
        staging.Release();
        texture.Release();
    }

    // A buffer's state tracked by hand, with a command list of its own and automatic barriers off:
    // a buffer with no initial state, ICommandList::beginTrackingBufferState (Common); setBufferState
    // to CopyDest for writeBuffer, then to CopySource for copyBuffer into a readback buffer;
    // setPermanentBufferState to ShaderResource. getBufferState after each. The readback: what was
    // written.
    function testBufferStateTracking(device: nvrhi.IDevice): void {
        const VALUES = 16;
        const buffer = nvrhi.createBuffer(device, nvrhi.bufferDesc(VALUES * 4, "Tracked buffer", nvrhi.RESOURCE_STATE_UNKNOWN,
            nvrhi.CPU_ACCESS_NONE));
        const readback = nvrhi.createBuffer(device, nvrhi.bufferDesc(VALUES * 4, "State readback", nvrhi.RESOURCE_STATE_COPY_DEST,
            nvrhi.CPU_ACCESS_READ));
        const commandList = nvrhi.createCommandList(device, nvrhi.commandListParameters());
        if (!buffer || !readback || !commandList) {
            check(false, "the buffer state test's buffers and command list");
            return;
        }
        check(!Deref(buffer.getDesc()).keepInitialState, "IBuffer::getDesc's keepInitialState");

        let values: u32[] = [];
        for (let i = 0; i < VALUES; i++) {
            values.push(3 * i + 1);
        }
        commandList.open();
        commandList.setEnableAutomaticBarriers(false);
        commandList.beginTrackingBufferState(buffer, nvrhi.RESOURCE_STATE_COMMON);
        const begun = commandList.getBufferState(buffer);
        commandList.setBufferState(buffer, nvrhi.RESOURCE_STATE_COPY_DEST);
        commandList.commitBarriers();
        const written = commandList.getBufferState(buffer);
        commandList.writeBuffer(buffer, <Opaque>Ref(values[0]), VALUES * 4, 0);
        commandList.setBufferState(buffer, nvrhi.RESOURCE_STATE_COPY_SOURCE);
        commandList.commitBarriers();
        const copied = commandList.getBufferState(buffer);
        commandList.copyBuffer(readback, 0, buffer, 0, VALUES * 4);
        commandList.setPermanentBufferState(buffer, nvrhi.RESOURCE_STATE_SHADER_RESOURCE);
        commandList.commitBarriers();
        const permanent = commandList.getBufferState(buffer);
        commandList.setEnableAutomaticBarriers(true);
        commandList.close();
        nvrhi.executeCommandList(device, commandList);
        check(device.waitForIdle(), "IDevice::waitForIdle after the buffer state test");

        console.log(`Buffer states: begun ${begun}, written ${written}, copied ${copied}, permanent ${permanent}`);
        check(begun == nvrhi.RESOURCE_STATE_COMMON, "ICommandList::beginTrackingBufferState");
        check(written == nvrhi.RESOURCE_STATE_COPY_DEST && copied == nvrhi.RESOURCE_STATE_COPY_SOURCE,
            "ICommandList::setBufferState and getBufferState");
        check(permanent == nvrhi.RESOURCE_STATE_SHADER_RESOURCE, "ICommandList::setPermanentBufferState");
        const mapped = <Ref<u32>>device.mapBuffer(readback, nvrhi.CPU_ACCESS_READ);
        let mismatches = 0;
        for (let i = 0; i < VALUES; i++) {
            if (Deref(mapped[i]) != 3 * i + 1) {
                mismatches++;
            }
        }
        device.unmapBuffer(readback);
        check(mismatches == 0, `a buffer written and copied between barriers made by hand (${mismatches} of ${VALUES} differ)`);

        commandList.Release();
        readback.Release();
        buffer.Release();
    }

    // n rounded up to a multiple of alignment (`%`: tslang's `/` divides as floats)
    function alignUp(n: u64, alignment: u64): u64 {
        return alignment == 0 || n % alignment == 0 ? n : n + alignment - n % alignment;
    }

    // Resources placed in heaps, with a command list of their own: a buffer and a render target
    // created virtual (isVirtual: no memory of their own), their IDevice::getBufferMemoryRequirements
    // and getTextureMemoryRequirements (a MemoryRequirements returned by value), a heap for each
    // (createHeap, IHeap::getDesc), bindBufferMemory at an offset of one alignment into its heap,
    // bindTextureMemory at 0. The buffer written and copied into a readback buffer, the texture
    // cleared and read back through a staging texture.
    function testPlacedResources(device: nvrhi.IDevice): void {
        const VALUES = 16;
        let bufferDesc = nvrhi.bufferDesc(VALUES * 4, "Placed buffer", nvrhi.RESOURCE_STATE_COPY_DEST, nvrhi.CPU_ACCESS_NONE);
        bufferDesc.isVirtual = true;
        const buffer = nvrhi.createBuffer(device, bufferDesc);
        let textureDesc = renderTargetDesc();
        textureDesc.debugName = nvrhi.stdString("Placed texture");
        textureDesc.isVirtual = true;
        const texture = nvrhi.createTexture(device, textureDesc);
        const readback = nvrhi.createBuffer(device, nvrhi.bufferDesc(VALUES * 4, "Placed readback", nvrhi.RESOURCE_STATE_COPY_DEST,
            nvrhi.CPU_ACCESS_READ));
        const staging = nvrhi.createStagingTexture(device, renderTargetDesc(), nvrhi.CPU_ACCESS_READ);
        const commandList = nvrhi.createCommandList(device, nvrhi.commandListParameters());
        if (!buffer || !texture || !readback || !staging || !commandList) {
            check(false, "the placed resource test's buffers, textures and command list");
            return;
        }
        check(Deref(buffer.getDesc()).isVirtual && Deref(texture.getDesc()).isVirtual, "IBuffer and ITexture::getDesc's isVirtual");

        const bufferRequirements = device.getBufferMemoryRequirements(buffer);
        const textureRequirements = device.getTextureMemoryRequirements(texture);
        console.log(`Memory requirements: buffer ${bufferRequirements.size} (alignment ${bufferRequirements.alignment}), `
            + `texture ${textureRequirements.size} (alignment ${textureRequirements.alignment})`);
        check(bufferRequirements.size >= VALUES * 4 && bufferRequirements.alignment != 0, "IDevice::getBufferMemoryRequirements");
        check(textureRequirements.size >= TEXTURE_SIZE * TEXTURE_SIZE * 4 && textureRequirements.alignment != 0,
            "IDevice::getTextureMemoryRequirements");
        const bufferOffset = alignUp(bufferRequirements.size, bufferRequirements.alignment);
        const bufferHeap = nvrhi.createHeap(device, 2 * bufferOffset, nvrhi.HEAP_TYPE_DEVICE_LOCAL, "Buffer heap");
        const textureHeap = nvrhi.createHeap(device, textureRequirements.size, nvrhi.HEAP_TYPE_DEVICE_LOCAL, "Texture heap");
        if (!bufferHeap || !textureHeap) {
            check(false, "IDevice::createHeap");
            return;
        }
        const heapDesc = Deref(bufferHeap.getDesc());
        check(heapDesc.capacity == 2 * bufferOffset && heapDesc.type == nvrhi.HEAP_TYPE_DEVICE_LOCAL
            && nvrhi.stdStringIs(heapDesc.debugName, "Buffer heap"), "IHeap::getDesc");
        check(device.bindBufferMemory(buffer, bufferHeap, bufferOffset), "IDevice::bindBufferMemory");
        check(device.bindTextureMemory(texture, textureHeap, 0), "IDevice::bindTextureMemory");

        let values: u32[] = [];
        for (let i = 0; i < VALUES; i++) {
            values.push(1000 + 7 * i);
        }
        commandList.open();
        commandList.writeBuffer(buffer, <Opaque>Ref(values[0]), VALUES * 4, 0);
        commandList.copyBuffer(readback, 0, buffer, 0, VALUES * 4);
        nvrhi.clearTextureFloat(commandList, texture, nvrhi.allSubresources(), [1.0, 0.5, 0.0, 1.0]);
        nvrhi.copyTextureToStaging(commandList, staging, nvrhi.entireTexture(), texture, nvrhi.entireTexture());
        commandList.close();
        nvrhi.executeCommandList(device, commandList);
        check(device.waitForIdle(), "IDevice::waitForIdle after the placed resource test");

        const mapped = <Ref<u32>>device.mapBuffer(readback, nvrhi.CPU_ACCESS_READ);
        let bufferMismatches = 0;
        for (let i = 0; i < VALUES; i++) {
            if (Deref(mapped[i]) != 1000 + 7 * i) {
                bufferMismatches++;
            }
        }
        device.unmapBuffer(readback);
        check(bufferMismatches == 0, `a buffer placed in a heap (${bufferMismatches} of ${VALUES} differ)`);
        const pixels = readStaging(device, staging);
        if (pixels.length != 0) {
            let textureMismatches = 0;
            for (let i = 0; i < pixels.length; i += 4) {
                if (!sameColor(pixels, i, 255, 128, 0)) {
                    textureMismatches++;
                }
            }
            check(textureMismatches == 0, `a texture placed in a heap (${textureMismatches} of ${TEXTURE_SIZE * TEXTURE_SIZE} pixels differ)`);
        }

        commandList.Release();
        staging.Release();
        readback.Release();
        texture.Release();
        buffer.Release();
        textureHeap.Release();
        bufferHeap.Release();
    }

    // Indexed indirect draws, with a command list of their own, as testDrawIndirect's: an index
    // buffer of three R32_UINT indices (0, 1, 2: nvrhi_direct.hlsl's vertices), a buffer of two
    // DrawIndexedIndirectArguments (indexCount, instanceCount, startIndexLocation,
    // baseVertexLocation, startInstanceLocation; 20 bytes). ICommandList::drawIndexedIndirect into
    // the left half from offset 20 (one instance), into the right half from 0 (none): the left half
    // green, the right half as cleared.
    function testDrawIndexedIndirect(app: App, device: nvrhi.IDevice, isD3D12: boolean): void {
        const color = nvrhi.createTexture(device, renderTargetDesc());
        const staging = nvrhi.createStagingTexture(device, renderTargetDesc(), nvrhi.CPU_ACCESS_READ);
        const vertexShader = loadShader(app, device, isD3D12, "nvrhi_direct", "main_vs", nvrhi.SHADER_TYPE_VERTEX);
        const pixelShader = loadShader(app, device, isD3D12, "nvrhi_direct", "main_ps", nvrhi.SHADER_TYPE_PIXEL);
        const commandList = nvrhi.createCommandList(device, nvrhi.commandListParameters());
        let indexDesc = nvrhi.bufferDesc(3 * 4, "Indices", nvrhi.RESOURCE_STATE_INDEX_BUFFER, nvrhi.CPU_ACCESS_NONE);
        indexDesc.isIndexBuffer = true;
        const indexBuffer = nvrhi.createBuffer(device, indexDesc);
        let argumentsDesc = nvrhi.bufferDesc(40, "Indexed args", nvrhi.RESOURCE_STATE_INDIRECT_ARGUMENT, nvrhi.CPU_ACCESS_NONE);
        argumentsDesc.isDrawIndirectArgs = true;
        const argumentsBuffer = nvrhi.createBuffer(device, argumentsDesc);
        if (!color || !staging || !vertexShader || !pixelShader || !commandList || !indexBuffer || !argumentsBuffer) {
            check(false, "the indexed indirect draw test's textures, shaders, command list and buffers");
            return;
        }
        const framebuffer = nvrhi.createFramebuffer(device, nvrhi.framebufferDesc([color], null));
        if (!framebuffer) {
            check(false, "IDevice::createFramebuffer for the indexed indirect draw test");
            return;
        }
        let renderState = nvrhi.renderState();
        renderState.depthStencilState.depthTestEnable = false;
        renderState.depthStencilState.depthWriteEnable = false;
        renderState.rasterState.cullMode = nvrhi.CULL_NONE;
        const pipeline = nvrhi.createGraphicsPipeline(device,
            nvrhi.graphicsPipelineDesc(null, vertexShader, pixelShader, null, renderState), framebuffer);
        if (!pipeline) {
            check(false, "IDevice::createGraphicsPipeline for the indexed indirect draw test");
            return;
        }

        let indices: u32[] = [0, 1, 2];
        let drawArguments: u32[] = [3, 0, 0, 0, 0, 3, 1, 0, 0, 0];
        commandList.open();
        nvrhi.clearTextureFloat(commandList, color, nvrhi.allSubresources(), [0.0, 0.0, 0.0, 1.0]);
        commandList.writeBuffer(indexBuffer, <Opaque>Ref(indices[0]), 3 * 4, 0);
        commandList.writeBuffer(argumentsBuffer, <Opaque>Ref(drawArguments[0]), 40, 0);
        let left = nvrhi.graphicsState(pipeline, framebuffer, [0, TEXTURE_SIZE / 2, 0, TEXTURE_SIZE, 0, 1],
            null, null, indexBuffer, Format.R32_UINT);
        left.indirectParams = argumentsBuffer;
        nvrhi.setGraphicsState(commandList, left);
        commandList.drawIndexedIndirect(20, 1);
        let right = nvrhi.graphicsState(pipeline, framebuffer, [TEXTURE_SIZE / 2, TEXTURE_SIZE, 0, TEXTURE_SIZE, 0, 1],
            null, null, indexBuffer, Format.R32_UINT);
        right.indirectParams = argumentsBuffer;
        nvrhi.setGraphicsState(commandList, right);
        commandList.drawIndexedIndirect(0, 1);
        nvrhi.copyTextureToStaging(commandList, staging, nvrhi.entireTexture(), color, nvrhi.entireTexture());
        commandList.close();
        nvrhi.executeCommandList(device, commandList);
        check(device.waitForIdle(), "IDevice::waitForIdle after the indexed indirect draw test");

        const pixels = readStaging(device, staging);
        if (pixels.length != 0) {
            let drawnMismatches = 0;
            let skippedMismatches = 0;
            for (let y = 0; y < TEXTURE_SIZE; y++) {
                for (let x = 0; x < TEXTURE_SIZE; x++) {
                    const i = 4 * (y * TEXTURE_SIZE + x);
                    if (x < TEXTURE_SIZE / 2) {
                        if (!sameColor(pixels, i, 0, 255, 0)) {
                            drawnMismatches++;
                        }
                    } else if (!sameColor(pixels, i, 0, 0, 0)) {
                        skippedMismatches++;
                    }
                }
            }
            const last = 4 * (TEXTURE_SIZE - 1);
            console.log(`Drawn indexed indirectly (${pixels[0]}, ${pixels[1]}, ${pixels[2]}), `
                + `no instance (${pixels[last]}, ${pixels[last + 1]}, ${pixels[last + 2]})`);
            const half = TEXTURE_SIZE * TEXTURE_SIZE / 2;
            check(drawnMismatches == 0, `ICommandList::drawIndexedIndirect from offset 20 (${drawnMismatches} of ${half} pixels differ)`);
            check(skippedMismatches == 0, `ICommandList::drawIndexedIndirect of no instance (${skippedMismatches} of ${half} pixels differ)`);
        }

        commandList.Release();
        pipeline.Release();
        framebuffer.Release();
        argumentsBuffer.Release();
        indexBuffer.Release();
        vertexShader.Release();
        pixelShader.Release();
        staging.Release();
        color.Release();
    }

    // IDevice::queryFormatSupport (FormatSupport bits): RGBA8_UNORM a sampled, blendable render
    // target and no depth format, D32 a depth format and no render target, R32_UINT a buffer format
    // with UAV stores.
    function testFormatSupport(device: nvrhi.IDevice): void {
        const rgba8 = device.queryFormatSupport(<u8>Format.RGBA8_UNORM);
        const d32 = device.queryFormatSupport(<u8>Format.D32);
        const r32 = device.queryFormatSupport(<u8>Format.R32_UINT);
        console.log(`IDevice::queryFormatSupport: RGBA8_UNORM ${rgba8}, D32 ${d32}, R32_UINT ${r32}`);
        const colorTarget = nvrhi.FORMAT_SUPPORT_TEXTURE | nvrhi.FORMAT_SUPPORT_RENDER_TARGET | nvrhi.FORMAT_SUPPORT_BLENDABLE
            | nvrhi.FORMAT_SUPPORT_SHADER_SAMPLE;
        check((rgba8 & colorTarget) == colorTarget && (rgba8 & nvrhi.FORMAT_SUPPORT_DEPTH_STENCIL) == 0,
            "IDevice::queryFormatSupport(RGBA8_UNORM)");
        check((d32 & nvrhi.FORMAT_SUPPORT_DEPTH_STENCIL) != 0 && (d32 & nvrhi.FORMAT_SUPPORT_RENDER_TARGET) == 0,
            "IDevice::queryFormatSupport(D32)");
        const uavBuffer = nvrhi.FORMAT_SUPPORT_BUFFER | nvrhi.FORMAT_SUPPORT_SHADER_UAV_STORE;
        check((r32 & uavBuffer) == uavBuffer, "IDevice::queryFormatSupport(R32_UINT)");
    }

    // Two command lists in one submission (IDevice::executeCommandLists of an array of them, run in
    // order): the first clears a texture, the second copies it into a staging texture. The copy: the
    // clear color.
    function testExecuteCommandLists(device: nvrhi.IDevice): void {
        const texture = nvrhi.createTexture(device, renderTargetDesc());
        const staging = nvrhi.createStagingTexture(device, renderTargetDesc(), nvrhi.CPU_ACCESS_READ);
        const first = nvrhi.createCommandList(device, nvrhi.commandListParameters());
        const second = nvrhi.createCommandList(device, nvrhi.commandListParameters());
        if (!texture || !staging || !first || !second) {
            check(false, "the command list submission test's textures and command lists");
            return;
        }

        first.open();
        nvrhi.clearTextureFloat(first, texture, nvrhi.allSubresources(), [1.0, 0.0, 1.0, 1.0]);
        first.close();
        second.open();
        nvrhi.copyTextureToStaging(second, staging, nvrhi.entireTexture(), texture, nvrhi.entireTexture());
        second.close();
        const instance = nvrhi.executeCommandLists(device, [first, second]);
        check(instance != 0, "IDevice::executeCommandLists' submission");
        check(device.waitForIdle(), "IDevice::waitForIdle after the command list submission test");

        const pixels = readStaging(device, staging);
        if (pixels.length != 0) {
            let mismatches = 0;
            for (let i = 0; i < pixels.length; i += 4) {
                if (!sameColor(pixels, i, 255, 0, 255)) {
                    mismatches++;
                }
            }
            console.log(`Two command lists: (${pixels[0]}, ${pixels[1]}, ${pixels[2]})`);
            check(mismatches == 0, `IDevice::executeCommandLists of two command lists (${mismatches} of ${TEXTURE_SIZE * TEXTURE_SIZE} pixels differ)`);
        }

        second.Release();
        first.Release();
        staging.Release();
        texture.Release();
    }

    // A command list lifetime tracker (IDevice::createCommandListLifetimeTracker for the graphics
    // queue, CommandListParameters::lifetimeTracker), which holds the command list's work until the
    // GPU is done with it, released by ICommandListLifetimeTracker::runGarbageCollection. The
    // command list clears a texture and copies it into a staging texture: the clear color.
    function testLifetimeTracker(device: nvrhi.IDevice): void {
        const tracker = nvrhi.createCommandListLifetimeTracker(device, nvrhi.COMMAND_QUEUE_GRAPHICS);
        if (!tracker) {
            check(false, "IDevice::createCommandListLifetimeTracker");
            return;
        }
        let params = nvrhi.commandListParameters();
        params.lifetimeTracker = tracker;
        const commandList = nvrhi.createCommandList(device, params);
        const texture = nvrhi.createTexture(device, renderTargetDesc());
        const staging = nvrhi.createStagingTexture(device, renderTargetDesc(), nvrhi.CPU_ACCESS_READ);
        if (!commandList || !texture || !staging) {
            check(false, "the lifetime tracker test's command list and textures");
            return;
        }
        const kept = Deref(commandList.getDesc()).lifetimeTracker;
        check(kept != null && <index><Opaque>kept == <index><Opaque>tracker, "ICommandList::getDesc's lifetimeTracker");

        commandList.open();
        nvrhi.clearTextureFloat(commandList, texture, nvrhi.allSubresources(), [0.0, 1.0, 1.0, 1.0]);
        nvrhi.copyTextureToStaging(commandList, staging, nvrhi.entireTexture(), texture, nvrhi.entireTexture());
        commandList.close();
        nvrhi.executeCommandList(device, commandList);
        check(device.waitForIdle(), "IDevice::waitForIdle after the lifetime tracker test");
        tracker.runGarbageCollection();

        const pixels = readStaging(device, staging);
        if (pixels.length != 0) {
            let mismatches = 0;
            for (let i = 0; i < pixels.length; i += 4) {
                if (!sameColor(pixels, i, 0, 255, 255)) {
                    mismatches++;
                }
            }
            check(mismatches == 0, `a command list with a lifetime tracker (${mismatches} of ${TEXTURE_SIZE * TEXTURE_SIZE} pixels differ)`);
        }

        staging.Release();
        texture.Release();
        commandList.Release();
        tracker.Release();
    }

    // testShaderSpecialization's compute pipeline of a shader over the layout; null on failure,
    // reported.
    function specializationPipeline(device: nvrhi.IDevice, shader: nvrhi.IShader, layout: nvrhi.IBindingLayout): nvrhi.IComputePipeline | null {
        const pipeline = nvrhi.createComputePipeline(device, nvrhi.computePipelineDesc(shader, layout));
        if (!pipeline) {
            check(false, "IDevice::createComputePipeline for the shader specialization test");
        }
        return pipeline;
    }

    // Shader specialization, with a command list of its own: IDevice::queryFeatureSupport
    // (ShaderSpecializations), which Vulkan has and D3D12 doesn't; on Vulkan,
    // createShaderSpecialization of nvrhi_direct_specialization.hlsl with its constant 0 set to 42
    // (a ShaderSpecialization: its ID, its value). The shader unspecialized (7) on both, and
    // specialized on Vulkan, each into a buffer: c_Value * 10 plus the index.
    function testShaderSpecialization(app: App, device: nvrhi.IDevice, isD3D12: boolean): void {
        const supported = device.queryFeatureSupport(nvrhi.FEATURE_SHADER_SPECIALIZATIONS, null, 0);
        console.log(`IDevice::queryFeatureSupport(ShaderSpecializations): ${supported}`);
        check(supported == !isD3D12, "IDevice::queryFeatureSupport(ShaderSpecializations): on Vulkan only");
        const shader = loadShader(app, device, isD3D12, "nvrhi_direct_specialization", "main_cs", nvrhi.SHADER_TYPE_COMPUTE);
        const layout = nvrhi.createBindingLayout(device, nvrhi.SHADER_TYPE_COMPUTE,
            [nvrhi.bindingLayoutItem(0, nvrhi.RESOURCE_TYPE_RAW_BUFFER_UAV)]);
        let outputDesc = nvrhi.bufferDesc(16, "Specialized", nvrhi.RESOURCE_STATE_UNORDERED_ACCESS, nvrhi.CPU_ACCESS_NONE);
        outputDesc.canHaveUAVs = true;
        outputDesc.canHaveRawViews = true;
        const baseOutput = nvrhi.createBuffer(device, outputDesc);
        const specializedOutput = nvrhi.createBuffer(device, outputDesc);
        const readback = nvrhi.createBuffer(device, nvrhi.bufferDesc(32, "Specialized back", nvrhi.RESOURCE_STATE_COPY_DEST,
            nvrhi.CPU_ACCESS_READ));
        const commandList = nvrhi.createCommandList(device, nvrhi.commandListParameters());
        if (!shader || !layout || !baseOutput || !specializedOutput || !readback || !commandList) {
            check(false, "the shader specialization test's shader, binding layout, buffers and command list");
            return;
        }
        const baseSet = nvrhi.createBindingSet(device, layout, [nvrhi.bufferBindingSetItem(0, nvrhi.RESOURCE_TYPE_RAW_BUFFER_UAV, baseOutput)]);
        const specializedSet = nvrhi.createBindingSet(device, layout,
            [nvrhi.bufferBindingSetItem(0, nvrhi.RESOURCE_TYPE_RAW_BUFFER_UAV, specializedOutput)]);
        const basePipeline = specializationPipeline(device, shader, layout);
        if (!baseSet || !specializedSet || !basePipeline) {
            check(false, "the shader specialization test's binding sets and pipeline");
            return;
        }
        const specialized = supported ? nvrhi.createShaderSpecialization(device, shader, [[0, 42]]) : null;
        if (supported && !specialized) {
            check(false, "IDevice::createShaderSpecialization");
        }
        const specializedPipeline = specialized ? specializationPipeline(device, specialized, layout) : null;

        commandList.open();
        nvrhi.setComputeState(commandList, nvrhi.computeState(basePipeline, baseSet));
        commandList.dispatch(1, 1, 1);
        commandList.copyBuffer(readback, 0, baseOutput, 0, 16);
        if (specializedPipeline) {
            nvrhi.setComputeState(commandList, nvrhi.computeState(specializedPipeline, specializedSet));
            commandList.dispatch(1, 1, 1);
            commandList.copyBuffer(readback, 16, specializedOutput, 0, 16);
        }
        commandList.close();
        nvrhi.executeCommandList(device, commandList);
        check(device.waitForIdle(), "IDevice::waitForIdle after the shader specialization test");

        const specializedRan = specializedPipeline ? true : false;
        const mapped = <Ref<u32>>device.mapBuffer(readback, nvrhi.CPU_ACCESS_READ);
        let baseMismatches = 0;
        let specializedMismatches = 0;
        for (let i = 0; i < 4; i++) {
            if (Deref(mapped[i]) != 70 + i) {
                baseMismatches++;
            }
            if (specializedRan && Deref(mapped[4 + i]) != 420 + i) {
                specializedMismatches++;
            }
        }
        console.log(`Shader specialization: unspecialized ${Deref(mapped[0])}`
            + (specializedRan ? `, specialized ${Deref(mapped[4])}` : ""));
        device.unmapBuffer(readback);
        check(baseMismatches == 0, `the unspecialized shader (${baseMismatches} of 4 differ)`);
        check(specializedMismatches == 0, `IDevice::createShaderSpecialization's shader (${specializedMismatches} of 4 differ)`);

        if (specializedPipeline) {
            specializedPipeline.Release();
        }
        if (specialized) {
            specialized.Release();
        }
        commandList.Release();
        basePipeline.Release();
        specializedSet.Release();
        baseSet.Release();
        readback.Release();
        specializedOutput.Release();
        baseOutput.Release();
        layout.Release();
        shader.Release();
    }

    // A bindless descriptor table, with a command list of its own: IDevice::createBindlessLayout of
    // raw buffers in register space 1 (at most 16), createDescriptorTable of it, resizeDescriptorTable
    // to 4 (IDescriptorTable::getCapacity: 4 on D3D12, 16 on Vulkan), writeDescriptorTable of 4 raw buffers, each holding a
    // value, at their indices. A compute pipeline of two binding layouts (a raw buffer UAV, then the
    // bindless layout: nvrhi_direct_bindless.hlsl), its state of a binding set and the table; the
    // buffers set to ShaderResource by hand after their writes (NVRHI doesn't track a table's
    // resources). Thread i stores buffer 3 - i's value: the values reversed.
    function testBindless(app: App, device: nvrhi.IDevice, isD3D12: boolean): void {
        const BUFFERS = 4;
        const MAX_CAPACITY = 16;
        const shader = loadShader(app, device, isD3D12, "nvrhi_direct_bindless", "main_cs", nvrhi.SHADER_TYPE_COMPUTE);
        const layout = nvrhi.createBindingLayout(device, nvrhi.SHADER_TYPE_COMPUTE,
            [nvrhi.bindingLayoutItem(0, nvrhi.RESOURCE_TYPE_RAW_BUFFER_UAV)]);
        const bindlessLayout = nvrhi.createBindlessLayout(device, nvrhi.SHADER_TYPE_COMPUTE, MAX_CAPACITY,
            nvrhi.bindingLayoutItem(1, nvrhi.RESOURCE_TYPE_RAW_BUFFER_SRV));
        let outputDesc = nvrhi.bufferDesc(BUFFERS * 4, "Bindless output", nvrhi.RESOURCE_STATE_UNORDERED_ACCESS, nvrhi.CPU_ACCESS_NONE);
        outputDesc.canHaveUAVs = true;
        outputDesc.canHaveRawViews = true;
        const output = nvrhi.createBuffer(device, outputDesc);
        const readback = nvrhi.createBuffer(device, nvrhi.bufferDesc(BUFFERS * 4, "Bindless back", nvrhi.RESOURCE_STATE_COPY_DEST,
            nvrhi.CPU_ACCESS_READ));
        const commandList = nvrhi.createCommandList(device, nvrhi.commandListParameters());
        if (!shader || !layout || !bindlessLayout || !output || !readback || !commandList) {
            check(false, "the bindless test's shader, binding layouts, buffers and command list");
            return;
        }
        const table = nvrhi.createDescriptorTable(device, bindlessLayout);
        const otherTable = nvrhi.createDescriptorTable(device, bindlessLayout);
        if (!table || !otherTable) {
            check(false, "IDevice::createDescriptorTable");
            return;
        }
        // IBindingLayout::getBindlessDesc: the desc NVRHI keeps; below, IDescriptorTable::
        // getFirstDescriptorIndexInHeap: where each table starts in D3D12's shader visible heap
        // (two tables: two places), 0 on Vulkan (a descriptor set each)
        const bindlessDesc = Deref(bindlessLayout.getBindlessDesc());
        check(bindlessDesc.maxCapacity == MAX_CAPACITY && bindlessDesc.visibility == nvrhi.SHADER_TYPE_COMPUTE
            && bindlessDesc.registerSpaces.current_size == 1, "IBindingLayout::getBindlessDesc");
        // (Vulkan's table has the layout's capacity from the start, and resizing it does nothing;
        // D3D12's has its place in the heap once resized)
        device.resizeDescriptorTable(table, BUFFERS, true);
        device.resizeDescriptorTable(otherTable, BUFFERS, true);
        const first = table.getFirstDescriptorIndexInHeap();
        const otherFirst = otherTable.getFirstDescriptorIndexInHeap();
        console.log(`IDescriptorTable::getFirstDescriptorIndexInHeap: ${first}, another table ${otherFirst}`);
        check(isD3D12 ? first != otherFirst : first == 0 && otherFirst == 0, "IDescriptorTable::getFirstDescriptorIndexInHeap");
        otherTable.Release();
        check(table.getCapacity() == (isD3D12 ? BUFFERS : MAX_CAPACITY),
            `IDevice::resizeDescriptorTable, IDescriptorTable::getCapacity (${table.getCapacity()})`);
        let buffers: nvrhi.IBuffer[] = [];
        for (let i = 0; i < BUFFERS; i++) {
            let desc = nvrhi.bufferDesc(16, `Bindless ${i}`, nvrhi.RESOURCE_STATE_SHADER_RESOURCE, nvrhi.CPU_ACCESS_NONE);
            desc.canHaveRawViews = true;
            const buffer = nvrhi.createBuffer(device, desc);
            if (!buffer) {
                check(false, "the bindless test's buffers");
                return;
            }
            buffers.push(buffer);
            check(nvrhi.writeDescriptorTable(device, table, nvrhi.bufferBindingSetItem(i, nvrhi.RESOURCE_TYPE_RAW_BUFFER_SRV, buffer)),
                `IDevice::writeDescriptorTable at ${i}`);
        }
        const bindingSet = nvrhi.createBindingSet(device, layout, [nvrhi.bufferBindingSetItem(0, nvrhi.RESOURCE_TYPE_RAW_BUFFER_UAV, output)]);
        if (!bindingSet) {
            check(false, "IDevice::createBindingSet for the bindless test");
            return;
        }
        // (a ComputePipelineDesc and a ComputeState of two each, as computePipelineDesc() and
        // computeState() make them of one; the table is a binding set)
        const pipeline = nvrhi.createComputePipeline(device,
            [[shader], [[[layout], [bindlessLayout], [null], [null], [null], [null], [null], [null]], 2]]);
        if (!pipeline) {
            check(false, "IDevice::createComputePipeline with a bindless layout");
            return;
        }

        commandList.open();
        for (let i = 0; i < BUFFERS; i++) {
            let value: u32[] = [100 + 11 * i];
            commandList.writeBuffer(buffers[i], <Opaque>Ref(value[0]), 4, 0);
            commandList.setBufferState(buffers[i], nvrhi.RESOURCE_STATE_SHADER_RESOURCE);
        }
        commandList.commitBarriers();
        nvrhi.setComputeState(commandList, [pipeline, [[bindingSet, <nvrhi.IBindingSet><Opaque>table, null, null, null, null, null, null], 2], null]);
        commandList.dispatch(1, 1, 1);
        commandList.copyBuffer(readback, 0, output, 0, BUFFERS * 4);
        commandList.close();
        nvrhi.executeCommandList(device, commandList);
        check(device.waitForIdle(), "IDevice::waitForIdle after the bindless test");

        const mapped = <Ref<u32>>device.mapBuffer(readback, nvrhi.CPU_ACCESS_READ);
        let mismatches = 0;
        for (let i = 0; i < BUFFERS; i++) {
            if (Deref(mapped[i]) != 100 + 11 * (BUFFERS - 1 - i)) {
                mismatches++;
            }
        }
        console.log(`Bindless: [${Deref(mapped[0])}, ${Deref(mapped[1])}, ${Deref(mapped[2])}, ${Deref(mapped[3])}]`);
        device.unmapBuffer(readback);
        check(mismatches == 0, `buffers read through a descriptor table (${mismatches} of ${BUFFERS} differ)`);

        commandList.Release();
        pipeline.Release();
        bindingSet.Release();
        for (let i = 0; i < BUFFERS; i++) {
            buffers[i].Release();
        }
        table.Release();
        readback.Release();
        output.Release();
        bindlessLayout.Release();
        layout.Release();
        shader.Release();
    }

    // Native views of a texture's subresources, with no command list: ITexture::getNativeView (a
    // TextureSubresourceSet by value; the API's view: D3D12 a shader resource view's GPU
    // descriptor, Vulkan a VkImageView) of a texture of 2 mip levels, of all its subresources, of mip
    // level 1, then of all again. NVRHI makes a view per subresource set and keeps it: the first and
    // the third the same, the second another.
    function testNativeViews(device: nvrhi.IDevice, isD3D12: boolean): void {
        let desc = nvrhi.textureDesc(TEXTURE_SIZE, TEXTURE_SIZE, Format.RGBA8_UNORM, "Viewed texture", nvrhi.RESOURCE_STATE_SHADER_RESOURCE);
        desc.mipLevels = 2;
        const texture = nvrhi.createTexture(device, desc);
        if (!texture) {
            check(false, "the native view test's texture");
            return;
        }

        const viewType = isD3D12 ? nvrhi.OBJECT_TYPE_D3D12_SRV_GPU_DESCRIPTOR : nvrhi.OBJECT_TYPE_VK_IMAGE_VIEW;
        const all = nvrhi.getNativeView(texture, viewType, <u8>Format.RGBA8_UNORM, nvrhi.allSubresources(), nvrhi.TEXTURE_DIMENSION_2D);
        const mip1 = nvrhi.getNativeView(texture, viewType, <u8>Format.RGBA8_UNORM, [1, 1, 0, 1], nvrhi.TEXTURE_DIMENSION_2D);
        const allAgain = nvrhi.getNativeView(texture, viewType, <u8>Format.RGBA8_UNORM, nvrhi.allSubresources(), nvrhi.TEXTURE_DIMENSION_2D);
        if (!all || !mip1 || !allAgain) {
            check(false, "ITexture::getNativeView");
        } else {
            console.log(`ITexture::getNativeView: all ${<index>all}, mip level 1 ${<index>mip1}, all again ${<index>allAgain}`);
            check(<index>all == <index>allAgain, "ITexture::getNativeView of the same subresources: the same view");
            check(<index>all != <index>mip1, "ITexture::getNativeView of another mip level: another view");
        }

        texture.Release();
    }

    // Handles of API objects, with two command lists: a texture and a buffer, their API objects
    // (getNativeObject: D3D12 resources; a VkImage, a VkBuffer), and an NVRHI handle of each
    // (IDevice::createHandleForNativeTexture, createHandleForNativeBuffer: an nvrhi::Object by
    // value). The first command list clears the texture and writes the buffer through the new
    // handles, the second copies them through the old ones: what the first wrote.
    function testNativeHandles(device: nvrhi.IDevice, isD3D12: boolean): void {
        const VALUES = 16;
        const texture = nvrhi.createTexture(device, renderTargetDesc());
        const buffer = nvrhi.createBuffer(device, nvrhi.bufferDesc(VALUES * 4, "Native buffer", nvrhi.RESOURCE_STATE_COPY_DEST,
            nvrhi.CPU_ACCESS_NONE));
        const staging = nvrhi.createStagingTexture(device, renderTargetDesc(), nvrhi.CPU_ACCESS_READ);
        const readback = nvrhi.createBuffer(device, nvrhi.bufferDesc(VALUES * 4, "Native readback", nvrhi.RESOURCE_STATE_COPY_DEST,
            nvrhi.CPU_ACCESS_READ));
        const writer = nvrhi.createCommandList(device, nvrhi.commandListParameters());
        const reader = nvrhi.createCommandList(device, nvrhi.commandListParameters());
        if (!texture || !buffer || !staging || !readback || !writer || !reader) {
            check(false, "the native handle test's resources and command lists");
            return;
        }
        const textureType = isD3D12 ? nvrhi.OBJECT_TYPE_D3D12_RESOURCE : nvrhi.OBJECT_TYPE_VK_IMAGE;
        const bufferType = isD3D12 ? nvrhi.OBJECT_TYPE_D3D12_RESOURCE : nvrhi.OBJECT_TYPE_VK_BUFFER;
        const nativeTexture = nvrhi.getNativeObject(texture, textureType);
        const nativeBuffer = nvrhi.getNativeObject(buffer, bufferType);
        if (!nativeTexture || !nativeBuffer) {
            check(false, "the native handle test's API objects");
            return;
        }
        let aliasDesc = renderTargetDesc();
        aliasDesc.debugName = nvrhi.stdString("Texture handle");
        const textureHandle = nvrhi.createHandleForNativeTexture(device, textureType, nativeTexture, aliasDesc);
        const bufferHandle = nvrhi.createHandleForNativeBuffer(device, bufferType, nativeBuffer,
            nvrhi.bufferDesc(VALUES * 4, "Buffer handle", nvrhi.RESOURCE_STATE_COPY_DEST, nvrhi.CPU_ACCESS_NONE));
        if (!textureHandle || !bufferHandle) {
            check(false, "IDevice::createHandleForNativeTexture and createHandleForNativeBuffer");
            return;
        }
        const handleTextureObject = nvrhi.getNativeObject(textureHandle, textureType);
        const handleBufferObject = nvrhi.getNativeObject(bufferHandle, bufferType);
        check(handleTextureObject != null && <index>handleTextureObject == <index>nativeTexture
            && nvrhi.stdStringIs(Deref(textureHandle.getDesc()).debugName, "Texture handle"),
            "IDevice::createHandleForNativeTexture's texture: the API object, the desc given");
        check(handleBufferObject != null && <index>handleBufferObject == <index>nativeBuffer
            && nvrhi.stdStringIs(Deref(bufferHandle.getDesc()).debugName, "Buffer handle"),
            "IDevice::createHandleForNativeBuffer's buffer: the API object, the desc given");

        let values: u32[] = [];
        for (let i = 0; i < VALUES; i++) {
            values.push(500 + 3 * i);
        }
        writer.open();
        nvrhi.clearTextureFloat(writer, textureHandle, nvrhi.allSubresources(), [0.5, 0.0, 1.0, 1.0]);
        writer.writeBuffer(bufferHandle, <Opaque>Ref(values[0]), VALUES * 4, 0);
        writer.close();
        nvrhi.executeCommandList(device, writer);
        reader.open();
        nvrhi.copyTextureToStaging(reader, staging, nvrhi.entireTexture(), texture, nvrhi.entireTexture());
        reader.copyBuffer(readback, 0, buffer, 0, VALUES * 4);
        reader.close();
        nvrhi.executeCommandList(device, reader);
        check(device.waitForIdle(), "IDevice::waitForIdle after the native handle test");

        const pixels = readStaging(device, staging);
        if (pixels.length != 0) {
            let textureMismatches = 0;
            for (let i = 0; i < pixels.length; i += 4) {
                if (!sameColor(pixels, i, 128, 0, 255)) {
                    textureMismatches++;
                }
            }
            check(textureMismatches == 0, `a texture cleared through another handle (${textureMismatches} of ${TEXTURE_SIZE * TEXTURE_SIZE} pixels differ)`);
        }
        const mapped = <Ref<u32>>device.mapBuffer(readback, nvrhi.CPU_ACCESS_READ);
        let bufferMismatches = 0;
        for (let i = 0; i < VALUES; i++) {
            if (Deref(mapped[i]) != 500 + 3 * i) {
                bufferMismatches++;
            }
        }
        device.unmapBuffer(readback);
        check(bufferMismatches == 0, `a buffer written through another handle (${bufferMismatches} of ${VALUES} differ)`);

        reader.Release();
        writer.Release();
        bufferHandle.Release();
        textureHandle.Release();
        readback.Release();
        staging.Release();
        buffer.Release();
        texture.Release();
    }

    // IResource::queryMemoryRequirements of a buffer, with no command list: what its memory takes,
    // at least its bytes (NVRHI reports buffers', not textures': those assert)
    function testResourceMemoryRequirements(device: nvrhi.IDevice): void {
        const buffer = nvrhi.createBuffer(device, nvrhi.bufferDesc(256, "Queried buffer", nvrhi.RESOURCE_STATE_COPY_DEST,
            nvrhi.CPU_ACCESS_NONE));
        if (!buffer) {
            check(false, "the memory requirement test's buffer");
            return;
        }
        let requirements: nvrhi.MemoryRequirements = [0, 0];
        const queried = buffer.queryMemoryRequirements(Ref(requirements));
        console.log(`IResource::queryMemoryRequirements: ${queried}, ${requirements.size} (alignment ${requirements.alignment})`);
        check(queried && requirements.size >= 256 && requirements.alignment != 0, "IResource::queryMemoryRequirements of a buffer");

        buffer.Release();
    }

    // Queries used twice, with a command list of their own: an event query and a timer query used
    // as testQueries uses them, IDevice::resetEventQuery and resetTimerQuery (pollTimerQuery false
    // again, the time not read yet), then used again: each done again, the timer's time more than 0.
    function testQueryResets(device: nvrhi.IDevice): void {
        const eventQuery = nvrhi.createEventQuery(device);
        const timerQuery = nvrhi.createTimerQuery(device);
        const texture = nvrhi.createTexture(device, renderTargetDesc());
        const commandList = nvrhi.createCommandList(device, nvrhi.commandListParameters());
        if (!eventQuery || !timerQuery || !texture || !commandList) {
            check(false, "the query reset test's queries, texture and command list");
            return;
        }

        for (let round = 0; round < 2; round++) {
            commandList.open();
            commandList.beginTimerQuery(timerQuery);
            nvrhi.clearTextureFloat(commandList, texture, nvrhi.allSubresources(), [round, 0.0, 0.0, 1.0]);
            commandList.endTimerQuery(timerQuery);
            commandList.close();
            nvrhi.executeCommandList(device, commandList);
            device.setEventQuery(eventQuery, nvrhi.COMMAND_QUEUE_GRAPHICS);
            device.waitEventQuery(eventQuery);
            check(device.pollEventQuery(eventQuery), `IDevice::pollEventQuery after waitEventQuery, use ${round + 1}`);
            check(device.pollTimerQuery(timerQuery), `IDevice::pollTimerQuery after the command list, use ${round + 1}`);
            // (the time read on the second use only: Vulkan's getTimerQueryTime ends the query itself)
            if (round == 1) {
                const seconds = device.getTimerQueryTime(timerQuery);
                check(seconds > 0 && seconds < 1, `IDevice::getTimerQueryTime after resetTimerQuery (${seconds} s)`);
            }

            device.resetEventQuery(eventQuery);
            device.resetTimerQuery(timerQuery);
            check(!device.pollTimerQuery(timerQuery), `IDevice::resetTimerQuery after use ${round + 1}: not done`);
        }

        commandList.Release();
        texture.Release();
        timerQuery.Release();
        eventQuery.Release();
    }

    // An output buffer of runTest's compute pipeline (input * 2 + 1); null on failure.
    function computeOutputBuffer(device: nvrhi.IDevice, name: string): nvrhi.IBuffer | null {
        let outputDesc = nvrhi.bufferDesc(SIZE, name, nvrhi.RESOURCE_STATE_UNORDERED_ACCESS, nvrhi.CPU_ACCESS_NONE);
        outputDesc.format = <u8>Format.R32_UINT;
        outputDesc.canHaveTypedViews = true;
        outputDesc.canHaveUAVs = true;
        return nvrhi.createBuffer(device, outputDesc);
    }

    // A binding set of runTest's compute pipeline over input and an output buffer; null on failure.
    function computeBindingSet(device: nvrhi.IDevice, bindingLayout: nvrhi.IBindingLayout, input: nvrhi.IBuffer,
        output: nvrhi.IBuffer): nvrhi.IBindingSet | null {
        return nvrhi.createBindingSet(device, bindingLayout, [
            nvrhi.bufferBindingSetItem(0, nvrhi.RESOURCE_TYPE_TYPED_BUFFER_SRV, input),
            nvrhi.bufferBindingSetItem(0, nvrhi.RESOURCE_TYPE_TYPED_BUFFER_UAV, output)]);
    }

    // How many of a readback buffer's COUNT values at offset (in values) differ from data * 2 + 1
    function computedMismatches(readback: nvrhi.IBuffer, device: nvrhi.IDevice, offset: int, data: u32[]): int {
        const mapped = <Ref<u32>>device.mapBuffer(readback, nvrhi.CPU_ACCESS_READ);
        let mismatches = 0;
        for (let i = 0; i < COUNT; i++) {
            if (Deref(mapped[offset + i]) != data[i] * 2 + 1) {
                mismatches++;
            }
        }
        device.unmapBuffer(readback);
        return mismatches;
    }

    // The compute queue, where the device has one (main asks Donut for one: D3D12's, Vulkan's
    // compute family or the graphics family's second queue): runTest's compute pipeline dispatched by a command list of the compute
    // queue (CommandListParameters::queueType), executed there (IDevice::executeCommandLists on it),
    // the graphics queue waiting for it (queueWaitForCommandList of its submission) before a copy
    // into a readback buffer: input * 2 + 1.
    function testComputeQueue(device: nvrhi.IDevice, hasComputeQueue: boolean, pipeline: nvrhi.IComputePipeline,
        bindingLayout: nvrhi.IBindingLayout, input: nvrhi.IBuffer, data: u32[]): void {
        if (!hasComputeQueue) {
            console.log("Compute queue: none, not tested");
            return;
        }
        const output = computeOutputBuffer(device, "Async output");
        const bindingSet = output ? computeBindingSet(device, bindingLayout, input, output) : null;
        const readback = nvrhi.createBuffer(device, nvrhi.bufferDesc(SIZE, "Async readback", nvrhi.RESOURCE_STATE_COPY_DEST,
            nvrhi.CPU_ACCESS_READ));
        let computeParams = nvrhi.commandListParameters();
        computeParams.queueType = nvrhi.COMMAND_QUEUE_COMPUTE;
        const computeList = nvrhi.createCommandList(device, computeParams);
        const copyList = nvrhi.createCommandList(device, nvrhi.commandListParameters());
        if (!bindingSet || !output || !readback || !computeList || !copyList) {
            check(false, "the compute queue test's buffers and command lists");
            return;
        }
        check(Deref(computeList.getDesc()).queueType == nvrhi.COMMAND_QUEUE_COMPUTE, "ICommandList::getDesc's queueType");

        computeList.open();
        nvrhi.setComputeState(computeList, nvrhi.computeState(pipeline, bindingSet));
        computeList.dispatch(1, 1, 1);
        computeList.close();
        const instance = nvrhi.executeCommandListOn(device, computeList, nvrhi.COMMAND_QUEUE_COMPUTE);
        device.queueWaitForCommandList(nvrhi.COMMAND_QUEUE_GRAPHICS, nvrhi.COMMAND_QUEUE_COMPUTE, instance);
        copyList.open();
        copyList.copyBuffer(readback, 0, output, 0, SIZE);
        copyList.close();
        nvrhi.executeCommandList(device, copyList);
        check(device.waitForIdle(), "IDevice::waitForIdle after the compute queue test");

        const mismatches = computedMismatches(readback, device, 0, data);
        console.log(`Compute queue: submission ${instance}`);
        check(mismatches == 0, `a dispatch on the compute queue (${mismatches} of ${COUNT} differ)`);

        copyList.Release();
        computeList.Release();
        readback.Release();
        bindingSet.Release();
        output.Release();
    }

    // UAV barriers turned off and on, with a command list of its own: runTest's compute pipeline
    // dispatched twice into one buffer with ICommandList::setEnableUavBarriersForBuffer off between
    // them (the two write the same values, which needs no barrier), then once more with it on; an
    // R32_UINT texture with UAVs cleared twice to one value with setEnableUavBarriersForTexture off,
    // then on. The buffer: input * 2 + 1; the texture: the value.
    function testUavBarrierControl(device: nvrhi.IDevice, pipeline: nvrhi.IComputePipeline,
        bindingLayout: nvrhi.IBindingLayout, input: nvrhi.IBuffer, data: u32[]): void {
        const output = computeOutputBuffer(device, "Unbarriered");
        const bindingSet = output ? computeBindingSet(device, bindingLayout, input, output) : null;
        const readback = nvrhi.createBuffer(device, nvrhi.bufferDesc(SIZE, "UAV readback", nvrhi.RESOURCE_STATE_COPY_DEST,
            nvrhi.CPU_ACCESS_READ));
        let textureDesc = nvrhi.textureDesc(TEXTURE_SIZE, TEXTURE_SIZE, Format.R32_UINT, "Unbarriered UAV",
            nvrhi.RESOURCE_STATE_UNORDERED_ACCESS);
        textureDesc.isUAV = true;
        const texture = nvrhi.createTexture(device, textureDesc);
        textureDesc.debugName = nvrhi.stdString("UAV staging");
        const staging = nvrhi.createStagingTexture(device, textureDesc, nvrhi.CPU_ACCESS_READ);
        const commandList = nvrhi.createCommandList(device, nvrhi.commandListParameters());
        if (!bindingSet || !output || !readback || !texture || !staging || !commandList) {
            check(false, "the UAV barrier test's resources and command list");
            return;
        }

        commandList.open();
        nvrhi.setComputeState(commandList, nvrhi.computeState(pipeline, bindingSet));
        commandList.setEnableUavBarriersForBuffer(output, false);
        commandList.dispatch(1, 1, 1);
        commandList.dispatch(1, 1, 1);
        commandList.setEnableUavBarriersForBuffer(output, true);
        commandList.dispatch(1, 1, 1);
        commandList.copyBuffer(readback, 0, output, 0, SIZE);
        commandList.setEnableUavBarriersForTexture(texture, false);
        nvrhi.clearTextureUInt(commandList, texture, nvrhi.allSubresources(), UINT_CLEAR_MIP);
        nvrhi.clearTextureUInt(commandList, texture, nvrhi.allSubresources(), UINT_CLEAR_MIP);
        commandList.setEnableUavBarriersForTexture(texture, true);
        nvrhi.copyTextureToStaging(commandList, staging, nvrhi.entireTexture(), texture, nvrhi.entireTexture());
        commandList.close();
        nvrhi.executeCommandList(device, commandList);
        check(device.waitForIdle(), "IDevice::waitForIdle after the UAV barrier test");

        const bufferMismatches = computedMismatches(readback, device, 0, data);
        check(bufferMismatches == 0, `dispatches with UAV barriers off (${bufferMismatches} of ${COUNT} differ)`);
        const texels = readStagingUInts(device, staging, 0, TEXTURE_SIZE);
        if (texels.length != 0) {
            let textureMismatches = 0;
            for (let i = 0; i < texels.length; i++) {
                if (texels[i] != UINT_CLEAR_MIP) {
                    textureMismatches++;
                }
            }
            check(textureMismatches == 0, `UAV clears with UAV barriers off (${textureMismatches} of ${texels.length} differ)`);
        }

        commandList.Release();
        staging.Release();
        texture.Release();
        readback.Release();
        bindingSet.Release();
        output.Release();
    }

    // A binding set's resources put in their states at once, with a command list of its own and
    // automatic barriers off: ICommandList::setResourceStatesForBindingSet of a binding set over
    // runTest's input (a typed buffer SRV, CopyDest between command lists) and a new output (a UAV),
    // commitBarriers; getBufferState of each (NonPixelShaderResource: a compute binding set's;
    // UnorderedAccess); then a dispatch, which
    // NVRHI doesn't transition for, and a copy into a readback buffer: input * 2 + 1.
    function testBindingSetStates(device: nvrhi.IDevice, pipeline: nvrhi.IComputePipeline,
        bindingLayout: nvrhi.IBindingLayout, input: nvrhi.IBuffer, data: u32[]): void {
        const output = computeOutputBuffer(device, "Set states");
        const bindingSet = output ? computeBindingSet(device, bindingLayout, input, output) : null;
        const readback = nvrhi.createBuffer(device, nvrhi.bufferDesc(SIZE, "States readback", nvrhi.RESOURCE_STATE_COPY_DEST,
            nvrhi.CPU_ACCESS_READ));
        const commandList = nvrhi.createCommandList(device, nvrhi.commandListParameters());
        if (!bindingSet || !output || !readback || !commandList) {
            check(false, "the binding set state test's buffers and command list");
            return;
        }

        commandList.open();
        commandList.setEnableAutomaticBarriers(false);
        commandList.setResourceStatesForBindingSet(bindingSet);
        commandList.commitBarriers();
        const inputState = commandList.getBufferState(input);
        const outputState = commandList.getBufferState(output);
        nvrhi.setComputeState(commandList, nvrhi.computeState(pipeline, bindingSet));
        commandList.dispatch(1, 1, 1);
        commandList.setBufferState(output, nvrhi.RESOURCE_STATE_COPY_SOURCE);
        commandList.commitBarriers();
        commandList.copyBuffer(readback, 0, output, 0, SIZE);
        commandList.setEnableAutomaticBarriers(true);
        commandList.close();
        nvrhi.executeCommandList(device, commandList);
        check(device.waitForIdle(), "IDevice::waitForIdle after the binding set state test");

        console.log(`ICommandList::setResourceStatesForBindingSet: input ${inputState}, output ${outputState}`);
        check(inputState == nvrhi.RESOURCE_STATE_NON_PIXEL_SHADER_RESOURCE && outputState == nvrhi.RESOURCE_STATE_UNORDERED_ACCESS,
            "ICommandList::setResourceStatesForBindingSet");
        const mismatches = computedMismatches(readback, device, 0, data);
        check(mismatches == 0, `a dispatch after setResourceStatesForBindingSet (${mismatches} of ${COUNT} differ)`);

        commandList.Release();
        readback.Release();
        bindingSet.Release();
        output.Release();
    }

    // Indexed indirect draws with a count from a buffer, D3D12 only (Donut's Vulkan device doesn't
    // enable drawIndirectCount), with a command list of their own, as testDrawIndexedIndirect's: a
    // buffer of DrawIndexedIndirectArguments (three indices, one instance) and a buffer of draw
    // counts (1, 0), the graphics state's indirectCountBuffer. ICommandList::drawIndexedIndirectCount
    // of at most one draw into the left half with the count at offset 0, into the right half with
    // the count at offset 4: the left half green, the right half as cleared.
    function testDrawIndexedIndirectCount(app: App, device: nvrhi.IDevice, isD3D12: boolean): void {
        if (!isD3D12) {
            console.log("drawIndexedIndirectCount: not on Vulkan (drawIndirectCount isn't enabled), not tested");
            return;
        }
        const color = nvrhi.createTexture(device, renderTargetDesc());
        const staging = nvrhi.createStagingTexture(device, renderTargetDesc(), nvrhi.CPU_ACCESS_READ);
        const vertexShader = loadShader(app, device, isD3D12, "nvrhi_direct", "main_vs", nvrhi.SHADER_TYPE_VERTEX);
        const pixelShader = loadShader(app, device, isD3D12, "nvrhi_direct", "main_ps", nvrhi.SHADER_TYPE_PIXEL);
        const commandList = nvrhi.createCommandList(device, nvrhi.commandListParameters());
        let indexDesc = nvrhi.bufferDesc(3 * 4, "Counted indices", nvrhi.RESOURCE_STATE_INDEX_BUFFER, nvrhi.CPU_ACCESS_NONE);
        indexDesc.isIndexBuffer = true;
        const indexBuffer = nvrhi.createBuffer(device, indexDesc);
        let argumentsDesc = nvrhi.bufferDesc(20, "Counted args", nvrhi.RESOURCE_STATE_INDIRECT_ARGUMENT, nvrhi.CPU_ACCESS_NONE);
        argumentsDesc.isDrawIndirectArgs = true;
        const argumentsBuffer = nvrhi.createBuffer(device, argumentsDesc);
        argumentsDesc.byteSize = 8;
        argumentsDesc.debugName = nvrhi.stdString("Draw counts");
        const countBuffer = nvrhi.createBuffer(device, argumentsDesc);
        if (!color || !staging || !vertexShader || !pixelShader || !commandList || !indexBuffer || !argumentsBuffer || !countBuffer) {
            check(false, "the counted indirect draw test's textures, shaders, command list and buffers");
            return;
        }
        const framebuffer = nvrhi.createFramebuffer(device, nvrhi.framebufferDesc([color], null));
        if (!framebuffer) {
            check(false, "IDevice::createFramebuffer for the counted indirect draw test");
            return;
        }
        let renderState = nvrhi.renderState();
        renderState.depthStencilState.depthTestEnable = false;
        renderState.depthStencilState.depthWriteEnable = false;
        renderState.rasterState.cullMode = nvrhi.CULL_NONE;
        const pipeline = nvrhi.createGraphicsPipeline(device,
            nvrhi.graphicsPipelineDesc(null, vertexShader, pixelShader, null, renderState), framebuffer);
        if (!pipeline) {
            check(false, "IDevice::createGraphicsPipeline for the counted indirect draw test");
            return;
        }

        let indices: u32[] = [0, 1, 2];
        let drawArguments: u32[] = [3, 1, 0, 0, 0];
        let counts: u32[] = [1, 0];
        commandList.open();
        nvrhi.clearTextureFloat(commandList, color, nvrhi.allSubresources(), [0.0, 0.0, 0.0, 1.0]);
        commandList.writeBuffer(indexBuffer, <Opaque>Ref(indices[0]), 3 * 4, 0);
        commandList.writeBuffer(argumentsBuffer, <Opaque>Ref(drawArguments[0]), 20, 0);
        commandList.writeBuffer(countBuffer, <Opaque>Ref(counts[0]), 8, 0);
        let left = nvrhi.graphicsState(pipeline, framebuffer, [0, TEXTURE_SIZE / 2, 0, TEXTURE_SIZE, 0, 1],
            null, null, indexBuffer, Format.R32_UINT);
        left.indirectParams = argumentsBuffer;
        left.indirectCountBuffer = countBuffer;
        nvrhi.setGraphicsState(commandList, left);
        commandList.drawIndexedIndirectCount(0, 0, 1);
        let right = nvrhi.graphicsState(pipeline, framebuffer, [TEXTURE_SIZE / 2, TEXTURE_SIZE, 0, TEXTURE_SIZE, 0, 1],
            null, null, indexBuffer, Format.R32_UINT);
        right.indirectParams = argumentsBuffer;
        right.indirectCountBuffer = countBuffer;
        nvrhi.setGraphicsState(commandList, right);
        commandList.drawIndexedIndirectCount(0, 4, 1);
        nvrhi.copyTextureToStaging(commandList, staging, nvrhi.entireTexture(), color, nvrhi.entireTexture());
        commandList.close();
        nvrhi.executeCommandList(device, commandList);
        check(device.waitForIdle(), "IDevice::waitForIdle after the counted indirect draw test");

        const pixels = readStaging(device, staging);
        if (pixels.length != 0) {
            let drawnMismatches = 0;
            let skippedMismatches = 0;
            for (let y = 0; y < TEXTURE_SIZE; y++) {
                for (let x = 0; x < TEXTURE_SIZE; x++) {
                    const i = 4 * (y * TEXTURE_SIZE + x);
                    if (x < TEXTURE_SIZE / 2) {
                        if (!sameColor(pixels, i, 0, 255, 0)) {
                            drawnMismatches++;
                        }
                    } else if (!sameColor(pixels, i, 0, 0, 0)) {
                        skippedMismatches++;
                    }
                }
            }
            const last = 4 * (TEXTURE_SIZE - 1);
            console.log(`Drawn with a count (${pixels[0]}, ${pixels[1]}, ${pixels[2]}), `
                + `count 0 (${pixels[last]}, ${pixels[last + 1]}, ${pixels[last + 2]})`);
            const half = TEXTURE_SIZE * TEXTURE_SIZE / 2;
            check(drawnMismatches == 0, `ICommandList::drawIndexedIndirectCount of count 1 (${drawnMismatches} of ${half} pixels differ)`);
            check(skippedMismatches == 0, `ICommandList::drawIndexedIndirectCount of count 0 (${skippedMismatches} of ${half} pixels differ)`);
        }

        commandList.Release();
        pipeline.Release();
        framebuffer.Release();
        countBuffer.Release();
        argumentsBuffer.Release();
        indexBuffer.Release();
        vertexShader.Release();
        pixelShader.Release();
        staging.Release();
        color.Release();
    }

    function runTest(app: App, api: GraphicsAPI, validation: boolean): void {
        // the tuples NVRHI reads as its structs: the same sizes as the C++ build's
        check(nvrhi.layoutMatches(), "the tuples have the C++ structs' sizes");

        const device = <nvrhi.IDevice>app.getNvrhiDevice();

        // IDevice::getMessageCallback: the MessageLog the device was made with
        check(<index><Opaque>device.getMessageCallback() == <index><Opaque>messageLog,
            "the device's IMessageCallback is the one implemented here");

        // IDevice::getGraphicsAPI; IResource::getNativeObject and IDevice::getNativeQueue (an
        // nvrhi::Object returned by value); IDevice::queryFeatureSupport, which says whether the
        // device has a compute queue (main asks Donut for one, which a device may not have), as
        // getNativeQueue does; runGarbageCollection
        const deviceApi: int = device.getGraphicsAPI();
        console.log(`IDevice::getGraphicsAPI: ${deviceApi}`);
        check(deviceApi == <int>api, "the device's graphics API is the one asked for");
        const isD3D12 = api == GraphicsAPI.D3D12;
        check(nvrhi.getNativeObject(device, isD3D12 ? nvrhi.OBJECT_TYPE_D3D12_DEVICE : nvrhi.OBJECT_TYPE_VK_DEVICE) != null,
            "the device has its native device");
        const queueType = isD3D12 ? nvrhi.OBJECT_TYPE_D3D12_COMMAND_QUEUE : nvrhi.OBJECT_TYPE_VK_QUEUE;
        check(nvrhi.getNativeQueue(device, queueType, nvrhi.COMMAND_QUEUE_GRAPHICS) != null, "the device has its graphics queue");
        const hasComputeQueue = device.queryFeatureSupport(nvrhi.FEATURE_COMPUTE_QUEUE, null, 0);
        console.log(`IDevice::queryFeatureSupport(ComputeQueue): ${hasComputeQueue}`);
        // NVRHI's Vulkan getNativeQueue dereferences a queue the device doesn't have (the Android
        // emulator's has no compute queue): ask Vulkan only for one it has
        if (hasComputeQueue || isD3D12) {
            check(hasComputeQueue == (nvrhi.getNativeQueue(device, queueType, nvrhi.COMMAND_QUEUE_COMPUTE) != null),
                "IDevice::queryFeatureSupport(ComputeQueue) and getNativeQueue agree");
        }
        device.runGarbageCollection();

        // IDevice::isAftermathEnabled: Donut doesn't enable Aftermath; getAftermathCrashDumpHelper
        // (a reference, the device's helper all the same)
        check(!device.isAftermathEnabled(), "IDevice::isAftermathEnabled: off");
        check(device.getAftermathCrashDumpHelper() != null, "IDevice::getAftermathCrashDumpHelper");

        // IResource::AddRef, Release, GetRefCount
        const refCount: int = device.GetRefCount();
        const added: int = device.AddRef();
        const released: int = device.Release();
        console.log(`IDevice reference count: ${refCount}, AddRef ${added}, Release ${released}`);
        check(added == refCount + 1 && released == refCount, "AddRef and Release count");

        // IDevice::createBuffer: the shader's input (uploaded) and output, one to clear, one to read
        // the three back from
        let inputDesc = nvrhi.bufferDesc(SIZE, "Input", nvrhi.RESOURCE_STATE_COPY_DEST, nvrhi.CPU_ACCESS_NONE);
        inputDesc.format = <u8>Format.R32_UINT;
        inputDesc.canHaveTypedViews = true;
        let outputDesc = nvrhi.bufferDesc(SIZE, "Output", nvrhi.RESOURCE_STATE_UNORDERED_ACCESS, nvrhi.CPU_ACCESS_NONE);
        outputDesc.format = <u8>Format.R32_UINT;
        outputDesc.canHaveTypedViews = true;
        outputDesc.canHaveUAVs = true;
        let clearedDesc = nvrhi.bufferDesc(SIZE, "Cleared", nvrhi.RESOURCE_STATE_COPY_DEST, nvrhi.CPU_ACCESS_NONE);
        clearedDesc.canHaveUAVs = true;
        const input = nvrhi.createBuffer(device, inputDesc);
        const output = nvrhi.createBuffer(device, outputDesc);
        const cleared = nvrhi.createBuffer(device, clearedDesc);
        const readback = nvrhi.createBuffer(device, nvrhi.bufferDesc(3 * SIZE, "Readback", nvrhi.RESOURCE_STATE_COPY_DEST, nvrhi.CPU_ACCESS_READ));
        if (!input || !output || !cleared || !readback) {
            check(false, "IDevice::createBuffer");
            return;
        }

        // IBuffer::getDesc: NVRHI's copy of the desc, debug name included; getGpuVirtualAddress (D3D12)
        const desc = Deref(cleared.getDesc());
        check(desc.byteSize == SIZE && desc.canHaveUAVs && desc.initialState == nvrhi.RESOURCE_STATE_COPY_DEST
            && desc.keepInitialState && desc.cpuAccess == nvrhi.CPU_ACCESS_NONE, "IBuffer::getDesc");
        check(nvrhi.stdStringIs(desc.debugName, "Cleared"),
            "the buffer's debug name");
        if (isD3D12) {
            check(input.getGpuVirtualAddress() != 0, "IBuffer::getGpuVirtualAddress");
        }

        // IDevice::createTexture, ITexture::getDesc, getNativeObject
        const texture = nvrhi.createTexture(device, renderTargetDesc());
        if (!texture) {
            check(false, "IDevice::createTexture");
            return;
        }
        const textureDesc = Deref(texture.getDesc());
        check(textureDesc.width == TEXTURE_SIZE && textureDesc.height == TEXTURE_SIZE
            && textureDesc.format == <u8>Format.RGBA8_UNORM && textureDesc.isRenderTarget
            && nvrhi.stdStringIs(textureDesc.debugName, "Cleared texture"), "ITexture::getDesc");
        check(nvrhi.getNativeObject(texture, isD3D12 ? nvrhi.OBJECT_TYPE_D3D12_RESOURCE : nvrhi.OBJECT_TYPE_VK_IMAGE) != null,
            "the texture has its native resource");

        // the texture's copy, and a staging texture the copy is read back through:
        // IDevice::createStagingTexture, IStagingTexture::getDesc
        const copied = nvrhi.createTexture(device, nvrhi.textureDesc(TEXTURE_SIZE, TEXTURE_SIZE, Format.RGBA8_UNORM,
            "Copied texture", nvrhi.RESOURCE_STATE_COPY_DEST));
        let stagingDesc = nvrhi.textureDesc(TEXTURE_SIZE, TEXTURE_SIZE, Format.RGBA8_UNORM, "Staging texture",
            nvrhi.RESOURCE_STATE_COPY_DEST);
        const staging = nvrhi.createStagingTexture(device, stagingDesc, nvrhi.CPU_ACCESS_READ);
        if (!copied || !staging) {
            check(false, "IDevice::createTexture and createStagingTexture");
            return;
        }
        const keptStagingDesc = Deref(staging.getDesc());
        check(keptStagingDesc.width == TEXTURE_SIZE && keptStagingDesc.height == TEXTURE_SIZE
            && keptStagingDesc.format == <u8>Format.RGBA8_UNORM
            && nvrhi.stdStringIs(keptStagingDesc.debugName, "Staging texture"), "IStagingTexture::getDesc");

        // The compute pipeline: IDevice::createShader of the bytecode ShaderMake compiled (DXIL,
        // SPIR-V), IShader::getDesc, getBytecode; its binding layout and set,
        // IDevice::createComputePipeline
        const shaderFile = app.loadBinaryFile(`shaders/nvrhi_direct/${isD3D12 ? "dxil" : "spirv"}/nvrhi_direct.bin`);
        if (shaderFile.isNull()) {
            check(false, "the compute shader's bytecode");
            return;
        }
        const shader = nvrhi.createShader(device, nvrhi.shaderDesc(nvrhi.SHADER_TYPE_COMPUTE, "nvrhi_direct", "main"),
            shaderFile.getData(), shaderFile.getSize());
        if (!shader) {
            check(false, "IDevice::createShader");
            return;
        }
        const shaderDesc = Deref(shader.getDesc());
        check(shaderDesc.shaderType == nvrhi.SHADER_TYPE_COMPUTE
            && nvrhi.stdStringIs(shaderDesc.entryName, "main") && nvrhi.stdStringIs(shaderDesc.debugName, "nvrhi_direct"),
            "IShader::getDesc");
        // NVRHI keeps a copy of the bytecode on D3D12 only; on Vulkan it writes null and 0
        let bytecode: Opaque | null = null;
        let bytecodeSize: index = 12345;
        shader.getBytecode(Ref(bytecode), Ref(bytecodeSize));
        check(isD3D12 ? bytecode != null && bytecodeSize == shaderFile.getSize() : bytecodeSize == 0, "IShader::getBytecode");

        // IDevice::createBindingLayout, createBindingSet, IBindingLayout::getDesc, IBindingSet::getDesc,
        // getLayout: the compute shader reads a typed buffer (t0) and writes another (u0)
        const bindingLayout = nvrhi.createBindingLayout(device, nvrhi.SHADER_TYPE_COMPUTE, [
            nvrhi.bindingLayoutItem(0, nvrhi.RESOURCE_TYPE_TYPED_BUFFER_SRV),
            nvrhi.bindingLayoutItem(0, nvrhi.RESOURCE_TYPE_TYPED_BUFFER_UAV)]);
        if (!bindingLayout) {
            check(false, "IDevice::createBindingLayout");
            return;
        }
        const bindingSet = nvrhi.createBindingSet(device, bindingLayout, [
            nvrhi.bufferBindingSetItem(0, nvrhi.RESOURCE_TYPE_TYPED_BUFFER_SRV, input),
            nvrhi.bufferBindingSetItem(0, nvrhi.RESOURCE_TYPE_TYPED_BUFFER_UAV, output)]);
        if (!bindingSet) {
            check(false, "IDevice::createBindingSet");
            return;
        }
        const layoutDesc = Deref(bindingLayout.getDesc());
        check(layoutDesc.visibility == nvrhi.SHADER_TYPE_COMPUTE && nvrhi.stdVectorSize(layoutDesc.bindings) == 2,
            "IBindingLayout::getDesc");
        check(nvrhi.stdVectorSize(Deref(bindingSet.getDesc()).bindings) == 2, "IBindingSet::getDesc");
        check(<index><Opaque>bindingSet.getLayout() == <index><Opaque>bindingLayout, "IBindingSet::getLayout");
        const pipeline = nvrhi.createComputePipeline(device, nvrhi.computePipelineDesc(shader, bindingLayout));
        if (!pipeline) {
            check(false, "IDevice::createComputePipeline");
            return;
        }

        // The graphics pipeline: IDevice::createFramebuffer over the texture, IFramebuffer::
        // getFramebufferInfo; the vertex and pixel shaders; IDevice::createGraphicsPipeline (for the
        // framebuffer) with the default render state but for the depth test and culling,
        // IGraphicsPipeline::getDesc
        const framebuffer = nvrhi.createFramebuffer(device, nvrhi.framebufferDesc([texture], null));
        if (!framebuffer) {
            check(false, "IDevice::createFramebuffer");
            return;
        }
        const framebufferInfo = Deref(framebuffer.getFramebufferInfo());
        check(framebufferInfo.width == TEXTURE_SIZE && framebufferInfo.height == TEXTURE_SIZE
            && framebufferInfo.colorFormats.current_size == 1,
            "IFramebuffer::getFramebufferInfo");
        const vertexShader = loadShader(app, device, isD3D12, "nvrhi_direct", "main_vs", nvrhi.SHADER_TYPE_VERTEX);
        const pixelShader = loadShader(app, device, isD3D12, "nvrhi_direct", "main_ps", nvrhi.SHADER_TYPE_PIXEL);
        if (!vertexShader || !pixelShader) {
            check(false, "the vertex and pixel shaders");
            return;
        }
        let renderState = nvrhi.renderState();
        renderState.depthStencilState.depthTestEnable = false;
        renderState.depthStencilState.depthWriteEnable = false;
        renderState.rasterState.cullMode = nvrhi.CULL_NONE;
        const graphicsPipeline = nvrhi.createGraphicsPipeline(device,
            nvrhi.graphicsPipelineDesc(null, vertexShader, pixelShader, null, renderState), framebuffer);
        if (!graphicsPipeline) {
            check(false, "IDevice::createGraphicsPipeline");
            return;
        }
        const graphicsDesc = Deref(graphicsPipeline.getDesc());
        check(graphicsDesc.renderState.rasterState.cullMode == nvrhi.CULL_NONE && !graphicsDesc.renderState.depthStencilState.depthTestEnable
            && <index><Opaque>graphicsDesc.VS.ptr_ == <index><Opaque>vertexShader, "IGraphicsPipeline::getDesc");

        // The textured draw's resources: IDevice::createTexture of the texels, createSampler (point
        // sampling), the vertex, index and constant buffers, the shaders, createInputLayout (the
        // vertex's position and texture coordinates), a binding layout and set of the constant
        // buffer, texture and sampler, its pipeline
        const texels = nvrhi.createTexture(device, nvrhi.textureDesc(2, 2, Format.RGBA8_UNORM, "Texels",
            nvrhi.RESOURCE_STATE_SHADER_RESOURCE));
        let pointSampling = nvrhi.samplerDesc();
        pointSampling.minFilter = false;
        pointSampling.magFilter = false;
        pointSampling.mipFilter = false;
        const sampler = nvrhi.createSampler(device, pointSampling);
        let vertexBufferDesc = nvrhi.bufferDesc(4 * QUAD_VERTEX_SIZE, "Quad vertices", nvrhi.RESOURCE_STATE_VERTEX_BUFFER,
            nvrhi.CPU_ACCESS_NONE);
        vertexBufferDesc.isVertexBuffer = true;
        let indexBufferDesc = nvrhi.bufferDesc(6 * 2, "Quad indices", nvrhi.RESOURCE_STATE_INDEX_BUFFER, nvrhi.CPU_ACCESS_NONE);
        indexBufferDesc.isIndexBuffer = true;
        // (D3D12 reads a constant buffer in 256-byte steps)
        let constantBufferDesc = nvrhi.bufferDesc(256, "Scale", nvrhi.RESOURCE_STATE_CONSTANT_BUFFER, nvrhi.CPU_ACCESS_NONE);
        constantBufferDesc.isConstantBuffer = true;
        const vertexBuffer = nvrhi.createBuffer(device, vertexBufferDesc);
        const indexBuffer = nvrhi.createBuffer(device, indexBufferDesc);
        const constantBuffer = nvrhi.createBuffer(device, constantBufferDesc);
        const texturedVertexShader = loadShader(app, device, isD3D12, "nvrhi_direct_textured", "main_vs", nvrhi.SHADER_TYPE_VERTEX);
        const texturedPixelShader = loadShader(app, device, isD3D12, "nvrhi_direct_textured", "main_ps", nvrhi.SHADER_TYPE_PIXEL);
        if (!texels || !sampler || !vertexBuffer || !indexBuffer || !constantBuffer || !texturedVertexShader || !texturedPixelShader) {
            check(false, "the textured draw's texture, sampler, buffers and shaders");
            return;
        }
        const inputLayout = nvrhi.createInputLayout(device, [
            nvrhi.vertexAttributeDesc("POSITION", Format.RG32_FLOAT, 0, 0, QUAD_VERTEX_SIZE),
            nvrhi.vertexAttributeDesc("TEXCOORD", Format.RG32_FLOAT, 0, 8, QUAD_VERTEX_SIZE)], texturedVertexShader);
        const texturedLayout = nvrhi.createBindingLayout(device, nvrhi.SHADER_TYPE_PIXEL, [
            nvrhi.bindingLayoutItem(0, nvrhi.RESOURCE_TYPE_CONSTANT_BUFFER),
            nvrhi.bindingLayoutItem(0, nvrhi.RESOURCE_TYPE_TEXTURE_SRV),
            nvrhi.bindingLayoutItem(0, nvrhi.RESOURCE_TYPE_SAMPLER)]);
        if (!inputLayout || !texturedLayout) {
            check(false, "IDevice::createInputLayout, createBindingLayout");
            return;
        }
        const texturedSet = nvrhi.createBindingSet(device, texturedLayout, [
            nvrhi.bufferBindingSetItem(0, nvrhi.RESOURCE_TYPE_CONSTANT_BUFFER, constantBuffer),
            nvrhi.textureBindingSetItem(0, texels),
            nvrhi.samplerBindingSetItem(0, sampler)]);
        const texturedPipeline = texturedSet ? nvrhi.createGraphicsPipeline(device,
            nvrhi.graphicsPipelineDesc(inputLayout, texturedVertexShader, texturedPixelShader, texturedLayout, renderState),
            framebuffer) : null;
        if (!texturedSet || !texturedPipeline) {
            check(false, "the textured draw's binding set and pipeline");
            return;
        }
        check(<index><Opaque>Deref(texturedPipeline.getDesc()).inputLayout.ptr_ == <index><Opaque>inputLayout,
            "the textured pipeline's input layout");

        // IDevice::createCommandList; ICommandList::open, clearState, beginMarker, writeBuffer,
        // clearBufferUInt, setComputeState, dispatch, setEnableAutomaticBarriers, setBufferState,
        // commitBarriers, copyBuffer, clearTextureFloat, endMarker, getDevice, close
        const commandList = nvrhi.createCommandList(device, nvrhi.commandListParameters());
        if (!commandList) {
            check(false, "IDevice::createCommandList");
            return;
        }
        check(<index><Opaque>commandList.getDevice() == <index><Opaque>device, "ICommandList::getDevice");

        // IMessageCallback::message, called by NVRHI: its validation layer (-debug) reports closing
        // a command list never opened as an error, and does nothing else (without it, the backend
        // would close a list it has none of)
        if (validation) {
            messageLog.expecting = true;
            commandList.close();
            messageLog.expecting = false;
            check(messageLog.provoked == 1, "NVRHI calls the IMessageCallback implemented here");
        }

        let data: u32[] = [];
        for (let i = 0; i < COUNT; i++) {
            data.push(i * 3 + 1);
        }

        commandList.open();
        commandList.clearState();
        commandList.beginMarker("nvrhi_direct");
        commandList.writeBuffer(input, <Opaque>Ref(data[0]), SIZE, 0);
        commandList.clearBufferUInt(cleared, CLEAR_VALUE);
        nvrhi.setComputeState(commandList, nvrhi.computeState(pipeline, bindingSet));
        commandList.dispatch(1, 1, 1);
        commandList.copyBuffer(readback, 0, input, 0, SIZE);
        commandList.copyBuffer(readback, SIZE, cleared, 0, SIZE);

        // the output's copy with the barriers made by hand
        commandList.setEnableAutomaticBarriers(false);
        commandList.setBufferState(output, nvrhi.RESOURCE_STATE_COPY_SOURCE);
        commandList.setBufferState(readback, nvrhi.RESOURCE_STATE_COPY_DEST);
        commandList.commitBarriers();
        commandList.copyBuffer(readback, 2 * SIZE, output, 0, SIZE);
        commandList.setEnableAutomaticBarriers(true);

        nvrhi.clearTextureFloat(commandList, texture, nvrhi.allSubresources(), [1.0, 0.5, 0.25, 1.0]);
        // ICommandList::setGraphicsState, draw: a triangle covering the viewport, the left half
        nvrhi.setGraphicsState(commandList, nvrhi.graphicsState(graphicsPipeline, framebuffer,
            [0, TEXTURE_SIZE / 2, 0, TEXTURE_SIZE, 0, 1], null, null, null, Format.UNKNOWN));
        nvrhi.draw(commandList, 3);

        // ICommandList::writeBuffer of the quad's vertices (position, texture coordinates: the
        // texture's top at the top) and indices (two triangles), and of the scale (green halved);
        // writeTexture of the 2 x 2 texels; setGraphicsState with the vertex and index buffers,
        // drawIndexed: the quad over the top right quarter, a texel a pixel
        let vertices: f32[] = [-1, -1, 0, 1, -1, 1, 0, 0, 1, 1, 1, 0, 1, -1, 1, 1];
        let indices: u16[] = [0, 1, 2, 0, 2, 3];
        let scale: f32[] = [1, 0.5, 1, 1];
        commandList.writeBuffer(vertexBuffer, <Opaque>Ref(vertices[0]), 4 * QUAD_VERTEX_SIZE, 0);
        commandList.writeBuffer(indexBuffer, <Opaque>Ref(indices[0]), 6 * 2, 0);
        commandList.writeBuffer(constantBuffer, <Opaque>Ref(scale[0]), 4 * 4, 0);
        commandList.writeTexture(texels, 0, 0, <Opaque>Ref(TEXELS[0]), 2 * 4, 0);
        nvrhi.setGraphicsState(commandList, nvrhi.graphicsState(texturedPipeline, framebuffer,
            [TEXTURE_SIZE / 2, TEXTURE_SIZE, 0, TEXTURE_SIZE / 2, 0, 1], texturedSet, vertexBuffer, indexBuffer, Format.R16_UINT));
        nvrhi.drawIndexed(commandList, 6);

        // ICommandList::copyTexture, two of its overloads: the texture into its copy, the copy into
        // the staging texture
        nvrhi.copyTexture(commandList, copied, nvrhi.entireTexture(), texture, nvrhi.entireTexture());
        nvrhi.copyTextureToStaging(commandList, staging, nvrhi.entireTexture(), copied, nvrhi.entireTexture());
        commandList.endMarker();
        commandList.close();

        // IDevice::executeCommandLists, waitForIdle
        nvrhi.executeCommandList(device, commandList);
        check(device.waitForIdle(), "IDevice::waitForIdle");

        // IDevice::mapBuffer, unmapBuffer
        const mapped = <Ref<u32>>device.mapBuffer(readback, nvrhi.CPU_ACCESS_READ);
        let uploadMismatches = 0;
        let clearMismatches = 0;
        let computeMismatches = 0;
        for (let i = 0; i < COUNT; i++) {
            if (Deref(mapped[i]) != data[i]) {
                uploadMismatches++;
            }
            if (Deref(mapped[COUNT + i]) != CLEAR_VALUE) {
                clearMismatches++;
            }
            if (Deref(mapped[2 * COUNT + i]) != data[i] * 2 + 1) {
                computeMismatches++;
            }
        }
        console.log(`Read back: [${Deref(mapped[0])}, ${Deref(mapped[1])}, ..., ${Deref(mapped[COUNT - 1])}], `
            + `cleared to ${Deref(mapped[COUNT])}, computed [${Deref(mapped[2 * COUNT])}, ..., ${Deref(mapped[3 * COUNT - 1])}]`);
        device.unmapBuffer(readback);
        check(uploadMismatches == 0, `ICommandList::writeBuffer and copyBuffer (${uploadMismatches} of ${COUNT} differ)`);
        check(clearMismatches == 0, `ICommandList::clearBufferUInt (${clearMismatches} of ${COUNT} differ)`);
        check(computeMismatches == 0, `the compute dispatch (${computeMismatches} of ${COUNT} differ)`);

        // the texture's copy, read back through the staging texture
        const pixels = readStaging(device, staging);
        if (pixels.length != 0) {
            // the left half drawn green; the top right quarter the texels, a pixel each, green
            // halved; the bottom right quarter as cleared
            let clearMismatches = 0;
            let drawMismatches = 0;
            let texturedMismatches = 0;
            for (let y = 0; y < TEXTURE_SIZE; y++) {
                for (let x = 0; x < TEXTURE_SIZE; x++) {
                    const i = 4 * (y * TEXTURE_SIZE + x);
                    if (x < TEXTURE_SIZE / 2) {
                        if (!sameColor(pixels, i, 0, 255, 0)) {
                            drawMismatches++;
                        }
                    } else if (y < TEXTURE_SIZE / 2) {
                        const texel = 4 * (y * 2 + x - TEXTURE_SIZE / 2);
                        if (!sameColor(pixels, i, TEXELS[texel], TEXELS[texel + 1] / 2, TEXELS[texel + 2])) {
                            texturedMismatches++;
                        }
                    } else if (!sameColor(pixels, i, 255, 128, 64)) {
                        clearMismatches++;
                    }
                }
            }
            const last = 4 * (TEXTURE_SIZE * TEXTURE_SIZE - 1);
            const topRight = 4 * (TEXTURE_SIZE / 2);
            console.log(`Texture drawn (${pixels[0]}, ${pixels[1]}, ${pixels[2]}), textured (${pixels[topRight]}, `
                + `${pixels[topRight + 1]}, ${pixels[topRight + 2]}), cleared to (${pixels[last]}, ${pixels[last + 1]}, ${pixels[last + 2]})`);
            const quarter = TEXTURE_SIZE * TEXTURE_SIZE / 4;
            check(clearMismatches == 0, `ICommandList::clearTextureFloat (${clearMismatches} of ${quarter} pixels differ)`);
            check(drawMismatches == 0, `ICommandList::draw (${drawMismatches} of ${2 * quarter} pixels differ)`);
            check(texturedMismatches == 0, `ICommandList::drawIndexed, the texture and the constant buffer (${texturedMismatches} of ${quarter} pixels differ)`);
        }

        testDepth(app, device, isD3D12);
        testBlend(app, device, isD3D12);
        testPushConstants(app, device, isD3D12);
        testDrawIndirect(app, device, isD3D12);
        testDispatchIndirect(device, pipeline, bindingLayout, input, data);
        testStagingUpload(device);
        testMultipleRenderTargets(app, device, isD3D12);
        testMultisampleResolve(app, device, isD3D12);
        testQueries(device);
        testStencil(app, device, isD3D12);
        testInstancing(app, device, isD3D12);
        testTextureUav(app, device, isD3D12);
        testStructuredAndRawBuffers(app, device, isD3D12);
        testTextureSubresources(device);
        testClearTextureUInt(device);
        testTextureStateTracking(device, isD3D12);
        testBufferStateTracking(device);
        testPlacedResources(device);
        testDrawIndexedIndirect(app, device, isD3D12);
        testFormatSupport(device);
        testExecuteCommandLists(device);
        testLifetimeTracker(device);
        testShaderSpecialization(app, device, isD3D12);
        testBindless(app, device, isD3D12);
        testNativeViews(device, isD3D12);
        testNativeHandles(device, isD3D12);
        testResourceMemoryRequirements(device);
        testQueryResets(device);
        testComputeQueue(device, hasComputeQueue, pipeline, bindingLayout, input, data);
        testUavBarrierControl(device, pipeline, bindingLayout, input, data);
        testBindingSetStates(device, pipeline, bindingLayout, input, data);
        testDrawIndexedIndirectCount(app, device, isD3D12);

        // IResource::Release on what the create functions returned with a reference
        commandList.Release();
        texturedPipeline.Release();
        texturedSet.Release();
        texturedLayout.Release();
        inputLayout.Release();
        texturedVertexShader.Release();
        texturedPixelShader.Release();
        vertexBuffer.Release();
        indexBuffer.Release();
        constantBuffer.Release();
        sampler.Release();
        texels.Release();
        graphicsPipeline.Release();
        vertexShader.Release();
        pixelShader.Release();
        framebuffer.Release();
        pipeline.Release();
        bindingSet.Release();
        bindingLayout.Release();
        shader.Release();
        texture.Release();
        copied.Release();
        staging.Release();
        input.Release();
        output.Release();
        cleared.Release();
        readback.Release();
    }

    class NvrhiDirectArgs extends Args {
        // --help: print the usage and exit.
        help = false;

        protected parseOptions(): void {
            for (let i = 1; i < this.argc; i++) {
                if (this[i] == "--help") {
                    this.help = true;
                }
            }
        }
    }

    export function main(argc: int, argv: Ref<string>): int {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("nvrhi_direct");

        const args = new NvrhiDirectArgs(argc, argv);
        args.parseArgs();

        Donut_SetLogMinSeverity(LogSeverity.Warning);

        const api = args.api;
        const options = args.options;
        if (args.help) {
            console.log(`Usage: ${args[0]} [options]
 -dx12            Use DX12 API (default)
 -vk              Use Vulkan API
 -debug           Enable the graphics API's debug layer and NVRHI's validation layer
 -test            Accepted for the test runner: it always runs headless`);
            return 0;
        }

        // the devices made from here on report to messageLog
        Donut_SetNvrhiMessageCallback(<Opaque>messageLog);

        // with a compute queue (testComputeQueue) where the device has one; without, elsewhere
        let app = App.createHeadlessWithOptions(api, -1, <AppOptions>(options | AppOptions.ComputeQueue));
        if (app.isNull()) {
            app = App.createHeadlessWithOptions(api, -1, options);
        }
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        console.log(`Using ${Donut_GraphicsAPIToString(api)} API with ${app.getRendererString()}.`);

        runTest(app, api, options == AppOptions.DebugRuntime);
        app.destroy();
        Donut_SetNvrhiMessageCallback(null);

        if (failures > 0) {
            console.log("Test FAILED!");
            return 1;
        }

        console.log("Test PASSED");
        return 0;
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>): int {
    return NvrhiDirect.main(argc, argv);
}
