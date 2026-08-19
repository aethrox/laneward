// The tier -> model mapping lived inline in src/conductor.ts and src/reader.ts,
// which was two problems. The copies could drift, and both hardcoded model IDs
// that move: a name that no longer exists fails per lane at dispatch, and a name
// that has been reassigned silently runs a different model than the routing
// measurements in docs/notes/2026-08-08-model-routing-pilot.md were taken
// against. Neither is visible at install time.
//
// Laneward passes the model to `codex exec -m`, which overrides whatever
// ~/.codex/config.toml says, so the operator cannot remap a tier without editing
// source. These environment variables are that missing knob.

export const MODEL_TIERS = ["sol", "terra", "luna"] as const;
export type ModelTierName = (typeof MODEL_TIERS)[number];

const DEFAULTS: Record<ModelTierName, string> = {
  sol: "gpt-5.6-sol",
  terra: "gpt-5.6-terra",
  luna: "gpt-5.6-luna",
};

export function modelEnvVar(tier: ModelTierName): string {
  return `LANEWARD_MODEL_${tier.toUpperCase()}`;
}

/** The models every tier resolves to, after the environment has its say. */
export function modelsByTier(env: Record<string, string | undefined> = process.env) {
  const models = {} as Record<ModelTierName, string>;
  for (const tier of MODEL_TIERS) {
    const override = env[modelEnvVar(tier)];
    models[tier] = override && override.length > 0 ? override : DEFAULTS[tier];
  }
  return models;
}

/**
 * Throws rather than returning undefined: an unrecognised tier is a lane that
 * can never run, and failing at dispatch with the tier named is more useful than
 * handing `undefined` to `codex exec -m`.
 */
export function modelForTier(
  tier: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const model = (modelsByTier(env) as Record<string, string>)[tier];
  if (!model) throw new Error(`unrecognized model tier: ${tier}`);
  return model;
}
