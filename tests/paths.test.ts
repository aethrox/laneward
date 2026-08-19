import { expect, test } from "bun:test";
import { join } from "node:path";
import { defaultLogDir } from "../src/paths";

// CP-5: the conductor wrote lane logs under LOCALAPPDATA on Windows while the
// dashboard looked under HOME/.local/state, so a running lane's log was missing
// from the dashboard. Both now call defaultLogDir, and the platform is injected
// so the Windows branch is asserted from Linux too.
const windows = { LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" };
const linux = { HOME: "/home/x" };

test("Windows resolves under LOCALAPPDATA", () => {
  expect(defaultLogDir(windows, "win32")).toBe(
    join("C:\\Users\\x\\AppData\\Local", "laneward", "logs"),
  );
});

test("Windows falls back to USERPROFILE when LOCALAPPDATA is unset", () => {
  expect(defaultLogDir({ USERPROFILE: "C:\\Users\\x" }, "win32")).toBe(
    join("C:\\Users\\x", "AppData", "Local", "laneward", "logs"),
  );
});

test("Linux resolves under HOME/.local/state", () => {
  expect(defaultLogDir(linux, "linux")).toBe(
    join("/home/x", ".local", "state", "laneward", "logs"),
  );
});

test("XDG_STATE_HOME wins on both platforms", () => {
  const env = { ...windows, ...linux, XDG_STATE_HOME: "/state" };
  const expected = join("/state", "laneward", "logs");
  expect(defaultLogDir(env, "win32")).toBe(expected);
  expect(defaultLogDir(env, "linux")).toBe(expected);
});

test("LANEWARD_LOG_DIR overrides everything", () => {
  const env = { ...windows, XDG_STATE_HOME: "/state", LANEWARD_LOG_DIR: "/logs" };
  expect(defaultLogDir(env, "win32")).toBe("/logs");
  expect(defaultLogDir(env, "linux")).toBe("/logs");
});
