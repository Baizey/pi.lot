import assert from "node:assert/strict";
import test from "node:test";
import {matchesServerVersion} from "../src/server/ServerCompatibility.js";

test("exact version pins retain literal equality", () => {
    for (const [version, requirement, matches] of [
        ["1.2.3", "1.2.3", true],
        ["1.2.4", "1.2.3", false],
        ["1.3.3", "1.2.3", false],
        ["2.2.3", "1.2.3", false],
        ["1.2.3-rc.1", "1.2.3", false],
        ["1.2.3-rc.1", "1.2.3-rc.1", true],
        ["1.2.3+build.7", "1.2.3", false],
        ["1.2.3+build.7", "1.2.3+build.7", true],
    ] as const) {
        assert.equal(matchesServerVersion(version, requirement), matches, `${version} against ${requirement}`);
    }
});

test("major wildcards accept stable minor and patch releases in that major", () => {
    for (const version of ["0.0.0", "0.1.3", "0.99.999", "0.1.3+build-7"]) {
        assert.equal(matchesServerVersion(version, "0.*"), true, version);
    }
    for (const version of ["1.0.0", "10.0.0", "0.1.3-rc.1", "0.1.3-rc.1+build.7"]) {
        assert.equal(matchesServerVersion(version, "0.*"), false, version);
    }
    assert.equal(matchesServerVersion("12.3.4", "12.*"), true);
    assert.equal(matchesServerVersion("120.3.4", "12.*"), false);
});

test("minor wildcards keep the exact major and minor, without numeric rounding", () => {
    for (const [version, requirement, matches] of [
        ["1.2.0", "1.2.*", true],
        ["1.2.999", "1.2.*", true],
        ["1.2.3+build.7", "1.2.*", true],
        ["1.2.3-rc.1", "1.2.*", false],
        ["1.3.0", "1.2.*", false],
        ["1.20.0", "1.2.*", false],
        ["10.2.0", "1.2.*", false],
        ["1.9007199254740993.2", "1.9007199254740993.*", true],
        ["1.9007199254740992.2", "1.9007199254740993.*", false],
    ] as const) {
        assert.equal(matchesServerVersion(version, requirement), matches, `${version} against ${requirement}`);
    }
});

test("unsupported or malformed requirements do not broaden compatibility", () => {
    for (const requirement of [
        "", "*", "1", "1.2", "1.x", "1.2.x", "^1.2.3", ">=1.2.3", "1.*.3", "1.*.*", "1.2.3.*",
        "01.*", "1.02.*", "1..*", "1.2.* ", "1.2.*\n", " 1.2.*", "1.2.*suffix",
    ]) {
        assert.equal(matchesServerVersion("1.2.3", requirement), false, requirement);
    }
});

test("invalid server versions never match either exact pins or wildcards", () => {
    for (const version of ["", "0.1", "0.*", "v0.1.3", "00.1.3", "0.01.3", "0.1.03", "0.1.3-01", "0.1.3\n"]) {
        assert.equal(matchesServerVersion(version, version), false, version);
        assert.equal(matchesServerVersion(version, "0.*"), false, version);
    }
});
