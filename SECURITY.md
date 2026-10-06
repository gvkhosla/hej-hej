# Security

This is an experimental, single-owner, self-hosted assistant—not a hardened multi-tenant service. Don't connect a shared/public Pi demo to Gmail.

## Trust boundaries

- Admin and bridge tokens must be distinct, random, at least 32 characters, sent only over HTTPS. The bridge token can admit/read the owner's iMessage work, but cannot configure Gmail or read WhatsApp/API results. Protect it accordingly.
- WhatsApp POST authentication verifies HMAC over the raw body, then filters the configured business, phone and owner IDs. The verification token is only for the initial challenge.
- Gmail uses only readonly OAuth, PKCE, expiring one-use state and an exact configured-owner profile check. Access/refresh tokens and the PKCE verifier are encrypted with AES-GCM in durable storage, and never returned to the model.
- Keep TOKEN_KEY in Worker secrets. Losing it makes stored credentials unusable; changing it requires deleting old credentials and reconnecting. Also protect ADMIN_TOKEN: an admin can read retained private responses, initiate OAuth, retry deliveries or reset all data.
- Tools have no arbitrary shell, filesystem, attachment, Gmail-write or recipient capability.
- Tavily receives only the explicit owner /research topic. It extracts only result URLs from that request. HTTPS/DNS validation rejects literal/local hosts; the provider, not this Worker, resolves and fetches pages. This is not a guarantee about DNS rebinding or provider-side redirect policy. Don't trust a third-party extraction provider with private URLs.
- Source text is labeled untrusted. Prompt instructions are mitigation, not a guarantee against prompt injection. A model may still produce misleading answers or disclose email to the owner. Don't grant it more permissions based on this prompt.
- One request per context, persistent tool/generation quotas, bounded pages/bodies, a daily admission quota and request deadlines limit abuse. Deadlines depend on Durable Object alarms; platform outages can delay cancellation.
- Attempt-before-send markers prevent silent automatic retries of uncertain external sends. They don't provide exactly-once transport or prove delivery.
- The Mac bridge reads only permitted text from a read-only Messages database, sends using AppleScript argv, skips old history, and ignores groups/attachments/self messages. Use a dedicated account and macOS user. Anyone controlling that user, Full Disk Access or the bridge bearer token can access sensitive material.

## Privacy and deletion

Gmail excerpts, prompts, replies and transcripts are retained in Cloudflare SQLite. Selected material is processed by Workers AI; explicit public topics and selected public pages are processed by Tavily. Messages also pass through Apple or Meta depending on channel. Cloudflare platform logs may capture operational metadata; application observability is disabled and errors are sanitized, but operators should review their platform logging settings.

The public repository contains code and examples only. Keep secrets, .dev.vars, .env files, Messages databases, bridge state and transcripts out of version control.

DELETE /v1/gmail removes stored credentials but does not revoke the Google grant or remove old excerpts. Revoke the app in Google Account settings. DELETE /v1/messages/:id removes only a receipt. POST /v1/reset removes all durable data and credentials; stop ingress and resolve/delete pending deliveries first. Delete Mac state separately. Cloudflare/provider backup, legal retention and deletion policies remain outside this app's control.

## Reporting

Please report vulnerabilities privately via [GitHub's security reporting](https://github.com/gvkhosla/hej-hej/security/advisories/new), if enabled, rather than posting credentials or private messages in a public issue. If private reporting is unavailable, open a minimal issue requesting a private contact, without exploit details or user data.

## Release validation

Automated tests use a faux model and mocked Google/Meta/Tavily HTTP responses plus a synthetic Messages database. A Wrangler dry run verifies bundling, not real provider/account delivery. Live Gmail consent, WhatsApp business provisioning and macOS permissions require owner setup and explicit real-account smoke tests.
