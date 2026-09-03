# Configuration

Everything is read from the `.env` the hub and the conductor load. There is no
config file and no flags beyond `--loop`.

## Every variable

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | none, required | Where the hub keeps its state. |
| `PORT` | `8787` | Hub listen port. The conductor derives its hub address from it. |
| `HUB_URL` | derived from `PORT` | Override when the conductor talks to a hub elsewhere. |
| `MAX_ACTIVE_LANES` | `3` | Concurrency ceiling. A lane over the ceiling stays `pending`. |
| `LANEWARD_AGENT` | none | Selects a preset: `codex` or `claude`. |
| `LANEWARD_AGENT_WRITE` | the preset's template | JSON argument array for the working agent. |
| `LANEWARD_AGENT_READ` | the preset's template | JSON argument array for the read-only reader. |
| `LANEWARD_AGENT_BIN` | the preset's `bin` | Overrides a preset's argv[0]. Ignored by a raw template, which owns its own. |
| `LANEWARD_MODEL_FAST` | the preset's table | Remaps the `fast` tier to any model string. |
| `LANEWARD_MODEL_BALANCED` | the preset's table | Remaps the `balanced` tier. |
| `LANEWARD_MODEL_DEEP` | the preset's table | Remaps the `deep` tier. |
| `LANEWARD_READER_MODEL` | `balanced` | Tier the advisory reader runs at. |
| `LANEWARD_READER_TIMEOUT_MS` | `600000` | Ceiling for one reader run. |
| `LANEWARD_CHECK_TIMEOUT_MS` | `600000` | Ceiling for one declared lane check. |
| `LANEWARD_DRAIN_INTERVAL_MS` | `5000` | Pause between drain passes under `--loop`. |
| `LANEWARD_NOTIFY` | `approval_required,lane_failed` | Comma-separated notification classes. Empty disables desktop alerts. |
| `LANEWARD_LOG_DIR` | platform state directory | Where lane logs are written. |
| `LANEWARD_CLEAN_RUN_SHELL` | resolved per platform | Absolute path to the interpreter the clean-run layer uses. |

The log directory, when you do not set one, is `$XDG_STATE_HOME/laneward/logs`,
falling back to `$HOME/.local/state/laneward/logs` on Linux and
`%LOCALAPPDATA%\laneward\logs` on Windows. The dashboard reads the same
directory, so pointing one process at a different one hides the logs from the
other.

!!! warning "A typo in `LANEWARD_NOTIFY` stops the hub from starting"

    An unrecognised class name throws `invalid LANEWARD_NOTIFY class: <name>`
    at startup rather than being ignored. The four valid names are
    `approval_required`, `lane_failed`, `plan_ready_for_review` and
    `findings_to_adjudicate`. An empty value is valid and means "no desktop
    alerts".

## Declaring an agent {#declaring-an-agent}

There is no default agent. With neither `LANEWARD_AGENT` nor
`LANEWARD_AGENT_WRITE` set, the first lane fails with:

```
no agent declared: set LANEWARD_AGENT to one of (codex, claude), or set
LANEWARD_AGENT_WRITE to a JSON argument array
```

An unknown preset name is refused just as loudly:
`LANEWARD_AGENT must be one of: codex, claude (got "gemini")`.

### The two presets

Only these two ship, because only these two were run against this project.
The `codex` path was last driven by a real run on 2026-08-19; the Codex
subscription behind it lapsed shortly after, and the path is now covered by
tests rather than by a run.

=== "codex"

    ```bash
    LANEWARD_AGENT=codex
    ```

    | Mode | Command |
    |---|---|
    | write | `codex exec -C {worktree} -s workspace-write -m {model}` |
    | read-only | `codex exec -C {worktree} -s read-only -m {model}` |

    Model tiers: `fast` is `gpt-5.6-luna`, `balanced` is `gpt-5.6-terra`,
    `deep` is `gpt-5.6-sol`.

=== "claude"

    ```bash
    LANEWARD_AGENT=claude
    ```

    | Mode | Command |
    |---|---|
    | write | `claude -p --permission-mode acceptEdits --disallowedTools "Bash(git *)" --model {model}` |
    | read-only | `claude -p --permission-mode plan --disallowedTools Edit Write NotebookEdit Bash --model {model}` |

    Model tiers: `fast` is `haiku`, `balanced` is `sonnet`, `deep` is `opus`.

    The write template denies `Bash(git *)` at the agent rather than leaving it
    to the shim. The agent reaches for git unprompted, and every shim refusal
    that is not identifiably a read would fail an otherwise correct lane.

Adding a third preset means adding it **and** driving a real lane with it, not
just writing the flags down.

### A raw command instead

For anything else, declare the argument arrays yourself. `{bin}`, `{worktree}`
and `{model}` are substituted; the array is passed to the operating system
as-is, because paths on Windows contain spaces.

```bash
LANEWARD_AGENT_WRITE='["my-agent","run","--dir","{worktree}","--model","{model}"]'
LANEWARD_AGENT_READ='["my-agent","run","--readonly","--dir","{worktree}","--model","{model}"]'
```

A malformed value throws `LANEWARD_AGENT_WRITE must be a JSON array of
arguments` rather than being half-parsed.

!!! danger "A raw write template without a read template disables the reader"

    Declaring `LANEWARD_AGENT_WRITE` and leaving `LANEWARD_AGENT_READ` unset
    records every reader run as `skipped`, with the reason attached. That is
    deliberate: the reader's read-only confinement is the agent's to provide,
    and Laneward will not run it unconfined over the candidate it is reviewing.

### What an agent has to promise

1. Read its instruction from **stdin**, not from a positional argument. An agent
   that takes a positional prompt waits on stdin forever when backgrounded.
2. Work in the **directory it is given**, and edit only what the brief allows.
3. Exit **0** on completion, **10** to request approval, non-zero otherwise.
4. Perform **no git mutation**. This one is enforced by the shim rather than
   trusted, so an unknown agent inherits the same boundary.

### Wrapping an agent

If `argv[0]` ends in `.ts`, it is run with Bun. That is the seam behind
`scripts/codex-round.ts`, which forwards every argument to the real binary and
adds per-round settings:

```bash
LANEWARD_AGENT=codex LANEWARD_AGENT_BIN=scripts/codex-round.ts bun run conductor
```

`LANEWARD_AGENT_BIN` is only substituted through the `{bin}` placeholder, so it
affects a preset and is ignored by a raw template that names its own binary.

## Model tiers

A tier (`fast`, `balanced`, `deep`) is a slot you fill, not a model name. The
names are a cost and capability ladder; what each one resolves to is yours to
set:

```bash
LANEWARD_MODEL_DEEP=my-favourite-large-model
```

A lane picks its tier at registration with `LANE_MODEL` (default `balanced`);
see [Your first lane](first-lane.md). Asking for a tier with no preset active
and no override set throws rather than guessing:

```
no default model for tier "deep": no agent preset is active, set LANEWARD_MODEL_DEEP
```
