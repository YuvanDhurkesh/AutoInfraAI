ARG NODE_VERSION=22.20.0
FROM node:${NODE_VERSION}-slim

# OpenSSL for Prisma's engines (node:slim ships none, and Prisma then guesses).
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
# npm and pnpm both read these: a dropped connection is retried, not fatal.
ENV NPM_CONFIG_FETCH_RETRIES=5 NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=20000 \
    NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000

WORKDIR /app
COPY . .
# pnpm from npm, at the version package.json pins: Node's bundled Corepack
# can't start pnpm 12 (it looks for bin/pnpm.cjs, which pnpm 12 no longer
# ships). The Prisma client is generated first: the TypeScript build needs its types.
RUN npm install -g "pnpm@$(node -p "require('./package.json').packageManager.split('@')[1]")" \
    && pnpm install --frozen-lockfile --filter @autoinfra/api... \
    && pnpm --filter @autoinfra/api prisma:generate \
    && pnpm --filter @autoinfra/api build

WORKDIR /app/apps/api
EXPOSE 4000
# Pending migrations first (a no-op when there are none), so `docker compose up`
# works on a fresh database without a separate migrate step.
CMD ["sh", "-c", "pnpm exec prisma migrate deploy && node dist/index.js"]
