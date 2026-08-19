#!/usr/bin/env bash
set -euo pipefail

die() { echo "install.sh: $*" >&2; exit 1; }

PACKAGE_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$PACKAGE_DIR"

CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/laneward"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
# Quadlet reads .container files from here, not from systemd/user.
QUADLET_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/containers/systemd"
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/laneward"

STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/laneward"

BUN="$HOME/.bun/bin/bun"
BUN_DIR="$(dirname -- "$BUN")"

# Removing what this script created. Someone who tries Laneward and decides
# against it should not have to reverse an installer by hand, and the same path
# is what makes the install testable repeatedly.
#
# pgdata is deliberately not removed without --purge: it holds the lane history,
# and an installer that silently deletes a database is a worse failure than one
# that leaves a directory behind.
if [ "${1:-}" = "--uninstall" ]; then
  systemctl --user stop laneward-conductor.service laneward.service laneward-db.service 2>/dev/null || true
  systemctl --user disable laneward-conductor.service laneward.service 2>/dev/null || true
  rm -f -- "$UNIT_DIR/laneward.service" "$UNIT_DIR/laneward-conductor.service" \
           "$QUADLET_DIR/laneward-db.container"
  [ "$UNIT_DIR" = "$HOME/.config/systemd/user" ] && systemctl --user daemon-reload || true
  rm -rf -- "$DATA_DIR/app" "$STATE_DIR"
  echo "Removed the units, the app directory and $STATE_DIR."
  if [ "${2:-}" = "--purge" ]; then
    rm -rf -- "$CONFIG_DIR" "$DATA_DIR"
    echo "Purged $CONFIG_DIR and $DATA_DIR, including the database volume."
  else
    echo "Kept $CONFIG_DIR/.env and $DATA_DIR/pgdata, which holds your lane history."
    echo "Add --purge to remove those too."
  fi
  exit 0
fi

[ -x "$BUN" ] || die "bun not found at $BUN"

# Warn rather than refuse. These are the versions Laneward was verified against,
# not measured floors: nobody has established that 1.3.13 fails, and refusing on
# a boundary that was never tested blocks installs for a guess.
VERIFIED_BUN=1.3.14
VERIFIED_CODEX=0.147.0
older_than() { [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -1)" = "$1" ]; }

BUN_VERSION="$("$BUN" --version 2>/dev/null || echo 0)"
if older_than "$BUN_VERSION" "$VERIFIED_BUN"; then
  echo "WARNING: bun $BUN_VERSION is older than $VERIFIED_BUN, the version Laneward was verified against." >&2
fi

if command -v codex >/dev/null; then
  CODEX_VERSION="$(codex --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || echo 0)"
  if older_than "$CODEX_VERSION" "$VERIFIED_CODEX"; then
    echo "WARNING: codex $CODEX_VERSION is older than $VERIFIED_CODEX, the version Laneward was verified against." >&2
  fi
else
  echo "WARNING: codex not on PATH. Laneward installs, but no lane can be dispatched until it is." >&2
fi

mkdir -p "$CONFIG_DIR" "$UNIT_DIR" "$QUADLET_DIR" "$DATA_DIR/pgdata"

if [ ! -f "$CONFIG_DIR/.env" ]; then
  cp .env.example "$CONFIG_DIR/.env"
  chmod 600 "$CONFIG_DIR/.env"
  echo "Wrote default config to $CONFIG_DIR/.env, edit it before first start."
fi

# Validate the config that will actually be loaded, not .env.example.
set -a; . "$CONFIG_DIR/.env"; set +a
[ -n "${DATABASE_URL:-}" ] || die "DATABASE_URL is empty in $CONFIG_DIR/.env"
[[ "${PORT:-}" =~ ^[0-9]+$ ]] || die "PORT must be numeric in $CONFIG_DIR/.env"
[[ "${MAX_ACTIVE_LANES:-}" =~ ^[0-9]+$ ]] || die "MAX_ACTIVE_LANES must be numeric in $CONFIG_DIR/.env"

# The notifier invokes notify-send directly. Without it every enabled class is a
# silent no-op, and a notification system that fails quietly is worse than one
# that is switched off on purpose, so refuse at install time instead. An empty
# LANEWARD_NOTIFY is a deliberate choice and needs nothing.
if [ -n "${LANEWARD_NOTIFY:-}" ] && ! command -v notify-send >/dev/null; then
  die "notify-send not found, but LANEWARD_NOTIFY=$LANEWARD_NOTIFY requests desktop notifications.
  Install it (Fedora: dnf install libnotify) or set LANEWARD_NOTIFY= in $CONFIG_DIR/.env"
fi

# Podman is required for the database this package ships, not for Laneward. The
# quadlet exists to run Postgres locally; a DATABASE_URL pointing somewhere else
# means the operator already has one, and demanding podman then refuses an
# install that would have worked. Decide from the config rather than assuming.
LOCAL_DB=0
case "$DATABASE_URL" in
  *@127.0.0.1*|*@localhost*|*@\[::1\]*) LOCAL_DB=1 ;;
esac

if [ "$LOCAL_DB" = 1 ]; then
  command -v podman >/dev/null || die "podman not found, and DATABASE_URL points at this host.
  The database ships as a Quadlet container and needs it. Install podman, or point
  DATABASE_URL at a Postgres you already run."
fi

# Can the address in the config actually be reached? A warning rather than a
# refusal, because on a local database the container is started after this
# script runs, so unreachable is the normal state here.
#
# It is worth saying anyway: an unreachable database does not fail fast. Every
# query times out after 5000 ms and reads as an application bug, and the address
# can be wrong in ways nothing else notices -- a published port whose forwarding
# is dead reports itself published, and a `.env` copied between machines carries
# the other machine's address. Both have cost a diagnosis on this project.
db_hostport="${DATABASE_URL##*@}"
db_hostport="${db_hostport%%/*}"
case "$db_hostport" in
  \[*\]*) db_host="${db_hostport%%]*}"; db_host="${db_host#[}"; db_port="${db_hostport##*]:}" ;;
  *) db_host="${db_hostport%%:*}"; db_port="${db_hostport##*:}" ;;
esac
[ "$db_port" = "$db_hostport" ] && db_port=5432
if ! timeout 2 bash -c "exec 3<>/dev/tcp/$db_host/$db_port" 2>/dev/null; then
  printf 'install.sh: warning: nothing is listening on %s:%s, where DATABASE_URL points.\n' "$db_host" "$db_port" >&2
  if [ "$LOCAL_DB" = 1 ]; then
    printf '  Expected before the database unit is started; start it below and it will be.\n' >&2
  else
    printf '  DATABASE_URL points off this host, so nothing here will start it. Every query\n  will time out after 5000 ms and look like an application bug.\n' >&2
  fi
fi

APP_DIR="$DATA_DIR/app"

# The units are templates. systemd's %h is the home directory, which is not what
# this script computed: it honours XDG_CONFIG_HOME and XDG_DATA_HOME, and a unit
# written with %h disagrees with it the moment either is non-default. Pure bash
# substitution rather than sed, so a path containing &, \ or | needs no escaping.
if [ "$LOCAL_DB" = 1 ]; then
  DB_DEPENDENCY="After=laneward-db.service
Requires=laneward-db.service"
else
  DB_DEPENDENCY="# DATABASE_URL points off this host, so no local database unit exists."
fi

render() {
  local content
  content="$(cat -- "$1")"
  content="${content//@APP_DIR@/$APP_DIR}"
  content="${content//@CONFIG_DIR@/$CONFIG_DIR}"
  content="${content//@DATA_DIR@/$DATA_DIR}"
  content="${content//@BUN_DIR@/$BUN_DIR}"
  content="${content//@BUN@/$BUN}"
  content="${content//@DB_DEPENDENCY@/$DB_DEPENDENCY}"
  printf '%s\n' "$content" > "$2"
  case "$(cat -- "$2")" in
    *@APP_DIR@*|*@CONFIG_DIR@*|*@DATA_DIR@*|*@BUN@*|*@BUN_DIR@*|*@DB_DEPENDENCY@*)
      die "unsubstituted placeholder left in $2" ;;
  esac
}

if [ "$LOCAL_DB" = 1 ]; then
  render quadlet/laneward-db.container "$QUADLET_DIR/laneward-db.container"
else
  rm -f -- "$QUADLET_DIR/laneward-db.container"
fi
render systemd/laneward.service "$UNIT_DIR/laneward.service"
render systemd/laneward-conductor.service "$UNIT_DIR/laneward-conductor.service"

APP_STAGE="$DATA_DIR/.app-install-$$"
rm -rf -- "$APP_STAGE"
mkdir -p "$APP_STAGE"
trap 'rm -rf -- "$APP_STAGE"' EXIT

shopt -s dotglob nullglob
for source in "$PACKAGE_DIR"/*; do
  case "${source##*/}" in
    # .codegraph is a gitignored local index, 3.5 MB of it, and shipping a stale
    # copy into the deployed app helps nothing. Keep this list level with
    # .gitignore; it is a denylist and it drifts.
    .git|.env|*.log|.codegraph|docs|tests) continue ;;
  esac
  cp -a -- "$source" "$APP_STAGE/"
done

if [ ! -d "$APP_STAGE/node_modules" ]; then
  (cd "$APP_STAGE" && "$HOME/.bun/bin/bun" install --frozen-lockfile)
fi

rm -rf -- "$APP_DIR"
mv -- "$APP_STAGE" "$APP_DIR"
trap - EXIT

# daemon-reload first: laneward-db.service does not exist until Quadlet generates it.
# An overridden config root is isolated from the live user manager.
if [ "$UNIT_DIR" = "$HOME/.config/systemd/user" ]; then
  systemctl --user daemon-reload
fi

# No systemd-analyze verify here: it does not resolve generator-produced units,
# so Requires=laneward-db.service always fails even after daemon-reload has
# generated it. The check could only ever cry wolf. `systemctl --user start`
# below is the real verification.

if [ "$LOCAL_DB" = 1 ]; then
  DB_LINE="          $QUADLET_DIR/laneward-db.container"
  START_LINE="  1. systemctl --user start laneward-db.service laneward.service"
else
  DB_LINE="  database  external, per DATABASE_URL; no quadlet installed"
  START_LINE="  1. systemctl --user start laneward.service   (your own database must be up)"
fi

cat <<EOF

Installed:
  units   $UNIT_DIR/laneward.service
          $UNIT_DIR/laneward-conductor.service
$DB_LINE
  config  $CONFIG_DIR/.env
  data    $DATA_DIR/pgdata
  app     $APP_DIR

Not done by this script: the services are installed but UNVERIFIED at runtime:
$START_LINE
  2. cd $APP_DIR && bun --env-file=$CONFIG_DIR/.env run db/migrate.ts
     (the deployed app has no .env of its own; only the unit reads $CONFIG_DIR/.env)
  3. systemctl --user start laneward-conductor.service
     (start it after the migration; it dispatches lanes and needs the schema)
  4. journalctl --user -u laneward.service -u laneward-conductor.service -n 30

Services stop at logout unless linger is enabled (persistent host change):
  loginctl enable-linger \$USER
EOF
