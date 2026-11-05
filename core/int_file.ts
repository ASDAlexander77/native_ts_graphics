// A small file of 32-bit ints, the first a magic number saying what it holds: settings, a cache,
// progress kept between runs. The file is read from (and written to) the app's data directory
// (the executable's on desktop), and written whole, replacing the old one only once it's written.
//
// Imported with `import { IntFile } from "../core/int_file";` (add_tslang_nri_example adds it to the
// app's sources).

/// <reference path="nri/nri_interop.d.ts" />
import { Nri, NriFile } from "./nri";

@final
export class IntFile {
    // The ints after the magic number, or null when there's no file, or it doesn't start with magic.
    // At most maxInts of them (a longer file's rest isn't read).
    static read(path: string, magic: int, maxInts: int): int[] | null {
        const file = NriFile.load(path);
        if (!file) {
            return null;
        }
        const ints = IntFile.readInts(file, 1 + maxInts);
        file.destroy();
        if (ints.length < 1 || ints[0] != magic) {
            return null;
        }
        const values: int[] = [];
        for (let i = 1; i < ints.length; i++) {
            values.push(ints[i]);
        }
        return values;
    }

    // The first count ints of a file (fewer when it's shorter), little-endian.
    static readInts(file: NriFile, count: int): int[] {
        const size = Math.min(file.getSize(), count * 4);
        const bytes: int[] = [];
        for (let i = 0; i < size; i++) {
            bytes.push(0);
        }
        if (size > 0) {
            file.copyBytes(0, size, Ref(bytes[0]));
        }
        const ints: int[] = [];
        for (let i = 0; i + 3 < size; i += 4) {
            ints.push(bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24));
        }
        return ints;
    }

    // magic, then ints, written to path; whether it was written.
    static write(path: string, magic: int, ints: int[]): boolean {
        const all: int[] = [magic];
        for (const value of ints) {
            all.push(value);
        }
        return Nri.saveIntsToFile(Ref(all[0]), all.length, path) != 0;
    }
}
