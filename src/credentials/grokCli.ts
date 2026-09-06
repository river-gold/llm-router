import { homedir } from "node:os";
import { join } from "node:path";

export interface GrokCredentials {
  /** Session key used as a Bearer token against api.x.ai. */
  sessionKey: string;
  expiresAt?: number;
}

interface GrokAuthEntry {
  key?: string;
  auth_mode?: string;
  refresh_token?: string;
  expires_at?: string;
}

type GrokAuthFile = Record<string, GrokAuthEntry>;

export const grokAuthPath = (): string =>
  join(process.env.GROK_HOME ?? join(homedir(), ".grok"), "auth.json");

/**
 * Read Grok CLI credentials. The file is keyed by issuer URL; pick the entry
 * matching auth.x.ai, falling back to the first entry. Read-only.
 */
export const readGrokCredentials = async (path?: string): Promise<GrokCredentials> => {
  const resolved = path ?? grokAuthPath();
  let parsed: GrokAuthFile;
  try {
    parsed = (await Bun.file(resolved).json()) as GrokAuthFile;
  } catch {
    throw new Error(`Grok auth not found at "${resolved}". Run \`grok login\`.`);
  }
  const keys = Object.keys(parsed);
  if (keys.length === 0) {
    throw new Error(`No entries in "${resolved}". Run \`grok login\`.`);
  }
  const issuerKey = keys.find((k) => k.includes("auth.x.ai")) ?? keys[0];
  const entry = parsed[issuerKey];
  if (!entry?.key) {
    throw new Error(`No session key in "${resolved}". Run \`grok login\`.`);
  }
  const expiresAt = entry.expires_at ? Date.parse(entry.expires_at) : undefined;
  return { sessionKey: entry.key, expiresAt };
};
