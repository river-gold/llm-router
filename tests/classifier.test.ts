import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateText } from "ai";
import type { ModelMessage } from "ai";
import { getBackendModel } from "../src/backends";
import {
  CLASSIFIER_SYSTEM_PROMPT,
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

describe("parseClassifierOutput", () => {
  it("parses tiers case-insensitively with whitespace", () => {
    expect(parseClassifierOutput(" HIGH ")).toBe("high");
    expect(parseClassifierOutput("minimal")).toBe("minimal");
  });

  it("rejects empty and unknown output", () => {
    expect(parseClassifierOutput("")).toBeUndefined();
    expect(parseClassifierOutput("   ")).toBeUndefined();
    expect(parseClassifierOutput("banana")).toBeUndefined();
  });
});

describe("runClassifier", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns undefined without user text", async () => {
    await expect(
      runClassifier([{ model: "p/m" }], [assistantMsg("hi")], 0),
    ).resolves.toBeUndefined();
    await expect(runClassifier([{ model: "p/m" }], [], 0)).resolves.toBeUndefined();
    await expect(
      runClassifier([{ model: "p/m" }], [userMsg([{ type: "image" } as never])], 0),
    ).resolves.toBeUndefined();
    expect(getBackendModelMock).not.toHaveBeenCalled();
  });

  it("classifies from string user content without history", async () => {
    getBackendModelMock.mockResolvedValue({ model: "m", provider: "p", modelId: "m" } as never);
    generateTextMock.mockResolvedValue({ text: "low" } as never);
    const out = await runClassifier([{ model: "p/m" }], [userMsg("do it")], 0);
    expect(out?.tier).toBe("low");
    expect(out?.attempts).toEqual([{ model: "p/m" }]);
    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({ system: CLASSIFIER_SYSTEM_PROMPT }),
    );
  });

  it("reads user text from array content and includes history pairs", async () => {
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

  it("covers history pair branches", async () => {
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

  it("skips non-text array parts and empty pairs", async () => {
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

  it("retries across models on unparseable output and errors", async () => {
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

  it("returns undefined when every model fails", async () => {
    getBackendModelMock.mockRejectedValue(new Error("down"));
    await expect(
      runClassifier([{ model: "p/a" }, { model: "p/b" }], [userMsg("go")], 0),
    ).resolves.toBeUndefined();
  });

  it("returns undefined for empty classifier list", async () => {
    await expect(runClassifier([], [userMsg("go")], 0)).resolves.toBeUndefined();
  });

  it("passes ref thinking and effort provider options", async () => {
    getBackendModelMock.mockResolvedValue({
      model: "m",
      provider: "p",
      modelId: "m",
      effort: "xhigh",
    } as never);
    generateTextMock.mockResolvedValue({ text: "xhigh" } as never);
    const out = await runClassifier([{ model: "p/m#max" }], [userMsg("go")], 0);
    expect(out?.tier).toBe("xhigh");
    expect(getBackendModelMock).toHaveBeenCalledWith("p", "m", "max");
    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        providerOptions: { openai: { reasoningEffort: "xhigh" } },
      }),
    );
  });

  it("falls back to entry thinking when the ref has none", async () => {
    getBackendModelMock.mockResolvedValue({ model: "m", provider: "p", modelId: "m" } as never);
    generateTextMock.mockResolvedValue({ text: "low" } as never);
    await runClassifier([{ model: "p/m", thinking: "low" }], [userMsg("go")], 0);
    expect(getBackendModelMock).toHaveBeenCalledWith("p", "m", "low");
  });

  it("records invalid model refs as attempt errors", async () => {
    await expect(runClassifier([{ model: "bogus" }], [userMsg("go")], 0)).resolves.toBeUndefined();
    expect(getBackendModelMock).not.toHaveBeenCalled();
  });
});
