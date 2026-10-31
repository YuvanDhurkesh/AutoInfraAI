import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { unapprovedChanges } from "@autoinfra/terraform-runner";
import { buildSourceZip } from "./source-zip.js";
import { apiHealthPath, checkHealth } from "./health.js";

function readZip(buf: Buffer) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: Record<string, { mode: number; content: string }> = {};
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const compressed = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const mode = (buf.readUInt32LE(p + 38) >>> 16) & 0o777;
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString();
    const start = local + 30 + buf.readUInt16LE(local + 26);
    const raw = buf.subarray(start, start + compressed);
    out[name] = { mode, content: (method === 8 ? inflateRawSync(raw) : raw).toString() };
    p += 46 + nameLen;
  }
  return out;
}

describe("approval drift check", () => {
  const approved = {
    adds: 2,
    changes: 0,
    destroys: 0,
    replaces: 0,
    dataBearingDestroys: [],
    resources: [
      {
        address: "aws_s3_bucket.a",
        type: "aws_s3_bucket",
        action: "create" as const,
        dataBearing: true,
      },
      {
        address: "aws_lambda_function.f",
        type: "aws_lambda_function",
        action: "create" as const,
        dataBearing: false,
      },
    ],
  };
  const fresh = (
    resources: Array<{
      address: string;
      action: "create" | "update" | "delete" | "replace" | "no-op";
    }>,
  ) => ({
    ...approved,
    resources: resources.map((r) => ({ ...r, type: r.address.split(".")[0]!, dataBearing: false })),
  });

  it("allows a subset (retry after a partial apply)", () => {
    expect(
      unapprovedChanges(
        approved,
        fresh([
          { address: "aws_s3_bucket.a", action: "no-op" },
          { address: "aws_lambda_function.f", action: "create" },
        ]),
      ),
    ).toEqual([]);
  });

  it("refuses new resources, destroys, and creates that became replaces", () => {
    expect(
      unapprovedChanges(
        approved,
        fresh([
          { address: "aws_s3_bucket.a", action: "replace" },
          { address: "aws_nat_gateway.n", action: "create" },
          { address: "aws_lambda_function.f", action: "delete" },
        ]),
      ),
    ).toEqual([
      "replace aws_s3_bucket.a",
      "create aws_nat_gateway.n",
      "delete aws_lambda_function.f",
    ]);
  });
});

describe("source zip", () => {
  it("packs the repo plus .autoinfra/ overlay, skipping .git and node_modules", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autoinfra-zip-"));
    fs.mkdirSync(path.join(dir, "src"));
    fs.mkdirSync(path.join(dir, "node_modules", "x"), { recursive: true });
    fs.mkdirSync(path.join(dir, ".git"));
    fs.mkdirSync(path.join(dir, "app")); // the repo's own app/ dir must survive
    fs.writeFileSync(path.join(dir, "src", "server.js"), "console.log('hi')".repeat(50));
    fs.writeFileSync(path.join(dir, "app", "page.tsx"), "export default 1");
    fs.writeFileSync(path.join(dir, "node_modules", "x", "index.js"), "x");
    fs.writeFileSync(path.join(dir, ".git", "HEAD"), "ref");

    const zip = readZip(
      buildSourceZip(
        dir,
        [
          { path: "main.tf", content: "resource" },
          { path: "app/run.sh", content: "#!/bin/bash\r\nexec node src/server.js\r\n" },
        ],
        [{ path: "autoinfra-env.mjs", content: "// env" }],
      ),
    );
    expect(Object.keys(zip).sort()).toEqual([
      ".autoinfra/autoinfra-env.mjs",
      ".autoinfra/run.sh",
      "app/page.tsx",
      "src/server.js",
    ]);
    expect(zip["src/server.js"]!.content).toBe("console.log('hi')".repeat(50));
    expect(zip[".autoinfra/run.sh"]!.mode).toBe(0o755);
    expect(zip[".autoinfra/run.sh"]!.content).not.toContain("\r");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("health checks", () => {
  it("maps the app health path onto the CloudFront API prefix", () => {
    expect(apiHealthPath("/api", "/api/health")).toBe("/api/health");
    expect(apiHealthPath("/api", "/health")).toBe("/api/health");
    expect(apiHealthPath("/api", "/")).toBe("/api/");
  });

  it("treats the 503 placeholder as not deployed, and gives up after the timeout", async () => {
    const calls: string[] = [];
    const result = await checkHealth(
      {
        fetch: (async (url: string) => {
          calls.push(url);
          return url.endsWith("/")
            ? new Response("<html>", { status: 200 })
            : new Response(JSON.stringify({ error: "deploying" }), { status: 503 });
        }) as typeof fetch,
        sleep: async () => undefined,
      },
      {
        baseUrl: "https://d.cloudfront.net",
        hasBackend: true,
        apiPathPrefix: "/api",
        healthCheckPath: "/api/health",
        timeoutMs: 30_000,
      },
    );
    expect(result.frontend.ok).toBe(true);
    expect(result.api!.ok).toBe(false);
    expect(result.api!.detail).toContain("placeholder");
    expect(calls.filter((c) => c.endsWith("/api/health"))).toHaveLength(3);
  });

  it("doesn't count S3 or a Lambda URL refusal as the backend answering", async () => {
    const run = (api: Response) =>
      checkHealth(
        {
          fetch: (async (url: string) =>
            url.endsWith("/api/health") ? api.clone() : new Response("<html>")) as typeof fetch,
          sleep: async () => undefined,
        },
        {
          baseUrl: "https://d.cloudfront.net",
          hasBackend: true,
          apiPathPrefix: "/api",
          healthCheckPath: "/api/health",
          timeoutMs: 10_000,
        },
      );

    const spaFallback = await run(
      new Response("<html>", { status: 200, headers: { server: "AmazonS3" } }),
    );
    expect(spaFallback.api!.ok).toBe(false);
    expect(spaFallback.api!.detail).toContain("S3 bucket");

    const lambdaRefused = await run(
      new Response('{"Message":"Forbidden"}', {
        status: 403,
        headers: { "x-amzn-ErrorType": "AccessDeniedException:http://internal.amazon.com/" },
      }),
    );
    expect(lambdaRefused.api!.ok).toBe(false);
    expect(lambdaRefused.api!.detail).toContain("AccessDeniedException)");

    const appNotFound = await run(new Response("Cannot GET /api/health", { status: 404 }));
    expect(appNotFound.api!.ok).toBe(true);
  });
});
