import path from "node:path";
import {ArchiveInbox} from "./ArchiveInbox.js";
import {ArchiveRuntime} from "./ArchiveRuntime.js";
import type {ArchiveSourceScope} from "./ArchiveSourceScope.js";
import {ServerConfigStore} from "./ServerConfig.js";

export type ArchiveBackgroundOptions = {
    directory?: string;
    runtime?: ArchiveRuntime;
};
export type ArchiveEnqueueResult = {queued: true; warning?: string};

/** Small foreground handoff. This class never opens the worker journal or a transcript. */
export class ArchiveBackground {
    readonly directory: string;
    private readonly inbox: ArchiveInbox;
    private readonly runtime: ArchiveRuntime;
    private ready = false;

    constructor(private readonly store: ServerConfigStore, options: ArchiveBackgroundOptions = {}) {
        this.directory = path.resolve(options.directory ?? store.archiveDirectory);
        this.inbox = new ArchiveInbox(this.directory);
        this.runtime = options.runtime ?? new ArchiveRuntime();
    }

    async initialize(): Promise<void> {
        this.store.ensureConnection();
        // Failure leaves enqueue enabled, but never causes hidden runtime validation
        // after teardown. The durable obligation is independent of launch success.
        await this.runtime.initialize();
        this.ready = true;
        await this.wake();
    }

    async enqueue(source: ArchiveSourceScope, enqueueId?: string): Promise<ArchiveEnqueueResult> {
        const connection = this.store.connection();
        if (!connection) throw new Error("Archive is not configured; source was not queued.");
        if (source.scope === "current" && !source.sessionFile) throw new Error("Ephemeral session was not queued.");
        this.inbox.publish(source, connection.config.url, connection.generation, enqueueId);
        try {
            await this.launch();
            return {queued: true};
        } catch {
            return {queued: true, warning: "Archive work is queued, but its background worker could not be launched. It will resume on a later wakeup."};
        }
    }

    async wake(): Promise<void> {
        this.inbox.signal();
        await this.launch();
    }

    private async launch(): Promise<void> {
        if (!this.ready) throw new Error("Archive background runtime is unavailable; queued work is retained.");
        await this.runtime.launch(this.directory, this.store.directory);
    }
}
