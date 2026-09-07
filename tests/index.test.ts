import { beforeEach, describe, expect, it, vi } from "vitest";
import { startRouter } from "../src/index";
import { reloadConfig } from "../src/api/server";
import { loadEnvFile, resolveEnvPath } from "../src/env";
import { loadState, setStatePath } from "../src/state";

vi.mock("../src/api/server", () => ({
  app: { fetch: () => new Response("ok") },
  reloadConfig: vi.fn(),
}));
vi.mock("../src/state", () => ({ loadState: vi.fn(), setStatePath: vi.fn() }));
vi.mock("../src/env", () => ({
  loadEnvFile: vi.fn(async () => []),
  resolveEnvPath: vi.fn((p: string) => `${p}.env`),
}));

const reloadConfigMock = vi.mocked(reloadConfig);
const loadStateMock = vi.mocked(loadState);

beforeEach(() => {
  vi.clearAllMocks();
});

const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
  throw new Error("process.exit");
}) as never);
vi.spyOn(console, "log").mockImplementation(() => {});
vi.spyOn(console, "error").mockImplementation(() => {});

describe("entrypoint 진입점", () => {
  it("진입점 에러를 보고한다", async () => {
    const mod = await import("../src/index");
    await expect(mod.entryPromise).resolves.toBeUndefined();
    await expect(mod.entrySettled).resolves.toEqual({ status: "skipped" });
    await expect(mod.settleEntryError(new mod.EntryError("[llm-router] x"))).rejects.toThrow(
      "process.exit",
    );
    expect(console.error).toHaveBeenCalledWith("[llm-router] x");
    await expect(mod.settleEntryError(new Error("plain"))).rejects.toThrow("process.exit");
    expect(console.error).toHaveBeenCalledWith("Error: plain");
  });
});

describe("entrypoint-extra 진입점", () => {
  it("기본 진입점을 노출한다", async () => {
    const mod = await import("../src/index");
    const entry = await mod.entryPromise;
    expect(entry).toBeUndefined();
    expect(mod.default).toBeUndefined();
  });

  it("vitest 밖에서 진입점을 실행한다", async () => {
    const mod = await import("../src/index");
    await expect(
      mod.runEntry(Promise.resolve({ port: 1, hostname: "h", fetch: (() => {}) as never })),
    ).resolves.toEqual({ port: 1, hostname: "h", fetch: expect.any(Function) });
    const consoleSpy = vi.mocked(console.error);
    const before = consoleSpy.mock.calls.length;
    const exitBefore = exitSpy.mock.calls.length;
    await expect(
      mod.settleEntryError(new mod.EntryError("[llm-router] entry bad")),
    ).rejects.toThrow("process.exit");
    expect(consoleSpy.mock.calls.length).toBeGreaterThan(before);
    expect(consoleSpy.mock.calls[consoleSpy.mock.calls.length - 1]).toEqual([
      "[llm-router] entry bad",
    ]);
    expect(exitSpy.mock.calls.length).toBeGreaterThan(exitBefore);
  });
});

describe("startRouter 함수", () => {
  it("기본값으로 시작한다", async () => {
    const entry = await startRouter({});
    expect(entry).toMatchObject({ port: 4891, hostname: "127.0.0.1" });
    expect(typeof entry.fetch).toBe("function");
    expect(reloadConfigMock).toHaveBeenCalledWith(undefined);
    expect(loadStateMock).toHaveBeenCalled();
  });

  it("env 포트와 설정을 우선한다", async () => {
    const entry = await startRouter({ LLM_ROUTER_PORT: "5000", LLM_ROUTER_CONFIG: "c.json" });
    expect(entry.port).toBe(5000);
    expect(reloadConfigMock).toHaveBeenCalledWith("c.json");
  });

  it("설정 옆의 .env를 로드하고 상태 경로를 적용한다", async () => {
    const loadEnvFileMock = vi.mocked(loadEnvFile);
    const setStatePathMock = vi.mocked(setStatePath);
    await startRouter({ LLM_ROUTER_CONFIG: "conf/r.json", LLM_ROUTER_STATE: "s.json" });
    expect(resolveEnvPath).toHaveBeenCalledWith("conf/r.json");
    expect(loadEnvFileMock).toHaveBeenCalledWith(
      expect.objectContaining({ LLM_ROUTER_CONFIG: "conf/r.json" }),
      "conf/r.json.env",
    );
    expect(setStatePathMock).toHaveBeenCalledWith("s.json");
  });

  it("설정 실패를 진입점 에러로 감싼다", async () => {
    reloadConfigMock.mockRejectedValue(new Error("bad config"));
    await expect(startRouter({})).rejects.toThrow("[llm-router] bad config");
  });

  it("실제 부팅 실패를 보고한다", async () => {
    const exterior = await import("../src/index");
    const entryError = new exterior.EntryError("[llm-router] entry bad");
    await expect(exterior.settleEntryError(entryError)).rejects.toThrow("process.exit");
    expect(console.error).toHaveBeenCalledWith("[llm-router] entry bad");
    expect(exitSpy).toHaveBeenCalledWith(1);
    await expect(exterior.settleEntryError(new Error("plain"))).rejects.toThrow("process.exit");
  });

  it("조건에 따라 main 진입점을 실행한다", async () => {
    const mod = await import("../src/index");
    await expect(mod.runMain({ main: true } as ImportMeta)).rejects.toThrow("process.exit");
    expect(mod.asEntryError(new Error("x"))).toBeInstanceOf(mod.EntryError);
    const kept = new mod.EntryError("kept");
    expect(mod.asEntryError(kept)).toBe(kept);
  });

  it("진입점이 아닌 실행 실패를 보고한다", async () => {
    const mod = await import("../src/index");
    await expect(mod.runEntry(Promise.reject(new Error("nope")))).rejects.toThrow("process.exit");
    expect(console.error).toHaveBeenCalledWith("Error: nope");
    await expect(
      mod.runEntry(Promise.resolve({ port: 1, hostname: "h", fetch: (() => {}) as never })),
    ).resolves.toEqual({ port: 1, hostname: "h", fetch: expect.any(Function) });
  });

  it("예상치 못한 진입점 실패를 거부한다", async () => {
    const mod = await import("../src/index");
    await expect(mod.settleEntry(Promise.reject(new Error("boom")))).resolves.toEqual({
      status: "rejected",
      value: undefined,
    });
    await expect(mod.settleEntry(Promise.resolve(undefined))).resolves.toEqual({
      status: "skipped",
    });
  });

  it("process.exit 없이 진입점을 종료 처리한다", async () => {
    const mod = await import("../src/index");
    await expect(mod.entrySettled).resolves.toEqual({ status: "skipped" });
    await expect(mod.settleEntry()).resolves.toEqual({ status: "skipped" });
    await expect(
      mod.settleEntry(Promise.resolve({ port: 1, hostname: "h", fetch: (() => {}) as never })),
    ).resolves.toEqual({
      status: "fulfilled",
      value: { port: 1, hostname: "h", fetch: expect.any(Function) },
    });
    await expect(mod.settleEntry(Promise.resolve(undefined))).resolves.toEqual({
      status: "skipped",
    });
    await expect(mod.settleEntry(Promise.reject(new Error("x")))).resolves.toEqual({
      status: "rejected",
      value: undefined,
    });
  });
});
