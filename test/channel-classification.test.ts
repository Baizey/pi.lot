import assert from "node:assert/strict";
import test from "node:test";
import {ChannelClassifier, channelProtocol, channelProtocols} from "../src/policy/network/ChannelProtocols.js";
import {classifyTcpProtocol} from "../src/policy/network/TcpProtocol.js";
import {channelEnvelopes} from "./fixtures/channel-envelopes.js";

for (const envelope of channelEnvelopes) {
    const direction = envelope.initiation;
    const bytes = direction === "client" ? envelope.request : envelope.response;
    test(`${envelope.protocol} classification preserves every fragmented initial prefix`, () => {
        const incremental = new ChannelClassifier(direction);
        for (let length = 0; length < bytes.length; length++) {
            assert.equal(classifyTcpProtocol(bytes.subarray(0, length), direction), undefined,
                `${envelope.protocol} prematurely classified at ${length}/${bytes.length}`);
            assert.equal(classifyTcpProtocol(bytes.subarray(0, length), direction, incremental), undefined,
                `${envelope.protocol} incremental reader prematurely classified at ${length}/${bytes.length}`);
        }
        assert.equal(classifyTcpProtocol(bytes, direction), envelope.protocol);
        assert.equal(classifyTcpProtocol(bytes, direction, incremental), envelope.protocol);
        assert.equal(classifyTcpProtocol(Buffer.concat([bytes, Buffer.from("GET / HTTP/1.1\r\n\0\xff")]), direction), envelope.protocol);
    });

    test(`${envelope.protocol} initial envelope has only one protocol interpretation`, () => {
        const matches = channelProtocols.filter((definition) => {
            const probe = direction === "client" ? definition.inspectClient(bytes) : definition.inspectServer(bytes);
            return probe.status === "match";
        });
        assert.deepEqual(matches.map((definition) => definition.protocol), [envelope.protocol]);
        const definition = channelProtocol(envelope.protocol)!;
        if (direction === "client") {
            assert.deepEqual(definition.inspectClient(Buffer.concat([bytes, Buffer.alloc(128, 0xff)])),
                {status: "match", length: bytes.length});
            assert.deepEqual(definition.inspectServer(envelope.response, bytes),
                {status: "match", length: envelope.response.length});
        }
    });
}

test("channel parser trust boundaries never throw on bounded arbitrary input", () => {
    // Reproducible malformed/truncated input coverage, not a substitute for protocol-specific tests.
    let state = 0x7f4a7c15;
    const random = () => {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return state >>> 0;
    };
    for (let iteration = 0; iteration < 512; iteration++) {
        const bytes = Buffer.alloc(random() % 256);
        for (let index = 0; index < bytes.length; index++) bytes[index] = random() & 0xff;
        for (const definition of channelProtocols) {
            assert.doesNotThrow(() => definition.inspectClient(bytes), definition.protocol);
            assert.doesNotThrow(() => definition.inspectServer(bytes), definition.protocol);
            const fixture = channelEnvelopes.find((entry) => entry.protocol === definition.protocol)!;
            assert.doesNotThrow(() => definition.inspectServer(bytes, fixture.request), definition.protocol);
        }
        const fixture = channelEnvelopes[iteration % channelEnvelopes.length]!;
        const definition = channelProtocol(fixture.protocol)!;
        const mutated = Buffer.from(fixture.initiation === "client" ? fixture.request : fixture.response);
        if (mutated.length > 0) mutated[random() % mutated.length] = random() & 0xff;
        assert.doesNotThrow(() => definition.inspectClient(mutated));
        assert.doesNotThrow(() => definition.inspectServer(mutated, fixture.request));
    }
});
