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
| GET    | `/v1/models`             | Profile list as `router/<profile>`                              |
| GET    | `/router/status`         | Profiles, spend (tokens), last decision                         |
| GET    | `/router/debug`          | Recent routing decisions (config `debug: true` records)         |
| POST   | `/router/reload`         | Hot-reload `model-router.jsonc`                                 |
| POST   | `/router/reset-failures` | Clear failure memory (`{"profile"?: "..."}`)                    |

## Config

`config/model-router.jsonc` (copy from `config/model-router.example.json`):

- `profiles.<name>.<tier>.models`: canonical refs `provider/model[#thinking]`
- `profiles.<name>.<tier>.api`: outbound transport, `"openai-completions"` (default) or `"openai-responses"`
- `classifierModels` / per-profile `classifierModels`: fast models for auto tiering
- `historySize`: prior turn pairs fed to the classifier (0–20)
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
