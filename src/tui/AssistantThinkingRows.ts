import type {AssistantMessageComponent} from "@earendil-works/pi-coding-agent";
import {Markdown, MouseRegion, Spacer, type Component, type Container} from "@earendil-works/pi-tui";

export type ThinkingRun = {
    readonly start: number;
    end: number;
    active: boolean;
    started: boolean;
};
type AssistantMessage = Parameters<AssistantMessageComponent["updateContent"]>[0];
type ContentRow = {component: Component; gap: Spacer; run?: ThinkingRun};

/** Pi 1.4 public-child adapter; native messages and thinking visibility overrides stay untouched. */
export class AssistantThinkingRows {
    private readonly content: Container;
    private readonly nativeChildren: Component[];
    private readonly rows: ContentRow[] = [];
    private readonly tail: Component[];
    private readonly leadingGap = new Spacer(1);
    private installed: Component[] | undefined;
    private active = true;

    constructor(
        component: AssistantMessageComponent,
        source: AssistantMessage,
        runs: readonly ThinkingRun[],
        private readonly label: (active: boolean, width: number) => string[],
        private readonly renderTail: (lines: string[], width: number) => string[],
        private readonly retained: (run: ThinkingRun) => boolean,
    ) {
        // AssistantMessageComponent exposes its content Container through public children.
        const content = component.children[0];
        if (!content || !("children" in content) || !Array.isArray(content.children)) {
            throw new Error("Unsupported native assistant content container");
        }
        this.content = content as Container;
        this.nativeChildren = [...this.content.children];
        const visible = (block: AssistantMessage["content"][number]) => (
            (block.type === "text" && !!block.text.trim()) || (block.type === "thinking" && !!block.thinking.trim())
        );
        let cursor = source.content.some(visible) ? 1 : 0;
        if (cursor && !isSpacer(this.nativeChildren[0])) throw new Error("Unsupported native assistant leading gap");
        for (let index = 0; index < source.content.length;) {
            const block = source.content[index]!;
            if (block.type === "thinking") {
                const start = index;
                let nonempty = false;
                while (source.content[index]?.type === "thinking") {
                    const thinking = source.content[index++]!;
                    nonempty ||= thinking.type === "thinking" && !!thinking.thinking.trim();
                }
                const run = runs.find((candidate) => candidate.start === start)!;
                const native = nonempty ? this.nativeChildren[cursor++] : undefined;
                if (nonempty && (!native || !(native instanceof MouseRegion || (
                    native.constructor.name === MouseRegion.name && typeof native.handleMouse === "function"
                )))) throw new Error("Unsupported native assistant thinking layout");
                const row: Component = {
                    render: (width) => !this.active ? native?.render(width) ?? [] : run.active
                        ? native ? this.renderTail(native.render(width), width) : this.label(true, width)
                        : this.label(false, width),
                    invalidate: () => native?.invalidate(),
                    // Native Pi's thinking handler toggles the entire run, not an individual Markdown row.
                    handleMouse: (event) => !this.active || run.active ? native?.handleMouse?.(event) : undefined,
                };
                this.rows.push({component: row, gap: new Spacer(1), run});
                if (nonempty && source.content.slice(index).some(visible)) {
                    if (!isSpacer(this.nativeChildren[cursor++])) throw new Error("Unsupported native assistant thinking gap");
                }
            } else {
                index++;
                if (block.type !== "text" || !block.text.trim()) continue;
                const native = this.nativeChildren[cursor++];
                if (!native || !(native instanceof Markdown || native.constructor.name === Markdown.name)) {
                    throw new Error("Unsupported native assistant text layout");
                }
                this.rows.push({component: native, gap: new Spacer(1)});
            }
        }
        // Error, abort, and length-stop rows belong to Pi and must never be classified as thinking.
        this.tail = this.nativeChildren.slice(cursor);
    }

    project(hidden: boolean): void {
        let children = this.nativeChildren;
        if (hidden) {
            const visible = this.rows.filter((row) => !row.run || (row.run.started && (row.run.active || this.retained(row.run))));
            children = visible.length ? [this.leadingGap] : [];
            for (let index = 0; index < visible.length; index++) {
                const row = visible[index]!;
                children.push(row.component);
                if (row.run && index + 1 < visible.length) children.push(row.gap);
            }
            children.push(...this.tail);
        }
        if (this.content.children.length === children.length
            && this.content.children.every((child, index) => child === children[index])) return;
        this.content.children = children;
        this.installed = children;
    }

    restore(): void {
        this.active = false;
        if (this.content.children === this.installed) this.content.children = this.nativeChildren;
    }
}

function isSpacer(component: Component | undefined): boolean {
    return component instanceof Spacer || component?.constructor.name === Spacer.name;
}
