# MCP

pi.lot uses Pi `0.99.1`'s native MCP adapter for stdio and Streamable HTTP servers. MCP remains an **opaque host capability outside pi.lot's filesystem and network mediation**: stdio servers run host processes, HTTP servers use the host network, and tool annotations are hints, not enforcement. Trust the server and expose only the tools you need.

## Configuration

Put global servers in `~/.pi/agent/mcp.json` (or `mcp.json` under the configured Pi agent directory). Trusted projects can provide `.pi/mcp.json`; those entries override same-named global entries. Untrusted project config is not loaded. No live user configuration is changed by installing pi.lot.

```json
{
  "mcpServers": {
    "local": {
      "command": "my-mcp-server",
      "args": [],
      "env": { "TOKEN": "${MY_TOKEN}" },
      "exposure": "hidden",
      "toolExposure": { "read_resource": "direct" }
    },
    "remote": {
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ${MCP_TOKEN}" },
      "exposure": "hidden"
    }
  }
}
```

A `command` selects stdio; a `url` selects Streamable HTTP. A stdio entry may also set `cwd` and `env`; an HTTP entry may set `headers` and OAuth options. Pi supports `${NAME}` environment substitution and `!command` values for env/headers; prefer `${NAME}` to putting credentials in JSON. The native `timeout` is in **seconds** (per request, reset on progress), and `enabled: false` keeps an entry without connecting. Invalid entries are reported, not used. See [Pi's MCP reference](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md) for transport, OAuth and timeout details.

Native default exposure is `codemode`, **not hidden**. Use `"exposure": "hidden"` and exact `toolExposure` overrides for direct access with least privilege. `toolExposure` patterns use `*` as a glob; `"*": "direct"` exposes every tool of a hidden server, so review it carefully. An exact name overrides a wildcard. Other modes (`codemode`, `codemode-deferred`, `deferred`, `direct`) are available when intentionally selected. Making the whole server `direct` can also expose its resources; use hidden plus per-tool overrides for an explicit tool allowlist. Pi names tools `mcp__<server>__<tool>`. Native aggregate resource tools (`list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource`) can be available to the **root** when a non-hidden server offers resources; they retain pi.lot's tool rendering but are not delegated to children because their server scope is not snapshotted per child.

## Manage servers

`/mcp` opens the native server manager: inspect status, errors and tools; enable/disable, change server exposure, sign in to OAuth servers, or reconnect. `/mcp reconnect <server>` reconnects from a command. From a shell use `pi mcp add`, `pi mcp remove`, `pi mcp list`, `pi mcp login` and `pi mcp logout`. Edit `toolExposure` in the native JSON file and use `/reload` (or a new session) to apply changes. Pi's connection notices are kept quiet for routine connection attention and still-connecting states; config errors, discovery warnings, native load failures, command diagnostics and tool errors still surface. Check `/mcp` for current state.

**Avoid a duplicate native loader in Pilot.** Pilot hosts `createMcpExtension()` itself; set `"extensions": ["-builtin:mcp"]` in Pi user settings (`~/.pi/agent/settings.json`, or the configured agent directory) while using Pilot. Alternatively disable Built-in MCP in `pi config`. This disables Pi's separately auto-loaded built-in extension, **not** Pilot's hosted native adapter; it avoids the duplicate-loader warning. Preserve any other existing extensions in that settings list. Pi's shell `pi mcp` commands still work.

## Subagents and display

A child gets MCP tool definitions only when spawned with the hard `mcp` capability; no ambient native MCP config is loaded into child sessions. Available tools are selected at child creation. Newly exposed tools do not automatically enter an existing child's conversation. At execution, the root's current hidden state and schema are checked, so later hides still block calls. A nested child cannot receive MCP unless its immediate parent has the hard capability. Native resource aggregate tools are root-only, not in delegated child tool sets. MCP is independent of policy-area snapshots and cannot be made filesystem/network mediated by granting `fs_*` or `web_*`. See [Subagents](subagents.md#capability-model).

Pilot still renders MCP tools with its normal compact/full display; `Ctrl+O` toggles tool expansion and `/view-full-tool` selects one full call. See [Security model and limitations](security.md).
