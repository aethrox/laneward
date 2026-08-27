import { handle, splitLines } from "./src/mcp";

// stdout is the protocol channel. Anything written to it that is not a
// JSON-RPC message desynchronises the client's parser, so every diagnostic
// this process ever produces goes to stderr.
function send(message: object) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function dispatch(lines: string[]) {
  for (const line of lines) {
    try {
      const response = await handle(line);
      if (response) send(response);
    } catch (error) {
      // handle() is written not to throw; if it ever does, the loop outlives it.
      console.error(error instanceof Error ? error.stack ?? error.message : error);
    }
  }
}

let buffer = "";

for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk);
  const { lines, rest } = splitLines(buffer);
  buffer = rest;
  await dispatch(lines);
}

// A last message with no trailing newline still deserves an answer.
await dispatch(splitLines(`${buffer}\n`).lines);
