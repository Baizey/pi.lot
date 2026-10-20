# Installation and setup

pi.lot (npm package name `pilot`) is a local Pi extension for **Linux x86-64**, hosted at [Baizey/pi-sandbox](https://github.com/Baizey/pi-sandbox). It overrides Pi's core file and shell tools, so install it only from a checkout you trust. The package is private; use the source checkout, not `npm install -g pilot`.

## Requirements

This checkout targets Pi `1.3.0` and requires:

- Node.js **22.19 or newer** and npm (Pi 1.3.0's Node requirement);
- system libfuse 3.17.3 or newer, including `/dev/fuse` and `/usr/bin/fusermount3`;
- Bubblewrap;
- nftables and iproute2;
- `flock`, `unshare`, and `nsenter` from util-linux;
- `slirp4netns`;
- `xdg-dbus-proxy`;
- unprivileged user and network namespaces;
- Rust 1.85 or newer, Cargo and a native linker toolchain (normally the `cc`/GCC driver);
- `pkg-config`;
- libfuse3 development files, version 3.17.3 or newer;
- `libnetfilter_queue` development files; and
- the libclang shared library and matching Clang resource headers for build-time binding generation.

Background session archival requires an external `node` executable >=22.19 on an absolute `PATH` entry, even when Pi itself is a compiled Bun executable. Startup/configuration validates that Node can load the package-local production `jiti` bootstrap and compatible `better-sqlite3`. Missing runtime support does not discard a durable queue item; a warning reports that launch must resume on a later wakeup. The detached worker uses util-linux `flock`, not Pi session-owned process lifetime. See [server archive](server.md).

The builder resolves system `fuse3` and `libnetfilter_queue` SDKs with `pkg-config`. FUSE API `317` uses `fuse_unset_feature_flag`, requiring exported capability helpers from libfuse >= 3.17.3; 3.17.2 headers alone are insufficient. Keep the SDK and runtime installations matched. Avoid libfuse 3.18.0's incompatible capability-helper symbol versions, and rebuild helpers when upgrading from it.

Typical Fedora packages:

```bash
sudo dnf install \
  gcc pkgconf-pkg-config clang-libs clang-resource-files \
  fuse3 fuse3-devel bubblewrap nftables iproute util-linux \
  slirp4netns xdg-dbus-proxy libnetfilter_queue-devel
```

On Bazzite, layer missing host packages with `rpm-ostree`, not `dnf`. For example, when the runtime is already installed but the FUSE SDK is missing:

```bash
sudo rpm-ostree install --apply-live fuse3-devel clang-libs clang-resource-files
```

If live application is unavailable, reboot into the updated deployment before building. Installing headers only in a container/toolbox does not provide the SDK to a host-side build.

Typical Debian/Ubuntu packages (use a distribution release/repository providing libfuse >= 3.17.3):

```bash
sudo apt install \
  build-essential pkg-config libclang-dev \
  fuse3 libfuse3-dev bubblewrap nftables iproute2 util-linux \
  slirp4netns xdg-dbus-proxy libnetfilter-queue-dev
```

Install Rust >= 1.85 and Cargo using your distribution or rustup. Cargo dependencies are pinned in `native/rust/Cargo.lock`; builds use `cargo build --locked`. Normal native builds generate FUSE bindings and compile Rust, not a production C shim, but still need a native linker toolchain. Tests also compile independent C ABI/syscall fixtures.

Binding generation loads libclang at build time, not at helper runtime. Installing only the `clang` executable is insufficient. For nonstandard LLVM installations, use `LIBCLANG_PATH` for the directory containing the shared library; see [libclang troubleshooting](#native-build-cannot-load-libclang).

Package names vary by distribution. Verify the host before building:

```bash
command -v node npm cargo rustc cc pkg-config bwrap fusermount3 nft ip flock unshare nsenter slirp4netns xdg-dbus-proxy
node --version
rustc --version
cargo --version
pkg-config --atleast-version=3.17.3 fuse3
pkg-config --cflags --libs fuse3
pkg-config --exists libnetfilter_queue
test -r /dev/fuse && test -w /dev/fuse
```

## Install Pi

Install the compatible Pi release:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@1.3.0
```

Start Pi and use `/login` to authenticate a subscription or API-key provider:

```bash
pi
```

Pi defaults to fullscreen mode. For the regular terminal UI, set `"tuiMode": "regular"` in Pi settings or start with `pi --tui-mode regular`.

## Build pi.lot

```bash
git clone https://github.com/Baizey/pi-sandbox.git pilot
cd pilot
npm install
```

`npm install` already builds the native helpers through its install hook. For an optional source check afterward, run `npm run typecheck`; `npm run build` is the explicit rebuild-plus-typecheck command, not an additional installation step. Pi loads the TypeScript entry point directly. Native compilation uses the host SDKs and may download locked Cargo dependencies on the first build; do not use `--ignore-scripts` for this checkout's install.

A successful build publishes four helpers and a SHA-256 receipt in this checkout's `build/`. Runtime rejects missing/mismatched artifacts, but does not check source freshness: an old binary and matching receipt can pass after source changes. Rebuild and restart Pi after native changes.

Failed preflight/compilation preserves existing helpers. `npm run clean` is destructive and not part of normal updates. See the [native helper reference](native-rust-migration.md) for publication and receipt limitations.

## Install the package

Install the checkout for your user:

```bash
pi install "$PWD"
```

Alternatively, install it only for a target project (run from that project, not the checkout):

```bash
cd /path/to/project
pi install -l /absolute/path/to/pilot
```

From the checkout, try it for one invocation without adding a package declaration:

```bash
pi -e "$PWD"
```

The checked-in `.pi/settings.json` already loads the repository root and disables the duplicate built-ins described below when Pi starts inside this trusted checkout. A local Pi package is loaded in place; Pi does not copy it or install its npm dependencies. Build it yourself first.

Pilot provides wrappers around Pi's built-in MCP and codemode implementations. Add `"-builtin:mcp"` and `"-builtin:codemode"` to the `extensions` list in Pi user settings (`~/.pi/agent/settings.json`, or the configured agent directory), preserving all other settings and list entries. These suppress Pi's separate automatic instances and their override warnings, **not MCP or codemode functionality**: Pilot still runs the built-in implementations. Without these entries, Pi omits the duplicate built-in instances because Pilot registers `/mcp` and `codemode`, and emits override warnings.

Codemode remains inactive by default. Enable it with `"defaultTools": ["+codemode"]` to keep the ordinary tools, or `pi --tools +codemode` for one invocation. MCP activates it when server exposure requires scripts. Pilot calls use JSON `{purpose, code}`; [Pi's codemode documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/codemode.md) describes the `code` body, not this wrapper. Review the [model-call policy boundary](security.md#codemode-model-calls).

`pi install` writes the package declaration to Pi settings. The checkout's npm install/build hooks do not rewrite your Pi configuration; add the loader exclusions yourself, preserving unrelated entries.

## Verify the installation

Start Pi in a project:

```bash
cd /path/to/project
pi
```

Inspect the initial state with these commands. Their availability checks extension loading, not mounted filesystem/network enforcement:

```text
/policy-defaults
/subagent-defaults
/mcp
/network-inspection
```

Continue with:

- [Policy configuration](policy.md)
- [Subagent model defaults](subagents.md#reasoning-and-model-selection)
- [Pi's MCP configuration](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md)
- [Web-search providers](web-search.md)

## Update a local installation

A local Pi package points at the checkout rather than copying it. Update and rebuild, then restart Pi:

```bash
cd /path/to/pilot
git pull
npm install
```

Install any newly required host SDKs before updating. `npm install` rebuilds helpers; use `npm run typecheck` for an optional TypeScript check, or `npm run build` when rebuilding without dependency installation. Stop active work and restart Pi after rebuilding; an existing broker can still hold the old executable/library mappings. Local path packages are updated with Git/npm here, not copied into a separate Pi deployment.

## Development and tests

Load the working tree with `pi -e "$PWD"`, or start Pi inside the checkout and use its project-local package setting.

Use a terminal on a prepared Linux host, **outside pi.lot's Bash sandbox or any other restrictive sandbox**. The full and host-native suites create FUSE mounts, Bubblewrap workers, network namespaces, and nftables/NFQUEUE state.

| Command | Scope |
| --- | --- |
| `npm run build` | Rebuild native helpers, then TypeScript no-emit check. |
| `npm run typecheck` | TypeScript no-emit check only; no native build. |
| `npm run test:native` | Build helpers, Rust unit tests, mount-free native contracts. |
| `npm run test:native:rust` | Cargo unit tests only; does not publish runtime helpers. |
| `npm run test:native:host` | Native suite plus real mounted/network contracts. |
| `npm run test:runtime` | Discover all top-level `test/*.test.ts` and `test/*.test.mjs`; no automatic build. Includes host integration. |
| `npm run test:network` | Build helpers, then the explicit network-related test subset. Includes host integration. |
| `npm test` | Build/typecheck, mount-free native suite without rebuilding, then all remaining discovered runtime tests (without rerunning native files). |

`test:native:integration` and `test:native:integration:host` are compatibility aliases for the canonical native runner without/with `--host`, not extra gates. A mount-free pass is not a passing mounted/network or full suite.

Native regression tests additionally require Python 3 for byte-preserving exec, seccomp, and deterministic subreaper launchers, plus a C compiler for ABI/syscall fixtures. The normal Rust helper build/runtime does not depend on Python.

Two mount-free INIT negotiation cases additionally need libfuse built with `-Denable-custom-io=true`. Distribution builds without it skip those cases on `-ENOTSUP`; other probe errors still fail. This optional transport is not required for production mounts. Use a matching custom-I/O-enabled SDK/runtime to run them without skips.

The source-package test exercises the actual npm install hook using a fresh Cargo target and cached dependencies in Cargo offline mode. It does **not** test offline installation of npm dependencies. See [regression entry points](native-rust-migration.md#regression-entry-points) for the contract-to-test map.

`test:native:host` fails preflight if `/dev/fuse` is absent; device presence alone does not establish usable mounts or namespace/network permissions. Record failures and skips from the actual run, rather than relying on historical test totals.

To debug a specific test after building:

```bash
node --import jiti/register --test test/native-fuse-callbacks.test.ts
```

`test/network.test.ts` first checks synthetic DNS and IPv4 HTTP forwarding against local fixtures. A failed preflight stops that file; inspect its curl stderr and policy events before interpreting cancelled network cases. Some negative native-protocol tests deliberately wait for fail-closed deadlines.

## Common setup failures

### `/dev/fuse` is unavailable

Ensure FUSE 3 is installed, `/usr/bin/fusermount3` and `/dev/fuse` exist, and the current user can read and write `/dev/fuse`. Containers and managed development environments may need explicit device access.

### Rust helper is missing or outdated

Run `npm run build:native` from the installed checkout, confirm it succeeds, and restart Pi. Do not copy binaries or manufacture a receipt to bypass the check.

### Namespace creation is denied

pi.lot needs unprivileged user and network namespaces. Host security policy, container settings, or another outer sandbox can disable them.

### Native build cannot find a supported FUSE3 SDK

The runtime package alone does not supply headers or `fuse3.pc`. Install `fuse3-devel` on Fedora/Bazzite (using `rpm-ostree` on Bazzite), or `libfuse3-dev` on Debian/Ubuntu. The SDK and runtime must be version 3.17.3 or newer; older distribution releases need an appropriate newer package source. Verify:

```bash
pkg-config --modversion fuse3
pkg-config --atleast-version=3.17.3 fuse3
pkg-config --cflags --libs fuse3
```

On Debian/Ubuntu, if `pkg-config --modversion fuse3` reports `3.17.2`, the development package is installed but is too old for this checkout. Check the available package versions:

```bash
apt-cache policy fuse3 libfuse3-dev
```

Use a distribution release or appropriate package source providing a supported SDK **and matching runtime**. Do not bypass the minimum-version check; installing `libfuse3-dev` again from the same older repository will not resolve the missing exported functions.

For a nonstandard SDK prefix, configure `PKG_CONFIG_PATH` to its pkg-config directory. Do not substitute the old npm FUSE2 headers or library. The builder rejects missing/old SDKs before replacing existing helpers.

### Native build cannot load libclang

Binding generation needs the libclang shared library, not just LLVM headers or a `clang` executable. Install `clang-libs` or `clang-devel` on Fedora/Bazzite, or `libclang-dev` on Debian/Ubuntu. As with the FUSE SDK, the library must be visible to the process building on the host, not only installed inside a toolbox.

If LLVM is installed in a nonstandard location, point `LIBCLANG_PATH` at its library directory before building. For example, if the shared library is `/opt/llvm/lib/libclang.so`:

```bash
LIBCLANG_PATH=/opt/llvm/lib npm run build:native
```

`LIBCLANG_PATH` locates LLVM's library; `PKG_CONFIG_PATH` separately locates the FUSE/NFQUEUE SDKs. Keep the installed FUSE headers and runtime matched and do not bypass the libfuse 3.17.3 minimum.

If parsing fails with a missing builtin header such as `stdarg.h`, install the matching Clang resource headers (`clang-resource-files`/`clang-devel` on Fedora, or `libclang-common-<version>-dev` on Debian/Ubuntu). The builder discovers these relative to the loaded library without needing a `clang` executable. For a nonstandard resource location, use `BINDGEN_EXTRA_CLANG_ARGS='-resource-dir=/path/to/lib/clang/<version>'`.

### Native build cannot find NFQUEUE

Install the distribution's `libnetfilter_queue` development package and verify:

```bash
pkg-config --cflags --libs libnetfilter_queue
```

### HTTPS clients reject the generated certificate

See [HTTPS inspection](policy.md#https-inspection). Certificate-pinned clients and private trust stores may require `/network-inspection off`.
