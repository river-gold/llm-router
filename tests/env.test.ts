import { afterEach, describe, expect, it, vi } from "vitest";
import { loadEnvFile, parseEnvText, resolveEnvPath } from "../src/env";

vi.stubGlobal("Bun", {
  file: (path: string) => ({
    text: async (): Promise<string> => {
      const hit = files.get(path);
      if (hit === undefined) throw new Error(`ENOENT: ${path}`);
      return hit;
    },
  }),
});

const files = new Map<string, string>();

afterEach(() => {
  files.clear();
});

describe("parseEnvText", () => {
  it("parses assignments, exports, and comments", () => {
    const parsed = parseEnvText(
      [
        "# comment",
        "",
        "PLAIN=abc",
        "export EXPORTED=def",
        "SPACED =  spaced  # trailing",
        "EMPTY=",
        "SINGLE='a#b'",
        'DOUBLE="x\\ny\\"z\\\\"',
        "NOEQ",
        "9BAD=oops",
        "BAD-KEY=oops",
      ].join("\n"),
    );
    expect(parsed).toEqual({
      PLAIN: "abc",
      EXPORTED: "def",
      SPACED: "spaced",
      EMPTY: "",
      SINGLE: "a#b",
      DOUBLE: 'x\ny"z\\',
    });
    expect(parsed).not.toHaveProperty("NOEQ");
  });

  it("keeps unterminated quotes literal", () => {
    expect(parseEnvText('HALF="abc')).toEqual({ HALF: '"abc' });
  });
});

describe("resolveEnvPath", () => {
  it("places .env next to the config file", () => {
    expect(resolveEnvPath("./config/model-router.jsonc")).toBe("config/.env");
    expect(resolveEnvPath("router.json")).toBe(".env");
  });
});

describe("loadEnvFile", () => {
  it("sets missing keys and reports them", async () => {
    files.set("a.env", "ONE=1\nTWO=2");
    const env: NodeJS.ProcessEnv = { TWO: "keep" };
    expect(await loadEnvFile(env, "a.env")).toEqual(["ONE"]);
    expect(env).toMatchObject({ ONE: "1", TWO: "keep" });
  });

  it("ignores missing files", async () => {
    expect(await loadEnvFile({}, "nope.env")).toEqual([]);
  });
});
