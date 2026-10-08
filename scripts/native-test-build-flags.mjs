import {fileURLToPath} from "node:url";
import {fuseFlags, netfilterQueueFlags} from "./native-build-flags.mjs";

// Both thin C probe drivers marshal the real callbacks into the Rust staticlib.
export function fuseProbeFlags() {
    return [
        fileURLToPath(new URL("../build/libpilot_native.a", import.meta.url)),
        ...fuseFlags(),
        ...netfilterQueueFlags(),
        "-lgcc_s", "-lutil", "-lrt", "-lpthread", "-lm", "-ldl",
    ];
}
