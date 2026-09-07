import { describe, expect, it } from "vitest";
import { toModelMessages, type OpenAIMessage } from "../src/api/convert";
import {
  formatModelRef,
  isRouterTier,
  parseCanonicalModelRef,
  parseServerModel,
  toModelEntry,
} from "../src/modelRef";
import {
  buildRoutingDecision,
  resolveAvailableTier,
  thinkingToTier,
} from "../src/routing/decision";
import {
  chainKey,
  cooldownSkipMessage,
  errorText,
  failedRefs,
  failureCooldownUntil,
  filterFailed,
  nextRetryAt,
  normalizeRef,
  RATE_LIMIT_COOLDOWN_MS,
  recordFailure,
  resetFailures,
} from "../src/routing/failureMemory";
import type { RouterProfile } from "../src/types";

describe("parseCanonicalModelRef 함수", () => {
  it("thinking이 있는 provider/모델을 파싱한다", () => {
    expect(parseCanonicalModelRef("openai/gpt-5#high")).toEqual({
      provider: "openai",
      modelId: "gpt-5",
      thinking: "high",
    });
  });

  it("thinking이 없는 provider/모델을 파싱한다", () => {
    expect(parseCanonicalModelRef("grok/grok-4")).toEqual({
      provider: "grok",
      modelId: "grok-4",
    });
  });

  it("빈 thinking 접미사를 없음으로 취급한다", () => {
    expect(parseCanonicalModelRef("p/m#")).toEqual({ provider: "p", modelId: "m" });
  });

  it("provider, 모델, thinking 주변 공백을 다듬는다", () => {
    expect(parseCanonicalModelRef(" p / m # low ")).toEqual({
      provider: "p",
      modelId: "m",
      thinking: "low",
    });
  });

  it("슬래시 없는 ref를 거부한다", () => {
    expect(() => parseCanonicalModelRef("gpt-5")).toThrow('Invalid model reference "gpt-5"');
  });

  it("빈 provider나 모델을 거부한다", () => {
    expect(() => parseCanonicalModelRef("/m")).toThrow("Invalid model reference");
    expect(() => parseCanonicalModelRef("p/")).toThrow("Invalid model reference");
    expect(() => parseCanonicalModelRef(" / ")).toThrow("Invalid model reference");
  });

  it("알 수 없는 thinking을 거부한다", () => {
    expect(() => parseCanonicalModelRef("p/m#ultra")).toThrow('Invalid thinking "ultra"');
  });
});

describe("formatModelRef 함수", () => {
  it("thinking 유무에 따라 형식을 만든다", () => {
    expect(formatModelRef("p", "m", "low")).toBe("p/m#low");
    expect(formatModelRef("p", "m")).toBe("p/m");
  });
});

describe("isRouterTier 함수", () => {
  it("tier는 받아들이고 나머지는 거부한다", () => {
    expect(isRouterTier("high")).toBe(true);
    expect(isRouterTier("ultra")).toBe(false);
  });
});

describe("parseServerModel 함수", () => {
  it("프로필만 있는 경우와 프로필+tier를 파싱한다", () => {
    expect(parseServerModel("router/balanced")).toEqual({ profile: "balanced" });
    expect(parseServerModel("router/grok/high")).toEqual({ profile: "grok", tier: "high" });
  });

  it("router가 아니거나 짧거나 프로필 없거나 잘못된 tier 모델을 거부한다", () => {
    expect(() => parseServerModel("openai/x")).toThrow("Invalid router model");
    expect(() => parseServerModel("x")).toThrow("Invalid router model");
    expect(() => parseServerModel("router/")).toThrow("Missing profile");
    expect(() => parseServerModel("router/p/ultra")).toThrow('Invalid tier "ultra"');
  });
});

describe("thinkingToTier 함수", () => {
  it("모든 thinking 수준을 매핑한다", () => {
    expect(thinkingToTier("max")).toBe("max");
    expect(thinkingToTier("xhigh")).toBe("xhigh");
    expect(thinkingToTier("high")).toBe("high");
    expect(thinkingToTier("medium")).toBe("medium");
    expect(thinkingToTier("low")).toBe("low");
    expect(thinkingToTier("minimal")).toBe("minimal");
    expect(thinkingToTier("off")).toBe("minimal");
  });
});

describe("resolveAvailableTier 함수", () => {
  it("설정된 선호 tier를 반환한다", () => {
    expect(resolveAvailableTier({ medium: {} }, "medium")).toBe("medium");
  });

  it("위쪽부터 다음 아래쪽으로 찾는다", () => {
    expect(resolveAvailableTier({ high: {} }, "medium")).toBe("high");
    expect(resolveAvailableTier({ low: {} }, "medium")).toBe("low");
  });

  it("설정이 없으면 선호 tier를 반환한다", () => {
    expect(resolveAvailableTier({}, "medium")).toBe("medium");
  });
});

describe("toModelEntry 함수", () => {
  it("단축 문자열을 감싸고 객체는 유지한다", () => {
    expect(toModelEntry("openai/x#low")).toEqual({ model: "openai/x#low" });
    const entry = { model: "openai/x", thinking: "high" as const };
    expect(toModelEntry(entry)).toBe(entry);
  });
});

describe("buildRoutingDecision 함수", () => {
  const profile: RouterProfile = {
    medium: { models: [{ model: "openai/gpt-5#low", thinking: "high" }] },
  };

  it("주요 ref thinking에서 결정을 만든다", () => {
    const d = buildRoutingDecision("p", profile, "medium", "r", true);
    expect(d).toMatchObject({
      profile: "p",
      tier: "medium",
      targetProvider: "openai",
      targetModelId: "gpt-5",
      targetLabel: "openai/gpt-5",
      reasoning: "r",
      thinking: "low",
      isClassifier: true,
    });
    expect(typeof d.timestamp).toBe("number");
  });

  it("ref에 thinking이 없으면 항목 thinking으로 대체한다", () => {
    const d = buildRoutingDecision(
      "p",
      { medium: { models: [{ model: "openai/gpt-5", thinking: "high" }] } },
      "medium",
      "r",
    );
    expect(d.thinking).toBe("high");
    expect(d.isClassifier).toBeUndefined();
  });

  it("tier나 모델이 없으면 예외를 던진다", () => {
    expect(() => buildRoutingDecision("p", {}, "medium", "r")).toThrow(
      'Profile "p" has no configuration for the medium tier.',
    );
    expect(() => buildRoutingDecision("p", { medium: {} }, "medium", "r")).toThrow(
      'Profile "p" tier medium has no models.',
    );
    expect(() => buildRoutingDecision("p", { medium: { models: [] } }, "medium", "r")).toThrow(
      'Profile "p" tier medium has no models.',
    );
  });
});

describe("failureMemory 모듈", () => {
  it("키를 만들고 ref를 정규화한다", () => {
    expect(chainKey("p", "low")).toBe("p/low");
    expect(normalizeRef("  a/b  ")).toBe("a/b");
  });

  it("실패를 기록하고 보고한다", () => {
    resetFailures();
    expect(failedRefs("p", "low").size).toBe(0);
    recordFailure("p", "low", "  openai/x  ");
    expect([...failedRefs("p", "low")]).toEqual(["openai/x"]);
  });

  it("전체를 초기화하고 개수를 보고한다", () => {
    resetFailures();
    recordFailure("a", "low", "m1");
    recordFailure("b", "high", "m2");
    expect(resetFailures()).toBe(2);
    expect(resetFailures()).toBe(0);
  });

  it("정확히 또는 접두사로 단일 프로필을 초기화한다", () => {
    resetFailures();
    recordFailure("p1", "low", "m1");
    recordFailure("p1", "high", "m2");
    recordFailure("p2", "low", "m3");
    expect(resetFailures("p")).toBe(0);
    expect(failedRefs("p1", "low").size).toBe(1);
    expect(resetFailures("p1")).toBe(2);
    expect(failedRefs("p1", "low").size).toBe(0);
    expect(failedRefs("p2", "low").size).toBe(1);
    expect(resetFailures("p2")).toBe(1);
  });

  it("정규화와 함께 시도분과 건너뜀분을 나눈다", () => {
    const { tried, skipped } = filterFailed(["a", " b "], new Set(["b"]));
    expect(tried).toEqual(["a"]);
    expect(skipped).toEqual([" b "]);
  });

  it("쿨다운 분류를 위해 에러를 문자열화한다", () => {
    expect(errorText("raw")).toBe("raw");
    expect(errorText(new Error("boom"))).toBe("boom");
    expect(errorText({ message: "obj" })).toBe('{"message":"obj"}');
    expect(errorText(7)).toBe("7");
  });

  it("속도 제한 에러에만 쿨다운을 적용한다", () => {
    const now = Date.parse("2026-09-06T13:00:00.000Z");
    expect(failureCooldownUntil("503 overloaded", now)).toBeNull();
    expect(failureCooldownUntil(new Error("aborted"), now)).toBeNull();
    expect(failureCooldownUntil("429", now)).toBe(now + RATE_LIMIT_COOLDOWN_MS);
    const limited =
      '429: {"message":"reached 5-hour usage limit. Your limit resets at 2026-09-06T13:31:13.576Z.","type":"rate_limit_error","code":"RATE_LIMITED"}';
    expect(failureCooldownUntil(limited, now)).toBe(Date.parse("2026-09-06T13:31:13.576Z"));
    expect(failureCooldownUntil("resets at 2026-13-99T99:99:99Z RATE_LIMITED", now)).toBe(
      now + RATE_LIMIT_COOLDOWN_MS,
    );
    expect(
      failureCooldownUntil("rate_limit_error resets at 2026-09-06T12:00:00.000Z", now),
    ).toBeNull();
  });

  it("만료된 쿨다운을 버리고 더 늦은 종료 시점을 유지한다", () => {
    resetFailures();
    const now = 1_000;
    recordFailure("p", "low", "a", now);
    expect(failedRefs("p", "low", now).size).toBe(0);
    recordFailure("p", "low", "b", now + 10);
    recordFailure("p", "low", "b", now + 5);
    expect([...failedRefs("p", "low", now)]).toEqual(["b"]);
    expect(failedRefs("p", "low", now + 10).size).toBe(0);
  });

  it("초기화 명령 없이 재시도 시점을 보고한다", () => {
    resetFailures();
    expect(nextRetryAt("p", "low", 1)).toBeUndefined();
    recordFailure("p", "low", "a", 50, 0);
    expect(nextRetryAt("p", "low", 100)).toBeUndefined();
    recordFailure("p", "low", "b", 200, 0);
    expect(nextRetryAt("p", "low", 100)).toBe(200);
    expect(cooldownSkipMessage("low", ["a"])).toBe(
      "All models in low tier are in cooldown (skipped: a).",
    );
    expect(cooldownSkipMessage("low", ["a", "b"], Date.parse("2026-09-06T13:31:13.576Z"))).toBe(
      "All models in low tier are in cooldown (skipped: a, b). Retry after 2026-09-06T13:31:13.576Z.",
    );
  });
});

describe("toModelMessages 함수", () => {
  it("system과 developer 메시지를 변환한다", () => {
    const out = toModelMessages([
      { role: "system", content: "sys" },
      { role: "developer", content: "dev" },
      { role: "system", content: [{ type: "text", text: "no" }] },
      { role: "system", content: "" },
    ]);
    expect(out).toEqual([
      { role: "system", content: "sys" },
      { role: "system", content: "dev" },
    ]);
  });

  it("텍스트와 이미지 포함 사용자 메시지를 변환한다", () => {
    const out = toModelMessages([
      { role: "user", content: "hi" },
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image_url", image_url: { url: "http://img" } },
          { type: "image_url" },
          { type: "image_url", image_url: { url: "" } },
          { type: "other", text: "skip" },
          { type: "text", text: "" },
          { text: "bare" },
          {},
        ],
      },
      { role: "user", content: "" },
      { role: "user" },
    ]);
    expect(out).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", image: "http://img" },
          { type: "text", text: "bare" },
        ],
      },
    ]);
  });

  it("텍스트와 도구 호출 포함 assistant 메시지를 변환한다", () => {
    const out = toModelMessages([
      { role: "assistant", content: "ans" },
      {
        role: "assistant",
        tool_calls: [
          { id: "1", function: { name: "f", arguments: '{"a":1}' } },
          { id: "2", function: { name: "g", arguments: "broken" } },
          { id: "3", function: { name: "h", arguments: "" } },
        ],
      },
      { role: "assistant" },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ role: "assistant", content: [{ type: "text", text: "ans" }] });
    expect(out[1]).toEqual({
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: "1", toolName: "f", input: { a: 1 } },
        { type: "tool-call", toolCallId: "2", toolName: "g", input: {} },
        { type: "tool-call", toolCallId: "3", toolName: "h", input: {} },
      ],
    });
  });

  it("도구 메시지를 변환하고 이름을 결정한다", () => {
    const msgs: OpenAIMessage[] = [
      {
        role: "assistant",
        tool_calls: [{ id: "c1", function: { name: "search", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "c1", content: "result" },
      { role: "tool", tool_call_id: "unknown", content: [{ type: "text", text: "x" }] },
      { role: "tool", tool_call_id: "none" },
      { role: "tool", content: "no-id" },
    ];
    const out = toModelMessages(msgs);
    expect(out).toHaveLength(5);
    expect(out[1]).toMatchObject({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "c1",
          toolName: "search",
          output: { type: "text", value: "result" },
        },
      ],
    });
    expect(out[2]).toMatchObject({
      content: [{ toolCallId: "unknown", toolName: "unknown" }],
    });
    expect(out[3]).toMatchObject({ content: [{ output: { value: '""' } }] });
    expect(out[4]).toMatchObject({
      content: [{ toolCallId: "", toolName: "", output: { value: "no-id" } }],
    });
  });

  it("알 수 없는 역할을 건너뛴다", () => {
    expect(toModelMessages([{ role: "function", content: "x" }])).toEqual([]);
  });
});
