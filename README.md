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

Filesystem and network mediation run in one sandbox. The command sees the complete host filesystem through the FUSE policy mount while its private network namespace routes outbound traffic through the network gate.

### Cleaner tool output

pi.lot adds shared display modes to Pi's Bash, Read, Edit, and Write tools:

- `Ctrl+O` toggles truncated and full output;
- `Alt+O` toggles a minimal title-only view.

Read highlighting and images, Write highlighting, and Edit diffs remain available.

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
~/.pi/agent/pilot.sqlite
```

Synchronized or account-wide policy is not implemented.

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
- Active network-flow revocation is not implemented.
- Some unusual filesystem, device, pseudo-filesystem, socket, DNS, and IPv6 behavior is not yet supported.
- Preserved local IPC can ask another host process to perform network activity outside the network gate.
- Unprivileged Linux namespaces may not preserve every supplementary group.
- An allowed operation retains your ordinary host-user permissions.

Unsupported, malformed, cancelled, or incomplete mediated operations are intended to fail closed.

## Project status

The filesystem and network policy systems, combined Bash sandbox, session runtime, and tool display controls are implemented as working MVPs.

Near-term work includes:

- active network-flow revocation;
- broader filesystem and network compatibility; and
- further policy and runtime hardening.

Features from `pi-agent-tools` that have not yet been ported include:

- subagents;
- web search and reading;
- agent-visible session search; and
- shell-command policy.

## Technical details

The implementation and security contracts are documented separately:

- [`FUSE-MVP.md`](./FUSE-MVP.md) — filesystem mediation
- [`NETWORK-MVP.md`](./NETWORK-MVP.md) — network mediation

## License

ISC
