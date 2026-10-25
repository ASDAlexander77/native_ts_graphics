// GLFW's input values (glfw3.h), as the input callbacks pass them: key codes, key and mouse
// button actions, mouse buttons.
//
// Every example compiles it in (TSLANG_CORE_SOURCES): import with
// `import { KEY_W, Action, ... } from "../core/glfw_input";` (from examples/).

// Keys.
export const KEY_SPACE = 32;
export const KEY_MINUS = 45;
export const KEY_0 = 48;
export const KEY_1 = 49;
export const KEY_2 = 50;
export const KEY_3 = 51;
export const KEY_4 = 52;
export const KEY_9 = 57;
export const KEY_EQUAL = 61;
export const KEY_A = 65;
export const KEY_B = 66;
export const KEY_C = 67;
export const KEY_D = 68;
export const KEY_E = 69;
export const KEY_F = 70;
export const KEY_G = 71;
export const KEY_H = 72;
export const KEY_J = 74;
export const KEY_K = 75;
export const KEY_L = 76;
export const KEY_M = 77;
export const KEY_O = 79;
export const KEY_P = 80;
export const KEY_Q = 81;
export const KEY_R = 82;
export const KEY_S = 83;
export const KEY_T = 84;
export const KEY_U = 85;
export const KEY_V = 86;
export const KEY_W = 87;
export const KEY_X = 88;
export const KEY_Y = 89;
export const KEY_Z = 90;
export const KEY_GRAVE_ACCENT = 96;
export const KEY_ESCAPE = 256;
export const KEY_ENTER = 257;
export const KEY_TAB = 258;
export const KEY_RIGHT = 262;
export const KEY_LEFT = 263;
export const KEY_DOWN = 264;
export const KEY_UP = 265;
export const KEY_PAGE_UP = 266;
export const KEY_PAGE_DOWN = 267;
export const KEY_HOME = 268;
export const KEY_END = 269;
export const KEY_F1 = 290;
export const KEY_KP_1 = 321;
export const KEY_KP_2 = 322;
export const KEY_KP_3 = 323;
export const KEY_KP_4 = 324;
export const KEY_KP_6 = 326;
export const KEY_KP_8 = 328;
export const KEY_KP_SUBTRACT = 333;
export const KEY_KP_ADD = 334;
export const KEY_KP_ENTER = 335;
export const KEY_LEFT_SHIFT = 340;
export const KEY_RIGHT_SHIFT = 344;

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
