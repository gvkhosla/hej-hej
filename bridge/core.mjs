import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

export const SEND_SCRIPT = `on run argv
  set targetBuddy to item 1 of argv
  set replyText to item 2 of argv
  set serviceId to item 3 of argv
  tell application "Messages"
    set targetService to first service whose id is serviceId and service type is iMessage
    set recipient to buddy targetBuddy of targetService
    send replyText to recipient
  end tell
end run`;

export function openMessages(path) {
  return new DatabaseSync(path, { readOnly: true });
}
export function maxRow(db) {
  return Number(
    db.prepare("SELECT COALESCE(MAX(ROWID),0) AS id FROM message").get().id,
  );
}
export function incoming(db, after, owner) {
  const batch = db
    .prepare(
      "SELECT ROWID AS id FROM message WHERE ROWID > ? ORDER BY ROWID LIMIT 200",
    )
    .all(after);
  if (!batch.length) return { cursor: after, messages: [] };
  const cursor = Number(batch.at(-1).id);
  const rows = db
    .prepare(
      `SELECT DISTINCT m.ROWID AS rowid, m.guid, m.text
    FROM message m JOIN handle h ON h.ROWID = m.handle_id
    JOIN chat_message_join cm ON cm.message_id = m.ROWID
    JOIN chat c ON c.ROWID = cm.chat_id
    WHERE m.ROWID > ? AND m.ROWID <= ? AND h.id = ?
      AND m.is_from_me = 0 AND m.cache_has_attachments = 0
      AND m.item_type = 0 AND m.associated_message_type = 0
      AND m.service = 'iMessage' AND c.style = 45
      AND (SELECT COUNT(*) FROM chat_handle_join ch WHERE ch.chat_id=c.ROWID) = 1
      AND m.text IS NOT NULL AND LENGTH(m.text) BETWEEN 1 AND 8000
    ORDER BY m.ROWID`,
    )
    .all(after, cursor, owner);
  return {
    cursor,
    messages: rows
      .filter((r) => r.text.trim())
      .map((r) => ({
        id:
          "mac-" +
          createHash("sha256")
            .update(r.guid || String(r.rowid))
            .digest("hex"),
        text: r.text,
      })),
  };
}

export class BridgeState {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT);
      CREATE TABLE IF NOT EXISTS inbox(id TEXT PRIMARY KEY,text TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox(id TEXT NOT NULL,attempt INTEGER NOT NULL,status TEXT NOT NULL,acked INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(id,attempt));`);
  }
  cursor() {
    const r = this.db
      .prepare("SELECT value FROM settings WHERE key='cursor'")
      .get();
    return r ? Number(r.value) : undefined;
  }
  enqueue({ cursor, messages }) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const m of messages)
        this.db
          .prepare("INSERT OR IGNORE INTO inbox(id,text) VALUES (?,?)")
          .run(m.id, m.text);
      this.db
        .prepare(
          "INSERT INTO settings(key,value) VALUES ('cursor',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(String(cursor));
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  queued() {
    return this.db
      .prepare("SELECT id,text FROM inbox ORDER BY rowid LIMIT 50")
      .all();
  }
  accepted(id) {
    this.db.prepare("DELETE FROM inbox WHERE id=?").run(id);
  }
  delivery(id, attempt) {
    return this.db
      .prepare("SELECT * FROM outbox WHERE id=? AND attempt=?")
      .get(id, attempt);
  }
  attempted(id, attempt) {
    this.db
      .prepare("INSERT INTO outbox(id,attempt,status) VALUES (?,?,'attempted')")
      .run(id, attempt);
  }
  outcome(id, attempt, status) {
    this.db
      .prepare("UPDATE outbox SET status=? WHERE id=? AND attempt=?")
      .run(status, id, attempt);
  }
  acknowledged(id, attempt) {
    this.db
      .prepare("UPDATE outbox SET acked=1 WHERE id=? AND attempt=?")
      .run(id, attempt);
  }
  pending() {
    return this.db.prepare("SELECT id,attempt FROM outbox WHERE acked=0").all();
  }
  prune() {
    this.db.prepare("DELETE FROM outbox WHERE acked=1").run();
  }
  close() {
    this.db.close();
  }
}

/** Persist before invoking Messages. After a crash, acknowledge unknown, never send again. */
export async function deliver(claim, state, send, ack) {
  let previous = state.delivery(claim.id, claim.attempt);
  if (!previous) {
    if (
      typeof claim.text !== "string" ||
      !claim.text ||
      claim.text.length > 4000
    )
      throw new Error("Invalid delivery");
    state.attempted(claim.id, claim.attempt);
    try {
      await send(claim.text);
      state.outcome(claim.id, claim.attempt, "sent");
    } catch {
      state.outcome(claim.id, claim.attempt, "unknown");
    }
    previous = state.delivery(claim.id, claim.attempt);
  }
  if (previous.status === "attempted") {
    state.outcome(claim.id, claim.attempt, "unknown");
    previous = state.delivery(claim.id, claim.attempt);
  }
  try {
    await ack(claim.id, claim.attempt, previous.status);
  } catch (error) {
    // An explicit admin retry/reset superseded this attempt. Do not block the new one.
    if (error.status !== 409) throw error;
  }
  state.acknowledged(claim.id, claim.attempt);
}

export function sendMessage(owner, text, serviceId, runner = spawn) {
  return new Promise((resolve, reject) => {
    const child = runner(
      "/usr/bin/osascript",
      ["-e", SEND_SCRIPT, "--", owner, text, serviceId],
      { stdio: "ignore", shell: false },
    );
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Messages send timed out"));
    }, 15000);
    child.on("error", () => {
      clearTimeout(timer);
      reject(new Error("Messages send failed"));
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error("Messages send failed"));
    });
  });
}
