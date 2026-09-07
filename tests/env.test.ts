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

describe("parseEnvText 함수", () => {
  it("할당, export, 주석을 파싱한다", () => {
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

  it("닫히지 않은 따옴표를 문자 그대로 유지한다", () => {
    expect(parseEnvText('HALF="abc')).toEqual({ HALF: '"abc' });
  });
});

describe("resolveEnvPath 함수", () => {
  it("설정 파일 옆에 .env를 둔다", () => {
    expect(resolveEnvPath("./config/model-router.jsonc")).toBe("config/.env");
    expect(resolveEnvPath("router.json")).toBe(".env");
  });
});

describe("loadEnvFile 함수", () => {
  it("없는 키를 설정하고 보고한다", async () => {
    files.set("a.env", "ONE=1\nTWO=2");
    const env: NodeJS.ProcessEnv = { TWO: "keep" };
    expect(await loadEnvFile(env, "a.env")).toEqual(["ONE"]);
    expect(env).toMatchObject({ ONE: "1", TWO: "keep" });
  });

  it("없는 파일을 무시한다", async () => {
    expect(await loadEnvFile({}, "nope.env")).toEqual([]);
  });
});
