export enum ClientTrustArtifactKind {
    COMBINED_PEM = "combined-pem",
    JAVA_PKCS12 = "java-pkcs12",
}

export enum ClientTrustSupportLevel {
    SUPPORTED = "supported",
    INHERITED = "inherited",
    BEST_EFFORT = "best-effort",
    UNSUPPORTED = "unsupported",
}

export type ClientTrustArtifactPaths = {
    combinedPem: string;
    javaPkcs12: string;
    javaPkcs12Password: string;
};

export type ClientTrustEnvironmentBinding =
    | {
        kind: "artifact-path";
        variable: string;
        artifact: ClientTrustArtifactKind;
    }
    | {
        kind: "java-system-properties";
        variable: "JAVA_TOOL_OPTIONS";
        artifact: ClientTrustArtifactKind.JAVA_PKCS12;
    };

export type ClientTrustAdapter = {
    id: string;
    tools: readonly string[];
    support: ClientTrustSupportLevel;
    bindings: readonly ClientTrustEnvironmentBinding[];
    limitations: readonly string[];
};

const combinedPem = (variable: string): ClientTrustEnvironmentBinding => ({
    kind: "artifact-path",
    variable,
    artifact: ClientTrustArtifactKind.COMBINED_PEM,
});

export const CLIENT_TRUST_ADAPTERS = [
    {
        id: "system-openssl",
        tools: ["openssl", "native OpenSSL clients"],
        support: ClientTrustSupportLevel.SUPPORTED,
        bindings: [combinedPem("SSL_CERT_FILE")],
        limitations: ["Applications that configure an explicit CA source bypass OpenSSL defaults."],
    },
    {
        id: "system-ca-bundle",
        tools: ["wget", "native system-trust clients"],
        support: ClientTrustSupportLevel.INHERITED,
        bindings: [],
        limitations: ["Only known Linux CA bundle files are overlaid; private trust databases are not changed."],
    },
    {
        id: "curl",
        tools: ["curl", "libcurl clients honoring curl environment settings"],
        support: ClientTrustSupportLevel.SUPPORTED,
        bindings: [combinedPem("CURL_CA_BUNDLE")],
        limitations: ["An explicit --cacert or application-level libcurl configuration can override this setting."],
    },
    {
        id: "git",
        tools: ["git"],
        support: ClientTrustSupportLevel.SUPPORTED,
        bindings: [combinedPem("GIT_SSL_CAINFO")],
        limitations: ["Repository or command-level TLS configuration can select another CA file."],
    },
    {
        id: "node",
        tools: ["node"],
        support: ClientTrustSupportLevel.SUPPORTED,
        bindings: [combinedPem("NODE_EXTRA_CA_CERTS")],
        limitations: ["Node reads NODE_EXTRA_CA_CERTS at process startup and ignores it when code supplies an explicit ca option."],
    },
    {
        id: "npm",
        tools: ["npm", "pnpm", "Yarn Classic"],
        support: ClientTrustSupportLevel.SUPPORTED,
        bindings: [combinedPem("NPM_CONFIG_CAFILE")],
        limitations: ["Package managers may override npm-compatible configuration or supply their own TLS agent."],
    },
    {
        id: "python-stdlib",
        tools: ["python urllib", "Python default SSL contexts"],
        support: ClientTrustSupportLevel.INHERITED,
        bindings: [combinedPem("SSL_CERT_FILE")],
        limitations: ["Custom SSLContext instances can replace the default trust roots."],
    },
    {
        id: "python-requests",
        tools: ["requests", "Poetry", "Python CLIs built on Requests"],
        support: ClientTrustSupportLevel.SUPPORTED,
        bindings: [combinedPem("REQUESTS_CA_BUNDLE")],
        limitations: ["An explicit verify path or custom transport adapter overrides environment trust."],
    },
    {
        id: "pip",
        tools: ["pip", "pip3"],
        support: ClientTrustSupportLevel.SUPPORTED,
        bindings: [combinedPem("PIP_CERT")],
        limitations: ["An explicit --cert option can select another bundle."],
    },
    {
        id: "uv",
        tools: ["uv", "uvx"],
        support: ClientTrustSupportLevel.SUPPORTED,
        bindings: [combinedPem("SSL_CERT_FILE")],
        limitations: ["Behavior can differ when a command explicitly selects native or bundled TLS roots."],
    },
    {
        id: "java-jsse",
        tools: ["java", "Gradle", "Maven", "Kotlin", "Scala", "sbt", "Clojure"],
        support: ClientTrustSupportLevel.SUPPORTED,
        bindings: [{
            kind: "java-system-properties",
            variable: "JAVA_TOOL_OPTIONS",
            artifact: ClientTrustArtifactKind.JAVA_PKCS12,
        }],
        limitations: [
            "JAVA_TOOL_OPTIONS produces a JVM startup notice on stderr.",
            "Applications that construct a custom SSLContext can ignore the default JSSE trust store.",
        ],
    },
    {
        id: "go-system-roots",
        tools: ["go", "gh", "Terraform", "Helm", "kubectl", "Go binaries using crypto/x509 system roots"],
        support: ClientTrustSupportLevel.INHERITED,
        bindings: [combinedPem("SSL_CERT_FILE")],
        limitations: ["Applications with an explicit RootCAs pool do not use Go system roots."],
    },
    {
        id: "cargo",
        tools: ["cargo"],
        support: ClientTrustSupportLevel.SUPPORTED,
        bindings: [combinedPem("CARGO_HTTP_CAINFO")],
        limitations: ["This configures Cargo HTTP only, not arbitrary Rust applications using rustls or webpki roots."],
    },
    {
        id: "ruby-openssl",
        tools: ["ruby", "RubyGems"],
        support: ClientTrustSupportLevel.INHERITED,
        bindings: [combinedPem("SSL_CERT_FILE")],
        limitations: ["Ruby code can replace the OpenSSL certificate store."],
    },
    {
        id: "bundler",
        tools: ["bundle", "bundler"],
        support: ClientTrustSupportLevel.SUPPORTED,
        bindings: [combinedPem("BUNDLE_SSL_CA_CERT")],
        limitations: ["Project Bundler configuration can select another certificate source."],
    },
    {
        id: "php-openssl",
        tools: ["php HTTPS streams"],
        support: ClientTrustSupportLevel.INHERITED,
        bindings: [combinedPem("SSL_CERT_FILE")],
        limitations: ["php.ini or stream context options can select another CA file."],
    },
    {
        id: "composer",
        tools: ["composer"],
        support: ClientTrustSupportLevel.SUPPORTED,
        bindings: [combinedPem("COMPOSER_CAFILE")],
        limitations: ["Composer or PHP configuration can select another CA source."],
    },
    {
        id: "nix",
        tools: ["nix"],
        support: ClientTrustSupportLevel.SUPPORTED,
        bindings: [combinedPem("NIX_SSL_CERT_FILE")],
        limitations: ["Fetches delegated to a host daemon are outside the worker's trust environment."],
    },
    {
        id: "aws",
        tools: ["AWS CLI", "AWS SDKs honoring AWS_CA_BUNDLE"],
        support: ClientTrustSupportLevel.SUPPORTED,
        bindings: [combinedPem("AWS_CA_BUNDLE")],
        limitations: ["Individual SDK transports can use an explicitly configured CA bundle."],
    },
    {
        id: "google-cloud",
        tools: ["gcloud"],
        support: ClientTrustSupportLevel.SUPPORTED,
        bindings: [combinedPem("CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE")],
        limitations: ["Components not using the Cloud SDK HTTP transport can choose another trust source."],
    },
    {
        id: "azure-cli",
        tools: ["az", "Python Azure SDK clients using Requests"],
        support: ClientTrustSupportLevel.INHERITED,
        bindings: [combinedPem("REQUESTS_CA_BUNDLE")],
        limitations: ["Non-Python Azure SDK transports may not use Requests environment settings."],
    },
    {
        id: "elixir-hex",
        tools: ["mix", "hex"],
        support: ClientTrustSupportLevel.SUPPORTED,
        bindings: [combinedPem("HEX_CACERTS_PATH")],
        limitations: ["Custom Erlang TLS options can replace Hex's CA path."],
    },
    {
        id: "grpc",
        tools: ["gRPC implementations honoring GRPC_DEFAULT_SSL_ROOTS_FILE_PATH"],
        support: ClientTrustSupportLevel.BEST_EFFORT,
        bindings: [combinedPem("GRPC_DEFAULT_SSL_ROOTS_FILE_PATH")],
        limitations: ["The request-aware gateway does not yet inspect HTTP/2, so CA trust alone does not provide gRPC support."],
    },
    {
        id: "deno",
        tools: ["deno"],
        support: ClientTrustSupportLevel.BEST_EFFORT,
        bindings: [combinedPem("DENO_CERT")],
        limitations: ["DENO_CERT behavior is version-dependent and explicit command options can replace it."],
    },
    {
        id: "conda",
        tools: ["conda"],
        support: ClientTrustSupportLevel.BEST_EFFORT,
        bindings: [combinedPem("CONDA_SSL_VERIFY"), combinedPem("REQUESTS_CA_BUNDLE")],
        limitations: ["Conda configuration can override the environment value."],
    },
    {
        id: "perl-lwp",
        tools: ["Perl LWP"],
        support: ClientTrustSupportLevel.BEST_EFFORT,
        bindings: [combinedPem("PERL_LWP_SSL_CA_FILE")],
        limitations: ["Other Perl TLS stacks use different trust configuration."],
    },
    {
        id: "private-or-pinned-trust",
        tools: ["certificate-pinned clients", "custom trust stores", "generic rustls/webpki applications", "browser private stores"],
        support: ClientTrustSupportLevel.UNSUPPORTED,
        bindings: [],
        limitations: ["No process-independent trust injection can override private roots or certificate pinning safely."],
    },
] as const satisfies readonly ClientTrustAdapter[];

export function clientTrustPemEnvironmentVariables(): string[] {
    return [...new Set(CLIENT_TRUST_ADAPTERS.flatMap((adapter) => (
        adapter.bindings
            .filter((binding) => (
                binding.kind === "artifact-path"
                && binding.artifact === ClientTrustArtifactKind.COMBINED_PEM
            ))
            .map(({variable}) => variable)
    )))].sort();
}

export function applyClientTrustAdapters(
    environment: NodeJS.ProcessEnv,
    artifacts: ClientTrustArtifactPaths,
): NodeJS.ProcessEnv {
    const result = {...environment};
    const installedBindings = new Map<string, string>();
    for (const adapter of CLIENT_TRUST_ADAPTERS) {
        if (adapter.support === ClientTrustSupportLevel.UNSUPPORTED) continue;
        for (const binding of adapter.bindings) {
            const bindingIdentity = `${binding.kind}\0${binding.artifact}`;
            const existingBinding = installedBindings.get(binding.variable);
            if (existingBinding === bindingIdentity) continue;
            if (existingBinding !== undefined) {
                throw new Error(`client trust adapters conflict on ${binding.variable}`);
            }
            installedBindings.set(binding.variable, bindingIdentity);
            if (binding.kind === "artifact-path") {
                result[binding.variable] = artifactPath(binding.artifact, artifacts);
            } else {
                const options = [
                    `-Djavax.net.ssl.trustStore=${artifacts.javaPkcs12}`,
                    "-Djavax.net.ssl.trustStoreType=PKCS12",
                    `-Djavax.net.ssl.trustStorePassword=${artifacts.javaPkcs12Password}`,
                ].map(quoteJavaToolOption).join(" ");
                const existing = result[binding.variable]?.trim();
                result[binding.variable] = existing ? `${existing} ${options}` : options;
            }
        }
    }
    return result;
}

function artifactPath(
    artifact: ClientTrustArtifactKind,
    artifacts: ClientTrustArtifactPaths,
): string {
    switch (artifact) {
        case ClientTrustArtifactKind.COMBINED_PEM:
            return artifacts.combinedPem;
        case ClientTrustArtifactKind.JAVA_PKCS12:
            return artifacts.javaPkcs12;
    }
}

function quoteJavaToolOption(option: string): string {
    if (!/[\s"\\]/.test(option)) return option;
    return `"${option.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}
