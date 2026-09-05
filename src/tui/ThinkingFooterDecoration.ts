import {stripVTControlCharacters} from "node:util";
import {FooterComponent, type ExtensionContext} from "@earendil-works/pi-coding-agent";
import type {Component, TUI} from "@earendil-works/pi-tui";
import {displayWidth} from "./terminalText.js";

type FooterRender = FooterComponent["render"];

/** Preserves Pi's native footer data/layout while removing its redundant thinking suffix. */
export class ThinkingFooterDecoration {
    private readonly decorations = new Map<FooterComponent, {original: FooterRender; decorated: FooterRender}>();
    private closed = false;

    constructor(private readonly context: ExtensionContext) {}

    attach(tui: Pick<TUI, "children">): void {
        if (this.closed) return;
        for (const child of tui.children ?? []) this.visit(child);
    }

    dispose(): void {
        this.closed = true;
        for (const [footer, {original, decorated}] of this.decorations) {
            if (footer.render === decorated) footer.render = original;
        }
        this.decorations.clear();
    }

    private visit(component: Component): void {
        if (this.isNativeFooter(component)) {
            if (this.decorations.has(component)) return;
            const original = component.render;
            const decorated: FooterRender = (width) => {
                const lines = original.call(component, width);
                if (this.closed || !lines[1]) return lines;
                const result = [...lines];
                result[1] = this.withoutThinkingSuffix(lines[1]);
                return result;
            };
            this.decorations.set(component, {original, decorated});
            component.render = decorated;
            return;
        }
        // Container.children is public; do not depend on InteractiveMode's private footer/session fields.
        const children = (component as Component & {children?: Component[]}).children;
        if (Array.isArray(children)) {
            for (const child of children) this.visit(child);
        }
    }

    private withoutThinkingSuffix(line: string): string {
        const model = this.context.model;
        if (!model?.reasoning) return line;
        const level = this.context.thinkingLevel ?? "off";
        const suffix = ` • ${level === "off" ? "thinking off" : level}`;
        const plain = stripVTControlCharacters(line);
        // At narrow widths Pi may render only part of the suffix. Match only text
        // immediately following the complete model ID at the end of the stats row.
        let visibleSuffix = suffix;
        while (visibleSuffix && !plain.endsWith(model.id + visibleSuffix)) {
            visibleSuffix = visibleSuffix.slice(0, -1);
        }
        if (!visibleSuffix) return line;

        let modelLabel = model.id;
        const withProvider = `(${model.provider}) ${modelLabel}`;
        if (plain.endsWith(withProvider + visibleSuffix)) modelLabel = withProvider;
        const target = modelLabel + visibleSuffix;
        const index = line.lastIndexOf(target);
        if (index < 0) return line;
        // Shift the entire model/provider label right instead of shortening the row.
        // Preserve ANSI styles, native usage totals, context, auto-compaction and subscription labels.
        return line.slice(0, index)
            + " ".repeat(displayWidth(visibleSuffix))
            + modelLabel
            + line.slice(index + target.length);
    }

    private isNativeFooter(component: Component): component is FooterComponent {
        // Pi and extensions can load different copies of the class through jiti.
        return component instanceof FooterComponent || (
            component.constructor.name === FooterComponent.name
            && "setSession" in component && typeof component.setSession === "function"
            && "setAutoCompactEnabled" in component && typeof component.setAutoCompactEnabled === "function"
        );
    }
}
