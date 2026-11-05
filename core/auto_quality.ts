// Picking a workload's size from the GPU's time for it: a measurement (ms) averaged over a window of
// frames (from firstFrame, once things have settled, up to lastFrame), then the size scaled down
// when the mean is over a budget. The size chosen is the app's to keep (an IntFile, say), so the
// measuring happens once.
//
// Imported with `import { AutoQuality } from "../core/auto_quality";` (add_tslang_nri_example
// adds it to the app's sources). start(), then sample() each frame until it says the window's
// over; mean() is the average then, AutoQuality.fit the size for a budget.

@final
export class AutoQuality {
    private active: boolean = false;
    private firstFrame: int = 0;
    private lastFrame: int = 0;
    private sum: number = 0.0;
    private count: int = 0;

    // Measuring frames firstFrame .. lastFrame (lastFrame's sample ends it).
    start(firstFrame: int, lastFrame: int) {
        this.active = true;
        this.firstFrame = firstFrame;
        this.lastFrame = lastFrame;
        this.sum = 0.0;
        this.count = 0;
    }

    measuring(): boolean {
        return this.active;
    }

    // Frame frameIndex's measurement (counted from firstFrame, when it's above 0: none taken that
    // frame otherwise). True once lastFrame's reached: measuring's over, mean() ready.
    sample(frameIndex: int, value: number): boolean {
        if (!this.active) {
            return false;
        }
        if (frameIndex >= this.firstFrame && value > 0.0) {
            this.sum += value;
            this.count++;
        }
        if (frameIndex < this.lastFrame) {
            return false;
        }
        this.active = false;
        return true;
    }

    // The measurements' mean (0 with none).
    mean(): number {
        return this.count > 0 ? this.sum / this.count : 0.0;
    }

    // size for a budget, given the mean time at size: kept within the budget; over it, scaled by
    // sqrt(budget / mean) (the work grows with the size squared, a grid's cells), down to a
    // multiple of step, at least minSize (and never above size).
    static fit(size: int, mean: number, budget: number, step: int, minSize: int): int {
        if (mean <= budget) {
            return size;
        }
        return Math.max(Math.min(Math.floor(size * Math.sqrt(budget / mean) / step) * step, size), minSize);
    }
}
