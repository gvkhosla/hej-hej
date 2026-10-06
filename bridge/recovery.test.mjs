import test from "node:test";
import assert from "node:assert/strict";
import { BridgeState, deliver } from "./core.mjs";
test("superseded acknowledgement does not block explicit retries", async () => {
  const state = new BridgeState(":memory:");
  state.attempted("id", 1);
  let sends = 0;
  await deliver(
    { id: "id", attempt: 1 },
    state,
    async () => {
      sends++;
    },
    async () => {
      throw Object.assign(new Error("Stale delivery"), { status: 409 });
    },
  );
  assert.equal(state.pending().length, 0);
  await deliver(
    { id: "id", attempt: 2, text: "explicit retry" },
    state,
    async () => {
      sends++;
    },
    async () => {},
  );
  assert.equal(sends, 1);
  state.close();
});
