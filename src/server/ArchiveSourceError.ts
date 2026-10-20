export type ArchiveSourceFailure = "missing" | "changing" | "invalid" | "unreadable";

/** Bounded, content-free diagnostics; retry policy belongs to the worker. */
export class ArchiveSourceError extends Error {
    constructor(readonly code: ArchiveSourceFailure, message: string) {
        super(message);
        this.name = "ArchiveSourceError";
    }

    static fromFilesystem(error: unknown): ArchiveSourceError {
        if (error instanceof ArchiveSourceError) return error;
        const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
        if (code === "ENOENT") return new ArchiveSourceError("missing", "Archive source is missing.");
        if (code === "ELOOP" || code === "ENOTDIR") {
            return new ArchiveSourceError("invalid", "Archive source has an unsafe filesystem type.");
        }
        return new ArchiveSourceError("unreadable", "Archive source could not be safely read.");
    }
}

export function checkArchiveSourceAbort(signal?: AbortSignal): void {
    if (!signal?.aborted) return;
    const error = new Error("Archive operation was aborted.");
    error.name = "AbortError";
    throw error;
}
