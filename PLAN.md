# AutoInfra — Plan

GitHub repo → Free-Tier-friendly AWS infrastructure, designed by Gemini,
deployed automatically. This document is the in-repo roadmap, schema, and API
reference; it's kept up to date as milestones land (see `PROGRESS.md` for
what's actually done so far).

## Scope decisions (made at project start)

- Build the full spec from the brief, milestone by milestone, in order.
- Same AWS account doubles as both AutoInfra's own platform identity and the
  first connected "test user" account during development.
- AutoInfra itself (the platform) runs locally via `docker-compose` only; no
  production hosting of the platform is in scope.
- Data model and queries are multi-tenant-safe (every query scoped by
  `ownerId`) from Milestone 1 onward; heavy hardening (rate limits, audit log
  polish, concurrent-job limits) is the last milestone, matching the brief's
  own ordering.

## Milestones

1. **Monorepo scaffolding, docker-compose, auth, Prisma migrations, CI** — done, see `PROGRESS.md`.
2. **GitHub connect + AWS connect wizard** (role verification, CloudFormation template, Free Tier plan/usage detection) — done, see `PROGRESS.md`.
3. **Free Tier policy package** (`policy.json` + evaluator + tests) — done, see `PROGRESS.md`.
4. **Repo scanner** + `RepoProfile` + pattern hinting + fixtures — done, see `PROGRESS.md`.
5. **Gemini client + architecture design** + diagram + review UI with Free Tier badge — done, see `PROGRESS.md`.
6. **Terraform generation + full validation gauntlet + self-repair loop** — done, see `PROGRESS.md`.
7. **Worker execution**: state bootstrap, plan/approve/apply, log streaming, CodeBuild deploy (F1 & F2), health checks, hosted URL — done; F2 and F3 deployed on real AWS, F1 tested with fakes only (see `PROGRESS.md`).
8. Deployment history, revisions, diffs, redeploy — done, see `PROGRESS.md`.
9. Change-request flow (chat → diff → Free Tier check → approve → apply) + AI diagnosis — done, see `PROGRESS.md`.
10. Rollback + full destroy with leftover verification — done (destroy verified on real AWS; rollback tested with fakes), see `PROGRESS.md`.
11. Hardening: security review, rate limits, audit log, docs, e2e demo on both sample repos — all but the real-AWS e2e demo done, see `PROGRESS.md`.

## Monorepo layout

```
AutoDeplo/
  apps/
    web/          Next.js (App Router, TS, Tailwind, shadcn/ui, TanStack Query, Mermaid)
    api/          Fastify + TS + Zod + Prisma
    worker/       BullMQ worker; Terraform/tflint/trivy/git pinned in its Dockerfile
  packages/
    shared/               Zod schemas: RepoProfile, ArchitecturePlan, FreeTierReport, API types
    scanner/               deterministic repo analysis + shallow clone (done, Milestone 4)
    llm/                    Gemini client, mock client, redaction, design prompt + validated design loop (done, Milestone 5)
    aws/                    AWS SDK v3 helpers: STS (done), EC2 instance-type lookup (done), FreeTier (done); SSM, CodeBuild, Logs, Tagging, S3, CloudFront land as later milestones need them
    terraform-policy/      static HCL pre-flight checks + plan-JSON security policy (done, Milestone 6)
    free-tier-policy/      policy.json + evaluator (done, Milestone 3)
    terraform-reference/   platform-managed providers.tf/variables.tf, validated F1/F2/F3 reference projects, deploy-role CloudFormation template (done)
    pipeline/              worker job implementations: generate, apply -> build -> deploy -> health; job logs; source zip (Milestone 7)
    terraform-runner/      validation gauntlet (fmt, init, validate, tflint, trivy, plan, policies) + Gemini self-repair loop (done, Milestone 6; not in the original brief layout)
  examples/
    react-express-lambda/        F1 sample (Milestone 4/7)
    react-node-postgres-ws/      F2 sample (Milestone 4/7)
  docs/
```

## DB schema (Prisma — `apps/api/prisma/schema.prisma`)

Implemented in full in Milestone 1 (later milestones populate the json/text
fields that are currently unused):

- `User` — email, argon2 `passwordHash`, default `freeTierModeDefault`.
- `Session` — server-side session record behind the httpOnly session cookie (added beyond the brief's Sec. 7 list, since cookie sessions need a store).
- `GithubConnection` — one per user, encrypted access token, scopes.
- `AwsConnection` — `roleArn`, `externalId`, `region`, `accountRegime` (`legacy_12mo|free_plan|paid_plan`), `planStateJson`, `verifiedAt`.
- `Deployment` — `ownerId`, `awsConnectionId`, `repoUrl`, `branch`, `subdir`, `pattern` (`F1|F2|F3`), `freeTierMode` (`strict|flexible`), `status`, `currentRevisionId`, `liveUrl`, `region`.
- `Revision` — `deploymentId`, `number`, `commitSha`, `repoProfile`/`architecturePlan`/`freeTierReport`/`terraformBundle`/`planSummary` (json), `changePrompt`, `status`, `action` (`initial|change|rollback|redeploy`).
- `Job` / `JobLog` — pipeline job tracking + streamed log lines.
- `EnvVar` — `name`, `isSecret`, `ssmPath`.
- `FreeTierLedgerEntry` — `awsConnectionId`, `resourceKind`, `amount`, `deploymentId`.
- `LlmCall` — per-call token/latency/success logging.
- `AuditEvent` — `userId`, `action`, `targetType`, `targetId`, `metadata`.

Every query touching `Deployment`/`Revision`/`Job`/`EnvVar` filters by the
authenticated `ownerId` — see `apps/api/src/routes/deployments.ts` for the
pattern, and `apps/api/src/test/isolation.integration.test.ts` for the test
that proves it.

## API surface

Implemented: `/health`, `/auth/csrf`, `/auth/signup`, `/auth/login`,
`/auth/logout`, `/auth/me`, `/auth/github` + `/auth/github/callback` (login
and connect, same OAuth app), `/deployments` (GET), `/deployments/:id` (GET),
`/aws/connections` (GET/POST), `/aws/connections/:id` (GET),
`/aws/connections/:id/template` (GET), `/aws/connections/:id/role` (PATCH),
`/aws/connections/:id/verify` (POST), `/aws/connections/:id/regime` (POST),
`/aws/connections/:id` (DELETE, refuses while active deployments reference
it), `/deployments` (POST), `/deployments/:id/analyze` (POST),
`/deployments/:id/design` (POST), `/deployments/:id/generate` (POST, 202 + background job), `/jobs/:id/logs` (GET, polling by `seq`),
`/jobs/:id/logs/stream` (SSE), `/deployments/:id/env` (GET/PUT/DELETE),
`/deployments/:id/approve|redeploy|destroy` (POST),
`/deployments/:id/revisions` (+ `/:n`, `/:n/diff`),
`/deployments/:id/changes` (POST: change request) and
`/deployments/:id/changes/discard` (POST), `/deployments/:id/rollback`
(POST `{toRevision}`), `/jobs/:id/diagnose` (POST: Gemini explains a failed
job, cached), `/account/settings` (GET/PUT: default Free Tier mode),
`/account/audit` (GET, `?after=<id>&limit=` cursor paging).

Specified, not yet implemented: `pause|resume` (stretch).

## AWS connect wizard (Milestone 2)

- **Cross-account role, no access keys** (Sec. 3.1): the user downloads a
  CloudFormation template (`packages/terraform-reference/src/deploy-role-template.ts`)
  with a per-connection `ExternalId` pre-filled, creates the stack themselves
  in their own AWS account (console upload or CLI -- the template is not
  hosted anywhere AWS could fetch it from in local dev, so the "quick-create
  console link" pattern doesn't work yet; see `KNOWN_LIMITATIONS.md`), and
  pastes back the resulting role ARN. The trust policy's `Principal` is
  AutoInfra's own AWS account id, resolved live via `sts:GetCallerIdentity`
  against whatever ambient credentials the api process is running as --
  never hardcoded.
- **Verification** (`POST /aws/connections/:id/verify`) assumes the role,
  then tries `freetier:GetAccountPlanState`/`GetFreeTierUsage` and
  `ec2:DescribeInstanceTypes` (filtered to `free-tier-eligible=true`, so the
  instance type suggestion is never hardcoded per Sec. 2.1). A
  `ResourceNotFoundException` from `GetAccountPlanState` is treated as a
  reliable signal for a legacy (pre-July-2025) account, since that account
  plan resource simply doesn't exist for those accounts; any other failure
  (access denied, throttling) means "unknown," not "assume legacy."
- When the regime can't be determined automatically, the wizard asks the
  user directly (`POST /aws/connections/:id/regime`) -- this is surfaced in
  `apps/web/src/app/aws/connect/page.tsx`.
- `DELETE /aws/connections/:id` ("Disconnect AWS") is refused with 409 while
  any non-destroyed `Deployment` references the connection.

## Free Tier policy package (Milestone 3)

- `packages/free-tier-policy/policy.json`: versioned (`lastVerified` date +
  `sourceUrls`), re-verified via live web search against AWS's own pages
  (not solely training data) before writing it, not hand-waved from the
  brief's text alone. Holds the two regimes' limits, the Always Free
  service limits, and the Sec. 2.3 deny-list as data, not code -- updating a
  limit later doesn't require touching the evaluator.
- The evaluator works on a `NormalizedResource[]` (Terraform
  type/name/attributes), deliberately decoupled from how that list is
  produced. Milestone 3 has no real Terraform plans to parse yet (Milestone
  6 generates and runs Terraform), so its own tests construct
  `NormalizedResource[]` fixtures by hand -- the exact Sec. 12 test matrix
  (NAT Gateway, Fargate, ALB, Multi-AZ RDS, oversized instance, two EC2s on
  one account, 100 GB EBS, log group without retention, Secrets Manager, and
  three compliant F1/F2/F3 plans). When Milestone 6 parses real
  `terraform show -json` output into this same shape, the evaluator doesn't
  change.
- **Mode independence is deliberate**: `evaluateFreeTier` reports the same
  violations and `fit` regardless of `freeTierMode`. What `strict` vs.
  `flexible` actually _does_ (reject outright vs. show a cost-labelled
  confirmation per Sec. 2.1) is a pipeline-level decision for whichever
  milestone wires this into the apply flow (M6+), not something baked into
  the fact-reporting here.
- Traffic-dependent usage (Lambda invocations, S3/CloudFront requests, log
  volume) is reported as `0` with an explicit warning rather than guessed --
  it can't be known from a Terraform plan alone. Only statically-derivable
  usage (instance/resource counts and sizes) is projected.
- `estimatedMonthlyCostUsd` is always `0` for now (a strict-compliant plan
  is $0 by construction; a non-compliant plan's real cost depends on usage
  this function can't see) -- real cost modeling is a future improvement,
  not faked here.

## Open questions resolved at project start

- Scope/pacing, platform AWS account, platform hosting, and multi-tenancy
  priority were all resolved via `AskUserQuestion` before Milestone 1 began
  (see commit history / conversation for the decisions, summarized above).

## Terraform generation + validation gauntlet (Milestone 6)

- **Platform-managed files.** `providers.tf` (pinned `aws ~> 6.69`,
  `random ~> 3.9`, `backend "s3" {}`, `default_tags` with the four required
  tags) and `variables.tf` (the variables contract) are written by AutoInfra
  on every run; Gemini never writes them. Variable _values_
  (`autoinfra.auto.tfvars.json`) are decided by the platform from the
  deployment, the scan, and the verified connection -- never by the model.
- **Reference projects** for F1/F2/F3 live as real `.tf` files in
  `packages/terraform-reference/reference/` and are validated by tests
  (fmt, init, validate, tflint, trivy). They are Gemini's few-shot context.
- **Gauntlet order** (`packages/terraform-runner`): static pre-flight on the
  raw HCL (no provisioners, `external`/`http` data sources, modules, foreign
  providers, or `file()` outside the module -- checked _before_ any
  terraform command runs) → fmt (auto-fixed) → init → validate → tflint →
  trivy (HIGH/CRITICAL) → plan → security policy on the plan JSON → Free Tier
  policy on the plan JSON. Failures go back to Gemini with the exact errors,
  up to 4 attempts.
- **Trivy exceptions** (`TRIVY_FREE_TIER_EXCEPTIONS`) are limited to findings
  that contradict the Free Tier constraints: WAF (deny-listed), customer-
  managed KMS keys (deny-listed), and F2 internet egress (no NAT/VPC
  endpoints). They're recorded as notes on the gate, not hidden.
- **F1 Function URL auth** (decision made with the user): AWS_IAM + CloudFront
  OAC when the scanner finds no write routes; a public Function URL behind
  CloudFront when it does, because OAC to a Function URL breaks browser
  POST/PUT (AWS requires a client-computed payload hash). The review screen
  shows the risk. The plan policy enforces the platform's choice.
- **Tool isolation.** terraform/tflint/trivy run with an allowlisted
  environment (no platform secrets), shared AWS config files and instance
  metadata disabled, and only the assumed deploy-role credentials.
- Pre-approval plans use a local backend in a throwaway directory; the S3
  state bootstrap and apply are Milestone 7.

## Deploy pipeline (Milestone 7)

- **Where work runs.** Every step runs on the BullMQ worker (`apps/worker`,
  job code in `packages/pipeline`): analyze and design on the
  `deployment-prep` queue (concurrency 4, so they never wait behind an
  apply), generate/apply/destroy on `deployment-jobs` (concurrency 2). A
  step can chain the next ones (`then`): the paste-a-link flow sends one
  `POST /analyze {then: ["design","generate"]}`, and each finished step
  hands off to the next in the same transaction as it finishes. Queue
  payloads carry only ids -- never credentials; the worker assumes the
  deploy role itself.
  `attempts: 1` and `maxStalledCount: 0`: an interrupted infrastructure job
  is marked failed for the user to retry, never re-run blindly. On startup
  the worker sweeps jobs left `running` by a dead process.
- **Live logs.** Every line goes to `job_logs` (ordered by `seq`) and is
  published to Redis; `GET /jobs/:id/logs/stream` (SSE) replays the backlog
  after `Last-Event-ID`, then streams live lines and an `end` event.
- **Env vars** (`/deployments/:id/env`): values go straight to SSM in the
  user's account (`/autoinfra/<short_id>/<NAME>`, SecureString for secrets);
  AutoInfra stores names only. Platform/runtime names (`AWS_*`,
  `AUTOINFRA_*`, `PORT`, ...) are reserved. F1 loads them at cold start via
  the platform-owned `.autoinfra/autoinfra-env.mjs|py` (eval'd by
  `run.sh`); F2 via `deploy.sh` on the instance.
- **Approve** (`POST /deployments/:id/approve`) requires a passed bundle;
  strict mode refuses any Free Tier violation, flexible mode requires
  `confirmPaidResources`; env vars found in the repo without a value need
  `acceptMissingEnv`. Every approval is audited.
- **Apply job:** assume role → S3 state bucket bootstrap
  (`autoinfra-tfstate-<account>-<region>`, SDK-created, versioned, AES256,
  private, `use_lockfile`) → `init` with the S3 backend → fresh plan →
  security + Free Tier policy again → refuse anything not approved
  (`unapprovedChanges`: a subset is fine, so retries after a partial apply
  work) → `apply` the saved plan with streamed `-json` progress → outputs →
  free-tier ledger → clone the pinned commit, zip it with the generated
  files under `.autoinfra/`, upload to the artifacts bucket → CodeBuild
  (logs streamed from CloudWatch) → health checks through CloudFront
  (frontend `/` and the API health route via the same prefix the frontend
  uses; the 503 placeholder doesn't count) → `live` with the
  `https://*.cloudfront.net` URL. On failure: readable reason, Lambda logs
  for F1, and the same validated bundle can be retried.
