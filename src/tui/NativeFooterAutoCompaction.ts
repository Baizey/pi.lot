import {stripVTControlCharacters} from "node:util";
import {FooterComponent} from "@earendil-works/pi-coding-agent";
import type {Component, TUI} from "@earendil-works/pi-tui";

type AutoCompactionSetter = FooterComponent["setAutoCompactEnabled"];

/** Bridges the live setting missing from Pi's public extension context. */
export class NativeFooterAutoCompaction {
    private footer: FooterComponent | undefined;
    private original: AutoCompactionSetter | undefined;
    private decorated: AutoCompactionSetter | undefined;
    private enabled: boolean | undefined;
    private closed = false;

    getEnabled(): boolean | undefined {
        return this.enabled;
    }

    attach(tui: Pick<TUI, "children">): void {
        if (this.closed || this.footer) return;
        for (const child of tui.children) {
            const footer = this.findFooter(child);
            if (!footer) continue;
            this.footer = footer;
            // Pi 0.85.1 exposes a setter but no getter. Read its initial indicator
            // once at a width sufficient for the bounded native statistics fields.
            // Ignore the separately padded model label, which may contain any text.
            const stats = stripVTControlCharacters(footer.render(4096)[1] ?? "").split(/ {2,}/)[0] ?? "";
            this.enabled = stats.includes(" (auto)");
            const original = footer.setAutoCompactEnabled;
            const decorated: AutoCompactionSetter = (enabled) => {
                original.call(footer, enabled);
                if (!this.closed) this.enabled = enabled;
            };
            this.original = original;
            this.decorated = decorated;
            footer.setAutoCompactEnabled = decorated;
            return;
        }
    }

    dispose(): void {
        this.closed = true;
        if (this.footer && this.footer.setAutoCompactEnabled === this.decorated && this.original) {
            this.footer.setAutoCompactEnabled = this.original;
        }
        this.footer = undefined;
        this.original = undefined;
        this.decorated = undefined;
    }

    private findFooter(component: Component): FooterComponent | undefined {
        // Pi and extensions can load different class copies through jiti.
        if (component instanceof FooterComponent || (
            component.constructor.name === FooterComponent.name
            && "setSession" in component && typeof component.setSession === "function"
            && "setAutoCompactEnabled" in component && typeof component.setAutoCompactEnabled === "function"
        )) return component as FooterComponent;
        // Only traverse the public Container interface, never private session state.
        const children = (component as Component & {children?: Component[]}).children;
        if (Array.isArray(children)) {
            for (const child of children) {
                const footer = this.findFooter(child);
                if (footer) return footer;
            }
        }
        return undefined;
    }
}
