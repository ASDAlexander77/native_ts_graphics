// What the two ports of Vulkan-Samples' ray_tracing_extended scene (ray_tracing_extended,
// ray_tracing_invocation_reorder) share: the sample's flame particles and its model types.
//
// Imported with `import { FlameParticleGenerator, ... } from "../core/ray_tracing_extended_scene";`
// (from examples/), and listed with core/matrix.ts and core/random.ts in the example's
// add_tslang_example sources.

import { TriangleBlas } from "./donut";
import { cross3, dot3 } from "./matrix";
import { randomFloat } from "./random";

// glm::normalize: a zero vector gives NaNs, as there.
export function normalize(v: number[]) {
    const inverseLength = 1.0 / Math.sqrt(dot3(v, v));
    return [v[0] * inverseLength, v[1] * inverseLength, v[2] * inverseLength];
}

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

@final
export class FlameParticleGenerator {
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
        this.u = normalize(Math.abs(dot3(direction, [0.0, 0.0, 1.0])) > 0.9
            ? cross3(direction, [1.0, 0.0, 0.0]) : cross3(direction, [0.0, 0.0, 1.0]));
        this.v = normalize(cross3(direction, this.u));
    }

    generateRandomDirection() {
        const a = 0.2 * randomFloat();
        const b = 0.2 * randomFloat();
        const c = 0.8 * randomFloat();
        const u = this.u;
        const v = this.v;
        const d = this.direction;
        return normalize([a * u[0] + b * v[0] + c * d[0], a * u[1] + b * v[1] + c * d[1], a * u[2] + b * v[2] + c * d[2]]);
    }

    generateParticle(lifetime: number) {
        const theta = 2.0 * 3.14159 * randomFloat();
        const R = this.radius * randomFloat();
        const velocityDirection = this.generateRandomDirection();
        const speed = randomFloat() * 0.2;

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
    init() {
        for (let i = 0; i < this.nParticles; i++) {
            const startingLifetime = randomFloat() * this.lifetime;
            this.particles.push(this.generateParticle(startingLifetime));
        }
    }

    updateParticles(timeDelta: number) {
        const remaining = this.particles.filter((particle) => !(particle.duration > randomFloat() * this.lifetime));

        for (const particle of remaining) {
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

// Geometry in NewVertex layout, before it goes to the static buffers.
@final
export class Model {
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
@final
export class ModelBuffer {
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
