import type {ResponseDefaults} from "./types.js";
import {ResponseType} from "./types.js";
import {JsonFileLoader, JsonFileLoaderInterface} from "../storage/JsonFileLoader";
import path from "node:path";
import os from "node:os";

export const initialPolicyDefaults: Readonly<ResponseDefaults> = {
    fs_read: ResponseType.allow,
    fs_write: ResponseType.ask_user,
    web_read: ResponseType.allow,
    web_write: ResponseType.ask_user,
    web_extra: ResponseType.ask_user,
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