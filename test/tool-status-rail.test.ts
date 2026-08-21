import assert from "node:assert/strict";
import test from "node:test";
import type {Theme} from "@earendil-works/pi-coding-agent";
import type {Component} from "@earendil-works/pi-tui";
import {ToolStatusRail} from "../src/tui/tool/ToolStatusRail.js";

const backgroundCodes = {
    toolPendingBg: "\x1b[41m",
    toolSuccessBg: "\x1b[42m",
    toolErrorBg: "\x1b[43m",
} as const;
const backgroundReset = "\x1b[49m";

const theme = {
    bg: (color: keyof typeof backgroundCodes, text: string) => `${backgroundCodes[color]}${text}${backgroundReset}`,
} as unknown as Theme;

test("status rail colors only the first padding cell and removes trailing spaces", () => {
    const content = component(["tool title   ", "", "output  "]);

    assert.deepEqual(
        new ToolStatusRail(content, theme, {isPartial: true, isError: false}).render(20),
        [
            `${backgroundCodes.toolPendingBg} ${backgroundReset}tool title`,
            `${backgroundCodes.toolPendingBg} ${backgroundReset}`,
            `${backgroundCodes.toolPendingBg} ${backgroundReset}output`,
        ],
    );
    assert.equal(content.renderedWidth, 19);
});

test("status rail selects settled success and error colors", () => {
    const success = new ToolStatusRail(component(["done"]), theme, {isPartial: false, isError: false});
    const error = new ToolStatusRail(component(["failed"]), theme, {isPartial: false, isError: true});

    assert.deepEqual(success.render(20), [`${backgroundCodes.toolSuccessBg} ${backgroundReset}done`]);
    assert.deepEqual(error.render(20), [`${backgroundCodes.toolErrorBg} ${backgroundReset}failed`]);
});

test("status rail honors narrow widths and forwards invalidation", () => {
    const content = component(["content"]);
    const rail = new ToolStatusRail(content, theme, {isPartial: false, isError: false});

    assert.deepEqual(rail.render(1), [`${backgroundCodes.toolSuccessBg} ${backgroundReset}`]);
    assert.equal(content.renderedWidth, 1);
    assert.deepEqual(rail.render(0), []);
    rail.invalidate();
    assert.equal(content.invalidations, 1);
});

function component(lines: string[]): Component & { renderedWidth?: number; invalidations: number } {
    const result = {
        invalidations: 0,
        renderedWidth: undefined as number | undefined,
        render(width: number) {
            result.renderedWidth = width;
            return lines;
        },
        invalidate() {
            result.invalidations++;
        },
    };
    return result;
}
