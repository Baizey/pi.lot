import {
    CustomEditor,
    type ExtensionContext,
    type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import type {EditorComponent} from "@earendil-works/pi-tui";
import {ThemeColor} from "./Color.js";
import {ThinkingFooterDecoration} from "./ThinkingFooterDecoration.js";

type EditorFactory = NonNullable<Parameters<ExtensionUIContext["setEditorComponent"]>[0]>;
type ThinkingLevel = NonNullable<ExtensionContext["thinkingLevel"]>;
type ThinkingUiSession = {context: ExtensionContext};

const STATUS_KEY = "pi.lot-thinking";
const THINKING_STEPS = {
    off: {filled: 0, color: ThemeColor.thinkingOff},
    minimal: {filled: 1, color: ThemeColor.thinkingMinimal},
    low: {filled: 2, color: ThemeColor.thinkingLow},
    medium: {filled: 3, color: ThemeColor.thinkingMedium},
    high: {filled: 4, color: ThemeColor.thinkingHigh},
    xhigh: {filled: 5, color: ThemeColor.thinkingXhigh},
    max: {filled: 6, color: ThemeColor.thinkingMax},
} satisfies Record<ThinkingLevel, {filled: number; color: ThemeColor}>;

/** Moves thinking-level color into the footer without replacing Pi's footer or editor behavior. */
export class ThinkingLevelUiRuntime {
    private session: ThinkingUiSession | undefined;
    private previousEditorFactory: EditorFactory | undefined;
    private editorFactory: EditorFactory | undefined;
    private lastStatus: string | undefined;
    private footerDecoration: ThinkingFooterDecoration | undefined;

    startSession(ctx: ExtensionContext): void {
        if (this.session) throw new Error("Thinking-level UI session is already started");
        const session = {context: ctx};
        this.session = session;
        if (!ctx.hasUI || ctx.mode !== "tui") return;

        this.previousEditorFactory = ctx.ui.getEditorComponent();
        const previous = this.previousEditorFactory;
        const footer = new ThinkingFooterDecoration(ctx);
        this.footerDecoration = footer;
        this.editorFactory = (tui, theme, keybindings) => {
            footer.attach(tui);
            return this.decorateEditor(
                previous?.(tui, theme, keybindings)
                    ?? new CustomEditor(tui, theme, keybindings, {embedWorkingStatus: true}),
                session,
            );
        };
        ctx.ui.setEditorComponent(this.editorFactory);
        this.update();
    }

    update(): void {
        const ctx = this.session?.context;
        if (!ctx?.hasUI || ctx.mode !== "tui") return;
        const level = ctx.model?.reasoning ? (ctx.thinkingLevel ?? "off") : "off";
        const {filled, color} = THINKING_STEPS[level];
        const total = Math.max(THINKING_STEPS.xhigh.filled, filled);
        const theme = ctx.ui.theme;
        const bar = theme.fg(color, "■".repeat(filled))
            + theme.fg(ThemeColor.thinkingOff, "□".repeat(total - filled));
        const status = `${theme.fg(ThemeColor.dim, "Thinking")} ${bar} ${theme.fg(color, level)}`;
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
        this.footerDecoration?.dispose();
        this.footerDecoration = undefined;
        if (!ctx?.hasUI || ctx.mode !== "tui") return;

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
