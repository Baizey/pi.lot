export const PERSONA_ACTIONS = ["off", "save", "reset"] as const;
export const MAX_PERSONAS = 64;
export const MAX_PERSONA_NAME = 48;
export const MAX_PERSONA_PROMPT_BYTES = 4096;
export const MAX_PERSONA_CATALOG_BYTES = 256 * 1024;

export type Persona = {id: string; name: string; prompt: string};
export type PersonaCatalog = {personas: Persona[]};

export function isPersonaId(value: unknown): value is string {
    return typeof value === "string" && value.length === 36
        && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
}

export function parsePersonaCatalog(value: unknown): PersonaCatalog {
    if (!exactObject(value, ["personas"]) || !Array.isArray(value.personas) || value.personas.length > MAX_PERSONAS) {
        throw new Error("Invalid persona library.");
    }
    const seen = new Set<string>();
    const personas = value.personas.map((entry): Persona => {
        if (!exactObject(entry, ["id", "name", "prompt"]) || !isPersonaId(entry.id) || seen.has(entry.id)) {
            throw new Error("Persona IDs must be valid and unique.");
        }
        seen.add(entry.id);
        const {id, name, prompt} = entry;
        validatePersonaName(name);
        validatePersonaPrompt(prompt);
        return {id, name, prompt};
    });
    return {personas};
}

export function validatePersonaName(name: unknown): asserts name is string {
    if (typeof name !== "string" || name !== name.trim() || name.length === 0 || name.length > MAX_PERSONA_NAME
        || /[^ -~]/u.test(name) || PERSONA_ACTIONS.some((action) => action === name.toLowerCase())) {
        throw new Error("Use a name of 1–48 printable ASCII characters other than off, save, or reset.");
    }
}

export function validatePersonaPrompt(prompt: unknown): asserts prompt is string {
    if (typeof prompt !== "string" || prompt !== prompt.trim() || prompt.length === 0
        || Buffer.byteLength(prompt) > MAX_PERSONA_PROMPT_BYTES
        || /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\p{Surrogate}]/u.test(prompt)) {
        throw new Error("Use a nonempty style description up to 4096 UTF-8 bytes, without control characters.");
    }
}

export function resolvePersona({personas}: PersonaCatalog, target: string): Persona {
    const id = personas.find((persona) => persona.id === target);
    if (id) return id;
    const matches = personas.filter((persona) => persona.name.toLowerCase() === target.toLowerCase());
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) throw new Error("That name matches multiple personas. Use the picker or specify an ID.");
    throw new Error("Persona not found.");
}

function exactObject<K extends string>(value: unknown, keys: readonly K[]): value is Record<K, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
