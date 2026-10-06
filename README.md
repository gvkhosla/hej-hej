# hej hej

A small, self-hosted personal assistant you text through **iMessage** or **WhatsApp**. Powered by **Pi Durable**, with **read-only Gmail**, public web research and reply-text drafting. No dashboard, email sending or autonomous outreach.

## Try it first — no credentials

Use **Node 24 LTS**. No Cloudflare login, Google account, Meta app or API key is needed for the demo:

```sh
git clone https://github.com/gvkhosla/hej-hej.git
cd hej-hej
npm ci
npm run demo
```

Type `Hello`, `Summarize my inbox` or `/research lightweight CRMs`. Type `/quit` to exit.

**This is an offline, scripted demo—not an AI or live-integration test.** It runs the real localhost Worker, authentication, durable queue and Pi harness, but never accesses your Gmail, searches the web or sends an iMessage/WhatsApp message. Replies say `[OFFLINE DEMO]`. Temporary demo state is deleted on clean exit; the server binds only to `127.0.0.1`.

For an unattended check:

```sh
npm run demo:check   # starts/stops a real local Worker and checks the message flow
npm run check        # formatting, types, automated tests and production bundle dry run
```

## Start using the real assistant

**Connect one thing at a time:** backend → one messaging channel → Gmail → optional web/WhatsApp. You do not need every integration to start.

Fresh installations:

```sh
npm run setup -- --email YOU@gmail.com
npm run login
npm run deploy
npm run doctor
npm run ask -- "Hello hej hej"
npm run smoke
```

- `setup` generates distinct random admin/bridge tokens and an encryption key. It saves private, gitignored configuration under `.hej-hej/` with directory mode 700 and file mode 600. It never prints credentials or edits the shared `wrangler.jsonc`.
- `login` opens Cloudflare authentication. **You** approve access to your account.
- `deploy` deploys the Worker, discovers its URL and uploads secrets over stdin—not command arguments. Subsequent runs preserve the URL and credentials.
- `doctor` checks backend access and explains which optional integrations are configured. A configured key is **not** proof of live delivery.
- `ask` submits and polls a request, so you don't need curl or exported admin tokens.
- `smoke` verifies auth, admission, successful generation and deduplication with one greeting request. **Live mode uses Workers AI and may incur charges**. It does not test Gmail or actual messaging delivery.

A Cloudflare account is required for live use. The default model uses the Workers AI binding; no OpenAI key is required. Workers AI usage/account limits still apply.

Choose a different Worker name at first setup if needed:

```sh
npm run setup -- --name hej-hej-personal --email YOU@gmail.com
```

An explicit HTTPS origin can be provided with `--url https://YOUR-WORKER.workers.dev`. Names cannot be changed by re-running setup on an existing managed installation: that would create another deployment, not migrate your data. Set your actual owner email before connecting Gmail; you can omit `--email` if you only want to try the live backend first.

**Already deployed v0.1.0 manually?** Keep your current Worker name, URLs and credentials; use the [manual compatibility path](#existing-or-manual-installations). Managed deploy refuses to overwrite existing remote core credentials or silently rotate a key. If deployment was interrupted after secret upload, keep `.hej-hej/` intact and resolve the recovery warning rather than generating new keys.

### 1. Connect iMessage (recommended first on Mac)

Use a dedicated **macOS user and assistant Messages account**, not your everyday personal inbox. Text the assistant from a different, allowlisted owner account. The Mac must stay awake/running for replies.

1. Give the terminal/Node host **Full Disk Access** in System Settings → Privacy & Security, so it can read `~/Library/Messages/chat.db`.
2. Approve **Automation → Messages** when macOS prompts.
3. List the dedicated account's service ID, then save your exact owner handle and that service:

```sh
npm run bridge:services
npm run bridge:setup -- --owner '+15551234567' --service 'YOUR-MESSAGES-SERVICE-ID'
npm run bridge
```

No bearer-token exports are needed on the same setup machine. The child bridge receives **only its bridge token**, never admin/Gmail/Cloudflare credentials. Owner/service preferences are also private and gitignored. For a separate bridge Mac, use the manual environment path below; **do not copy the entire credential folder**.

Send `Hello hej hej` from your allowlisted owner. Then verify a reply in Messages. The first start skips history; only new plain-text, one-to-one **iMessages** are admitted. Self messages, groups, attachments, reactions and SMS are excluded. The Messages database opens read-only; AppleScript reply text is passed as argv, never interpolated into code.

Delivery state remains in the legacy `~/.local/state/pi-assistant` directory to preserve attempt markers across the rename. A stale `bridge.lock` after a crash must be removed **only after verifying no bridge is running**. A lost claim or interrupted send may be uncertain; inspect it with the admin API and never blindly resend. If your macOS Messages schema differs, the bridge fails closed.

This is local macOS automation, not an Apple-supported bot API. Full Disk Access, Automation approval and real delivery require your own Mac smoke test.

### 2. Add Gmail when messaging works

1. In [Google Cloud Console](https://console.cloud.google.com/), enable the Gmail API, configure OAuth consent and add yourself as a test user if the app is in Testing.
2. Create a **Web application** OAuth client. Register your exact deployed URL plus `/oauth/google/callback` as an authorized redirect URI. `npm run deploy` prints your URL.
3. Save the client values with hidden prompts, deploy them, and open readonly consent:

```sh
npm run secret -- GOOGLE_CLIENT_ID
npm run secret -- GOOGLE_CLIENT_SECRET
npm run deploy
npm run connect:gmail
npm run doctor
npm run ask -- "Find my latest 3 emails and summarize them."
```

Sign in as the configured `--email` owner. The callback verifies that Gmail account, uses one-use expiring state and PKCE, and encrypts server-side tokens. Only **Gmail readonly** is requested. Drafts are text in your reply—not saved/sent Gmail drafts. Attachments and HTML are not opened.

Google considers this a restricted scope. Personal/testing apps may require periodic reconnects (external Testing refresh tokens generally expire after seven days). Distributing a hosted app requires Google's verification and potentially further security review. This is a single-owner tool, not a multi-user hosted service.

### 3. Optional public web research

Get a [Tavily API key](https://app.tavily.com/):

```sh
npm run secret -- TAVILY_API_KEY
npm run deploy
npm run ask -- "/research lightweight CRMs for a two-person consulting company"
```

Research requires `/research <public topic>` (400 characters max). That topic is sent verbatim to Tavily; private email is not silently turned into a search query. Only HTTPS URLs returned by that request's public search can be extracted. The Worker does not directly fetch user URLs.

### 4. Optional WhatsApp

Use the [official Meta Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api/get-started), not a personal-account scraping library. This part still requires Meta's business/developer provisioning; it cannot be made keyless.

1. Create a developer app with WhatsApp and provision a test or business phone number.
2. Save these values from your Meta setup (each command prompts privately):

```sh
npm run secret -- WHATSAPP_APP_SECRET
npm run secret -- WHATSAPP_VERIFY_TOKEN
npm run secret -- WHATSAPP_TOKEN
npm run secret -- WHATSAPP_PHONE_ID
npm run secret -- WHATSAPP_BUSINESS_ID
npm run secret -- WHATSAPP_OWNER
npm run deploy
```

`WHATSAPP_VERIFY_TOKEN` is a random setup token you choose. `WHATSAPP_BUSINESS_ID` is the WhatsApp Business Account ID; `WHATSAPP_OWNER` is your numeric WhatsApp ID including country code, **without +**. The App Secret—not the verification token—authenticates POST signatures.

3. Register your deployed URL plus `/webhooks/whatsapp` with the same verification token. Subscribe the app to the business account and **messages** field.
4. Allow your number as a test recipient if using Meta's sandbox. Text the business number from that exact number, and verify the actual reply in WhatsApp.

Graph version defaults to `v23.0`; choose a version supported by your Meta app in the generated config. Dev tokens expire; production needs suitable long-lived/system-user credentials and business setup. Other senders, media, status notifications and unrelated business/phone IDs are ignored. V1 refuses replies older than 23 hours and never sends proactive templates.

## Everyday commands

| Command                                  | What it does                                                    |
| ---------------------------------------- | --------------------------------------------------------------- |
| `npm run demo`                           | Interactive offline demo, no keys                               |
| `npm run demo:check`                     | Unattended local message-flow check                             |
| `npm run setup -- --email YOU@gmail.com` | Generate/preserve private local configuration                   |
| `npm run login` / `npm run deploy`       | Cloudflare login and managed deployment                         |
| `npm run secret -- KEY`                  | Save one integration value with hidden entry (or stdin)         |
| `npm run doctor`                         | Check backend access and optional readiness                     |
| `npm run ask -- "Your question"`         | Ask and wait for the reply                                      |
| `npm run smoke`                          | Live backend/model smoke test, one greeting request             |
| `npm run connect:gmail`                  | Open your one-use Google consent URL                            |
| `npm run bridge`                         | Start the configured Mac bridge                                 |
| `npm run dev`                            | Local development; uses remote Workers AI and may incur charges |

With `npm run dev` in another terminal, use `npm run doctor -- --local`, `npm run ask -- --local "Hello"` and `npm run smoke -- --local`. `ASSISTANT_URL` and `ADMIN_TOKEN` environment overrides remain supported for advanced use; never put bearer values in command arguments.

`secret` saves locally; `deploy` applies changes remotely. It does not delete existing remote secret values. To revoke a key, use Wrangler's explicit secret-delete command and revoke at its provider. Protect and back up `.hej-hej/` privately: losing/changing the encryption key makes existing Gmail credentials unreadable.

## Existing or manual installations

Existing deployments should keep their configured Worker name, URLs, credential values and bridge state directory. The hej hej rename does not change token-encryption identifiers. Do not initialize fresh credentials over an existing account's stored data.

Manual configuration remains supported via `wrangler.jsonc` and a gitignored `.dev.vars` (see `.env.example`). Always pass the explicit config path:

```sh
npx wrangler login
npx wrangler secret put ADMIN_TOKEN --config ./wrangler.jsonc
npx wrangler secret put BRIDGE_TOKEN --config ./wrangler.jsonc
npx wrangler secret put TOKEN_KEY --config ./wrangler.jsonc
npx wrangler deploy --config ./wrangler.jsonc
```

Set `PUBLIC_URL` and `OWNER_EMAIL` in that config, retain existing secret values, and use `wrangler secret put KEY --config ./wrangler.jsonc` for optional integrations. Public readonly consent is initiated by authenticated `POST /oauth/google/start`. For a separate Mac, export **only** `ASSISTANT_URL`, `BRIDGE_TOKEN`, `IMESSAGE_OWNER` and `IMESSAGE_SERVICE_ID`, then run `node bridge/index.mjs` directly. Do not copy admin/Gmail credentials onto a bridge-only machine.

## Architecture and safety

```text
iMessage ←→ Mac bridge ─┐
WhatsApp ←→ Cloud API ─┼→ authenticated Worker → owner Durable Object → Pi Durable
JSON API / CLI ────────┘                              ├→ Gmail (readonly)
                                                     └→ Tavily (public sources)
```

Admission is acknowledged before the model completes. Lifecycle alarms resume the application queue/outbox; Pi handles generation recovery. One request runs at a time, in fresh context. Include the context you need in each message; there is no cross-request conversational memory in v1.

**Delivery is not exactly once.** An HTTP/AppleScript timeout can mean a message was sent. Attempt markers are persisted before sending; uncertain attempts are never automatically resent. `sent` means Meta accepted the API request or AppleScript returned successfully—not recipient receipt/read. An admin can explicitly retry, accepting duplicate risk. At most three delivery attempts are allowed per receipt.

Limits: 8,000 input and 3,800 reply characters; 50 new messages/day; 10 queued/running messages; 1,000 receipts; 8 generation attempts and 8 tool calls/request; 120-second request deadline. Gmail search reads at most 5 results; web search at most 5 sources, source read at most 2. HTTP timeouts and body-size limits apply.

### API and recovery

`/v1/*` and `POST /oauth/google/start` require the admin bearer. `/bridge/*` uses the separate bridge bearer. There is no CORS or public session API.

| Endpoint                        | Purpose                                                                |
| ------------------------------- | ---------------------------------------------------------------------- |
| `GET /health`                   | Public product/version/mode                                            |
| `GET /v1/status`                | Private integration readiness                                          |
| `POST /v1/messages`             | Admit `{"id":"stable-client-id","text":"..."}`                         |
| `GET /v1/messages`              | List statuses                                                          |
| `GET /v1/messages/:id`          | Private receipt/reply; completion is `done`, `unanswered` or `timeout` |
| `POST /v1/messages/:id/retry`   | Manual channel retry with `{"confirmDuplicateRisk":true}`              |
| `DELETE /v1/messages/:id`       | Remove a finished receipt, **not** its Pi transcript                   |
| `DELETE /v1/gmail`              | Delete stored OAuth credentials; also revoke in Google Account         |
| `POST /v1/reset`                | Wipe all durable data, credentials and dedupe history                  |
| `POST /bridge/inbox`            | Bridge-only admission                                                  |
| `GET /bridge/outbox`            | Ready iMessage reply IDs                                               |
| `POST /bridge/outbox/:id/claim` | Persist attempt before returning text                                  |
| `POST /bridge/outbox/:id/ack`   | Acknowledge the exact attempt                                          |

`queued → running → ready → attempted → sent / failed / unknown`. API replies stay `ready` for polling. An interrupted `attempted` is uncertain, not permission to resend. Stop/inspect the sender before an explicit retry.

**Retention:** private prompts, read email excerpts, replies and Pi transcripts stay in the owner's Durable Object until a full reset. Receipt deletion does not erase transcripts. Reset refuses active work/pending deliveries; stop ingress/bridge and inspect/delete remaining uncertain receipts first. Reset clears dedupe, so old inbound IDs could be admitted again. Delete Mac bridge state separately if desired. See [SECURITY.md](SECURITY.md).

## Development and validation

```sh
npm ci
npm run fmt
npm run check
npm run demo:check
```

Automated tests use a faux model, mocked Google/Meta/Tavily responses and a synthetic Messages database. The localhost demo checks an actual Worker process. **Neither proves your real accounts are connected.** Verify a live backend/model with `smoke`, then actual Gmail consent/search and a reply in your chosen messaging app.

- `src/pi.ts`: pinned experimental Pi Durable adapter.
- `src/worker.ts`, `src/store.ts`: routing, durable admission, alarms and outbox.
- `src/gmail.ts`, `src/whatsapp.ts`, `src/tools.ts`: narrow integrations.
- `scripts/`: demo, private setup, deploy and test/diagnostic CLI.
- `bridge/`: independently tested local Mac reader/delivery.

MIT licensed. Contributions should keep the product small and its safety boundaries explicit.
