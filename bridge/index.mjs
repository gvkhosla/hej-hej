import { mkdirSync, chmodSync, openSync, closeSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  openMessages,
  maxRow,
  incoming,
  BridgeState,
  deliver,
  sendMessage,
} from "./core.mjs";

if (process.platform !== "darwin")
  throw new Error("The iMessage bridge requires macOS");
const { ASSISTANT_URL, BRIDGE_TOKEN, IMESSAGE_OWNER, IMESSAGE_SERVICE_ID } =
  process.env;
if (
  !ASSISTANT_URL ||
  !BRIDGE_TOKEN ||
  BRIDGE_TOKEN.length < 32 ||
  !IMESSAGE_OWNER ||
  !IMESSAGE_SERVICE_ID
)
  throw new Error(
    "Set ASSISTANT_URL, BRIDGE_TOKEN, IMESSAGE_OWNER and IMESSAGE_SERVICE_ID",
  );
const base = new URL(ASSISTANT_URL);
if (
  base.protocol !== "https:" &&
  !(
    base.protocol === "http:" &&
    ["127.0.0.1", "localhost"].includes(base.hostname)
  )
)
  throw new Error(
    "ASSISTANT_URL must use HTTPS (or localhost for development)",
  );
if (base.username || base.password || base.search || base.hash)
  throw new Error("Invalid ASSISTANT_URL");
process.umask(0o077);
// Keep the legacy directory so rebranding never loses in-flight delivery markers.
const directory = resolve(
  process.env.BRIDGE_STATE_DIR ??
    resolve(homedir(), ".local/state/pi-assistant"),
);
mkdirSync(directory, { recursive: true, mode: 0o700 });
chmodSync(directory, 0o700);
const lock = resolve(directory, "bridge.lock");
let fd;
try {
  fd = openSync(lock, "wx", 0o600);
} catch {
  throw new Error(
    "Bridge already running, or stale bridge.lock; inspect it before removing",
  );
}
const messages = openMessages(
  resolve(
    process.env.MESSAGES_DB ?? resolve(homedir(), "Library/Messages/chat.db"),
  ),
);
const state = new BridgeState(resolve(directory, "bridge.db"));
const shutdown = () => {
  state.close();
  messages.close();
  closeSync(fd);
  unlinkSync(lock);
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function api(path, method = "GET", body) {
  const response = await fetch(new URL(path, base), {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(15000),
    headers: {
      Authorization: "Bearer " + BRIDGE_TOKEN,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw Object.assign(new Error("Bridge API request failed"), {
      status: response.status,
    });
  }
  const reader = response.body.getReader();
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 262144) throw new Error("Response too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
const ack = (id, attempt, status) =>
  api("/bridge/outbox/" + id + "/ack", "POST", { attempt, status });
const send = (text) => sendMessage(IMESSAGE_OWNER, text, IMESSAGE_SERVICE_ID);
// First start ignores history. Never accidentally ingest old personal conversations.
if (state.cursor() === undefined)
  state.enqueue({ cursor: maxRow(messages), messages: [] });
console.log(
  "hej hej iMessage bridge running. Only new plain-text, one-to-one owner messages are accepted.",
);
while (true) {
  try {
    // Reconcile previous uncertain sends without another AppleScript invocation.
    for (const pending of state.pending())
      await deliver(pending, state, send, ack);
    state.prune();
    if (state.queued().length < 50)
      state.enqueue(incoming(messages, state.cursor(), IMESSAGE_OWNER));
    for (const m of state.queued()) {
      await api("/bridge/inbox", "POST", m);
      state.accepted(m.id);
    }
    const available = await api("/bridge/outbox");
    for (const entry of available) {
      const claim = await api(
        "/bridge/outbox/" + entry.id + "/claim",
        "POST",
        {},
      );
      await deliver(claim, state, send, ack);
    }
  } catch {
    console.warn(
      "Bridge polling failed; check permissions, connection and configuration. No uncertain send will be repeated.",
    );
  }
  await sleep(3000);
}
