# llm-router

Standalone LLM router web server (Bun + Hono + Vercel AI SDK).
pi-model-router의 라우팅 기능(프로파일·티어·fallback·classifier·thinking clamp)을
독립 서버로 구현. pi·opencode는 OpenAI 호환 클라이언트로 연결한다.

## Architecture

```
pi (models.json custom provider) ──┐
                                   ├─> http://127.0.0.1:4891 (llm-router)
opencode (openai-compatible) ──────┘
```

## Model interface

`<profile>[/<tier>]` as the OpenAI `model` field:

- `router/balanced` — tier resolution: explicit > single-tier > effort > classifier > medium
- `router/grok/high` — explicit tier (skips classifier)
- `reasoning_effort` request param → tier mapping (none/low/medium/high/xhigh/max)

## Endpoints

| Method | Path                     | Description                                                     |
| ------ | ------------------------ | --------------------------------------------------------------- |
| POST   | `/v1/chat/completions`   | OpenAI-compatible chat (stream + non-stream, tools passthrough) |
| POST   | `/v1/responses`          | Responses API (stream + non-stream, background unsupported)     |
| GET    | `/v1/models`             | Profile list as `router/<profile>`                              |
| GET    | `/router/status`         | Profiles, spend (tokens), last decision                         |
| GET    | `/router/debug`          | Recent routing decisions (config `debug: true` records)         |
| POST   | `/router/reload`         | Hot-reload `model-router.jsonc`                                 |
| POST   | `/router/reset-failures` | Clear failure memory (`{"profile"?: "..."}`)                    |

## Config

`config/model-router.jsonc` (copy from `config/model-router.example.jsonc`):

Inbound clients use `router/<profile>[/<tier>]` as the model on both `/v1/chat/completions`
and `/v1/responses`. Responses `reasoning.effort` / `reasoning_effort` select the tier
the same way `reasoning_effort` does on chat completions; `background: true` is rejected.

- `profiles.<name>.<tier>.models`: entries in fallback order, `"provider/model[#thinking]"`
  shorthand or `{ model, thinking, api }` objects (`thinking`/`api` are per-model only).
  `api`: `"openai-completions"` (default) or `"openai-responses"` outbound transport
- `classifierModels` / per-profile `classifierModels`: fast models for auto tiering
- `historySize`: prior turn pairs fed to the classifier (0–20)
- `tierGuides`: optional top-level map of tier name → classifier description (`minimal`/`low`/`medium`/`high`/`xhigh`/`max`). Replaces the matching built-in tier lines in the classifier system prompt. Partial overrides keep defaults for the rest; values are trimmed. Invalid tierGuides (non-object, unknown tier keys, non-string or empty/whitespace-only values) fail config load with an error. Hot-reloadable via `POST /router/reload` (llm-router) / `/router reload` (pi-model-router)
- `defaultProfile`, `debug`

## Credentials (read-only, never written)

| Provider | Source                                                                                                                                  |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `codex`  | Codex CLI auth: `$CODEX_HOME/auth.json` (default `~/.codex/auth.json`), or `LLM_ROUTER_CODEX_TOKEN` + `LLM_ROUTER_CODEX_ACCOUNT_ID` env |
| `grok`   | Grok CLI auth: `$GROK_HOME/auth.json` (default `~/.grok/auth.json`), or `LLM_ROUTER_GROK_KEY` env                                       |
| others   | `<PROVIDER>_API_KEY` env (+ optional `<PROVIDER>_BASE_URL`; uppercase, `-` → `_`, e.g. `opencode-go` → `OPENCODE_GO_API_KEY`)           |

CLI auth files are re-read on every request, so CLI-side OAuth refreshes are
picked up automatically. Expired tokens return an error asking for `codex login`
/ `grok login`.

## Dev

```bash
bun install
bun run tsc # typecheck
bun run test # vitest --coverage (100% thresholds)
bun run lint # oxlint
bun run format:check # oxfmt
LLM_ROUTER_CONFIG=./config/model-router.jsonc bun run src/index.ts
```

`/pi-check`는 위 4단계(tsc → test → lint → format:check)를 `.pi/pi-check.json` 순서대로 실행한다.

Env: `LLM_ROUTER_PORT` (default 4891), `LLM_ROUTER_CONFIG`, `LLM_ROUTER_STATE`.

Secrets can also live in `config/.env` (copy from `config/.env.example`, git-ignored).
It is loaded at boot from the config file's directory; existing environment variables win.
