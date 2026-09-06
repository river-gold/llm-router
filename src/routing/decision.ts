import type { RouterProfile, RouterTier, RoutingDecision, ThinkingLevel } from "../types";
import { ROUTER_TIERS } from "../types";
import { parseCanonicalModelRef, formatModelRef } from "../modelRef";

export const thinkingToTier = (thinking: ThinkingLevel): RouterTier => {
  if (thinking === "max") return "max";
  if (thinking === "xhigh") return "xhigh";
  if (thinking === "high") return "high";
  if (thinking === "medium") return "medium";
  if (thinking === "low") return "low";
  return "minimal";
};

/** Nearest-tier fallback when the preferred tier is not configured. */
export const resolveAvailableTier = (profile: RouterProfile, preferred: RouterTier): RouterTier => {
  if (profile[preferred]) return preferred;
  const order: RouterTier[] = [...ROUTER_TIERS];
  const startIdx = order.indexOf(preferred);
  for (let i = startIdx + 1; i < order.length; i++) {
    if (profile[order[i]]) return order[i];
  }
  for (let i = startIdx - 1; i >= 0; i--) {
    if (profile[order[i]]) return order[i];
  }
  return preferred;
};

export const buildRoutingDecision = (
  profileName: string,
  profile: RouterProfile,
  tier: RouterTier,
  reasoning: string,
  isClassifier?: boolean,
): RoutingDecision => {
  const routed = profile[tier];
  if (!routed) {
    throw new Error(`Profile "${profileName}" has no configuration for the ${tier} tier.`);
  }
  const primaryRef = routed.models?.[0];
  if (!primaryRef) {
    throw new Error(`Profile "${profileName}" tier ${tier} has no models.`);
  }
  const { provider, modelId, thinking } = parseCanonicalModelRef(primaryRef);
  return {
    profile: profileName,
    tier,
    targetProvider: provider,
    targetModelId: modelId,
    targetLabel: formatModelRef(provider, modelId),
    reasoning,
    thinking: thinking ?? routed.thinking,
    timestamp: Date.now(),
    isClassifier,
  };
};
