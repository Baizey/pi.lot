import path from "node:path";
import fs from "node:fs";

export function resolvePhysicalPath(input: string): string {
    const normalized = stripTrailingPathSeparators(path.resolve(input).normalize());
    const existingAncestor = nearestExistingAncestor(normalized);
    if (!existingAncestor) return normalized;

    try {
        const physicalAncestor = stripTrailingPathSeparators(fs.realpathSync.native(existingAncestor));
        const suffix = path.relative(existingAncestor, normalized);
        return suffix
            ? stripTrailingPathSeparators(path.join(physicalAncestor, suffix).normalize())
            : physicalAncestor;
    } catch {
        return normalized;
    }
}

function stripTrailingPathSeparators(
    input: string,
    pathParser: Pick<typeof path, "parse"> = path,
): string {
    const root = pathParser.parse(input).root;
    const stripped = input.replace(/[\\/]+$/g, "");
    return stripped.length < root.length ? root : stripped;
}

function nearestExistingAncestor(input: string): string | null {
    let current = input;
    while (true) {
        if (fs.existsSync(current)) return current;
        const parent = path.dirname(current);
        if (parent === current) return null;
        current = parent;
    }
}