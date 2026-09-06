import { streamText, stepCountIs, tool, type ModelMessage, type ToolSet } from "ai";
import { getBackendModel } from "../backends";
import { parseCanonicalModelRef } from "../modelRef";
import { recordDecision } from "../state";
import type {
  RouterConfig,
  RouterProfile,
  RouterTier,
  RoutingDecision,
  ThinkingLevel,
} from "../types";
import { runClassifier } from "./classifier";
import { buildRoutingDecision, resolveAvailableTier, thinkingToTier } from "./decision";
import { failedRefs, filterFailed, recordFailure } from "./failureMemory";
import { singleTier } from "../config";

export type RouterEvent =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | { type: "tool-call-delta"; id: string; name?: string; argsDelta?: string }
  | {
      type: "done";
      finishReason: string;
      usage: { inputTokens: number; outputTokens: number; totalTokens: number };
    };

export interface RouteRequest {
  profile: string;
  /** Explicit tier from "router/<profile>/<tier>". Wins over everything. */
  explicitTier?: RouterTier;
  /** Client-requested reasoning effort (reasoning_effort param). */
  effort?: string;
  messages: ModelMessage[];
  tools?: ToolSet;
  toolChoice?: "auto" | "none" | "required";
  temperature?: number;
  topP?: number;
  maxTokens?: number;
}

const effortToThinking = (effort: string): ThinkingLevel | undefined => {
  const v = effort.trim().toLowerCase();
  if (v === "none" || v === "auto" || v === "") return undefined;
  if (v === "minimal" || v === "low") return "low";
  if (v === "medium") return "medium";
  if (v === "high") return "high";
  if (v === "xhigh" || v === "max") return v as ThinkingLevel;
  return undefined;
};

const hasToolMessages = (messages: ModelMessage[]): boolean =>
  messages.some((m) => m.role === "tool");

export const resolveTier = async (
  config: RouterConfig,
  profileName: string,
  profile: RouterProfile,
  req: Pick<RouteRequest, "explicitTier" | "effort" | "messages">,
): Promise<{ decision: RoutingDecision; classifierUsed: boolean }> => {
  if (req.explicitTier) {
    const tier = resolveAvailableTier(profile, req.explicitTier);
    return {
      decision: buildRoutingDecision(
        profileName,
        profile,
        tier,
        `Explicit tier "${req.explicitTier}"${tier !== req.explicitTier ? ` resolved to ${tier}` : ""}.`,
      ),
      classifierUsed: false,
    };
  }
  const one = singleTier(profile);
  if (one) {
    return {
      decision: buildRoutingDecision(
        profileName,
        profile,
        one,
        `Single tier "${one}" defined — skipping classifier/thinking mapping.`,
      ),
      classifierUsed: false,
    };
  }
  const thinking = req.effort ? effortToThinking(req.effort) : undefined;
  if (thinking) {
    const preferred = thinkingToTier(thinking);
    const tier = resolveAvailableTier(profile, preferred);
    return {
      decision: buildRoutingDecision(
        profileName,
        profile,
        tier,
        `Reasoning effort ${req.effort} mapped to ${tier} tier.`,
      ),
      classifierUsed: false,
    };
  }
  const classifiers = profile.classifierModels ?? config.classifierModels ?? [];
  if (classifiers.length > 0 && !hasToolMessages(req.messages)) {
    const result = await runClassifier(classifiers, req.messages, config.historySize ?? 0);
    if (result) {
      const tier = resolveAvailableTier(profile, result.tier);
      return {
        decision: buildRoutingDecision(
          profileName,
          profile,
          tier,
          `Classifier selected ${result.tier}${tier !== result.tier ? `, resolved to ${tier}` : ""}.`,
          true,
        ),
        classifierUsed: true,
      };
    }
  }
  const tier = resolveAvailableTier(profile, "medium");
  return {
    decision: buildRoutingDecision(
      profileName,
      profile,
      tier,
      hasToolMessages(req.messages)
        ? "Tool-loop continuation: kept default tier without re-classifying."
        : "Classifier unavailable or failed: defaulted to medium tier.",
    ),
    classifierUsed: false,
  };
};

export const candidateRefs = (profile: RouterProfile, decision: RoutingDecision): string[] => {
  const models = profile[decision.tier]?.models ?? [];
  if (models.length > 0) return [...new Set(models)];
  return [`${decision.targetProvider}/${decision.targetModelId}`];
};

export async function* attemptModel(
  ref: string,
  profile: RouterProfile,
  decision: RoutingDecision,
  req: RouteRequest,
): AsyncGenerator<RouterEvent> {
  const { provider, modelId, thinking } = parseCanonicalModelRef(ref);
  const tierCfg = profile[decision.tier];
  const backend = await getBackendModel(provider, modelId, thinking ?? tierCfg?.thinking);
  const maxTokens = req.maxTokens ?? tierCfg?.maxTokens;
  const result = streamText({
    model: backend.model,
    messages: req.messages,
    ...(req.tools ? { tools: req.tools, stopWhen: stepCountIs(1) } : {}),
    ...(req.toolChoice === "none" ? { toolChoice: "none" as const } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.topP !== undefined ? { topP: req.topP } : {}),
    ...(maxTokens !== undefined ? { maxOutputTokens: maxTokens } : {}),
    ...(backend.effort ? { providerOptions: { openai: { reasoningEffort: backend.effort } } } : {}),
  });

  let contentStarted = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let finishReason = "stop";
  let sawFinish = false;
  let sawContent = false;
  try {
    for await (const part of result.fullStream) {
      if (part.type === "text-delta") {
        contentStarted = true;
        sawContent = true;
        yield { type: "text-delta", text: part.text };
      } else if (part.type === "reasoning-delta") {
        contentStarted = true;
        sawContent = true;
        yield { type: "reasoning-delta", text: part.text };
      } else if (part.type === "tool-input-start") {
        contentStarted = true;
        sawContent = true;
        yield { type: "tool-call-delta", id: part.id, name: part.toolName };
      } else if (part.type === "tool-input-delta") {
        yield { type: "tool-call-delta", id: part.id, argsDelta: part.delta };
      } else if (part.type === "finish") {
        sawFinish = true;
        if (part.finishReason !== "stop" && part.finishReason !== "tool-calls") {
          throw new Error("Model stream ended without terminal event.");
        }
        finishReason = part.finishReason === "tool-calls" ? "tool_calls" : "stop";
        inputTokens = part.totalUsage.inputTokens ?? 0;
        outputTokens = part.totalUsage.outputTokens ?? 0;
      } else if (part.type === "error") {
        throw part.error;
      }
    }
  } catch (e) {
    if (!contentStarted) {
      recordFailure(decision.profile, decision.tier, ref);
      throw e;
    }
    const detail = (e as Error).message;
    if (detail === "Model stream ended without terminal event.") throw e;
    throw new Error(`NON_RETRYABLE: ${detail}`);
  }
  if (!sawFinish && sawContent) {
    throw new Error("Model stream ended without terminal event.");
  }
  if (!sawFinish) {
    throw new Error(`Model "${ref}" produced no output.`);
  }
  yield {
    type: "done",
    finishReason,
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
    },
  };
}

/**
 * Run one model attempt, buffering events so a truncated stream (events but
 * no terminal `done`) never leaks partial output to the caller.
 */
export const runAttempt = async (
  ref: string,
  profile: RouterProfile,
  decision: RoutingDecision,
  req: RouteRequest,
  config: RouterConfig,
  index: number,
  attempt: typeof attemptModel = attemptModel,
): Promise<
  | { status: "ok"; events: RouterEvent[] }
  | { status: "empty"; error: Error }
  | { status: "unfinished" }
> => {
  const events: RouterEvent[] = [];
  try {
    for await (const event of attempt(ref, profile, { ...decision }, req)) {
      events.push(event);
      if (event.type === "done") {
        if (index > 0) decision.isFallback = true;
        recordDecision({ ...decision, isFallback: decision.isFallback }, event.usage, config.debug);
        return { status: "ok", events };
      }
    }
  } catch (raw) {
    const e = raw as Error;
    if (e.message.startsWith("NON_RETRYABLE:")) {
      throw new Error(e.message.slice("NON_RETRYABLE: ".length));
    }
    const message = e.message;
    if (message === "Model stream ended without terminal event." && events.length > 0) {
      return { status: "unfinished" };
    }
    return { status: "empty", error: e as Error };
  }
  return { status: "unfinished" };
};

/**
 * Route one chat request: resolve tier → try tier models in order with
 * fallback on pre-content failures → yield normalized events.
 */
export async function* routeRequest(
  config: RouterConfig,
  req: RouteRequest,
): AsyncGenerator<RouterEvent> {
  const profile = config.profiles[req.profile];
  if (!profile) {
    throw new Error(
      `Unknown profile "${req.profile}". Available: ${Object.keys(config.profiles).join(", ")}.`,
    );
  }
  const { decision } = await resolveTier(config, req.profile, profile, req);
  const refs = candidateRefs(profile, decision);
  const { tried, skipped } = filterFailed(refs, failedRefs(req.profile, decision.tier));
  if (tried.length === 0) {
    throw new Error(
      `All models in ${decision.tier} tier are marked failed (skipped: ${skipped.join(", ")}). POST /router/reset-failures to retry.`,
    );
  }
  let lastError = "unknown";
  for (const [index, ref] of tried.entries()) {
    const outcome = await runAttempt(ref, profile, decision, req, config, index);
    if (outcome.status === "ok") {
      for (const event of outcome.events) yield event;
      return;
    }
    if (outcome.status === "unfinished") {
      lastError = "Model stream ended without terminal event.";
    } else {
      lastError = outcome.error.message;
    }
  }
  throw new Error(
    `All ${tried.length} model(s) in ${decision.tier} tier failed. Last error: ${lastError}`,
  );
}

export const passthroughTools = (
  tools: Record<string, { description?: string; parameters: unknown }>,
): ToolSet => {
  const out: ToolSet = {};
  for (const [name, def] of Object.entries(tools)) {
    out[name] = tool({
      description: def.description ?? name,
      inputSchema: def.parameters as never,
    });
  }
  return out;
};
