# Platform-owned (AutoInfra adds this to every F1 build). Python twin of
# autoinfra-env.mjs: prints `export NAME='value'` lines for the app's env vars
# in SSM under $AUTOINFRA_SSM_PREFIX. Uses boto3 from the Lambda runtime.
import os
import re
import shlex

import boto3

prefix = os.environ.get("AUTOINFRA_SSM_PREFIX")
if prefix:
    paginator = boto3.client("ssm").get_paginator("get_parameters_by_path")
    for page in paginator.paginate(Path=prefix, Recursive=False, WithDecryption=True):
        for param in page.get("Parameters", []):
            name = param["Name"][len(prefix):]
            # Only valid shell identifiers -- a parameter name can't inject commands.
            if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
                print(f"export {name}={shlex.quote(param.get('Value', ''))}")
