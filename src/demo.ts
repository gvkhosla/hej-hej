import {
  fauxAssistantMessage,
  fauxText,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
/** Scripted, clearly labeled UX demo. Not an LLM, email reader or web search. */
export function demoResponse(context: TranscriptContext) {
  const last = [...context.messages]
    .reverse()
    .find((message) => message.role === "user");
  const content = last?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n")
        : "";
  const request = text.split("Owner request:\n").at(-1)?.trim() ?? "";
  const explanation = request.startsWith("/research")
    ? "In the real app, /research sends your explicit public topic to Tavily and returns cited sources. This offline demo does not search the internet."
    : /email|gmail|inbox/i.test(request)
      ? "In the real app, I can search and read your Gmail after readonly consent. This offline demo has no email account or inbox access."
      : "hej hej! Your message went through the real authenticated API, durable queue and Pi harness. The reply is scripted, not AI-generated.";
  return fauxAssistantMessage([
    fauxText(
      "[OFFLINE DEMO]\n" +
        explanation +
        "\n\nTry a real setup when you're ready: npm run setup, then npm run deploy.",
    ),
  ]);
}
