/** Per route-chain failure memory (process-local). Rate-limit cooldowns only. */
const failedByChain = new Map<string, Map<string, number>>();

/** Fallback when a 429 has no parseable reset time. */
export const RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;

const RESET_AT_RE = /resets at (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/i;

export const chainKey = (profile: string, tier: string): string => `${profile}/${tier}`;

export const normalizeRef = (ref: string): string => ref.trim();

export const errorText = (error: unknown): string => {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") return JSON.stringify(error);
  return String(error);
};

const isRateLimit = (text: string): boolean =>
  /\b429\b/.test(text) || /RATE_LIMITED/i.test(text) || /rate_limit_error/i.test(text);

/** `null` = transient (do not skip on later requests). */
export const failureCooldownUntil = (error: unknown, now = Date.now()): number | null => {
  const text = errorText(error);
  if (!isRateLimit(text)) return null;
  const iso = text.match(RESET_AT_RE)?.[1];
  if (iso) {
    const parsed = Date.parse(iso);
    if (!Number.isNaN(parsed)) return parsed > now ? parsed : null;
  }
  return now + RATE_LIMIT_COOLDOWN_MS;
};

export const recordFailure = (
  profile: string,
  tier: string,
  ref: string,
  untilMs?: number,
  now = Date.now(),
): void => {
  const until = untilMs ?? now + RATE_LIMIT_COOLDOWN_MS;
  const key = chainKey(profile, tier);
  const map = failedByChain.get(key) ?? new Map<string, number>();
  const id = normalizeRef(ref);
  map.set(id, Math.max(map.get(id) ?? 0, until));
  failedByChain.set(key, map);
};

export const failedRefs = (profile: string, tier: string, now = Date.now()): Set<string> => {
  const key = chainKey(profile, tier);
  const map = failedByChain.get(key);
  if (!map) return new Set<string>();
  const live = new Set<string>();
  for (const [ref, until] of map) {
    if (until > now) live.add(ref);
    else map.delete(ref);
  }
  if (map.size === 0) failedByChain.delete(key);
  return live;
};

export const nextRetryAt = (
  profile: string,
  tier: string,
  now = Date.now(),
): number | undefined => {
  const map = failedByChain.get(chainKey(profile, tier));
  if (!map) return undefined;
  let latest = 0;
  for (const until of map.values()) {
    if (until > now && until > latest) latest = until;
  }
  return latest > 0 ? latest : undefined;
};

export const cooldownSkipMessage = (tier: string, skipped: string[], retryAt?: number): string => {
  const until = retryAt ? ` Retry after ${new Date(retryAt).toISOString()}.` : "";
  return `All models in ${tier} tier are in cooldown (skipped: ${skipped.join(", ")}).${until}`;
};

export const resetFailures = (profile?: string): number => {
  if (!profile) {
    const n = failedByChain.size;
    failedByChain.clear();
    return n;
  }
  let n = 0;
  for (const key of failedByChain.keys()) {
    if (key === profile || key.startsWith(`${profile}/`)) {
      failedByChain.delete(key);
      n++;
    }
  }
  return n;
};

export const filterFailed = (
  refs: string[],
  failed: Set<string>,
): { tried: string[]; skipped: string[] } => {
  const tried: string[] = [];
  const skipped: string[] = [];
  for (const ref of refs) {
    if (failed.has(normalizeRef(ref))) skipped.push(ref);
    else tried.push(ref);
  }
  return { tried, skipped };
};
