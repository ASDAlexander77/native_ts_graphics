// The random numbers the examples use in place of the samples' C++ engines (std::rand,
// std::default_random_engine): a Park-Miller generator from a fixed seed, so every run, and every
// test, draws the same numbers (Math.random doesn't repeat).
//
// Imported with `import { randomFloat } from "../core/random";` (from examples/), and listed in the
// example's add_tslang_example sources.

let seed = 12345.0;

// The next number, in (0, 1).
export function randomFloat() {
    seed = (seed * 16807.0) % 2147483647.0;
    return seed / 2147483647.0;
}

// MSVC's rand() after srand(seed) (the C runtime the samples are built with: srand(1) unless they
// seed it), RAND_MAX 32767, so that what the samples draw from it comes out the same.
export class MsvcRandom {
    private state: number;

    constructor(seed: number) {
        this.state = seed;
    }

    next(): int {
        this.state = (this.state * 214013 + 2531011) % 4294967296;
        return Math.floor(this.state / 65536) % 32768;
    }

    // static_cast<float>(rand()) / RAND_MAX.
    nextFloat() {
        return this.next() / 32767.0;
    }
}
