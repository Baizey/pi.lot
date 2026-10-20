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
import {Image, type Component, type TUI} from "@earendil-works/pi-tui";
import {ThemeColor} from "./Color.js";
import {renderLineFactory} from "./terminalText.js";
import {ToolCallSpinner} from "./tool/ToolCallSpinner.js";
import {ToolDisplayMode} from "./tool/ToolDisplayMode.js";
import {ToolDisplayModes} from "./tool/ToolDisplayModes.js";

type AssistantMessage = Parameters<AssistantMessageComponent["updateContent"]>[0];
type Decoration = {
    refresh(hidden: boolean): void;
    restore(): void;
    toolHidden?(): boolean;
    contentActive?(): boolean;
};
type ToolProbe = {partial?: boolean; expanded?: boolean};

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
    private readonly workingPlaceholder = renderLineFactory(() => this.renderWorkingPlaceholder(), 1);

    constructor(private readonly pi: ExtensionAPI, private readonly modes: ToolDisplayModes) {}

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
            if (!event.parentToolCallId) this.setToolActive(event.toolCallId, false);
        });
        this.pi.registerToolRenderer((_name, next) => {
            const renderers = next();
            if (!renderers) return undefined;
            const observed: ToolRenderers = {...renderers};
            const call = renderers.renderCall;
            const result = renderers.renderResult;
            if (call) observed.renderCall = (args, theme, context) => {
                if (this.probe) Object.assign(this.probe, {partial: context.isPartial, expanded: context.expanded});
                return call(args, theme, context);
            };
            if (result) observed.renderResult = (value, options, theme, context) => {
                if (this.probe) Object.assign(this.probe, {partial: context.isPartial, expanded: context.expanded});
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
        // Track only current calls: unavailable historical renderers cannot be probed.
        for (const block of message.content) {
            if (block.type === "toolCall") this.setToolActive(block.id, true);
        }
    }

    private setToolActive(toolCallId: string, active: boolean): void {
        if (!this.working || !this.context?.hasUI || this.context.mode !== "tui"
            || this.activeToolCalls.has(toolCallId) === active) return;
        if (active) this.activeToolCalls.add(toolCallId);
        else this.activeToolCalls.delete(toolCallId);
        this.tui?.requestRender();
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
        this.tui = undefined;
    }

    private scan(): void {
        if (this.scanning) return;
        this.scanning = true;
        try {
            const hidden = this.isHidden();
            const seen = new Set<Component>();
            const visit = (component: Component, toolHidden?: () => boolean, source = false): void => {
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
                    for (const child of children) visit(child, decoration?.toolHidden ?? toolHidden);
                }
            };
            for (const child of this.tui?.children ?? []) visit(child, undefined, true);
            for (const [component, decoration] of this.decorations) {
                if (seen.has(component)) continue;
                decoration.restore();
                this.decorations.delete(component);
            }
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
        let source: AssistantMessage | undefined;
        let projection: AssistantMessage | undefined;
        let streaming = false;
        let hidden = this.isHidden();
        let active = true;
        const decoratedUpdate: AssistantMessageComponent["updateContent"] = (message, isStreaming) => {
            // Native invalidate, setters, and mouse callbacks pass the last UI message back.
            // Recognize that exact object, not content equality, to retain the real source.
            const original = message === projection && source ? source : message;
            streaming = isStreaming ?? (source ? streaming : original.stopReason === "pending");
            source = original;
            hidden = active && this.isHidden();
            projection = hidden ? this.projectThoughts(original) : undefined;
            update.call(component, projection ?? original, streaming);
        };
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
            },
            restore: () => {
                active = false;
                if (component.updateContent === decoratedUpdate) {
                    if (source) update.call(component, source, streaming);
                    component.updateContent = update;
                }
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
            if (hidden && status.partial === false) return [];
            const lines = render.call(component, width);
            // Removing partial-result images must not leave their trailing spacer rows.
            if (hidden) while (lines.at(-1) === "") lines.pop();
            return lines;
        };
        const decoratedUpdate: ToolExecutionComponent["updateResult"] = (result, partial = false) => {
            status.partial = partial;
            update.call(component, result, partial);
        };
        const decoratedExpand: ToolExecutionComponent["setExpanded"] = (expanded) => {
            status.expanded = expanded;
            expand.call(component, expanded);
        };
        component.render = decoratedRender;
        component.updateResult = decoratedUpdate;
        component.setExpanded = decoratedExpand;
        // Probe only the synchronous public renderer context emitted by this invalidate.
        // No tool identifiers, private status, or historic event inventories are needed.
        const previousProbe = this.probe;
        this.probe = status;
        try {
            component.invalidate();
        } finally {
            this.probe = previousProbe;
        }
        return {
            toolHidden,
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
