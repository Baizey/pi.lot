import {readFile} from "node:fs/promises";
import path from "node:path";

export async function isMountedPath(candidate: string): Promise<boolean> {
    return (await mountedPaths()).includes(candidate);
}

export async function hasMountedPathAtOrBelow(directory: string): Promise<boolean> {
    return (await mountedPaths()).some((candidate) => {
        const relative = path.relative(directory, candidate);
        return relative === ""
            || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
    });
}

async function mountedPaths(): Promise<string[]> {
    const mountInfo = await readFile("/proc/self/mountinfo", "utf8");
    return mountInfo.split("\n").flatMap((line) => {
        if (!line) return [];
        const fields = line.split(" ");
        return fields.length > 4 ? [decodeMountInfoPath(fields[4]!)] : [];
    });
}

function decodeMountInfoPath(value: string): string {
    return value.replace(/\\(040|011|012|134)/g, (_match, octal: string) => (
        String.fromCharCode(Number.parseInt(octal, 8))
    ));
}
