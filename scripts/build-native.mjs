import {mkdirSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const outputDirectory = fileURLToPath(new URL("../build", import.meta.url));

mkdirSync(outputDirectory, {recursive: true});
compileNative("pi-mknod.c", "pi-mknod-native");
compileNative("pi-network-queue.c", "pi-network-queue-native", netfilterQueueFlags());
compileNative("pi-tcp-gateway.c", "pi-tcp-gateway-native");

function compileNative(sourceName, outputName, extraFlags = []) {
  const source = fileURLToPath(new URL(`../native/${sourceName}`, import.meta.url));
  const output = fileURLToPath(new URL(`../build/${outputName}`, import.meta.url));
  const result = spawnSync("cc", [
    "-std=c17",
    "-O2",
    "-g",
    "-Wall",
    "-Wextra",
    "-Wpedantic",
    "-o",
    output,
    source,
    ...extraFlags,
  ], {cwd: root, stdio: "inherit"});

  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function netfilterQueueFlags() {
  const result = spawnSync("pkg-config", ["--cflags", "--libs", "libnetfilter_queue"], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.error) {
    throw new Error("pkg-config is required to locate libnetfilter_queue", {cause: result.error});
  }
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    throw new Error(
      "libnetfilter_queue development files are required (Bazzite/Fedora: libnetfilter_queue-devel; Debian/Ubuntu: libnetfilter-queue-dev)",
    );
  }
  return result.stdout.trim().split(/\s+/).filter(Boolean);
}
