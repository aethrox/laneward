import { join } from "node:path";

// The conductor writes lane logs here and the dashboard reads them back, so the
// two must resolve the same directory or a running lane's log is simply missing
// from the dashboard. They used to compute it separately, and the Windows branch
// existed in only one of them.
export function stateHome(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.XDG_STATE_HOME) return env.XDG_STATE_HOME;
  if (platform === "win32") {
    return env.LOCALAPPDATA ?? join(env.USERPROFILE ?? ".", "AppData", "Local");
  }
  return join(env.HOME ?? ".", ".local", "state");
}

export function defaultLogDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  return env.LANEWARD_LOG_DIR ?? join(stateHome(env, platform), "laneward", "logs");
}
