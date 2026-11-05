// A simulation's clock in fixed steps: each frame, the steps its time covers (the rest carried to the
// next frame), whatever the frame rate. After a long frame it falls behind rather than taking ever
// more steps: past maxSteps, the time left over is dropped.
//
// Imported with `import { FixedStep } from "../core/fixed_step";` (add_tslang_nri_example adds it
// to the app's sources).

@final
export class FixedStep {
    // Time not stepped through yet (under a step).
    private pending: number = 0.0;

    // The steps of step seconds frameTime seconds more cover, at most maxSteps.
    advance(frameTime: number, step: number, maxSteps: int): int {
        this.pending += frameTime;
        let steps = Math.floor(this.pending / step);
        if (steps > maxSteps) {
            steps = maxSteps;
            this.pending = 0.0;
        } else {
            this.pending -= steps * step;
        }
        return steps;
    }

    // The time carried over dropped.
    reset() {
        this.pending = 0.0;
    }
}
