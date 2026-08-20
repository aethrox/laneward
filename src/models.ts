import { activePreset } from "./agent";

// The tier -> model mapping lived inline in src/conductor.ts and src/reader.ts,
// which was two problems. The copies could drift, and both hardcoded model IDs
// that move: a name that no longer exists fails per lane at dispatch, and a name
// that has been reassigned silently runs a different model than the routing
// measurements in docs/notes/2026-08-08-model-routing-pilot.md were taken
// against. Neither is visible at install time.
//
// Laneward passes the resolved model to the agent's write/read-only command,
// which overrides whatever config file the agent itself reads, so the operator
// cannot remap a tier without editing source. These environment variables are
// that missing knob.
//
// There is no module-level default table: an agent preset (src/agent.ts) is
// what used to fill DEFAULTS, and with no preset active -- raw JSON templates
// only -- guessing a model ID for an unknown agent is exactly the
// silent-wrong-model failure this file exists to prevent. Unresolved tiers
// throw, naming the variable to set, instead of handing an undefined or
// invented model ID to the agent's command.

export const MODEL_TIERS = ["fast", "balanced", "deep"] as const;
export type ModelTierName = (typeof MODEL_TIERS)[number];

export function modelEnvVar(tier: ModelTierName): string {
  return `LANEWARD_MODEL_${tier.toUpperCase()}`;
}

/**
 * Throws rather than returning undefined: an unrecognised tier is a lane that
 * can never run, and failing at dispatch with the tier named is more useful than
 * handing `undefined` to the agent's command.
 */
export function modelForTier(
  tier: string,
  env: Record<string, string | undefined> = process.env,
): string {
  if (!(MODEL_TIERS as readonly string[]).includes(tier)) {
    throw new Error(`unrecognized model tier: ${tier}`);
  }
  const name = tier as ModelTierName;
  const override = env[modelEnvVar(name)];
  if (override && override.length > 0) return override;

  const preset = activePreset(env);
  if (preset) return preset.models[name];

  throw new Error(
    `no default model for tier "${name}": no agent preset is active, set ${modelEnvVar(name)}`,
  );
}

/** The models every tier resolves to, after the environment has its say. */
export function modelsByTier(env: Record<string, string | undefined> = process.env): Record<ModelTierName, string> {
  const models = {} as Record<ModelTierName, string>;
  for (const tier of MODEL_TIERS) models[tier] = modelForTier(tier, env);
  return models;
}
