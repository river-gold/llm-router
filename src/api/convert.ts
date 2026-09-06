import type { ModelMessage } from "ai";

export interface OpenAIMessage {
  role: string;
  content?: string | Array<{ type?: string; text?: string; image_url?: { url: string } }>;
  name?: string;
  tool_calls?: Array<{
    id: string;
    type?: string;
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

const toolNameByCallId = (messages: OpenAIMessage[], id: string): string => {
  for (const m of messages) {
    for (const tc of m.tool_calls ?? []) {
      if (tc.id === id) return tc.function.name;
    }
  }
  return id;
};

const userContentToText = (
  content: OpenAIMessage["content"],
): Array<{ type: "text"; text: string } | { type: "image"; image: string }> => {
  if (!content) return [];
  if (typeof content === "string") return [{ type: "text", text: content }];
  const parts: Array<{ type: "text"; text: string } | { type: "image"; image: string }> = [];
  for (const p of content) {
    if (p.type === "image_url" && p.image_url?.url)
      parts.push({ type: "image", image: p.image_url.url });
    else if ((p.type === undefined || p.type === "text") && p.text) {
      parts.push({ type: "text", text: p.text });
    }
  }
  return parts;
};

/** OpenAI chat messages → AI SDK model messages. */
export const toModelMessages = (messages: OpenAIMessage[]): ModelMessage[] => {
  const out: ModelMessage[] = [];
  for (const m of messages) {
    if (m.role === "system" || m.role === "developer") {
      const text = typeof m.content === "string" ? m.content : "";
      if (text) out.push({ role: "system", content: text });
    } else if (m.role === "user") {
      const content = userContentToText(m.content);
      if (content.length > 0) out.push({ role: "user", content });
    } else if (m.role === "assistant") {
      const content: Array<
        | { type: "text"; text: string }
        | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
      > = [];
      if (typeof m.content === "string" && m.content)
        content.push({ type: "text", text: m.content });
      for (const tc of m.tool_calls ?? []) {
        let input: unknown = {};
        try {
          input = JSON.parse(tc.function.arguments || "{}");
        } catch {
          input = {};
        }
        content.push({
          type: "tool-call",
          toolCallId: tc.id,
          toolName: tc.function.name,
          input,
        });
      }
      if (content.length > 0) out.push({ role: "assistant", content });
    } else if (m.role === "tool") {
      const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
      out.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: m.tool_call_id ?? "",
            toolName: toolNameByCallId(messages, m.tool_call_id ?? ""),
            output: { type: "text", value: text },
          },
        ],
      });
    }
  }
  return out;
};
