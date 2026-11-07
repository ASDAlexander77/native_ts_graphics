/// <reference path="../donut_handles.d.ts" />
// Math and random numbers

// A C++ std::default_random_engine (std::mt19937 with MSVC's library), for data that samples make
// with one: the same seed gives the same numbers; a negative seed takes one from std::random_device
// (different every run).
@nodrops declare function Donut_CreateRandomEngine(app: AppHandle, seed: int): RandomEngineHandle;
// Same, seeded with all 32 bits of seedBits (as unsigned; a negative one is no random seed here).
@nodrops declare function Donut_CreateRandomEngineFromBits(app: AppHandle, seedBits: int): RandomEngineHandle;
// The C runtime's sinf, cosf and tanf of (float)x: not correctly rounded (Math.fround(Math.sin(x)) can
// differ in the last bits), for ports of samples whose geometry depends on them to the last bit.
@nodrops declare function Donut_Sinf(x: number): number;
@nodrops declare function Donut_Cosf(x: number): number;
@nodrops declare function Donut_Tanf(x: number): number;
// The C runtime's log2f and exp2f of (float)x (MiniEngine's ExpVar settings go through both).
@nodrops declare function Donut_Log2f(x: number): number;
@nodrops declare function Donut_Exp2f(x: number): number;
// MSVC's /fp:fast sinf and cosf of (float)x into dst[0] and dst[1] (core/msvc_fast_math.cpp, linked only
// into the examples that list it): its cosine can differ from cosf's in the last bits.
@nodrops declare function Donut_FastSinCosf(x: number, dst: Ref<f32>): void;
// The CPU's approximate reciprocal of (float)x (SSE's rcpss; 1 / x without SSE): MSVC's /fp:fast divides
// by it and a Newton-Raphson step (core/msvc_fast_math.cpp).
@nodrops declare function Donut_ApproxRcpf(x: number): number;
// The engine's next number from std::uniform_real_distribution<float>(a, b).
@nodrops declare function Donut_RandomUniformFloat(randomEngine: RandomEngineHandle, a: number, b: number): number;
// The engine's next number from std::uniform_int_distribution<int>(a, b).
@nodrops declare function Donut_RandomUniformInt(randomEngine: RandomEngineHandle, a: int, b: int): int;
// The engine's next number from std::uniform_int_distribution<unsigned>(a, b): the bounds and the
// result as unsigned bits in ints (a = 0, b = -1 for the whole range).
@nodrops declare function Donut_RandomUniformUInt(randomEngine: RandomEngineHandle, a: int, b: int): int;
// count numbers from one std::normal_distribution<float>(mean, stddev) over the engine, into dst
// (Ref of a `let` f32 array element): one distribution object, as the samples keep one (MSVC's makes
// values in pairs and keeps the second).
@nodrops declare function Donut_RandomNormalFloats(randomEngine: RandomEngineHandle, mean: number, stddev: number, count: int, dst: Ref<f32>): void;
