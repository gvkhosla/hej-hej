import { describe, it, expect } from "vitest";
import {
  authorized,
  boundedText,
  encrypt,
  decrypt,
  publicUrl,
  validSignature,
} from "../src/security";
const key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
describe("security boundaries", () => {
  it("uses exact bearer auth and rejects unset/weak tokens", async () => {
    const token = "a".repeat(32);
    expect(
      await authorized(
        new Request("https://x", {
          headers: { Authorization: "Bearer " + token },
        }),
        token,
      ),
    ).toBe(true);
    expect(
      await authorized(
        new Request("https://x", {
          headers: { Authorization: "Bearer " + token + "x" },
        }),
        token,
      ),
    ).toBe(false);
    expect(await authorized(new Request("https://x"), undefined)).toBe(false);
    expect(
      await authorized(
        new Request("https://x", {
          headers: { Authorization: "Bearer short" },
        }),
        "short",
      ),
    ).toBe(false);
  });
  it("encrypts tokens and detects tampering and a wrong key", async () => {
    const cipher = await encrypt({ refresh: "secret" }, key);
    expect(cipher).not.toContain("secret");
    expect(await decrypt(cipher, key)).toEqual({ refresh: "secret" });
    await expect(
      decrypt(cipher, "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE="),
    ).rejects.toThrow();
    await expect(decrypt(cipher.slice(0, -3) + "AAA", key)).rejects.toThrow();
  });
  it("bounds a body even when Content-Length is absent", async () => {
    await expect(
      boundedText(
        new Request("https://x", { method: "POST", body: "a".repeat(20) }),
        10,
      ),
    ).rejects.toThrow("Body too large");
  });
  it.each([
    "http://example.com",
    "https://127.0.0.1/",
    "https://2130706433/",
    "https://0x7f000001/",
    "https://[::1]/",
    "https://foo.local/a",
    "https://user:pass@google.com/",
    "https://google.com:8443/",
    "https://localhost/",
    "file:///tmp/foo",
    "https://metadata.google.internal/",
  ])("rejects nonpublic URL %s", (url) => {
    expect(() => publicUrl(url)).toThrow();
  });
  it("accepts public HTTPS DNS URLs", () =>
    expect(publicUrl("https://www.google.com/search?q=hello#frag")).toBe(
      "https://www.google.com/search?q=hello",
    ));
  it("requires a raw body HMAC, not just a verification token", async () => {
    const raw = '{"hello":1}',
      secret = "test-secret";
    const h = await crypto.subtle.importKey(
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
          await crypto.subtle.sign("HMAC", h, new TextEncoder().encode(raw)),
        ),
      ]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    expect(await validSignature(raw, signature, secret)).toBe(true);
    expect(await validSignature(raw + " ", signature, secret)).toBe(false);
    expect(await validSignature(raw, null, secret)).toBe(false);
  });
});
