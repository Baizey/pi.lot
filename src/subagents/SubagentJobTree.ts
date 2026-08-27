import type {SubagentJobSnapshot} from "./types.js";

export type SubagentJobTreeEntry = {
    job: SubagentJobSnapshot;
    prefix: string;
};

/** Order a scoped set of jobs depth-first, treating missing parents as roots. */
export function subagentJobTree(jobs: readonly SubagentJobSnapshot[]): SubagentJobTreeEntry[] {
    const byId = new Map(jobs.map((job) => [job.id, job]));
    const children = new Map<string | undefined, SubagentJobSnapshot[]>();
    for (const job of jobs) {
        const visibleParentId = job.parentId && byId.has(job.parentId) ? job.parentId : undefined;
        const siblings = children.get(visibleParentId) ?? [];
        siblings.push(job);
        children.set(visibleParentId, siblings);
    }
    for (const siblings of children.values()) siblings.sort(compareJobs);

    const entries: SubagentJobTreeEntry[] = [];
    const visited = new Set<string>();
    const append = (job: SubagentJobSnapshot, ancestorLast: readonly boolean[]) => {
        if (visited.has(job.id)) return;
        visited.add(job.id);
        entries.push({job, prefix: treePrefix(ancestorLast)});
        const descendants = children.get(job.id) ?? [];
        for (let index = 0; index < descendants.length; index++) {
            append(descendants[index]!, [...ancestorLast, index === descendants.length - 1]);
        }
    };
    for (const root of children.get(undefined) ?? []) append(root, []);
    for (const orphan of [...jobs].sort(compareJobs)) append(orphan, []);
    return entries;
}

function compareJobs(left: SubagentJobSnapshot, right: SubagentJobSnapshot): number {
    return left.createdAt - right.createdAt || left.id.localeCompare(right.id);
}

function treePrefix(ancestorLast: readonly boolean[]): string {
    if (ancestorLast.length === 0) return "";
    const ancestors = ancestorLast
        .slice(0, -1)
        .map((last) => last ? "    " : "  │ ")
        .join("");
    return `${ancestors}  ${ancestorLast.at(-1) ? "└─ " : "├─ "}`;
}
