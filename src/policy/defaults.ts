import {PolicyArea, PolicyFallbackResponse} from "./types.js";
import {JsonFileLoader, JsonFileLoaderInterface} from "../storage/JsonFileLoader";
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

export type PolicyDefaultJsonStorageInterface = JsonFileLoaderInterface<ResponseDefaults>;

export class PolicyDefaultJsonStorage extends JsonFileLoader<ResponseDefaults> implements PolicyDefaultJsonStorageInterface {

    constructor(
        filename: string = "policy-defaults",
        directory = path.join(os.homedir(), ".pilot")
    ) {
        super(filename, initialPolicyDefaults, directory)
    }
}