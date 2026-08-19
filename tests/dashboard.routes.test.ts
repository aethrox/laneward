import { beforeEach, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import app from "../src/app";
import { sql } from "../src/db";
import { createDashboard, type DashboardConfig } from "../src/dashboard";
import { formatLocations } from "../src/dashboard-page";

beforeEach(async () => {
  // /pending answers with findings now, so this file's empty-response assertion
  // depends on the verification tables too, not only the lane ones.
  await sql`TRUNCATE lanes, messages, approvals, verification_runs, plans, plan_revisions RESTART IDENTITY CASCADE`;
});

async function tempConfig(): Promise<DashboardConfig> {
  return {
    logDir: await mkdtemp(join(tmpdir(), "dashboard-routes-")),
    pollMs: 10,
    picoPath: join(import.meta.dir, "..", "assets", "pico.classless.min.css"),
  };
}

test("the page is served as HTML and links the stylesheet", async () => {
  const response = await app.request("/");
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/html");
  const body = await response.text();
  expect(body).toContain('<link rel="stylesheet" href="/pico.css">');
  expect(body).toContain("EventSource");
  expect(body).toContain('"Reader: "');
  expect(body).toContain("finding.finding");
  expect(body).toContain("if (revision.findings.length)");
  // The page calls the same function the test below asserts on, so the two
  // cannot drift: this only checks it was carried into the script.
  expect(body).toContain("const formatLocations =");
  expect(body).toContain("formatLocations(finding.locations)");
});

test("a finding's locations read as places", () => {
  expect(formatLocations([{ path: "src/reader.ts", side: "head", start_line: 12, end_line: 14 }]))
    .toBe("src/reader.ts:12-14 (head)");
  expect(formatLocations([{ path: "src/reader.ts", side: "base", start_line: 12, end_line: 12 }]))
    .toBe("src/reader.ts:12 (base)");
  expect(formatLocations([
    { path: "tests/reader.test.ts", side: "base", start_line: 3, end_line: 3 },
    { path: "src/reader.ts", side: "head", start_line: 31, end_line: 40 },
  ])).toBe("tests/reader.test.ts:3 (base), src/reader.ts:31-40 (head)");
  expect(formatLocations([])).toBe("");
});

test("the vendored stylesheet is served and cached", async () => {
  const response = await app.request("/pico.css");
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/css");
  expect(response.headers.get("cache-control")).toContain("immutable");
  expect((await response.text()).length).toBeGreaterThan(60000);
});

test("a whole log is served as plain text", async () => {
  const cfg = await tempConfig();
  await writeFile(join(cfg.logDir, "alpha.log"), "line one\nline two\n");
  const response = await createDashboard(cfg).request("/lanes/alpha/log");
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/plain");
  expect(await response.text()).toBe("line one\nline two\n");
});

test("a missing log is a 404, not an empty 200", async () => {
  const response = await createDashboard(await tempConfig()).request("/lanes/nope/log");
  expect(response.status).toBe(404);
});

// The log route holds the same rule as lane registration: an id that could not
// be registered cannot name a log file either.
test("a lane id that escapes the log directory is rejected", async () => {
  const dashboard = createDashboard(await tempConfig());
  // A lone `.` or `..` segment, encoded or not, is normalized away by the URL
  // parser and never reaches the route at all, so the cases worth asserting are
  // the ones that do arrive as a lane id.
  for (const laneId of ["..%2F..%2Fetc%2Fpasswd", "%2Eenv", "-leading", "with%20space", "a%5Cb"]) {
    const response = await dashboard.request(`/lanes/${laneId}/log`);
    expect(response.status).toBe(400);
  }
});

test("mounting the dashboard does not shadow the JSON API", async () => {
  const response = await app.request("/pending");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ waiting_approval: [], failed: [], findings: [] });
});
