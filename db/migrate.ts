import { sql } from "../src/db";

const schema = await Bun.file(new URL("./schema.sql", import.meta.url)).text();

// Postgres requires statements split on `;` when sent via bun:sql's tagged
// template (it does not support multi-statement strings in one call).
const statements = schema
  .split(";")
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

for (const statement of statements) {
  await sql.unsafe(statement);
}

console.log(`Applied ${statements.length} statements.`);
process.exit(0);
