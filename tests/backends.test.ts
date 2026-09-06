import { beforeEach, describe, expect, it, vi } from "vitest";
import { createOpenAI } from "@ai-sdk/openai";
import { getBackendModel } from "../src/backends";
import { getCodexModel, thinkingToEffort } from "../src/backends/codex";
import { getGrokModel } from "../src/backends/grok";
import { resolveCredential } from "../src/credentials/resolver";
import type * as resolverModule from "../src/credentials/resolver";

vi.mock("../src/credentials/resolver", async (importOriginal) => {
  const actual = await importOriginal<typeof resolverModule>();
  return { ...actual, resolveCredential: vi.fn() };
});
vi.mock("@ai-sdk/openai", () => ({ createOpenAI: vi.fn() }));

const resolveCredentialMock = vi.mocked(resolveCredential);
const createOpenAIMock = vi.mocked(createOpenAI);

const providerStub = () => ({
  responses: vi.fn((id: string) => `responses:${id}`),
  chat: vi.fn((id: string) => `chat:${id}`),
});

beforeEach(() => {
  vi.clearAllMocks();
  createOpenAIMock.mockImplementation(providerStub as never);
});

describe("thinkingToEffort", () => {
  it("maps thinking to effort", () => {
    expect(thinkingToEffort(undefined)).toBeUndefined();
    expect(thinkingToEffort("off")).toBeUndefined();
    expect(thinkingToEffort("minimal")).toBeUndefined();
    expect(thinkingToEffort("low")).toBe("low");
    expect(thinkingToEffort("medium")).toBe("medium");
    expect(thinkingToEffort("high")).toBe("high");
    expect(thinkingToEffort("xhigh")).toBe("xhigh");
    expect(thinkingToEffort("max")).toBe("xhigh");
  });
});

describe("getCodexModel", () => {
  it("builds a responses model with account headers", async () => {
    resolveCredentialMock.mockResolvedValue({
      kind: "codex",
      creds: { accessToken: "tok", accountId: "acc" },
    });
    const out = await getCodexModel("gpt-5", "high");
    expect(out).toEqual({ model: "responses:gpt-5", effort: "high" });
    expect(createOpenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: "https://chatgpt.com/backend-api/codex",
        apiKey: "tok",
        name: "codex",
      }),
    );
  });

  it("rejects non-codex credentials", async () => {
    resolveCredentialMock.mockResolvedValue({ kind: "apiKey", key: "k" });
    await expect(getCodexModel("gpt-5")).rejects.toThrow("Unreachable: codex credential kind");
  });
});

describe("getGrokModel", () => {
  it("builds a chat model with the session key", async () => {
    resolveCredentialMock.mockResolvedValue({ kind: "grok", creds: { sessionKey: "s" } });
    const out = await getGrokModel("grok-4");
    expect(out).toEqual({ model: "chat:grok-4" });
    expect(createOpenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: "https://api.x.ai/v1", apiKey: "s", name: "grok" }),
    );
  });

  it("rejects non-grok credentials", async () => {
    resolveCredentialMock.mockResolvedValue({ kind: "apiKey", key: "k" });
    await expect(getGrokModel("grok-4")).rejects.toThrow("Unreachable: grok credential kind");
  });
});

describe("getBackendModel", () => {
  it("routes codex and grok providers", async () => {
    resolveCredentialMock
      .mockResolvedValueOnce({ kind: "codex", creds: { accessToken: "t", accountId: "a" } })
      .mockResolvedValueOnce({ kind: "grok", creds: { sessionKey: "s" } });
    const codex = await getBackendModel("codex", "gpt-5", "low");
    expect(codex).toMatchObject({ provider: "codex", modelId: "gpt-5", effort: "low" });
    const grok = await getBackendModel("grok", "grok-4");
    expect(grok).toMatchObject({ provider: "grok", modelId: "grok-4" });
    expect(grok.effort).toBeUndefined();
  });

  it("builds generic providers with and without base URL", async () => {
    resolveCredentialMock.mockResolvedValue({ kind: "apiKey", key: "k" });
    delete process.env.OPENAI_BASE_URL;
    const plain = await getBackendModel("openai", "gpt-5");
    expect(plain).toMatchObject({ provider: "openai", modelId: "gpt-5" });
    expect(createOpenAIMock).toHaveBeenCalledWith({ apiKey: "k", name: "openai" });
    process.env.OPENAI_BASE_URL = "http://local";
    await getBackendModel("openai", "gpt-5");
    expect(createOpenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: "http://local" }),
    );
    delete process.env.OPENAI_BASE_URL;
  });

  it("rejects unsupported credential kinds", async () => {
    resolveCredentialMock.mockResolvedValue({
      kind: "codex",
      creds: { accessToken: "t", accountId: "a" },
    });
    await expect(getBackendModel("other", "m")).rejects.toThrow(
      'Unsupported credential for "other"',
    );
  });
});
