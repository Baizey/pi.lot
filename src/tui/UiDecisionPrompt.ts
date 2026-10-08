export type UiDecisionField = {
    label: string;
    value: string;
    multiline?: boolean;
    essential?: boolean;
};

export type UiDecisionContext = {
    summary: readonly UiDecisionField[];
    details: readonly UiDecisionField[];
};

/** Dialog-only clients receive the same request information without terminal styling. */
export function formatUiDecisionPrompt(title: string, context?: UiDecisionContext): string {
    if (!context) return title;
    return [
        decisionDisplayText(title),
        "",
        ...[...context.summary, ...context.details].map(({label, value, multiline}) => (
            `${decisionDisplayText(label)}: ${decisionFieldLines({label, value, multiline}).join("\n  ")}`
        )),
    ].join("\n");
}

export function decisionFieldLines(field: UiDecisionField): string[] {
    return (field.multiline ? field.value.split("\n") : [field.value]).map(decisionDisplayText);
}

/** Escape supplied control characters before applying trusted theme styling. */
export function decisionDisplayText(value: string): string {
    return value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, (character) => (
        `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
    ));
}
