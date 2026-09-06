import type { ModelMessage, ToolSet } from "ai";
import { passthroughTools, type RouterEvent } from "../routing/delegate";

export interface ResponsesContentPart {
  type?: string;
  text?: string;
  image_url?: string | { url?: string };
  refusal?: string;
}

export interface ResponsesInputItem {
  type?: string;
  role?: string;
  content?: string | ResponsesContentPart[];
  status?: string;
  call_id?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
  output?: unknown;
  summary?: unknown;
}

export type ResponsesInput = string | ResponsesInputItem[];

export interface ResponsesFunctionTool {
  type?: string;
  name?: string;
  description?: string;
  parameters?: unknown;
  strict?: boolean;
}

export interface ResponsesRequestBody {
  model?: string;
  input?: ResponsesInput;
  instructions?: string;
  tools?: ResponsesFunctionTool[];
  tool_choice?: string | { type?: string; name?: string };
  reasoning?: { effort?: string };
  reasoning_effort?: string;
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  max_tokens?: number;
  stream?: boolean;
  background?: boolean;
}

const parseToolArguments = (value: unknown): unknown => {
  if (typeof value === "string") {
    if (!value) return {};
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return {};
    }
  }
  if (typeof value === "number" || typeof value === "boolean") return { _raw: value };
  return value !== null && typeof value === "object" ? value : {};
};

const outputToString = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (typeof value === "undefined" || value === null) return "";
  const encoded = JSON.stringify(value);
  return typeof encoded === "string" ? encoded : "";
};

const toolNameByCallId = (items: ResponsesInputItem[], callId: string): string => {
  for (const item of items) {
    if (!item || item.type !== "function_call") continue;
    const id = item.call_id ?? item.id;
    if (id !== undefined && id === callId && item.name) return item.name;
  }
  return callId;
};

const isTextPart = (part: ResponsesContentPart): boolean =>
  part.type === undefined ||
  part.type === "text" ||
  part.type === "input_text" ||
  part.type === "output_text";

/** Single part → message text (refusal text included). */
const partText = (part: ResponsesContentPart): string => {
  if (typeof part.refusal === "string" && part.refusal) return part.refusal;
  return typeof part.text === "string" && part.text && isTextPart(part) ? part.text : "";
};

/** Image URL from a string or `{ url }` object. */
const imagePartUrl = (value: ResponsesContentPart["image_url"]): string | undefined => {
  const url = typeof value === "string" ? value : (value as { url?: unknown } | undefined)?.url;
  return typeof url === "string" && url ? url : undefined;
};

/** Message text from a string or content parts (incl. refusal text). */
const textParts = (content: string | ResponsesContentPart[] | undefined): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(partText).join("");
};

const userContent = (
  content: string | ResponsesContentPart[] | undefined,
): Array<{ type: "text"; text: string } | { type: "image"; image: string }> => {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  const parts: Array<{ type: "text"; text: string } | { type: "image"; image: string }> = [];
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue;
    const text = partText(part);
    const imageUrl =
      part.type === "input_image" || part.type === "image_url"
        ? imagePartUrl(part.image_url)
        : undefined;
    if (imageUrl) parts.push({ type: "image", image: imageUrl });
    else if (text) parts.push({ type: "text", text });
  }
  return parts;
};

/** Responses `input` → AI SDK model messages. `instructions` becomes the leading system message. */
export const toModelMessagesFromResponses = (
  input: ResponsesInput,
  instructions?: string,
): ModelMessage[] => {
  const out: ModelMessage[] = [];
  if (typeof instructions === "string" && instructions) {
    out.push({ role: "system", content: instructions });
  }
  if (typeof input === "string") {
    if (input) out.push({ role: "user", content: [{ type: "text", text: input }] });
    return out;
  }
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "function_call") {
      if (!item.name) continue;
      out.push({
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: item.call_id ?? item.id ?? item.name,
            toolName: item.name,
            input: parseToolArguments(item.arguments),
          },
        ],
      });
      continue;
    }
    if (item.type === "function_call_output") {
      const callId = item.call_id ?? item.id ?? "";
      out.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: callId,
            toolName: toolNameByCallId(input, callId),
            output: { type: "text", value: outputToString(item.output) },
          },
        ],
      });
      continue;
    }
    if (item.type === "reasoning") continue;
    const role = item.role ?? "user";
    if (role === "system" || role === "developer") {
      const text = textParts(item.content);
      if (text) out.push({ role: "system", content: text });
    } else if (role === "user") {
      const content = userContent(item.content);
      if (content.length > 0) out.push({ role: "user", content });
    } else if (role === "assistant") {
      const text = textParts(item.content);
      if (text) out.push({ role: "assistant", content: [{ type: "text", text }] });
    }
  }
  return out;
};

/** Responses function tools → AI SDK tool set. Non-function tools are ignored. */
export const responsesToolsToToolSet = (tools?: ResponsesFunctionTool[]): ToolSet | undefined => {
  if (!tools || tools.length === 0) return undefined;
  const entries: Record<string, { description?: string; parameters: unknown }> = {};
  for (const t of tools) {
    if (!t || (t.type !== undefined && t.type !== "function") || !t.name) continue;
    entries[t.name] = { description: t.description, parameters: t.parameters };
  }
  if (Object.keys(entries).length === 0) return undefined;
  return passthroughTools(entries);
};

export const responsesToolChoice = (
  choice: ResponsesRequestBody["tool_choice"],
): "auto" | "none" | "required" | undefined => {
  if (typeof choice === "string") {
    if (choice === "auto" || choice === "none" || choice === "required") return choice;
    return undefined;
  }
  if (choice && typeof choice === "object") {
    if (choice.type === "function") return "required";
    return undefined;
  }
  return undefined;
};

export interface CollectedRoute {
  text: string;
  reasoning: string;
  toolCalls: Array<{ id: string; name: string; args: string }>;
  finishReason: string;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
}

/** Drain route events into text / reasoning / tool calls / usage. Unknown events are ignored. */
export const collectRouteEvents = async (
  events: AsyncIterable<RouterEvent>,
): Promise<CollectedRoute> => {
  let finishReason = "stop";
  let usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const texts: string[] = [];
  const reasoning: string[] = [];
  const toolCalls: CollectedRoute["toolCalls"] = [];
  for await (const event of events) {
    if (event.type === "text-delta") texts.push(event.text);
    else if (event.type === "reasoning-delta") reasoning.push(event.text);
    else if (event.type === "tool-call-delta") {
      const existing = toolCalls.find((t) => t.id === event.id);
      if (!existing) {
        toolCalls.push({ id: event.id, name: event.name ?? "", args: event.argsDelta ?? "" });
      } else {
        existing.args += event.argsDelta ?? "";
        if (event.name) existing.name = event.name;
      }
    } else if (event.type === "done") {
      finishReason = event.finishReason;
      usage = event.usage;
    }
  }
  return { text: texts.join(""), reasoning: reasoning.join(""), toolCalls, finishReason, usage };
};

export interface ResponsesOutput {
  model: string;
  id?: string;
  createdAt?: number;
  text: string;
  reasoning?: string;
  toolCalls?: Array<{ id: string; name: string; args: string }>;
  finishReason?: string;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
}

/** Collected route output → Responses API response object. */
export const buildResponsesResponse = (args: ResponsesOutput): Record<string, unknown> => {
  const id = args.id ?? `resp-${Date.now()}`;
  const createdAt = args.createdAt ?? Math.floor(Date.now() / 1000);
  const usage = args.usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const status =
    args.finishReason === undefined ||
    args.finishReason === "stop" ||
    args.finishReason === "tool_calls"
      ? "completed"
      : "incomplete";
  const output: Record<string, unknown>[] = [];
  if (args.reasoning) {
    output.push({
      type: "reasoning",
      id: `rs-${Date.now()}`,
      status: "completed",
      summary: [{ type: "summary_text", text: args.reasoning }],
    });
  }
  output.push({
    type: "message",
    id: `msg-${Date.now()}`,
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text: args.text, annotations: [] }],
  });
  for (const tc of args.toolCalls ?? []) {
    output.push({
      type: "function_call",
      id: `fc-${Date.now()}`,
      call_id: tc.id,
      status: "completed",
      name: tc.name,
      arguments: tc.args,
    });
  }
  return {
    id,
    object: "response",
    created_at: createdAt,
    model: args.model,
    status,
    output,
    usage: {
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      total_tokens: usage.totalTokens,
    },
  };
};

export type ResponsesSend = (event: string, data: unknown) => Promise<void> | void;

interface StreamToolCall {
  id: string;
  itemId: string;
  outputIndex: number;
  name: string;
  args: string[];
}

/**
 * Route events → Responses SSE (`response.created` … `response.completed`).
 * Failures mid-stream are reported as `response.failed`. No `[DONE]` terminator:
 * the stream ends with `response.completed`.
 */
export const pipeToResponsesStream = async (
  events: AsyncIterable<RouterEvent>,
  model: string,
  send: ResponsesSend,
): Promise<void> => {
  const id = `resp-${Date.now()}`;
  const createdAt = Math.floor(Date.now() / 1000);
  let seq = 0;
  const emit = async (event: string, data: Record<string, unknown>): Promise<void> => {
    const n = seq;
    seq += 1;
    await send(event, { ...data, sequence_number: n });
  };
  await emit("response.created", {
    type: "response.created",
    response: {
      id,
      object: "response",
      created_at: createdAt,
      model,
      status: "in_progress",
      output: [],
    },
  });
  const msgId = `msg-${Date.now()}`;
  const reasoningId = `rs-${Date.now()}`;
  let messageIndex: number | undefined;
  let reasoningIndex: number | undefined;
  let nextIndex = 0;
  const texts: string[] = [];
  const reasoningTexts: string[] = [];
  const toolCalls: StreamToolCall[] = [];
  let finishReason = "stop";
  let usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  try {
    for await (const event of events) {
      if (event.type === "text-delta") {
        if (messageIndex === undefined) {
          messageIndex = nextIndex;
          nextIndex += 1;
          await emit("response.output_item.added", {
            type: "response.output_item.added",
            output_index: messageIndex,
            item: {
              type: "message",
              id: msgId,
              status: "in_progress",
              role: "assistant",
              content: [],
            },
          });
        } else {
          texts.push(event.text);
        }
        texts.push(event.text);
        await emit("response.output_text.delta", {
          type: "response.output_text.delta",
          item_id: msgId,
          output_index: messageIndex,
          content_index: 0,
          delta: event.text,
        });
      } else if (event.type === "reasoning-delta") {
        if (reasoningIndex === undefined) {
          reasoningIndex = nextIndex;
          nextIndex += 1;
          await emit("response.output_item.added", {
            type: "response.output_item.added",
            output_index: reasoningIndex,
            item: { type: "reasoning", id: reasoningId, status: "in_progress" },
          });
        }
        reasoningTexts.push(event.text);
        await emit("response.reasoning_summary_text.delta", {
          type: "response.reasoning_summary_text.delta",
          item_id: reasoningId,
          output_index: reasoningIndex,
          summary_index: 0,
          delta: event.text,
        });
      } else if (event.type === "tool-call-delta") {
        let entry = toolCalls.find((t) => t.id === event.id);
        if (!entry) {
          entry = {
            id: event.id,
            itemId: `fc-${Date.now()}-${toolCalls.length}`,
            outputIndex: nextIndex,
            name: event.name ?? "",
            args: [],
          };
          nextIndex += 1;
          toolCalls.push(entry);
          await emit("response.output_item.added", {
            type: "response.output_item.added",
            output_index: entry.outputIndex,
            item: {
              type: "function_call",
              id: entry.itemId,
              call_id: entry.id,
              status: "in_progress",
              name: entry.name,
              arguments: "",
            },
          });
        }
        if (event.argsDelta) {
          entry.args.push(event.argsDelta);
          await emit("response.function_call_arguments.delta", {
            type: "response.function_call_arguments.delta",
            item_id: entry.itemId,
            output_index: entry.outputIndex,
            delta: event.argsDelta,
          });
        }
        if (event.name) entry.name = event.name;
      } else if (event.type === "done") {
        finishReason = event.finishReason;
        usage = event.usage;
      }
    }
  } catch (e) {
    await emit("response.failed", {
      type: "response.failed",
      response: {
        id,
        object: "response",
        created_at: createdAt,
        model,
        status: "failed",
        error: { message: (e as Error).message },
      },
    });
    return;
  }
  if (messageIndex !== undefined) {
    await emit("response.output_item.done", {
      type: "response.output_item.done",
      output_index: messageIndex,
      item: {
        type: "message",
        id: msgId,
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: texts.join(""), annotations: [] }],
      },
    });
  }
  if (reasoningIndex !== undefined) {
    await emit("response.output_item.done", {
      type: "response.output_item.done",
      output_index: reasoningIndex,
      item: {
        type: "reasoning",
        id: reasoningId,
        status: "completed",
        summary: [{ type: "summary_text", text: reasoningTexts.join("") }],
      },
    });
  }
  for (const tc of toolCalls) {
    await emit("response.output_item.done", {
      type: "response.output_item.done",
      output_index: tc.outputIndex,
      item: {
        type: "function_call",
        id: tc.itemId,
        call_id: tc.id,
        status: "completed",
        name: tc.name,
        arguments: tc.args.join(""),
      },
    });
  }
  const response = buildResponsesResponse({
    model,
    id,
    createdAt,
    text: texts.join(""),
    reasoning: reasoningTexts.join("") || undefined,
    toolCalls: toolCalls.map((t) => ({ id: t.id, name: t.name, args: t.args.join("") })),
    finishReason,
    usage,
  });
  await emit("response.completed", { type: "response.completed", response });
};
