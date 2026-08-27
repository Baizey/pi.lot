import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/** Resolve a built-in tool path with Pi's Linux path normalization. */
export function resolveBuiltinToolPath(input: string, cwd: string): string {
    let normalized = input.replace(UNICODE_SPACES, " ");
    if (normalized.startsWith("@")) normalized = normalized.slice(1);
    if (normalized === "~") normalized = os.homedir();
    else if (normalized.startsWith("~/")) normalized = path.join(os.homedir(), normalized.slice(2));
    if (/^file:\/\//.test(normalized)) normalized = fileURLToPath(normalized);
    return path.resolve(cwd, normalized);
}
