import assert from "node:assert/strict";
import test from "node:test";
import type {Theme} from "@earendil-works/pi-coding-agent";
import {
    ToolArgumentLayout,
    ToolArgumentPlacement,
    ToolTextDirection,
} from "../src/tui/tool/ToolPresentation.js";
import type {ToolPresentationSpec} from "../src/tui/tool/ToolPresentation.js";
import {resolveToolDisplayMode, ToolDisplayMode} from "../src/tui/tool/ToolDisplayMode.js";
import {ToolPresentationRenderer} from "../src/tui/tool/ToolPresentationRenderer.js";
import {ThemeColor} from "../src/tui/Color.js";
import {displayWidth} from "../src/tui/terminalText.js";

const plainTheme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
} as unknown as Theme;

test("global expansion selects truncated display while the row-local override selects full display", () => {
    assert.equal(resolveToolDisplayMode(false, {}), ToolDisplayMode.MINIMAL);
    assert.equal(resolveToolDisplayMode(true, {}), ToolDisplayMode.TRUNCATED);
    assert.equal(
        resolveToolDisplayMode(false, {pilotFullDisplay: true}),
        ToolDisplayMode.FULL,
    );
    assert.equal(
        resolveToolDisplayMode(true, {pilotFullDisplay: true}),
        ToolDisplayMode.FULL,
    );
});

test("full Bash presentation promotes purpose and timeout and shows complete output", () => {
    const renderer = new ToolPresentationRenderer(bashPresentation());

    assert.deepEqual(
        renderer.renderCall({
            purpose: "Build the native helper",
            command: "npm run build\nnpm test",
            timeout: 300,
        }, plainTheme, ToolDisplayMode.FULL).render(120),
        [
            "bash | Build the native helper (timeout 300s)",
            "    npm run build",
            "    npm test",
        ],
    );
    assert.deepEqual(
        renderer.renderResult(
            {content: [{type: "text", text: "build complete"}]},
            plainTheme,
            {},
            ToolDisplayMode.FULL,
        ).render(120),
        ["", "build complete"],
    );
});

test("minimal presentation shows title arguments and hides successful or failed output", () => {
    const renderer = new ToolPresentationRenderer(bashPresentation());
    const args = {
        purpose: "Build the native helper",
        command: "npm run build",
        timeout: 300,
    };

    assert.deepEqual(
        renderer.renderCall(args, plainTheme, ToolDisplayMode.MINIMAL).render(120),
        ["bash | Build the native helper (timeout 300s)"],
    );
    assert.deepEqual(
        renderer.renderResult(
            {content: [{type: "text", text: "success"}]},
            plainTheme,
            {},
            ToolDisplayMode.MINIMAL,
        ).render(120),
        [],
    );
    assert.deepEqual(
        renderer.renderResult(
            {content: [{type: "text", text: "failure details"}]},
            plainTheme,
            {isError: true},
            ToolDisplayMode.MINIMAL,
        ).render(120),
        [],
    );
});

test("truncated presentation keeps argument heads and output tails", () => {
    const renderer = new ToolPresentationRenderer(bashPresentation());
    const call = renderer.renderCall({
        purpose: "Exercise truncation",
        command: numberedLines(10),
    }, plainTheme, ToolDisplayMode.TRUNCATED).render(120);
    const result = renderer.renderResult(
        {content: [{type: "text", text: numberedLines(8)}]},
        plainTheme,
        {},
        ToolDisplayMode.TRUNCATED,
    ).render(120);

    assert.deepEqual(call.slice(0, 3), [
        "bash | Exercise truncation",
        "    line 1",
        "    line 2",
    ]);
    assert.equal(call.at(-1), "    ... (2 more lines)");
    assert.equal(result[1]?.includes("3 earlier lines"), true);
    assert.deepEqual(result.slice(-5), ["line 4", "line 5", "line 6", "line 7", "line 8"]);
});

test("known arguments retain declared order, unknown arguments sort, and blocks render last", () => {
    type Args = {block: string; known: string};
    const presentation = {
        toolName: "ordered",
        arguments: [
            {key: "block", layout: ToolArgumentLayout.BLOCK},
            {key: "known"},
        ],
    } satisfies ToolPresentationSpec<Args>;
    const renderer = new ToolPresentationRenderer(presentation);

    assert.deepEqual(
        renderer.renderCall({
            block: "configured block",
            known: "configured inline",
            zeta: 2,
            alpha: 1,
            unknownBlock: "first\nsecond",
        } as Args, plainTheme, ToolDisplayMode.FULL).render(120),
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

test("body argument values honor configured colors", () => {
    type Args = {inline: string; block: string};
    const presentation = {
        toolName: "colored",
        arguments: [
            {key: "inline", color: ThemeColor.warning},
            {key: "block", layout: ToolArgumentLayout.BLOCK, color: ThemeColor.text},
        ],
    } satisfies ToolPresentationSpec<Args>;
    const colorTheme = {
        fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
        bold: (text: string) => text,
    } as unknown as Theme;
    const renderer = new ToolPresentationRenderer(presentation);

    assert.deepEqual(
        renderer.renderCall({inline: "configured inline", block: "first\nsecond"}, colorTheme, ToolDisplayMode.FULL)
            .render(120),
        [
            "<toolTitle>colored</toolTitle>",
            "    <dim>inline:</dim> <warning>configured inline</warning>",
            "    <dim>block:</dim>",
            "        <text>first</text>",
            "        <text>second</text>",
        ],
    );
});

test("full presentation retains hard row and terminal-width limits", () => {
    type Args = {content: string};
    const presentation = {
        toolName: "bounded",
        maxCallLines: 6,
        arguments: [{key: "content", layout: ToolArgumentLayout.BLOCK}],
        result: {direction: ToolTextDirection.TAIL, maxFullLines: 4},
    } satisfies ToolPresentationSpec<Args>;
    const renderer = new ToolPresentationRenderer(presentation);

    const callLines = renderer.renderCall(
        {content: numberedLines(20)},
        plainTheme,
        ToolDisplayMode.FULL,
    ).render(20);
    assert.equal(callLines.length, 6);
    assert.equal(callLines[5], "... (16 lines omitt…");
    assert.equal(callLines.every((line) => displayWidth(line) <= 20), true);
    assert.deepEqual(
        renderer.renderResult(
            {content: [{type: "text", text: numberedLines(10)}]},
            plainTheme,
            {},
            ToolDisplayMode.FULL,
        ).render(120),
        ["", "... (7 lines omitted from display)", "line 8", "line 9", "line 10"],
    );
});

test("every display mode enforces Pi's width contract", () => {
    const renderer = new ToolPresentationRenderer(bashPresentation());
    const ansiTheme = {
        fg: (_color: string, text: string) => `\x1b[31m${text}\x1b[39m`,
        bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
    } as unknown as Theme;
    const args = {
        purpose: "◽ purpose ".repeat(20),
        command: "printf '界🙂' ".repeat(20),
    };
    const result = {content: [{type: "text", text: "👨‍👩‍👧‍👦 output ◽ ".repeat(20)}]};

    for (const mode of Object.values(ToolDisplayMode)) {
        for (const width of [1, 2, 10, 20]) {
            const lines = [
                ...renderer.renderCall(args, ansiTheme, mode).render(width),
                ...renderer.renderResult(result, ansiTheme, {}, mode).render(width),
            ];
            assert.equal(
                lines.every((line) => displayWidth(line) <= width),
                true,
                `${mode} produced an over-wide line at width ${width}`,
            );
        }
    }
});

test("character safety limits retain the configured head or tail boundary", () => {
    type Args = {content: string};
    const presentation = {
        toolName: "character-bounded",
        arguments: [{key: "content", layout: ToolArgumentLayout.BLOCK, maxCharacters: 5}],
        result: {direction: ToolTextDirection.TAIL, maxCharacters: 5},
    } satisfies ToolPresentationSpec<Args>;
    const renderer = new ToolPresentationRenderer(presentation);

    assert.deepEqual(
        renderer.renderCall({content: "abcdefghij"}, plainTheme, ToolDisplayMode.FULL).render(120),
        ["character-bounded", "    abcde", "    [display truncated]"],
    );
    assert.deepEqual(
        renderer.renderResult(
            {content: [{type: "text", text: "abcdefghij"}]},
            plainTheme,
            {},
            ToolDisplayMode.FULL,
        ).render(120),
        ["", "[display truncated]", "fghij"],
    );
});

test("secondary owners consume declared arguments and retain independent title parts", () => {
    type Args = {path: string; offset?: number; limit?: number; encoding?: string};
    const presentation = {
        toolName: "read",
        arguments: [
            {key: "path", placement: ToolArgumentPlacement.TITLE_PRIMARY, color: ThemeColor.text},
            {
                key: "offset",
                placement: ToolArgumentPlacement.TITLE_SECONDARY,
                color: ThemeColor.warning,
                format: (_value, args) => {
                    const from = args.offset ?? 1;
                    return args.limit === undefined ? `:${from}` : `:${from}-${from + args.limit - 1}`;
                },
            },
            {key: "limit", placement: ToolArgumentPlacement.TITLE_SECONDARY, consumedBy: "offset"},
            {
                key: "encoding",
                placement: ToolArgumentPlacement.TITLE_SECONDARY,
                format: (value) => ` (${String(value)})`,
            },
        ],
    } satisfies ToolPresentationSpec<Args>;
    const renderer = new ToolPresentationRenderer(presentation);

    assert.deepEqual(
        renderer.renderCall(
            {path: "file.txt", offset: 2, limit: 2, encoding: "utf8"},
            plainTheme,
            ToolDisplayMode.MINIMAL,
        ).render(120),
        ["read | file.txt:2-3 (utf8)"],
    );
    assert.deepEqual(
        renderer.renderCall({path: "file.txt", limit: 2}, plainTheme, ToolDisplayMode.MINIMAL).render(120),
        ["read | file.txt:1-2"],
    );
});

test("presentation specifications reject ambiguous argument declarations", () => {
    type Args = {value: string};
    assert.throws(
        () => new ToolPresentationRenderer({
            toolName: "duplicate",
            arguments: [{key: "value"}, {key: "value"}],
        } satisfies ToolPresentationSpec<Args>),
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
        } satisfies ToolPresentationSpec<{value: string; owner: string}>),
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
            {key: "purpose", placement: ToolArgumentPlacement.TITLE_PRIMARY},
            {
                key: "timeout",
                placement: ToolArgumentPlacement.TITLE_SECONDARY,
                format: (value) => ` (timeout ${String(value)}s)`,
            },
            {key: "command", layout: ToolArgumentLayout.BLOCK, direction: ToolTextDirection.HEAD},
        ],
        result: {direction: ToolTextDirection.TAIL},
    };
}

function numberedLines(count: number): string {
    return Array.from({length: count}, (_, index) => `line ${index + 1}`).join("\n");
}
