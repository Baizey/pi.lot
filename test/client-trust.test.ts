import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import forge from "node-forge";
import {
    CLIENT_TRUST_ADAPTERS,
    ClientTrustArtifactKind,
    ClientTrustSupportLevel,
    applyClientTrustAdapters,
} from "../src/policy/network/trust/ClientTrustAdapters.js";
import {ClientTrust} from "../src/policy/network/trust/ClientTrust.js";
import {JAVA_TRUST_STORE_PASSWORD} from "../src/policy/network/trust/JavaTrustStore.js";
import {TlsCertificateAuthority} from "../src/policy/network/TlsCertificateAuthority.js";

const JAVA_TRUSTED_KEY_USAGE_OID = "2.16.840.1.113894.746875.1.1";
const ANY_EXTENDED_KEY_USAGE_OID = "2.5.29.37.0";

test("client trust adapters are declarative, unique, and install their documented environment", () => {
    const ids: string[] = CLIENT_TRUST_ADAPTERS.map(({id}) => id);
    assert.equal(new Set(ids).size, ids.length);
    assert.deepEqual(
        ["system-openssl", "curl", "git", "node", "npm", "pip", "java-jsse", "cargo"]
            .filter((id) => !ids.includes(id)),
        [],
    );
    for (const adapter of CLIENT_TRUST_ADAPTERS) {
        assert.equal(adapter.tools.length > 0, true, `${adapter.id} has no documented tools`);
        assert.equal(adapter.limitations.length > 0, true, `${adapter.id} has no documented limitations`);
        if (adapter.support === ClientTrustSupportLevel.UNSUPPORTED) {
            assert.equal(adapter.bindings.length, 0, `${adapter.id} cannot inject unsupported trust`);
        }
    }

    const artifacts = {
        combinedPem: "/runtime/ca-bundle.pem",
        javaPkcs12: "/runtime/java-truststore.p12",
        javaPkcs12Password: "test-password",
    };
    const environment = applyClientTrustAdapters({
        JAVA_TOOL_OPTIONS: "-Xmx128m",
        SSL_CERT_FILE: "/user/selected.pem",
    }, artifacts);
    for (const adapter of CLIENT_TRUST_ADAPTERS) {
        for (const binding of adapter.bindings) {
            if (binding.kind !== "artifact-path") continue;
            assert.equal(
                environment[binding.variable],
                binding.artifact === ClientTrustArtifactKind.COMBINED_PEM
                    ? artifacts.combinedPem
                    : artifacts.javaPkcs12,
                `${adapter.id} did not install ${binding.variable}`,
            );
        }
    }
    assert.equal(environment.JAVA_TOOL_OPTIONS, [
        "-Xmx128m",
        "-Djavax.net.ssl.trustStore=/runtime/java-truststore.p12",
        "-Djavax.net.ssl.trustStoreType=PKCS12",
        "-Djavax.net.ssl.trustStorePassword=test-password",
    ].join(" "));
});

test("client trust materializes a read-only PEM bundle and Java trusted-certificate store", async (context) => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), "pilot-client-trust-test-"));
    const hostBundleFile = path.join(workspace, "host-ca.pem");
    const authority = new TlsCertificateAuthority();
    writeFileSync(hostBundleFile, authority.certificatePem);

    try {
        const trust = await ClientTrust.create({
            runtimeDirectory: workspace,
            environment: {SSL_CERT_FILE: hostBundleFile},
        });
        assert.equal(statSync(trust.combinedPemFile).mode & 0o777, 0o400);
        assert.equal(statSync(trust.javaPkcs12File).mode & 0o777, 0o400);
        const combinedPem = readFileSync(trust.combinedPemFile, "utf8");
        const combinedCertificates = combinedPem.match(/-----BEGIN CERTIFICATE-----/g) ?? [];
        assert.equal(combinedCertificates.length > 0, true);
        assert.equal(combinedPem.includes(authority.certificatePem.trim()), true);
        assert.equal(trust.javaTrustStoreAliases.length, combinedCertificates.length);

        const pkcs12Bytes = readFileSync(trust.javaPkcs12File);
        const pkcs12 = forge.pkcs12.pkcs12FromAsn1(
            forge.asn1.fromDer(pkcs12Bytes.toString("binary")),
            JAVA_TRUST_STORE_PASSWORD,
        );
        const certificateBags = pkcs12.getBags({bagType: forge.pki.oids.certBag})[forge.pki.oids.certBag];
        assert.equal(certificateBags?.length, trust.javaTrustStoreAliases.length);
        assert.equal(pkcs12Bytes.includes(oidValue(JAVA_TRUSTED_KEY_USAGE_OID)), true);
        assert.equal(pkcs12Bytes.includes(oidValue(ANY_EXTENDED_KEY_USAGE_OID)), true);

        const environment = trust.environment({JAVA_TOOL_OPTIONS: "-Xms32m"});
        assert.equal(environment.PIP_CERT, trust.combinedPemFile);
        assert.equal(environment.CARGO_HTTP_CAINFO, trust.combinedPemFile);
        assert.equal(environment.AWS_CA_BUNDLE, trust.combinedPemFile);
        assert.match(environment.JAVA_TOOL_OPTIONS ?? "", /^-Xms32m /);
        assert.match(environment.JAVA_TOOL_OPTIONS ?? "", /javax\.net\.ssl\.trustStore=.*java-truststore\.p12/);

        const mountArguments = trust.bubblewrapArguments();
        assert.deepEqual(mountArguments.slice(0, 6), [
            "--ro-bind", trust.combinedPemFile, trust.combinedPemFile,
            "--ro-bind", trust.javaPkcs12File, trust.javaPkcs12File,
        ]);

        const keytool = spawnSync("keytool", [
            "-list",
            "-v",
            "-storetype", "PKCS12",
            "-storepass", JAVA_TRUST_STORE_PASSWORD,
            "-keystore", trust.javaPkcs12File,
            "-alias", trust.javaTrustStoreAliases[0]!,
        ], {
            encoding: "utf8",
            env: {...process.env, LANG: "C", LC_ALL: "C"},
        });
        if (keytool.error && (keytool.error as NodeJS.ErrnoException).code === "ENOENT") {
            context.diagnostic("keytool is unavailable; Java compatibility assertion skipped");
        } else {
            assert.equal(keytool.status, 0, `${keytool.stdout}\n${keytool.stderr}`);
            assert.match(`${keytool.stdout}\n${keytool.stderr}`, /Entry type: trustedCertEntry/);
        }
    } finally {
        rmSync(workspace, {recursive: true, force: true});
    }
});

function oidValue(oid: string): Buffer {
    return Buffer.from(forge.asn1.oidToDer(oid).getBytes(), "binary");
}
