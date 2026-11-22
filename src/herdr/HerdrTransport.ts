import {createConnection} from "node:net";
import {posix} from "node:path";

export type HerdrTarget = Readonly<{endpoint: string; paneId: string}>;

export function herdrTarget(env: NodeJS.ProcessEnv, platform = process.platform): HerdrTarget | undefined {
    const {HERDR_SOCKET_PATH: path, HERDR_PANE_ID: paneId} = env;
    if (env.HERDR_ENV !== "1" || env.PILOT_HERDR_REPORTING === "0" || !path || !paneId) return;
    if (/[\x00-\x1f\x7f]/u.test(path) || /[\x00-\x20\x7f]/u.test(paneId) || paneId.length > 128) return;
    if (platform === "win32") {
        // Herdr's Windows socket is the local pipe with this name, not a UNC destination.
        const endpoint = `\\\\.\\pipe\\${path}`;
        if (endpoint.length <= 256) return {endpoint, paneId};
        return;
    }
    // Do not let the OS truncate a pathname and connect to a different socket.
    if (!posix.isAbsolute(path) || Buffer.byteLength(path) > (platform === "linux" ? 107 : 103)) return;
    return {endpoint: path, paneId};
}

export type HerdrRequest = {
    id: string;
    method: "pane.report_agent" | "pane.report_agent_session";
    params: {
        pane_id: string;
        source: "herdr:pi";
        agent: "pi";
        seq: number;
        session_start_source?: "startup" | "reload" | "new" | "resume" | "fork";
        agent_session_path?: string;
        agent_session_id?: string;
        state?: "working" | "idle" | "blocked";
        message?: "Policy approval required" | "Server sign-in required";
    };
};

type Delivery = "accepted" | "rejected" | "unavailable";
export type HerdrSend = (endpoint: string, request: HerdrRequest, signal: AbortSignal) => Promise<Delivery>;

const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_REPLY_BYTES = 4096;

function attempt(endpoint: string, id: string, frame: string, signal: AbortSignal, timeoutMs: number): Promise<Delivery> {
    if (signal.aborted) return Promise.resolve("unavailable");
    return new Promise((resolve) => {
        let socket: ReturnType<typeof createConnection>;
        try {
            // An IPC path, never a TCP host, executable, or arbitrary method.
            socket = createConnection({path: endpoint});
        } catch {
            resolve("unavailable");
            return;
        }
        let finished = false;
        let reply = Buffer.alloc(0);
        const finish = (result: Delivery) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            signal.removeEventListener("abort", abort);
            socket.destroy();
            resolve(result);
        };
        const abort = () => finish("unavailable");
        const timer = setTimeout(abort, timeoutMs);
        timer.unref();
        socket.unref();
        signal.addEventListener("abort", abort, {once: true});
        socket.on("error", abort);
        socket.on("close", abort);
        socket.once("connect", () => socket.write(frame));
        socket.on("data", (chunk: Buffer) => {
            const newline = chunk.indexOf(10);
            const line = newline < 0 ? chunk : chunk.subarray(0, newline);
            if (reply.length + line.length > MAX_REPLY_BYTES) return abort();
            reply = Buffer.concat([reply, line]);
            if (newline < 0) return;
            try {
                const response = JSON.parse(reply.toString("utf8"));
                if (response?.id === id && response.result?.type === "ok") return finish("accepted");
                if (response?.id === id && typeof response.error?.code === "string") return finish("rejected");
            } catch {
                // Malformed reply.
            }
            abort();
        });
    });
}

export const sendHerdrRequest: HerdrSend = async (endpoint, request, signal) => {
    const frame = JSON.stringify(request) + "\n";
    if (Buffer.byteLength(frame) > MAX_REQUEST_BYTES) return "rejected";
    const result = await attempt(endpoint, request.id, frame, signal, 500);
    if (result === "unavailable" && !signal.aborted) {
        return attempt(endpoint, request.id, frame, signal, 1500);
    }
    return result;
};
