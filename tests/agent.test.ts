import { expect, test } from "bun:test";
import { AGENT_ENV_VAR, agentCommand, agentTemplate } from "../src/agent";

// The environment is injected, so these assert the adapter rather than whatever
// the operator exported before running the suite.
const subs = { worktree: "/work tree", model: "some-model" };
const stock: Record<string, string | undefined> = {};

test("a stock install still invokes Codex, both modes", () => {
  expect(agentCommand("write", subs, stock)).toEqual([
    "codex", "exec", "-C", "/work tree", "-s", "workspace-write", "-m", "some-model",
  ]);
  expect(agentCommand("read_only", subs, stock)).toEqual([
    "codex", "exec", "-C", "/work tree", "-s", "read-only", "-m", "some-model",
  ]);
});

test("CODEX_BIN still replaces the binary of the built-in template", () => {
  const command = agentCommand("write", subs, { CODEX_BIN: "/opt/codex" })!;
  expect(command[0]).toBe("/opt/codex");
});

test("a declared agent owns its own argv[0], so CODEX_BIN does not rewrite it", () => {
  // Overriding a command the operator wrote deliberately would be the kind of
  // silent rewrite that is impossible to debug from the outside.
  const env = {
    CODEX_BIN: "/opt/codex",
    [AGENT_ENV_VAR.write]: JSON.stringify(["my-agent", "--dir", "{worktree}"]),
  };
  expect(agentCommand("write", subs, env)).toEqual(["my-agent", "--dir", "/work tree"]);
});

test("placeholders are substituted, and a path with spaces stays one argument", () => {
  const env = {
    [AGENT_ENV_VAR.write]: JSON.stringify(["a", "{worktree}", "{model}", "{worktree}"]),
  };
  expect(agentCommand("write", subs, env)).toEqual(["a", "/work tree", "some-model", "/work tree"]);
});

test("a .ts entry point is run through bun", () => {
  const env = { [AGENT_ENV_VAR.write]: JSON.stringify(["./fake-agent.ts", "{worktree}"]) };
  const command = agentCommand("write", subs, env)!;
  expect(command[0]).toBe(process.execPath);
  expect(command[1]).toBe("./fake-agent.ts");
});

// The decision this file exists to enforce.
test("a declared write agent with no read-only command disables the reader", () => {
  const env = { [AGENT_ENV_VAR.write]: JSON.stringify(["my-agent", "{worktree}"]) };
  expect(agentTemplate("read_only", env)).toBeNull();
  expect(agentCommand("read_only", subs, env)).toBeNull();
});

test("declaring both modes runs the reader with the read-only command", () => {
  const env = {
    [AGENT_ENV_VAR.write]: JSON.stringify(["my-agent", "--write", "{worktree}"]),
    [AGENT_ENV_VAR.read_only]: JSON.stringify(["my-agent", "--readonly", "{worktree}"]),
  };
  expect(agentCommand("read_only", subs, env)).toEqual(["my-agent", "--readonly", "/work tree"]);
});

test("a read-only command alone does not disable anything", () => {
  const env = { [AGENT_ENV_VAR.read_only]: JSON.stringify(["my-agent", "--readonly", "{worktree}"]) };
  expect(agentCommand("write", subs, env)![0]).toBe("codex");
  expect(agentCommand("read_only", subs, env)).toEqual(["my-agent", "--readonly", "/work tree"]);
});

test("a malformed template names the variable rather than spawning nonsense", () => {
  for (const bad of ["not json", '"a string"', "[]", '[1,2]']) {
    expect(() => agentCommand("write", subs, { [AGENT_ENV_VAR.write]: bad })).toThrow(
      `${AGENT_ENV_VAR.write} must be a JSON array of arguments`,
    );
  }
});
