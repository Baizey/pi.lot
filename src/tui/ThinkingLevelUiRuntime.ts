import {
    CustomEditor,
    type ExtensionContext,
    type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import type {EditorComponent} from "@earendil-works/pi-tui";
import {ThemeColor} from "./Color.js";
import {NativeFooterAutoCompaction} from "./NativeFooterAutoCompaction.js";
import {PilotFooter} from "./PilotFooter.js";
import {formatThinkingIndicator} from "./ThinkingIndicator.js";

type EditorFactory = NonNullable<Parameters<ExtensionUIContext["setEditorComponent"]>[0]>;
type ThinkingUiSession = {context: ExtensionContext};

const STATUS_KEY = "pi.lot-thinking";

/** Owns the structured footer and thinking colors while preserving editor behavior. */
export class ThinkingLevelUiRuntime {
    private session: ThinkingUiSession | undefined;
    private previousEditorFactory: EditorFactory | undefined;
    private editorFactory: EditorFactory | undefined;
    private lastStatus: string | undefined;
    private autoCompaction: NativeFooterAutoCompaction | undefined;
    private footer: PilotFooter | undefined;

    startSession(ctx: ExtensionContext): void {
        if (this.session) throw new Error("Thinking-level UI session is already started");
        const session = {context: ctx};
        this.session = session;
        if (!ctx.hasUI || ctx.mode !== "tui") return;

        this.previousEditorFactory = ctx.ui.getEditorComponent();
        const previous = this.previousEditorFactory;
        const autoCompaction = new NativeFooterAutoCompaction();
        this.autoCompaction = autoCompaction;
        this.editorFactory = (tui, theme, keybindings) => {
            autoCompaction.attach(tui);
            return this.decorateEditor(
                previous?.(tui, theme, keybindings)
                    ?? new CustomEditor(tui, theme, keybindings, {embedWorkingStatus: true}),
                session,
            );
        };
        ctx.ui.setEditorComponent(this.editorFactory);
        ctx.ui.setFooter((_tui, _theme, footerData) => {
            const footer = new PilotFooter(ctx, footerData, () => autoCompaction.getEnabled());
            this.footer = footer;
            return footer;
        });
        this.update();
    }

    update(): void {
        const ctx = this.session?.context;
        if (!ctx?.hasUI || ctx.mode !== "tui") return;
        const status = formatThinkingIndicator(ctx);
        // Updates can originate from editor invalidation/rendering; do not schedule a render loop.
        if (status === this.lastStatus) return;
        this.lastStatus = status;
        ctx.ui.setStatus(STATUS_KEY, status);
    }

    stopSession(): void {
        const ctx = this.session?.context;
        const factory = this.editorFactory;
        const previous = this.previousEditorFactory;
        this.session = undefined;
        this.editorFactory = undefined;
        this.previousEditorFactory = undefined;
        this.lastStatus = undefined;
        this.autoCompaction?.dispose();
        this.autoCompaction = undefined;
        const footer = this.footer;
        this.footer = undefined;
        if (!ctx?.hasUI || ctx.mode !== "tui") return;

        // Pi disposes the previous component when another extension replaces the footer.
        if (footer && !footer.disposed) ctx.ui.setFooter(undefined);
        ctx.ui.setStatus(STATUS_KEY, undefined);
        // A later extension may have installed its own editor. Do not replace it on teardown.
        if (factory && ctx.ui.getEditorComponent() === factory) {
            ctx.ui.setEditorComponent(previous);
        }
    }

    private decorateEditor(editor: EditorComponent, session: ThinkingUiSession): EditorComponent {
        const ctx = session.context;
        const render = editor.render.bind(editor);
        const invalidate = editor.invalidate.bind(editor);
        // Decorate only rendering so cursor/focus, input, autocomplete, app shortcuts, and
        // any pre-existing custom editor remain on the original editor instance.
        editor.render = (width) => {
            if (this.session !== session) return render(width);
            this.update();
            const originalBorder = editor.borderColor;
            if (originalBorder) {
                const color = editor.getText().trimStart().startsWith("!")
                    ? ThemeColor.bashMode
                    : ThemeColor.thinkingXhigh;
                editor.borderColor = (text) => ctx.ui.theme.fg(color, text);
            }
            try {
                return render(width);
            } finally {
                editor.borderColor = originalBorder;
            }
        };
        editor.invalidate = () => {
            invalidate();
            // Pi invalidates the editor on theme changes; read the current theme rather
            // than retaining ANSI strings from the theme supplied to the factory.
            if (this.session === session) this.update();
        };
        return editor;
    }
}
