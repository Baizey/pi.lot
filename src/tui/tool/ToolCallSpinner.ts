import {Loader, type TUI} from "@earendil-works/pi-tui";

export type ToolCallSpinnerState = {
    /** Undefined before animation starts; null once the row is finished or cleared. */
    pilotCallSpinner?: ToolCallSpinner | null;
};

/** Pi's loader animation, owned by one tool row rather than a terminal renderer. */
export class ToolCallSpinner extends Loader {
    constructor(invalidate: () => void) {
        let initialized = false;
        // Tool renderers receive a row invalidator, not the TUI. Loader only needs
        // requestRender; suppress its constructor redraw until the row owns it.
        super({requestRender: () => {
            if (initialized) invalidate();
        }} as TUI, (text) => text, (text) => text, "");
        initialized = true;
    }

    frame(): string {
        return this.getRenderedIndicator();
    }
}
