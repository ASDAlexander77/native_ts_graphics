// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";

namespace RtParticles {
    // GLFW values, as passed to the keyboard callback.
    const KEY_SPACE = 32;
    const ACTION_PRESS = 1;

    const WINDOW_TITLE = "Donut Example: Ray Traced Particles";
    const SCENE_PATH = "media/rt_particles/ParticleScene.gltf";

    const MAX_PARTICLES = 1024;
    const INDICES_PER_QUAD = 6;
    const VERTICES_PER_QUAD = 4;

    // main in rt_particles.hlsl runs 16 x 16 threads per group.
    const COMPUTE_GROUP_SIZE = 16;
    // The MLAB_FRAGMENTS permutations compiled in shaders/rt_particles.cfg.
    const g_MlabFragmentCounts: int[] = [1, 2, 4, 8];

    // From shaders/rt_particles_cb.h.
    const INSTANCE_MASK_OPAQUE = 1;
    const INSTANCE_MASK_PARTICLE_GEOMETRY = 2;
    const INSTANCE_MASK_INTERSECTION_PARTICLE = 4;

    const ORIENTATION_MODE_AVT_MATRIX = 0;
    const ORIENTATION_MODE_QUATERNION = 1;
    const ORIENTATION_MODE_BEAM = 2;
    const ORIENTATION_MODE_BASIS = 3;

    // struct ParticleInfo (64 bytes), as f32 offsets.
    const PARTICLE_INFO_FLOATS = 16;
    const PARTICLE_INFO_CENTER = 0;
    const PARTICLE_INFO_ROTATION = 3;
    const PARTICLE_INFO_X_AXIS = 4;
    const PARTICLE_INFO_INVERSE_RADIUS = 7;
    const PARTICLE_INFO_Y_AXIS = 8;
    const PARTICLE_INFO_TEXTURE_INDEX = 11; // int
    const PARTICLE_INFO_COLOR_FACTOR = 12;
    const PARTICLE_INFO_OPACITY_FACTOR = 15;

    // struct GlobalConstants: PlanarViewConstants view (size from Donut), then these, as f32 offsets
    // from the end of `view`.
    const GLOBAL_PRIMARY_RAY_CONE_ANGLE = 0;
    const GLOBAL_REORIENT_PRIMARY = 1;   // uint
    const GLOBAL_REORIENT_SECONDARY = 2; // uint
    const GLOBAL_ORIENTATION_MODE = 3;   // uint
    const GLOBAL_ENVIRONMENT_MAP = 4;    // int
    const GLOBAL_TAIL_FLOATS = 5;

    const PARTICLE_TEXTURE_SMOKE = 0;
    const PARTICLE_TEXTURE_LOGO = 1;

    // --- Math ---------------------------------------------------------------------------------

    function radians(degrees: number): number {
        return degrees * Math.PI / 180.0;
    }

    function saturate(x: number): number {
        return Math.min(Math.max(x, 0.0), 1.0);
    }

    // std::rand() / RAND_MAX replacement: a Park-Miller generator (tslang's Math.random isn't usable).
    let g_RandomSeed = 12345.0;
    function randomFloat(): number {
        g_RandomSeed = (g_RandomSeed * 16807.0) % 2147483647.0;
        return g_RandomSeed / 2147483647.0;
    }

    // math::perspProjD3DStyleReverse(verticalFOV, aspect, zNear): reverse Z, infinite far plane,
    // row-major with Donut's row-vector convention.
    // In float32 as Donut's (computed in double, the scales differ in the last bit, which moves
    // edges by a pixel here and there).
    function perspProjD3DStyleReverse(verticalFOV: number, aspect: number, zNear: number): number[] {
        const yScale = Math.fround(1.0 / Math.fround(Math.tan(Math.fround(0.5 * Math.fround(verticalFOV)))));
        const xScale = Math.fround(yScale / Math.fround(aspect));
        return [
            xScale, 0.0,    0.0,   0.0,
            0.0,    yScale, 0.0,   0.0,
            0.0,    0.0,    0.0,   1.0,
            0.0,    0.0,    zNear, 0.0,
        ];
    }

    // --- Particles ----------------------------------------------------------------------------

    class ParticleEntity {
        public active: boolean;
        public positionX: number;
        public positionY: number;
        public positionZ: number;
        public velocityX: number;
        public velocityY: number;
        public velocityZ: number;
        public colorR: number;
        public colorG: number;
        public colorB: number;
        public radius: number;
        public age: number;
        public opacity: number;
        public rotation: number;

        constructor() {
            this.active = false;
            this.positionX = 0.0;
            this.positionY = 0.0;
            this.positionZ = 0.0;
            this.velocityX = 0.0;
            this.velocityY = 0.0;
            this.velocityZ = 0.0;
            this.colorR = 1.0;
            this.colorG = 1.0;
            this.colorB = 1.0;
            this.radius = 0.0;
            this.age = 0.0;
            this.opacity = 1.0;
            this.rotation = 0.0;
        }

        emit(emitterX: number, emitterY: number, emitterZ: number): void {
            this.active = true;
            this.positionX = emitterX;
            this.positionY = emitterY;
            this.positionZ = emitterZ;
            this.velocityX = randomFloat() - 0.5;
            this.velocityY = 1.0 + randomFloat() - 0.5;
            this.velocityZ = randomFloat() - 0.5;
            this.radius = randomFloat() * 0.05 + 0.1;
            this.age = 0.0;
            this.opacity = 1.0;
            this.colorR = randomFloat() * 0.5 + 0.1;
            this.colorG = randomFloat() * 0.5 + 0.1;
            this.colorB = randomFloat() * 0.5 + 0.1;
            this.rotation = randomFloat() * 6.28;
        }

        animate(time: number): void {
            const lifeTime = 2.0;

            this.positionX += this.velocityX * time;
            this.positionY += this.velocityY * time;
            this.positionZ += this.velocityZ * time;
            this.velocityY += 1.0 * time;
            this.velocityX += 1.0 * time;
            this.age += time;
            this.radius += 0.5 * time;
            this.opacity = saturate((lifeTime - this.age) * 0.5);

            if (this.age > lifeTime) {
                this.active = false;
            }
        }
    }

    // The settings the UI edits, shared by the passes (the sample's UIData).
    class UIData {
        public updatePipeline: boolean;
        public enableAnimations: boolean;
        public alwaysUpdateOrientation: boolean;
        public reorientParticlesInPrimaryRays: boolean;
        public reorientParticlesInSecondaryRays: boolean;
        public orientationMode: int;
        public mlabFragments: int;
        public particleTexture: int;
        // x, y, z; `let`-style storage for Donut_ImGuiDragFloat3.
        public emitterPosition: f32[];

        constructor() {
            this.updatePipeline = true;
            this.enableAnimations = true;
            this.alwaysUpdateOrientation = true;
            this.reorientParticlesInPrimaryRays = false;
            this.reorientParticlesInSecondaryRays = true;
            this.orientationMode = ORIENTATION_MODE_QUATERNION;
            this.mlabFragments = 4;
            this.particleTexture = PARTICLE_TEXTURE_SMOKE;
            this.emitterPosition = [];
            for (let i = 0; i < 3; i++) {
                this.emitterPosition.push(0.0);
            }
        }
    }

    // --- Passes -------------------------------------------------------------------------------

    // Port of Donut-Samples' rt_particles.cpp: a compute shader traces ray queries through a scene
    // with particles in it twice over, as camera-facing billboard triangles (a dynamic mesh rebuilt
    // every frame) and as procedural AABB instances intersected in the shader, and blends them with
    // multi-layer alpha blending (MLAB, 1-8 fragments), including in reflections.
    class RayTracedParticlesPass {
        private app: App;
        private ui: UIData;
        private scene: Scene;
        private camera: Camera;
        private view: View;
        private bindlessLayout: Opaque;
        private bindingLayout: Opaque;
        private descriptorTable: Opaque;
        private constantBuffer: BufferHandle;
        private particleMesh: Opaque;
        private particleInfoBuffer: BufferHandle;
        private particleIntersectionBLAS: Opaque;
        private topLevelAS: SceneAccelStructs;
        private environmentMap: LoadedTexture;
        private smokeTexture: LoadedTexture;
        private logoTexture: LoadedTexture;
        // The particle texture last given to the particle mesh, and whether the scene has yet to see it.
        private appliedParticleTexture: int;
        private materialDirty: boolean;
        // (Re)created when ui.updatePipeline is set.
        private computeShader: ShaderHandle | null;
        private computePipeline: Opaque | null;
        // Created on the first frame, dropped on resize.
        private colorBuffer: TextureHandle | null;
        private bindingSet: BindingSet;

        private particles: ParticleEntity[];
        private wallclockTime: number;
        private lastEmitTime: number;

        // Per-frame particle geometry and ParticleInfo data, uploaded as a whole.
        private indices: int[];
        private positions: f32[];
        private texCoords: f32[];
        private particleInfos: f32[];
        private cameraForward: f32[];
        private cameraUp: f32[];

        // The GlobalConstants contents; the fields after `view` start at viewFloats.
        private constants: f32[];
        private viewFloats: int;
        private constantsSize: int;
        // Passed to Donut_SetPlanarView, 16 floats each.
        private viewMatrix: f32[];
        private projMatrix: f32[];

        constructor(app: App, ui: UIData) {
            this.app = app;
            this.ui = ui;
            this.appliedParticleTexture = -1;
            this.materialDirty = false;
            this.computeShader = null;
            this.computePipeline = null;
            this.colorBuffer = null;
            this.bindingSet = new BindingSet(null);
            this.wallclockTime = 0.0;
            this.lastEmitTime = 0.0;
            this.viewFloats = 0;
            this.constantsSize = 0;

            this.particles = [];
            for (let i = 0; i < MAX_PARTICLES; i++) {
                this.particles.push(new ParticleEntity());
            }

            this.indices = [];
            for (let i = 0; i < MAX_PARTICLES * INDICES_PER_QUAD; i++) {
                this.indices.push(0);
            }
            this.positions = [];
            for (let i = 0; i < MAX_PARTICLES * VERTICES_PER_QUAD * 3; i++) {
                this.positions.push(0.0);
            }
            this.texCoords = [];
            for (let i = 0; i < MAX_PARTICLES * VERTICES_PER_QUAD * 2; i++) {
                this.texCoords.push(0.0);
            }
            this.particleInfos = [];
            for (let i = 0; i < MAX_PARTICLES * PARTICLE_INFO_FLOATS; i++) {
                this.particleInfos.push(0.0);
            }
            this.cameraForward = [0.0, 0.0, 0.0];
            this.cameraUp = [0.0, 0.0, 0.0];

            this.constants = [];
            this.viewMatrix = [];
            this.projMatrix = [];
            for (let i = 0; i < 16; i++) {
                this.viewMatrix.push(0.0);
                this.projMatrix.push(0.0);
            }
        }

        onKey(key: int, scancode: int, action: int, mods: int): int {
            this.camera.keyboardUpdate(key, scancode, action, mods);

            if (key == KEY_SPACE && action == ACTION_PRESS) {
                this.ui.enableAnimations = !this.ui.enableAnimations;
            }

            return 1;
        }

        onMousePos(x: number, y: number): int {
            this.camera.mousePosUpdate(x, y);
            return 1;
        }

        onMouseButton(button: int, action: int, mods: int): int {
            this.camera.mouseButtonUpdate(button, action, mods);
            return 1;
        }

        onMouseScroll(xOffset: number, yOffset: number): int {
            this.camera.mouseScrollUpdate(xOffset, yOffset);
            return 1;
        }

        onAnimate(elapsedSeconds: number): void {
            this.camera.animate(elapsedSeconds);

            if (this.ui.enableAnimations) {
                this.wallclockTime += elapsedSeconds;

                // Animate the live particles, also find the first empty particle slot for spawning.
                let firstEmptyParticle = -1;
                for (let i = 0; i < MAX_PARTICLES; i++) {
                    const particle = this.particles[i];

                    if (particle.active) {
                        particle.animate(elapsedSeconds);
                    }

                    if (!particle.active && firstEmptyParticle < 0) {
                        firstEmptyParticle = i;
                    }
                }

                const particlesPerSecond = 20.0;
                const particleEmissionPeriod = 1.0 / particlesPerSecond;

                // Emit a new particle if enough time has passed since the last emission.
                if (this.wallclockTime - this.lastEmitTime > particleEmissionPeriod && firstEmptyParticle >= 0) {
                    this.particles[firstEmptyParticle].emit(
                        this.ui.emitterPosition[0], this.ui.emitterPosition[1], this.ui.emitterPosition[2]);
                    this.lastEmitTime = this.wallclockTime;
                }
            }

            this.app.setInformativeWindowTitle(WINDOW_TITLE);
        }

        onBackBufferResizing(): void {
            const bindingSet = this.bindingSet;
            if (!bindingSet.isNull()) {
                this.app.releaseResource(bindingSet.handle);
                this.bindingSet = new BindingSet(null);
            }

            const colorBuffer = this.colorBuffer;
            if (colorBuffer) {
                this.app.releaseResource(colorBuffer);
                this.colorBuffer = null;
            }

            // The blit's cached binding sets still reference the old color buffer.
            this.app.clearBindingCache();
        }

        // Recreates the compute pipeline for ui.mlabFragments.
        createComputePipeline(): boolean {
            const oldPipeline = this.computePipeline;
            if (oldPipeline) {
                this.app.releaseResource(oldPipeline);
                this.computePipeline = null;
            }
            const oldShader = this.computeShader;
            if (oldShader) {
                this.app.releaseResource(oldShader);
                this.computeShader = null;
            }

            const shader = this.app.createShaderWithDefine("rt_particles.hlsl", "main", ShaderType.Compute,
                "MLAB_FRAGMENTS", `${this.ui.mlabFragments}`);
            if (!shader) {
                return false;
            }
            this.computeShader = shader;

            const pipeline = this.app.createComputePipelineWithLayouts(shader, this.bindingLayout, this.bindlessLayout);
            if (!pipeline) {
                return false;
            }
            this.computePipeline = pipeline;
            return true;
        }

        // Updates the particle billboards (facing the camera) and ParticleInfo data, and rebuilds the
        // particle mesh's BLAS.
        buildParticleGeometry(frame: Frame): void {
            this.camera.getDirection(Ref(this.cameraForward[0]));
            this.camera.getUp(Ref(this.cameraUp[0]));
            let forwardX = this.cameraForward[0];
            let forwardY = this.cameraForward[1];
            let forwardZ = this.cameraForward[2];
            let upX = this.cameraUp[0];
            let upY = this.cameraUp[1];
            let upZ = this.cameraUp[2];

            // To demonstrate beam orientation, we create vertical sprites that are free to rotate
            // around the world-space Y axis, simulating what old Doom-like games used.
            if (this.ui.orientationMode == ORIENTATION_MODE_BEAM) {
                if (Math.abs(forwardY) > 0.999) {
                    forwardX = upX;
                    forwardY = upY;
                    forwardZ = upZ;
                }

                forwardY = 0.0;
                const length = Math.sqrt(forwardX * forwardX + forwardZ * forwardZ);
                forwardX /= length;
                forwardZ /= length;
                upX = 0.0;
                upY = 1.0;
                upZ = 0.0;
            }

            // cross(forward, up)
            const rightX = forwardY * upZ - forwardZ * upY;
            const rightY = forwardZ * upX - forwardX * upZ;
            const rightZ = forwardX * upY - forwardY * upX;

            const textureIndex = (this.ui.particleTexture == PARTICLE_TEXTURE_SMOKE
                ? this.smokeTexture : this.logoTexture).getDescriptorIndex();

            let numParticles = 0;
            for (let index = 0; index < MAX_PARTICLES; index++) {
                const particle = this.particles[index];
                if (!particle.active) {
                    continue;
                }

                const baseIndex = numParticles * INDICES_PER_QUAD;
                const baseVertex = numParticles * VERTICES_PER_QUAD;

                // Indices for a quad.
                this.indices[baseIndex + 0] = baseVertex + 0;
                this.indices[baseIndex + 1] = baseVertex + 1;
                this.indices[baseIndex + 2] = baseVertex + 2;
                this.indices[baseIndex + 3] = baseVertex + 0;
                this.indices[baseIndex + 4] = baseVertex + 2;
                this.indices[baseIndex + 5] = baseVertex + 3;

                // The quad orientation in world space.
                const rotation = this.ui.orientationMode == ORIENTATION_MODE_BEAM ? 0.0 : particle.rotation;
                const localRightX = Math.cos(rotation);
                const localRightY = Math.sin(rotation);
                const localUpX = -localRightY;
                const localUpY = localRightX;
                const worldRightX = localRightX * rightX + localRightY * upX;
                const worldRightY = localRightX * rightY + localRightY * upY;
                const worldRightZ = localRightX * rightZ + localRightY * upZ;
                const worldUpX = localUpX * rightX + localUpY * upX;
                const worldUpY = localUpX * rightY + localUpY * upY;
                const worldUpZ = localUpX * rightZ + localUpY * upZ;

                // Positions: corners (-right + up), (+right + up), (+right - up), (-right - up).
                const r = particle.radius;
                const p = baseVertex * 3;
                this.positions[p + 0] = particle.positionX + (-worldRightX + worldUpX) * r;
                this.positions[p + 1] = particle.positionY + (-worldRightY + worldUpY) * r;
                this.positions[p + 2] = particle.positionZ + (-worldRightZ + worldUpZ) * r;
                this.positions[p + 3] = particle.positionX + (worldRightX + worldUpX) * r;
                this.positions[p + 4] = particle.positionY + (worldRightY + worldUpY) * r;
                this.positions[p + 5] = particle.positionZ + (worldRightZ + worldUpZ) * r;
                this.positions[p + 6] = particle.positionX + (worldRightX - worldUpX) * r;
                this.positions[p + 7] = particle.positionY + (worldRightY - worldUpY) * r;
                this.positions[p + 8] = particle.positionZ + (worldRightZ - worldUpZ) * r;
                this.positions[p + 9] = particle.positionX + (-worldRightX - worldUpX) * r;
                this.positions[p + 10] = particle.positionY + (-worldRightY - worldUpY) * r;
                this.positions[p + 11] = particle.positionZ + (-worldRightZ - worldUpZ) * r;

                // Texture coordinates: (0, 0), (1, 0), (1, 1), (0, 1).
                const t = baseVertex * 2;
                this.texCoords[t + 0] = 0.0;
                this.texCoords[t + 1] = 0.0;
                this.texCoords[t + 2] = 1.0;
                this.texCoords[t + 3] = 0.0;
                this.texCoords[t + 4] = 1.0;
                this.texCoords[t + 5] = 1.0;
                this.texCoords[t + 6] = 0.0;
                this.texCoords[t + 7] = 1.0;

                // The ParticleInfo structure for the shaders, mostly for the intersection particles.
                const info = numParticles * PARTICLE_INFO_FLOATS;
                this.particleInfos[info + PARTICLE_INFO_CENTER + 0] = particle.positionX;
                this.particleInfos[info + PARTICLE_INFO_CENTER + 1] = particle.positionY;
                this.particleInfos[info + PARTICLE_INFO_CENTER + 2] = particle.positionZ;
                this.particleInfos[info + PARTICLE_INFO_ROTATION] = particle.rotation;
                this.particleInfos[info + PARTICLE_INFO_X_AXIS + 0] = worldRightX;
                this.particleInfos[info + PARTICLE_INFO_X_AXIS + 1] = worldRightY;
                this.particleInfos[info + PARTICLE_INFO_X_AXIS + 2] = worldRightZ;
                this.particleInfos[info + PARTICLE_INFO_INVERSE_RADIUS] = 1.0 / r;
                this.particleInfos[info + PARTICLE_INFO_Y_AXIS + 0] = worldUpX;
                this.particleInfos[info + PARTICLE_INFO_Y_AXIS + 1] = worldUpY;
                this.particleInfos[info + PARTICLE_INFO_Y_AXIS + 2] = worldUpZ;
                Donut_StoreInt32(Ref(this.particleInfos[info + PARTICLE_INFO_TEXTURE_INDEX]), textureIndex);
                this.particleInfos[info + PARTICLE_INFO_COLOR_FACTOR + 0] = particle.colorR;
                this.particleInfos[info + PARTICLE_INFO_COLOR_FACTOR + 1] = particle.colorG;
                this.particleInfos[info + PARTICLE_INFO_COLOR_FACTOR + 2] = particle.colorB;
                this.particleInfos[info + PARTICLE_INFO_OPACITY_FACTOR] = particle.opacity;

                numParticles++;
            }

            frame.updateDynamicMesh(this.particleMesh, Ref(this.positions[0]), Ref(this.texCoords[0]),
                numParticles * VERTICES_PER_QUAD, Ref(this.indices[0]), numParticles * INDICES_PER_QUAD);

            if (numParticles > 0) {
                frame.getCommandList().writeBuffer(this.particleInfoBuffer, Ref(this.particleInfos[0]),
                    numParticles * PARTICLE_INFO_FLOATS * 4);
            }
        }

        // The TLAS: the scene's instances (the particle mesh with its own mask), plus one scaled AABB
        // instance per active particle for the intersection path.
        buildTLAS(frame: Frame): void {
            this.topLevelAS.addSceneInstances(this.scene, INSTANCE_MASK_OPAQUE,
                this.particleMesh, INSTANCE_MASK_PARTICLE_GEOMETRY);

            let particleIndex = 0;
            for (let i = 0; i < MAX_PARTICLES; i++) {
                const particle = this.particles[i];
                if (!particle.active) {
                    continue;
                }

                this.topLevelAS.addInstance(this.particleIntersectionBLAS, INSTANCE_MASK_INTERSECTION_PARTICLE,
                    particleIndex, particle.radius, particle.positionX, particle.positionY, particle.positionZ);
                particleIndex++;
            }

            frame.buildTopLevelAS(this.topLevelAS);
        }

        onRender(frameHandle: FrameHandle): void {
            const frame = new Frame(frameHandle);
            const width = frame.getWidth();
            const height = frame.getHeight();

            if (this.ui.updatePipeline) {
                if (!this.createComputePipeline()) {
                    this.app.closeWindow();
                    return;
                }
                this.ui.updatePipeline = false;
            }
            const computePipeline = this.computePipeline;
            if (!computePipeline) {
                return;
            }

            let colorBuffer = this.colorBuffer;
            let bindingSet = this.bindingSet;
            if (!colorBuffer || bindingSet.isNull()) {
                colorBuffer = this.app.createUAVTextureForFrameWithFormat(frame, "ColorBuffer", Format.RGBA16_FLOAT);

                const bindingSetDesc = BindingSetDesc.create();
                bindingSetDesc.bindEntireConstantBuffer(0, this.constantBuffer);
                bindingSetDesc.bindAccelStruct(0, this.topLevelAS.getTopLevelAS());
                bindingSetDesc.bindStructuredBufferSRV(1, this.scene.getBuffer(SceneBuffer.Instances));
                bindingSetDesc.bindStructuredBufferSRV(2, this.scene.getBuffer(SceneBuffer.Geometries));
                bindingSetDesc.bindStructuredBufferSRV(3, this.scene.getBuffer(SceneBuffer.Materials));
                bindingSetDesc.bindStructuredBufferSRV(4, this.particleInfoBuffer);
                bindingSetDesc.bindSampler(0, this.app.getCommonSampler(CommonSampler.AnisotropicWrap));
                bindingSetDesc.bindTextureUAV(0, colorBuffer);
                bindingSet = this.app.createBindingSetForLayout(bindingSetDesc, this.bindingLayout);

                this.colorBuffer = colorBuffer;
                this.bindingSet = bindingSet;
            }

            if (this.appliedParticleTexture != this.ui.particleTexture) {
                this.app.setDynamicMeshTexture(this.particleMesh,
                    this.ui.particleTexture == PARTICLE_TEXTURE_SMOKE ? this.smokeTexture : this.logoTexture);
                this.appliedParticleTexture = this.ui.particleTexture;
                this.materialDirty = true;
            }

            this.camera.getWorldToView(Ref(this.viewMatrix[0]));
            const verticalFovRadians = Math.fround(Math.PI * 0.25);
            const projection = perspProjD3DStyleReverse(verticalFovRadians, width / height, 0.1);
            for (let i = 0; i < 16; i++) {
                this.projMatrix[i] = projection[i];
            }
            this.view.setPlanarView(Ref(this.viewMatrix[0]), Ref(this.projMatrix[0]), width, height);
            this.camera.thirdPersonSetView(this.view);

            if (this.ui.enableAnimations || this.ui.alwaysUpdateOrientation || this.materialDirty) {
                this.app.refreshScene(frame, this.scene);
                this.buildParticleGeometry(frame);
                this.buildTLAS(frame);
                this.materialDirty = false;
            }

            const tail = this.viewFloats;
            this.view.fillPlanarViewConstants(Ref(this.constants[0]));
            this.constants[tail + GLOBAL_PRIMARY_RAY_CONE_ANGLE] = verticalFovRadians / height;
            Donut_StoreInt32(Ref(this.constants[tail + GLOBAL_REORIENT_PRIMARY]), this.ui.reorientParticlesInPrimaryRays ? 1 : 0);
            Donut_StoreInt32(Ref(this.constants[tail + GLOBAL_REORIENT_SECONDARY]), this.ui.reorientParticlesInSecondaryRays ? 1 : 0);
            Donut_StoreInt32(Ref(this.constants[tail + GLOBAL_ORIENTATION_MODE]), this.ui.orientationMode);
            Donut_StoreInt32(Ref(this.constants[tail + GLOBAL_ENVIRONMENT_MAP]), this.environmentMap.getDescriptorIndex());
            frame.getCommandList().writeBuffer(this.constantBuffer, Ref(this.constants[0]), this.constantsSize);

            const groupsX: int = Math.floor((width + COMPUTE_GROUP_SIZE - 1) / COMPUTE_GROUP_SIZE);
            const groupsY: int = Math.floor((height + COMPUTE_GROUP_SIZE - 1) / COMPUTE_GROUP_SIZE);
            frame.getCommandList().dispatchWithDescriptorTable(computePipeline, bindingSet,
                this.descriptorTable, groupsX, groupsY, 1);

            this.app.blitTexture(frame, colorBuffer);
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(): boolean {
            const bindlessLayoutDesc = BindlessLayoutDesc.create(0, 1024, ShaderType.All);
            bindlessLayoutDesc.addRawBuffers(1);
            bindlessLayoutDesc.addTextures(2);
            this.bindlessLayout = this.app.createBindlessLayout(bindlessLayoutDesc);

            const layoutDesc = BindingLayoutDesc.create();
            layoutDesc.layoutVolatileConstantBuffer(0);
            layoutDesc.layoutAccelStruct(0);
            layoutDesc.layoutStructuredBufferSRV(1);
            layoutDesc.layoutStructuredBufferSRV(2);
            layoutDesc.layoutStructuredBufferSRV(3);
            layoutDesc.layoutStructuredBufferSRV(4);
            layoutDesc.layoutSampler(0);
            layoutDesc.layoutTextureUAV(0);
            this.bindingLayout = this.app.createBindingLayout(layoutDesc, ShaderType.All);

            const descriptorTableManager = this.app.createDescriptorTableManager(this.bindlessLayout);
            this.descriptorTable = descriptorTableManager.getDescriptorTable();

            // A procedural particle mesh, attached to the scene below.
            this.particleMesh = this.app.createDynamicMesh(descriptorTableManager,
                MAX_PARTICLES * VERTICES_PER_QUAD, MAX_PARTICLES * INDICES_PER_QUAD, "ParticleMesh");
            this.particleInfoBuffer = this.app.createStructuredBuffer(PARTICLE_INFO_FLOATS * 4, MAX_PARTICLES, "ParticleInfoBuffer");

            const environmentMap = this.app.loadBindlessTexture(descriptorTableManager, "media/rt_particles/environment-map.dds", 0);
            const smokeTexture = this.app.loadBindlessTexture(descriptorTableManager, "media/rt_particles/smoke-particle.png", 1);
            const logoTexture = this.app.loadBindlessTexture(descriptorTableManager, "media/nvidia-logo.png", 1);
            if (environmentMap.isNull() || smokeTexture.isNull() || logoTexture.isNull()) {
                console.log("Cannot load the particle textures");
                return false;
            }
            this.environmentMap = environmentMap;
            this.smokeTexture = smokeTexture;
            this.logoTexture = logoTexture;

            const scene = this.app.loadSceneWithDescriptorTable(SCENE_PATH, descriptorTableManager);
            if (scene.isNull()) {
                console.log(`Cannot load the scene ${SCENE_PATH}`);
                return false;
            }
            this.scene = scene;

            this.app.attachDynamicMesh(scene, this.particleMesh);

            scene.getNodePosition("/Emitter", Ref(this.ui.emitterPosition[0]));

            this.camera = this.app.createThirdPersonCamera();
            this.camera.thirdPersonSetTarget(
                this.ui.emitterPosition[0], this.ui.emitterPosition[1] + 2.0, this.ui.emitterPosition[2]);
            this.camera.thirdPersonSetDistance(6.0);
            this.camera.thirdPersonSetRotation(radians(225.0), radians(20.0));
            this.camera.setMoveSpeed(3.0);

            this.view = this.app.createPlanarView();

            this.viewFloats = Donut_GetPlanarViewConstantsSize() / 4;
            this.constantsSize = (this.viewFloats + GLOBAL_TAIL_FLOATS) * 4;
            for (let i = 0; i < this.viewFloats + GLOBAL_TAIL_FLOATS; i++) {
                this.constants.push(0.0);
            }
            this.constantBuffer = this.app.createVolatileConstantBuffer(this.constantsSize, "GlobalConstants");

            const commandList = this.app.createCommandList();
            commandList.open();

            // The particle mesh has its BLAS already (built every frame); this builds the others.
            this.app.buildSceneBLASes(commandList, scene);
            this.particleIntersectionBLAS = this.app.createUnitAABBBlas(commandList, "ParticleIntersectionBLAS");

            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.waitForIdle();
            this.app.releaseResource(commandList.handle);

            // The scene's instances (including the one of the particle mesh) plus one per particle.
            this.topLevelAS = this.app.createTopLevelAS(scene.getInstanceCount() + MAX_PARTICLES);

            const pass = this.app.addPass();
            pass.setKeyboardCallback(this.onKey);
            pass.setMousePosCallback(this.onMousePos);
            pass.setMouseButtonCallback(this.onMouseButton);
            pass.setMouseScrollCallback(this.onMouseScroll);
            pass.setAnimateCallback(this.onAnimate);
            pass.setBackBufferResizingCallback(this.onBackBufferResizing);
            pass.setRenderCallback(this.onRender);
            return true;
        }
    }

    // The settings window (the sample's UserInterface, an ImGui_Renderer).
    class UserInterface {
        private ui: UIData;

        constructor(ui: UIData) {
            this.ui = ui;
        }

        checkbox(label: string, value: boolean): boolean {
            return Donut_ImGuiCheckbox(label, value ? 1 : 0) != 0;
        }

        buildUI(): void {
            const ui = this.ui;

            Donut_ImGuiSetNextWindowPos(10.0, 10.0);
            Donut_ImGuiBegin("Settings", 1);

            ui.enableAnimations = this.checkbox("Animate particles (Space)", ui.enableAnimations);
            ui.alwaysUpdateOrientation = this.checkbox("Update orientation when paused", ui.alwaysUpdateOrientation);
            Donut_ImGuiSeparator();

            Donut_ImGuiText("Orientation mode:");
            Donut_ImGuiIndent();
            ui.orientationMode = Donut_ImGuiCombo("##orientationMode", ui.orientationMode,
                "Accumulated Vector Transform|Quaternion Rotation|Beam or Vertical Sprite|Basis (RTG2)");
            Donut_ImGuiUnindent();
            Donut_ImGuiSeparator();

            Donut_ImGuiText("Reorient particles:");
            Donut_ImGuiIndent();
            ui.reorientParticlesInPrimaryRays = this.checkbox("In primary rays", ui.reorientParticlesInPrimaryRays);
            ui.reorientParticlesInSecondaryRays = this.checkbox("In secondary rays", ui.reorientParticlesInSecondaryRays);
            Donut_ImGuiUnindent();
            Donut_ImGuiSeparator();

            // MLAB fragment count combo box.
            Donut_ImGuiPushItemWidth(40.0);
            let newFragmentCount = ui.mlabFragments;
            if (Donut_ImGuiBeginCombo("Blending fragments", `${ui.mlabFragments}`) != 0) {
                for (let i = 0; i < 4; i++) {
                    const fragmentCount = g_MlabFragmentCounts[i];
                    if (Donut_ImGuiSelectable(`${fragmentCount}`, newFragmentCount == fragmentCount ? 1 : 0) != 0) {
                        newFragmentCount = fragmentCount;
                    }
                }
                Donut_ImGuiEndCombo();
            }
            Donut_ImGuiPopItemWidth();
            if (newFragmentCount != ui.mlabFragments) {
                ui.mlabFragments = newFragmentCount;
                ui.updatePipeline = true;
            }
            Donut_ImGuiSeparator();

            Donut_ImGuiText("Emitter position:");
            Donut_ImGuiIndent();
            Donut_ImGuiDragFloat3("##emitterPosition", Ref(ui.emitterPosition[0]), 0.01);
            Donut_ImGuiUnindent();

            Donut_ImGuiText("Particle texture:");
            Donut_ImGuiIndent();
            ui.particleTexture = Donut_ImGuiCombo("##particleTexture", ui.particleTexture, "Smoke|Logo");
            Donut_ImGuiUnindent();

            Donut_ImGuiEnd();
        }

        // Declared after buildUI: tslang resolves `this.buildUI` only for members declared earlier.
        init(app: App): boolean {
            return !app.addImGuiPass(this.buildUI).isNull();
        }
    }

    export function main(argc: int, argv: Ref<string>): int {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("rt_particles");

        // -debug: the graphics API's debug layer and NVRHI's validation layer.
        // -noui: without the settings window.
        let options = AppOptions.RayTracing;
        let withUI = true;
        for (let i = 1; i < argc; i++) {
            const arg = Donut_GetArg(argv, i);
            if (arg == "-debug") {
                options = AppOptions.RayTracing | AppOptions.DebugRuntime;
            } else if (arg == "-noui") {
                withUI = false;
            }
        }

        const api = Donut_GetGraphicsAPIFromCommandLine(argc, argv);
        const app = App.createWithOptions(api, WINDOW_TITLE, 1280, 720, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        if (!app.isFeatureSupported(Feature.RayQuery)) {
            console.log("The graphics device does not support Ray Queries");
            app.destroy();
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        const uiData = new UIData();
        const particles = new RayTracedParticlesPass(app, uiData);
        if (!particles.init()) {
            app.destroy();
            return 1;
        }

        // Drawn after (over) the particles, and sees the mouse first.
        const gui = new UserInterface(uiData);
        if (withUI && !gui.init(app)) {
            console.log("Cannot initialize the user interface");
            app.destroy();
            return 1;
        }

        const input = new InputPass(app.handle);

        app.run();
        app.destroy();
        return 0;
    }
}

// tslang starts the program at a global main.
function main(argc: int, argv: Ref<string>): int {
    return RtParticles.main(argc, argv);
}
