import {spawnSync} from "node:child_process";

export const minimumFuseVersion = "3.17.3";
const fuseSdkHelp = `libfuse >= ${minimumFuseVersion} development files are required (Fedora: fuse3-devel; Bazzite: sudo rpm-ostree install --apply-live fuse3-devel; Debian/Ubuntu: libfuse3-dev from a release providing the required version)`;

export function fuseFlags() {
    const version = pkgConfig(["--modversion", "fuse3"], fuseSdkHelp).trim();
    const compatible = spawnSync("pkg-config", [`--atleast-version=${minimumFuseVersion}`, "fuse3"], {
        encoding: "utf8",
    });
    if (compatible.error) throw new Error(`pkg-config is required to locate fuse3. ${fuseSdkHelp}`, {cause: compatible.error});
    if (compatible.status !== 0) throw new Error(`Installed libfuse SDK ${version || "(unknown version)"} is too old. ${fuseSdkHelp}`);
    return packageFlags("fuse3", fuseSdkHelp);
}

export function netfilterQueueFlags() {
    return packageFlags("libnetfilter_queue", "libnetfilter_queue development files are required (Bazzite/Fedora: libnetfilter_queue-devel; Debian/Ubuntu: libnetfilter-queue-dev)");
}

function packageFlags(name, help) {
    const flags = parsePkgConfigFlags(pkgConfig(["--cflags", "--libs", name], help));
    if (flags.length === 0) throw new Error(`pkg-config returned no compiler/linker flags for ${name}. ${help}`);
    return flags;
}

function pkgConfig(args, help) {
    const result = spawnSync("pkg-config", args, {encoding: "utf8"});
    if (result.error) throw new Error(`pkg-config is required to locate ${args.at(-1)}. ${help}`, {cause: result.error});
    if (result.status !== 0) throw new Error(`${help}\n${result.stderr.trim()}`);
    return result.stdout;
}

// pkg-config emits shell-escaped arguments. Decode quoting without invoking a shell
// so escaped spaces in SDK paths survive, and substitutions are never executed.
export function parsePkgConfigFlags(output) {
    const flags = [];
    let argument = "";
    let quote;
    let started = false;
    for (let index = 0; index < output.length; index++) {
        const character = output[index];
        if (character === "\\" && quote !== "'") {
            const next = output[++index];
            if (next === undefined) throw new Error("Malformed pkg-config flags: trailing escape");
            if (quote === '"' && !['"', "\\", "$", "`", "\n"].includes(next)) argument += "\\";
            if (next !== "\n") argument += next;
            started = true;
        } else if (quote) {
            if (character === quote) quote = undefined;
            else argument += character;
        } else if (character === "'" || character === '"') {
            quote = character;
            started = true;
        } else if (/\s/.test(character)) {
            if (started) flags.push(argument);
            argument = "";
            started = false;
        } else {
            argument += character;
            started = true;
        }
    }
    if (quote) throw new Error("Malformed pkg-config flags: unterminated quote");
    if (started) flags.push(argument);
    return flags;
}
