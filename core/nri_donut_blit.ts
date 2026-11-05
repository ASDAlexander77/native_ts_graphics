// Donut's blit (CommonRenderPasses::BlitTexture: shaders/framework's rect_vs and blit_ps, linear
// clamp sampling) of a whole texture into a whole color attachment, for the NRI ports of Donut
// examples that blit what they render into the back buffer (app.blitTexture), so their frames match
// the Donut example's.
//
// Imported with `import { DonutBlit } from "../../core/nri_donut_blit";` (from examples/nri/), and
// listed in the example's add_tslang_nri_example sources; the example depends on donut_shaders
// (shaders/framework).

/// <reference path="nri/nri_interop.d.ts" />
import { NriCommandBuffer, NriDescriptor, NriDescriptorPool, NriDescriptorSet, NriDevice, NriPipeline, NriPipelineDesc, NriPipelineLayout, NriPipelineLayoutDesc } from "./nri";

// struct BlitConstants { float2 sourceOrigin, sourceSize, targetOrigin, targetSize; float
// sharpenFactor; }: the whole source into the whole target.
const DONUT_BLIT_CONSTANTS: f32[] = [0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0];

@final
export class DonutBlit {
    private layout: NriPipelineLayout | null = null;
    private pipeline: NriPipeline | null = null;
    private linearClamp: NriDescriptor | null = null;
    private constants: f32[] = [];

    // The blit's layout and pipeline (shaders/framework/<folder>), into attachments of format;
    // false (after printing why) on failure.
    init(device: NriDevice, folder: string, format: NriFormat): boolean {
        for (const value of DONUT_BLIT_CONSTANTS) {
            this.constants.push(value);
        }

        // Its constants (b0), the source (t0), linear clamp sampling (s0).
        const layoutDesc = NriPipelineLayoutDesc.create();
        layoutDesc.addRootConstants(0, DONUT_BLIT_CONSTANTS.length * 4, NriStage.Vertex);
        layoutDesc.addRange(0, 0, 1, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
        layoutDesc.addRange(0, 0, 1, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
        const layout = device.createPipelineLayoutFromDesc(layoutDesc);
        layoutDesc.destroy();
        this.layout = layout;
        if (!layout) {
            console.log("Cannot create the blit's layout");
            return false;
        }

        const desc = NriPipelineDesc.create();
        let loaded = desc.addShader(NriShaderStage.Vertex, `shaders/framework/${folder}/rect_vs.bin`, "main") != 0;
        if (loaded) {
            loaded = desc.addShaderPermutation(NriShaderStage.Pixel, `shaders/framework/${folder}/blit_ps.bin`, "main",
                "TEXTURE_ARRAY=0") != 0;
        }
        desc.setTopology(NriTopology.TriangleStrip);
        desc.setColor(format, NriColorWrite.RGBA);
        this.pipeline = loaded ? device.createPipelineFromDesc(layout, desc) : null;
        desc.destroy();
        if (!this.pipeline) {
            console.log("Cannot load Donut's blit shaders");
            return false;
        }
        this.linearClamp = device.createSampler(NriFilter.Linear, NriAddressMode.ClampToEdge, 1);
        return true;
    }

    // The set of a blit from source (a texture view) from the pool (a texture and a sampler); null on
    // failure.
    createSet(descriptorPool: NriDescriptorPool, source: NriDescriptor): NriDescriptorSet | null {
        const layout = this.layout;
        const linearClamp = this.linearClamp;
        if (!layout || !linearClamp) {
            return null;
        }
        const set = descriptorPool.allocateDescriptorSet(layout, 0, 0);
        if (set) {
            set.updateDescriptor(0, 0, source);
            set.updateDescriptor(1, 0, linearClamp);
        }
        return set;
    }

    // The blit of set's source over a width x height attachment (between NriCommandBuffer.beginRendering and
    // NriCommandBuffer.endRendering; the set's pool set).
    record(commandBuffer: NriCommandBuffer, set: NriDescriptorSet, width: int, height: int) {
        const layout = this.layout;
        const pipeline = this.pipeline;
        if (!layout || !pipeline) {
            return;
        }
        commandBuffer.setViewport(0.0, 0.0, width, height);
        commandBuffer.setScissor(0, 0, width, height);
        commandBuffer.setPipelineLayout(layout);
        commandBuffer.setPipeline(pipeline);
        commandBuffer.setRootConstants(0, Ref(this.constants[0]), DONUT_BLIT_CONSTANTS.length * 4);
        commandBuffer.setDescriptorSet(0, set);
        commandBuffer.draw(4, 1, 0, 0);
    }

    // After the device is idle (the sets go with their pool).
    destroy() {
        const pipeline = this.pipeline;
        if (pipeline) {
            pipeline.destroy();
        }
        const layout = this.layout;
        if (layout) {
            layout.destroy();
        }
        const linearClamp = this.linearClamp;
        if (linearClamp) {
            linearClamp.destroy();
        }
    }
}
