// The textures of a Donut scene (NriDonutScene.load) as Donut's TextureCache makes them: each image
// with the mip chain below its first level blitted level by level with Donut's blit shaders (rect_vs,
// blit_ps) through sRGB or linear views, as the texture is: for the NRI ports of Donut examples that
// draw Donut scenes, so their frames match the Donut example's.
//
// Imported with `import { DonutSceneTextures } from "../../core/nri_donut_textures";` (from
// examples/nri/), and listed in the example's add_tslang_nri_example sources; the example depends on
// donut_shaders (shaders/framework).

/// <reference path="nri/nri_interop.d.ts" />
import { NriCommandBuffer, NriDescriptor, NriDescriptorPool, NriDescriptorSet, NriDevice, NriDonutScene, NriPipeline, NriPipelineDesc, NriPipelineLayout, NriPipelineLayoutDesc, NriQueue, NriTexture } from "./nri";

// Donut's blit (CommonRenderPasses::BlitTexture) of a level into the next: struct BlitConstants
// { float2 sourceOrigin, sourceSize, targetOrigin, targetSize; float sharpenFactor; }.
const BLIT_CONSTANTS: f32[] = [0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0];

// A blit of a texture's level into the next: the level's attachment view, the set of the level
// above's view, whether the texture is sRGB.
class MipBlit {
    constructor(public texture: NriTexture, public mip: int, public width: int, public height: int, public srgb: boolean,
        public attachment: NriDescriptor, public sourceView: NriDescriptor, public set: NriDescriptorSet) {
    }
}

@final
export class DonutSceneTextures {
    // By number, and their views (sRGB or linear, as the texture is).
    textures: NriTexture[] = [];
    views: NriDescriptor[] = [];
    private srgb: boolean[] = [];
    private blits: MipBlit[] = [];
    private blitted: boolean = false;
    private blitLayout: NriPipelineLayout | null = null;
    // For linear (0) and sRGB (1) textures.
    private blitPipelines: NriPipeline[] = [];
    private linearClamp: NriDescriptor | null = null;
    private blitConstants: f32[] = [];

    // Loads the scene's textures (and their mip chains' pipelines: shaders/framework/<folder>); false
    // (after printing why) on failure.
    load(device: NriDevice, queue: NriQueue, scene: NriDonutScene, folder: string): boolean {
        for (const value of BLIT_CONSTANTS) {
            this.blitConstants.push(value);
        }
        const count = scene.getTextureCount();
        for (let i = 0; i < count; i++) {
            const path = scene.getTexturePath(i);
            const srgb = scene.getTextureSrgb(i) != 0;
            const texture = device.loadImageTextureWithMipChain(queue, path, srgb ? 1 : 0);
            if (!texture) {
                console.log(`Cannot load the texture ${path}`);
                return false;
            }
            this.textures.push(texture);
            this.srgb.push(srgb);
            this.views.push(texture.createView(srgb ? NriFormat.RGBA8_SRGB : NriFormat.RGBA8_UNORM));
        }

        // Donut's blit: its constants (b0), the source (t0), linear clamp sampling (s0).
        const layoutDesc = NriPipelineLayoutDesc.create();
        layoutDesc.addRootConstants(0, BLIT_CONSTANTS.length * 4, NriStage.Vertex);
        layoutDesc.addRange(0, 0, 1, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
        layoutDesc.addRange(0, 0, 1, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
        const layout = device.createPipelineLayoutFromDesc(layoutDesc);
        layoutDesc.destroy();
        this.blitLayout = layout;
        if (!layout) {
            console.log("Cannot create the blit's layout");
            return false;
        }
        const formats = [NriFormat.RGBA8_UNORM, NriFormat.RGBA8_SRGB];
        for (const format of formats) {
            const desc = NriPipelineDesc.create();
            let loaded = desc.addShader(NriShaderStage.Vertex, `shaders/framework/${folder}/rect_vs.bin`, "main") != 0;
            if (loaded) {
                loaded = desc.addShaderPermutation(NriShaderStage.Pixel, `shaders/framework/${folder}/blit_ps.bin`, "main",
                    "TEXTURE_ARRAY=0") != 0;
            }
            desc.setTopology(NriTopology.TriangleStrip);
            desc.setColor(format, NriColorWrite.RGBA);
            const pipeline = loaded ? device.createPipelineFromDesc(layout, desc) : null;
            desc.destroy();
            if (!pipeline) {
                console.log("Cannot load Donut's blit shaders");
                return false;
            }
            this.blitPipelines.push(pipeline);
        }
        this.linearClamp = device.createSampler(NriFilter.Linear, NriAddressMode.ClampToEdge, 1);
        return true;
    }

    // The sets the mip chains' blits take from a pool (a texture and a sampler each).
    blitSetCount(): int {
        let count = 0;
        for (const texture of this.textures) {
            count += texture.getMipNum() - 1;
        }
        return count;
    }

    // The blits' sets and views, from the pool; false on failure.
    createBlits(descriptorPool: NriDescriptorPool): boolean {
        const layout = this.blitLayout;
        const linearClamp = this.linearClamp;
        if (!layout || !linearClamp) {
            return false;
        }
        for (let t = 0; t < this.textures.length; t++) {
            const texture = this.textures[t];
            const srgb = this.srgb[t];
            const format = srgb ? NriFormat.RGBA8_SRGB : NriFormat.RGBA8_UNORM;
            const mipNum = texture.getMipNum();
            const width = texture.getWidth();
            const height = texture.getHeight();
            for (let mip = 1; mip < mipNum; mip++) {
                const set = descriptorPool.allocateDescriptorSet(layout, 0, 0);
                if (!set) {
                    return false;
                }
                const sourceView = texture.createMipView(format, mip - 1);
                set.updateDescriptor(0, 0, sourceView);
                set.updateDescriptor(1, 0, linearClamp);
                this.blits.push(new MipBlit(texture, mip, Math.max(width >> mip, 1), Math.max(height >> mip, 1), srgb,
                    texture.createColorAttachmentMipView(format, mip), sourceView, set));
            }
        }
        return true;
    }

    // The mip chains, once (the first frame, before the textures are read; the pool set).
    recordBlits(commandBuffer: NriCommandBuffer) {
        const layout = this.blitLayout;
        if (this.blitted || !layout) {
            return;
        }
        for (const blit of this.blits) {
            commandBuffer.textureMipBarrier(blit.texture, blit.mip, NriTextureState.ShaderResource, NriTextureState.ColorAttachment);
            commandBuffer.beginRendering(blit.attachment);
            commandBuffer.setViewport(0.0, 0.0, blit.width, blit.height);
            commandBuffer.setScissor(0, 0, blit.width, blit.height);
            commandBuffer.setPipelineLayout(layout);
            commandBuffer.setPipeline(this.blitPipelines[blit.srgb ? 1 : 0]);
            commandBuffer.setRootConstants(0, Ref(this.blitConstants[0]), BLIT_CONSTANTS.length * 4);
            commandBuffer.setDescriptorSet(0, blit.set);
            commandBuffer.draw(4, 1, 0, 0);
            commandBuffer.endRendering();
            commandBuffer.textureMipBarrier(blit.texture, blit.mip, NriTextureState.ColorAttachment, NriTextureState.ShaderResource);
        }
        this.blitted = true;
    }

    // After the device is idle (the sets go with their pool).
    destroy() {
        for (const blit of this.blits) {
            blit.attachment.destroy();
            blit.sourceView.destroy();
        }
        for (const view of this.views) {
            view.destroy();
        }
        for (const texture of this.textures) {
            texture.destroy();
        }
        for (const pipeline of this.blitPipelines) {
            pipeline.destroy();
        }
        const layout = this.blitLayout;
        if (layout) {
            layout.destroy();
        }
        const linearClamp = this.linearClamp;
        if (linearClamp) {
            linearClamp.destroy();
        }
    }
}
