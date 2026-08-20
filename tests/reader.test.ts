import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReader, type ReaderFinding } from "../src/reader";

const roots: string[] = [];
const fakeCodex = join(import.meta.dir, "fixtures", "fake-codex.ts");

// runReader spawns an agent through the generic path, which needs an active
// preset to resolve anything at all -- there is no default.
const previousAgent = process.env.LANEWARD_AGENT;
process.env.LANEWARD_AGENT = "codex";

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  if (previousAgent === undefined) delete process.env.LANEWARD_AGENT;
  else process.env.LANEWARD_AGENT = previousAgent;
});

async function git(worktree: string, args: string[]) {
  const result = Bun.spawnSync(["git", "-C", worktree, ...args]);
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

async function fixture(manifest: unknown = { version: 1, reader: { test_paths: ["tests"] } }) {
  const root = await mkdtemp(join(tmpdir(), "reader runner with spaces "));
  roots.push(root);
  const worktree = join(root, "candidate worktree");
  const logs = join(root, "reader logs");
  await mkdir(join(worktree, "tests"), { recursive: true });
  await mkdir(join(worktree, "src"), { recursive: true });
  if (manifest !== undefined) {
    await mkdir(join(worktree, ".laneward"));
    await writeFile(join(worktree, ".laneward", "project.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest));
  }
  await writeFile(join(worktree, "tests", "subject.test.ts"), "export const testMarker = 'base-test';\n");
  await writeFile(join(worktree, "src", "context.ts"), "export const sourceMarker = 'base-source';\n");
  await git(worktree, ["init"]);
  await git(worktree, ["add", "."]);
  await git(worktree, ["-c", "user.name=Reader", "-c", "user.email=reader@example.test", "commit", "-m", "base"]);
  const base = await git(worktree, ["rev-parse", "HEAD"]);
  await writeFile(join(worktree, "tests", "subject.test.ts"), "export const testMarker = 'changed-test-diff';\n");
  await writeFile(join(worktree, "src", "context.ts"), "export const sourceMarker = 'changed-source-diff';\n");
  await git(worktree, ["add", "."]);
  await git(worktree, ["-c", "user.name=Reader", "-c", "user.email=reader@example.test", "commit", "-m", "candidate"]);
  return { worktree, logs, base };
}

async function skippedFixture(manifest: unknown) {
  const root = await mkdtemp(join(tmpdir(), "reader runner with spaces "));
  roots.push(root);
  const worktree = join(root, "candidate worktree");
  const logs = join(root, "reader logs");
  await mkdir(worktree, { recursive: true });
  if (manifest !== undefined) {
    await mkdir(join(worktree, ".laneward"));
    await writeFile(join(worktree, ".laneward", "project.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest));
  }
  return { worktree, logs };
}

function report(findings: unknown[]) { return `before\n\`\`\`json\n${JSON.stringify({ findings })}\n\`\`\``; }
function location(path: string, side: "base" | "head" = "head") { return { path, side, start_line: 2, end_line: 3 }; }

async function run(item: Awaited<ReturnType<typeof fixture>>, output: string, rejected: ReaderFinding[] = []) {
  await writeFile(join(item.worktree, ".output"), output);
  const previous = process.env.LANEWARD_AGENT_BIN;
  process.env.LANEWARD_AGENT_BIN = fakeCodex;
  try { return await runReader(item.worktree, item.base, rejected, item.logs); }
  finally { if (previous === undefined) delete process.env.LANEWARD_AGENT_BIN; else process.env.LANEWARD_AGENT_BIN = previous; }
}

test("returns validated findings and preserves their fields", async () => {
  const item = await fixture();
  const findings: ReaderFinding[] = [
    { finding: "test concern", subject: "test_diff", out_of_change: false, locations: [location("tests/subject.test.ts"), location("tests/subject.test.ts", "base")] },
    { finding: "context concern", subject: "source_context", out_of_change: true, locations: [location("src/context.ts")] },
  ];
  const result = await run(item, report(findings));
  expect(result).toMatchObject({ schema_version: 1, source: "reader", status: "succeeded", findings, exit_code: 0, error: null });
  expect(result.output_path).toEndWith("candidate-worktree.reader.log");
});

test("only a parsed empty report is no_findings", async () => {
  const item = await fixture();
  expect(await run(item, report([]))).toMatchObject({ status: "no_findings", findings: [], exit_code: 0 });
  expect(await run(item, "nothing structured here")).toMatchObject({ status: "failed", findings: [], error: expect.stringContaining("no JSON block") });
});

test("unparseable reports fail with specific errors", async () => {
  const item = await fixture();
  expect((await run(item, "```json\n{\n``` ")).error).toContain("invalid JSON");
  expect((await run(item, report([{ finding: "bad", subject: "other", out_of_change: false, locations: [] }]))).error).toContain("unknown subject");
  expect((await run(item, report([{ finding: "bad", subject: "test_diff", out_of_change: false, locations: [{ path: "x", side: "head", start_line: 0, end_line: 1 }] }]))).error).toContain("malformed location");
});

test("a nonzero reader exit fails even when its report parses", async () => {
  const item = await fixture();
  await writeFile(join(item.worktree, ".exit-code"), "7");
  const result = await run(item, report([]));
  expect(result).toMatchObject({ status: "failed", findings: [], exit_code: 7, error: "reader exited 7" });
});

test("a caller-supplied reader binary wins over the environment", async () => {
  const item = await fixture();
  await writeFile(join(item.worktree, ".output"), report([]));
  const previous = process.env.LANEWARD_AGENT_BIN;
  process.env.LANEWARD_AGENT_BIN = join(item.worktree, "missing-reader-binary");
  try {
    expect(await runReader(item.worktree, item.base, [], item.logs, fakeCodex)).toMatchObject({ status: "no_findings", exit_code: 0 });
    expect(await Bun.file(join(item.worktree, ".prompt")).exists()).toBe(true);
  } finally {
    if (previous === undefined) delete process.env.LANEWARD_AGENT_BIN; else process.env.LANEWARD_AGENT_BIN = previous;
  }
});

test("the prompt carries both diffs and rejected finding context", async () => {
  const item = await fixture();
  await run(item, report([]), [{ finding: "previous false positive", subject: "test_diff", out_of_change: false, locations: [location("tests/subject.test.ts")] }]);
  const sent = await readFile(join(item.worktree, ".prompt"), "utf8");
  expect(sent).toContain("changed-test-diff");
  expect(sent).toContain("changed-source-diff");
  expect(sent).toContain("previous false positive");
});

test("missing, malformed, empty, and malformed test-path declarations are skipped without spawning", async () => {
  for (const manifest of [undefined, "{", { version: 1, reader: { test_paths: [] } }, { version: 1, reader: { test_paths: "tests" } }]) {
    const item = await skippedFixture(manifest);
    const result = await runReader(item.worktree, "unneeded", [], item.logs);
    expect(result).toMatchObject({ status: "skipped", findings: [], output_path: null, exit_code: null, error: expect.stringContaining(manifest === undefined || manifest === "{" ? "project manifest" : "reader.test_paths") });
    expect(await Bun.file(join(item.worktree, ".prompt")).exists()).toBe(false);
  }
});

test("a timeout kills the reader and fails", async () => {
  const item = await fixture();
  await writeFile(join(item.worktree, ".sleep"), "2");
  const previousBin = process.env.LANEWARD_AGENT_BIN;
  const previousTimeout = process.env.LANEWARD_READER_TIMEOUT_MS;
  process.env.LANEWARD_AGENT_BIN = fakeCodex;
  process.env.LANEWARD_READER_TIMEOUT_MS = "500";
  try {
    expect(await runReader(item.worktree, item.base, [], item.logs)).toMatchObject({ status: "failed", findings: [], exit_code: null, error: "reader timed out after 500 ms" });
  } finally {
    if (previousBin === undefined) delete process.env.LANEWARD_AGENT_BIN; else process.env.LANEWARD_AGENT_BIN = previousBin;
    if (previousTimeout === undefined) delete process.env.LANEWARD_READER_TIMEOUT_MS; else process.env.LANEWARD_READER_TIMEOUT_MS = previousTimeout;
  }
}, 20_000);
