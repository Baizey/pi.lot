import assert from "node:assert/strict";
import {createEventBus, createExtensionRuntime, type ExtensionAPI} from "@earendil-works/pi-coding-agent";
import {loadExtensionFromFactory} from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";

/** Obtain Pi's complete API without starting a session, loading files, or connecting providers. */
export async function createNativeExtensionApi(): Promise<ExtensionAPI> {
    let api: ExtensionAPI | undefined;
    await loadExtensionFromFactory((pi) => { api = pi; }, process.cwd(), createEventBus(), createExtensionRuntime());
    assert.ok(api);
    return api;
}
