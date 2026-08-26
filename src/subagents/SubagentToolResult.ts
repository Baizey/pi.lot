import type {AgentToolResult} from "@earendil-works/pi-coding-agent";
import {
    SubagentJobStatus,
    type SubagentJobSnapshot,
} from "./types";

const MAX_TOOL_OUTPUT_CHARS = 100_000;

export type SubagentToolDetails = { jobs: SubagentJobSnapshot[] };

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
            `Reasoning: ${job.reasoningSkill} skill, ${job.reasoningAmount} amount`,
            `Capabilities: ${job.capabilities.length > 0 ? job.capabilities.join(", ") : "(none)"}`,
            `Task: ${job.task}`,
        ];
        if (job.resolvedModel) {
            const thinking = job.resolvedThinkingLevel ? `; thinking ${job.resolvedThinkingLevel}` : "";
            const source = job.modelSelectionSource ? `; selected by ${job.modelSelectionSource}` : "";
            lines.push(`Resolved model: ${job.resolvedModel}${thinking}${source}`);
        }
        if (job.latestLine && (job.status === SubagentJobStatus.QUEUED || job.status === SubagentJobStatus.RUNNING)) {
            lines.push(`Latest: ${job.latestLine}`);
        }
        if (job.output) lines.push("", job.output);
        if (job.error) lines.push("", `Error: ${job.error}`);
        if (job.status === SubagentJobStatus.RUNNING) {
            lines.push("", "Use subagent_message to steer this active job.");
        }
        if (job.status === SubagentJobStatus.IDLE) {
            lines.push("", "This conversation is idle and can receive a follow-up turn through subagent_message.");
        }
        return lines.join("\n");
    }).join("\n\n");
}

function boundedToolOutput(text: string): string {
    if (text.length <= MAX_TOOL_OUTPUT_CHARS) return text;
    return `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n[Subagent status output truncated]`;
}
