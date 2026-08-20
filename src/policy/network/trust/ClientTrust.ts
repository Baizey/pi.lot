import {readFile, realpath, stat, writeFile} from "node:fs/promises";
import path from "node:path";
import {
    applyClientTrustAdapters,
    clientTrustPemEnvironmentVariables,
} from "./ClientTrustAdapters.js";
import type {ClientTrustArtifactPaths} from "./ClientTrustAdapters.js";
import {createJavaTrustStore, JAVA_TRUST_STORE_PASSWORD} from "./JavaTrustStore.js";
import type {WorkerBindMount, WorkerRuntimeResource} from "../worker/WorkerRuntimeResource.js";
import {workerBindMountArguments} from "../worker/WorkerRuntimeResource.js";

const SYSTEM_CA_BUNDLE_CANDIDATES = [
    "/etc/ssl/certs/ca-certificates.crt",
    "/etc/pki/tls/certs/ca-bundle.crt",
    "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem",
    "/etc/ssl/ca-bundle.pem",
    "/etc/pki/tls/cacert.pem",
] as const;
const CERTIFICATE_PATTERN = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;

export type ClientTrustOptions = {
    runtimeDirectory: string;
    environment?: NodeJS.ProcessEnv;
    additionalCa?: string;
    interceptionCa?: string;
};

export class ClientTrust implements WorkerRuntimeResource {
    readonly combinedPemFile: string;
    readonly javaPkcs12File: string;
    readonly javaTrustStoreAliases: readonly string[];

    private readonly systemCaBundleDestinations: readonly string[];

    private constructor(
        artifacts: ClientTrustArtifactPaths,
        javaTrustStoreAliases: readonly string[],
        systemCaBundleDestinations: readonly string[],
    ) {
        this.combinedPemFile = artifacts.combinedPem;
        this.javaPkcs12File = artifacts.javaPkcs12;
        this.javaTrustStoreAliases = javaTrustStoreAliases;
        this.systemCaBundleDestinations = systemCaBundleDestinations;
    }

    static async create(options: ClientTrustOptions): Promise<ClientTrust> {
        const [hostCaBundle, systemCaBundleDestinations] = await Promise.all([
            readHostCaBundle(options.environment),
            resolveSystemCaBundleDestinations(),
        ]);
        const combinedPem = combineCaBundles(hostCaBundle, options.additionalCa, options.interceptionCa);
        const javaTrustStore = createJavaTrustStore(combinedPem, JAVA_TRUST_STORE_PASSWORD);
        const artifacts: ClientTrustArtifactPaths = {
            combinedPem: path.join(options.runtimeDirectory, "ca-bundle.pem"),
            javaPkcs12: path.join(options.runtimeDirectory, "java-truststore.p12"),
            javaPkcs12Password: JAVA_TRUST_STORE_PASSWORD,
        };
        await Promise.all([
            writeFile(artifacts.combinedPem, combinedPem, {mode: 0o400}),
            writeFile(artifacts.javaPkcs12, javaTrustStore.bytes, {mode: 0o400}),
        ]);
        return new ClientTrust(artifacts, javaTrustStore.aliases, systemCaBundleDestinations);
    }

    environment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
        return applyClientTrustAdapters(base, this.artifacts());
    }

    mounts(): readonly WorkerBindMount[] {
        return [
            {source: this.combinedPemFile, destination: this.combinedPemFile, readOnly: true},
            {source: this.javaPkcs12File, destination: this.javaPkcs12File, readOnly: true},
            ...this.systemCaBundleDestinations.map((destination) => ({
                source: this.combinedPemFile,
                destination,
                readOnly: true,
            })),
        ];
    }

    bubblewrapArguments(): string[] {
        return workerBindMountArguments(this.mounts());
    }

    private artifacts(): ClientTrustArtifactPaths {
        return {
            combinedPem: this.combinedPemFile,
            javaPkcs12: this.javaPkcs12File,
            javaPkcs12Password: JAVA_TRUST_STORE_PASSWORD,
        };
    }
}

async function readHostCaBundle(environment: NodeJS.ProcessEnv | undefined): Promise<string> {
    const environmentCandidates = clientTrustPemEnvironmentVariables().flatMap((variable) => [
        environment?.[variable],
        process.env[variable],
    ]);
    const candidates = [...environmentCandidates, ...SYSTEM_CA_BUNDLE_CANDIDATES];
    const loadedPaths = new Set<string>();
    const bundles: string[] = [];
    for (const candidate of candidates) {
        if (!candidate) continue;
        try {
            const resolved = await realpath(candidate);
            if (loadedPaths.has(resolved)) continue;
            const contents = await readFile(resolved, "utf8");
            if (!contents.includes("-----BEGIN CERTIFICATE-----")) continue;
            loadedPaths.add(resolved);
            bundles.push(contents);
        } catch {
            // Try the next configured or system trust-bundle location.
        }
    }
    if (bundles.length === 0) throw new Error("network sandbox could not locate a host CA bundle");
    return combineCaBundles(...bundles);
}

async function resolveSystemCaBundleDestinations(): Promise<string[]> {
    const destinations = new Set<string>();
    await Promise.all(SYSTEM_CA_BUNDLE_CANDIDATES.map(async (candidate) => {
        try {
            const destination = await realpath(candidate);
            if ((await stat(destination)).isFile()) destinations.add(destination);
        } catch {
            // The host does not use this trust-bundle convention.
        }
    }));
    return [...destinations].sort();
}

function combineCaBundles(...bundles: Array<string | undefined>): string {
    const certificates = new Map<string, string>();
    for (const bundle of bundles) {
        for (const certificate of bundle?.match(CERTIFICATE_PATTERN) ?? []) {
            const normalized = certificate.replace(/-----[^-]+-----|\s/g, "");
            certificates.set(normalized, certificate.trim());
        }
    }
    if (certificates.size === 0) throw new Error("client trust bundle contains no PEM certificates");
    return `${[...certificates.values()].join("\n")}\n`;
}
