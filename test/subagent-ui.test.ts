import assert from "node:assert/strict";
import test from "node:test";
import type {
    ExtensionContext,
    Theme,
} from "@earendil-works/pi-coding-agent";
import {
    SubagentJobStatus,
    type SubagentJobChange,
    type SubagentJobMonitor,
    type SubagentJobSnapshot,
} from "../src/subagents/types.js";
import {
    SubagentActivityWidget,
    subagentStatusCounts,
} from "../src/tui/subagent/SubagentActivityWidget.js";
import {SubagentUiRuntime} from "../src/tui/subagent/SubagentUiRuntime.js";
import {displayWidth} from "../src/tui/terminalText.js";

const plainTheme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
} as unknown as Theme;

test("subagent activity widget shows bounded active work and omits retained idle jobs", () => {
    const jobs = [
        job({id: "running", role: "policy auditor", status: SubagentJobStatus.RUNNING, latestLine: "Using read"}),
        job({id: "queued", role: "test reviewer", status: SubagentJobStatus.QUEUED, depth: 1, createdAt: 2}),
        job({id: "idle", role: "finished reviewer", status: SubagentJobStatus.IDLE, createdAt: 3}),
    ];
    const widget = new SubagentActivityWidget(() => jobs, plainTheme);

    const lines = widget.render(70);

    assert.equal(lines[0], "Subagents · 1 running · 1 queued");
    assert.equal(lines.some((line) => line.includes("policy auditor") && line.includes("Using read")), true);
    assert.equal(lines.some((line) => line.includes("└─ ◌ test reviewer")), true);
    assert.equal(lines.some((line) => line.includes("finished reviewer")), false);
    assert.equal(lines.every((line) => displayWidth(line) <= 70), true);
    assert.deepEqual(subagentStatusCounts(jobs), {running: 1, queued: 1, idle: 1, attention: 0});
});

test("subagent UI runtime keeps the above-editor widget and footer synchronized", () => {
    const monitor = new FakeMonitor([job({id: "visible", status: SubagentJobStatus.RUNNING})]);
    const statuses: Array<string | undefined> = [];
    const widgets: unknown[] = [];
    let widgetFactory: ((tui: {requestRender(): void}, theme: Theme) => SubagentActivityWidget) | undefined;
    let renders = 0;
    const ui = {
        theme: plainTheme,
        setStatus(_key: string, value: string | undefined) {
            statuses.push(value);
        },
        setWidget(_key: string, value: unknown) {
            widgets.push(value);
            if (typeof value === "function") widgetFactory = value as typeof widgetFactory;
        },
    };
    const ctx = {
        mode: "tui",
        hasUI: true,
        ui,
    } as unknown as ExtensionContext;
    const runtime = new SubagentUiRuntime();

    runtime.startSession(ctx, monitor);
    assert.equal(statuses.at(-1), "agents ●1");
    assert.ok(widgetFactory);
    const widget = widgetFactory({requestRender: () => renders++}, plainTheme);
    assert.equal(widget.render(100).some((line) => line.includes("reviewer")), true);

    monitor.upsert(job({id: "visible", status: SubagentJobStatus.IDLE}));
    assert.equal(statuses.at(-1), "agents ○1");
    assert.equal(renders, 1);
    assert.deepEqual(widget.render(100), []);

    runtime.stopSession();
    assert.equal(statuses.at(-1), undefined);
    assert.equal(widgets.at(-1), undefined);

    const statusCount = statuses.length;
    monitor.upsert(job({id: "visible", status: SubagentJobStatus.RUNNING}));
    assert.equal(statuses.length, statusCount);
});

class FakeMonitor implements SubagentJobMonitor {
    private readonly jobs = new Map<string, SubagentJobSnapshot>();
    private readonly listeners = new Set<(change: SubagentJobChange) => void>();

    constructor(jobs: SubagentJobSnapshot[]) {
        for (const value of jobs) this.jobs.set(value.id, value);
    }

    list(): SubagentJobSnapshot[] {
        return [...this.jobs.values()];
    }

    subscribe(listener: (change: SubagentJobChange) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    upsert(value: SubagentJobSnapshot): void {
        this.jobs.set(value.id, value);
        for (const listener of this.listeners) listener({kind: "upsert", job: value});
    }
}

function job(overrides: Partial<SubagentJobSnapshot> = {}): SubagentJobSnapshot {
    return {
        id: "job",
        depth: 0,
        createdAt: 1,
        status: SubagentJobStatus.QUEUED,
        role: "reviewer",
        task: "Inspect the implementation",
        capabilities: [],
        cwd: process.cwd(),
        reasoningSkill: "mid" as SubagentJobSnapshot["reasoningSkill"],
        reasoningAmount: "mid" as SubagentJobSnapshot["reasoningAmount"],
        turns: 0,
        ...overrides,
    };
}
