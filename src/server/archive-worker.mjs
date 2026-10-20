import path from "node:path";
import {accessSync, constants, statSync} from "node:fs";
import {createJiti} from "jiti";
import Database from "better-sqlite3";

try {
    const [major, minor] = process.versions.node.split(".").map(Number);
    if (process.versions.bun || process.release.name !== "node" || major < 22 || (major === 22 && minor < 19)) {
        throw new Error("External Node >=22.19 is required");
    }
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === "--check") {
        // ArchiveLock deliberately uses this fixed absolute helper, not PATH lookup.
        accessSync("/usr/bin/flock", constants.X_OK);
        if (!statSync("/usr/bin/flock").isFile()) throw new Error("Archive flock helper must be executable");
        // Opening the database, rather than merely importing the package, checks the native ABI.
        const database = new Database(":memory:");
        try {
            database.prepare("SELECT 1").get();
        } finally {
            database.close();
        }
    } else {
        if (args.length !== 2 || !args.every((argument) => path.isAbsolute(argument))) {
            throw new Error("Expected absolute archive and configuration directories");
        }
        // Resolve the trusted entry point relative to this installed bootstrap, never the cwd.
        const jiti = createJiti(import.meta.url, {fsCache: false});
        const {runArchiveWorker} = await jiti.import(new URL("./ArchiveWorker.ts", import.meta.url).href);
        await runArchiveWorker(args[0], args[1]);
    }
} catch {
    // Configuration and transport errors can contain credentials; do not echo them to inherited logs.
    console.error("Archive worker bootstrap failed");
    process.exitCode = 1;
}
