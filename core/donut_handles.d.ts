// Handle types: one class per kind of C++ object the interop functions (donut_interop.d.ts) take
// or return. Declared, never defined: a handle is the C++ object's pointer, and its class only
// gives it a type of its own, so tslang and tsc reject one kind of handle where another is
// expected. The private brand member, named differently in each class, is what makes two classes
// incompatible; it's an int because tslang can't compile a void member here.
//
// tools/check_interop_types.py maps each C++ type to its class (HANDLES there) and checks every
// declaration in donut_interop.d.ts against its C++ definition.
//
// Handles to nvrhi resources extend ResourceHandle (Donut_ReleaseResource takes any of them);
// handles to objects App::OwnObject keeps extend ObjectHandle (Donut_ReleaseObject).
// Never declare a parameter as a union of two of these: tslang passes a union as a tagged struct,
// not a pointer. Take their base class instead.

declare class AppHandle { private readonly __app: int; }
declare class FrameHandle { private readonly __frame: int; }
declare class PassHandle { private readonly __pass: int; }
declare class AdapterListHandle { private readonly __adapterList: int; }
declare class ResourceHandle { private readonly __resource: int; }
declare class CommandListHandle extends ResourceHandle { private readonly __commandList: int; }
declare class BufferHandle extends ResourceHandle { private readonly __buffer: int; }
declare class TextureHandle extends ResourceHandle { private readonly __texture: int; }
declare class StagingTextureHandle extends ResourceHandle { private readonly __stagingTexture: int; }
declare class SamplerHandle extends ResourceHandle { private readonly __sampler: int; }
declare class HeapHandle extends ResourceHandle { private readonly __heap: int; }
declare class ShaderHandle extends ResourceHandle { private readonly __shader: int; }
declare class ShaderLibraryHandle extends ResourceHandle { private readonly __shaderLibrary: int; }
declare class InputLayoutHandle extends ResourceHandle { private readonly __inputLayout: int; }
declare class InputLayoutDescHandle { private readonly __inputLayoutDesc: int; }
