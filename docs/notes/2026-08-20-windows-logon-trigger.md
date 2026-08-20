# The Windows logon trigger, fired

The last thing `install.ps1` did that nobody had watched. The Scheduled Task it
registers has always been started by hand; whether Windows would start it at
logon was a prediction. It is now an observation, and the run showed more than
it was set up to show.

## What was run

A real install at the default location: `%APPDATA%\laneward\.env`,
`%LOCALAPPDATA%\laneward\app`, `LANEWARD_AGENT=claude`. A `logon-check` lane was
registered and left `pending`, the hub was stopped, and **neither task was
started by hand**. Then the operator logged off and back on.

## The result

```
11:36:45  laneward-conductor-hub   Running   LastTaskResult 0x41301
11:36:45  laneward-conductor       Running   LastTaskResult 0x41301
          three bun processes alive, nothing started by a human
```

`0x41301` is "the task is currently running", not an error code.

The Podman machine does not survive a logout, so the database was down when both
tasks started. Neither of them died of it. The hub answered HTTP 500 rather than
refusing the connection, which is the distinction that matters: it was up and
serving, it simply had nothing to read from. The conductor logged its failed
passes and kept looping, which is exactly what Stage 5a's error tolerance was
written for.

Starting the Podman machine and the database container was the only thing done
afterwards, and nothing else was touched:

```
+10s   logon-check: running
+20s   logon-check: completed
```

The hub reconnected on its own, the conductor picked the lane up on its next
pass, and a real agent drove it to completion. `notes.txt` carried the requested
line, `git status` showed the one file the lane owned, the evidence row was
recorded, and the Git guard log held seven refusals, all of them reads and none
a mutation.

So one cycle answered three questions rather than one: the trigger fires, both
services tolerate a database that is not there yet, and they recover without
help when it arrives.

## The defect it found first

The cycle was set up twice. The first attempt proved nothing, because no task
was registered at the time: the S3 run's task had been removed and the real
install had not yet been done. That is a process mistake rather than a defect.

The defect came out of preparing the second attempt. **`install.ps1` registered
only the conductor at logon, never the hub.** On Linux `install.sh` installs two
units and the conductor's declares `Requires=laneward.service`, so a boot brings
the API up with it. Registering one task here looked equivalent and was not:
after a logon the loop would have run against nothing, logged a connection
failure every interval, and dispatched no lane. What the operator would have
seen is a task reporting `Running` and a dashboard that never loads.

`install.ps1` now registers `laneward-conductor-hub` alongside it. Two tasks
rather than one wrapper, because a Scheduled Task has no ordering guarantee
either; the conductor already tolerates an absent hub by design (D-038), which
is what makes starting them independently safe, and this run is the evidence for
that tolerance rather than the assumption of it.

## What this does not establish

- **A reboot.** A logoff and logon is not a cold boot. The Podman machine does
  not survive either, so a reboot has the same shape, but it has not been run.
- **Linux.** `loginctl enable-linger` is still untested, and it is a persistent
  host change that needs its own approval.
- **The database surviving with it.** Nothing here starts the Podman machine at
  logon. That is left to the operator on purpose: it is a machine-wide service,
  not Laneward's to register.
