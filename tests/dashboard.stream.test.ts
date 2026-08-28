import { beforeEach, expect, test } from "bun:test";
import { mkdtemp, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import app from "../src/app";
import { sql } from "../src/db";
import { createDashboard, type DashboardConfig } from "../src/dashboard";

beforeEach(async () => {
  await sql`TRUNCATE lanes, messages, approvals, plans, plan_revisions RESTART IDENTITY CASCADE`;
});

async function tempConfig(): Promise<DashboardConfig> {
  return {
    logDir: await mkdtemp(join(tmpdir(), "dashboard-stream-")),
    pollMs: 10,
    picoPath: join(import.meta.dir, "..", "assets", "pico.classless.min.css"),
  };
}

async function registerRunningLane(laneId: string) {
  await app.request("/lanes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      lane_id: laneId,
      lane_type: "write",
      model: "balanced",
      worktree_path: tmpdir(),
      owned_paths: [`src/${laneId}.ts`],
      original_brief: "brief",
    }),
  });
  await app.request(`/lanes/${laneId}/start`, { method: "POST" });
}

test("the empty dashboard page has an empty state", async () => {
  const response = await createDashboard(await tempConfig()).request("/");
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("No plans or lanes yet.");
});

// Collects SSE frames until `want` is satisfied or the deadline passes, then
// cancels the reader, which is also what a closed browser tab does.
async function collect(
  response: Response,
  want: (events: { event: string; data: string }[]) => boolean,
  timeoutMs = 3000,
) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const events: { event: string; data: string }[] = [];
  const deadline = Date.now() + timeoutMs;
  let buffer = "";
  try {
    while (!want(events) && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let split: number;
      while ((split = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        events.push({
          event: frame.match(/^event: (.*)$/m)?.[1] ?? "message",
          data: frame
            .split("\n")
            .filter((line) => line.startsWith("data: "))
            .map((line) => line.slice(6))
            .join("\n"),
        });
      }
    }
  } finally {
    await reader.cancel();
  }
  return events;
}

test("the stream opens with lane and plan snapshots", async () => {
  await registerRunningLane("alpha");
  await sql`INSERT INTO plans (plan_id, title) VALUES ('plan-a', 'Plan A')`;
  const cfg = await tempConfig();
  const response = await createDashboard(cfg).request("/events");
  expect(response.headers.get("content-type")).toContain("text/event-stream");

  const events = await collect(response, (e) =>
    e.some((x) => x.event === "lanes") && e.some((x) => x.event === "plans"),
  );
  const lanes = JSON.parse(events.find((e) => e.event === "lanes")!.data);
  const plans = JSON.parse(events.find((e) => e.event === "plans")!.data);
  expect(Array.isArray(lanes)).toBe(true);
  expect(lanes).toHaveLength(1);
  expect(lanes[0].lane_id).toBe("alpha");
  expect(lanes[0].status).toBe("running");
  expect(plans).toEqual([expect.objectContaining({ plan_id: "plan-a", title: "Plan A" })]);
});

test("an unchanged stream does not repeat lane or plan snapshots", async () => {
  await registerRunningLane("alpha");
  const cfg = await tempConfig();
  const response = await createDashboard(cfg).request("/events");
  const events = await collect(response, () => false, cfg.pollMs * 8);
  expect(events.filter((event) => event.event === "lanes")).toHaveLength(1);
  expect(events.filter((event) => event.event === "plans")).toHaveLength(1);
});

test("an existing log arrives as a reset payload before any appends", async () => {
  const cfg = await tempConfig();
  await registerRunningLane("alpha");
  await writeFile(join(cfg.logDir, "alpha.log"), "already here\n");

  const response = await createDashboard(cfg).request("/events");
  const events = await collect(response, (e) => e.some((x) => x.event === "log"));
  const payload = JSON.parse(events.find((e) => e.event === "log")!.data);
  expect(payload.lane_id).toBe("alpha");
  expect(payload.reset).toBe(true);
  expect(payload.chunk).toContain("already here");
});

test("new log bytes are pushed as they are written", async () => {
  const cfg = await tempConfig();
  await registerRunningLane("alpha");
  const path = join(cfg.logDir, "alpha.log");
  await writeFile(path, "first\n");

  const response = await createDashboard(cfg).request("/events");
  const appended = (async () => {
    await Bun.sleep(60);
    await appendFile(path, "second\n");
  })();

  const events = await collect(response, (e) => e.filter((x) => x.event === "log").length >= 2);
  await appended;

  const payloads = events.filter((e) => e.event === "log").map((e) => JSON.parse(e.data));
  expect(payloads[0].reset).toBe(true);
  expect(payloads[1].reset).toBe(false);
  expect(payloads[1].chunk).toBe("second\n");
});

test("closing the connection stops the poll loop", async () => {
  const cfg = await tempConfig();
  await registerRunningLane("alpha");
  const dash = createDashboard(cfg);
  const response = await dash.request("/events");

  await collect(response, (e) => e.some((x) => x.event === "lanes"));
  // collect() cancelled the reader; the loop must observe the abort and stop
  // writing rather than spinning forever on a dead connection.
  await Bun.sleep(cfg.pollMs * 5);
  expect(response.body!.locked).toBe(true);

  // A second connection must still work: the first one leaked nothing that
  // blocks it.
  const second = await dash.request("/events");
  const events = await collect(second, (e) => e.some((x) => x.event === "lanes"));
  expect(events.some((e) => e.event === "lanes")).toBe(true);
}, 20_000);

test("the stream sends a heartbeat so an idle socket is not reaped", async () => {
  const cfg = await tempConfig();
  await registerRunningLane("alpha");
  const response = await createDashboard(cfg).request("/events");
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  try {
    while (!raw.includes(": ping") && raw.length < 100000) {
      const { value, done } = await reader.read();
      if (done) break;
      raw += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel();
  }
  expect(raw).toContain(": ping");
});
