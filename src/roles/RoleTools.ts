import {randomUUID} from "node:crypto";
import type {ToolDefinition} from "@earendil-works/pi-coding-agent";
import {enumSchema, objectSchema, stringSchema} from "../tools/types.js";
import {ThemeColor} from "../tui/Color.js";
import type {ToolDisplayRows} from "../tui/tool/ToolDisplayRows.js";
import {ToolArgumentLayout, ToolArgumentPlacement, ToolTextDirection, type ToolPresentationSpec} from "../tui/tool/ToolPresentation.js";
import {
    MAX_ROLES, MAX_ROLE_DESCRIPTION, MAX_ROLE_TEXT, MAX_ROLE_TITLE,
    parseRoleProfile, resolveRole, type RoleCatalog, type RoleProfile,
} from "./RoleCatalog.js";
import type {RoleLibrary} from "./RoleStore.js";

type LookupInput = {target?: string};
type Input = {action: "create" | "edit" | "delete"; target?: string; title?: string; text?: string; description?: string};
type Change = {before: RoleProfile | null; after: RoleProfile | null};

const ROLE_LOOKUP_PRESENTATION = {
    toolName: "role_lookup",
    arguments: [{key: "target", placement: ToolArgumentPlacement.TITLE_PRIMARY, color: ThemeColor.text}],
    result: {direction: ToolTextDirection.HEAD, wrap: true},
} satisfies ToolPresentationSpec<LookupInput>;

const ROLE_MANAGE_PRESENTATION = {
    toolName: "role_manage",
    arguments: [
        {key: "action", placement: ToolArgumentPlacement.TITLE_PRIMARY},
        {key: "target", placement: ToolArgumentPlacement.TITLE_PRIMARY, color: ThemeColor.text},
        {key: "title", placement: ToolArgumentPlacement.TITLE_PRIMARY, color: ThemeColor.text},
        {key: "description", layout: ToolArgumentLayout.BLOCK, wrap: true},
        {key: "text", layout: ToolArgumentLayout.BLOCK, color: ThemeColor.text, wrap: true},
    ],
    result: {wrap: true},
} satisfies ToolPresentationSpec<Input>;

export function roleReadTool(library: RoleLibrary, displayRows: ToolDisplayRows): ToolDefinition<any, undefined> {
    return {
        name: "role_lookup",
        label: "Find saved roles",
        description: "List saved roles and their IDs, or inspect one role's instructions. Pass its ID as roleProfile to subagent_spawn.",
        ...displayRows.bind(ROLE_LOOKUP_PRESENTATION),
        parameters: objectSchema({target: stringSchema("Optional role ID or title", MAX_ROLE_TITLE)}),
        async execute(_id, params, signal) {
            signal?.throwIfAborted();
            const input = params as LookupInput;
            const catalog = library.catalog();
            if (input.target !== undefined) {
                const role = resolveRole(catalog, input.target.trim());
                return result(JSON.stringify(role));
            }
            const list = catalog.roles.map(({id, title, description}) => ({id, title, description}));
            return result(JSON.stringify(list));
        },
    };
}

export function roleManageTool(
    library: RoleLibrary,
    onSave: () => void,
    displayRows: ToolDisplayRows,
): ToolDefinition<any, undefined> {
    return {
        name: "role_manage",
        label: "Manage saved roles",
        description: "Create, edit, or delete a saved role. Changes affect future selections and spawns, not permissions or existing assignments.",
        ...displayRows.bind(ROLE_MANAGE_PRESENTATION),
        parameters: objectSchema({
            action: enumSchema(["create", "edit", "delete"], "Role operation"),
            target: stringSchema("Existing role ID or title (edit/delete)", MAX_ROLE_TITLE),
            title: stringSchema("Role title (create or rename)", MAX_ROLE_TITLE),
            text: stringSchema("Saved agent instructions", MAX_ROLE_TEXT),
            description: {type: "string", maxLength: MAX_ROLE_DESCRIPTION, description: "Optional one-line summary. Empty removes it."},
        }, ["action"]),
        async execute(_id, params, signal) {
            signal?.throwIfAborted();
            const input = params as Input;
            const catalog = library.catalog();
            const {before, after} = plan(catalog, input);
            if (before && after && JSON.stringify(before) === JSON.stringify(after)) return result("No changes.");
            const roles = catalog.roles.filter(({id}) => id !== before?.id);
            if (after) roles.push(after);
            library.save(catalog, {roles});
            onSave();
            return result(after ? `Saved ${after.title} (${after.id}).` : `Deleted ${before!.title}.`);
        },
    };
}

function plan(catalog: RoleCatalog, input: Input): Change {
    if (input.action === "create") {
        if (input.target !== undefined) throw new Error("Create does not take a target.");
        if (catalog.roles.length >= MAX_ROLES) throw new Error("The saved role library is full.");
        return {before: null, after: validate(null, input, catalog)};
    }
    if (input.action !== "edit" && input.action !== "delete") throw new Error("Unknown role operation.");
    if (!input.target?.trim()) throw new Error("Specify a role ID or title.");
    const before = resolveRole(catalog, input.target.trim());
    if (input.action === "edit") return {before, after: validate(before, input, catalog)};
    if (input.title !== undefined || input.text !== undefined || input.description !== undefined) {
        throw new Error("Delete only takes a target.");
    }
    return {before, after: null};
}

function validate(before: RoleProfile | null, input: Input, catalog: RoleCatalog): RoleProfile {
    const description = input.description === undefined ? before?.description : input.description.trim() || undefined;
    const after = parseRoleProfile({id: before?.id ?? randomUUID(), title: input.title?.trim() ?? before?.title,
        text: input.text?.trim() ?? before?.text, ...(description === undefined ? {} : {description})});
    if (before?.title.toLowerCase() !== after.title.toLowerCase() && catalog.roles.some(({title}) =>
        title.toLowerCase() === after.title.toLowerCase())) throw new Error("A saved role already has that title.");
    return after;
}

function result(text: string) {
    return {content: [{type: "text" as const, text}], details: undefined};
}
