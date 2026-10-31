#!/bin/bash
# Lambda Web Adapter entrypoint: load env vars from SSM, then start the app
# unchanged on $AWS_LWA_PORT.
set -e
eval "$(node autoinfra-env.mjs)"
export PORT="${AWS_LWA_PORT:-8080}"
exec node src/server.js
