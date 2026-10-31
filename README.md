# AutoInfra

GitHub repo → Free-Tier-friendly AWS infrastructure, designed by Gemini,
deployed automatically.

A user connects GitHub + AWS, pastes a repo URL, and AutoInfra analyzes the
repo, designs an AWS architecture that fits inside the Free Tier, generates
and validates Terraform, deploys it into the user's own AWS account after
approval, and manages its full lifecycle (change requests, rollback,
destroy). See `PLAN.md` for the full roadmap, schema, and API surface, and
`PROGRESS.md` for what's actually built so far.

## Status

All 11 milestones are built; what's still open is a full demo on real AWS.
Real deploys have run end to end on AWS for static sites (F3), server apps
on EC2 (F2, with Gemini's Terraform and with the blueprint, including
redeploy and destroy) and a FastAPI app on Lambda (F1). Change requests,
failure diagnosis and rollback are tested with fakes but not yet on real
AWS. Start with `HOW_IT_WORKS.md` (what's done and how it works); see
`PROGRESS.md` for detail and `KNOWN_LIMITATIONS.md` for the honest list of
gaps.

## Prerequisites

- Node.js 20+ (developed against 22.20.0)
- pnpm (`corepack enable && corepack prepare pnpm@latest --activate`, or `npm i -g pnpm`)
- Docker (for `docker-compose` and the worker's Terraform/tflint/trivy image)
- Terraform ≥ 1.10 locally if you want to run it outside Docker (S3 native state locking needs ≥1.10)

## Setup

1. `cp .env.example .env` (if you don't already have one) and fill in:
   - `GEMINI_API_KEY` / `GEMINI_MODEL` -- from https://ai.google.dev/
   - `COOKIE_SECRET` / `ENCRYPTION_KEY` -- any 32+ byte random hex string, e.g. `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
   - `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` -- see `docs/github-oauth-setup.md`. Without these, `/auth/github` routes are disabled (logged at startup) but everything else still works.
   - `AWS_REGION` -- a default region suggestion; the AWS connect wizard refines this per Free-Tier-eligible instance availability once you verify a connection
   - `API_BASE_URL` -- this API's own externally-reachable base URL (used to build the GitHub OAuth callback)
   - `TF_PLUGIN_CACHE_DIR` -- an existing folder; without it every validation downloads the ~700 MB AWS provider again
2. `pnpm install`
3. `docker compose up -d postgres redis`
4. `pnpm --filter @autoinfra/api db:deploy` (creates or updates the tables; reads `DATABASE_URL` from the root `.env`, which plain `prisma` wouldn't find)
5. Three processes, each in its own terminal:
   `pnpm --filter @autoinfra/api dev` (API on :4000),
   `pnpm --filter @autoinfra/worker dev` (runs generate/apply/destroy jobs;
   needs Terraform on PATH, plus Docker for tflint/trivy if they aren't
   installed), and `pnpm --filter @autoinfra/web dev` (web on :3000) -- or
   `docker compose up --build` to run everything in containers (the API
   container applies pending migrations itself; api and worker read the
   platform's AWS identity from `~/.aws`).
6. The api/worker processes pick up AWS credentials from the normal AWS SDK
   credential chain (env vars, `~/.aws/credentials`, instance profile, ...)
   for the platform's own identity -- the trust policy `Principal` in the
   generated deploy-role template is resolved live from
   `sts:GetCallerIdentity`, never hardcoded. Run `aws sts get-caller-identity`
   first to confirm credentials are configured.

## Using it

1. Sign up at http://localhost:3000, then **Connect AWS**: one click opens
   CloudFormation in your account with AutoInfra's deploy-role template;
   create the stack and the connection verifies itself (no keys are ever
   pasted). Optionally **Connect GitHub** for private repos.
2. **New deployment**: paste a `https://github.com/<owner>/<repo>` URL.
   AutoInfra scans the repo, Gemini designs an architecture (F1 Lambda, F2
   EC2 + Docker Compose, or F3 static), writes Terraform, and the
   validation gauntlet (fmt, validate, tflint, trivy, plan, security and
   Free Tier policy) checks it, repairing up to 4 times.
3. Review the diagram, the plan and the Free Tier report, fill in any env
   vars it found, and **Approve & deploy**. Terraform applies, CodeBuild
   builds, and a health check through CloudFront gives you a live URL.
4. Afterwards, on the deployment page:
   - **Redeploy latest commit** after you push code (same infrastructure).
   - **Request a change** in plain words ("increase the disk to 25 GB");
     Gemini edits the live Terraform and you approve the exact plan.
     Pending changes can be discarded.
   - **Explain this failure** on a failed step.
   - **History**: every revision, its diff, and **Roll back to this**.
   - **Danger zone**: destroy everything, with a leftover check.
5. **Settings**: default Free Tier mode and your account's activity log.

Limits: sign-in attempts, signups, AI steps (30/hour per user) and new
deployments (20/day) are rate-limited, and one user can have at most
`MAX_RUNNING_JOBS_PER_USER` steps running at once. See
`docs/security-review.md`.

## AWS Free Tier

AutoInfra defaults to **strict** Free Tier mode: every resource it creates
must be Free-Tier-eligible, and the server independently re-validates every
Gemini-generated Terraform plan against a versioned policy
(`packages/free-tier-policy`, Milestone 3) -- the LLM's own assessment is
never trusted. See `KNOWN_LIMITATIONS.md` for the two AWS Free Tier regimes
(legacy 12-month vs. the 2025+ credit-based Free plan) and what that means
for account expiry.

## Monorepo layout

See `PLAN.md`.

## Testing

`pnpm -w test` (needs `docker compose up -d postgres redis` and a migrated
database first -- `pnpm --filter @autoinfra/api db:deploy`;
the API tests hit a real Postgres and Redis, and the terraform-runner and
pipeline tests run real Terraform, using `TF_PLUGIN_CACHE_DIR` from `.env`).
AWS and Gemini are faked in tests.
