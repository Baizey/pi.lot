# pi.lot

**Interactive permissions for [Pi](https://pi.dev) on Linux.**

pi.lot lets Pi work across repositories and absolute paths without treating one directory as its entire world. Instead of placing the agent inside a fixed workspace, it asks for permission when a shell command tries to perform a policy-sensitive filesystem or network operation.

The goal is to let Pi work alongside you across the machine while keeping important effects visible and controllable.

> [!WARNING]
> pi.lot is experimental, under active development, and has not been security audited. Do not yet treat it as a hardened sandbox for hostile code.

pi.lot is the successor to [`Baizey/pi-agent-tools`](https://github.com/Baizey/pi-agent-tools).

## What it does

### Filesystem permissions

pi.lot replaces Pi's built-in Bash execution with a Linux-mediated worker. When a command attempts a filesystem operation that is not already covered by policy, pi.lot asks whether to allow or deny it.

Filesystem operations are grouped into:

- **Read**
- **Write**
- **Delete**

Permissions can apply to:

- the current Bash call;
- the current Pi session; or
- future sessions on this computer.

Policies can cover one path or a wider directory scope. More-specific path policies take precedence over broader ones, including policies covering the filesystem root.

Bash calls also include a short purpose explaining what the command is intended to achieve. That purpose is shown alongside permission requests.

### Network permissions

The normal Bash worker also catches actual network activity from a command and its descendants rather than trying to recognize commands such as `curl`, Git, npm, or SSH. It covers:

- hostname resolution;
- IPv4 and IPv6;
- outbound TCP connections;
- outbound UDP flows;
- literal IP addresses;
- normal hostname aliases;
- `localhost` traffic inside the command's private network; and
- a mandatory transparent TCP gateway with HTTP/HTTPS request mediation.

The worker mediates the actual method and canonical URL produced by arbitrary clients—including Git smart HTTP—without parsing the shell command. After coarse flow approval, each new method-and-URL scope is evaluated through the same one-call, session, and persistent policy runtime as filesystem access. The request remains held until policy allows it, before the gateway opens the target-side connection.

When the gateway host has no global IPv6 address and default route, public AAAA answers are returned as DNS NODATA so dual-stack clients fall back to IPv4 before connecting. Local and ULA IPv6 traffic remains available and policy-visible.

Filesystem and network mediation run in one sandbox. The command sees the complete host filesystem through the FUSE policy mount while its private network namespace routes outbound traffic through the network gate.

Full HTTPS method/path inspection is enabled at the start of every session. If a client uses an unsupported private trust store or certificate pinning, disable interception for later Bash calls with:

```text
/network-inspection off
```

In this compatibility mode, HTTP and TLS bytes are relayed unmodified and HTTPS remains end-to-end. DNS and TCP hostname/port policy still applies, but method/path policy is unavailable. Use `/network-inspection on` to restore full inspection, or `/network-inspection` to show the active session value.

### Cleaner tool output

pi.lot adds shared display modes to Pi's Bash, Read, Edit, and Write tools:

- `Ctrl+O` toggles truncated and full output;
- `Alt+O` toggles a minimal title-only view.

Read highlighting and images, Write highlighting, and Edit diffs remain available.

### MCP servers

pi.lot supports MCP servers over stdio and Streamable HTTP. Configuration is stored in:

```text
~/.pilot/mcp.json
```

Tools default to unexposed. Expose only the tools you want Pi to call:

```json
{
  "servers": {
    "example": {
      "transport": "stdio",
      "command": "example-mcp-server",
      "args": [],
      "tools": {
        "expose": ["read_resource"],
        "hide": []
      }
    }
  }
}
```

Manage connections and exposure with:

```text
/mcp show [all|server]
/mcp connect [all|server]
/mcp disconnect [all|server]
/mcp refresh [all|server]
/mcp expose <server> <tool...|*>
/mcp hide <server> <tool...|*>
/mcp reset <server> [tool...|*]
```

MCP is an explicit capability boundary, not part of pi.lot's filesystem or network mediation. Stdio servers run as ordinary host processes, HTTP transports use the host network, and exposed MCP tools may perform effects outside Bash policy.

## Why not use a workspace sandbox?

A workspace sandbox is useful when an agent should only see one directory. That is not always how Pi is used.

You may want Pi to:

- inspect several repositories;
- work with files elsewhere in your home directory;
- use system tools and configuration;
- run normal development commands; or
- stay with you while you move between projects.

pi.lot is designed around that workflow. It preserves broad host visibility while placing interactive policy checks around selected effects.

This is mediation, not complete isolation: an allowed operation still runs with your normal user permissions.

## Requirements

pi.lot currently supports **Linux x86-64 only**.

You will need:

- [Pi](https://pi.dev)
- Node.js and npm
- FUSE 2
- Bubblewrap
- nftables
- iproute2
- `slirp4netns`
- a C compiler and `pkg-config`
- `libnetfilter_queue` development files

The NFQUEUE development package is commonly named:

- `libnetfilter_queue-devel` on Fedora/Bazzite;
- `libnetfilter-queue-dev` on Debian/Ubuntu.

Other package names vary by distribution.

## Installation

From a local checkout:

```bash
npm install
npm run build
pi install "$PWD"
```

To load the extension directly without installing it:

```bash
pi -e "$PWD"
```

After installation, start Pi normally. pi.lot automatically replaces the supported built-in tools and presents permission requests when needed.

## Policy storage

One-call and session permissions live only for their selected lifetime.

Permissions remembered on this computer are stored in:

```text
~/.pilot/pilot.sqlite
```

Synchronized or account-wide policy is not implemented. All remembered policy currently remains local to this computer.

## Policy defaults

Unmatched operations use session defaults before an interactive policy is requested. The initial defaults allow filesystem and web reads, while filesystem writes and other web access ask the user.

Use `/policy-defaults` to show the current values. Change one with response-first syntax:

```text
/policy-defaults allow fs_read
/policy-defaults deny web_extra
/policy-defaults ask_user fs_write
```

The response is one of `allow`, `deny`, or `ask_user`. The policy category is one of `fs_read`, `fs_write`, `web_read`, `web_write`, or `web_extra`. Pi autocompletes both arguments. Changes initially apply only to the current session.

Use `/policy-defaults save` to persist the active values to `~/.pilot/policy-defaults.json`. New sessions load that file automatically. Use `/policy-defaults reset` to restore the active values from the file, or from the built-in defaults when no file exists.

## Current limitations

- Linux only.
- The project has not been security audited.
- Host-side FUSE path resolution still has pathname race windows.
- Versioned live policy replacement and active network-flow revocation are not implemented.
- The combined worker's `/proc`, `/dev`, pseudo-filesystem, and pathname-socket contract needs further hardening and compatibility work.
- Some DNS, HTTP/TLS, UDP-lifecycle, and IPv6 behavior is not yet supported.
- Preserved local IPC can ask another host process to perform network activity outside the network gate.
- Unprivileged Linux namespaces may not preserve every supplementary group.
- An allowed operation retains your ordinary host-user permissions.
- MCP servers and MCP tool effects are intentionally outside filesystem and network policy mediation.

Unsupported, malformed, cancelled, or incomplete mediated operations are intended to fail closed.

## Project status

The filesystem and network policy systems, combined Bash sandbox, session runtime, and tool display controls are implemented as an integrated experimental system. The completed MVP specifications have been retired; remaining correctness, compatibility, and hardening work is tracked in [`POLICY_FUTURE_WORK.md`](./POLICY_FUTURE_WORK.md).

Features from `pi-agent-tools` that have not yet been ported include:

- subagents;
- web search and reading;
- agent-visible session search; and
- shell-command policy.

## Technical details

- [`EXPERIMENT_README.md`](./EXPERIMENT_README.md) describes the current implementation.
- [`CLIENT_TRUST_SUPPORT.md`](./CLIENT_TRUST_SUPPORT.md) lists HTTPS interception trust adapters and limitations.
- [`POLICY_FUTURE_WORK.md`](./POLICY_FUTURE_WORK.md) records the remaining filesystem and network policy work.

## License

ISC
