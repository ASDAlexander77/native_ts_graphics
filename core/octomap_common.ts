// What render_octomap and its NRI port (examples/nri/render_octomap_nri.ts) share: the reader of
// the sample's octomap file, its height coloring and the splats' sort.
//
// Imported with `import { OctomapReader, hsvToRgb, sortDescending } from "../core/octomap_common";`
// (from examples/), and listed in the example's sources.

// octomap::OcTree: 16 levels, keys centered on 2^15.
const TREE_DEPTH = 16;
const TREE_MAX_VAL = 32768;

// ASCII.
const CHAR_NEWLINE = 10;
const CHAR_HASH = 35;
const CHAR_MINUS = 45;
const CHAR_DOT = 46;
const CHAR_0 = 48;
const CHAR_9 = 57;
const CHAR_E = 69;
const CHAR_D = 100;
const CHAR_LOWER_E = 101;
const CHAR_R = 114;
const CHAR_S = 115;

// The sample's hsv_to_rgb (h in [0,1], s and v in [0,1]), into rgb[0..2].
export function hsvToRgb(hIn: number, s: number, v: number, rgb: number[]) {
    let h = hIn - Math.floor(hIn);
    h *= 6.0;
    const i = Math.floor(h);
    let f = h - i;
    if (i % 2 == 0) {
        f = 1.0 - f;
    }
    const m = v * (1.0 - s);
    const n = v * (1.0 - s * f);
    if (i == 6 || i == 0) {
        rgb[0] = v; rgb[1] = n; rgb[2] = m;
    } else if (i == 1) {
        rgb[0] = n; rgb[1] = v; rgb[2] = m;
    } else if (i == 2) {
        rgb[0] = m; rgb[1] = v; rgb[2] = n;
    } else if (i == 3) {
        rgb[0] = m; rgb[1] = n; rgb[2] = v;
    } else if (i == 4) {
        rgb[0] = n; rgb[1] = m; rgb[2] = v;
    } else if (i == 5) {
        rgb[0] = v; rgb[1] = m; rgb[2] = n;
    } else {
        rgb[0] = 1.0; rgb[1] = 0.5; rgb[2] = 0.5;
    }
}

// A decimal number in bytes [start, end) ("0.1", "-2e-3"...): digits as an integer, scaled by a
// power of ten, as strtod rounds it for numbers of up to 15 digits.
function parseNumber(bytes: int[], start: int, end: int) {
    let i = start;
    let negative = false;
    if (i < end && bytes[i] == CHAR_MINUS) {
        negative = true;
        i++;
    }
    let mantissa = 0.0;
    let decimals = 0;
    let inFraction = false;
    while (i < end) {
        const c = bytes[i];
        if (c >= CHAR_0 && c <= CHAR_9) {
            mantissa = mantissa * 10.0 + (c - CHAR_0);
            if (inFraction) {
                decimals++;
            }
        } else if (c == CHAR_DOT) {
            inFraction = true;
        } else {
            break;
        }
        i++;
    }
    let exponent = 0;
    if (i < end && (bytes[i] == CHAR_LOWER_E || bytes[i] == CHAR_E)) {
        i++;
        let exponentNegative = false;
        if (i < end && bytes[i] == CHAR_MINUS) {
            exponentNegative = true;
            i++;
        }
        while (i < end && bytes[i] >= CHAR_0 && bytes[i] <= CHAR_9) {
            exponent = exponent * 10 + (bytes[i] - CHAR_0);
            i++;
        }
        if (exponentNegative) {
            exponent = -exponent;
        }
    }
    exponent -= decimals;
    const value = exponent >= 0 ? mantissa * Math.pow(10.0, exponent) : mantissa / Math.pow(10.0, -exponent);
    return negative ? -value : value;
}

// octomap::OcTree's readBinary and its tree iterator: the file's header (resolution), then
// the nodes, depth first, 2 bits per child (01 occupied leaf, 10 free leaf, 11 inner node,
// 00 none), each inner node's children following it. The leaves come out in the order the
// iterator visits them (children 0 to 7, depth first), with their centers and sizes as
// keyToCoord and getNodeSize compute them.
@final
export class OctomapReader {
    bytes: int[];
    position: int;
    resolution: number;
    // Every leaf: x, y, z (center) and size; and whether it's occupied.
    leaves: number[];
    occupied: boolean[];

    constructor() {
        this.bytes = [];
        this.position = 0;
        this.resolution = 0.1;
        this.leaves = [];
        this.occupied = [];
    }

    keyToCoord(key: int, depth: int) {
        if (depth == 0) {
            return 0.0;
        }
        if (depth == TREE_DEPTH) {
            return (key - TREE_MAX_VAL + 0.5) * this.resolution;
        }
        const cells = Math.pow(2.0, TREE_DEPTH - depth);
        return (Math.floor((key - TREE_MAX_VAL) / cells) + 0.5) * this.resolution * cells;
    }

    addLeaf(depth: int, kx: int, ky: int, kz: int, occupied: boolean) {
        this.leaves.push(this.keyToCoord(kx, depth));
        this.leaves.push(this.keyToCoord(ky, depth));
        this.leaves.push(this.keyToCoord(kz, depth));
        this.leaves.push(this.resolution * Math.pow(2.0, TREE_DEPTH - depth));
        this.occupied.push(occupied);
    }

    // computeChildKey for one axis.
    childKey(parentKey: int, centerOffsetKey: int, upper: boolean) {
        if (upper) {
            return parentKey + centerOffsetKey;
        }
        return parentKey - centerOffsetKey - (centerOffsetKey != 0 ? 0 : 1);
    }

    readNode(depth: int, kx: int, ky: int, kz: int) {
        if (this.position + 2 > this.bytes.length) {
            return false;
        }
        const child1to4 = this.bytes[this.position];
        const child5to8 = this.bytes[this.position + 1];
        this.position += 2;

        const childDepth = depth + 1;
        const centerOffsetKey = TREE_MAX_VAL >> childDepth;
        for (let i = 0; i < 8; i++) {
            const bits = i < 4 ? child1to4 : child5to8;
            const shift = (i % 4) * 2;
            const low = (bits >> shift) & 1;
            const high = (bits >> (shift + 1)) & 1;
            if (low == 0 && high == 0) {
                continue;
            }
            const cx = this.childKey(kx, centerOffsetKey, (i & 1) != 0);
            const cy = this.childKey(ky, centerOffsetKey, (i & 2) != 0);
            const cz = this.childKey(kz, centerOffsetKey, (i & 4) != 0);
            if (low == 1 && high == 1) {
                if (!this.readNode(childDepth, cx, cy, cz)) {
                    return false;
                }
            } else {
                // 01: occupied leaf, 10: free leaf.
                this.addLeaf(childDepth, cx, cy, cz, high == 1);
            }
        }
        return true;
    }

    // Room for a file of size bytes, which the caller copies into bytes from bytes[0]; false if it's
    // empty.
    resize(size: int) {
        for (let i = 0; i < size; i++) {
            this.bytes.push(0);
        }
        return size > 0;
    }

    // The bytes' header lines up to "data" (its resolution from "res"), then the tree.
    parse() {
        const size = this.bytes.length;
        if (size == 0 || this.bytes[0] != CHAR_HASH) {
            return false;
        }
        let lineStart = 0;
        let foundData = false;
        while (lineStart < size && !foundData) {
            let lineEnd = lineStart;
            while (lineEnd < size && this.bytes[lineEnd] != CHAR_NEWLINE) {
                lineEnd++;
            }
            const b = this.bytes;
            if (lineEnd - lineStart >= 4 && b[lineStart] == CHAR_R && b[lineStart + 1] == CHAR_LOWER_E
                && b[lineStart + 2] == CHAR_S) {
                this.resolution = parseNumber(b, lineStart + 4, lineEnd);
            } else if (lineEnd - lineStart >= 4 && b[lineStart] == CHAR_D && b[lineStart + 1] == 97
                && b[lineStart + 2] == 116 && b[lineStart + 3] == 97) {
                foundData = true;
            }
            lineStart = lineEnd + 1;
        }
        if (!foundData) {
            return false;
        }
        this.position = lineStart;
        return this.readNode(0, TREE_MAX_VAL, TREE_MAX_VAL, TREE_MAX_VAL);
    }
}

// Sorts order[] by key[] descending (merge sort, stable), with scratch[] as large as order.
export function sortDescending(order: int[], key: number[], scratch: int[]) {
    const n = order.length;
    let width = 1;
    let src = order;
    let dst = scratch;
    let inScratch = false;
    while (width < n) {
        for (let left = 0; left < n; left += 2 * width) {
            const mid = Math.min(left + width, n);
            const right = Math.min(left + 2 * width, n);
            let i = left;
            let j = mid;
            let k = left;
            while (i < mid && j < right) {
                if (key[src[j]] > key[src[i]]) {
                    dst[k] = src[j];
                    j++;
                } else {
                    dst[k] = src[i];
                    i++;
                }
                k++;
            }
            while (i < mid) {
                dst[k] = src[i];
                i++;
                k++;
            }
            while (j < right) {
                dst[k] = src[j];
                j++;
                k++;
            }
        }
        const swap = src;
        src = dst;
        dst = swap;
        inScratch = !inScratch;
        width *= 2;
    }
    if (inScratch) {
        for (let i = 0; i < n; i++) {
            order[i] = src[i];
        }
    }
}
