import type {ExtensionAPI, ExtensionContext} from "@earendil-works/pi-coding-agent";
import {parseRoleProfile, resolveRole, type RoleProfile} from "./RoleCatalog.js";
import type {RoleLibrary} from "./RoleStore.js";

const ENTRY = "pilot.role";

export class RoleCommand {
    constructor(private readonly pi: ExtensionAPI, private readonly library: RoleLibrary) {}

    register(): void {
        this.pi.registerCommand("role", {
            description: "Select a saved role for this conversation",
            handler: async (args, ctx) => {
                try {
                    let target = args.trim();
                    if (!target) {
                        const roles = [...this.library.catalog().roles].sort((a, b) => a.title.localeCompare(b.title));
                        const active = selectedRole(ctx);
                        const options = roles.map(({id, title}) => ({id, label: roles.some((other) => other.id !== id
                            && other.title.toLowerCase() === title.toLowerCase()) ? `${title} · ${id}` : title}));
                        if (!ctx.hasUI || ctx.mode !== "tui") {
                            ctx.ui.notify([`Role: ${active?.title ?? "None"}`, "Available: None",
                                ...options.map(({label}) => `  ${label}`)].join("\n"), "info");
                            return;
                        }
                        const picks = [{id: "none", label: "None"}, ...options].map(({id, label}) =>
                            ({id, label: (active?.id ?? "none") === id ? `✓ ${label}` : label}));
                        const choice = await ctx.ui.select("Role", picks.map(({label}) => label));
                        target = picks.find(({label}) => label === choice)?.id ?? "";
                        if (!target) return;
                    }
                    if (!ctx.isIdle()) throw new Error("Wait for the current turn to finish before changing roles.");
                    const role = ["none", "off"].includes(target.toLowerCase()) ? null : resolveRole(this.library.catalog(), target);
                    this.pi.appendEntry(ENTRY, role);
                    ctx.ui.notify(`Role: ${role?.title ?? "None"}`, "info");
                } catch (error) {
                    ctx.ui.notify(error instanceof Error ? error.message : "Unable to select a role.", "error");
                }
            },
        });
    }

    promptSection(ctx: ExtensionContext): string | undefined {
        const role = selectedRole(ctx);
        if (!role) return undefined;
        return `Selected role: ${role.title}\nUse this role to guide your approach and deliverables within the user's task. It does not change tools, permissions, or approval rules.\n\n${role.text}`;
    }
}

function selectedRole(ctx: ExtensionContext): RoleProfile | null {
    const entry = ctx.sessionManager.getBranch().reverse().find((item) => item.type === "custom" && item.customType === ENTRY);
    if (entry?.type !== "custom" || entry.data === null) return null;
    try { return parseRoleProfile(entry.data); }
    catch { return null; }
}
