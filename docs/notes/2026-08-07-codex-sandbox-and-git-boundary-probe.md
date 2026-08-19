# Codex sandbox repair and Git-boundary probe

Status: measured evidence
Date: 2026-08-07
Host: Windows 11 Pro 26200, Codex CLI 0.146.0, Git 2.54.0.windows.1

This is the Phase 2 measurement that had been blocked since 2026-08-05. It ran
only after a Codex sandbox failure on this host was diagnosed and repaired.

## Part 1 — The Windows sandbox was broken, and why

The first attempt produced a null result. Every command under
`codex exec -s workspace-write` failed before the process started:

```text
windows sandbox: CreateProcessWithLogonW failed: 2
```

This was not specific to a linked worktree. A trivial `git --version` in an
unrelated empty directory failed identically, and `apply_patch` file writes
failed too. Codex could neither run a command nor write a file on this host.

Two hypotheses were tested and rejected:

- Not a path-permission problem. The same failure occurred in
  `C:\Users\Public\codex-sbtest`, outside the interactive user's profile.
- Not the documented `elevated_windows_sandbox` feature-flag workaround.
  `--disable elevated_windows_sandbox --enable experimental_windows_sandbox`
  failed identically.

`codex doctor` reported the sandbox as healthy, so it does not detect this
failure.

The cause is the `[windows] sandbox` mode. It accepts only `elevated` or
`unelevated`. This host was set to `elevated`, which switches to a separate
local account per command through `CreateProcessWithLogonW`. The accounts
(`CodexSandboxOnline`, `CodexSandboxOffline`) exist as local users, but neither
has a Windows profile: there is no `C:\Users\CodexSandbox*` directory and no
`Win32_UserProfile` entry for them. Error 2 is "file not found", raised when the
profile cannot be loaded.

This is a known failure class upstream, reported with several error codes
against the same mechanism: openai/codex issues
[16780](https://github.com/openai/codex/issues/16780) (1385),
[34575](https://github.com/openai/codex/issues/34575) (1312),
[9062](https://github.com/openai/codex/issues/9062) (5),
[18620](https://github.com/openai/codex/issues/18620) (1326 / 1909).

Fix applied to `~/.codex/config.toml`: `sandbox = "unelevated"`. That mode uses
a restricted token rather than a second account. `-s workspace-write` then works
without any per-call override.

The relevance to Laneward is not incidental. Between the two states, Codex on
this host went from being unable to do anything to, briefly, running with
`danger-full-access` and no sandbox at all. Neither is the posture the
architecture assumes, and `unelevated` is what restores it.

## Part 2 — The Git boundary probe

Run in a real linked worktree of this repository, with
`-s workspace-write` and `sandbox_workspace_write.network_access=false`.

### Result

The `workspace-write` sandbox already denies every Git mutation from a linked
worktree.

| Attempt | Result |
|---|---|
| Write inside the worktree | Succeeded |
| Write into the parent repository | Blocked, `UnauthorizedAccessException` |
| Read the parent repository `.git/config` | Succeeded |
| Network request | Blocked |
| `git add`, `git commit` | Blocked |
| `git branch`, `git tag`, `git update-ref` | Blocked |
| `git worktree add` | Blocked |
| `git config user.name` | Blocked |
| `git log`, `git status`, `git diff` | Succeeded |
| `git config --get remote.origin.url` | Succeeded |
| `git config --get credential.helper` | Succeeded |
| `GH_TOKEN` / `GITHUB_TOKEN` present | Both UNSET |

### The mechanism

This is what was predicted on 2026-08-05, now observed. A lane worktree's
`.git` is a file; the real object store lives in the parent repository, outside
the writable workspace. Git writes a lock file there for every mutation, and the
sandbox denies that write:

```text
fatal: Unable to create 'C:/Users/<user>/Documents/Github/laneward/.git/worktrees/probe-git-boundary/index.lock': Permission denied
fatal: cannot lock ref 'refs/heads/probe-extra-branch': Unable to create '.../refs/heads/probe-extra-branch.lock': Permission denied
fatal: cannot lock ref 'refs/tags/probe-tag': Unable to create '.../refs/tags/probe-tag.lock': Permission denied
error: could not lock config file C:/Users/<user>/Documents/Github/laneward/.git/config: Permission denied
```

Note what this is and is not. It is a sandbox write denial surfacing through
Git, not a Git policy refusal. Git is willing; it simply cannot write the lock.
A boundary that depends on this is depending on filesystem confinement, not on
Git behaving itself.

### Independent verification

The agent's report was not taken at face value. Checked directly in the parent
repository afterwards:

- `git log --oneline -1` unchanged at `85c0ac8`;
- `probe-extra-branch`, `probe-tag`, and `refs/heads/probe-ref` do not exist;
- `sandbox-outside.txt` was never created;
- the worktree contained only the two expected untracked files.

The probe worktree and its branch were removed afterwards.

## Part 3 — What this changes

Confirms D-023's control is worth building, and narrows what it must cover.
Filesystem confinement already blocks the mutations, so the restricted `git`
wrapper is defense in depth rather than the only thing standing between a worker
and a commit. It is still required, because the confinement is a property of the
sandbox, and this note is itself the record of that sandbox being entirely
absent for part of a day.

Leaves one real gap. Credential configuration is readable: the remote URL and
the configured credential helper both returned successfully. No token was
present in the environment and the network was blocked, so nothing could be
pushed. That is two independent controls holding, not the credential boundary
holding. D-023's requirement to keep credentials out of the worker environment
stands unmet.

Does not settle Linux. The mechanism is a property of linked worktrees rather
than of Windows, so the same denial is expected under Landlock, but expected is
not measured. Per D-022 the evidence has to be produced on both platforms before
Phase 2 is complete.

## Reproducing

```powershell
git worktree add -b probe/git-boundary ../laneward-worktrees/probe-git-boundary
codex exec -C ../laneward-worktrees/probe-git-boundary `
  -s workspace-write `
  -c sandbox_workspace_write.network_access=false `
  -c model_reasoning_effort=high `
  - < probe-prompt.txt
```

Verify in the parent repository, not from the agent's report: check `git log`,
`git branch --list`, `git tag --list`, and `git show-ref` for artifacts the
probe attempted to create.
