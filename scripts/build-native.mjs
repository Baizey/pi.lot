import {mkdirSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const outputDirectory = fileURLToPath(new URL("../build", import.meta.url));
const source = fileURLToPath(new URL("../native/pi-bubblewrap.c", import.meta.url));
const output = fileURLToPath(new URL("../build/pi-bubblewrap-native", import.meta.url));

mkdirSync(outputDirectory, {recursive: true});
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
], {cwd: root, stdio: "inherit"});

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
