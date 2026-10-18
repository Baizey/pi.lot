import {PolicyArea, PolicyFallbackResponse} from "./types.js";
import {JsonDefaultsFile} from "../storage/JsonDefaultsFile.js";
import path from "node:path";
import os from "node:os";

export type ResponseDefaults = Record<PolicyArea, PolicyFallbackResponse>

export const initialPolicyDefaults: Readonly<ResponseDefaults> = {
    fs_read: PolicyFallbackResponse.allow,
    fs_write: PolicyFallbackResponse.ask_user,
    web_read: PolicyFallbackResponse.allow,
    web_write: PolicyFallbackResponse.ask_user,
    web_dns: PolicyFallbackResponse.ask_user,
    web_grpc: PolicyFallbackResponse.ask_user,
    web_smtp: PolicyFallbackResponse.ask_user,
    web_ssh: PolicyFallbackResponse.ask_user,
    web_tcp: PolicyFallbackResponse.ask_user,
    web_udp: PolicyFallbackResponse.ask_user,
    web_websocket: PolicyFallbackResponse.ask_user,
};

export interface PolicyDefaultJsonStorageInterface {
    load(): ResponseDefaults;
    save(defaults: ResponseDefaults): void;
}

export class PolicyDefaultJsonStorage implements PolicyDefaultJsonStorageInterface {
    readonly file: string;
    private readonly defaultsFile: JsonDefaultsFile<ResponseDefaults>;

    constructor(
        filename: string = "policy-defaults",
        directory = path.join(os.homedir(), ".pilot")
    ) {
        // Keep the shared fallback frozen from the first store construction, as before.
        Object.freeze(initialPolicyDefaults);
        this.file = path.join(directory, `${filename}.json`);
        this.defaultsFile = new JsonDefaultsFile(
            this.file,
            "policy defaults",
            (value) => value as ResponseDefaults,
            () => initialPolicyDefaults,
        );
    }

    load(): ResponseDefaults {
        return this.defaultsFile.load();
    }

    save(defaults: ResponseDefaults): void {
        this.defaultsFile.save(defaults);
    }
}
