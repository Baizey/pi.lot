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
    activeSubagentJobs,
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
        job({
            id: "queued",
            parentId: "running",
            role: "test reviewer",
            status: SubagentJobStatus.QUEUED,
            depth: 1,
            createdAt: 2,
        }),
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

test("subagent status counts include failures and timeouts but exclude cancellations", () => {
    const jobs = Object.values(SubagentJobStatus).map((status) => job({id: status, status}));
    const original = structuredClone(jobs);
    assert.deepEqual(subagentStatusCounts([]), {running: 0, queued: 0, idle: 0, attention: 0});
    assert.deepEqual(subagentStatusCounts(jobs), {running: 1, queued: 1, idle: 1, attention: 2});
    assert.deepEqual(subagentStatusCounts([...jobs, ...jobs]), {running: 2, queued: 2, idle: 2, attention: 4});
    assert.deepEqual(jobs, original, "counting must not mutate the job snapshots or their order");
});

test("subagent activity widget renders active jobs in depth-first parent order", () => {
    const jobs = [
        job({id: "parent-a", role: "parent A", status: SubagentJobStatus.RUNNING, createdAt: 1}),
        job({id: "parent-b", role: "parent B", status: SubagentJobStatus.RUNNING, createdAt: 2}),
        job({
            id: "child-b",
            parentId: "parent-b",
            role: "child B",
            status: SubagentJobStatus.RUNNING,
            depth: 1,
            createdAt: 3,
        }),
        job({
            id: "child-a",
            parentId: "parent-a",
            role: "child A",
            status: SubagentJobStatus.RUNNING,
            depth: 1,
            createdAt: 4,
        }),
    ];

    assert.deepEqual(
        activeSubagentJobs(jobs).map((value) => value.id),
        ["parent-a", "child-a", "parent-b", "child-b"],
    );
    assert.deepEqual(
        new SubagentActivityWidget(() => jobs, plainTheme).render(120).slice(1).map((line) => (
            line.replace(/ —.*$/, "")
        )),
        [
            "● parent A",
            "  └─ ● child A",
            "● parent B",
            "  └─ ● child B",
        ],
    );
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

test("subagent footer counts follow updates and removals without changing chronological widget order", () => {
    const jobs = [
        job({id: "child", role: "child A", parentId: "parent", depth: 1, createdAt: 3}),
        job({id: "later", role: "parent B", status: SubagentJobStatus.RUNNING, createdAt: 2}),
        job({id: "parent", role: "parent A", status: SubagentJobStatus.RUNNING, createdAt: 1}),
        job({id: "idle", status: SubagentJobStatus.IDLE}),
        job({id: "failed", status: SubagentJobStatus.FAILED}),
        job({id: "timeout", status: SubagentJobStatus.TIMED_OUT}),
        job({id: "cancelled", status: SubagentJobStatus.CANCELLED}),
    ];
    const monitor = new FakeMonitor(jobs);
    let status: string | undefined;
    let widget: SubagentActivityWidget | undefined;
    const ctx = {
        mode: "tui", hasUI: true,
        ui: {
            theme: plainTheme,
            setStatus(_key: string, value: string | undefined) { status = value; },
            setWidget(_key: string, factory: unknown) {
                if (typeof factory === "function") widget = factory({requestRender() {}}, plainTheme);
            },
        },
    } as unknown as ExtensionContext;
    const runtime = new SubagentUiRuntime();
    try {
        runtime.startSession(ctx, monitor);
        assert.equal(status, "agents ●2 ◌1 ○1 !2");
        assert.ok(widget);
        assert.deepEqual(widget.render(120).slice(1).map((line) => line.replace(/ —.*$/, "")), [
            "● parent A", "  └─ ◌ child A", "● parent B",
        ]);
        monitor.upsert(job({id: "later", role: "parent B", status: SubagentJobStatus.IDLE, createdAt: 2}));
        assert.equal(status, "agents ●1 ◌1 ○2 !2");
        monitor.remove("timeout");
        assert.equal(status, "agents ●1 ◌1 ○2 !1");
        monitor.remove("failed");
        assert.equal(status, "agents ●1 ◌1 ○2");
        for (const value of jobs) monitor.remove(value.id);
        assert.equal(status, undefined);
        assert.deepEqual(widget.render(120), []);
    } finally {
        runtime.stopSession();
    }
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

    remove(jobId: string): void {
        this.jobs.delete(jobId);
        for (const listener of this.listeners) listener({kind: "remove", jobId});
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
