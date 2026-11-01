import path from "node:path";
import {fileURLToPath} from "node:url";

export class PilotDocumentation {
    readonly mainFile: string;
    readonly directory: string;

    constructor(packageRoot = fileURLToPath(new URL("../../", import.meta.url))) {
        this.mainFile = path.join(packageRoot, "README.md");
        this.directory = path.join(packageRoot, "docs");
    }

    routingPrompt(): string {
        return [
            "pi.lot documentation (read only for relevant pi.lot features or archive-tool use):",
            `- Main documentation: ${this.mainFile}`,
            `- Additional docs: ${this.directory}`,
            "- Installation or setup: read docs/installation.md.",
            "- Policies, permissions, network mediation, credentials, or audit logs: read docs/policy.md.",
            "- Subagents or delegation: read docs/subagents.md.",
            "- Web search: read docs/web-search.md.",
            "- pi.server connections, session uploads, archive browsing, or saved configuration sync/recovery: read docs/server.md; also read it before using archive_list/archive_fetch.",
            "- Security model or limitations: read docs/security.md.",
            "Resolve docs/... under Additional docs, not the current working directory, and read relevant files before answering.",
        ].join("\n");
    }
}
