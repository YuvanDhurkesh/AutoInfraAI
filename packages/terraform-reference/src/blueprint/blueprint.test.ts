import { describe, expect, it } from "vitest";
import type { RepoProfile } from "@autoinfra/shared";
import { blueprintFor, designBlueprint, renderBlueprint, renderTemplate } from "../index.js";

describe("renderTemplate", () => {
  it("handles if/else/unless, nesting, and values", () => {
    const t =
      "a\n{{#if X}}\nx={{V}}\n{{#unless Y}}\nnot-y\n{{/unless}}\n{{else}}\nno-x\n{{/if}}\nb\n";
    expect(renderTemplate(t, { X: true, Y: false, V: 3 })).toBe("a\nx=3\nnot-y\nb\n");
    expect(renderTemplate(t, { X: false, Y: true, V: 3 })).toBe("a\nno-x\nb\n");
  });

  it("keeps Terraform and shell interpolation untouched", () => {
    const t = 'name = "autoinfra-${var.short_id}" # $HOME {{V}}\n';
    expect(renderTemplate(t, { V: "ok" })).toBe('name = "autoinfra-${var.short_id}" # $HOME ok\n');
  });

  it("fails loudly on unknown flags and missing values instead of rendering blanks", () => {
    expect(() => renderTemplate("{{#if NOPE}}x{{/if}}", {})).toThrow(
      /unknown template flag "NOPE"/,
    );
    expect(() => renderTemplate("{{MISSING}}", {})).toThrow(/no value for/);
    expect(() => renderTemplate("{{FLAG}}", { FLAG: true })).toThrow(/no value for/);
  });
});

const base: RepoProfile = {
  repoUrl: "https://github.com/x/y",
  commitSha: "a",
  branch: "main",
  envVars: [],
  database: "none",
  databaseExternal: false,
  databaseInitScripts: [],
  databaseSetup: [],
  seedScripts: [],
  hasDockerfile: false,
  hasComposeFile: false,
  unsupportedReasons: [],
  secretsDetected: [],
};
const vite: NonNullable<RepoProfile["frontend"]> = {
  framework: "react-vite",
  rootDir: "frontend",
  buildCommand: "vite build",
  outputDir: "dist",
  isSSR: false,
  apiBaseUrlEnvVar: "VITE_API_URL",
  apiBaseUrlAppendsApi: false,
  hardcodedLocalhostUrls: [],
  localhostApiOrigins: [],
  devProxyPaths: [],
  apiBaseUrlForSocket: false,
  pageRoutes: [],
  installCommand: "(npm ci || npm install --legacy-peer-deps)",
};
const express: NonNullable<RepoProfile["backend"]> = {
  language: "node",
  framework: "express",
  rootDir: "backend",
  port: 5000,
  apiRoutePrefix: "/api",
  routePrefixes: ["/api"],
  isStatelessHttp: true,
  usesWebSockets: false,
  webSocketPaths: [],
  localhostOrigins: [],
  hasLocalDiskPersistence: false,
  lambdaCompatible: true,
  hasMutatingRoutes: true,
  installCommand: "(npm ci || npm install --legacy-peer-deps)",
  runCommand: "node server.js",
  usesPrisma: false,
};

const render = (profile: RepoProfile) => {
  const decision = blueprintFor(profile);
  if (!decision.supported) throw new Error(decision.reason);
  const files = renderBlueprint({
    profile,
    pattern: decision.pattern,
    apiPathPrefix: "/api",
    appPort: 5000,
  });
  const byPath = Object.fromEntries(files.map((f) => [f.path, f.content]));
  for (const f of files) expect(f.content, f.path).not.toMatch(/\{\{/);
  return { pattern: decision.pattern, files: byPath };
};

describe("blueprintFor + renderBlueprint", () => {
  it("static site -> F3 without compute", () => {
    const { pattern, files } = render({ ...base, frontend: vite });
    expect(pattern).toBe("F3");
    expect(Object.keys(files).sort()).toEqual(
      ["build.tf", "buildspec.yml", "cdn.tf", "outputs.tf", "storage.tf"].sort(),
    );
    expect(files["buildspec.yml"]).toContain("bash .autoinfra/build-frontend.sh");
    expect(files["cdn.tf"]).toContain('request.uri = "/index.html"');
  });

  it("stateless API + SPA -> F1 Lambda with the repo's start command", () => {
    const { pattern, files } = render({
      ...base,
      frontend: vite,
      backend: express,
      recommendedPattern: "F1",
    });
    expect(pattern).toBe("F1");
    expect(files["app/run.sh"]).toContain("exec node server.js");
    expect(files["compute.tf"]).toContain('runtime          = "nodejs22.x"');
    expect(files["buildspec.yml"]).toContain('AUTOINFRA_API_SUFFIX: "/api"');
    // Routes already under /api: no stripping at the edge.
    expect(files["cdn.tf"]).not.toContain("api_prefix");
  });

  it("strips /api at the edge when the backend's routes don't use it", () => {
    const { files } = render({
      ...base,
      frontend: vite,
      backend: { ...express, apiRoutePrefix: undefined },
      recommendedPattern: "F1",
    });
    expect(files["cdn.tf"]).toContain('resource "aws_cloudfront_function" "api_prefix"');
  });

  it("SQL app -> F2 with the database container wired to the app's own settings", () => {
    const { pattern, files } = render({
      ...base,
      frontend: vite,
      backend: express,
      recommendedPattern: "F2",
      database: "mysql",
      databaseName: "todo_db",
      databaseInitScripts: ["database/init.sql"],
      envVars: ["DB_HOST", "DB_USER", "DB_PASSWORD", "DB_NAME", "STRIPE_KEY"].map((name) => ({
        name,
        isSecret: false,
      })),
    });
    expect(pattern).toBe("F2");
    const compose = files["app/docker-compose.yml"]!;
    expect(compose).toContain('DB_HOST: "db"');
    expect(compose).toContain('DB_USER: "root"');
    expect(compose).toContain('MYSQL_DATABASE: "todo_db"');
    expect(compose).toContain("./initdb:/docker-entrypoint-initdb.d:ro");
    expect(compose).not.toContain("STRIPE_KEY");
    expect(files["buildspec.yml"]).toContain('deploy/initdb/01-init.sql"');
    expect(files["compute.tf"]).toContain("AUTOINFRA_DB_PASSWORD");
    expect(files["app/Dockerfile"]).toContain('CMD ["sh", "-c", "node server.js"]');
  });

  it("Sequelize-style settings (PROD_DB_HOSTNAME, PROD_DB_DIALECT) are wired to the container", () => {
    const { files } = render({
      ...base,
      frontend: vite,
      backend: express,
      recommendedPattern: "F2",
      database: "postgres",
      envVars: [
        "PROD_DB_HOSTNAME",
        "PROD_DB_USERNAME",
        "PROD_DB_PASSWORD",
        "PROD_DB_NAME",
        "PROD_DB_DIALECT",
      ].map((name) => ({ name, isSecret: false })),
    });
    const compose = files["app/docker-compose.yml"]!;
    expect(compose).toContain('PROD_DB_HOSTNAME: "db"');
    expect(compose).toContain('PROD_DB_USERNAME: "app"');
    expect(compose).toContain('PROD_DB_PASSWORD: "${AUTOINFRA_DB_PASSWORD}"');
    expect(compose).toContain('PROD_DB_DIALECT: "postgres"');
    expect(compose).toMatch(/PROD_DB_NAME: "\w+"/);
  });

  it("the repo's own Dockerfile is built at its compose target; without one, as docker would", () => {
    const own = {
      ...base,
      frontend: vite,
      backend: { ...express, dockerfile: "backend/Dockerfile" },
      recommendedPattern: "F2" as const,
      database: "mongo" as const,
    };
    const targeted = render({ ...own, backend: { ...own.backend, dockerTarget: "development" } });
    expect(targeted.files["buildspec.yml"]).toContain(
      '-f backend/Dockerfile --target development "$AUTOINFRA_BE_DIR"',
    );
    expect(render(own).files["buildspec.yml"]).toContain(
      '-f backend/Dockerfile "$AUTOINFRA_BE_DIR"',
    );
    // Its Docker Official base images come from AWS's mirror first (Docker Hub's 429).
    expect(render(own).files["buildspec.yml"]).toMatch(
      /- bash \.autoinfra\/base-images\.sh backend\/Dockerfile\n\s+- docker build /,
    );
  });

  it("Postgres + a Redis cache -> a second container the app's Redis settings point at", () => {
    const profile: RepoProfile = {
      ...base,
      frontend: vite,
      backend: express,
      recommendedPattern: "F2",
      database: "postgres",
      cache: "redis",
      envVars: ["DATABASE_URL", "REDIS_URL"].map((name) => ({ name, isSecret: false })),
    };
    const { files } = render(profile);
    const compose = files["app/docker-compose.yml"]!;
    expect(compose).toContain('REDIS_URL: "redis://cache:6379"');
    expect(compose).toContain(
      'DATABASE_URL: "postgresql://app:${AUTOINFRA_DB_PASSWORD}@db:5432/app"',
    );
    expect(compose).toMatch(
      /^ {2}cache:\n {4}image: public\.ecr\.aws\/docker\/library\/redis:7-alpine/m,
    );
    expect(compose).toMatch(/depends_on:\n {6}db:\n {8}condition: service_healthy\n {6}cache:/);
    expect(compose).toMatch(/^volumes:\n {2}dbdata:\n {2}cachedata:/m);
    // Hosts apps written for docker-compose hard-code reach the same containers.
    expect(compose).toMatch(
      /^ {4}networks:\n {6}default:\n {8}aliases:\n {10}- postgres\n {10}- postgresql\n {10}- database\n/m,
    );
    expect(compose).toMatch(/aliases:\n {10}- redis\n/);
    const plan = designBlueprint(profile, {
      pattern: "F2",
      instanceType: "t3.micro",
      apiPathPrefix: "/api",
    });
    expect(JSON.stringify(plan.components)).toContain("Redis (cache, sessions, queues)");
  });

  it("external database -> no container, egress to any port, settings left to the owner", () => {
    const { files } = render({
      ...base,
      frontend: vite,
      backend: express,
      recommendedPattern: "F2",
      database: "mongo",
      databaseExternal: true,
      envVars: [{ name: "MONGODB_URI", isSecret: true }],
    });
    expect(files["app/docker-compose.yml"]).not.toMatch(/image: mongo|MONGODB_URI/);
    // Providers use custom ports (Supabase's pooler 6543, Redis Cloud), and
    // apps send email over SMTP: the instance may connect out on any port.
    expect(files["network.tf"]).toMatch(
      /"aws_vpc_security_group_egress_rule" "all" \{[^}]*ip_protocol\s+= "-1"/,
    );
    expect(files["network.tf"]).not.toMatch(/from_port\s+= 443/);
    expect(files["compute.tf"]).not.toContain("db_password");
  });

  it("Next.js SSR + Express -> web container behind Caddy, pages from the instance", () => {
    const { pattern, files } = render({
      ...base,
      frontend: {
        ...vite,
        framework: "next",
        isSSR: true,
        outputDir: ".next",
        apiBaseUrlEnvVar: "NEXT_PUBLIC_API_URL",
      },
      backend: express,
      recommendedPattern: "F2",
    });
    expect(pattern).toBe("F2");
    expect(files["app/docker-compose.yml"]).toContain("image: ${WEB_IMAGE}");
    expect(files["app/Caddyfile"]).toContain("reverse_proxy web:3000");
    expect(files["buildspec.yml"]).toContain(".autoinfra/Dockerfile.web");
    expect(files["cdn.tf"]).not.toContain(
      's3-frontend"\n    viewer_protocol_policy = "redirect-to-https"\n    allowed_methods        = ["GET", "HEAD", "OPTIONS"]',
    );
  });

  it("backend paths outside /api: CloudFront routes them for S3 pages, Caddy for a Next.js server", () => {
    const backend = {
      ...express,
      routePrefixes: ["/api", "/uploads"],
      socketIoPath: "/socket.io",
      usesWebSockets: true,
      lambdaCompatible: false,
    };
    const spa = render({ ...base, frontend: vite, backend, recommendedPattern: "F2" }).files;
    expect(spa["cdn.tf"]).toContain('for p in ["/socket.io","/uploads"]');
    expect(spa["app/Caddyfile"]).not.toContain("@backend");

    const next = render({
      ...base,
      frontend: { ...vite, framework: "next", isSSR: true, outputDir: ".next" },
      backend,
      recommendedPattern: "F2",
    }).files;
    // Every path reaches the instance; Caddy picks the backend before the Next.js server.
    expect(next["cdn.tf"]).not.toContain('dynamic "ordered_cache_behavior"');
    const caddy = next["app/Caddyfile"]!;
    expect(caddy).toContain("@backend path /socket.io /socket.io/* /uploads /uploads/*");
    expect(caddy.indexOf("handle @backend")).toBeLessThan(caddy.indexOf("reverse_proxy web:3000"));
  });

  it("Next.js with its own API routes and Postgres -> the database is wired to the web container", () => {
    const { files } = render({
      ...base,
      frontend: { ...vite, framework: "next", isSSR: true, rootDir: "." },
      database: "postgres",
      envVars: [{ name: "DATABASE_URL", isSecret: true }],
    });
    const compose = files["app/docker-compose.yml"]!;
    expect(compose).not.toContain("  app:");
    expect(compose).toMatch(
      /web:[\s\S]*DATABASE_URL: "postgresql:\/\/app:\$\{AUTOINFRA_DB_PASSWORD\}@db:5432\/app"/,
    );
    expect(files["app/Caddyfile"]).not.toContain("reverse_proxy app:");
  });

  it("Nuxt and SvelteKit servers run from Dockerfile.web; their static builds go to S3", () => {
    const kit = render({
      ...base,
      frontend: { ...vite, framework: "sveltekit", isSSR: true, rootDir: "." },
    });
    expect(kit.pattern).toBe("F2");
    expect(kit.files["buildspec.yml"]).toContain("--build-arg AUTOINFRA_WEB_FRAMEWORK=sveltekit");
    // adapter-node checks form posts against the origin it reads from these headers.
    expect(kit.files["app/docker-compose.yml"]).toMatch(
      /web:[\s\S]*PROTOCOL_HEADER: "x-forwarded-proto"\n\s+HOST_HEADER: "x-forwarded-host"/,
    );
    expect(kit.files["app/Caddyfile"]).toMatch(
      /reverse_proxy web:3000 \{\n\s+header_up X-Forwarded-Proto https/,
    );

    const nuxt = render({ ...base, frontend: { ...vite, framework: "nuxt", isSSR: true } });
    expect(nuxt.files["buildspec.yml"]).toContain("--build-arg AUTOINFRA_WEB_FRAMEWORK=nuxt");
    expect(nuxt.files["app/docker-compose.yml"]).not.toContain("PROTOCOL_HEADER");

    const generated = render({
      ...base,
      frontend: {
        ...vite,
        framework: "nuxt",
        buildCommand: "nuxt generate",
        buildScript: "generate",
        outputDir: ".output/public",
      },
    });
    expect(generated.pattern).toBe("F3");
    expect(generated.files["buildspec.yml"]).toContain('AUTOINFRA_FE_BUILD: "npm run generate"');
    expect(generated.files["buildspec.yml"]).toContain('AUTOINFRA_FE_OUT: ".output/public"');
    expect(generated.files["cdn.tf"]).toContain('uri + "/index.html"');
  });

  it("an F2 database is backed up: backup.sh shipped, the instance may write backups/ only", () => {
    const { files } = render({ ...base, frontend: vite, backend: express, database: "postgres" });
    expect(files["buildspec.yml"]).toContain(
      '.autoinfra/backup.sh "s3://$ARTIFACTS_BUCKET/deploy/backup.sh"',
    );
    expect(files["iam.tf"]).toContain('Resource = "${aws_s3_bucket.artifacts.arn}/backups/*"');

    const noDb = render({
      ...base,
      frontend: vite,
      backend: { ...express, lambdaCompatible: false },
    });
    expect(noDb.pattern).toBe("F2");
    expect(noDb.files["buildspec.yml"]).not.toContain("backup.sh");
    expect(noDb.files["iam.tf"]).not.toContain("backups/*");
  });

  it("Python FastAPI -> generated Dockerfile with the server it needs", () => {
    const { files } = render({
      ...base,
      backend: {
        ...express,
        language: "python",
        framework: "fastapi",
        rootDir: ".",
        port: 8000,
        lambdaCompatible: false,
        installCommand: "pip install --no-cache-dir -r requirements.txt",
        runCommand: "uvicorn main:app --host 0.0.0.0 --port $PORT",
        runtimeNeeds: "uvicorn",
      },
      recommendedPattern: "F2",
    });
    expect(files["app/Dockerfile"]).toContain(
      "FROM public.ecr.aws/docker/library/python:3.12-slim",
    );
    expect(files["app/Dockerfile"]).toContain("pip install --no-cache-dir uvicorn");
    expect(files["app/Dockerfile"]).toContain("python3 -m uvicorn main:app");
  });

  it("refuses shapes it has no tested blueprint for", () => {
    expect(
      blueprintFor({ ...base, frontend: { ...vite, framework: "remix", isSSR: true } }),
    ).toMatchObject({ supported: false });
    expect(
      blueprintFor({
        ...base,
        backend: { ...express, language: "go", framework: undefined, runCommand: undefined },
      }),
    ).toMatchObject({ supported: false });
    expect(blueprintFor({ ...base, unsupportedReasons: ["GPU"] })).toMatchObject({
      supported: false,
    });
  });

  it("containers: Go and Java get a generated Dockerfile, other languages need their own", () => {
    const noNode = { ...express, framework: undefined, runCommand: undefined, port: 8080 };
    const go = render({
      ...base,
      backend: { ...noNode, language: "go", goMainPackage: "./cmd/api" },
    });
    expect(go.pattern).toBe("F2");
    expect(go.files["app/Dockerfile"]).toContain("go build -trimpath -o /out/server ./cmd/api");

    const gradle = render({
      ...base,
      backend: { ...noNode, language: "java", javaBuildTool: "gradle" },
    });
    expect(gradle.files["app/Dockerfile"]).toContain(
      "FROM public.ecr.aws/docker/library/gradle:8-jdk21 AS build",
    );
    expect(gradle.files["app/Dockerfile"]).toContain("SERVER_PORT=5000");

    const ruby = blueprintFor({
      ...base,
      backend: { ...noNode, language: "ruby", rootDir: "api" },
    });
    expect(ruby).toEqual({
      supported: false,
      reason: "a ruby backend needs its own Dockerfile (add one at api/Dockerfile)",
    });
    const rubyWithDockerfile = render({
      ...base,
      backend: { ...noNode, language: "ruby", dockerfile: "Dockerfile" },
    });
    expect(rubyWithDockerfile.files["app/Dockerfile"]).toBeUndefined();
    expect(rubyWithDockerfile.files["buildspec.yml"]).toContain(
      '-f Dockerfile "$AUTOINFRA_BE_DIR"',
    );
  });

  it("designs list exactly what the template creates", () => {
    const plan = designBlueprint(
      { ...base, frontend: vite, backend: express, database: "postgres" },
      { pattern: "F2", instanceType: "t3.micro", apiPathPrefix: "/api" },
    );
    const services = plan.components.map((c) => c.service);
    expect(services).toContain("aws_instance");
    expect(services).toContain("aws_eip");
    expect(services).not.toContain("aws_db_instance");
    expect(plan.mermaidDiagram).toMatch(/^flowchart LR/);
    expect(plan.summary).toContain("PostgreSQL in a container");
  });
});
