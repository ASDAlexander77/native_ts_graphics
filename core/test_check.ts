// What the examples' -test checks share (see Args.test): the last frame and GPU buffers read back,
// and checks of the frame. A check returns "" when it passes, else what's wrong, as App.finishTest
// takes it.
//
// Imported with `import { TestCheck } from "../core/test_check";` (from examples/); compiled into
// every example, as args.ts is.

import { App } from "./donut";

export class TestCheck {
    // The last frame's pixels, RGBA8 packed as 0xAABBGGRR, row after row; empty if it can't be read.
    pixels: int[] = [];
    width: int;
    height: int;

    constructor(private app: App) {
        this.width = app.getWindowWidth();
        this.height = app.getWindowHeight();
        const pixels: int[] = [];
        for (let i = 0; i < this.width * this.height; i++) {
            pixels.push(0);
        }
        if (app.readBackBufferRGBA8(Ref(pixels[0]), pixels.length) != 0) {
            this.pixels = pixels;
        }
    }

    // "" if the frame was read back.
    frameRead(): string {
        return this.pixels.length > 0 ? "" : "cannot read the back buffer";
    }

    // The pixel at (x, y), as 0xBBGGRR.
    rgb(x: int, y: int): int {
        return this.pixels[y * this.width + x] & 0xFFFFFF;
    }

    // The four corners are the color rgb (0xBBGGRR): the clear color, where nothing is drawn.
    corners(rgb: int): string {
        const failure = this.frameRead();
        if (failure != "") {
            return failure;
        }
        const xs = [0, this.width - 1, 0, this.width - 1];
        const ys = [0, 0, this.height - 1, this.height - 1];
        for (let k = 0; k < 4; k++) {
            const p = this.rgb(xs[k], ys[k]);
            if (p != rgb) {
                return `corner (${xs[k]}, ${ys[k]}) is ${p & 0xFF}, ${(p >> 8) & 0xFF}, ${(p >> 16) & 0xFF}, not ${rgb & 0xFF}, ${(rgb >> 8) & 0xFF}, ${(rgb >> 16) & 0xFF}`;
            }
        }
        return "";
    }

    // The pixels of another color than rgb (0xBBGGRR), in the rectangle (x, y, width, height).
    countOtherThan(rgb: int, x: int, y: int, width: int, height: int): int {
        let count = 0;
        for (let j = y; j < y + height; j++) {
            for (let i = x; i < x + width; i++) {
                if (this.rgb(i, j) != rgb) {
                    count++;
                }
            }
        }
        return count;
    }

    // The pixels in the rectangle (x, y, width, height) whose red, green and blue are each within
    // their range (inclusive, 0 to 255).
    countInRange(rMin: int, rMax: int, gMin: int, gMax: int, bMin: int, bMax: int,
        x: int, y: int, width: int, height: int): int {
        let count = 0;
        for (let j = y; j < y + height; j++) {
            for (let i = x; i < x + width; i++) {
                const p = this.rgb(i, j);
                const r = p & 0xFF;
                const g = (p >> 8) & 0xFF;
                const b = (p >> 16) & 0xFF;
                if (r >= rMin && r <= rMax && g >= gMin && g <= gMax && b >= bMin && b <= bMax) {
                    count++;
                }
            }
        }
        return count;
    }

    // The pixels in the rectangle whose largest and smallest channels are at least `spread` apart
    // (colors, not grays), or, with gray, those within `spread` of each other and at least `level`
    // (grays brighter than that).
    countSpread(spread: int, gray: boolean, level: int, x: int, y: int, width: int, height: int): int {
        let count = 0;
        for (let j = y; j < y + height; j++) {
            for (let i = x; i < x + width; i++) {
                const p = this.rgb(i, j);
                const r = p & 0xFF;
                const g = (p >> 8) & 0xFF;
                const b = (p >> 16) & 0xFF;
                let high = r;
                let low = r;
                if (g > high) {
                    high = g;
                }
                if (b > high) {
                    high = b;
                }
                if (g < low) {
                    low = g;
                }
                if (b < low) {
                    low = b;
                }
                if (gray ? (high - low < spread && low >= level) : (high - low >= spread)) {
                    count++;
                }
            }
        }
        return count;
    }

    // count is between `min` and `max` hundredths of `total` pixels; what names them in the failure.
    // Logs the share.
    share(count: int, total: int, min: number, max: number, what: string): string {
        const percent = 100.0 * count / total;
        console.log(`${what}: ${percent}% (${count} of ${total} pixels)`);
        if (percent < min || percent > max) {
            return `${what}: ${percent}% of the pixels, not ${min}% to ${max}%`;
        }
        return "";
    }

    // At least `minimum` pixels of the frame aren't rgb (0xBBGGRR): something was drawn over the
    // clear color. what names it in the failure.
    drawn(rgb: int, minimum: int, what: string): string {
        const failure = this.frameRead();
        if (failure != "") {
            return failure;
        }
        const count = this.countOtherThan(rgb, 0, 0, this.width, this.height);
        console.log(`${what}: ${count} pixels`);
        return count >= minimum ? "" : `${what}: ${count} pixels drawn, not ${minimum} or more`;
    }

    // The first byteSize bytes of a GPU buffer (in any state but CPU-visible), read back as floats;
    // empty if it can't be. Submits its own command list and waits for the GPU: call it after
    // App.run, as the checks are.
    readFloats(buffer: BufferHandle, byteSize: int): f32[] {
        const readback = this.app.createReadbackBuffer(byteSize, "Test readback");
        const commandList = this.app.createCommandList();
        commandList.open();
        commandList.copyBuffer(readback, 0, buffer, 0, byteSize);
        commandList.close();
        this.app.executeCommandList(commandList);
        this.app.waitForIdle();
        this.app.releaseResource(commandList.handle);
        const values: f32[] = [];
        for (let i = 0; i < byteSize / 4; i++) {
            values.push(0.0);
        }
        const read = this.app.readBuffer(readback, Ref(values[0]), byteSize);
        this.app.releaseResource(readback);
        if (read == 0) {
            return [];
        }
        return values;
    }
}

// The exit code of a test the device can't run (CTest's SKIP_RETURN_CODE, see
// add_tslang_example_test; tools/android.py ctest reports it as SKIPPED).
export const TEST_SKIPPED = 77;

// An example that can't run on this device (it lacks a feature the example needs) returns this
// from main: under -test (`test`, Args.test), "Test SKIPPED: <why>" and TEST_SKIPPED, a skip, not
// a failure; otherwise why, and 1.
export function unsupported(test: boolean, why: string): int {
    if (test) {
        console.log(`Test SKIPPED: ${why}`);
        return TEST_SKIPPED;
    }
    console.log(why);
    return 1;
}

// Neither NaN nor infinite.
export function isFinite32(x: number): boolean {
    return x > -1.0e38 && x < 1.0e38;
}
