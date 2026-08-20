import { SQL } from "bun";
import { isSlug, slugRule } from "../src/slug";
import { access, copyFile, mkdir, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const usage = "Usage: scripts/new-lane.ts <lane_id> <brief-file> <owned_path>...";

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function adminUrl(url: URL): string {
  const admin = new URL(url);
  admin.pathname = "/postgres";
  return admin.toString();
}

function readEnv(text: string, key: string): string | undefined {
  return text.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1].trim() || undefined;
}

/**
 * The database the copied `.env` points at, in either of the two shapes a
 * repository uses: one `DATABASE_URL`, or `DATABASE_HOST` and friends as
 * separate keys. Returns undefined when the repository names no database at
 * all and configures itself some other way.
 */
export function envDatabaseUrl(text: string): URL | undefined {
  const single = readEnv(text, "DATABASE_URL");
  if (single) return new URL(single);

  const name = readEnv(text, "DATABASE_NAME");
  if (!name) return undefined;

  const url = new URL("postgres://127.0.0.1/");
  const host = readEnv(text, "DATABASE_HOST");
  if (host) url.hostname = host;
  const port = readEnv(text, "DATABASE_PORT");
  if (port) url.port = port;
  const user = readEnv(text, "DATABASE_USER");
  if (user) url.username = encodeURIComponent(user);
  // A split configuration usually keeps the password out of `.env` on purpose,
  // so fall back to the environment rather than failing on a missing key.
  const password = readEnv(text, "DATABASE_PASSWORD") ?? process.env.PGPASSWORD;
  if (password) url.password = encodeURIComponent(password);
  url.pathname = `/${encodeURIComponent(name)}`;
  return url;
}

/**
 * The tail a lane's database name carries. Teardown recognises a lane database
 * by this suffix, so the two must stay derived from one place: a mismatch would
 * either strand databases or, far worse, aim a DROP at the hub's own.
 */
export function laneDbSuffix(laneId: string): string {
  return `_lane_${laneId.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
}

/**
 * The tail an integration candidate's database name carries, by the same rule
 * and for the same reason as `laneDbSuffix`.
 *
 * It ends in `_test` deliberately. The verification layer's first act is running
 * the repository's own suite inside the candidate tree, and `src/db.ts` refuses
 * a `DATABASE_URL` under test whose database is not recognisably disposable.
 *
 * The plan component is capped where a lane's is not: `_test` has to survive,
 * and a plan id long enough to push the tail past Postgres's 63-byte limit would
 * lose it to silent truncation, leaving a candidate database the suite will not
 * run against. A hash keeps two long ids that share a prefix apart.
 */
export function candidateDbSuffix(planId: string, revision: number): string {
  const sanitized = planId.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  const component = sanitized.length <= 32
    ? sanitized
    : `${sanitized.slice(0, 23)}_${createHash("sha256").update(sanitized).digest("hex").slice(0, 8)}`;
  return `_candidate_${component}_r${revision}_test`;
}

export function suffixedDatabaseName(base: string, suffix: string): string {
  const maxBaseBytes = 63 - Buffer.byteLength(suffix);
  let trimmed = base;
  while (Buffer.byteLength(trimmed) > maxBaseBytes) trimmed = trimmed.slice(0, -1);
  return `${trimmed || "d"}${suffix}`;
}

export function candidateDatabaseName(base: string, planId: string, revision: number): string {
  return suffixedDatabaseName(base, candidateDbSuffix(planId, revision));
}

/**
 * Point the lane's copied `.env` at a database of its own. Without this a lane
 * driving a database-backed repository runs that repository's test suite, which
 * truncates tables, against the very database the hub is using.
 *
 * Returns the environment the driven repository needs to reach the new
 * database, which is the key it configures itself with rather than a fixed one.
 */
async function provisionDatabase(
  envPath: string,
  suffix: string,
): Promise<{ name: string; env: Record<string, string> } | undefined> {
  const text = await Bun.file(envPath).text();
  const url = envDatabaseUrl(text);
  if (!url) return undefined;

  const base = decodeURIComponent(url.pathname.slice(1));
  // Postgres truncates identifiers at 63 bytes, so a collision there would
  // silently share a database. Reserve room by trimming the base name instead.
  const database = suffixedDatabaseName(base, suffix);

  const admin = new SQL(adminUrl(url));
  try {
    await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(database)}`);
  } finally {
    await admin.end();
  }

  url.pathname = `/${encodeURIComponent(database)}`;
  if (readEnv(text, "DATABASE_URL")) {
    await Bun.write(envPath, text.replace(/^DATABASE_URL=.*$/m, `DATABASE_URL=${url.toString()}`));
    return { name: database, env: { DATABASE_URL: url.toString() } };
  }
  await Bun.write(envPath, text.replace(/^DATABASE_NAME=.*$/m, `DATABASE_NAME=${database}`));
  return { name: database, env: { DATABASE_NAME: database } };
}

export async function provisionLaneDatabase(
  envPath: string,
  laneId: string,
): Promise<{ name: string; env: Record<string, string> } | undefined> {
  return provisionDatabase(envPath, laneDbSuffix(laneId));
}

export async function provisionCandidateDatabase(
  envPath: string,
  planId: string,
  revision: number,
): Promise<{ name: string; env: Record<string, string> } | undefined> {
  return provisionDatabase(envPath, candidateDbSuffix(planId, revision));
}

export async function dropLaneDatabase(envPath: string, laneDb: string): Promise<void> {
  const url = envDatabaseUrl(await Bun.file(envPath).text());
  if (!url) return;
  const admin = new SQL(adminUrl(url));
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${quoteIdentifier(laneDb)}`);
  } finally {
    await admin.end();
  }
}

export function run(
  command: string[],
  cwd?: string,
  env?: Record<string, string | undefined>,
): { stdout: string; stderr: string; exitCode: number } {
  const result = Bun.spawnSync(command, { cwd, env, stdout: "pipe", stderr: "pipe" });
  return {
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
    exitCode: result.exitCode,
  };
}

/**
 * Every uncommitted path in a worktree.
 *
 * A failed `git status` throws rather than reporting a clean tree. Teardown
 * reads this to decide whether removing a worktree would destroy work, and an
 * error it cannot interpret is not permission to delete.
 */
export function dirtyPaths(worktreePath: string): string[] {
  const status = run(["git", "-C", worktreePath, "status", "--porcelain", "-uall"]);
  if (status.exitCode !== 0) {
    throw new Error(status.stderr.trim() || `Could not read git status in ${worktreePath}`);
  }
  return status.stdout.split("\n").filter(Boolean).map((line) => line.slice(3));
}

/** The one repository/worktree-root derivation shared by every lane artifact. */
export async function repositoryLocation(): Promise<{ repoRoot: string; worktreeRoot: string }> {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoCandidate = process.env.LANE_REPO ?? resolve(scriptDir, "..");
  const repo = run(["git", "-C", repoCandidate, "rev-parse", "--show-toplevel"]);
  if (repo.exitCode !== 0) throw new Error(repo.stderr.trim() || "Could not resolve repository root");
  const repoRoot = repo.stdout.trim();
  const declared =
    process.env.LANE_WORKTREE_ROOT ?? join(dirname(repoRoot), `${basename(repoRoot)}-worktrees`);
  const worktreeRoot = await realpath(declared).catch(() => declared);
  return { repoRoot, worktreeRoot };
}

/**
 * Where a lane lives, from its id alone. Teardown has to arrive at exactly the
 * same path this script created, including through a symlink or junction.
 */
export async function laneLocation(laneId: string): Promise<{ repoRoot: string; worktreeRoot: string; worktreePath: string; branch: string }> {
  const { repoRoot, worktreeRoot } = await repositoryLocation();
  return { repoRoot, worktreeRoot, worktreePath: join(worktreeRoot, laneId), branch: `lane/${laneId}` };
}

async function hasScript(packageJsonPath: string, name: string): Promise<boolean> {
  try {
    const pkg = await Bun.file(packageJsonPath).json();
    return typeof pkg?.scripts?.[name] === "string";
  } catch {
    return false;
  }
}

async function main() {
  const [laneId, briefFile, ...ownedPaths] = process.argv.slice(2);
  if (!laneId || !briefFile || ownedPaths.length === 0) {
    console.error(usage);
    process.exit(1);
  }

  // The worktree path is built from this id, so it is checked before anything
  // is created rather than left for the hub to reject after the fact.
  if (!isSlug(laneId)) {
    console.error(`Invalid lane_id: ${laneId}`);
    console.error(`A lane_id names a worktree directory and a branch: ${slugRule}.`);
    process.exit(1);
  }

  try {
    await access(briefFile, constants.R_OK);
  } catch {
    console.error(`Brief file is not readable: ${briefFile}`);
    console.error(usage);
    process.exit(1);
  }

  // The root may not exist yet on the very first lane, which is the one case
  // `laneLocation` cannot resolve; create it and ask again.
  let { repoRoot, worktreeRoot, worktreePath, branch } = await laneLocation(laneId);
  if (!(await realpath(worktreeRoot).catch(() => undefined))) {
    await mkdir(worktreeRoot, { recursive: true });
    ({ worktreeRoot, worktreePath } = await laneLocation(laneId));
  }

  try {
    await access(join(repoRoot, ".env"), constants.F_OK);
  } catch {
    try {
      await access(join(repoRoot, ".env.example"), constants.F_OK);
      console.error(`Repository .env is missing: ${join(repoRoot, ".env")}`);
      console.error("Write one with development values before opening a lane. Copying .env.example is not safe by default: it carries the installed deployment's database target, and a lane pointed at that can destroy real data.");
      process.exit(1);
    } catch {
      // Repositories without an example configure themselves another way.
    }
  }

  let created = false;
  let laneDb: Awaited<ReturnType<typeof provisionLaneDatabase>>;
  const laneEnv = join(worktreePath, ".env");
  try {
    const add = run(["git", "-C", repoRoot, "worktree", "add", "-b", branch, worktreePath]);
    if (add.exitCode !== 0) throw new Error(add.stderr.trim() || "Could not create worktree");
    created = true;

    try {
      await access(join(repoRoot, ".env"), constants.F_OK);
      await copyFile(join(repoRoot, ".env"), laneEnv);
      laneDb = await provisionLaneDatabase(laneEnv, laneId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const beforeInstall = new Set(dirtyPaths(worktreePath));
    const install = run(["bun", "install"], worktreePath);
    if (install.exitCode !== 0) throw new Error(install.stderr.trim() || "bun install failed");
    // In a repository with no committed lockfile `bun install` writes one, and
    // the evidence check scores every dirty path in the worktree against
    // `owned_paths`. Without this the worker is failed for a file this script
    // created before it ever started, and the lane records no evidence at all.
    const openerPaths = dirtyPaths(worktreePath).filter((path) => !beforeInstall.has(path));

    // A fresh database is empty. Apply the driven repository's own schema when
    // it declares the conventional script; repositories without one manage
    // their schema another way and are left alone.
    if (laneDb && (await hasScript(join(worktreePath, "package.json"), "db:migrate"))) {
      // Bun does not let a `.env` file override a variable that is already in
      // the environment, and this script's own process has the hub's
      // DATABASE_URL loaded. Pass the lane's explicitly or the hub gets migrated.
      const migrate = run(["bun", "run", "db:migrate"], worktreePath, {
        ...process.env,
        ...laneDb.env,
      });
      if (migrate.exitCode !== 0) throw new Error(migrate.stderr.trim() || "db:migrate failed");
    }

    const response = await fetch(`${process.env.HUB_URL ?? "http://127.0.0.1:8787"}/lanes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lane_id: laneId,
        lane_type: process.env.LANE_TYPE ?? "write",
        model: process.env.LANE_MODEL ?? "balanced",
        worktree_path: worktreePath,
        owned_paths: [...ownedPaths, ...openerPaths],
        original_brief: await Bun.file(briefFile).text(),
        depends_on: (process.env.LANE_DEPENDS_ON ?? "").split(/\s+/).filter(Boolean),
        plan_revision_id: process.env.LANE_PLAN_REVISION_ID,
      }),
    });
    const body = await response.text();
    if (response.status !== 201) throw new Error(`HUB registration failed (HTTP ${response.status}):\n${body}`);

    created = false;
    console.log(`Worktree: ${worktreePath}`);
    console.log(`Lane: ${laneId}`);
    if (laneDb) console.log(`Database: ${laneDb.name}`);
  } catch (error) {
    if (created) {
      if (laneDb) await dropLaneDatabase(laneEnv, laneDb.name).catch(() => {});
      run(["git", "-C", repoRoot, "worktree", "remove", "--force", worktreePath]);
      run(["git", "-C", repoRoot, "branch", "-D", branch]);
    }
    throw error;
  }
}

if (import.meta.main) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
