import assert from "node:assert/strict";
import test from "node:test";
import { backendEnv, backendFor, isCustomBaseUrl, parseContextWindow } from "../src/backend.js";
import { firstAgentPlan } from "../src/first-agent.js";

test("only a parseable URL off Anthropic is a custom backend", () => {
  assert.equal(isCustomBaseUrl("http://localhost:11434"), true);
  assert.equal(isCustomBaseUrl("https://litellm.internal.example/v1"), true);
  // Exporting Anthropic's own URL must not take an agent off the sign-in and
  // quota guards.
  assert.equal(isCustomBaseUrl("https://api.anthropic.com"), false);
  assert.equal(isCustomBaseUrl("https://anthropic.com"), false);
  // A typo is not a backend: guessing "custom" would drop the sign-in check
  // for an agent that then reaches nothing.
  assert.equal(isCustomBaseUrl("localhost:11434 oops"), false);
  assert.equal(isCustomBaseUrl(""), false);
  assert.equal(isCustomBaseUrl(undefined), false);
});

test("a host merely CONTAINING anthropic.com is still custom", () => {
  assert.equal(isCustomBaseUrl("http://anthropic.com.evil.example"), true);
  assert.equal(isCustomBaseUrl("http://notanthropic.com"), true);
});

test("context window accepts plain numbers and k/m suffixes", () => {
  assert.equal(parseContextWindow("64000"), 64_000);
  assert.equal(parseContextWindow("128k"), 128_000);
  assert.equal(parseContextWindow("1M"), 1_000_000);
  assert.equal(parseContextWindow("0"), null);
  assert.equal(parseContextWindow("big"), null);
  assert.equal(parseContextWindow(undefined), null);
});

test("backendFor reads the URL, the model and the window", () => {
  assert.deepEqual(backendFor({}), { kind: "subscription" });
  assert.deepEqual(
    backendFor({
      ANTHROPIC_BASE_URL: "http://localhost:11434",
      ANTHROPIC_MODEL: "qwen3-coder:30b",
      SHADOK_CONTEXT_WINDOW: "64k",
    }),
    { kind: "custom", baseUrl: "http://localhost:11434", model: "qwen3-coder:30b", contextWindow: 64_000 },
  );
});

test("shadok's own ANTHROPIC_* is forwarded only when it points off Anthropic", () => {
  // A developer's shell often carries an API key for other work: forwarding it
  // to a subscription agent would move it onto API billing without a word.
  assert.deepEqual(backendEnv({ ANTHROPIC_API_KEY: "sk-ant-x", PATH: "/bin" }, {}), {});
  const env = backendEnv(
    { ANTHROPIC_BASE_URL: "http://localhost:11434", ANTHROPIC_AUTH_TOKEN: "ollama", PATH: "/bin" },
    {},
  );
  assert.equal(env.ANTHROPIC_BASE_URL, "http://localhost:11434");
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "ollama");
  assert.equal("PATH" in env, false); // only the backend variables, never the whole env
});

test("a profile's secrets win over shadok's environment", () => {
  const env = backendEnv(
    { ANTHROPIC_BASE_URL: "http://localhost:11434", ANTHROPIC_MODEL: "small" },
    { ANTHROPIC_MODEL: "big" },
  );
  assert.equal(env.ANTHROPIC_MODEL, "big");
});

test("a profile alone can put one role on a custom backend", () => {
  const env = backendEnv({}, { ANTHROPIC_BASE_URL: "http://gpu-box:8000", ANTHROPIC_MODEL: "glm" });
  assert.equal(backendFor(env).kind, "custom");
});

test("every unmapped alias lands on the named model", () => {
  // Otherwise `opus` in the picker, and Claude Code's background small-model
  // calls, reach a server that has never heard of claude-opus-….
  const env = backendEnv(
    {},
    {
      ANTHROPIC_BASE_URL: "http://localhost:11434",
      ANTHROPIC_MODEL: "qwen3-coder:30b",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "qwen3:4b",
    },
  );
  assert.equal(env.ANTHROPIC_DEFAULT_OPUS_MODEL, "qwen3-coder:30b");
  assert.equal(env.ANTHROPIC_DEFAULT_SONNET_MODEL, "qwen3-coder:30b");
  assert.equal(env.ANTHROPIC_SMALL_FAST_MODEL, "qwen3-coder:30b");
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "qwen3:4b"); // an explicit mapping stays
});

test("no alias is invented on the subscription or without a model", () => {
  assert.deepEqual(backendEnv({}, { ANTHROPIC_MODEL: "opus" }), { ANTHROPIC_MODEL: "opus" });
  const env = backendEnv({}, { ANTHROPIC_BASE_URL: "http://localhost:11434" });
  assert.equal("ANTHROPIC_DEFAULT_OPUS_MODEL" in env, false);
});

test("a custom-backend instance gets its lead agent without signing in", () => {
  const p = firstAgentPlan({ channelCount: 0, authState: "signed-out", customBackend: true });
  assert.equal(p.spawn, true);
  // …but a cockpit in use is still left alone.
  assert.equal(firstAgentPlan({ channelCount: 2, authState: "unknown", customBackend: true }).spawn, false);
});
