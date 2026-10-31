# Security review (Milestone 11)

Date: 2026-10-20. Scope: the API, the worker, the web app, and the
deployment role AutoInfra asks users to create. It covers the platform as
designed today: local-only (`docker-compose`), multi-tenant data model.

## Threat model in one paragraph

Users are untrusted toward each other. Repositories are untrusted: anything
scanned from one, including what Gemini writes after reading it, could be
hostile. Gemini's output is untrusted until AutoInfra's own checks pass.
The SNS topic for one-click connect accepts publishes from **any** AWS
account (it has to, because stacks in users' accounts report to it), so
everything that arrives on it is untrusted. The worker holds the platform's
own AWS identity and, briefly, each user's assumed-role credentials. It is
the most valuable thing to protect.

## Fixed in this review

| Finding                                                                                                                                                             | Impact                                                                                                                                         | Fix                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SSRF via one-click connect.** The worker PUT the CloudFormation response to the message's `ResponseURL` without checking it, and anyone can publish to the topic. | A forged message could make the worker send requests to the instance metadata service or internal services (Redis, Postgres, the API).         | `ResponseURL` must be `https`, have no port or userinfo, and point at CloudFormation's own S3 response bucket host. Anything else is ignored before any database work or request (`isCloudFormationResponseUrl`, with tests).                                                          |
| **No rate limits anywhere.**                                                                                                                                        | Password brute force; one user burning the shared Gemini quota; mass signup.                                                                   | Fixed-window limits in Redis, shared across API processes: sign-in 10 per 15 min per account and 30 per IP, signup 10/hour per IP, AI steps 30/hour per user, new deployments 20/day, AWS connect 20/hour, and a 600/min per-IP ceiling on everything. Answers 429 with `Retry-After`. |
| **No per-user cap on running jobs.**                                                                                                                                | One user could fill the worker queue across many deployments.                                                                                  | `MAX_RUNNING_JOBS_PER_USER` (default 3), checked inside the serializable job-start transaction. Destroy is exempt, because it stops costs.                                                                                                                                             |
| **Account-existence timing leak on sign-in.**                                                                                                                       | Unknown emails skipped argon2, so response time revealed which emails are registered.                                                          | Always run one argon2 verification, against a dummy hash for unknown emails.                                                                                                                                                                                                           |
| **Auth/CSRF hooks didn't return the reply.**                                                                                                                        | Fastify stops on `reply.sent` today, but a hook that sends without returning relies on that internal detail.                                   | Both hooks now `return reply...send()`. A test proves a CSRF-rejected logout leaves the session intact.                                                                                                                                                                                |
| **Live log streams: unbounded and could hang.**                                                                                                                     | Each stream holds a Redis subscription (resource exhaustion). A job that finished between the backlog read and the subscribe never sent `end`. | At most 10 live streams per user per API process. After subscribing, the stream catches up on logs and status, so it can't miss `end`. A Redis failure ends the response cleanly.                                                                                                      |
| **`/generate` could regenerate the live revision in place.**                                                                                                        | The applied Terraform record would no longer match what is running.                                                                            | Refused for the live revision and for discarded ones.                                                                                                                                                                                                                                  |
| **Audit gaps.**                                                                                                                                                     | No record of failed sign-ins, logout, env var deletion or AWS connection changes, and no way for a user to see their own trail.                | Added these events (sign-ins carry the IP), plus `GET /account/audit` and an Activity list in Settings.                                                                                                                                                                                |

## Checked and fine

- **Tenant isolation.** Every deployment, revision, job, log, env var and
  connection query is scoped by `ownerId`/`userId`, either directly or
  through the deployment relation. Tests cover cross-user reads, history,
  diagnosis, rollback and audit.
- **Sessions.** httpOnly, signed, `SameSite=Lax` cookie backed by a
  `Session` row with a 7-day expiry. A new session on every sign-in.
  `Secure` in production.
- **CSRF.** Double-submit cookie on every mutating route except sign-in
  and signup. CORS is locked to `WEB_ORIGIN` with credentials.
- **GitHub OAuth.** Random `state` in a signed cookie, compared on callback.
  The access token is stored AES-256-GCM encrypted. Clone errors are
  scrubbed so the token-bearing URL never reaches responses (tested).
- **Repo input (SSRF boundary for cloning).** Only
  `https://github.com/<owner>/<repo>` is accepted. Branch and subdir are
  validated (no `..`, no leading `-`).
- **Gemini prompt injection.** Repo profiles and job logs are fenced as
  untrusted data in every prompt. Profiles are redacted before sending.
  Whatever comes back is schema-validated, and nothing the model says is
  trusted. The static gate refuses `provisioner`, `data "external"`,
  `data "http"` and file-reading functions before Terraform runs on the
  worker. The plan policy re-checks the planned resources, and the Free
  Tier policy is computed from the plan, never from the model's claims.
- **Credentials.** Queue payloads carry ids only. The worker assumes the
  user's role itself, with an ExternalId and short sessions. Env var
  values go straight to SSM in the user's account; AutoInfra stores names
  only. Log lines sent to Gemini for diagnosis are redacted (AWS keys,
  tokens, `password=` values, JWTs).
- **Applying changes.** Nothing changes in AWS without an explicit
  approval. The apply step re-plans and refuses anything outside the
  approved plan. Data-bearing destroys and paid resources each need their
  own confirmation.
- **Rendering model output.** React escapes text. Mermaid runs with
  `securityLevel: "strict"`.

## Open / accepted risks

- **The deploy role is broad within its services.** It can create and
  delete what AutoInfra deploys (EC2, S3, CloudFront, Lambda, CodeBuild,
  ECR, SSM, CloudWatch, scoped IAM roles). It is scoped to `autoinfra-*`
  names where AWS allows, with explicit denies on Organizations, Account,
  and IAM user/key creation. A compromised worker could still damage
  AutoInfra-created resources in connected accounts.
- **The platform's own AWS identity** comes from `~/.aws` on the host
  (mounted read-only into the worker). That's fine locally. A hosted
  platform should use an instance or task role.
- **Rate limits and the stream cap are per IP or per user, with no
  CAPTCHA**, so a distributed attacker can still try passwords slowly
  across many IPs (10 attempts per account per 15 minutes bounds it).
  There's no account lockout email or 2FA.
- **Log redaction is pattern-based.** An unusual secret format in a build
  log could reach Gemini when the user clicks "Explain this failure".
- **No dependency or container image scanning in CI** for AutoInfra's own
  code. Trivy scans only the generated Terraform.
- **No email verification.** Users can change their password (which signs
  out their other sessions) and sign out everywhere, but there's no mail
  sending, so an email address -- including one added to a GitHub-only
  account -- is never verified, and there's no "forgot password" flow.
