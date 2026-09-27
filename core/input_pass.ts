/// <reference path="donut.ts" />

// The input handling the examples share: Escape closes the window, V toggles vertical sync.
//
// Imported with `import { InputPass } from "../core/input_pass";` (from examples/), which gives the importer its
// declarations only; the code is linked in from its own object (CMake builds it once for all the
// examples) or, under the JIT, comes from input_pass.dll listed in --shared-libs (see run_jit.bat).
// It references donut.ts (the class wrappers, which reference donut_interop.d.ts) for the examples
// that import it, as tslang would load those files twice if they referenced them too.

// GLFW values, as passed to the keyboard callback.
const KEY_V = 86;
const KEY_ESCAPE = 256;
const ACTION_PRESS = 1;

export class InputPass {
    private app: App;

    constructor(app: Opaque) {
        this.app = new App(app);
        this.app.addPass().setKeyboardCallback(this.onKey);
    }

    onKey(key: int, scancode: int, action: int, mods: int): int {
        if (key == KEY_ESCAPE && action == ACTION_PRESS) {
            this.app.closeWindow();
            return 1;
        }

        if (key == KEY_V && action == ACTION_PRESS) {
            this.app.setVsyncEnabled(this.app.isVsyncEnabled() != 0 ? 0 : 1);
            return 1;
        }

        return 0;
    }
}
