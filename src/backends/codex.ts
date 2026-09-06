import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { resolveCredential } from "../credentials/resolver";
import type { ThinkingLevel } from "../types";

const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";

/**
 * Tier thinking → Responses reasoning effort. "max" is clamped to "xhigh"
 * unless the model is known to support it; "off"/missing disables reasoning.
 * (Deliberate simplification of pi's per-model thinkingLevelMap; per-model
 * maps can be added to config later.)
 */
export const thinkingToEffort = (thinking?: ThinkingLevel): string | undefined => {
  if (!thinking || thinking === "off" || thinking === "minimal") return undefined;
  if (thinking === "low") return "low";
  if (thinking === "medium") return "medium";
  if (thinking === "high") return "high";
  return "xhigh";
};

/**
 * Codex (ChatGPT subscription) backend via the Responses API.
 * Auth: Codex CLI access token (Bearer) + chatgpt-account-id header.
 * Provider instance is rebuilt per request so CLI-side token refreshes
 * are picked up without a server restart.
 */
export const getCodexModel = async (
  modelId: string,
  thinking?: ThinkingLevel,
): Promise<{ model: LanguageModel; effort?: string }> => {
  const resolved = await resolveCredential("codex");
  if (resolved.kind !== "codex") throw new Error("Unreachable: codex credential kind");
  const { accessToken, accountId } = resolved.creds;
  const provider = createOpenAI({
    baseURL: CODEX_BASE_URL,
    apiKey: accessToken,
    headers: {
      "chatgpt-account-id": accountId,
      originator: "llm-router",
    },
    name: "codex",
  });
  const effort = thinkingToEffort(thinking);
  const model = provider.responses(modelId);
  return { model, effort };
};
