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

describe("thinkingToEffort 함수", () => {
  it("thinking 값을 effort로 매핑한다", () => {
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

describe("getCodexModel 함수", () => {
  it("account 헤더를 포함한 responses 모델을 생성한다", async () => {
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

  it("codex가 아닌 credential을 거부한다", async () => {
    resolveCredentialMock.mockResolvedValue({ kind: "apiKey", key: "k" });
    await expect(getCodexModel("gpt-5")).rejects.toThrow("Unreachable: codex credential kind");
  });
});

describe("getGrokModel 함수", () => {
  it("session key로 chat 모델을 생성한다", async () => {
    resolveCredentialMock.mockResolvedValue({ kind: "grok", creds: { sessionKey: "s" } });
    const out = await getGrokModel("grok-4");
    expect(out).toEqual({ model: "chat:grok-4" });
    expect(createOpenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: "https://api.x.ai/v1", apiKey: "s", name: "grok" }),
    );
  });

  it("grok이 아닌 credential을 거부한다", async () => {
    resolveCredentialMock.mockResolvedValue({ kind: "apiKey", key: "k" });
    await expect(getGrokModel("grok-4")).rejects.toThrow("Unreachable: grok credential kind");
  });
});

describe("getBackendModel 함수", () => {
  it("codex와 grok provider를 라우팅한다", async () => {
    resolveCredentialMock
      .mockResolvedValueOnce({ kind: "codex", creds: { accessToken: "t", accountId: "a" } })
      .mockResolvedValueOnce({ kind: "grok", creds: { sessionKey: "s" } });
    const codex = await getBackendModel("codex", "gpt-5", "low");
    expect(codex).toMatchObject({ provider: "codex", modelId: "gpt-5", effort: "low" });
    const grok = await getBackendModel("grok", "grok-4");
    expect(grok).toMatchObject({ provider: "grok", modelId: "grok-4" });
    expect(grok.effort).toBeUndefined();
  });

  it("base URL 유무에 따라 범용 provider를 생성한다", async () => {
    resolveCredentialMock.mockResolvedValue({ kind: "apiKey", key: "k" });
    delete process.env.OPENAI_BASE_URL;
    const plain = await getBackendModel("openai", "gpt-5");
    expect(plain).toMatchObject({ provider: "openai", modelId: "gpt-5", model: "chat:gpt-5" });
    expect(createOpenAIMock).toHaveBeenCalledWith({ apiKey: "k", name: "openai" });
    process.env.OPENAI_BASE_URL = "http://local";
    await getBackendModel("openai", "gpt-5");
    expect(createOpenAIMock).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: "http://local" }),
    );
    delete process.env.OPENAI_BASE_URL;
  });

  it("api가 openai-responses일 때 responses 전송 방식을 선택한다", async () => {
    resolveCredentialMock.mockResolvedValue({ kind: "apiKey", key: "k" });
    const out = await getBackendModel("openai", "gpt-5", undefined, "openai-responses");
    expect(out).toMatchObject({ provider: "openai", modelId: "gpt-5", model: "responses:gpt-5" });
  });

  it("지원하지 않는 credential 종류를 거부한다", async () => {
    resolveCredentialMock.mockResolvedValue({
      kind: "codex",
      creds: { accessToken: "t", accountId: "a" },
    });
    await expect(getBackendModel("other", "m")).rejects.toThrow(
      'Unsupported credential for "other"',
    );
  });
});
