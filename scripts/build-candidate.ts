import { access, copyFile, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";

import { isSlug, slugRule } from "../src/slug";
import {
  candidateDbSuffix,
  dropLaneDatabase,
  envDatabaseUrl,
  provisionCandidateDatabase,
  repositoryLocation,
  run,
} from "./new-lane";

const usage = "Usage: scripts/build-candidate.ts <plan_id> [--rebuild]";

export interface HubLane {
  lane_id: string;
  status: string;
  worktree_path: string;
  plan_revision_id: string;
  plan_id: string;
  revision: number;
}

export function newestPlanLanes(lanes: HubLane[], planId: string): HubLane[] {
  const matching = lanes.filter((lane) => lane.plan_id === planId);
  if (matching.length === 0) return [];
  const revision = Math.max(...matching.map((lane) => lane.revision));
  return matching
    .filter((lane) => lane.revision === revision)
    .sort((a, b) => a.lane_id < b.lane_id ? -1 : a.lane_id > b.lane_id ? 1 : 0);
}

export function candidateLocation(worktreeRoot: string, planId: string, revision: number) {
  const name = `${planId}-r${revision}`;
  return {
    branch: `integration/${name}`,
    worktreePath: join(worktreeRoot, `candidate-${name}`),
  };
}

export function candidateDatabaseFromEnv(
  envText: string,
  planId: string,
  revision: number,
): string | undefined {
  const url = envDatabaseUrl(envText);
  if (!url) return undefined;
  const name = decodeURIComponent(url.pathname.slice(1));
  return name.endsWith(candidateDbSuffix(planId, revision)) ? name : undefined;
}

function isHubLane(value: unknown): value is HubLane {
  if (!value || typeof value !== "object") return false;
  const lane = value as Record<string, unknown>;
  return isSlug(lane.lane_id) &&
    typeof lane.status === "string" &&
    typeof lane.worktree_path === "string" &&
    typeof lane.plan_revision_id === "string" &&
    typeof lane.plan_id === "string" &&
    Number.isInteger(lane.revision) &&
    (lane.revision as number) > 0 &&
    (lane.revision as number) <= 2_147_483_647;
}

async function hasScript(packageJsonPath: string, name: string): Promise<boolean> {
  try {
    const pkg = await Bun.file(packageJsonPath).json();
    return typeof pkg?.scripts?.[name] === "string";
  } catch {
    return false;
  }
}

function commandFailure(result: ReturnType<typeof run>, fallback: string): Error | undefined {
  if (result.exitCode === 0) return undefined;
  return new Error(result.stderr.trim() || result.stdout.trim() || fallback);
}

async function hubJson(
  hubUrl: string,
  path: string,
  init?: RequestInit,
): Promise<Record<string, any> | null> {
  const response = await fetch(`${hubUrl}${path}`, init);
  if (!response.ok) throw new Error(`Hub returned HTTP ${response.status}: ${await response.text()}`);
  return response.json();
}

function hubPost(hubUrl: string, path: string, body: unknown) {
  return hubJson(hubUrl, path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function removePreviousCandidate(
  repoRoot: string,
  worktreePath: string,
  branch: string,
  planId: string,
  revision: number,
): Promise<void> {
  const candidateEnv = join(worktreePath, ".env");
  const database = await Bun.file(candidateEnv)
    .text()
    .then((text) => candidateDatabaseFromEnv(text, planId, revision))
    .catch(() => undefined);
  if (database) {
    console.log(`Removing database: ${database}`);
    await dropLaneDatabase(candidateEnv, database);
  }

  try {
    await access(worktreePath, constants.F_OK);
    console.log(`Removing worktree: ${worktreePath}`);
    const removed = run(["git", "-C", repoRoot, "worktree", "remove", "--force", worktreePath]);
    const failure = commandFailure(removed, "Could not remove the previous candidate worktree");
    if (failure) throw failure;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  if (run(["git", "-C", repoRoot, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).exitCode === 0) {
    console.log(`Removing branch: ${branch}`);
    const removed = run(["git", "-C", repoRoot, "branch", "-D", branch]);
    const failure = commandFailure(removed, `Could not remove ${branch}`);
    if (failure) throw failure;
  }
}

async function main(): Promise<number> {
  const planId = process.argv[2];
  const rebuild = process.argv[3] === "--rebuild";
  if (!planId || process.argv.length > (rebuild ? 4 : 3)) {
    console.error(usage);
    return 1;
  }
  if (!isSlug(planId)) {
    console.error(`Invalid plan_id: ${planId}`);
    console.error(`A plan_id names a worktree directory and a branch: ${slugRule}.`);
    return 1;
  }

  let started = false;
  let step = "lane discovery";
  let runId: string | undefined;
  let runClosed = false;
  let hubUrl = "";
  let revisionId: string | undefined;
  try {
    hubUrl = (process.env.HUB_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
    const response = await fetch(`${hubUrl}/lanes`);
    if (!response.ok) throw new Error(`Hub returned HTTP ${response.status}: ${await response.text()}`);
    const body: unknown = await response.json();
    if (!Array.isArray(body)) throw new Error("Hub returned a malformed lane list");

    const matching = body.filter(
      (lane) => lane && typeof lane === "object" && (lane as Record<string, unknown>).plan_id === planId,
    );
    if (matching.some((lane) => !isHubLane(lane))) {
      throw new Error(`Hub returned a malformed lane for plan ${planId}`);
    }

    const lanes = newestPlanLanes(matching as HubLane[], planId);
    if (lanes.length === 0) {
      console.error(`Refusing to build candidate for ${planId}: the plan has no lanes. Nothing was changed.`);
      return 1;
    }

    const revision = lanes[0].revision;
    revisionId = lanes[0].plan_revision_id;
    if (lanes.some((lane) => lane.status !== "completed")) {
      console.error(`Refusing to build candidate for ${planId} revision ${revision}: not every lane is completed. Nothing was changed.`);
      for (const lane of lanes) console.error(`  ${lane.lane_id}: ${lane.status}`);
      return 1;
    }

    const latest = await hubJson(
      hubUrl,
      `/verification-runs/latest?plan_revision_id=${encodeURIComponent(revisionId)}&layer=construction`,
    );
    if (!rebuild && latest) {
      console.error(
        `Refusing to build ${planId} revision ${revision}: a construction attempt is already recorded; use --rebuild to replace it. Nothing was changed.`,
      );
      return 1;
    }
    if (rebuild) {
      if (latest?.status !== "failed") {
        console.error(
          `Refusing to rebuild ${planId} revision ${revision}: latest construction attempt is ${latest?.status ?? "missing"}. Nothing was changed.`,
        );
        return 1;
      }
      const pending = await hubJson(hubUrl, "/pending");
      if ((pending?.waiting_approval ?? []).some(
        (approval: any) =>
          approval.subject_kind === "plan_revision" && approval.plan_revision_id === revisionId,
      )) {
        console.error(
          `Refusing to rebuild ${planId} revision ${revision}: an unresolved approval exists. Nothing was changed.`,
        );
        return 1;
      }
    }
    const opened = await hubPost(hubUrl, "/verification-runs", {
      plan_revision_id: revisionId,
      layer: "construction",
    });
    runId = opened?.id;
    if (!runId) throw new Error("Hub did not return a verification run id");

    step = "repository inspection";
    const { repoRoot, worktreeRoot } = await repositoryLocation();
    const base = run(["git", "-C", repoRoot, "rev-parse", "HEAD"]);
    if (base.exitCode !== 0) throw commandFailure(base, "Could not read the base commit");
    const baseCommit = base.stdout.trim();
    const { branch, worktreePath } = candidateLocation(worktreeRoot, planId, revision);

    if (rebuild) {
      step = "previous candidate cleanup";
      await removePreviousCandidate(repoRoot, worktreePath, branch, planId, revision);
    }

    started = true;
    step = "candidate worktree creation";
    await mkdir(worktreeRoot, { recursive: true });
    const add = run(["git", "-C", repoRoot, "worktree", "add", "-b", branch, worktreePath, baseCommit]);
    const addFailure = commandFailure(add, "Could not create the candidate worktree");
    if (addFailure) throw addFailure;

    for (const lane of lanes) {
      const laneBranch = `lane/${lane.lane_id}`;
      step = `merge of ${laneBranch}`;
      const merge = run(["git", "-C", worktreePath, "merge", "--no-ff", "--no-edit", laneBranch]);
      const mergeFailure = commandFailure(merge, `Could not merge ${laneBranch}`);
      if (mergeFailure) throw mergeFailure;
    }

    const sourceEnv = join(repoRoot, ".env");
    const candidateEnv = join(worktreePath, ".env");
    let candidateDb: Awaited<ReturnType<typeof provisionCandidateDatabase>>;
    try {
      await access(sourceEnv, constants.F_OK);
      step = ".env copy";
      await copyFile(sourceEnv, candidateEnv);
      step = "candidate database provisioning";
      candidateDb = await provisionCandidateDatabase(candidateEnv, planId, revision);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    step = "bun install";
    const install = run(["bun", "install"], worktreePath);
    const installFailure = commandFailure(install, "bun install failed");
    if (installFailure) throw installFailure;

    if (candidateDb && (await hasScript(join(worktreePath, "package.json"), "db:migrate"))) {
      step = "db:migrate";
      // The parent process carries the hub's database variables. Bun will not
      // replace them from the copied `.env`, so the candidate values are explicit.
      const migrate = run(["bun", "run", "db:migrate"], worktreePath, {
        ...process.env,
        ...candidateDb.env,
      });
      const migrateFailure = commandFailure(migrate, "db:migrate failed");
      if (migrateFailure) throw migrateFailure;
    }

    console.log(`Branch: ${branch}`);
    console.log(`Worktree: ${worktreePath}`);
    console.log(`Base commit: ${baseCommit}`);
    console.log(`Database: ${candidateDb?.name ?? "not configured"}`);
    await hubPost(hubUrl, `/verification-runs/${runId}/result`, {
      status: "succeeded",
      detail: {
        branch,
        worktree_path: worktreePath,
        base_commit: baseCommit,
        database_name: candidateDb?.name ?? null,
      },
    });
    runClosed = true;
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (runId && !runClosed && revisionId) {
      try {
        await hubPost(hubUrl, `/verification-runs/${runId}/result`, {
          status: "failed",
          detail: { step, message },
        });
        await hubPost(hubUrl, `/plan-revisions/${revisionId}/approvals`, {});
      } catch (recordError) {
        console.error(`Could not record construction failure: ${recordError}`);
      }
    }
    console.error(
      started
        ? `Candidate build failed during ${step}. Debris was left in place.`
        : `Candidate build failed during ${step}. Nothing was changed.`,
    );
    console.error(message);
    return started ? 2 : 1;
  }
}

if (import.meta.main) {
  process.exitCode = await main();
}
