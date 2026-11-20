import {isProfileId} from "../storage/profileId.js";

export const MAX_ROLES = 64;
export const MAX_ROLE_TITLE = 48;
export const MAX_ROLE_TEXT = 4096;
export const MAX_ROLE_DESCRIPTION = 256;
const RESERVED = ["off", "none", "save", "reset"];

export type RoleProfile = {id: string; title: string; text: string; description?: string};
export type RoleCatalog = {roles: RoleProfile[]};

export function parseRoleCatalog(value: unknown): RoleCatalog {
    if (!record(value) || Object.keys(value).length !== 1 || !Object.hasOwn(value, "roles")
        || !Array.isArray(value.roles) || value.roles.length > MAX_ROLES) throw new Error("Invalid role catalog.");
    const ids = new Set<string>();
    const roles = value.roles.map((entry) => {
        const role = parseRoleProfile(entry);
        if (ids.has(role.id)) throw new Error("Duplicate saved role ID.");
        ids.add(role.id);
        return role;
    });
    return {roles};
}

export function parseRoleProfile(value: unknown): RoleProfile {
    if (!record(value) || !["id", "title", "text"].every((key) => Object.hasOwn(value, key))
        || Object.keys(value).some((key) => !["id", "title", "text", "description"].includes(key))
        || !isProfileId(value.id)) throw new Error("Invalid saved role.");
    const {id, title, text, description} = value;
    if (typeof title !== "string" || !title.length || title.length > MAX_ROLE_TITLE || title !== title.trim()
        || /[^ -~]/u.test(title) || RESERVED.includes(title.toLowerCase())) {
        throw new Error("Use a role title of 1–48 printable ASCII characters, excluding None, Off, Save and Reset.");
    }
    if (!boundedText(text, MAX_ROLE_TEXT) || /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u.test(text)) {
        throw new Error("Use nonempty role instructions up to 4096 UTF-8 bytes, without control characters.");
    }
    if (Object.hasOwn(value, "description")) {
        if (!boundedText(description, MAX_ROLE_DESCRIPTION) || /[\p{Cc}\u2028\u2029]/u.test(description)) {
            throw new Error("Use a single-line description up to 256 UTF-8 bytes.");
        }
        return {id, title, text, description};
    }
    return {id, title, text};
}

export function resolveRole({roles}: RoleCatalog, target: string): RoleProfile {
    const byId = roles.find(({id}) => id === target);
    if (byId) return byId;
    const matches = roles.filter(({title}) => title.toLowerCase() === target.toLowerCase());
    if (matches.length > 1) throw new Error("That title matches multiple saved roles. Use a role ID.");
    if (matches[0]) return matches[0];
    throw new Error("Saved role not found.");
}

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedText(value: unknown, maxBytes: number): value is string {
    return typeof value === "string" && value.length > 0 && value === value.trim()
        && Buffer.byteLength(value) <= maxBytes && !/\p{Surrogate}/u.test(value);
}
