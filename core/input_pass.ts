// The input handling the examples share: Escape closes the window, V toggles vertical sync.
//
// Imported with `import { InputPass } from "../core/input_pass";` (from examples/), which gives the importer its
// declarations only; the code is linked in from its own object (CMake builds it once for all the
// examples) or, under the JIT, comes from input_pass.dll listed in --shared-libs (see run_jit.bat).
// It references donut.ts (the class wrappers, which reference donut_interop.d.ts) for the examples
// that import it, as tslang would load those files twice if they referenced them too.

import { App } from "./donut";

@final
export class InputPass {
    private app: App;

    constructor(app: AppHandle) {
        this.app = new App(app);
        this.app.addPass().setKeyboardCallback(this.onKey);
    }

    onKey(key: Key, scancode: int, action: Action, mods: KeyMods): int {
        if (key == Key.Escape && action == Action.Press) {
            this.app.closeWindow();
            return 1;
        }

        if (key == Key.V && action == Action.Press) {
            this.app.setVsyncEnabled(!this.app.isVsyncEnabled());
            return 1;
        }

        return 0;
    }
}
