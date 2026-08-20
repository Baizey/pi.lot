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

### Host credential IPC

The worker inherits the Pi process environment and sees ordinary credential files through the mediated filesystem. pi.lot also preserves selected host credential protocols whose live Unix-socket inodes cannot pass through FUSE:

- Secret Service clients receive a per-command D-Bus proxy filtered to `org.freedesktop.secrets`; and
- the live socket named by `SSH_AUTH_SOCK` is imported read-only, covering OpenSSH agents and compatible providers such as 1Password.

These are protocol capabilities rather than tool-specific integrations. GitHub CLI, libsecret, `go-keyring`, Git credential helpers, SSH, and other compatible clients keep their normal authentication behavior. The proxy and socket mounts exist only for the Bash call and are removed during cleanup.

Missing configuration uses the built-in Secret Service and SSH-agent defaults. Create `~/.pilot/credential-ipc.json` to replace them or add other real-world protocols:

```json
{
  "version": 1,
  "sessionBus": {
    "enabled": true,
    "talk": ["org.freedesktop.secrets"]
  },
  "unixSockets": [
    {
      "id": "ssh-agent",
      "environment": "SSH_AUTH_SOCK",
      "optional": true
    },
    {
      "id": "gpg-agent",
      "path": "${XDG_RUNTIME_DIR}/gnupg/S.gpg-agent",
      "optional": true
    }
  ]
}
```

Each socket declares exactly one source: an environment variable containing its pathname, or an absolute pathname. Paths support only explicit `${VARIABLE}` expansion—no shell syntax. `optional` defaults to `true`; missing required sockets are reported as IPC errors. Set an entry's `enabled` field to `false` to keep it documented but inactive. Configuration is strictly validated and loaded once when the Pi session starts.

Pathname IPC is outside filesystem and network mediation. A preserved host service may perform effects on the worker's behalf using the user's normal authority; those delegated effects are an explicit boundary of the current model.

### Cleaner tool output

pi.lot uses Pi's native `Ctrl+O` expansion state as a global density toggle for built-in, subagent, and MCP tools. Collapsed tools show a minimal title-only view; expanded tools show bounded argument and result previews. Use `/view-full-tool` to toggle row-local full views. Enter toggles the selected row without closing the bounded list; Escape closes it.

Full Read and Write views retain Pi's native text and syntax highlighting, Read retains native image behavior, and full Edit views retain Pi's native diff preview.

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

### Subagents

pi.lot provides child agents with separate model context and conversation state through four agent-callable tools:

- `subagent_spawn` starts `sync`, `async`, or `conversation` work;
- `subagent_status` inspects jobs and can wait for active work;
- `subagent_message` continues an idle conversation session; and
- `subagent_stop` stops a job and its descendants.

Capabilities are explicit. A child receives only its requested toolkits:

- `bash` provides the same policy-mediated Bash implementation owned by the root pi.lot session;
- `mcp` provides MCP tools that are currently exposed; and
- `delegate` allows bounded nested delegation.

Children default to no tools and inherit the invoking model, thinking level, and working directory unless the spawn request overrides them. Nested children cannot exceed their parent's toolkit ceiling. The coordinator limits concurrent turns, delegation depth, retained output, and retained jobs; root session shutdown aborts all active children before policy and MCP resources close.

Child agents currently use Pi's in-process SDK with in-memory sessions. They have independent model context, but they are not separate operating-system processes. Async jobs and conversations are not persisted across root session shutdown.

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
- `xdg-dbus-proxy`
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
- Subagents have separate model sessions but currently share the root Pi process.

Unsupported, malformed, cancelled, or incomplete mediated operations are intended to fail closed.

## Project status

The filesystem and network policy systems, combined Bash sandbox, session runtime, and tool display controls are implemented as an integrated experimental system. The completed MVP specifications have been retired; remaining correctness, compatibility, and hardening work is tracked in [`POLICY_FUTURE_WORK.md`](./POLICY_FUTURE_WORK.md).

Features from `pi-agent-tools` that have not yet been ported include:

- subagent personas, model profiles, persistence, and tree UI;
- web search and reading;
- agent-visible session search; and
- shell-command policy.

## Technical details

- [`EXPERIMENT_README.md`](./EXPERIMENT_README.md) describes the current implementation.
- [`CLIENT_TRUST_SUPPORT.md`](./CLIENT_TRUST_SUPPORT.md) lists HTTPS interception trust adapters and limitations.
- [`POLICY_FUTURE_WORK.md`](./POLICY_FUTURE_WORK.md) records the remaining filesystem and network policy work.

## License

ISC
