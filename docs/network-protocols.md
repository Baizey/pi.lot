# Service protocol admission

[Policy system](policy.md#application-protocol-admission) · [Security boundaries](security.md)

The Bash TCP gateway recognizes the following initial wire envelopes on arbitrary destination ports. Each requires its own protocol permission **in addition to transport admission**. New protocol areas default to `ask_user`, including when older saved defaults omit them.

This is **channel admission**, not query, command, authentication, or content policy. An approval permits the resulting channel and its opaque continuation, including in-band encryption. It does not limit database users, keys, topics, shares, remote paths, directory entries, mailboxes, or tunneled applications.

## Admission contract

- A client-first connection requires a complete supported initial envelope before protocol approval. After approval, the gateway connects to the already-approved upstream address, sends only that envelope, and confirms its response before releasing queued client operations.
- **The approved first request can already have effects.** Response validation cannot undo it. A framed authentication failure is not proof of successful login, and admission is not authentication.
- A server-first connection may establish an already-transport-approved upstream connection to obtain a greeting. No application greeting or queued client data is released until protocol approval.
- Endpoint pinning and TLS identity checks remain in force. Client SNI and advertised broker/topology/referral addresses do not authorize new destinations. Each new connection gets its own applicable checks.
- Classification and confirmation examine at most **65,539 bytes per initial envelope**. Confirmation has a **five-second** budget after protocol approval and upstream connection. Fragmentation and coalesced continuation are preserved; malformed, oversized, contradictory, and unsupported envelopes fail closed with full inspection enabled.
- Terminal messages do not admit continuation. PostgreSQL cancellation sends exactly the validated request, then closes both channels without forwarding server bytes. An NFS RPC rejection is returned to the client, then both channels close; a server saying that it does not export NFS cannot unlock other RPC programs.
- A client reset may not be observed immediately while unread input is backpressured in a paused socket. Detected disconnects cancel pending work; broker shutdown always destroys tracked sockets. This is not a guarantee of instantaneous cancellation or revocation of already-admitted effects.

## Supported initial modes

| Protocol / policy area | Supported admission | Important exclusions |
| --- | --- | --- |
| PostgreSQL — `web_postgres` | UTF-8 protocol-3.0 StartupMessage, SSLRequest, GSSENCRequest; framed initial authentication/error/option-negotiation; terminal 16-byte CancelRequest | Other startup protocol versions, including 3.2, newer variable-length cancellation formats, and direct-TLS `postgresql` ALPN are not recognized. |
| MySQL/MariaDB — `web_mysql` | Server-first protocol-10, protocol-4.1 secure-connection greeting, with or without plugin authentication; MariaDB extended capability bytes | Old short greetings and pre-4.1 handshakes are unsupported. Native SSLRequest upgrades remain end-to-end after channel admission. |
| Redis — `web_redis` | RESP array-of-bulk-string commands and bounded fixed-length RESP2/RESP3 replies, including attributes; additional confirmation described below | Inline commands, streamed aggregates/strings, unsolicited server-first recognition, and initial modes preventing confirmation are unsupported. |
| MongoDB — `web_mongodb` | Uncompressed OP_MSG commands with `$db`, document sequences, optional CRC-32C; direct legacy OP_QUERY `hello`/`isMaster` and correlated OP_REPLY | OP_COMPRESSED, arbitrary legacy queries, `$query`-wrapped hello, and no-reply `moreToCome` initial requests are unsupported. |
| MQTT — `web_mqtt` | CONNECT 3.1, 3.1.1, and 5.0; version/context-checked CONNACK or a correlated MQTT5 enhanced-authentication challenge | Not arbitrary MQTT packets as a connection's first envelope. Confirmation does not establish successful authentication. |
| AMQP — `web_amqp` | AMQP 0-9-1 header and bounded `connection.start`; AMQP 1.0 and SASL protocol-header exchange | Other protocol revisions and arbitrary initial frame streams are unsupported. Later SASL/frame traffic is channel continuation. |
| Kafka — `web_kafka` | ApiVersions v0–v4, including flexible v3/v4 tags; Metadata v0–v1; SaslHandshake v0–v1; framed, correlation-checked replies | Other first APIs/versions are unsupported. Subsequent negotiated APIs are opaque continuation. |
| NATS — `web_nats` | Server-first, single-line, case-insensitive INFO with bounded valid JSON and server identity/version/endpoint fields | Generic INFO JSON, embedded raw line breaks, and greetings missing required server fields are unsupported. |
| FTP/FTPS control — `web_ftp` | Identifying ASCII 220 single/multiline greeting; includes vsFTPd, ProFTPD, Pure-FTPd and canonical FileZilla banners; explicit AUTH TLS continuation | **Control only.** Data transfers/listings need separate data connections, which are not implemented here. Generic 220 and nonidentifying banners fail closed. |
| SMB — `web_smb` | Direct-TCP SMB 2.0.2–3.1.1 NEGOTIATE, including 3.1.1 preauthentication contexts; message-ID/offered-dialect-correlated reply | SMB1, SMB1-wrapped negotiation, NetBIOS session service, or transform packets as the initial envelope are unsupported. Negotiated signing/encryption is opaque continuation. |
| NFS — `web_nfs` | Single-fragment ONC RPC TCP record for NFS program 100003 v3/v4, bounded authentication, XID correlation, and v4 COMPOUND tag correlation | **TCP only.** Initial multi-fragment records, RPC-over-UDP, rpcbind, mountd, NFSv2, and other RPC programs are unsupported by this application parser. |
| LDAP — `web_ldap` | LDAPv3 definite-length BER simple/SASL Bind, Search, StartTLS; correlated initial response and bounded filter/control structure | LDAPv2, indefinite BER, and unrelated extended operations as the initial envelope are unsupported. Referrals do not grant endpoint access. |
| IMAP — `web_imap` | Identifying ASCII `* OK` or `* PREAUTH`, including CAPABILITY/IMAP4rev1/IMAP4rev2, Exchange IMAP4, and Gmail Gimap greetings | Generic nonidentifying banners are unsupported. STARTTLS and subsequent mailbox operations are channel continuation. |
| POP3 — `web_pop3` | Identifying ASCII `+OK` greeting containing POP3 evidence or exact conventional `+OK Dovecot ready.` | Bare/generic `+OK` and other ambiguous Redis-style replies are not inferred to be POP3. STLS and subsequent mailbox operations are channel continuation. |

RESP/BSON nesting is capped at 32, with a 4,096-item parsing budget; Redis requests allow at most 4,096 arguments. LDAP search-filter nesting is capped at 32. These are compatibility limits even when a larger message would otherwise be valid.

### Redis and ambiguous POP3 replies

RESP simple strings/errors overlap POP3 greetings. In particular, `+OK` or `-ERR` alone cannot establish a Redis channel. After the specifically approved initial request and its reply, ambiguous simple/error replies require an additional **cryptographically random nonce PING** round trip. The gateway consumes that private exchange rather than exposing it to the client. Distinctive RESP framing and exact `+PONG` for an initial zero-argument PING need no extra challenge.

When authentication is required, the first request must already authenticate, and PING must be ACL-permitted. Authentication queued behind another request cannot satisfy this requirement. Initial transaction/monitor modes, or intervening pubsub pushes that prevent the exact nonce reply, fail closed. A Redis-compatible server can still carry arbitrary traffic after admission; the challenge prevents confusing ordinary POP3 greetings with Redis, not intentional protocol impersonation by an approved peer.

## TLS scope

Implicit TLS is supported through the existing inspected-TLS gateway **when no incompatible application-specific ALPN is required**. After TLS termination without negotiated HTTP ALPN, the same application-envelope checks apply, and upstream certificates are verified against the pinned logical identity. This supports identifying implicit FTPS, LDAPS, IMAPS, and POP3S greetings/requests under those conditions; it is not support for every deployment or trust configuration.

PostgreSQL direct-TLS ALPN and MQTT/AMQP deployments requiring dedicated ALPN are not currently negotiated. Native PostgreSQL SSL/GSS, MySQL TLS, FTP AUTH TLS, LDAP StartTLS, IMAP STARTTLS, POP3 STLS, and NATS encryption upgrades continue end-to-end inside an approved channel; their certificate verification is the client's responsibility.

With inspection off, recognized supported **plaintext** channels still require their protocol approval. Opaque TLS and unrecognized plaintext may receive transport-only forwarding. Turning inspection off does not add protocol-aware support and does not disable DNS mediation.

## Incomplete protocol-family support

### FTP data connections

A control grant must not authorize arbitrary ports advertised by an FTP peer. Passive data support needs bounded control-reply parsing, short-lived endpoint correlation, same-peer/anti-bounce checks, independent transport/protocol admission, and cancellation/expiry ownership. Active mode additionally needs inbound/reverse-connection handling. Encrypted control needs a deliberate termination/inspection design before endpoints can be correlated. These are not implemented by greeting recognition; full FTP file transfer is still incomplete.

### NFS auxiliary transports

NFS-over-UDP currently receives generic UDP flow policy, **not `web_nfs` application inspection**. rpcbind and mountd are distinct programs/endpoints and do not inherit NFS approval. Supporting them needs explicit RPC program/endpoint handling and bounded datagram/XID validation. Actual OS mounting also depends on the worker's capabilities and filesystem isolation; TCP admission does not grant mount privileges.

## Implementation and validation

- `src/policy/network/ChannelProtocol.ts`: parser and confirmation contract.
- `src/policy/network/ChannelProtocols.ts`: protocol registry and ambiguity handling.
- `src/policy/network/ChannelHandshake.ts`: bounded stream reads, confirmation, and terminal requests.
- `src/policy/network/DatabaseProtocols.ts`, `MessagingProtocols.ts`, `FileMailProtocols.ts`: supported wire envelopes and specification references.
- `test/*-protocols.test.ts`, `channel-classification.test.ts`, `channel-handshake.test.ts`: malformed fields, lengths, correlation, every valid fixture prefix, bounds, and cleanup.
- `test/tcp-gateway-channels.test.ts`, `tcp-gateway-channel-security.test.ts`: real in-process TCP/TLS admission, denial, deferred approvals, byte preservation, spoofing regressions, and cancellation.
- `test/protocol-client-compatibility.test.ts`: optional installed MariaDB, Samba, and LDAP client initial-handshake checks against disposable local fixtures. They are not full real-server interoperability tests.

Independent reviews cover ADB and each new protocol family. This is engineering review, not an independent security audit or proof of complete interoperability. Run mounted/native integration on a prepared host, not inside another sandbox. Restart Pi after updating the extension so new policy areas and parsers are loaded.
