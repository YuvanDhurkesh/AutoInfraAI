#!/bin/bash
# EC2 user data (templatefile). Prepares the host once; deploys happen via
# /opt/autoinfra/deploy.sh, triggered by CodeBuild through SSM Run Command.
set -euo pipefail

dnf install -y docker
systemctl enable --now docker
mkdir -p /usr/local/lib/docker/cli-plugins
curl -fsSL "https://github.com/docker/compose/releases/download/v2.32.4/docker-compose-linux-$(uname -m)" \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

# 1 GB RAM is tight for app + database: add swap.
if [ ! -f /swapfile ]; then
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo "/swapfile swap swap defaults 0 0" >> /etc/fstab
fi

mkdir -p /opt/autoinfra
cat > /opt/autoinfra/deploy.sh <<'DEPLOY'
#!/bin/bash
set -euo pipefail
cd /opt/autoinfra
aws s3 cp "s3://${artifacts_bucket}/deploy/" . --recursive --region "${region}"
# App env vars + platform secrets from SSM (never baked into the image).
aws ssm get-parameters-by-path --path "/autoinfra/${short_id}/" --recursive --with-decryption \
  --region "${region}" --query "Parameters[].[Name,Value]" --output text \
  | while IFS=$'\t' read -r name value; do echo "$${name##*/}=$value"; done > .env
# The image tag CodeBuild just pushed (APP_IMAGE=...), for compose interpolation.
cat image.env >> .env
chmod 600 .env
aws ecr get-login-password --region "${region}" | docker login --username AWS --password-stdin "${ecr_registry}"
docker compose pull
docker compose up -d --remove-orphans
docker image prune -f
DEPLOY
chmod +x /opt/autoinfra/deploy.sh
