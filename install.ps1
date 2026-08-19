# Windows installer. The Linux counterpart is install.sh, and the two are kept
# deliberately parallel: same directory resolution, same refusals, same staged
# app directory, same printed to-do list of what it did NOT do.
#
# D-037 settles the database: the same postgres image on a Podman machine, with
# the port published on 127.0.0.1. D-038 settles supervision: a Scheduled Task at
# logon, not a service wrapper, because Windows has no POSIX signal delivery and
# so neither option can stop the conductor cleanly.

[CmdletBinding()]
param(
  # Render everything and report, but register nothing and copy nothing.
  [switch]$DryRun,
  # Remove what this script created. Keeps the config and the database volume
  # unless -Purge is given, because an installer that silently deletes a
  # database is a worse failure than one that leaves a directory behind.
  [switch]$Uninstall,
  [switch]$Purge,
  # Override the install roots. Present so the installer can be exercised end to
  # end against a throwaway location, which is the only way it gets tested
  # before someone runs it for real.
  [string]$ConfigDir = (Join-Path $env:APPDATA 'laneward'),
  [string]$DataDir = (Join-Path $env:LOCALAPPDATA 'laneward'),
  [string]$TaskName = 'laneward-conductor'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Die($message) { Write-Error "install.ps1: $message"; exit 1 }

$PackageDir = $PSScriptRoot
$AppDir = Join-Path $DataDir 'app'
$StateDir = Join-Path $DataDir 'logs'

if ($Uninstall) {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($task) {
    if ($task.State -eq 'Running') { Stop-ScheduledTask -TaskName $TaskName }
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Output "Removed scheduled task $TaskName."
  } else {
    Write-Output "No scheduled task named $TaskName."
  }
  foreach ($dir in @($AppDir, $StateDir)) {
    if (Test-Path $dir) { Remove-Item -Recurse -Force $dir }
  }
  Write-Output "Removed $AppDir and $StateDir."
  if ($Purge) {
    foreach ($dir in @($ConfigDir, $DataDir)) {
      if (Test-Path $dir) { Remove-Item -Recurse -Force $dir }
    }
    Write-Output "Purged $ConfigDir and $DataDir, including the database volume."
  } else {
    Write-Output "Kept $ConfigDir and $(Join-Path $DataDir 'pgdata'), which holds your lane history."
    Write-Output "Add -Purge to remove those too."
  }
  exit 0
}

# --- prerequisites -----------------------------------------------------------

$bun = (Get-Command bun -ErrorAction SilentlyContinue)
if (-not $bun) { Die 'bun not found on PATH' }
$BunPath = $bun.Source

# Warn rather than refuse, for the same reason install.sh does: these are the
# versions Laneward was verified against, not measured floors.
$VerifiedBun = [version]'1.3.14'
$VerifiedCodex = [version]'0.147.0'
function ParseVersion($text) {
  if ($text -match '(\d+\.\d+\.\d+)') { return [version]$Matches[1] }
  return $null
}
$bunVersion = ParseVersion (& $BunPath --version 2>$null)
if ($bunVersion -and $bunVersion -lt $VerifiedBun) {
  Write-Warning "bun $bunVersion is older than $VerifiedBun, the version Laneward was verified against."
}
$codex = Get-Command codex -ErrorAction SilentlyContinue
if ($codex) {
  $codexVersion = ParseVersion (& $codex.Source --version 2>$null)
  if ($codexVersion -and $codexVersion -lt $VerifiedCodex) {
    Write-Warning "codex $codexVersion is older than $VerifiedCodex, the version Laneward was verified against."
  }
} else {
  Write-Warning 'codex not on PATH. Laneward installs, but no lane can be dispatched until it is.'
}

$podman = (Get-Command podman -ErrorAction SilentlyContinue)
if (-not $podman) { Die 'podman not found on PATH; the database runs in a Podman machine (D-037)' }

# D-037's named cost, and the most likely day-one failure. A stopped machine does
# not produce a connection error, it produces a 5000 ms timeout on every database
# call, which reads as a code fault. Say it once, here.
$machines = & podman machine list --format '{{.Name}} {{.Running}}' 2>$null
$running = @($machines | Where-Object { $_ -match '\strue$' })
if ($running.Count -eq 0) {
  Die @"
no Podman machine is running, so the database is unreachable.
  A stopped machine does not fail fast: every query times out after 5000 ms and
  looks like an application bug. Start it first:
      podman machine start
  It does not start itself after a reboot.
"@
}

# --- config ------------------------------------------------------------------

foreach ($dir in @($ConfigDir, $DataDir, (Join-Path $DataDir 'pgdata'))) {
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
}

$EnvFile = Join-Path $ConfigDir '.env'
if (-not (Test-Path $EnvFile)) {
  if ($DryRun) {
    Write-Output "[dry-run] would write $EnvFile from .env.example"
  } else {
    # -Encoding utf8 without a BOM: a BOM makes the first key unreadable, and the
    # file then looks correct while DATABASE_URL reads as unset.
    $example = Get-Content -Raw -Path (Join-Path $PackageDir '.env.example')
    [System.IO.File]::WriteAllText($EnvFile, $example, (New-Object System.Text.UTF8Encoding $false))
    Write-Output "Wrote default config to $EnvFile, edit it before first start."
  }
}

# Validate the config that will actually be loaded. Under -DryRun the .env was
# not written, so the file that would have been written is the one to check,
# otherwise a dry run reports a failure the real run would never have. Same
# checks as install.sh, and the same reason: a numeric field that arrived as text
# is cheapest to catch here and most confusing later.
$ValidatedFile = if (Test-Path $EnvFile) { $EnvFile } else { Join-Path $PackageDir '.env.example' }
$settings = @{}
foreach ($line in Get-Content -Path $ValidatedFile) {
  if ($line -match '^\s*#') { continue }
  if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$') {
    $settings[$Matches[1]] = $Matches[2]
  }
}
if (-not $settings.ContainsKey('DATABASE_URL') -or -not $settings['DATABASE_URL']) {
  Die "DATABASE_URL is empty in $ValidatedFile"
}
foreach ($numeric in @('PORT', 'MAX_ACTIVE_LANES')) {
  if (-not ($settings.ContainsKey($numeric) -and $settings[$numeric] -match '^[0-9]+$')) {
    Die "$numeric must be numeric in $ValidatedFile"
  }
}

# D-037 again, as a warning rather than a refusal: the operator may knowingly
# point at a remote database, but the overwhelmingly likely case is a .env copied
# from a machine where the Podman address differed. That is CP-4's exact symptom.
if ($settings['DATABASE_URL'] -notmatch '(127\.0\.0\.1|localhost)') {
  Write-Warning "DATABASE_URL does not point at 127.0.0.1. Per D-037 the Podman machine publishes the port there; a WSL address works until the machine is recreated."
}

# Is anything actually listening there? A warning rather than a refusal, because
# the database container is started after this script runs.
#
# Worth saying anyway, and this is the check that would have saved a diagnosis:
# a Podman machine can report a port published while nothing on the Windows side
# is listening on it, and the symptom is not a connection error but a 5000 ms
# timeout on every query, which reads as an application bug.
if ($settings['DATABASE_URL'] -match '@(\[[^\]]+\]|[^:/@]+)(?::(\d+))?/') {
  $dbHost = $Matches[1].Trim('[', ']')
  $dbPort = if ($Matches[2]) { [int]$Matches[2] } else { 5432 }
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $reached = $client.BeginConnect($dbHost, $dbPort, $null, $null).AsyncWaitHandle.WaitOne(2000)
  } catch {
    $reached = $false
  } finally {
    $client.Close()
  }
  if (-not $reached) {
    Write-Warning @"
nothing is listening on ${dbHost}:${dbPort}, where DATABASE_URL points.
  Expected if the database container is not started yet. If it is started, check
  that the Podman machine is still forwarding the port: podman ps reports a port
  as published whether or not the forward is alive, and a dead forward times out
  at 5000 ms per query instead of failing.
"@
  }
}

# The Windows notifier addresses PowerShell by its fixed location rather than
# through PATH, so that is what has to exist. Mirrors install.sh's notify-send
# refusal: a notifier that silently does nothing is worse than one switched off.
if ($settings.ContainsKey('LANEWARD_NOTIFY') -and $settings['LANEWARD_NOTIFY']) {
  $shell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  if (-not (Test-Path $shell)) {
    Die "$shell not found, but LANEWARD_NOTIFY=$($settings['LANEWARD_NOTIFY']) requests desktop notifications.`n  Set LANEWARD_NOTIFY= in $EnvFile to turn them off."
  }
}

# --- app directory -----------------------------------------------------------

# Staged and moved into place, so an interrupted install cannot leave a half
# copied app directory behind. Same shape as install.sh.
$Stage = Join-Path $DataDir ".app-install-$PID"
if ($DryRun) {
  Write-Output "[dry-run] would stage the app into $Stage and move it to $AppDir"
} else {
  if (Test-Path $Stage) { Remove-Item -Recurse -Force $Stage }
  New-Item -ItemType Directory -Force -Path $Stage | Out-Null
  try {
    Get-ChildItem -Path $PackageDir -Force |
      # Same list as install.sh, and the same warning: it is a denylist and it
      # drifts from .gitignore. .codegraph is a local index, 3.5 MB of it, and a
      # stale copy in the deployed app helps nothing.
      Where-Object { $_.Name -notin @('.git', '.env', '.codegraph', 'docs', 'tests') -and $_.Extension -ne '.log' } |
      ForEach-Object { Copy-Item -Path $_.FullName -Destination $Stage -Recurse -Force }

    if (-not (Test-Path (Join-Path $Stage 'node_modules'))) {
      Push-Location $Stage
      try { & $BunPath install --frozen-lockfile } finally { Pop-Location }
      if ($LASTEXITCODE -ne 0) { Die 'bun install failed' }
    }

    if (Test-Path $AppDir) { Remove-Item -Recurse -Force $AppDir }
    Move-Item -Path $Stage -Destination $AppDir
  } finally {
    if (Test-Path $Stage) { Remove-Item -Recurse -Force $Stage }
  }
}

# --- the Scheduled Task (D-038) ----------------------------------------------

# No Requires= equivalent exists here, so unlike laneward-conductor.service this
# task cannot depend on the API being up. The loop's own error tolerance is what
# covers that: a failed pass is logged and the loop continues.
#
# Stopping the task terminates the process. There is no clean hand-back, so lanes
# are left `running` and `bun run reset-stranded` is the recovery, exactly as
# after a crash. That is CP-3's cost, conceded by D-038 rather than solved.
# A Scheduled Task has no EnvironmentFile= equivalent, so the config has to
# travel in the command line. `--env-file` before the subcommand still loads
# while `--no-env-file` after it suppresses auto-loading from the working
# directory -- verified, both at once. Without this the task starts on pure
# defaults: PORT reverts to 8787 while the hub listens wherever the operator put
# it, and every pass logs a connection failure forever. That is D-014's defect 3
# with no way for the operator to see it.
$taskArguments = "--env-file=`"$EnvFile`" run --no-env-file conductor.ts --loop"
$taskCommand = "`"$BunPath`" $taskArguments"
$action = New-ScheduledTaskAction -Execute $BunPath `
  -Argument $taskArguments -WorkingDirectory $AppDir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$taskSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero)

if ($DryRun) {
  Write-Output "[dry-run] would register scheduled task '$TaskName'"
  Write-Output "[dry-run]   command:  $taskCommand"
  Write-Output "[dry-run]   workdir:  $AppDir"
  Write-Output "[dry-run]   trigger:  at logon of $env:USERNAME"
} else {
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $taskSettings -Force | Out-Null
}

# --- what this did not do ----------------------------------------------------

@"

Installed:
  task    $TaskName (at logon, runs the conductor loop)
  config  $EnvFile
  data    $(Join-Path $DataDir 'pgdata')
  app     $AppDir

Not done by this script: nothing is running and nothing is verified.
  1. podman machine start                    (it does not survive a reboot)
  2. start the database container, then the hub:
       cd $AppDir; bun --env-file=$EnvFile run start
     (the deployed app has no .env of its own; without this it exits at once)
  3. cd $AppDir; bun --env-file=$EnvFile run db/migrate.ts
     (the deployed app has no .env of its own)
  4. Start-ScheduledTask -TaskName $TaskName
  5. Get-ScheduledTaskInfo -TaskName $TaskName
     An exit code alone proves nothing; watch a lane actually run.

Stopping the task terminates the conductor. Windows has no catchable SIGTERM, so
lanes are left running with no worker behind them:
  cd $AppDir; bun --env-file=$EnvFile run reset-stranded --dry-run
"@
