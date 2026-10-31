#!/bin/bash
# EC2 user data: prepares the host once. Every deploy then runs the current
# deploy.sh from the artifacts bucket (CodeBuild -> SSM Run Command).
set -euo pipefail

# deploy.sh repeats these steps when they're missing, so a first boot that
# failed half-way (a download that timed out) heals on the next deploy.
dnf install -y docker
systemctl enable --now docker
mkdir -p /usr/local/lib/docker/cli-plugins
curl -fsSL --retry 5 --retry-delay 5 --retry-all-errors \
  "https://github.com/docker/compose/releases/download/v2.32.4/docker-compose-linux-$(uname -m)" \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

# 1 GB RAM is tight for an app plus a database: add swap.
if [ ! -f /swapfile ]; then
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo "/swapfile swap swap defaults 0 0" >> /etc/fstab
fi

mkdir -p /opt/autoinfra
