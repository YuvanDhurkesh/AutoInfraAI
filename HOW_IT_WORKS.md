# AutoInfra: what's done and how it works

_Last updated: 27 October 2026_

This guide explains AutoInfra in plain words: what it does, what is finished,
and how each part works. Read it first. For more detail:

- [PLAN.md](PLAN.md): design decisions, database schema and API list
- [PROGRESS.md](PROGRESS.md): a log of every work session and how it was checked
- [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md): everything AutoInfra can't do, or does only partly
- [docs/security-review.md](docs/security-review.md): threats, fixes and accepted risks

## Contents

1. [What AutoInfra is](#1-what-autoinfra-is)
2. [What is done](#2-what-is-done)
3. [The parts of the system](#3-the-parts-of-the-system)
4. [Deploying an app, step by step](#4-deploying-an-app-step-by-step)
5. [The three ways an app is hosted](#5-the-three-ways-an-app-is-hosted)
6. [After the app is live](#6-after-the-app-is-live)
7. [Free Tier protection](#7-free-tier-protection)
8. [Security](#8-security)
9. [Where the code is](#9-where-the-code-is)
10. [Running AutoInfra on your computer](#10-running-autoinfra-on-your-computer)
11. [Tests](#11-tests)
12. [What is not done, and known limits](#12-what-is-not-done-and-known-limits)
13. [Words used in this guide](#13-words-used-in-this-guide)

---

## 1. What AutoInfra is

AutoInfra takes an app from a GitHub repository and puts it on the internet,
inside **your own AWS account**, using only AWS services that fit the
**AWS Free Tier**.

You do three things:

1. **Connect your AWS account.** One click. You never paste access keys.
2. **Paste a GitHub link**, for example `https://github.com/owner/repo`.
3. **Check the plan** (what will be created) and click **Approve & deploy**.

AutoInfra does everything else:

```
read the code -> choose a design -> write Terraform -> check it 9 ways
  -> you approve -> create the AWS resources -> build the app
  -> check that it answers -> live at https://xxxx.cloudfront.net
```

Once the app is live, you can deploy new commits, ask for infrastructure
changes in plain words, go back to an earlier version, or delete everything.

AutoInfra itself runs on your own computer, with Docker or in three terminal
windows. Hosting AutoInfra on the internet for other people was out of scope.

---

## 2. What is done

All 11 planned milestones are built. The one item still open from the plan
is a full demo on real AWS: some features have only been tested with a fake
AWS and a fake Gemini.

How to read the last column:

- **Real AWS**: has worked end to end in a real AWS account.
- **Local run**: built and run on this computer (for example in Docker), but never deployed to AWS.
- **Tests only**: covered by automated tests that use a fake AWS and a fake Gemini. Never run for real.

| Area         | Feature                                                                               | How it was checked                                                                                                                                                                            |
| ------------ | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accounts     | Sign up and log in with email and password                                            | Tests, browser click-through                                                                                                                                                                  |
| Accounts     | Change password, add a password to a GitHub account, sign out everywhere              | Tests, browser click-through                                                                                                                                                                  |
| Accounts     | Log in with GitHub; connect GitHub for private repos                                  | Tests (GitHub's servers faked). No real run yet: it needs a GitHub OAuth app, and `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` are empty on this machine.                                        |
| Connect AWS  | One-click connect: a CloudFormation stack creates the role and reports back by itself | Real AWS                                                                                                                                                                                      |
| Connect AWS  | "Update permissions" when AutoInfra's role template changes                           | Real AWS                                                                                                                                                                                      |
| Analyze      | Repo scanner                                                                          | Tests (22 sample repos and the 2 example apps)                                                                                                                                                |
| Design       | Blueprints: fixed, tested designs for common app types, with no AI call               | Tests, real Terraform checks (see [Tests](#11-tests))                                                                                                                                         |
| Design       | Gemini designs for apps no blueprint fits                                             | Real Gemini calls, tests                                                                                                                                                                      |
| Generate     | Terraform files, the 9 checks, and the AI repair loop                                 | Real Gemini and real Terraform                                                                                                                                                                |
| Deploy       | F3: static sites                                                                      | Real AWS: one site with Gemini's Terraform, one with the blueprint                                                                                                                            |
| Deploy       | F2: one EC2 server with Docker                                                        | Real AWS: with Gemini's Terraform (React + Express + MySQL, 20 Oct), and **with the blueprint** (React + Express + Sequelize + Postgres, 28 Oct: 36 resources, migrations, live in 8 minutes) |
| Deploy       | F1: serverless with Lambda                                                            | Real AWS with the blueprint (FastAPI, 29 Oct): 24 resources, packaged by CodeBuild, live; the Lambda's own address refuses requests that don't come through CloudFront (403)                  |
| Deploy       | Server-rendered frontends (Next.js, Nuxt, SvelteKit) on F2                            | Local run                                                                                                                                                                                     |
| Deploy       | Go and Spring Boot backends (AutoInfra writes the Dockerfile)                         | Local run                                                                                                                                                                                     |
| Deploy       | Other languages with their own Dockerfile (Ruby, PHP, ...)                            | Tests only                                                                                                                                                                                    |
| Deploy       | Databases hosted outside AWS (MongoDB Atlas, Neon, Supabase, ...)                     | Tests only                                                                                                                                                                                    |
| Deploy       | Database backups on F2                                                                | Real AWS: the backup before a deploy ran and reached S3 (28 Oct); the daily timer is installed, and restores were checked locally against real database containers                            |
| Deploy       | F2 database and Redis wiring (the compose file AutoInfra writes)                      | Local run: Postgres + Redis and MySQL stacks started in Docker; the app connected with only the settings AutoInfra filled in                                                                  |
| After live   | Redeploy the latest commit                                                            | Real AWS (28 Oct): 0 infrastructure changes, rebuilt and restarted with a new env value, data kept, live in 4.5 minutes                                                                       |
| After live   | Change requests in plain words                                                        | Tests only                                                                                                                                                                                    |
| After live   | "Explain this failure" (AI)                                                           | Tests only                                                                                                                                                                                    |
| After live   | Roll back to an earlier version                                                       | Tests only                                                                                                                                                                                    |
| After live   | History of versions, with diffs                                                       | Tests, browser click-through                                                                                                                                                                  |
| After live   | Destroy everything, then check for leftovers                                          | Real AWS                                                                                                                                                                                      |
| Safety       | Rate limits, running-job cap, audit log, settings                                     | Tests                                                                                                                                                                                         |
| Platform     | AutoInfra itself in Docker (`docker compose up`)                                      | Local run: the three images build; the API and website containers started and answered (the worker container wasn't started, so it couldn't take your real jobs)                              |
| Stretch goal | Pause and resume an F2 server                                                         | **Not built**                                                                                                                                                                                 |

### Checks run on 27 October 2026

| Check                                              | Result                                                                                             |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Typecheck, all packages                            | Pass                                                                                               |
| Lint                                               | Pass                                                                                               |
| Production build (12 tasks, including the web app) | Pass                                                                                               |
| Automated tests, all packages                      | 320 of 320 pass                                                                                    |
| Blueprint matrix (real Terraform on 23 app types)  | 23 of 23 pass in one run (part of the 320)                                                         |
| Formatting (`pnpm format:check`)                   | Pass                                                                                               |
| AutoInfra's own Docker images (api, worker, web)   | All three build; the API and website containers started and answered; no `.env` inside any image   |
| Generated F2 compose files, started in Docker      | Postgres + Redis and MySQL: the stand-in app connected using only the settings AutoInfra filled in |

---

## 3. The parts of the system

```
 You (browser)
      |
      v
 +---------+  HTTP   +---------+        +-----------------------------+
 |   web   | ------> |   api   | -----> | Postgres: all records       |
 | Next.js | <------ | Fastify |        | Redis: job queues,          |
 |  :3000  |  logs   |  :4000  |        |   live logs, rate limits    |
 +---------+         +----+----+        +--------------^--------------+
                          | jobs (through Redis)       |
                          v                            |
                     +---------+                       |
                     | worker  | ----------------------+
                     +----+----+
                          |--> GitHub: clone the repo
                          |--> Gemini: only when it is needed (see below)
                          '--> YOUR AWS account: through the deploy role
```

| Part                 | What it does                                                                                                                                                                                                                 | Code                                                  |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| **web**              | The screens you use. Talks only to the api.                                                                                                                                                                                  | `apps/web`                                            |
| **api**              | Login and sessions. Checks that every request is about your own records. Saves records and starts jobs. It makes a few quick AWS calls itself (for example, saving env var values). Everything slow is a job for the worker. | `apps/api`                                            |
| **worker**           | Runs the jobs: analyze, design, generate and validate, apply, destroy. Also listens for new AWS connections.                                                                                                                 | `apps/worker`; the job code is in `packages/pipeline` |
| **Postgres**         | Stores all records (see "Where data lives" below).                                                                                                                                                                           | `apps/api/prisma/schema.prisma`                       |
| **Redis**            | Job queues, live log lines, rate-limit counters.                                                                                                                                                                             |                                                       |
| **Your AWS account** | Where your app runs. AutoInfra gets in only through the role you created.                                                                                                                                                    |                                                       |
| **Gemini**           | Google's AI model. **Optional.** Used for apps no blueprint fits, change requests, repairing Terraform that failed a check, and "Explain this failure". Apps that a blueprint fits deploy without it.                        | `packages/llm`                                        |

### Jobs and queues

The worker has two queues:

- `deployment-prep`: analyze and design, up to 4 at a time.
- `deployment-jobs`: generate, apply and destroy, up to 2 at a time.

A step can start the next one by itself (analyze -> design -> generate), so
the work continues even if you close the browser tab.

Each job runs only once. If the worker stops in the middle of a job, that job
is marked "failed" when the worker starts again, and you retry it. AutoInfra
never re-runs infrastructure work on its own. Queue messages carry only ids,
never credentials.

### Live logs

Every log line is saved in Postgres (`job_logs`) and published on Redis. The
page shows the lines as they happen, through a stream (Server-Sent Events). If
you reload the page, the stream first replays the earlier lines.

### Where data lives

| What                                                              | Where                                                                                                                                 |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Users, sessions, deployments, revisions, jobs, logs, audit events | Postgres, on your computer                                                                                                            |
| Your GitHub token                                                 | Postgres, encrypted (AES-256-GCM, with `ENCRYPTION_KEY`)                                                                              |
| Passwords                                                         | Postgres, as argon2 hashes only                                                                                                       |
| Env var **names**                                                 | Postgres                                                                                                                              |
| Env var **values**                                                | SSM Parameter Store in **your** AWS account, under `/autoinfra/<id>/<NAME>` (secrets as SecureString). Never in AutoInfra's database. |
| Terraform state                                                   | An S3 bucket in your account, `autoinfra-tfstate-<account>-<region>` (private, versioned, encrypted)                                  |
| Your code, for each build                                         | The deployment's artifacts bucket in your account                                                                                     |
| F2 database backups                                               | The artifacts bucket, folder `backups/`, kept for 7 days                                                                              |

The database tables are: User, Session, GithubConnection, AwsConnection,
Deployment, Revision, Job, JobLog, EnvVar, FreeTierLedgerEntry, LlmCall and
AuditEvent. [PLAN.md](PLAN.md) describes each one.

---

## 4. Deploying an app, step by step

### Step 0: Connect AWS (once for each AWS account)

1. You click **Connect AWS**. AutoInfra opens the AWS CloudFormation
   "quick create" page, with AutoInfra's template already filled in.
2. You tick the box that allows creating an IAM role, and click **Create stack**.
3. The stack creates a role named `AutoInfraDeployRole`. Only AutoInfra's own
   AWS account can use it, and only with a secret code (the **ExternalId**)
   made for this connection.
4. The stack reports back by itself. One part of the stack sends a message to
   AutoInfra's SNS topic. The message goes to an SQS queue, which the worker reads.
5. The worker checks the ExternalId and tries the role. It finds out which
   Free Tier plan your account is on, and which instance types are free for
   it. Then it tells CloudFormation "success". If anything is wrong, it
   answers "failed", and the stack rolls back.

There is also a manual way: download the template, create the stack
yourself, and paste the role's ARN.

Code: `apps/api/src/routes/aws.ts`, `packages/pipeline/src/connection.ts`,
`packages/aws/src/platform.ts`, `packages/terraform-reference/src/deploy-role-template.ts`.

### Step 1: Create a deployment

On **New deployment** you paste the repo link. Only
`https://github.com/<owner>/<repo>` links are accepted. Optional settings:

- **Branch** and **subfolder** (for a repo that holds several apps).
- **Free Tier mode**: strict (the default) or flexible. See [section 7](#7-free-tier-protection).
- **Database hosted outside AWS**: tick it if the app uses a database such as
  MongoDB Atlas or Neon. This can't be changed later.

Creating the deployment starts the chain analyze -> design -> generate. The
chain stops at the review screen.

### Step 2: Analyze (read the repo)

The worker clones the repo: a shallow copy of one commit. For a private repo
it uses your GitHub token. Submodules and Git LFS files are included.

Then the **scanner** reads the files. It uses no AI, only fixed rules. It
writes what it finds into a **RepoProfile**:

- the frontend framework, and whether it needs its own server (server-side rendering)
- the backend: language, framework, port, start command, health route, and API prefix (such as `/api`)
- WebSockets or socket.io, and whether the app writes files to local disk
- the database, and whether it is hosted outside AWS
- Redis used next to the main database (for a cache, sessions or job queues)
- database schema scripts (for example `init.sql`)
- the env vars the code reads
- backend routes, dev-proxy paths and frontend pages (used for routing)
- hardcoded `localhost` URLs
- database connections written into the code with a `localhost` or
  hosted-database address (RDS, Atlas, Neon, ...). The deployed app wouldn't
  use AutoInfra's database, so the review screen warns you, with the file and
  line to change (and any password in it masked).
- secrets committed by mistake. The scanner reports **that** a file looks like
  it holds a secret. It never copies the value.

The scanner also suggests a hosting pattern. Or it explains why the app can't
be supported: nothing it recognizes, GPU or machine-learning libraries, or a
backend in another language without a Dockerfile.

It understands the usual layouts: the app at the top level, a `frontend/` and
a `backend/` folder, npm or pnpm workspaces, and a subfolder that holds a whole
app. It stops after 5,000 files and skips files over 1 MB.

Code: `packages/scanner`.

### Step 3: Design (choose the architecture)

There are two ways to get a design:

- **A blueprint (no AI).** If the app is a type AutoInfra has a tested
  blueprint for, the design comes from that blueprint. This covers most
  common apps (see [section 5](#5-the-three-ways-an-app-is-hosted)).
- **Gemini.** Otherwise, Gemini designs it. Gemini sees only the scanner's
  structured findings: no file contents, no env values, no secrets. It also
  gets the list of allowed services, the Free Tier limits and your account's
  free instance types. Its answer must match a strict format and pass the
  Free Tier check. If it doesn't, the answer goes back to Gemini with the
  errors, up to 3 tries.

Either way, AutoInfra works out the Free Tier report itself. It never trusts
the AI's own opinion about cost.

You see a diagram, the list of AWS resources with a Free Tier badge, and the
risks and assumptions.

Code: `packages/terraform-reference/src/blueprint/`,
`packages/llm/src/design.ts`, `packages/pipeline/src/prepare-jobs.ts`.

### Step 4: Generate and check the Terraform

The Terraform files come from the blueprint, or from Gemini. Either way,
AutoInfra writes `providers.tf` and `variables.tf` itself, and decides every
variable value (region, names, ports, instance type). The AI never decides
those.

Every set of files then goes through the **validation gauntlet**: nine
checks, in this order.

| #   | Check                | What it catches                                                                                                                                                                                                                                              |
| --- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Static checks        | Dangerous features (provisioners, `external` and `http` data sources, modules, other providers, reading files outside the folder), plus AutoInfra's own rules for layout, Docker Compose, server frontends and databases. Runs before any Terraform command. |
| 2   | `terraform fmt`      | Formatting (fixed automatically)                                                                                                                                                                                                                             |
| 3   | `terraform init`     | Providers that can't be downloaded, files that don't load                                                                                                                                                                                                    |
| 4   | `terraform validate` | Invalid Terraform                                                                                                                                                                                                                                            |
| 5   | tflint               | Common Terraform mistakes                                                                                                                                                                                                                                    |
| 6   | trivy                | Security problems. HIGH and CRITICAL findings fail, except a short recorded list that conflicts with the Free Tier, such as "add a WAF" (a WAF costs money).                                                                                                 |
| 7   | `terraform plan`     | A read-only preview against your real AWS account                                                                                                                                                                                                            |
| 8   | Security policy      | On the plan: no wildcard IAM permissions, no IAM users or keys, no public buckets, no ports open to the whole internet, required tags, correct region                                                                                                        |
| 9   | Free Tier policy     | On the plan: see [section 7](#7-free-tier-protection)                                                                                                                                                                                                        |

If a check fails, the exact errors go to Gemini, which fixes the files. There
are up to 4 attempts in total. A blueprint that fails a check is also sent to
Gemini for repair, if Gemini is set up.

If tflint or trivy can't run (not installed, and no Docker), that check is
marked "skipped". A skipped check never counts as passed, so those files
can't be approved.

**Network problems are not mistakes in the files.** `terraform init` needs
`registry.terraform.io`. If it can't reach the network, AutoInfra tries again
after 15 seconds, then after 45 seconds. A network failure (in `init` or
`plan`) and a crashed tflint or trivy are never sent to Gemini to "fix": the
step stops with a clear message to check the internet connection and retry.
Behind a proxy, set `HTTPS_PROXY` and `NO_PROXY` for the worker; Terraform
gets them.

Code: `packages/terraform-runner` (`gauntlet.ts`, `pipeline.ts`, `init.ts`),
`packages/terraform-policy`.

### Step 5: Review and approve

The review screen shows:

- the plan: what will be created, changed or deleted, with a warning for
  anything that holds data
- the Free Tier report
- the Terraform files
- a form for the env vars the scanner found. AutoInfra fills in the ones it
  knows: database settings (`DB_HOST`, `DATABASE_URL`, and copies such as
  `PROD_DB_HOSTNAME`), Redis settings (`REDIS_URL`), and the live address for
  settings such as `CLIENT_URL`, `NEXTAUTH_URL` and CORS origins. You fill in
  the rest, one row at a time or with **Paste a .env file**: the paste leaves
  out what AutoInfra sets itself, and never uses a placeholder secret such as
  `supersecretkey_example` (you type your own). Names that AutoInfra or AWS
  use themselves (`AWS_*`, `AUTOINFRA_*`, `PORT`, ...) are reserved.

**Approve & deploy** is refused unless all of these are true:

- every check passed
- in strict mode, there is no Free Tier violation
- in flexible mode, you confirmed the paid resources
- you confirmed any env vars left empty
- you confirmed any delete or replace of a resource that holds data (S3,
  EBS disks, databases, DynamoDB)

Every approval is saved in the audit log.

### Step 6: Apply, build, deploy, health check

The worker's apply job:

1. Uses the role in your account (`sts:AssumeRole` with the ExternalId).
2. Creates the Terraform state bucket, if it doesn't exist yet.
3. Runs `terraform init` with that state, makes a fresh plan, and runs the
   security and Free Tier checks again.
4. Refuses anything you didn't approve. The fresh plan must be the approved
   plan, or a part of it, so a retry after a half-finished apply still works.
5. Runs `terraform apply`. Its progress appears in the live log.
6. Reads the outputs (addresses, ids) and records the deployment's Free Tier use.
7. Zips your code at the exact approved commit, adds AutoInfra's generated
   files under `.autoinfra/`, and uploads the zip to your artifacts bucket
   (in 8 MB parts, each retried on network errors).
8. Starts **CodeBuild** in your account, and shows its logs. CodeBuild:
   - builds a static frontend and copies it to S3
   - for F2: builds the Docker images, pushes them to ECR, and tells the EC2
     server (through SSM) to pull them and restart
   - for F1: packages the backend and updates the Lambda function
   - clears the CloudFront cache
9. Runs health checks through CloudFront: the home page and the backend's
   health route must answer. These all count as "not healthy": a 5xx error,
   the "deploying" placeholder page, an answer from S3 instead of the
   backend, and a Lambda that refuses CloudFront.
10. Sets the status to **live**, with the `https://....cloudfront.net` address.

If a step fails, you see a plain reason (and the Lambda logs, for F1). You can
retry with the same checked files, or click **Explain this failure**.

Code: `packages/pipeline/src/apply-job.ts`, `packages/terraform-runner/src/apply.ts`,
`packages/pipeline/src/health.ts`, the build scripts in `packages/terraform-reference/platform-app/`.

### Deployment statuses

```
queued -> analyzing -> designing -> generating -> validating -> awaiting_approval
       -> applying -> building -> deploying -> health_checking -> live

live -> destroying -> destroyed
any step -> failed   (with a reason; most steps can be retried)
```

During a change or a rollback, the site keeps serving the live version until
you approve the new one and it is applied. A redeploy starts at once, because
the infrastructure doesn't change.

---

## 5. The three ways an app is hosted

|                    | F3: static site                                               | F1: serverless                                                                                                 | F2: one server                                                                                                                                           |
| ------------------ | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Used for           | A frontend with no backend                                    | A Node or Python backend that only answers HTTP requests                                                       | Everything else                                                                                                                                          |
| Your code runs on  | Nothing: files only                                           | AWS Lambda                                                                                                     | One EC2 instance with Docker Compose                                                                                                                     |
| Main AWS resources | Private S3 bucket, CloudFront, CodeBuild, an artifacts bucket | Everything in F3, plus a Lambda function with a Function URL, and DynamoDB if the app uses it                  | Everything in F3, plus an EC2 instance, an Elastic IP, its own VPC, a security group, an ECR repository and SSM parameters                               |
| Database           | None                                                          | DynamoDB, or one hosted outside AWS                                                                            | Postgres, MySQL, MongoDB or Redis in a container on the instance (plus a second Redis container when the app also uses Redis), or one hosted outside AWS |
| Good to know       | Simplest and cheapest                                         | Cold starts; requests through CloudFront time out after about 30 s; the package can be at most 250 MB unzipped | 1 GB of memory (plus 1 GB of swap); one server, so no high availability; daily database backups                                                          |

F1 runs the backend with the AWS Lambda Web Adapter, so a normal Express or
Flask app works without changes.

### How AutoInfra picks a pattern

1. A frontend that needs its own server (Next.js with server features, a Nuxt
   server, a SvelteKit server) -> **F2**. The frontend server runs in its own
   container.
2. A frontend with no backend -> **F3**.
3. A Node or Python backend that is stateless (no WebSockets, no files written
   to local disk) and has no database that must run next to it -> **F1**.
4. Anything else (WebSockets, local files, a database in a container, Go, Java,
   or another language with its own Dockerfile) -> **F2**.
5. No blueprint fits (for example Remix, or Astro's server mode) -> Gemini
   designs it, still as F1, F2 or F3, and with the same checks.

### Inside an F2 server

Docker Compose runs:

- **Caddy**, the front door. It only accepts requests that carry a secret
  header CloudFront adds, so nobody can reach the server directly. The
  security group also lets in only CloudFront's addresses.
- your backend container
- the database container, if there is one (backed up to S3 every day)
- a Redis container, when the app uses Redis next to its database (64 MB)
- the frontend server container, for server-rendered frontends

Every deploy also checks the server itself: if its first-boot setup (Docker,
Docker Compose, swap) didn't finish -- for example a download failed -- the
deploy finishes it, instead of failing.

### One address for everything

CloudFront serves the frontend, and sends backend paths to the backend:

- the API prefix (`/api`)
- other backend paths the scanner found, such as `/socket.io`, WebSocket
  paths, dev-proxy paths, and top-level routes like `/auth` or `/uploads`.
  At most 8 of these, and never a path where the frontend has a page.

If the code calls `http://localhost:5000`, the copy that gets built is changed
to call the live address (`ws://` becomes `wss://`). Your repo itself is never
changed.

Code: the blueprint templates in `packages/terraform-reference/blueprints/`,
the build scripts in `packages/terraform-reference/platform-app/`, and the
routing rules in `packages/shared/src/routing.ts`.

---

## 6. After the app is live

Every deployment has numbered **revisions**. A revision is one version: the
commit, the scan, the design, the Free Tier report, the Terraform files and
the plan. The **current revision** is the one that is live now.

**History** lists every revision, with its kind (initial, change, rollback or
redeploy) and its state (live now, superseded, failed, discarded, ...).
**View changes** compares two revisions: the commit, the components, and the
Terraform files line by line.

| Action                     | What happens                                                                                                                                                                                                                                                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Redeploy latest commit** | Use it after you push code to GitHub. AutoInfra fetches the newest commit and scans it again. It refuses if the app's type changed, and asks about new env vars. Then it builds and deploys the new code on the same infrastructure. The Terraform plan must show no changes.                                                                     |
| **Request a change**       | Describe an infrastructure change in plain words, for example "increase the disk to 25 GB". Gemini edits the live Terraform, all nine checks run, and you approve the exact plan. You can discard a pending change. Code changes go through GitHub and Redeploy instead.                                                                          |
| **Roll back**              | Choose an earlier revision that was live. AutoInfra checks its Terraform again (no AI) against what is running now, and you approve. Then it applies those files and rebuilds that commit. It works only within the same pattern, and it doesn't bring back deleted data. Env var values aren't versioned: the old code runs with today's values. |
| **Env vars**               | Edit them at any time. F1 picks up new values on its next cold start; F2 on the next deploy.                                                                                                                                                                                                                                                      |
| **Explain this failure**   | Appears on a failed step. Gemini reads the last 150 log lines (keys, tokens and passwords are hidden first). It answers with a summary, the likely cause, a suggested fix, and who should fix it. If the fix is an infrastructure change, it can fill in a change request for you.                                                                |
| **Destroy**                | Runs `terraform destroy` and deletes the SSM values. Then it searches your account for anything still tagged with this deployment, and lists it.                                                                                                                                                                                                  |

---

## 7. Free Tier protection

AWS has two kinds of Free Tier accounts:

- **Legacy** (created before 15 July 2025): 12 months of free usage limits,
  for example 750 hours a month of a small EC2 instance.
- **Free plan** (created on or after 15 July 2025): up to about $200 in
  credits for 6 months. After that the account closes unless you upgrade it.
  **AutoInfra never upgrades it.** The dashboard warns you, in red when fewer
  than 30 days are left.

AutoInfra finds out which kind your account is when it connects. If it can't
tell, it asks you.

**Modes**

- **Strict** (the default): every resource must be Free Tier eligible.
  Anything else is refused.
- **Flexible**: paid resources are allowed, but you must confirm them before
  deploying.

**Never allowed in strict mode:** NAT Gateway, Fargate, load balancers, API
Gateway, Multi-AZ RDS, Aurora, ElastiCache, OpenSearch, EKS, Route 53 hosted
zones, WAF, customer-managed KMS keys, Secrets Manager, and Elastic IPs that
aren't attached to an instance.

**Size limits:** 30 GB of EBS disk in total, 20 GB of RDS storage, a retention
period on every log group, and an instance type from your account's free list.

**One always-on EC2 instance for each AWS account:** the 750 free hours are
shared by the whole account. So strict mode allows one always-on instance for
each AWS account, across all of its deployments and every connection to it
(another region, or another person who connected the same account). A failed
deployment still counts while it has an instance; one being destroyed doesn't,
so you can destroy an app and deploy another straight away. When the instance
is taken, the design step names the deployment using it.

**Checked three times:** on the design, on the Terraform plan before you
approve, and again just before apply.

The limits are in `packages/free-tier-policy/policy.json`, last checked
against AWS's own pages on 16 October 2026. AWS can change its terms, and
nothing re-checks them automatically. There is no cost model yet: an
estimated cost of 0 means "not priced", not "free".

---

## 8. Security

**No access keys.** AutoInfra uses a role in your account that only
AutoInfra's AWS account can use, and only with your connection's secret
ExternalId. Where AWS allows it, the role is limited to resources named
`autoinfra-*`. It is explicitly denied AWS Organizations, account settings,
and creating IAM users or access keys.

**Your secrets**

- Env var values go only to SSM, in your account.
- Your GitHub token is stored encrypted.
- Passwords are stored as argon2 hashes.
- Secrets found in a repo are reported, never copied and never sent to Gemini.

**Logins:** an httpOnly session cookie backed by a `Session` table, CSRF
protection (a double-submit token), and a lock after 10 failed sign-ins on one
account within 15 minutes.

**Only your own records:** every database query is limited to the signed-in
user (`ownerId`). A test checks that one user can't see another user's
deployments.

**The AI is never trusted**

- Gemini sees structured scan results only, marked as untrusted data.
- Its answers must match a strict format.
- The server checks everything again (security and Free Tier).
- You approve every plan.

**Tools run in isolation:** Terraform, tflint and trivy get a clean
environment, with no AutoInfra secrets: only the role's short-lived
credentials.

**Limits on use:** sign-ins and signups are rate-limited. AI steps: 30 per
hour per user. New deployments: 20 per day. AWS connects: 20 per hour. All
requests: 600 per minute per IP address. Each user can have at most
`MAX_RUNNING_JOBS_PER_USER` steps running at once (default 3; destroy is never
blocked).

**Audit log:** sign-ins (including failed ones), approvals, password and env
var changes, AWS connection changes and settings changes. You can see it under
**Settings**.

**Accepted risks** (details in [docs/security-review.md](docs/security-review.md)):

- The deploy role is broad within the services it needs.
- There is no two-factor login, no email check and no "forgot password" email.
- Secrets are hidden in logs by matching patterns, so a secret in an unusual
  format could reach Gemini.
- CI doesn't scan AutoInfra's own dependencies.

---

## 9. Where the code is

AutoInfra is one repository with several parts (a pnpm + Turborepo monorepo).

| Folder                         | What it does                                                                                                                      | Main files                                                                                                             |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `apps/web`                     | The website (Next.js, Tailwind, TanStack Query, Mermaid diagrams)                                                                 | `src/app/**/page.tsx`, `src/components/`                                                                               |
| `apps/api`                     | The HTTP API (Fastify, Zod, Prisma)                                                                                               | `src/routes/`, `src/lib/`, `prisma/schema.prisma`                                                                      |
| `apps/worker`                  | Runs jobs from the queues                                                                                                         | `src/index.ts`                                                                                                         |
| `packages/shared`              | Data shapes used everywhere (Zod schemas), routing rules, diffs                                                                   | `repo-profile.ts`, `architecture-plan.ts`, `enums.ts`, `routing.ts`, `platform-env.ts`                                 |
| `packages/scanner`             | Clones and reads repos                                                                                                            | `clone.ts`, `scan.ts`, `pattern.ts`, `detectors/`                                                                      |
| `packages/llm`                 | Gemini client, prompts, hiding secrets                                                                                            | `gemini-client.ts`, `design.ts`, `terraform.ts`, `diagnose.ts`, `redact.ts`                                            |
| `packages/terraform-reference` | Blueprints, AutoInfra's own Terraform files, build scripts, the role template, and reference projects shown to Gemini as examples | `src/blueprint/`, `blueprints/`, `platform/`, `platform-app/`, `reference/`, `src/deploy-role-template.ts`             |
| `packages/terraform-runner`    | The 9 checks, the repair loop, apply and destroy                                                                                  | `gauntlet.ts`, `pipeline.ts`, `apply.ts`, `destroy.ts`, `tools.ts`                                                     |
| `packages/terraform-policy`    | Static checks and plan security checks                                                                                            | `static-checks.ts`, `plan-checks.ts`, `summary.ts`                                                                     |
| `packages/free-tier-policy`    | Free Tier limits and the checker                                                                                                  | `policy.json`, `evaluator.ts`                                                                                          |
| `packages/aws`                 | AWS SDK helpers                                                                                                                   | `sts.ts`, `free-tier.ts`, `ec2.ts`, `state-bucket.ts`, `build.ts`, `parameters.ts`, `platform.ts`, `tagging.ts`        |
| `packages/pipeline`            | The job code the worker runs                                                                                                      | `prepare-jobs.ts` (analyze, design), `generate-job.ts`, `apply-job.ts`, `destroy-job.ts`, `health.ts`, `connection.ts` |
| `examples/`                    | Two sample apps: `react-express-lambda` (F1) and `react-node-postgres-ws` (F2)                                                    |                                                                                                                        |
| `docs/`                        | GitHub OAuth setup, security review                                                                                               |                                                                                                                        |

### Screens

| Page                | What it is for                                                                                                                            |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `/signup`, `/login` | Create an account, or log in (also with GitHub, when an OAuth app is set up)                                                              |
| `/dashboard`        | Your deployments, and warnings about your connections                                                                                     |
| `/aws/connect`      | Connect an AWS account                                                                                                                    |
| `/deployments/new`  | Paste a repo link                                                                                                                         |
| `/deployments/[id]` | Everything about one deployment: progress, live logs, review and approve, the live address, history, changes, rollback, env vars, destroy |
| `/settings`         | Default Free Tier mode, password, sessions, activity log                                                                                  |

### API

| Group           | Routes                                                                                                                                                                                                                  |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Health          | `GET /health`                                                                                                                                                                                                           |
| Login           | `GET /auth/csrf`, `POST /auth/signup`, `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`, `GET /auth/providers` (is GitHub sign-in set up?), `GET /auth/github`, `GET /auth/github/callback`                      |
| Account         | `GET` and `PUT /account/settings`, `POST /account/password`, `POST /account/sessions/revoke`, `GET /account/audit`                                                                                                      |
| AWS connections | `GET` and `POST /aws/connections`; `GET /aws/connections/:id`, plus `/connect-link`, `/permission-update`, `/template`; `PATCH .../:id/role`; `POST .../:id/verify` and `.../:id/regime`; `DELETE /aws/connections/:id` |
| Deployments     | `GET` and `POST /deployments`; `GET /deployments/:id`; `POST /deployments/:id/` + `analyze`, `design`, `generate`, `approve`, `redeploy`, `changes`, `changes/discard`, `rollback`, `destroy`                           |
| Env vars        | `GET` and `PUT /deployments/:id/env`, `DELETE /deployments/:id/env/:name`                                                                                                                                               |
| History         | `GET /deployments/:id/revisions`, `GET .../revisions/:number`, `GET .../revisions/:number/diff`                                                                                                                         |
| Jobs            | `GET /jobs/:id/logs`, `GET /jobs/:id/logs/stream` (live), `POST /jobs/:id/diagnose`                                                                                                                                     |

Every request that changes something needs the CSRF token. Every deployment
route checks that the deployment is yours.

---

## 10. Running AutoInfra on your computer

You need:

- Node.js 20 or newer (developed on 22.20.0), and pnpm
- Docker Desktop: for Postgres and Redis, and for tflint and trivy if they aren't installed
- Terraform 1.10 or newer on your PATH, if you run the worker outside Docker
- AWS credentials for AutoInfra's own identity, in `~/.aws`. Check them with
  `aws sts get-caller-identity`. They are used only to take on the role in
  connected accounts.
- A Gemini API key: for apps no blueprint fits, change requests, repairs and
  "Explain this failure"
- Optional: a GitHub OAuth app, for GitHub login and private repos (see
  [docs/github-oauth-setup.md](docs/github-oauth-setup.md))

Steps:

1. Copy `.env.example` to `.env`. Fill in `COOKIE_SECRET`, `ENCRYPTION_KEY`,
   `GEMINI_API_KEY`, `GEMINI_MODEL` and `AWS_REGION`. To make a secret:
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
   Also set `TF_PLUGIN_CACHE_DIR` to a folder that exists. Without it, every
   check downloads the AWS provider (about 700 MB) again.
2. `pnpm install`
3. `docker compose up -d postgres redis`. Postgres uses port 5433 and Redis
   port 6380, so they don't clash with programs already installed on this
   computer.
4. `pnpm --filter @autoinfra/api db:deploy` creates or updates the database
   tables (it reads `DATABASE_URL` from the `.env` in the project folder).
5. Start three processes, each in its own terminal:
   - `pnpm --filter @autoinfra/api dev` (the API, port 4000)
   - `pnpm --filter @autoinfra/worker dev`
   - `pnpm --filter @autoinfra/web dev` (the website, port 3000)

   Or run everything in containers with `docker compose up --build`. The API
   container applies pending migrations itself (so step 4 isn't needed), and
   the API and worker containers read AutoInfra's AWS identity from `~/.aws`.
   Your `.env` is passed to the containers when they start; it is never
   copied into an image.

6. Open http://localhost:3000, sign up, and connect AWS.

The computer that runs the worker needs internet access to GitHub,
`registry.terraform.io`, Gemini and AWS.

---

## 11. Tests

Run every test with `pnpm test` from the project folder. You need:

- Postgres and Redis running, with the database migrated (steps 3 and 4 above).
- `TF_PLUGIN_CACHE_DIR` set in `.env` (the tests read it from there).
  Without it, every Terraform test downloads the AWS provider again, and the
  full run can take hours.

The tests fake AWS and Gemini. Terraform, tflint, trivy and bash are real.

| Package             | Tests   | What they cover                                                                                                                                                                                                                               |
| ------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| api                 | 77      | The main flows through the real routes and the real job code: connect, paste a link, approve, deploy, redeploy, change, rollback, destroy, diagnose, isolation between users, rate limits, audit log, GitHub sign-in (GitHub's servers faked) |
| scanner             | 53      | The detection rules on 22 sample repos, the 2 example apps and small repos the tests write (layouts, databases, Redis, database settings in code); cloning, including paths longer than Windows' limit                                        |
| terraform-reference | 40      | Blueprint output (Redis container, Sequelize-style settings), and the build and deploy scripts run with real bash (`deploy.sh` and `rollout.sh` with stand-ins for AWS and Docker)                                                            |
| terraform-runner    | 31      | The 9 checks and the repair loop, with real Terraform; network failures retried and never sent to Gemini                                                                                                                                      |
| shared              | 29      | Data shapes, routing rules, diffs, env values (database and Redis settings)                                                                                                                                                                   |
| terraform-policy    | 24      | Static checks and plan security checks                                                                                                                                                                                                        |
| llm                 | 15      | Prompts, retries, hiding secrets                                                                                                                                                                                                              |
| free-tier-policy    | 14      | The Free Tier test cases from the brief                                                                                                                                                                                                       |
| pipeline            | 10 + 23 | Job helpers, and the blueprint matrix: 23 app types through real Terraform                                                                                                                                                                    |
| aws                 | 4       | Uploading in 8 MB parts, and retrying network errors                                                                                                                                                                                          |

To run only the blueprint matrix:

```powershell
cd packages/pipeline
npx vitest run src/blueprint-matrix.test.ts
```

**CI.** `.github/workflows/ci.yml` runs typecheck, lint, the database
migration and every test on GitHub Actions. It only runs once the project is
on GitHub.

---

## 12. What is not done, and known limits

**Not done yet**

- **A real run on AWS** of change requests, rollback, "Explain this
  failure", and the two example apps. (Both blueprints have gone live for
  real: F2 on 28 October, F1 on Lambda on 29 October; redeploy on 28
  October.)
- **A real run of GitHub login and connect.** Automated tests cover it now,
  but it has never run against GitHub itself: that needs a GitHub OAuth app
  (see [docs/github-oauth-setup.md](docs/github-oauth-setup.md)).
- **Two separate AWS accounts.** So far, AutoInfra's own account and the
  connected account have been the same account.
- **Pause and resume** for F2 servers (a stretch goal).
- **A cost model.** Costs show as 0, which means "not priced".

**Main limits** (the full list is in [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md))

- The scanner matches patterns; it is not a full code parser. It can miss
  ports, routes or env vars that are set in unusual ways.
- F2 runs on one small server: 1 GB of memory, no high availability, and the
  database on one disk. Restoring a backup is a manual job.
- The connection from CloudFront to the F2 server is plain HTTP (a
  certificate would need a load balancer, which isn't free). A secret header
  protects it.
- For F1 APIs that accept writes (POST, PUT), the Lambda Function URL is
  public, with CloudFront in front. The app's own login is what protects it.
- A repo's own `docker-compose.yml` isn't used. A repo with several services
  needs one deployment for each subfolder.
- Every generate and apply needs `registry.terraform.io` to be reachable.
  Short drops are retried; a longer outage stops the step with a message to
  retry, and is never sent to Gemini.
- Database settings written into an app's code can't be changed by
  AutoInfra: the review screen points at the line, and the code has to read
  env vars instead.
- AutoInfra itself runs only on your computer.

---

## 13. Words used in this guide

| Word                 | Meaning                                                                                                          |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- |
| AWS Free Tier        | AWS usage that costs nothing, within limits                                                                      |
| CloudFormation       | AWS's own service for creating resources from a template. AutoInfra uses it only to create the deploy role.      |
| CloudFront           | AWS's content delivery network. Each app gets one `https://....cloudfront.net` address.                          |
| CodeBuild            | AWS's build service. It builds your app inside your account.                                                     |
| Deploy role          | The IAM role `AutoInfraDeployRole` in your account, which AutoInfra uses                                         |
| EC2, EBS, Elastic IP | A virtual server, its disk, and a fixed public IP address                                                        |
| ECR                  | AWS's store for Docker images                                                                                    |
| ExternalId           | A secret code needed to use the deploy role, so that another AutoInfra user can't get AutoInfra to use your role |
| Lambda, Function URL | Runs code on request without a server; a direct HTTPS address for a Lambda function                              |
| S3                   | AWS file storage, organized in "buckets"                                                                         |
| SSM Parameter Store  | AWS storage for settings and secrets. It holds your env var values.                                              |
| SSM Run Command      | Runs a command on an EC2 server. Used to roll out new images on F2.                                              |
| STS AssumeRole       | Getting short-lived credentials for a role                                                                       |
| Terraform            | A tool that creates cloud resources from code files (`.tf`)                                                      |
| Terraform state      | Terraform's record of what it created                                                                            |
| tflint, trivy        | Tools that check Terraform files for mistakes, and for security problems                                         |
| Blueprint            | AutoInfra's fixed, tested design and Terraform template for a common type of app                                 |
| Gauntlet             | AutoInfra's nine checks on every set of Terraform files                                                          |
| Pattern (F1, F2, F3) | One of the three hosting shapes in [section 5](#5-the-three-ways-an-app-is-hosted)                               |
| RepoProfile          | What the scanner found in a repo                                                                                 |
| ArchitecturePlan     | The design: which AWS components, and their sizes                                                                |
| Revision             | One version of a deployment                                                                                      |
| Job                  | One step that runs on the worker: analyze, design, generate, apply or destroy                                    |
| Strict, flexible     | The two Free Tier modes in [section 7](#7-free-tier-protection)                                                  |
| BullMQ               | The job queue library (it uses Redis)                                                                            |
| Prisma               | The database library (it uses Postgres)                                                                          |
| Caddy                | The web server in front of the app on F2                                                                         |
