import { test, expect } from "bun:test";
import { join } from "node:path";
import { isDisposableDatabase, sql } from "../src/db";

test("connects to Postgres and can run a trivial query", async () => {
  const [row] = await sql`SELECT 1 AS one`;
  expect(row.one).toBe(1);
});

test("a disposable database is one the suite is allowed to truncate", () => {
  expect(isDisposableDatabase("postgres://u:p@host:5433/laneward_test")).toBe(true);
  expect(isDisposableDatabase("postgres://u:p@host:5433/neura_test")).toBe(true);
  expect(isDisposableDatabase("postgres://u:p@host:5433/laneward_lane_phase7_dashboard")).toBe(true);
});

test("the live hub database is not disposable", () => {
  expect(isDisposableDatabase("postgres://u:p@host:5433/laneward")).toBe(false);
  expect(isDisposableDatabase("postgres://u:p@host:5433/")).toBe(false);
  expect(isDisposableDatabase("not a url")).toBe(false);
  // A name that merely contains "test" is not one, or `latest` would qualify.
  expect(isDisposableDatabase("postgres://u:p@host:5433/laneward_testing")).toBe(false);
});

// The guard has to fire on import, before any test body runs, so the only
// honest check is a separate process that imports the module.
test("importing the module under NODE_ENV=test refuses a non-disposable database", async () => {
  const proc = Bun.spawn([process.execPath, "-e", "import('./src/db')"], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      NODE_ENV: "test",
      DATABASE_URL: "postgres://u:p@127.0.0.1:5433/laneward",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  expect(await proc.exited).not.toBe(0);
  expect(stderr).toContain("refusing to run tests against laneward");
});

test("the same import outside a test run is allowed through", async () => {
  const proc = Bun.spawn(
    [process.execPath, "-e", "import('./src/db').then(() => console.log('imported'))"],
    {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        NODE_ENV: "production",
        DATABASE_URL: "postgres://u:p@127.0.0.1:5433/laneward",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(await new Response(proc.stdout).text()).toContain("imported");
  expect(await proc.exited).toBe(0);
});

test("the clean run seed refuses the hub database before importing the database client", async () => {
  const proc = Bun.spawn([process.execPath, "scripts/seed-clean-run.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: {
      ...process.env,
      NODE_ENV: "production",
      DATABASE_URL: "postgres://u:p@127.0.0.1:5433/laneward",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  expect(await proc.exited).not.toBe(0);
  expect(stderr).toContain("refusing to seed non-candidate database: laneward");
});
