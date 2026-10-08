import {fileURLToPath} from "node:url";
import {fuseFlags, netfilterQueueFlags} from "./native-build-flags.mjs";

// Both probe drivers exercise the real production callbacks. Their C branch
// remains the baseline; their Rust branch links the production Rust staticlib.
export function fuseProbeFlags() {
    const implementation = process.env.PILOT_NATIVE_IMPLEMENTATION ?? "rust";
    if (implementation === "c") return fuseFlags();
    if (implementation !== "rust") throw new Error(`Invalid PILOT_NATIVE_IMPLEMENTATION: ${implementation}`);
    return [
        "-DPILOT_RUST_NATIVE",
        fileURLToPath(new URL("../build/libpilot_native.a", import.meta.url)),
        ...fuseFlags(),
        ...netfilterQueueFlags(),
        "-lgcc_s", "-lutil", "-lrt", "-lpthread", "-lm", "-ldl",
    ];
}
