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
    files.set("badnum.json", JSON.stringify({ profiles: { p: { medium: { maxTokens: -1 } } } }));
    await expect(loadConfig("badnum.json")).rejects.toThrow("Invalid router config");
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
