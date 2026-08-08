import {randomBytes} from "node:crypto";
import {isIP} from "node:net";
import {createSecureContext} from "node:tls";
import type {SecureContext} from "node:tls";
import forge from "node-forge";

const RSA_KEY_BITS = 2_048;
const CERTIFICATE_CLOCK_SKEW_MILLISECONDS = 5 * 60 * 1_000;
const CERTIFICATE_LIFETIME_MILLISECONDS = 24 * 60 * 60 * 1_000;

export type TlsServerCredentials = {
    key: string;
    cert: string;
};

export class TlsCertificateAuthority {
    private readonly caKeys: forge.pki.rsa.KeyPair;
    private readonly leafKeys: forge.pki.rsa.KeyPair;
    private readonly caCertificate: forge.pki.Certificate;
    private readonly contexts = new Map<string, SecureContext>();
    private readonly credentialsByIdentity = new Map<string, TlsServerCredentials>();
    readonly certificatePem: string;

    constructor() {
        this.caKeys = forge.pki.rsa.generateKeyPair(RSA_KEY_BITS);
        this.leafKeys = forge.pki.rsa.generateKeyPair(RSA_KEY_BITS);
        this.caCertificate = createCaCertificate(this.caKeys);
        this.certificatePem = forge.pki.certificateToPem(this.caCertificate);
    }

    secureContext(identity: string): SecureContext {
        const normalized = normalizeIdentity(identity);
        const existing = this.contexts.get(normalized);
        if (existing) return existing;

        const credentials = this.serverCredentials(normalized);
        const context = createSecureContext({
            ...credentials,
            minVersion: "TLSv1.2",
        });
        this.contexts.set(normalized, context);
        return context;
    }

    serverCredentials(identity: string): TlsServerCredentials {
        const normalized = normalizeIdentity(identity);
        const existing = this.credentialsByIdentity.get(normalized);
        if (existing) return existing;
        const certificate = createLeafCertificate(
            normalized,
            this.leafKeys.publicKey,
            this.caCertificate,
            this.caKeys.privateKey,
        );
        const credentials = {
            key: forge.pki.privateKeyToPem(this.leafKeys.privateKey),
            cert: `${forge.pki.certificateToPem(certificate)}${this.certificatePem}`,
        };
        this.credentialsByIdentity.set(normalized, credentials);
        return credentials;
    }
}

function createCaCertificate(keys: forge.pki.rsa.KeyPair): forge.pki.Certificate {
    const certificate = forge.pki.createCertificate();
    certificate.publicKey = keys.publicKey;
    certificate.serialNumber = certificateSerial();
    setValidity(certificate);
    const subject = [{name: "commonName", value: "Pilot Session Network CA"}];
    certificate.setSubject(subject);
    certificate.setIssuer(subject);
    certificate.setExtensions([
        {name: "basicConstraints", cA: true, critical: true},
        {
            name: "keyUsage",
            keyCertSign: true,
            cRLSign: true,
            digitalSignature: true,
            critical: true,
        },
        {name: "subjectKeyIdentifier"},
    ]);
    certificate.sign(keys.privateKey, forge.md.sha256.create());
    return certificate;
}

function createLeafCertificate(
    identity: string,
    publicKey: forge.pki.rsa.PublicKey,
    issuer: forge.pki.Certificate,
    issuerKey: forge.pki.rsa.PrivateKey,
): forge.pki.Certificate {
    const certificate = forge.pki.createCertificate();
    certificate.publicKey = publicKey;
    certificate.serialNumber = certificateSerial();
    setValidity(certificate);
    certificate.setSubject([{name: "commonName", value: "Pilot Intercepted Endpoint"}]);
    certificate.setIssuer(issuer.subject.attributes);
    certificate.setExtensions([
        {name: "basicConstraints", cA: false, critical: true},
        {
            name: "keyUsage",
            digitalSignature: true,
            keyEncipherment: true,
            critical: true,
        },
        {
            name: "extKeyUsage",
            serverAuth: true,
        },
        {
            name: "subjectAltName",
            altNames: isIP(identity) === 0
                ? [{type: 2, value: identity}]
                : [{type: 7, ip: identity}],
        },
        {name: "subjectKeyIdentifier"},
        {name: "authorityKeyIdentifier", keyIdentifier: issuer.generateSubjectKeyIdentifier().getBytes()},
    ]);
    certificate.sign(issuerKey, forge.md.sha256.create());
    return certificate;
}

function setValidity(certificate: forge.pki.Certificate): void {
    const now = Date.now();
    certificate.validity.notBefore = new Date(now - CERTIFICATE_CLOCK_SKEW_MILLISECONDS);
    certificate.validity.notAfter = new Date(now + CERTIFICATE_LIFETIME_MILLISECONDS);
}

function certificateSerial(): string {
    return `01${randomBytes(19).toString("hex")}`;
}

function normalizeIdentity(identity: string): string {
    if (isIP(identity) !== 0) return identity;
    const normalized = identity.toLowerCase().replace(/\.$/, "");
    if (
        normalized.length === 0
        || normalized.length > 253
        || normalized.split(".").some((label) => (
            label.length === 0
            || label.length > 63
            || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)
        ))
    ) {
        throw new Error("TLS gateway received an invalid certificate hostname");
    }
    return normalized;
}
