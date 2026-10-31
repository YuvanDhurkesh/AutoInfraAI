# Pinned tool versions -- bump deliberately, never track "latest" in a job runner.
# tflint and trivy must match TFLINT_IMAGE/TRIVY_IMAGE in
# packages/terraform-runner/src/tools.ts (the gauntlet's Docker fallback).
ARG NODE_VERSION=22.20.0
ARG TERRAFORM_VERSION=1.15.8
ARG TFLINT_VERSION=0.54.0
ARG TRIVY_VERSION=0.58.1

# The linters come from their official images: the same binaries the
# gauntlet runs elsewhere, and no dependence on GitHub release files (trivy
# 0.58.1's tarball was taken down; its image is still published).
FROM ghcr.io/terraform-linters/tflint:v${TFLINT_VERSION} AS tflint
FROM aquasec/trivy:${TRIVY_VERSION} AS trivy

FROM node:${NODE_VERSION}-slim AS base

ARG TERRAFORM_VERSION
# npm and pnpm both read these: a dropped connection is retried, not fatal.
ENV NPM_CONFIG_FETCH_RETRIES=5 NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=20000 \
    NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl unzip git git-lfs ca-certificates gnupg openssl \
    && rm -rf /var/lib/apt/lists/*

# Terraform
RUN curl -fsSL -o /tmp/terraform.zip \
      "https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_linux_amd64.zip" \
    && unzip /tmp/terraform.zip -d /usr/local/bin \
    && rm /tmp/terraform.zip \
    && terraform -version

# tflint, and trivy (config scanning for generated Terraform)
COPY --from=tflint /usr/local/bin/tflint /usr/local/bin/tflint
COPY --from=trivy /usr/local/bin/trivy /usr/local/bin/trivy
RUN tflint --version && trivy --version

WORKDIR /app

# Dependencies installed at image build time from the full monorepo context so the
# worker has @autoinfra/shared and friends available without a registry publish step.
COPY . .
# The Prisma schema lives in apps/api, so it's installed too for `prisma generate`.
# pnpm from npm, at the version package.json pins: Node's bundled Corepack
# can't start pnpm 12 (it looks for bin/pnpm.cjs, which pnpm 12 no longer ships).
RUN npm install -g "pnpm@$(node -p "require('./package.json').packageManager.split('@')[1]")" \
    && pnpm install --frozen-lockfile --filter "@autoinfra/worker..." --filter @autoinfra/api \
    && pnpm --filter @autoinfra/api exec prisma generate \
    && pnpm --filter "@autoinfra/worker..." build

WORKDIR /app/apps/worker
CMD ["node", "dist/index.js"]
