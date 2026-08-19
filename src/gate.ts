import { sql } from "./db";
import type { GateResult } from "./types";

// ponytail: directory-prefix glob only (`dir/*`); no full glob library,
// this is the only pattern shape the spec's owned_paths examples use.
export function pathsOverlap(a: string[], b: string[]): boolean {
  const normalize = (p: string) => (p.endsWith("/*") ? p.slice(0, -1) : p);
  for (const rawA of a) {
    for (const rawB of b) {
      const na = normalize(rawA);
      const nb = normalize(rawB);
      if (na === nb || na.startsWith(nb) || nb.startsWith(na)) {
        return true;
      }
    }
  }
  return false;
}

export async function checkGate(laneId: string): Promise<GateResult> {
  const [lane] = await sql`SELECT * FROM lanes WHERE lane_id = ${laneId}`;
  if (!lane) {
    return { allowed: false, reason: "lane not found" };
  }

  if (lane.plan_revision_id) {
    const [revision] = await sql`
      SELECT plan_id, revision, approved_at FROM plan_revisions WHERE id = ${lane.plan_revision_id}
    `;
    if (!revision?.approved_at) {
      return { allowed: false, reason: "lane's plan revision is not approved" };
    }
    const [{ revision: newestRevision }] = await sql`
      SELECT MAX(revision)::int AS revision FROM plan_revisions WHERE plan_id = ${revision.plan_id}
    `;
    if (revision.revision !== newestRevision) {
      return {
        allowed: false,
        reason: `lane's plan revision ${revision.revision} is superseded by revision ${newestRevision}`,
      };
    }
  }

  const [pendingApproval] = await sql`
    SELECT 1 FROM approvals
    WHERE lane_id = ${laneId} AND resolved_at IS NULL
    LIMIT 1
  `;
  if (pendingApproval) {
    return { allowed: false, reason: "lane has a pending approval request" };
  }

  const dependsOn: string[] = lane.depends_on ?? [];
  if (dependsOn.length > 0) {
    // A dependency that does not exist is not a satisfied one: an unmatched
    // IN-list would let a typo'd lane_id open the gate silently, which defeats
    // the whole check. LEFT JOIN so a missing row is reported, not skipped.
    const unsatisfied = await sql`
      SELECT d.lane_id, l.status
      -- bun:sql needs the explicit element type; sql.array(x) alone
      -- JSON-quotes each string and the comparison silently never matches.
      FROM unnest(${sql.array(dependsOn, "text")}) AS d(lane_id)
      LEFT JOIN lanes l ON l.lane_id = d.lane_id
      WHERE l.lane_id IS NULL OR l.status != 'completed'
    `;
    if (unsatisfied.length > 0) {
      const missing = unsatisfied.filter((r: any) => r.status === null);
      if (missing.length > 0) {
        return {
          allowed: false,
          reason: `dependency not found: ${missing.map((r: any) => r.lane_id).join(", ")}`,
        };
      }
      const names = unsatisfied.map((r: any) => r.lane_id).join(", ");
      return { allowed: false, reason: `dependency not completed: ${names}` };
    }
  }

  const maxActive = Number(process.env.MAX_ACTIVE_LANES ?? 3);
  const [{ count }] = await sql`
    SELECT COUNT(*)::int AS count FROM lanes WHERE status = 'running'
  `;
  if (count >= maxActive) {
    return { allowed: false, reason: `active lane limit reached (${maxActive})` };
  }

  const running = await sql`
    SELECT owned_paths FROM lanes
    WHERE status = 'running' AND lane_id != ${laneId}
  `;
  for (const row of running) {
    if (pathsOverlap(lane.owned_paths, row.owned_paths)) {
      return { allowed: false, reason: "owned_paths conflict with a running lane" };
    }
  }

  return { allowed: true, reason: "ok" };
}
