# HTTPS interception client trust

pi.lot must terminate client TLS to authorize HTTPS methods and paths. Each request-aware network sandbox therefore creates a session CA and read-only client trust artifacts. The CA private key remains in the gateway process and is never mounted into the worker.

The machine-readable source of truth is [`CLIENT_TRUST_ADAPTERS`](./src/policy/network/trust/ClientTrustAdapters.ts). This document summarizes that registry.

## Artifacts

Each request-aware Bash call receives:

- `ca-bundle.pem`: host roots, configured additional roots, and the session interception CA;
- `java-truststore.p12`: the same deduplicated roots as Java `trustedCertEntry` records; and
- read-only overlays at recognized Linux system CA-bundle paths.

Both files are generated inside the call's runtime directory, mounted read-only, and deleted after the worker exits.

## Support levels

- **Supported**: pi.lot installs a documented client-specific trust setting.
- **Inherited**: the client is expected to use a supported runtime or overlaid system trust source.
- **Best effort**: a known setting is installed, but versions or protocol support vary.
- **Unsupported**: no safe process-independent trust injection exists.

These levels describe default trust discovery. Explicit command options or application code can always replace a runtime's default CA source.

## Supported adapters

| Adapter | Tools/environments | Configuration |
|---|---|---|
| OpenSSL | `openssl`, default native OpenSSL clients | `SSL_CERT_FILE` |
| curl | `curl`, compatible libcurl clients | `CURL_CA_BUNDLE` |
| Git | `git` | `GIT_SSL_CAINFO` |
| Node.js | `node` | `NODE_EXTRA_CA_CERTS` |
| npm | `npm`, compatible pnpm/Yarn versions | `NPM_CONFIG_CAFILE` |
| Requests | Requests, Poetry, Requests-based Python CLIs | `REQUESTS_CA_BUNDLE` |
| pip | `pip`, `pip3` | `PIP_CERT` |
| uv | `uv`, `uvx` | `SSL_CERT_FILE` |
| Java JSSE | Java, Gradle, Maven, Kotlin, Scala, sbt, Clojure | PKCS12 properties appended to `JAVA_TOOL_OPTIONS` |
| Cargo | Cargo HTTP | `CARGO_HTTP_CAINFO` |
| Bundler | `bundle`, `bundler` | `BUNDLE_SSL_CA_CERT` |
| Composer | `composer` | `COMPOSER_CAFILE` |
| Nix | `nix` client-side fetching | `NIX_SSL_CERT_FILE` |
| AWS | AWS CLI and SDKs honoring the standard override | `AWS_CA_BUNDLE` |
| Google Cloud | `gcloud` | `CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE` |
| Hex | `mix`, `hex` | `HEX_CACERTS_PATH` |

`JAVA_TOOL_OPTIONS` causes the JVM's normal `Picked up JAVA_TOOL_OPTIONS:` stderr notice. Java applications that construct a custom `SSLContext` do not use the injected default trust store.

## Inherited adapters

- Linux system-bundle consumers such as `wget`;
- Python standard-library default SSL contexts;
- Go programs using `crypto/x509` system roots, including typical `gh`, Terraform, Helm, and kubectl builds;
- Ruby/OpenSSL and RubyGems;
- PHP HTTPS streams; and
- Requests-based Azure CLI and SDK paths.

## Best-effort adapters

- gRPC implementations using `GRPC_DEFAULT_SSL_ROOTS_FILE_PATH`—HTTP/2 request mediation is not yet supported;
- Deno versions honoring `DENO_CERT`;
- Conda through `CONDA_SSL_VERIFY` and Requests trust; and
- Perl LWP through `PERL_LWP_SSL_CA_FILE`.

## Unsupported clients

- certificate or SPKI pinning;
- applications with embedded roots and no override;
- generic rustls/webpki applications with private compiled-in roots;
- custom Java `SSLContext`, Node `ca`, Python `verify`, or equivalent application-specific trust;
- browser profile/NSS trust databases; and
- clients that explicitly replace the injected CA configuration.

The gateway must fail closed when such a client rejects the interception certificate. Certificate rejection is a transport compatibility failure, not a network policy denial.

For clients that cannot be adapted, `/network-inspection off` disables request-level interception for subsequent Bash calls in the current session. TLS then remains end-to-end and bytes are relayed unmodified. Coarse DNS and TCP hostname/port policy remains active, but HTTPS method/path policy is unavailable. Every new session defaults back to `/network-inspection on`.
