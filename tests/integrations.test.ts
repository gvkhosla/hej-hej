import { describe, it, expect, vi, afterEach } from "vitest";
import { env, reset, runInDurableObject } from "cloudflare:test";
import type { Env } from "../src/types";
import type { Assistant } from "../src/worker";
import { Gmail } from "../src/gmail";
import { decrypt, encrypt, digest } from "../src/security";
import { parseWebhook, sendWhatsApp } from "../src/whatsapp";
import { tools, type ToolPolicy } from "../src/tools";
import type { ToolRegistration } from "@earendil-works/pi-durable";
const bindings = env as unknown as Env;
const configured = {
  ...bindings,
  GOOGLE_CLIENT_ID: "google-id",
  GOOGLE_CLIENT_SECRET: "google-secret",
  PUBLIC_URL: "https://assistant.test",
};
const scope = "https://www.googleapis.com/auth/gmail.readonly";
afterEach(async () => {
  vi.unstubAllGlobals();
  await reset();
});
const reply = (data: unknown) =>
  new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json" },
  });
const mock = (
  fn: (url: string, init?: RequestInit) => Response | Promise<Response>,
) => {
  const fetcher = vi.fn((url: RequestInfo | URL, init?: RequestInit) =>
    fn(String(url), init),
  );
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
};
const withGmail = <T>(
  fn: (gmail: Gmail, state: DurableObjectState) => Promise<T>,
) =>
  runInDurableObject<Assistant, T>(
    bindings.ASSISTANT.get(bindings.ASSISTANT.idFromName("gmail-tests")),
    (_instance, state) => fn(new Gmail(state.storage, configured), state),
  );
describe("Google readonly OAuth", () => {
  it("uses exact readonly scope, PKCE, one-use state and encrypted token storage", async () => {
    let form: URLSearchParams | undefined;
    mock((url, init) => {
      if (url.includes("/token")) {
        form = new URLSearchParams(String(init?.body));
        return reply({
          access_token: "access-secret",
          refresh_token: "refresh-secret",
          expires_in: 3600,
          scope,
        });
      }
      return reply({ emailAddress: "owner@example.com" });
    });
    await withGmail(async (gmail, state) => {
      const auth = new URL(await gmail.start());
      expect(auth.searchParams.get("scope")).toBe(scope);
      expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
      const pending = await state.storage.get<{ cipher: string }>(
        "oauth-state",
      );
      const decoded = await decrypt<{ verifier: string }>(
        pending!.cipher,
        bindings.TOKEN_KEY,
      );
      expect(auth.searchParams.get("code_challenge")).toBe(
        await digest(decoded.verifier),
      );
      await gmail.finish(auth.searchParams.get("state")!, "code");
      expect(form!.get("code_verifier")).toBe(decoded.verifier);
      const stored = await state.storage.get<string>("gmail-tokens");
      expect(stored).not.toContain("secret");
      expect(await gmail.connected()).toBe(true);
      await expect(
        gmail.finish(auth.searchParams.get("state")!, "code"),
      ).rejects.toThrow("state");
      await gmail.disconnect();
      expect(await gmail.connected()).toBe(false);
    });
  });
  it("rejects the wrong Gmail owner and never saves the grant", async () => {
    mock((url) =>
      url.includes("/token")
        ? reply({
            access_token: "access",
            refresh_token: "refresh",
            expires_in: 3600,
            scope,
          })
        : reply({ emailAddress: "someone-else@example.com" }),
    );
    await withGmail(async (gmail, state) => {
      const auth = new URL(await gmail.start());
      await expect(
        gmail.finish(auth.searchParams.get("state")!, "code"),
      ).rejects.toThrow("owner");
      expect(await state.storage.get("gmail-tokens")).toBeUndefined();
    });
  });
  it("rejects mismatched and expired state before any token exchange", async () => {
    const fetcher = mock(() => {
      throw new Error("Must not fetch");
    });
    await withGmail(async (gmail, state) => {
      const auth = new URL(await gmail.start());
      await expect(gmail.finish("wrong-state", "code")).rejects.toThrow(
        "state",
      );
      await state.storage.put("oauth-state", {
        hash: await digest(auth.searchParams.get("state")!),
        cipher: await encrypt(
          { verifier: "v", expires: 0 },
          bindings.TOKEN_KEY,
        ),
      });
      await expect(
        gmail.finish(auth.searchParams.get("state")!, "code"),
      ).rejects.toThrow("Expired");
      expect(fetcher).not.toHaveBeenCalled();
    });
  });
  it("rejects broader grants", async () => {
    mock(() =>
      reply({
        access_token: "access",
        refresh_token: "refresh",
        expires_in: 3600,
        scope: scope + " https://mail.google.com/",
      }),
    );
    await withGmail(async (gmail) => {
      const auth = new URL(await gmail.start());
      await expect(
        gmail.finish(auth.searchParams.get("state")!, "code"),
      ).rejects.toThrow("Unexpected OAuth grant");
    });
  });
  it("refreshes once for parallel reads and returns plaintext without attachments", async () => {
    let refreshes = 0;
    const fetcher = mock((url) => {
      if (url.includes("/token")) {
        refreshes++;
        return reply({ access_token: "new-access", expires_in: 3600, scope });
      }
      return reply({
        id: "abc123",
        payload: {
          headers: [{ name: "Subject", value: "Hello" }],
          parts: [
            { mimeType: "text/plain", body: { data: btoa("plain text") } },
            {
              mimeType: "text/html",
              body: { data: btoa("<script>ignored</script>") },
            },
            {
              mimeType: "text/plain",
              filename: "secret.txt",
              body: { data: btoa("attachment not allowed") },
            },
          ],
        },
      });
    });
    await withGmail(async (gmail, state) => {
      await state.storage.put(
        "gmail-tokens",
        await encrypt(
          { access: "expired", refresh: "refresh", expires: 0 },
          bindings.TOKEN_KEY,
        ),
      );
      const results = await Promise.all([
        gmail.read("abc123"),
        gmail.read("abc123"),
      ]);
      expect(refreshes).toBe(1);
      expect(results[0].text).toBe("plain text");
      expect(JSON.stringify(results)).not.toContain("new-access");
      expect(
        fetcher.mock.calls.every(
          ([url]) => !String(url).includes("/attachments/"),
        ),
      ).toBe(true);
    });
  });
});
async function signed(
  payload: unknown,
  secret = bindings.WHATSAPP_APP_SECRET!,
) {
  const raw = JSON.stringify(payload);
  const k = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature =
    "sha256=" +
    [
      ...new Uint8Array(
        await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(raw)),
      ),
    ]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  return new Request("https://assistant.test/webhooks/whatsapp", {
    method: "POST",
    headers: { "x-hub-signature-256": signature },
    body: raw,
  });
}
function webhook(overrides: Record<string, unknown> = {}) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "456",
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: "123" },
              messages: [
                {
                  id: "wamid.test",
                  from: "15551234567",
                  type: "text",
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  text: { body: "Hello" },
                  ...overrides,
                },
              ],
            },
          },
        ],
      },
    ],
  };
}
describe("official WhatsApp", () => {
  it("admits only signed owner text for the configured business and phone", async () => {
    expect(await parseWebhook(await signed(webhook()), bindings)).toHaveLength(
      1,
    );
    expect(
      await parseWebhook(await signed(webhook({ from: "outsider" })), bindings),
    ).toEqual([]);
    expect(
      await parseWebhook(await signed(webhook({ type: "image" })), bindings),
    ).toEqual([]);
    expect(
      await parseWebhook(await signed(webhook({ timestamp: "1" })), bindings),
    ).toEqual([]);
    expect(
      await parseWebhook(await signed(webhook()), {
        ...bindings,
        WHATSAPP_PHONE_ID: "other",
      }),
    ).toEqual([]);
    expect(
      await parseWebhook(await signed(webhook()), {
        ...bindings,
        WHATSAPP_BUSINESS_ID: "other",
      }),
    ).toEqual([]);
    await expect(
      parseWebhook(await signed(webhook(), "wrong"), bindings),
    ).rejects.toThrow("signature");
  });
  it("sends only to the configured owner and treats uncertain errors as unknown", async () => {
    const fetcher = mock((_url, init) => {
      const data = JSON.parse(String(init?.body));
      expect(data.to).toBe(bindings.WHATSAPP_OWNER);
      expect(data.text.preview_url).toBe(false);
      return reply({ messages: [{ id: "sent-id" }] });
    });
    const configured = { ...bindings, WHATSAPP_TOKEN: "private-token" };
    expect(await sendWhatsApp(configured, "reply")).toEqual({
      status: "sent",
      providerId: "sent-id",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockRejectedValue(new Error("network uncertain"));
    expect(await sendWhatsApp(configured, "reply")).toEqual({
      status: "unknown",
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("distinguishes definite rejection from server ambiguity", async () => {
    const fetcher = mock(() => new Response("no", { status: 400 }));
    const configured = { ...bindings, WHATSAPP_TOKEN: "private-token" };
    expect(await sendWhatsApp(configured, "reply")).toEqual({
      status: "failed",
    });
    fetcher.mockResolvedValue(new Response("oops", { status: 503 }));
    expect(await sendWhatsApp(configured, "reply")).toEqual({
      status: "unknown",
    });
  });
});
describe("public research tools", () => {
  it("cannot invent a query or extract an email/private link", async () => {
    const fetcher = mock(() => reply({ results: [] }));
    const policy: ToolPolicy = {
      consume() {},
      query: () => undefined,
      remember() {},
      allowed: () => false,
    };
    const registry = tools(
      {} as Gmail,
      { ...bindings, TAVILY_API_KEY: "tavily-secret" },
      policy,
    );
    const api = {} as Parameters<ToolRegistration["execute"]>[1];
    const context = { abortSignal: new AbortController().signal } as Parameters<
      ToolRegistration["execute"]
    >[2];
    await expect(
      registry.find((t) => t.name === "web_search")!.execute({}, api, context),
    ).rejects.toThrow("explicit");
    await expect(
      registry
        .find((t) => t.name === "web_read")!
        .execute({ urls: ["https://mail.google.com/private"] }, api, context),
    ).rejects.toThrow("Only URLs");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("forwards the explicit owner topic only and bounds source output", async () => {
    let allowed: string[] = [];
    const fetcher = mock((url, init) => {
      const data = JSON.parse(String(init?.body));
      if (url.endsWith("/search")) {
        expect(data.query).toBe("public topic");
        return reply({
          results: [
            {
              url: "https://www.cloudflare.com/docs",
              title: "Source",
              content: "x".repeat(5000),
            },
            { url: "http://127.0.0.1/", title: "Private", content: "no" },
          ],
        });
      }
      return reply({ results: [{ url: allowed[0], raw_content: "evidence" }] });
    });
    const policy: ToolPolicy = {
      consume() {},
      query: () => "public topic",
      remember(urls) {
        allowed = urls;
      },
      allowed: (url) => allowed.includes(url),
    };
    const registry = tools(
      {} as Gmail,
      { ...bindings, TAVILY_API_KEY: "tavily-secret" },
      policy,
    );
    const api = {} as Parameters<ToolRegistration["execute"]>[1];
    const context = { abortSignal: new AbortController().signal } as Parameters<
      ToolRegistration["execute"]
    >[2];
    const r = await registry
      .find((t) => t.name === "web_search")!
      .execute({}, api, context);
    const data = JSON.parse((r.content![0] as { text: string }).text);
    expect(data.results).toHaveLength(1);
    expect(data.results[0].text.length).toBe(2000);
    await registry
      .find((t) => t.name === "web_read")!
      .execute({ urls: allowed }, api, context);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
