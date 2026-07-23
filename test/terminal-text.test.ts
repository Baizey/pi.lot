import assert from "node:assert/strict";
import test from "node:test";
import {visibleWidth as piVisibleWidth} from "@earendil-works/pi-tui";
import {
    displayWidth,
    renderLines,
    sanitizeTerminalLine,
    truncateToWidth,
} from "../src/tui/terminalText.js";

test("terminal text uses Pi's Unicode width contract", () => {
    const source = "◽ ".repeat(20);
    const bounded = truncateToWidth(source, 20);

    assert.equal(displayWidth(bounded), piVisibleWidth(bounded));
    assert.equal(piVisibleWidth(bounded) <= 20, true);
    assert.equal(bounded.endsWith("…"), true);
});

test("rendered lines remain safe across narrow widths, ANSI, and grapheme clusters", () => {
    const lines = [
        "\x1b[31m" + "界🙂e\u0301 ◽ ".repeat(20) + "\x1b[0m",
        "family 👨‍👩‍👧‍👦 and flags 🇺🇸🇨🇦 ".repeat(10),
        "first\nsecond\tthird",
    ];
    const component = renderLines(lines);

    for (const width of [-1, 0, 1, 2, 3, 7.9, 20, 80]) {
        const expectedMaximum = Number.isFinite(width) && width > 0 ? Math.floor(width) : 0;
        const rendered = component.render(width);
        assert.equal(rendered.length, lines.length);
        for (const line of rendered) {
            assert.equal(
                piVisibleWidth(line) <= expectedMaximum,
                true,
                `line width ${piVisibleWidth(line)} exceeds ${expectedMaximum}: ${JSON.stringify(line)}`,
            );
            assert.equal(/[\r\n]/.test(line), false);
        }
    }
});

test("ANSI truncation keeps styling active through the ellipsis", () => {
    const bounded = truncateToWidth(`\x1b[31m${"◽ ".repeat(20)}`, 20);

    assert.equal(piVisibleWidth(bounded) <= 20, true);
    assert.equal(bounded.includes("\x1b[0m…"), false);
    assert.equal(bounded.endsWith("…\x1b[0m"), true);
});

test("terminal text removes non-display terminal controls before measuring", () => {
    const sanitized = sanitizeTerminalLine(
        "left\r\nright\t\x1b]0;forbidden title\x07visible\x01\x1b[31mred",
    );

    assert.equal(sanitized, "left right  visible\x1b[31mred\x1b[0m");
    assert.equal(sanitized.includes("forbidden title"), false);
    assert.equal(/[\r\n\t\x01\x07]/.test(sanitized), false);
});

test("invalid render widths fail closed", () => {
    for (const width of [Number.NaN, Number.NEGATIVE_INFINITY, -10, 0]) {
        assert.equal(truncateToWidth("visible text", width), "");
    }
});
