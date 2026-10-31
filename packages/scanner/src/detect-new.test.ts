import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { scanRepo } from "./scan.js";
import { detectEnvVars } from "./detectors/detect-env-vars.js";

const created: string[] = [];
afterAll(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

/** Writes a small repo: { "backend/package.json": "...", ... }. Removed after the file's tests. */
function repo(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "autoinfra-scan-"));
  created.push(root);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return root;
}

const scan = (root: string) =>
  scanRepo(root, { repoUrl: "https://github.com/x/y", commitSha: "0", branch: "main" });

const express = (deps: Record<string, string> = {}, scripts: Record<string, string> = {}) =>
  JSON.stringify({
    dependencies: { express: "4", ...deps },
    scripts: { start: "node server.js", ...scripts },
  });

describe("database setup detection", () => {
  it("plain SQL migrations and migrate*.js scripts run once each, in order; seeds never", () => {
    const p = scan(
      repo({
        "backend/package.json": express({ pg: "8" }),
        "backend/server.js": "require('express')().listen(5001)",
        "backend/db/schema.sql": "CREATE TABLE users (id serial);",
        "backend/db/migrations/002_more.sql": "ALTER TABLE users ADD COLUMN b int;",
        "backend/db/migrations/001_first.sql": "ALTER TABLE users ADD COLUMN a int;",
        "backend/migrate_db.js": "// adds columns",
        "backend/scripts/migrate_bids.js": "// bids table",
        "backend/scripts/seed.js": "// sample users",
        "backend/scripts/initDB.js": "// sample data",
      }),
    );
    expect(p.databaseInitScripts).toEqual(["backend/db/schema.sql"]);
    expect(p.databaseSetup).toEqual([
      { kind: "sql", path: "backend/db/migrations/001_first.sql", once: true },
      { kind: "sql", path: "backend/db/migrations/002_more.sql", once: true },
      { kind: "command", path: "migrate_db.js", command: "node migrate_db.js", once: true },
      {
        kind: "command",
        path: "scripts/migrate_bids.js",
        command: "node scripts/migrate_bids.js",
        once: true,
      },
    ]);
    expect(p.seedScripts.sort()).toEqual(["backend/scripts/initDB.js", "backend/scripts/seed.js"]);
  });

  it("Prisma: the schema's provider names the database; migrations run every deploy", () => {
    const p = scan(
      repo({
        "package.json": express({ "@prisma/client": "5" }, {}),
        "server.js": "require('express')().listen(3000)",
        "prisma/schema.prisma":
          'datasource db {\n  provider = "mysql"\n  url = env("DATABASE_URL")\n}\n',
        "prisma/migrations/0001_init/migration.sql": "CREATE TABLE x (id int);",
      }),
    );
    expect(p.database).toBe("mysql");
    expect(p.backend?.usesPrisma).toBe(true);
    expect(p.databaseSetup).toEqual([
      { kind: "command", path: "prisma", command: "npx prisma migrate deploy", once: false },
    ]);
  });

  it("the app's own migrate script wins over guessing", () => {
    const p = scan(
      repo({
        "package.json": express(
          { pg: "8", knex: "3" },
          { migrate: "knex migrate:latest --env production" },
        ),
        "server.js": "require('express')().listen(3000)",
        "knexfile.js": "module.exports = {}",
      }),
    );
    expect(p.databaseSetup).toEqual([
      { kind: "command", path: "npm:migrate", command: "npm run migrate", once: false },
    ]);
  });

  it("Django runs its migrations", () => {
    const p = scan(
      repo({
        "requirements.txt": "django==5.1\npsycopg[binary]==3.2\n",
        "manage.py": "import django",
        "mysite/wsgi.py": "application = get_wsgi_application()",
        "mysite/settings.py": "DEBUG = False",
      }),
    );
    expect(p.backend?.runCommand).toBe("gunicorn --bind 0.0.0.0:$PORT mysite.wsgi:application");
    expect(p.databaseSetup).toEqual([
      {
        kind: "command",
        path: "django",
        command: "python manage.py migrate --noinput",
        once: false,
      },
    ]);
  });
});

describe("frontend API address", () => {
  // Vitest rewrites import.meta.env even inside string literals: build it.
  const env = ["import", "meta", "env"].join(".");
  const app = (src: string, extra: Record<string, string> = {}) =>
    scan(
      repo({
        "frontend/package.json": JSON.stringify({
          dependencies: { react: "18", vite: "5" },
          scripts: { build: "vite build" },
        }),
        "frontend/src/api.js": src,
        "backend/package.json": express(),
        "backend/server.js":
          "const app = require('express')(); app.use('/api/users', r); app.listen(5001)",
        ...extra,
      }),
    ).frontend!;

  it("an origin variable the code appends /api to", () => {
    const fe = app(`fetch(\`\${${env}.VITE_API_URL}/api/users\`)`);
    expect(fe.apiBaseUrlEnvVar).toBe("VITE_API_URL");
    expect(fe.apiBaseUrlAppendsApi).toBe(true);
  });

  it("a full base URL with a fallback is not 'appending'", () => {
    const fe = app(`const API = ${env}.VITE_API_URL || "/api";\nfetch(\`\${API}/users\`)`);
    expect(fe.apiBaseUrlEnvVar).toBe("VITE_API_URL");
    expect(fe.apiBaseUrlAppendsApi).toBe(false);
  });

  it("appending through a constant counts", () => {
    const fe = app(`const BASE = ${env}.VITE_BACKEND_URL ?? '';\naxios.get(\`\${BASE}/api/x\`)`);
    expect(fe.apiBaseUrlEnvVar).toBe("VITE_BACKEND_URL");
    expect(fe.apiBaseUrlAppendsApi).toBe(true);
  });

  it("never mistakes another public variable for the API address", () => {
    const fe = app(`const key = ${env}.VITE_FIREBASE_KEY; fetch('/api/x')`);
    expect(fe.apiBaseUrlEnvVar).toBe("VITE_API_URL"); // the convention, not VITE_FIREBASE_KEY
  });

  it("only the backend's localhost origin is rewritten, not other dev servers", () => {
    const fe = app('fetch("http://localhost:5001/api/a"); const docs = "http://localhost:6006";', {
      "frontend/vite.config.js": "server: { proxy: { '/api': 'http://localhost:5001' } }",
    });
    expect(fe.localhostApiOrigins).toEqual(["http://localhost:5001"]);
  });
});

describe("layout", () => {
  it("finds a backend folder with an unusual name next to a root frontend", () => {
    const p = scan(
      repo({
        "package.json": JSON.stringify({
          dependencies: { react: "18", vite: "5" },
          scripts: { build: "vite build" },
        }),
        "index.html": "<div id=root>",
        "farmer-api/package.json": express(),
        "farmer-api/server.js": "require('express')().listen(4000)",
      }),
    );
    expect(p.frontend?.rootDir).toBe(".");
    expect(p.backend?.rootDir).toBe("farmer-api");
    expect(p.backend?.port).toBe(4000);
  });

  it("lockfiles decide the install command", () => {
    const p = scan(
      repo({
        "package.json": express(),
        "server.js": "require('express')().listen(4000)",
        "pnpm-lock.yaml": "lockfileVersion: 9",
      }),
    );
    expect(p.backend?.installCommand).toContain("pnpm install");
  });

  it("an npm workspaces root is not the backend: its members are", () => {
    const p = scan(
      repo({
        "package.json": JSON.stringify({
          workspaces: ["backend", "frontend"],
          scripts: { start: "npm run build -w frontend && npm run start -w backend" },
        }),
        "package-lock.json": "{}",
        "backend/package.json": JSON.stringify({
          dependencies: { express: "5", pg: "8", sequelize: "6" },
          scripts: { start: "node index.js" },
        }),
        "backend/index.js": "const app = require('express')(); app.listen(3001);",
        "frontend/package.json": JSON.stringify({
          dependencies: { react: "18" },
          devDependencies: { vite: "5" },
          scripts: { build: "vite build" },
        }),
        "frontend/index.html": "<div id=root>",
      }),
    );
    expect(p.backend?.rootDir).toBe("backend");
    expect(p.backend?.framework).toBe("express");
    expect(p.frontend?.rootDir).toBe("frontend");
    expect(p.database).toBe("postgres");
  });
});

describe("database connections written into the code", () => {
  it("flags a localhost host or URL, with file and line (a real CRUD repo)", () => {
    const p = scan(
      repo({
        "package.json": express({ mysql: "2" }),
        "server.js": "require('express')().listen(4000)",
        "config/db.config.js":
          "const mysql = require('mysql');\nconst dbConn = mysql.createConnection({\n  host     : 'localhost',\n  user     : 'root',\n});\n",
        "models/mongo.js":
          "const mongoose = require('mongoose');\nmongoose.connect(\"mongodb://localhost:27017/app\");\n",
      }),
    );
    expect(p.backend?.hardcodedDatabaseHosts).toEqual([
      "config/db.config.js:3: host     : 'localhost'",
      'models/mongo.js:2: "mongodb://localhost:27017/app"',
    ]);
  });

  it("Python drivers and SQLAlchemy URLs too", () => {
    const p = scan(
      repo({
        "requirements.txt": "flask\nmysql-connector-python\n",
        "app.py":
          'import mysql.connector\nfrom flask import Flask\napp = Flask(__name__)\ndb = mysql.connector.connect(host="localhost", user="root")\nURL = \'mysql+pymysql://root:pw@127.0.0.1/shop\'\n',
      }),
    );
    expect(p.backend?.hardcodedDatabaseHosts).toEqual([
      'app.py:4: host="localhost"',
      "app.py:5: 'mysql+pymysql://***@127.0.0.1/shop'", // the password never leaves the repo
    ]);
  });

  it("a hosted database's address written in (a real repo: someone's RDS, in a dict), not other servers", () => {
    const p = scan(
      repo({
        "requirements.txt": "flask\nmysql-connector-python\n",
        "app.py":
          "import mysql.connector\nfrom flask import Flask\napp = Flask(__name__)\ndb_config = {\n    'host': 'book-rds.cinsoscgioqa.us-east-1.rds.amazonaws.com',\n    'user': 'admin',\n}\nMONGO = \"mongodb+srv://app:s3cret@cluster0.abcde.mongodb.net/shop\"\nMAIL = {'host': 'smtp.gmail.com'}\n",
      }),
    );
    expect(p.backend?.hardcodedDatabaseHosts).toEqual([
      "app.py:5: 'host': 'book-rds.cinsoscgioqa.us-east-1.rds.amazonaws.com'",
      'app.py:8: "mongodb+srv://***@cluster0.abcde.mongodb.net/shop"',
    ]);
  });

  it("leaves env-var fallbacks, per-environment config and test helpers alone", () => {
    const p = scan(
      repo({
        "package.json": express({ pg: "8", knex: "3" }),
        "server.js": "require('express')().listen(4000)",
        "db.js":
          "const { Pool } = require('pg');\nnew Pool({ host: process.env.DB_HOST || 'localhost' });\nconst url = process.env.DATABASE_URL ?? 'postgres://app@localhost/app';\n",
        "knexfile.js":
          "module.exports = {\n  development: { client: 'pg', connection: { host: '127.0.0.1' } },\n  production: { client: 'pg', connection: process.env.DATABASE_URL },\n};\n",
        "test/db.test.js": "const { Pool } = require('pg');\nnew Pool({ host: 'localhost' });\n",
        "scripts/seed.js": "const { Pool } = require('pg');\nnew Pool({ host: 'localhost' });\n",
      }),
    );
    expect(p.backend?.hardcodedDatabaseHosts).toEqual([]);
  });
});

describe("the backend's own Dockerfile", () => {
  const files = (target: string) => ({
    "compose.yaml": `services:\n  frontend:\n    build:\n      context: frontend\n      target: development\n  backend:\n    build:\n      context: backend\n      target: ${target}\n`,
    "frontend/package.json": JSON.stringify({
      dependencies: { react: "18" },
      devDependencies: { vite: "5" },
      scripts: { build: "vite build" },
    }),
    "frontend/index.html": "<div id=root>",
    "backend/package.json": express({ mongoose: "8" }),
    "backend/server.js": "require('express')().listen(3000)",
    // Docker's samples: the app first, a developer-tools stage last.
    "backend/Dockerfile":
      "FROM node:lts-buster-slim AS development\nCMD npm run dev\n\nFROM development as dev-envs\nRUN apt-get update\n",
  });

  it("is built at the stage the repo's compose file targets, not the last one", () => {
    const p = scan(repo(files("development")));
    expect(p.backend?.dockerfile).toBe("backend/Dockerfile");
    expect(p.backend?.dockerTarget).toBe("development");
    expect(p.hasComposeFile).toBe(true); // compose.yaml, the Compose spec's own name
  });

  it("also in a subdir of a samples repo (awesome-compose/react-express-mongodb)", () => {
    const inSubdir = Object.fromEntries(
      Object.entries(files("development")).map(([rel, content]) => [`sample/${rel}`, content]),
    );
    const p = scanRepo(repo(inSubdir), {
      repoUrl: "https://github.com/x/y",
      commitSha: "0",
      branch: "main",
      subdir: "sample",
    });
    expect(p.backend?.dockerfile).toBe("sample/backend/Dockerfile");
    expect(p.backend?.dockerTarget).toBe("development");
    expect(p.hasComposeFile).toBe(true);
  });

  it("a target the Dockerfile doesn't have is ignored (docker build would fail on it)", () => {
    expect(scan(repo(files("production"))).backend?.dockerTarget).toBeUndefined();
  });

  it("a last stage that is the production image wins over compose's development target", () => {
    // react-rust-postgres: `development` compiles with `cargo run` when the container
    // starts; the last stage ships the release binary built during the build.
    const rust = {
      ...files("development"),
      "backend/Dockerfile":
        'FROM rust:buster AS base\nRUN cargo fetch\n\nFROM base AS development\nCMD [ "cargo", "run" ]\n\nFROM base AS builder\nRUN cargo build --release\n\nFROM debian:buster-slim\nCOPY --from=builder /code/target/release/app /app\nCMD [ "/app" ]\n',
    };
    expect(scan(repo(rust)).backend?.dockerTarget).toBeUndefined();
  });

  it("before a developer-tools last stage, a production-named stage beats compose's target", () => {
    const named = {
      ...files("development"),
      "backend/Dockerfile":
        "FROM node:22 AS development\nCMD npm run dev\n\nFROM node:22-slim AS production\nCMD node server.js\n\nFROM development AS dev-envs\n",
    };
    expect(scan(repo(named)).backend?.dockerTarget).toBe("production");
  });
});

describe("Redis next to the main database", () => {
  it.each([
    [{ pg: "8", ioredis: "5" }, "postgres"],
    [{ mongoose: "8", bullmq: "5" }, "mongo"],
    [{ mysql2: "3", "connect-redis": "7", redis: "4" }, "mysql"],
  ])("%j: %s, with Redis as a second container", (deps, database) => {
    const p = scan(
      repo({ "package.json": express(deps), "server.js": "require('express')().listen(4000)" }),
    );
    expect(p.database).toBe(database);
    expect(p.cache).toBe("redis");
  });

  it("Python: psycopg2 + redis", () => {
    const p = scan(
      repo({
        "requirements.txt": "flask\npsycopg2-binary\nredis==5.0.1\n",
        "app.py": "from flask import Flask\napp = Flask(__name__)",
      }),
    );
    expect(p.database).toBe("postgres");
    expect(p.cache).toBe("redis");
  });

  it("an app whose only store is Redis has no separate cache", () => {
    const p = scan(
      repo({
        "package.json": express({ ioredis: "5" }),
        "server.js": "require('express')().listen(4000)",
      }),
    );
    expect(p.database).toBe("redis");
    expect(p.cache).toBeUndefined();
  });
});

describe("Python database drivers", () => {
  it.each(["mysql-connector-python==8.4.0", "mysql-connector==2.2.9"])(
    "%s means MySQL, ahead of a Redis cache",
    (requirement) => {
      const p = scan(
        repo({
          "requirements.txt": `flask\n${requirement}\nredis\n`,
          "app.py": "from flask import Flask\napp = Flask(__name__)",
        }),
      );
      expect(p.backend?.framework).toBe("flask");
      expect(p.database).toBe("mysql");
    },
  );
});

describe("a server's listen address", () => {
  it("is kept from the code's default or the env example, other defaults aren't", () => {
    const root = repo({
      // awesome-compose's Rust backend: 127.0.0.1 inside a container is unreachable.
      "src/main.rs":
        'let addr = std::env::var("ADDRESS").unwrap_or_else(|_| "127.0.0.1:8000".into());',
      "server.js":
        'app.listen(process.env.PORT || 3000, process.env.HOST || "localhost");\nconst db = process.env.DB_NAME || "todo";',
      "app.py": 'app.run(host=os.environ.get("FLASK_RUN_HOST", "0.0.0.0"))',
      ".env.example": "BIND=:8080\nAPI_URL=http://localhost:3000\n",
    });
    const defaults = Object.fromEntries(detectEnvVars(root).map((v) => [v.name, v.bindDefault]));
    expect(defaults).toMatchObject({
      ADDRESS: "127.0.0.1:8000",
      HOST: "localhost",
      FLASK_RUN_HOST: "0.0.0.0",
      BIND: ":8080",
    });
    expect(defaults.DB_NAME).toBeUndefined();
    expect(defaults.API_URL).toBeUndefined();
  });
});
