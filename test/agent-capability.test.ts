import assert from "node:assert/strict";
import test from "node:test";
import {
    AGENT_CAPABILITIES,
    AgentCapabilitySet,
    AgentMechanismCapability,
} from "../src/subagents/AgentCapability.js";
import {
    POLICY_AREAS,
    PolicyAccessType,
    PolicyArea,
    policyAreaAccessTypes,
    policyAreaForAccessType,
} from "../src/policy/types.js";

test("agent capabilities are the complete policy-area set plus hard mechanisms", () => {
    assert.deepEqual(AGENT_CAPABILITIES, [
        ...POLICY_AREAS,
        AgentMechanismCapability.mcp,
        AgentMechanismCapability.delegate,
    ]);
    assert.equal(AGENT_CAPABILITIES.includes(PolicyArea.web_grpc), true);
    assert.equal(AGENT_CAPABILITIES.includes(PolicyArea.web_smtp), true);
    assert.equal(AGENT_CAPABILITIES.includes(PolicyArea.web_ssh), true);
    assert.equal(AGENT_CAPABILITIES.includes(PolicyArea.web_websocket), true);
});

test("every concrete policy access type belongs to exactly one capability area", () => {
    const covered = POLICY_AREAS.flatMap((area) => policyAreaAccessTypes(area));
    assert.deepEqual(new Set(covered), new Set(Object.values(PolicyAccessType)));
    assert.equal(covered.length, Object.values(PolicyAccessType).length);
    for (const accessType of Object.values(PolicyAccessType)) {
        assert.equal(policyAreaAccessTypes(policyAreaForAccessType(accessType)).includes(accessType), true);
    }
});

test("capability sets deduplicate and separate policy snapshots from hard mechanisms", () => {
    const capabilities = new AgentCapabilitySet([
        PolicyArea.fs_read,
        AgentMechanismCapability.mcp,
        PolicyArea.fs_read,
        AgentMechanismCapability.delegate,
    ]);

    assert.deepEqual(capabilities.policyAreas(), [PolicyArea.fs_read]);
    assert.deepEqual(capabilities.mechanisms(), [
        AgentMechanismCapability.mcp,
        AgentMechanismCapability.delegate,
    ]);
    assert.deepEqual(capabilities.all(), [
        PolicyArea.fs_read,
        AgentMechanismCapability.mcp,
        AgentMechanismCapability.delegate,
    ]);
});

test("unknown capabilities fail closed", () => {
    assert.throws(
        () => new AgentCapabilitySet(["unknown" as PolicyArea]),
        /Unknown agent capability/,
    );
});
