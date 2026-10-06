import { describe, it, expect, afterEach } from "vitest";
import {
  env,
  SELF,
  reset,
  runDurableObjectAlarm,
  evictDurableObject,
  runInDurableObject,
} from "cloudflare:test";
import type { Env } from "../src/types";
import type { Assistant } from "../src/worker";
const bindings = env as unknown as Env;
const headers = {
  Authorization: "Bearer " + bindings.ADMIN_TOKEN,
  "Content-Type": "application/json",
};
const bridge = {
  Authorization: "Bearer " + bindings.BRIDGE_TOKEN,
  "Content-Type": "application/json",
};
const call = async (
  path: string,
  method = "GET",
  body?: unknown,
  h = headers,
) => {
  const r = await SELF.fetch("https://assistant.test" + path, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // Drain service-binding responses before asking workerd to evict their object.
  return new Response(await r.arrayBuffer(), {
    status: r.status,
    headers: r.headers,
  });
};
const stub = () =>
  bindings.ASSISTANT.get(bindings.ASSISTANT.idFromName("owner"));
afterEach(async () => {
  await reset();
});
async function finish() {
  for (let i = 0; i < 5; i++) {
    await runDurableObjectAlarm(stub());
    await new Promise((resolve) => setTimeout(resolve, 50));
    const status = (await (await call("/v1/messages")).json()) as {
      status: string;
    }[];
    if (status.every((m) => !["queued", "running"].includes(m.status))) return;
  }
  throw new Error("Did not settle");
}
describe("authenticated durable assistant", () => {
  it("health is public but integrations are protected", async () => {
    expect((await SELF.fetch("https://assistant.test/health")).status).toBe(
      200,
    );
    expect((await SELF.fetch("https://assistant.test/v1/status")).status).toBe(
      401,
    );
    expect(
      (await SELF.fetch("https://assistant.test/internal/whatsapp")).status,
    ).toBe(404);
    expect((await call("/v1/status", "GET", undefined, bridge)).status).toBe(
      401,
    );
    expect(
      (await call("/bridge/outbox", "GET", undefined, headers)).status,
    ).toBe(401);
  });
  it("rejects malformed and oversized messages before admission", async () => {
    expect(
      (await call("/v1/messages", "POST", { id: "test", text: "" })).status,
    ).toBe(400);
    expect(
      (
        await call("/v1/messages", "POST", {
          id: "test",
          text: "a".repeat(8001),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call("/v1/messages", "POST", {
          id: "test",
          text: "a".repeat(70000),
        })
      ).status,
    ).toBe(413);
    expect(await (await call("/v1/messages")).json()).toEqual([]);
  });
  it("runs Pi with a faux model, dedupes and persists across eviction", async () => {
    const admitted = (await (
      await call("/v1/messages", "POST", { id: "request-1", text: "Hello" })
    ).json()) as { id: string };
    expect(
      (await call("/v1/messages", "POST", { id: "request-1", text: "Hello" }))
        .status,
    ).toBe(202);
    expect(
      (
        await call("/v1/messages", "POST", {
          id: "request-1",
          text: "Different",
        })
      ).status,
    ).toBe(409);
    await finish();
    const reply = (await (
      await call("/v1/messages/" + admitted.id)
    ).json()) as { response: string; status: string; generations: number };
    expect(reply.response).toBe("Test assistant reply.");
    expect(reply.status).toBe("ready");
    expect(reply.generations).toBe(1);
    await evictDurableObject(stub());
    expect(await (await call("/v1/messages/" + admitted.id)).json()).toEqual(
      reply,
    );
    expect(
      ((await (await call("/v1/messages")).json()) as unknown[]).length,
    ).toBe(1);
  });
  it("claims bridge delivery once; only exact attempt can acknowledge", async () => {
    const admitted = (await (
      await call(
        "/bridge/inbox",
        "POST",
        { id: "mac-1", text: "Hello" },
        bridge,
      )
    ).json()) as { id: string };
    await finish();
    const path = "/bridge/outbox/" + admitted.id;
    const claim = (await (
      await call(path + "/claim", "POST", {}, bridge)
    ).json()) as { id: string; attempt: number; text: string };
    expect(claim.text).toBe("Test assistant reply.");
    expect((await call(path + "/claim", "POST", {}, bridge)).status).toBe(409);
    expect(
      await (await call("/bridge/outbox", "GET", undefined, bridge)).json(),
    ).toEqual([]);
    expect(
      (
        await call(
          path + "/ack",
          "POST",
          { attempt: 99, status: "sent" },
          bridge,
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await call(
          path + "/ack",
          "POST",
          { attempt: claim.attempt, status: "sent" },
          bridge,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await call(
          path + "/ack",
          "POST",
          { attempt: claim.attempt, status: "sent" },
          bridge,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await call(
          path + "/ack",
          "POST",
          { attempt: claim.attempt, status: "unknown" },
          bridge,
        )
      ).status,
    ).toBe(409);
  });
  it("does not resend ambiguous deliveries after eviction, requires explicit retry", async () => {
    const { id } = (await (
      await call(
        "/bridge/inbox",
        "POST",
        { id: "mac-2", text: "Hello" },
        bridge,
      )
    ).json()) as { id: string };
    await finish();
    await call("/bridge/outbox/" + id + "/claim", "POST", {}, bridge);
    await evictDurableObject(stub());
    expect(
      await (await call("/bridge/outbox", "GET", undefined, bridge)).json(),
    ).toEqual([]);
    expect(
      (await call("/v1/messages/" + id + "/retry", "POST", {})).status,
    ).toBe(400);
    expect(
      (
        await call("/v1/messages/" + id + "/retry", "POST", {
          confirmDuplicateRisk: true,
        })
      ).status,
    ).toBe(200);
    expect(
      await (await call("/bridge/outbox", "GET", undefined, bridge)).json(),
    ).toEqual([{ id }]);
  });
  it("enforces durable tool/generation quotas and explicit public-query privacy", async () => {
    await call("/v1/messages", "POST", {
      id: "budget",
      text: "/research public topic",
    });
    await runInDurableObject<Assistant, void>(stub(), (instance) => {
      const m = instance.store.list()[0];
      m.status = "running";
      m.started = Date.now();
      instance.store.save(m);
      expect(instance.store.query()).toBe("public topic");
      for (let i = 0; i < 8; i++) instance.store.consume("tool");
      expect(() => instance.store.consume("tool")).toThrow("budget");
      m.text = "Find something about this private email";
      instance.store.save(m);
      expect(instance.store.query()).toBeUndefined();
    });
  });
  it("protects reset while work is pending and erases Gmail/transcripts afterwards", async () => {
    const { id } = (await (
      await call("/v1/messages", "POST", { id: "reset", text: "Hello" })
    ).json()) as { id: string };
    expect((await call("/v1/reset", "POST", {})).status).toBe(409);
    await finish();
    expect((await call("/v1/messages/" + id, "DELETE")).status).toBe(200);
    expect((await call("/v1/reset", "POST", {})).status).toBe(200);
    expect(await (await call("/v1/messages")).json()).toEqual([]);
  });
});
