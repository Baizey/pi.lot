import {createInterface} from "node:readline";

const input = createInterface({input: process.stdin});
input.on("line", (line) => {
    const message = JSON.parse(line);
    if (message.id === undefined) return;
    let result;
    switch (message.method) {
        case "initialize":
            result = {
                protocolVersion: message.params.protocolVersion,
                capabilities: {tools: {}},
                serverInfo: {name: "pilot-test-server", version: "1.0.0"},
            };
            break;
        case "tools/list":
            result = {tools: [{
                name: "echo",
                description: "Echo a value",
                inputSchema: {type: "object", properties: {value: {type: "string"}}, required: ["value"]},
            }]};
            break;
        case "tools/call":
            result = {content: [{type: "text", text: message.params.arguments.value}]};
            break;
        default:
            process.stdout.write(`${JSON.stringify({jsonrpc: "2.0", id: message.id, error: {code: -32601, message: "Method not found"}})}\n`);
            return;
    }
    process.stdout.write(`${JSON.stringify({jsonrpc: "2.0", id: message.id, result})}\n`);
});
