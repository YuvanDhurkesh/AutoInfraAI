#!/bin/bash
# CodeBuild: upload the built site to the private frontend bucket. HTML is
# revalidated on every request so a deploy shows up at once.
set -euo pipefail
out=$(cat ${AUTOINFRA_TMP:-/tmp}/autoinfra-frontend-out)
skip=(--exclude ".git/*" --exclude ".autoinfra/*" --exclude "node_modules/*" --exclude ".env*")
aws s3 sync "$out" "s3://$FRONTEND_BUCKET" --delete --only-show-errors "${skip[@]}"
aws s3 cp "$out" "s3://$FRONTEND_BUCKET" --recursive --only-show-errors "${skip[@]}" \
  --exclude "*" --include "*.html" --cache-control "no-cache" \
  --content-type "text/html; charset=utf-8"
echo "Published the frontend to s3://$FRONTEND_BUCKET"
