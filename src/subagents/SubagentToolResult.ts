import type {AgentToolResult} from "@earendil-works/pi-coding-agent";
import {
    SubagentJobStatus,
    type SubagentJobSnapshot,
} from "./types";

const MAX_TOOL_OUTPUT_CHARS = 100_000;

export type SubagentToolDetails = {jobs: SubagentJobSnapshot[]};

export function subagentToolResult(jobs: SubagentJobSnapshot[]): AgentToolResult<SubagentToolDetails> {
    return {
        content: [{type: "text", text: boundedToolOutput(renderJobs(jobs))}],
        details: {jobs},
    };
}

export function renderJobs(jobs: SubagentJobSnapshot[]): string {
    if (jobs.length === 0) return "No subagent jobs.";
    return jobs.map((job) => {
        const lines = [
            `## ${job.role} (${job.id})`,
            `Status: ${job.status}`,
            `Mode: ${job.mode}`,
            `Depth: ${job.depth}`,
            `Toolkits: ${job.toolkits.length > 0 ? job.toolkits.join(", ") : "(none)"}`,
            `Task: ${job.task}`,
        ];
        if (job.latestLine && (job.status === SubagentJobStatus.QUEUED || job.status === SubagentJobStatus.RUNNING)) {
            lines.push(`Latest: ${job.latestLine}`);
        }
        if (job.output) lines.push("", job.output);
        if (job.error) lines.push("", `Error: ${job.error}`);
        if (job.status === SubagentJobStatus.IDLE) {
            lines.push("", "This conversation is idle and can receive subagent_message.");
        }
        return lines.join("\n");
    }).join("\n\n");
}

function boundedToolOutput(text: string): string {
    if (text.length <= MAX_TOOL_OUTPUT_CHARS) return text;
    return `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n[Subagent status output truncated]`;
}
