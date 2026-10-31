#!/bin/bash
# Runs on the F2 instance for every deploy (CodeBuild -> SSM Run Command).
# Usage: deploy.sh <artifacts-bucket> <region> <ssm-prefix>
set -euo pipefail
BUCKET="$1"
REGION="$2"
SSM_PREFIX="$3"
cd "${AUTOINFRA_HOME:-/opt/autoinfra}"

# A new instance can register with SSM while its first-boot setup (user data:
# Docker, Compose, swap) is still running -- wait for it. If that setup failed
# half-way (a download timed out), do the missing steps now, or every deploy
# to this instance would fail.
if command -v cloud-init > /dev/null; then
  timeout 600 cloud-init status --wait > /dev/null 2>&1 || true
fi
if ! command -v docker > /dev/null; then
  echo "Installing Docker (the instance's first-boot setup didn't finish)"
  dnf install -y docker
fi
systemctl enable --now docker > /dev/null
if ! docker compose version > /dev/null 2>&1; then
  echo "Installing Docker Compose (the instance's first-boot setup didn't finish)"
  mkdir -p /usr/local/lib/docker/cli-plugins
  curl -fsSL --retry 5 --retry-delay 5 --retry-all-errors \
    "https://github.com/docker/compose/releases/download/v2.32.4/docker-compose-linux-$(uname -m)" \
    -o /usr/local/lib/docker/cli-plugins/docker-compose
  chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
fi
SWAPFILE="${AUTOINFRA_SWAPFILE:-/swapfile}"
if [ ! -f "$SWAPFILE" ]; then
  fallocate -l 1G "$SWAPFILE" && chmod 600 "$SWAPFILE" && mkswap "$SWAPFILE" && swapon "$SWAPFILE"
  echo "$SWAPFILE swap swap defaults 0 0" >> /etc/fstab
fi

rm -rf initdb
aws s3 cp "s3://$BUCKET/deploy/" . --recursive --region "$REGION" --only-show-errors

# App env vars + platform secrets from SSM, never baked into an image. Values
# are single-quoted so Compose takes them literally ($, #, spaces).
aws ssm get-parameters-by-path --path "$SSM_PREFIX/" --recursive --with-decryption \
  --region "$REGION" --output json |
  python3 -c '
import json, sys
for p in json.load(sys.stdin)["Parameters"]:
    name = p["Name"].rsplit("/", 1)[-1]
    value = p["Value"].replace("\n", "\\n")
    if "\x27" not in value:
        print(name + "=\x27" + value + "\x27")
    else:
        escaped = value.replace("\\", "\\\\").replace("\"", "\\\"").replace("$", "$$")
        print(name + "=\"" + escaped + "\"")
' > .env
cat image.env >> .env
chmod 600 .env

set -a
. ./image.env
set +a
image="${APP_IMAGE:-${WEB_IMAGE:-}}"
registry="${image%%/*}"
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$registry" > /dev/null

docker compose pull --quiet

# Database backups: daily, and now -- before this deploy's migrations touch
# the data. A failed backup is reported but doesn't block the deploy.
if [ -f backup.sh ]; then
  cat > /etc/systemd/system/autoinfra-backup.service << EOF
[Unit]
Description=AutoInfra database backup to S3
[Service]
Type=oneshot
ExecStart=/bin/bash /opt/autoinfra/backup.sh $BUCKET $REGION daily
EOF
  cat > /etc/systemd/system/autoinfra-backup.timer << EOF
[Unit]
Description=Daily AutoInfra database backup
[Timer]
OnCalendar=*-*-* 03:00:00
RandomizedDelaySec=1h
Persistent=true
[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable --now autoinfra-backup.timer > /dev/null 2>&1 ||
    echo "WARNING: couldn't enable the daily database backup timer"
  bash backup.sh "$BUCKET" "$REGION" predeploy ||
    echo "WARNING: the pre-deploy database backup failed (see above); deploying anyway"
fi

# The app's own database setup (migrations), before the new version starts.
if [ -f setup.sh ]; then
  bash setup.sh
fi
docker compose up -d --remove-orphans

# The containers must stay up: a crash at startup (a missing env var, a bad
# database URL) otherwise looks like a successful deploy. Give them time to
# connect, then check twice.
failed=""
for check in 1 2; do
  sleep 25
  for service in $(docker compose config --services); do
    container=$(docker compose ps -aq "$service")
    if [ -z "$container" ]; then
      failed="$failed $service"
      continue
    fi
    read -r state restarts < <(docker inspect -f '{{.State.Status}} {{.RestartCount}}' "$container")
    if [ "$state" != "running" ] || [ "$restarts" -ge 3 ]; then
      failed="$failed $service"
    fi
  done
  [ -n "$failed" ] && break
done

# Passwords in connection URLs (mongodb+srv://user:secret@...) stay out of the build log.
mask_urls() { sed -E 's#(://[^:/@ ]+:)[^@ ]+@#\1***@#g'; }

if [ -n "$failed" ]; then
  for service in $(echo "$failed" | tr ' ' '\n' | sort -u); do
    echo "=== $service did not stay up. Its last log lines: ==="
    docker compose logs --no-color --tail 80 "$service" 2>&1 | mask_urls || true
  done
  exit 1
fi

docker compose ps --format "table {{.Service}}\t{{.Status}}"
# Old images (every deploy pushes a new tag) would slowly fill the disk.
docker image prune -af > /dev/null || true

# Up isn't the same as working: an app that can't reach its database often
# says so once at startup and carries on. Its error lines (it has been
# running ~50s by now) go to the build log, where AutoInfra reads them.
apps=$(docker compose config --services | grep -vxE 'caddy|db|cache' | tr '\n' ' ') || true
errors=$(docker compose logs --no-color --since 10m $apps 2>&1 |
  grep -iE 'error|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|refused|denied|timed out' | mask_urls | tail -20) || true
if [ -n "$errors" ]; then
  echo "=== error lines in the app's startup log ==="
  echo "$errors"
fi
echo "Deploy finished: all containers are running."
