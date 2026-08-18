import assert from "node:assert/strict";
import test from "node:test";
import type {ExtensionContext, Theme} from "@earendil-works/pi-coding-agent";
import {
    ToolDisplayController,
    ToolDisplayMode,
} from "../src/tui/tool/ToolDisplayController.js";
import type {ToolDisplayModeSource} from "../src/tui/tool/ToolDisplayController.js";
import {
    ToolArgumentLayout,
    ToolArgumentPlacement,
    ToolTextDirection,
} from "../src/tui/tool/ToolPresentation.js";
import type {ToolPresentationSpec} from "../src/tui/tool/ToolPresentation.js";
import {ThemeColor} from "../src/tui/Color.js";
import {displayWidth} from "../src/tui/terminalText.js";
import {ToolPresentationRenderer} from "../src/tui/tool/ToolPresentationRenderer.js";

const plainTheme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
} as unknown as Theme;

class MutableDisplayMode implements ToolDisplayModeSource {
    constructor(private mode: ToolDisplayMode) {}

    currentMode(): ToolDisplayMode {
        return this.mode;
    }

    set(mode: ToolDisplayMode): void {
        this.mode = mode;
    }
}

test("tool display controls remember the regular mode while minimal is active", () => {
    const expandedStates: boolean[] = [];
    const ctx = {
        mode: "tui",
        ui: {
            setToolsExpanded(expanded: boolean) {
                expandedStates.push(expanded);
            },
        },
    } as unknown as ExtensionContext;
    const controller = new ToolDisplayController(ctx);

    assert.equal(controller.currentMode(), ToolDisplayMode.TRUNCATED);
    assert.deepEqual(expandedStates, [false]);
    assert.equal(controller.toggleExpanded(), ToolDisplayMode.FULL);
    assert.equal(controller.toggleMinimal(), ToolDisplayMode.MINIMAL);
    assert.equal(controller.toggleMinimal(), ToolDisplayMode.FULL);

    assert.equal(controller.toggleMinimal(), ToolDisplayMode.MINIMAL);
    assert.equal(controller.toggleExpanded(), ToolDisplayMode.FULL);
    assert.equal(controller.toggleExpanded(), ToolDisplayMode.TRUNCATED);
    assert.equal(controller.toggleMinimal(), ToolDisplayMode.MINIMAL);
    assert.equal(controller.synchronizeExpanded(false), ToolDisplayMode.MINIMAL);
    assert.equal(controller.synchronizeExpanded(true), ToolDisplayMode.FULL);
    assert.deepEqual(expandedStates, [false, true, false, true, false, true, false, false]);
});

test("full Bash presentation promotes purpose and timeout and omits the sole body argument label", () => {
    const mode = new MutableDisplayMode(ToolDisplayMode.FULL);
    const renderer = new ToolPresentationRenderer(bashPresentation(), mode);

    assert.deepEqual(
        renderer.renderCall({
            purpose: "Build the native helper",
            command: "npm run build\nnpm test",
            timeout: 300,
        }, plainTheme).render(120),
        [
            "bash | Build the native helper (timeout 300s)",
            "    npm run build",
            "    npm test",
        ],
    );
    assert.deepEqual(
        renderer.renderResult({content: [{type: "text", text: "build complete"}]}, plainTheme).render(120),
        ["", "build complete"],
    );
});

test("minimal presentation shows title arguments and hides successful or failed output", () => {
    const mode = new MutableDisplayMode(ToolDisplayMode.MINIMAL);
    const renderer = new ToolPresentationRenderer(bashPresentation(), mode);
    const args = {
        purpose: "Build the native helper",
        command: "npm run build",
        timeout: 300,
    };

    assert.deepEqual(
        renderer.renderCall(args, plainTheme).render(120),
        ["bash | Build the native helper (timeout 300s)"],
    );
    assert.deepEqual(
        renderer.renderResult({content: [{type: "text", text: "success"}]}, plainTheme).render(120),
        [],
    );
    assert.deepEqual(
        renderer.renderResult(
            {content: [{type: "text", text: "failure details"}]},
            plainTheme,
            {isError: true},
        ).render(120),
        [],
    );
});

test("rendered components observe display-mode changes without being replaced", () => {
    const mode = new MutableDisplayMode(ToolDisplayMode.FULL);
    const renderer = new ToolPresentationRenderer(bashPresentation(), mode);
    const call = renderer.renderCall({purpose: "Track display mode", command: "echo complete"}, plainTheme);
    const result = renderer.renderResult({content: [{type: "text", text: "complete"}]}, plainTheme);

    assert.deepEqual(call.render(120), [
        "bash | Track display mode",
        "    echo complete",
    ]);
    assert.deepEqual(result.render(120), ["", "complete"]);

    mode.set(ToolDisplayMode.MINIMAL);
    assert.deepEqual(call.render(120), ["bash | Track display mode"]);
    assert.deepEqual(result.render(120), []);
});

test("truncated presentation keeps argument heads and output tails", () => {
    const mode = new MutableDisplayMode(ToolDisplayMode.TRUNCATED);
    const renderer = new ToolPresentationRenderer(bashPresentation(), mode);
    const command = numberedLines(10);
    const output = numberedLines(8);

    assert.deepEqual(
        renderer.renderCall({purpose: "Exercise truncation", command}, plainTheme).render(120),
        [
            "bash | Exercise truncation",
            "    line 1",
            "    line 2",
            "    line 3",
            "    line 4",
            "    line 5",
            "    line 6",
            "    line 7",
            "    line 8",
            "    ... (2 more lines, ctrl+o to expand)",
        ],
    );
    assert.deepEqual(
        renderer.renderResult({content: [{type: "text", text: output}]}, plainTheme).render(120),
        [
            "",
            "... (3 earlier lines, ctrl+o to expand)",
            "line 4",
            "line 5",
            "line 6",
            "line 7",
            "line 8",
        ],
    );
});

test("known arguments retain declared order, unknown arguments sort, and blocks render last", () => {
    type Args = {
        block: string;
        known: string;
    };
    const presentation = {
        toolName: "ordered",
        arguments: [
            {key: "block", layout: ToolArgumentLayout.BLOCK},
            {key: "known"},
        ],
    } satisfies ToolPresentationSpec<Args>;
    const renderer = new ToolPresentationRenderer(
        presentation,
        new MutableDisplayMode(ToolDisplayMode.FULL),
    );

    assert.deepEqual(
        renderer.renderCall({
            block: "configured block",
            known: "configured inline",
            zeta: 2,
            alpha: 1,
            unknownBlock: "first\nsecond",
        } as Args, plainTheme).render(120),
        [
            "ordered",
            "    known: configured inline",
            "    alpha: 1",
            "    zeta: 2",
            "    block:",
            "        configured block",
            "    unknownBlock:",
            "        first",
            "        second",
        ],
    );
});

test("a sole body argument is displayed without its name", () => {
    type Args = {path: string};
    const presentation = {
        toolName: "mkdir",
        arguments: [{key: "path"}],
    } satisfies ToolPresentationSpec<Args>;
    const renderer = new ToolPresentationRenderer(
        presentation,
        new MutableDisplayMode(ToolDisplayMode.FULL),
    );

    assert.deepEqual(
        renderer.renderCall({path: "/tmp/new-directory"}, plainTheme).render(120),
        ["mkdir", "    /tmp/new-directory"],
    );
    assert.deepEqual(renderer.renderCall(undefined, plainTheme).render(120), ["mkdir"]);
});

test("full presentation retains hard row and terminal-width limits", () => {
    type Args = {content: string};
    const presentation = {
        toolName: "bounded",
        maxCallLines: 6,
        arguments: [{key: "content", layout: ToolArgumentLayout.BLOCK}],
        result: {
            direction: ToolTextDirection.TAIL,
            maxFullLines: 4,
        },
    } satisfies ToolPresentationSpec<Args>;
    const renderer = new ToolPresentationRenderer(
        presentation,
        new MutableDisplayMode(ToolDisplayMode.FULL),
    );

    const callLines = renderer.renderCall({content: numberedLines(20)}, plainTheme).render(20);
    assert.equal(callLines.length, 6);
    assert.equal(callLines[5], "... (16 lines omitt…");
    assert.equal(callLines.every((line) => displayWidth(line) <= 20), true);
    assert.deepEqual(
        renderer.renderResult({content: [{type: "text", text: numberedLines(10)}]}, plainTheme).render(120),
        [
            "",
            "... (7 lines omitted from display)",
            "line 8",
            "line 9",
            "line 10",
        ],
    );
});

test("every tool display mode enforces Pi's width contract", () => {
    const mode = new MutableDisplayMode(ToolDisplayMode.FULL);
    const renderer = new ToolPresentationRenderer(bashPresentation(), mode);
    const ansiTheme = {
        fg: (_color: string, text: string) => `\x1b[31m${text}\x1b[39m`,
        bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
    } as unknown as Theme;
    const args = {
        purpose: "◽ purpose ".repeat(20),
        command: "printf '界🙂' ".repeat(20),
    };
    const result = {content: [{type: "text", text: "👨‍👩‍👧‍👦 output ◽ ".repeat(20)}]};

    for (const displayMode of Object.values(ToolDisplayMode)) {
        mode.set(displayMode);
        for (const width of [1, 2, 10, 20]) {
            const lines = [
                ...renderer.renderCall(args, ansiTheme).render(width),
                ...renderer.renderResult(result, ansiTheme).render(width),
            ];
            assert.equal(
                lines.every((line) => displayWidth(line) <= width),
                true,
                `${displayMode} produced an over-wide line at width ${width}`,
            );
        }
    }
});

test("character safety limits retain the configured head or tail boundary", () => {
    type Args = {content: string};
    const presentation = {
        toolName: "character-bounded",
        arguments: [{
            key: "content",
            layout: ToolArgumentLayout.BLOCK,
            maxCharacters: 5,
        }],
        result: {
            direction: ToolTextDirection.TAIL,
            maxCharacters: 5,
        },
    } satisfies ToolPresentationSpec<Args>;
    const renderer = new ToolPresentationRenderer(
        presentation,
        new MutableDisplayMode(ToolDisplayMode.FULL),
    );

    assert.deepEqual(
        renderer.renderCall({content: "abcdefghij"}, plainTheme).render(120),
        ["character-bounded", "    abcde", "    [display truncated]"],
    );
    assert.deepEqual(
        renderer.renderResult({content: [{type: "text", text: "abcdefghij"}]}, plainTheme).render(120),
        ["", "[display truncated]", "fghij"],
    );
});

test("secondary owners consume declared arguments and retain independent title parts", () => {
    type Args = {
        path: string;
        offset?: number;
        limit?: number;
        encoding?: string;
    };
    const presentation = {
        toolName: "read",
        arguments: [
            {
                key: "path",
                placement: ToolArgumentPlacement.TITLE_PRIMARY,
                color: ThemeColor.text,
            },
            {
                key: "offset",
                placement: ToolArgumentPlacement.TITLE_SECONDARY,
                color: ThemeColor.warning,
                format: (_value, args) => {
                    const from = args.offset ?? 1;
                    return args.limit === undefined ? `:${from}` : `:${from}-${from + args.limit - 1}`;
                },
            },
            {
                key: "limit",
                placement: ToolArgumentPlacement.TITLE_SECONDARY,
                consumedBy: "offset",
            },
            {
                key: "encoding",
                placement: ToolArgumentPlacement.TITLE_SECONDARY,
                format: (value) => ` (${String(value)})`,
            },
        ],
    } satisfies ToolPresentationSpec<Args>;
    const colorTheme = {
        fg: (color: string, text: string) => color === ThemeColor.warning ? `<warning>${text}</warning>` : text,
        bold: (text: string) => text,
    } as unknown as Theme;
    const renderer = new ToolPresentationRenderer(
        presentation,
        new MutableDisplayMode(ToolDisplayMode.MINIMAL),
    );

    assert.deepEqual(
        renderer.renderCall({path: "file.txt", offset: 2, limit: 2, encoding: "utf8"}, colorTheme).render(120),
        ["read | file.txt<warning>:2-3</warning> (utf8)"],
    );
    assert.deepEqual(
        renderer.renderCall({path: "file.txt", limit: 2}, colorTheme).render(120),
        ["read | file.txt<warning>:1-2</warning>"],
    );
    assert.deepEqual(
        renderer.renderCall({path: "file.txt", offset: 2}, colorTheme).render(120),
        ["read | file.txt<warning>:2</warning>"],
    );
});

test("presentation specifications reject ambiguous argument declarations", () => {
    type Args = {value: string};
    const mode = new MutableDisplayMode(ToolDisplayMode.FULL);

    assert.throws(
        () => new ToolPresentationRenderer({
            toolName: "duplicate",
            arguments: [{key: "value"}, {key: "value"}],
        } satisfies ToolPresentationSpec<Args>, mode),
        /duplicate argument: value/,
    );
    assert.throws(
        () => new ToolPresentationRenderer({
            toolName: "forward-consumption",
            arguments: [
                {
                    key: "value",
                    placement: ToolArgumentPlacement.TITLE_SECONDARY,
                    consumedBy: "owner",
                },
                {
                    key: "owner",
                    placement: ToolArgumentPlacement.TITLE_SECONDARY,
                    format: String,
                },
            ],
        } satisfies ToolPresentationSpec<{value: string; owner: string}>, mode),
        /must reference an earlier argument: owner/,
    );
});

function bashPresentation(): ToolPresentationSpec<{
    purpose: string;
    command: string;
    timeout?: number;
}> {
    return {
        toolName: "bash",
        arguments: [
            {
                key: "purpose",
                placement: ToolArgumentPlacement.TITLE_PRIMARY,
            },
            {
                key: "timeout",
                placement: ToolArgumentPlacement.TITLE_SECONDARY,
                format: (value) => ` (timeout ${String(value)}s)`,
            },
            {
                key: "command",
                layout: ToolArgumentLayout.BLOCK,
                direction: ToolTextDirection.HEAD,
            },
        ],
        result: {
            direction: ToolTextDirection.TAIL,
        },
    };
}

function numberedLines(count: number): string {
    return Array.from({length: count}, (_, index) => `line ${index + 1}`).join("\n");
}
