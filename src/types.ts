import type { Assistant } from "./worker";
export interface Env {
  ASSISTANT: DurableObjectNamespace<Assistant>;
  AI: Ai;
  ADMIN_TOKEN: string;
  BRIDGE_TOKEN: string;
  TOKEN_KEY: string;
  PUBLIC_URL: string;
  OWNER_EMAIL: string;
  MODEL_ID: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  TAVILY_API_KEY?: string;
  WHATSAPP_APP_SECRET?: string;
  WHATSAPP_VERIFY_TOKEN?: string;
  WHATSAPP_TOKEN?: string;
  WHATSAPP_OWNER?: string;
  WHATSAPP_PHONE_ID?: string;
  WHATSAPP_BUSINESS_ID?: string;
  WHATSAPP_GRAPH_VERSION: string;
  TEST_MODE?: string;
}
export type Channel = "api" | "imessage" | "whatsapp";
export interface Message {
  id: string;
  channel: Channel;
  text: string;
  created: number;
  status:
    | "queued"
    | "running"
    | "ready"
    | "attempted"
    | "sent"
    | "failed"
    | "unknown";
  response?: string;
  providerId?: string;
  attempts: number;
  session?: string;
  started?: number;
  tools?: number;
  generations?: number;
  urls?: string[];
}
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
