#!/bin/bash
# Runs on the F2 instance: dumps the database container to
# s3://<artifacts-bucket>/backups/. The bucket's 7-day expiry keeps the last
# week of dumps. deploy.sh runs it daily (systemd timer) and before each
# deploy's database setup.
# Usage: backup.sh <artifacts-bucket> <region> [label]
set -euo pipefail
BUCKET="$1"
REGION="$2"
LABEL="${3:-daily}"
cd "${AUTOINFRA_DIR:-/opt/autoinfra}"

image=$(docker compose config --format json |
  python3 -c 'import json, sys; print(json.load(sys.stdin)["services"].get("db", {}).get("image", ""))')
if [ -z "$image" ]; then
  echo "No database container: nothing to back up."
  exit 0
fi
if [ -z "$(docker compose ps -q --status running db)" ]; then
  echo "The database container isn't running: nothing to back up yet."
  exit 0
fi

# Each dump reads its credentials from the container's own environment.
# Matched by the image's own name: AutoInfra pulls it from a registry
# (public.ecr.aws/docker/library/mongo:7), an older deploy by name alone.
case "${image##*/}" in
  postgres:*)
    ext=sql
    dump() { docker compose exec -T db sh -c 'exec pg_dumpall -U "$POSTGRES_USER"'; }
    ;;
  mysql:*)
    ext=sql
    dump() {
      docker compose exec -T db sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysqldump -uroot --all-databases --single-transaction --routines --events --triggers'
    }
    ;;
  mongo:*)
    ext=archive
    dump() {
      docker compose exec -T db sh -c 'exec mongodump --quiet --archive --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin'
    }
    ;;
  redis:*)
    ext=rdb
    dump() { docker compose exec -T db sh -c 'redis-cli SAVE > /dev/null && cat /data/dump.rdb'; }
    ;;
  *)
    echo "Don't know how to back up the database image $image." >&2
    exit 1
    ;;
esac

# To a file first: a dump that fails halfway is never uploaded as a backup.
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
dump | gzip -c > "$tmp"
if [ "$(gzip -dc "$tmp" | head -c 1 | wc -c)" -eq 0 ]; then
  echo "The database dump was empty; not uploading it." >&2
  exit 1
fi
key="backups/db-$(date -u +%Y-%m-%dT%H%M%SZ)-$LABEL.$ext.gz"
aws s3 cp "$tmp" "s3://$BUCKET/$key" --region "$REGION" --only-show-errors
echo "Database backup: s3://$BUCKET/$key ($(du -h "$tmp" | cut -f1))"
