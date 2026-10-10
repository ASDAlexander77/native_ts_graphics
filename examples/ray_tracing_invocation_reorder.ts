// donut.ts (the class wrappers over donut_interop.d.ts) comes in through input_pass.ts: tslang
// would load it twice if this file referenced it too.
import { InputPass } from "../core/input_pass";

namespace RayTracingInvocationReorder {
    const WINDOW_TITLE = "Donut Example: Ray Tracing Invocation Reorder";

    // The sample's scene and flame texture (Vulkan-Samples' assets, ray_tracing_extended's), the KTX
    // textures converted to DDS at build time (see VULKAN_SAMPLES_ASSETS_DIR in CMakeLists.txt): the
    // glTF's <name>.ktx images are <name>.dds next to it.
    const SCENE_DIR = "media/ray_tracing_extended/sponza/";
    const SCENE_PATH = "media/ray_tracing_extended/sponza/Sponza01.gltf";
    const FLAME_TEXTURE_PATH = "media/ray_tracing_extended/generated_flame.dds";

    // struct Payload: three float4.
    const PAYLOAD_SIZE = 48;

    // struct NewVertex: float3 pos, float3 normal, float2 tex_coord.
    const VERTEX_FLOATS = 8;
    const VERTEX_SIZE = 32;
    // Triangle: three uint32 indices.
    const TRIANGLE_SIZE = 12;

    // enum RenderMode (RENDER_BARYCENTRIC .. RENDER_AO in between).
    const RENDER_DEFAULT = 0;
    const RENDER_AO = 6;

    // enum ObjectType
    const OBJECT_NORMAL = 0;     // has AO and ray traced shadows
    const OBJECT_REFRACTION = 1; // pass-through with IOR
    const OBJECT_FLAME = 2;      // emission surface; constant amplitude

    // struct CameraProperties in shaders/ray_tracing_invocation_reorder.hlsl, as f32 offsets.
    const CONST_VIEW_INVERSE = 0;
    const CONST_PROJ_INVERSE = 16;
    const CONST_RENDER_MODE = 32;        // uint
    const CONST_MAX_RAYS = 33;           // uint
    const CONST_ENABLE_SER = 34;         // int
    const CONST_USE_COHERENCE_HINT = 35; // int
    const CONST_FLOATS = 36;

    // The hit groups, by object type (the instances' hit group offsets).
    const HIT_GROUPS = ["HitGroupNormal", "HitGroupRefraction", "HitGroupFlame"];
    const CLOSEST_HITS = ["closesthit_normal", "closesthit_refraction", "closesthit_flame"];

    // The sample's specialization constant maxRays.
    const MAX_RAYS = 60;
    // The refraction model's vertices per side.
    const GRID_SIZE = 100;
    const FLAME_PARTICLE_COUNT = 512;

    // nvrhi::rt::InstanceFlags::TriangleCullDisable (VK_GEOMETRY_INSTANCE_TRIANGLE_FACING_CULL_DISABLE_BIT_KHR).
    const INSTANCE_FLAGS_CULL_DISABLE = 1;

    // The sample's camera: glm::perspective(60 degrees, aspect, 0.1, 512), depth from 0 to 1.
    const FOV_DEGREES = 60.0;
    const Z_NEAR = 0.1;
    const Z_FAR = 512.0;

    // --- Math ---------------------------------------------------------------------------------

    function radians(degrees: number): number {
        return degrees * Math.PI / 180.0;
    }

    // std::default_random_engine with a uniform distribution over [0, 1) replacement: a Park-Miller
    // generator (tslang's Math.random isn't usable). The sample seeds its engine with the time.
    let g_RandomSeed = 12345.0;
    function generateRandom(): number {
        g_RandomSeed = (g_RandomSeed * 16807.0) % 2147483647.0;
        return g_RandomSeed / 2147483647.0;
    }

    function dot(a: number[], b: number[]): number {
        return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    }

    function cross(a: number[], b: number[]): number[] {
        return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    }

    // glm::normalize: a zero vector gives NaNs, as there.
    function normalize(v: number[]): number[] {
        const inverseLength = 1.0 / Math.sqrt(dot(v, v));
        return [v[0] * inverseLength, v[1] * inverseLength, v[2] * inverseLength];
    }

    // --- Flame particles ----------------------------------------------------------------------

    class FlameParticle {
        position: number[];
        velocity: number[];
        duration: number;

        constructor(position: number[], velocity: number[], duration: number) {
            this.position = position;
            this.velocity = velocity;
            this.duration = duration;
        }
    }

    class FlameParticleGenerator {
        particles: FlameParticle[];
        private origin: number[];
        private direction: number[];
        private u: number[];
        private v: number[];
        private lifetime: number;
        private radius: number;
        private nParticles: int;

        constructor(origin: number[], direction: number[], radius: number, nParticles: int) {
            this.particles = [];
            this.origin = origin;
            this.direction = direction;
            this.radius = radius;
            this.nParticles = nParticles;
            this.lifetime = 5.0;
            this.u = normalize(Math.abs(dot(direction, [0.0, 0.0, 1.0])) > 0.9
                ? cross(direction, [1.0, 0.0, 0.0]) : cross(direction, [0.0, 0.0, 1.0]));
            this.v = normalize(cross(direction, this.u));
        }

        generateRandomDirection(): number[] {
            const a = 0.2 * generateRandom();
            const b = 0.2 * generateRandom();
            const c = 0.8 * generateRandom();
            const u = this.u;
            const v = this.v;
            const d = this.direction;
            return normalize([a * u[0] + b * v[0] + c * d[0], a * u[1] + b * v[1] + c * d[1], a * u[2] + b * v[2] + c * d[2]]);
        }

        generateParticle(lifetime: number): FlameParticle {
            const theta = 2.0 * 3.14159 * generateRandom();
            const R = this.radius * generateRandom();
            const velocityDirection = this.generateRandomDirection();
            const speed = generateRandom() * 0.2;

            const s = Math.sin(theta);
            const c = Math.cos(theta);
            const position: number[] = [];
            const velocity: number[] = [];
            for (let i = 0; i < 3; i++) {
                position.push(this.origin[i] + R * (s * this.u[i] + c * this.v[i]));
                velocity.push(speed * velocityDirection[i]);
            }
            return new FlameParticle(position, velocity, lifetime);
        }

        // The sample's constructor's particles, at random points of their lifetimes.
        init(): void {
            for (let i = 0; i < this.nParticles; i++) {
                const startingLifetime = generateRandom() * this.lifetime;
                this.particles.push(this.generateParticle(startingLifetime));
            }
        }

        updateParticles(timeDelta: number): void {
            const remaining: FlameParticle[] = [];
            for (let i = 0; i < this.particles.length; i++) {
                const particle = this.particles[i];
                if (!(particle.duration > generateRandom() * this.lifetime)) {
                    remaining.push(particle);
                }
            }

            for (let i = 0; i < remaining.length; i++) {
                const particle = remaining[i];
                for (let k = 0; k < 3; k++) {
                    particle.position[k] += timeDelta * particle.velocity[k];
                }
                particle.duration += timeDelta;
            }

            while (remaining.length < this.nParticles) {
                remaining.push(this.generateParticle(0.0));
            }
            this.particles = remaining;
        }
    }

    // --- Scene ----------------------------------------------------------------------------------

    // Geometry in NewVertex layout, before it goes to the static buffers.
    class Model {
        vertices: f32[];
        triangles: int[];
        textureIndex: int;
        objectType: int;

        constructor(vertices: f32[], triangles: int[], textureIndex: int, objectType: int) {
            this.vertices = vertices;
            this.triangles = triangles;
            this.textureIndex = textureIndex;
            this.objectType = objectType;
        }
    }

    // A model's place in the static or dynamic buffers, and its BLAS.
    class ModelBuffer {
        vertexOffset: int; // in bytes
        indexOffset: int;  // in bytes
        numVertices: int;
        numTriangles: int;
        textureIndex: int;
        objectType: int;
        isStatic: boolean;
        blas: TriangleBlas;

        constructor(vertexOffset: int, indexOffset: int, numVertices: int, numTriangles: int, textureIndex: int,
            objectType: int, isStatic: boolean) {
            this.vertexOffset = vertexOffset;
            this.indexOffset = indexOffset;
            this.numVertices = numVertices;
            this.numTriangles = numTriangles;
            this.textureIndex = textureIndex;
            this.objectType = objectType;
            this.isStatic = isStatic;
            this.blas = new TriangleBlas(null);
        }
    }

    // --- Pass -----------------------------------------------------------------------------------

    // Port of Vulkan-Samples' ray_tracing_invocation_reorder: ray_tracing_extended's scene (Sponza
    // with ray traced shadows and ambient occlusion, a refracting sheet whose BLAS is updated every
    // frame, flame particles instanced in a TLAS rebuilt every frame) with a hit group per material,
    // which the instances select (their hit group offsets), and Shader Execution Reordering: the
    // primary rays are traced into hit objects, the threads reordered by them (coherence hints:
    // the instance hit) before their hit shaders run, so that threads running the same shader
    // run together.
    class InvocationReorderPass {
        private app: App;
        private camera: Camera;
        renderMode: int;
        // What the device has (ShaderExecutionReordering), and the sample's settings.
        serSupport: ShaderExecutionReordering;
        serEnabled: boolean;
        coherenceHintEnabled: boolean;

        private bindingLayout: Opaque;
        private bindlessLayout: Opaque;
        private descriptorTable: Opaque;
        private shaderTable: ShaderTable;
        private constantBuffer: BufferHandle;
        private vertexBuffer: BufferHandle;
        private indexBuffer: BufferHandle;
        private dynamicVertexBuffer: BufferHandle;
        private dynamicIndexBuffer: BufferHandle;
        private dataToModelBuffer: BufferHandle;
        private topLevelAS: SceneAccelStructs;
        private models: Model[];
        private modelBuffers: ModelBuffer[];
        private flameGenerator: FlameParticleGenerator;

        // Created on the first frame (the size of the back buffer), dropped on resize.
        private storageImage: Opaque | null;
        private bindingSet: BindingSet;

        // Seconds since the start, for the refraction model's waves.
        private time: number;
        private refractionModel: f32[];
        private refractionIndices: int[];
        // The CameraProperties contents.
        private constants: f32[];
        // Donut's world-to-view matrix, 16 floats.
        private viewMatrix: f32[];
        // The camera's position in the sample's world, from the view.
        private eye: number[];
        // An instance transform, 12 floats.
        private transform: f32[];

        constructor(app: App) {
            this.app = app;
            this.renderMode = RENDER_DEFAULT;
            this.serSupport = ShaderExecutionReordering.None;
            this.serEnabled = true;
            this.coherenceHintEnabled = true;
            this.models = [];
            this.modelBuffers = [];
            this.storageImage = null;
            this.bindingSet = new BindingSet(null);
            this.time = 0.0;
            this.refractionModel = [];
            this.refractionIndices = [];
            this.constants = [];
            for (let i = 0; i < CONST_FLOATS; i++) {
                this.constants.push(0.0);
            }
            this.viewMatrix = [];
            for (let i = 0; i < 16; i++) {
                this.viewMatrix.push(0.0);
            }
            this.eye = [0.0, 0.0, 0.0];
            this.transform = [];
            for (let i = 0; i < 12; i++) {
                this.transform.push(0.0);
            }
            this.flameGenerator = new FlameParticleGenerator([-0.15, -1.5, -2.3], [0.0, -1.0, 0.0], 0.5, FLAME_PARTICLE_COUNT);
        }

        onKey(key: int, scancode: int, action: int, mods: int): int {
            this.camera.keyboardUpdate(key, scancode, action, mods);
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

        onAnimate(elapsedSeconds: number): void {
            this.camera.animate(elapsedSeconds);
            this.app.setInformativeWindowTitle(WINDOW_TITLE);

            this.time += elapsedSeconds;
            this.flameGenerator.updateParticles(elapsedSeconds);
        }

        onBackBufferResizing(): void {
            const bindingSet = this.bindingSet;
            if (!bindingSet.isNull()) {
                this.app.releaseResource(bindingSet.handle);
                this.bindingSet = new BindingSet(null);
            }
            const storageImage = this.storageImage;
            if (storageImage) {
                this.app.releaseResource(storageImage);
                this.storageImage = null;
            }
        }

        // The refraction model: a GRID_SIZE x GRID_SIZE sheet with waves running along it, its
        // normals averaged from the faces'. As in the sample, its index array has room for
        // 2 x GRID_SIZE^2 triangles but uses 2 x (GRID_SIZE - 1)^2: the rest are (0, 0, 0).
        createDynamicObjectBuffers(time: number): void {
            const model = this.refractionModel;
            const indices = this.refractionIndices;
            if (model.length == 0) {
                for (let i = 0; i < GRID_SIZE * GRID_SIZE * VERTEX_FLOATS; i++) {
                    model.push(0.0);
                }
                for (let i = 0; i < 2 * GRID_SIZE * GRID_SIZE * 3; i++) {
                    indices.push(0);
                }
            }

            for (let i = 0; i < GRID_SIZE; i++) {
                for (let j = 0; j < GRID_SIZE; j++) {
                    const x = i / GRID_SIZE;
                    const y = j / GRID_SIZE;
                    const lateralScale = Math.min(Math.min(Math.min(Math.min(x, 1 - x), y), 1 - y), 0.2) * 5.0;
                    const base = (GRID_SIZE * i + j) * VERTEX_FLOATS;
                    model[base + 0] = y - 0.5;
                    model[base + 1] = 2 * x - 1.0;
                    model[base + 2] = lateralScale * 0.025 * Math.cos(2 * 3.14159 * (4 * x + time / 2));
                    model[base + 3] = 0.0;
                    model[base + 4] = 0.0;
                    model[base + 5] = 0.0;
                    model[base + 6] = x;
                    model[base + 7] = y;

                    if (i + 1 < GRID_SIZE && j + 1 < GRID_SIZE) {
                        const t = 6 * (GRID_SIZE * i + j);
                        indices[t + 0] = i * GRID_SIZE + j;
                        indices[t + 1] = (i + 1) * GRID_SIZE + j;
                        indices[t + 2] = i * GRID_SIZE + j + 1;
                        indices[t + 3] = (i + 1) * GRID_SIZE + j;
                        indices[t + 4] = (i + 1) * GRID_SIZE + j + 1;
                        indices[t + 5] = i * GRID_SIZE + j + 1;
                    }
                }
            }

            for (let t = 0; t < indices.length; t += 3) {
                const a = indices[t] * VERTEX_FLOATS;
                const b = indices[t + 1] * VERTEX_FLOATS;
                const c = indices[t + 2] * VERTEX_FLOATS;
                const normal = normalize(cross(
                    [model[b] - model[a], model[b + 1] - model[a + 1], model[b + 2] - model[a + 2]],
                    [model[c] - model[a], model[c + 1] - model[a + 1], model[c + 2] - model[a + 2]]));
                for (let k = 0; k < 3; k++) {
                    const v = indices[t + k] * VERTEX_FLOATS;
                    model[v + 3] += normal[0];
                    model[v + 4] += normal[1];
                    model[v + 5] += normal[2];
                }
            }

            for (let v = 0; v < GRID_SIZE * GRID_SIZE * VERTEX_FLOATS; v += VERTEX_FLOATS) {
                const normal = normalize([model[v + 3], model[v + 4], model[v + 5]]);
                model[v + 3] = normal[0];
                model[v + 4] = normal[1];
                model[v + 5] = normal[2];
            }
        }

        // The sample's calculate_rotation into this.transform: a billboard at pt facing the camera,
        // turned only around y if freezeY.
        calculateRotation(pt: number[], scale: number, freezeY: boolean): void {
            let normal = normalize([pt[0] - this.eye[0], pt[1] - this.eye[1], pt[2] - this.eye[2]]);
            if (freezeY) {
                normal = normalize(Math.abs(normal[1]) > 0.99 ? [0.0, 0.0, 1.0] : [normal[0], 0.0, normal[2]]);
            }
            const u = normalize(cross(normal, [0.0, 1.0, 0.0]));
            const v = normalize(cross(normal, u));

            // wait to multiply by scale until after calculating basis to prevent floating point problems
            for (let row = 0; row < 3; row++) {
                this.transform[row * 4 + 0] = u[row] * scale;
                this.transform[row * 4 + 1] = v[row] * scale;
                this.transform[row * 4 + 2] = normal[row] * scale;
                this.transform[row * 4 + 3] = pt[row];
            }
        }

        // The sample's create_top_level_acceleration_structure: Sponza and the refraction model,
        // then a billboard instance per flame particle.
        createTopLevelAccelerationStructure(frame: Frame): void {
            const tlas = this.topLevelAS;
            let flameIndex = -1;
            for (let i = 0; i < this.modelBuffers.length; i++) {
                const modelBuffer = this.modelBuffers[i];
                // these objects have a single instance with the identity transform
                if (modelBuffer.objectType == OBJECT_NORMAL) {
                    for (let k = 0; k < 12; k++) {
                        this.transform[k] = k % 5 == 0 ? 1.0 : 0.0;
                    }
                } else if (modelBuffer.objectType == OBJECT_REFRACTION) {
                    this.calculateRotation([-0.25, -2.5, -2.35], 1.0, true);
                } else {
                    // handle flame separately
                    flameIndex = i;
                    continue;
                }
                // Use object_type to select the appropriate hit group shader
                // This creates shader divergence that SER can optimize by reordering threads
                tlas.addInstanceWithHitGroup(modelBuffer.blas.getAccelStruct(), 0xFF, i, modelBuffer.objectType,
                    INSTANCE_FLAGS_CULL_DISABLE, Ref(this.transform[0]));
            }

            // find the flame particle object, then add the particles as instances
            const flame = this.modelBuffers[flameIndex];
            const particles = this.flameGenerator.particles;
            for (let i = 0; i < particles.length; i++) {
                this.calculateRotation(particles[i].position, 0.25, true);
                tlas.addInstanceWithHitGroup(flame.blas.getAccelStruct(), 0xFF, flameIndex, OBJECT_FLAME,
                    INSTANCE_FLAGS_CULL_DISABLE, Ref(this.transform[0]));
            }

            frame.buildTopLevelAS(tlas);
        }

        // The sample's update_uniform_buffers: inverse view and projection matrices.
        updateUniformBuffers(width: int, height: int): void {
            this.camera.getWorldToView(Ref(this.viewMatrix[0]));

            // The sample's world has -y up on the screen. Mirrored in y it is Donut's world, y up,
            // with the same picture: Donut's world is right-handed, its view space left-handed. So
            // the sample's view matrix is the y mirror, then Donut's view, then Donut's view space
            // to the sample's (y down, -z forward): rows and columns of Donut's negated.
            const view: number[] = [];
            for (let i = 0; i < 16; i++) {
                const row = Math.floor(i / 4);
                const column = i % 4;
                const mirrored = row == 1 ? -this.viewMatrix[i] : this.viewMatrix[i];
                view.push(column == 1 || column == 2 ? -mirrored : mirrored);
            }

            // inverse(view): a rotation and a translation, so the rotation transposed and the
            // translation turned back. Its last row is the camera's position.
            const c = this.constants;
            for (let row = 0; row < 3; row++) {
                for (let column = 0; column < 3; column++) {
                    c[CONST_VIEW_INVERSE + row * 4 + column] = view[column * 4 + row];
                }
                c[CONST_VIEW_INVERSE + row * 4 + 3] = 0.0;
            }
            for (let column = 0; column < 3; column++) {
                let t = 0.0;
                for (let k = 0; k < 3; k++) {
                    t -= view[12 + k] * view[column * 4 + k];
                }
                c[CONST_VIEW_INVERSE + 12 + column] = t;
                this.eye[column] = t;
            }
            c[CONST_VIEW_INVERSE + 15] = 1.0;

            // inverse(glm::perspective(fov, aspect, near, far)) for row vectors.
            const tanHalfFovy = Math.tan(0.5 * radians(FOV_DEGREES));
            const aspect = width / height;
            const p22 = Z_FAR / (Z_NEAR - Z_FAR);
            const p32 = -(Z_FAR * Z_NEAR) / (Z_FAR - Z_NEAR);
            const projInverse = [
                aspect * tanHalfFovy, 0.0,         0.0,  0.0,
                0.0,                  tanHalfFovy, 0.0,  0.0,
                0.0,                  0.0,         0.0,  1.0 / p32,
                0.0,                  0.0,         -1.0, p22 / p32,
            ];
            for (let i = 0; i < 16; i++) {
                c[CONST_PROJ_INVERSE + i] = projInverse[i];
            }

            Donut_StoreInt32(Ref(c[CONST_RENDER_MODE]), this.renderMode);
            Donut_StoreInt32(Ref(c[CONST_MAX_RAYS]), MAX_RAYS);
            // SER only with the library that has it (see createRayTracingPipeline).
            const ser = this.serEnabled && this.serSupport != ShaderExecutionReordering.None;
            Donut_StoreInt32(Ref(c[CONST_ENABLE_SER]), ser ? 1 : 0);
            Donut_StoreInt32(Ref(c[CONST_USE_COHERENCE_HINT]), this.coherenceHintEnabled ? 1 : 0);
        }

        onRender(frameHandle: FrameHandle): void {
            const frame = new Frame(frameHandle);
            const width = frame.getWidth();
            const height = frame.getHeight();
            const commandList = frame.getCommandList();

            let storageImage = this.storageImage;
            let bindingSet = this.bindingSet;
            if (!storageImage || bindingSet.isNull()) {
                // Set up a storage image that the ray generation shader will be writing to: UNORM, in the
                // back buffer's channel order, for the copy below.
                storageImage = this.app.createUAVTextureForFrameCopy(frame, "StorageImage");

                const bindingSetDesc = BindingSetDesc.create();
                bindingSetDesc.bindEntireConstantBuffer(0, this.constantBuffer);
                bindingSetDesc.bindAccelStruct(0, this.topLevelAS.getTopLevelAS());
                bindingSetDesc.bindStructuredBufferSRV(1, this.vertexBuffer);
                bindingSetDesc.bindStructuredBufferSRV(2, this.indexBuffer);
                bindingSetDesc.bindStructuredBufferSRV(3, this.dataToModelBuffer);
                bindingSetDesc.bindStructuredBufferSRV(4, this.dynamicVertexBuffer);
                bindingSetDesc.bindStructuredBufferSRV(5, this.dynamicIndexBuffer);
                bindingSetDesc.bindSampler(0, this.app.getCommonSampler(CommonSampler.LinearWrap));
                bindingSetDesc.bindTextureUAV(0, storageImage);
                bindingSet = this.app.createBindingSetForLayout(bindingSetDesc, this.bindingLayout);

                this.storageImage = storageImage;
                this.bindingSet = bindingSet;
            }

            this.updateUniformBuffers(width, height);
            commandList.writeBuffer(this.constantBuffer, Ref(this.constants[0]), CONST_FLOATS * 4);

            // The refraction model's new vertices, and its BLAS updated for them.
            this.createDynamicObjectBuffers(this.time);
            commandList.writeBuffer(this.dynamicVertexBuffer, Ref(this.refractionModel[0]),
                GRID_SIZE * GRID_SIZE * VERTEX_SIZE);
            for (let i = 0; i < this.modelBuffers.length; i++) {
                const modelBuffer = this.modelBuffers[i];
                if (!modelBuffer.isStatic) {
                    modelBuffer.blas.update(commandList);
                }
            }
            this.createTopLevelAccelerationStructure(frame);

            /*
                Dispatch the ray tracing commands
            */
            frame.dispatchRaysWithDescriptorTable(this.shaderTable, bindingSet, this.descriptorTable, width, height);

            /*
                Copy ray tracing output to swap chain image
            */
            // Without conversion, as the sample's vkCmdCopyImage: the UNORM values become the sRGB
            // back buffer's encoded ones.
            frame.copyTextureToFrame(storageImage);
        }

        // The sample's RaytracingScene: every Sponza submesh, its positions scaled to meters and
        // its axes turned (the vase moved too), with its base color texture.
        loadScene(descriptorTableManager: DescriptorTableManager): boolean {
            const scene = this.app.loadGltfModel(SCENE_PATH);
            if (scene.isNull()) {
                return false;
            }

            const sponzaScale = 0.01;
            for (let p = 0; p < scene.getPrimitiveCount(); p++) {
                const image = scene.getBaseColorImage(p);
                if (!image.endsWith(".ktx")) {
                    console.log(`Unexpected base color image ${image} in ${SCENE_PATH}`);
                    return false;
                }
                const texture = this.app.loadBindlessTexture(descriptorTableManager,
                    SCENE_DIR + image.substring(0, image.length - 4) + ".dds", 1);
                if (texture.isNull()) {
                    return false;
                }
                const isVase = image.indexOf("vase_dif.ktx") >= 0;

                const vertexCount = scene.getVertexCount(p);
                const indexCount = scene.getIndexCount(p);
                let vertices: f32[] = [];
                for (let i = 0; i < vertexCount * VERTEX_FLOATS; i++) {
                    vertices.push(0.0);
                }
                let triangles: int[] = [];
                for (let i = 0; i < indexCount; i++) {
                    triangles.push(0);
                }
                scene.copyVertices(p, Ref(vertices[0]));
                scene.copyIndices(p, Ref(triangles[0]));

                // pt = vec3(mat4(transform) * vec4(pt, 1)) + translation, with the sample's
                // column-major transform (0, 0, s, tx | s, 0, 0, 0 | 0, s, 0, tz): (s y + tx, s z, s x + tz),
                // where the vase's translation is (4.3, 0, 9.5) and the rest's 0.
                const tx = isVase ? 4.3 : 0.0;
                const tz = isVase ? 9.5 : 0.0;
                for (let v = 0; v < vertexCount * VERTEX_FLOATS; v += VERTEX_FLOATS) {
                    const x = vertices[v];
                    const y = vertices[v + 1];
                    const z = vertices[v + 2];
                    vertices[v] = sponzaScale * y + tx;
                    vertices[v + 1] = sponzaScale * z;
                    vertices[v + 2] = sponzaScale * x + tz;
                }

                this.models.push(new Model(vertices, triangles, texture.getDescriptorIndex(), OBJECT_NORMAL));
            }
            return true;
        }

        // The sample's create_flame_model: a unit square billboard with the flame texture.
        createFlameModel(descriptorTableManager: DescriptorTableManager): boolean {
            const texture = this.app.loadBindlessTexture(descriptorTableManager, FLAME_TEXTURE_PATH, 1);
            if (texture.isNull()) {
                return false;
            }

            const pts = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [1.0, 1.0, 0.0], [0.0, 1.0, 0.0]];
            let vertices: f32[] = [];
            for (let i = 0; i < pts.length; i++) {
                const pt = pts[i];
                // center the point
                vertices.push(pt[0] - 0.5);
                vertices.push(pt[1] - 0.5);
                vertices.push(pt[2]);
                vertices.push(0.0);
                vertices.push(0.0);
                vertices.push(1.0);
                vertices.push(pt[0]);
                vertices.push(1.0 - pt[1]);
            }
            let triangles: int[] = [0, 1, 2, 0, 2, 3];
            this.models.push(new Model(vertices, triangles, texture.getDescriptorIndex(), OBJECT_FLAME));

            this.flameGenerator.init();
            return true;
        }

        // The sample's create_static_object_buffers, create_dynamic_object_buffers(0) and
        // create_bottom_level_acceleration_structure, recorded into an open command list: the
        // models' vertices and triangles in one vertex and one index buffer, the refraction model
        // in its own pair, a BLAS for each.
        createBuffersAndBlases(commandList: CommandList): void {
            let staticVertices: f32[] = [];
            let staticTriangles: int[] = [];
            for (let i = 0; i < this.models.length; i++) {
                const model = this.models[i];
                const modelBuffer = new ModelBuffer(staticVertices.length / VERTEX_FLOATS * VERTEX_SIZE,
                    staticTriangles.length / 3 * TRIANGLE_SIZE, model.vertices.length / VERTEX_FLOATS,
                    model.triangles.length / 3, model.textureIndex, model.objectType, true);
                this.modelBuffers.push(modelBuffer);
                for (let k = 0; k < model.vertices.length; k++) {
                    staticVertices.push(model.vertices[k]);
                }
                for (let k = 0; k < model.triangles.length; k++) {
                    staticTriangles.push(model.triangles[k]);
                }
            }

            const vertexCount = staticVertices.length / VERTEX_FLOATS;
            const triangleCount = staticTriangles.length / 3;
            this.vertexBuffer = this.app.createAccelStructInputStructuredBuffer(16, vertexCount * 2, "Vertices");
            this.indexBuffer = this.app.createAccelStructInputStructuredBuffer(4, triangleCount * 3, "Indices");
            commandList.writeBuffer(this.vertexBuffer, Ref(staticVertices[0]), vertexCount * VERTEX_SIZE);
            commandList.writeBuffer(this.indexBuffer, Ref(staticTriangles[0]), triangleCount * TRIANGLE_SIZE);

            // The refraction model's buffers, rewritten every frame (its indices don't change).
            this.createDynamicObjectBuffers(0.0);
            const gridVertices = GRID_SIZE * GRID_SIZE;
            const gridTriangles = 2 * GRID_SIZE * GRID_SIZE;
            this.dynamicVertexBuffer = this.app.createAccelStructInputStructuredBuffer(16, gridVertices * 2, "Dynamic Vertices");
            this.dynamicIndexBuffer = this.app.createAccelStructInputStructuredBuffer(4, gridTriangles * 3, "Dynamic Indices");
            commandList.writeBuffer(this.dynamicVertexBuffer, Ref(this.refractionModel[0]), gridVertices * VERTEX_SIZE);
            commandList.writeBuffer(this.dynamicIndexBuffer, Ref(this.refractionIndices[0]), gridTriangles * TRIANGLE_SIZE);
            this.modelBuffers.push(new ModelBuffer(0, 0, gridVertices, gridTriangles, -1, OBJECT_REFRACTION, false));

            // Static objects prefer fast tracing; the refraction model fast builds and updates.
            for (let i = 0; i < this.modelBuffers.length; i++) {
                const modelBuffer = this.modelBuffers[i];
                modelBuffer.blas = this.app.createTriangleBlas(commandList,
                    modelBuffer.isStatic ? this.indexBuffer : this.dynamicIndexBuffer, modelBuffer.indexOffset,
                    modelBuffer.numTriangles * 3,
                    modelBuffer.isStatic ? this.vertexBuffer : this.dynamicVertexBuffer, modelBuffer.vertexOffset,
                    modelBuffer.numVertices, VERTEX_SIZE, modelBuffer.isStatic ? 0 : 1, `BLAS ${i}`);
            }

            // This buffer is used to correlate the instance information with model information:
            // struct SceneInstanceData { vertex_index, indices_index, image_index, object_type }.
            let modelInstanceData: int[] = [];
            for (let i = 0; i < this.modelBuffers.length; i++) {
                const modelBuffer = this.modelBuffers[i];
                modelInstanceData.push(modelBuffer.vertexOffset / VERTEX_SIZE);
                modelInstanceData.push(modelBuffer.indexOffset / TRIANGLE_SIZE);
                modelInstanceData.push(modelBuffer.textureIndex);
                modelInstanceData.push(modelBuffer.objectType);
            }
            this.dataToModelBuffer = this.app.createStructuredBuffer(4, modelInstanceData.length, "Data To Model");
            commandList.writeBuffer(this.dataToModelBuffer, Ref(modelInstanceData[0]), modelInstanceData.length * 4);
        }

        // The ray generation and miss shaders, and a hit group per object type (in the shader table
        // in that order). The library with hit objects (shader model 6.9 on D3D12, the NV extension
        // on Vulkan) where the device has them.
        createRayTracingPipeline(): boolean {
            const ser = this.serSupport != ShaderExecutionReordering.None;
            const shaderLibrary = this.app.createShaderLibraryWithDefine("ray_tracing_invocation_reorder.hlsl", "SER", ser ? "1" : "0");
            if (!shaderLibrary) {
                return false;
            }

            const pipelineDesc = RtPipelineDesc.create(PAYLOAD_SIZE, 1);
            pipelineDesc.addGlobalBindingLayout(this.bindingLayout);
            pipelineDesc.addGlobalBindingLayout(this.bindlessLayout);
            pipelineDesc.addShader(shaderLibrary, "raygen", ShaderType.RayGeneration);
            pipelineDesc.addShader(shaderLibrary, "miss", ShaderType.Miss);
            // Ray closest hit groups - one per object type for SER demonstration
            // SER benefits from shader divergence - different shaders for different materials
            for (let i = 0; i < HIT_GROUPS.length; i++) {
                pipelineDesc.addHitGroup(shaderLibrary, HIT_GROUPS[i], CLOSEST_HITS[i], "", null);
            }
            const pipeline = this.app.createRayTracingPipelineFromDesc(pipelineDesc);
            if (!pipeline) {
                return false;
            }

            const shaderTable = this.app.createEmptyShaderTable(pipeline);
            // The shader table keeps the pipeline alive.
            this.app.releaseResource(pipeline);
            shaderTable.setRayGeneration("raygen");
            shaderTable.addMiss("miss");
            for (let i = 0; i < HIT_GROUPS.length; i++) {
                shaderTable.addHitGroup(HIT_GROUPS[i], null);
            }
            this.shaderTable = shaderTable;
            return true;
        }

        // Declared after the callbacks: tslang resolves `this.onX` only for members declared earlier.
        init(): boolean {
            this.serSupport = this.app.getShaderExecutionReordering();
            // The scene's textures, as an array indexed by their descriptor indices.
            const bindlessLayoutDesc = BindlessLayoutDesc.create(0, 1024, ShaderType.All);
            bindlessLayoutDesc.addTextures(1);
            this.bindlessLayout = this.app.createBindlessLayout(bindlessLayoutDesc);

            const layoutDesc = BindingLayoutDesc.create();
            layoutDesc.layoutVolatileConstantBuffer(0);
            layoutDesc.layoutAccelStruct(0);
            layoutDesc.layoutStructuredBufferSRV(1);
            layoutDesc.layoutStructuredBufferSRV(2);
            layoutDesc.layoutStructuredBufferSRV(3);
            layoutDesc.layoutStructuredBufferSRV(4);
            layoutDesc.layoutStructuredBufferSRV(5);
            layoutDesc.layoutSampler(0);
            layoutDesc.layoutTextureUAV(0);
            this.bindingLayout = this.app.createBindingLayout(layoutDesc, ShaderType.All);

            const descriptorTableManager = this.app.createDescriptorTableManager(this.bindlessLayout);
            this.descriptorTable = descriptorTableManager.getDescriptorTable();

            // The textures load on command lists of their own: before ours is open.
            if (!this.loadScene(descriptorTableManager) || !this.createFlameModel(descriptorTableManager)) {
                console.log("Cannot load the scene and its textures: set VULKAN_SAMPLES_ASSETS_DIR when configuring");
                return false;
            }

            if (!this.createRayTracingPipeline()) {
                return false;
            }

            const commandList = this.app.createCommandList();
            commandList.open();
            this.createBuffersAndBlases(commandList);
            commandList.close();
            this.app.executeCommandList(commandList);
            this.app.waitForIdle();
            this.app.releaseResource(commandList.handle);

            // Every model but the flame once, and each flame particle.
            this.topLevelAS = this.app.createTopLevelAS(this.modelBuffers.length - 1 + FLAME_PARTICLE_COUNT);

            this.constantBuffer = this.app.createVolatileConstantBuffer(CONST_FLOATS * 4, "CameraProperties");

            // The sample's first person camera at (0, 1.5, 0), not turned: at (0, -1.5, 0) looking
            // down -z in its world, (0, 1.5, 0) in Donut's (see updateUniformBuffers). One degree
            // per pixel of mouse movement and one unit per second, as its camera.
            this.camera = this.app.createFirstPersonCamera();
            this.camera.lookAt(0.0, 1.5, 0.0, 0.0, 1.5, -1.0);
            this.camera.setMoveSpeed(1.0);
            this.camera.setRotateSpeed(radians(1.0));

            const pass = this.app.addPass();
            pass.setKeyboardCallback(this.onKey);
            pass.setMousePosCallback(this.onMousePos);
            pass.setMouseButtonCallback(this.onMouseButton);
            pass.setAnimateCallback(this.onAnimate);
            pass.setBackBufferResizingCallback(this.onBackBufferResizing);
            pass.setRenderCallback(this.onRender);
            return true;
        }
    }

    // The sample's overlay: SER's settings, where the device reorders (the sample shows them if
    // the device says it reorders; D3D12 doesn't say, so there with hit objects).
    class UserInterface {
        private sample: InvocationReorderPass;

        constructor(sample: InvocationReorderPass) {
            this.sample = sample;
        }

        buildUI(): void {
            const sample = this.sample;
            Donut_ImGuiSetNextWindowPos(10.0, 10.0);
            // The sample's title (ApiVulkanSample's default).
            Donut_ImGuiBegin("Vulkan Example", 1);
            if (sample.serSupport != ShaderExecutionReordering.None) {
                sample.serEnabled = Donut_ImGuiCheckbox("Enable Shader Execution Reordering (SER)", sample.serEnabled ? 1 : 0) != 0;
                sample.coherenceHintEnabled = Donut_ImGuiCheckbox("Enable Coherence Hint", sample.coherenceHintEnabled ? 1 : 0) != 0;
            } else {
                Donut_ImGuiText("Shader Execution Reordering is not supported");
            }
            Donut_ImGuiEnd();
        }

        // Declared after buildUI: tslang resolves `this.buildUI` only for members declared earlier.
        init(app: App): boolean {
            return !app.addImGuiPass(this.buildUI).isNull();
        }
    }

    export function main(argc: int, argv: Ref<string>): int {
        // Under the JIT the shaders can't be found from the executable's name (see Donut_SetAppName).
        Donut_SetAppName("ray_tracing_invocation_reorder");

        // -debug: the graphics API's debug layer and NVRHI's validation layer.
        // -mode <0..6>: the sample's render mode (its specialization constant): 0 default,
        // 1 barycentric, 2 instance ID, 3 distance, 4 global XYZ, 5 shadow map, 6 ambient occlusion
        // (as in the sample, 5 and 6 show the hit's texture: its ray generation shader stops before
        // their shadow and AO output).
        // -noser, -nohint: SER, its coherence hint off at start.
        // -noui: without the settings window.
        let options = AppOptions.RayTracing;
        let renderMode = RENDER_DEFAULT;
        let ser = true;
        let hint = true;
        let withUI = true;
        for (let i = 1; i < argc; i++) {
            const arg = Donut_GetArg(argv, i);
            if (arg == "-debug") {
                options = options | AppOptions.DebugRuntime;
            } else if (arg == "-noser") {
                ser = false;
            } else if (arg == "-nohint") {
                hint = false;
            } else if (arg == "-noui") {
                withUI = false;
            } else if (arg == "-mode" && i + 1 < argc) {
                i++;
                renderMode = Math.min(Math.max(parseInt(Donut_GetArg(argv, i)), RENDER_DEFAULT), RENDER_AO);
            }
        }

        const api = Donut_GetGraphicsAPIFromCommandLine(argc, argv);
        const app = App.createWithOptions(api, WINDOW_TITLE, 1280, 720, options);
        if (app.isNull()) {
            console.log("Cannot initialize a graphics device with the requested parameters");
            return 1;
        }

        if (!app.isFeatureSupported(Feature.RayTracingPipeline)) {
            console.log("The graphics device does not support Ray Tracing Pipelines");
            app.destroy();
            return 1;
        }

        console.log(`Renderer: ${app.getRendererString()}`);

        const rayTracing = new InvocationReorderPass(app);
        rayTracing.renderMode = renderMode;
        rayTracing.serEnabled = ser;
        rayTracing.coherenceHintEnabled = hint;
        if (!rayTracing.init()) {
            app.destroy();
            return 1;
        }
        if (rayTracing.serSupport == ShaderExecutionReordering.None) {
            console.log("Shader Execution Reordering isn't supported (D3D12 shader model 6.9 and raytracing tier 1.2, or Vulkan's VK_NV_ray_tracing_invocation_reorder): tracing without it");
        }

        // Drawn after (over) the scene, and sees the mouse first.
        const gui = new UserInterface(rayTracing);
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
    return RayTracingInvocationReorder.main(argc, argv);
}
