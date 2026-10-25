// GLFW's input values (glfw3.h), as the input callbacks pass them: key codes, key and mouse
// button actions, mouse buttons.
//
// Every example compiles it in (TSLANG_CORE_SOURCES): import with
// `import { Key, Action, ... } from "../core/glfw_input";` (from examples/).

// Keys.
export enum Key {
    Space = 32,
    Minus = 45,
    Num0 = 48,
    Num1 = 49,
    Num2 = 50,
    Num3 = 51,
    Num4 = 52,
    Num9 = 57,
    Equal = 61,
    A = 65,
    B = 66,
    C = 67,
    D = 68,
    E = 69,
    F = 70,
    G = 71,
    H = 72,
    J = 74,
    K = 75,
    L = 76,
    M = 77,
    O = 79,
    P = 80,
    Q = 81,
    R = 82,
    S = 83,
    T = 84,
    U = 85,
    V = 86,
    W = 87,
    X = 88,
    Y = 89,
    Z = 90,
    GraveAccent = 96,
    Escape = 256,
    Enter = 257,
    Tab = 258,
    Right = 262,
    Left = 263,
    Down = 264,
    Up = 265,
    PageUp = 266,
    PageDown = 267,
    Home = 268,
    End = 269,
    F1 = 290,
    Kp1 = 321,
    Kp2 = 322,
    Kp3 = 323,
    Kp4 = 324,
    Kp6 = 326,
    Kp8 = 328,
    KpSubtract = 333,
    KpAdd = 334,
    KpEnter = 335,
    LeftShift = 340,
    RightShift = 344
}


// Actions.
export enum Action {
    Release = 0,
    Press = 1,
    Repeat = 2
}

// Mouse buttons.
export enum MouseButton {
    Left = 0,
    Right = 1,
    Middle = 2
}
