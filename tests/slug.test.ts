import { afterAll, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isSlug } from "../src/slug";

const dir = await mkdtemp(join(tmpdir(), "laneward-slug-"));

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

test("isSlug accepts the ids lanes actually use", () => {
  for (const value of ["phase7-dashboard", "neura-phase1-migrations", "lane_1", "a", "v1.2"]) {
    expect(isSlug(value)).toBe(true);
  }
});

test("isSlug rejects anything that could leave the worktree root", () => {
  for (const value of ["../escape", "..", ".", "a/b", "a\\b", "-leading", ".hidden", "with space", "", "x".repeat(65), 7, null, undefined]) {
    expect(isSlug(value)).toBe(false);
  }
});

// The CLI creates the worktree itself, so rejecting the id at the hub would be
// too late: the directory would already exist wherever the id pointed.
test("new-lane.ts refuses a traversing lane_id before creating anything", async () => {
  const worktreeRoot = join(dir, "worktrees");
  const brief = join(dir, "brief.md");
  await Bun.write(brief, "# brief\n");

  const child = Bun.spawnSync(
    [process.execPath, "run", join(import.meta.dir, "..", "scripts", "new-lane.ts"), "../escape", brief, "core/*"],
    { env: { ...process.env, LANE_WORKTREE_ROOT: worktreeRoot }, stdout: "pipe", stderr: "pipe" },
  );

  expect(child.exitCode).toBe(1);
  expect(new TextDecoder().decode(child.stderr)).toContain("Invalid lane_id");
  expect(await readdir(dir)).not.toContain("worktrees");
});
