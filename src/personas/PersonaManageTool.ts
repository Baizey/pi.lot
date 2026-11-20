import {randomUUID} from "node:crypto";
import type {ExtensionAPI, ToolDefinition} from "@earendil-works/pi-coding-agent";
import {enumSchema, objectSchema, stringSchema} from "../tools/types.js";
import {ThemeColor} from "../tui/Color.js";
import type {ToolDisplayRows} from "../tui/tool/ToolDisplayRows.js";
import {ToolArgumentLayout, ToolArgumentPlacement, ToolTextDirection, type ToolPresentationSpec} from "../tui/tool/ToolPresentation.js";
import {
    MAX_PERSONA_NAME, MAX_PERSONA_PROMPT_BYTES, MAX_PERSONAS, resolvePersona,
    validatePersonaName, validatePersonaPrompt, type Persona, type PersonaCatalog,
} from "./PersonaCatalog.js";
import type {PersonaStore} from "./PersonaStore.js";

type Input = {action: "list" | "create" | "edit" | "delete"; target?: string; name?: string; prompt?: string};
type Change = {before: Persona | null; after: Persona | null};

const PERSONA_MANAGE_PRESENTATION = {
    toolName: "persona_manage",
    arguments: [
        {key: "action", placement: ToolArgumentPlacement.TITLE_PRIMARY},
        {key: "target", placement: ToolArgumentPlacement.TITLE_PRIMARY, color: ThemeColor.text},
        {key: "name", placement: ToolArgumentPlacement.TITLE_PRIMARY, color: ThemeColor.text},
        {key: "prompt", layout: ToolArgumentLayout.BLOCK, color: ThemeColor.text, wrap: true},
    ],
    result: {direction: ToolTextDirection.HEAD, wrap: true},
} satisfies ToolPresentationSpec<Input>;

export function registerPersonaManageTool(pi: ExtensionAPI, store: PersonaStore, displayRows: ToolDisplayRows): void {
    const definition: ToolDefinition<any, undefined> = {
        name: "persona_manage",
        label: "Manage personas",
        description: "List, create, edit, or delete saved personas. "
            + "Personas are user-facing communication styles. This tool does not activate them; the user selects one with /persona.",
        ...displayRows.bind(PERSONA_MANAGE_PRESENTATION),
        parameters: objectSchema({
            action: enumSchema(["list", "create", "edit", "delete"], "Persona operation"),
            target: stringSchema("Existing persona name or ID (edit/delete)", MAX_PERSONA_NAME),
            name: stringSchema("Persona name (required for create; optional rename for edit)", MAX_PERSONA_NAME),
            prompt: stringSchema("Instructions for user-facing tone and style (required for create; optional for edit)", MAX_PERSONA_PROMPT_BYTES),
        }, ["action"]),
        async execute(_toolCallId, params, signal) {
            const input = params as Input;
            signal?.throwIfAborted();
            const catalog = store.catalog();
            if (input.action === "list") {
                return result(catalog.personas.length
                    ? catalog.personas.map(({name, id}) => `${name} (${id})`).join("\n") : "No saved personas.");
            }
            const change = planChange(catalog, input);
            if (change.before && change.after && change.before.name === change.after.name
                && change.before.prompt === change.after.prompt) return result("No changes.");
            const personas = catalog.personas.filter(({id}) => id !== change.before?.id);
            if (change.after) personas.push(change.after);
            store.saveCatalog(catalog, {personas});
            return result(change.after ? `Saved persona: ${change.after.name}. Use /persona to apply it.`
                : `Deleted persona: ${change.before!.name}.`);
        },
    };
    pi.registerTool(definition);
}

function planChange(catalog: PersonaCatalog, input: Input): Change {
    switch (input.action) {
        case "create": {
            if (input.target !== undefined) throw new Error("Create takes a name and style, not an existing target.");
            if (catalog.personas.length >= MAX_PERSONAS) throw new Error("The persona library is full.");
            const name = input.name?.trim();
            const prompt = input.prompt?.trim();
            validatePersonaName(name);
            validatePersonaPrompt(prompt);
            requireUniqueName(catalog, name);
            return {before: null, after: {id: randomUUID(), name, prompt}};
        }
        case "edit": {
            const before = existingPersona(catalog, input.target);
            const name = input.name?.trim() ?? before.name;
            const prompt = input.prompt?.trim() ?? before.prompt;
            validatePersonaName(name);
            validatePersonaPrompt(prompt);
            if (name.toLowerCase() !== before.name.toLowerCase()) requireUniqueName(catalog, name);
            return {before, after: {id: before.id, name, prompt}};
        }
        case "delete":
            if (input.name !== undefined || input.prompt !== undefined) throw new Error("Delete only takes a target.");
            return {before: existingPersona(catalog, input.target), after: null};
        default: throw new Error("Unknown persona operation.");
    }
}

function existingPersona(catalog: PersonaCatalog, target: string | undefined): Persona {
    if (!target?.trim()) throw new Error("Specify the persona name or ID.");
    return resolvePersona(catalog, target.trim());
}

function requireUniqueName(catalog: PersonaCatalog, name: string): void {
    if (catalog.personas.some((persona) => persona.name.toLowerCase() === name.toLowerCase())) {
        throw new Error("A persona already has that name.");
    }
}

function result(text: string) {
    return {content: [{type: "text" as const, text}], details: undefined};
}
