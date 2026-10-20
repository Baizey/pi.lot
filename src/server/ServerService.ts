import {ServerConfigStore, type ServerConfig} from "./ServerConfig.js";
import {checkServerVersion} from "./ServerConnection.js";
import {SessionArchive, type SessionArchiveOptions} from "./SessionArchive.js";
import {ArchiveBackground} from "./ArchiveBackground.js";

/** Foreground request admission and read access; committed archive work has independent ownership. */
export class ServerService {
    private readonly requests = new Set<AbortController>();
    private closing = false;

    constructor(
        readonly store = new ServerConfigStore(),
        readonly checkConnection = checkServerVersion,
        readonly background = new ArchiveBackground(store),
    ) {
    }

    startSession(): void {
        this.closing = false;
    }

    beginRequest(): AbortController | undefined {
        if (this.closing) return undefined;
        const controller = new AbortController();
        this.requests.add(controller);
        return controller;
    }

    finishRequest(controller: AbortController): void {
        this.requests.delete(controller);
    }

    beginShutdown(): void {
        if (this.closing) return;
        this.closing = true;
        for (const controller of this.requests) controller.abort();
    }

    archive(config: ServerConfig, options: SessionArchiveOptions = {}): SessionArchive {
        return new SessionArchive(config, options);
    }
}
