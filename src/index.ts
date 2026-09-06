import { reloadConfig, app } from "./api/server";
import { loadEnvFile, resolveEnvPath } from "./env";
import { DEFAULT_CONFIG_PATH } from "./config";
import { loadState, setStatePath } from "./state";

export interface RouterEntrypoint {
  port: number;
  hostname: string;
  fetch: typeof app.fetch;
}

const boot = async (env: NodeJS.ProcessEnv): Promise<RouterEntrypoint> => {
  // Secrets live next to the router config: existing env vars win over the file.
  await loadEnvFile(env, resolveEnvPath(env.LLM_ROUTER_CONFIG ?? DEFAULT_CONFIG_PATH));
  // statePath is read at import time; re-apply in case the .env file set it.
  if (env.LLM_ROUTER_STATE) setStatePath(env.LLM_ROUTER_STATE);
  const port = Number(env.LLM_ROUTER_PORT ?? 4891);
  const configPath = env.LLM_ROUTER_CONFIG;
  try {
    await reloadConfig(configPath);
  } catch (e) {
    throw asEntryError(e as Error);
  }
  await loadState();
  console.log(`[llm-router] listening on http://127.0.0.1:${port}`);
  return { port, hostname: "127.0.0.1", fetch: app.fetch };
};

export const asEntryError = (e: Error): EntryError =>
  e instanceof EntryError ? e : new EntryError(`[llm-router] ${e.message}`);

export class EntryError extends Error {}

export const reportEntryError = (e: Error): Promise<RouterEntrypoint | undefined> => {
  console.error(e instanceof EntryError ? e.message : String(e));
  process.exit(1);
  return Promise.resolve(undefined);
};

export const settleEntryError = async (e: Error): Promise<undefined> => {
  await reportEntryError(e);
};

export const startRouter = async (
  env: NodeJS.ProcessEnv = process.env,
): Promise<RouterEntrypoint> => boot(env);

export const entryPromise: Promise<RouterEntrypoint | undefined> = Promise.resolve(undefined);

export const runEntry = (
  promise: Promise<RouterEntrypoint> = boot(process.env),
): Promise<RouterEntrypoint | undefined> =>
  promise.then(
    (entry) => entry,
    (e: Error) => settleEntryError(e),
  );

export const settleEntry = async (
  promise: Promise<RouterEntrypoint | undefined> = entryPromise,
): Promise<{ status: string; value?: RouterEntrypoint }> =>
  promise.then(
    (value) => (value === undefined ? { status: "skipped" } : { status: "fulfilled", value }),
    () => ({ status: "rejected", value: undefined }),
  );

export const entrySettled = settleEntry();

export const runMain = async (meta: ImportMeta = import.meta): Promise<void> => {
  if (!meta.main) return;
  await runEntry();
};

await runMain();

export default (await entryPromise) as RouterEntrypoint;
