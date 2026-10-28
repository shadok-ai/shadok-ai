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

## Not done (deliberately)

- No UI to configure a backend: secrets and env already exist, and a second
  configuration surface would drift from them.
- The header quota gauges still show the subscription (empty on a pure custom
  instance).
- No quality guard: a model with weak tool calling will loop. Documented in the
  README rather than detected.

## Verification

End to end against a fake Anthropic-compatible SSE server on a free port: a
signed-out instance launched with the variables started its lead agent, the
agent's requests reached the fake server with `model=fake-coder` and a bearer
token, the reply streamed into the chat, the context gauge read 19% (12k of
64k), and the page opened no sign-in card.
