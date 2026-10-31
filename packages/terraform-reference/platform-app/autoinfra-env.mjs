// Platform-owned (AutoInfra adds this to every F1 build). Prints
// `export NAME='value'` lines for the app's env vars stored in SSM Parameter
// Store under $AUTOINFRA_SSM_PREFIX, for run.sh to eval before starting the
// app. Uses the AWS SDK bundled in the Lambda Node.js runtime.
import { SSMClient, GetParametersByPathCommand } from "@aws-sdk/client-ssm";

const prefix = process.env.AUTOINFRA_SSM_PREFIX;
if (!prefix) process.exit(0);

const client = new SSMClient({});
const quote = (v) => `'${v.replace(/'/g, `'\\''`)}'`;
let NextToken;
do {
  const res = await client.send(
    new GetParametersByPathCommand({
      Path: prefix,
      Recursive: false,
      WithDecryption: true,
      NextToken,
    }),
  );
  for (const p of res.Parameters ?? []) {
    const name = p.Name.slice(prefix.length);
    // Only valid shell identifiers -- a parameter name can't inject commands.
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      process.stdout.write(`export ${name}=${quote(p.Value ?? "")}\n`);
    }
  }
  NextToken = res.NextToken;
} while (NextToken);
