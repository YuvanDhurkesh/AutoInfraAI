# Known limitations

What AutoInfra doesn't do, does only partly, or trades away on purpose (per
the brief, Sec. 13). Last reviewed 2026-10-27. Security
trade-offs are covered in more depth in `docs/security-review.md`.

## What has and hasn't run on real AWS

- **Run for real:** one-click connect (role stack, callback, verification),
  an F3 static site (`octocat/Spoon-Knife`), an F2 React + Express + MySQL
  app (deploy, live use, then destroy with the leftover check), the
  "Update permissions" flow, and on 28 October an F2 blueprint app
  (conduit: deploy, sign-up and login, env var change, **redeploy**, and
  the pre-deploy database backup to S3, then destroy with a clean leftover
  check), and on 29 October an F1 blueprint app on Lambda (FastAPI: deploy
  through CodeBuild packaging; the Function URL refuses direct requests).
- **Tested only with fakes** (real API routes and pipeline code; AWS,
  Terraform apply, CodeBuild and Gemini faked): change requests,
  "Explain this failure", rollback, GitHub
  sign-in (GitHub's endpoints faked), and the analyze -> design -> generate
  chain on the worker. The two sample apps in `examples/` were verified
  locally but never deployed.
- The **F2 blueprint** went live on real AWS on 28 October (a React +
  Express + Sequelize + Postgres app: 36 resources, CodeBuild, migrations
  on the instance, health checks, live through CloudFront). The **F1
  blueprint** went live on Lambda on 29 October (a FastAPI app: 24
  resources, the Python package built by CodeBuild, health check through
  CloudFront; the Function URL answers only CloudFront's signed requests).
  F1 with a frontend and an API that accepts writes (a public Function URL)
  hasn't run for real yet.
- The platform's own AWS identity and the first connected "user" account
  are the same account during development. The cross-account mechanics are
  real (`sts:AssumeRole` with an ExternalId), but two genuinely separate
  accounts haven't been exercised.

## Platform scope

- AutoInfra itself (`apps/api`, `apps/worker`, `apps/web`) runs locally
  only (`docker compose` or the dev servers); hosting the platform is out
  of scope.
- The worker uses the host's `~/.aws` credentials for the platform's own
  identity (only to assume users' roles). A hosted platform would use an
  instance or task role.
- Pause/resume for F2 (a stretch goal in the brief) is not implemented.

## AWS Free Tier and the deployment patterns

- New AWS accounts (created July 15, 2025 or later) are on the credit-based
  Free plan: up to about $200 in credits for 6 months, then the account
  closes unless upgraded. AutoInfra never upgrades it. The dashboard warns
  (red within 30 days) with the end date and credits AWS reported at the
  connection's last verification -- a snapshot, not live; re-verify the
  connection or check Billing for current numbers.
- Treating `GetAccountPlanState`'s `ResourceNotFoundException` as "legacy
  12-month account" is a reasonable signal, not a certainty. When the API
  gives no answer, the user is asked, and they can override it.
- The 750 EC2 hours/month allowance is shared across the whole AWS account,
  so strict mode allows one always-on EC2 instance per AWS account (every
  connection to it, read from the role ARN) across all of its deployments.
  A failed deployment counts only if its apply recorded an instance: one
  that failed mid-apply, before Terraform's outputs, isn't counted even if
  the instance exists -- destroy failed deployments. One being destroyed
  isn't counted; if that destroy then fails, the new deployment's checks
  before apply catch the second instance.
- `policy.json`'s `lastVerified` date is only as good as the last manual
  check; AWS changes Free Tier terms and nothing re-verifies them
  automatically. CodeBuild's free build minutes aren't enforced as a number
  (AWS's pages were inconsistent); the policy notes it instead.
- `estimatedMonthlyCostUsd` is always `0`: there's no cost model. A `0`
  means "not priced", not "free".
- The unattached-EIP check reads the plan only; an EIP orphaned later (for
  example by an out-of-band instance delete) isn't caught until destroy's
  leftover scan.
- **F1** (S3 + CloudFront + Lambda): cold starts, CloudFront's ~30 s origin
  timeout and Lambda's 250 MB unzipped package limit bound what it can run.
  For APIs with write routes the Lambda Function URL is public with
  CloudFront in front (CloudFront's signed access breaks browser POST/PUT);
  anyone who finds the URL can call it directly, so the app's own auth is
  the protection. Read-only APIs use AWS_IAM + OAC. Env var changes take
  effect on the next cold start.
- **F2** (one EC2 instance with Docker Compose + Caddy): 1 GB of RAM is
  tight for an app plus a database; the platform adds a 1 GB swap file.
  At deploy time AutoInfra shows a crashed container's last lines and an
  app's startup error lines (a "live, but..." notice when it recognises
  them). Afterwards the deployment page's App logs panel reads any
  container's last 200-500 lines on request -- not a live stream. Its
  Database panel shows the tables in AutoInfra's PostgreSQL, MySQL or
  MongoDB container and 25 rows at a time, read-only: no SQL box, no
  editing, values cut at 200 characters, password-like columns hidden
  until asked. A database hosted outside AWS (Atlas, Neon...) isn't shown
  -- use the provider's console -- nor is Redis. Files an app saves in
  its container (uploads) are lost when a deploy replaces the container.
  The database runs in a container on one EBS volume -- no high
  availability. It is dumped (pg_dumpall, mysqldump, mongodump, or Redis's
  RDB file) to the artifacts bucket's `backups/` folder daily and before
  every deploy's migrations; the bucket's 7-day expiry keeps a week of them,
  and destroying the deployment deletes them with the bucket. Restoring is
  manual (download the dump, pipe it into the container over an SSM
  session), and a failed pre-deploy backup is logged but doesn't block the
  deploy. CloudFront reaches the
  instance over plain HTTP (no certificate without a load balancer, which
  is deny-listed); a secret origin header authenticates CloudFront to
  Caddy, but that hop is unencrypted. The instance may connect out on any
  port (no NAT Gateway or VPC endpoints on the Free Tier, and apps need
  databases on custom ports and SMTP; recorded as a trivy exception);
  inbound stays CloudFront-only. AWS throttles outbound port 25 on EC2, so
  email goes through a provider on 587/465. The origin secret is Terraform-generated, so it lives
  in the (encrypted, private) state bucket and SSM. MySQL apps connect as
  root on the private Docker network; a dedicated user would be better.
  Env var changes apply on the next deploy.
- **Server-rendered frontends** -- Next.js (middleware, dynamic routes, no
  `output: "export"`), Nuxt (unless built with `nuxt generate`) and SvelteKit
  (unless it uses adapter-static) -- always go to F2: the server runs as a
  second container built by AutoInfra's own `Dockerfile.web` with the repo's
  lockfile (npm, yarn or pnpm), and CloudFront sends every non-API path to
  the instance uncached -- no CDN caching of pages or static assets. It
  shares the instance's 1 GB with the API (and database, if any). SvelteKit
  apps using adapter-auto or a hosting provider's adapter are built with
  adapter-node instead (in the build's copy only). Nuxt needs Nitro's default
  node-server preset. Remix, Astro's server mode, SolidStart and other
  server frameworks have no blueprint (Gemini designs them, unverified).
  Public build-time values the owner enters (`NEXT_PUBLIC_*`, `PUBLIC_*`,
  `VITE_*`) are passed to the build.
- Caddy tells the app every request arrived over HTTPS (`X-Forwarded-Proto:
https`), which is true at CloudFront; apps that trust proxy headers then
  set secure cookies and build `https://` links correctly.

## Connecting AWS and GitHub

- The deploy role's permissions are scoped to `autoinfra-*` resources where
  AWS allows it, with explicit denies on Organizations, Account and IAM
  user/key creation. It was widened as real deploys needed (now template
  v3); the F1 (Lambda) permissions have been exercised on real AWS since
  29 October (create, code update, Function URL).
- One-click connect creates the role stack in the platform's region
  (`AWS_REGION`): a CloudFormation custom resource can only notify an SNS
  topic in its own region. The role is global, so deployments can target
  other regions. The quick-create link's presigned template URL expires
  after an hour; reopening the connect page makes a fresh one.
- The registration SNS topic accepts publishes from any AWS account (it has
  to). A message only counts if it carries the connection's secret
  ExternalId and names a role AutoInfra can actually assume, and the
  response is only ever sent to CloudFormation's own S3 response hosts.
- GitHub OAuth asks for `read:user repo`, which covers every repo the
  account can read -- OAuth Apps have nothing narrower. A GitHub App could
  let users pick repos; not attempted.
- Accounts created with "Log in with GitHub" get a placeholder `.invalid`
  email (that scope doesn't include the email). They can add a real email
  and password in Settings; nothing verifies the email (there's no mail
  sending).
- One GitHub account connects to one AutoInfra account; connecting it to a
  second is refused. GitHub sign-in needs an OAuth app
  (`docs/github-oauth-setup.md`); without one the buttons are hidden.

## Scanning repositories

- The scanner is regex/heuristic-based, not a parser: it misses ports set
  through config objects, routes registered indirectly, and env vars read
  by destructuring. Read every `RepoProfile` field as "what was found".
- `database` reports the main datastore. Redis used next to it (a cache,
  sessions, job queues) runs as a second container on F2 (64 MB, its own
  small volume); on F1, or when the data lives outside AWS, its settings
  are the owner's to enter.
- Database settings written into the code with a localhost or
  hosted-database address (`host: 'localhost'`, `mongodb://localhost/app`,
  an RDS or Atlas host) are flagged on the review screen, with any password
  in a URL masked: AutoInfra wires databases through env vars only, so the
  code has to read them. Other hosts written in (an SMTP server) aren't
  flagged. Per-environment config files whose production
  entry reads env vars (knexfile, Sequelize's config.js) aren't flagged.
  Env-prefixed copies (`PROD_DB_HOSTNAME`, `DEV_DB_NAME`) and
  `*_DIALECT` are filled in like `DB_HOST`. Settings wired to AutoInfra's
  database or Redis container can't be given a value of your own (the env
  form refuses them: the compose file's value would win anyway); to use your
  own database, create the deployment with "Database hosted outside AWS".
- Databases hosted outside AWS (MongoDB Atlas, Neon, Supabase, PlanetScale,
  Upstash...) are accepted when the deployment's "hosted outside AWS"
  option is ticked at creation (it can't be changed afterwards), or when
  the repo's env template (.env.example and similar) points a database
  setting at a known provider's domain -- a short list (neon.tech,
  supabase.co/.com, mongodb.net, psdb.cloud, upstash.io, render.com,
  railway.app, aivencloud.com, rds.amazonaws.com...); a provider not on it
  still needs the option. The owner enters the connection settings as env
  vars; AutoInfra creates no database and runs no schema scripts against
  it. The provider must accept connections from AutoInfra's side: Lambda
  has no fixed outbound IP, so allow anywhere (e.g. Atlas 0.0.0.0/0); on F2
  outbound traffic leaves through the instance's Elastic IP, shown on the
  deployment's live card.
- Local-disk detection can false-positive on code that only writes to
  `/tmp`, pushing an app to F2 when F1 would have worked.
- Backends: Node and Python run as they are (F1 or F2); Go and Java
  (Spring Boot, Maven or Gradle) get a generated Dockerfile on F2; any other
  language (Ruby, PHP, Rust, .NET, Elixir...) runs from its own Dockerfile
  on F2 and is refused without one. A Dockerfile whose final image only
  serves files (nginx, httpd, caddy) counts as a static site. A repo's own
  docker-compose.yml is not run. The backend's Dockerfile is built at its
  last stage, as Docker does; only when that stage is for development
  (`dev-envs`, `development`, `test`, `debug`) does AutoInfra take a
  production-named stage, else the `target:` the compose file builds.
  Code that hard-codes what only the repo's compose file provides -- a
  database password read from `/run/secrets/...` (Docker secrets), or
  compose's own credentials (`root`/`example`, user `postgres`) -- can't
  work with AutoInfra's database, which has its own user and password; the
  hosts themselves (`db`, `postgres`, `mysql`, `mongo`, `redis`,
  `database`) do resolve to AutoInfra's containers. One backend
  container (plus the database and a Next.js server) is what the blueprints
  run, so a repo of several services needs a subdir per deployment. A
  subdir holding a whole
  app (`frontend/` + `backend/`) is searched like a repo root, and an npm
  or pnpm workspaces root is never taken for the backend itself. Databases of other
  languages are found by driver names in go.mod, pom.xml/build.gradle,
  Gemfile, composer.json and Cargo.toml (Laravel by DB_CONNECTION).
- Routing: one CloudFront URL. The API prefix (/api) goes to the backend
  (stripped when its routes lack it). Its other paths go to it unchanged:
  socket.io, WebSocket paths, dev-proxy paths (Vite/Vue/Angular proxy
  keys, setupProxy.js) and its top-level routes found on the app itself or
  as router mounts (Express/Fastify/Koa/Hono, FastAPI/Flask, NestJS) --
  at most 8 of them (CloudFront's 25-behavior quota), and never a path the
  frontend has a page at (React/Vue Router, Angular, Next.js folders); a
  route registered some other way (a loop, a computed path) isn't found.
- localhost URLs are rewritten in the build's copy of the code: in the
  frontend the backend's (http(s) and ws://), in the backend its own and
  frontend dev servers' (CORS allow-lists, redirects after login); a
  second local service's port is left alone. With socket.io and backend
  routes outside /api, one constant serving both io() and fetch() relies on
  those routes being found.
- Secret detection is a small set of high-confidence patterns, not a full
  scanner like gitleaks. Detected secrets are flagged and never sent to the
  model, but a clean result isn't a guarantee.
- The walk stops after 5,000 files and skips files over 1 MB.
- Leaving Branch empty uses the repository's default branch (`main`,
  `master`, ...), whose name the first analyze records; a deployment then
  follows that branch, even if the repository's default changes later.
- Clones are shallow and include submodules and Git LFS files. Submodules
  on GitHub are fetched with the user's token (SSH URLs over HTTPS);
  submodules on other hosts must be public. Git's errors are shown with the
  token scrubbed out.

## Design, generation and validation

- The model sees the scanner's structured fields, never file contents.
  Prompt-injection defense is layered (untrusted-data framing, schema
  output, server-side checks, a human approval gate) but not provable.
- The Free Tier check on a design is only as good as the sizes the model
  fills in; the binding check is on the Terraform plan.
- Bucket and IAM policy documents that reference resources not created yet
  are unknown at plan time, so the security policy notes them instead of
  inspecting them.
- tflint runs its bundled Terraform ruleset only (the AWS ruleset plugin
  would need a download at runtime). Without native tflint/trivy or Docker,
  those gates report "skipped" -- never treated as passed -- so nothing can
  reach approval.
- Every `terraform init` downloads providers through registry.terraform.io
  (the plugin cache saves the download, not the registry lookup). A network
  failure there is retried twice (15 s, then 45 s) and is never sent to
  Gemini as something to repair -- the step stops with "check the internet
  connection and retry". The same goes for a network failure during `plan`
  and for tflint/trivy crashing. Behind a proxy, set `HTTPS_PROXY`/
  `NO_PROXY` (and `SSL_CERT_FILE` for its CA) for the worker; they're
  passed to Terraform.
- A failed generation can be regenerated, but redesigning that revision
  needs a re-analysis first.

## Deploying, changes and rollback

- The pre-approval plan runs against the deployment's real Terraform state
  once anything was applied; the apply step re-plans and refuses anything
  outside what was approved.
- Change requests: Gemini edits the live Terraform and is told to keep
  every other resource address, but only the reviewed plan enforces that --
  a careless edit shows up as replaces or destroys (data-bearing ones need
  an extra confirmation), not as a refusal. Changes are infrastructure
  only; code changes go through GitHub and "Redeploy latest commit".
- Rollback restores an earlier revision's Terraform and commit only within
  the same architecture pattern, and it doesn't restore data: rolling back
  past a change that added a table or bucket deletes it (the plan shows
  this and asks for confirmation). Env var values aren't versioned; the old
  code runs with today's values.
- Redeploy still clones and scans the new commit inside the API request
  (to refuse a changed app shape and ask about new env vars before
  starting), so a slow clone holds that request open -- for at most two
  minutes per git step, then it fails with a readable error.
- The source is uploaded from the machine running the worker (8 MB parts,
  each retried on network errors for about a minute). On a slow or
  unstable connection a large repo can still fail the upload; a drop then
  costs one part, not the whole upload.
- Health checks accept any non-5xx answer from the app on the API route (an
  app that 404s on the probed path still counts). The "deploying"
  placeholder doesn't, nor does an answer from S3 (the path isn't routed to
  the backend -- the SPA fallback would otherwise look like a 200) or a
  Lambda Function URL refusing CloudFront.
- "Explain this failure" sends the last 150 log lines to Gemini after
  pattern-based redaction of keys, tokens and `password=` values; an
  unusual secret format in a build log could get through.

## Security trade-offs

See `docs/security-review.md` for the full list. In short: rate limits use
fixed windows (a burst at a window edge can briefly reach twice a limit)
and the live-log cap is per API process; there's no 2FA, CAPTCHA or lockout
email; CSRF protection is a double-submit cookie (it stops cross-site
requests, not XSS); and CI doesn't scan AutoInfra's own dependencies.

## This machine

- A native Windows Postgres service already listens on 5432, so
  `docker-compose.yml` maps Postgres to 5433 and Redis to 6380. Harmless
  elsewhere.
- `turbo.json` uses `"envMode": "loose"` so `.env` values reach tasks; fine
  without remote caching, worth revisiting for reproducible CI caching.
- `.gitattributes` forces LF for shell scripts, Terraform, YAML, the
  Caddyfile and Dockerfiles, and the loaders strip CRLF too -- a Windows
  checkout would otherwise ship `run.sh` with `\r` and break bash on Linux.
- A worker on Windows clones with git's `core.longpaths`: repos with paths
  over 260 characters would otherwise clone but fail to check out. Every
  clone keeps the repository's own line endings (`core.autocrlf=false`,
  `core.eol=lf`): Git for Windows' CRLF checkout broke a repo's Dockerfile
  heredoc on the Linux build (`apt-get update\r`).
- The F2 instance's first-boot setup (Docker, Compose, swap) is repeated by
  each deploy when it's missing, so a first boot whose download failed heals
  on the next deploy instead of breaking every one.
