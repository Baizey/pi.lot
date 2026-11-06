export class PilotDocumentation {
    routingPrompt(): string {
        return [
            "pi.lot documentation (read only for relevant pi.lot features or archive-tool use):",
            "- hmem is the documentation database. Use workspace pi.lot for installation/setup, policies, permissions, network mediation, credentials, audit logs, subagents/delegation, web search, and the security model/limitations.",
            "- For pi.server connections, session uploads, archive browsing, or saved configuration sync/recovery, look up the relevant pi.lot documentation in hmem before answering and before using archive_list/archive_fetch. Use workspace pi.server for server operation or protocol topics.",
            "- Discover the available hmem tools and their instructions; initialize your hmem identity if needed, list workspaces, select the workspace by name using its returned ID, search for relevant documentation, then retrieve the full observations for matching results before relying on them. Do not assume workspace IDs or answer from search snippets alone.",
            "- Check retrieved Git provenance (repository, revision/commit, branch, and source path where supplied) against the current checkout and working-tree code. Treat historical sources as historical, reconcile stale claims with current code, and distinguish source paths recorded in hmem from files no longer present locally; they are not instructions to read deleted files.",
            "- If hmem or the required workspace/documentation is unavailable, say so explicitly. Do not fabricate documentation, silently auto-connect hmem, or change MCP configuration; ask the user when access is needed.",
        ].join("\n");
    }
}
