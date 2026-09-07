import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateText } from "ai";
import type { ModelMessage } from "ai";
import { getBackendModel } from "../src/backends";
import {
  buildClassifierSystemPrompt,
  CLASSIFIER_SYSTEM_PROMPT,
  DEFAULT_TIER_GUIDES,
  parseClassifierOutput,
  runClassifier,
} from "../src/routing/classifier";

vi.mock("ai", () => ({ generateText: vi.fn() }));
vi.mock("../src/backends", () => ({ getBackendModel: vi.fn() }));

const generateTextMock = vi.mocked(generateText);
const getBackendModelMock = vi.mocked(getBackendModel);

const userMsg = (content: ModelMessage["content"]): ModelMessage =>
  ({ role: "user", content }) as ModelMessage;
const assistantMsg = (content: ModelMessage["content"]): ModelMessage =>
  ({ role: "assistant", content }) as ModelMessage;

describe("parseClassifierOutput 함수", () => {
  it("대소문자 구분 없이 공백을 무시하고 tier를 파싱한다", () => {
    expect(parseClassifierOutput(" HIGH ")).toBe("high");
    expect(parseClassifierOutput("minimal")).toBe("minimal");
  });

  it("빈 출력과 알 수 없는 출력을 거부한다", () => {
    expect(parseClassifierOutput("")).toBeUndefined();
    expect(parseClassifierOutput("   ")).toBeUndefined();
    expect(parseClassifierOutput("banana")).toBeUndefined();
  });
});

describe("runClassifier 함수", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("사용자 텍스트가 없으면 undefined를 반환한다", async () => {
    await expect(
      runClassifier([{ model: "p/m" }], [assistantMsg("hi")], 0),
    ).resolves.toBeUndefined();
    await expect(runClassifier([{ model: "p/m" }], [], 0)).resolves.toBeUndefined();
    await expect(
      runClassifier([{ model: "p/m" }], [userMsg([{ type: "image" } as never])], 0),
    ).resolves.toBeUndefined();
    expect(getBackendModelMock).not.toHaveBeenCalled();
  });

  it("히스토리 없이 문자열 사용자 콘텐츠에서 분류한다", async () => {
    getBackendModelMock.mockResolvedValue({ model: "m", provider: "p", modelId: "m" } as never);
    generateTextMock.mockResolvedValue({ text: "low" } as never);
    const out = await runClassifier([{ model: "p/m" }], [userMsg("do it")], 0);
    expect(out?.tier).toBe("low");
    expect(out?.attempts).toEqual([{ model: "p/m" }]);
    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({ system: CLASSIFIER_SYSTEM_PROMPT }),
    );
  });

  it("배열 콘텐츠에서 사용자 텍스트를 읽고 히스토리 쌍을 포함한다", async () => {
    getBackendModelMock.mockResolvedValue({ model: "m", provider: "p", modelId: "m" } as never);
    generateTextMock.mockResolvedValue({ text: "max" } as never);
    const long = "u".repeat(600);
    const out = await runClassifier(
      [{ model: "p/m" }],
      [
        userMsg(long),
        assistantMsg("done"),
        userMsg([{ type: "text", text: "again" }]),
        assistantMsg([{ type: "text", text: "ok" }]),
      ],
      5,
    );
    expect(out?.tier).toBe("max");
    const prompt = generateTextMock.mock.calls[0][0].prompt as string;
    expect(prompt).toContain("Recent history");
    expect(prompt).not.toContain(long);
  });

  it("히스토리 쌍 분기를 모두 다룬다", async () => {
    getBackendModelMock.mockResolvedValue({ model: "m", provider: "p", modelId: "m" } as never);
    generateTextMock.mockResolvedValue({ text: "medium" } as never);
    await runClassifier(
      [{ model: "p/m" }],
      [
        userMsg([{ type: "text", text: "first" }]),
        assistantMsg("short"),
        userMsg("second"),
        assistantMsg([{ type: "text", text: "r" }]),
        userMsg("third"),
        assistantMsg("tail"),
      ],
      1,
    );
    const prompt = generateTextMock.mock.calls.at(-1)?.[0].prompt as string;
    expect(prompt).toContain("tail");
    expect(prompt).not.toContain("short");
  });

  it("텍스트가 아닌 배열 요소와 빈 쌍을 건너뛴다", async () => {
    getBackendModelMock.mockResolvedValue({ model: "m", provider: "p", modelId: "m" } as never);
    generateTextMock.mockResolvedValue({ text: "medium" } as never);
    const out = await runClassifier(
      [{ model: "p/m" }],
      [
        userMsg([{ type: "image" } as never]),
        userMsg("real"),
        assistantMsg([{ type: "image" } as never]),
      ],
      2,
    );
    expect(out?.tier).toBe("medium");
  });

  it("파싱할 수 없는 출력과 에러에 대해 여러 모델로 재시도한다", async () => {
    getBackendModelMock
      .mockResolvedValueOnce({ model: "m", provider: "p", modelId: "m" } as never)
      .mockRejectedValueOnce(new Error("no backend"))
      .mockResolvedValueOnce({ model: "m", provider: "p", modelId: "m" } as never);
    generateTextMock
      .mockResolvedValueOnce({ text: "nonsense" } as never)
      .mockResolvedValueOnce({ text: "high" } as never);
    const out = await runClassifier(
      [{ model: "p/a" }, { model: "p/b" }, { model: "p/c" }],
      [userMsg("go")],
      0,
    );
    expect(out?.tier).toBe("high");
    expect(out?.attempts).toEqual([
      { model: "p/a", error: "unparseable output" },
      { model: "p/b", error: "no backend" },
      { model: "p/c" },
    ]);
  });

  it("모든 모델이 실패하면 undefined를 반환한다", async () => {
    getBackendModelMock.mockRejectedValue(new Error("down"));
    await expect(
      runClassifier([{ model: "p/a" }, { model: "p/b" }], [userMsg("go")], 0),
    ).resolves.toBeUndefined();
  });

  it("분류기 목록이 비어 있으면 undefined를 반환한다", async () => {
    await expect(runClassifier([], [userMsg("go")], 0)).resolves.toBeUndefined();
  });

  it("ref thinking과 effort provider 옵션을 전달한다", async () => {
    getBackendModelMock.mockResolvedValue({
      model: "m",
      provider: "p",
      modelId: "m",
      effort: "xhigh",
    } as never);
    generateTextMock.mockResolvedValue({ text: "xhigh" } as never);
    const out = await runClassifier([{ model: "p/m#max" }], [userMsg("go")], 0);
    expect(out?.tier).toBe("xhigh");
    expect(getBackendModelMock).toHaveBeenCalledWith("p", "m", "max", undefined);
    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        providerOptions: { openai: { reasoningEffort: "xhigh" } },
      }),
    );
  });

  it("ref에 thinking이 없으면 항목의 thinking으로 대체한다", async () => {
    getBackendModelMock.mockResolvedValue({ model: "m", provider: "p", modelId: "m" } as never);
    generateTextMock.mockResolvedValue({ text: "low" } as never);
    await runClassifier([{ model: "p/m", thinking: "low" }], [userMsg("go")], 0);
    expect(getBackendModelMock).toHaveBeenCalledWith("p", "m", "low", undefined);
  });

  it("항목의 api를 그대로 전달한다", async () => {
    getBackendModelMock.mockResolvedValue({ model: "m", provider: "p", modelId: "m" } as never);
    generateTextMock.mockResolvedValue({ text: "low" } as never);
    await runClassifier([{ model: "p/m", api: "openai-responses" }], [userMsg("go")], 0);
    expect(getBackendModelMock).toHaveBeenCalledWith("p", "m", undefined, "openai-responses");
  });

  it("잘못된 모델 ref를 시도 에러로 기록한다", async () => {
    await expect(runClassifier([{ model: "bogus" }], [userMsg("go")], 0)).resolves.toBeUndefined();
    expect(getBackendModelMock).not.toHaveBeenCalled();
  });
});

describe("buildClassifierSystemPrompt 함수", () => {
  it("기본적으로 기존 프롬프트와 일치한다", () => {
    expect(buildClassifierSystemPrompt()).toBe(CLASSIFIER_SYSTEM_PROMPT);
    expect(buildClassifierSystemPrompt({})).toBe(CLASSIFIER_SYSTEM_PROMPT);
  });

  it("일부 재정의값을 적용하고 나머지는 기본값을 유지한다", () => {
    const prompt = buildClassifierSystemPrompt({
      low: "Custom low work.",
      max: "Custom max work.",
    });
    expect(prompt).toContain("- low: Custom low work.");
    expect(prompt).toContain("- max: Custom max work.");
    expect(prompt).toContain(`- minimal: ${DEFAULT_TIER_GUIDES.minimal}`);
    expect(prompt).toContain(`- medium: ${DEFAULT_TIER_GUIDES.medium}`);
  });

  it("tierGuides를 generateText에 전달한다", async () => {
    getBackendModelMock.mockResolvedValue({ model: "m", provider: "p", modelId: "m" } as never);
    generateTextMock.mockResolvedValue({ text: "high" } as never);
    const out = await runClassifier([{ model: "p/m" }], [userMsg("go")], 0, {
      high: "Custom high work.",
    });
    expect(out?.tier).toBe("high");
    const system = generateTextMock.mock.calls[0][0].system as string;
    expect(system).toContain("- high: Custom high work.");
    expect(system).toContain(`- low: ${DEFAULT_TIER_GUIDES.low}`);
  });

  it("가이드가 생략되면 기본 프롬프트를 사용한다", async () => {
    getBackendModelMock.mockResolvedValue({ model: "m", provider: "p", modelId: "m" } as never);
    generateTextMock.mockResolvedValue({ text: "low" } as never);
    await runClassifier([{ model: "p/m" }], [userMsg("go")], 0);
    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({ system: CLASSIFIER_SYSTEM_PROMPT }),
    );
  });
});
