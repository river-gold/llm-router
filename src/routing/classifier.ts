import { generateText } from "ai";
import type { ModelMessage } from "ai";
import { getBackendModel } from "../backends";
import { parseCanonicalModelRef, isRouterTier } from "../modelRef";
import type { ClassifierConfig, RouterTier, TierGuides } from "../types";

export const TIER_GUIDE_ORDER: readonly RouterTier[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export const DEFAULT_TIER_GUIDES: Record<RouterTier, string> = {
  minimal:
    "Mechanical transforms with no judgment: format, typo, rename, indent, template fill, quote-from-context.",
  low: "Cheap language/lookup work: summaries, changelogs, commit messages, quick explanations, small bounded transforms, simple read-only lookup.",
  medium:
    "Execute a known plan: spec-following implementation, multi-file edits, focused debugging with known cause, tests/fixes, routine wiring.",
  high: "Local design under uncertainty: module architecture, planning, tradeoff analysis, broad debugging, large refactors, codebase research.",
  xhigh:
    "Cross-cutting or high-blast-radius work: migrations, ambiguous RCA, security-sensitive changes, multi-repo/system design, risky refactors.",
  max: "Novel or irreversible work: greenfield strategy, adversarial audit, long-horizon research with conflicting sources, eval/algorithm invention.",
};

export const buildClassifierSystemPrompt = (guides?: TierGuides): string => {
  const lines = TIER_GUIDE_ORDER.map(
    (tier) => `- ${tier}: ${guides?.[tier] ?? DEFAULT_TIER_GUIDES[tier]}`,
  );
  return `You are a model router classifier. Your job is to categorize the user's latest request into one of six tiers: "minimal", "low", "medium", "high", "xhigh", or "max".

Tiers:
${lines.join("\n")}

Do not answer the user's request. Do not use tools.
Return ONLY one word: minimal|low|medium|high|xhigh|max. No other text.`;
};

export const CLASSIFIER_SYSTEM_PROMPT = buildClassifierSystemPrompt();

const OUTPUT_CONSTRAINT =
  "Classify the latest user message. Output ONLY one word: minimal|low|medium|high|xhigh|max. No other text.";

export const parseClassifierOutput = (fullText: string): RouterTier | undefined => {
  const trimmed = fullText.trim().toLowerCase();
  if (!trimmed || !isRouterTier(trimmed)) return undefined;
  return trimmed;
};

export interface ClassifierAttempt {
  model: string;
  error?: string;
}

const lastUserText = (messages: ModelMessage[]): string => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    const content = m.content;
    if (typeof content === "string") return content;
    const text = content
      .filter((p) => p.type === "text")
      .map((p) => (p as { text: string }).text)
      .join("\n");
    if (text) return text;
  }
  return "";
};

const historyPairsText = (messages: ModelMessage[], historySize: number): string => {
  if (historySize <= 0) return "";
  const pairs: string[] = [];
  let pendingUser: string | undefined;
  for (const m of messages) {
    if (m.role === "user") {
      const text = typeof m.content === "string" ? m.content : "";
      if (text) pendingUser = text.slice(0, 500);
    } else if (m.role === "assistant" && pendingUser) {
      const text =
        typeof m.content === "string"
          ? m.content
          : m.content
              .filter((p) => p.type === "text")
              .map((p) => (p as { text: string }).text)
              .join(" ");
      pairs.push(`User: ${pendingUser}\nResult: ${text.slice(0, 500)}`);
      pendingUser = undefined;
    }
  }
  return pairs.slice(-historySize).join("\n---\n");
};

/**
 * Run the intent classifier over the configured classifier models in order.
 * Returns undefined when every model fails (caller falls back to medium).
 */
export const runClassifier = async (
  classifierModels: ClassifierConfig[],
  messages: ModelMessage[],
  historySize = 0,
  tierGuides?: TierGuides,
): Promise<{ tier: RouterTier; attempts: ClassifierAttempt[] } | undefined> => {
  const attempts: ClassifierAttempt[] = [];
  const userText = lastUserText(messages);
  if (!userText) return undefined;
  const historyText = historyPairsText(messages, historySize);
  const body = historyText
    ? `Recent history (user+final result pairs):\n${historyText}\n\nLatest user message:\n${userText}`.trim()
    : `Latest user message:\n${userText}`.trim();

  for (const entry of classifierModels) {
    try {
      const { provider, modelId, thinking } = parseCanonicalModelRef(entry.model);
      const backend = await getBackendModel(
        provider,
        modelId,
        thinking ?? entry.thinking,
        entry.api,
      );
      const result = await generateText({
        model: backend.model,
        system: buildClassifierSystemPrompt(tierGuides),
        prompt: `${OUTPUT_CONSTRAINT}\n\n${body}`,
        ...(backend.effort
          ? { providerOptions: { openai: { reasoningEffort: backend.effort } } }
          : {}),
      });
      const tier = parseClassifierOutput(result.text);
      if (tier) {
        return { tier, attempts: [...attempts, { model: entry.model }] };
      }
      attempts.push({ model: entry.model, error: "unparseable output" });
    } catch (e) {
      attempts.push({ model: entry.model, error: (e as Error).message });
    }
  }
  return undefined;
};
