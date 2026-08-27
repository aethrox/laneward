import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { HubError, hubJson, url } from "./hub";
import { WORKFLOW_BRIEF } from "./mcp-brief";
import { isSlug, slugRule } from "./slug";

// Pinned rather than echoed back from the client's `initialize`: echoing an
// unknown version claims support for whatever the client asked for.
const PROTOCOL_VERSION = "2025-06-18";

function hubUrl(): string {
  return process.env.HUB_URL ?? "http://127.0.0.1:8787";
}

// Word for word what `bridge state` says when the hub is down, because an
// operator who has seen one of them should recognise the other.
function unreachable(): string {
  return `Laneward is unreachable at ${hubUrl()}. The hub is a local service; start it with 'bun start' in the Laneward checkout.`;
}

function bodyField(body: unknown, key: string): string | undefined {
  const value = (body as Record<string, unknown> | null)?.[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * The hub's failure in the words the agent has to act on. A status code alone
 * tells it nothing it can do differently, and every one of these cases has a
 * different next move: fix a field, narrow the paths, or stop retrying.
 */
function hubMessage(error: HubError): string {
  const detail = bodyField(error.body, "error") ?? (typeof error.body === "string" ? error.body : "");
  const conflicting = bodyField(error.body, "conflicting_lane_id");
  if (conflicting) {
    return `owned_paths conflict with lane '${conflicting}'. Narrow this lane's owned_paths, or wait for that lane to finish. The worktree was rolled back; nothing was left behind.`;
  }
  const field = bodyField(error.body, "field");
  if (error.status === 400 && field) return `invalid ${field}: ${detail}`;
  if (error.status === 409 && /already/.test(detail)) {
    return `${detail}. The state is already what you asked for, so this is not something to retry.`;
  }
  return `${error.message}${detail ? `: ${detail}` : ""}`;
}

async function hub(path: string, init?: RequestInit): Promise<any> {
  try {
    return await hubJson(path, init);
  } catch (error) {
    if (error instanceof HubError) throw new Error(hubMessage(error));
    throw new Error(unreachable());
  }
}

async function hubPost(path: string, body: unknown): Promise<any> {
  return await hub(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// `GET /lanes/:id/log` serves plain text, so it cannot go through hubJson.
async function hubText(path: string): Promise<string> {
  try {
    const response = await fetch(url(path), { signal: AbortSignal.timeout(2_000) });
    const text = await response.text();
    if (!response.ok) {
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        // Same reason as in hubJson: not every hub error is JSON.
      }
      throw new HubError(response.status, body, `hub returned HTTP ${response.status}`);
    }
    return text;
  } catch (error) {
    if (error instanceof HubError) throw new Error(hubMessage(error));
    throw new Error(unreachable());
  }
}

function scriptPath(name: string): string {
  return fileURLToPath(new URL(`../scripts/${name}`, import.meta.url));
}

/**
 * `--no-env-file` for the same reason the server itself runs with it: an MCP
 * server's working directory is the *client's* project, and a `.env` picked up
 * there would aim these scripts at the driven repository's database.
 */
async function spawnScript(
  name: string,
  args: string[],
  env: Record<string, string | undefined> = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const child = Bun.spawn([process.execPath, "run", "--no-env-file", scriptPath(name), ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

function summary(sentence: string, payload?: unknown): string {
  if (payload === undefined) return sentence;
  const rendered = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  return rendered.length === 0 ? sentence : `${sentence}\n\n${rendered}`;
}

interface Tool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  run: (args: any) => Promise<string>;
}

const str = (description: string) => ({ type: "string", description });
const strings = (description: string) => ({ type: "array", items: { type: "string" }, description });
const flag = (description: string, def: boolean) => ({ type: "boolean", default: def, description });
const empty = { type: "object" as const, properties: {}, additionalProperties: false };

const readOnly = { readOnlyHint: true };
const destructive = { destructiveHint: true };

const tools: Tool[] = [
  {
    name: "laneward_status",
    description:
      "One line of Laneward's state - lanes blocked on an unapproved plan revision, lanes waiting on a human, failed lanes - followed by the full pending payload including each waiting lane's question. Start here.",
    inputSchema: empty,
    annotations: readOnly,
    run: async () => {
      const [pending, lanes] = await Promise.all([hub("/pending"), hub("/lanes")]);
      if (!pending || typeof pending !== "object" || !Array.isArray(lanes)) {
        throw new Error("The hub answered, but /pending or /lanes was not the shape this tool expects.");
      }
      const count = (key: string) => (Array.isArray(pending[key]) ? pending[key].length : 0);
      const unapproved = lanes.filter((lane: any) => lane?.plan_revision_id && !lane.approved_at).length;
      return summary(
        `Laneward: ${unapproved} lane(s) blocked on an unapproved plan revision; ${count("waiting_approval")} lane(s) waiting on a human; ${count("failed")} failed lane(s).`,
        pending,
      );
    },
  },
  {
    name: "lane_list",
    description:
      "Every registered lane with its status, worktree path, and the plan revision it is bound to. This is what you poll while lanes run; the conductor dispatches them, not you.",
    inputSchema: empty,
    annotations: readOnly,
    run: async () => {
      const lanes = await hub("/lanes");
      return summary(`${Array.isArray(lanes) ? lanes.length : 0} lane(s) registered.`, lanes);
    },
  },
  {
    name: "lane_gate",
    description:
      "Why a lane is or is not allowed to run right now. A closed gate is Laneward working, not a failure: read the reason and act on it rather than retrying.",
    inputSchema: {
      type: "object",
      properties: { lane_id: str("The lane to ask about.") },
      required: ["lane_id"],
    },
    annotations: readOnly,
    run: async (args) => {
      const gate = await hub(`/lanes/${encodeURIComponent(args.lane_id)}/gate`);
      const reason = typeof gate?.reason === "string" ? gate.reason : "no reason given";
      return summary(
        gate?.allowed
          ? `Lane '${args.lane_id}' may run: ${reason}.`
          : `Lane '${args.lane_id}' may not run: ${reason}.`,
        gate,
      );
    },
  },
  {
    name: "lane_log",
    description: "The tail of a lane's worker log, which is where a failing lane says what it was doing.",
    inputSchema: {
      type: "object",
      properties: {
        lane_id: str("The lane whose log to read."),
        lines: { type: "integer", default: 60, description: "How many trailing lines to return. Defaults to 60." },
      },
      required: ["lane_id"],
    },
    annotations: readOnly,
    run: async (args) => {
      // The route serves the whole file, so the tail is taken here rather than
      // handing an agent a log that could be megabytes.
      const wanted = Number.isInteger(args.lines) && args.lines > 0 ? args.lines : 60;
      const log = await hubText(`/lanes/${encodeURIComponent(args.lane_id)}/log`);
      const all = log.split("\n");
      const tail = all.slice(Math.max(0, all.length - wanted));
      return summary(`Last ${tail.length} of ${all.length} log line(s) for lane '${args.lane_id}'.`, tail.join("\n"));
    },
  },
  {
    name: "lane_evidence",
    description: "The evidence a lane recorded: what it claims it ran and what the run produced.",
    inputSchema: {
      type: "object",
      properties: { lane_id: str("The lane whose evidence to read.") },
      required: ["lane_id"],
    },
    annotations: readOnly,
    run: async (args) => {
      const evidence = await hub(`/lanes/${encodeURIComponent(args.lane_id)}/evidence`);
      const rows = Array.isArray(evidence?.evidence) ? evidence.evidence.length : 0;
      return summary(`Lane '${args.lane_id}' recorded ${rows} evidence message(s).`, evidence);
    },
  },
  {
    name: "plan_show",
    description:
      "A plan and every revision it has, newest first, each with its content and whether it was approved and by whom.",
    inputSchema: {
      type: "object",
      properties: { plan_id: str("The plan id.") },
      required: ["plan_id"],
    },
    annotations: readOnly,
    run: async (args) => {
      const plan = await hub(`/plans/${encodeURIComponent(args.plan_id)}`);
      const revisions = Array.isArray(plan?.revisions) ? plan.revisions.length : 0;
      return summary(`Plan '${args.plan_id}' has ${revisions} revision(s).`, plan);
    },
  },
  {
    name: "findings_list",
    description:
      "Every verification finding raised against one plan revision, in any state. Open ones are the reader's advice waiting on a human decision.",
    inputSchema: {
      type: "object",
      properties: { plan_revision_id: str("The plan revision id, as returned by plan_submit or plan_revise.") },
      required: ["plan_revision_id"],
    },
    annotations: readOnly,
    run: async (args) => {
      const findings = await hub(`/plan-revisions/${encodeURIComponent(args.plan_revision_id)}/findings`);
      const open = Array.isArray(findings) ? findings.filter((f: any) => f?.state === "open").length : 0;
      return summary(
        `${Array.isArray(findings) ? findings.length : 0} finding(s), ${open} still open.`,
        findings,
      );
    },
  },
  {
    name: "candidates_due",
    description:
      "Plan revisions whose lanes have all completed and which have no integration candidate yet. These are the ones build_candidate is for.",
    inputSchema: empty,
    annotations: readOnly,
    run: async () => {
      const due = await hub("/candidates/due");
      return summary(`${Array.isArray(due) ? due.length : 0} plan revision(s) due a candidate.`, due);
    },
  },
  {
    name: "lane_create",
    description:
      "Register a lane: creates its worktree, branch and database, then records it. It does not run anything - the conductor dispatches it when its gate opens. The brief is the only thing the worker will see.",
    inputSchema: {
      type: "object",
      properties: {
        lane_id: str(`Names the worktree directory and the branch, so it is a slug: ${slugRule}.`),
        brief: str("The whole instruction the worker reads. It sees nothing else: state the goal, the command that proves the work is done, the paths it owns, and what it must not touch."),
        owned_paths: strings("Every path this lane may write. Registration overlap is a prefix match; the evidence check is a stricter anchored glob where '*' does not cross '/'."),
        lane_type: { type: "string", enum: ["write", "read_review"], default: "write", description: "'write' by default; 'read_review' for a lane that only reads." },
        model: { type: "string", enum: ["fast", "balanced", "deep"], default: "balanced", description: "Which model tier the worker runs on." },
        depends_on: strings("Lane ids that must finish before this lane's gate opens."),
        plan_revision_id: str("Binds the lane to a plan revision, which must be approved before the lane may run."),
      },
      required: ["lane_id", "brief", "owned_paths"],
    },
    run: async (args) => {
      // Checked here rather than left to the script, because the script has
      // already built a worktree path out of this id by the time it complains.
      if (!isSlug(args.lane_id)) {
        throw new Error(
          `Invalid lane_id '${String(args.lane_id)}'. A lane_id names a worktree directory and a branch: ${slugRule}. Nothing was created.`,
        );
      }
      if (!Array.isArray(args.owned_paths) || args.owned_paths.some((p: unknown) => typeof p !== "string")) {
        throw new Error("owned_paths must be an array of strings. Nothing was created.");
      }
      // Unset, `repositoryLocation()` falls back to Laneward's own checkout,
      // and the lane would quietly open on Laneward instead of the repository
      // the human meant.
      if (!process.env.LANE_REPO) {
        throw new Error(
          "LANE_REPO is not set, so a lane would be opened on Laneward's own checkout instead of the repository you meant. Ask the human to set LANE_REPO to the driven repository and restart the MCP server. Nothing was created.",
        );
      }

      const briefPath = join(tmpdir(), `laneward-brief-${crypto.randomUUID()}.md`);
      await Bun.write(briefPath, args.brief);
      try {
        const result = await spawnScript(
          "new-lane.ts",
          [args.lane_id, briefPath, ...args.owned_paths],
          {
            LANE_TYPE: args.lane_type ?? "write",
            LANE_MODEL: args.model ?? "balanced",
            LANE_DEPENDS_ON: Array.isArray(args.depends_on) ? args.depends_on.join(" ") : "",
            // Spread rather than set: new-lane.ts passes this straight into the
            // POST body, and an empty string is not undefined, so the hub would
            // reject it as an invalid plan_revision_id.
            ...(args.plan_revision_id ? { LANE_PLAN_REVISION_ID: args.plan_revision_id } : {}),
          },
        );
        if (result.exitCode !== 0) {
          const conflicting = result.stderr.match(/"conflicting_lane_id"\s*:\s*"([^"]+)"/)?.[1];
          if (conflicting) {
            throw new Error(
              `${result.stderr}\n\nowned_paths conflict with lane '${conflicting}'. Narrow this lane's owned_paths, or wait for that lane to finish. The worktree was rolled back; nothing was left behind.`,
            );
          }
          if (/already exists/i.test(result.stderr)) {
            throw new Error(`${result.stderr}\n\nPick a different lane_id. Nothing was created.`);
          }
          throw new Error(result.stderr || `new-lane.ts exited ${result.exitCode}.`);
        }
        return summary(
          `Lane '${args.lane_id}' is registered and pending. Nothing has run yet; the conductor dispatches it when its gate opens.`,
          result.stdout,
        );
      } finally {
        await rm(briefPath, { force: true }).catch(() => {});
      }
    },
  },
  {
    name: "plan_submit",
    description:
      "Record a plan and its first revision. A plan carries execution authority: a lane bound to a revision cannot run until that revision is approved.",
    inputSchema: {
      type: "object",
      properties: {
        title: str("What the plan is for, in a few words."),
        content: { type: "object", description: "The plan itself, as a JSON object." },
        plan_id: str("A slug you can address later. One is generated if you omit it, but a generated id is not something a human can type."),
      },
      required: ["title", "content"],
    },
    run: async (args) => {
      const planId = args.plan_id ?? crypto.randomUUID();
      const body = await hubPost("/plans", { plan_id: planId, title: args.title, content: args.content });
      return summary(`Plan '${body.plan_id}' recorded at revision ${body.revision}. It is not approved yet.`, body);
    },
  },
  {
    name: "plan_revise",
    description:
      "Append a revision to a plan. This withdraws execution authority from every lane bound to an older revision, so those lanes stop until the new one is approved.",
    inputSchema: {
      type: "object",
      properties: {
        plan_id: str("The plan to revise."),
        content: { type: "object", description: "The new plan content, as a JSON object." },
      },
      required: ["plan_id", "content"],
    },
    run: async (args) => {
      const body = await hubPost(`/plans/${encodeURIComponent(args.plan_id)}/revisions`, { content: args.content });
      return summary(
        `Plan '${body.plan_id}' is now at revision ${body.revision}. Lanes on older revisions are blocked until this one is approved.`,
        body,
      );
    },
  },
  {
    name: "lane_answer",
    description:
      "Answer a lane that stopped to ask. Bring its question to the human first and use their words: the conductor appends this decision to the original brief and dispatches the lane again.",
    inputSchema: {
      type: "object",
      properties: {
        approval_id: str("The approval id from laneward_status."),
        decision: str("The human's answer, in full. The worker reads this appended to its brief."),
        resolved_by: { type: "string", enum: ["human", "claude"], default: "human", description: "Who decided. 'human' unless you decided it alone." },
        verified_by: { type: "string", enum: ["human", "claude"], description: "Who checked the claim, for a HOST VERIFICATION REQUIRED escalation." },
      },
      required: ["approval_id", "decision"],
    },
    run: async (args) => {
      const body = await hubPost(`/approvals/${encodeURIComponent(args.approval_id)}`, {
        resolved_by: args.resolved_by ?? "human",
        verified_by: args.verified_by,
        decision: args.decision,
      });
      return summary("Approval resolved. The conductor will dispatch the lane again with your decision appended to its brief.", body);
    },
  },
  {
    name: "finding_adjudicate",
    description:
      "Accept, reject or defer one verification finding. A rejected finding is what the next reader run is told not to raise again, so reject only what the human has actually dismissed.",
    inputSchema: {
      type: "object",
      properties: {
        finding_id: str("The finding id from findings_list."),
        state: { type: "string", enum: ["accepted", "rejected", "deferred"], description: "The decision." },
        note: str("Why, for whoever reads this later."),
      },
      required: ["finding_id", "state"],
    },
    run: async (args) => {
      const body = await hubPost(`/verification-findings/${encodeURIComponent(args.finding_id)}/adjudication`, {
        state: args.state,
        note: args.note,
      });
      return summary(`Finding adjudicated as '${body.state}'.`, body);
    },
  },
  {
    name: "plan_approve",
    description:
      "DESTRUCTIVE. Grants execution authority to every lane bound to this plan revision, and cannot be undone. Tell the human which plan and revision you are about to approve and wait for a yes before calling it.",
    inputSchema: {
      type: "object",
      properties: {
        plan_id: str("The plan to approve a revision of."),
        revision: { type: "integer", description: "The revision number." },
        approved_by: { type: "string", enum: ["human", "claude"], default: "human", description: "Who approved. 'human' unless the human explicitly delegated it." },
      },
      required: ["plan_id", "revision"],
    },
    annotations: destructive,
    run: async (args) => {
      const body = await hubPost(
        `/plans/${encodeURIComponent(args.plan_id)}/revisions/${encodeURIComponent(String(args.revision))}/approve`,
        { approved_by: args.approved_by ?? "human" },
      );
      return summary(
        `Plan '${body.plan_id}' revision ${body.revision} is approved. Lanes bound to it may now run.`,
        body,
      );
    },
  },
  {
    name: "build_candidate",
    description:
      "DESTRUCTIVE when rebuild is true, which destroys the existing candidate worktree, branch and database. Assembles an integration candidate from a plan's completed lanes for review - it is not a merge, and Laneward never commits or pushes. Ask the human before rebuilding.",
    inputSchema: {
      type: "object",
      properties: {
        plan_id: str("The plan to build a candidate for. candidates_due lists the ones that are ready."),
        rebuild: flag("DESTRUCTIVE: replaces the existing candidate worktree, branch and database. Ask the human first.", false),
      },
      required: ["plan_id"],
    },
    annotations: destructive,
    run: async (args) => {
      const result = await spawnScript("build-candidate.ts", [args.plan_id, ...(args.rebuild ? ["--rebuild"] : [])]);
      if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || `build-candidate.ts exited ${result.exitCode}.`);
      return summary(`Integration candidate built for plan '${args.plan_id}'. It is a candidate for review, not a merge; the human integrates.`, result.stdout);
    },
  },
  {
    name: "reset_stranded",
    description:
      "DESTRUCTIVE when dry_run is false, which rewrites lane state. Returns lanes left 'running' with no worker behind them - after a reboot or a killed conductor - to 'pending'. Run it with dry_run first, show the human what would change, and ask before changing it.",
    inputSchema: {
      type: "object",
      properties: {
        dry_run: flag("True by default: reports what would change without changing it. Setting it false is DESTRUCTIVE - ask the human first.", true),
        failed: flag("Retry lanes that genuinely failed rather than reclaiming stranded ones. This also clears their attempt count.", false),
        lane_id: str("Limit to one lane."),
      },
    },
    annotations: destructive,
    run: async (args) => {
      // This is the one tool that does not go through the hub: the script talks
      // to Postgres directly, so it needs the connection string itself.
      if (!process.env.DATABASE_URL) {
        throw new Error(
          "DATABASE_URL is not set in this server's environment. reset_stranded is the one tool that talks to Postgres directly rather than through the hub, so it cannot run without it. Nothing was changed.",
        );
      }
      const dryRun = args.dry_run !== false;
      const result = await spawnScript("reset-stranded.ts", [
        ...(dryRun ? ["--dry-run"] : []),
        ...(args.failed ? ["--failed"] : []),
        ...(args.lane_id ? ["--lane", args.lane_id] : []),
      ]);
      if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || `reset-stranded.ts exited ${result.exitCode}.`);
      return summary(dryRun ? "Dry run: nothing was changed." : "Lane state was rewritten.", result.stdout);
    },
  },
  {
    name: "lane_teardown",
    description:
      "DESTRUCTIVE. Drops the lane's database, removes its worktree and deletes its branch. Say those three things to the human and wait for a yes before calling it. It refuses on a dirty worktree or unintegrated commits, and that refusal is final.",
    inputSchema: {
      type: "object",
      properties: { lane_id: str("The lane to tear down.") },
      required: ["lane_id"],
    },
    annotations: destructive,
    run: async (args) => {
      const result = await spawnScript("teardown.ts", [args.lane_id]);
      if (result.exitCode !== 0) {
        throw new Error(
          `${result.stderr || result.stdout || `teardown.ts exited ${result.exitCode}.`}\n\nTeardown refused and nothing was destroyed. This refusal is a safety property, not a transient error: treat it as final, report it to the human, and do not retry.`,
        );
      }
      return summary(
        `Lane '${args.lane_id}' was torn down: its database, worktree and branch are gone. The lane row remains in Laneward - a terminal row is inert, and it is what keeps the lane's history readable.`,
        result.stdout,
      );
    },
  },
];

const byName = new Map(tools.map((tool) => [tool.name, tool]));

function publicTool({ run: _run, ...rest }: Tool) {
  return rest;
}

const reply = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id, result });
const failure = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

function missingField(tool: Tool, args: Record<string, unknown>): string | undefined {
  for (const field of tool.inputSchema.required ?? []) {
    const value = args[field];
    if (value === undefined || value === null) return field;
    if (typeof value === "string" && value.trim() === "") return field;
    if (Array.isArray(value) && value.length === 0) return field;
  }
  return undefined;
}

async function callTool(id: unknown, params: any) {
  const tool = byName.get(params?.name);
  if (!tool) return failure(id, -32602, `Unknown tool: ${String(params?.name)}`);
  const args = params?.arguments ?? {};
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return failure(id, -32602, "arguments must be an object");
  }
  const missing = missingField(tool, args);
  if (missing) return failure(id, -32602, `Missing required field: ${missing}`);

  // A thrown handler is the tool reporting a failure to the agent, not the
  // server dying: the loop must survive anything a hub or a script does.
  try {
    return reply(id, { content: [{ type: "text", text: await tool.run(args) }] });
  } catch (error) {
    return reply(id, {
      content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      isError: true,
    });
  }
}

export function splitLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split("\n");
  const rest = parts.pop() ?? "";
  return { lines: parts.map((line) => line.trim()).filter(Boolean), rest };
}

export async function handle(line: string): Promise<object | undefined> {
  let message: any;
  try {
    message = JSON.parse(line);
  } catch {
    return failure(null, -32700, "Parse error: that line was not valid JSON.");
  }

  const { id, method, params } = message ?? {};
  // A notification carries no id, and answering one is a protocol violation
  // even when the method is unknown.
  if (id === undefined || id === null) return undefined;

  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {}, prompts: {} },
        serverInfo: { name: "laneward", version: "0.1.0" },
        instructions: WORKFLOW_BRIEF,
      });
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, { tools: tools.map(publicTool) });
    case "tools/call":
      return await callTool(id, params);
    case "prompts/list":
      return reply(id, {
        prompts: [
          {
            name: "laneward_workflow",
            title: "How to drive Laneward",
            description: "The rules for registering lanes, watching them, and carrying their questions back to a human.",
            arguments: [],
          },
        ],
      });
    case "prompts/get":
      if (params?.name !== undefined && params.name !== "laneward_workflow") {
        return failure(id, -32602, `Unknown prompt: ${String(params.name)}`);
      }
      return reply(id, {
        description: "The rules for registering lanes, watching them, and carrying their questions back to a human.",
        messages: [{ role: "user", content: { type: "text", text: WORKFLOW_BRIEF } }],
      });
    default:
      return failure(id, -32601, `Unknown method: ${String(method)}`);
  }
}
