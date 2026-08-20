import { expect, test } from "bun:test";
import { AGENT_PRESET_ENV_VAR } from "../src/agent";
import { MODEL_TIERS, modelEnvVar, modelForTier, modelsByTier } from "../src/models";

// The environment is injected rather than mutated, so these assert the mapping
// itself and not whatever the operator exported before running the suite.
const empty: Record<string, string | undefined> = {};
const codex = { [AGENT_PRESET_ENV_VAR]: "codex" };
const claude = { [AGENT_PRESET_ENV_VAR]: "claude" };

test("every tier resolves to a model under the codex preset", () => {
  const models = modelsByTier(codex);
  for (const tier of MODEL_TIERS) {
    expect(models[tier]).toMatch(/^gpt-/);
  }
  expect(new Set(Object.values(models)).size).toBe(MODEL_TIERS.length);
});

test("every tier resolves to a model under the claude preset, and the two presets disagree", () => {
  const models = modelsByTier(claude);
  expect(models).toEqual({ fast: "haiku", balanced: "sonnet", deep: "opus" });
  expect(models.balanced).not.toBe(modelsByTier(codex).balanced);
});

test("an environment variable remaps one tier and leaves the others alone", () => {
  const env = { ...codex, LANEWARD_MODEL_BALANCED: "some-other-model" };
  const models = modelsByTier(env);
  expect(models.balanced).toBe("some-other-model");
  expect(models.fast).toBe(modelsByTier(codex).fast);
  expect(models.deep).toBe(modelsByTier(codex).deep);
});

test("an empty override is ignored rather than blanking the model", () => {
  // An empty model id is worse than the preset default: it fails per lane at
  // dispatch instead of at configuration time.
  expect(modelsByTier({ ...codex, LANEWARD_MODEL_DEEP: "" }).deep).toBe(modelsByTier(codex).deep);
});

test("a LANEWARD_MODEL_* override beats the active preset", () => {
  const env = { ...claude, LANEWARD_MODEL_FAST: "a-completely-different-model" };
  expect(modelForTier("fast", env)).toBe("a-completely-different-model");
});

test("modelEnvVar names the variable the operator has to set", () => {
  expect(modelEnvVar("balanced")).toBe("LANEWARD_MODEL_BALANCED");
});

test("an unrecognized tier throws with the tier named", () => {
  expect(() => modelForTier("mercury", codex)).toThrow("unrecognized model tier: mercury");
});

test("no active preset and no override throws naming the variable to set", () => {
  expect(() => modelForTier("deep", empty)).toThrow(
    `no default model for tier "deep": no agent preset is active, set ${modelEnvVar("deep")}`,
  );
});
