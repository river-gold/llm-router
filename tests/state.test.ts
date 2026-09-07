import { describe, expect, it, vi } from "vitest";

let stored: string | undefined;
let writeFails = false;

vi.stubGlobal("Bun", {
  file: () => ({
    json: async (): Promise<unknown> => {
      if (stored === undefined) throw new Error("ENOENT");
      return JSON.parse(stored) as unknown;
    },
  }),
  write: async (): Promise<void> => {
    if (writeFails) throw new Error("disk full");
  },
});

const decision = (id: string) => ({
  profile: "p",
  tier: "low" as const,
  targetProvider: "a",
  targetModelId: id,
  targetLabel: `a/${id}`,
  reasoning: "r",
  timestamp: 1,
});

describe("state 모듈", () => {
  it("누락된 필드에 기본값을 두고 저장된 상태를 로드한다", async () => {
    vi.resetModules();
    delete process.env.LLM_ROUTER_STATE;
    const mod = await import("../src/state");
    stored = JSON.stringify({ accumulatedInputTokens: 3 });
    mod.setStatePath("s1.json");
    await mod.loadState();
    await mod.loadState();
    const snap = mod.snapshot();
    expect(snap.accumulatedInputTokens).toBe(3);
    expect(snap.accumulatedOutputTokens).toBe(0);
    expect(snap.debugHistory).toEqual([]);
    expect(snap.lastDecision).toBeUndefined();
    expect(snap.totalTokens).toBe(3);
  });

  it("가져오기 시점에 LLM_ROUTER_STATE를 우선한다", async () => {
    vi.resetModules();
    process.env.LLM_ROUTER_STATE = "custom.json";
    const mod = await import("../src/state");
    stored = JSON.stringify({ accumulatedOutputTokens: 7 });
    await mod.loadState();
    expect(mod.snapshot().accumulatedOutputTokens).toBe(7);
    delete process.env.LLM_ROUTER_STATE;
  });

  it("상태 파일이 없으면 새로 시작한다", async () => {
    vi.resetModules();
    const mod = await import("../src/state");
    stored = undefined;
    mod.setStatePath("missing.json");
    await mod.loadState();
    expect(mod.snapshot().totalTokens).toBe(0);
  });

  it("사용량을 누적하고 디버그 히스토리를 제한하며 쓰기 실패를 허용한다", async () => {
    vi.resetModules();
    const mod = await import("../src/state");
    stored = undefined;
    writeFails = true;
    mod.setStatePath("w.json");
    await mod.loadState();
    const d = decision("x");
    mod.recordDecision(d, { inputTokens: 2, outputTokens: 3 });
    mod.recordDecision(d, { inputTokens: 1, outputTokens: 1 }, false);
    for (let i = 0; i < 25; i++) {
      mod.recordDecision(decision(`m${i}`), { inputTokens: 0, outputTokens: 0 }, true);
    }
    const snap = mod.snapshot();
    expect(snap.totalTokens).toBe(7);
    expect(snap.lastDecision?.targetModelId).toBe("m24");
    expect(snap.debugHistory).toHaveLength(20);
    expect(snap.debugHistory[0].targetModelId).toBe("m5");
    snap.debugHistory.push(decision("mut"));
    expect(mod.snapshot().debugHistory).toHaveLength(20);
    writeFails = false;
  });

  it("저장된 전체 상태를 로드한다", async () => {
    vi.resetModules();
    const mod = await import("../src/state");
    const d = decision("full");
    stored = JSON.stringify({
      accumulatedInputTokens: 1,
      accumulatedOutputTokens: 2,
      debugHistory: [d],
      lastDecision: d,
    });
    mod.setStatePath("full.json");
    await mod.loadState();
    const snap = mod.snapshot();
    expect(snap.debugHistory).toHaveLength(1);
    expect(snap.lastDecision?.targetModelId).toBe("full");
  });
});
