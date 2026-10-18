
declare function print(...args: any[]) : void;
declare function assert(cond: boolean, msg?: string) : void;
declare type byte = any;
declare type short = any;
declare type ushort = any;
declare type int = any;
declare type uint = any;
declare type index = any;
declare type long = any;
declare type ulong = any;
declare type char = any;
declare type i8 = any;
declare type i16 = any;
declare type i32 = any;
declare type i64 = any;
declare type u8 = any;
declare type u16 = any;
declare type u32 = any;
declare type u64 = any;
declare type s8 = any;
declare type s16 = any;
declare type s32 = any;
declare type s64 = any;
declare type f16 = any;
declare type f32 = any;
declare type f64 = any;
declare type f128 = any;
declare type half = any;
declare type float = any;
declare type double = any;
declare type Opaque = any;

type Ref<T> = T
type Reference<T> = Ref<T> // deprecated alias of Ref

declare function Ref<T>(r: T): Ref<T>;
declare function Deref<T>(r: Ref<T>): T;

// deprecated aliases of Ref / Deref
declare function ReferenceOf<T>(r: T): Ref<T>;
declare function LoadReference<T>(r: Ref<T>): T;

declare function sizeof<T>(v?: T): index;

// tslang's decorators of C++ classes (tslang's docs/cpp-classes.md), declared for the editor
declare function cpp(target: any, context?: any): any;
declare function cppnontrivial(target: any, context?: any): any;
declare function slot(index: number): (target: any, context?: any) => any;
declare function linkname(symbol: string): (target: any, context?: any) => any;

// The C++ library types NVRHI's descs hold (core/nvrhi_classes.<os>.ts, core/nvrhi_abi.<os>.ts):
// tslang lays them out for its target (MSVC's or libc++'s), so the editor takes them loosely.
declare type basic_string_char = any;
declare type vector<T> = any;
