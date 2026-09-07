import { afterEach, describe, expect, it, vi } from "vitest";
import { configuredTiers, loadConfig, singleTier } from "../src/config";

const files = new Map<string, string>();
let readError: string | undefined;

vi.stubGlobal("Bun", {
  file: (path: string) => ({
    text: async (): Promise<string> => {
      if (readError) throw new Error(readError);
      const hit = files.get(path);
      if (hit === undefined) throw new Error(`ENOENT: ${path}`);
      return hit;
    },
  }),
});

const VALID = JSON.stringify({
  profiles: { balanced: { medium: { models: ["openai/x"] } } },
});

afterEach(() => {
  files.clear();
  readError = undefined;
  delete process.env.LLM_ROUTER_CONFIG;
});

describe("loadConfig", () => {
  it("loads from an explicit path", async () => {
    files.set("r.json", VALID);
    const { config, warnings } = await loadConfig("r.json");
    expect(Object.keys(config.profiles)).toEqual(["balanced"]);
    expect(warnings).toEqual([]);
  });

  it("prefers explicit path over env", async () => {
    files.set("a.json", VALID);
    files.set("b.json", VALID);
    process.env.LLM_ROUTER_CONFIG = "b.json";
    await loadConfig("a.json");
  });

  it("falls back to env then default path", async () => {
    files.set("env.json", VALID);
    process.env.LLM_ROUTER_CONFIG = "env.json";
    await loadConfig();
    files.set("./config/model-router.jsonc", VALID);
    delete process.env.LLM_ROUTER_CONFIG;
    await loadConfig();
  });

  it("tolerates trailing commas", async () => {
    files.set(
      "trail.jsonc",
      '{ "profiles": { "p": { "medium": { "models": ["openai/x"], }, }, }, }',
    );
    const { config } = await loadConfig("trail.jsonc");
    expect(Object.keys(config.profiles)).toEqual(["p"]);
  });

  it("strips // comments", async () => {
    files.set("c.json", "// top comment\n" + VALID + "\n// bottom comment\n");
    const { config } = await loadConfig("c.json");
    expect(Object.keys(config.profiles)).toEqual(["balanced"]);
  });

  it("handles lines without comments", async () => {
    files.set("plain.json", VALID);
    await loadConfig("plain.json");
  });

  it("throws on unreadable file", async () => {
    readError = "denied";
    await expect(loadConfig("x.json")).rejects.toThrow(
      'Cannot read router config "x.json": denied',
    );
  });

  it("throws on invalid JSON", async () => {
    files.set("bad.json", "{oops");
    await expect(loadConfig("bad.json")).rejects.toThrow(
      'Invalid JSON in router config "bad.json"',
    );
  });

  it("throws on schema violations", async () => {
    files.set("tierless.json", JSON.stringify({ profiles: { p: {} } }));
    await expect(loadConfig("tierless.json")).rejects.toThrow("Invalid router config");
    files.set(
      "badnum.json",
      JSON.stringify({
        profiles: { p: { medium: { models: [{ model: "openai/x", thinking: "ultra" }] } } },
      }),
    );
    await expect(loadConfig("badnum.json")).rejects.toThrow("Invalid router config");
    files.set(
      "badapi.json",
      JSON.stringify({
        profiles: { p: { medium: { models: [{ model: "openai/x", api: "rest" }] } } },
      }),
    );
    await expect(loadConfig("badapi.json")).rejects.toThrow("Invalid router config");
  });

  it("loads string classifier shorthands", async () => {
    files.set(
      "clf.json",
      JSON.stringify({
        classifierModels: [
          "openai/x#low",
          { model: "openai/y", thinking: "high", api: "openai-responses" },
        ],
        profiles: { p: { medium: { models: ["openai/x"] } } },
      }),
    );
    const { config } = await loadConfig("clf.json");
    expect(config.classifierModels).toEqual([
      { model: "openai/x#low" },
      { model: "openai/y", thinking: "high", api: "openai-responses" },
    ]);
  });

  it("loads model entry api and thinking", async () => {
    files.set(
      "api.json",
      JSON.stringify({
        profiles: {
          p: {
            medium: {
              models: [{ model: "openai/x", thinking: "low", api: "openai-responses" }],
            },
          },
        },
      }),
    );
    const { config } = await loadConfig("api.json");
    expect(config.profiles["p"]?.medium?.models).toEqual([
      { model: "openai/x", thinking: "low", api: "openai-responses" },
    ]);
  });

  it("loads full and partial tierGuides", async () => {
    files.set(
      "guides.json",
      JSON.stringify({
        tierGuides: {
          minimal: "m",
          low: "l",
          medium: "med",
          high: "h",
          xhigh: "x",
          max: "top",
        },
        profiles: { p: { medium: { models: ["openai/x"] } } },
      }),
    );
    const full = await loadConfig("guides.json");
    expect(full.config.tierGuides).toEqual({
      minimal: "m",
      low: "l",
      medium: "med",
      high: "h",
      xhigh: "x",
      max: "top",
    });
    files.set(
      "partial.json",
      JSON.stringify({
        tierGuides: { low: "Custom low." },
        profiles: { p: { medium: { models: ["openai/x"] } } },
      }),
    );
    const partial = await loadConfig("partial.json");
    expect(partial.config.tierGuides).toEqual({ low: "Custom low." });
  });

  it("trims tierGuides values", async () => {
    files.set(
      "trim.json",
      JSON.stringify({
        tierGuides: { low: "  ok  " },
        profiles: { p: { medium: { models: ["openai/x"] } } },
      }),
    );
    const { config } = await loadConfig("trim.json");
    expect(config.tierGuides).toEqual({ low: "ok" });
  });

  it("throws on empty tierGuides values", async () => {
    files.set(
      "empty.json",
      JSON.stringify({
        tierGuides: { low: "" },
        profiles: { p: { medium: { models: ["openai/x"] } } },
      }),
    );
    await expect(loadConfig("empty.json")).rejects.toThrow("Invalid router config");
  });

  it("throws on whitespace-only tierGuides values", async () => {
    files.set(
      "blank.json",
      JSON.stringify({
        tierGuides: { high: "   " },
        profiles: { p: { medium: { models: ["openai/x"] } } },
      }),
    );
    await expect(loadConfig("blank.json")).rejects.toThrow(
      "tierGuides values must be non-blank strings",
    );
  });

  it("throws on non-string tierGuides values", async () => {
    files.set(
      "nonstring.json",
      JSON.stringify({
        tierGuides: { medium: 123 },
        profiles: { p: { medium: { models: ["openai/x"] } } },
      }),
    );
    await expect(loadConfig("nonstring.json")).rejects.toThrow("Invalid router config");
  });

  it("throws on non-object tierGuides", async () => {
    files.set(
      "bad.json",
      JSON.stringify({
        tierGuides: "nope",
        profiles: { p: { medium: { models: ["openai/x"] } } },
      }),
    );
    await expect(loadConfig("bad.json")).rejects.toThrow("Invalid router config");
  });

  it("throws on unknown tierGuides keys", async () => {
    files.set(
      "unknown.json",
      JSON.stringify({
        tierGuides: { low: "Custom low.", ultra: "nope" },
        profiles: { p: { medium: { models: ["openai/x"] } } },
      }),
    );
    await expect(loadConfig("unknown.json")).rejects.toThrow("Invalid router config");
  });

  it("drops tier-level thinking and api", async () => {
    files.set(
      "tiertop.json",
      JSON.stringify({
        profiles: {
          p: { medium: { models: ["openai/x"], thinking: "high", api: "openai-responses" } },
        },
      }),
    );
    const { config } = await loadConfig("tiertop.json");
    expect(config.profiles["p"]?.medium).toEqual({ models: ["openai/x"] });
  });
});

describe("configuredTiers / singleTier", () => {
  it("lists configured tiers", () => {
    expect(configuredTiers({ low: {}, max: {} })).toEqual(["low", "max"]);
    expect(configuredTiers({})).toEqual([]);
  });

  it("detects single-tier profiles", () => {
    expect(singleTier({ low: {} })).toBe("low");
    expect(singleTier({})).toBeUndefined();
    expect(singleTier({ low: {}, high: {} })).toBeUndefined();
  });
});
