#!/bin/bash
# Sourced by setup.sh on the F2 instance (cwd /opt/autoinfra) before the app
# starts: the app's own database setup. Steps marked "once" are remembered in
# /opt/autoinfra/state, on the same disk as the database's volume.
# Expects DB_KIND, DB_NAME and APP_SERVICE from setup.sh.

STATE="${AUTOINFRA_STATE:-/opt/autoinfra/state}"
mkdir -p "$STATE"

marker() {
  echo "$STATE/$(printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_')"
}

# Start the database container (if AutoInfra runs one) and wait until it is
# healthy -- its healthcheck uses TCP, which only answers once the image's
# own init scripts (schema.sql etc.) have finished.
start_database() {
  # Not grep -q: it exits at the first match, compose gets SIGPIPE, and
  # pipefail turns "found" into "not found" when db is listed first.
  if docker compose config --services | grep -x db > /dev/null; then
    echo "Starting the database"
    docker compose up -d --wait --wait-timeout 300 db
  fi
}

run_in_app() {
  echo "Running: $1"
  docker compose run --rm -T --no-deps "$APP_SERVICE" sh -c "$1"
}

# sql_once <name> <file>: pipe a migration file into the database, once.
sql_once() {
  local done_marker
  done_marker=$(marker "sql:$1")
  [ -f "$done_marker" ] && return 0
  case "$DB_KIND" in
    postgres)
      echo "Applying $1"
      docker compose exec -T db psql -v ON_ERROR_STOP=1 -U app -d "$DB_NAME" < "$2"
      ;;
    mysql)
      echo "Applying $1"
      docker compose exec -T db sh -c 'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE"' < "$2"
      ;;
    *)
      echo "Skipping $1: SQL files are only applied to a database AutoInfra runs."
      return 0
      ;;
  esac
  touch "$done_marker"
}

# command_once <name> <command>: run a migration script in the app container, once.
command_once() {
  local done_marker
  done_marker=$(marker "cmd:$1")
  [ -f "$done_marker" ] && return 0
  run_in_app "$2"
  touch "$done_marker"
}

# command_always <name> <command>: migration tools (prisma, knex...) are idempotent.
command_always() {
  run_in_app "$2"
}
