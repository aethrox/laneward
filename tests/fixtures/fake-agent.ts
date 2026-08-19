// An agent that is not Codex, deliberately: no `exec` subcommand, no -C, no -s,
// and the working directory arrives as --workdir rather than positionally. If
// Laneward can drive this through configuration alone, the Codex flags are no
// longer part of its contract.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const args = Bun.argv.slice(2);
const workdir = args[args.indexOf("--workdir") + 1];
const model = args[args.indexOf("--model") + 1];

if (args[0] !== "run") {
  console.error(`fake-agent expects the 'run' verb, got ${JSON.stringify(args[0])}`);
  process.exit(64);
}

await Bun.write(join(workdir, ".prompt"), await Bun.stdin.text());
console.log(`fake agent running in ${workdir} with model ${model}`);

if (existsSync(join(workdir, ".exit-code"))) {
  process.exit(Number(await readFile(join(workdir, ".exit-code"), "utf8")));
}
