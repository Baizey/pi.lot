import {
    AssistantMessageComponent,
    BranchSummaryMessageComponent,
    CompactionSummaryMessageComponent,
    ToolExecutionComponent,
    type ExtensionAPI,
    type ExtensionContext,
    type MessageUpdateEvent,
    type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import {Image, MouseRegion, type Component, type TUI} from "@earendil-works/pi-tui";
import {AssistantThinkingRows, type ThinkingRun} from "./AssistantThinkingRows.js";
import {ThemeColor} from "./Color.js";
import {renderLineFactory} from "./terminalText.js";
import {ToolCallSpinner} from "./tool/ToolCallSpinner.js";
import {ToolDisplayMode} from "./tool/ToolDisplayMode.js";
import {ToolDisplayModes} from "./tool/ToolDisplayModes.js";
import {ToolDisplayRows} from "./tool/ToolDisplayRows.js";
import {ToolPresentationRenderer} from "./tool/ToolPresentationRenderer.js";

const RECENT_FINISHED_LIMIT = 5;
const THINKING_PREVIEW_LINES = 12;

type AssistantMessage = Parameters<AssistantMessageComponent["updateContent"]>[0];
type Decoration = {
    refresh(hidden: boolean): void;
    restore(): void;
    toolHidden?(): boolean;
    contentActive?(): boolean;
    toolStatus?: ToolProbe;
    thinkingRuns?(): readonly ThinkingRun[];
    project?(): void;
};
type ToolProbe = {partial?: boolean; expanded?: boolean; toolCallId?: string; compact?: boolean};
type CompletionKey = string | ThinkingRun;
type Completion = {sequence: number; live: boolean};
type ThinkingMessage = {
    source: AssistantMessage;
    runs: ThinkingRun[];
    streaming: boolean;
    observed: boolean;
    closedBlocks: Set<number>;
    cursor?: number;
    activeBlock?: number;
};

/** UI-only projection of native rows; never changes the session transcript. */
export class TranscriptDisplayRuntime {
    private context: ExtensionContext | undefined;
    private tui: TUI | undefined;
    private scanning = false;
    private unsubscribe: (() => void) | undefined;
    private readonly decorations = new Map<Component, Decoration>();
    private probe: ToolProbe | undefined;
    private registered = false;
    private reportedUnknownPartial = false;
    private working = false;
    private workingSpinner: ToolCallSpinner | undefined;
    private readonly activeToolCalls = new Set<string>();
    private readonly completions = new Map<CompletionKey, Completion>();
    private nextCompletionSequence = 0;
    private readonly modes: ToolDisplayModes;
    private readonly recentFinished = new Set<CompletionKey>();
    private readonly transcriptOrder = new Map<CompletionKey, number>();
    private thinkingSources = new WeakMap<AssistantMessage, ThinkingMessage>();
    private readonly thinkingEntries = new Map<string, ThinkingMessage>();
    private readonly thinkingMessages = new Map<number, ThinkingMessage[]>();
    private readonly claimedThinkingMessages = new Set<ThinkingMessage>();
    private streamingThinkingMessage: ThinkingMessage | undefined;
    private thinkingLeaf: string | null | undefined;
    private readonly workingPlaceholder = renderLineFactory(() => this.renderWorkingPlaceholder(), 1);

    constructor(private readonly pi: ExtensionAPI, private readonly displayRows: ToolDisplayRows) {
        this.modes = displayRows.modes;
    }

    /** Register before other resolvers so next() includes MCP/resumed tool renderers. */
    register(): void {
        if (this.registered) throw new Error("Transcript display runtime is already registered");
        this.registered = true;
        this.pi.on("agent_start", () => this.setWorking(true));
        this.pi.on("agent_end", () => this.setWorking(false));
        this.pi.on("message_start", (event) => this.observeThinking(event.message, true, undefined, true));
        this.pi.on("message_update", (event) => {
            this.observeThinking(event.message, true, event.assistantMessageEvent);
            this.observeToolCalls(event.message);
        });
        this.pi.on("message_end", (event) => {
            this.observeThinking(event.message, false);
            this.observeToolCalls(event.message);
        });
        this.pi.on("turn_end", (event) => {
            if (event.message.role === "assistant") {
                const message = this.thinkingSources.get(event.message);
                if (message) this.thinkingEntries.set(event.messageEntryId, message);
            }
        });
        this.pi.on("tool_execution_start", (event) => {
            if (!event.parentToolCallId) this.setToolActive(event.toolCallId, true);
        });
        this.pi.on("tool_execution_end", (event) => {
            if (!event.parentToolCallId) {
                this.finishCompletion(event.toolCallId, true);
                this.setToolActive(event.toolCallId, false);
            }
        });
        this.pi.registerToolRenderer((name, next) => {
            const renderers = next();
            if (!renderers) return undefined;
            const observed: ToolRenderers = {...renderers};
            const call = renderers.renderCall;
            const result = renderers.renderResult;
            const fallback = new ToolPresentationRenderer<Record<string, unknown>>({toolName: name, arguments: []});
            if (call) observed.renderCall = (args, theme, context) => {
                if (this.probe) Object.assign(this.probe, {
                    partial: context.isPartial, expanded: context.expanded, toolCallId: context.toolCallId, compact: !!result,
                });
                const compact = !context.isPartial && this.modes.resolve(context.expanded) === ToolDisplayMode.HIDDEN;
                if (compact && !this.displayRows.callPresentation(name)) {
                    // Foreign call renderers need a safe header too; keep their active layout unchanged.
                    try {
                        call(args, theme, context);
                    } catch {
                        // A failing foreign renderer must not bypass the compact projection.
                    }
                    return fallback.renderCall(undefined, theme, ToolDisplayMode.MINIMAL, {outputPad: context.outputPad});
                }
                return call(args, theme, context);
            };
            if (result) observed.renderResult = (value, options, theme, context) => {
                if (this.probe) Object.assign(this.probe, {
                    partial: context.isPartial, expanded: context.expanded, toolCallId: context.toolCallId, compact: !!call,
                });
                if (!options.isPartial && this.modes.resolve(options.expanded) === ToolDisplayMode.HIDDEN) {
                    try {
                        // Allow renderer cleanup, but never fall back to completed output on a render failure.
                        result(value, options, theme, context);
                    } catch {
                        // The finished-result projection remains empty even if native fallback would show text.
                    }
                    return renderLineFactory(() => []);
                }
                return result(value, options, theme, context);
            };
            return observed;
        });
    }

    startSession(ctx: ExtensionContext): void {
        if (this.context) throw new Error("Transcript display session is already started");
        this.context = ctx;
        this.reportedUnknownPartial = false;
        if (ctx.hasUI && ctx.mode === "tui") {
            this.unsubscribe = this.modes.subscribe(() => {
                if (!this.tui) return;
                this.scan();
                this.tui.invalidate();
                this.tui.requestRender();
            });
        }
    }

    /** Called by the existing editor factory; does not claim editor ownership. */
    attach(tui: TUI): void {
        if (!this.context?.hasUI || this.context.mode !== "tui") return;
        if (this.tui !== tui) {
            this.detach();
            this.tui = tui;
        }
        this.scan();
        tui.requestRender();
    }

    stopSession(): void {
        this.unsubscribe?.();
        this.unsubscribe = undefined;
        this.setWorking(false);
        const tui = this.tui;
        this.detach();
        this.completions.clear();
        this.transcriptOrder.clear();
        this.thinkingSources = new WeakMap();
        this.thinkingEntries.clear();
        this.thinkingMessages.clear();
        this.claimedThinkingMessages.clear();
        this.streamingThinkingMessage = undefined;
        this.thinkingLeaf = undefined;
        this.nextCompletionSequence = 0;
        this.context = undefined;
        tui?.invalidate();
        tui?.requestRender();
    }

    private setWorking(working: boolean): void {
        this.activeToolCalls.clear();
        this.working = working;
        if (!working) {
            this.stopWorkingSpinner();
            for (const messages of this.thinkingMessages.values()) {
                for (const message of messages) {
                    for (const run of message.runs) {
                        if (!run.active) continue;
                        run.active = false;
                        message.closedBlocks.add(run.end - 1);
                        this.finishCompletion(run, true);
                    }
                    message.streaming = false;
                }
            }
            this.streamingThinkingMessage = undefined;
            this.refreshRecentFinishedItems();
        }
        this.tui?.requestRender();
    }

    private observeToolCalls(message: MessageUpdateEvent["message"]): void {
        if (message.role !== "assistant") return;
        // Pi finishes assistant streaming before executing that message's tools.
        // Aborted/error messages instead finalize their streamed rows without execution events.
        const finished = message.stopReason === "aborted" || message.stopReason === "error";
        for (const block of message.content) {
            if (block.type !== "toolCall") continue;
            if (finished) this.finishCompletion(block.id, true);
            this.setToolActive(block.id, !finished);
        }
    }

    private setToolActive(toolCallId: string, active: boolean): void {
        if (!this.working || !this.context?.hasUI || this.context.mode !== "tui"
            || this.activeToolCalls.has(toolCallId) === active) return;
        if (active) this.activeToolCalls.add(toolCallId);
        else this.activeToolCalls.delete(toolCallId);
        this.tui?.requestRender();
    }

    private observeThinking(
        source: MessageUpdateEvent["message"], streaming: boolean,
        event?: MessageUpdateEvent["assistantMessageEvent"], start = false,
    ): void {
        if (source.role !== "assistant" || !this.context?.hasUI || this.context.mode !== "tui") return;
        const message = this.getThinkingMessage(source, start ? undefined : this.streamingThinkingMessage, start);
        message.observed = true;
        message.streaming = streaming;
        if (start) {
            message.cursor = -1;
            message.activeBlock = undefined;
        } else if (event && "contentIndex" in event) {
            const previousCursor = message.cursor ?? -1;
            message.cursor = Math.max(previousCursor, event.contentIndex);
            if (event.type === "thinking_start") message.closedBlocks.delete(event.contentIndex);
            if (event.type === "thinking_start" || event.type === "thinking_delta") {
                if (event.contentIndex >= previousCursor && !message.closedBlocks.has(event.contentIndex)) {
                    message.activeBlock = event.contentIndex;
                }
            } else if (event.type === "thinking_end") {
                message.closedBlocks.add(event.contentIndex);
                if (message.activeBlock === event.contentIndex) message.activeBlock = undefined;
            } else if (message.activeBlock !== undefined && event.contentIndex > message.activeBlock
                && event.contentIndex >= previousCursor) {
                // Responses slots can finish independently: an older text/tool event
                // must not complete a later thinking block that is still streaming.
                message.activeBlock = undefined;
            }
        }
        this.syncThinking(message, source, streaming, true);
        this.streamingThinkingMessage = streaming ? message : undefined;
        this.tui?.requestRender();
    }

    private getThinkingMessage(source: AssistantMessage, previous?: ThinkingMessage, fresh = false): ThinkingMessage {
        let message = this.thinkingSources.get(source) ?? (fresh ? undefined : previous);
        const candidates = this.thinkingMessages.get(source.timestamp) ?? [];
        if (!message && !fresh && candidates.length) {
            const content = JSON.stringify(source.content);
            // Timestamps only narrow the search. Source aliases, entry IDs, content, and
            // transcript occurrence keep distinct messages with equal timestamps separate.
            message = candidates.find((candidate) => !this.claimedThinkingMessages.has(candidate)
                && candidate.source.provider === source.provider && candidate.source.model === source.model
                && candidate.source.responseId === source.responseId
                && JSON.stringify(candidate.source.content) === content);
        }
        if (!message) {
            message = {source, runs: [], streaming: false, observed: false, closedBlocks: new Set()};
            candidates.push(message);
            this.thinkingMessages.set(source.timestamp, candidates);
        }
        this.thinkingSources.set(source, message);
        return message;
    }

    private reconcileThinkingEntries(): void {
        const manager = this.context!.sessionManager;
        const leaf = manager.getLeafId();
        if (this.thinkingLeaf === leaf) return;
        this.thinkingLeaf = leaf;
        for (const entry of manager.getBranch()) {
            if (entry.type !== "message" || entry.message.role !== "assistant") continue;
            const message = this.thinkingEntries.get(entry.id) ?? this.thinkingSources.get(entry.message)
                ?? this.getThinkingMessage(entry.message, undefined, true);
            this.thinkingEntries.set(entry.id, message);
            this.thinkingSources.set(entry.message, message);
        }
    }

    private thinkingRuns(message: ThinkingMessage, source: AssistantMessage): ThinkingRun[] {
        const runs: ThinkingRun[] = [];
        for (let index = 0; index < source.content.length;) {
            if (source.content[index]?.type !== "thinking") { index++; continue; }
            const start = index;
            while (source.content[index]?.type === "thinking") index++;
            let run = message.runs.find((candidate) => candidate.start === start);
            if (!run) {
                run = {start, end: index, active: false, started: false};
                message.runs.push(run);
            }
            run.end = Math.max(run.end, index);
            runs.push(run);
        }
        return runs;
    }

    private syncThinking(message: ThinkingMessage, source: AssistantMessage, streaming: boolean, live: boolean): void {
        // Native invalidation may still hold an older snapshot while extension handlers
        // already observed the next event. Only events may advance an observed record.
        if (message.observed && !live) return;
        message.source = source;
        if (!message.observed) message.streaming = streaming;
        for (const run of this.thinkingRuns(message, source)) {
            run.started ||= !message.streaming || message.cursor === undefined || run.start <= message.cursor;
            const active = run.started && message.streaming && (message.cursor === undefined
                ? run.end === source.content.length && !message.closedBlocks.has(run.end - 1)
                : message.activeBlock !== undefined && run.start <= message.activeBlock && message.activeBlock < run.end);
            if (active && !run.active) this.completions.delete(run);
            if (run.started && !active) this.finishCompletion(run, live || run.active);
            run.active = active;
        }
        if (!message.streaming) {
            for (const run of message.runs) {
                if (!run.active) continue;
                run.active = false;
                this.finishCompletion(run, live);
            }
        }
    }

    private finishCompletion(key: CompletionKey, live: boolean): void {
        if (!this.context?.hasUI || this.context.mode !== "tui") return;
        const previous = this.completions.get(key);
        if (previous && (previous.live || !live)) return;
        // Live completions outrank history; redraws never promote a finished item.
        this.completions.set(key, {sequence: this.nextCompletionSequence++, live});
        this.tui?.requestRender();
    }

    private refreshRecentFinishedItems(): void {
        const finished = new Set<CompletionKey>();
        for (const decoration of this.decorations.values()) {
            const status = decoration.toolStatus;
            if (status?.partial === false && status.toolCallId !== undefined) finished.add(status.toolCallId);
            for (const run of decoration.thinkingRuns?.() ?? []) if (run.started && !run.active) finished.add(run);
        }
        const ordered = [...finished].sort((left, right) => {
            const a = this.completions.get(left)!;
            const b = this.completions.get(right)!;
            return Number(b.live) - Number(a.live) || (a.live ? b.sequence - a.sequence
                : (this.transcriptOrder.get(right) ?? -1) - (this.transcriptOrder.get(left) ?? -1));
        });
        this.recentFinished.clear();
        for (const key of ordered.slice(0, RECENT_FINISHED_LIMIT)) this.recentFinished.add(key);
    }

    private renderWorkingPlaceholder(): string[] {
        if (!this.working || !this.isHidden() || this.activeToolCalls.size > 0
            || [...this.decorations.values()].some((decoration) => decoration.contentActive?.())) {
            this.stopWorkingSpinner();
            return [];
        }
        this.workingSpinner ??= new ToolCallSpinner(() => this.tui?.requestRender());
        const theme = this.context!.ui.theme;
        return [
            `${theme.fg(ThemeColor.accent, this.workingSpinner.frame())} ${theme.fg(ThemeColor.toolTitle, theme.bold("Working…"))}`,
        ];
    }

    private stopWorkingSpinner(): void {
        this.workingSpinner?.stop();
        this.workingSpinner = undefined;
    }

    private detach(): void {
        this.stopWorkingSpinner();
        for (const decoration of this.decorations.values()) decoration.restore();
        this.decorations.clear();
        this.recentFinished.clear();
        this.tui = undefined;
    }

    private scan(): void {
        if (this.scanning) return;
        this.scanning = true;
        try {
            const hidden = this.isHidden();
            this.claimedThinkingMessages.clear();
            this.transcriptOrder.clear();
            this.reconcileThinkingEntries();
            const seen = new Set<Component>();
            const visit = (component: Component, toolHidden?: () => boolean, source = false, assistantContent = false): void => {
                if (seen.has(component)) return;
                seen.add(component);
                const kind = nativeComponentKind(component);
                let decoration = this.decorations.get(component);
                if (!decoration) {
                    switch (kind) {
                        case "assistant":
                            decoration = this.decorateAssistant(component as AssistantMessageComponent);
                            break;
                        case "tool":
                            decoration = this.decorateTool(component as ToolExecutionComponent);
                            break;
                        case "summary":
                            decoration = this.decorateSummary(component);
                            break;
                    }
                    // Pi injects a stable facade whose method getters return fresh bound
                    // functions. Decorate the real mounted source containers instead of
                    // assigning methods on that facade. Fullscreen ScrollViews render these
                    // same sources even when they bypass the TUI's root render method.
                    if (!decoration && source && Array.isArray((component as Component & {children?: Component[]}).children)) {
                        decoration = this.decorateSource(component);
                    }
                    // In Pi 1.4, the public MouseRegions under assistant content wrap thinking runs.
                    // Clip their rendered Markdown, not raw text or any private child component.
                    if (!decoration && assistantContent && (component instanceof MouseRegion || (
                        component.constructor.name === MouseRegion.name
                        && "handleMouse" in component && typeof component.handleMouse === "function"
                    ))) decoration = this.decorateThinking(component);
                    // Native result images are drawn independently of tool renderers. Hide
                    // those too, without hiding conversation images or changing image settings.
                    if (!decoration && toolHidden && (component instanceof Image || (
                        component.constructor.name === Image.name
                        && "getImageId" in component && typeof component.getImageId === "function"
                    ))) decoration = this.decorateSummary(component, toolHidden);
                    if (decoration) this.decorations.set(component, decoration);
                }
                decoration?.refresh(hidden);
                const status = decoration?.toolStatus;
                if (status?.toolCallId !== undefined) this.transcriptOrder.set(status.toolCallId, this.transcriptOrder.size);
                for (const run of decoration?.thinkingRuns?.() ?? []) this.transcriptOrder.set(run, this.transcriptOrder.size);
                // Container's children are public. MouseRegion/other private interiors are not traversed.
                const children = (component as Component & {children?: Component[]}).children;
                if (Array.isArray(children)) {
                    for (const child of children) {
                        visit(child, decoration?.toolHidden ?? toolHidden, false, assistantContent || kind === "assistant");
                    }
                }
            };
            for (const child of this.tui?.children ?? []) visit(child, undefined, true);
            for (const [component, decoration] of this.decorations) {
                if (seen.has(component)) continue;
                decoration.restore();
                this.decorations.delete(component);
            }
            this.refreshRecentFinishedItems();
            for (const decoration of this.decorations.values()) decoration.project?.();
        } finally {
            this.scanning = false;
        }
    }

    private decorateSource(component: Component): Decoration {
        const render = component.render;
        let active = true;
        const decorated: Component["render"] = (width) => {
            if (active) this.scan();
            const lines = render.call(component, width);
            // Pi mounts the scrollable document first; subsequent sources belong
            // to the fixed input dock. Append only to that document's projection.
            if (!active || component !== this.tui?.children[0]) return lines;
            const placeholder = this.workingPlaceholder.render(width);
            return placeholder.length > 0 ? [...lines, "", ...placeholder] : lines;
        };
        component.render = decorated;
        return {
            refresh: () => {},
            restore: () => {
                active = false;
                if (component.render === decorated) component.render = render;
            },
        };
    }

    private decorateAssistant(component: AssistantMessageComponent): Decoration {
        const update = component.updateContent;
        const render = component.render;
        let message: ThinkingMessage | undefined;
        let rows: AssistantThinkingRows | undefined;
        let displayedRuns: ThinkingRun[] = [];
        let displayedText = false;
        let streaming = false;
        let active = true;
        let thinkingScanNeeded = false;
        const decoratedRender: Component["render"] = (width) => {
            if (active) {
                // Setters and mouse callbacks can rebuild runs before a source-container frame.
                if (thinkingScanNeeded) { thinkingScanNeeded = false; this.scan(); }
                rows?.project(this.isHidden());
            }
            return render.call(component, width);
        };
        const decoratedUpdate: AssistantMessageComponent["updateContent"] = (source, isStreaming) => {
            streaming = isStreaming ?? (message ? streaming : source.stopReason === "pending");
            if (active) {
                message = this.getThinkingMessage(source, message);
                this.syncThinking(message, source, streaming, false);
            }
            rows?.restore();
            update.call(component, source, streaming);
            displayedText = source.content.some((block) => block.type === "text" && !!block.text.trim());
            if (active && message) {
                displayedRuns = this.thinkingRuns(message, source);
                for (const run of displayedRuns) {
                    if (!message.streaming && !run.started) {
                        run.started = true;
                        this.finishCompletion(run, false);
                    }
                }
            }
            if (active && displayedRuns.length) {
                rows = new AssistantThinkingRows(component, source, displayedRuns,
                    (partial, width) => this.renderThinkingLabel(partial, width),
                    (lines, width) => this.renderThinkingTail(lines, width),
                    (run) => this.recentFinished.has(run));
            } else rows = undefined;
            thinkingScanNeeded = true;
        };
        component.render = decoratedRender;
        component.updateContent = decoratedUpdate;
        component.invalidate();
        return {
            thinkingRuns: () => displayedRuns,
            contentActive: () => !!message?.streaming && (displayedText || displayedRuns.some((run) => run.active)),
            refresh: () => {
                // Traverse native regions before the final Conversation projection so
                // the first Ctrl+O Preview frame already has tail decorators installed.
                rows?.project(false);
                if (message) this.claimedThinkingMessages.add(message);
                thinkingScanNeeded = false;
            },
            project: () => rows?.project(this.isHidden()),
            restore: () => {
                active = false;
                rows?.restore();
                if (component.render === decoratedRender) component.render = render;
                if (component.updateContent === decoratedUpdate) component.updateContent = update;
            },
        };
    }

    private renderThinkingLabel(active: boolean, width: number): string[] {
        const label = active ? "Thinking..." : "Thinking";
        return renderLineFactory(() => [this.context?.ui.theme.fg(ThemeColor.thinkingText, label) ?? label], 1).render(width);
    }

    private renderThinkingTail(lines: string[], width: number): string[] {
        if (lines.length <= THINKING_PREVIEW_LINES) return lines;
        const omitted = lines.length - THINKING_PREVIEW_LINES;
        const label = `... (${omitted} earlier ${omitted === 1 ? "line" : "lines"})`;
        const notice = renderLineFactory(() => [this.context?.ui.theme.fg(ThemeColor.muted, label) ?? label]);
        return [...notice.render(width), ...lines.slice(-THINKING_PREVIEW_LINES)];
    }

    private decorateThinking(component: Component): Decoration {
        const render = component.render;
        let active = true;
        const decorated: Component["render"] = (width) => {
            const lines = render.call(component, width);
            if (!active || !this.context || this.modes.resolve(this.context.ui.getToolsExpanded()) !== ToolDisplayMode.TRUNCATED
                || lines.length <= THINKING_PREVIEW_LINES) return lines;
            return this.renderThinkingTail(lines, width);
        };
        component.render = decorated;
        return {
            refresh: () => {},
            restore: () => {
                active = false;
                if (component.render === decorated) component.render = render;
            },
        };
    }

    private decorateTool(component: ToolExecutionComponent): Decoration {
        const render = component.render;
        const update = component.updateResult;
        const expand = component.setExpanded;
        const status: ToolProbe = {};
        // Pi permits mouse overrides per tool. Text, images, and completion must
        // resolve the same row-local slot, not the global default for other rows.
        const toolHidden = () => this.modes.resolve(
            status.expanded ?? this.context?.ui.getToolsExpanded() ?? false,
        ) === ToolDisplayMode.HIDDEN;
        let active = true;
        let hidden = toolHidden();
        const decoratedRender: ToolExecutionComponent["render"] = (width) => {
            const hidden = active && toolHidden();
            if (hidden && status.partial === false && (!status.compact || status.toolCallId === undefined
                || !this.recentFinished.has(status.toolCallId))) return [];
            const lines = render.call(component, width);
            // Removing partial-result images must not leave their trailing spacer rows.
            if (hidden) while (lines.at(-1) === "") lines.pop();
            return lines;
        };
        const decoratedUpdate: ToolExecutionComponent["updateResult"] = (result, partial = false) => {
            const wasFinished = status.partial === false;
            status.partial = partial;
            const previousProbe = this.probe;
            this.probe = status;
            try {
                update.call(component, result, partial);
            } finally {
                this.probe = previousProbe;
            }
            if (!partial && !wasFinished && status.toolCallId !== undefined) this.finishCompletion(status.toolCallId, true);
            this.refreshRecentFinishedItems();
        };
        const decoratedExpand: ToolExecutionComponent["setExpanded"] = (expanded) => {
            status.expanded = expanded;
            expand.call(component, expanded);
        };
        component.render = decoratedRender;
        component.updateResult = decoratedUpdate;
        component.setExpanded = decoratedExpand;
        // Probe only the synchronous public renderer context emitted by this invalidate.
        // Capture the public call ID to join this row to session completion order.
        const previousProbe = this.probe;
        this.probe = status;
        try {
            component.invalidate();
        } finally {
            this.probe = previousProbe;
        }
        if (status.partial === false && status.toolCallId !== undefined) this.finishCompletion(status.toolCallId, false);
        return {
            toolHidden,
            toolStatus: status,
            // Streamed argument headers take over even before execution starts.
            contentActive: () => status.partial === true,
            refresh: () => {
                const nextHidden = toolHidden();
                if (hidden !== nextHidden) component.invalidate();
                hidden = nextHidden;
                if (hidden && status.partial === undefined) this.reportUnknownPartial();
            },
            restore: () => {
                active = false;
                if (component.render === decoratedRender) component.render = render;
                if (component.updateResult === decoratedUpdate) component.updateResult = update;
                if (component.setExpanded === decoratedExpand) component.setExpanded = expand;
            },
        };
    }

    private decorateSummary(component: Component, isHidden = () => this.isHidden()): Decoration {
        const render = component.render;
        let active = true;
        const decorated: Component["render"] = (width) =>
            active && isHidden() ? [] : render.call(component, width);
        component.render = decorated;
        return {
            refresh: () => {},
            restore: () => {
                active = false;
                if (component.render === decorated) component.render = render;
            },
        };
    }

    private isHidden(): boolean {
        return !!this.context && this.modes.resolve(this.context.ui.getToolsExpanded()) === ToolDisplayMode.HIDDEN;
    }

    private reportUnknownPartial(): void {
        if (this.reportedUnknownPartial) return;
        this.reportedUnknownPartial = true;
        this.context?.ui.notify(
            "Hidden view cannot classify an existing native tool row without a public renderer context; it remains visible until its next result update.",
            "warning",
        );
    }
}

/** Native compatibility boundary: also accept Pi's separate jiti-loaded class copies. */
function nativeComponentKind(component: Component): "assistant" | "tool" | "summary" | undefined {
    if (component instanceof AssistantMessageComponent || (
        component.constructor.name === AssistantMessageComponent.name
        && "updateContent" in component && typeof component.updateContent === "function"
        && "setHideThinkingBlock" in component && typeof component.setHideThinkingBlock === "function"
    )) return "assistant";
    if (component instanceof ToolExecutionComponent || (
        component.constructor.name === ToolExecutionComponent.name
        && "updateResult" in component && typeof component.updateResult === "function"
        && "setExpanded" in component && typeof component.setExpanded === "function"
    )) return "tool";
    if (component instanceof CompactionSummaryMessageComponent || component instanceof BranchSummaryMessageComponent || (
        (component.constructor.name === CompactionSummaryMessageComponent.name
            || component.constructor.name === BranchSummaryMessageComponent.name)
        && "setExpanded" in component && typeof component.setExpanded === "function"
    )) return "summary";
    return undefined;
}
