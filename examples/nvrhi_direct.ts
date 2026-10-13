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
    //   constant buffer; read back through Donut, the bottom right quarter as cleared.
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
        // (named so as not to hide nvrhi.textureDesc below: TSLANG_ISSUES.md #18)
        const keptTextureDesc = Deref(texture.getDesc());
        check(keptTextureDesc.width == TEXTURE_SIZE && keptTextureDesc.height == TEXTURE_SIZE
            && keptTextureDesc.format == <u8>Format.RGBA8_UNORM && keptTextureDesc.isRenderTarget
            && nvrhi.stdStringIs(keptTextureDesc.debugName, "Cleared texture"), "ITexture::getDesc");
        check(nvrhi.getNativeObject(texture, isD3D12 ? nvrhi.OBJECT_TYPE_D3D12_RESOURCE : nvrhi.OBJECT_TYPE_VK_IMAGE) != null,
            "the texture has its native resource");

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
        check(layoutDesc.visibility == nvrhi.SHADER_TYPE_COMPUTE && nvrhi.stdVectorSize<nvrhi.BindingLayoutItem>(layoutDesc.bindings) == 2,
            "IBindingLayout::getDesc");
        check(nvrhi.stdVectorSize<nvrhi.BindingSetItem>(Deref(bindingSet.getDesc()).bindings) == 2, "IBindingSet::getDesc");
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
        const framebuffer = nvrhi.createFramebuffer(device, nvrhi.framebufferDesc(texture));
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

        // the texture, read back through Donut (a staging texture)
        let pixels: u8[] = [];
        pixels.length = TEXTURE_SIZE * TEXTURE_SIZE * 4;
        if (app.readTextureLevel(<TextureHandle><Opaque>texture, 0, <Opaque>Ref(pixels[0]), pixels.length) == 0) {
            check(false, "the texture's readback");
        } else {
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
