import type { RoutingDecision } from "./types";

interface StateFile {
  accumulatedInputTokens: number;
  accumulatedOutputTokens: number;
  debugHistory: RoutingDecision[];
  lastDecision?: RoutingDecision;
}

const MAX_DEBUG_HISTORY = 20;

const state: StateFile = {
  accumulatedInputTokens: 0,
  accumulatedOutputTokens: 0,
  debugHistory: [],
};

let statePath = process.env.LLM_ROUTER_STATE ?? "./data/router-state.json";
let loaded = false;

export const setStatePath = (path: string): void => {
  statePath = path;
  loaded = false;
};

export const loadState = async (): Promise<void> => {
  if (loaded) return;
  loaded = true;
  try {
    const parsed = (await Bun.file(statePath).json()) as Partial<StateFile>;
    state.accumulatedInputTokens = parsed.accumulatedInputTokens ?? 0;
    state.accumulatedOutputTokens = parsed.accumulatedOutputTokens ?? 0;
    state.debugHistory = parsed.debugHistory ?? [];
    state.lastDecision = parsed.lastDecision;
  } catch {
    // No prior state; start fresh.
  }
};

const persist = async (): Promise<void> => {
  try {
    await Bun.write(statePath, JSON.stringify(state, null, 2));
  } catch {
    // State persistence is best-effort.
  }
};

export const recordDecision = (
  decision: RoutingDecision,
  usage: { inputTokens: number; outputTokens: number },
  debug?: boolean,
): void => {
  state.accumulatedInputTokens += usage.inputTokens;
  state.accumulatedOutputTokens += usage.outputTokens;
  state.lastDecision = decision;
  if (debug) {
    state.debugHistory.push(decision);
    if (state.debugHistory.length > MAX_DEBUG_HISTORY) {
      state.debugHistory.splice(0, state.debugHistory.length - MAX_DEBUG_HISTORY);
    }
  }
  void persist();
};

export const snapshot = (): StateFile & { totalTokens: number } => ({
  ...state,
  debugHistory: [...state.debugHistory],
  totalTokens: state.accumulatedInputTokens + state.accumulatedOutputTokens,
});
