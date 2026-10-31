import { gunzipSync } from "node:zlib";
import { runOnInstance, type InstanceTarget } from "./instance-command.js";

/**
 * The read-only database viewer: the tables (collections) in the F2
 * instance's `db` container and a page of one table's rows. Only these fixed
 * queries run -- never SQL from the browser -- inside the container, with the
 * container's own credentials, in a read-only transaction (Postgres) or
 * session (MySQL); the Mongo script only reads.
 */
export const BROWSABLE_DATABASES = ["postgres", "mysql", "mongo"] as const;
export type BrowsableDatabase = (typeof BROWSABLE_DATABASES)[number];

export interface DatabaseTable {
  name: string;
  rows: number;
  /** A planner estimate (Postgres tables past 100k rows), not a count. */
  estimated?: boolean;
}

export interface DatabaseRows {
  columns: string[];
  /** Each value as text (Mongo: ids, dates and objects as JSON), cut at 200 characters. */
  rows: Record<string, string | null>[];
  total: number;
  offset: number;
  limit: number;
}

/** Longer values are cut here, so a page fits through SSM's 24k-character output. */
const CELL_MAX = 200;

/**
 * Table names as the listing gives them. Anything else is refused before it
 * reaches the instance: names are put into the query as quoted identifiers,
 * so quotes, backticks and spaces never get that far.
 */
const NAME: Record<BrowsableDatabase, RegExp> = {
  // "schema.table" outside public.
  postgres: /^(?:([A-Za-z0-9_][A-Za-z0-9_$-]{0,62})\.)?([A-Za-z0-9_][A-Za-z0-9_$-]{0,62})$/,
  mysql: /^[A-Za-z0-9_$-]{1,64}$/,
  // "database/collection" outside the app's database.
  mongo: /^(?:([A-Za-z0-9_-]{1,63})\/)?([A-Za-z0-9_][A-Za-z0-9_.-]{0,119})$/,
};

export function isBrowsableTableName(kind: BrowsableDatabase, name: string): boolean {
  return NAME[kind].test(name);
}

/** Runs a script on the client inside the `db` container, reading it from stdin. */
const CLIENT: Record<BrowsableDatabase, string> = {
  postgres:
    'PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=15000" psql -X -q -t -A -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"',
  mysql:
    'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" --batch --raw --skip-column-names "$MYSQL_DATABASE"',
  mongo:
    'f=/tmp/autoinfra-view-$$.js; cat > "$f" && mongosh --quiet -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin mongodb://127.0.0.1:27017/admin --file "$f"; s=$?; rm -f "$f"; exit $s',
};

const MYSQL_SESSION = [
  "SET SESSION TRANSACTION READ ONLY;",
  "SET SESSION max_execution_time = 15000;",
  "SET SESSION group_concat_max_len = 1000000;",
].join("\n");

/** Mongo values as text: ids and dates plainly, objects and arrays as JSON. */
const MONGO_CELL = `const cell = (v) => v === null || v === undefined ? null
  : typeof v === "string" ? v
  : v instanceof Date ? v.toISOString()
  : /^ObjectI[dD]$/.test(v._bsontype ?? "") ? v.toHexString()
  : EJSON.stringify(v, { relaxed: true });`;

function listScript(kind: BrowsableDatabase): string {
  switch (kind) {
    case "postgres":
      // Exact counts (count(*) per table) unless the table is big.
      return `SELECT coalesce(json_agg(json_build_object(
  'name', CASE WHEN n.nspname = 'public' THEN c.relname ELSE n.nspname || '.' || c.relname END,
  'rows', CASE WHEN c.reltuples > 100000 THEN c.reltuples::bigint
    ELSE (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname), false, true, '')))[1]::text::bigint END,
  'estimated', c.reltuples > 100000
) ORDER BY n.nspname <> 'public', n.nspname, c.relname), '[]')
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition
  AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%';`;
    case "mysql":
      return `${MYSQL_SESSION}
SELECT GROUP_CONCAT(CONCAT('SELECT ', QUOTE(table_name), ' AS name, COUNT(*) AS n FROM \`', REPLACE(table_name, '\`', '\`\`'), '\`') SEPARATOR ' UNION ALL ')
  INTO @u FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE';
SET @q = IF(@u IS NULL, 'SELECT JSON_ARRAY()',
  CONCAT('SELECT JSON_ARRAYAGG(JSON_OBJECT(''name'', name, ''rows'', n)) FROM (', @u, ') x'));
PREPARE s FROM @q;
EXECUTE s;`;
    case "mongo":
      return `const def = process.env.MONGO_INITDB_DATABASE;
const tables = [];
for (const { name: dn } of db.adminCommand({ listDatabases: 1, nameOnly: true }).databases) {
  if (["admin", "config", "local"].includes(dn)) continue;
  const d = db.getSiblingDB(dn);
  for (const cn of d.getCollectionNames()) {
    if (cn.startsWith("system.")) continue;
    tables.push({ name: dn === def ? cn : dn + "/" + cn, rows: d.getCollection(cn).estimatedDocumentCount() });
  }
}
print(JSON.stringify(tables));`;
  }
}

function rowsScript(kind: BrowsableDatabase, name: string, limit: number, offset: number): string {
  const m = NAME[kind].exec(name);
  if (!m) throw new Error(`can't browse a table named ${JSON.stringify(name)}`);
  switch (kind) {
    case "postgres": {
      const rel = `"${m[1] ?? "public"}"."${m[2]}"`;
      return `SELECT json_build_object(
  'columns', (SELECT coalesce(json_agg(attname ORDER BY attnum), '[]') FROM pg_attribute
    WHERE attrelid = '${rel}'::regclass AND attnum > 0 AND NOT attisdropped),
  'total', (SELECT count(*) FROM ${rel}),
  'rows', (SELECT coalesce(json_agg((SELECT json_object_agg(key, left(value, ${CELL_MAX + 1})) FROM json_each_text(row_to_json(r)))), '[]')
    FROM (SELECT * FROM ${rel} LIMIT ${limit} OFFSET ${offset}) r)
);`;
    }
    case "mysql":
      // Column names come from information_schema and are quoted there.
      return `${MYSQL_SESSION}
SET @t = '${name}';
SELECT GROUP_CONCAT(CONCAT(QUOTE(column_name), ', LEFT(CAST(\`', REPLACE(column_name, '\`', '\`\`'), '\` AS CHAR), ${CELL_MAX + 1})') ORDER BY ordinal_position SEPARATOR ', '),
       CONCAT('[', GROUP_CONCAT(JSON_QUOTE(column_name) ORDER BY ordinal_position SEPARATOR ','), ']')
  INTO @pairs, @cols
  FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = @t;
SET @q = IF(@pairs IS NULL, 'SELECT JSON_OBJECT(''error'', ''no_such_table'')',
  CONCAT('SELECT JSON_OBJECT(''columns'', CAST(', QUOTE(@cols), ' AS JSON), ''total'', (SELECT COUNT(*) FROM \`', @t, '\`), ''rows'', (SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT(', @pairs, ')), JSON_ARRAY()) FROM (SELECT * FROM \`', @t, '\` LIMIT ${limit} OFFSET ${offset}) r))'));
PREPARE s FROM @q;
EXECUTE s;`;
    case "mongo":
      return `const def = process.env.MONGO_INITDB_DATABASE;
const d = db.getSiblingDB(${JSON.stringify(m[1] ?? null)} ?? def);
const cn = ${JSON.stringify(m[2])};
${MONGO_CELL}
if (!d.getCollectionNames().includes(cn)) {
  print(JSON.stringify({ error: "no_such_table" }));
} else {
  const c = d.getCollection(cn);
  const docs = c.find().skip(${offset}).limit(${limit}).toArray();
  const columns = [];
  for (const doc of docs) for (const k of Object.keys(doc)) if (!columns.includes(k)) columns.push(k);
  const rows = docs.map((doc) => Object.fromEntries(Object.keys(doc).map((k) => {
    const v = cell(doc[k]);
    return [k, v === null ? null : v.slice(0, ${CELL_MAX + 1})];
  })));
  print(JSON.stringify({ columns, total: c.estimatedDocumentCount(), rows }));
}`;
  }
}

const NO_SUCH_TABLE = "no such table";

/** The page didn't fit through SSM's output limit. */
class TooLarge extends Error {}

/** Runs one script in the `db` container; its last stdout line, parsed. */
async function runInDb(
  target: InstanceTarget,
  kind: BrowsableDatabase,
  script: string,
): Promise<unknown> {
  const b64 = Buffer.from(script, "utf8").toString("base64");
  const res = await runOnInstance(
    target,
    [
      "set -o pipefail",
      "cd /opt/autoinfra",
      // base64 is shell-safe, so nothing in the script reaches the shell; the
      // answer is gzipped to fit SSM's output limit.
      `echo ${b64} | base64 -d | docker compose exec -T db sh -c '${CLIENT[kind]}' | gzip -c | base64 -w0`,
    ],
    "AutoInfra: database viewer (read-only)",
  );
  if (!res.ok) throw new Error(dbError(res.stderr));
  // SSM cuts stdout at 24,000 characters.
  if (res.stdout.length >= 24000) throw new TooLarge();
  let text: string;
  try {
    text = gunzipSync(Buffer.from(res.stdout.trim(), "base64")).toString("utf8");
  } catch {
    throw new TooLarge();
  }
  if (!text.trim()) throw new Error(dbError(res.stderr) || "the database returned nothing");
  // psql's json_agg breaks lines between elements; a client warning would
  // come before the answer, on lines of its own.
  try {
    return JSON.parse(text);
  } catch {
    return JSON.parse(text.trim().split("\n").pop()!);
  }
}

/** The database client's complaint, without its password warning. */
function dbError(stderr: string): string {
  if (/service "?db"? is not running|no such service: db/i.test(stderr))
    return "the database container isn't running";
  // Postgres's answer for a table that isn't there (spread over three lines).
  if (/ERROR:\s+relation "[^"]*" does not exist/.test(stderr)) return NO_SUCH_TABLE;
  const lines = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/Using a password on the command line/i.test(l));
  return lines.slice(-2).join(" ").slice(0, 300) || "the command failed on the instance";
}

export async function listDatabaseTables(
  opts: InstanceTarget & { kind: BrowsableDatabase },
): Promise<DatabaseTable[]> {
  if (!BROWSABLE_DATABASES.includes(opts.kind)) throw new Error(`can't browse ${opts.kind}`);
  const raw = await runInDb(opts, opts.kind, listScript(opts.kind));
  const tables = Array.isArray(raw) ? (raw as DatabaseTable[]) : [];
  return tables
    .map((t) => ({
      name: String(t.name),
      rows: Number(t.rows) || 0,
      ...(t.estimated ? { estimated: true } : {}),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** A page of one table's rows; null when there's no such table. */
export async function readDatabaseTable(
  opts: InstanceTarget & { kind: BrowsableDatabase; table: string; limit: number; offset: number },
): Promise<DatabaseRows | null> {
  if (!BROWSABLE_DATABASES.includes(opts.kind)) throw new Error(`can't browse ${opts.kind}`);
  const offset = Math.max(Math.trunc(opts.offset) || 0, 0);
  let limit = Math.min(Math.max(Math.trunc(opts.limit) || 25, 1), 50);
  for (;;) {
    let raw: unknown;
    try {
      raw = await runInDb(opts, opts.kind, rowsScript(opts.kind, opts.table, limit, offset));
    } catch (err) {
      // Wide rows: fewer per page.
      if (err instanceof TooLarge && limit > 5) {
        limit = Math.max(5, Math.floor(limit / 3));
        continue;
      }
      if (err instanceof TooLarge)
        throw new Error("these rows are too large to show here", { cause: err });
      if (err instanceof Error && err.message === NO_SUCH_TABLE) return null;
      throw err;
    }
    const page = raw as {
      error?: string;
      columns?: string[];
      rows?: Record<string, unknown>[];
      total?: number;
    };
    if (page.error === "no_such_table") return null;
    const cut = (v: unknown): string | null => {
      if (v === null || v === undefined) return null;
      const s = typeof v === "string" ? v : JSON.stringify(v);
      return s.length > CELL_MAX ? `${s.slice(0, CELL_MAX)}…` : s;
    };
    return {
      columns: (page.columns ?? []).map(String),
      rows: (page.rows ?? []).map((r) =>
        Object.fromEntries(Object.entries(r ?? {}).map(([k, v]) => [k, cut(v)])),
      ),
      total: Number(page.total) || 0,
      offset,
      limit,
    };
  }
}
