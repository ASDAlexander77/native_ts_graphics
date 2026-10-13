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
    // compute shader writing a texture (testTextureUav).
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

    function runTest(app: App, api: GraphicsAPI, validation: boolean): void {
        // the tuples NVRHI reads as its structs: the same sizes as the C++ build's
        check(nvrhi.layoutMatches(), "the tuples have the C++ structs' sizes");

        const device = <nvrhi.IDevice>app.getNvrhiDevice();

        // IDevice::getMessageCallback: the MessageLog the device was made with
        check(<index><Opaque>device.getMessageCallback() == <index><Opaque>messageLog,
            "the device's IMessageCallback is the one implemented here");

        // IDevice::getGraphicsAPI; IResource::getNativeObject and IDevice::getNativeQueue (an
        // nvrhi::Object returned by value); IDevice::queryFeatureSupport, which says whether the
        // device has a compute queue (Donut's headless device has one on Vulkan, not on D3D12), as
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

        const app = App.createHeadlessWithOptions(api, -1, options);
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
