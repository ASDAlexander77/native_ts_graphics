// A small JSON reader over a file's bytes: objects, arrays, strings (ASCII), numbers, true, false
// and null, read in order by the caller, who knows the shape it expects (no tree is built).
//
// Imported with `import { JsonReader } from "../../core/json_reader";` (from examples/nri/), and
// listed in the example's sources. It depends on nothing: the caller copies the bytes in (one per
// int, e.g. with Nri_CopyFileBytes into bytes[0] after resize).
//
//     if (reader.beginObject()) {
//         while (reader.nextKey()) {
//             const key = reader.readString();
//             if (key == "name") { name = reader.readString(); } else { reader.skipValue(); }
//         }
//     }

const CHAR_TAB = 9;
const CHAR_NEWLINE = 10;
const CHAR_RETURN = 13;
const CHAR_SPACE = 32;
const CHAR_QUOTE = 34;
const CHAR_PLUS = 43;
const CHAR_COMMA = 44;
const CHAR_MINUS = 45;
const CHAR_DOT = 46;
const CHAR_0 = 48;
const CHAR_9 = 57;
const CHAR_COLON = 58;
const CHAR_E = 69;
const CHAR_OPEN_BRACKET = 91;
const CHAR_BACKSLASH = 92;
const CHAR_CLOSE_BRACKET = 93;
const CHAR_LOWER_E = 101;
const CHAR_LOWER_F = 102;
const CHAR_LOWER_N = 110;
const CHAR_LOWER_T = 116;
const CHAR_OPEN_BRACE = 123;
const CHAR_CLOSE_BRACE = 125;

// The printable ASCII characters from the space on, for building strings from their codes.
const PRINTABLE = " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~";

@final
export class JsonReader {
    // The file's bytes, one per int: resize makes room, the caller copies them in from bytes[0].
    bytes: int[];
    // The first thing that didn't parse ("" while all did); reads after it return empty values.
    error: string;
    private pos: int;

    constructor() {
        this.bytes = [];
        this.error = "";
        this.pos = 0;
    }

    // Room for a file of size bytes; false if it's empty.
    resize(size: int) {
        for (let i = 0; i < size; i++) {
            this.bytes.push(0);
        }
        return size > 0;
    }

    private fail(what: string) {
        if (this.error == "") {
            this.error = `${what} at byte ${this.pos}`;
        }
        this.pos = this.bytes.length;
    }

    private skipSpace() {
        while (this.pos < this.bytes.length) {
            const c = this.bytes[this.pos];
            if (c != CHAR_SPACE && c != CHAR_TAB && c != CHAR_NEWLINE && c != CHAR_RETURN) {
                return;
            }
            this.pos++;
        }
    }

    // The next character past the white space (0 at the end).
    peek(): int {
        this.skipSpace();
        return this.pos < this.bytes.length ? this.bytes[this.pos] : 0;
    }

    // Moves past c if it's next.
    private accept(c: int) {
        if (this.peek() == c) {
            this.pos++;
            return true;
        }
        return false;
    }

    private expect(c: int, what: string) {
        if (!this.accept(c)) {
            this.fail(`expected ${what}`);
        }
    }

    // Into an object: true if there is one (else the value is skipped).
    beginObject() {
        if (this.accept(CHAR_OPEN_BRACE)) {
            return true;
        }
        this.skipValue();
        return false;
    }

    // Into an array: true if there is one (else the value is skipped).
    beginArray() {
        if (this.accept(CHAR_OPEN_BRACKET)) {
            return true;
        }
        this.skipValue();
        return false;
    }

    // In an object: true before its next key (read it with readString, then its value), false at
    // its end (moved past it).
    nextKey() {
        this.accept(CHAR_COMMA);
        if (this.accept(CHAR_CLOSE_BRACE) || this.pos >= this.bytes.length) {
            return false;
        }
        return true;
    }

    // In an array: true before its next value, false at its end (moved past it).
    nextItem() {
        this.accept(CHAR_COMMA);
        if (this.accept(CHAR_CLOSE_BRACKET) || this.pos >= this.bytes.length) {
            return false;
        }
        return true;
    }

    // A string (an object's key too: its colon taken with it). Escapes keep the escaped character;
    // characters past ASCII read as '?'.
    readString(): string {
        if (!this.accept(CHAR_QUOTE)) {
            this.fail("expected a string");
            return "";
        }
        let text = "";
        while (this.pos < this.bytes.length && this.bytes[this.pos] != CHAR_QUOTE) {
            let c = this.bytes[this.pos];
            if (c == CHAR_BACKSLASH && this.pos + 1 < this.bytes.length) {
                this.pos++;
                c = this.bytes[this.pos];
                if (c == CHAR_LOWER_N) {
                    c = CHAR_SPACE;
                }
            }
            text += c >= CHAR_SPACE && c - CHAR_SPACE < PRINTABLE.length ? PRINTABLE.charAt(c - CHAR_SPACE) : "?";
            this.pos++;
        }
        this.expect(CHAR_QUOTE, "the string's end");
        if (this.peek() == CHAR_COLON) {
            this.pos++;
        }
        return text;
    }

    // A number (0 if there's none).
    readNumber(): number {
        const c = this.peek();
        if (!((c >= CHAR_0 && c <= CHAR_9) || c == CHAR_MINUS || c == CHAR_PLUS || c == CHAR_DOT)) {
            this.fail("expected a number");
            return 0.0;
        }
        let sign = 1.0;
        if (this.bytes[this.pos] == CHAR_MINUS) {
            sign = -1.0;
            this.pos++;
        } else if (this.bytes[this.pos] == CHAR_PLUS) {
            this.pos++;
        }
        // The digits as an integer, and the power of ten they're scaled by.
        let mantissa = 0.0;
        let exponent = 0;
        while (this.pos < this.bytes.length && this.bytes[this.pos] >= CHAR_0 && this.bytes[this.pos] <= CHAR_9) {
            mantissa = mantissa * 10.0 + (this.bytes[this.pos] - CHAR_0);
            this.pos++;
        }
        if (this.pos < this.bytes.length && this.bytes[this.pos] == CHAR_DOT) {
            this.pos++;
            while (this.pos < this.bytes.length && this.bytes[this.pos] >= CHAR_0 && this.bytes[this.pos] <= CHAR_9) {
                mantissa = mantissa * 10.0 + (this.bytes[this.pos] - CHAR_0);
                exponent--;
                this.pos++;
            }
        }
        if (this.pos < this.bytes.length && (this.bytes[this.pos] == CHAR_E || this.bytes[this.pos] == CHAR_LOWER_E)) {
            this.pos++;
            let exponentSign = 1;
            if (this.bytes[this.pos] == CHAR_MINUS) {
                exponentSign = -1;
                this.pos++;
            } else if (this.bytes[this.pos] == CHAR_PLUS) {
                this.pos++;
            }
            let e = 0;
            while (this.pos < this.bytes.length && this.bytes[this.pos] >= CHAR_0 && this.bytes[this.pos] <= CHAR_9) {
                e = e * 10 + (this.bytes[this.pos] - CHAR_0);
                this.pos++;
            }
            exponent += exponentSign * e;
        }
        let value = mantissa;
        for (let i = 0; i < exponent; i++) {
            value *= 10.0;
        }
        for (let i = 0; i > exponent; i--) {
            value /= 10.0;
        }
        return sign * value;
    }

    // true or false (false if it's neither).
    readBool() {
        const c = this.peek();
        if (c == CHAR_LOWER_T || c == CHAR_LOWER_F) {
            this.skipValue();
            return c == CHAR_LOWER_T;
        }
        this.fail("expected true or false");
        return false;
    }

    // An array of numbers, as many as it has.
    readNumbers(): number[] {
        const values: number[] = [];
        if (this.beginArray()) {
            while (this.nextItem()) {
                values.push(this.readNumber());
            }
        }
        return values;
    }

    // Past the next value, whatever it is.
    skipValue() {
        const c = this.peek();
        if (c == CHAR_OPEN_BRACE) {
            this.pos++;
            while (this.nextKey()) {
                this.readString();
                this.skipValue();
            }
        } else if (c == CHAR_OPEN_BRACKET) {
            this.pos++;
            while (this.nextItem()) {
                this.skipValue();
            }
        } else if (c == CHAR_QUOTE) {
            this.readString();
        } else if ((c >= CHAR_0 && c <= CHAR_9) || c == CHAR_MINUS || c == CHAR_PLUS || c == CHAR_DOT) {
            this.readNumber();
        } else if (c == CHAR_LOWER_T || c == CHAR_LOWER_F || c == CHAR_LOWER_N) {
            // true, false, null: the letters
            while (this.pos < this.bytes.length && this.bytes[this.pos] >= 97 && this.bytes[this.pos] <= 122) {
                this.pos++;
            }
        } else {
            this.fail("expected a value");
        }
    }
}
