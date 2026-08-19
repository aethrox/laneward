import { expect, test } from "bun:test";
import { MODEL_TIERS, modelEnvVar, modelForTier, modelsByTier } from "../src/models";

// The environment is injected rather than mutated, so these assert the mapping
// itself and not whatever the operator exported before running the suite.
const empty: Record<string, string | undefined> = {};

test("every tier resolves to a model by default", () => {
  const models = modelsByTier(empty);
  for (const tier of MODEL_TIERS) {
    expect(models[tier]).toMatch(/^gpt-/);
  }
  expect(new Set(Object.values(models)).size).toBe(MODEL_TIERS.length);
});

test("an environment variable remaps one tier and leaves the others alone", () => {
  const env = { LANEWARD_MODEL_TERRA: "some-other-model" };
  const models = modelsByTier(env);
  expect(models.terra).toBe("some-other-model");
  expect(models.sol).toBe(modelsByTier(empty).sol);
  expect(models.luna).toBe(modelsByTier(empty).luna);
});

test("an empty override is ignored rather than blanking the model", () => {
  // codex exec -m "" is worse than the default: it fails per lane at dispatch.
  expect(modelsByTier({ LANEWARD_MODEL_SOL: "" }).sol).toBe(modelsByTier(empty).sol);
});

test("modelEnvVar names the variable the operator has to set", () => {
  expect(modelEnvVar("terra")).toBe("LANEWARD_MODEL_TERRA");
});

test("an unrecognized tier throws with the tier named", () => {
  expect(() => modelForTier("mercury", empty)).toThrow("unrecognized model tier: mercury");
});
