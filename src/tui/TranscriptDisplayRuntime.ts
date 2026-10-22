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
import {ThemeColor} from "./Color.js";
import {renderLineFactory} from "./terminalText.js";
import {ToolCallSpinner} from "./tool/ToolCallSpinner.js";
import {ToolDisplayMode} from "./tool/ToolDisplayMode.js";
import {ToolDisplayModes} from "./tool/ToolDisplayModes.js";
import {ToolDisplayRows} from "./tool/ToolDisplayRows.js";
import {ToolPresentationRenderer} from "./tool/ToolPresentationRenderer.js";

const RECENT_FINISHED_TOOL_LIMIT = 5;
const THINKING_PREVIEW_LINES = 12;

type AssistantMessage = Parameters<AssistantMessageComponent["updateContent"]>[0];
type Decoration = {
    refresh(hidden: boolean): void;
    restore(): void;
    toolHidden?(): boolean;
    contentActive?(): boolean;
    toolStatus?: ToolProbe;
};
type ToolProbe = {partial?: boolean; expanded?: boolean; toolCallId?: string; compact?: boolean};
type ToolCompletion = {sequence: number; live: boolean};

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
    private readonly completedToolCalls = new Map<string, ToolCompletion>();
    private nextCompletionSequence = 0;
    private readonly modes: ToolDisplayModes;
    private readonly recentFinishedToolCalls = new Set<string>();
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
        this.pi.on("message_update", (event) => this.observeToolCalls(event.message));
        this.pi.on("message_end", (event) => this.observeToolCalls(event.message));
        this.pi.on("tool_execution_start", (event) => {
            if (!event.parentToolCallId) this.setToolActive(event.toolCallId, true);
        });
        this.pi.on("tool_execution_end", (event) => {
            if (!event.parentToolCallId) {
                this.finishToolCall(event.toolCallId, true);
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
        this.completedToolCalls.clear();
        this.nextCompletionSequence = 0;
        this.context = undefined;
        tui?.invalidate();
        tui?.requestRender();
    }

    private setWorking(working: boolean): void {
        this.activeToolCalls.clear();
        this.working = working;
        if (!working) this.stopWorkingSpinner();
        this.tui?.requestRender();
    }

    private observeToolCalls(message: MessageUpdateEvent["message"]): void {
        if (message.role !== "assistant") return;
        // Pi finishes assistant streaming before executing that message's tools.
        // Aborted/error messages instead finalize their streamed rows without execution events.
        const finished = message.stopReason === "aborted" || message.stopReason === "error";
        for (const block of message.content) {
            if (block.type !== "toolCall") continue;
            if (finished) this.finishToolCall(block.id, true);
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

    private finishToolCall(toolCallId: string, live: boolean): void {
        if (!this.context?.hasUI || this.context.mode !== "tui") return;
        const previous = this.completedToolCalls.get(toolCallId);
        if (previous && (previous.live || !live)) return;
        // Live completions outrank history even when old rows are first discovered later.
        // Discovery order is only a fallback within history; redraws never promote a row.
        this.completedToolCalls.set(toolCallId, {sequence: this.nextCompletionSequence++, live});
        this.tui?.requestRender();
    }

    private refreshRecentFinishedTools(): void {
        const finished: string[] = [];
        for (const decoration of this.decorations.values()) {
            const status = decoration.toolStatus;
            if (status?.partial === false && status.toolCallId !== undefined) finished.push(status.toolCallId);
        }
        finished.sort((left, right) => {
            const a = this.completedToolCalls.get(left)!;
            const b = this.completedToolCalls.get(right)!;
            return Number(b.live) - Number(a.live) || b.sequence - a.sequence;
        });
        this.recentFinishedToolCalls.clear();
        for (const toolCallId of finished.slice(0, RECENT_FINISHED_TOOL_LIMIT)) {
            this.recentFinishedToolCalls.add(toolCallId);
        }
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
        this.recentFinishedToolCalls.clear();
        this.tui = undefined;
    }

    private scan(): void {
        if (this.scanning) return;
        this.scanning = true;
        try {
            const hidden = this.isHidden();
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
            this.refreshRecentFinishedTools();
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
        let source: AssistantMessage | undefined;
        let projection: AssistantMessage | undefined;
        let streaming = false;
        let hidden = this.isHidden();
        let active = true;
        let thinkingScanNeeded = false;
        const decoratedRender: Component["render"] = (width) => {
            // Public setters and mouse callbacks can rebuild runs before a source-container frame.
            if (active && thinkingScanNeeded) {
                thinkingScanNeeded = false;
                this.scan();
            }
            return render.call(component, width);
        };
        const decoratedUpdate: AssistantMessageComponent["updateContent"] = (message, isStreaming) => {
            // Native invalidate, setters, and mouse callbacks pass the last UI message back.
            // Recognize that exact object, not content equality, to retain the real source.
            const original = message === projection && source ? source : message;
            streaming = isStreaming ?? (source ? streaming : original.stopReason === "pending");
            source = original;
            hidden = active && this.isHidden();
            projection = hidden ? this.projectThoughts(original) : undefined;
            update.call(component, projection ?? original, streaming);
            thinkingScanNeeded = true;
        };
        component.render = decoratedRender;
        component.updateContent = decoratedUpdate;
        // The exported API has no last-message getter. invalidate calls our updateContent.
        component.invalidate();
        return {
            contentActive: () => streaming && !!(projection ?? source)?.content.some((block) => (
                (block.type === "text" && block.text.trim())
                || (block.type === "thinking" && block.thinking.trim())
            )),
            refresh: (nextHidden) => {
                if (hidden !== nextHidden && source && component.updateContent === decoratedUpdate) {
                    decoratedUpdate(source, streaming);
                }
                // The enclosing scan visits the newly rebuilt thinking runs next.
                thinkingScanNeeded = false;
            },
            restore: () => {
                active = false;
                if (component.render === decoratedRender) component.render = render;
                if (component.updateContent === decoratedUpdate) {
                    if (source) update.call(component, source, streaming);
                    component.updateContent = update;
                }
            },
        };
    }

    private decorateThinking(component: Component): Decoration {
        const render = component.render;
        let active = true;
        const decorated: Component["render"] = (width) => {
            const lines = render.call(component, width);
            if (!active || !this.context || this.modes.resolve(this.context.ui.getToolsExpanded()) !== ToolDisplayMode.TRUNCATED
                || lines.length <= THINKING_PREVIEW_LINES) return lines;
            const omitted = lines.length - THINKING_PREVIEW_LINES;
            const theme = this.context.ui.theme;
            const notice = renderLineFactory(() => [theme.fg(
                ThemeColor.muted, `... (${omitted} earlier ${omitted === 1 ? "line" : "lines"})`,
            )]);
            return [...notice.render(width), ...lines.slice(-THINKING_PREVIEW_LINES)];
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
                || !this.recentFinishedToolCalls.has(status.toolCallId))) return [];
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
            if (!partial && !wasFinished && status.toolCallId !== undefined) this.finishToolCall(status.toolCallId, true);
            this.refreshRecentFinishedTools();
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
        if (status.partial === false && status.toolCallId !== undefined) this.finishToolCall(status.toolCallId, false);
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

    private projectThoughts(message: AssistantMessage): AssistantMessage {
        return {...message, content: message.content.filter((block) => block.type !== "thinking")};
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
