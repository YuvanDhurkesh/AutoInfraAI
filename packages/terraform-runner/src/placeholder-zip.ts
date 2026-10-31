import { deflateRawSync } from "node:zlib";
/**
 * The F1 Lambda needs a deployment package at create time, before CodeBuild
 * has built the real app. This placeholder runs behind the Web Adapter,
 * answers the readiness path with 200, and everything else with 503
 * "deploying". Built in-process (no archive provider -- only aws and random
 * are allowed) and byte-for-byte deterministic, so source_code_hash is stable
 * between plan and apply.
 */
const PLACEHOLDER_JS = `const http = require("http");
const port = Number(process.env.AWS_LWA_PORT || 8080);
const ready = process.env.AWS_LWA_READINESS_CHECK_PATH || "/";
http
  .createServer((req, res) => {
    if (req.url === ready) {
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end("ok");
    }
    res.writeHead(503, { "content-type": "application/json", "retry-after": "30" });
    res.end(JSON.stringify({ error: "deploying", message: "AutoInfra is still deploying this app." }));
  })
  .listen(port);
`;

const RUN_SH = "#!/bin/bash\nexec node placeholder.js\n";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// Fixed DOS timestamp (1980-01-01 00:00) for determinism.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

export interface ZipEntry {
  name: string;
  data: Buffer;
  mode: number;
  /** Deflate instead of store (used for repo source uploads). */
  deflate?: boolean;
}

export function buildZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const crc = crc32(e.data);
    const stored = e.deflate ? deflateRawSync(e.data) : e.data;
    const method = e.deflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, stored);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by: Unix, so the mode below is honored
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(((0o100000 | e.mode) << 16) >>> 0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + stored.length;
  }

  const centralSize = centrals.reduce((s, b) => s + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

export function buildPlaceholderLambdaZip(): Buffer {
  return buildZip([
    { name: "placeholder.js", data: Buffer.from(PLACEHOLDER_JS), mode: 0o644 },
    { name: "run.sh", data: Buffer.from(RUN_SH), mode: 0o755 },
  ]);
}
