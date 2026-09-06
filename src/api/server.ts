import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { loadConfig } from "../config";
import { resetFailures } from "../routing/failureMemory";
import { passthroughTools, routeRequest, type RouterEvent } from "../routing/delegate";
import { snapshot, loadState } from "../state";
import { toModelMessages, type OpenAIMessage } from "./convert";
import {
  buildResponsesResponse,
  collectRouteEvents,
  pipeToResponsesStream,
  responsesToolChoice,
  responsesToolsToToolSet,
  toModelMessagesFromResponses,
  type ResponsesRequestBody,
} from "./responses";
import type { RouterConfig, RouterTier } from "../types";

interface ServerState {
  config: RouterConfig;
  configPath?: string;
}

interface ResponsesRouteOptions {
  effort?: string;
  tools?: NonNullable<ReturnType<typeof responsesToolsToToolSet>>;
  toolChoice?: NonNullable<ReturnType<typeof responsesToolChoice>>;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
}

const responsesRouteOptions = (body: ResponsesRequestBody): ResponsesRouteOptions => {
  const effort = body.reasoning_effort ?? body.reasoning?.effort;
  const tools = responsesToolsToToolSet(body.tools);
  const toolChoice = responsesToolChoice(body.tool_choice);
  return {
    ...(effort ? { effort } : {}),
    ...(tools ? { tools } : {}),
    ...(toolChoice ? { toolChoice } : {}),
    ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
    ...(body.top_p !== undefined ? { topP: body.top_p } : {}),
    ...(body.max_output_tokens !== undefined
      ? { maxTokens: body.max_output_tokens }
      : body.max_tokens !== undefined
        ? { maxTokens: body.max_tokens }
        : {}),
  };
};

const state: ServerState = { config: { profiles: {} } };

export const reloadConfig = async (path?: string): Promise<void> => {
  if (path) state.configPath = path;
  const { config } = await loadConfig(state.configPath);
  state.config = config;
};

export const app = new Hono();

app.get("/v1/models", (c) => {
  const profiles = Object.keys(state.config.profiles);
  return c.json({
    object: "list",
    data: profiles.map((p) => ({
      id: `router/${p}`,
      object: "model",
      created: 0,
      owned_by: "llm-router",
    })),
  });
});

app.post("/v1/chat/completions", async (c) => {
  let body: {
    model?: string;
    messages?: OpenAIMessage[];
    tools?: Array<{
      type?: string;
      function: { name: string; description?: string; parameters: unknown };
    }>;
    tool_choice?: string | { type?: string; function?: { name: string } };
    reasoning_effort?: string;
    temperature?: number;
    top_p?: number;
    max_tokens?: number;
    stream?: boolean;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { message: "Invalid JSON body.", type: "invalid_request_error" } }, 400);
  }
  if (!body.model || !Array.isArray(body.messages)) {
    return c.json(
      { error: { message: 'Expected "model" and "messages".', type: "invalid_request_error" } },
      400,
    );
  }
  const match = /^router\/([^/]+)(?:\/([^/]+))?$/.exec(body.model);
  if (!match) {
    return c.json(
      {
        error: {
          message: `Model "${body.model}" not served. Use "router/<profile>[/<tier>]".`,
          type: "invalid_request_error",
        },
      },
      404,
    );
  }
  const tools =
    body.tools && body.tools.length > 0
      ? passthroughTools(
          Object.fromEntries(
            body.tools
              .filter((t) => t?.function?.name)
              .map((t) => [
                t.function.name,
                { description: t.function.description, parameters: t.function.parameters },
              ]),
          ),
        )
      : undefined;
  const toolChoice =
    typeof body.tool_choice === "string" ? (body.tool_choice as "auto" | "none") : undefined;

  if (!body.stream) {
    let finishReason = "stop";
    let usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    const texts: string[] = [];
    const toolCalls: Array<{ id: string; name: string; args: string[] }> = [];
    try {
      for await (const event of routeRequest(state.config, {
        profile: match[1],
        ...(match[2] ? { explicitTier: match[2] as RouterTier } : {}),
        effort: body.reasoning_effort,
        messages: toModelMessages(body.messages!),
        ...(tools ? { tools } : {}),
        ...(toolChoice ? { toolChoice } : {}),
        ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
        ...(body.top_p !== undefined ? { topP: body.top_p } : {}),
        ...(body.max_tokens !== undefined ? { maxTokens: body.max_tokens } : {}),
      })) {
        if (event.type === "text-delta") texts.push(event.text);
        else if (event.type === "tool-call-delta") {
          const existing = toolCalls.find((t) => t.id === event.id);
          if (!existing) {
            toolCalls.push({
              id: event.id,
              name: event.name ?? "",
              args: event.argsDelta ? [event.argsDelta] : [],
            });
          } else if (event.argsDelta) {
            existing.args.push(event.argsDelta);
            if (event.name) existing.name = event.name;
          }
        } else if (event.type === "done") {
          finishReason = event.finishReason;
          usage = event.usage;
        }
      }
    } catch (e) {
      const status = (e as { status?: number }).status ?? 500;
      return c.json(
        { error: { message: (e as Error).message, type: "router_error" } },
        status as 500,
      );
    }
    return c.json({
      id: `router-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: body.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant" as const,
            content: texts.join("") || null,
            ...(toolCalls.length > 0
              ? {
                  tool_calls: toolCalls.map((t) => ({
                    id: t.id,
                    type: "function" as const,
                    function: { name: t.name, arguments: t.args.join("") },
                  })),
                }
              : {}),
          },
          finish_reason: finishReason,
        },
      ],
      usage: {
        prompt_tokens: usage.inputTokens,
        completion_tokens: usage.outputTokens,
        total_tokens: usage.totalTokens,
      },
    });
  }

  const created = Math.floor(Date.now() / 1000);
  const id = `router-${Date.now()}`;
  return streamSSE(c, async (stream) => {
    const toolCalls = new Map<string, { name: string; args: string[] }>();
    const send = async (data: unknown) => {
      await stream.writeSSE({ data: JSON.stringify(data) });
    };
    try {
      for await (const event of routeRequest(state.config, {
        profile: match[1],
        ...(match[2] ? { explicitTier: match[2] as RouterTier } : {}),
        effort: body.reasoning_effort,
        messages: toModelMessages(body.messages!),
        ...(tools ? { tools } : {}),
        ...(toolChoice ? { toolChoice } : {}),
        ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
        ...(body.top_p !== undefined ? { topP: body.top_p } : {}),
        ...(body.max_tokens !== undefined ? { maxTokens: body.max_tokens } : {}),
      })) {
        if (event.type === "text-delta") {
          await send({
            id,
            object: "chat.completion.chunk",
            created,
            model: body.model,
            choices: [
              { index: 0, delta: { role: "assistant", content: event.text }, finish_reason: null },
            ],
          });
        } else if (event.type === "reasoning-delta") {
          await send({
            id,
            object: "chat.completion.chunk",
            created,
            model: body.model,
            choices: [{ index: 0, delta: { reasoning_content: event.text }, finish_reason: null }],
          });
        } else if (event.type === "tool-call-delta") {
          const entry = toolCalls.get(event.id) ?? { name: "", args: [] };
          if (event.name) entry.name = event.name;
          if (event.argsDelta) entry.args.push(event.argsDelta);
          toolCalls.set(event.id, entry);
          const index = [...toolCalls.keys()].indexOf(event.id);
          await send({
            id,
            object: "chat.completion.chunk",
            created,
            model: body.model,
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index,
                      id: event.name ? event.id : undefined,
                      type: "function",
                      function: {
                        ...(event.name ? { name: event.name } : {}),
                        ...(event.argsDelta ? { arguments: event.argsDelta } : {}),
                      },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          });
        } else if (event.type === "done") {
          await send({
            id,
            object: "chat.completion.chunk",
            created,
            model: body.model,
            choices: [{ index: 0, delta: {}, finish_reason: event.finishReason }],
            usage: {
              prompt_tokens: event.usage.inputTokens,
              completion_tokens: event.usage.outputTokens,
              total_tokens: event.usage.totalTokens,
            },
          });
        }
      }
    } catch (e) {
      await send({ error: { message: (e as Error).message, type: "router_error" } });
    }
    await stream.writeSSE({ data: "[DONE]" });
  });
});

const RESPONSES_MODEL_RE = /^router\/([^/]+)(?:\/([^/]+))?$/;

app.post("/v1/responses", async (c) => {
  let body: ResponsesRequestBody;
  try {
    body = (await c.req.json()) as ResponsesRequestBody;
  } catch {
    return c.json({ error: { message: "Invalid JSON body.", type: "invalid_request_error" } }, 400);
  }
  if (!body.model || body.input === undefined || body.input === null) {
    return c.json(
      { error: { message: 'Expected "model" and "input".', type: "invalid_request_error" } },
      400,
    );
  }
  const match = RESPONSES_MODEL_RE.exec(body.model);
  if (!match) {
    return c.json(
      {
        error: {
          message: `Model "${body.model}" not served. Use "router/<profile>[/<tier>]".`,
          type: "invalid_request_error",
        },
      },
      404,
    );
  }
  if (body.background === true) {
    return c.json(
      {
        error: {
          message: "Background mode is not supported. Retry without background.",
          type: "invalid_request_error",
        },
      },
      400,
    );
  }
  const model = body.model;
  const input = body.input;
  const profile = match[1] as string;
  const explicitTier = match[2] as RouterTier | undefined;
  const routeOptions = responsesRouteOptions(body);

  if (!body.stream) {
    try {
      const collected = await collectRouteEvents(
        routeRequest(state.config, {
          profile,
          ...(explicitTier ? { explicitTier } : {}),
          ...routeOptions,
          messages: toModelMessagesFromResponses(input, body.instructions),
        }),
      );
      return c.json(
        buildResponsesResponse({
          model,
          text: collected.text,
          reasoning: collected.reasoning || undefined,
          toolCalls: collected.toolCalls,
          finishReason: collected.finishReason,
          usage: collected.usage,
        }),
      );
    } catch (e) {
      const status = (e as { status?: number }).status ?? 500;
      return c.json(
        { error: { message: (e as Error).message, type: "router_error" } },
        status as 500,
      );
    }
  }

  const baseRoute = {
    profile,
    ...(explicitTier ? { explicitTier } : {}),
    ...routeOptions,
    messages: toModelMessagesFromResponses(input, body.instructions),
  };
  const streamEvents = (): AsyncIterable<RouterEvent> => routeRequest(state.config, baseRoute);

  return streamSSE(c, (stream) =>
    pipeToResponsesStream(streamEvents(), model, (event, data) =>
      stream.writeSSE({ event, data: JSON.stringify(data) }),
    ),
  );
});

app.get("/router/status", async (c) => {
  await loadState();
  const { debugHistory: _omit, ...rest } = snapshot();
  return c.json({
    ...rest,
    profiles: Object.keys(state.config.profiles),
    debugEnabled: state.config.debug ?? false,
  });
});

app.get("/router/debug", async (c) => {
  await loadState();
  return c.json({ history: snapshot().debugHistory });
});

app.post("/router/reload", async (c) => {
  try {
    await reloadConfig();
    return c.json({ ok: true, profiles: Object.keys(state.config.profiles) });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 500);
  }
});

app.post("/router/reset-failures", async (c) => {
  let profile: string | undefined;
  try {
    const body = await c.req.json();
    profile = body.profile;
  } catch {
    profile = undefined;
  }
  return c.json({ ok: true, cleared: resetFailures(profile) });
});
