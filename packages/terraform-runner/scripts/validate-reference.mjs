import { runGauntlet } from "../dist/index.js";
import { loadReference, lambdaAdapterLayerArn } from "@autoinfra/terraform-reference";

const pattern = process.argv[2];
let files = loadReference(pattern);
if (process.env.MUTATE) {
  files = files.map((f) => {
    let c = f.content;
    if (f.path === "storage.tf") {
      c = c.replace(
        /resource "aws_s3_bucket_public_access_block" "artifacts" \{[\s\S]*?\n\}\n/,
        "",
      );
    }
    if (f.path === "compute.tf") {
      c = c
        .replace("retention_in_days = 7", "retention_in_days = 0")
        .replace(
          'billing_mode = "PAY_PER_REQUEST"',
          'billing_mode = "PAY_PER_REQUEST"\n  region       = "us-east-1"',
        );
    }
    return { ...f, content: c };
  });
}

const res = await runGauntlet({
  bundle: { files },
  pattern,
  freeTierMode: "strict",
  eligibleInstanceTypes: ["t3.micro"],
  existingAlwaysOnEc2Count: 0,
  credentials: process.env.SMOKE_CREDS ? JSON.parse(process.env.SMOKE_CREDS) : null,
  pluginCacheDir: process.env.LOCALAPPDATA + "/autoinfra/tf-plugin-cache",
  tfvars: {
    region: "ap-south-1",
    deployment_id: "dep-smoke",
    owner: "user-smoke",
    short_id: "smoke123",
    api_path_prefix: "/api",
    app_port: 4000,
    health_check_path: "/api/health",
    function_url_auth_type: "NONE",
    lambda_adapter_layer_arn: lambdaAdapterLayerArn("ap-south-1"),
    instance_type: "t3.micro",
    instance_architecture: "x86_64",
  },
});
for (const g of res.gates) {
  console.log(`[${g.gate}] ${g.status} (${g.durationMs}ms)`);
  for (const e of g.errors) console.log("   ERR  " + e);
  for (const n of g.notes) console.log("   note " + n);
}
