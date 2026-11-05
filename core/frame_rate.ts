// Frames per second, for a HUD: the frames counted over half a second at a time (steady enough to
// read, quick to follow a change).
//
// Imported with `import { FrameRate } from "../core/frame_rate";` (add_tslang_nri_example adds it
// to the app's sources). Each frame: tick(its time); fps() is the last half second's rate.

const INTERVAL = 0.5;

@final
export class FrameRate {
    private frames: int = 0;
    private time: number = 0.0;
    private rate: number = 0.0;

    // A frame of frameTime seconds.
    tick(frameTime: number) {
        this.frames++;
        this.time += frameTime;
        if (this.time >= INTERVAL) {
            this.rate = this.frames / this.time;
            this.frames = 0;
            this.time = 0.0;
        }
    }

    // The rate over the last half second (0 before it).
    fps(): number {
        return this.rate;
    }
}
