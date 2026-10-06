# Pi Assistant

A small, self-hosted personal assistant you text through **Apple Messages (iMessage)** or **WhatsApp**. Powered by **Pi Durable**.

Ask it to read your Gmail, summarize a conversation, draft a reply for you to copy, or research a public topic with sources. No dashboard, email sending, or autonomous outreach.

> **v0.1.0:** single-owner, self-hosted software. Gmail, WhatsApp and iMessage need your own account setup. Automated tests use a fake model and mocked providers; they are not proof of live account connectivity.

## What works

- iMessage input and replies through a local, read-only Mac Messages bridge.
- Official WhatsApp Cloud API: signed webhooks, owner allowlist, text replies.
- Gmail search and plain-text message reading via **readonly OAuth**.
- Public web search and source reading through Tavily.
- Durable Pi generation, inbound deduplication and a persisted delivery outbox.
- Authenticated JSON API for setup, message status and manual recovery.

Example messages:

```text
Find the latest email from Alex and summarize what I owe them.
Draft a short reply saying Thursday works. Don't send it.
/research best lightweight CRMs for a two-person consulting company
```

Each request starts fresh; include the context you need. Drafts are reply text, **not** saved Gmail drafts. Web research requires an explicit `/research <public topic>` message (400 characters max). That topic is sent verbatim to Tavily: the model cannot silently turn private email into a web query.

## Architecture

```text
iMessage ←→ Mac bridge ─┐
WhatsApp ←→ Cloud API ─┼→ authenticated Worker → owner Durable Object → Pi Durable
JSON API ──────────────┘                              ├→ Gmail (readonly)
                                                     └→ Tavily (public sources)
```

The Worker acknowledges admission without waiting for the model. Lifecycle alarms resume the app queue/outbox; Pi handles generation recovery. One request runs at a time, with a fresh Pi session. Replies go only to the configured owner.

**Delivery is not exactly once.** An HTTP or AppleScript timeout might mean a message was sent. We persist an attempt marker before sending and never automatically resend an uncertain attempt. An admin can explicitly retry, accepting duplicate risk. WhatsApp `sent` means the API accepted it; iMessage `sent` means AppleScript returned successfully. Neither means the recipient read it.

## Quick start: backend

Use Node 24 LTS (bridge minimum: Node 22.13), a Cloudflare account, and your own Google/Meta/Tavily credentials. Cloudflare AI and Tavily may incur usage charges.

```sh
git clone https://github.com/gvkhosla/pi-assistant.git
cd pi-assistant
npm ci
npm run check
npx wrangler login
```

1. Edit `wrangler.jsonc`: choose a unique Worker name, set `PUBLIC_URL` to its HTTPS origin and `OWNER_EMAIL` to the Gmail account you will connect. The bundled model is Workers AI Llama 3.3; `MODEL_ID` can be changed to a supported Workers AI chat/tool model.
2. Generate **distinct** admin and bridge tokens, each at least 32 characters, plus a 32-byte base64 encryption key. Use a password manager or `openssl rand -hex 32` (tokens) / `openssl rand -base64 32` (key). Store all three securely.
3. Add them as Worker secrets. Wrangler prompts for each value; never put real keys in the repo:

```sh
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put BRIDGE_TOKEN
npx wrangler secret put TOKEN_KEY
npm run deploy
```

For local development use a gitignored `.dev.vars` file, based on the Worker variables in `.env.example`, then `npm run dev`. Never set `TEST_MODE` on a real deployment. Tests have a separate config with **no AI binding** and require no Cloudflare login or provider keys.

```sh
export ASSISTANT_URL=https://YOUR-WORKER.workers.dev
# Export ADMIN_TOKEN privately, without pasting it into shared terminal history.
curl -H "Authorization: Bearer $ADMIN_TOKEN" "$ASSISTANT_URL/v1/status"
curl -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"id":"first-request","text":"Hello"}' "$ASSISTANT_URL/v1/messages"
# Poll GET /v1/messages/<returned-id> for status and response.
```

### Connect Gmail

1. In [Google Cloud Console](https://console.cloud.google.com/), enable the Gmail API, configure the OAuth consent screen, and add yourself as a test user if the app is in Testing.
2. Create a **Web application** OAuth client. Register exactly `https://YOUR-WORKER.workers.dev/oauth/google/callback` as an authorized redirect URI.
3. Configure `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` with `wrangler secret put`.
4. Authenticated `POST /oauth/google/start` returns a Google consent URL. Open it in a browser; sign in as the configured `OWNER_EMAIL` and approve **Gmail readonly**. The callback verifies that account and encrypts server-side tokens.

```sh
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" "$ASSISTANT_URL/oauth/google/start"
```

Gmail readonly is a restricted Google scope. Personal/testing apps can require periodic reconnects (external Testing refresh tokens generally expire after seven days); distributing a hosted app requires Google's verification and potentially further security review. This project is not a multi-user hosted service.

### Connect public research

Get a [Tavily API key](https://app.tavily.com/) and run `npx wrangler secret put TAVILY_API_KEY`. Send `/research <public topic>`. Gmail contents are not used as search queries. Only HTTPS URLs returned by that request's public search can be extracted; the Worker does not directly fetch user URLs.

### Connect WhatsApp

Use the [official Meta Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api/get-started), not a personal-account scraping library.

1. Create a Meta developer app with WhatsApp, and provision a test or business phone number.
2. Configure Worker secrets `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN` (a random setup token), `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`, `WHATSAPP_BUSINESS_ID` (WhatsApp Business Account ID) and `WHATSAPP_OWNER` (your numeric WhatsApp ID including country code, **no +**).
3. Add `https://YOUR-WORKER.workers.dev/webhooks/whatsapp` as the callback URL and use the same verification token. Subscribe the app to the business account and the **messages** field.
4. Add your own number as an allowed test recipient if using Meta's sandbox, then text the business number from that number.

The configured Graph version defaults to `v23.0`; choose a version supported by your Meta app. Dev tokens expire; production requires an appropriate long-lived/system-user token and business setup. The signature uses **App Secret**, not the verification token. Other senders, media, status notifications, business IDs and phone IDs are ignored. Responses must fit Meta's customer-service window; v1 refuses replies to messages older than 23 hours and does not send proactive templates.

### Connect Apple Messages

This needs an always-on **Mac**. For safety, use a **dedicated macOS user and assistant Apple Messages account**—not your everyday personal inbox. Sign into Messages there, and text it from a different, allowlisted owner account.

1. Grant the terminal/Node host **Full Disk Access** in System Settings → Privacy & Security so it can read `~/Library/Messages/chat.db`.
2. Grant **Automation → Messages** when macOS prompts during your first reply.
3. Get the dedicated Messages service ID:

```sh
osascript -e 'tell application "Messages" to get {id, name} of every service whose service type is iMessage'
```

4. Configure the bridge environment (bridge token only—**never the admin token**):

```sh
export ASSISTANT_URL=https://YOUR-WORKER.workers.dev
export IMESSAGE_OWNER='+15551234567'  # exact handle as recorded in Messages; email handles also work
export IMESSAGE_SERVICE_ID='YOUR-DEDICATED-SERVICE-ID'
# Export BRIDGE_TOKEN privately from your password manager.
npm run bridge
```

The first start skips history. Only **new, plain-text, one-to-one iMessages** from the configured handle are admitted; self messages, groups, attachments, reactions and SMS are excluded. The Messages database opens read-only. Replies use AppleScript with text passed as arguments, never interpolated into source.

Bridge state is stored privately in `~/.local/state/pi-assistant` (directory mode 700, files created under umask 077). Keep it on the Mac's local encrypted disk. A stale `bridge.lock` after a crash must be removed **only after verifying no bridge process is running**. On restart, uncertain local sends are acknowledged as unknown, not sent again. A lost server claim can leave `attempted` without a local record; inspect it using the admin API. If the Messages schema differs on your macOS version, the bridge fails closed.

This is local macOS automation, not an Apple-supported bot API. Real Mac permissions and actual account delivery must be tested on your machine.

## API and recovery

All `/v1/*` and `POST /oauth/google/start` require the admin bearer token. All `/bridge/*` require the separate bridge token. There is no CORS or public session endpoint.

| Endpoint                        | Purpose                                                                   |
| ------------------------------- | ------------------------------------------------------------------------- |
| `GET /health`                   | Public version/health only                                                |
| `GET /v1/status`                | Integration readiness; no credentials                                     |
| `POST /v1/messages`             | Admit `{"id":"stable-client-id","text":"..."}`                            |
| `GET /v1/messages`              | List delivery statuses                                                    |
| `GET /v1/messages/:id`          | Private request, response and delivery details                            |
| `POST /v1/messages/:id/retry`   | Manual channel retry; require `{"confirmDuplicateRisk":true}`             |
| `DELETE /v1/messages/:id`       | Delete a finished receipt, **not its Pi transcript**                      |
| `DELETE /v1/gmail`              | Delete local OAuth credentials; also revoke access in Google Account      |
| `POST /v1/reset`                | Destructive wipe of credentials, transcripts, receipts and dedupe history |
| `POST /bridge/inbox`            | Bridge-only inbound admission                                             |
| `GET /bridge/outbox`            | Bridge-only ready IDs                                                     |
| `POST /bridge/outbox/:id/claim` | Persist attempt before returning reply text                               |
| `POST /bridge/outbox/:id/ack`   | Acknowledge exact attempt, not stale delivery                             |

`queued → running → ready → attempted → sent / failed / unknown`. API replies stay `ready` for polling. `attempted` is uncertain if its sender crashed. Don't retry until you have inspected the channel and confirmed the original attempt isn't still running. Explicit retries can duplicate a reply; at most three send attempts are permitted per receipt.

Limits: 8,000 input characters, 3,800 reply characters, 50 new messages/day, 10 queued/running messages, 1,000 receipts, 8 generation attempts and 8 tool calls/request, 120-second request deadline. Gmail search returns at most 5 messages; web search at most 5 sources, source read at most 2. HTTP timeouts and response-size limits apply.

**Retention:** transcripts and read email excerpts remain in the owner's Durable Object until a full reset. Delete finished receipts to manage the receipt limit, and reset periodically to remove all history. Reset refuses active requests/unsettled channel replies. Stop channel ingress/bridge, inspect and delete remaining uncertain receipts, then reset. Reset also clears dedupe: old inbound IDs could be admitted again. Delete the Mac bridge's state separately if you want to wipe local queues.

## Development

```sh
npm ci
npm run fmt
npm run check
```

Tests cover authenticated admission, Pi faux generation, eviction recovery, OAuth/PKCE/token encryption, Gmail plaintext parsing, webhook filtering/signatures, tool privacy/budgets, ambiguous delivery, bridge database filtering and AppleScript argument safety. No live credentials or network provider calls are needed.

- `src/pi.ts`: isolated, pinned experimental Pi Durable adapter.
- `src/worker.ts`, `src/store.ts`: authenticated routing, admission, alarms and outbox.
- `src/gmail.ts`, `src/whatsapp.ts`, `src/tools.ts`: narrow integrations.
- `bridge/`: local Mac polling/delivery, independently tested with SQLite fixtures.

MIT licensed. Contributions should keep the surface small and safety boundaries explicit. See [SECURITY.md](SECURITY.md).
