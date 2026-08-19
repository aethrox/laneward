import { afterAll, expect, test } from "bun:test";
import { SQL } from "bun";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  dirtyPaths,
  dropLaneDatabase,
  laneDbSuffix,
  provisionLaneDatabase,
  suffixedDatabaseName,
} from "../scripts/new-lane";

const laneId = "db-provision-test";
const dir = await mkdtemp(join(tmpdir(), "laneward-new-lane-"));
const envPath = join(dir, ".env");

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("a lane gets its own database and its .env points at it", async () => {
  const hubUrl = process.env.DATABASE_URL!;
  await Bun.write(envPath, `DATABASE_URL=${hubUrl}\nPORT=8787\n`);

  const laneDb = (await provisionLaneDatabase(envPath, laneId))!;
  try {
    // Derived, not concatenated: the base name is trimmed to keep the whole
    // identifier inside Postgres's 63 bytes, so a hand-built expectation is
    // right only while the hub's own database name is short. It is not short
    // inside a lane worktree, where this suite runs as that lane's own check,
    // and a lane that fails its own check can never complete.
    expect(laneDb.name).toBe(
      suffixedDatabaseName(new URL(hubUrl).pathname.slice(1), laneDbSuffix(laneId)),
    );
    expect(laneDb.name.length).toBeLessThanOrEqual(63);

    const rewritten = await Bun.file(envPath).text();
    expect(rewritten).toContain(`DATABASE_URL=${laneDb.env.DATABASE_URL}`);
    expect(rewritten).toContain("PORT=8787");
    expect(new URL(laneDb.env.DATABASE_URL).pathname).toBe(`/${laneDb.name}`);

    // The database really exists and is not the hub's.
    const lane = new SQL(laneDb.env.DATABASE_URL);
    const [row] = await lane`SELECT current_database() AS name`;
    await lane.end();
    expect(row.name).toBe(laneDb.name);
  } finally {
    await dropLaneDatabase(envPath, laneDb.name);
  }

  const admin = new SQL(new URL("/postgres", hubUrl).toString());
  const gone = await admin`SELECT 1 FROM pg_database WHERE datname = ${laneDb.name}`;
  await admin.end();
  expect(gone.length).toBe(0);
});

// The case above cannot reach this branch: it runs against whatever database
// the suite was pointed at, and that name is short on the hub's own checkout.
// It is long inside a lane worktree, which is where the trimming decides
// whether a lane can run its own checks at all.
test("a base name too long for the suffix is trimmed, not truncated by Postgres", () => {
  const base = "laneward_lane_verification_findings_record";
  const name = suffixedDatabaseName(base, laneDbSuffix("db-provision-test"));
  expect(Buffer.byteLength(name)).toBeLessThanOrEqual(63);
  expect(name).toEndWith(laneDbSuffix("db-provision-test"));
  expect(base).toStartWith(name.slice(0, name.length - laneDbSuffix("db-provision-test").length));
});

// `bun install` writes a lockfile into a repository that has no committed one.
// Those paths are added to the lane's owned_paths, because otherwise the
// evidence check fails the worker for a file the lane opener created.
test("dirtyPaths reports every untracked and modified path", async () => {
  const repo = await mkdtemp(join(tmpdir(), "laneward-dirty-"));
  const git = (...args: string[]) => Bun.spawnSync(["git", "-C", repo, ...args]);
  git("init", "-q");
  git("config", "user.email", "test@test.local");
  git("config", "user.name", "test");
  await Bun.write(join(repo, "tracked.txt"), "one\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");

  expect(dirtyPaths(repo)).toEqual([]);

  await Bun.write(join(repo, "bun.lock"), "{}\n");
  await Bun.write(join(repo, "tracked.txt"), "two\n");
  expect(dirtyPaths(repo).sort()).toEqual(["bun.lock", "tracked.txt"]);

  await rm(repo, { recursive: true, force: true });
});

// Teardown reads this to decide whether removing a worktree destroys work, so a
// git failure must not read as a clean tree. It used to: the exit code was
// ignored, and a directory git cannot inspect reported nothing dirty.
test("a directory git cannot inspect is an error, not a clean tree", async () => {
  const notARepo = await mkdtemp(join(tmpdir(), "laneward-not-a-repo-"));
  expect(() => dirtyPaths(notARepo)).toThrow();
  await rm(notARepo, { recursive: true, force: true });
});

// neura-system, the Phase 4 pilot repository, keeps its connection in separate
// keys. The first pilot lane got no database of its own at all, because
// provisioning only recognised a single DATABASE_URL.
test("a repository configured with separate keys gets its own database too", async () => {
  const hub = new URL(process.env.DATABASE_URL!);
  const splitPath = join(dir, ".env.split");
  await Bun.write(
    splitPath,
    [
      `DATABASE_HOST=${hub.hostname}`,
      `DATABASE_PORT=${hub.port}`,
      `DATABASE_NAME=${decodeURIComponent(hub.pathname.slice(1))}`,
      `DATABASE_USER=${decodeURIComponent(hub.username)}`,
      `DATABASE_PASSWORD=${decodeURIComponent(hub.password)}`,
      "API_PORT=4390",
    ].join("\n") + "\n",
  );

  const laneDb = (await provisionLaneDatabase(splitPath, "split-test"))!;
  try {
    expect(laneDb.env).toEqual({ DATABASE_NAME: laneDb.name });

    const rewritten = await Bun.file(splitPath).text();
    expect(rewritten).toContain(`DATABASE_NAME=${laneDb.name}`);
    expect(rewritten).toContain("API_PORT=4390");
    expect(rewritten).not.toContain(`DATABASE_NAME=${decodeURIComponent(hub.pathname.slice(1))}\n`);

    const laneUrl = new URL(hub);
    laneUrl.pathname = `/${laneDb.name}`;
    const lane = new SQL(laneUrl.toString());
    const [row] = await lane`SELECT current_database() AS name`;
    await lane.end();
    expect(row.name).toBe(laneDb.name);
  } finally {
    await dropLaneDatabase(splitPath, laneDb.name);
  }
});

test("a repository that names no database is left alone", async () => {
  const nonePath = join(dir, ".env.none");
  await Bun.write(nonePath, "API_PORT=4390\n");
  expect(await provisionLaneDatabase(nonePath, "none-test")).toBeUndefined();
});
