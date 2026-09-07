import { describe, expect, it } from "vitest";
import {
  buildResponsesResponse,
  collectRouteEvents,
  pipeToResponsesStream,
  responsesToolChoice,
  responsesToolsToToolSet,
  toModelMessagesFromResponses,
} from "../src/api/responses";
import type { RouterEvent } from "../src/routing/delegate";

function streamOf(events: unknown[]): AsyncIterable<RouterEvent> {
  return (async function* () {
    for (const e of events) yield e as RouterEvent;
  })();
}

function rejectingStream(error: Error): AsyncIterable<never> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => Promise.reject(error),
      return: () => Promise.resolve({ done: true as const, value: undefined }),
      throw: (e: unknown) => Promise.reject(e),
    }),
  };
}

const done = (finishReason = "stop") =>
  streamOf([
    { type: "text-delta", text: "hi" },
    { type: "text-delta", text: "!" },
    {
      type: "done",
      finishReason,
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    },
  ]);

describe("toModelMessagesFromResponses 함수", () => {
  it("instructions와 함께 문자열 입력을 매핑한다", () => {
    expect(toModelMessagesFromResponses("hello", "be brief")).toEqual([
      { role: "system", content: "be brief" },
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ]);
  });

  it("여러 역할과 도구 히스토리에 걸쳐 항목 목록을 매핑한다", () => {
    const messages = toModelMessagesFromResponses([
      { role: "system", content: "sys" },
      { role: "developer", content: [{ type: "input_text", text: "dev" }] },
      { role: "user", content: [{ type: "input_text", text: "q" }] },
      {
        role: "user",
        content: [
          { type: "input_image", image_url: { url: "https://img" } },
          { type: "input_image", image_url: "https://direct" },
        ],
      },
      { role: "assistant", content: [{ type: "output_text", text: "a" }] },
      { role: "assistant", content: [{ type: "refusal", refusal: "no" }] },
      {
        type: "function_call",
        call_id: "c1",
        name: "search",
        arguments: '{"q":"x"}',
      },
      { type: "function_call_output", call_id: "c1", output: { ok: true } },
      { type: "reasoning" },
      { role: "unknown" },
      null as never,
      { role: "user" },
      { role: "system", content: "" },
      { role: "user", content: "" },
      { role: "assistant", content: "" },
      {},
    ]);
    expect(messages).toEqual([
      { role: "system", content: "sys" },
      { role: "system", content: "dev" },
      { role: "user", content: [{ type: "text", text: "q" }] },
      {
        role: "user",
        content: [
          { type: "image", image: "https://img" },
          { type: "image", image: "https://direct" },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "a" }] },
      { role: "assistant", content: [{ type: "text", text: "no" }] },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "c1", toolName: "search", input: { q: "x" } }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "search",
            output: { type: "text", value: '{"ok":true}' },
          },
        ],
      },
    ]);
  });

  it("잘못된 콘텐츠와 인자를 너그럽게 처리한다", () => {
    const messages = toModelMessagesFromResponses([
      { role: "user", content: "x" },
      {
        role: "user",
        content: [
          { type: "input_text" },
          { type: "input_image" },
          { type: "input_text" },
          { type: "input_image" },
          { type: "input_image", image_url: { url: "" } },
          { type: "input_image", image_url: "" },
          { type: "input_text", text: "fallback" },
          undefined,
          null,
          "s",
        ] as never,
      },
      {
        type: "function_call",
        call_id: "c2",
        name: "f",
        arguments: "{bad",
      },
      { type: "function_call", call_id: "c3" },
      { type: "function_call", call_id: "c4", name: "g", arguments: true },
      { type: "function_call", call_id: "c5", name: "h2", arguments: null },
      {
        type: "function_call",
        id: "only-id",
        name: "h",
        arguments: { q: 1 },
      },
      { type: "function_call_output", output: "done" },
      { type: "function_call_output", call_id: "c1", output: null },
      { role: "assistant", content: "a" },
      { role: "system", content: [{ type: "input_text" }] },
      { role: "system", content: 7 as never },
      { role: "developer", content: "d" },
      { role: "assistant", content: [{ type: "output_text" }] },
    ]);
    expect(messages).toHaveLength(10);
    expect(messages[0]).toEqual({ role: "user", content: [{ type: "text", text: "x" }] });
    expect(messages[1]).toEqual({
      role: "user",
      content: [{ type: "text", text: "fallback" }],
    });
    expect(messages[2]).toMatchObject({
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "c2", input: {} }],
    });
    expect(messages[3]).toMatchObject({
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "c4", input: { _raw: true } }],
    });
    expect(messages[4]).toMatchObject({
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "c5", input: {} }],
    });
    expect(messages[5]).toMatchObject({
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "only-id", input: { q: 1 } }],
    });
    expect(messages[6]).toMatchObject({
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "", output: { value: "done" } }],
    });
    expect(messages[7]).toMatchObject({
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "c1", output: { value: "" } }],
    });
    expect(messages[8]).toEqual({ role: "assistant", content: [{ type: "text", text: "a" }] });
    expect(messages[9]).toEqual({ role: "system", content: "d" });
  });

  it("빈 문자열 입력을 건너뛴다", () => {
    expect(toModelMessagesFromResponses("", "sys")).toEqual([{ role: "system", content: "sys" }]);
  });
});

describe("responsesToolsToToolSet / responsesToolChoice 함수", () => {
  it("function 도구를 변환하고 나머지는 버린다", () => {
    const tools = responsesToolsToToolSet([
      { type: "function", name: "f", description: "d", parameters: {} },
      { type: "web_search" },
      { name: "" },
      null as never,
    ]);
    expect(tools).not.toBeUndefined();
    expect(Object.keys(tools ?? {})).toEqual(["f"]);
    expect(responsesToolsToToolSet([])).toBeUndefined();
    expect(responsesToolsToToolSet(undefined)).toBeUndefined();
    expect(responsesToolsToToolSet([{ type: "web_search", name: "w" } as never])).toBeUndefined();
  });

  it("도구 선택 값을 매핑한다", () => {
    expect(responsesToolChoice("auto")).toBe("auto");
    expect(responsesToolChoice("none")).toBe("none");
    expect(responsesToolChoice("required")).toBe("required");
    expect(responsesToolChoice("unknown" as never)).toBeUndefined();
    expect(responsesToolChoice(undefined)).toBeUndefined();
    expect(responsesToolChoice({ type: "function", name: "f" })).toBe("required");
    expect(responsesToolChoice({ type: "other" } as never)).toBeUndefined();
    expect(responsesToolChoice(null as never)).toBeUndefined();
  });
});

describe("collectRouteEvents 함수", () => {
  it("텍스트, reasoning, 도구 호출, 사용량을 모은다", async () => {
    const collected = await collectRouteEvents(
      streamOf([
        { type: "text-delta", text: "a" },
        { type: "reasoning-delta", text: "r" },
        { type: "tool-call-delta", id: "t1", name: "f", argsDelta: '{"a":' },
        { type: "tool-call-delta", id: "t1", argsDelta: "1}" },
        { type: "tool-call-delta", id: "t2" },
        { type: "unknown" },
        {
          type: "done",
          finishReason: "tool_calls",
          usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
        },
      ]),
    );
    expect(collected).toEqual({
      text: "a",
      reasoning: "r",
      toolCalls: [
        { id: "t1", name: "f", args: '{"a":1}' },
        { id: "t2", name: "", args: "" },
      ],
      finishReason: "tool_calls",
      usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
    });
  });

  it("분할된 이름 업데이트를 병합한다", async () => {
    const collected = await collectRouteEvents(
      streamOf([
        { type: "tool-call-delta", id: "t", name: "a" },
        { type: "tool-call-delta", id: "t", name: "b", argsDelta: "x" },
        {
          type: "done",
          finishReason: "stop",
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        },
      ]),
    );
    expect(collected.toolCalls).toEqual([{ id: "t", name: "b", args: "x" }]);
    const nameless = await collectRouteEvents(
      streamOf([
        { type: "tool-call-delta", id: "u" },
        { type: "tool-call-delta", id: "u", argsDelta: "y" },
        {
          type: "done",
          finishReason: "stop",
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        },
      ]),
    );
    expect(nameless.toolCalls).toEqual([{ id: "u", name: "", args: "y" }]);
    const emptyDelta = await collectRouteEvents(
      streamOf([
        { type: "tool-call-delta", id: "v", name: "w" },
        { type: "tool-call-delta", id: "v" },
        {
          type: "done",
          finishReason: "stop",
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        },
      ]),
    );
    expect(emptyDelta.toolCalls).toEqual([{ id: "v", name: "w", args: "" }]);
  });

  it("인자와 출력 강제 변환을 다룬다", () => {
    expect(
      toModelMessagesFromResponses([
        { type: "function_call", name: "f", arguments: '{"a":1}' },
        { type: "function_call", name: "g", arguments: "" },
        { type: "function_call", name: "n", arguments: 3 },
        { type: "function_call_output", output: 5 },
        { type: "function_call_output", call_id: "c9", output: undefined },
        { type: "function_call_output", call_id: "c9", output: Symbol("s") },
      ]),
    ).toMatchObject([
      { role: "assistant" },
      { role: "assistant" },
      { role: "assistant" },
      { role: "tool", content: [{ type: "tool-result", output: { value: "5" } }] },
      { role: "tool", content: [{ type: "tool-result", output: { value: "" } }] },
      { role: "tool", content: [{ type: "tool-result", output: { value: "" } }] },
    ]);
  });
});

describe("buildResponsesResponse 함수", () => {
  it("완료된 응답과 미완성 응답을 만든다", () => {
    const full = buildResponsesResponse({
      model: "router/balanced",
      text: "hi",
      reasoning: "why",
      toolCalls: [{ id: "c1", name: "f", args: "{}" }],
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    }) as {
      object: string;
      status: string;
      output: Array<{ type: string }>;
      usage: Record<string, number>;
    };
    expect(full.object).toBe("response");
    expect(full.status).toBe("completed");
    expect(full.output.map((o) => o.type)).toEqual(["reasoning", "message", "function_call"]);
    expect(full.usage).toEqual({ input_tokens: 1, output_tokens: 2, total_tokens: 3 });

    const incomplete = buildResponsesResponse({
      model: "router/balanced",
      text: "",
      finishReason: "length",
    }) as { status: string; output: Array<{ type: string }> };
    expect(incomplete.status).toBe("incomplete");
    expect(incomplete.output.map((o) => o.type)).toEqual(["message"]);
  });

  it("도구 호출이나 reasoning 없이 기본값을 채운다", () => {
    const res = buildResponsesResponse({ model: "router/balanced", text: "" }) as {
      model: string;
      usage: Record<string, number>;
    };
    expect(res.model).toBe("router/balanced");
    expect(res.usage).toEqual({ input_tokens: 0, output_tokens: 0, total_tokens: 0 });
  });
});

describe("pipeToResponsesStream 함수", () => {
  it("DONE 종결자 없이 created, 델타, completed을 내보낸다", async () => {
    const seen: Array<{ event: string; data: Record<string, unknown> }> = [];
    await pipeToResponsesStream(done(), "router/balanced", (event, data) => {
      seen.push({ event, data: data as Record<string, unknown> });
    });
    const events = seen.map((s) => s.event);
    expect(events).toEqual([
      "response.created",
      "response.output_item.added",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_item.done",
      "response.completed",
    ]);
    const completed = seen.find((s) => s.event === "response.completed")?.data as {
      response: { usage: Record<string, number>; status: string };
    };
    expect(completed.response.status).toBe("completed");
    expect(completed.response.usage).toEqual({
      input_tokens: 1,
      output_tokens: 2,
      total_tokens: 3,
    });
    expect(
      seen.every((s, i) => (s.data as { sequence_number: number }).sequence_number === i),
    ).toBe(true);
  });

  it("reasoning과 분할된 도구 호출을 스트리밍한다", async () => {
    const seen: string[] = [];
    await pipeToResponsesStream(
      streamOf([
        { type: "text-delta", text: "pre" },
        { type: "reasoning-delta", text: "r1" },
        { type: "reasoning-delta", text: "r2" },
        { type: "tool-call-delta", id: "t1", name: "f" },
        { type: "tool-call-delta", id: "t1", argsDelta: '{"a":' },
        { type: "tool-call-delta", id: "t1", name: "g", argsDelta: "1}" },
        { type: "tool-call-delta", id: "t2", argsDelta: "z" },
        { type: "unknown" },
        {
          type: "done",
          finishReason: "stop",
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        },
      ]),
      "router/balanced",
      (event) => {
        seen.push(event);
      },
    );
    expect(seen).toEqual([
      "response.created",
      "response.output_item.added",
      "response.output_text.delta",
      "response.output_item.added",
      "response.reasoning_summary_text.delta",
      "response.reasoning_summary_text.delta",
      "response.output_item.added",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.delta",
      "response.output_item.added",
      "response.function_call_arguments.delta",
      "response.output_item.done",
      "response.output_item.done",
      "response.output_item.done",
      "response.output_item.done",
      "response.completed",
    ]);
  });

  it("빈 델타를 내보내지 않고 이름 없는 도구 호출을 스트리밍한다", async () => {
    const seen: string[] = [];
    await pipeToResponsesStream(
      streamOf([
        { type: "tool-call-delta", id: "solo" },
        {
          type: "done",
          finishReason: "stop",
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        },
      ]),
      "router/balanced",
      (event) => {
        seen.push(event);
      },
    );
    expect(seen).toEqual([
      "response.created",
      "response.output_item.added",
      "response.output_item.done",
      "response.completed",
    ]);
  });

  it("중간 스트림 실패를 response.failed로 보고한다", async () => {
    const seen: Array<{ event: string; data: unknown }> = [];
    await pipeToResponsesStream(rejectingStream(new Error("boom")), "router/balanced", (e, d) => {
      seen.push({ event: e, data: d });
    });
    expect(seen.map((s) => s.event)).toEqual(["response.created", "response.failed"]);
    expect(JSON.stringify(seen[1]?.data)).toContain("boom");
  });
});
