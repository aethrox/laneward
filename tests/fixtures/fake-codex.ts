import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const args = Bun.argv.slice(2);
const worktree = args[args.indexOf("-C") + 1];

await Bun.write(join(worktree, ".prompt"), await Bun.stdin.text());
console.log(`fake codex running in ${worktree}`);
console.error("fake codex stderr line");

if (existsSync(join(worktree, ".output"))) console.log(await readFile(join(worktree, ".output"), "utf8"));
if (existsSync(join(worktree, ".sleep"))) await Bun.sleep(Number(await readFile(join(worktree, ".sleep"), "utf8")) * 1000);
if (existsSync(join(worktree, ".exit-code"))) process.exit(Number(await readFile(join(worktree, ".exit-code"), "utf8")));
