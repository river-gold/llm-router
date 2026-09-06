import type { LanguageModel } from "ai";
import { getCodexModel } from "./codex";
import { getGrokModel } from "./grok";
import { resolveCredential } from "../credentials/resolver";
import { createOpenAI } from "@ai-sdk/openai";
import type { ThinkingLevel } from "../types";

export interface BackendModel {
  model: LanguageModel;
  /** Reasoning effort to send via provider options (codex only for now). */
  effort?: string;
  provider: string;
  modelId: string;
}

/**
 * Build a backend model for a canonical provider/model.
 * - codex / grok: subscription auth via CLI credential files
 * - others: OpenAI-compatible base via "<PROVIDER>_BASE_URL" or default,
 *   auth via "<PROVIDER>_API_KEY" env
 */
export const getBackendModel = async (
  provider: string,
  modelId: string,
  thinking?: ThinkingLevel,
): Promise<BackendModel> => {
  if (provider === "codex") {
    const { model, effort } = await getCodexModel(modelId, thinking);
    return { model, effort, provider, modelId };
  }
  if (provider === "grok") {
    const { model } = await getGrokModel(modelId);
    return { model, provider, modelId };
  }
  const resolved = await resolveCredential(provider);
  if (resolved.kind !== "apiKey") throw new Error(`Unsupported credential for "${provider}".`);
  const baseURL = process.env[`${provider.toUpperCase()}_BASE_URL`];
  const instance = createOpenAI({
    ...(baseURL ? { baseURL } : {}),
    apiKey: resolved.key,
    name: provider,
  });
  return { model: instance.chat(modelId), provider, modelId };
};
