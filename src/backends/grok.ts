import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { resolveCredential } from "../credentials/resolver";

const GROK_BASE_URL = "https://api.x.ai/v1";

/**
 * Grok (xAI subscription) backend via OpenAI-compatible chat completions.
 * Auth: Grok CLI session key as Bearer token.
 * Note: tier thinking is currently not translated for grok (xAI reasoning
 * controls differ); recorded in the routing decision only.
 */
export const getGrokModel = async (modelId: string): Promise<{ model: LanguageModel }> => {
  const resolved = await resolveCredential("grok");
  if (resolved.kind !== "grok") throw new Error("Unreachable: grok credential kind");
  const provider = createOpenAI({
    baseURL: GROK_BASE_URL,
    apiKey: resolved.creds.sessionKey,
    name: "grok",
  });
  return { model: provider.chat(modelId) };
};
