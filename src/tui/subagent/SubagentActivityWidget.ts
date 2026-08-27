import type {Theme} from "@earendil-works/pi-coding-agent";
import type {Component} from "@earendil-works/pi-tui";
import {subagentJobTree} from "../../subagents/SubagentJobTree.js";
import {
    SubagentJobStatus,
    type SubagentJobSnapshot,
} from "../../subagents/types.js";
import {sanitizeTerminalLine, truncateToWidth} from "../terminalText.js";

const MAX_VISIBLE_JOBS = 5;
const MAX_SUMMARY_CHARS = 90;

export class SubagentActivityWidget implements Component {
    constructor(
        private readonly jobs: () => readonly SubagentJobSnapshot[],
        private readonly theme: Theme,
    ) {
    }

    render(width: number): string[] {
        const active = activeSubagentTree(this.jobs());
        if (active.length === 0) return [];

        const running = active.filter(({job}) => job.status === SubagentJobStatus.RUNNING).length;
        const queued = active.length - running;
        const counts = [
            running > 0 ? `${running} running` : "",
            queued > 0 ? `${queued} queued` : "",
        ].filter(Boolean).join(" · ");
        const visible = active.slice(0, MAX_VISIBLE_JOBS);
        const rows = visible.map(({job, prefix}) => this.jobLine(job, prefix));
        if (active.length > visible.length) {
            rows.push(this.theme.fg("dim", `… ${active.length - visible.length} more`));
        }

        return [
            this.theme.fg("accent", this.theme.bold(`Subagents · ${counts}`)),
            ...rows,
        ].map((line) => truncateToWidth(line, width));
    }

    invalidate(): void {
    }

    private jobLine(job: SubagentJobSnapshot, prefix: string): string {
        const running = job.status === SubagentJobStatus.RUNNING;
        const marker = running
            ? this.theme.fg("accent", "●")
            : this.theme.fg("warning", "◌");
        const role = this.theme.fg("text", compact(job.role, MAX_SUMMARY_CHARS));
        const task = this.theme.fg("muted", compact(job.task, MAX_SUMMARY_CHARS));
        const latest = job.latestLine && compact(job.latestLine, MAX_SUMMARY_CHARS) !== compact(job.task, MAX_SUMMARY_CHARS)
            ? this.theme.fg("dim", ` · ${compact(job.latestLine, MAX_SUMMARY_CHARS)}`)
            : "";
        return `${prefix}${marker} ${role} — ${task}${latest}`;
    }
}

export function activeSubagentJobs(jobs: readonly SubagentJobSnapshot[]): SubagentJobSnapshot[] {
    return activeSubagentTree(jobs).map(({job}) => job);
}

function activeSubagentTree(jobs: readonly SubagentJobSnapshot[]) {
    return subagentJobTree(jobs.filter((job) => (
        job.status === SubagentJobStatus.QUEUED
        || job.status === SubagentJobStatus.RUNNING
    )));
}

export function subagentStatusCounts(jobs: readonly SubagentJobSnapshot[]): {
    running: number;
    queued: number;
    idle: number;
    attention: number;
} {
    return {
        running: jobs.filter((job) => job.status === SubagentJobStatus.RUNNING).length,
        queued: jobs.filter((job) => job.status === SubagentJobStatus.QUEUED).length,
        idle: jobs.filter((job) => job.status === SubagentJobStatus.IDLE).length,
        attention: jobs.filter((job) => (
            job.status === SubagentJobStatus.FAILED
            || job.status === SubagentJobStatus.TIMED_OUT
        )).length,
    };
}

function compact(value: string, maximum: number): string {
    const line = sanitizeTerminalLine(value).replace(/\s+/g, " ").trim();
    return line.length <= maximum ? line : `${line.slice(0, maximum - 1)}…`;
}
