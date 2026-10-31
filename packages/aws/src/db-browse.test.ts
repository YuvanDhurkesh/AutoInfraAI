import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GetCommandInvocationCommand, SendCommandCommand, SSMClient } from "@aws-sdk/client-ssm";
import { isBrowsableTableName, listDatabaseTables, readDatabaseTable } from "./db-browse.js";

const target = {
  credentials: { accessKeyId: "AKIA", secretAccessKey: "x" },
  region: "ap-south-1",
  instanceId: "i-1",
  pollMs: 0,
};
afterEach(() => vi.restoreAllMocks());

/** Answers each SendCommand with the next reply; records the scripts sent. */
function fakeInstance(replies: { stdout?: string; stderr?: string; ok?: boolean; raw?: string }[]) {
  const sent: { command: string; script: string }[] = [];
  let reply = replies[0]!;
  vi.spyOn(SSMClient.prototype, "send").mockImplementation(async (command: unknown) => {
    if (command instanceof SendCommandCommand) {
      const command_ = (command.input.Parameters?.commands ?? []).join("\n");
      const b64 = /echo (\S+) \| base64 -d/.exec(command_)![1]!;
      sent.push({ command: command_, script: Buffer.from(b64, "base64").toString("utf8") });
      reply = replies[sent.length - 1] ?? reply;
      return { Command: { CommandId: `c-${sent.length}` } };
    }
    if (command instanceof GetCommandInvocationCommand) {
      return {
        Status: reply.ok === false ? "Failed" : "Success",
        StandardOutputContent:
          reply.raw ?? gzipSync(Buffer.from(reply.stdout ?? "", "utf8")).toString("base64"),
        StandardErrorContent: reply.stderr ?? "",
      };
    }
    throw new Error("unexpected command");
  });
  return sent;
}

describe("database viewer", () => {
  it("lists Postgres tables read-only, inside the db container, sorted", async () => {
    const sent = fakeInstance([
      {
        stdout:
          '[{"name":"users","rows":3,"estimated":false}, \n {"name":"audit.events","rows":200000,"estimated":true}]\n',
      },
    ]);
    const tables = await listDatabaseTables({ ...target, kind: "postgres" });
    expect(tables).toEqual([
      { name: "audit.events", rows: 200000, estimated: true },
      { name: "users", rows: 3 },
    ]);
    expect(sent[0]!.command).toContain("docker compose exec -T db sh -c");
    expect(sent[0]!.command).toContain("default_transaction_read_only=on");
    expect(sent[0]!.script).toContain("FROM pg_class");
  });

  it("reads a MySQL page in a read-only session; long values are cut", async () => {
    const long = "x".repeat(500);
    const sent = fakeInstance([
      {
        stderr: "mysql: [Warning] Using a password on the command line interface can be insecure.",
        stdout: JSON.stringify({
          columns: ["id", "bio"],
          total: 1,
          rows: [{ id: "1", bio: long }],
        }),
      },
    ]);
    const page = await readDatabaseTable({
      ...target,
      kind: "mysql",
      table: "users",
      limit: 25,
      offset: 50,
    });
    expect(page).toEqual({
      columns: ["id", "bio"],
      rows: [{ id: "1", bio: `${"x".repeat(200)}…` }],
      total: 1,
      offset: 50,
      limit: 25,
    });
    expect(sent[0]!.script).toContain("SET SESSION TRANSACTION READ ONLY;");
    expect(sent[0]!.script).toContain("SET @t = 'users';");
    expect(sent[0]!.script).toContain("LIMIT 25 OFFSET 50");
  });

  it("refuses table names that could break out of the query -- nothing is sent", async () => {
    const send = vi.spyOn(SSMClient.prototype, "send");
    for (const table of ['users"; DROP TABLE users; --', "a'b", "a`b", "a b", ""]) {
      await expect(
        readDatabaseTable({ ...target, kind: "postgres", table, limit: 5, offset: 0 }),
      ).rejects.toThrow(/can't browse/);
      expect(isBrowsableTableName("mysql", table)).toBe(false);
    }
    expect(send).not.toHaveBeenCalled();
    expect(isBrowsableTableName("postgres", "audit.events")).toBe(true);
    expect(isBrowsableTableName("mongo", "otherdb/fs.chunks")).toBe(true);
  });

  it("a missing table is null: Postgres's error, Mongo's answer", async () => {
    fakeInstance([{ ok: false, stderr: 'ERROR:  relation "public.gone" does not exist' }]);
    expect(
      await readDatabaseTable({ ...target, kind: "postgres", table: "gone", limit: 5, offset: 0 }),
    ).toBeNull();
    vi.restoreAllMocks();
    const sent = fakeInstance([{ stdout: '{"error":"no_such_table"}' }]);
    expect(
      await readDatabaseTable({
        ...target,
        kind: "mongo",
        table: "other/gone",
        limit: 5,
        offset: 0,
      }),
    ).toBeNull();
    expect(sent[0]!.script).toContain('db.getSiblingDB("other" ?? def)');
  });

  it("rows too wide for SSM's output: fewer per page", async () => {
    const sent = fakeInstance([
      { raw: "A".repeat(24000) },
      { stdout: JSON.stringify({ columns: ["_id"], total: 40, rows: [{ _id: "a" }] }) },
    ]);
    const page = await readDatabaseTable({
      ...target,
      kind: "mongo",
      table: "posts",
      limit: 25,
      offset: 0,
    });
    expect(page?.limit).toBe(8);
    expect(sent[1]!.script).toContain(".limit(8)");
  });

  it("explains a stopped database container", async () => {
    fakeInstance([{ ok: false, stderr: 'service "db" is not running' }]);
    await expect(listDatabaseTables({ ...target, kind: "mongo" })).rejects.toThrow(
      /container isn't running/,
    );
  });
});
