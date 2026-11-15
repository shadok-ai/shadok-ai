# Custom model backend (self-hosted open models)

## Goal

Let an agent — or a whole instance — run on a model the user hosts (Ollama,
llama.cpp, vLLM, a LiteLLM gateway) instead of the Claude subscription.

## Mechanism: Claude Code's own, not ours

shadok never calls a model; it drives the `claude` TUI. Claude Code already
supports another backend through `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` +
`ANTHROPIC_MODEL` (and the `ANTHROPIC_DEFAULT_*_MODEL` alias mappings), as long
as the server speaks the Anthropic Messages API. So shadok adds no model client:
it carries the variables to the agent and stops treating that agent as a
subscription agent.

## Sources

1. shadok's own environment — a whole instance on a local model.
2. The profile's vault secrets — one role on a local model. Secrets win.

shadok's environment is forwarded ONLY when its `ANTHROPIC_BASE_URL` points off
Anthropic: a developer's shell often carries an `ANTHROPIC_API_KEY`, and
forwarding it to a subscription instance would silently switch agents to API
billing. Only the listed backend variables are forwarded, never the whole env.
They are passed explicitly because a tmux pane does not reliably inherit
shadok's environment (tmux gives a new session its server's env).

"Custom" = a parseable http(s) URL whose host is not `anthropic.com` or a
subdomain of it. An unparseable URL is NOT custom: guessing would drop the
sign-in check for an agent that reaches nothing.

## What changes for a custom agent

| Subscription behaviour | Custom backend |
|---|---|
| Spawn refused when the instance is signed out (`logged-out`) | Not checked: the agent carries its own token. The profile is resolved before the gate (`gateProfile`); an unmatched resume falls back to the probe. |
| Lead agent waits for a sign-in (`firstAgentPlan`) | Spawned at once when the INSTANCE env is custom. |
| Sign-in card opens on a signed-out `/auth` | `/auth` carries `backend: "custom"` (instance-wide) and the page does not open the card. |
| Pace guard blocks prompts and parks auto-retries | Skipped (`Live.backend`, decided at spawn from the same env the process got). |
| Context window from the `[1m]` setting | `SHADOK_CONTEXT_WINDOW` when set, else the usual assumption. |
| Model aliases resolve to Claude models | Every unset alias (`opus`/`sonnet`/`haiku`, small-fast) mapped to `ANTHROPIC_MODEL`. |

## Choosing it in the cockpit

The sign-in card a signed-out instance opens gains a second side, **Another
model**; the version menu opens the same card on that side (**⚙ Model
backend…**), dismissable. The `claude auth login` child is started only when
the Claude side is shown, and cancelled when another model is saved, so it is
never left waiting on stdin.

- **Presets** (`BACKEND_PRESETS`): Ollama, llama.cpp, DeepSeek, Z.ai (GLM),
  Moonshot (Kimi), and "another Anthropic-compatible server". Only servers that
  speak the Anthropic Messages API: an OpenAI-only API (Hugging Face Inference,
  Together, Groq) needs a translating proxy such as LiteLLM, which goes through
  the last entry. Preset model names are starting points; the test proves them.
- **Models** (`POST /backend/models`): Ollama's `/api/tags` (what is pulled),
  then `/v1/models`; nothing found leaves the field free text.
- **Test** (`POST /backend/test`): one real `POST /v1/messages`, with the key
  sent exactly as Claude Code sends `ANTHROPIC_AUTH_TOKEN` (a bearer, nothing
  else), so a pass predicts a working agent. Failures are worded by cause
  (`testFailure`): refused key, no Anthropic API at that address (→ proxy),
  unknown model, nothing listening, timeout. An answer that is not an Anthropic
  `message` fails too. **Save is disabled until a test passes**, and any edit
  disables it again.
- **Storage** (`PUT /backend`, admin + browser only): `config.modelBackend[cwd]`
  — per launch dir, like the title and theme; the key is never sent back
  (`GET /backend` reports `hasKey`), and an empty key field keeps the saved key
  only for the SAME server address.
- **Precedence**: a saved backend REPLACES shadok's environment as the instance
  source, wholesale. Merging would forward a shell's `ANTHROPIC_API_KEY` to the
  third-party server just configured.
- Saving starts the lead agent if the instance has none (`startFirstAgent`).

## Not done (deliberately)

- No OpenAI-format translator inside shadok: documented as a proxy instead,
  until the need is confirmed.
- The header quota gauges still show the subscription (empty on a pure custom
  instance).
- No quality guard: a model with weak tool calling will loop. Documented in the
  README rather than detected.

## Verification

Onboarding: recorded with Playwright against an isolated `HOME` (a fresh,
signed-out machine) and a fake server on Ollama's port: card → Another model →
the three served models listed → Test passes → save → the lead agent starts on
`qwen3-coder:30b` and answers, no console errors.

Mechanism:

End to end against a fake Anthropic-compatible SSE server on a free port: a
signed-out instance launched with the variables started its lead agent, the
agent's requests reached the fake server with `model=fake-coder` and a bearer
token, the reply streamed into the chat, the context gauge read 19% (12k of
64k), and the page opened no sign-in card.
