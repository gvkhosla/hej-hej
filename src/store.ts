import { HttpError, type Channel, type Message } from "./types";
/** Synchronous SQL keeps admissions, quota and transitions atomic across awaits. */
export class Store {
  constructor(private storage: DurableObjectStorage) {
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS app_messages (id TEXT PRIMARY KEY, created INTEGER NOT NULL, data TEXT NOT NULL)",
    );
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS app_quota (day TEXT PRIMARY KEY, count INTEGER NOT NULL)",
    );
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
  }
  get(id: string): Message | undefined {
    const row = this.storage.sql
      .exec<{ data: string }>("SELECT data FROM app_messages WHERE id = ?", id)
      .toArray()[0];
    return row ? JSON.parse(row.data) : undefined;
  }
  save(m: Message): void {
    this.storage.sql.exec(
      "INSERT INTO app_messages (id,created,data) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      m.id,
      m.created,
      JSON.stringify(m),
    );
  }
  list(): Message[] {
    return this.storage.sql
      .exec<{ data: string }>(
        "SELECT data FROM app_messages ORDER BY created,id LIMIT 1000",
      )
      .toArray()
      .map((r) => JSON.parse(r.data));
  }
  admit(id: string, channel: Channel, text: string, created: number): Message {
    return this.storage.transactionSync(() => {
      const prior = this.get(id);
      if (prior) {
        if (prior.text !== text || prior.channel !== channel)
          throw new HttpError(
            409,
            "Idempotency key reused with different input",
          );
        return prior;
      }
      const all = this.list();
      if (
        all.filter((m) => ["queued", "running"].includes(m.status)).length >= 10
      )
        throw new HttpError(429, "Queue full");
      if (all.length >= 1000)
        throw new HttpError(
          429,
          "Storage limit reached; delete finished messages",
        );
      const day = new Date().toISOString().slice(0, 10);
      const count =
        this.storage.sql
          .exec<{ count: number }>(
            "SELECT count FROM app_quota WHERE day=?",
            day,
          )
          .toArray()[0]?.count ?? 0;
      if (count >= 50) throw new HttpError(429, "Daily message limit reached");
      this.storage.sql.exec(
        "INSERT INTO app_quota(day,count) VALUES (?,1) ON CONFLICT(day) DO UPDATE SET count=count+1",
        day,
      );
      this.storage.sql.exec("DELETE FROM app_quota WHERE day < ?", day);
      const m: Message = {
        id,
        channel,
        text,
        created,
        status: "queued",
        attempts: 0,
      };
      this.save(m);
      return m;
    });
  }
  active(): Message | undefined {
    return this.list().find((m) => m.status === "running");
  }
  consume(kind: "tool" | "generation"): void {
    const m = this.active();
    if (!m || !m.started || Date.now() - m.started > 120000)
      throw new Error("Request expired");
    const field = kind === "tool" ? "tools" : "generations";
    if ((m[field] ?? 0) >= 8) throw new Error("Request budget exhausted");
    m[field] = (m[field] ?? 0) + 1;
    this.save(m);
  }
  query(): string | undefined {
    const text = this.active()?.text ?? "";
    const match = /^\/research\s+([\s\S]+)$/i.exec(text);
    return match && match[1].length <= 400 ? match[1].trim() : undefined;
  }
  remember(urls: string[]): void {
    const m = this.active();
    if (m) {
      m.urls = urls;
      this.save(m);
    }
  }
  allowed(url: string): boolean {
    return this.active()?.urls?.includes(url) ?? false;
  }
  retry(id: string): Message {
    const m = this.get(id);
    if (
      !m ||
      !["failed", "unknown", "attempted"].includes(m.status) ||
      !m.response ||
      m.channel === "api"
    )
      throw new HttpError(409, "This delivery cannot be retried");
    if (m.attempts >= 3)
      throw new HttpError(409, "Delivery attempt limit reached");
    if (m.channel === "whatsapp" && Date.now() - m.created >= 23 * 3600000)
      throw new HttpError(409, "WhatsApp reply window expired");
    m.status = "ready";
    this.save(m);
    return m;
  }
  claim(id: string): Message {
    const m = this.get(id);
    if (!m || m.channel !== "imessage" || m.status !== "ready")
      throw new HttpError(409, "Not ready to claim");
    m.status = "attempted";
    m.attempts++;
    this.save(m);
    return m;
  }
  ack(
    id: string,
    attempt: number,
    status: "sent" | "unknown" | "failed",
  ): void {
    const m = this.get(id);
    if (!m || m.channel !== "imessage" || m.attempts !== attempt)
      throw new HttpError(409, "Stale delivery acknowledgement");
    if (m.status === status) return;
    if (m.status !== "attempted")
      throw new HttpError(409, "Delivery already settled");
    m.status = status;
    this.save(m);
  }
  remove(id: string): void {
    const m = this.get(id);
    if (!m) throw new HttpError(404, "Not found");
    if (["queued", "running"].includes(m.status))
      throw new HttpError(409, "Cannot delete active work");
    this.storage.sql.exec("DELETE FROM app_messages WHERE id=?", id);
  }
}
