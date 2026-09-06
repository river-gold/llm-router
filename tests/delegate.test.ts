import { beforeEach, describe, expect, it, vi } from "vitest";
import { stepCountIs, streamText, tool } from "ai";
import { getBackendModel } from "../src/backends";
import { runClassifier } from "../src/routing/classifier";
import {
  attemptModel,
  candidateRefs,
  passthroughTools,
  resolveTier,
  routeRequest,
  runAttempt,
  type RouteRequest,
  type RouterEvent,
} from "../src/routing/delegate";
import type { RoutingDecision } from "../src/types";
import { recordDecision } from "../src/state";
import { resetFailures } from "../src/routing/failureMemory";
import type { RouterConfig, RouterProfile } from "../src/types";

vi.mock("ai", () => ({
  streamText: vi.fn(),
  stepCountIs: vi.fn((n: number) => `steps:${n}`),
  tool: vi.fn((def: unknown) => ({ mockedTool: def })),
}));
vi.mock("../src/backends", () => ({ getBackendModel: vi.fn() }));
vi.mock("../src/routing/classifier", () => ({ runClassifier: vi.fn() }));
vi.mock("../src/state", () => ({ recordDecision: vi.fn() }));

const streamTextMock = vi.mocked(streamText);
const getBackendModelMock = vi.mocked(getBackendModel);
const runClassifierMock = vi.mocked(runClassifier);

const profile: RouterProfile = {
  low: { models: ["openai/a#low", "openai/b"] },
  medium: { models: ["openai/c"], thinking: "medium", maxTokens: 50 },
};

const config: RouterConfig = { profiles: { balanced: profile } };

const baseReq = (over: Partial<RouteRequest> = {}): RouteRequest => ({
  profile: "balanced",
  messages: [{ role: "user", content: "hi" } as never],
  ...over,
});

function streamOf(parts: ReadonlyArray<Record<string, unknown>>): {
  fullStream: AsyncGenerator<unknown>;
} {
  const snapshot = [...parts];
  return {
    fullStream: (async function* () {
      for (const p of snapshot) yield p;
    })(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetAllMocks();
  resetFailures();
  getBackendModelMock.mockImplementation(
    async () => ({ model: "m", provider: "openai", modelId: "x" }) as never,
  );
});

const collect = async (gen: AsyncGenerator<{ type: string }>): Promise<string[]> => {
  const types: string[] = [];
  for await (const e of gen) types.push(e.type);
  return types;
};

describe("resolveTier", () => {
  it("honors explicit tiers including fallback resolution", async () => {
    const direct = await resolveTier(config, "balanced", profile, {
      explicitTier: "low",
      messages: baseReq().messages,
    });
    expect(direct.decision.tier).toBe("low");
    expect(direct.classifierUsed).toBe(false);
    const resolved = await resolveTier(
      config,
      "balanced",
      { low: { models: ["openai/a"] } },
      { explicitTier: "max", messages: baseReq().messages },
    );
    expect(resolved.decision.tier).toBe("low");
    expect(resolved.decision.reasoning).toContain("resolved to");
  });

  it("skips classification for single-tier profiles", async () => {
    const out = await resolveTier(
      config,
      "balanced",
      { low: { models: ["openai/a"] } },
      { messages: baseReq().messages },
    );
    expect(out.decision.tier).toBe("low");
    expect(runClassifierMock).not.toHaveBeenCalled();
  });

  it("maps reasoning effort to tiers", async () => {
    const full: RouterProfile = {
      minimal: { models: ["openai/a"] },
      low: { models: ["openai/a"] },
      medium: { models: ["openai/a"] },
      high: { models: ["openai/a"] },
      xhigh: { models: ["openai/a"] },
      max: { models: ["openai/a"] },
    };
    for (const [effort, tier] of [
      ["none", "medium"],
      ["auto", "medium"],
      ["", "medium"],
      ["minimal", "low"],
      ["low", "low"],
      ["medium", "medium"],
      [" HIGH ", "high"],
      ["xhigh", "xhigh"],
      ["max", "max"],
      ["weird", "medium"],
    ] as const) {
      const out = await resolveTier(config, "balanced", full, {
        effort,
        messages: baseReq().messages,
      });
      expect(out.decision.tier).toBe(tier);
    }
    expect(runClassifierMock).not.toHaveBeenCalled();
  });

  it("uses the classifier when available", async () => {
    runClassifierMock.mockResolvedValue({ tier: "low", attempts: [] });
    const cfg: RouterConfig = {
      profiles: { balanced: { ...profile, classifierModels: [{ model: "openai/clf" }] } },
      historySize: 3,
    };
    const out = await resolveTier(
      cfg,
      "balanced",
      { ...profile, classifierModels: [{ model: "openai/clf" }] },
      { messages: baseReq().messages },
    );
    expect(out.decision.tier).toBe("low");
    expect(out.decision.isClassifier).toBe(true);
    expect(out.classifierUsed).toBe(true);
  });

  it("resolves classifier tiers to available ones", async () => {
    runClassifierMock.mockResolvedValue({ tier: "max", attempts: [] });
    const two: RouterProfile = {
      low: { models: ["openai/a"] },
      medium: { models: ["openai/b"] },
      classifierModels: [{ model: "openai/clf" }],
    };
    const cfg: RouterConfig = { profiles: { balanced: two } };
    const out = await resolveTier(cfg, "balanced", two, { messages: baseReq().messages });
    expect(out.decision.tier).toBe("medium");
    expect(out.decision.reasoning).toContain("resolved to");
  });

  it("uses global classifier models", async () => {
    runClassifierMock.mockResolvedValue({ tier: "medium", attempts: [] });
    const cfg: RouterConfig = {
      profiles: { balanced: profile },
      classifierModels: [{ model: "openai/clf" }],
    };
    const out = await resolveTier(cfg, "balanced", profile, { messages: baseReq().messages });
    expect(out.classifierUsed).toBe(true);
  });

  it("defaults to medium when the classifier is skipped or fails", async () => {
    runClassifierMock.mockResolvedValue(undefined);
    const toolReq = baseReq({ messages: [{ role: "tool", content: [] } as never] });
    const skipped = await resolveTier(
      { profiles: { balanced: { ...profile, classifierModels: [{ model: "openai/clf" }] } } },
      "balanced",
      { ...profile, classifierModels: [{ model: "openai/clf" }] },
      toolReq,
    );
    expect(skipped.decision.tier).toBe("medium");
    expect(skipped.decision.reasoning).toContain("Tool-loop");
    expect(runClassifierMock).not.toHaveBeenCalled();
    const failed = await resolveTier(config, "balanced", profile, { messages: baseReq().messages });
    expect(failed.decision.tier).toBe("medium");
    expect(failed.decision.reasoning).toContain("defaulted to medium");
    const empty = await resolveTier(
      { profiles: { balanced: { ...profile, classifierModels: [{ model: "openai/clf" }] } } },
      "balanced",
      { ...profile, classifierModels: [{ model: "openai/clf" }] },
      { messages: baseReq().messages },
    );
    expect(empty.decision.tier).toBe("medium");
    expect(empty.decision.reasoning).toContain("defaulted to medium");
  });
});

describe("routeRequest", () => {
  it("rejects unknown profiles", async () => {
    await expect(collect(routeRequest(config, baseReq({ profile: "nope" })))).rejects.toThrow(
      'Unknown profile "nope"',
    );
  });

  it("rejects when every model is in cooldown", async () => {
    const { recordFailure, resetFailures } = await import("../src/routing/failureMemory");
    resetFailures("balanced");
    recordFailure("balanced", "low", "openai/a#low");
    recordFailure("balanced", "low", "openai/b");
    await expect(collect(routeRequest(config, baseReq({ explicitTier: "low" })))).rejects.toThrow(
      "in cooldown",
    );
    resetFailures("balanced");
  });

  it("streams text and records the decision", async () => {
    streamTextMock.mockImplementationOnce(
      () =>
        streamOf([
          { type: "text-delta", text: "hel" },
          { type: "reasoning-delta", text: "think" },
          {
            type: "finish",
            finishReason: "stop",
            totalUsage: { inputTokens: 2, outputTokens: 5 },
          },
        ]) as never,
    );
    const events: unknown[] = [];
    for await (const e of routeRequest(config, baseReq({ explicitTier: "medium" }))) events.push(e);
    expect(events.map((e) => (e as { type: string }).type)).toEqual([
      "text-delta",
      "reasoning-delta",
      "done",
    ]);
    expect(events[2]).toMatchObject({
      usage: { inputTokens: 2, outputTokens: 5, totalTokens: 7 },
    });
    expect(recordDecision).toHaveBeenCalledTimes(1);
    expect(streamTextMock).toHaveBeenCalledWith(expect.objectContaining({ maxOutputTokens: 50 }));
  });

  it("passes tools, choice, and limits through", async () => {
    streamTextMock.mockImplementationOnce(
      () =>
        streamOf([
          { type: "tool-input-start", id: "t1", toolName: "f" },
          { type: "tool-input-delta", id: "t1", delta: "{}" },
          { type: "finish", finishReason: "tool-calls", totalUsage: {} },
        ]) as never,
    );
    const tools = passthroughTools({ f: { description: "d", parameters: { type: "object" } } });
    expect(tool).toHaveBeenCalled();
    const bare = passthroughTools({ g: { parameters: { type: "object" } } });
    expect(bare.g).toBeDefined();
    const events: unknown[] = [];
    for await (const e of routeRequest(
      config,
      baseReq({
        explicitTier: "low",
        tools,
        toolChoice: "none",
        temperature: 0.5,
        topP: 0.9,
        maxTokens: 9,
      }),
    )) {
      events.push(e);
    }
    expect(events.map((e) => (e as { type: string }).type)).toEqual([
      "tool-call-delta",
      "tool-call-delta",
      "done",
    ]);
    expect(events[2]).toMatchObject({ finishReason: "tool_calls" });
    expect(stepCountIs).toHaveBeenCalledWith(1);
    expect(streamTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        toolChoice: "none",
        temperature: 0.5,
        topP: 0.9,
        maxOutputTokens: 9,
      }),
    );
  });

  it("falls back to the next model on pre-content failure", async () => {
    const okStream = () =>
      streamOf([
        { type: "text-delta", text: "ok" },
        { type: "finish", finishReason: "stop", totalUsage: {} },
      ]) as never;
    streamTextMock.mockImplementation(
      (() => {
        let n = 0;
        return () => {
          n += 1;
          if (n === 1) throw new Error("boom");
          return okStream();
        };
      })(),
    );
    const events: unknown[] = [];
    for await (const e of routeRequest(config, baseReq({ explicitTier: "low" }))) events.push(e);
    expect(events.map((e) => (e as { type: string }).type)).toEqual(["text-delta", "done"]);
    expect(recordDecision).toHaveBeenCalledWith(
      expect.objectContaining({ isFallback: true }),
      expect.anything(),
      undefined,
    );
  });

  it("fails all models and reports the last error", async () => {
    const down = (): never => {
      throw new Error("down");
    };
    streamTextMock.mockImplementationOnce(down).mockImplementationOnce(down);
    await expect(collect(routeRequest(config, baseReq({ explicitTier: "low" })))).rejects.toThrow(
      "All 2 model(s) in low tier failed. Last error: down",
    );
  });

  it("does not skip models after a transient 503", async () => {
    const overloaded = () =>
      streamOf([
        {
          type: "error",
          error: new Error(
            '503: {"message":"Upstream model provider is temporarily unavailable.","type":"overloaded_error"}',
          ),
        },
      ]) as never;
    streamTextMock.mockImplementation(overloaded);
    await expect(collect(routeRequest(config, baseReq({ explicitTier: "low" })))).rejects.toThrow(
      "All 2 model(s) in low tier failed",
    );
    await expect(collect(routeRequest(config, baseReq({ explicitTier: "low" })))).rejects.toThrow(
      "All 2 model(s) in low tier failed",
    );
    expect(streamTextMock).toHaveBeenCalledTimes(4);
  });

  it("skips only the rate-limited model on the next request", async () => {
    const limited = () =>
      streamOf([
        {
          type: "error",
          error: new Error(
            '429: {"message":"limit resets at 2099-01-01T00:00:00.000Z.","type":"rate_limit_error","code":"RATE_LIMITED"}',
          ),
        },
      ]) as never;
    const okStream = () =>
      streamOf([
        { type: "text-delta", text: "ok" },
        { type: "finish", finishReason: "stop", totalUsage: {} },
      ]) as never;
    streamTextMock.mockImplementationOnce(limited).mockImplementation(okStream);
    await collect(routeRequest(config, baseReq({ explicitTier: "low" })));
    streamTextMock.mockClear();
    streamTextMock.mockImplementation(okStream);
    const events: unknown[] = [];
    for await (const e of routeRequest(config, baseReq({ explicitTier: "low" }))) events.push(e);
    expect(events.map((e) => (e as { type: string }).type)).toEqual(["text-delta", "done"]);
    expect(streamTextMock).toHaveBeenCalledTimes(1);
  });

  it("handles streams ending without a terminal event", async () => {
    const unfinished = () =>
      streamOf([
        { type: "text-delta", text: "x" },
        { type: "finish", finishReason: "length", totalUsage: {} },
      ]) as never;
    streamTextMock.mockImplementationOnce(unfinished).mockImplementationOnce(unfinished);
    await expect(collect(routeRequest(config, baseReq({ explicitTier: "low" })))).rejects.toThrow(
      "All 2 model(s) in low tier failed. Last error: Model stream ended without terminal event.",
    );
    const empty = () => streamOf([]) as never;
    streamTextMock.mockImplementation(empty);
    await expect(collect(routeRequest(config, baseReq({ explicitTier: "low" })))).rejects.toThrow(
      'Model "openai/b" produced no output',
    );
  });

  it("propagates stream errors and mid-stream failures as non-retryable", async () => {
    streamTextMock
      .mockImplementationOnce(() => streamOf([{ type: "error", error: new Error("bad") }]) as never)
      .mockImplementationOnce(
        () =>
          streamOf([
            { type: "text-delta", text: "partial" },
            { type: "error", error: new Error("mid") },
          ]) as never,
      );
    await expect(collect(routeRequest(config, baseReq({ explicitTier: "low" })))).rejects.toThrow(
      "mid",
    );
  });

  it("ignores unknown stream parts", async () => {
    streamTextMock.mockImplementation(
      () =>
        streamOf([
          { type: "unknown-part" },
          { type: "text-delta", text: "x" },
          { type: "finish", finishReason: "stop", totalUsage: {} },
        ]) as never,
    );
    const events: unknown[] = [];
    for await (const e of routeRequest(config, baseReq({ explicitTier: "low" }))) {
      events.push(e);
    }
    expect(events.map((e) => (e as { type: string }).type)).toEqual(["text-delta", "done"]);
  });

  it("retries unfinished streams on the next model", async () => {
    getBackendModelMock.mockImplementation(async () => ({ model: "m" }) as never);
    const unfinishedStream = () =>
      streamOf([
        { type: "text-delta", text: "x" },
        { type: "finish", finishReason: "length", totalUsage: {} },
      ]) as never;
    const doneStream = () =>
      streamOf([
        { type: "text-delta", text: "ok" },
        { type: "finish", finishReason: "stop", totalUsage: {} },
      ]) as never;
    streamTextMock.mockImplementation(
      (() => {
        let n = 0;
        return () => {
          n += 1;
          return n === 1 ? unfinishedStream() : doneStream();
        };
      })(),
    );
    const resumed: unknown[] = [];
    for await (const e of routeRequest(
      { profiles: { balanced: { low: { models: ["openai/a", "openai/b"] } } } },
      baseReq({ explicitTier: "low" }),
    )) {
      resumed.push(e);
    }
    expect(resumed.map((e) => (e as { type: string }).type)).toEqual(["text-delta", "done"]);
    expect(recordDecision).toHaveBeenCalledWith(
      expect.objectContaining({ isFallback: true }),
      expect.anything(),
      undefined,
    );
  });

  it("reports runAttempt statuses", async () => {
    const tiny = { low: { models: ["openai/z"] } };
    const orphan: RoutingDecision = {
      profile: "p",
      tier: "low",
      targetProvider: "openai",
      targetModelId: "z",
      targetLabel: "openai/z",
      reasoning: "r",
      timestamp: 1,
    };
    const cfg: RouterConfig = { profiles: { p: tiny } };
    getBackendModelMock.mockImplementation(async () => ({ model: "m" }) as never);
    streamTextMock.mockImplementation(
      () => streamOf([{ type: "finish", finishReason: "stop", totalUsage: {} }]) as never,
    );
    const onlyDone = await runAttempt("openai/z", tiny, { ...orphan }, baseReq({}), cfg, 0);
    expect(onlyDone.status).toBe("ok");
    streamTextMock.mockImplementation(() => {
      throw new Error("down");
    });
    const empty = await runAttempt("openai/z", tiny, { ...orphan }, baseReq({}), cfg, 0);
    expect(empty).toEqual({ status: "empty", error: new Error("down") });
    streamTextMock.mockImplementation(() => streamOf([{ type: "text-delta", text: "x" }]) as never);
    const unfinished = await runAttempt("openai/z", tiny, { ...orphan }, baseReq({}), cfg, 0);
    expect(unfinished).toEqual({ status: "unfinished" });
    const truncated = async function* (): AsyncGenerator<RouterEvent> {
      yield { type: "text-delta", text: "x" };
    };
    const drained = await runAttempt(
      "openai/z",
      tiny,
      { ...orphan },
      baseReq({}),
      cfg,
      0,
      truncated as never,
    );
    expect(drained).toEqual({ status: "unfinished" });
    streamTextMock.mockImplementation(
      () =>
        streamOf([
          { type: "text-delta", text: "x" },
          { type: "error", error: new Error("mid") },
        ]) as never,
    );
    await expect(runAttempt("openai/z", tiny, { ...orphan }, baseReq({}), cfg, 0)).rejects.toThrow(
      "mid",
    );
  });

  it("uses candidate fallback refs for model-less tiers", async () => {
    const orphan: RoutingDecision = {
      profile: "p",
      tier: "low",
      targetProvider: "openai",
      targetModelId: "z",
      targetLabel: "openai/z",
      reasoning: "r",
      timestamp: 1,
    };
    expect(candidateRefs({}, orphan)).toEqual(["openai/z"]);
    expect(candidateRefs({ low: {} }, orphan)).toEqual(["openai/z"]);
    expect(candidateRefs({ low: { models: ["openai/a", "openai/a"] } }, orphan)).toEqual([
      "openai/a",
    ]);
  });

  it("attempts models with missing tier config", async () => {
    const done = () =>
      streamOf([
        { type: "text-delta", text: "x" },
        {
          type: "finish",
          finishReason: "stop",
          totalUsage: { inputTokens: 1, outputTokens: 1 },
        },
      ]) as never;
    streamTextMock.mockImplementationOnce(done).mockImplementationOnce(done);
    getBackendModelMock.mockImplementation(async () => ({ model: "m", effort: "xhigh" }) as never);
    const orphan: RoutingDecision = {
      profile: "p",
      tier: "low",
      targetProvider: "openai",
      targetModelId: "z",
      targetLabel: "openai/z",
      reasoning: "r",
      timestamp: 1,
    };
    const types = await collect(attemptModel("openai/z#high", {}, orphan, baseReq({})));
    expect(types).toEqual(["text-delta", "done"]);
    expect(getBackendModelMock).toHaveBeenCalledWith("openai", "z", "high");
    const bare = await collect(attemptModel("openai/z", {}, orphan, baseReq({})));
    expect(bare).toEqual(["text-delta", "done"]);
    expect(getBackendModelMock).toHaveBeenCalledWith("openai", "z", undefined);
    expect(streamTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        providerOptions: { openai: { reasoningEffort: "xhigh" } },
      }),
    );
  });
});
