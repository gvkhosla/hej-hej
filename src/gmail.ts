import type { Env } from "./types";
import { HttpError } from "./types";
import { b64, decrypt, digest, encrypt, jsonFetch, unb64 } from "./security";
const SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
interface Tokens {
  access: string;
  refresh: string;
  expires: number;
}
interface TokenReply {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
}
interface OAuthState {
  verifier: string;
  expires: number;
}
interface Part {
  mimeType?: string;
  filename?: string;
  body?: { data?: string };
  parts?: Part[];
  headers?: { name: string; value: string }[];
}
export class Gmail {
  private refreshing?: Promise<Tokens>;
  constructor(
    private storage: DurableObjectStorage,
    private env: Env,
  ) {}
  private config() {
    if (
      !this.env.GOOGLE_CLIENT_ID ||
      !this.env.GOOGLE_CLIENT_SECRET ||
      !this.env.OWNER_EMAIL ||
      !this.env.PUBLIC_URL.startsWith("https://") ||
      this.env.PUBLIC_URL.includes("YOUR-WORKER")
    )
      throw new HttpError(
        503,
        "Configure Google OAuth, PUBLIC_URL and OWNER_EMAIL first",
      );
    return {
      client_id: this.env.GOOGLE_CLIENT_ID,
      client_secret: this.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: new URL(
        "/oauth/google/callback",
        this.env.PUBLIC_URL,
      ).toString(),
    };
  }
  async start(): Promise<string> {
    const config = this.config();
    const state = b64(crypto.getRandomValues(new Uint8Array(32)));
    const verifier = b64(crypto.getRandomValues(new Uint8Array(48)));
    // One pending login; a second start invalidates the first.
    await this.storage.put("oauth-state", {
      hash: await digest(state),
      cipher: await encrypt(
        { verifier, expires: Date.now() + 600000 },
        this.env.TOKEN_KEY,
      ),
    });
    const params = new URLSearchParams({
      client_id: config.client_id,
      redirect_uri: config.redirect_uri,
      response_type: "code",
      scope: SCOPE,
      state,
      code_challenge: await digest(verifier),
      code_challenge_method: "S256",
      access_type: "offline",
      prompt: "consent",
      login_hint: this.env.OWNER_EMAIL,
    });
    return "https://accounts.google.com/o/oauth2/v2/auth?" + params;
  }
  async finish(state: string, code: string): Promise<void> {
    const config = this.config();
    const hash = await digest(state);
    const pending = await this.storage.transaction(async (tx) => {
      const p = await tx.get<{ hash: string; cipher: string }>("oauth-state");
      if (!p || p.hash !== hash)
        throw new HttpError(400, "Invalid OAuth state");
      await tx.delete("oauth-state"); // Consume before exchange; never replay.
      return p;
    });
    const { verifier, expires } = await decrypt<OAuthState>(
      pending.cipher,
      this.env.TOKEN_KEY,
    );
    if (expires < Date.now()) throw new HttpError(400, "Expired OAuth state");
    const tokens = await this.exchange({
      ...config,
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
    });
    const profile = await jsonFetch<{ emailAddress: string }>(
      "https://gmail.googleapis.com/gmail/v1/users/me/profile",
      { headers: { Authorization: "Bearer " + tokens.access_token } },
    );
    if (
      profile.emailAddress.toLowerCase() !== this.env.OWNER_EMAIL.toLowerCase()
    )
      throw new HttpError(403, "This is not the configured owner's Gmail");
    if (!tokens.refresh_token)
      throw new HttpError(
        400,
        "Google did not issue a refresh token; revoke the app and reconnect",
      );
    await this.save({
      access: tokens.access_token,
      refresh: tokens.refresh_token,
      expires: Date.now() + tokens.expires_in * 1000,
    });
  }
  private async exchange(params: Record<string, string>): Promise<TokenReply> {
    const t = await jsonFetch<TokenReply>(
      "https://oauth2.googleapis.com/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(params),
      },
    );
    if (
      typeof t.access_token !== "string" ||
      !Number.isFinite(t.expires_in) ||
      t.expires_in <= 0 ||
      (t.scope && t.scope.split(" ").some((s) => s !== SCOPE))
    )
      throw new HttpError(502, "Unexpected OAuth grant");
    return t;
  }
  private save(t: Tokens): Promise<void> {
    return encrypt(t, this.env.TOKEN_KEY).then((cipher) =>
      this.storage.put("gmail-tokens", cipher),
    );
  }
  private async access(): Promise<string> {
    const cipher = await this.storage.get<string>("gmail-tokens");
    if (!cipher) throw new HttpError(409, "Gmail not connected");
    const t = await decrypt<Tokens>(cipher, this.env.TOKEN_KEY);
    if (t.expires > Date.now() + 60000) return t.access;
    if (!this.refreshing)
      this.refreshing = (async () => {
        const reply = await this.exchange({
          client_id: this.config().client_id,
          client_secret: this.config().client_secret,
          grant_type: "refresh_token",
          refresh_token: t.refresh,
        });
        const updated = {
          access: reply.access_token,
          refresh: reply.refresh_token ?? t.refresh,
          expires: Date.now() + reply.expires_in * 1000,
        };
        await this.save(updated);
        return updated;
      })().finally(() => {
        this.refreshing = undefined;
      });
    return (await this.refreshing).access;
  }
  async connected(): Promise<boolean> {
    return !!(await this.storage.get("gmail-tokens"));
  }
  async disconnect(): Promise<void> {
    // Local deletion only. Owner must also revoke in Google Account permissions.
    await this.storage.delete(["gmail-tokens", "oauth-state"]);
  }
  private async get<T>(path: string, signal?: AbortSignal): Promise<T> {
    return jsonFetch<T>(
      "https://gmail.googleapis.com/gmail/v1/users/me/" + path,
      {
        headers: { Authorization: "Bearer " + (await this.access()) },
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
          : undefined,
      },
      1048576,
    );
  }
  async search(query: string, signal?: AbortSignal) {
    const data = await this.get<{ messages?: { id: string }[] }>(
      "messages?" + new URLSearchParams({ q: query, maxResults: "5" }),
      signal,
    );
    const results = await Promise.all(
      (data.messages ?? []).slice(0, 5).map(async ({ id }) => {
        if (!/^[a-f0-9]+$/i.test(id))
          throw new HttpError(502, "Unexpected Gmail id");
        const m = await this.get<{
          id: string;
          snippet?: string;
          payload?: Part;
        }>(
          "messages/" +
            id +
            "?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date",
          signal,
        );
        return {
          id: m.id,
          snippet: (m.snippet ?? "").slice(0, 1000),
          headers: (m.payload?.headers ?? []).map((h) => ({
            name: h.name,
            value: h.value.slice(0, 500),
          })),
          url: "https://mail.google.com/mail/u/0/#all/" + id,
        };
      }),
    );
    return { untrusted: true, results };
  }
  async read(id: string, signal?: AbortSignal) {
    const m = await this.get<{ id: string; snippet?: string; payload?: Part }>(
      "messages/" + encodeURIComponent(id) + "?format=full",
      signal,
    );
    const texts: string[] = [];
    const visit = (p: Part, depth = 0) => {
      if (depth > 8 || p.filename) return;
      if (p.mimeType === "text/plain" && p.body?.data)
        texts.push(
          new TextDecoder().decode(unb64(p.body.data)).slice(0, 12000),
        );
      for (const child of (p.parts ?? []).slice(0, 20)) visit(child, depth + 1);
    };
    if (m.payload) visit(m.payload);
    return {
      untrusted: true,
      id: m.id,
      headers: (m.payload?.headers ?? [])
        .filter((h) =>
          ["from", "to", "subject", "date"].includes(h.name.toLowerCase()),
        )
        .slice(0, 10)
        .map((h) => ({ name: h.name, value: h.value.slice(0, 500) })),
      text:
        texts.join("\n").slice(0, 12000) || (m.snippet ?? "").slice(0, 2000),
      note: "Plain-text only; attachments and HTML omitted",
      url: "https://mail.google.com/mail/u/0/#all/" + id,
    };
  }
}
