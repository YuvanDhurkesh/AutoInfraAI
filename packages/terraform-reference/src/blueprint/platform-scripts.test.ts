import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const APP = path.resolve(fileURLToPath(new URL("../../platform-app", import.meta.url)));
const scripts = fs.readdirSync(APP).filter((f) => f.endsWith(".sh"));

const created: string[] = [];
afterAll(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autoinfra-script-"));
  created.push(dir);
  return dir;
}

/** A stand-in `aws` CLI on PATH: answers the two SSM calls prepare-frontend makes. */
function fakeAws(dir: string, params: Record<string, string>) {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const names = Object.keys(params).map((n) => `/autoinfra/abc/${n}`);
  fs.writeFileSync(
    path.join(bin, "aws"),
    `#!/bin/bash
case "$2" in
  describe-parameters) echo "${names.join("\t")}" ;;
  get-parameters) echo '${JSON.stringify(Object.entries(params).map(([n, v]) => [`/autoinfra/abc/${n}`, v]))}' ;;
esac
`,
    { mode: 0o755 },
  );
  // Windows' python3 is a Store placeholder; CodeBuild and EC2 have a real one.
  if (process.platform === "win32")
    fs.writeFileSync(path.join(bin, "python3"), '#!/bin/bash\nexec python "$@"\n', {
      mode: 0o755,
    });
  return bin;
}

/** Scratch dir shared by the scripts (CodeBuild uses /tmp). Forward slashes suit Git Bash too. */
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "autoinfra-scratch-")).replaceAll("\\", "/");
created.push(scratch);
const scratchFile = (name: string) => path.join(scratch, name);

function bash(script: string, cwd: string, env: Record<string, string>, args: string[] = []) {
  const result = spawnSync("bash", [path.join(APP, script), ...args], {
    cwd,
    env: { ...process.env, AUTOINFRA_TMP: scratch, ...env },
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`${script} failed: ${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

describe("platform scripts", () => {
  it.each(scripts)("%s is valid bash", (script) => {
    execFileSync("bash", ["-n", path.join(APP, script)]);
  });

  it("prepare-frontend: public vars from SSM, the API address, localhost URLs rewritten", () => {
    const dir = tmp();
    const fe = path.join(dir, "frontend");
    fs.mkdirSync(path.join(fe, "src"), { recursive: true });
    fs.mkdirSync(path.join(fe, "node_modules", "x"), { recursive: true });
    fs.writeFileSync(path.join(fe, "src", "api.js"), 'const API = "http://localhost:5001/api";\n');
    fs.writeFileSync(path.join(fe, "node_modules", "x", "i.js"), 'u = "http://localhost:5001"\n');
    const bin = fakeAws(dir, {
      VITE_MAPS_KEY: "pk_live=abc",
      VITE_API_URL: "http://localhost:5001/api", // copied from a local .env: must lose
    });
    fs.rmSync(scratchFile("autoinfra-frontend.env"), { force: true });

    bash("prepare-frontend.sh", dir, {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      SSM_PREFIX: "/autoinfra/abc",
      SITE_URL: "https://d1.cloudfront.net",
      AUTOINFRA_FE_DIR: "frontend",
      AUTOINFRA_API_VAR: "VITE_API_URL",
      AUTOINFRA_API_SUFFIX: "/api",
      AUTOINFRA_LOCALHOST_ORIGINS: "http://localhost:5001",
    });

    const env = fs.readFileSync(scratchFile("autoinfra-frontend.env"), "utf8");
    expect(env).toContain("VITE_MAPS_KEY=pk_live=abc");
    expect(env).toContain("VITE_API_URL=https://d1.cloudfront.net/api");
    expect(env).not.toContain("localhost");
    expect(fs.readFileSync(path.join(fe, "src", "api.js"), "utf8")).toContain(
      '"https://d1.cloudfront.net/api"',
    );
    // Dependencies are never touched.
    expect(fs.readFileSync(path.join(fe, "node_modules", "x", "i.js"), "utf8")).toContain(
      "localhost",
    );
  });

  it("prepare-frontend: each localhost URL becomes the form that reaches the backend", () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    const source = [
      'const API = "http://localhost:4000";',
      'fetch("http://localhost:4000/todos");',
      'fetch("http://localhost:4000/api/items");',
      'const other = "http://localhost:40001/x";',
      'const socket = io("http://localhost:4000");',
      'const SOCKET_URL = "http://localhost:4000";',
      'new WebSocket("ws://localhost:4000/live");',
      "",
    ].join("\n");
    fs.writeFileSync(path.join(dir, "src", "api.js"), source);
    const bin = fakeAws(dir, {});

    bash("prepare-frontend.sh", dir, {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      SSM_PREFIX: "/autoinfra/abc",
      SITE_URL: "https://d1.cloudfront.net",
      API_PATH_PREFIX: "/api",
      AUTOINFRA_FE_DIR: ".",
      AUTOINFRA_LOCALHOST_ORIGINS: "http://localhost:4000 ws://localhost:4000",
      // The backend's routes lack /api: CloudFront strips the prefix again.
      AUTOINFRA_LOCALHOST_SUFFIX: "/api",
      // "/live" is routed to the backend as-is.
      AUTOINFRA_WS_SUFFIX: "",
    });

    expect(fs.readFileSync(path.join(dir, "src", "api.js"), "utf8").split("\n")).toEqual([
      'const API = "https://d1.cloudfront.net/api";',
      'fetch("https://d1.cloudfront.net/api/todos");',
      'fetch("https://d1.cloudfront.net/api/items");',
      'const other = "http://localhost:40001/x";',
      'const socket = io("https://d1.cloudfront.net");',
      'const SOCKET_URL = "https://d1.cloudfront.net";',
      'new WebSocket("wss://d1.cloudfront.net/live");',
      "",
    ]);
  });

  it("prepare-frontend: a WebSocket server without a path is reached through the API prefix", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "ws.js"), 'new WebSocket("ws://127.0.0.1:5000");\n');
    const bin = fakeAws(dir, {});
    bash("prepare-frontend.sh", dir, {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      SSM_PREFIX: "/autoinfra/abc",
      SITE_URL: "https://d1.cloudfront.net",
      AUTOINFRA_FE_DIR: ".",
      AUTOINFRA_LOCALHOST_ORIGINS: "ws://127.0.0.1:5000",
      AUTOINFRA_WS_SUFFIX: "/api",
    });
    expect(fs.readFileSync(path.join(dir, "ws.js"), "utf8")).toBe(
      'new WebSocket("wss://d1.cloudfront.net/api");\n',
    );
  });

  it("prepare-backend: CORS allow-lists and redirects get the live URL, self-links the API prefix", () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, "server"));
    fs.writeFileSync(
      path.join(dir, "server", "app.js"),
      [
        'app.use(cors({ origin: ["http://localhost:3000", "http://localhost:5173"] }));',
        'res.redirect("http://localhost:3000/dashboard");',
        "const avatar = `http://localhost:5000/uploads/${file}`;",
        'const callback = "http://localhost:5000/api/auth/callback";',
        'const ml = "http://localhost:8001/predict";',
        "",
      ].join("\n"),
    );
    bash("prepare-backend.sh", dir, {
      SITE_URL: "https://d1.cloudfront.net",
      API_PATH_PREFIX: "/api",
      AUTOINFRA_BE_DIR: "server",
      AUTOINFRA_BE_PORT: "5000",
      AUTOINFRA_BE_LOCALHOST_ORIGINS:
        "http://localhost:3000 http://localhost:5000 http://localhost:5173",
      AUTOINFRA_LOCALHOST_SUFFIX: "/api",
    });
    expect(fs.readFileSync(path.join(dir, "server", "app.js"), "utf8").split("\n")).toEqual([
      'app.use(cors({ origin: ["https://d1.cloudfront.net", "https://d1.cloudfront.net"] }));',
      'res.redirect("https://d1.cloudfront.net/dashboard");',
      "const avatar = `https://d1.cloudfront.net/api/uploads/${file}`;",
      'const callback = "https://d1.cloudfront.net/api/auth/callback";',
      'const ml = "http://localhost:8001/predict";',
      "",
    ]);
  });

  it("package-lambda: installs, adds the entrypoint and env loader, ships the zip through S3", () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, "api"));
    fs.mkdirSync(path.join(dir, ".autoinfra"));
    fs.writeFileSync(path.join(dir, "api", "index.js"), "require('express')");
    fs.writeFileSync(path.join(dir, "api", "package-lock.json"), "{}");
    fs.writeFileSync(path.join(dir, ".autoinfra", "run.sh"), "#!/bin/bash\nexec node index.js\n");
    fs.writeFileSync(path.join(dir, ".autoinfra", "autoinfra-env.mjs"), "// loader");
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    const log = scratchFile("package-lambda.log").replaceAll("\\", "/");
    fs.rmSync(log, { force: true });
    for (const tool of ["npm", "zip", "aws"])
      fs.writeFileSync(path.join(bin, tool), `#!/bin/bash\necho "${tool} $*" >> "${log}"\n`, {
        mode: 0o755,
      });

    bash("package-lambda.sh", dir, {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      AUTOINFRA_BE_DIR: "api",
      AUTOINFRA_BE_LANG: "node",
      AUTOINFRA_BE_INSTALL: "npm ci",
      ARTIFACTS_BUCKET: "artifacts",
      FUNCTION_NAME: "fn",
    });

    expect(fs.existsSync(path.join(dir, "api", "run.sh"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "api", "autoinfra-env.mjs"))).toBe(true);
    const calls = fs.readFileSync(log, "utf8").trim().split("\n");
    expect(calls).toEqual([
      "npm ci",
      "npm prune --omit=dev",
      "zip -qr /tmp/api.zip . -x .git/* .autoinfra/*",
      "aws s3 cp /tmp/api.zip s3://artifacts/deploy/api.zip --only-show-errors",
      "aws lambda update-function-code --function-name fn --s3-bucket artifacts --s3-key deploy/api.zip",
      "aws lambda wait function-updated --function-name fn",
    ]);
  });

  it("build-frontend: builds with the variables and finds the output folder", () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, "web"));
    fs.writeFileSync(
      scratchFile("autoinfra-frontend.env"),
      "VITE_API_URL=https://d1.cloudfront.net/api\n",
    );
    bash("build-frontend.sh", dir, {
      AUTOINFRA_FE_DIR: "web",
      AUTOINFRA_FE_INSTALL: "true",
      AUTOINFRA_FE_BUILD: 'mkdir -p build && echo "$VITE_API_URL $CI" > build/index.html',
      AUTOINFRA_FE_OUT: "dist", // wrong guess: the script still finds build/
    });
    const out = fs.readFileSync(scratchFile("autoinfra-frontend-out"), "utf8").trim();
    expect(out.replaceAll("\\", "/")).toMatch(/web\/build$/);
    expect(fs.readFileSync(path.join(dir, "web", "build", "index.html"), "utf8").trim()).toBe(
      "https://d1.cloudfront.net/api false",
    );
  });

  it("deploy (F2 instance): .env from SSM, ECR login, containers started and checked", () => {
    const { home, run, calls } = deployFixture();
    const out = run();
    expect(out).toContain("Deploy finished: all containers are running.");
    // Every SSM value, quoted for Compose, then the image tags.
    expect(fs.readFileSync(path.join(home, ".env"), "utf8").replaceAll("\r\n", "\n")).toBe(
      [
        "AUTOINFRA_DB_PASSWORD='s3cr$t'",
        "STRIPE_KEY='sk_live_1'",
        `QUOTED="it's"`,
        "APP_IMAGE=123.dkr.ecr.ap-south-1.amazonaws.com/autoinfra-abc:build-7",
        "",
      ].join("\n"),
    );
    const log = calls();
    expect(log).toContain(
      "docker login --username AWS --password-stdin 123.dkr.ecr.ap-south-1.amazonaws.com",
    );
    expect(log.indexOf("docker compose pull --quiet")).toBeLessThan(
      log.indexOf("docker compose up -d --remove-orphans"),
    );
    expect(log).toContain("systemctl enable --now docker");
    // A new instance's first-boot setup is waited for, at most 10 minutes.
    expect(log).toContain("timeout 600 cloud-init status --wait");
    // Compose was there: nothing reinstalled.
    expect(log.some((c) => c.startsWith("curl"))).toBe(false);
  });

  it("deploy: a container that keeps crashing fails the deploy and shows its logs", () => {
    const { run } = deployFixture({ CRASH: "app" });
    expect(() => run()).toThrow(/=== app did not stay up[\s\S]*ECONNREFUSED db:5432/);
  });

  it("deploy: a first boot that never installed Compose is healed, with retries", () => {
    const { run, calls } = deployFixture({ NO_COMPOSE: "1" });
    expect(run()).toContain("Installing Docker Compose");
    const curl = calls().find((c) => c.startsWith("curl"));
    expect(curl).toContain("--retry 5");
    expect(curl).toContain("docker-compose-linux-");
  });

  it("rollout: waits for SSM, runs deploy.sh on the instance, prints what it printed", () => {
    const { run, calls } = rolloutFixture({ STATUS: "Success" });
    const out = run();
    expect(out).toContain("Rolling out on i-123 (SSM command cmd-1)");
    expect(out).toContain("deploy output");
    const send = calls().find((c) => c.includes("send-command"))!;
    expect(send).toContain(
      "bash /opt/autoinfra/deploy.sh artifacts-bucket ap-south-1 /autoinfra/abc",
    );
  });

  it("rollout: a failed deploy on the instance fails the build with its errors", () => {
    const { run } = rolloutFixture({ STATUS: "Failed" });
    expect(() => run()).toThrow(
      /--- errors from the instance ---[\s\S]*boom[\s\S]*ended with status: Failed/,
    );
  });

  it("build-frontend: a build without index.html fails with a clear message", () => {
    const dir = tmp();
    fs.writeFileSync(scratchFile("autoinfra-frontend.env"), "");
    expect(() =>
      bash("build-frontend.sh", dir, {
        AUTOINFRA_FE_DIR: ".",
        AUTOINFRA_FE_INSTALL: "true",
        AUTOINFRA_FE_BUILD: "mkdir -p dist",
      }),
    ).toThrow(/no folder with an index.html/);
  });
});

const posix = (...parts: string[]) => path.join(...parts).replaceAll("\\", "/");

/**
 * Stand-in commands on PATH: each logs "tool args" to `log`, then runs `body`.
 * `sleep` and `timeout` are always faked so the scripts' waits take no time
 * (and Windows' own timeout.exe, a pause command, is never reached).
 */
function fakeBin(dir: string, log: string, tools: Record<string, string>): string {
  const bin = posix(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const all: Record<string, string> = { sleep: "", timeout: 'shift; "$@"', ...tools };
  for (const [tool, body] of Object.entries(all))
    fs.writeFileSync(posix(bin, tool), `#!/bin/bash\necho "${tool} $*" >> "${log}"\n${body}\n`, {
      mode: 0o755,
    });
  if (process.platform === "win32")
    fs.writeFileSync(posix(bin, "python3"), '#!/bin/bash\nexec python "$@"\n', { mode: 0o755 });
  return bin;
}

const readCalls = (log: string) =>
  fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean) : [];

/** An F2 instance for deploy.sh: the artifacts bucket's deploy/ folder, SSM values, Docker. */
function deployFixture(env: Record<string, string> = {}) {
  const root = tmp().replaceAll("\\", "/");
  const home = posix(root, "home");
  const bucket = posix(root, "bucket", "deploy");
  fs.mkdirSync(home);
  fs.mkdirSync(bucket, { recursive: true });
  fs.writeFileSync(posix(bucket, "docker-compose.yml"), "services: {}\n");
  fs.writeFileSync(
    posix(bucket, "image.env"),
    "APP_IMAGE=123.dkr.ecr.ap-south-1.amazonaws.com/autoinfra-abc:build-7\n",
  );
  const params = posix(root, "params.json");
  fs.writeFileSync(
    params,
    JSON.stringify({
      Parameters: [
        { Name: "/autoinfra/abc/platform/AUTOINFRA_DB_PASSWORD", Value: "s3cr$t" },
        { Name: "/autoinfra/abc/STRIPE_KEY", Value: "sk_live_1" },
        { Name: "/autoinfra/abc/QUOTED", Value: "it's" },
      ],
    }),
  );
  const swapfile = posix(root, "swapfile"); // exists: no swap is made
  fs.writeFileSync(swapfile, "");
  const log = posix(root, "calls.log");
  const bin = fakeBin(root, log, {
    aws: `case "$1 $2" in
  "s3 cp") cp -r "${bucket}/." "$4" ;;
  "ssm get-parameters-by-path") cat "${params}" ;;
  "ecr get-login-password") echo token ;;
esac`,
    docker: `case "$*" in
  "compose version") [ -z "$NO_COMPOSE" ] || [ -f "${root}/compose-installed" ] ;;
  "compose config --services") printf 'caddy\\napp\\n' ;;
  "compose ps -aq "*) echo "id-$4" ;;
  "inspect "*) if [ "$4" = "id-$CRASH" ]; then echo "restarting 4"; else echo "running 0"; fi ;;
  "compose logs"*) echo "Error: connect ECONNREFUSED db:5432" ;;
esac`,
    "cloud-init": "",
    curl: `touch "${root}/compose-installed"`,
    systemctl: "",
    dnf: "",
    mkdir: "",
    chmod: "",
  });
  return {
    home,
    calls: () => readCalls(log),
    run: () =>
      bash(
        "deploy.sh",
        home,
        {
          PATH: `${bin}${path.delimiter}${process.env.PATH}`,
          AUTOINFRA_HOME: home,
          AUTOINFRA_SWAPFILE: swapfile,
          ...env,
        },
        ["artifacts-bucket", "ap-south-1", "/autoinfra/abc"],
      ).replaceAll("\r\n", "\n"),
  };
}

/** CodeBuild's side of an F2 rollout: SSM registration, Run Command and its result. */
function rolloutFixture(env: Record<string, string>) {
  const root = tmp().replaceAll("\\", "/");
  const log = posix(root, "calls.log");
  const bin = fakeBin(root, log, {
    aws: `case "$*" in
  *describe-instance-information*) echo 1 ;;
  *send-command*) echo cmd-1 ;;
  *"--query Status"*) echo "$STATUS" ;;
  *StandardOutputContent*) echo "deploy output" ;;
  *StandardErrorContent*) echo "boom" ;;
esac`,
  });
  return {
    calls: () => readCalls(log),
    run: () =>
      bash("rollout.sh", root, {
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        INSTANCE_ID: "i-123",
        ARTIFACTS_BUCKET: "artifacts-bucket",
        AWS_REGION: "ap-south-1",
        SSM_PREFIX: "/autoinfra/abc",
        ...env,
      }),
  };
}
