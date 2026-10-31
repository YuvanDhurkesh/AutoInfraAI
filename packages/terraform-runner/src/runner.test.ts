import { describe, expect, it } from "vitest";
import type { ArchitecturePlan, GateResult, RepoProfile } from "@autoinfra/shared";
import { MockLlmClient } from "@autoinfra/llm";
import { lambdaAdapterLayerArn, loadReference } from "@autoinfra/terraform-reference";
import { buildPlaceholderLambdaZip } from "./placeholder-zip.js";
import {
  checkBuildspecLayout,
  checkBuildspecArtifactUploads,
  checkComposeDatabaseName,
  checkComposeDatabaseStability,
  checkExternalDatabaseAccess,
  checkServerRenderedFrontend,
  checkComposeKeepsPlatformEnv,
  checkInstanceCanListArtifacts,
  runGauntlet,
  type TfVars,
} from "./gauntlet.js";
import { generateAndValidate } from "./pipeline.js";
import { initWithRetry, isNetworkError } from "./init.js";
import { repairErrors, unfinishedReason } from "./gauntlet.js";

const tfvars: TfVars = {
  region: "ap-south-1",
  deployment_id: "dep-test",
  owner: "user-test",
  short_id: "test1234",
  api_path_prefix: "/api",
  app_port: 4000,
  health_check_path: "/api/health",
  function_url_auth_type: "NONE",
  lambda_adapter_layer_arn: lambdaAdapterLayerArn("ap-south-1"),
  instance_type: "t3.micro",
  instance_architecture: "x86_64",
};

const common = {
  tfvars,
  freeTierMode: "strict" as const,
  eligibleInstanceTypes: ["t3.micro"],
  existingAlwaysOnEc2Count: 0,
  credentials: null,
  pluginCacheDir: process.env.TF_PLUGIN_CACHE_DIR,
};

/** Minimal central-directory reader, enough to verify our own writer. */
function readZip(buf: Buffer) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const crc = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const mode = (buf.readUInt32LE(p + 38) >>> 16) & 0o777;
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString();
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const data = buf.subarray(
      localOffset + 30 + localNameLen,
      localOffset + 30 + localNameLen + size,
    );
    entries.push({ name, mode, crc, data });
    p += 46 + nameLen;
  }
  return entries;
}

describe("placeholder Lambda zip", () => {
  it("contains an executable run.sh and is byte-for-byte deterministic", () => {
    const zip = buildPlaceholderLambdaZip();
    expect(buildPlaceholderLambdaZip().equals(zip)).toBe(true);
    const entries = readZip(zip);
    expect(entries.map((e) => e.name)).toEqual(["placeholder.js", "run.sh"]);
    expect(entries.find((e) => e.name === "run.sh")!.mode).toBe(0o755);
    expect(entries.find((e) => e.name === "run.sh")!.data.toString()).toContain(
      "exec node placeholder.js",
    );
  });
});

describe("static gate", () => {
  it("stops before any terraform command runs on unsafe code", async () => {
    const result = await runGauntlet({
      ...common,
      pattern: "F3",
      bundle: {
        files: [
          {
            path: "main.tf",
            content: 'data "external" "x" { program = ["curl", "http://169.254.169.254"] }',
          },
          { path: "buildspec.yml", content: "version: 0.2" },
        ],
      },
    });
    expect(result.passed).toBe(false);
    expect(result.gates.map((g) => g.gate)).toEqual(["static"]);
    expect(result.gates[0]!.errors.join()).toContain("external");
  });
});

describe("re-validating an earlier revision (rollback)", () => {
  it("runs the gauntlet once on the given files, with no model and no repair", async () => {
    const result = await generateAndValidate(null, {
      ...common,
      plan: { pattern: "F3", routing: { apiPathPrefix: "/api" } } as ArchitecturePlan,
      profile: {} as RepoProfile,
      reuse: {
        files: [
          {
            path: "main.tf",
            content: 'resource "aws_instance" "x" {\n  provisioner "local-exec" {}\n}\n',
          },
          { path: "buildspec.yml", content: "version: 0.2" },
        ],
      },
    });
    expect(result.passed).toBe(false);
    expect(result.attempts).toHaveLength(1);
    expect(result.bundle?.files[0]!.path).toBe("main.tf");
    expect(result.failureReason).toContain("no longer passes validation");
  });
});

describe("buildspec layout check", () => {
  // A real React + Express + MySQL repo with frontend/ and backend/ folders.
  const layout = {
    frontend: { rootDir: "frontend", outputDir: "dist" },
    backend: { rootDir: "backend", dockerfile: "backend/Dockerfile" },
  } as unknown as RepoProfile;

  it("rejects a buildspec that builds at the repo root (what Gemini first wrote)", () => {
    const wrong = `build:\n  commands:\n    - npm ci\n    - VITE_API_URL="$API_PATH_PREFIX" npm run build\n    - docker build -t "$ECR_REPOSITORY_URL:$IMAGE_TAG" .\n    - aws s3 sync dist "s3://$FRONTEND_BUCKET" --delete`;
    const errors = checkBuildspecLayout(wrong, layout, "F2");
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain('frontend folder "frontend"');
    expect(errors[1]).toContain("docker build -f backend/Dockerfile backend");
  });

  it("accepts a buildspec that uses the real folders", () => {
    const right = `    - cd frontend && npm ci && npm run build && cd ..\n    - docker build -t "$IMG" -f backend/Dockerfile backend\n    - aws s3 sync frontend/dist "s3://$FRONTEND_BUCKET" --delete`;
    expect(checkBuildspecLayout(right, layout, "F2")).toEqual([]);
  });

  it("has nothing to check for a repo-root app", () => {
    const root = { frontend: { rootDir: "." } } as unknown as RepoProfile;
    expect(checkBuildspecLayout("- npm ci && npm run build", root, "F3")).toEqual([]);
  });
});

describe("instance can list its deploy files", () => {
  const bootstrap = {
    path: "app/bootstrap.sh",
    content: 'aws s3 cp "s3://${artifacts_bucket}/deploy/" . --recursive --region "${region}"',
  };

  it("rejects GetObject-only access when deploy.sh copies the folder recursively (failed a real rollout)", () => {
    const iam = { path: "iam.tf", content: 'Action = ["s3:GetObject"]' };
    expect(checkInstanceCanListArtifacts([bootstrap, iam])[0]).toContain("s3:ListBucket");
  });

  it("accepts it once ListBucket is granted", () => {
    const iam = {
      path: "iam.tf",
      content: 'Action = ["s3:GetObject"]\nAction = ["s3:ListBucket"]',
    };
    expect(checkInstanceCanListArtifacts([bootstrap, iam])).toEqual([]);
  });
});

describe("compose keeps AutoInfra's env values", () => {
  const profile = {
    envVars: [
      { name: "CLIENT_URL", isSecret: false },
      { name: "NODE_ENV", isSecret: false },
    ],
    database: "mysql",
  } as unknown as RepoProfile;

  it('rejects CLIENT_URL: "*" in compose (broke every browser write on a real deploy)', () => {
    const errors = checkComposeKeepsPlatformEnv(
      '      CLIENT_URL: "*"\n      NODE_ENV: production\n',
      profile,
      "F2",
    );
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain("live URL");
  });

  it("allows passing the value through", () => {
    expect(
      checkComposeKeepsPlatformEnv("      CLIENT_URL: ${CLIENT_URL}\n", profile, "F2"),
    ).toEqual([]);
  });
});

describe("database settings stay stable across deploys", () => {
  const mysql = { database: "mysql" } as unknown as RepoProfile;

  it("rejects a new MYSQL_USER and a varying volume name (what a regeneration produced)", () => {
    const compose = `  app:\n    environment:\n      DB_USER: todo_user\n  db:\n    environment:\n      MYSQL_USER: todo_user\n    volumes:\n      - mysqldata:/var/lib/mysql\n`;
    const errors = checkComposeDatabaseStability(compose, mysql);
    expect(errors.some((e) => e.includes('"dbdata"'))).toBe(true);
    expect(errors.some((e) => e.includes("remove MYSQL_USER"))).toBe(true);
    expect(errors.some((e) => e.includes('DB_USER must be "root"'))).toBe(true);
  });

  it("accepts root + dbdata for MySQL and app + dbdata for Postgres", () => {
    expect(
      checkComposeDatabaseStability("      DB_USER: root\n      - dbdata:/var/lib/mysql\n", mysql),
    ).toEqual([]);
    const pg = { database: "postgres" } as unknown as RepoProfile;
    expect(
      checkComposeDatabaseStability(
        "      POSTGRES_USER: app\n      - dbdata:/var/lib/postgresql/data\n",
        pg,
      ),
    ).toEqual([]);
  });
});

describe("server-rendered Next.js frontend (F2)", () => {
  const ssr = {
    frontend: { framework: "next", rootDir: "frontend", isSSR: true },
  } as unknown as RepoProfile;
  const cdn = (
    defaultTarget: string,
    fn: string,
  ) => `resource "aws_cloudfront_distribution" "main" {
  origin {
    origin_id                = "s3-frontend"
    domain_name              = aws_s3_bucket.frontend.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.s3.id
  }
  origin {
    origin_id   = "ec2-api"
    domain_name = aws_eip.app.public_dns
  }
  default_cache_behavior {
    target_origin_id = "${defaultTarget}"
${fn}  }
  ordered_cache_behavior {
    path_pattern     = "/api/*"
    target_origin_id = "ec2-api"
  }
}
`;
  const spaFn = `    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.spa_rewrite.arn
    }
`;

  // What a real generation produced for a Next.js app with middleware.
  const broken = [
    {
      path: "buildspec.yml",
      content:
        '      - cd frontend && npm ci && NEXT_PUBLIC_API_URL="$API_PATH_PREFIX" npm run build && cd ..\n      - if [ -d frontend/out ]; then aws s3 sync frontend/out "s3://$FRONTEND_BUCKET" --delete; elif [ -d frontend/.next ]; then aws s3 sync frontend/.next "s3://$FRONTEND_BUCKET" --delete; fi\n',
    },
    { path: "app/docker-compose.yml", content: "services:\n  app:\n    image: ${APP_IMAGE}\n" },
    {
      path: "app/Caddyfile",
      content: ":80 {\n\thandle @cloudfront {\n\t\treverse_proxy app:{$APP_PORT}\n\t}\n}\n",
    },
    { path: "cdn.tf", content: cdn("s3-frontend", spaFn) },
  ];
  const fixed = [
    {
      path: "buildspec.yml",
      content:
        '      - docker build -t "$ECR_REPOSITORY_URL:web-$IMAGE_TAG" -f .autoinfra/Dockerfile.web --build-arg AUTOINFRA_BUILD_ENV="NEXT_PUBLIC_API_URL=$API_PATH_PREFIX" frontend\n      - echo "WEB_IMAGE=$ECR_REPOSITORY_URL:web-$IMAGE_TAG" >> /tmp/image.env\n',
    },
    {
      path: "app/docker-compose.yml",
      content: "services:\n  app:\n    image: ${APP_IMAGE}\n  web:\n    image: ${WEB_IMAGE}\n",
    },
    {
      path: "app/Caddyfile",
      content:
        ":80 {\n\thandle @cloudfront {\n\t\thandle /api/* {\n\t\t\treverse_proxy app:{$APP_PORT}\n\t\t}\n\t\thandle {\n\t\t\treverse_proxy web:3000\n\t\t}\n\t}\n}\n",
    },
    { path: "cdn.tf", content: cdn("ec2-api", "") },
  ];

  it("rejects the S3 recipe for a frontend that needs its server", () => {
    const errors = checkServerRenderedFrontend(broken, ssr, "F2");
    expect(errors.some((e) => e.includes("Dockerfile.web"))).toBe(true);
    expect(errors.some((e) => e.includes("uploads the frontend to S3"))).toBe(true);
    expect(errors.some((e) => e.includes("${WEB_IMAGE}"))).toBe(true);
    expect(errors.some((e) => e.includes("web:3000"))).toBe(true);
    expect(errors.some((e) => e.includes('targets the S3 origin "s3-frontend"'))).toBe(true);
    expect(errors.some((e) => e.includes("function_association"))).toBe(true);
  });

  it("accepts the web container behind Caddy with CloudFront's default behavior on the instance", () => {
    expect(checkServerRenderedFrontend(fixed, ssr, "F2")).toEqual([]);
  });

  it("leaves static frontends alone", () => {
    const vite = { frontend: { framework: "react-vite", isSSR: false } } as unknown as RepoProfile;
    expect(checkServerRenderedFrontend(broken, vite, "F2")).toEqual([]);
  });
});

describe("database hosted outside AWS (F2)", () => {
  const mongo = { database: "mongo", databaseExternal: true } as unknown as RepoProfile;
  const sg = `resource "aws_vpc_security_group_egress_rule" "https" {
  from_port = 443
  to_port = 443
}
`;
  const dbRule = `resource "aws_vpc_security_group_egress_rule" "database" {
  security_group_id = aws_security_group.app.id
  cidr_ipv4 = "0.0.0.0/0"
  from_port = 27017
  to_port = 27017
  ip_protocol = "tcp"
}
`;
  const files = (tf: string, compose = "services:\n  app:\n    image: app\n") => [
    { path: "network.tf", content: tf },
    { path: "app/docker-compose.yml", content: compose },
  ];

  it("requires an egress rule on the database's port", () => {
    const errors = checkExternalDatabaseAccess(files(sg), mongo, "F2");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("27017");
    expect(checkExternalDatabaseAccess(files(sg + dbRule), mongo, "F2")).toEqual([]);
  });

  it("accepts an all-traffic egress rule or a port range that covers the database", () => {
    const all = `resource "aws_vpc_security_group_egress_rule" "all" {
  security_group_id = aws_security_group.app.id
  cidr_ipv4 = "0.0.0.0/0"
  ip_protocol = "-1"
}
`;
    const range = `resource "aws_vpc_security_group_egress_rule" "high" {
  from_port = 1024
  to_port = 65535
  ip_protocol = "tcp"
}
`;
    expect(checkExternalDatabaseAccess(files(all), mongo, "F2")).toEqual([]);
    expect(checkExternalDatabaseAccess(files(sg + range), mongo, "F2")).toEqual([]);
  });

  it("rejects a database container (the app would use an empty local copy)", () => {
    const compose = "services:\n  app:\n    image: app\n  db:\n    image: mongo:7\n";
    const errors = checkExternalDatabaseAccess(files(sg + dbRule, compose), mongo, "F2");
    expect(errors.some((e) => e.includes("mongo container"))).toBe(true);
  });

  it("doesn't apply to F1 or to a database on the instance", () => {
    expect(checkExternalDatabaseAccess(files(sg), mongo, "F1")).toEqual([]);
    const onInstance = { database: "mysql", databaseExternal: false } as unknown as RepoProfile;
    expect(checkExternalDatabaseAccess(files(sg), onInstance, "F2")).toEqual([]);
    const externalMysql = { database: "mysql", databaseExternal: true } as unknown as RepoProfile;
    expect(checkComposeDatabaseStability("services: {}\n", externalMysql)).toEqual([]);
  });
});

describe("buildspec artifact uploads", () => {
  it("rejects syncing into the artifacts bucket (the build role can't list it)", () => {
    expect(
      checkBuildspecArtifactUploads(
        '      - aws s3 sync /tmp/initdb/ "s3://$ARTIFACTS_BUCKET/deploy/initdb/"',
      ),
    ).toHaveLength(1);
  });

  it("allows per-file copies, and syncing the frontend bucket", () => {
    const ok = `      - aws s3 cp database/init.sql "s3://$ARTIFACTS_BUCKET/deploy/initdb/01-init.sql"\n      - aws s3 sync frontend/dist "s3://$FRONTEND_BUCKET" --delete`;
    expect(checkBuildspecArtifactUploads(ok)).toEqual([]);
  });
});

describe("compose database name check", () => {
  const profile = { databaseName: "todo_db" } as unknown as RepoProfile;

  it("rejects a compose file that points the app at a different database (what Gemini wrote)", () => {
    const compose = `  app:\n    environment:\n      DB_NAME: tododb\n  db:\n    environment:\n      MYSQL_DATABASE: tododb\n`;
    const errors = checkComposeDatabaseName(compose, profile);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain('use "todo_db"');
  });

  it("accepts the right name, and variable references", () => {
    const compose = `      DB_NAME: "todo_db"\n      MYSQL_DATABASE: todo_db\n      POSTGRES_DB: \${DB_NAME}\n`;
    expect(checkComposeDatabaseName(compose, profile)).toEqual([]);
    expect(checkComposeDatabaseName("MYSQL_DATABASE: x", {} as RepoProfile)).toEqual([]);
  });
});

describe("reference projects pass every pre-plan gate (real terraform)", () => {
  it.each(["F1", "F2"] as const)(
    "%s reference",
    async (pattern) => {
      const result = await runGauntlet({
        ...common,
        pattern,
        bundle: { files: loadReference(pattern) },
      });
      const statuses = Object.fromEntries(result.gates.map((g) => [g.gate, g.status]));
      expect(statuses).toMatchObject({
        static: "passed",
        fmt: "passed",
        init: "passed",
        validate: "passed",
        plan: "skipped",
      });
      expect(["passed", "skipped"]).toContain(statuses.tflint);
      expect(["passed", "skipped"]).toContain(statuses.trivy);
    },
    600_000,
  );
});

describe("generate -> gauntlet -> repair loop (real terraform)", () => {
  it("feeds gate errors back to the model and stops cleanly when only credentials are missing", async () => {
    const unsafe = {
      files: [
        ...loadReference("F3"),
        {
          path: "evil.tf",
          content:
            'resource "aws_instance" "x" {\n  provisioner "local-exec" {\n    command = "id"\n  }\n}\n',
        },
      ],
    };
    const llm = new MockLlmClient({
      terraform: [unsafe],
      terraform_repair: [{ files: loadReference("F3") }],
    });
    const plan = { pattern: "F3", routing: { apiPathPrefix: "/api" } } as ArchitecturePlan;
    const profile = {
      repoUrl: "https://github.com/x/y",
      commitSha: "a",
      branch: "main",
      envVars: [],
      database: "none",
      hasDockerfile: false,
      hasComposeFile: false,
      unsupportedReasons: [],
      secretsDetected: [],
    } as unknown as RepoProfile;

    const result = await generateAndValidate(llm, { ...common, plan, profile });

    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]!.gates.at(-1)).toMatchObject({ gate: "static", status: "failed" });
    expect(llm.requests[1]!.user).toContain("[static] evil.tf: provisioner blocks");

    const second = Object.fromEntries(result.attempts[1]!.gates.map((g) => [g.gate, g.status]));
    expect(second).toMatchObject({
      static: "passed",
      fmt: "passed",
      init: "passed",
      validate: "passed",
      plan: "skipped",
    });
    expect(result.passed).toBe(false);
    expect(result.failureReason).toContain("plan");
  }, 600_000);
});

describe("network failures are retried, never 'repaired'", () => {
  const registryDown = {
    code: 1,
    stdout: "",
    stderr:
      "Error: Failed to query available provider packages\n\nCould not retrieve the list of available versions for provider hashicorp/aws: could not connect to registry.terraform.io: failed to request discovery document: context deadline exceeded",
    timedOut: false,
  };
  const ok = {
    code: 0,
    stdout: "Terraform has been successfully initialized!",
    stderr: "",
    timedOut: false,
  };

  it("retries init after a network error, waiting between attempts", async () => {
    const results = [registryDown, registryDown, ok];
    const waits: number[] = [];
    const result = await initWithRetry(async () => results.shift()!, {
      sleep: async (ms) => void waits.push(ms),
    });
    expect(result).toMatchObject({ code: 0, attempts: 3, networkError: false });
    expect(waits).toEqual([15_000, 45_000]);
  });

  it("gives up after three attempts, and never retries a real error or a 5-minute timeout", async () => {
    const down = await initWithRetry(async () => registryDown, { sleep: async () => {} });
    expect(down).toMatchObject({ code: 1, attempts: 3, networkError: true });

    const badProvider = {
      ...registryDown,
      stderr:
        'Error: Failed to query available provider packages\n\nprovider registry.terraform.io/hashicorp/awss: provider "hashicorp/awss" was not found',
    };
    expect(await initWithRetry(async () => badProvider)).toMatchObject({
      attempts: 1,
      networkError: false,
    });
    expect(
      await initWithRetry(async () => ({ ...registryDown, stderr: "", timedOut: true })),
    ).toMatchObject({ attempts: 1, networkError: true });
  });

  it("recognises the network errors Terraform and the AWS provider print", () => {
    for (const msg of [
      'Get "https://registry.terraform.io/.well-known/terraform.json": context deadline exceeded',
      "dial tcp: lookup sts.ap-south-1.amazonaws.com: no such host",
      "RequestError: send request failed caused by: Post https://sts.amazonaws.com/: net/http: TLS handshake timeout",
      "read tcp 10.0.0.2:51515->52.94.1.1:443: read: connection reset by peer",
    ])
      expect(isNetworkError(msg), msg).toBe(true);
    expect(isNetworkError('Error: Unsupported argument "bucket_name"')).toBe(false);
  });

  it("leaves unrepairable failures out of the repair prompt and says why validation stopped", () => {
    const gates: GateResult[] = [
      { gate: "static", status: "passed", errors: [], notes: [], durationMs: 1 },
      {
        gate: "init",
        status: "failed",
        errors: ["terraform init couldn't reach the network after 3 attempts"],
        notes: [],
        durationMs: 1,
        repairable: false,
      },
    ];
    expect(repairErrors(gates)).toEqual([]);
    expect(unfinishedReason(gates)).toBe(
      "Validation could not finish: init: terraform init couldn't reach the network after 3 attempts",
    );
  });

  it("an unreachable registry stops validation without asking the model (real terraform)", async () => {
    const llm = new MockLlmClient({ terraform: [{ files: loadReference("F3") }] });
    const plan = { pattern: "F3", routing: { apiPathPrefix: "/api" } } as ArchitecturePlan;
    const profile = {
      repoUrl: "https://github.com/x/y",
      commitSha: "a",
      branch: "main",
      envVars: [],
      database: "none",
      hasDockerfile: false,
      hasComposeFile: false,
      unsupportedReasons: [],
      secretsDetected: [],
    } as unknown as RepoProfile;
    // Nothing listens on port 9: every request through this proxy is refused.
    const saved = process.env.HTTPS_PROXY;
    process.env.HTTPS_PROXY = "http://127.0.0.1:9";
    try {
      const result = await generateAndValidate(llm, {
        ...common,
        plan,
        profile,
        initRetryDelaysMs: [0],
      });
      expect(result.passed).toBe(false);
      expect(result.attempts).toHaveLength(1);
      expect(llm.requests).toHaveLength(1); // the generation itself; no repair request
      expect(result.attempts[0]!.gates.at(-1)).toMatchObject({
        gate: "init",
        status: "failed",
        repairable: false,
      });
      expect(result.failureReason).toContain("couldn't reach the network after 2 attempts");
    } finally {
      if (saved === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = saved;
    }
  }, 120_000);
});
