export type RouterTier = "max" | "xhigh" | "high" | "medium" | "low" | "minimal";

export const ROUTER_TIERS: readonly RouterTier[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Reasoning effort values accepted by OpenAI-style backends. */
export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ClassifierConfig {
  model: string;
  thinking?: ThinkingLevel;
}

export interface RoutedTierConfig {
  models?: string[];
  thinking?: ThinkingLevel;
  contextWindow?: number;
  maxTokens?: number;
}

export interface RouterProfile {
  max?: RoutedTierConfig;
  xhigh?: RoutedTierConfig;
  high?: RoutedTierConfig;
  medium?: RoutedTierConfig;
  low?: RoutedTierConfig;
  minimal?: RoutedTierConfig;
  classifierModels?: ClassifierConfig[];
}

export interface RouterConfig {
  debug?: boolean;
  classifierModels?: ClassifierConfig[];
  historySize?: number;
  defaultProfile?: string;
  profiles: Record<string, RouterProfile>;
}

export interface RoutingDecision {
  profile: string;
  tier: RouterTier;
  targetProvider: string;
  targetModelId: string;
  targetLabel: string;
  reasoning: string;
  thinking?: ThinkingLevel;
  timestamp: number;
  isClassifier?: boolean;
  isFallback?: boolean;
}

export interface RouterPersistedState {
  accumulatedCost?: number;
  debugHistory?: RoutingDecision[];
  lastDecision?: RoutingDecision;
  timestamp: number;
}
