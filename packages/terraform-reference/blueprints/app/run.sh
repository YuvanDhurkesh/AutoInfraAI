#!/bin/bash
# Lambda Web Adapter entrypoint: load env vars from SSM, then start the app
# unchanged on $AWS_LWA_PORT.
set -e
{{#if PYTHON}}
eval "$(python3 autoinfra-env.py)"
{{else}}
eval "$(node autoinfra-env.mjs)"
{{/if}}
export PORT="${AWS_LWA_PORT:-8080}"
exec {{RUN_COMMAND}}
