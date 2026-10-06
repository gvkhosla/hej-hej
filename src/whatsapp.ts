import type { Env } from "./types";
import { HttpError } from "./types";
import { boundedText, validSignature } from "./security";
export interface IncomingWhatsApp {
  id: string;
  text: string;
  created: number;
}
export async function parseWebhook(
  request: Request,
  env: Env,
): Promise<IncomingWhatsApp[]> {
  const raw = await boundedText(request);
  if (
    !(await validSignature(
      raw,
      request.headers.get("x-hub-signature-256"),
      env.WHATSAPP_APP_SECRET,
    ))
  )
    throw new HttpError(401, "Invalid signature");
  if (
    !env.WHATSAPP_OWNER ||
    !env.WHATSAPP_PHONE_ID ||
    !env.WHATSAPP_BUSINESS_ID
  )
    throw new HttpError(503, "WhatsApp not configured");
  let payload: any;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "Invalid JSON");
  }
  const result: IncomingWhatsApp[] = [];
  if (payload.object !== "whatsapp_business_account") return result;
  for (const entry of (Array.isArray(payload.entry) ? payload.entry : []).slice(
    0,
    20,
  )) {
    if (entry.id !== env.WHATSAPP_BUSINESS_ID) continue;
    for (const change of (Array.isArray(entry.changes)
      ? entry.changes
      : []
    ).slice(0, 20)) {
      const value = change.value;
      if (
        change.field !== "messages" ||
        value?.metadata?.phone_number_id !== env.WHATSAPP_PHONE_ID
      )
        continue;
      for (const message of (Array.isArray(value.messages)
        ? value.messages
        : []
      ).slice(0, 20)) {
        const created = Number(message.timestamp) * 1000;
        if (
          message.from !== env.WHATSAPP_OWNER ||
          message.type !== "text" ||
          typeof message.id !== "string" ||
          message.id.length > 200 ||
          typeof message.text?.body !== "string" ||
          !message.text.body.trim() ||
          message.text.body.length > 8000 ||
          !Number.isFinite(created) ||
          created > Date.now() + 60000 ||
          Date.now() - created > 23 * 3600000
        )
          continue;
        result.push({ id: message.id, text: message.text.body, created });
      }
    }
  }
  return result.slice(0, 20);
}
export function verification(url: URL, env: Env): Response {
  // This token is only for Meta's setup challenge, never POST authentication.
  if (
    env.WHATSAPP_VERIFY_TOKEN &&
    url.searchParams.get("hub.mode") === "subscribe" &&
    url.searchParams.get("hub.verify_token") === env.WHATSAPP_VERIFY_TOKEN
  ) {
    const challenge = url.searchParams.get("hub.challenge");
    if (challenge && /^\d{1,100}$/.test(challenge))
      return new Response(challenge);
  }
  return new Response("Forbidden", { status: 403 });
}
export async function sendWhatsApp(
  env: Env,
  text: string,
): Promise<{ status: "sent" | "failed" | "unknown"; providerId?: string }> {
  if (
    !env.WHATSAPP_TOKEN ||
    !env.WHATSAPP_OWNER ||
    !env.WHATSAPP_PHONE_ID ||
    !/^v\d+\.0$/.test(env.WHATSAPP_GRAPH_VERSION)
  )
    return { status: "failed" };
  // One HTTP attempt; a timeout, malformed success or server error is ambiguous.
  try {
    const response = await fetch(
      "https://graph.facebook.com/" +
        env.WHATSAPP_GRAPH_VERSION +
        "/" +
        encodeURIComponent(env.WHATSAPP_PHONE_ID) +
        "/messages",
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(15000),
        headers: {
          Authorization: "Bearer " + env.WHATSAPP_TOKEN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: env.WHATSAPP_OWNER,
          type: "text",
          text: { preview_url: false, body: text.slice(0, 3800) },
        }),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      return { status: response.status >= 500 ? "unknown" : "failed" };
    }
    const data = JSON.parse(await boundedText(response)) as {
      messages?: { id?: string }[];
    };
    return typeof data.messages?.[0]?.id === "string"
      ? { status: "sent", providerId: data.messages[0].id }
      : { status: "unknown" };
  } catch {
    return { status: "unknown" };
  }
}
