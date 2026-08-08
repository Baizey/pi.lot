import assert from "node:assert/strict";
import test from "node:test";
import type {ExtensionContext} from "@earendil-works/pi-coding-agent";
import type {UiDecision} from "../src/tui/UiDecisionFlowManager.js";
import {UiDecisionFlowManager} from "../src/tui/UiDecisionFlowManager.js";

type Approval = {
    choice: string;
};

type PendingPrompt = {
    title: string;
    choose(value: string | undefined): void;
};

test("decision flows are serialized and a queued flow can be cancelled", async () => {
    const shownTitles: string[] = [];
    const prompts: PendingPrompt[] = [];
    let activePrompts = 0;
    let maximumActivePrompts = 0;
    const ctx = {
        hasUI: true,
        mode: "rpc",
        ui: {
            select(title: string): Promise<string | undefined> {
                shownTitles.push(title);
                activePrompts++;
                maximumActivePrompts = Math.max(maximumActivePrompts, activePrompts);
                return new Promise((resolve) => {
                    prompts.push({
                        title,
                        choose(value) {
                            activePrompts--;
                            resolve(value);
                        },
                    });
                });
            },
        },
    } as unknown as ExtensionContext;
    const manager = new UiDecisionFlowManager(ctx);
    const firstDecision = decision("first");
    const secondDecision = decision("second");
    const thirdDecision = decision("third");
    const secondController = new AbortController();

    const first = manager.runFlow(firstDecision, {choice: firstDecision}, cancelled);
    const second = manager.runFlow(
        secondDecision,
        {choice: secondDecision},
        cancelled,
        {signal: secondController.signal},
    );
    const third = manager.runFlow(thirdDecision, {choice: thirdDecision}, cancelled);

    await nextTurn();
    assert.deepEqual(shownTitles, ["first"]);
    assert.equal(activePrompts, 1);

    secondController.abort();
    assert.deepEqual(await second, {choice: "cancelled"});
    await nextTurn();
    assert.deepEqual(shownTitles, ["first"]);

    prompts.shift()!.choose("first");
    assert.deepEqual(await first, {choice: "first"});
    await nextTurn();
    assert.deepEqual(shownTitles, ["first", "third"]);

    prompts.shift()!.choose("third");
    assert.deepEqual(await third, {choice: "third"});
    assert.equal(maximumActivePrompts, 1);
});

function decision(title: string): UiDecision<Approval> {
    return {
        type: "select",
        key: "choice",
        title,
        options: [{title, value: title, next: null}],
    };
}

function cancelled(): Approval {
    return {choice: "cancelled"};
}

function nextTurn(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}
