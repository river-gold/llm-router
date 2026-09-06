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

describe("parseCanonicalModelRef", () => {
  it("parses provider/model with thinking", () => {
    expect(parseCanonicalModelRef("openai/gpt-5#high")).toEqual({
      provider: "openai",
      modelId: "gpt-5",
      thinking: "high",
    });
  });

  it("parses provider/model without thinking", () => {
    expect(parseCanonicalModelRef("grok/grok-4")).toEqual({
      provider: "grok",
      modelId: "grok-4",
    });
  });

  it("treats empty thinking suffix as absent", () => {
    expect(parseCanonicalModelRef("p/m#")).toEqual({ provider: "p", modelId: "m" });
  });

  it("trims whitespace around provider, model, and thinking", () => {
    expect(parseCanonicalModelRef(" p / m # low ")).toEqual({
      provider: "p",
      modelId: "m",
      thinking: "low",
    });
  });

  it("rejects refs without a slash", () => {
    expect(() => parseCanonicalModelRef("gpt-5")).toThrow('Invalid model reference "gpt-5"');
  });

  it("rejects empty provider or model", () => {
    expect(() => parseCanonicalModelRef("/m")).toThrow("Invalid model reference");
    expect(() => parseCanonicalModelRef("p/")).toThrow("Invalid model reference");
    expect(() => parseCanonicalModelRef(" / ")).toThrow("Invalid model reference");
  });

  it("rejects unknown thinking", () => {
    expect(() => parseCanonicalModelRef("p/m#ultra")).toThrow('Invalid thinking "ultra"');
  });
});

describe("formatModelRef", () => {
  it("formats with and without thinking", () => {
    expect(formatModelRef("p", "m", "low")).toBe("p/m#low");
    expect(formatModelRef("p", "m")).toBe("p/m");
  });
});

describe("isRouterTier", () => {
  it("accepts tiers and rejects others", () => {
    expect(isRouterTier("high")).toBe(true);
    expect(isRouterTier("ultra")).toBe(false);
  });
});

describe("parseServerModel", () => {
  it("parses profile-only and profile+tier", () => {
    expect(parseServerModel("router/balanced")).toEqual({ profile: "balanced" });
    expect(parseServerModel("router/grok/high")).toEqual({ profile: "grok", tier: "high" });
  });

  it("rejects non-router, short, profile-less, and bad-tier models", () => {
    expect(() => parseServerModel("openai/x")).toThrow("Invalid router model");
    expect(() => parseServerModel("x")).toThrow("Invalid router model");
    expect(() => parseServerModel("router/")).toThrow("Missing profile");
    expect(() => parseServerModel("router/p/ultra")).toThrow('Invalid tier "ultra"');
  });
});

describe("thinkingToTier", () => {
  it("maps every thinking level", () => {
    expect(thinkingToTier("max")).toBe("max");
    expect(thinkingToTier("xhigh")).toBe("xhigh");
    expect(thinkingToTier("high")).toBe("high");
    expect(thinkingToTier("medium")).toBe("medium");
    expect(thinkingToTier("low")).toBe("low");
    expect(thinkingToTier("minimal")).toBe("minimal");
    expect(thinkingToTier("off")).toBe("minimal");
  });
});

describe("resolveAvailableTier", () => {
  it("returns the preferred tier when configured", () => {
    expect(resolveAvailableTier({ medium: {} }, "medium")).toBe("medium");
  });

  it("searches upward then downward", () => {
    expect(resolveAvailableTier({ high: {} }, "medium")).toBe("high");
    expect(resolveAvailableTier({ low: {} }, "medium")).toBe("low");
  });

  it("returns preferred when nothing is configured", () => {
    expect(resolveAvailableTier({}, "medium")).toBe("medium");
  });
});

describe("toModelEntry", () => {
  it("wraps shorthand strings and keeps objects", () => {
    expect(toModelEntry("openai/x#low")).toEqual({ model: "openai/x#low" });
    const entry = { model: "openai/x", thinking: "high" as const };
    expect(toModelEntry(entry)).toBe(entry);
  });
});

describe("buildRoutingDecision", () => {
  const profile: RouterProfile = {
    medium: { models: [{ model: "openai/gpt-5#low", thinking: "high" }] },
  };

  it("builds a decision from the primary ref thinking", () => {
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

  it("falls back to entry thinking when the ref has none", () => {
    const d = buildRoutingDecision(
      "p",
      { medium: { models: [{ model: "openai/gpt-5", thinking: "high" }] } },
      "medium",
      "r",
    );
    expect(d.thinking).toBe("high");
    expect(d.isClassifier).toBeUndefined();
  });

  it("throws for missing tier or missing models", () => {
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

describe("failureMemory", () => {
  it("builds keys and normalizes refs", () => {
    expect(chainKey("p", "low")).toBe("p/low");
    expect(normalizeRef("  a/b  ")).toBe("a/b");
  });

  it("records and reports failures", () => {
    resetFailures();
    expect(failedRefs("p", "low").size).toBe(0);
    recordFailure("p", "low", "  openai/x  ");
    expect([...failedRefs("p", "low")]).toEqual(["openai/x"]);
  });

  it("resets all and reports counts", () => {
    resetFailures();
    recordFailure("a", "low", "m1");
    recordFailure("b", "high", "m2");
    expect(resetFailures()).toBe(2);
    expect(resetFailures()).toBe(0);
  });

  it("resets a single profile by exact or prefix match", () => {
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

  it("splits tried and skipped with normalization", () => {
    const { tried, skipped } = filterFailed(["a", " b "], new Set(["b"]));
    expect(tried).toEqual(["a"]);
    expect(skipped).toEqual([" b "]);
  });

  it("stringifies errors for cooldown classification", () => {
    expect(errorText("raw")).toBe("raw");
    expect(errorText(new Error("boom"))).toBe("boom");
    expect(errorText({ message: "obj" })).toBe('{"message":"obj"}');
    expect(errorText(7)).toBe("7");
  });

  it("cools down only rate-limit errors", () => {
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

  it("drops expired cooldowns and keeps the later until", () => {
    resetFailures();
    const now = 1_000;
    recordFailure("p", "low", "a", now);
    expect(failedRefs("p", "low", now).size).toBe(0);
    recordFailure("p", "low", "b", now + 10);
    recordFailure("p", "low", "b", now + 5);
    expect([...failedRefs("p", "low", now)]).toEqual(["b"]);
    expect(failedRefs("p", "low", now + 10).size).toBe(0);
  });

  it("reports retry time without a reset command", () => {
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

describe("toModelMessages", () => {
  it("converts system and developer messages", () => {
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

  it("converts user messages with text and images", () => {
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

  it("converts assistant messages with text and tool calls", () => {
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

  it("converts tool messages and resolves names", () => {
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

  it("skips unknown roles", () => {
    expect(toModelMessages([{ role: "function", content: "x" }])).toEqual([]);
  });
});
