import test from "node:test";
import assert from "node:assert/strict";
import { smoke } from "./lib.mjs";
test("smoke does not mistake a durable error reply for successful generation", async () => {
  const fetcher = async (url, init = {}) => {
    if (url.endsWith("/health"))
      return new Response('{"ok":true,"product":"hej hej","mode":"live"}');
    if (url.endsWith("/v1/status")) return new Response("{}", { status: 401 });
    if (init.method === "POST") return new Response('{"id":"receipt"}');
    return new Response(
      '{"id":"receipt","status":"ready","completion":"unanswered","response":"I could not complete this request"}',
    );
  };
  await assert.rejects(
    smoke({ url: "http://localhost:1", token: "x" }, { fetcher }),
    /generation did not succeed/,
  );
});
