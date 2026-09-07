import { beforeEach, describe, expect, it, vi } from "vitest";
import { app, reloadConfig } from "../src/api/server";
import { loadConfig } from "../src/config";
import { resetFailures } from "../src/routing/failureMemory";
import { passthroughTools, routeRequest } from "../src/routing/delegate";
import { loadState, snapshot } from "../src/state";

vi.mock("../src/config", () => ({ loadConfig: vi.fn() }));
vi.mock("../src/routing/delegate", () => ({
  passthroughTools: vi.fn((t: unknown) => t),
  routeRequest: vi.fn(),
}));
vi.mock("../src/state", () => ({ loadState: vi.fn(), snapshot: vi.fn() }));
vi.mock("../src/routing/failureMemory", () => ({ resetFailures: vi.fn(() => 0) }));

const loadConfigMock = vi.mocked(loadConfig);
const routeRequestMock = vi.mocked(routeRequest);
const snapshotMock = vi.mocked(snapshot);

const cfg = { profiles: { balanced: { medium: { models: ["openai/a"] } } } };

function streamOf(events: unknown[]) {
  return (async function* () {
    for (const e of events) yield e;
  })();
}

function rejectingIterator(error: Error): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => Promise.reject(error),
      return: () => Promise.resolve({ done: true as const, value: undefined }),
      throw: (e: unknown) => Promise.reject(e),
    }),
  };
}

const chat = (body: unknown, path = "/v1/chat/completions"): Request =>
  new Request(`http://x${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const responses = (body: unknown): Request =>
  new Request("http://x/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  loadConfigMock.mockResolvedValue({ config: cfg, warnings: [] } as never);
  snapshotMock.mockReturnValue({
    accumulatedInputTokens: 1,
    accumulatedOutputTokens: 2,
    debugHistory: [{ id: 1 }],
    lastDecision: undefined,
    totalTokens: 3,
  } as never);
});

describe("reloadConfig 함수", () => {
  it("경로 유무에 따라 로드한다", async () => {
    await reloadConfig("a.json");
    expect(loadConfigMock).toHaveBeenCalledWith("a.json");
    await reloadConfig();
    expect(loadConfigMock).toHaveBeenCalledWith("a.json");
    vi.clearAllMocks();
    loadConfigMock.mockResolvedValue({ config: { profiles: {} }, warnings: [] } as never);
    await reloadConfig(undefined);
  });
});

describe("GET /v1/models 엔드포인트", () => {
  it("프로필 목록을 나열한다", async () => {
    await reloadConfig("a.json");
    const res = await app.request("/v1/models");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data).toEqual([
      { id: "router/balanced", object: "model", created: 0, owned_by: "llm-router" },
    ]);
  });
});

describe("POST /v1/chat/completions 엔드포인트", () => {
  it("잘못된 JSON을 거부한다", async () => {
    const res = await app.request(chat("{bad"));
    expect(res.status).toBe(400);
  });

  it("누락된 model/messages를 거부한다", async () => {
    for (const body of [{}, { model: "router/balanced" }, { messages: [] }]) {
      const res = await app.request(chat(body));
      expect(res.status).toBe(400);
    }
  });

  it("router가 아닌 모델을 거부한다", async () => {
    const res = await app.request(chat({ model: "openai/x", messages: [] }));
    expect(res.status).toBe(404);
  });

  it("텍스트 포함 비스트리밍 응답을 반환한다", async () => {
    await reloadConfig("a.json");
    routeRequestMock.mockReturnValue(
      streamOf([
        { type: "text-delta", text: "hi" },
        {
          type: "done",
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        },
      ]) as never,
    );
    const res = await app.request(
      chat({ model: "router/balanced", messages: [], temperature: 0.5, top_p: 1, max_tokens: 9 }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      model: string;
      choices: Array<{ message: { content: string }; finish_reason: string }>;
      usage: { prompt_tokens: number };
    };
    expect(body.model).toBe("router/balanced");
    expect(body.choices[0].message.content).toBe("hi");
    expect(body.usage.prompt_tokens).toBe(1);
  });

  it("분할된 도구 호출과 null 콘텐츠를 누적한다", async () => {
    await reloadConfig("a.json");
    routeRequestMock.mockReturnValue(
      streamOf([
        { type: "tool-call-delta", id: "t1", name: "f", argsDelta: '{"a":' },
        { type: "tool-call-delta", id: "t1", argsDelta: "1}" },
        { type: "tool-call-delta", id: "t1", name: "g", argsDelta: "" },
        { type: "tool-call-delta", id: "t1" },
        { type: "tool-call-delta", id: "t1", name: "g2", argsDelta: "q" },
        { type: "tool-call-delta", id: "t3", argsDelta: "z" },
        { type: "tool-call-delta", id: "t2", name: "h" },
        { type: "ignored" },
        {
          type: "done",
          finishReason: "tool_calls",
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        },
      ]) as never,
    );
    const res = await app.request(
      chat({
        model: "router/balanced/low",
        messages: [],
        tools: [
          { function: { name: "f", description: "d", parameters: {} } },
          { type: "function", function: { name: "", description: "", parameters: {} } },
          {},
        ],
        tool_choice: "none",
        reasoning_effort: "high",
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      choices: Array<{ message: { content: null; tool_calls: Array<{ function: object }> } }>;
    };
    expect(body.choices[0].message.content).toBeNull();
    const calls = body.choices[0].message.tool_calls as Array<{
      function: { arguments: string };
    }>;
    expect(calls).toHaveLength(3);
    expect(calls[0].function.arguments).toBe('{"a":1}q');
    expect(passthroughTools).toHaveBeenCalled();
  });

  it("도구 없이 객체 tool_choice를 매핑한다", async () => {
    await reloadConfig("a.json");
    routeRequestMock.mockReturnValue(
      streamOf([
        { type: "text-delta", text: "x" },
        {
          type: "done",
          finishReason: "stop",
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        },
      ]) as never,
    );
    const res = await app.request(
      chat({ model: "router/balanced", messages: [], tool_choice: { type: "auto" } }),
    );
    expect(res.status).toBe(200);
  });

  it("사용자 정의 상태로 라우터 에러를 반환한다", async () => {
    await reloadConfig("a.json");
    routeRequestMock.mockReturnValue(
      rejectingIterator(Object.assign(new Error("denied"), { status: 403 })) as never,
    );
    const res = await app.request(chat({ model: "router/balanced", messages: [] }));
    expect(res.status).toBe(403);
  });

  it("기본 상태로 라우터 에러를 반환한다", async () => {
    await reloadConfig("a.json");
    routeRequestMock.mockReturnValue(rejectingIterator(new Error("boom")) as never);
    const res = await app.request(chat({ model: "router/balanced", messages: [] }));
    expect(res.status).toBe(500);
  });

  it("잘못된 responses 페이로드를 거부한다", async () => {
    await reloadConfig("a.json");
    const bad = await app.request(responses("{bad"));
    expect(bad.status).toBe(400);
    for (const body of [
      {},
      { model: "router/balanced" },
      { input: "hi" },
      { model: "openai/x", input: "hi" },
    ]) {
      const res = await app.request(responses(body));
      expect(res.status).toBe(body.model === "openai/x" ? 404 : 400);
    }
    const bg = await app.request(
      responses({ model: "router/balanced", input: "hi", background: true }),
    );
    expect(bg.status).toBe(400);
  });

  it("에러 포함 SSE 이벤트를 스트리밍한다", async () => {
    await reloadConfig("a.json");
    routeRequestMock.mockReturnValueOnce(
      streamOf([
        { type: "text-delta", text: "a" },
        { type: "reasoning-delta", text: "r" },
        { type: "tool-call-delta", id: "t1", name: "f", argsDelta: "{}" },
        { type: "tool-call-delta", id: "t1", argsDelta: "+1" },
        { type: "tool-call-delta", id: "t2" },
        { type: "ignored" },
        {
          type: "done",
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ]) as never,
    );
    const res = await app.request(
      chat({
        model: "router/balanced/low",
        messages: [],
        stream: true,
        tools: [{ function: { name: "f", parameters: {} } }],
        tool_choice: "auto",
        temperature: 0.2,
        top_p: 0.8,
        max_tokens: 5,
        reasoning_effort: "low",
      }),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("[DONE]");
    expect(text).toContain("chat.completion.chunk");
    expect(text).toContain("reasoning_content");
    expect(text).toContain("tool_calls");

    routeRequestMock.mockReturnValueOnce(rejectingIterator(new Error("stream bad")) as never);
    const errRes = await app.request(
      chat({ model: "router/balanced", messages: [], stream: true }),
    );
    const errText = await errRes.text();
    expect(errText).toContain("stream bad");
  });
});

describe("POST /v1/responses 엔드포인트", () => {
  it("스트리밍 없이 응답 객체를 반환한다", async () => {
    await reloadConfig("a.json");
    routeRequestMock.mockReturnValue(
      streamOf([
        { type: "text-delta", text: "hi" },
        {
          type: "done",
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        },
      ]) as never,
    );
    const res = await app.request(
      responses({
        model: "router/balanced/low",
        input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
        instructions: "be brief",
        tools: [{ type: "function", name: "f", parameters: {} }],
        tool_choice: "auto",
        reasoning: { effort: "low" },
        temperature: 0.2,
        top_p: 0.8,
        max_output_tokens: 5,
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      object: string;
      status: string;
      model: string;
      usage: { total_tokens: number };
    };
    expect(body.object).toBe("response");
    expect(body.status).toBe("completed");
    expect(body.model).toBe("router/balanced/low");
    expect(body.usage.total_tokens).toBe(3);
    expect(routeRequest).toHaveBeenCalled();
  });

  it("문자열 입력과 reasoning_effort를 지원한다", async () => {
    await reloadConfig("a.json");
    routeRequestMock.mockReturnValue(streamOf([]) as never);
    const res = await app.request(
      responses({
        model: "router/balanced/high",
        input: "hi",
        reasoning_effort: "high",
        temperature: 0,
        top_p: 1,
        max_output_tokens: 1,
      }),
    );
    expect(res.status).toBe(200);
    const streamed = await app.request(
      responses({ model: "router/balanced", input: "hi", stream: false }),
    );
    expect(streamed.status).toBe(200);
    const streamedTier = await app.request(
      responses({ model: "router/balanced/low", input: "hi", stream: true }),
    );
    expect(streamedTier.status).toBe(200);
  });

  it("라우터 실패를 router_error에 매핑한다", async () => {
    await reloadConfig("a.json");
    routeRequestMock.mockReturnValueOnce(
      rejectingIterator(Object.assign(new Error("denied"), { status: 403 })) as never,
    );
    const denied = await app.request(responses({ model: "router/balanced", input: "hi" }));
    expect(denied.status).toBe(403);
    routeRequestMock.mockReturnValueOnce(rejectingIterator(new Error("boom")) as never);
    const failed = await app.request(responses({ model: "router/balanced", input: "hi" }));
    expect(failed.status).toBe(500);
  });

  it("response.completed로 끝나는 responses SSE를 스트리밍한다", async () => {
    await reloadConfig("a.json");
    routeRequestMock.mockReturnValueOnce(
      streamOf([
        { type: "text-delta", text: "a" },
        { type: "reasoning-delta", text: "r" },
        { type: "tool-call-delta", id: "t1", name: "f", argsDelta: "{}" },
        {
          type: "done",
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ]) as never,
    );
    const res = await app.request(
      responses({
        model: "router/balanced",
        input: "hi",
        stream: true,
        tools: [{ type: "function", name: "f" }],
        tool_choice: { type: "function", name: "f" },
        max_tokens: 5,
      }),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("response.completed");
    expect(text).toContain("response.output_text.delta");
    expect(text).not.toContain("[DONE]");

    routeRequestMock.mockReturnValueOnce(rejectingIterator(new Error("stream bad")) as never);
    const errRes = await app.request(
      responses({ model: "router/balanced", input: "hi", stream: true }),
    );
    const errText = await errRes.text();
    expect(errText).toContain("response.failed");
  });
});

describe("router 관리", () => {
  it("상태와 디버그를 제공한다", async () => {
    await reloadConfig("a.json");
    const status = await app.request("/router/status");
    expect(status.status).toBe(200);
    const sbody = (await status.json()) as { profiles: string[]; debugEnabled: boolean };
    expect(sbody.profiles).toEqual(["balanced"]);
    expect(sbody.debugEnabled).toBe(false);
    const debug = await app.request("/router/debug");
    expect((await debug.json()) as { history: unknown[] }).toEqual({ history: [{ id: 1 }] });
    expect(loadState).toHaveBeenCalled();
  });

  it("성공과 실패로 설정을 다시 로드한다", async () => {
    loadConfigMock.mockResolvedValue({ config: cfg, warnings: [] } as never);
    const ok = await app.request("/router/reload", { method: "POST" });
    expect(ok.status).toBe(200);
    loadConfigMock.mockRejectedValueOnce(new Error("bad"));
    const bad = await app.request("/router/reload", { method: "POST" });
    expect(bad.status).toBe(500);
  });

  it("JSON 유무에 따라 실패 기록을 초기화한다", async () => {
    const withBody = await app.request("/router/reset-failures", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile: "balanced" }),
    });
    expect(withBody.status).toBe(200);
    const raw = new Request("http://x/router/reset-failures", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{bad",
    });
    const without = await app.request(raw);
    expect(without.status).toBe(200);
    expect(resetFailures).toHaveBeenCalled();
  });
});
