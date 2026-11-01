// The textures of a Donut scene (Nri_LoadDonutScene) as Donut's TextureCache makes them: each image
// with the mip chain below its first level blitted level by level with Donut's blit shaders (rect_vs,
// blit_ps) through sRGB or linear views, as the texture is: for the NRI ports of Donut examples that
// draw Donut scenes, so their frames match the Donut example's.
//
// Imported with `import { DonutSceneTextures } from "../../core/nri_donut_textures";` (from
// examples/nri/), and listed in the example's add_tslang_nri_example sources; the example depends on
// donut_shaders (shaders/framework).

/// <reference path="nri/nri_interop.d.ts" />

// Donut's blit (CommonRenderPasses::BlitTexture) of a level into the next: struct BlitConstants
// { float2 sourceOrigin, sourceSize, targetOrigin, targetSize; float sharpenFactor; }.
const BLIT_CONSTANTS: f32[] = [0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0];

// A blit of a texture's level into the next: the level's attachment view, the set of the level
// above's view, whether the texture is sRGB.
class MipBlit {
    constructor(public texture: NriTextureHandle, public mip: int, public width: int, public height: int, public srgb: boolean,
        public attachment: NriDescriptorHandle, public sourceView: NriDescriptorHandle, public set: NriDescriptorSetHandle) {
    }
}

@final
export class DonutSceneTextures {
    // By number, and their views (sRGB or linear, as the texture is).
    textures: NriTextureHandle[] = [];
    views: NriDescriptorHandle[] = [];
    private srgb: boolean[] = [];
    private blits: MipBlit[] = [];
    private blitted: boolean = false;
    private blitLayout: NriPipelineLayoutHandle | null = null;
    // For linear (0) and sRGB (1) textures.
    private blitPipelines: NriPipelineHandle[] = [];
    private linearClamp: NriDescriptorHandle | null = null;
    private blitConstants: f32[] = [];

    // Loads the scene's textures (and their mip chains' pipelines: shaders/framework/<folder>); false
    // (after printing why) on failure.
    load(device: NriDeviceHandle, queue: NriQueueHandle, scene: NriDonutSceneHandle, folder: string): boolean {
        for (const value of BLIT_CONSTANTS) {
            this.blitConstants.push(value);
        }
        const count = Nri_GetDonutSceneTextureCount(scene);
        for (let i = 0; i < count; i++) {
            const path = Nri_GetDonutSceneTexturePath(scene, i);
            const srgb = Nri_GetDonutSceneTextureSrgb(scene, i) != 0;
            const texture = Nri_LoadImageTextureWithMipChain(device, queue, path, srgb ? 1 : 0);
            if (!texture) {
                console.log(`Cannot load the texture ${path}`);
                return false;
            }
            this.textures.push(texture);
            this.srgb.push(srgb);
            this.views.push(Nri_CreateTextureView(texture, srgb ? NriFormat.RGBA8_SRGB : NriFormat.RGBA8_UNORM));
        }

        // Donut's blit: its constants (b0), the source (t0), linear clamp sampling (s0).
        const layoutDesc = Nri_CreatePipelineLayoutDesc();
        Nri_PipelineLayoutDescAddRootConstants(layoutDesc, 0, BLIT_CONSTANTS.length * 4, NriStage.Vertex);
        Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 0, 1, NriDescriptorType.Texture, NriStage.Pixel, NriRangeFlags.None);
        Nri_PipelineLayoutDescAddRange(layoutDesc, 0, 0, 1, NriDescriptorType.Sampler, NriStage.Pixel, NriRangeFlags.None);
        const layout = Nri_CreatePipelineLayoutFromDesc(device, layoutDesc);
        Nri_DestroyPipelineLayoutDesc(layoutDesc);
        this.blitLayout = layout;
        if (!layout) {
            console.log("Cannot create the blit's layout");
            return false;
        }
        const formats = [NriFormat.RGBA8_UNORM, NriFormat.RGBA8_SRGB];
        for (const format of formats) {
            const desc = Nri_CreatePipelineDesc();
            let loaded = Nri_PipelineDescAddShader(desc, NriShaderStage.Vertex, `shaders/framework/${folder}/rect_vs.bin`, "main") != 0;
            if (loaded) {
                loaded = Nri_PipelineDescAddShaderPermutation(desc, NriShaderStage.Pixel, `shaders/framework/${folder}/blit_ps.bin`, "main",
                    "TEXTURE_ARRAY=0") != 0;
            }
            Nri_PipelineDescSetTopology(desc, NriTopology.TriangleStrip);
            Nri_PipelineDescSetColor(desc, format, NriColorWrite.RGBA);
            const pipeline = loaded ? Nri_CreatePipelineFromDesc(device, layout, desc) : null;
            Nri_DestroyPipelineDesc(desc);
            if (!pipeline) {
                console.log("Cannot load Donut's blit shaders");
                return false;
            }
            this.blitPipelines.push(pipeline);
        }
        this.linearClamp = Nri_CreateSampler(device, NriFilter.Linear, NriAddressMode.ClampToEdge, 1);
        return true;
    }

    // The sets the mip chains' blits take from a pool (a texture and a sampler each).
    blitSetCount(): int {
        let count = 0;
        for (const texture of this.textures) {
            count += Nri_GetTextureMipNum(texture) - 1;
        }
        return count;
    }

    // The blits' sets and views, from the pool; false on failure.
    createBlits(descriptorPool: NriDescriptorPoolHandle): boolean {
        const layout = this.blitLayout;
        const linearClamp = this.linearClamp;
        if (!layout || !linearClamp) {
            return false;
        }
        for (let t = 0; t < this.textures.length; t++) {
            const texture = this.textures[t];
            const srgb = this.srgb[t];
            const format = srgb ? NriFormat.RGBA8_SRGB : NriFormat.RGBA8_UNORM;
            const mipNum = Nri_GetTextureMipNum(texture);
            const width = Nri_GetTextureWidth(texture);
            const height = Nri_GetTextureHeight(texture);
            for (let mip = 1; mip < mipNum; mip++) {
                const set = Nri_AllocateDescriptorSet(descriptorPool, layout, 0, 0);
                if (!set) {
                    return false;
                }
                const sourceView = Nri_CreateTextureMipView(texture, format, mip - 1);
                Nri_UpdateDescriptor(set, 0, 0, sourceView);
                Nri_UpdateDescriptor(set, 1, 0, linearClamp);
                this.blits.push(new MipBlit(texture, mip, Math.max(width >> mip, 1), Math.max(height >> mip, 1), srgb,
                    Nri_CreateColorAttachmentMipView(texture, format, mip), sourceView, set));
            }
        }
        return true;
    }

    // The mip chains, once (the first frame, before the textures are read; the pool set).
    recordBlits(commandBuffer: NriCommandBufferHandle) {
        const layout = this.blitLayout;
        if (this.blitted || !layout) {
            return;
        }
        for (const blit of this.blits) {
            Nri_CmdTextureMipBarrier(commandBuffer, blit.texture, blit.mip, NriTextureState.ShaderResource, NriTextureState.ColorAttachment);
            Nri_CmdBeginRendering(commandBuffer, blit.attachment);
            Nri_CmdSetViewport(commandBuffer, 0.0, 0.0, blit.width, blit.height);
            Nri_CmdSetScissor(commandBuffer, 0, 0, blit.width, blit.height);
            Nri_CmdSetPipelineLayout(commandBuffer, layout);
            Nri_CmdSetPipeline(commandBuffer, this.blitPipelines[blit.srgb ? 1 : 0]);
            Nri_CmdSetRootConstants(commandBuffer, 0, Ref(this.blitConstants[0]), BLIT_CONSTANTS.length * 4);
            Nri_CmdSetDescriptorSet(commandBuffer, 0, blit.set);
            Nri_CmdDraw(commandBuffer, 4, 1, 0, 0);
            Nri_CmdEndRendering(commandBuffer);
            Nri_CmdTextureMipBarrier(commandBuffer, blit.texture, blit.mip, NriTextureState.ColorAttachment, NriTextureState.ShaderResource);
        }
        this.blitted = true;
    }

    // After the device is idle (the sets go with their pool).
    destroy() {
        for (const blit of this.blits) {
            Nri_DestroyDescriptor(blit.attachment);
            Nri_DestroyDescriptor(blit.sourceView);
        }
        for (const view of this.views) {
            Nri_DestroyDescriptor(view);
        }
        for (const texture of this.textures) {
            Nri_DestroyTexture(texture);
        }
        for (const pipeline of this.blitPipelines) {
            Nri_DestroyPipeline(pipeline);
        }
        const layout = this.blitLayout;
        if (layout) {
            Nri_DestroyPipelineLayout(layout);
        }
        const linearClamp = this.linearClamp;
        if (linearClamp) {
            Nri_DestroyDescriptor(linearClamp);
        }
    }
}
