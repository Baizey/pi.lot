# pi-sandbox

Installable Linux Pi extension demonstrating kernel-mediated approval for I/O caused by shell commands.

- [`SPEC.md`](./SPEC.md) documents the sandbox model, security boundary, and prototype limitations.
- [`FUSE-MVP.md`](./FUSE-MVP.md) records a possible future filesystem-broker direction. The current extension does **not** use FUSE.

## How it works

The package registers `bash-bubblewrap`, a sandboxed variant of Pi's bash tool. Each command runs in a fresh Bubblewrap worker under an inherited seccomp user-notification filter.

When the worker attempts a mediated access:

1. The kernel pauses the syscall before executing it.
2. The native adapter reports the operation to trusted TypeScript.
3. The extension asks the user to allow or deny it.
4. Allow resumes the syscall; deny returns `EPERM` to the command.

Filesystem events contain per-path `READ`, `WRITE`, `DELETE`, and `EXECUTE` accesses. Network events include their decoded destination. The current yes/no prompt is intentionally a placeholder for the mature policy system that will resolve once/session/local/global rules before asking the user.

The Pi working directory is the worker's only writable host bind. The host root is visible but read-only, and `/tmp` is private ephemeral storage.

## Requirements

- Linux x86-64
- Node.js and npm
- A C compiler
- Bubblewrap (`bwrap`)
- A kernel supporting seccomp user notifications

## Install

```bash
npm install
pi install /absolute/path/to/pi-bubblewrap
```

To try it without installing:

```bash
pi -e /absolute/path/to/pi-bubblewrap
```

This repository also contains `.pi/settings.json`, which auto-loads the package while working in the repository.

## Test

```bash
npm test
```

The focused tests cover protocol validation and extension-level allow/deny behavior against the native sandbox.

## Project layout

- `src/extension.ts` — Pi tool registration and approval prompt.
- `src/bubblewrap/sandbox-runner.ts` — validated protocol plus native process and decision lifecycle.
- `native/pi-bubblewrap.c` — Bubblewrap/seccomp adapter with no configurable policy logic.
- `scripts/build-native.mjs` — native adapter build.
- `test/` — focused extension and protocol tests.

## Important warning

This is a proof of concept, not a production sandbox. Path authorization uses seccomp notification with `CONTINUE`, which has a documented time-of-check/time-of-use weakness. Syscall coverage is explicit rather than complete, approved descriptors remain usable by their worker process tree, and path strings are not durable resource identities.
