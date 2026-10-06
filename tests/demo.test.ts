import { it, expect } from "vitest";
import { env } from "cloudflare:test";
import worker from "../src/worker";
import type { Env } from "../src/types";
import { demoResponse } from "../src/demo";
import { normalizeContext } from "@earendil-works/pi-ai";
it("clearly labels scripted demo replies and never claims live research/email access", () => {
  for (const content of ["Hello", "Read my Gmail", "/research CRMs"]) {
    const response = demoResponse(
      normalizeContext({
        messages: [{ role: "user", content, timestamp: Date.now() }],
      }),
    );
    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    expect(text).toContain("[OFFLINE DEMO]");
    expect(text).toMatch(/scripted|does not search|no email account/);
  }
});
it("blocks live channel/OAuth endpoints when demo is enabled", async () => {
  const bindings = { ...env, DEMO_MODE: "true" } as unknown as Env;
  for (const path of [
    "/oauth/google/start",
    "/oauth/google/callback",
    "/bridge/inbox",
    "/bridge/outbox",
    "/webhooks/whatsapp",
  ]) {
    const response = await worker.fetch(
      new Request("https://demo.test" + path, { method: "POST" }),
      bindings,
    );
    expect(response.status).toBe(404);
  }
  const health = await worker.fetch(
    new Request("https://demo.test/health"),
    bindings,
  );
  expect(await health.json()).toMatchObject({
    product: "hej hej",
    mode: "demo",
  });
});
