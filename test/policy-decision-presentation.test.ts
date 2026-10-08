import assert from "node:assert/strict";
import test from "node:test";
import type {ExtensionContext} from "@earendil-works/pi-coding-agent";
import {KeybindingsManager, TUI_KEYBINDINGS, stripTerminalSequences, visibleWidth} from "@earendil-works/pi-tui";
import type {PolicyApprovalRequestContext} from "../src/policy/AgentPolicyDecisionFlow.js";
import {PolicyDecisionFlow} from "../src/policy/PolicyDecisionFlow.js";
import {policyScopeHierarchy} from "../src/policy/PolicyScope.js";
import {PolicyAccessType, PolicyLifetime, PolicyResponse} from "../src/policy/types.js";
import {UiDecisionFlowManager, type UiDecision} from "../src/tui/UiDecisionFlowManager.js";
import type {TextComponent} from "../src/tui/terminalText.js";

type PromptFactory<T> = (
    tui: {requestRender(): void; terminal: {rows: number}},
    theme: {fg(name: string, value: string): string; bg(name: string, value: string): string; bold(value: string): string},
    keybindings: KeybindingsManager,
    done: (value: T) => void,
) => TextComponent;

class PromptHarness {
    readonly prompts: TextComponent[] = [];
    readonly inputTitles: string[] = [];
    readonly terminal = {rows: 30};
    readonly keybindings = new KeybindingsManager(TUI_KEYBINDINGS);
    readonly context: ExtensionContext;
    renderRequests = 0;
    completions = 0;
    color = 36;
    inputResult: string | undefined = "";

    constructor() {
        this.context = {
            hasUI: true,
            mode: "tui",
            ui: {
                select: async () => assert.fail("interactive policy selections must use the custom component"),
                input: async (title: string) => {
                    this.inputTitles.push(title);
                    return this.inputResult;
                },
                custom: <T>(factory: PromptFactory<T>): Promise<T> => new Promise((resolve) => {
                    const component = factory({
                        terminal: this.terminal,
                        requestRender: () => this.renderRequests++,
                    }, {
                        fg: (_name, value) => `\x1b[${this.color}m${value}\x1b[0m`,
                        bg: (_name, value) => `\x1b[44m${value}\x1b[0m`,
                        bold: (value) => `\x1b[1m${value}\x1b[0m`,
                    }, this.keybindings, (value) => {
                        this.completions++;
                        resolve(value);
                    });
                    this.prompts.push(component);
                }),
            },
        } as unknown as ExtensionContext;
    }

    flow(): PolicyDecisionFlow {
        return new PolicyDecisionFlow({decisionFlows: new UiDecisionFlowManager(this.context)});
    }

    async prompt(index = this.prompts.length - 1): Promise<TextComponent> {
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.ok(this.prompts[index], `prompt ${index} was not opened`);
        return this.prompts[index]!;
    }
}

const target = "/tmp/pilot-policy-presentation/source/file.ts";
const request: PolicyApprovalRequestContext = {
    requestId: "request-42",
    requestingAgentIdentifier: "child-7",
    ancestry: [
        {agentIdentifier: "root-1", role: "Root agent", task: "Implement the feature"},
        {agentIdentifier: "child-7", role: "Reviewer", task: "Review the generated file"},
    ],
    toolCall: {
        toolName: "bash",
        toolCallId: "bash-3",
        purpose: "Update generated output",
        command: "printf '%s\\n' updated > source/file.ts",
    },
};

function plain(component: TextComponent, width = 80): string {
    return component.render(width).map(stripTerminalSequences).join("\n");
}

function key(component: TextComponent, input: string): void {
    assert.ok(component.handleInput);
    component.handleInput(input);
}

test("human policy selections separate the heading, request fields, choices, and hints", async () => {
    const harness = new PromptHarness();
    const result = harness.flow().askForPolicy(target, PolicyAccessType.FS_WRITE, undefined, request);
    const scope = await harness.prompt(0);
    const rendered = plain(scope);
    assert.equal(stripTerminalSequences(scope.render(80)[0]!), "Path policy scope · 1/3");
    assert.match(rendered, /Access: Write files \(FS_WRITE\)/);
    assert.match(rendered, /Target: \/tmp\/pilot-policy-presentation\/source\/file\.ts/);
    assert.match(rendered, /Tool: bash/);
    assert.match(rendered, /Purpose: Update generated output/);
    assert.match(rendered, /Command: printf/);
    assert.match(rendered, /› \/tmp\/pilot-policy-presentation\/source\/file\.ts/);
    assert.match(rendered, /← deny once.*→ allow once/);
    assert.match(rendered, /tab full request/);
    assert.equal(rendered.includes("Authority ancestry"), false);
    assert.equal(scope.render(80).slice(2).some((line) => line.includes("\x1b[1m")), false);

    key(scope, "\r");
    const status = await harness.prompt(1);
    assert.match(plain(status), /Path policy decision · 2\/3/);
    assert.match(plain(status), /Scope: \/tmp\/pilot-policy-presentation\/source\/file\.ts/);
    key(status, "\r");
    const lifetime = await harness.prompt(2);
    assert.match(plain(lifetime), /Path policy lifetime · 3\/3/);
    assert.match(plain(lifetime), /Decision: Allow/);
    assert.match(plain(lifetime), /This session/);
    assert.match(plain(lifetime), /Always on this computer/);
    assert.equal(plain(lifetime).includes("Always synchronized"), false);
    key(lifetime, "\r");
    assert.deepEqual(await result, {
        uri: target,
        accessType: PolicyAccessType.FS_WRITE,
        status: PolicyResponse.ALLOWED,
        lifetime: PolicyLifetime.ONCE,
        reason: "User selected ALLOWED for FS_WRITE.",
    });
    assert.equal(harness.inputTitles.length, 0);
});

test("long Unicode requests stay bounded and the full request remains scrollable", async () => {
    const harness = new PromptHarness();
    const longTarget = `/tmp/${"nested/".repeat(15)}界🙂é-file.ts`;
    const command = Array.from({length: 30}, (_, index) => `printf '界🙂é ${index}'`).join("\n") + "\nCOMMAND_END";
    const result = harness.flow().askForPolicy(longTarget, PolicyAccessType.FS_WRITE, undefined, {
        ...request,
        toolCall: {...request.toolCall, command},
    });
    const component = await harness.prompt(0);
    for (const rows of [6, 8, 10, 12, 24, 40]) {
        harness.terminal.rows = rows;
        for (const width of [0, 0.5, 1, 2, 7.9, 30, 42, 80]) {
            for (const line of component.render(width)) {
                assert.ok(visibleWidth(line) <= Math.floor(width));
                assert.equal(/[\r\n]/.test(line), false);
            }
            assert.ok(component.render(width).length <= rows - 2);
        }
        assert.match(plain(component, 42), /›/);
    }
    key(component, "\t");
    for (const rows of [6, 8, 10, 12, 24, 40]) {
        harness.terminal.rows = rows;
        for (const width of [0, 0.5, 1, 2, 7.9, 30, 42, 80]) {
            const lines = component.render(width);
            assert.ok(lines.length <= rows - 2);
            assert.ok(lines.every((line) => visibleWidth(line) <= Math.floor(width)));
        }
    }
    harness.terminal.rows = 24;
    let observed = plain(component, 42);
    assert.match(observed, /Selected option:/);
    assert.match(observed, /Request lines/);
    for (let index = 0; index < 160; index++) {
        key(component, "\x1b[B");
        observed += `\n${plain(component, 42)}`;
    }
    for (const text of ["COMMAND_END", "Policy request: request-42", "Tool call: bash-3", "Root agent", "Reviewer"]) {
        assert.ok(observed.includes(text), `full request lost ${text}`);
    }
    const finalPage = plain(component, 42);
    key(component, "\x1b[B");
    assert.equal(plain(component, 42), finalPage);
    harness.terminal.rows = 12;
    assert.ok(component.render(30).length <= 10);
    key(component, "\t");
    key(component, "\r");
    const status = await harness.prompt(1);
    key(status, "\x1b[C");
    assert.equal((await result).uri, longTarget.normalize("NFC"));
});

test("display escaping and theme changes do not alter the selected scope value", async () => {
    const harness = new PromptHarness();
    const unsafe = "scope\x1b[31m\t\u202e";
    const decision: UiDecision<{choice: string}> = {
        type: "select",
        key: "choice",
        title: "Choose a scope",
        context: {summary: [{label: "Target", value: unsafe}], details: []},
        options: [{title: unsafe, value: unsafe, next: null}],
    };
    const result = new UiDecisionFlowManager(harness.context).runFlow(
        decision, {choice: decision}, () => ({choice: "cancelled"}), {shortcuts: {enabled: true}},
    );
    const component = await harness.prompt(0);
    assert.match(plain(component), /scope\\u001b\[31m\\u0009\\u202e/);
    assert.equal(component.render(80).join("\n").includes("\x1b[31m"), false);
    harness.color = 35;
    component.invalidate();
    assert.ok(component.render(80)[0]!.includes("\x1b[35m"));
    key(component, "\r");
    assert.deepEqual(await result, {choice: unsafe});
    key(component, "\x1b[C");
    assert.equal(harness.completions, 1);
});

test("request review preserves configured navigation and selection wrapping", async () => {
    const harness = new PromptHarness();
    harness.keybindings.setUserBindings({"tui.select.up": "k", "tui.select.down": "j", "tui.input.tab": "ctrl+t"});
    const result = harness.flow().askForPolicy(target, PolicyAccessType.FS_READ);
    const component = await harness.prompt(0);
    assert.match(plain(component), /kj move/);
    assert.match(plain(component), /ctrl\+t full request/);
    key(component, "k");
    assert.match(plain(component), /› \//);
    key(component, "\x14");
    key(component, "j");
    component.render(80);
    key(component, "\x14");
    key(component, "j");
    key(component, "\r");
    const status = await harness.prompt(1);
    assert.match(plain(status), /Scope: \/tmp\/pilot-policy-presentation\/source\/file\.ts/);
    key(status, "\x1b[D");
    assert.equal((await result).status, PolicyResponse.DENIED);
});

for (const step of [0, 1, 2]) {
    for (const [input, status] of [["\x1b[C", PolicyResponse.ALLOWED], ["\x1b[D", PolicyResponse.DENIED]] as const) {
        test(`${status} once shortcut at select step ${step + 1} still applies to the exact target`, async () => {
            const harness = new PromptHarness();
            const result = harness.flow().askForPolicy(target, PolicyAccessType.FS_WRITE);
            let component = await harness.prompt(0);
            if (step > 0) {
                key(component, "\x1b[B");
                key(component, "\r");
                component = await harness.prompt(1);
                if (step > 1) {
                    key(component, "\x1b[B");
                    key(component, "\r");
                    component = await harness.prompt(2);
                }
            }
            key(component, "\t");
            key(component, input);
            const choice = await result;
            assert.equal(choice.uri, target);
            assert.equal(choice.lifetime, PolicyLifetime.ONCE);
            assert.equal(choice.status, status);
            assert.equal(harness.prompts.length, step + 1);
            assert.equal(harness.inputTitles.length, 0);
        });
    }
}

for (const step of [0, 1, 2]) {
    test(`cancelling select step ${step + 1} remains a once-only denial`, async () => {
        const harness = new PromptHarness();
        const controller = new AbortController();
        const result = harness.flow().askForPolicy(target, PolicyAccessType.FS_WRITE, controller.signal);
        let component = await harness.prompt(0);
        if (step > 0) {
            key(component, "\x1b[B");
            key(component, "\r");
            component = await harness.prompt(1);
            if (step > 1) {
                key(component, "\r");
                component = await harness.prompt(2);
            }
        }
        key(component, "\t");
        controller.abort();
        key(component, "\x1b[C");
        const choice = await result;
        assert.equal(choice.uri, step === 0 ? target : policyScopeHierarchy(target, PolicyAccessType.FS_WRITE)[1]);
        assert.equal(choice.status, PolicyResponse.DENIED);
        assert.equal(choice.lifetime, PolicyLifetime.ONCE);
        assert.match(choice.reason, /Access denied: No uri policy/);
        assert.equal(harness.completions, step + 1);
    });
}

test("denial reason input retains the selected scope and unmodified user text", async () => {
    const harness = new PromptHarness();
    const reason = "Do not overwrite this file.\nKeep the original.";
    harness.inputResult = reason;
    const result = harness.flow().askForPolicy(target, PolicyAccessType.FS_WRITE, undefined, request);
    key(await harness.prompt(0), "\r");
    const status = await harness.prompt(1);
    key(status, "\x1b[B");
    key(status, "\r");
    key(await harness.prompt(2), "\r");
    const choice = await result;
    assert.equal(choice.status, PolicyResponse.DENIED);
    assert.equal(choice.reason, reason);
    assert.match(harness.inputTitles[0]!, /Scope: \/tmp\/pilot-policy-presentation\/source\/file\.ts/);
    assert.match(harness.inputTitles[0]!, /Decision: Deny/);
    assert.match(harness.inputTitles[0]!, /Policy request: request-42/);
});

test("network selections retain canonical scopes and all four lifetimes", async () => {
    const harness = new PromptHarness();
    const result = harness.flow().askForPolicy("localhost:3000", PolicyAccessType.TCP_ACCESS);
    const scope = await harness.prompt(0);
    assert.match(plain(scope), /Network policy scope · 1\/3/);
    assert.match(plain(scope), /Access: TCP/);
    assert.match(plain(scope), /Target: localhost:3000/);
    key(scope, "\x1b[B");
    key(scope, "\r");
    key(await harness.prompt(1), "\r");
    const lifetime = await harness.prompt(2);
    assert.match(plain(lifetime), /Scope: localhost/);
    assert.match(plain(lifetime), /Always synchronized/);
    key(lifetime, "\x1b[A");
    key(lifetime, "\r");
    const choice = await result;
    assert.equal(choice.uri, "localhost");
    assert.equal(choice.status, PolicyResponse.ALLOWED);
    assert.equal(choice.lifetime, PolicyLifetime.GLOBAL);
});

test("compact terminals keep target and selected state visible before allocating extra choices", async () => {
    const harness = new PromptHarness();
    harness.terminal.rows = 12;
    const result = harness.flow().askForPolicy(target, PolicyAccessType.FS_WRITE, undefined, request);
    const scope = await harness.prompt(0);
    assert.match(plain(scope, 30), /Access:/);
    assert.match(plain(scope, 30), /Target:/);
    assert.match(plain(scope, 30), /esc cancel/);
    assert.match(plain(scope, 30), /← deny once.*→ allow once/);
    key(scope, "\r");
    const status = await harness.prompt(1);
    assert.match(plain(status, 30), /Scope:/);
    key(status, "\r");
    const lifetime = await harness.prompt(2);
    for (const label of ["Access:", "Target:", "Scope:", "Decision: Allow"]) {
        assert.ok(plain(lifetime, 30).includes(label), `compact lifetime view lost ${label}`);
    }
    key(lifetime, "\r");
    assert.equal((await result).status, PolicyResponse.ALLOWED);
});

for (const [input, expected] of [["\x1b[5~", PolicyResponse.DENIED], ["\x1b[6~", PolicyResponse.ALLOWED]] as const) {
    test(`request view preserves the ${expected} once Page shortcut`, async () => {
        const harness = new PromptHarness();
        const result = harness.flow().askForPolicy(target, PolicyAccessType.FS_WRITE);
        const component = await harness.prompt(0);
        key(component, "\t");
        key(component, input);
        const choice = await result;
        assert.equal(choice.uri, target);
        assert.equal(choice.status, expected);
        assert.equal(choice.lifetime, PolicyLifetime.ONCE);
    });
}

for (const [input, expected] of [["h", PolicyResponse.DENIED], ["l", PolicyResponse.ALLOWED]] as const) {
    test(`request view preserves the configured ${expected} once shortcut`, async () => {
        const harness = new PromptHarness();
        harness.keybindings.setUserBindings({"tui.editor.cursorLeft": "h", "tui.editor.cursorRight": "l"});
        const result = harness.flow().askForPolicy(target, PolicyAccessType.FS_WRITE);
        const component = await harness.prompt(0);
        assert.match(plain(component), /h deny once.*l allow once/);
        key(component, "\t");
        key(component, input);
        assert.equal((await result).status, expected);
    });
}

for (const mode of ["rpc", "tui"] as const) {
    test(`${mode} dialog fallback retains plain request context and canonical option values`, async () => {
        const titles: string[] = [];
        const optionLists: string[][] = [];
        const context = {
            hasUI: true,
            mode,
            ui: {
                select: async (title: string, options: string[]) => {
                    titles.push(title);
                    optionLists.push(options);
                    if (titles.length === 1) return options[1];
                    if (titles.length === 2) return "Allow";
                    return "This session";
                },
                ...(mode === "rpc" ? {custom: () => assert.fail("RPC must never invoke terminal custom UI")} : {}),
            },
        } as unknown as ExtensionContext;
        const choice = await new PolicyDecisionFlow({decisionFlows: new UiDecisionFlowManager(context)}).askForPolicy(
            target, PolicyAccessType.FS_WRITE, undefined,
            {...request, toolCall: {...request.toolCall, command: "first\nsecond\x1b[31m"}},
        );
        assert.deepEqual(optionLists[0], policyScopeHierarchy(target, PolicyAccessType.FS_WRITE));
        for (const title of titles) {
            assert.equal(title.includes("\x1b"), false);
            for (const text of ["Access: Write files (FS_WRITE)", target, "Tool: bash", "Command: first\n  second\\u001b[31m",
                "Policy request: request-42", "Tool call: bash-3", "Root agent [root-1]", "Reviewer [child-7]"]) {
                assert.ok(title.includes(text), `fallback lost ${text}`);
            }
        }
        assert.equal(choice.uri, policyScopeHierarchy(target, PolicyAccessType.FS_WRITE)[1]);
        assert.equal(choice.status, PolicyResponse.ALLOWED);
        assert.equal(choice.lifetime, PolicyLifetime.SESSION);
    });
}

test("resizing long-target decisions never trades selected scope and decision for extra choices", async () => {
    const harness = new PromptHarness();
    const longTarget = `/tmp/${"long-directory-name/".repeat(10)}source/file.ts`;
    const result = harness.flow().askForPolicy(longTarget, PolicyAccessType.FS_WRITE, undefined, request);
    const scope = await harness.prompt(0);
    key(scope, "\x1b[B");
    key(scope, "\r");
    key(await harness.prompt(1), "\r");
    const lifetime = await harness.prompt(2);
    for (const rows of [12, 16, 18, 24, 40]) {
        harness.terminal.rows = rows;
        const view = plain(lifetime, 30);
        for (const label of ["Access:", "Target:", "Scope:", "Decision: Allow"]) {
            assert.ok(view.includes(label), `${rows}-row lifetime view lost ${label}`);
        }
        assert.ok(lifetime.render(30).length <= rows - 2);
    }
    key(lifetime, "\r");
    assert.equal((await result).uri, policyScopeHierarchy(longTarget, PolicyAccessType.FS_WRITE)[1]);
});

test("compact shortcut hints retain both once actions with multi-character keybindings", async () => {
    const harness = new PromptHarness();
    harness.keybindings.setUserBindings({"tui.editor.cursorLeft": "ctrl+b", "tui.editor.cursorRight": "ctrl+f"});
    const result = harness.flow().askForPolicy(target, PolicyAccessType.FS_WRITE);
    const component = await harness.prompt(0);
    assert.match(plain(component, 30), /Once ctrl\+b:deny ctrl\+f:allow/);
    key(component, "\x06");
    assert.equal((await result).status, PolicyResponse.ALLOWED);
});

test("configured confirmation and cancellation still resolve the original decision flow", async () => {
    const harness = new PromptHarness();
    harness.keybindings.setUserBindings({"tui.select.confirm": "space", "tui.select.cancel": "q"});
    const result = harness.flow().askForPolicy(target, PolicyAccessType.FS_WRITE);
    const scope = await harness.prompt(0);
    assert.match(plain(scope), /space select.*q cancel/);
    key(scope, " ");
    key(await harness.prompt(1), " ");
    const lifetime = await harness.prompt(2);
    key(lifetime, "\x1b[B");
    key(lifetime, " ");
    assert.equal((await result).lifetime, PolicyLifetime.SESSION);

    const cancelled = harness.flow().askForPolicy(target, PolicyAccessType.FS_WRITE);
    const cancelPrompt = await harness.prompt(3);
    key(cancelPrompt, "\t");
    key(cancelPrompt, "q");
    const choice = await cancelled;
    assert.equal(choice.status, PolicyResponse.DENIED);
    assert.equal(choice.lifetime, PolicyLifetime.ONCE);
});

for (const input of ["", undefined]) {
    test(`${input === undefined ? "cancelled" : "empty"} denial input preserves its distinct result`, async () => {
        const harness = new PromptHarness();
        harness.inputResult = input;
        const result = harness.flow().askForPolicy(target, PolicyAccessType.FS_WRITE);
        const scope = await harness.prompt(0);
        key(scope, "\x1b[B");
        key(scope, "\r");
        const status = await harness.prompt(1);
        key(status, "\x1b[B");
        key(status, "\r");
        const lifetime = await harness.prompt(2);
        key(lifetime, "\x1b[B");
        key(lifetime, "\r");
        const choice = await result;
        assert.equal(choice.uri, policyScopeHierarchy(target, PolicyAccessType.FS_WRITE)[1]);
        assert.equal(choice.status, PolicyResponse.DENIED);
        assert.equal(choice.lifetime, input === undefined ? PolicyLifetime.ONCE : PolicyLifetime.SESSION);
        assert.equal(choice.reason, input === undefined
            ? "Access denied: No uri policy denial reason was completed."
            : "User selected DENIED for FS_WRITE.");
    });
}
