import {readdirSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
// Discover the actual contracts, including new parity tests, rather than keep
// a hand-maintained list that can omit tests or name nonexistent files.
const tests = readdirSync(new URL("../test", import.meta.url))
    .filter((name) => /\.test\.(ts|mjs)$/.test(name))
    .sort().map((name) => `./test/${name}`);
const result = spawnSync(process.execPath, ["--import", "jiti/register", "--test", ...tests], {
    cwd: root, env: process.env, stdio: "inherit",
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
