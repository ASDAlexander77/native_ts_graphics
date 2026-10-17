// Text helpers the examples' UIs share.
//
// Imported with `import { formatFixed, ... } from "../core/text_format";` (from examples/), and
// listed in the example's add_tslang_example sources.

// value rounded to digits digits after the point, as text.
export function formatFixed(value: number, digits: int) {
    let scale = 1.0;
    for (let i = 0; i < digits; i++) {
        scale *= 10.0;
    }
    const scaled = Math.round(Math.abs(value) * scale);
    const whole: int = Math.floor(scaled / scale);
    const fraction: int = scaled - whole * scale;
    let fractionText = `${fraction}`;
    while (fractionText.length < digits) {
        fractionText = "0" + fractionText;
    }
    const sign = value < 0.0 && scaled > 0.0 ? "-" : "";
    return digits > 0 ? `${sign}${whole}.${fractionText}` : `${sign}${whole}`;
}

// ImGui's combo items: names separated by '|'.
export function comboItems(names: string[]) {
    let items = "";
    for (let i = 0; i < names.length; i++) {
        items += (i > 0 ? "|" : "") + names[i];
    }
    return items;
}
