import assert from "node:assert/strict";
import {mkdtempSync, rmSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
    createAgentSession,
    DefaultResourceLoader,
    SessionManager,
    SettingsManager,
    type CodemodeToolDetails,
} from "@earendil-works/pi-coding-agent";
import type {ClassifierContext, ClassifierResult, Usage} from "@earendil-works/pi-ai";
import {CodemodeExtension} from "../src/tools/codemode/CodemodeExtension.js";
import {ToolDisplayRows} from "../src/tui/tool/ToolDisplayRows.js";

test("Pilot codemode forwards classifier image inputs unchanged and aggregates model usage", {timeout: 15_000}, async (t) => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "pilot-codemode-models-"));
    const rows = new ToolDisplayRows();
    t.after(() => {
        rows.clear();
        rmSync(directory, {recursive: true, force: true});
    });
    const settingsManager = SettingsManager.inMemory({defaultTools: ["codemode"]});
    const loader = new DefaultResourceLoader({
        cwd: directory, agentDir: directory, settingsManager,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        extensionFactories: [(pi) => new CodemodeExtension(pi, rows).register()],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const {session} = await createAgentSession({
        cwd: directory, agentDir: directory, settingsManager, resourceLoader: loader,
        sessionManager: SessionManager.inMemory(directory), noTools: "builtin",
    });
    try {
        await session.bindExtensions({});
        session.setActiveToolsByName(["codemode"]);
        const tool = session.agent.state.tools.find((definition) => definition.name === "codemode");
        assert.ok(tool);
        const classifier = session.modelRuntime.getModelOfType("classifier", "typesafe", "jev-latest");
        assert.ok(classifier);
        assert.ok(classifier.input.includes("image"), "Pi 1.4's Jev catalog advertises image support");
        const context: ClassifierContext = {
            state: {task: "Compare fixture images", labels: ["first", "second"]},
            images: [
                {type: "image", data: Buffer.from("first fixture image").toString("base64"), mimeType: "image/png"},
                {type: "image", data: Buffer.from("second fixture image").toString("base64"), mimeType: "image/jpeg"},
            ],
            questions: {
                acceptable: {
                    type: "bool", instructions: "Are both fixtures acceptable?",
                    criteria: {true: "Acceptable", false: "Not acceptable"},
                },
            },
        };
        const usage: Usage = {
            input: 11, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 14,
            cost: {input: 0.125, output: 0.25, cacheRead: 0, cacheWrite: 0, total: 0.375},
        };
        const classified: ClassifierResult = {
            api: classifier.api, provider: classifier.provider, model: classifier.id,
            answers: {acceptable: {type: "bool", probability: 0.875}},
            usage, stopReason: "stop", timestamp: 123,
        };
        // Mock the provider boundary only: lookup, validation, worker bridging and accounting stay native.
        const classifyProvider: typeof session.modelRuntime.classify = async (model, received, options) => {
            assert.equal(model, classifier);
            assert.deepEqual(received, context);
            assert.ok(options?.signal instanceof AbortSignal);
            assert.equal(options.signal.aborted, false);
            return classified;
        };
        const classify = t.mock.method(session.modelRuntime, "classify", classifyProvider);
        const args = {
            purpose: "Classify fixture images without contacting a provider",
            code: `const model = await models.getModelOfType("classifier", "typesafe", "jev-latest");
                const context = ${JSON.stringify(context)};
                const first = await models.classify(model, context);
                const second = await models.classify(model, context);
                return [first.answers, second.answers];`,
        };
        session.agent.state.messages.push({
            role: "assistant", content: [{type: "toolCall", id: "classify-images", name: "codemode", arguments: args}],
            api: "openai-completions", provider: "fixture", model: "fixture",
            usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
                cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}},
            stopReason: "toolUse", timestamp: Date.now(),
        });
        const result = await tool.execute("classify-images", args, undefined, undefined);
        assert.equal(result.isError, undefined, JSON.stringify(result.content));
        assert.equal(classify.mock.callCount(), 2);
        assert.ok(result.content.some((part) => part.type === "text"
            && part.text === JSON.stringify([classified.answers, classified.answers])));
        assert.deepEqual(result.usage, {
            input: 22, output: 6, cacheRead: 0, cacheWrite: 0, totalTokens: 28,
            cost: {input: 0.25, output: 0.5, cacheRead: 0, cacheWrite: 0, total: 0.75},
        });
        const calls = (result.details as CodemodeToolDetails).calls;
        assert.equal(calls.length, 2);
        for (const call of calls) {
            assert.equal(call.name, "models.classify");
            assert.equal(call.args, "typesafe/jev-latest", "activity records the model, not image or question data");
            assert.equal(call.status, "ok");
            assert.equal(call.cost, usage.cost.total);
        }
    } finally {
        session.dispose();
    }
});
