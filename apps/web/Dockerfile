ARG NODE_VERSION=22.20.0
FROM node:${NODE_VERSION}-slim

# npm and pnpm both read these: a dropped connection is retried, not fatal.
ENV NPM_CONFIG_FETCH_RETRIES=5 NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=20000 \
    NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000

WORKDIR /app
COPY . .
# pnpm from npm, at the version package.json pins: Node's bundled Corepack
# can't start pnpm 12 (it looks for bin/pnpm.cjs, which pnpm 12 no longer ships).
RUN npm install -g "pnpm@$(node -p "require('./package.json').packageManager.split('@')[1]")" \
    && pnpm install --frozen-lockfile --filter @autoinfra/web... \
    && pnpm --filter "@autoinfra/web..." build

WORKDIR /app/apps/web
EXPOSE 3000
CMD ["pnpm", "start"]
