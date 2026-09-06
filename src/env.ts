import { dirname, join } from "node:path";

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Parse dotenv-style text: `KEY=value`, optional `export `, `#` comments, single/double quotes. */
export const parseEnvText = (text: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const body = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const eq = body.indexOf("=");
    if (eq === -1) continue;
    const key = body.slice(0, eq).trim();
    if (!KEY_RE.test(key)) continue;
    let value = body.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    } else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    } else {
      const comment = value.indexOf(" #");
      value = (comment === -1 ? value : value.slice(0, comment)).trim();
    }
    out[key] = value;
  }
  return out;
};

/** `.env` lives next to the router config file (default `./config/.env`). */
export const resolveEnvPath = (configPath: string): string => join(dirname(configPath), ".env");

/**
 * Load a dotenv file into `env`. Keys already set win; missing file is a no-op.
 * Returns the keys that were set.
 */
export const loadEnvFile = async (env: NodeJS.ProcessEnv, path: string): Promise<string[]> => {
  let raw: string;
  try {
    raw = await Bun.file(path).text();
  } catch {
    return [];
  }
  const loaded: string[] = [];
  for (const [key, value] of Object.entries(parseEnvText(raw))) {
    if (env[key] === undefined) {
      env[key] = value;
      loaded.push(key);
    }
  }
  return loaded;
};
