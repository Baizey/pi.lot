# Installation and setup

pi.lot is a Pi package for **Linux x86-64**. It overrides Pi's core file and shell tools, so install it only from a checkout you trust.

## Requirements

This checkout targets Pi `0.84.2` and requires:

- Node.js and npm;
- FUSE 2, including `/dev/fuse` and `fusermount`;
- Bubblewrap;
- nftables and iproute2;
- `unshare` and `nsenter` from util-linux;
- `slirp4netns`;
- `xdg-dbus-proxy`;
- unprivileged user and network namespaces;
- a C compiler and `pkg-config`; and
- `libnetfilter_queue` development files.

Typical Fedora/Bazzite packages:

```bash
sudo dnf install \
  gcc make pkgconf-pkg-config \
  fuse fuse-devel bubblewrap nftables iproute util-linux \
  slirp4netns xdg-dbus-proxy libnetfilter_queue-devel
```

Typical Debian/Ubuntu packages:

```bash
sudo apt install \
  build-essential pkg-config \
  fuse libfuse-dev bubblewrap nftables iproute2 util-linux \
  slirp4netns xdg-dbus-proxy libnetfilter-queue-dev
```

Package names vary by distribution. Verify the host before building:

```bash
command -v cc pkg-config bwrap fusermount nft ip unshare nsenter slirp4netns xdg-dbus-proxy
pkg-config --exists libnetfilter_queue
test -r /dev/fuse && test -w /dev/fuse
```

## Install Pi

Install the compatible Pi release:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.84.2
```

Start Pi and use `/login` to authenticate a subscription or API-key provider:

```bash
pi
```

Subagents require at least one authenticated model with normal reasoning support. Provider-native web search requires an authenticated active model that supports native search.

## Build pi.lot

```bash
git clone https://github.com/Baizey/pi-sandbox.git pilot
cd pilot
npm install
npm run build
```

The build compiles four native helpers and type-checks the extension.

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
/mcp show
/network-inspection
```

Continue with:

- [Policy configuration](policy.md)
- [Subagent model defaults](subagents.md#reasoning-and-model-selection)
- [MCP configuration](mcp.md)
- [Web-search providers](web-search.md)

## Update a local installation

A local Pi package points at the checkout rather than copying it. Update and rebuild, then restart Pi:

```bash
cd /path/to/pilot
git pull
npm install
npm run build
```

## Development and tests

Load the working tree with `pi -e "$PWD"`, or start Pi inside the checkout and use its project-local package setting.

Run the suite only on a suitable host environment:

```bash
npm test
```

Do **not** run the sandbox integration suite from inside pi.lot or another restrictive sandbox. The tests create FUSE mounts, Bubblewrap workers, network namespaces, and nftables/NFQUEUE state; nesting those mechanisms produces misleading failures.

## Common setup failures

### `/dev/fuse` is unavailable

Ensure FUSE 2 is installed, `/dev/fuse` exists, and the current user can read and write it. Containers and managed development environments may need explicit device access.

### Namespace creation is denied

pi.lot needs unprivileged user and network namespaces. Host security policy, container settings, or another outer sandbox can disable them.

### Native build cannot find NFQUEUE

Install the distribution's `libnetfilter_queue` development package and verify:

```bash
pkg-config --cflags --libs libnetfilter_queue
```

### HTTPS clients reject the generated certificate

See [HTTPS inspection](policy.md#https-inspection). Certificate-pinned clients and private trust stores may require `/network-inspection off`.
