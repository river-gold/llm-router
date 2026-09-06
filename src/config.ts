import { z } from "zod";
import type { RouterConfig, RouterProfile, RouterTier } from "./types";
import { ROUTER_TIERS } from "./types";

const thinkingSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

const classifierSchema = z.object({
  model: z.string().min(1),
  thinking: thinkingSchema.optional(),
});

// Accept shorthand strings ("provider/model[#thinking]"); the suffix is parsed later.
const classifierEntrySchema = z.union([
  z
    .string()
    .min(1)
    .transform((model) => ({ model })),
  classifierSchema,
]);

const apiSchema = z.enum(["openai-completions", "openai-responses"]);

const modelEntrySchema = z.union([
  z.string().min(1),
  z.object({
    model: z.string().min(1),
    thinking: thinkingSchema.optional(),
    api: apiSchema.optional(),
  }),
]);

const tierSchema = z.object({
  models: z.array(modelEntrySchema).optional(),
});

const profileSchema = z
  .object({
    max: tierSchema.optional(),
    xhigh: tierSchema.optional(),
    high: tierSchema.optional(),
    medium: tierSchema.optional(),
    low: tierSchema.optional(),
    minimal: tierSchema.optional(),
    classifierModels: z.array(classifierEntrySchema).optional(),
  })
  .refine((p) => ROUTER_TIERS.some((t) => p[t] !== undefined), {
    message: "Profile must define at least one tier.",
  });

const configSchema = z.object({
  debug: z.boolean().optional(),
  classifierModels: z.array(classifierEntrySchema).optional(),
  historySize: z.number().int().min(0).max(20).optional(),
  defaultProfile: z.string().optional(),
  profiles: z.record(z.string(), profileSchema),
});

export const DEFAULT_CONFIG_PATH = "./config/model-router.jsonc";

const stripJsonComments = (text: string): string =>
  text
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("//");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");

// Tolerate JSONC trailing commas (e.g. formatter output) before } or ].
const stripTrailingCommas = (text: string): string => text.replace(/,(\s*[}\]])/g, "$1");

export const loadConfig = async (
  path?: string,
): Promise<{ config: RouterConfig; warnings: string[] }> => {
  const resolved = path ?? process.env.LLM_ROUTER_CONFIG ?? DEFAULT_CONFIG_PATH;
  const warnings: string[] = [];
  let raw: string;
  try {
    raw = await Bun.file(resolved).text();
  } catch (e) {
    throw new Error(`Cannot read router config "${resolved}": ${(e as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripTrailingCommas(stripJsonComments(raw)));
  } catch (e) {
    throw new Error(`Invalid JSON in router config "${resolved}": ${(e as Error).message}`);
  }
  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Invalid router config "${resolved}": ${result.error.message}`);
  }
  return { config: result.data as RouterConfig, warnings };
};

export const configuredTiers = (profile: RouterProfile): RouterTier[] =>
  ROUTER_TIERS.filter((t) => profile[t] !== undefined);

export const singleTier = (profile: RouterProfile): RouterTier | undefined => {
  const tiers = configuredTiers(profile);
  return tiers.length === 1 ? tiers[0] : undefined;
};
