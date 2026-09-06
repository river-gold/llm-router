import type { ThinkingLevel } from "./types";
import { ROUTER_TIERS } from "./types";

const ALLOWED_THINKING: readonly string[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/**
 * Parse a canonical model reference: "provider/modelId[#thinking]".
 * Ported from pi-model-router config/modelRef.ts.
 */
export const parseCanonicalModelRef = (
  value: string,
): { provider: string; modelId: string; thinking?: ThinkingLevel } => {
  const hashIndex = value.indexOf("#");
  const rawRef = hashIndex === -1 ? value : value.slice(0, hashIndex);
  const thinkingRaw = hashIndex === -1 ? undefined : value.slice(hashIndex + 1).trim();
  const slashIndex = rawRef.indexOf("/");
  if (slashIndex === -1) {
    throw new Error(`Invalid model reference "${value}". Expected "provider/model[#thinking]".`);
  }
  const provider = rawRef.slice(0, slashIndex).trim();
  const modelId = rawRef.slice(slashIndex + 1).trim();
  if (!provider || !modelId) {
    throw new Error(`Invalid model reference "${value}". Expected "provider/model[#thinking]".`);
  }
  if (thinkingRaw) {
    if (!ALLOWED_THINKING.includes(thinkingRaw)) {
      throw new Error(
        `Invalid thinking "${thinkingRaw}": expected one of ${ALLOWED_THINKING.join(", ")}.`,
      );
    }
    return { provider, modelId, thinking: thinkingRaw as ThinkingLevel };
  }
  return { provider, modelId };
};

export const formatModelRef = (
  provider: string,
  modelId: string,
  thinking?: ThinkingLevel,
): string => (thinking ? `${provider}/${modelId}#${thinking}` : `${provider}/${modelId}`);

export const isRouterTier = (value: string): value is (typeof ROUTER_TIERS)[number] =>
  (ROUTER_TIERS as readonly string[]).includes(value);

/**
 * Requested server model: "router/<profile>" or "router/<profile>/<tier>".
 */
export const parseServerModel = (
  value: string,
): { profile: string; tier?: (typeof ROUTER_TIERS)[number] } => {
  const parts = value.split("/");
  if (parts.length < 2 || parts[0] !== "router") {
    throw new Error(`Invalid router model "${value}". Expected "router/<profile>[/<tier>]".`);
  }
  const profile = parts[1];
  if (!profile) throw new Error(`Invalid router model "${value}". Missing profile.`);
  const tierRaw = parts[2];
  if (tierRaw !== undefined && !isRouterTier(tierRaw)) {
    throw new Error(`Invalid tier "${tierRaw}". Expected one of ${ROUTER_TIERS.join(", ")}.`);
  }
  return tierRaw ? { profile, tier: tierRaw } : { profile };
};
