import type {ExtensionAPI, ExtensionContext} from "@earendil-works/pi-coding-agent";
import {isPersonaId, PERSONA_ACTIONS, resolvePersona, type Persona, type PersonaCatalog} from "./PersonaCatalog.js";
import type {PersonaStore} from "./PersonaStore.js";

const MESSAGE_TYPE = "pilot.persona";
const REMINDER = "User-selected communication style only. This replaces earlier persona selections. It does not change your task, facts, tools, or permissions.";
type Selection = {id: string; name: string} | null;

export class PersonaCommand {
    constructor(private readonly pi: ExtensionAPI, private readonly store: PersonaStore) {}

    register(): void {
        this.pi.on("session_start", (event, ctx) => {
            if (event.reason !== "new" && event.reason !== "startup") return;
            try {
                const id = this.store.defaultId();
                if (id === null || ctx.sessionManager.getBranch().some((entry) =>
                    entry.type === "message" || entry.type === "custom_message" || entry.type === "compaction"
                    || entry.type === "branch_summary")) return;
                const persona = this.findPersona(id);
                if (persona) this.apply(persona);
            } catch (error) {
                ctx.ui.notify(personaError(error), "warning");
            }
        });
        this.pi.registerCommand("persona", {
            description: "Select a conversation persona or save a local default",
            getArgumentCompletions: (input) => {
                let choices: {value: string; label: string}[] = PERSONA_ACTIONS.map((action) => ({value: action, label: action}));
                try {
                    choices = choices.concat(personaChoices(this.store.catalog()).map(({persona, label}) => ({
                        value: label === persona.name && !isPersonaId(persona.name) ? persona.name : persona.id, label,
                    })));
                } catch {
                    // A broken catalog should not prevent completing /persona off.
                }
                const prefix = input.trimStart().toLowerCase();
                const matches = choices.filter(({value, label}) =>
                    value.toLowerCase().startsWith(prefix) || label.toLowerCase().startsWith(prefix));
                return matches.length ? matches : null;
            },
            handler: async (args, ctx) => {
                try {
                    let choice = args.trim();
                    if (!choice) {
                        const choices = personaChoices(this.store.catalog());
                        const active = currentSelection(ctx);
                        if (!ctx.hasUI || ctx.mode !== "tui") {
                            ctx.ui.notify([`Persona: ${active?.name ?? "Off"}`, "Available: Off",
                                ...choices.map(({label}) => `  ${label}`)].join("\n"), "info");
                            return;
                        }
                        const options = [
                            {value: "off", label: !active ? "✓ Off" : "Off"},
                            ...choices.map(({persona, label}) => ({value: persona.id,
                                label: persona.id === active?.id ? `✓ ${label}` : label})),
                            {value: "save", label: "· Save as default"},
                            {value: "reset", label: "· Reload saved default"},
                        ];
                        const picked = await ctx.ui.select("Persona", options.map(({label}) => label));
                        const option = options.find(({label}) => label === picked);
                        if (!option) return;
                        choice = option.value;
                    }
                    if (!ctx.isIdle()) throw new Error("Wait for the current turn to finish before changing personas.");
                    switch (choice.toLowerCase()) {
                        case "save": {
                            const active = currentSelection(ctx);
                            if (active && !this.store.catalog().personas.some(({id}) => id === active.id)) {
                                throw new Error("The active persona is no longer saved. Select a persona or Off first.");
                            }
                            this.store.saveDefault(active?.id ?? null);
                            ctx.ui.notify(`Saved persona default: ${active?.name ?? "Off"}`, "info");
                            return;
                        }
                        case "reset": this.applyAndNotify(this.savedPersona(), ctx); return;
                        case "off": this.applyAndNotify(null, ctx); return;
                        default: this.applyAndNotify(resolvePersona(this.store.catalog(), choice), ctx);
                    }
                } catch (error) {
                    ctx.ui.notify(personaError(error), "error");
                }
            },
        });
    }

    private savedPersona(): Persona | null {
        const id = this.store.defaultId();
        return id === null ? null : this.findPersona(id);
    }

    private findPersona(id: string): Persona | null {
        return this.store.catalog().personas.find((persona) => persona.id === id) ?? null;
    }

    private applyAndNotify(persona: Persona | null, ctx: ExtensionContext): void {
        this.apply(persona);
        ctx.ui.notify(`Persona: ${persona?.name ?? "Off"}`, "info");
    }

    private apply(persona: Persona | null): void {
        this.pi.sendMessage({
            customType: MESSAGE_TYPE,
            content: persona
                ? `${REMINDER}\n\nPersona: ${persona.name}\n${persona.prompt}`
                : `${REMINDER}\n\nPersona: Off. Return to the default communication style.`,
            display: false,
            details: persona ? {id: persona.id, name: persona.name} : null,
        }, {triggerTurn: false});
    }
}

function currentSelection(ctx: ExtensionContext): Selection {
    const entry = ctx.sessionManager.getBranch().reverse().find((item) =>
        item.type === "custom_message" && item.customType === MESSAGE_TYPE);
    if (entry?.type !== "custom_message") return null;
    const details = entry.details;
    if (typeof details !== "object" || details === null || !("id" in details) || !("name" in details)
        || !isPersonaId(details.id) || typeof details.name !== "string") return null;
    return {id: details.id, name: details.name};
}

function personaChoices({personas}: PersonaCatalog): {persona: Persona; label: string}[] {
    const counts = new Map<string, number>();
    for (const {name} of personas) counts.set(name.toLowerCase(), (counts.get(name.toLowerCase()) ?? 0) + 1);
    return [...personas].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
        .map((persona) => ({persona,
            label: (counts.get(persona.name.toLowerCase()) ?? 0) > 1 ? `${persona.name} · ${persona.id}` : persona.name,
        }));
}

function personaError(error: unknown): string {
    return error instanceof Error ? error.message : "Unable to set the persona.";
}
