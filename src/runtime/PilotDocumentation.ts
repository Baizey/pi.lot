import path from "node:path";
import {fileURLToPath} from "node:url";

export class PilotDocumentation {
    readonly directory = fileURLToPath(new URL("../../docs", import.meta.url));

    routingPrompt(): string {
        return [
            "pi.lot documentation (read only for relevant pi.lot features or archive-tool use):",
            `- Main documentation: ${path.join(this.directory, "README.md")}`,
            `- Additional docs: ${this.directory}`,
            "- Installation or setup: read installation.md.",
            "- Policies, permissions, network mediation, sandboxing settings, credentials, or audit logs: read policy.md.",
            "- Subagents or delegation: read subagents.md.",
            "- Web search: read web-search.md.",
            "- pi.server connections, session uploads, archive browsing, or saved configuration sync/recovery: read server.md; also read it before using archive_list/archive_fetch.",
            "- Security model or limitations: read security.md.",
            "Resolve these Markdown paths under Additional docs, not the current working directory, and read relevant files before answering. Historical engineering investigations are not current capability guarantees.",
        ].join("\n");
    }
}
