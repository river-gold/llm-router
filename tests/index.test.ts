import { beforeEach, describe, expect, it, vi } from "vitest";
import { startRouter } from "../src/index";
import { reloadConfig } from "../src/api/server";
import { loadState } from "../src/state";

vi.mock("../src/api/server", () => ({
  app: { fetch: () => new Response("ok") },
  reloadConfig: vi.fn(),
}));
vi.mock("../src/state", () => ({ loadState: vi.fn() }));

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

describe("entrypoint", () => {
  it("reports entry errors", async () => {
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

describe("entrypoint-extra", () => {
  it("exposes the default entry", async () => {
    const mod = await import("../src/index");
    const entry = await mod.entryPromise;
    expect(entry).toBeUndefined();
    expect(mod.default).toBeUndefined();
  });

  it("runs the entry outside vitest", async () => {
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

describe("startRouter", () => {
  it("starts with defaults", async () => {
    const entry = await startRouter({});
    expect(entry).toMatchObject({ port: 4891, hostname: "127.0.0.1" });
    expect(typeof entry.fetch).toBe("function");
    expect(reloadConfigMock).toHaveBeenCalledWith(undefined);
    expect(loadStateMock).toHaveBeenCalled();
  });

  it("honors env port and config", async () => {
    const entry = await startRouter({ LLM_ROUTER_PORT: "5000", LLM_ROUTER_CONFIG: "c.json" });
    expect(entry.port).toBe(5000);
    expect(reloadConfigMock).toHaveBeenCalledWith("c.json");
  });

  it("wraps config failures as entry errors", async () => {
    reloadConfigMock.mockRejectedValue(new Error("bad config"));
    await expect(startRouter({})).rejects.toThrow("[llm-router] bad config");
  });

  it("reports real boot failures", async () => {
    const exterior = await import("../src/index");
    const entryError = new exterior.EntryError("[llm-router] entry bad");
    await expect(exterior.settleEntryError(entryError)).rejects.toThrow("process.exit");
    expect(console.error).toHaveBeenCalledWith("[llm-router] entry bad");
    expect(exitSpy).toHaveBeenCalledWith(1);
    await expect(exterior.settleEntryError(new Error("plain"))).rejects.toThrow("process.exit");
  });

  it("runs main entries conditionally", async () => {
    const mod = await import("../src/index");
    await expect(mod.runMain({ main: true } as ImportMeta)).rejects.toThrow("process.exit");
    expect(mod.asEntryError(new Error("x"))).toBeInstanceOf(mod.EntryError);
    const kept = new mod.EntryError("kept");
    expect(mod.asEntryError(kept)).toBe(kept);
  });

  it("reports non-entry run failures", async () => {
    const mod = await import("../src/index");
    await expect(mod.runEntry(Promise.reject(new Error("nope")))).rejects.toThrow("process.exit");
    expect(console.error).toHaveBeenCalledWith("Error: nope");
    await expect(
      mod.runEntry(Promise.resolve({ port: 1, hostname: "h", fetch: (() => {}) as never })),
    ).resolves.toEqual({ port: 1, hostname: "h", fetch: expect.any(Function) });
  });

  it("rejects unexpected entry failures", async () => {
    const mod = await import("../src/index");
    await expect(mod.settleEntry(Promise.reject(new Error("boom")))).resolves.toEqual({
      status: "rejected",
      value: undefined,
    });
    await expect(mod.settleEntry(Promise.resolve(undefined))).resolves.toEqual({
      status: "skipped",
    });
  });

  it("settles entries without touching process.exit", async () => {
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
