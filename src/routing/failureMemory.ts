/** Per route-chain failure memory (process-local). */
const failedByChain = new Map<string, Set<string>>();

export const chainKey = (profile: string, tier: string): string => `${profile}/${tier}`;

export const normalizeRef = (ref: string): string => ref.trim();

export const recordFailure = (profile: string, tier: string, ref: string): void => {
  const key = chainKey(profile, tier);
  const set = failedByChain.get(key) ?? new Set<string>();
  set.add(normalizeRef(ref));
  failedByChain.set(key, set);
};

export const failedRefs = (profile: string, tier: string): Set<string> =>
  failedByChain.get(chainKey(profile, tier)) ?? new Set<string>();

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
