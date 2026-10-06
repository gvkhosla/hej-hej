import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";
import {
  BridgeState,
  deliver,
  incoming,
  openMessages,
  sendMessage,
  SEND_SCRIPT,
} from "./core.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
test("local attempt marker prevents resending after a crash", async () => {
  const state = new BridgeState(":memory:");
  state.attempted("id", 1);
  let sends = 0;
  let ack;
  await deliver(
    { id: "id", attempt: 1 },
    state,
    async () => {
      sends++;
    },
    async (...args) => {
      ack = args;
    },
  );
  assert.equal(sends, 0);
  assert.deepEqual(ack, ["id", 1, "unknown"]);
  state.close();
});
test("lost acknowledgement retries only the acknowledgement", async () => {
  const state = new BridgeState(":memory:");
  let sends = 0;
  const claim = { id: "id", attempt: 1, text: "reply" };
  await assert.rejects(
    deliver(
      claim,
      state,
      async () => {
        sends++;
      },
      async () => {
        throw new Error("network");
      },
    ),
  );
  await deliver(
    claim,
    state,
    async () => {
      sends++;
    },
    async () => {},
  );
  assert.equal(sends, 1);
  assert.equal(state.delivery("id", 1).status, "sent");
  state.close();
});
test("AppleScript failure is ambiguous, never an automatic retry", async () => {
  const state = new BridgeState(":memory:");
  let sends = 0;
  await deliver(
    { id: "id", attempt: 1, text: "reply" },
    state,
    async () => {
      sends++;
      throw new Error();
    },
    async () => {},
  );
  await deliver(
    { id: "id", attempt: 1, text: "reply" },
    state,
    async () => {
      sends++;
    },
    async () => {},
  );
  assert.equal(sends, 1);
  assert.equal(state.delivery("id", 1).status, "unknown");
  state.close();
});
test("AppleScript text, buddy and service are argv, not source interpolation", async () => {
  const text = 'hello" & do shell script "oops"';
  let invocation;
  await sendMessage("owner", text, "service", (bin, args, opts) => {
    invocation = { bin, args, opts };
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("exit", 0));
    return child;
  });
  assert.equal(invocation.bin, "/usr/bin/osascript");
  assert.equal(invocation.opts.shell, false);
  assert.equal(invocation.args[1], SEND_SCRIPT);
  assert.equal(SEND_SCRIPT.includes(text), false);
  assert.deepEqual(invocation.args.slice(2), ["--", "owner", text, "service"]);
});
test("Messages reader ignores self, groups, reactions, attachments and outsiders; advances cursor", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-assistant-test-")),
    path = join(dir, "messages.db");
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE message(guid TEXT,text TEXT,handle_id INTEGER,is_from_me INTEGER DEFAULT 0,cache_has_attachments INTEGER DEFAULT 0,item_type INTEGER DEFAULT 0,associated_message_type INTEGER DEFAULT 0,service TEXT DEFAULT 'iMessage');
    CREATE TABLE handle(id TEXT);
    CREATE TABLE chat(style INTEGER);
    CREATE TABLE chat_message_join(chat_id INTEGER,message_id INTEGER);
    CREATE TABLE chat_handle_join(chat_id INTEGER,handle_id INTEGER);
    INSERT INTO handle VALUES ('owner'),('outsider');
    INSERT INTO chat VALUES (45),(43);
    INSERT INTO chat_handle_join VALUES (1,1),(2,1),(2,2);`);
  const add = (
    text,
    handle = 1,
    self = 0,
    attachment = 0,
    reaction = 0,
    chat = 1,
  ) => {
    const row = db
      .prepare(
        "INSERT INTO message(guid,text,handle_id,is_from_me,cache_has_attachments,associated_message_type) VALUES (?,?,?,?,?,?)",
      )
      .run(text, text, handle, self, attachment, reaction).lastInsertRowid;
    db.prepare("INSERT INTO chat_message_join VALUES (?,?)").run(chat, row);
  };
  add("accepted");
  add("outsider", 2);
  add("own", 1, 1);
  add("attachment", 1, 0, 1);
  add("reaction", 1, 0, 0, 2000);
  add("group", 1, 0, 0, 0, 2);
  db.close();
  const reader = openMessages(path);
  const batch = incoming(reader, 0, "owner");
  assert.equal(batch.cursor, 6);
  assert.equal(batch.messages.length, 1);
  assert.equal(batch.messages[0].text, "accepted");
  assert.throws(() => reader.exec("DELETE FROM message"));
  reader.close();
  rmSync(dir, { recursive: true });
});
test("cursor and pending inbox commit together; retries use stable IDs", () => {
  const state = new BridgeState(":memory:");
  state.enqueue({ cursor: 3, messages: [{ id: "same", text: "hello" }] });
  state.enqueue({ cursor: 3, messages: [{ id: "same", text: "hello" }] });
  assert.equal(state.cursor(), 3);
  assert.equal(state.queued().length, 1);
  state.accepted("same");
  assert.equal(state.queued().length, 0);
  state.close();
});
