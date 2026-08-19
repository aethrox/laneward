import { test, expect } from "bun:test";
import { sql } from "../src/db";

test("workflow tables include verification records", async () => {
  const tables = await sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('lanes', 'messages', 'approvals', 'verification_runs', 'verification_findings')
  `;
  expect(tables.map((t: any) => t.table_name).sort()).toEqual([
    "approvals",
    "lanes",
    "messages",
    "verification_findings",
    "verification_runs",
  ]);
});
