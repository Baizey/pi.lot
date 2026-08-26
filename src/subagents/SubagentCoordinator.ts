import {AsyncLocalStorage} from "node:async_hooks";
import crypto from "node:crypto";
import type {PolicyPrincipalRegistry} from "../policy/PolicyRuntime.js";
import {
    AgentCapabilitySet,
    AgentMechanismCapability,
} from "./AgentCapability.js";
import {SubagentToolCatalog} from "./SubagentToolCatalog.js";
import {AUTO_SUBAGENT_MODEL} from "./SubagentDefaults.js";
import {
    SubagentReasoningAmount,
    SubagentReasoningSkill,
} from "./SubagentReasoning.js";
import {
    SubagentJobStatus,
    type SubagentChildSession,
    type SubagentChildSessionFactory,
    type SubagentJobSnapshot,
    type SubagentRequest,
} from "./types.js";

const MAX_JOB_OUTPUT_CHARS = 50_000;
const DEFAULT_MAX_CONCURRENCY = 1_000;
const DEFAULT_MAX_DEPTH = 100;
const DEFAULT_MAX_JOBS = 100_000;

type DelegationContext = {
    jobId: string;
    agentIdentifier: string;
    depth: number;
    mechanisms: ReadonlySet<AgentMechanismCapability>;
};

type SubagentJob = {
    id: string;
    agentIdentifier: string;
    parentId?: string;
    depth: number;
    request: SubagentRequest;
    capabilities: AgentCapabilitySet;
    status: SubagentJobStatus;
    createdAt: number;
    startedAt?: number;
    finishedAt?: number;
    latestLine?: string;
    output?: string;
    error?: string;
    turns: number;
    nextTask: string;
    queuedTasks: string[];
    pendingSteering: string[];
    session?: SubagentChildSession;
    resolvedModel?: string;
    resolvedThinkingLevel?: SubagentJobSnapshot["resolvedThinkingLevel"];
    modelSelectionSource?: string;
    controller?: AbortController;
    runPromise?: Promise<void>;
    stopRequested: boolean;
    timedOut: boolean;
    principalReleased: boolean;
};

export type SubagentCoordinatorOptions = {
    maxConcurrency?: number;
    maxDepth?: number;
    maxJobs?: number;
};

export type SpawnedSubagent = {
    job: SubagentJobSnapshot;
};

export class SubagentCoordinator {
    private readonly jobs = new Map<string, SubagentJob>();
    private readonly queue: SubagentJob[] = [];
    private readonly changes = new Set<() => void>();
    private readonly delegationContext = new AsyncLocalStorage<DelegationContext>();
    private readonly maxConcurrency: number;
    private readonly maxDepth: number;
    private readonly maxJobs: number;
    private activeCount = 0;
    private closed = false;

    constructor(
        private readonly sessionFactory: SubagentChildSessionFactory,
        readonly tools: SubagentToolCatalog,
        private readonly policyPrincipals: PolicyPrincipalRegistry,
        options: SubagentCoordinatorOptions = {},
    ) {
        this.maxConcurrency = positiveInteger(options.maxConcurrency, DEFAULT_MAX_CONCURRENCY);
        this.maxDepth = nonNegativeInteger(options.maxDepth, DEFAULT_MAX_DEPTH);
        this.maxJobs = positiveInteger(options.maxJobs, DEFAULT_MAX_JOBS);
    }

    async spawn(
        request: SubagentRequest,
        signal?: AbortSignal,
    ): Promise<SpawnedSubagent> {
        this.requireOpen();
        if (signal?.aborted) throw abortError();
        const normalized = this.validateRequest(request);
        const capabilities = new AgentCapabilitySet(normalized.capabilities);
        const parent = this.delegationContext.getStore();
        const depth = parent ? parent.depth + 1 : 0;
        if (depth > this.maxDepth) {
            throw new Error(`Subagent delegation depth ${depth} exceeds the maximum ${this.maxDepth}`);
        }
        if (parent) this.validateNestedSpawn(parent, normalized, capabilities);

        this.evictTerminalJobs();
        const id = `subagent-${crypto.randomUUID()}`;
        this.policyPrincipals.registerPolicyPrincipal(
            id,
            normalized.parentAgentIdentifier,
            capabilities.policyAreas(),
        );
        const job: SubagentJob = {
            id,
            agentIdentifier: id,
            parentId: parent?.jobId,
            depth,
            request: normalized,
            capabilities,
            status: SubagentJobStatus.QUEUED,
            createdAt: Date.now(),
            turns: 0,
            nextTask: normalized.task,
            queuedTasks: [],
            pendingSteering: [],
            stopRequested: false,
            timedOut: false,
            principalReleased: false,
        };
        this.jobs.set(job.id, job);
        this.queue.push(job);
        this.notify(job);
        this.pump();
        return {job: snapshot(job)};
    }

    list(jobIds?: string[]): SubagentJobSnapshot[] {
        return this.selectJobs(jobIds).map(snapshot);
    }

    async status(
        jobIds?: string[],
        waitSeconds = 0,
        signal?: AbortSignal,
        onUpdate?: (jobs: SubagentJobSnapshot[]) => void,
    ): Promise<SubagentJobSnapshot[]> {
        const jobs = this.selectJobs(jobIds);
        if (waitSeconds <= 0 || jobs.every((job) => !isActive(job.status))) return jobs.map(snapshot);
        if (signal?.aborted) throw abortError();

        await new Promise<void>((resolve, reject) => {
            let settled = false;
            const finish = (error?: Error) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                this.changes.delete(changed);
                signal?.removeEventListener("abort", aborted);
                error ? reject(error) : resolve();
            };
            const changed = () => {
                onUpdate?.(jobs.map(snapshot));
                if (jobs.every((job) => !isActive(job.status))) finish();
            };
            const aborted = () => finish(abortError());
            const timeout = setTimeout(() => finish(), Math.max(0, waitSeconds) * 1000);
            timeout.unref();
            this.changes.add(changed);
            signal?.addEventListener("abort", aborted, {once: true});
        });
        return jobs.map(snapshot);
    }

    async message(jobId: string, task: string): Promise<SubagentJobSnapshot> {
        this.requireOpen();
        const job = this.requireManageableJob(jobId);
        const normalizedTask = requiredText(task, "task", 100_000);

        if (job.status === SubagentJobStatus.RUNNING) {
            if (!job.session) {
                job.pendingSteering.push(normalizedTask);
                job.latestLine = "Steering message queued";
                this.notify(job);
                return snapshot(job);
            }
            if (await job.session.steer(normalizedTask)) {
                job.latestLine = "Steering message queued";
                this.notify(job);
                return snapshot(job);
            }
        }

        if (job.status === SubagentJobStatus.IDLE) {
            job.request = {...job.request, task: normalizedTask};
            job.nextTask = normalizedTask;
            job.status = SubagentJobStatus.QUEUED;
            job.latestLine = "Queued follow-up";
            job.finishedAt = undefined;
            job.error = undefined;
            job.stopRequested = false;
            job.timedOut = false;
            this.queue.push(job);
            this.notify(job);
            this.pump();
            return snapshot(job);
        }
        if (job.status === SubagentJobStatus.QUEUED || job.status === SubagentJobStatus.RUNNING) {
            job.queuedTasks.push(normalizedTask);
            job.latestLine = "Queued follow-up";
            this.notify(job);
            return snapshot(job);
        }
        throw new Error(`Subagent conversation cannot receive a message: ${jobId} (${job.status})`);
    }

    async stop(jobId: string): Promise<SubagentJobSnapshot> {
        const root = this.requireManageableJob(jobId);
        const descendants = [...this.jobs.values()]
            .filter((job) => isDescendant(job, root.id, this.jobs))
            .sort((left, right) => right.depth - left.depth);
        for (const job of descendants) await this.stopOne(job);
        await this.stopOne(root);
        this.releaseTerminalPrincipals();
        return snapshot(root);
    }

    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        const jobs = [...this.jobs.values()].sort((left, right) => right.depth - left.depth);
        await Promise.all(jobs.map((job) => this.stopOne(job)));
        this.releaseTerminalPrincipals();
        this.queue.splice(0);
        this.changes.clear();
    }

    private validateNestedSpawn(
        parent: DelegationContext,
        request: SubagentRequest,
        capabilities: AgentCapabilitySet,
    ): void {
        if (request.parentAgentIdentifier !== parent.agentIdentifier) {
            throw new Error("Nested subagent parent policy principal does not match the invoking agent");
        }
        if (!parent.mechanisms.has(AgentMechanismCapability.delegate)) {
            throw new Error("This subagent was not granted the delegate capability");
        }
        for (const capability of capabilities.mechanisms()) {
            if (!parent.mechanisms.has(capability)) {
                throw new Error(`Nested subagent mechanism exceeds the parent capabilities: ${capability}`);
            }
        }
    }

    private validateRequest(request: SubagentRequest): SubagentRequest {
        const capabilities = new AgentCapabilitySet(request.capabilities).all();
        return {
            ...request,
            parentAgentIdentifier: requiredText(
                request.parentAgentIdentifier,
                "parent agent identifier",
                500,
            ),
            task: requiredText(request.task, "task", 100_000),
            role: requiredText(request.role, "role", 120),
            capabilities,
            cwd: requiredText(request.cwd, "cwd", 10_000),
            timeoutSeconds: boundedNumber(request.timeoutSeconds, "timeoutSeconds", 1, 3_600),
            reasoningSkill: enumValue(
                request.reasoningSkill,
                SubagentReasoningSkill,
                "reasoning skill",
            ),
            reasoningAmount: enumValue(
                request.reasoningAmount,
                SubagentReasoningAmount,
                "reasoning amount",
            ),
            modelPreference: modelPreference(request.modelPreference),
            systemPrompt: optionalText(request.systemPrompt, "systemPrompt", 100_000),
            contextPaths: request.contextPaths?.map((entry) => requiredText(entry, "context path", 10_000)),
        };
    }

    private pump(): void {
        while (!this.closed && this.activeCount < this.maxConcurrency) {
            const job = this.queue.shift();
            if (!job) break;
            if (job.status !== SubagentJobStatus.QUEUED) continue;
            this.activeCount++;
            const running = this.executeTurn(job).finally(() => {
                this.activeCount--;
                if (job.runPromise === running) job.runPromise = undefined;
                this.pump();
            });
            job.runPromise = running;
            void running;
        }
    }

    private async executeTurn(job: SubagentJob): Promise<void> {
        job.status = SubagentJobStatus.RUNNING;
        job.startedAt ??= Date.now();
        job.latestLine = "Starting";
        job.stopRequested = false;
        job.timedOut = false;
        const controller = new AbortController();
        job.controller = controller;
        const timeout = setTimeout(() => {
            job.timedOut = true;
            job.latestLine = "Timed out; stopping";
            controller.abort();
            void job.session?.abort();
            this.notify(job);
        }, job.request.timeoutSeconds * 1000);
        timeout.unref();
        this.notify(job);

        try {
            const tools = this.tools.resolve(job.capabilities);
            if (!job.session) {
                job.session = await this.sessionFactory.create({
                    ...job.request,
                    agentIdentifier: job.agentIdentifier,
                }, tools, controller.signal);
                job.resolvedModel = job.session.modelSelection?.model;
                job.resolvedThinkingLevel = job.session.modelSelection?.thinkingLevel;
                job.modelSelectionSource = job.session.modelSelection?.source;
            }
            if (controller.signal.aborted) throw abortError();
            const output = await this.delegationContext.run({
                jobId: job.id,
                agentIdentifier: job.agentIdentifier,
                depth: job.depth,
                mechanisms: new Set(job.capabilities.mechanisms()),
            }, async () => {
                const prompting = job.session!.prompt(job.nextTask, controller.signal, (update) => {
                    job.latestLine = update.latestLine;
                    if (update.output !== undefined) job.output = boundedOutput(update.output);
                    this.notify(job);
                });
                const steering = job.pendingSteering.splice(0);
                const accepted = await Promise.all(steering.map((task) => job.session!.steer(task)));
                for (let index = 0; index < steering.length; index++) {
                    if (!accepted[index]) job.queuedTasks.push(steering[index]!);
                }
                return prompting;
            });
            if (controller.signal.aborted) throw abortError();
            job.output = boundedOutput(output);
            job.latestLine = lastMeaningfulLine(output);
            job.turns++;
            const nextTask = job.queuedTasks.shift();
            if (nextTask) {
                job.request = {...job.request, task: nextTask};
                job.nextTask = nextTask;
                job.status = SubagentJobStatus.QUEUED;
                job.latestLine = "Queued follow-up";
                job.error = undefined;
                job.stopRequested = false;
                job.timedOut = false;
                this.queue.push(job);
            } else {
                job.status = SubagentJobStatus.IDLE;
            }
        } catch (error) {
            job.pendingSteering.splice(0);
            job.queuedTasks.splice(0);
            job.error = errorMessage(error);
            job.finishedAt = Date.now();
            job.status = job.timedOut
                ? SubagentJobStatus.TIMED_OUT
                : job.stopRequested || controller.signal.aborted
                    ? SubagentJobStatus.CANCELLED
                    : SubagentJobStatus.FAILED;
            job.latestLine = job.error;
        } finally {
            clearTimeout(timeout);
            job.controller = undefined;
            const retainedConversation = job.status === SubagentJobStatus.IDLE
                || job.status === SubagentJobStatus.QUEUED;
            if (!retainedConversation) {
                job.session?.dispose();
                job.session = undefined;
            }
            this.notify(job);
            this.releaseTerminalPrincipals();
        }
    }

    private async stopOne(job: SubagentJob): Promise<void> {
        if (job.status === SubagentJobStatus.QUEUED) {
            const index = this.queue.indexOf(job);
            if (index >= 0) this.queue.splice(index, 1);
            job.stopRequested = true;
            job.pendingSteering.splice(0);
            job.queuedTasks.splice(0);
            job.status = SubagentJobStatus.CANCELLED;
            job.finishedAt = Date.now();
            job.latestLine = "Cancelled before starting";
            job.session?.dispose();
            job.session = undefined;
            this.notify(job);
            this.releaseTerminalPrincipals();
            return;
        }
        if (job.status === SubagentJobStatus.RUNNING) {
            job.stopRequested = true;
            job.latestLine = "Stopping";
            job.controller?.abort();
            await job.session?.abort().catch(() => undefined);
            await job.runPromise;
            return;
        }
        if (job.status === SubagentJobStatus.IDLE) {
            job.stopRequested = true;
            job.pendingSteering.splice(0);
            job.queuedTasks.splice(0);
            job.status = SubagentJobStatus.CANCELLED;
            job.finishedAt = Date.now();
            job.latestLine = "Stopped";
            job.session?.dispose();
            job.session = undefined;
            this.notify(job);
            this.releaseTerminalPrincipals();
        }
    }

    private selectJobs(jobIds?: string[]): SubagentJob[] {
        const caller = this.delegationContext.getStore();
        if (!jobIds || jobIds.length === 0) {
            return [...this.jobs.values()]
                .filter((job) => !caller || isDescendant(job, caller.jobId, this.jobs))
                .sort((left, right) => right.createdAt - left.createdAt);
        }
        return [...new Set(jobIds)].map((jobId) => this.requireManageableJob(jobId));
    }

    private requireManageableJob(jobId: string): SubagentJob {
        const job = this.requireJob(jobId);
        const caller = this.delegationContext.getStore();
        if (caller && !isDescendant(job, caller.jobId, this.jobs)) {
            throw new Error(`Subagent job is outside the invoking agent's descendants: ${jobId}`);
        }
        return job;
    }

    private requireJob(jobId: string): SubagentJob {
        const job = this.jobs.get(jobId);
        if (!job) throw new Error(`Unknown subagent job: ${jobId}`);
        return job;
    }

    private requireOpen(): void {
        if (this.closed) throw new Error("Subagent coordinator is closed");
    }

    private releaseTerminalPrincipals(): void {
        let released: boolean;
        do {
            released = false;
            const candidates = [...this.jobs.values()]
                .filter((job) => isTerminal(job.status) && !job.principalReleased)
                .sort((left, right) => right.depth - left.depth);
            for (const job of candidates) {
                const hasRetainedChildren = [...this.jobs.values()].some((candidate) => (
                    candidate.parentId === job.id && !candidate.principalReleased
                ));
                if (hasRetainedChildren) continue;
                this.policyPrincipals.removePolicyPrincipal(job.agentIdentifier);
                job.principalReleased = true;
                released = true;
            }
        } while (released);
    }

    private evictTerminalJobs(): void {
        if (this.jobs.size < this.maxJobs) return;
        const evictable = [...this.jobs.values()]
            .filter((job) => (
                isTerminal(job.status)
                && job.principalReleased
                && ![...this.jobs.values()].some((candidate) => isDescendant(candidate, job.id, this.jobs))
            ))
            .sort((left, right) => (left.finishedAt ?? left.createdAt) - (right.finishedAt ?? right.createdAt));
        while (this.jobs.size >= this.maxJobs && evictable.length > 0) {
            this.jobs.delete(evictable.shift()!.id);
        }
        if (this.jobs.size >= this.maxJobs) throw new Error(`Subagent job limit reached (${this.maxJobs})`);
    }

    private notify(_job: SubagentJob): void {
        for (const listener of [...this.changes]) listener();
    }
}

function snapshot(job: SubagentJob): SubagentJobSnapshot {
    return {
        id: job.id,
        parentId: job.parentId,
        depth: job.depth,
        status: job.status,
        role: job.request.role,
        task: job.request.task,
        capabilities: job.capabilities.all(),
        cwd: job.request.cwd,
        reasoningSkill: job.request.reasoningSkill,
        reasoningAmount: job.request.reasoningAmount,
        resolvedModel: job.resolvedModel,
        resolvedThinkingLevel: job.resolvedThinkingLevel,
        modelSelectionSource: job.modelSelectionSource,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        latestLine: job.latestLine,
        output: job.output,
        error: job.error,
        turns: job.turns,
    };
}

function isActive(status: SubagentJobStatus): boolean {
    return status === SubagentJobStatus.QUEUED || status === SubagentJobStatus.RUNNING;
}

function isTerminal(status: SubagentJobStatus): boolean {
    return status === SubagentJobStatus.FAILED
        || status === SubagentJobStatus.CANCELLED
        || status === SubagentJobStatus.TIMED_OUT;
}

function isDescendant(job: SubagentJob, ancestorId: string, jobs: Map<string, SubagentJob>): boolean {
    let parentId = job.parentId;
    while (parentId) {
        if (parentId === ancestorId) return true;
        parentId = jobs.get(parentId)?.parentId;
    }
    return false;
}

function requiredText(value: unknown, name: string, maxLength: number): string {
    if (typeof value !== "string" || !value.trim()) throw new Error(`Subagent ${name} is required`);
    if (value.length > maxLength) throw new Error(`Subagent ${name} exceeds ${maxLength} characters`);
    return value;
}

function optionalText(value: unknown, name: string, maxLength: number): string | undefined {
    if (value === undefined) return undefined;
    return requiredText(value, name, maxLength);
}

function modelPreference(value: unknown): string {
    const preference = requiredText(value, "model preference", 500);
    if (preference !== AUTO_SUBAGENT_MODEL && !preference.includes("/")) {
        throw new Error("Subagent model preference must be auto or a canonical provider/model");
    }
    return preference;
}

function enumValue<T extends string>(
    value: unknown,
    values: Record<string, T>,
    name: string,
): T {
    if (typeof value === "string" && Object.values(values).includes(value as T)) return value as T;
    throw new Error(`Unsupported subagent ${name}: ${String(value)}`);
}

function boundedNumber(value: unknown, name: string, minimum: number, maximum: number): number {
    if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
        throw new Error(`Subagent ${name} must be between ${minimum} and ${maximum}`);
    }
    return value;
}

function positiveInteger(value: number | undefined, fallback: number): number {
    return value === undefined ? fallback : Math.max(1, Math.floor(value));
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
    return value === undefined ? fallback : Math.max(0, Math.floor(value));
}

function boundedOutput(text: string): string {
    if (text.length <= MAX_JOB_OUTPUT_CHARS) return text;
    const half = Math.floor((MAX_JOB_OUTPUT_CHARS - 40) / 2);
    return `${text.slice(0, half)}\n[Subagent output truncated]\n${text.slice(-half)}`;
}

function lastMeaningfulLine(text: string): string {
    const line = text.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean).at(-1) ?? "Completed";
    return line.length <= 300 ? line : `${line.slice(0, 299)}…`;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function abortError(): Error {
    const error = new Error("Subagent operation was aborted");
    error.name = "AbortError";
    return error;
}
