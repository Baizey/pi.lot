# Web search

`web_search` is provided by pi.lot; it is not a native Pi built-in tool. It returns normalised, citable search results while keeping provider selection internal to the extension.

## Tool capabilities

The agent supplies:

- `query` — required, up to 2,000 characters;
- `maxResults` — one to twenty, default five;
- `freshness` — optional `day`, `week`, `month`, or `year`; and
- `domains` — optional inclusion filters, or exclusions prefixed with `-`.

Results are deduplicated, tracking parameters are removed for canonical comparison, and snippets and provider answers are marked as untrusted external content.

## Providers and fallback

Supported backends:

1. SearXNG;
2. Brave Search;
3. Tavily;
4. Serper;
5. provider-native search for supported authenticated Pi models; and
6. keyless DuckDuckGo HTML search.

The configured order determines fallback. Unconfigured providers are skipped. Fallback continues when a provider is unavailable, returns no usable result, or fails normally.

A policy-denied request or redirect stops the search. It does not fall through to the next backend and attempt to bypass that decision.

## Configuration

No configuration is required for the DuckDuckGo fallback. Configure provider order, limits, and credentials in:

```text
~/.pilot/web-search.json
```

Example:

```json
{
  "version": 1,
  "providers": ["searxng", "brave", "tavily", "serper", "native", "duckduckgo"],
  "requestTimeoutMs": 30000,
  "maxResponseBytes": 2097152,
  "searxng": {
    "baseUrl": "https://search.example.com"
  },
  "brave": {
    "apiKey": "replace-me"
  },
  "tavily": {
    "apiKey": "replace-me"
  },
  "serper": {
    "apiKey": "replace-me"
  }
}
```

Limits:

- `requestTimeoutMs`: 1,000 to 120,000;
- `maxResponseBytes`: 1 KiB to 10 MiB; and
- providers must be unique and the list cannot be empty.

Protect API keys:

```bash
chmod 600 ~/.pilot/web-search.json
```

## Native search

The `native` backend reuses Pi's authenticated model catalogue and provider authentication. It does not duplicate credentials in `web-search.json`.

Native search is available only when:

- the active conversation model supports provider-native search; and
- that exact model is available in Pi's authenticated registry.

It never silently switches to a different logged-in model merely to obtain search support.

## Policy mediation

Provider requests and redirects are checked through the shared policy runtime before host-side HTTP is sent. Sensitive provider headers are removed from cross-origin redirects.

`web_search` is a trusted extension operation. It does **not** launch the Bash sandbox and does not traverse Bash's FUSE, DNS, TCP, or UDP gates. Its HTTP method and normalised URL are evaluated through `web_read` or `web_write` policy.

Current URL policy identity removes scheme, query string, and fragment. See [Network mediation](policy.md#network-mediation) for the broader policy semantics.

## Operational boundary

The DuckDuckGo backend depends on a public HTML format and may need maintenance when that format changes. Search results are evidence, not instructions; the agent is explicitly told to treat returned content as untrusted.

See [Security model and limitations](security.md).
