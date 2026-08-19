import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, logPath, readFrom, readTail } from "../src/dashboard-data";

async function tempLog(contents: string) {
  const dir = await mkdtemp(join(tmpdir(), "dashboard-logs-"));
  const path = join(dir, "lane.log");
  await writeFile(path, contents);
  return path;
}

test("logPath joins the configured log directory", () => {
  // logPath is only ever used as a filesystem path (Bun.file, writeFile), never
  // as a URL, so the platform-native separator is correct and the expectation
  // has to match it rather than hardcode POSIX.
  const cfg = { logDir: "/var/logs", pollMs: 1000, picoPath: "/pico.css" };
  expect(logPath(cfg, "gig-radar")).toBe(join("/var/logs", "gig-radar.log"));
});

test("defaultConfig honours LANEWARD_LOG_DIR", () => {
  const previous = process.env.LANEWARD_LOG_DIR;
  process.env.LANEWARD_LOG_DIR = "/tmp/somewhere";
  expect(defaultConfig().logDir).toBe("/tmp/somewhere");
  if (previous === undefined) delete process.env.LANEWARD_LOG_DIR;
  else process.env.LANEWARD_LOG_DIR = previous;
});

test("readTail returns only the last lines and the file size", async () => {
  const path = await tempLog("a\nb\nc\nd\n");
  const tail = await readTail(path, 2);
  expect(tail.text).toBe("c\nd\n".trimEnd());
  expect(tail.next).toBe(8);
});

test("readTail on a missing file is empty, not an error", async () => {
  const tail = await readTail("/tmp/does-not-exist-dashboard.log");
  expect(tail.text).toBe("");
  expect(tail.next).toBe(0);
});

test("readFrom returns only the bytes after the offset", async () => {
  const path = await tempLog("hello\n");
  await writeFile(path, "hello\nworld\n");
  const result = await readFrom(path, 6);
  expect(result.chunk).toBe("world\n");
  expect(result.next).toBe(12);
  expect(result.reset).toBe(false);
});

test("readFrom returns nothing when the file has not grown", async () => {
  const path = await tempLog("hello\n");
  const result = await readFrom(path, 6);
  expect(result.chunk).toBe("");
  expect(result.next).toBe(6);
});

test("readFrom restarts from zero when the file was truncated", async () => {
  const path = await tempLog("a long first run\n");
  await writeFile(path, "new\n");
  const result = await readFrom(path, 17);
  expect(result.chunk).toBe("new\n");
  expect(result.next).toBe(4);
  expect(result.reset).toBe(true);
});
