import { DurableObject } from "cloudflare:workers";
import { Lifecycle, type LifecycleJobContext } from "agents/lifecycle";
import { HttpError, type Channel, type Env, type Message } from "./types";
import { authorized, boundedText, digest, equal } from "./security";
import { Gmail } from "./gmail";
import { createPi } from "./pi";
import { Store } from "./store";
import { parseWebhook, sendWhatsApp, verification } from "./whatsapp";
const json = (value: unknown, status = 200) =>
  Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
async function body(request: Request): Promise<Record<string, unknown>> {
  try {
    const value = JSON.parse(await boundedText(request));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error();
    return value;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, "Invalid JSON");
  }
}
function input(value: Record<string, unknown>): { id: string; text: string } {
  if (
    typeof value.id !== "string" ||
    !/^[a-zA-Z0-9_.:-]{1,200}$/.test(value.id) ||
    typeof value.text !== "string" ||
    !value.text.trim() ||
    value.text.length > 8000
  )
    throw new HttpError(
      400,
      "Expected id (1–200 safe characters) and text (1–8000 characters)",
    );
  return { id: value.id, text: value.text };
}
export class Assistant extends DurableObject<Env> {
  store = new Store(this.ctx.storage);
  gmail = new Gmail(this.ctx.storage, this.env);
  harness = createPi(this.env, this.gmail, this.store, () =>
    this.store.consume("generation"),
  );
  lifecycle = new Lifecycle(this).use(this.harness);
  private requests = 0;
  private driving = false;
  private resetting = false;
  // Explicit dispatch lets an owner reset rebuild the entire in-memory composition.
  fetch(request: Request): Promise<Response> {
    return this.lifecycle.fetch(request);
  }
  alarm(): Promise<void> {
    return this.lifecycle.alarm();
  }
  async onStart(): Promise<void> {
    // Resume the app outbox independently of Pi's own durable generation jobs.
    await this.lifecycle.jobs.push({
      id: "drive",
      fn: "drive",
      time: Date.now() + 1000,
      singleflight: true,
    });
  }
  private async admit(
    channel: Channel,
    id: string,
    text: string,
    created = Date.now(),
  ): Promise<Message> {
    const key = channel + "-" + (await digest(id));
    // Schedule before admitting. A reset before admission gets no ACK, so client retry is safe.
    await this.lifecycle.jobs.push({
      id: "drive",
      fn: "drive",
      time: Date.now() + 100,
      singleflight: true,
    });
    return this.store.admit(key, channel, text, created);
  }
  async onRequest(request: Request): Promise<Response> {
    if (this.resetting) return json({ error: "Reset in progress" }, 409);
    this.requests++;
    try {
      return await this.handle(request);
    } catch (e) {
      return json(
        { error: e instanceof HttpError ? e.message : "Internal error" },
        e instanceof HttpError ? e.status : 500,
      );
    } finally {
      this.requests--;
    }
  }
  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url),
      path = url.pathname,
      method = request.method;
    if (path === "/internal/whatsapp" && method === "POST") {
      const data = await body(request);
      if (!Array.isArray(data.messages))
        throw new HttpError(400, "Invalid messages");
      for (const m of data.messages)
        await this.admit("whatsapp", m.id, m.text, m.created);
      return json({ accepted: true });
    }
    if (
      (path === "/v1/messages" || path === "/bridge/inbox") &&
      method === "POST"
    ) {
      const { id, text } = input(await body(request));
      const m = await this.admit(
        path.startsWith("/bridge") ? "imessage" : "api",
        id,
        text,
      );
      return json({ id: m.id, status: m.status }, 202);
    }
    if (path === "/v1/messages" && method === "GET")
      return json(
        this.store.list().map(({ id, channel, status, attempts, created }) => ({
          id,
          channel,
          status,
          attempts,
          created,
        })),
      );
    const match = /^\/v1\/messages\/([A-Za-z0-9_-]+)(\/retry)?$/.exec(path);
    if (match) {
      if (match[2] && method === "POST") {
        const data = await body(request);
        if (data.confirmDuplicateRisk !== true)
          throw new HttpError(
            400,
            "Explicit confirmDuplicateRisk: true required",
          );
        await this.lifecycle.jobs.push({
          id: "drive",
          fn: "drive",
          time: Date.now() + 100,
          singleflight: true,
        });
        if (this.driving)
          throw new HttpError(
            409,
            "Wait for the current delivery driver to finish",
          );
        return json(this.store.retry(match[1]));
      }
      const m = this.store.get(match[1]);
      if (!m) throw new HttpError(404, "Not found");
      if (method === "GET" && !match[2]) return json(m);
      if (method === "DELETE" && !match[2]) {
        if (this.driving)
          throw new HttpError(
            409,
            "Wait for the current delivery driver to finish",
          );
        this.store.remove(m.id);
        return json({
          deleted: true,
          note: "Pi transcripts remain until /v1/reset",
        });
      }
    }
    if (path === "/bridge/outbox" && method === "GET") {
      return json(
        this.store
          .list()
          .filter((m) => m.channel === "imessage" && m.status === "ready")
          .map((m) => ({ id: m.id })),
      );
    }
    const bridge = /^\/bridge\/outbox\/([A-Za-z0-9_-]+)\/(claim|ack)$/.exec(
      path,
    );
    if (bridge && method === "POST") {
      if (bridge[2] === "claim") {
        const m = this.store.claim(bridge[1]);
        return json({ id: m.id, text: m.response, attempt: m.attempts });
      }
      const data = await body(request);
      if (
        !Number.isInteger(data.attempt) ||
        !["sent", "unknown", "failed"].includes(String(data.status))
      )
        throw new HttpError(400, "Invalid acknowledgement");
      this.store.ack(
        bridge[1],
        data.attempt as number,
        data.status as "sent" | "unknown" | "failed",
      );
      return json({ ok: true });
    }
    if (path === "/v1/status" && method === "GET")
      return json({
        version: "0.1.0",
        gmail: await this.gmail.connected(),
        web: !!this.env.TAVILY_API_KEY,
        whatsapp: !!(
          this.env.WHATSAPP_TOKEN &&
          this.env.WHATSAPP_OWNER &&
          this.env.WHATSAPP_PHONE_ID &&
          this.env.WHATSAPP_BUSINESS_ID &&
          this.env.WHATSAPP_APP_SECRET
        ),
        active: this.store.active()?.id,
      });
    if (path === "/oauth/google/start" && method === "POST")
      return json({ url: await this.gmail.start() });
    if (path === "/oauth/google/callback" && method === "GET") {
      const state = url.searchParams.get("state"),
        code = url.searchParams.get("code");
      if (!state || !code || state.length > 200 || code.length > 2000)
        throw new HttpError(400, "Missing OAuth state or code");
      await this.gmail.finish(state, code);
      return new Response(
        "Gmail connected (read-only). You can close this tab.",
        {
          headers: {
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
            "Content-Security-Policy": "default-src 'none'",
          },
        },
      );
    }
    if (path === "/v1/gmail" && method === "DELETE") {
      if (this.requests > 1 || this.store.active())
        throw new HttpError(
          409,
          "Wait for active requests before disconnecting Gmail",
        );
      await this.gmail.disconnect();
      return json({
        disconnected: true,
        note: "Also revoke access in your Google Account. Historical transcripts remain until /v1/reset.",
      });
    }
    if (path === "/v1/reset" && method === "POST") {
      this.resetting = true;
      try {
        if (
          this.requests > 1 ||
          this.driving ||
          this.store
            .list()
            .some((m) =>
              ["queued", "running", "ready", "attempted"].includes(m.status),
            ) ||
          (await this.harness.pending()).length
        )
          throw new HttpError(409, "Finish or delete pending deliveries first");
        await this.lifecycle.dispose();
        await this.lifecycle.disableAlarms();
        await this.ctx.storage.deleteAll();
        this.store = new Store(this.ctx.storage);
        this.gmail = new Gmail(this.ctx.storage, this.env);
        this.harness = createPi(this.env, this.gmail, this.store, () =>
          this.store.consume("generation"),
        );
        this.lifecycle = new Lifecycle(this).use(this.harness);
        return json({
          reset: true,
          note: "Gmail credentials, all transcripts, receipts and dedupe history deleted. Use new inbound IDs; old messages can now be admitted again.",
        });
      } finally {
        this.resetting = false;
      }
    }
    throw new HttpError(404, "Not found");
  }
  async onJob(
    _context: LifecycleJobContext,
  ): Promise<{ rescheduleAt: number } | undefined> {
    if (this.resetting) return { rescheduleAt: Date.now() + 1000 };
    this.driving = true;
    try {
      return await this.drive();
    } finally {
      this.driving = false;
    }
  }
  private async drive(): Promise<{ rescheduleAt: number } | undefined> {
    // Attempt markers survive crashes; never automatically repeat an external send.
    for (const m of this.store.list()) {
      if (m.status === "attempted" && m.channel === "whatsapp") {
        m.status = "unknown";
        this.store.save(m);
      }
    }
    let m = this.store.active();
    if (!m) {
      m = this.store.list().find((m) => m.status === "queued");
      if (m) {
        m.status = "running";
        m.started = Date.now();
        this.store.save(m);
      }
    }
    if (m) {
      // Each request gets its own context, preventing cross-request source instructions.
      if (!m.session) {
        const session = await this.harness.sessions.create();
        m.session = session.id;
        this.store.save(m);
      }
      if (Date.now() - (m.started ?? m.created) > 120000) {
        await this.harness.abort({ operationId: m.id, session: m.session });
        m.response =
          "This request exceeded its time budget. Please try a smaller request.";
        m.status = "ready";
        this.store.save(m);
      } else {
        await this.harness.submit(
          "Today: " +
            new Date().toISOString().slice(0, 10) +
            "\nOwner request:\n" +
            m.text,
          { operationId: m.id, session: m.session },
        );
        try {
          const outcome = await this.harness.wait(m.id, {
            session: m.session,
            signal: AbortSignal.timeout(500),
          });
          // Tools update persisted budgets while wait is running; do not overwrite them.
          m = this.store.get(m.id)!;
          m.response =
            outcome.status === "done" && outcome.text?.trim()
              ? outcome.text.slice(0, 3800)
              : "I couldn't complete this request. Check integration setup or ask a smaller question.";
          m.status = "ready";
          this.store.save(m);
        } catch {
          // A bounded wait timing out leaves Pi work durable, not a failed run.
          return { rescheduleAt: Date.now() + 2000 };
        }
      }
    }
    for (const reply of this.store
      .list()
      .filter((m) => m.status === "ready" && m.channel === "whatsapp")
      .slice(0, 1)) {
      if (reply.channel === "api") continue;
      if (reply.channel === "imessage") continue; // Local bridge explicitly claims.
      if (Date.now() - reply.created >= 23 * 3600000) {
        reply.status = "failed";
        this.store.save(reply);
        continue;
      }
      reply.status = "attempted";
      reply.attempts++;
      this.store.save(reply);
      const sent = await sendWhatsApp(
        this.env,
        reply.response ?? "No response",
      );
      // Persist the attempt before this side effect, and its outcome after.
      Object.assign(reply, sent);
      this.store.save(reply);
    }
    return this.store
      .list()
      .some(
        (m) =>
          ["queued", "running"].includes(m.status) ||
          (m.channel === "whatsapp" && m.status === "ready"),
      )
      ? { rescheduleAt: Date.now() + 2000 }
      : undefined;
  }
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url),
        path = url.pathname;
      if (path === "/health" && request.method === "GET")
        return json({ ok: true, version: "0.1.0" });
      if (
        !env.ADMIN_TOKEN ||
        !env.BRIDGE_TOKEN ||
        env.ADMIN_TOKEN.length < 32 ||
        env.BRIDGE_TOKEN.length < 32 ||
        (await equal(env.ADMIN_TOKEN, env.BRIDGE_TOKEN)) ||
        !env.TOKEN_KEY
      )
        throw new HttpError(
          503,
          "Configure distinct admin/bridge tokens and encryption key",
        );
      if (path === "/webhooks/whatsapp") {
        if (request.method === "GET") return verification(url, env);
        if (request.method !== "POST")
          throw new HttpError(405, "Method not allowed");
        const messages = await parseWebhook(request, env);
        if (!messages.length) return json({ accepted: true });
        return await env.ASSISTANT.get(env.ASSISTANT.idFromName("owner")).fetch(
          new Request("https://internal/internal/whatsapp", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ messages }),
          }),
        );
      }
      const callback =
        path === "/oauth/google/callback" && request.method === "GET";
      const isBridge =
        path === "/bridge/inbox" ||
        path === "/bridge/outbox" ||
        /^\/bridge\/outbox\/[A-Za-z0-9_-]+\/(claim|ack)$/.test(path);
      const isAdmin =
        path === "/v1/messages" ||
        /^\/v1\/messages\/[A-Za-z0-9_-]+(\/retry)?$/.test(path) ||
        [
          "/v1/status",
          "/v1/gmail",
          "/v1/reset",
          "/oauth/google/start",
        ].includes(path);
      if (!callback && !isBridge && !isAdmin)
        throw new HttpError(404, "Not found");
      if (
        !callback &&
        !(await authorized(
          request,
          isBridge ? env.BRIDGE_TOKEN : env.ADMIN_TOKEN,
        ))
      )
        throw new HttpError(401, "Unauthorized");
      return await env.ASSISTANT.get(env.ASSISTANT.idFromName("owner")).fetch(
        request,
      );
    } catch (e) {
      return json(
        { error: e instanceof HttpError ? e.message : "Internal error" },
        e instanceof HttpError ? e.status : 500,
      );
    }
  },
} satisfies ExportedHandler<Env>;
