import { readCodexCredentials, type CodexCredentials } from "./codexCli";
import { readGrokCredentials, type GrokCredentials } from "./grokCli";

export type BackendCredential =
  | { kind: "codex"; creds: CodexCredentials }
  | { kind: "grok"; creds: GrokCredentials }
  | { kind: "apiKey"; key: string };

const isExpired = (expiresAt: number | undefined): boolean =>
  expiresAt !== undefined && expiresAt <= Date.now() + 60_000;

/** Env prefix for a provider: uppercased with "-" normalized to "_" (e.g. "opencode-go" → "OPENCODE_GO"). */
export const envPrefix = (provider: string): string => provider.toUpperCase().replace(/-/g, "_");

/**
 * Resolve credentials for a backend provider.
 * - "codex": Codex CLI auth file (env overrides for path/token available)
 * - "grok": Grok CLI auth file
 * - others: environment variable "<PROVIDER>_API_KEY" (uppercased, e.g. OPENAI_API_KEY)
 *
 * Always read-only; never writes credential files. OAuth/CLI files are
 * re-read on every call so CLI-side refreshes are picked up.
 */
export const resolveCredential = async (provider: string): Promise<BackendCredential> => {
  if (provider === "codex") {
    const envToken = process.env.LLM_ROUTER_CODEX_TOKEN;
    const envAccount = process.env.LLM_ROUTER_CODEX_ACCOUNT_ID;
    if (envToken && envAccount) {
      return { kind: "codex", creds: { accessToken: envToken, accountId: envAccount } };
    }
    const creds = await readCodexCredentials();
    if (isExpired(creds.expiresAt)) {
      throw new Error("Codex access token expired. Run `codex login` to refresh.");
    }
    return { kind: "codex", creds };
  }
  if (provider === "grok") {
    const envKey = process.env.LLM_ROUTER_GROK_KEY;
    if (envKey) return { kind: "grok", creds: { sessionKey: envKey } };
    const creds = await readGrokCredentials();
    if (isExpired(creds.expiresAt)) {
      throw new Error("Grok session expired. Run `grok login` to refresh.");
    }
    return { kind: "grok", creds };
  }
  const key = process.env[`${envPrefix(provider)}_API_KEY`];
  if (!key) {
    throw new Error(
      `No credential for provider "${provider}". Set ${envPrefix(provider)}_API_KEY.`,
    );
  }
  return { kind: "apiKey", key };
};
