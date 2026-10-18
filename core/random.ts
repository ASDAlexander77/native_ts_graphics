// The random numbers the examples use in place of the samples' C++ engines (std::rand,
// std::default_random_engine): a Park-Miller generator from a fixed seed, so every run, and every
// test, draws the same numbers. tslang's Math.random isn't usable here.
//
// Imported with `import { randomFloat } from "../core/random";` (from examples/), and listed in the
// example's add_tslang_example sources.

let seed = 12345.0;

// The next number, in (0, 1).
export function randomFloat() {
    seed = (seed * 16807.0) % 2147483647.0;
    return seed / 2147483647.0;
}
