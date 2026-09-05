import assert from "node:assert/strict";
import test from "node:test";
import {
    initTheme,
    ToolExecutionComponent,
    type ExtensionAPI,
    type Theme,
    type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
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
import {ToolDisplayRows} from "../src/tui/tool/ToolDisplayRows.js";
import {ViewFullToolCommand} from "../src/commands/ViewFullToolCommand.js";

const plainTheme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
} as unknown as Theme;

test("view-full-tool bounds the chronological window and toggles rows without closing", async () => {
    const rows = new ToolDisplayRows();
    const states = Array.from({length: 20}, () => ({} as {pilotFullDisplay?: boolean}));
    const invalidations = Array.from({length: 20}, () => 0);
    for (let index = 0; index < states.length; index++) {
        rows.observe("bash", {purpose: `Call ${index + 1}`}, {
            toolCallId: `call-${index + 1}`,
            state: states[index]!,
            invalidate: () => invalidations[index]++,
        });
    }

    let command: {handler(args: string, ctx: any): Promise<void>} | undefined;
    new ViewFullToolCommand({
        registerCommand(_name, options) {
            command = options as typeof command;
        },
    } as ExtensionAPI, rows).register();
    assert.ok(command);

    await command.handler("", {
        ui: {
            async custom(factory: any) {
                let closed = false;
                const component = factory(
                    {requestRender() {}},
                    plainTheme,
                    {
                        matches(data: string, keybinding: string) {
                            return (data === "\r" && keybinding === "tui.select.confirm")
                                || (data === "\x1b" && keybinding === "tui.select.cancel");
                        },
                    },
                    () => closed = true,
                );
                const optionLines = component.render(120)
                    .filter((line: string) => line.includes("○") || line.includes("●"));
                assert.equal(optionLines.length, 6);
                assert.match(optionLines[0]!, /15\. bash — Call 15/);
                assert.match(optionLines.at(-1)!, /^→ ○ 20\. bash — Call 20/);
                assert.equal(optionLines.some((line: string) => /14\. bash — Call 14/.test(line)), false);

                component.handleInput("\r");
                assert.equal(closed, false);
                assert.match(
                    component.render(120).find((line: string) => line.startsWith("→"))!,
                    /^→ ● 20\. bash — Call 20/,
                );

                component.handleInput("\x1b");
                assert.equal(closed, true);
            },
            notify() {},
        },
    });

    assert.equal(states[19]!.pilotFullDisplay, true);
    assert.equal(states.slice(0, -1).every((state) => state.pilotFullDisplay === undefined), true);
    assert.equal(invalidations[19], 1);
    assert.equal(invalidations.slice(0, -1).every((count) => count === 0), true);
});

test("self-shell composition keeps symbolic content free of fill-to-width whitespace", () => {
    initTheme("dark");
    type Args = {path: string; content: string};
    const presentation = new ToolPresentationRenderer({
        toolName: "symbol_test",
        arguments: [
            {key: "path", placement: ToolArgumentPlacement.TITLE_PRIMARY},
            {key: "content", layout: ToolArgumentLayout.BLOCK},
        ],
        result: {direction: ToolTextDirection.HEAD},
    } satisfies ToolPresentationSpec<Args>);
    const definition = {
        name: "symbol_test",
        label: "Symbol test",
        description: "Exercise copy-safe symbolic rendering",
        parameters: {type: "object", properties: {}},
        renderShell: "self",
        async execute() {
            return {content: [{type: "text" as const, text: "unused"}], details: undefined};
        },
        renderCall: (args, theme, context) => presentation.renderCall(
            args as Args,
            theme,
            ToolDisplayMode.TRUNCATED,
            {isPartial: context.isPartial, isError: context.isError},
        ),
        renderResult: (result, _options, theme, context) => presentation.renderResult(
            result,
            theme,
            {isError: context.isError},
            ToolDisplayMode.TRUNCATED,
        ),
    } as ToolDefinition<any, any>;
    const args = {path: "symbols-◽.txt", content: "界🙂e\u0301 → value"};
    const component = new ToolExecutionComponent(
        definition.name,
        "symbol-call",
        args,
        {},
        definition,
        {requestRender() {}} as any,
        process.cwd(),
    );
    component.setArgsComplete();
    component.markExecutionStarted();
    component.updateResult({
        content: [{type: "text", text: "family 👨‍👩‍👧‍👦 · math ∑"}],
        isError: false,
    });

    const plainLines = component.render(80).map(stripAnsi);
    assert.equal(plainLines.includes("界🙂e\u0301 → value"), true);
    assert.equal(plainLines.includes("family 👨‍👩‍👧‍👦 · math ∑"), true);
    assert.equal(plainLines.every((line) => !/[ \t]+$/.test(line)), true);
    assert.equal(plainLines.some((line) => /^\s+界/.test(line)), false);
});

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
            "npm run build",
            "npm test",
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

test("tool headers show lifecycle state without adding a padded shell", () => {
    const renderer = new ToolPresentationRenderer(bashPresentation());
    const args = {purpose: "Check lifecycle", command: "true"};

    assert.deepEqual(
        renderer.renderCall(args, plainTheme, ToolDisplayMode.MINIMAL, {isPartial: true}).render(120),
        ["· bash | Check lifecycle"],
    );
    assert.deepEqual(
        renderer.renderCall(args, plainTheme, ToolDisplayMode.MINIMAL, {isPartial: false}).render(120),
        ["✓ bash | Check lifecycle"],
    );
    assert.deepEqual(
        renderer.renderCall(args, plainTheme, ToolDisplayMode.MINIMAL, {isPartial: false, isError: true}).render(120),
        ["× bash | Check lifecycle"],
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

test("every display mode formats the same header once and only expanded modes format the body", () => {
    type Args = {block: string; path: string; range: string; note: string};
    const formatted: string[] = [];
    const format = (key: string, value: unknown): string => {
        formatted.push(key);
        return String(value);
    };
    const renderer = new ToolPresentationRenderer<Args>({
        toolName: "mixed",
        arguments: [
            {key: "block", layout: ToolArgumentLayout.BLOCK, format: (value) => format("block", value)},
            {key: "path", placement: ToolArgumentPlacement.TITLE_PRIMARY, format: (value) => format("path", value)},
            {key: "range", placement: ToolArgumentPlacement.TITLE_SECONDARY, format: (value) => format("range", value)},
            {key: "note", format: (value) => format("note", value)},
        ],
    });
    const args = {block: "line 1\nline 2", path: "file.txt", range: ":2", note: "first"};

    for (const mode of Object.values(ToolDisplayMode)) {
        formatted.length = 0;
        const lines = renderer.renderCall(args, plainTheme, mode, {isError: true}).render(120);
        assert.deepEqual(lines, mode === ToolDisplayMode.MINIMAL
            ? ["× mixed | file.txt:2"]
            : ["× mixed | file.txt:2", "note: first", "block:", "line 1", "line 2"]);
        assert.deepEqual(formatted, mode === ToolDisplayMode.MINIMAL
            ? ["path", "range"]
            : ["path", "range", "note", "block"]);
    }
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
        "line 1",
        "line 2",
    ]);
    assert.equal(call.at(-1), "... (2 more lines)");
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
            "known: configured inline",
            "alpha: 1",
            "zeta: 2",
            "block:",
            "configured block",
            "unknownBlock:",
            "first",
            "second",
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
            "<dim>inline:</dim> <warning>configured inline</warning>",
            "<dim>block:</dim>",
            "<text>first</text>",
            "<text>second</text>",
        ],
    );
});

test("result rows can select foreground colors without whole-line backgrounds", () => {
    type Args = Record<string, never>;
    const renderer = new ToolPresentationRenderer({
        toolName: "diff",
        arguments: [],
        result: {
            direction: ToolTextDirection.HEAD,
            color: (line) => line.startsWith("+") ? ThemeColor.toolDiffAdded : ThemeColor.toolDiffRemoved,
        },
    } satisfies ToolPresentationSpec<Args>);
    const colorTheme = {
        fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
        bold: (text: string) => text,
    } as unknown as Theme;

    assert.deepEqual(
        renderer.renderResult(
            {content: [{type: "text", text: "+added\n-removed"}]},
            colorTheme,
            {},
            ToolDisplayMode.FULL,
        ).render(120),
        [
            "",
            "<toolDiffAdded>+added</toolDiffAdded>",
            "<toolDiffRemoved>-removed</toolDiffRemoved>",
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
        ["character-bounded", "abcde", "[display truncated]"],
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

function stripAnsi(value: string): string {
    return value.replace(/\x1b\[[0-?]*[ -/]*m/g, "");
}

function numberedLines(count: number): string {
    return Array.from({length: count}, (_, index) => `line ${index + 1}`).join("\n");
}
