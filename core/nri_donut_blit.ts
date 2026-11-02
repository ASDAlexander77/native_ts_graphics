// Donut's blit (CommonRenderPasses::BlitTexture: shaders/framework's rect_vs and blit_ps, linear
// clamp sampling) of a whole texture into a whole color attachment, for the NRI ports of Donut
// examples that blit what they render into the back buffer (app.blitTexture), so their frames match
// the Donut example's.
//
// Imported with `import { DonutBlit } from "../../core/nri_donut_blit";` (from examples/nri/), and
// listed in the example's add_tslang_nri_example sources; the example depends on donut_shaders
// (shaders/framework).

/// <reference path="nri/nri_interop.d.ts" />

// struct BlitConstants { float2 sourceOrigin, sourceSize, targetOrigin, targetSize; float
// sharpenFactor; }: the whole source into the whole target.
const DONUT_BLIT_CONSTANTS: f32[] = [0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0];

@final
export class DonutBlit {
    private layout: NriPipelineLayoutHandle | null = null;
    private pipeline: NriPipelineHandle | null = null;
    private linearClamp: NriDescriptorHandle | null = null;
    private constants: f32[] = [];

    // The blit's layout and pipeline (shaders/framework/<folder>), into attachments of format;
    // false (after printing why) on failure.
    init(device: NriDeviceHandle, folder: string, format: NriFormat): boolean {
        for (const value of DONUT_BLIT_CONSTANTS) {
            this.constants.push(value);
        }

        // Its constants (b0), the source (t0), linear clamp sampling (s0).
        const layoutDesc = Nri_CreatePipelineLayoutDesc();
        Nri_PipelineLayoutDescAddRootConstants(layoutDesc, 0, DONUT_BLIT_CONSTANTS.length * 4, NriStage.Vertex);
        Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 0, 1, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
        Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 0, 1, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
        const layout = Nri_CreatePipelineLayoutFromDesc(device, layoutDesc);
        Nri_DestroyPipelineLayoutDesc(layoutDesc);
        this.layout = layout;
        if (!layout) {
            console.log("Cannot create the blit's layout");
            return false;
        }

        const desc = Nri_CreatePipelineDesc();
        let loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Vertex, `shaders/framework/${folder}/rect_vs.bin`, "main") != 0;
        if (loaded) {
            loaded = Nri_PipelineDescAddShaderPermutation(desc, NriShaderStage.Pixel, `shaders/framework/${folder}/blit_ps.bin`, "main",
                "TEXTURE_ARRAY=0") != 0;
        }
        Nri_PipelineDescSetTopology(desc, NriTopology.TriangleStrip);
        Nri_PipelineDescSetColor(desc, format, NriColorWrite.RGBA);
        this.pipeline = loaded ? Nri_CreatePipelineFromDesc(device, layout, desc) : null;
        Nri_DestroyPipelineDesc(desc);
        if (!this.pipeline) {
            console.log("Cannot load Donut's blit shaders");
            return false;
        }
        this.linearClamp = Nri_CreateSampler(device, NriFilter.Linear, NriAddressMode.ClampToEdge, 1);
        return true;
    }

    // The set of a blit from source (a texture view) from the pool (a texture and a sampler); null on
    // failure.
    createSet(descriptorPool: NriDescriptorPoolHandle, source: NriDescriptorHandle): NriDescriptorSetHandle | null {
        const layout = this.layout;
        const linearClamp = this.linearClamp;
        if (!layout || !linearClamp) {
            return null;
        }
        const set = Nri_AllocateDescriptorSet(descriptorPool, layout, 0, 0);
        if (set) {
            Nri_UpdateDescriptor(set, 0, 0, source);
            Nri_UpdateDescriptor(set, 1, 0, linearClamp);
        }
        return set;
    }

    // The blit of set's source over a width x height attachment (between Nri_CmdBeginRendering and
    // Nri_CmdEndRendering; the set's pool set).
    record(commandBuffer: NriCommandBufferHandle, set: NriDescriptorSetHandle, width: int, height: int) {
        const layout = this.layout;
        const pipeline = this.pipeline;
        if (!layout || !pipeline) {
            return;
        }
        Nri_CmdSetViewport(commandBuffer, 0.0, 0.0, width, height);
        Nri_CmdSetScissor(commandBuffer, 0, 0, width, height);
        Nri_CmdSetPipelineLayout(commandBuffer, layout);
        Nri_CmdSetPipeline(commandBuffer, pipeline);
        Nri_CmdSetRootConstants(commandBuffer, 0, Ref(this.constants[0]), DONUT_BLIT_CONSTANTS.length * 4);
        Nri_CmdSetDescriptorSet(commandBuffer, 0, set);
        Nri_CmdDraw(commandBuffer, 4, 1, 0, 0);
    }

    // After the device is idle (the sets go with their pool).
    destroy() {
        const pipeline = this.pipeline;
        if (pipeline) {
            Nri_DestroyPipeline(pipeline);
        }
        const layout = this.layout;
        if (layout) {
            Nri_DestroyPipelineLayout(layout);
        }
        const linearClamp = this.linearClamp;
        if (linearClamp) {
            Nri_DestroyDescriptor(linearClamp);
        }
    }
}
