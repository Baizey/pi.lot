# Working inside the pi.lot harness

Read this before diagnosing Bash connectivity, reaching a service on the user's machine, or controlling an Android emulator. It describes pi.lot's tools and network layout; other agent runners and commands executed inside Android can have different layouts.

## Choose the right execution context

Each `bash` call runs with a private network namespace and a policy-mediated filesystem. **Its `localhost` is not the host's `localhost`.** Files can be shared through the mediated host filesystem, but network listeners and shell state are local to that call.

| Where an operation runs | What to expect |
| --- | --- |
| User's normal host terminal | Host loopback and host services, including the user's running ADB server |
| pi.lot `bash` | A fresh worker with private loopback; use the host gateway for host TCP services |
| Another `bash` call, including a child's | Another worker; it does not share the previous call's loopback, variables, or background jobs |
| `read`, `edit`, `write` | Direct file tools with filesystem policy; `read` can return images |
| An MCP tool | The configured server's execution environment; MCP effects are outside pi.lot filesystem/network mediation |
| `web_search` and root-only archive tools | Extension-managed host HTTP with their own policy checks; not general shell or device-control tools |

The `bash` tool accepts `command`, `purpose`, and optional `timeout` in seconds. There is no host-execution or escalation parameter in that interface. A tool named `bash` in a different runner may behave differently. Discover actual tools before claiming that an Android-control MCP or other integration is available.

## Address map for a Bash client

| Destination | Meaning inside pi.lot Bash |
| --- | --- |
| `localhost`, `127.0.0.1`, `::1` | This call's worker, useful for a server and client running in the same call |
| `10.0.2.2:<port>` | Host IPv4 loopback, forwarded to `127.0.0.1:<port>` |
| `[fd00::2]:<port>` | Host IPv6 loopback, forwarded to `[::1]:<port>` |
| `10.0.2.3`, `fd00::3` | Harness DNS resolver addresses, not host application-service addresses |
| Other hostnames/IPs | Normal destination routing subject to DNS/transport and applicable protocol policy |

These host aliases come from pi.lot's gateway implementation, not from detecting an Android device or assuming that every virtual machine uses the same addresses. They reach services on the machine running pi.lot. They do not automatically reach the user's laptop when pi.lot itself runs elsewhere. A host service listening only on IPv4 loopback needs the IPv4 alias, and vice versa.

Worker-local loopback connections receive transport checks but do not traverse the application gateway. Host-gateway connections do traverse it, even though their eventual destination is host loopback.

For a host development server already listening on port 3000:

```bash
curl --noproxy '*' --fail --show-error http://10.0.2.2:3000/
```

The gateway can reach a loopback-only host service; rebinding it to `0.0.0.0` is unnecessary. Proxy configuration can change where a client connects; `--noproxy '*'` makes this local diagnostic direct. The connection still receives pi.lot's policy checks.

Using an IP in an HTTP URL also changes its Host header and, for HTTPS, its TLS identity. If a service requires a hostname, preserve that logical name and use a client-supported address override, such as curl's `--resolve 'dev.example.test:443:10.0.2.2'` with `https://dev.example.test/`. The gateway still verifies the upstream certificate. Read [HTTPS inspection](policy.md#https-inspection) for trust behavior; address routing does not fix a certificate mismatch or an untrusted upstream certificate.

## State and lifetime

Every Bash call starts from the tool context's working directory. A `cd`, function definition, or `export` affects only that call. Repeat connection flags and required environment setup in later calls. Persisted file changes remain subject to filesystem policy; a new call gets a new filesystem mediation view.

Keep a temporary server and its client/test in the **same Bash call**, wait for the server to become ready, and clean it up on exit. Workers and their network resources are torn down when the call ends or is cancelled. `nohup` or `&` is not a persistent host-service launcher. For an already-running user service, connect through the host gateway instead.

The filesystem view is not a rollback layer: completed writes can survive cancellation. Host/cross-call SQLite WAL coordination is unsupported even with writable mmap enabled. See [filesystem mediation](policy.md#filesystem-mediation).

## Separate routing, policy, and protocol failures

A host gateway address supplies a route, not permission. For a literal TCP endpoint, transport policy (`web_tcp`) and the applicable application policy are separate. HTTP uses method/URL policy; SSH, SMTP, ADB, WebSocket, gRPC, and supported database/messaging/file/mail channels have dedicated areas. See the [supported service modes](network-protocols.md) before assuming that a protocol family includes every version or auxiliary connection. DNS hostname grants can cover subsequent transport flows more broadly within a call; see [network mediation](policy.md#network-mediation) for exact scope.

Network inspection starts **on**. The TCP gateway recognizes supported application bytes rather than assuming a protocol from a port. Unsupported or inconclusive traffic fails closed under full inspection. This is independent of certificate checking: ordinary client-to-server ADB on port 5037 is plaintext, so rejecting its protocol is not a TLS certificate failure.

ADB has first-class smart-socket recognition and `web_adb` approval, alongside SSH and SMTP. It validates the initial length-prefixed host request and the server's `OKAY`/`FAIL` response before allowing continuation. The approval covers the server channel, including subsequent device selection, shell, file transfer, installation, forwarding, and binary output. It is **not a per-device or per-command restriction**. It does not implement the separate binary server-to-`adbd` transport or the emulator console protocol. Full admission semantics are in [application-protocol admission](policy.md#application-protocol-admission).

Keep inspection on for supported protocols, including ADB. Turning it off retains transport checks and recognized plaintext checks, but permits transport-only handling of opaque traffic. It is a session compatibility setting, not a general connectivity repair. Both inspection and writable-mmap settings apply to new calls, including children; see [sandboxing switches](README.md#sandboxing-switches).

Use the normal approval flow for the endpoint and operation the task requires. An explicit denial is not a reason to try another tool, address, or proxy to obtain the same effect. Diagnose the reported policy area and reason before deciding whether a new approval is relevant.

## Android and emulator walkthrough

The intended path is:

```text
Bash ADB client -> 10.0.2.2:5037 -> host ADB server on 127.0.0.1:5037 -> device/emulator
```

The host ADB server owns discovery of the user's emulator and physical devices. Bash does not need direct USB access to use a device already registered there. pi.lot gives workers a private `/dev`; a TCP grant does not grant access to host device nodes.

### 1. Discover through the existing host server

Locate the installed ADB client, for example with `command -v adb` or the project's SDK configuration. The following commands use a common Linux SDK location and the usual host server port; substitute the actual values:

```bash
~/Android/Sdk/platform-tools/adb -H 10.0.2.2 -P 5037 devices -l
```

This needs `web_tcp` and `web_adb` for the endpoint, plus filesystem access to run the client. New `web_adb` defaults are `ask_user`, including when loading older saved defaults that omit that area. Use the existing [approval scope and lifetime](policy.md#interactive-approvals) controls rather than allowing all network access.

Without endpoint overrides, a plain `adb devices` uses the worker's local server endpoint and can start an unrelated server with an empty device list. That does not establish whether the host emulator is present. Repeating that command in new workers cannot bridge the namespace boundary. If the client reports conflicting connection settings, inspect its ADB-specific environment as well as command flags.

If a host comparison is needed, the user's normal terminal can run:

```bash
~/Android/Sdk/platform-tools/adb devices -l
```

That comparison must actually run on the host. Do not label a second sandbox call as a host check. Paste commands without a terminal's `$` prompt or previous command output.

### 2. Select a ready device

Choose a serial from the returned list and keep `-H`, `-P`, and `-s` on subsequent commands. `emulator-5554` below is an example, not a guaranteed Pixel identity. A ready entry has state `device`; `offline` or `unauthorized` requires resolving the device/host connection. Multiple devices require an explicit selection.

```bash
~/Android/Sdk/platform-tools/adb -H 10.0.2.2 -P 5037 \
  -s emulator-5554 shell getprop ro.product.model
```

### 3. Inspect the screen and UI

Capture binary image output with `exec-out` and redirect it to a file:

```bash
~/Android/Sdk/platform-tools/adb -H 10.0.2.2 -P 5037 \
  -s emulator-5554 exec-out screencap -p > /tmp/pixel-screen.png
```

The destination requires filesystem-write permission. View the PNG with `read`; text output or the command's exit status alone does not establish what is on screen. Choose a task-specific filename if working concurrently.

For an accessibility hierarchy, these commands create a temporary XML file **on the device** and print it:

```bash
~/Android/Sdk/platform-tools/adb -H 10.0.2.2 -P 5037 \
  -s emulator-5554 shell uiautomator dump /data/local/tmp/pilot-window.xml
~/Android/Sdk/platform-tools/adb -H 10.0.2.2 -P 5037 \
  -s emulator-5554 shell cat /data/local/tmp/pilot-window.xml
```

That device path is not a local path for the `read` tool. The dump may omit custom-rendered content; use the screenshot as well. Device-side writes and commands travel inside the admitted ADB channel rather than through host filesystem policy.

### 4. Interact and verify

For a task that calls for UI interaction, use the observed screenshot dimensions and hierarchy bounds with `shell input tap X Y`, `shell input swipe X1 Y1 X2 Y2 DURATION_MS`, or a key event. For example, returning to Home is:

```bash
~/Android/Sdk/platform-tools/adb -H 10.0.2.2 -P 5037 \
  -s emulator-5554 shell input keyevent KEYCODE_HOME
```

Capture a fresh screen after an action to verify the outcome. Account for scaling if an image viewer resized the screenshot. An accepted input command does not prove that the intended control was activated.

An ADB channel grant does not expand the user's task. Inspecting an emulator does not by itself call for installing/replacing an app, clearing its data, changing device settings, or restarting the host ADB server. Keep operations within the requested work and report what was actually observed.

## Troubleshooting by evidence

| Observation | Next check |
| --- | --- |
| Plain `adb devices` is empty, host terminal lists an emulator | Use explicit host gateway flags; the two clients may be querying different servers |
| Gateway `devices -l` succeeds but is empty | The server is reachable; check that it is the intended host/port and that the device is registered there |
| Connection refused | Check the server's listening address, port, and running state; use the matching IPv4/IPv6 alias |
| Timeout, reset, or EOF | Inspect accompanying pi.lot errors and audit reasons; these symptoms alone do not identify the failing layer |
| `web_tcp` denied | Transport admission is missing; application approval cannot replace it |
| `web_adb` denied after TCP approval | ADB needs its own approval; TCP permission alone is insufficient |
| Unsupported/opaque protocol with inspection on | Check the actual endpoint and protocol, and the loaded pi.lot version. ADB support means the host smart-socket protocol, not every Android-related port |
| Certificate or hostname error | Investigate TLS trust and logical identity. Ordinary ADB smart sockets do not use certificates |
| ADB reports `offline`, `unauthorized`, or a server/client version mismatch | Resolve that specific host/device/client state. Do not kill the user's server or expose it on all interfaces as an automatic repair |
| A short client timeout expires during approval | The harness pauses its supported execution budgets for approval, but a client application's own timers can still expire; retry after the decision with an appropriate timeout |
| Screenshot exists but cannot be viewed | Check capture success, file contents, read permission, and image-tool/model support |
| SSH credentials missing despite network approval | Credential IPC is separate from network authority; see [host credential IPC](policy.md#host-credential-ipc) |

Approval decisions are recorded under `~/.pilot/logs/<session-id>.log`. These are not exhaustive packet or operation logs. Read the relevant reason and resolution source; a `SYSTEM` denial can be a configured fallback or a runtime safeguard. Avoid including secrets from logs or command output in a report.

If behavior differs from this guide, establish which installation is loaded and restart Pi after updating it. Editing a checkout does not replace an already-running extension. Native changes also require rebuilt helpers; see [installation](installation.md). Report the command context, endpoint, relevant error, and observed result instead of declaring an emulator unavailable from a sandbox-local check.

## Implementation references

These are the current implementation and regression-test entry points, useful when the documented behavior needs investigation:

- [BashTool](../src/tools/builtin/BashTool.ts): per-call filesystem and network composition.
- [NetworkSandbox](../src/policy/network/NetworkSandbox.ts): worker namespaces, cleanup, DNS, and `hostAddressForGateway` mappings.
- [TcpGatewayBroker](../src/policy/network/TcpGatewayBroker.ts), [AdbProtocol](../src/policy/network/AdbProtocol.ts), and [ChannelProtocols](../src/policy/network/ChannelProtocols.ts): protocol admission, smart-socket handshake, and bounded service channel confirmation.
- [NetworkPolicyAuthorizer](../src/policy/network/NetworkPolicyAuthorizer.ts): transport and application-policy decisions.
- [Network integration tests](../test/network.test.ts) and [ADB gateway tests](../test/tcp-gateway-adb.test.ts): host aliases and protocol/denial/streaming coverage. Run native integration on a prepared host, not inside another sandbox.

For policy details use [policy.md](policy.md); for trust boundaries and limitations use [security.md](security.md). Root and child agents receive installation-relative documentation pointers. Reading a guide still uses the normal file policy and does not grant additional capabilities.
