import { homedir } from "node:os";
import { join } from "node:path";

export interface CodexCredentials {
  accessToken: string;
  accountId: string;
  expiresAt?: number;
}

interface CodexAuthFile {
  auth_mode?: string;
  OPENAI_API_KEY?: string | null;
  tokens?: {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
  };
  last_refresh?: string;
}

const base64UrlDecode = (segment: string): string =>
  Buffer.from(segment.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

/** Extract chatgpt_account_id from the access-token JWT payload. */
export const accountIdFromJwt = (accessToken: string): string | undefined => {
  const parts = accessToken.split(".");
  if (parts.length < 2) return undefined;
  try {
    const payload = JSON.parse(base64UrlDecode(parts[1])) as Record<string, unknown>;
    const auth = payload["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
    const id = auth?.["chatgpt_account_id"];
    return typeof id === "string" ? id : undefined;
  } catch {
    return undefined;
  }
};

export const jwtExpiryMs = (accessToken: string): number | undefined => {
  const parts = accessToken.split(".");
  if (parts.length < 2) return undefined;
  try {
    const payload = JSON.parse(base64UrlDecode(parts[1])) as { exp?: unknown };
    return typeof payload.exp === "number" ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
};

export const codexAuthPath = (): string =>
  join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json");

/**
 * Read Codex CLI credentials. Read-only; the CLI refreshes the file itself.
 * Throws when the file is missing or unusable.
 */
export const readCodexCredentials = async (path?: string): Promise<CodexCredentials> => {
  const resolved = path ?? codexAuthPath();
  let parsed: CodexAuthFile;
  try {
    parsed = (await Bun.file(resolved).json()) as CodexAuthFile;
  } catch {
    throw new Error(`Codex auth not found at "${resolved}". Run \`codex login\`.`);
  }
  const accessToken = parsed.tokens?.access_token;
  if (!accessToken) {
    throw new Error(`No access token in "${resolved}". Run \`codex login\`.`);
  }
  const accountId = parsed.tokens?.account_id ?? accountIdFromJwt(accessToken);
  if (!accountId) {
    throw new Error(`Cannot determine chatgpt account id from "${resolved}".`);
  }
  return { accessToken, accountId, expiresAt: jwtExpiryMs(accessToken) };
};
