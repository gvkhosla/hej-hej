import { HttpError } from "./types";
const encoder = new TextEncoder();
// Encryption AAD is a stable protocol identifier, not branding. Keep it for existing tokens.
export function b64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
export function unb64(s: string): Uint8Array {
  return Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0),
  );
}
export async function digest(s: string): Promise<string> {
  return b64(
    new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(s))),
  );
}
export async function equal(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  let difference = 0;
  for (let i = 0; i < x.length; i++)
    difference |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return difference === 0;
}
export async function authorized(
  request: Request,
  token?: string,
): Promise<boolean> {
  return (
    !!token &&
    token.length >= 32 &&
    (await equal(request.headers.get("Authorization") ?? "", "Bearer " + token))
  );
}
export async function validSignature(
  raw: string,
  signature: string | null,
  secret?: string,
): Promise<boolean> {
  if (!secret || !signature || !/^sha256=[a-f0-9]{64}$/.test(signature))
    return false;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(raw)),
  );
  return equal(
    signature,
    "sha256=" +
      [...signed].map((b) => b.toString(16).padStart(2, "0")).join(""),
  );
}
async function tokenKey(secret: string): Promise<CryptoKey> {
  const bytes = unb64(secret);
  if (bytes.length !== 32)
    throw new HttpError(503, "TOKEN_KEY must encode 32 bytes");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}
export async function encrypt(value: unknown, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: encoder.encode("pi-assistant:gmail:v1"),
    },
    await tokenKey(secret),
    encoder.encode(JSON.stringify(value)),
  );
  return b64(iv) + "." + b64(new Uint8Array(data));
}
export async function decrypt<T>(value: string, secret: string): Promise<T> {
  const [iv, data] = value.split(".");
  const result = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: unb64(iv),
      additionalData: encoder.encode("pi-assistant:gmail:v1"),
    },
    await tokenKey(secret),
    unb64(data),
  );
  return JSON.parse(new TextDecoder().decode(result)) as T;
}
export async function boundedText(
  request: Request | Response,
  limit = 65536,
): Promise<string> {
  if (Number(request.headers.get("content-length")) > limit)
    throw new HttpError(413, "Body too large");
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit) throw new HttpError(413, "Body too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(bytes);
}
export async function jsonFetch<T>(
  url: string,
  init: RequestInit = {},
  limit = 262144,
): Promise<T> {
  const response = await fetch(url, {
    ...init,
    redirect: "error",
    signal: init.signal ?? AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new HttpError(
      502,
      "Upstream request failed (" + response.status + ")",
    );
  }
  return JSON.parse(await boundedText(response, limit)) as T;
}
/** Only DNS hostnames over HTTPS. No direct user-URL fetches: extraction is delegated to Tavily. */
export function publicUrl(value: string): string {
  const url = new URL(value);
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    !host.includes(".") ||
    !/^[a-z0-9.-]+$/.test(host) ||
    /^[0-9.]+$/.test(host) ||
    /(^|\.)(localhost|local|internal|lan|home|test|invalid|example)$/.test(host)
  ) {
    throw new HttpError(400, "Only public HTTPS domain URLs are supported");
  }
  url.hash = "";
  return url.toString();
}
