// Pico is classless: it styles semantic HTML directly, so the markup below stays
// semantic on purpose. Only the two things Pico does not cover are styled here.
const STYLE = `
:root {
  --status-pending: #6c757d;
  --status-running: #0a7d3c;
  --status-waiting_approval: #b7791f;
  --status-completed: #4a5568;
  --status-failed: #c53030;
}
.pill {
  border-radius: 1em;
  padding: 0.1em 0.7em;
  font-size: 0.8em;
  color: #fff;
  background: var(--status-pending);
}
.pill.running { background: var(--status-running); }
.pill.waiting_approval { background: var(--status-waiting_approval); }
.pill.completed { background: var(--status-completed); }
.pill.failed { background: var(--status-failed); }
.log {
  font-family: ui-monospace, monospace;
  font-size: 0.8em;
  white-space: pre-wrap;
  overflow-y: auto;
  max-height: 24em;
  margin: 0;
}
#connection.down { color: var(--status-failed); font-weight: bold; }
.plan-needs-approval { border-left: 0.35rem solid var(--status-waiting_approval); }
.empty { color: var(--pico-muted-color); }
`;

/**
 * Where a finding points, as a person reads it: `path:start-end (side)`, and
 * `path:start (side)` when the range is one line, because `12-12` is noise.
 *
 * It lives out here, and is serialised into the page below, so a test can
 * assert what a reader actually sees. The page is a script string with no DOM
 * in the test process, so an assertion on the served source would only restate
 * the implementation, which is the defect the reader layer raised against this
 * very change on 2026-08-15.
 */
export function formatLocations(
  locations: { path: string; side: string; start_line: number; end_line: number }[],
): string {
  return locations.map((location) =>
    location.path + ":" + location.start_line +
      (location.start_line === location.end_line ? "" : "-" + location.end_line) +
      " (" + location.side + ")",
  ).join(", ");
}

// A page that has silently stopped updating looks exactly like a quiet system,
// so the connection state is always on screen.
const SCRIPT = `
const formatLocations = ${formatLocations};
const panes = new Map();
const logs = new Map();
let lanes = [];
let plans = [];
const fmtAge = (iso) => {
  if (!iso) return "no activity yet";
  const secs = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return secs + "s ago";
  if (secs < 3600) return Math.round(secs / 60) + "m ago";
  return Math.round(secs / 3600) + "h ago";
};

function element(tag, value) {
  const node = document.createElement(tag);
  if (value !== undefined) node.textContent = value;
  return node;
}

function laneCard(lane) {
  const card = element("article");
  const head = element("header");
  const name = element("strong", lane.lane_id);
  const pill = element("span", lane.status);
  pill.className = "pill";
  pill.classList.add(lane.status);
  const summary = element(
    "small",
    lane.lane_type + " · attempt " + lane.attempt_count +
      " · " + fmtAge(lane.last_message_at) +
      " · " + lane.owned_paths.join(", "),
  );
  head.append(name, document.createTextNode(" "), pill, document.createTextNode(" "), summary);
  card.append(head);

  if (lane.status === "waiting_approval" && lane.pending_question) {
    const question = element("blockquote", lane.pending_question);
    const id = element("small", "approval_id: " + lane.approval_id);
    card.append(question, id);
  }

  const evidence = element("section");
  evidence.append(element("h4", "Evidence (" + lane.evidence.length + ")"));
  if (lane.evidence.length) {
    const list = element("ol");
    for (const item of lane.evidence) {
      const entry = element("li");
      const when = element("time", item.created_at);
      when.dateTime = item.created_at;
      const refs = element("code", JSON.stringify(item.evidence_refs) ?? "null");
      entry.append(when, document.createTextNode(" · "), refs);
      list.append(entry);
    }
    evidence.append(list);
  } else {
    evidence.append(element("p", "No evidence recorded."));
  }
  card.append(evidence);

  const approvals = element("section");
  approvals.append(element("h4", "Approvals (" + lane.approvals.length + ")"));
  if (lane.approvals.length) {
    const list = element("ol");
    for (const approval of lane.approvals) {
      list.append(element(
        "li",
        "requested " + approval.requested_at +
          "; " + (approval.resolved_at ? "resolved " + approval.resolved_at : "unresolved") +
          "; decision: " + (approval.decision ?? "—") +
          "; resolved by: " + (approval.resolved_by ?? "—") +
          "; verified by: " + (approval.verified_by ?? "—"),
      ));
    }
    approvals.append(list);
  } else {
    approvals.append(element("p", "No approvals recorded."));
  }
  card.append(approvals);

  const pane = element("pre");
  pane.className = "log";
  pane.textContent = logs.get(lane.lane_id) ?? "";
  card.append(pane);
  panes.set(lane.lane_id, pane);

  const link = element("a", "whole log (" + lane.log_bytes + " bytes)");
  link.href = "/lanes/" + encodeURIComponent(lane.lane_id) + "/log";
  card.append(link);
  return card;
}

function laneGroup(title, group) {
  const section = element("section");
  section.append(element("h3", title));
  if (group.length) {
    for (const lane of group) section.append(laneCard(lane));
  } else {
    section.append(element("p", "No lanes."));
  }
  return section;
}

function render() {
  const root = document.getElementById("dashboard");
  root.replaceChildren();
  panes.clear();
  if (!plans.length && !lanes.length) {
    const empty = element("p", "No plans or lanes yet.");
    empty.className = "empty";
    root.append(empty);
    return;
  }

  const knownRevisions = new Set();
  const lanesByRevision = new Map();
  const unbound = [];
  for (const lane of lanes) {
    if (!lane.plan_revision_id) {
      unbound.push(lane);
      continue;
    }
    const group = lanesByRevision.get(lane.plan_revision_id) ?? [];
    group.push(lane);
    lanesByRevision.set(lane.plan_revision_id, group);
  }

  for (const plan of plans) {
    const card = element("article");
    const head = element("header");
    head.append(element("h2", plan.title));
    card.append(head);
    const revisions = element("ul");
    for (const revision of plan.revisions) {
      knownRevisions.add(revision.id);
      const item = element(
        "li",
        "Revision " + revision.revision +
          (revision.is_newest ? " (newest)" : "") +
          ": " + (revision.approved ? "approved by " + (revision.approved_by ?? "unknown") : "unapproved (no approver)"),
      );
      if ((revision.is_newest && !revision.approved) || revision.approval_id) {
        item.className = "plan-needs-approval";
      }
      if (revision.approval_id) {
        item.append(
          element("blockquote", revision.pending_question),
          element("small", "approval_id: " + revision.approval_id),
        );
      }
      const verification = element("ul");
      verification.append(element(
        "li",
        "Construction: " + (revision.construction
          ? revision.construction.status + " (attempt " + revision.construction.attempt + ")"
          : "not recorded"),
      ));
      const cleanRun = element(
        "li",
        "Clean run: " + (revision.clean_run
          ? revision.clean_run.status + " (attempt " + revision.clean_run.attempt + ")"
          : "not recorded"),
      );
      if (revision.clean_run?.unmet_expectations.length) {
        const unmet = element("ul");
        for (const name of revision.clean_run.unmet_expectations) {
          unmet.append(element("li", "Unmet: " + name));
        }
        cleanRun.append(unmet);
      }
      verification.append(cleanRun);
      verification.append(element(
        "li",
        "Reader: " + (revision.reader
          ? revision.reader.status + " (attempt " + revision.reader.attempt + ")"
          : "not recorded"),
      ));
      if (revision.findings.length) {
        const findings = element("ul");
        for (const finding of revision.findings) {
          const locations = formatLocations(finding.locations);
          findings.append(element(
            "li",
            finding.finding + " (" + finding.subject + ")" + (locations ? ": " + locations : ""),
          ));
        }
        verification.append(findings);
      }
      item.append(verification);
      revisions.append(item);
    }
    card.append(revisions);
    if (!plan.revisions.length) card.append(element("p", "No revisions."));
    for (const revision of plan.revisions) {
      card.append(laneGroup("Revision " + revision.revision + " lanes", lanesByRevision.get(revision.id) ?? []));
    }
    root.append(card);
  }

  for (const [revisionId, group] of lanesByRevision) {
    if (!knownRevisions.has(revisionId)) root.append(laneGroup("Unknown plan revision " + revisionId, group));
  }
  root.append(laneGroup("Unbound lanes", unbound));
}

function appendLog(payload) {
  const pane = panes.get(payload.lane_id);
  const current = payload.reset ? "" : (logs.get(payload.lane_id) ?? "");
  const next = current + payload.chunk;
  logs.set(payload.lane_id, next);
  if (!pane) return;
  const stuck = pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 4;
  pane.textContent = next;
  if (stuck) pane.scrollTop = pane.scrollHeight;
}

const events = new EventSource("/events");
const indicator = document.getElementById("connection");
events.addEventListener("lanes", (e) => {
  lanes = JSON.parse(e.data);
  render();
});
events.addEventListener("plans", (e) => {
  plans = JSON.parse(e.data);
  render();
});
events.addEventListener("log", (e) => appendLog(JSON.parse(e.data)));
events.addEventListener("open", () => {
  indicator.textContent = "live";
  indicator.classList.remove("down");
});
events.addEventListener("error", () => {
  indicator.textContent = "disconnected, retrying";
  indicator.classList.add("down");
});
`;

export function renderPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>laneward</title>
<link rel="stylesheet" href="/pico.css">
<style>${STYLE}</style>
</head>
<body>
<main>
<hgroup>
  <h1>laneward</h1>
  <p><span id="connection">connecting</span></p>
</hgroup>
<div id="dashboard"></div>
</main>
<script>${SCRIPT}</script>
</body>
</html>`;
}
