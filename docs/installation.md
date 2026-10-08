# Installation and setup

pi.lot is a Pi package for **Linux x86-64**. It overrides Pi's core file and shell tools, so install it only from a checkout you trust.

## Requirements

This checkout targets Pi `1.0.0` and requires:

- Node.js and npm;
- system libfuse 3.17.3 or newer, including `/dev/fuse` and `/usr/bin/fusermount3`;
- Bubblewrap;
- nftables and iproute2;
- `unshare` and `nsenter` from util-linux;
- `slirp4netns`;
- `xdg-dbus-proxy`;
- unprivileged user and network namespaces;
- Rust 1.85 or newer, Cargo and a native linker toolchain (normally the `cc`/GCC driver);
- `pkg-config`;
- libfuse3 development files, version 3.17.3 or newer;
- `libnetfilter_queue` development files; and
- the libclang shared library and matching Clang resource headers for build-time binding generation.

Normal builds no longer compile C source, but Rust still needs its platform linker toolchain. Tests additionally use a C compiler for independent ABI/syscall fixtures.

The native helper uses the modern 64-bit capability API (`FUSE_USE_VERSION=317`), including `fuse_unset_feature_flag` exported since libfuse 3.17.3. **Why not 3.17.2?** Its headers declare the capability helpers, but its shared library does not export them. Simply lowering the minimum version would therefore cause undefined-reference linker errors. The helper uses these functions to disable mmap, writeback, passthrough, and callback-bypassing capabilities while keeping libfuse's internal negotiation bookkeeping consistent; supporting 3.17.2 would require a separately implemented and tested compatibility path, not just a version-check change.

The build resolves the system `fuse3` SDK with `pkg-config`; the old npm-bundled FUSE 2 library is not used. Avoid libfuse 3.18.0, which briefly used incompatible ELF symbol versions for the capability helpers; rebuild native helpers when upgrading from it. Build and run against matching system library installations. This migration does **not** enable writable shared mmap, writeback cache, or passthrough. The [current security limitations](security.md#known-limitations) still apply; the [mmap feasibility investigation](transparent-mmap-feasibility.md) is not production enablement.

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

Install a Rust toolchain providing Rust 1.85 or newer and Cargo using your distribution or rustup. Cargo dependencies are pinned in `native/rust/Cargo.lock`; normal builds use `cargo build --locked`. The only runtime Rust crate dependency is `libc`. Build-time dependencies are pinned `bindgen 0.72.1` and `clang-sys 1.9.1`; the latter supports locating the loaded library's matching resource headers. Binding generation loads libclang during compilation, not when running helpers. On Fedora, `clang-devel` is an alternative package providing the libclang development library. For nonstandard LLVM installations, set `LIBCLANG_PATH` to the directory containing `libclang.so` (or its versioned shared library). Installing only the `clang` executable is not sufficient.

Normal native builds generate FUSE bindings and compile Rust; they no longer compile a production C shim. Native tests still need a C compiler (`gcc` on Fedora or `build-essential` on Debian/Ubuntu) for independent ABI/syscall fixtures.

Package names vary by distribution. Verify the host before building:

```bash
command -v cargo rustc pkg-config bwrap fusermount3 nft ip unshare nsenter slirp4netns xdg-dbus-proxy
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
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@1.0.0
```

Start Pi and use `/login` to authenticate a subscription or API-key provider:

```bash
pi
```

Pi `1.0.0` defaults to fullscreen mode. For the regular terminal UI, set `"tuiMode": "regular"` in Pi settings or start with `pi --tui-mode regular`.

Subagents require at least one authenticated model with normal reasoning support. Provider-native web search requires an authenticated active model that supports native search.

## Build pi.lot

```bash
git clone https://github.com/Baizey/pi-sandbox.git pilot
cd pilot
npm install
npm run build
```

The build generates bindings from the installed system FUSE headers with `bindgen`/libclang, compiles four Rust native helpers, then type-checks the extension. `native/rust/src/fuse/abi.rs` owns the libfuse callback table, configuration and file-info bitfield marshalling; `native/rust/src/fuse/bindings.rs` includes the header bindings generated by `native/rust/build.rs`. No production C shim is compiled. The existing executable names, protocols, high-level system-libfuse frontend, capability negotiation and filesystem enforcement semantics are retained. System libfuse and libnetfilter_queue remain external C libraries. See [Native Rust migration](native-rust-migration.md).

`npm install`'s install hook and `npm run build` both build Rust helpers. A successful native build publishes `build/native-rust.json` with SHA-256 digests for all four helpers. The production runtime validates that receipt and resolves only this package's `build/`; old C primary binaries, missing receipts and changed binaries are rejected with rebuild guidance. The receipt detects stale local build artifacts, not malicious host modification or unbuilt source changes; it is not a security attestation.

`npm run build` does not delete working helpers before compilation. `npm run clean` is a separate, destructive operation; do not run it on a live installation when attempting a safe update.

The four old C helper implementations, reference build, and implementation selector were removed after successful local Linux integration and corrected C/Rust comparison. The remaining production libfuse C ABI shim has subsequently been replaced by the Rust adapter; independent test-only C probes remain. The old implementations and comparison evidence remain in Git history. The earlier mounted results precede the ABI-adapter replacement and do not validate that new path; see the [ABI replacement verification scope](native-rust-migration.md#remaining-libfuse-c-abi-shim-replaced).

## Install the package

Install the checkout for your user:

```bash
pi install "$PWD"
```

Install it only for the current project:

```bash
pi install -l "$PWD"
```

Try it for one invocation without installing:

```bash
pi -e "$PWD"
```

The checked-in `.pi/settings.json` also loads the repository root as a project-local package when Pi starts inside the checkout and the project is trusted.

Pilot imports Pi's built-in MCP and codemode implementations through the public factories `createMcpExtension()` and `createCodemodeExtension()`, adding its own presentation. Add `"-builtin:mcp"` and `"-builtin:codemode"` to the `extensions` list in Pi user settings (`~/.pi/agent/settings.json`, or the configured agent directory), preserving all other settings and list entries. These suppress Pi's separate automatic instances and their override warnings, **not MCP or codemode functionality**: Pilot still runs the built-in implementations. Without these entries, Pi omits the duplicate built-in instances because Pilot registers `/mcp` and `codemode`, and emits override warnings.

Codemode remains inactive by default. Enable it with `"defaultTools": ["+codemode"]` to keep the ordinary tools alongside it, or use `--tools` for one invocation. MCP activates it automatically when its tools require scripts. Pi's `codemode.mode` and `codemode.inlineBudget` settings continue to apply. Pilot calls remain JSON `{purpose, code}`; [Pi's codemode documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/codemode.md) describes the `code` body and API rather than this wrapper envelope. Root model calls are [outside policy mediation](security.md#codemode-model-calls); child codemode exposes no model globals.

MCP OAuth credentials now belong to a server name plus URL. Pi handles legacy credential migration; multiple differently named servers sharing one URL may require separate `/mcp login <server>` calls afterward.

Installing pi.lot does not modify live user configuration; make this loader setting change yourself.

## Verify the installation

Start Pi in a project:

```bash
cd /path/to/project
pi
```

Confirm these commands are available:

```text
/policy-defaults
/subagent-defaults
/mcp
/network-inspection
/view-full-tool
```

Then inspect the initial state:

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
npm run build:native
npm install
npm run build
```

For a FUSE2-to-FUSE3 upgrade in a running Pi session, install the host FUSE3 SDK first and successfully compile the new native helper **before** `npm install` or any dependency pruning. Until that succeeds, keep the existing native binary and physical `node_modules/fuse-shared-library*` directories intact; the running installation may still need them. Restart Pi after the upgrade.

## Development and tests

Load the working tree with `pi -e "$PWD"`, or start Pi inside the checkout and use its project-local package setting.

Use a terminal on your normal Linux machine with the prerequisites above. pi.lot is a local Pi extension; testing does not require a separate server, testing host, or deployment rollout.

```bash
npm test
```

This builds/type-checks the extension, runs the canonical mount-free native suite without rebuilding, then runs the runtime suite, which discovers all existing `.test.ts` and `.test.mjs` files. The runtime suite includes real mount/network tests, so run it outside pi.lot's Bash sandbox or any other restrictive sandbox.

Native regression tests additionally require Python 3 for byte-preserving exec, seccomp, and deterministic subreaper launchers, plus a C compiler for ABI/syscall fixtures. The normal Rust helper build/runtime does not depend on Python.

For mount-free native verification:

```bash
npm run test:native
```

The canonical runner, `scripts/test-native.mjs`, builds the Rust helpers, runs Rust unit tests, callback/protocol/policy contracts, independent expected-behavior regressions, and build/runtime/source-package integration checks. The mount-free FUSE probes exercise production callbacks and real libfuse INIT negotiation; they do not replace kernel/mount integration.

The source-package check uses the actual npm install hook to build real Rust ELF helpers with a fresh Cargo target and cached dependencies in Cargo offline mode. It checks package contents, package-local resolution, protocol/exec smoke behavior, and preservation after a failed npm build. It tests the install hook, **not** offline installation of npm dependencies.

For the same suite plus real mounted/network contract coverage:

```bash
npm run test:native:host
```

This requires accessible `/dev/fuse` and the local namespace/network prerequisites. A mount-free pass is not a passing mounted/network suite. `test:native:integration` and `test:native:integration:host` are retained compatibility aliases for the same canonical runner without/with `--host`; they are not extra verification gates. The [migration record](native-rust-migration.md#local-linux-integration-and-c-retirement-completed) records the successful user-run integration and pre-retirement C/Rust comparison.

To debug a specific test after building:

```bash
node --import jiti/register --test test/native-fuse-callbacks.test.ts
```

Do **not** run integration from inside pi.lot's Bash sandbox or another restrictive sandbox. The tests create FUSE mounts, Bubblewrap workers, network namespaces, and nftables/NFQUEUE state; nesting those mechanisms produces misleading failures.

`test/network.test.ts` first checks synthetic DNS and IPv4 HTTP forwarding against local fixture servers. Its curl probe has a two-second connection timeout and a three-second total timeout, with a five-second sandbox deadline. A failed preflight stops that file instead of repeating the same gateway failure through every HTTP, HTTPS, Git, and Java test. Other test files still run. The failure includes curl stderr and observed policy events; fix that prerequisite before interpreting the cancelled network tests. Some negative native-protocol tests deliberately exercise five-second fail-closed deadlines.

## Common setup failures

### `/dev/fuse` is unavailable

Ensure FUSE 3 is installed, `/usr/bin/fusermount3` and `/dev/fuse` exist, and the current user can read and write `/dev/fuse`. Containers and managed development environments may need explicit device access.

### Rust helper is missing or outdated

Run `npm run build:native` from the installed checkout, confirm it succeeds, and restart Pi. Do not copy legacy C executables into the primary `build/` paths or manually manufacture the Rust receipt. The old C comparison selection (`PILOT_NATIVE_IMPLEMENTATION=c`) and reference build no longer exist; remove any obsolete override from your environment.

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
