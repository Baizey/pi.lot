import type {ConfigSyncResult} from "./ConfigSyncService.js";

/** Fixed, credential-free presentation shared by manual and opt-in startup checks. */
export function configSyncStatus(result: ConfigSyncResult): {message: string; severity: "info" | "warning" | "error"} {
    switch (result.kind) {
        case "unconfigured": return {message: "Server is not configured. Use /server login first.", severity: "error"};
        case "busy": return {message: "Configuration synchronization is already running on this computer.", severity: "info"};
        case "binding_changed": return {message: "The configuration sync destination binding changed. Automatic sync is paused; use /server sync on to approve this destination.", severity: "warning"};
        case "complete": {
            const lines = result.items.map((item) => `${item.key}: ${item.status}${item.outcome ? ` (${item.outcome})` : ""}${item.phase ? ` during ${item.phase}` : ""}`);
            const recovery = result.items.filter((item) => item.status === "needs_recovery");
            const attention = recovery.length > 0 || result.items.some((item) => item.status === "failed" || item.status === "deferred");
            return {message: `Configuration sync:\n${lines.join("\n")}\n\nSaved defaults and GLOBAL policy changes take effect in new/reloaded sessions. Web-search settings are read on use.${attention ? "\nPending work or newer local edits are retained for the next sync." : ""}${recovery.length ? `\nInterrupted JSON application requires an explicit choice:\n${recovery.map((item) => `/server sync recover ${item.key} <local|server>`).join("\n")}\nlocal submits the selected local file as a fresh change; server preserves a copy and accepts current server state.` : ""}`,
                severity: attention ? "warning" : "info"};
        }
    }
}
