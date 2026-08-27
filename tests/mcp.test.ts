import { afterEach, expect, test } from "bun:test";
import { handle, splitLines } from "../src/mcp";

const servers: ReturnType<typeof Bun.serve>[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

async function withHub<T>(hub: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.HUB_URL;
  process.env.HUB_URL = hub;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.HUB_URL;
    else process.env.HUB_URL = previous;
  }
}

function serve(routes: Record<string, () => Response>, seen: string[] = []) {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      seen.push(path);
      return routes[path]?.() ?? new Response("not found", { status: 404 });
    },
  });
  servers.push(server);
  return server.url.href;
}

async function call(name: string, args: object = {}, hub = "http://127.0.0.1:1"): Promise<any> {
  const response: any = await withHub(hub, () =>
    handle(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })),
  );
  return response;
}

const textOf = (response: any) => response.result.content.map((part: any) => part.text).join("\n");

test("initialize advertises tools, prompts and the workflow brief", async () => {
  const response: any = await handle(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
  expect(typeof response.result.protocolVersion).toBe("string");
  expect(response.result.capabilities.tools).toBeDefined();
  expect(response.result.capabilities.prompts).toBeDefined();
  expect(response.result.instructions.length).toBeGreaterThan(0);
});

test("a notification is not answered", async () => {
  expect(await handle(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }))).toBeUndefined();
});

test("tools/list carries every tool, each described and with an object schema", async () => {
  const response: any = await handle(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
  const names = response.result.tools.map((tool: any) => tool.name);
  expect(names.sort()).toEqual([
    "build_candidate", "candidates_due", "finding_adjudicate", "findings_list", "lane_answer",
    "lane_create", "lane_evidence", "lane_gate", "lane_list", "lane_log", "lane_teardown",
    "laneward_status", "plan_approve", "plan_revise", "plan_show", "plan_submit", "reset_stranded",
  ]);
  for (const tool of response.result.tools) {
    expect(tool.description.length).toBeGreaterThan(0);
    expect(tool.inputSchema.type).toBe("object");
  }
});

// Clients surface annotations and descriptions differently, and a destructive
// tool that reads as safe in either channel is the failure that matters.
test("destructive marking agrees in both directions", async () => {
  const response: any = await handle(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
  for (const tool of response.result.tools) {
    const flagged = tool.annotations?.destructiveHint === true;
    const said = tool.description.includes("DESTRUCTIVE");
    expect(flagged).toBe(said);
  }
  expect(response.result.tools.filter((t: any) => t.annotations?.destructiveHint).length).toBe(4);
});

test("laneward_status reports the counts sentence", async () => {
  const hub = serve({
    "/pending": () => Response.json({ waiting_approval: [{ lane_id: "a" }, { lane_id: "b" }], failed: [{ lane_id: "c" }], findings: [] }),
    "/lanes": () => Response.json([{ lane_id: "a", plan_revision_id: "r1", approved_at: null }]),
  });
  const text = textOf(await call("laneward_status", {}, hub));
  expect(text).toContain("Laneward: 1 lane(s) blocked on an unapproved plan revision; 2 lane(s) waiting on a human; 1 failed lane(s).");
});

test("an unreachable hub resolves as a tool error rather than rejecting", async () => {
  const response = await call("lane_list");
  expect(response.result.isError).toBe(true);
  expect(textOf(response)).toContain("unreachable");
});

test("a closed gate is a success, with its reason", async () => {
  const hub = serve({ "/lanes/a/gate": () => Response.json({ allowed: false, reason: "plan revision not approved" }) });
  const response = await call("lane_gate", { lane_id: "a" }, hub);
  expect(response.result.isError).toBeFalsy();
  expect(textOf(response)).toContain("plan revision not approved");
});

test("an owned_paths conflict names the lane it collided with", async () => {
  const hub = serve({
    "/plans/p/revisions": () => Response.json({ error: "owned_paths conflict", conflicting_lane_id: "other" }, { status: 409 }),
  });
  const response = await call("plan_revise", { plan_id: "p", content: {} }, hub);
  expect(response.result.isError).toBe(true);
  expect(textOf(response)).toContain("other");
});

test("lane_create rejects a lane_id that is not a slug without touching anything", async () => {
  const seen: string[] = [];
  const hub = serve({}, seen);
  const response = await call("lane_create", { lane_id: "../escape", brief: "b", owned_paths: ["src"] }, hub);
  expect(response.result.isError).toBe(true);
  expect(textOf(response)).toContain("letters, digits, dot, underscore and dash only");
  expect(seen).toEqual([]);
});

test("lane_create refuses when LANE_REPO is unset", async () => {
  const previous = process.env.LANE_REPO;
  delete process.env.LANE_REPO;
  try {
    const response = await call("lane_create", { lane_id: "fix-login", brief: "b", owned_paths: ["src"] });
    expect(response.result.isError).toBe(true);
    expect(textOf(response)).toContain("LANE_REPO");
  } finally {
    if (previous !== undefined) process.env.LANE_REPO = previous;
  }
});

// Identity, not equality: one string is what stops the two copies drifting.
test("the prompt serves the same text as initialize.instructions", async () => {
  const init: any = await handle(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
  const prompt: any = await handle(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "prompts/get", params: { name: "laneward_workflow" } }));
  expect(prompt.result.messages[0].content.text).toBe(init.result.instructions);
});

test("protocol errors use the codes a client expects", async () => {
  const unknownTool: any = await handle(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "nope" } }));
  expect(unknownTool.error.code).toBe(-32602);

  const missing: any = await handle(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lane_gate", arguments: {} } }));
  expect(missing.error.code).toBe(-32602);
  expect(missing.error.message).toContain("lane_id");

  const unknownMethod: any = await handle(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "does/not/exist" }));
  expect(unknownMethod.error.code).toBe(-32601);

  const malformed: any = await handle("{ not json");
  expect(malformed.error.code).toBe(-32700);
  expect(malformed.id).toBeNull();
});

test("splitLines frames messages and holds a partial one back", () => {
  const whole = splitLines('{"a":1}\n{"b":2}\n');
  expect(whole.lines).toEqual(['{"a":1}', '{"b":2}']);
  expect(whole.rest).toBe("");

  const first = splitLines('{"a":1}\n{"b":');
  expect(first.lines).toEqual(['{"a":1}']);
  const second = splitLines(`${first.rest}2}\n`);
  expect(second.lines).toEqual(['{"b":2}']);
  expect(second.rest).toBe("");
});
