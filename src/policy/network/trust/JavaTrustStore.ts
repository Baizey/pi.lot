import {createHash} from "node:crypto";
import forge from "node-forge";

const CERTIFICATE_PATTERN = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g;
const JAVA_TRUSTED_KEY_USAGE_OID = "2.16.840.1.113894.746875.1.1";
const ANY_EXTENDED_KEY_USAGE_OID = "2.5.29.37.0";
const MAC_ITERATIONS = 2_048;
const MAC_SALT_BYTES = 20;

export const JAVA_TRUST_STORE_PASSWORD = "changeit";

export type JavaTrustStore = {
    bytes: Buffer;
    aliases: readonly string[];
};

type TrustCertificate = {
    der: string;
    alias: string;
};

export function createJavaTrustStore(
    certificateBundlePem: string,
    password = JAVA_TRUST_STORE_PASSWORD,
): JavaTrustStore {
    const certificates = parseTrustCertificates(certificateBundlePem);
    if (certificates.length === 0) throw new Error("Java trust store requires at least one CA certificate");

    const safeContents = forge.asn1.create(
        forge.asn1.Class.UNIVERSAL,
        forge.asn1.Type.SEQUENCE,
        true,
        certificates.map(certificateSafeBag),
    );
    const authenticatedSafe = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
        dataContentInfo(forge.asn1.toDer(safeContents).getBytes()),
    ]);
    const authenticatedSafeDer = forge.asn1.toDer(authenticatedSafe).getBytes();
    const pfx = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
        forge.asn1.create(
            forge.asn1.Class.UNIVERSAL,
            forge.asn1.Type.INTEGER,
            false,
            forge.asn1.integerToDer(3).getBytes(),
        ),
        dataContentInfo(authenticatedSafeDer),
        createMacData(authenticatedSafeDer, password),
    ]);
    return {
        bytes: Buffer.from(forge.asn1.toDer(pfx).getBytes(), "binary"),
        aliases: certificates.map(({alias}) => alias),
    };
}

function parseTrustCertificates(certificateBundlePem: string): TrustCertificate[] {
    const unique = new Map<string, TrustCertificate>();
    for (const match of certificateBundlePem.matchAll(CERTIFICATE_PATTERN)) {
        const encoded = match[1]?.replace(/\s/g, "");
        if (!encoded) throw new Error("client trust bundle contains an empty PEM certificate");
        const derBuffer = Buffer.from(encoded, "base64");
        const der = derBuffer.toString("binary");
        try {
            const certificate = forge.asn1.fromDer(der);
            if (
                certificate.tagClass !== forge.asn1.Class.UNIVERSAL
                || certificate.type !== forge.asn1.Type.SEQUENCE
                || !certificate.constructed
            ) {
                throw new Error("X.509 certificate is not an ASN.1 sequence");
            }
        } catch (error) {
            throw new Error("client trust bundle contains an invalid DER certificate", {cause: error});
        }
        const fingerprint = createHash("sha256").update(derBuffer).digest("hex");
        unique.set(fingerprint, {der, alias: `pilot-ca-${fingerprint}`});
    }
    return [...unique.values()];
}

function certificateSafeBag(certificate: TrustCertificate): forge.asn1.Asn1 {
    return forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
        oid(forge.pki.oids.certBag),
        forge.asn1.create(forge.asn1.Class.CONTEXT_SPECIFIC, 0, true, [
            forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
                oid(forge.pki.oids.x509Certificate),
                forge.asn1.create(forge.asn1.Class.CONTEXT_SPECIFIC, 0, true, [
                    forge.asn1.create(
                        forge.asn1.Class.UNIVERSAL,
                        forge.asn1.Type.OCTETSTRING,
                        false,
                        certificate.der,
                    ),
                ]),
            ]),
        ]),
        trustedCertificateAttributes(certificate.alias),
    ]);
}

function trustedCertificateAttributes(alias: string): forge.asn1.Asn1 {
    // Java only exposes a certificate-only PKCS12 bag as a trustedCertEntry when this Oracle attribute is present.
    return forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, [
        forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
            oid(forge.pki.oids.friendlyName),
            forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, [
                forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.BMPSTRING, false, alias),
            ]),
        ]),
        forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
            oid(JAVA_TRUSTED_KEY_USAGE_OID),
            forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, [
                oid(ANY_EXTENDED_KEY_USAGE_OID),
            ]),
        ]),
    ]);
}

function dataContentInfo(content: string): forge.asn1.Asn1 {
    return forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
        oid(forge.pki.oids.data),
        forge.asn1.create(forge.asn1.Class.CONTEXT_SPECIFIC, 0, true, [
            forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.OCTETSTRING, false, content),
        ]),
    ]);
}

function createMacData(authenticatedSafe: string, password: string): forge.asn1.Asn1 {
    // SHA-1 is used only for broad PKCS12 MAC compatibility, not for certificate signing.
    const saltBytes = forge.random.getBytesSync(MAC_SALT_BYTES);
    const key = forge.pkcs12.generateKey(
        password,
        forge.util.createBuffer(saltBytes),
        3,
        MAC_ITERATIONS,
        20,
    );
    const mac = forge.hmac.create();
    mac.start(forge.md.sha1.create(), key);
    mac.update(authenticatedSafe);
    return forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
        forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
            forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, [
                oid(forge.pki.oids.sha1),
                forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.NULL, false, ""),
            ]),
            forge.asn1.create(
                forge.asn1.Class.UNIVERSAL,
                forge.asn1.Type.OCTETSTRING,
                false,
                mac.getMac().getBytes(),
            ),
        ]),
        forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.OCTETSTRING, false, saltBytes),
        forge.asn1.create(
            forge.asn1.Class.UNIVERSAL,
            forge.asn1.Type.INTEGER,
            false,
            forge.asn1.integerToDer(MAC_ITERATIONS).getBytes(),
        ),
    ]);
}

function oid(value: string): forge.asn1.Asn1 {
    return forge.asn1.create(
        forge.asn1.Class.UNIVERSAL,
        forge.asn1.Type.OID,
        false,
        forge.asn1.oidToDer(value).getBytes(),
    );
}
