import type {ExtensionContext} from "@earendil-works/pi-coding-agent";
import type {
    SubagentJobChange,
    SubagentJobMonitor,
    SubagentJobSnapshot,
} from "../../subagents/types.js";
import {
    SubagentActivityWidget,
    subagentStatusCounts,
} from "./SubagentActivityWidget.js";

const UI_KEY = "pi.lot-subagents";

export class SubagentUiRuntime {
    private readonly jobs = new Map<string, SubagentJobSnapshot>();
    private context: ExtensionContext | undefined;
    private unsubscribe: (() => void) | undefined;
    private requestRender: (() => void) | undefined;

    startSession(ctx: ExtensionContext, monitor: SubagentJobMonitor): void {
        if (this.context) throw new Error("Subagent UI session is already started");
        this.context = ctx;
        this.jobs.clear();
        for (const job of monitor.list()) this.jobs.set(job.id, job);
        this.unsubscribe = monitor.subscribe((change) => this.changed(change));
        this.installUi(ctx);
        this.updateUi();
    }

    stopSession(): void {
        this.unsubscribe?.();
        this.unsubscribe = undefined;
        this.jobs.clear();
        this.clearUi();
        this.context = undefined;
    }

    private installUi(ctx: ExtensionContext): void {
        if (!ctx.hasUI) return;
        if (ctx.mode === "tui" && typeof ctx.ui.setWidget === "function") {
            ctx.ui.setWidget(UI_KEY, (tui, theme) => {
                this.requestRender = () => tui.requestRender();
                return new SubagentActivityWidget(() => this.sortedJobs(), theme);
            });
        }
    }

    private clearUi(): void {
        const ctx = this.context;
        this.requestRender = undefined;
        if (!ctx?.hasUI) return;
        if (typeof ctx.ui.setStatus === "function") ctx.ui.setStatus(UI_KEY, undefined);
        if (typeof ctx.ui.setWidget === "function") ctx.ui.setWidget(UI_KEY, undefined);
    }

    private changed(change: SubagentJobChange): void {
        if (change.kind === "upsert") this.jobs.set(change.job.id, change.job);
        else this.jobs.delete(change.jobId);
        this.updateUi();
    }

    private updateUi(): void {
        const ctx = this.context;
        if (!ctx?.hasUI) return;
        if (typeof ctx.ui.setStatus === "function") {
            const status = formatFooterStatus(this.sortedJobs(), ctx);
            ctx.ui.setStatus(UI_KEY, status || undefined);
        }
        this.requestRender?.();
    }

    private sortedJobs(): SubagentJobSnapshot[] {
        return [...this.jobs.values()].sort((left, right) => left.createdAt - right.createdAt);
    }
}

function formatFooterStatus(jobs: readonly SubagentJobSnapshot[], ctx: ExtensionContext): string {
    const counts = subagentStatusCounts(jobs);
    const parts = [
        counts.running > 0 ? ctx.ui.theme.fg("accent", `●${counts.running}`) : "",
        counts.queued > 0 ? ctx.ui.theme.fg("warning", `◌${counts.queued}`) : "",
        counts.idle > 0 ? ctx.ui.theme.fg("dim", `○${counts.idle}`) : "",
        counts.attention > 0 ? ctx.ui.theme.fg("error", `!${counts.attention}`) : "",
    ].filter(Boolean);
    return parts.length > 0 ? `agents ${parts.join(" ")}` : "";
}
