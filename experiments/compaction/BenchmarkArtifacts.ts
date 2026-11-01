import {randomUUID} from "node:crypto";
import {mkdir, open, rename, unlink} from "node:fs/promises";
import path from "node:path";

/** Owns a new private artifact path. Never overwrite an existing corpus, report, symlink, or transcript. */
export class BenchmarkArtifacts {
    private constructor(private readonly file: string) {}

    static async create(file: string, initial: unknown): Promise<BenchmarkArtifacts> {
        const resolved = path.resolve(file);
        await mkdir(path.dirname(resolved), {recursive: true});
        const handle = await open(resolved, "wx", 0o600);
        await handle.close();
        const artifacts = new BenchmarkArtifacts(resolved);
        await artifacts.save(initial);
        return artifacts;
    }

    async save(value: unknown): Promise<void> {
        const temporary = `${this.file}.${randomUUID()}.tmp`;
        let owned = false;
        try {
            const handle = await open(temporary, "wx", 0o600);
            owned = true;
            try { await handle.writeFile(JSON.stringify(value, null, 2) + "\n"); }
            finally { await handle.close(); }
            await rename(temporary, this.file);
        } finally {
            if (owned) await unlink(temporary).catch((error: unknown) => {
                if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
            });
        }
    }
}
