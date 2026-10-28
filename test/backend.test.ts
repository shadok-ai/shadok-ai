import assert from "node:assert/strict";
import test from "node:test";
import {
  BACKEND_PRESETS,
  backendEnv,
  backendFor,
  backendSaveVerdict,
  configuredBackendEnv,
  instanceEnv,
  isCustomBaseUrl,
  joinUrl,
  looksLikeMessage,
  parseContextWindow,
  parseModelList,
  testFailure,
} from "../src/backend.js";
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

test("a backend saved in the cockpit REPLACES shadok's env, never merges with it", () => {
  // Merging would hand the shell's Anthropic key to whatever third-party
  // server was just configured.
  const env = instanceEnv(
    { ANTHROPIC_API_KEY: "sk-ant-secret", ANTHROPIC_BASE_URL: "http://other:1" },
    { baseUrl: "https://api.deepseek.com/anthropic", model: "deepseek-chat", authToken: "ds-key" },
  );
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_BASE_URL, "https://api.deepseek.com/anthropic");
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "ds-key");
  const agent = backendEnv(env, {});
  assert.equal(agent.ANTHROPIC_API_KEY, undefined);
  assert.equal(agent.ANTHROPIC_DEFAULT_OPUS_MODEL, "deepseek-chat");
});

test("without a saved backend, the env is the source as before", () => {
  const pe = { ANTHROPIC_BASE_URL: "http://localhost:11434" };
  assert.equal(instanceEnv(pe, null), pe);
});

test("a keyless local backend still hands Claude Code a token", () => {
  // Claude Code wants SOME credential to skip its own sign-in.
  assert.equal(configuredBackendEnv({ baseUrl: "http://localhost:11434", model: "m" }).ANTHROPIC_AUTH_TOKEN, "none");
  assert.equal(configuredBackendEnv({ baseUrl: "http://x:1", model: "m", contextWindow: 64000 }).SHADOK_CONTEXT_WINDOW, "64000");
});

test("saving validates the address, the model and the window", () => {
  assert.equal(backendSaveVerdict({ baseUrl: "https://api.anthropic.com", model: "m" }).ok, false);
  assert.equal(backendSaveVerdict({ baseUrl: "localhost:11434", model: "m" }).ok, false);
  assert.equal(backendSaveVerdict({ baseUrl: "http://localhost:11434", model: " " }).ok, false);
  assert.equal(backendSaveVerdict({ baseUrl: "http://localhost:11434", model: "m", contextWindow: "lots" }).ok, false);
  const v = backendSaveVerdict({ baseUrl: "http://localhost:11434/", model: "m", contextWindow: "64k" });
  assert.deepEqual(v, { ok: true, value: { baseUrl: "http://localhost:11434", model: "m", contextWindow: 64000 } });
});

test("an empty key field keeps the saved key — for the same server only", () => {
  const saved = { baseUrl: "https://api.z.ai/api/anthropic", model: "glm", authToken: "k1" };
  const same = backendSaveVerdict({ baseUrl: "https://api.z.ai/api/anthropic", model: "glm-4.6" }, saved);
  assert.equal(same.ok && same.value.authToken, "k1");
  // A key never follows the user to ANOTHER server.
  const other = backendSaveVerdict({ baseUrl: "https://api.deepseek.com/anthropic", model: "x" }, saved);
  assert.equal(other.ok && other.value.authToken, undefined);
  const typed = backendSaveVerdict({ baseUrl: saved.baseUrl, model: "glm", authToken: "k2" }, saved);
  assert.equal(typed.ok && typed.value.authToken, "k2");
});

test("every preset but 'custom' is a custom backend address", () => {
  for (const p of BACKEND_PRESETS) {
    if (p.id === "custom") continue;
    assert.equal(isCustomBaseUrl(p.baseUrl), true, p.id);
  }
});

test("model lists are read from Ollama and OpenAI-style answers", () => {
  assert.deepEqual(parseModelList({ models: [{ name: "qwen3-coder:30b" }, { name: "gpt-oss:20b" }] }), ["gpt-oss:20b", "qwen3-coder:30b"]);
  assert.deepEqual(parseModelList({ data: [{ id: "glm-4.6" }, { id: "glm-4.6" }] }), ["glm-4.6"]);
  assert.deepEqual(parseModelList({ error: "nope" }), []);
  assert.deepEqual(parseModelList(null), []);
});

test("a failed test says what to change", () => {
  assert.match(testFailure(401, '{"error":{"message":"invalid key"}}'), /refused the API key/);
  assert.match(testFailure(404, "Not Found"), /LiteLLM/);
  assert.match(testFailure(404, '{"error":{"message":"model \'x\' not found"}}'), /does not know this model/);
  assert.match(testFailure(500, '{"error":"boom"}'), /500: boom/);
});

test("only an Anthropic message counts as a passed test", () => {
  assert.equal(looksLikeMessage({ type: "message", content: [{ type: "text", text: "ok" }] }), true);
  // An OpenAI chat completion is a server that answered in the wrong format.
  assert.equal(looksLikeMessage({ object: "chat.completion", choices: [] }), false);
});

test("joinUrl neither doubles nor drops a slash", () => {
  assert.equal(joinUrl("http://h:1/", "/v1/messages"), "http://h:1/v1/messages");
  assert.equal(joinUrl("https://api.deepseek.com/anthropic", "v1/messages"), "https://api.deepseek.com/anthropic/v1/messages");
});
