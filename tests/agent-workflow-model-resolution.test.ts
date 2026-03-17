import test from "node:test";
import assert from "node:assert/strict";
import { resolveAgentModel } from "../extensions/agent_workflow/model_resolution.js";

test("resolveAgentModel keeps the requested model when it is available", () => {
  const resolved = resolveAgentModel(
    "openai/gpt-5.4",
    [
      { provider: "openai", id: "gpt-5.4" },
      { provider: "anthropic", id: "claude-opus-4-6" },
    ],
    { provider: "openai", id: "gpt-5.4" },
  );

  assert.equal(resolved.resolvedModel, "openai/gpt-5.4");
  assert.equal(resolved.warning, undefined);
});

test("resolveAgentModel falls back to the current session model when the requested model is unavailable", () => {
  const resolved = resolveAgentModel(
    "anthropic/claude-opus-4-6",
    [
      { provider: "openai-codex", id: "gpt-5.4" },
      { provider: "openai-codex", id: "gpt-5.3-codex" },
    ],
    { provider: "openai-codex", id: "gpt-5.3-codex" },
  );

  assert.equal(resolved.resolvedModel, "openai-codex/gpt-5.3-codex");
  assert.match(resolved.warning ?? "", /current session model openai-codex\/gpt-5\.3-codex/);
});

test("resolveAgentModel uses the current session model for agents without an explicit model", () => {
  const resolved = resolveAgentModel(
    undefined,
    [
      { provider: "openai-codex", id: "gpt-5.4" },
      { provider: "openai-codex", id: "gpt-5.3-codex" },
    ],
    { provider: "openai-codex", id: "gpt-5.4" },
  );

  assert.equal(resolved.resolvedModel, "openai-codex/gpt-5.4");
  assert.equal(resolved.warning, undefined);
});

test("resolveAgentModel falls back to the first available model when no current session model is provided", () => {
  const resolved = resolveAgentModel(
    "anthropic/claude-opus-4-6",
    [
      { provider: "openai-codex", id: "gpt-5.4" },
      { provider: "openai-codex", id: "gpt-5.3-codex" },
    ],
    undefined,
  );

  assert.equal(resolved.resolvedModel, "openai-codex/gpt-5.4");
  assert.match(resolved.warning ?? "", /falling back to openai-codex\/gpt-5\.4/);
});

test("resolveAgentModel skips an unavailable current session model and falls back to the first available model", () => {
  const resolved = resolveAgentModel(
    "anthropic/claude-opus-4-6",
    [
      { provider: "openai-codex", id: "gpt-5.4" },
      { provider: "openai-codex", id: "gpt-5.3-codex" },
    ],
    { provider: "anthropic", id: "claude-opus-4-6" },
  );

  assert.equal(resolved.resolvedModel, "openai-codex/gpt-5.4");
  assert.match(resolved.warning ?? "", /falling back to openai-codex\/gpt-5\.4/);
});

test("resolveAgentModel returns a helpful error when no authenticated models are available", () => {
  const resolved = resolveAgentModel("anthropic/claude-opus-4-6", [], undefined);

  assert.equal(resolved.resolvedModel, undefined);
  assert.match(resolved.warning ?? "", /no authenticated Pi models are configured/i);
});
