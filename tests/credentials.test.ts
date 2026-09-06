import { afterEach, describe, expect, it, vi } from "vitest";
import {
  accountIdFromJwt,
  codexAuthPath,
  jwtExpiryMs,
  readCodexCredentials,
} from "../src/credentials/codexCli";
import { grokAuthPath, readGrokCredentials } from "../src/credentials/grokCli";
import { envPrefix, resolveCredential } from "../src/credentials/resolver";

const store = new Map<string, unknown>();
let readFails = false;

vi.stubGlobal("Bun", {
  file: (path: string) => ({
    json: async (): Promise<unknown> => {
      if (readFails || !store.has(path)) throw new Error(`ENOENT: ${path}`);
      return store.get(path) as unknown;
    },
  }),
});

const b64url = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString("base64url");
const jwt = (payload: unknown): string => `h.${b64url(payload)}.s`;

const codexFile = (tokens: unknown) => ({ tokens });
const grokFile = (entries: Record<string, unknown>) => entries;

afterEach(() => {
  store.clear();
  readFails = false;
  for (const k of [
    "CODEX_HOME",
    "GROK_HOME",
    "LLM_ROUTER_CODEX_TOKEN",
    "LLM_ROUTER_CODEX_ACCOUNT_ID",
    "LLM_ROUTER_GROK_KEY",
    "OPENAI_API_KEY",
  ]) {
    delete process.env[k];
  }
});

describe("codexCli helpers", () => {
  it("decodes account id and expiry from JWT", () => {
    const token = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acc-1" }, exp: 999 });
    expect(accountIdFromJwt(token)).toBe("acc-1");
    expect(jwtExpiryMs(token)).toBe(999000);
  });

  it("returns undefined for malformed tokens", () => {
    expect(accountIdFromJwt("single")).toBeUndefined();
    expect(jwtExpiryMs("single")).toBeUndefined();
    expect(accountIdFromJwt("a.Zm9v.bar")).toBeUndefined();
    expect(jwtExpiryMs("a.W10.bar")).toBeUndefined();
    expect(accountIdFromJwt(jwt({}))).toBeUndefined();
    expect(
      accountIdFromJwt(jwt({ "https://api.openai.com/auth": { chatgpt_account_id: 7 } })),
    ).toBeUndefined();
    expect(jwtExpiryMs(jwt({ exp: "soon" }))).toBeUndefined();
    expect(jwtExpiryMs(jwt({}))).toBeUndefined();
    expect(jwtExpiryMs("a.!!!.c")).toBeUndefined();
  });

  it("resolves auth path from env or home", () => {
    process.env.CODEX_HOME = "/c";
    expect(codexAuthPath()).toBe("/c/auth.json");
    delete process.env.CODEX_HOME;
    expect(codexAuthPath()).toMatch(/\.codex\/auth\.json$/);
  });

  it("reads credentials from file", async () => {
    const token = jwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "a" },
      exp: 2000000000,
    });
    store.set("/c/auth.json", codexFile({ access_token: token, account_id: "explicit" }));
    process.env.CODEX_HOME = "/c";
    const creds = await readCodexCredentials();
    expect(creds.accountId).toBe("explicit");
    expect(creds.expiresAt).toBe(2000000000000);
  });

  it("derives account id from JWT when absent", async () => {
    const token = jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "jwt-acc" } });
    store.set("/c2/auth.json", codexFile({ access_token: token }));
    const creds = await readCodexCredentials("/c2/auth.json");
    expect(creds.accountId).toBe("jwt-acc");
    expect(creds.expiresAt).toBeUndefined();
  });

  it("throws for missing file, token, or account", async () => {
    await expect(readCodexCredentials("/nope.json")).rejects.toThrow("Codex auth not found");
    readFails = true;
    await expect(readCodexCredentials("/x.json")).rejects.toThrow("Run `codex login`");
    readFails = false;
    store.set("/e1.json", codexFile({}));
    await expect(readCodexCredentials("/e1.json")).rejects.toThrow("No access token");
    store.set("/e2.json", codexFile({ access_token: jwt({}) }));
    await expect(readCodexCredentials("/e2.json")).rejects.toThrow(
      "Cannot determine chatgpt account id",
    );
  });
});

describe("grokCli", () => {
  it("resolves auth path from env or home", () => {
    process.env.GROK_HOME = "/g";
    expect(grokAuthPath()).toBe("/g/auth.json");
    delete process.env.GROK_HOME;
    expect(grokAuthPath()).toMatch(/\.grok\/auth\.json$/);
  });

  it("reads the auth.x.ai entry", async () => {
    store.set(
      "/g/auth.json",
      grokFile({
        "https://other": { key: "k-other" },
        "https://auth.x.ai": { key: "k-main", expires_at: "2030-01-01T00:00:00.000Z" },
      }),
    );
    process.env.GROK_HOME = "/g";
    const creds = await readGrokCredentials();
    expect(creds.sessionKey).toBe("k-main");
    expect(creds.expiresAt).toBe(Date.parse("2030-01-01T00:00:00.000Z"));
  });

  it("falls back to the first entry without expiry", async () => {
    store.set("/f.json", grokFile({ "https://other": { key: "k1" } }));
    const creds = await readGrokCredentials("/f.json");
    expect(creds.sessionKey).toBe("k1");
    expect(creds.expiresAt).toBeUndefined();
  });

  it("throws for missing file, entries, or key", async () => {
    await expect(readGrokCredentials("/nope.json")).rejects.toThrow("Grok auth not found");
    store.set("/empty.json", grokFile({}));
    await expect(readGrokCredentials("/empty.json")).rejects.toThrow("No entries");
    store.set("/nokey.json", grokFile({ "https://auth.x.ai": {} }));
    await expect(readGrokCredentials("/nokey.json")).rejects.toThrow("No session key");
    store.set("/null.json", { "https://auth.x.ai": null });
    await expect(readGrokCredentials("/null.json")).rejects.toThrow("No session key");
  });
});

describe("resolveCredential", () => {
  it("prefers codex env credentials", async () => {
    process.env.LLM_ROUTER_CODEX_TOKEN = "t";
    process.env.LLM_ROUTER_CODEX_ACCOUNT_ID = "a";
    expect(await resolveCredential("codex")).toEqual({
      kind: "codex",
      creds: { accessToken: "t", accountId: "a" },
    });
  });

  it("reads codex file credentials and rejects expired tokens", async () => {
    process.env.LLM_ROUTER_CODEX_TOKEN = "t";
    await expect(resolveCredential("codex")).rejects.toThrow("Codex auth not found");
    delete process.env.LLM_ROUTER_CODEX_TOKEN;
    const fresh = jwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "a" },
      exp: 2000000000,
    });
    store.set("/cx/auth.json", codexFile({ access_token: fresh }));
    process.env.CODEX_HOME = "/cx";
    const creds = await resolveCredential("codex");
    expect(creds.kind).toBe("codex");
    store.set("/cx/auth.json", codexFile({ access_token: jwt({ exp: 1 }) }));
    const withId = codexFile({ access_token: jwt({ exp: 1 }), account_id: "a" });
    store.set("/cx/auth.json", withId);
    await expect(resolveCredential("codex")).rejects.toThrow("expired");
  });

  it("resolves grok from env, file, and rejects expiry", async () => {
    process.env.LLM_ROUTER_GROK_KEY = "gk";
    expect(await resolveCredential("grok")).toEqual({ kind: "grok", creds: { sessionKey: "gk" } });
    delete process.env.LLM_ROUTER_GROK_KEY;
    store.set("/gx/auth.json", grokFile({ "https://auth.x.ai": { key: "k" } }));
    process.env.GROK_HOME = "/gx";
    expect(await resolveCredential("grok")).toEqual({ kind: "grok", creds: { sessionKey: "k" } });
    store.set(
      "/gx/auth.json",
      grokFile({ "https://auth.x.ai": { key: "k", expires_at: "2000-01-01T00:00:00.000Z" } }),
    );
    await expect(resolveCredential("grok")).rejects.toThrow("expired");
  });

  it("resolves generic providers from env", async () => {
    await expect(resolveCredential("openai")).rejects.toThrow("OPENAI_API_KEY");
    process.env.OPENAI_API_KEY = "sk-x";
    expect(await resolveCredential("openai")).toEqual({ kind: "apiKey", key: "sk-x" });
  });

  it("normalizes hyphens in provider names to underscores", async () => {
    expect(envPrefix("opencode-go")).toBe("OPENCODE_GO");
    await expect(resolveCredential("opencode-go")).rejects.toThrow("OPENCODE_GO_API_KEY");
    process.env.OPENCODE_GO_API_KEY = "sk-y";
    expect(await resolveCredential("opencode-go")).toEqual({ kind: "apiKey", key: "sk-y" });
    delete process.env.OPENCODE_GO_API_KEY;
  });
});
