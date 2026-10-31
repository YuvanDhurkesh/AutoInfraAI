# Progress

## Milestone 1 — Monorepo scaffolding, docker-compose, auth, Prisma migrations, CI

Status: **done**

- Fixed a pre-existing git misconfiguration before starting: the repo at
  `C:\` was tracking the entire user profile with a remote pointing at an
  unrelated GitHub project. Left it untouched and `git init`'d a fresh,
  properly scoped repo inside `AutoDeplo/` (branch `main`).
- pnpm workspace + Turborepo set up (`pnpm-workspace.yaml`, `turbo.json`,
  shared `tsconfig.base.json`, flat ESLint config, Prettier).
- Scaffolded `apps/web` (Next.js App Router + Tailwind), `apps/api` (Fastify +
  Zod + Prisma), `apps/worker` (BullMQ skeleton + Dockerfile with Terraform
  1.15.8, tflint, trivy, git pinned).
- Stubbed `packages/scanner`, `packages/llm`, `packages/aws`,
  `packages/terraform-policy`, `packages/free-tier-policy`,
  `packages/terraform-reference` — each a real workspace package with a
  milestone marker, so the dependency graph resolves now and later
  milestones only add implementation.
- `packages/shared`: Zod schemas for auth, deployment enums, `RepoProfile`,
  `ArchitecturePlan`, `FreeTierReport`, `CreateDeploymentInput`/`DeploymentSummary`.
- Prisma schema implementing the full data model from `PLAN.md` (one model,
  `Session`, added beyond the brief's list — needed for httpOnly cookie
  sessions).
- Auth: argon2 password hashing, email+password signup/login, httpOnly signed
  session cookie backed by the `Session` table, double-submit CSRF cookie
  (GitHub OAuth deferred to Milestone 2 — doc with setup steps is at
  `docs/github-oauth-setup.md` since the OAuth app doesn't exist yet).
- `/deployments` and `/deployments/:id` wired with the owner-scoped query
  pattern every later deployment route must follow.
- Tests: argon2 round-trip, CSRF token matching, and an integration test
  proving user A cannot read user B's deployment through the API (also
  checks CSRF rejection on a real mutating route).
- `docker-compose.yml` (postgres, redis, api, worker, web) + Dockerfiles for
  each app; `.env.example`; GitHub Actions CI (typecheck, lint, prisma
  migrate, test against real postgres/redis services).
- `.env` already had `GEMINI_API_KEY`/`GEMINI_MODEL`/`AWS_REGION` from the
  user; added the remaining local-dev variables (`DATABASE_URL`,
  `REDIS_URL`, `WEB_ORIGIN`, freshly generated `COOKIE_SECRET` /
  `ENCRYPTION_KEY`, empty GitHub OAuth placeholders).

### Verification performed this session

- Found Docker Desktop wasn't running; started it and confirmed the daemon
  came up before using `docker compose`.
- `pnpm install` — succeeded (had to approve native build scripts for
  `argon2`/`sharp`/`esbuild`/prisma via `pnpm-workspace.yaml`'s
  `onlyBuiltDependencies`, since pnpm 10+ blocks these by default).
- Fixed `tsc -b --noEmit` failing on every package that references
  `packages/shared` (TS6310: a composite referenced project "may not disable
  emit") by changing `typecheck` to plain `tsc -b` for all referencing
  packages — `pnpm -w typecheck` passes across all 10 packages.
- Fixed a worker typecheck error from `ioredis`'s default-export interop
  under `NodeNext` by importing the named `Redis` export instead.
- `pnpm -w lint` passes across all 10 packages.
- `docker compose up -d postgres redis` — discovered a **pre-existing native
  Windows Postgres service already bound to host port 5432**, silently
  intercepting connections meant for the container (TCP connected, but auth
  always failed with no matching error in the container's own logs). Remapped
  compose's host ports to 5433 (postgres) and 6380 (redis) rather than
  touching the existing native service; updated `.env`/`.env.example`
  accordingly. Internal container-to-container networking (api/worker →
  `postgres:5432`/`redis:6379`) is unaffected.
- `pnpm --filter @autoinfra/api exec prisma migrate dev --name init` —
  applied cleanly against the remapped Postgres.
- Fixed `pnpm -w test`: Turborepo 2.x defaults to strict env-var filtering,
  which silently dropped `DATABASE_URL`/`COOKIE_SECRET`/`ENCRYPTION_KEY` from
  test tasks even though they were exported in the shell. Set
  `"envMode": "loose"` in `turbo.json`. Also fixed the env schema rejecting
  empty-string optional vars (`GITHUB_CLIENT_ID=` with no value) by
  preprocessing empty strings to `undefined` before validation.
- `pnpm -w test` — **all 11 tasks pass** (9 real tests in `apps/api`
  including the multi-tenant isolation test and CSRF rejection test; the
  remaining packages are intentional Milestone-2+ stubs using
  `--passWithNoTests`; `packages/shared` has 4 schema tests).
- `pnpm -w build` — all 10 packages build, including a full Next.js
  production build of `apps/web`.
- Manual smoke test: ran the API directly (`tsx src/index.ts`), then via
  `curl`: `/health` → `200`, `/auth/csrf` → sets cookie, `/auth/signup` → 201
  - session cookie, `/auth/me` → 200 with the signed-up user, `/auth/logout`
    without a CSRF header → 403, with the correct header → 200. Stopped the
    dev server afterward.

## Milestone 2 — GitHub connect + AWS connect wizard

Status: **done**

- Confirmed `@aws-sdk/client-freetier` (the AWS Free Tier API client) exists
  on npm with the exact `GetAccountPlanStateCommand`/`GetFreeTierUsageCommand`
  shape the brief describes, before building around it -- pinned it and
  `@aws-sdk/client-sts`/`@aws-sdk/client-ec2` at `3.1152.0`.
- `packages/aws`: `assumeDeployRole`/`getCallerIdentity`/`getPlatformAccountId`
  (STS), `listFreeTierEligibleInstanceTypes` (EC2, filtered by
  `free-tier-eligible=true` -- never a hardcoded instance type),
  `getAccountPlanState`/`getFreeTierUsage` (FreeTier, with the
  `ResourceNotFoundException` → `legacy_12mo` inference described in
  `PLAN.md`).
- `packages/terraform-reference`: `buildDeployRoleTemplate` generates the
  `AutoInfraDeployRole` CloudFormation YAML (Sec. 3.1/3.2 permission scope,
  explicit deny on Organizations/Account/IAM-user-creation as a safety net).
- GitHub OAuth (`apps/api/src/routes/github.ts`): one app, two flows on the
  same callback -- "log in with GitHub" (no session) vs. "connect GitHub"
  (existing session), disambiguated by whether a valid session cookie is
  already present when the callback runs. Login-only GitHub users get a
  synthetic `.invalid`-domain email (GitHub's `read:user` scope doesn't grant
  real email access). Access token stored AES-256-GCM-encrypted
  (`apps/api/src/lib/crypto.ts`, `ENCRYPTION_KEY`).
- AWS connect wizard (`apps/api/src/routes/aws.ts` +
  `apps/web/src/app/aws/connect/page.tsx`): create a pending connection
  (generates `externalId`) → download the CFN template → paste the role ARN
  → verify (assumes the role, detects Free Tier regime, lists eligible
  instance types) → if regime detection failed, ask the user directly →
  "Connected" status card. Disconnect refuses with 409 while any
  non-destroyed deployment references the connection.
- Changed `AwsConnection.roleArn` to nullable in the schema (a connection now
  starts "pending" before the user has created/pasted their role) --
  migration `20261016084615_aws_connection_role_arn_nullable`.
- Added `API_BASE_URL` env var (builds the GitHub OAuth callback URL).

### Verification performed this session

- `pnpm -w typecheck`, `pnpm -w lint`, `pnpm -w build`, `pnpm -w test` all
  pass (13 tasks; 15 tests in `apps/api`, including 6 new tests for the AWS
  connect wizard that mock `@autoinfra/aws` so CI needs no real AWS
  credentials -- covers malformed-ARN rejection, template content, both
  branches of the regime-detection fallback, and the disconnect-refusal/
  success cases).
- **Manually smoke-tested against the real, already-configured local AWS
  credentials** (not mocked): `GET /aws/connections/:id/template` correctly
  resolved the platform's live AWS account id via a real
  `sts:GetCallerIdentity` call and embedded it as the trust policy
  `Principal`; `POST /aws/connections/:id/verify` against a role ARN that
  doesn't exist yet correctly failed with a clear `assume_role_failed`
  message from a real `sts:AssumeRole` call. Deliberately did **not** create
  the actual CloudFormation stack/IAM role in the live AWS account myself --
  that's a real, consequential account change the user should trigger
  through the wizard when they're ready, not something to do unprompted.
- Found and fixed two Prisma `Json` field typing issues (`Prisma.JsonNull`
  for explicit nulls; round-tripping AWS SDK responses through
  `JSON.parse(JSON.stringify(...))` since they can contain `Date` objects,
  which aren't valid `Json` input directly).

### Still open for a future milestone

- No GitHub repo-URL input/analysis flow yet (Milestone 4).
- The CloudFormation "quick-create" console link isn't generated -- it needs
  the template hosted somewhere AWS's backend can fetch it from (e.g. S3),
  which doesn't exist for a local-only platform. The downloadable
  file + manual "upload a template" console flow works today; see
  `KNOWN_LIMITATIONS.md`.
- No settings-page endpoint for `User.freeTierModeDefault` yet (the field
  exists; per-deployment `freeTierMode` is what Milestone 4+ will actually
  use).

## Milestone 3 — Free Tier policy package

Status: **done**

- Before writing `policy.json`, ran live web searches against AWS's own
  pages (`aws.amazon.com/free/*`, `docs.aws.amazon.com/.../free-tier.html`)
  rather than trusting training data alone, since the brief explicitly warns
  these terms change. Confirmed the brief's numbers (legacy 750 EC2/RDS
  hrs/mo, 20GB RDS storage, 30GB EBS, 5GB S3; Always Free Lambda 1M
  requests + 400K GB-seconds, DynamoDB 25GB + 25/25 RCU/WCU, CloudFront 1TB +
  10M requests; new-model $100-$200 credits, 6-month Free plan,
  auto-close-if-not-upgraded) against multiple sources, including AWS's own
  "what's new" post for the July 2025 change. `policy.json` carries the
  `lastVerified` date and source URLs so this can be re-checked later
  without re-deriving it from scratch.
- `packages/free-tier-policy`: `evaluateFreeTier()` takes a
  `NormalizedResource[]` (Terraform type/name/attributes -- decoupled from
  how that list is produced, since real Terraform plan parsing doesn't
  exist until Milestone 6) plus `freeTierMode`, an optional
  `existingAlwaysOnEc2Count` (for the Sec. 2.4 shared-EC2-per-account rule),
  and the live `eligibleInstanceTypes` list from `@autoinfra/aws`. Returns
  `@autoinfra/shared`'s `FreeTierReport` shape directly.
- Deliberately **mode-independent fact reporting**: `strict` and `flexible`
  produce identical violations/fit from this function; gating behavior
  (reject vs. ask for cost-labelled confirmation) is left to whichever
  future milestone wires this into the apply pipeline.
- Deny-list checks (NAT Gateway, ECS Fargate, ALB/NLB, API Gateway, Multi-AZ
  RDS, Aurora, ElastiCache, OpenSearch, EKS, Route 53 zones, WAF,
  customer-managed KMS, Secrets Manager, unattached EIP) plus structural
  checks (EBS total > 30GB, RDS storage > 20GB, CloudWatch log group with no
  retention policy, instance type not in the live eligible list, and the
  shared single-always-on-EC2-per-account rule).
- Usage projection is honest about what a static Terraform plan can't tell
  you: EC2/RDS hours and EBS/RDS storage are computed from resource counts
  and sizes; Lambda invocations, S3/CloudFront requests, and log volume stay
  `0` with an explicit warning rather than being guessed.

### Verification performed this session

- Wrote the exact test matrix from Sec. 12 of the brief as real tests: all
  nine named non-compliant cases (NAT Gateway, Fargate, ALB, Multi-AZ RDS,
  oversized instance, two EC2s on one account, 100GB EBS, log group without
  retention, Secrets Manager) assert `fit: "exceeds"`; three compliant F1/F2/F3
  plans assert `fit: "within_limits"` with zero violations; one test asserts
  `strict` and `flexible` report identical facts. 14/14 pass.
- `pnpm -w typecheck`, `pnpm -w lint`, `pnpm -w build`, `pnpm -w test` all
  pass across all 13 tasks (shared+free-tier-policy+api test totals: 33
  tests).

## Milestone 4 — Repo scanner

Status: **done**

- `packages/scanner`: deterministic, no-LLM analysis producing
  `@autoinfra/shared`'s `RepoProfile`. Detectors for frontend framework
  (react-vite / CRA / Next / Vue / Angular / static), Next.js SSR vs.
  static export, the framework's API base-URL env var convention, hardcoded
  `localhost` URLs, backend language/framework (Node: Express/Fastify/Nest;
  Python: FastAPI/Flask/Django; Go/Java language-only), port, health route,
  `/api` prefix, WebSocket use, local-disk persistence, primary datastore,
  env vars (from `.env.example` + `process.env.*`/`os.environ`), and secrets.
- Pattern hinting: backend present → F1 if Lambda-compatible (stateless
  HTTP, no WebSockets, no local disk) else F2; Next.js SSR with no separate
  backend → F2 (Sec. 11: "SSR only via F2"); any other frontend-only → F3.
- Unsupported-workload reasons: nothing detectable, MongoDB (no
  DynamoDB-compatible rewrite path), likely GPU/ML deps.
- Monorepos: an explicit `subdir` is respected; without one, common layouts
  (`frontend|client|web|app` + `backend|server|api`) are auto-detected and
  merged into one profile.
- Secret detection reports _that_ a file looks suspicious (committed `.env`,
  AWS key ID, private key block, GitHub/Slack/Stripe tokens), never the value.
- `cloneRepo`: shallow clone into a temp dir, optional pinned `commitSha`,
  GitHub token injected into the URL for that clone only, returns the
  resolved SHA plus a `cleanup()`. Shells out to `git` (already in the worker
  image) rather than adding a dependency.
- Two full runnable `/examples` apps are still deferred to Milestone 7, when
  they're actually deployed; Milestone 4 uses lighter test fixtures.

### Verification performed this session

- All 8 fixture repos from Sec. 12 of the brief as real tests (React+Express,
  Vite+Fastify, Next.js SSR+Postgres, static-only, monorepo with and without
  an explicit subdir, hardcoded localhost, repo with secrets, WebSockets →
  F2). The secrets test asserts the fake key and fake password strings never
  appear anywhere in the serialized `RepoProfile`. 8/8 pass.
- Real network smoke test: `cloneRepo` against the public
  `octocat/Hello-World` repo -- cloned, resolved the commit SHA, scanned
  (correctly reported "no recognizable frontend or backend" for a
  README-only repo), and cleaned up the temp dir.
- The fake secrets fixture's `.env` needed a narrow `.gitignore` exception
  (the root ignores all `.env` files), otherwise the test would silently pass
  locally and fail in CI with the file missing.
- `pnpm -w typecheck`, `lint`, `test`, `format:check` all pass (13 tasks).

## Milestone 5 — Gemini client + architecture design + review UI

Status: **done**

- `packages/llm`:
  - `LlmClient` interface returning raw JSON text; all validation happens in
    the callers, so every model output goes through the same Zod gate.
  - `GeminiClient` (`@google/genai` 2.30.0): model from `GEMINI_MODEL`, JSON
    output via `responseJsonSchema` generated from the Zod schema,
    exponential backoff on 429/5xx, and a per-call logger (wired to the
    `llm_calls` table: purpose, model, token counts, latency, success).
  - `MockLlmClient`: replays canned responses per purpose and records
    requests, so CI never needs a key (Sec. 12).
  - `redactProfileForLlm`: Gemini sees the scanner's structured findings
    only -- no file contents, no `.env` values, URL credentials stripped,
    secret findings reduced to a count.
  - `designArchitecture`: system prompt carries the F1/F2/F3 catalog, the
    deny-list and limits from `policy.json`, and the account's live
    Free-Tier-eligible instance types; the repo profile is wrapped in
    `<repo_profile>` tags as untrusted data. Each response is Zod-validated
    and, in strict mode, checked by the server's own Free Tier evaluator;
    failures go back to the model with the exact errors, up to 3 attempts.
    Unsupported repos are refused before any model call.
- `ArchitectureComponent` now carries the sizing fields the evaluator checks
  (instance type, storage, Multi-AZ, log retention), and
  `architectureToResources` maps a design onto the evaluator's resource
  shape, so a design is judged before any Terraform exists.
- API: `POST /deployments` (GitHub-only URLs, safe branch/subdir validation,
  verified AWS connection required), `POST /deployments/:id/analyze`
  (clone with the user's GitHub token if connected, scan, store the
  revision), `POST /deployments/:id/design` (Gemini design + server-computed
  `FreeTierReport`). One running job per deployment, enforced via `Job` rows
  in a serializable transaction. Both steps run inline in the request for
  now; Milestone 7 moves them to the worker.
- Web: new-deployment form, deployment page with a step indicator, scan
  summary (including hardcoded-localhost and committed-secret warnings),
  Mermaid diagram (rendered with `securityLevel: "strict"`, since the source
  is LLM output derived from an untrusted repo), Free Tier badge, per-resource
  eligibility table, risks/assumptions. Dashboard now lists deployments.
- Schema: `Deployment.allowRds` (F2+RDS opt-in) and
  `Deployment.failureReason`.

### Verification performed this session

- 8 new `llm` tests (mock client): happy path, malformed JSON / schema
  failures retried with errors fed back, a NAT Gateway rejected in strict mode
  and sent back to the model, the same design allowed in flexible mode, give
  up after 3 attempts, unsupported repos never reach the model, and the
  prompt contains the untrusted-data wrapper but not URL credentials or
  secret locations.
- 7 new API integration tests: non-GitHub/SSRF-style URLs and `../` subdirs
  rejected, unverified AWS connection refused, full analyze→design flow with
  a stored server-side report, unsupported repo fails without a model call,
  clone errors never leak the tokenized URL, one-job-at-a-time lock, and
  another user can't analyze/design or use someone else's AWS connection.
- **Two real Gemini calls** with the configured `GEMINI_MODEL`: a direct
  `designArchitecture` call (React + Express + DynamoDB → valid F1 with a
  Lambda Function URL and no API Gateway/NAT), and a full HTTP end-to-end run
  -- real clone of `octocat/Spoon-Knife` pinned to its commit, scanned as
  static → F3, Gemini proposed S3 + CloudFront + OAC, server report
  `within_limits`, and the call was logged to `llm_calls`. The e2e run used a
  hand-inserted "verified" AWS connection row in the local dev database,
  since no real deploy role exists yet and this milestone makes no AWS calls.
- Started the Next.js dev server and confirmed `/`, `/dashboard`,
  `/deployments/new`, `/deployments/:id`, and `/aws/connect` all compile and
  return 200 with no errors in the log. **Not verified in a real browser** --
  no browser tool was available in this session, so the Mermaid rendering
  and the click-through flow still need a manual look.
- Found and fixed: `NODE_ENV=development` in `.env` (added in Milestone 1)
  breaks `next build` with an `<Html>` prerender error for anyone who
  exports `.env` into their shell. Removed it from `.env` and `.env.example`
  (the API already defaults to development).
- Explicitly denied (rather than approved) install scripts for
  `@google/genai` and `protobufjs` after reading them: one is a no-op
  version warning, the other references a script not shipped in the package.
- All 56 tests pass across 16 tasks; typecheck, lint, build, and format all
  pass.

## Milestone 6 — Terraform generation + validation gauntlet + self-repair

Status: **done**

- Checked current versions before pinning them instead of guessing: AWS
  provider 6.69.1, random 3.9.1, Lambda Web Adapter layer **30** (from the
  official awslabs README -- web search results only showed stale mirrors at
  25), CodeBuild Amazon Linux 2023 standard image 6.0.
- Verified two design points against AWS docs before building on them:
  1. CloudFront OAC to a Lambda Function URL requires the _client_ to send a
     SHA-256 payload hash on POST/PUT, which breaks normal browser apps.
     Asked the user; decision: AWS_IAM + OAC for read-only APIs, a public
     Function URL behind CloudFront for APIs with write routes (scanner now
     detects write routes; unknown counts as "has writes").
  2. Since October 2025, new Function URLs need both `InvokeFunctionUrl` and
     `InvokeFunction` permissions -- both are in the reference, using the
     `invoked_via_function_url` argument confirmed from the provider schema.
- `packages/terraform-reference`: platform-managed `providers.tf` /
  `variables.tf`; real, validated F1/F2/F3 reference projects (S3 + OAC +
  CloudFront Function SPA fallback, Lambda Web Adapter with a placeholder
  zip, Function URL, DynamoDB, CodeBuild, single-EC2 VPC with the CloudFront
  prefix list, IMDSv2, one attached EIP, Caddy origin-secret check, ECR with
  scan-on-push and immutable tags, SSM rollout).
- `packages/terraform-policy`: static pre-flight HCL checks and the plan-JSON
  security policy (providers, wildcard IAM, IAM users/keys, dangerous managed
  policies, public S3, world-open ingress, required tags, provider _and
  per-resource_ region -- the latter found from the v6 provider schema --
  and the platform-chosen Function URL auth type); plan → Free Tier
  evaluator converter; plan summary with data-loss flags.
- `packages/llm`: `generateTerraform` (platform files + reference project +
  plan + redacted profile; repair rounds get the previous files and exact
  gate errors).
- `packages/terraform-runner` (new): the gauntlet and the 4-attempt repair
  loop, tool resolution (native binary, else the same pinned version via
  Docker, else "skipped"), a deterministic placeholder Lambda zip written
  in-process, and a minimal child-process environment.
- API: `POST /deployments/:id/generate` (fails fast if the deploy role
  can't be assumed, then runs in the background and returns 202),
  `GET /jobs/:id/logs` (ordered by a new `job_logs.seq` column).
- Web: generate button, live validation console, gate results, plan summary
  with data-loss warnings, Terraform file viewer, public-Function-URL risk
  notice, and a disabled "Approve & deploy" (Milestone 7).
- Fixed the Milestone 2 deploy-role CloudFormation template, which was
  missing permissions Terraform needs (`s3:PutBucketTagging` for the
  required tags, `ec2:ModifyVpcAttribute`, CloudFront Function APIs, the
  public AMI SSM parameter, and read-only Get/List/Describe for refresh).
  AWS `validate-template` accepts it; the wizard now mentions the
  CAPABILITY_NAMED_IAM acknowledgement it requires.

### Verification performed this session

- All three reference projects pass fmt, init, validate, tflint and trivy
  with the real AWS provider (tflint/trivy via Docker at the worker image's
  pinned versions). Trivy's first run flagged WAF and customer-managed KMS
  (both deny-listed by the Free Tier policy -- recorded as exceptions), plus
  two genuine F2 issues that were fixed in the reference (ECR scan-on-push,
  immutable tags) and unavoidable F2 egress (narrowed to 80/443, recorded).
- **Real `terraform plan` (read-only, nothing created)** with the
  developer's local AWS credentials: F1 reference +25 resources, F2 +35;
  both pass the security and Free Tier policies on real plan JSON. A
  deliberately broken F1 (missing public access block, no log retention,
  cross-region table) is caught on a real plan by trivy, the security
  policy, and the Free Tier policy independently.
- **Real Gemini end to end** (`packages/terraform-runner/scripts/e2e-generate.mjs`):
  - F1 (React + Express with write routes + DynamoDB): Gemini's Terraform
    passed all 9 gates on the first attempt; real plan +25, `within_limits`.
    2 Gemini calls, ~15K tokens.
  - F2 (React + Express + WebSockets + Postgres): attempt 1 failed trivy
    because Gemini's generated Dockerfile ran as root; the error went back,
    attempt 2 fixed it and passed all 9 gates; real plan +35,
    `within_limits`. 7 Gemini calls, ~42K tokens.
- New automated tests: 13 more policy tests (static pre-flight cases, wildcard
  IAM, public S3 vs. the CloudFront OAC bucket policy, open ingress, tags,
  region incl. per-resource region, Function URL auth, plan → evaluator
  quirks), 3 tfvars tests, 4 API tests for `/generate` (fail fast before
  spending tokens when the role can't be assumed; background run stores the
  bundle and reaches `awaiting_approval`; failures keep artifacts; job logs
  are owner-scoped), and 5 runner tests that run real Terraform (placeholder
  zip determinism, static gate stops before any terraform command, F1 and F2
  references pass every pre-plan gate, and the generate → gauntlet → repair
  loop with a mock LLM).
- Full suite: **92 tests pass across 19 tasks**; typecheck and lint pass.
- CI now installs Terraform 1.15.8 (with `terraform_wrapper: false`, which
  would otherwise break `-json` parsing).

## Milestone 7 — Worker execution, approve, deploy, live URL

Status: **built and tested with fakes; first real deploy pending** (needs the
AutoInfraDeployRole, which doesn't exist in the account yet -- checked with a
read-only `iam:GetRole`).

- `packages/pipeline` (new): worker job implementations. `generate` (moved
  from the API's in-process task), and `apply`: state bucket bootstrap →
  re-plan + re-check + approval-drift check → apply with streamed progress
  → outputs + free-tier ledger → pinned-commit source zip with generated
  files under `.autoinfra/` → CodeBuild with streamed logs → health checks
  through CloudFront → `live`. Also owns `buildTfVars` and the secret
  encryption helper (moved from the API so the worker can use them).
- `packages/aws`: state bucket bootstrap, S3 upload, CodeBuild run + log
  streaming, recent CloudWatch log lines, SSM parameter put/delete.
- `packages/terraform-runner`: `applyBundle` (S3 backend, re-check, drift
  check, `apply -json`), streaming exec, deflate in the zip writer, and a
  gauntlet check that required outputs exist.
- `packages/terraform-reference`: generated files now go to `.autoinfra/`
  in the build source (repos often have their own `app/`, e.g. Next.js);
  platform-owned SSM env loaders (`autoinfra-env.mjs`/`.py`) that only
  export valid identifiers and shell-quote values; IAM grants on the SSM
  path itself (GetParametersByPath authorizes against it); F2 buildspec waits
  for the instance to register with SSM before rolling out.
- `apps/worker`: BullMQ worker with real dependencies, `attempts: 1` /
  `maxStalledCount: 0`, startup sweep for jobs left running by a dead process.
- API: generate now enqueues; `PUT/GET/DELETE /deployments/:id/env`,
  `POST /deployments/:id/approve` (strict/flexible cost gate, missing-env
  confirmation, audited), `GET /jobs/:id/logs/stream` (SSE). `pnpm dev` for
  api and worker now loads `.env` via `--env-file`.
- Web: env-var form, approve panel (with missing-env and paid-resource
  confirmations, and "Retry deploy" after a failed deploy), live SSE
  console, live URL card with copy.
- docker-compose: worker gets a Terraform plugin cache volume and the
  host's AWS credentials read-only (platform identity for AssumeRole only).

### Verification performed this session

- 10 new API integration tests driving the real routes and real pipeline
  code end to end with fakes: fail fast without the role; platform-decided
  tfvars; failed validation keeps artifacts; env values go to SSM and never
  appear in AutoInfra's DB, API responses or audit log; reserved names
  refused; approve refuses before validation, asks about missing env vars,
  then deploys to a live URL (state bucket/key, approved plan passed to
  apply, source upload, health checks on `/` and `/api/health`, audit
  events); flexible mode requires paid-resource confirmation and strict
  refuses; a failed build fails with a readable reason and can be retried;
  a failed health check surfaces the Lambda logs; SSE replays backlog and
  ends, other users get 404.
- 5 new pipeline unit tests: approval drift (subset OK; new resources,
  destroys and create→replace refused), source zip (overlay, skips
  `.git`/`node_modules`, keeps the repo's own `app/`, deflate round-trip,
  executable LF `run.sh`), health path mapping and placeholder detection.
- Live plumbing against real processes: started the real worker (it swept
  10 stale `running` jobs, including one planted for the test, marking them
  failed with a retry message) and the real API; an SSE client received the
  DB backlog, then a line published to real Redis, then the `end` event.
- Found and fixed: the health poller's wall-clock loop spun at full speed
  with an injected sleep and ran a test worker out of memory -- it's now
  bounded by attempt count.
- Full suite: **103 tests pass across 21 tasks**; typecheck, lint and the
  production build pass.

## One-click connect + paste-a-link flow (between M7 and M8)

Goal from the user: **Paste GitHub URL -> Connect AWS -> Approve permissions
once -> Review deployment -> Deploy.** No access keys, no ARN pasting.

### What was built

- **Connect AWS is one click.** `POST /aws/connections` (and
  `GET /aws/connections/:id/connect-link`) return a CloudFormation
  quick-create console URL with the template, ExternalId, ConnectionId and
  role name already filled in. The user ticks the IAM acknowledgement and
  clicks _Create stack_ -- that's the "approve permissions once".
- **The stack reports back by itself.** The template now contains a
  `Custom::AutoInfraRegistration` resource whose ServiceToken is the
  platform's SNS topic. SNS -> SQS -> the worker's registration poller ->
  `handleRegistration` (packages/pipeline/src/connection.ts): it checks
  ConnectionId + ExternalId (the topic is publicly publishable, so the
  ExternalId is the secret), sets the role, proves it with a real
  `sts:AssumeRole` (8 attempts, 5s apart, for IAM propagation), detects the
  Free Tier plan, and answers CloudFormation SUCCESS. Anything wrong answers
  FAILED, so the stack rolls back instead of leaving a half-connected role.
  Deleting the stack makes AutoInfra forget the role.
- **Platform resources** (`packages/aws/src/platform.ts`, created on demand
  in the platform region): private S3 bucket for the template (served via a
  1-hour presigned URL), SNS topic `autoinfra-registrations`, SQS queue
  subscribed to it.
- **Web:** `ConnectAws` component (button -> new tab -> waits for
  verification, manual download/paste kept under "Do it manually instead").
  `/deployments/new` is now one URL field; connect appears inline once the
  URL looks valid; options are collapsed. Creating the deployment runs
  analyze -> design -> generate & validate automatically and stops at the
  review screen, whose one action is **Approve & deploy**.

### Verification

- 6 new integration tests (quick-create link; SUCCESS path; wrong
  ExternalId -> FAILED and nothing saved; un-assumable role -> FAILED after 8
  attempts; stack delete clears the role; junk messages ignored).
- Full suite **104 tests pass**; typecheck, lint, production build pass.
- Not yet done against real AWS: creating the platform resources and a real
  click-through of the quick-create link (needs the user's go-ahead).

## Milestone 8 -- history, revisions, diffs, redeploy

Also in this round: **real end-to-end deploy on AWS** and **backend sample apps**.

### Real deploy (first one on the user's account)

- One-click connect for real: the user clicked Create stack; the stack's
  registration resource reached the worker over SNS -> SQS, AutoInfra
  assumed the new role and verified it ~40 s later (account plan detected:
  Paid). No ARN or keys pasted.
- `octocat/Spoon-Knife` went from pasted link to live
  (`https://dfvz8atfbvoyw.cloudfront.net`, 200): Gemini's F3 Terraform passed
  all 9 gates on the first attempt; apply, CodeBuild, invalidation and the
  health check passed.
- Fixed from the run: signed-out pages showed "unauthenticated" instead of
  sending you to log in (now `/login?next=...` and back); the job console
  duplicated every line after a job finished (React duplicate-key errors).

### Backend sample apps (examples/)

- `react-express-lambda`: Vite React + Express notes API with a POST route
  -> F1 (Lambda + public Function URL behind CloudFront).
- `react-node-postgres-ws`: Vite React + Express + ws chat with Postgres and
  its own non-root Dockerfile -> F2 (EC2 + Docker Compose + Caddy).
- Both verified locally (API, Postgres migration, live WebSocket push);
  scanner tests assert their patterns. Real AWS deploys need them on GitHub.

### Milestone 8

- `GET /deployments/:id/revisions` -- every revision with action, derived
  status (`live now`, `superseded`, `abandoned`, `failed`...), commit, pattern
  and plan counts.
- `GET /deployments/:id/revisions/:n` and `.../:n/diff?against=m` -- commit
  change (with a GitHub compare link), architecture components added /
  removed / changed, and per-file Terraform line diffs (dependency-free LCS
  diff in `@autoinfra/shared`).
- `POST /deployments/:id/redeploy` -- fetches the branch head, re-scans it,
  refuses if the app's shape changed (pattern) and asks about new env vars,
  then creates a `redeploy` revision that reuses the live infrastructure with
  an approved plan of **no changes**. Any drift is refused by the apply step
  with a clear message, and the site keeps serving the previous revision.
- Re-analyzing a live deployment now creates a new `change` revision instead
  of overwriting anything that was applied.
- Web: History section with "View changes" diffs; live card shows the
  serving revision, stays visible during/after a failed update, and has
  "Redeploy latest commit"; env vars can be edited on live deployments.

### Verification

- 7 diff unit tests; 5 new API integration tests (redeploy refused before
  live; redeploy ships the new commit with a no-change plan and records
  history; drift refused with the site still on the old revision and nothing
  built; file + component diffs; history is owner-only).
- Full suite **123 tests pass**; typecheck, lint, production build pass.

## First real backend deploy: React + Express + MySQL on F2 (2026-10-20)

Repo: github.com/Sabryilyas/todo-app-assessment (frontend/ + backend/ with its
own Dockerfile, MySQL, database/init.sql). Live at
https://d278zg2kgdocoh.cloudfront.net -- verified through CloudFront: page
200, list returns the init.sql seed rows, create + complete a task from the
browser origin (CORS allowed), read back from MySQL.

Getting there surfaced (and fixed, each with a prompt rule and/or a static
gate check so the model can't repeat it) these AutoInfra gaps:

- SQL/Redis apps were routed to Lambda (nowhere to run the database) -> F2
- Schema scripts weren't shipped; their database name wasn't known
  (Gemini guessed "tododb", then the detector read "if" from a comment)
- Repo layout (frontend/, backend/, backend/Dockerfile) wasn't passed on;
  the first buildspec built at the repo root
- DB password referenced an undefined POSTGRES_PASSWORD -> platform-generated
  AUTOINFRA_DB_PASSWORD in SSM
- Env vars AutoInfra knows (DB__, CLIENT_URL, NODE_ENV, VITE_API_URL) were
  asked of the user; CLIENT_URL: "_" in compose overrode the live URL
- Instance and build roles lacked s3:ListBucket for recursive copies
- Pre-approval plans ignored real state, so every retry after a partial
  apply would be refused as "unapproved"; now planned against S3 state
- Volume name / DB user drifted between generations (each drift = empty DB
  or locked-out app); now fixed by the platform (dbdata, root/app)
- Health route outside /api was probed as /api/health
- Gemini 503 spikes (longer backoff), daily free-tier quota (no retry, says
  when it resets); Terraform provider cache actually used (init 3.5 min ->
  seconds); stale role sessions refreshed per repair attempt

## Milestone 10 (part 1) verified on real AWS (2026-10-20)

- Permission update: the user ran the "Update permissions" command; the
  stack's registration resource reported TemplateVersion 3 and the
  connection's notice cleared on its own.
- Destroy of the live F2 todo app (44 resources): terraform destroy removed
  37 managed resources in 4.5 min (CloudFront 2m50s, instance, buckets with
  their versioned contents, ECR), then 2 SSM values; status "destroyed".
- Independent check: instance terminated, volume/EIP/VPC/SG/buckets/
  CloudFront/SSM all gone. The leftover scan had reported 5 items -- all
  stale tag-API entries (deleted SG rules, the terminated instance, its
  deleted volume). The scan now verifies EC2 ARNs against EC2 and drops
  ones that no longer exist.

## Milestone 9 -- change requests + AI failure diagnosis

Status: **done** (tested with fakes; not yet exercised on real AWS)

- `POST /deployments/:id/changes` -- the owner describes a change to a live
  deployment in plain words. A new `change` revision copies the live
  revision's profile/plan; the generate job hands Gemini the **live
  Terraform files plus the request** (edit, don't rewrite: keep addresses,
  never drop data-bearing resources unless asked; hard rules and Free Tier
  policy still apply). The full gauntlet runs, planning against the real S3
  state, so the review shows the true diff. The site keeps serving the live
  revision until the change is approved and applied.
- Approve now refuses a plan that destroys or replaces data-bearing
  resources (S3, EBS, databases, DynamoDB) without `confirmDataLoss`; the
  approve panel shows a red confirmation for it, and says what a change
  approval will do.
- `POST /deployments/:id/changes/discard` -- drops a pending change
  (awaiting approval, or failed validation) and returns to `live`, only
  while no apply/destroy job ran for it. `Revision.discardedAt` (migration
  `20261020110000_revision_discarded_at`) shows as "discarded" in history;
  discarded revisions can't be approved or regenerated.
- `/deployments/:id/generate` no longer regenerates the live revision (or a
  discarded one) in place.
- `POST /jobs/:id/diagnose` -- "Explain this failure": Gemini reads the
  redacted last 150 log lines (keys, tokens, `password=` values, JWTs
  stripped; the log is marked untrusted data in the prompt) and returns a
  validated `{summary, likelyCause, suggestedFix, whoFixes, changeRequest?}`.
  Cached on `Job.diagnosis`. When the fix is an infrastructure change, the
  UI offers "Request this change", which pre-fills the change form.

### Verification

- New tests: redaction + validated retry in `@autoinfra/llm`; API
  integration tests for a change request end to end (live files + request
  reach Gemini, site stays on revision 1, diff shows the edit, approval
  applies only the approved plan), the data-loss confirmation, discard
  (including refusal once a change touched AWS), and diagnosis (cached,
  failed-only, owner-only).
- Full suite **157 tests pass**; typecheck, lint, production build pass.
- Not yet run against real AWS/Gemini: needs a live deployment to change.

## Milestone 10 (part 2) -- rollback

Status: **done** (tested with fakes; not yet exercised on real AWS)

- `POST /deployments/:id/rollback {toRevision}` -- restore any earlier
  revision that was live. Creates a `rollback` revision (`rollbackOf`,
  migration `20261020120000_revision_rollback_of`) with that revision's
  commit, plan and Terraform files, marked unvalidated. The generate job
  sees `action: rollback` and re-runs the full gauntlet on those files
  against the real state -- **no Gemini call, no repair**
  (`generateAndValidate(..., { reuse })`). The review shows exactly what
  changes back; approve (with the data-loss confirmation if it applies) then
  applies, rebuilds the old commit and deploys. The site keeps serving the
  current revision until then; a pending rollback can be discarded like any
  pending change.
- Refused: the revision that's already live, revisions that never went
  live, a busy deployment, and revisions on a different architecture
  pattern than what's live (that would rebuild everything).
- Discard now restores `deployment.pattern` from the live revision (a
  re-design writes it before anything is applied).
- Web: "Roll back to this" (with a confirm step) on superseded revisions in
  History; "Restores #N" on rollback rows; the approve panel says what a
  rollback approval does.

### Verification

- API integration tests: #1 live -> change #2 -> redeploy #3 (new commit)
  -> rollback to #1: gauntlet gets #1's files via `reuse`, site stays on #3
  while awaiting approval, approval applies #1's files with the reviewed
  "delete log group" plan and #4 goes live on #1's commit; refusals for
  already-live / never-live / busy / cross-pattern / other users.
- Runner test: `reuse` runs one gauntlet pass with no model and no repair.
- Full suite **160 tests pass**; typecheck, lint, production build pass.

## Milestone 11 -- hardening (everything except the real-AWS demo)

Status: **done for the parts that don't need AWS**; the end-to-end demo on
both sample apps (and real runs of change/rollback) still needs a live
deployment.

- **Security review**: `docs/security-review.md` (threat model, fixes,
  what was checked, accepted risks). Fixed:
  - SSRF: the worker PUT CloudFormation responses to any `ResponseURL`
    from the publicly publishable SNS topic; now only CloudFormation's own
    S3 response hosts over https are accepted, before any DB work.
  - Sign-in timing leaked which emails exist (argon2 skipped); now one
    verification always runs.
  - Auth/CSRF hooks now return the reply they send.
  - Live log streams: capped at 10 per user per process; a job that ended
    between backlog read and subscribe no longer leaves the stream hanging;
    Redis failure ends the response cleanly.
- **Rate limits** (`apps/api/src/lib/rate-limit.ts`, Redis fixed windows,
  memory in tests): sign-in per account + per IP, signup per IP, AI steps
  30/hour/user (analyze, design, generate, change, diagnose), deployments
  20/day, AWS connect 20/hour, 600/min/IP global. 429 + `Retry-After`.
- **Per-user job cap**: `MAX_RUNNING_JOBS_PER_USER` (default 3) across an
  owner's deployments, checked in the serializable job-start transaction;
  destroy exempt.
- **Audit log**: new events (failed sign-in with IP, logout, env var
  deleted, AWS connection created/verified/plan set/removed, settings
  changed); `GET /account/audit` with id-cursor paging; Activity list on
  the new Settings page.
- **Settings**: `GET/PUT /account/settings` for the default Free Tier mode;
  new deployments use it unless the form overrides it (the form starts
  from it).
- **Free plan warning**: connection summaries carry the plan end date and
  credits AWS reported; the dashboard warns (red within 30 days) that the
  account closes unless upgraded and AutoInfra never upgrades it.
- **Docs**: README status/setup (three processes)/usage walkthrough;
  `.env.example` has `MAX_RUNNING_JOBS_PER_USER`.

### Verification

- New `hardening.integration.test.ts` (limiter windows + Retry-After;
  account lock after 10 failed sign-ins across IPs with no session issued,
  failures audited with IP; unknown-email answer identical; CSRF-rejected
  request never runs; job cap + destroy exemption; settings default
  applied + audited; audit paging without gaps on identical timestamps and
  owner-only; Free plan summary) and an SSRF test in the connect suite.
- Full suite **169 tests pass**; typecheck, lint, production build pass.

## Milestone 11 follow-ups (2026-10-20)

- **Analyze and design run on the worker** (new `deployment-prep` queue,
  concurrency 4). `POST /analyze` and `/design` return 202; `then` chains
  the following steps server-side with an atomic hand-off, so paste-a-link
  reaches the review screen even if the tab is closed. Their logs stream in
  the job console. A chain that includes generate checks the deploy role
  first. Also fixed on the way: "Redesign" on a live deployment overwrote
  the live revision's plan (now refused, and the button only shows for
  unapplied revisions); re-analysis could reuse a discarded revision;
  failed steps marked the job finished before the deployment failed (a
  poller could see an idle deployment still "analyzing"); a queue outage
  left jobs "running" forever (now failed with a clear message).
- **Account:** change password (current one required; wrong attempts
  audited and rate-limited), add an email + password to a GitHub-only
  account, sign out everywhere; password changes sign out other sessions.
- **Browser click-through** (headless Chrome via playwright-core, seeded
  demo user, removed afterwards): dashboard Free plan warning, Settings
  (mode, password, sessions, activity), a live deployment's history and
  rollback (up to the role error the fake account produces), a pending
  change and discard, sign out everywhere. Fixed what it found: the live
  card said "the last change didn't go live" for a change merely awaiting
  approval and offered Redeploy (which the API refuses then); the Free Tier
  mode radio only moved after the save returned.
- **`KNOWN_LIMITATIONS.md` rewritten by topic**: stale entries removed (no
  real deploy, no rate limits, analyze inline, no quick-create link, no
  password for GitHub users...), and a wrong one corrected (F2 has no
  automated database backups).
- **174 tests pass**; typecheck, lint, production build pass.

## Databases hosted outside AWS (2026-10-21)

- A real paste-a-link of a React + Express + MongoDB app failed at analyze:
  MongoDB was refused in every mode (the message suggested flexible mode,
  which never helped).
- New `RepoProfile.databaseExternal`, set by the scanner: always for MongoDB,
  and for Postgres/MySQL/Redis when the deployment's new `externalDatabase`
  option is ticked (migration `20261020140000_deployment_external_database`;
  checkbox under the new-deployment options). An external database doesn't
  force F2, gets no schema scripts, and its connection settings
  (`MONGODB_URI`, `DATABASE_URL`, `DB_HOST`...) are asked of the user instead
  of being wired to a container; `*_URI`/`*_URL` connection strings count as
  secrets.
- Design: Gemini is told the database is external; a plan that adds RDS or
  DynamoDB for it is sent back. Terraform: no database container, plus an
  egress rule on the database's port (F2's security group only allows
  80/443 out). The static gate enforces both.
- Redeploy compared the new scan's pattern hint with the pattern Gemini
  chose, so an app whose hint and design differ (now common: an external
  database leaves the hint at F1 while Gemini may pick F2) could never be
  redeployed; it now compares scan to scan.
- Tests: scanner (MongoDB fixture, external MySQL), platform env, design,
  gauntlet egress/container checks, and an API test from paste to the env
  form for both cases.

## Next.js frontends that need their server (2026-10-21)

- A real generation for a Next.js app with `middleware.js` and dynamic
  routes (React frontend + Express + Postgres) uploaded `frontend/.next` to
  S3 behind an index.html rewrite -- the site would have served nothing. The
  prompt and the gates had no rules for a server-rendered frontend.
- Scanner: Next.js SSR now means F2 even when the backend alone could run on
  Lambda; design refuses any other pattern for it.
- New platform-owned `.autoinfra/Dockerfile.web` (in `platform-app/`): builds
  the frontend inside Docker with the API path written to
  `.env.production.local`, prunes dev dependencies, the build cache and the
  SWC binaries (kept for `next.config.ts`). Verified on the real repo: pages,
  middleware and dynamic routes answer 200, ~47 MB RAM, ~170 MB compressed.
- Terraform prompt: a `web` compose service (`${WEB_IMAGE}`, port 3000),
  Caddy routes the API prefix to `app` and everything else to `web`,
  CloudFront's default behavior goes to the instance (all methods,
  CachingDisabled + AllViewer, no SPA function), nothing uploaded to S3, ECR
  keeps 4 images. `checkServerRenderedFrontend` enforces all of it; on the
  real broken bundle it reports all six problems.
- Lockout test timeout raised to 20 s (11 argon2 verifications exceeded 5 s
  under a full parallel run).

## Routing, outside databases, containers, uploads (2026-10-26)

- A real static site (images + 61 MB video) went live on F3 from the
  blueprint. Its redeploy then failed twice on a mobile hotspot: the source
  upload (33 MB, one PUT) dropped and DNS stayed down past the SDK's
  retries. `uploadObject` now sends 8 MB multipart parts, each retried on
  network errors for about a minute; the artifacts bucket's lifecycle
  aborts unfinished uploads after a day (the deploy role can't abort).
- **Backend paths outside /api** reached S3 instead of the backend: a
  hardcoded `http://localhost:5000/users` with routes lacking /api, socket.io
  (`/socket.io/`), `ws://` URLs, Vite/CRA dev-proxy paths, files served at
  `/uploads`. New scan fields (dev-proxy paths, page routes, top-level
  routes, socket.io/WebSocket paths) feed `backendRouting` in shared, used
  by the blueprint, the design text and the Gemini prompt: CloudFront gets
  a behavior pair per backend path (Caddy routes them for a Next.js
  server), and the build rewrites each localhost URL to the form that
  reaches the backend (the API prefix only where it's stripped, never on
  socket.io lines; `ws://` -> `wss://`). .vue/.svelte files and inline
  scripts in .html are scanned now.
- **F2 egress**: one all-traffic egress rule instead of 80/443 plus the
  database's standard port -- Supabase's 6543 pooler, Redis Cloud/Aiven
  ports and SMTP failed before. Inbound unchanged (CloudFront only).
- **Outside databases**: a database setting in the repo's env template
  pointing at a hosted provider (Neon, Supabase, Atlas, PlanetScale,
  Upstash...) makes the database external even without the option, so it
  is never replaced by an empty container (`databaseHostedAt` explains it
  on the review screen).
- **Backend <-> frontend URLs**: new `prepare-backend.sh` rewrites localhost
  URLs in the backend (its own port through the API prefix, frontend dev
  servers' to the live URL: CORS allow-lists, redirects after login). More
  settings are filled in: NEXTAUTH_URL/AUTH_URL, CORS_ALLOWED_ORIGINS,
  CSRF_TRUSTED_ORIGINS, framework-prefixed *_SITE_URL (live URL),
  ALLOWED_HOSTS (host), BACKEND_URL/SERVER_URL (backend's public URL), and
  any variable whose example value is a localhost URL (same path on the
  live URL, e.g. an OAuth callback). `providedValue` in shared computes
  them for the apply step.
- **Containers**: Go and Spring Boot (Maven/Gradle) get generated
  Dockerfiles; any other language with its own Dockerfile runs on F2; a
  Dockerfile that only serves files is a static site. Env vars, databases
  and /api prefixes are found in Go, Java, Ruby, PHP, Rust, .NET and Elixir
  code. Both generated images were built and run locally from the
  fixtures: the Go API answered 200; Spring Boot started on its configured
  port 8081 in a 384 MB container, answered 200 and used ~117 MB.
- **Fixed**: F1 blueprint deploys ran `.autoinfra/package-lambda.sh`, which
  didn't exist -- every Lambda deploy would have failed at the build step
  (the matrix validates Terraform, not the buildspec's scripts). Written
  now: installs, prunes dev dependencies, adds run.sh and the env loader,
  ships the zip through S3.
- Tests: routing, env-value and upload units; scanner cases for every new
  detection; platform-script tests running the real bash rewrites; five
  new real-Terraform matrix shapes (MERN + socket.io, Vite proxy without
  /api on Lambda, Go + Vite, Spring Boot, Ruby with its Dockerfile). Two
  API tests still expected Gemini to design blueprint shapes and MongoDB
  to always be external; they now check the blueprint path, the option,
  the env-template detection and MongoDB on the instance. The paste-a-link
  test gets 20 s (it timed out at 5 s only under a full parallel run).

## Reliability pass (2026-10-27)

- **GitHub token in clone errors**: execFile's error message holds the
  command line, so a failed clone of a private repo carried the tokenized
  URL into the API log (redeploy) and the apply job's failure. `cloneRepo`
  now scrubs the token from every error, never lets git prompt for a
  password, and limits each git step (10 minutes on the worker, 2 inside
  the redeploy request). It also fetches submodules (GitHub ones with the
  token, SSH URLs over HTTPS) and Git LFS files; git-lfs is in the worker
  image.
- **Health check**: an API probe answered by S3 (a path CloudFront doesn't
  route to the backend; the SPA fallback made that a 200) or by a Lambda
  URL refusing CloudFront no longer counts as the backend being up.
- **F2 database backups**: `backup.sh` dumps the database container daily
  (systemd timer installed by deploy.sh) and before each deploy's
  migrations to `backups/` in the artifacts bucket (7-day expiry); the
  instance role may write that prefix only. Verified against real
  Postgres 16, MySQL 8.4, MongoDB 7 and Redis 7 containers: each dump
  restored into a fresh container returned the seeded row; a dump that
  fails halfway exits 1 and uploads nothing.
- **Nuxt and SvelteKit**: server-rendered ones go to F2 through a
  framework-aware `Dockerfile.web` (which now also uses yarn and pnpm
  lockfiles); `nuxt generate` and adapter-static builds are static sites.
  SvelteKit's adapter-auto is swapped for the adapter-node matching its Kit
  version (the latest needs Kit 3 -- the first real build caught it).
  Verified by building and running both: pages render on the server, Nuxt
  sees https, SvelteKit accepts a same-origin form post and refuses a
  cross-site one (403); 17-31 MB of RAM each.
- **Caddy** sends `X-Forwarded-Proto: https` upstream (viewers always use
  HTTPS at CloudFront): Express secure cookies behind `trust proxy`,
  Django's SSL redirect and SvelteKit's origin check depend on it.
- The F2 instance's Elastic IP is a Terraform output and shown on the live
  card, for outside databases' allow-lists.

## Gap hunt: real repos, real tools (2026-10-27)

Driven by running AutoInfra's own scanner on real public repos
(`docker/awesome-compose`, a RealWorld app, CRUD samples) and by running
the platform's pieces for real (Docker Compose, Docker builds, bash).

- **Scanner.** A subfolder holding a whole app (`frontend/` + `backend/`)
  was scanned only at its top level: 18 of 20 awesome-compose apps -- and
  this repo's own `examples/` pushed as one repo -- failed at analyze. Now
  searched like a repo root (subfolder `backend` still means the backend
  alone). An npm/pnpm workspaces root was taken for a plain Node backend
  (its `.listen()` was a member's), so a Sequelize + Postgres app came out
  "no database". `mysql-connector(-python)` and `aiomysql` now mean MySQL
  (they read as Redis or no database, sending MySQL apps to Lambda). A
  Windows worker clones with `core.longpaths` (a deep repo failed checkout
  with exit 128).
- **Redis next to the main database** (`RepoProfile.cache`): F2 runs it as
  a second container (64 MB, its own volume) and points the app's
  `REDIS_*` settings at it; before, the owner was asked for a Redis they
  didn't have.
- **Database settings:** env-prefixed copies (`PROD_DB_HOSTNAME`,
  `DEV_DB_NAME`, `TEST_DATABASE_URL`), `*_HOSTNAME` and `*_DIALECT` are
  wired to the container like `DB_HOST` (Sequelize's config.js). Connections
  written into the code with a localhost host are flagged on the review
  screen (`backend.hardcodedDatabaseHosts`), with file and line.
- **Network failures:** `terraform init` is retried twice (15 s, 45 s) on a
  network error, in validation, apply and destroy. Network failures in
  init/plan and crashed tflint/trivy are marked `repairable: false` and
  never sent to Gemini -- before, a registry timeout cost up to four
  pointless repair calls and ended in a confusing error. Proxy settings
  (`HTTP(S)_PROXY`, `NO_PROXY`, `SSL_CERT_*`) now reach Terraform.
- **F2 instance:** `deploy.sh` waits for the first-boot setup (cloud-init)
  and installs Docker, Compose and swap when they're missing, so a first
  boot whose download failed heals on the next deploy; `bootstrap.sh`
  retries the Compose download.
- **pnpm 12:** Node's bundled Corepack can't start it (it looks for
  `bin/pnpm.cjs`). AutoInfra's Dockerfiles and CI install the pinned pnpm
  with npm; users' apps fall back to npm's pnpm when Corepack fails.
- **Docker images** (never built with the current code): no
  `.dockerignore`, so the real `.env` (Gemini key, encryption key) and
  Windows `node_modules` were copied into all three images; the API image
  compiled before generating the Prisma client; the web image relied on
  the host's built `dist/`; the API container had no AWS credentials
  (Connect AWS needs the platform identity) and never applied migrations;
  trivy 0.58.1's GitHub tarball is gone (404) -- the worker now copies
  tflint and trivy from their official images, the same versions the
  gauntlet's Docker fallback runs.
- **GitHub sign-in:** the login page had no GitHub button; the dashboard
  always offered "Connect GitHub" (a bare 404 when OAuth isn't set up);
  failures were never shown; one GitHub account could be linked to two
  AutoInfra accounts. Now: `GET /auth/providers`, "Continue with GitHub"
  on login and signup, "GitHub: @login" on the dashboard, a message for
  success and each failure, the second link refused, and a stale
  `/auth/github` link explains itself.
- **Review screen:** said the F2 database had no automated backups (it has
  had them since the reliability pass).
- **Dev tooling:** the pipeline and terraform-runner tests read `.env`
  (without `TF_PLUGIN_CACHE_DIR` a full run took hours); turbo caches
  `tsconfig.tsbuildinfo` with `dist/` (a cached `dist/` with a corrupt
  source map survived rebuilds); `.prettierignore` for the blueprint
  templates; scanner and script tests remove their temp folders; two API
  tests expected the deployment response from before `outboundIp`.

### Verification

- New tests: subfolder app, workspaces root, MySQL drivers, Redis next to
  Postgres/MongoDB/MySQL, hardcoded localhost connections (and what's not
  flagged), long-path clone (fails with exit 128 without the fix),
  env-prefixed and dialect settings, Redis container wiring, `deploy.sh`
  (`.env` from SSM, ECR login, crash detection with logs, healing a first
  boot without Compose), `rollout.sh` (success, failure), init retry rules,
  and a real-Terraform run behind a dead proxy that stops without a model
  call; the first GitHub OAuth tests (sign-in, connect, refusal of a second
  link, forged state, failed exchange, no OAuth app).
- Real runs: the generated F2 compose files started in Docker -- Postgres +
  Redis (Sequelize-style settings, `DATABASE_URL` over SSL, `REDIS_URL`
  answered PONG) and MySQL (`DB_*` as root in `todo_db`); `deploy.sh`'s
  `.env` quoting read back exactly by a real container (`$`, `#`, quotes,
  spaces); the pnpm fallback in `node:22.20.0-slim` with a pnpm@12.11.2
  app (Corepack fails, npm's pnpm switches to 12.11.2) and a pnpm@9.15.0
  app (Corepack works); the scanner on 26 real apps; the three platform
  images build (npm and pnpm now retry dropped connections -- two builds
  had failed on ECONNRESET/ETIMEDOUT; `openssl` added for Prisma, whose
  warning is gone), the API and web containers answered (`/health`, a
  login that reads the database, `/login`), and the worker image carries
  terraform, tflint, trivy and git-lfs -- with no `.env` in any image.
- Full suite **320 tests pass**, the blueprint matrix 23/23 in one run with
  `TF_PLUGIN_CACHE_DIR` read from `.env`; typecheck, lint, format check and
  the production build pass. One API test running four analyze -> design
  chains now gets 20 s (it timed out at 5 s while three Docker builds ran).

## Three user-suggested repos, checked (2026-10-28)

- `python-backend-testing` hardcodes someone's RDS endpoint and password in
  a Python dict; nothing warned (only localhost hosts were flagged, and
  quoted dict keys weren't matched). Hosted-database addresses written into
  code (the provider list behind `databaseHostedAt`) are flagged now, and
  credentials in a flagged URL are masked before the finding is stored or
  shown. Scanner **54 tests pass**; API **77**.
- `conduit-realworld-example-app` run on its generated F2 files in local
  Docker: the generated Dockerfile built the backend; `setup.sh` +
  `db-setup.sh` started Postgres and ran `sequelize-cli db:migrate` on the
  empty database (8 tables), and again as a no-op; through Caddy with the
  origin secret, tags, sign-up (JWT) and articles answered, and a request
  without the secret got 403. Only `JWT_KEY` is the owner's to enter.
- `crud-example`: still flagged (`host: 'localhost'` in config/db.config.js);
  it needs its code changed to read env vars.
- **First real F2 blueprint deployment**: conduit went from pasted link to
  live (`https://d3qnp2jx24pc72.cloudfront.net`) on the user's account. The
  blueprint passed all 9 gates first time (no AI), the apply created 36
  resources, CodeBuild built the image and frontend, `deploy.sh` ran the
  migrations and kept the containers up, and the health checks passed
  (frontend 200; `/api/` 404 from the app itself). Checked through
  CloudFront afterwards: the page, `/api/tags` and `/api/articles` from
  Postgres, SPA routes, http -> https. 8 minutes from approval to live.
- **First real redeploy**: the owner approved with `JWT_KEY` empty, so
  sign-up saved the account but returned `secretOrPrivateKey must have a
value`. After saving `JWT_KEY` and "Redeploy latest commit": a no-change
  plan, rebuild, rollout and health checks, live in 4.5 minutes; on the
  instance the pre-deploy backup reached S3
  (`backups/...-predeploy.sql.gz`), the migrations were a no-op, the
  database container kept running, and the owner logged in with the account
  created before the redeploy.
- **Destroy of the blueprint deployment**: 36 resources destroyed, 5 SSM
  values deleted, the leftover check found nothing; 4.5 minutes.

## First Lambda (F1) deployment, and the default branch (2026-10-29)

- **First real F1 deployment**: awesome-compose's `fastapi` folder went
  live (`https://dpjnweog7r4ia.cloudfront.net`): the F1 blueprint passed
  all 9 gates first time, the apply created 24 resources (the deploy
  role's Lambda permissions used for the first time), CodeBuild installed
  the Python dependencies and shipped a 5.6 MB package to the function,
  and the health check passed. Through CloudFront `/` answered
  `{"message":"OK"}` from Lambda; the Function URL (`AWS_IAM`) refused a
  direct request with 403.
- **The Branch box defaulted to `main`**, and awesome-compose's only
  branch is `master`: the clone failed with a generic "check the URL and
  branch". Now an empty Branch (the new default) means the repository's own
  default branch -- cloned without `--branch`, its name recorded on the
  deployment by the first analyze so redeploys follow it -- and asking for
  a branch that doesn't exist says which one does (`git ls-remote
--symref`). Secret findings use `/` paths on Windows too, and the audit
  log names a deployment without a dangling `@` before its branch is known.
  Scanner **55 tests**, API **79**, shared 32, pipeline 10.
- **awesome-compose `react-express-mongodb` failed at the build** -- two
  causes: (1) the Windows worker's clone had converted the repo's LF files
  to CRLF (Git for Windows' `core.autocrlf=true`; the repo stores LF), so
  the backend Dockerfile's heredoc ran `apt-get update\r`; (2) AutoInfra
  built the Dockerfile's last stage, `dev-envs` (Docker Desktop's
  developer tools, `apt-get` on end-of-life Debian buster), while the
  repo's compose file builds `target: development`. Now every git command
  runs with `core.autocrlf=false core.eol=lf`, and the backend's build
  target is read from the repo's compose file (only a stage the Dockerfile
  has) and passed as `--target`. `compose.yaml`/`compose.yml` (the Compose
  spec's own names) and a compose file in the chosen subdir now count for
  `hasComposeFile`. Checked before redeploying: the image built at
  `--target development` and AutoInfra's generated docker-compose.yml run
  locally (Caddy + app + `mongo:7`): `GET /api` 200, `POST /api/todos`
  saved through the wired `MONGODB_URI` (the app's own `config.json` host
  `mongo` is skipped because AutoInfra sets `NODE_ENV=production`), and no
  origin secret -> 403. Scanner **59 tests**, blueprints 41, API 79.
- **The one-free-instance rule counted the wrong deployments.** It counted
  per AutoInfra connection, but the 750 free hours are per AWS account (the
  user had two connections to one account); it counted a deployment being
  destroyed, so "Destroy, then deploy again" failed at design with "Destroy
  the other deployment"; and it skipped every failed deployment, even one
  whose instance was still running (the failed react-express-mongodb had
  one) -- a second instance on the bill. Now `alwaysOnEc2Holders` counts
  F2 deployments on any connection to the same account (from the role ARN),
  a failed one only when its outputs name an instance, and not one being
  destroyed; the design step's refusal names the deployment holding the
  instance (another person's is not named). New DB-backed test
  (`common.test.ts`); the API tests give each test user its own AWS account.
  API **79** passing.
- **react-express-mongodb is live on real AWS** (F2, MongoDB on the
  instance) -- the first MongoDB app. The old deployment was destroyed
  cleanly (36 resources, SSM values, no leftovers), and the new one went
  straight through: default branch `master`, all 9 gates, 36 resources,
  the backend built at `--target development` (the `dev-envs` stage never
  ran), `app`/`caddy`/`db` up, health `/` 200 and `/api/` 200. Checked by
  hand through CloudFront: `GET /api` (the exact call the app makes) is
  JSON from Caddy, the page and its bundle load, deep links fall back to
  the app, and the instance itself doesn't answer from outside CloudFront
  (security group: CloudFront's origin-facing prefix list only).
- The status said `deploying` during the whole CodeBuild run (about four
  minutes, mostly building), and `building` only during the source upload.
  It now says `building` until CodeBuild starts the first deploy step
  (`rollout.sh`, `package-lambda.sh` or `publish-frontend.sh`), then
  `deploying`; the API test checks the order of the status lines.

## Pre-scan of every awesome-compose sample, and what it found (2026-10-29)

Scanned all 40 samples, the owner's CareerLens and the MySQL todo app with
the current scanner before recommending any for testing. CareerLens (refused
on 20 Oct: "MongoDB not supported") now maps to F2 with MongoDB, and
`todo-app-assessment` to F2 MySQL with nothing to enter. Gaps found and fixed:

- **Database-name settings**: `DATABASE_DB` (react-express-mysql) and
  `*_DBNAME` (`PG_DBNAME`, react-rust-postgres) were asked of the owner; a
  value other than the database AutoInfra creates fails ("unknown
  database"). They now point at it like `DB_NAME`.
- **A listen address the app reads from its own setting** (`ADDRESS`,
  default `127.0.0.1:8000`): 127.0.0.1 inside the container is out of
  Caddy's reach. The scanner keeps a default that is a listen address
  (code: `process.env.X || ...`, `os.environ.get(..., ...)`, Rust's
  `unwrap_or`; or the env example), and AutoInfra sets `0.0.0.0` (with the
  routed port when the default has one). `BIND*`/`LISTEN*` names always;
  `HOST`/`ADDRESS`/`SERVER_HOST`... only with such a default, since
  otherwise they may be a public host name.
- **The listen port under the app's own name** (`FLASK_SERVER_PORT`,
  `SERVER_PORT`, `APP_PORT`...): nginx-flask-mongo listens on 9090 by
  default while AutoInfra routed to 8000 (the Dockerfile's `EXPOSE`). Now
  set to the routed port, through the same stored values as `NODE_ENV`
  (`.env` on F2, the Lambda's loader on F1).
- **Hosts written for docker-compose** (`host='redis'`, `mongo:27017`):
  the database container is also reachable as its usual names (`postgres`,
  `mysql`, `mongo`, `redis`, `database`...), the Redis cache as `redis`.
  Checked in real Docker: psql as `db`/`postgres`/`database`, redis-cli
  PING as `cache`/`redis`.
- **Which Dockerfile stage to build**: following compose's `target:`
  (added for react-express-mongodb, whose last stage is Docker Desktop's
  `dev-envs`) would have built react-rust-postgres's `development` stage,
  which compiles with `cargo run` when the container starts (on a 384 MB
  container). Now: the last stage, as Docker builds it; only when that
  stage is for development, a production-named stage, else compose's
  target. react-express-mongodb still gets `development`.
- Not AutoInfra's to fix, documented: samples that read the database
  password from `/run/secrets/...` or hard-code compose's credentials
  (most of awesome-compose); react-rust-postgres doesn't build at all any
  more (its `rust:buster` image has Cargo 1.79, and with no `Cargo.lock`
  today's crates need `edition2024`).

Shared **38 tests**, scanner **62**, blueprints 41, pipeline 11 (quick) +
the 23-case real-Terraform matrix, API 79; typecheck + lint 33/33.

## First Next.js SSR app on AWS: Farmer_Connect (2026-10-29)

`adii11001/Farmer_Connect`: Next.js (app router, server-rendered) + Express
on 5001, Postgres on Neon (created with "Database hosted outside AWS").
Blueprint F2, all 9 gates, 33 resources (no database container). CodeBuild
built both images -- the Next.js server (`Dockerfile.web`, 25 static pages)
and the backend (generated Dockerfile) -- and the new `== deploying ==`
line came exactly at `rollout.sh`. Checked in the code first: the
frontend's relative `fetch('/api/...')`, `/uploads` and `/health` reach
Express (Caddy routes them to `app`, the rest to `web`); the auth cookie
has no domain and `secure` follows `NODE_ENV=production`; the startup env
check needs six DB/JWT names, all saved; Twilio's client sits in a module
nothing loads. The rollout stopped at the first migration script
(`node migrate_db.js`): Neon refused the saved password (`password
authentication failed for user 'neondb_owner'`) -- TCP egress and SSL to
Neon worked. AutoInfra writes values to the instance's `.env`
single-quoted, so the stored value arrived as stored.

Two ways AutoInfra itself could store a wrong value, found while ruling it
out, and fixed:

- Pasting `DB_PASSWORD="npg_x" # Neon` (a quoted value with a comment after
  it) kept the quotes in the value: the quote check wanted the whole rest
  of the line quoted. Now the comment after the closing quote is dropped.
- Values were stored exactly as typed, so a password copied with a
  trailing space or line break (`\r\n` from Windows) could never log in.
  The API now trims names and values, as dotenv does for unquoted values,
  and a blank value is refused ("is empty").

Still for the owner: the right Neon password, and -- if that Neon database
is empty -- `backend/db/schema.sql` loaded first (the repo's migrations
alter existing `users`/`listings` tables). Uploaded files live in the
backend container (no volume) and don't survive a redeploy.

The owner then clicked Retry without changing the password, and it failed
the same way -- the deployment's reason said only "The CodeBuild build
failed (...). See the build log above.", with the cause 40 lines up in the
log. A failed rollout now says why in plain words when the instance's
output (after rollout.sh's `--- errors from the instance ---` or
deploy.sh's `=== app did not stay up`) shows a known cause: a refused
database password (Postgres, MySQL, MongoDB), a database that wants SSL, a
missing database or table, a host that doesn't resolve, nothing answering
(localhost inside the container called out), a missing module, running out
of memory. The advice depends on whose database it is: an external one's
settings are the values the owner entered; with AutoInfra's own, a refused
login means credentials written into the code. Anything else keeps the old
reason, for the log and Explain this failure. `startup-errors.test.ts` (12,
from the real Neon lines) and an API test of the stored reason.

## CareerLens, and Docker Hub's rate limit (2026-10-29)

- **The account-wide instance rule on real data**: CareerLens's first
  design was refused while Farmer_Connect's failed deployment still had its
  instance -- "This AWS account's free instance is used by
  adii11001/Farmer_Connect, failed: destroy that deployment, then retry
  this one". The owner did; the next design passed.
- **Docker Hub refused CodeBuild** (`429 Too Many Requests` for
  `node:22`, the base of AutoInfra's generated Dockerfile): CodeBuild pulls
  from addresses shared with other AWS customers, and Docker Hub limits
  anonymous pulls per address. Every image AutoInfra names now comes from
  AWS's mirror of Docker Official Images, `public.ecr.aws/docker/library/`
  (all 13 checked there): the generated Node/Python/Go/Java Dockerfiles,
  `Dockerfile.web`, and Caddy/Postgres/MySQL/MongoDB/Redis on the instance;
  Gemini's prompt says the same. A repo's own Dockerfile gets
  `base-images.sh` first: its official bases (ARG defaults resolved, stage
  names, `scratch`, other registries and digests skipped) are pulled from
  the mirror and tagged with the Dockerfile's names -- `docker build` uses a
  local image before asking a registry (checked with a name that exists
  only locally). Mirror and Docker Hub images had the same IDs. A 429 that
  still happens (a repo naming a non-official image) now reads as Docker
  Hub's limit, not the app's failure.
- **An outside database's allow list**: the deployment page showed the
  instance's address ("allow this address in a hosted database's network
  access list") only once live; an app whose setup needs the database first
  never got there. It now shows from the first apply when the database is
  outside AWS. CareerLens's `/api/health` answers without the database and
  its MongoDB connection is tried once at start, so an Atlas list without
  the instance's address would look live but fail at login.

Shared 38, scanner 62, blueprints 42, LLM 15, pipeline 24 (quick), API
**80**; typecheck + lint 33/33.

After the mirror fix CareerLens built (the backend's `node:22` came from
the mirror with the same digest Docker Hub had refused) and went live --
yet a login answered `Operation users.findOne() buffering timed out after
10000ms`. Its startup log (read over SSM: AutoInfra had no way to show an
F2 app's logs) said `querySrv ENOTFOUND
_mongodb._tcp.cluster0.dqbopmt.mongodb.net`, and Google's and
Cloudflare's DNS agree the cluster doesn't exist: the owner's `MONGODB_URI`
names a deleted or mistyped Atlas cluster. Nothing AutoInfra could connect
to -- but it said "Live" with nothing wrong.

- **"Live, but..."**: deploy.sh, once the containers have stayed up (~50s),
  prints the app's error lines under `=== error lines in the app's startup
log ===` (URL passwords masked, here and in the crash path too). The
  apply job reads them with the same plain-language matcher (now also
  `querySrv ENOTFOUND`, and "Redeploy" instead of "Retry" for a live app),
  logs "The app is up, but its startup log shows a problem: ...", and the
  live page shows it -- stored with the live revision's outputs
  (`startup_warning`), so the next deploy re-decides.
- **Destroy refused with "Re-verify the AWS connection"** although the role
  was fine: the API's sts:AssumeRole call to AWS timed out (33s) from the
  owner's machine, and the error was swallowed (`catch {}`). Now the real
  error goes to the API log, and a timeout or network failure says
  "AutoInfra couldn't reach AWS just now ... Nothing was changed -- try
  again in a minute" (`aws_unreachable`); a refused role keeps the
  re-verify message. All 10 routes that assume the role. (The worker's log
  had `getaddrinfo ENOTFOUND sqs.ap-south-1.amazonaws.com` around then:
  the owner's machine briefly couldn't resolve AWS's addresses.)
- **First real permission update**: Spoon-Knife's destroy was refused
  (`permissions_outdated`): its connection's stack, `AutoInfra-b37ec02b`,
  was on a template from before versions were recorded (no
  `TemplateVersion` output; the newer connection's says 3). Updated with the
  template the permission-update route serves (same code path),
  `UsePreviousValue` for ConnectionId/RoleName/ExternalId: the role and
  `AutoInfraRegistration` updated in 35 s, the stack reported 3, the worker
  logged `registration: SUCCESS`, and the connection's `templateVersion`
  was 3 a few seconds later -- the notice and the refusal gone.
- API **82** (the live revision now carries `startupWarning`; two tests
  compared it field by field).

- The env form said every AutoInfra-filled setting could be overridden, but
  database and Redis settings are set by docker-compose's `environment:`,
  which beats `.env` -- a pasted env template (conduit's `127.0.0.1`,
  `mysql`) would have been saved and silently ignored. `PUT .../env` now
  refuses those names with the reason (`set_by_autoinfra`); API **77 tests
  pass** with the new case.
- "Save to AWS" answered a bad row with a bare `invalid_input`; the
  message now names the row and the reason. And the form can take a whole
  `.env` file (**Paste a .env file**, `parseEnvPaste` in shared): it leaves
  out names AutoInfra sets (an env template's 127.0.0.1 and localhost URLs
  would otherwise replace them) and reserved ones, and leaves placeholder
  or weak secrets empty for the owner to type. The name rules (`ENV_NAME`,
  `RESERVED_ENV_NAME`, `SECRET_ENV_NAME`) now live once in shared for the
  scanner, the API and the form. Shared **32 tests**, scanner 54, API 77.

## CareerLens live with AutoInfra's MongoDB (2026-10-29)

- Created again without "Database hosted outside AWS": 36 resources, MongoDB
  in a container. The first rollout crashed -- `OAuth2Strategy requires a
clientID option`: CareerLens's passport setup builds the Google and
  GitHub strategies unconditionally, so their client IDs are needed even
  unused. A failed rollout now names that (and, for a crash it doesn't
  recognise, the settings the code reads that have no value). The env form
  is locked while a deploy runs, so a value can only be added between runs.
- With placeholder client IDs it went live; the new startup check showed
  `MongoDB Connection Error: Socket 'connect' timed out after 38868ms
(connectTimeoutMS: 5000)` -- the event loop blocked by its model training
  at start -- but a login probe answered 401 from the database in 1.1 s, so
  it recovered (and no "live, but" notice was raised for an unknown line).
- **Regression found on AWS**: the pre-deploy (and daily) backup failed.
  backup.sh picked the dump by `case "$image" in mongo:*)`, and since the
  mirror change the image is `public.ecr.aws/docker/library/mongo:7`. It
  now matches the image's own name (`${image##*/}`), mirrored or not; a
  deployment gets the fixed script with its next deploy.

## Farmer_Connect live: first Next.js SSR + Postgres app on AWS (2026-10-30)

- Created without "Database hosted outside AWS". The first rollout failed:
  `service "db" is not running` when applying the migration SQL. db-setup.sh
  started the database only `if docker compose config --services | grep -qx
db` -- under `pipefail`, `grep -q` exits at the first match, compose gets
  SIGPIPE (141), and the check reads "no db" whenever db is listed first
  (conduit's order hid it). Now `grep -x db > /dev/null` (reproduced, then
  fixed). The failure message had also blamed the empty Twilio settings: the
  empty-settings guess is now only for a container that crashed, not a setup
  step.
- Retry: "Starting the database", schema.sql as the init script, the SQL
  migration and both scripts, all containers up; live at
  https://d1bfklyujpfrfi.cloudfront.net. Pages render through the Next.js
  server, `/health` ok, a login looked a farmer up in Postgres, and the
  owner registered, logged in, created a listing and saw it after a reload.

## App logs and database viewer on the deployment page (2026-10-31)

- **App logs**: `GET /deployments/:id/logs?service=&lines=` -- an F2
  container's last lines (`docker compose logs` over SSM Run Command, URL
  passwords masked on the instance) or the F1 Lambda's (CloudWatch). Owner
  only, 30 reads a minute; no role change (the role already sends the
  rollout over SSM).
- **Database viewer**: `GET /deployments/:id/database` (tables and row
  counts) and `GET /deployments/:id/database/rows?table=&offset=&limit=`
  (25 rows a page, up to 50) for the PostgreSQL, MySQL or MongoDB container
  AutoInfra runs on an F2 instance (packages/aws `db-browse.ts`).
  - Fixed queries only, never SQL from the browser. The script goes to the
    instance base64-encoded and runs in the `db` container with the
    container's own credentials: Postgres in a read-only transaction, MySQL
    in a read-only session (both refused an INSERT in the check below),
    Mongo's script only reads. Table names are checked against a strict
    pattern before anything is sent, then used as quoted identifiers.
  - Output is gzipped to fit SSM's 24,000-character limit; values are cut at
    200 characters, and a page too wide still is retried with fewer rows.
  - The web panel hides password/token/hash-like columns until "show" is
    ticked. Rows go straight to the owner and are never stored or logged.
  - Not for an outside database (409 naming the provider) or Redis.
- **Verified** against the same images the instances run (postgres:16,
  mysql:8.4, mongo:7) through the real command path -- only `docker compose
exec` swapped for `docker exec`: a quoted "User" table, a non-public
  schema, empty tables, NULLs, a column name with a space, JSON, dates,
  ObjectIds, nested documents, a second Mongo database, 50 wide rows in one
  page, and missing tables (404 on all three). Not yet run on a live
  instance.
- Tests: aws 12 (6 new), API 84 (viewer route; another user gets 404).
