import assert from "node:assert/strict";
import {AsyncResource} from "node:async_hooks";
import {mkdtempSync, readFileSync, rmSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import {performance} from "node:perf_hooks";
import test, {type TestContext} from "node:test";
import {
    createAgentSession,
    DefaultResourceLoader,
    SessionManager,
    SettingsManager,
    type AgentToolResult,
    type CodemodeToolDetails,
    type ExtensionContext,
    type ExtensionToolContext,
    type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {CodemodeSourceError, parseCodemodeSource} from "@earendil-works/pi-codemode/source";
import {PolicyDecisionFlow} from "../src/policy/PolicyDecisionFlow.js";
import {PolicyRuntime} from "../src/policy/PolicyRuntime.js";
import {PolicyAccessType, PolicyArea, PolicyFallbackResponse, PolicyResponse, type Policy} from "../src/policy/types.js";
import {ApprovalWaitScope} from "../src/runtime/ApprovalWaitScope.js";
import type {PolicyDaoInterface} from "../src/storage/PolicyDao.js";
import {AgentMechanismCapability} from "../src/subagents/AgentCapability.js";
import {SubagentCoordinator} from "../src/subagents/SubagentCoordinator.js";
import {AUTO_SUBAGENT_MODEL, initialSubagentDefaults} from "../src/subagents/SubagentDefaults.js";
import {SubagentToolCatalog} from "../src/subagents/SubagentToolCatalog.js";
import {SubagentJobStatus, type SubagentChildSessionFactory} from "../src/subagents/types.js";
import {SubagentReasoningAmount, SubagentReasoningSkill} from "../src/subagents/SubagentReasoning.js";
import {createSubagentResourceLoader} from "../src/subagents/SdkSubagentSession.js";
import {CodemodeExtension} from "../src/tools/codemode/CodemodeExtension.js";
import {withApprovalAwareCodemodeTimeout} from "../src/tools/codemode/CodemodeExecutionTimeout.js";
import {SubagentSpawnTool} from "../src/tools/subagent/SubagentSpawnTool.js";
import {SubagentStatusTool} from "../src/tools/subagent/SubagentStatusTool.js";
import {UiDecisionFlowManager} from "../src/tui/UiDecisionFlowManager.js";
import {UiDecisionFlowQueue} from "../src/tui/UiDecisionFlowQueue.js";
import {ToolDisplayRows} from "../src/tui/tool/ToolDisplayRows.js";

type Result = AgentToolResult<CodemodeToolDetails | undefined>;
const context = {} as ExtensionToolContext;
const completed: Result = {content: [{type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n"}], details: {calls: []}};

test("codemode validates original options, preserves output budget, arguments, and source lines", async (t) => {
    const tick = clock(t);
    const parentSignal = new AbortController().signal;
    const original = {purpose: "Keep the original displayed", code: '  // @options: {"timeout_ms":100,"max_output_tokens":0}\r\nthrow new Error("fixture");\n'};
    const originalCode = original.code;
    let executionSignal: AbortSignal | undefined;
    let executionScope: ApprovalWaitScope | undefined;
    const onUpdate = () => {};
    const wrapped = withApprovalAwareCodemodeTimeout(async (id, params, signal, update, ctx) => {
        assert.equal(id, "options");
        assert.equal(ctx, context);
        assert.equal(update, onUpdate);
        assert.notEqual(params, original);
        assert.equal((params as typeof original).purpose, original.purpose);
        const parsed = parseCodemodeSource(params.code);
        assert.deepEqual(parsed.options, {maxOutputTokens: 0});
        assert.equal(parsed.code, parseCodemodeSource(originalCode).code);
        assert.equal(params.code.split("\n").length, originalCode.split("\n").length);
        executionSignal = signal;
        executionScope = ApprovalWaitScope.current();
        assert.ok(executionScope);
        assert.notEqual(signal, parentSignal);
        return completed;
    });
    assert.equal(await wrapped("options", original, parentSignal, onUpdate, context), completed);
    assert.equal(original.code, originalCode);
    assert.equal(ApprovalWaitScope.current(), undefined);
    tick(1000);
    assert.equal(executionSignal?.aborted, false, "completed calls dispose their wrapper timeout");
    assert.throws(() => executionScope!.setTimeout(() => {}, 1), /closed/);
});

test("codemode passes an unset timeout through unchanged and closes leaked wait tokens", async (t) => {
    const tick = clock(t);
    const parent = new ApprovalWaitScope();
    t.after(() => parent.close());
    const signal = new AbortController().signal;
    const params = {code: '// @options: {"max_output_tokens":7}\nreturn 1;'};
    let release!: () => void;
    const execute = withApprovalAwareCodemodeTimeout(async (_id, input, nativeSignal) => {
        assert.equal(input, params);
        assert.equal(nativeSignal, signal);
        const scope = ApprovalWaitScope.current();
        assert.ok(scope && scope !== parent);
        release = scope.beginWait();
        assert.equal(parent.waiting, true);
        tick(1_000_000);
        assert.equal(nativeSignal?.aborted, false);
        return completed;
    });
    assert.equal(await parent.run(() => execute("default", params, signal, undefined, context)), completed);
    assert.equal(parent.waiting, false);
    release();
    assert.equal(parent.waiting, false);
});

test("codemode rejects malformed source/options before native execution", async () => {
    let executions = 0;
    const execute = withApprovalAwareCodemodeTimeout(async () => { executions++; return completed; });
    for (const code of [
        "", " \n", "// @options: {}", "// @options: nope\nreturn 1;",
        "// @options: []\nreturn 1;", '// @options: {"unknown":1,"timeout_ms":100}\nreturn 1;',
        '// @options: {"timeout_ms":0}\nreturn 1;', '// @options: {"timeout_ms":1.5}\nreturn 1;',
        '// @options: {"timeout_ms":2147483648}\nreturn 1;',
        '// @options: {"max_output_tokens":-1,"timeout_ms":100}\nreturn 1;',
    ]) {
        await assert.rejects(execute("invalid", {code}, undefined, undefined, context), CodemodeSourceError);
    }
    assert.equal(executions, 0);
    assert.equal(ApprovalWaitScope.current(), undefined);
});

test("nested overlapping approval holds suspend only the remaining codemode timeout", async (t) => {
    const tick = clock(t);
    const parent = new ApprovalWaitScope();
    t.after(() => parent.close());
    let nativeSignal!: AbortSignal;
    let scope!: ApprovalWaitScope;
    let child!: ApprovalWaitScope;
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const ctx = Object.create(context, {executeTool: {value: () => {
        assert.equal(ApprovalWaitScope.current(), scope);
        child = new ApprovalWaitScope(scope);
        child.run(() => {
            releaseFirst = child.beginWait();
            releaseSecond = child.beginWait();
        });
    }}}) as ExtensionToolContext;
    const execute = withApprovalAwareCodemodeTimeout(async (_id, _params, signal, _update, nativeContext) => {
        nativeSignal = signal!;
        scope = ApprovalWaitScope.current()!;
        tick(40);
        nativeContext.executeTool("approval", {});
        return waitForAbort(nativeSignal);
    });
    const pending = parent.run(() => execute("held", {code: '// @options: {"timeout_ms":100}\nawait tools.approval({});'}, undefined, undefined, ctx));
    assert.ok(scope.waiting && child.waiting && parent.waiting);
    tick(1000);
    assert.equal(nativeSignal.aborted, false);
    releaseFirst();
    releaseFirst();
    tick(1000);
    assert.ok(scope.waiting && parent.waiting);
    assert.equal(nativeSignal.aborted, false, "the first release cannot resume an overlapping hold");
    releaseSecond();
    child.close();
    assert.equal(parent.waiting, false);
    tick(59);
    assert.equal(nativeSignal.aborted, false);
    tick(1);
    const result = await pending;
    assert.equal(result.isError, true);
    assert.match(resultText(result), /Script timed out: Execution timed out after 100 ms/);
    assert.doesNotMatch(resultText(result), /Script aborted:/);
    assert.equal(result.details?.calls[0]?.status, "cancelled");
});

test("ordinary nested work consumes the codemode budget rather than suspending it", async (t) => {
    const tick = clock(t);
    let scope!: ApprovalWaitScope;
    let signal!: AbortSignal;
    const execute = withApprovalAwareCodemodeTimeout(async (_id, _params, nativeSignal) => {
        scope = ApprovalWaitScope.current()!;
        signal = nativeSignal!;
        return waitForAbort(signal);
    });
    const pending = execute("work", {code: '// @options: {"timeout_ms":100}\nawait tools.work({});'}, undefined, undefined, context);
    assert.equal(scope.waiting, false);
    tick(100);
    assert.equal(signal.aborted, true);
    assert.match(resultText(await pending), /Script timed out:/);
});

test("parent cancellation still aborts a paused codemode and is never relabeled as timeout", async (t) => {
    const tick = clock(t);
    const parentScope = new ApprovalWaitScope();
    t.after(() => parentScope.close());
    const controller = new AbortController();
    let release!: () => void;
    let nativeSignal!: AbortSignal;
    const execute = withApprovalAwareCodemodeTimeout(async (_id, _params, signal) => {
        nativeSignal = signal!;
        release = ApprovalWaitScope.current()!.beginWait();
        return waitForAbort(nativeSignal);
    });
    const pending = parentScope.run(() => execute("cancel", {code: '// @options: {"timeout_ms":100}\nreturn 1;'}, controller.signal, undefined, context));
    tick(1000);
    assert.equal(nativeSignal.aborted, false);
    const reason = new Error("Parent explicitly stopped");
    controller.abort(reason);
    assert.equal(nativeSignal.reason, reason);
    const result = await pending;
    assert.match(resultText(result), /Script aborted: Parent explicitly stopped/);
    assert.doesNotMatch(resultText(result), /Script timed out/);
    assert.equal(parentScope.waiting, false, "closing the execution releases parent tokens even before approval settles");
    release();
    tick(1000);
    assert.equal(nativeSignal.reason, reason);
});

test("already-aborted parent keeps its original cancellation reason", async (t) => {
    const tick = clock(t);
    const controller = new AbortController();
    controller.abort(new Error("Already cancelled"));
    const execute = withApprovalAwareCodemodeTimeout(async (_id, _params, signal) => {
        assert.equal(signal!.reason, controller.signal.reason);
        tick(1000);
        return waitForAbort(signal!);
    });
    assert.match(resultText(await execute("cancel", {code: '// @options: {"timeout_ms":100}\nreturn 1;'}, controller.signal, undefined, context)), /Script aborted: Already cancelled/);
});

test("late wrapper timeout does not override a finalized native success or unrelated error", async (t) => {
    const tick = clock(t);
    const failed: Result = {content: [{type: "text", text: "Script error:\nError: original failure"}], details: {calls: []}, isError: true};
    for (const nativeResult of [completed, failed]) {
        const execute = withApprovalAwareCodemodeTimeout(async (_id, _params, signal) => {
            // Model the native VM finishing before asynchronous output spilling completes.
            tick(100);
            assert.equal(signal!.aborted, true);
            return nativeResult;
        });
        const result = await execute("late", {code: '// @options: {"timeout_ms":100}\nreturn 1;'}, undefined, undefined, context);
        assert.deepEqual(result, nativeResult);
    }
});

test("timeout normalization edits only a trailing native diagnostic, not matching script output", async (t) => {
    const tick = clock(t);
    const execute = withApprovalAwareCodemodeTimeout(async (_id, _params, signal) => {
        const pending = waitForAbort(signal!);
        tick(100);
        const nativeResult = await pending;
        return {
            ...nativeResult,
            content: [...nativeResult.content, {type: "text", text: "Script error:\nError: actual script failure"}],
        };
    });
    const result = await execute("script-output", {code: '// @options: {"timeout_ms":100}\nreturn 1;'}, undefined, undefined, context);
    assert.match(resultText(result), /Script aborted: Execution timed out/);
    assert.doesNotMatch(resultText(result), /Script timed out:/);
    assert.equal(result.content.at(-1)?.type, "text");
});

test("timeout reporting leaves spilled native output and its file untouched", async (t) => {
    const tick = clock(t);
    let nativeResult!: Result;
    const execute = withApprovalAwareCodemodeTimeout(async (_id, _params, signal) => {
        const pending = waitForAbort(signal!);
        tick(100);
        nativeResult = await pending;
        nativeResult.details!.fullOutputPath = "/native-owned/output.txt";
        return nativeResult;
    });
    const result = await execute("spill", {code: '// @options: {"timeout_ms":100,"max_output_tokens":0}\nreturn 1;'}, undefined, undefined, context);
    assert.equal(result, nativeResult);
    assert.match(resultText(result), /Script aborted: Execution timed out/);
    assert.equal(result.details?.fullOutputPath, "/native-owned/output.txt");
});

test("thrown native execution closes approval scope and disposes timeout", async (t) => {
    const tick = clock(t);
    const parent = new ApprovalWaitScope();
    t.after(() => parent.close());
    let signal!: AbortSignal;
    const failure = new Error("Native initialization failure");
    const execute = withApprovalAwareCodemodeTimeout(async (_id, _params, nativeSignal) => {
        signal = nativeSignal!;
        ApprovalWaitScope.current()!.beginWait();
        throw failure;
    });
    await assert.rejects(parent.run(() => execute("throw", {code: '// @options: {"timeout_ms":100}\nreturn 1;'}, undefined, undefined, context)), (error) => error === failure);
    assert.equal(parent.waiting, false);
    tick(1000);
    assert.equal(signal.aborted, false);
});

test("real main codemode enforces a finite timeout for a script with no nested tools", {timeout: 10_000}, async () => {
    const fixture = await sessionFixture(false);
    try {
        assert.equal((await fixture.run("return 1;")).isError, undefined);
        const result = await fixture.run('// @options: {"timeout_ms":150}\nwhile (true) {}');
        assert.equal(result.isError, true);
        assert.match(resultText(result), /Script failed/);
        assert.match(resultText(result), /Script timed out: Execution timed out after 150 ms/);
        assert.deepEqual((result.details as CodemodeToolDetails).calls, []);
    } finally {
        fixture.close();
    }
});

test("real main and child codemode suspend nested approval waits and keep native context/output behavior", {timeout: 15_000}, async () => {
    for (const child of [false, true]) {
        const entered = deferred<void>();
        const approved = deferred<void>();
        let scope!: ApprovalWaitScope;
        let nestedSignal!: AbortSignal;
        let releaseFirst!: () => void;
        let releaseSecond!: () => void;
        let nestedCwd = "";
        const approval: ToolDefinition = {
            name: "mcp__fixture__approval", label: "approval", description: "Fixture approval", exposure: "codemode",
            parameters: {type: "object", properties: {}},
            async execute(_id, _params, signal, _update, ctx) {
                scope = ApprovalWaitScope.current()!;
                assert.ok(scope, "SDK nested routing retains the execution's async scope");
                nestedSignal = signal!;
                nestedCwd = ctx.cwd;
                releaseFirst = scope.beginWait();
                releaseSecond = scope.beginWait();
                entered.resolve();
                try {
                    await approved.promise;
                    return {content: [{type: "text", text: "approved"}], details: undefined};
                } finally {
                    releaseFirst();
                    releaseSecond();
                }
            },
        };
        const fixture = await sessionFixture(child, [approval]);
        try {
            // Warm native lazy initialization before testing an approval exceeding the budget.
            const globals = await fixture.run('return typeof models;');
            assert.equal(globals.isError, undefined);
            assert.match(resultText(globals), child ? /undefined/ : /object/);
            const pending = fixture.run('// @options: {"timeout_ms":500,"max_output_tokens":100}\ntext("before approval"); await tools.mcp__fixture__approval({}); return "after approval";');
            await entered.promise;
            assert.equal(nestedCwd, fixture.directory);
            await delay(600);
            assert.equal(nestedSignal.aborted, false);
            releaseFirst();
            await delay(100);
            assert.equal(scope.waiting, true);
            assert.equal(nestedSignal.aborted, false);
            releaseSecond();
            approved.resolve();
            const result = await pending;
            assert.equal(result.isError, undefined, resultText(result));
            assert.match(resultText(result), /before approval/);
            assert.match(resultText(result), /after approval/);
            assert.equal((result.details as CodemodeToolDetails).calls[0]?.status, "ok");
            assert.equal(scope.waiting, false);

            // Native output truncation still uses max_output_tokens after timeout_ms removal.
            const spilled = await fixture.run('// @options: {"timeout_ms":5000,"max_output_tokens":0}\nreturn "native output budget";');
            assert.equal(spilled.isError, undefined);
            const outputPath = (spilled.details as CodemodeToolDetails).fullOutputPath;
            assert.ok(outputPath);
            try {
                assert.equal(readFileSync(outputPath, "utf8"), "native output budget");
                assert.match(resultText(spilled), /truncated output/);
            } finally {
                rmSync(outputPath, {force: true});
            }
            if (child) {
                const timedOut = await fixture.run('// @options: {"timeout_ms":150}\nwhile (true) {}');
                assert.equal(timedOut.isError, true);
                assert.match(resultText(timedOut), /Script timed out:/);
            }
        } finally {
            approved.resolve();
            releaseFirst?.();
            releaseSecond?.();
            fixture.close();
        }
    }
});

test("real policy capture pauses child codemode, job, status wait, and outer native codemode through queued approvals", {timeout: 15_000}, async (t) => {
    const fixture = await PolicyCodemodeHierarchy.create(t, true);
    const pending = fixture.run();
    await waitUntil(() => fixture.dialogs.length === 1 && fixture.policyCalls === 2);
    assert.ok(fixture.policyScope?.waiting);
    assert.ok(fixture.sourceScope?.waiting, "status bridges the detached child's approval into its waiting native caller");
    assert.match(fixture.dialogs[0]!.title, /Policy native child/);
    await delay(1400); // Exceeds both 600ms codemode budgets, 500ms status wait, and 1s job budget.
    fixture.assertRunning();
    await fixture.allowCurrent("Once");
    await waitUntil(() => fixture.dialogs.length === 4);
    assert.equal(fixture.policyResults.length, 1);
    assert.ok(fixture.policyScope?.waiting, "the queued second approval still holds the inner source");
    assert.ok(fixture.sourceScope?.waiting);
    await delay(800);
    fixture.assertRunning();
    await fixture.allowCurrent("Once");
    const result = await pending;
    assert.equal(result.isError, undefined, resultText(result));
    assert.match(resultText(result), /Status: idle/);
    assert.match(resultText(result), /discovery ok/);
    assert.equal(fixture.coordinator.list()[0]?.status, SubagentJobStatus.IDLE);
    assert.deepEqual(fixture.policyResults, [PolicyResponse.ALLOWED, PolicyResponse.ALLOWED]);
    assert.equal(fixture.persisted.length, 0, "ONCE approvals are not persisted");
    assert.equal(fixture.policyScope?.waiting, false);
    assert.equal(fixture.sourceScope?.waiting, false);
    assert.deepEqual((fixture.childResult!.details as CodemodeToolDetails).calls.map((call) => call.status), ["ok", "ok"]);
    assert.deepEqual((result.details as CodemodeToolDetails).calls.map((call) => call.status), ["ok", "ok"]);
});

test("stopping the real source job aborts paused native codemode and a late user lifetime choice installs no grant", {timeout: 15_000}, async (t) => {
    const fixture = await PolicyCodemodeHierarchy.create(t, false);
    const pending = fixture.run();
    await waitUntil(() => fixture.dialogs.length === 1);
    const lifetime = await fixture.toLifetime();
    await delay(1400);
    fixture.assertRunning();
    const stopped = await fixture.coordinator.stop(fixture.coordinator.list()[0]!.id);
    assert.equal(stopped.status, SubagentJobStatus.CANCELLED);
    const result = await pending;
    assert.equal(result.isError, undefined, resultText(result));
    assert.match(resultText(result), /Status: cancelled/);
    assert.equal(fixture.childResult?.isError, true);
    assert.match(resultText(fixture.childResult!), /Script aborted:/);
    assert.doesNotMatch(resultText(fixture.childResult!), /Script timed out:/);
    assert.equal(fixture.jobSignal?.aborted, true);
    assert.equal(fixture.policySignal?.aborted, true);
    assert.equal(lifetime.signal?.aborted, true);
    assert.equal(fixture.policyScope?.waiting, false);
    assert.equal(fixture.sourceScope?.waiting, false);
    assert.deepEqual(fixture.policyResults, [PolicyResponse.DENIED]);

    lifetime.answer("Always on this computer"); // UI deliberately ignores cancellation until this late response.
    await delay(20);
    assert.equal(fixture.dialogs.length, 3, "late completion cannot advance another prompt");
    assert.equal(fixture.persisted.length, 0, "late LOCAL choices must not write the DAO");
    const view = fixture.runtime.beginNativeFilesystemToolCall(PolicyCodemodeHierarchy.rootId);
    try {
        assert.equal(view.currentPolicyResult(fixture.target, PolicyAccessType.FS_WRITE), undefined,
            "late completion installs neither root session authority nor a persistent rule");
    } finally {
        view.close();
    }
});

type PolicyDialog = {
    title: string;
    options: string[];
    signal?: AbortSignal;
    answer(value: string | undefined): void;
};

/** Real execution hierarchy; only the provider turn and UI transport are simulated. */
class PolicyCodemodeHierarchy {
    static readonly rootId = "policy-codemode-root";
    readonly dialogs: PolicyDialog[] = [];
    readonly persisted: Policy[] = [];
    readonly policyResults: PolicyResponse[] = [];
    readonly runtime: PolicyRuntime;
    readonly coordinator: SubagentCoordinator;
    policyCalls = 0;
    policyScope?: ApprovalWaitScope;
    sourceScope?: ApprovalWaitScope;
    policySignal?: AbortSignal;
    jobSignal?: AbortSignal;
    childResult?: AgentToolResult<unknown>;
    private root!: Awaited<ReturnType<typeof sessionFixture>>;
    private readonly rows = new ToolDisplayRows();
    private readonly queue = new UiDecisionFlowQueue();
    // Created outside source.run(): model a shared broker callback's detached async context.
    private readonly broker = new AsyncResource("codemode-policy-broker");

    private constructor(private readonly parallel: boolean) {
        const ui = {
            select: async (title: string, options: string[], config?: {signal?: AbortSignal}) => {
                const answer = deferred<string | undefined>();
                this.dialogs.push({title, options, signal: config?.signal, answer: answer.resolve});
                return answer.promise;
            },
        };
        const ctx = {hasUI: true, mode: "rpc", ui} as unknown as ExtensionContext;
        const dao: PolicyDaoInterface = {
            initializeSchema() {}, loadPolicies: () => [], deletePolicy() {},
            upsertPolicies: (policies) => this.persisted.push(...structuredClone(policies)),
        };
        this.runtime = new PolicyRuntime(PolicyCodemodeHierarchy.rootId, dao, new PolicyDecisionFlow({
            decisionFlows: new UiDecisionFlowManager(ctx, this.queue),
        }));
        this.runtime.setDefaultResponse(PolicyArea.fs_write, PolicyFallbackResponse.ask_user);
        const placeholder: ToolDefinition = {
            name: "mcp__policy__write", label: "policy write", description: "Request write policy", exposure: "codemode",
            namespace: {name: "mcp__policy", description: "Granted policy fixture"},
            parameters: {type: "object", properties: {path: {type: "string"}}, required: ["path"]},
            async execute() { throw new Error("Child factory must bind its policy principal"); },
        };
        const catalog = new SubagentToolCatalog({builtins: () => [], mcp: () => [placeholder], delegate: () => []});
        const factory: SubagentChildSessionFactory = {
            create: async (request, tools) => {
                const bound = tools.map((tool): ToolDefinition => ({
                    ...tool,
                    execute: async (id, params, signal) => {
                        this.policyCalls++;
                        this.policyScope = ApprovalWaitScope.current();
                        assert.ok(this.policyScope);
                        this.policySignal = signal;
                        const evaluate = this.runtime.beginToolCall(request.agentIdentifier, {
                            toolCallId: id, toolName: tool.name, purpose: "Test captured native source",
                        });
                        const path = (params as {path: string}).path;
                        const result = await this.broker.runInAsyncScope(() => {
                            assert.equal(ApprovalWaitScope.current(), undefined);
                            return evaluate(path, PolicyAccessType.FS_WRITE, signal);
                        });
                        this.policyResults.push(result.matchedStatus);
                        return {
                            content: [{type: "text", text: result.matchedStatus === PolicyResponse.ALLOWED ? "policy allowed" : "policy denied"}],
                            details: undefined,
                            ...(result.matchedStatus === PolicyResponse.ALLOWED ? {} : {isError: true}),
                        };
                    },
                }));
                const child = await sessionFixture(true, bound, request.agentIdentifier);
                return {
                    prompt: async (_task, signal) => {
                        this.jobSignal = signal;
                        const paths = this.parallel ? [this.target, `${this.target}.second`] : [this.target];
                        const code = '// @options: {"timeout_ms":600}\n'
                            + 'const ns = await describeNamespace("policy"); const found = await searchTools("write", {namespace:"policy"}); '
                            + 'const description = await describeTool("mcp__policy__write"); '
                            + 'if (!ns || !found.length || !description) throw new Error("discovery failed"); text("discovery ok"); '
                            + `return await Promise.all(${JSON.stringify(paths)}.map(path => tools.mcp__policy__write({path})));`;
                        this.childResult = await child.run(code, signal);
                        if (this.childResult.isError) throw new Error(resultText(this.childResult));
                        return resultText(this.childResult);
                    },
                    steer: async () => false,
                    abort: async () => {}, // The coordinator's parent signal already reaches native execute.
                    dispose: () => child.close(),
                };
            },
        };
        this.coordinator = new SubagentCoordinator(factory, catalog, this.runtime);
    }

    static async create(t: TestContext, parallel: boolean): Promise<PolicyCodemodeHierarchy> {
        const fixture = new PolicyCodemodeHierarchy(parallel);
        t.after(() => fixture.close());
        const pi = {registerTool() {}};
        const spawn = new SubagentSpawnTool(pi, () => fixture.coordinator, () => initialSubagentDefaults, fixture.rows).toolDefinition();
        const status = new SubagentStatusTool(pi, () => fixture.coordinator, fixture.rows).toolDefinition();
        fixture.root = await sessionFixture(false, [
            {...spawn, exposure: "codemode"},
            {...status, exposure: "codemode", execute: (...args) => {
                fixture.sourceScope = ApprovalWaitScope.current();
                return status.execute(...args);
            }},
        ], this.rootId);
        assert.equal((await fixture.root.run("return 1;")).isError, undefined);
        return fixture;
    }

    get target(): string {
        return path.join(this.root.directory, "requested.txt");
    }

    run(): Promise<AgentToolResult<unknown>> {
        return this.root.run('// @options: {"timeout_ms":600}\n'
            + 'const spawned = await tools.subagent_spawn({task:"Request policy",role:"Policy native child",capabilities:["mcp"],'
            + 'timeoutSeconds:1,reasoning_skill:"mid",reasoning_amount:"mid"}); '
            + 'const id = spawned.match(/\\((subagent-[^)]+)\\)/)[1]; '
            + 'return await tools.subagent_status({jobIds:[id],waitSeconds:0.5});');
    }

    assertRunning(): void {
        assert.equal(this.coordinator.list()[0]?.status, SubagentJobStatus.RUNNING);
        assert.equal(this.jobSignal?.aborted, false);
        assert.equal(this.policySignal?.aborted, false);
        assert.ok(this.policyScope?.waiting && this.sourceScope?.waiting);
    }

    async allowCurrent(lifetime: string): Promise<void> {
        const dialog = await this.toLifetime();
        dialog.answer(lifetime);
    }

    async toLifetime(): Promise<PolicyDialog> {
        const count = this.dialogs.length;
        const scope = this.dialogs.at(-1)!;
        assert.match(scope.title, /^Path policy scope/);
        scope.answer(scope.options[0]);
        await waitUntil(() => this.dialogs.length === count + 1);
        const status = this.dialogs.at(-1)!;
        assert.match(status.title, /^Path policy decision/);
        status.answer("Allow");
        await waitUntil(() => this.dialogs.length === count + 2);
        const lifetime = this.dialogs.at(-1)!;
        assert.match(lifetime.title, /^Path policy lifetime/);
        return lifetime;
    }

    private async close(): Promise<void> {
        this.queue.close();
        for (const dialog of this.dialogs) dialog.answer(undefined);
        await this.coordinator.close();
        this.runtime.beginShutdown();
        this.root?.close();
        this.rows.clear();
        this.broker.emitDestroy();
    }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
        assert.ok(Date.now() < deadline, "timed out waiting for native/policy fixture progress");
        await delay(5);
    }
}

function clock(t: TestContext): (milliseconds: number) => void {
    let now = 0;
    t.mock.method(performance, "now", () => now);
    t.mock.timers.enable({apis: ["setTimeout"]});
    return (milliseconds) => {
        now += milliseconds;
        t.mock.timers.tick(milliseconds);
    };
}

function waitForAbort(signal: AbortSignal): Promise<Result> {
    return new Promise((resolve) => {
        const aborted = () => resolve({
            content: [
                {type: "text", text: "Script failed\nWall time 0.1 seconds\nOutput:\n"},
                {type: "text", text: `Script error:\nScript aborted: ${signal.reason.message}\n\nTool calls made before the failure (they are not undone): approval (cancelled)`},
            ],
            details: {calls: [{id: "fixture/?", name: "approval", args: "{}", status: "cancelled"}]},
            isError: true,
        });
        if (signal.aborted) aborted();
        else signal.addEventListener("abort", aborted, {once: true});
    });
}

function resultText(result: AgentToolResult<unknown>): string {
    return result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

function deferred<T>(): {promise: Promise<T>; resolve: (value: T) => void} {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((accept) => { resolve = accept; });
    return {promise, resolve};
}

function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function sessionFixture(child: boolean, tools: ToolDefinition[] = [], sessionId?: string) {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pilot-codemode-timeout-"));
    const rows = new ToolDisplayRows();
    const settingsManager = SettingsManager.inMemory({defaultTools: ["codemode"]});
    const loader = child
        ? await createSubagentResourceLoader({
            parentAgentIdentifier: "parent", agentIdentifier: sessionId ?? "child", task: "test timeout", role: "fixture",
            capabilities: [AgentMechanismCapability.mcp], cwd: directory, timeoutSeconds: 30,
            reasoningSkill: SubagentReasoningSkill.MID, reasoningAmount: SubagentReasoningAmount.MID,
            modelPreference: AUTO_SUBAGENT_MODEL,
        }, directory, settingsManager, tools)
        : new DefaultResourceLoader({
            cwd: directory, agentDir: directory, settingsManager,
            noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
            extensionFactories: [(pi) => new CodemodeExtension(pi, rows).register()],
        });
    if (!child) await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const {session} = await createAgentSession({
        cwd: directory, agentDir: directory, settingsManager, resourceLoader: loader,
        sessionManager: SessionManager.inMemory(directory, sessionId ? {id: sessionId} : undefined), noTools: "builtin", customTools: tools,
    });
    await session.bindExtensions({});
    session.setActiveToolsByName(["codemode"]);
    const tool = session.agent.state.tools.find((entry) => entry.name === "codemode");
    assert.ok(tool);
    return {
        directory,
        async run(code: string, signal?: AbortSignal) {
            const args: Record<string, string> = child ? {code} : {purpose: "Exercise approval-aware execution", code};
            const id = `fixture-${session.agent.state.messages.length}`;
            session.agent.state.messages.push({
                role: "assistant", content: [{type: "toolCall", id, name: "codemode", arguments: args}],
                api: "openai-completions", provider: "fixture", model: "fixture",
                usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
                    cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}},
                stopReason: "toolUse", timestamp: Date.now(),
            });
            return tool.execute(id, args, signal, undefined);
        },
        close() {
            session.dispose();
            rows.clear();
            rmSync(directory, {recursive: true, force: true});
        },
    };
}
