export {};

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is not set by the candidate's .env");
const databaseName = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ""));
if (!/_candidate_.+_r\d+_test$/.test(databaseName)) {
  throw new Error(`refusing to seed non-candidate database: ${databaseName || "unnamed"}`);
}

const { sql } = await import("../src/db");
const suffix = crypto.randomUUID();
const planId = `clean-run-${suffix}`;
await sql`INSERT INTO plans (plan_id, title) VALUES (${planId}, 'Clean run observation')`;

const revisionIds: string[] = [];
for (let revision = 1; revision <= 3; revision++) {
  const [row] = await sql`
    INSERT INTO plan_revisions (plan_id, revision, content)
    VALUES (${planId}, ${revision}, ${{ objective: "exercise notification delivery" }})
    RETURNING id
  `;
  revisionIds.push(row.id);
}

for (const [index, status] of ["waiting_approval", "failed", "completed"].entries()) {
  await sql`
    INSERT INTO lanes
      (lane_id, owned_paths, lane_type, status, worktree_path, original_brief, plan_revision_id)
    VALUES
      (${`clean-run-${index + 1}-${suffix}`}, ${sql.array(["src/notify.ts"], "text")},
       'write', ${status}, ${process.cwd()}, 'Clean run seed', ${revisionIds[index]})
  `;
}

console.log(`Seeded clean run fixtures in ${databaseName}.`);
process.exit(0);
