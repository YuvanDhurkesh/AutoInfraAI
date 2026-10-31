#!/bin/bash
# CodeBuild (F1): package the backend for Lambda -- the app unchanged, its
# dependencies, the Web Adapter entrypoint (run.sh) and the SSM env loader --
# and ship it. The zip goes through S3: update-function-code takes at most
# 50 MB inline.
set -euo pipefail
platform="$(pwd)/.autoinfra"
cd "${AUTOINFRA_BE_DIR:-.}"

if [ "${AUTOINFRA_BE_LANG:-node}" = "python" ]; then
  # Dependencies next to the code: python -m puts the working directory on sys.path.
  if [ -f requirements.txt ]; then
    python3 -m pip install --no-cache-dir --quiet --target . -r requirements.txt
  else
    python3 -m pip install --no-cache-dir --quiet --target . .
  fi
  if [ -n "${AUTOINFRA_RUNTIME_NEEDS:-}" ]; then
    # shellcheck disable=SC2086 # a list of packages
    python3 -m pip install --no-cache-dir --quiet --target . $AUTOINFRA_RUNTIME_NEEDS
  fi
  cp "$platform/autoinfra-env.py" .
else
  echo "Installing backend dependencies: ${AUTOINFRA_BE_INSTALL:-npm install}"
  eval "${AUTOINFRA_BE_INSTALL:-npm install}"
  if [ -n "${AUTOINFRA_BE_BUILD:-}" ]; then eval "$AUTOINFRA_BE_BUILD"; fi
  if [ -f prisma/schema.prisma ] || [ -f schema.prisma ]; then
    npx prisma generate # CodeBuild and Lambda share the platform: the native engine fits
  elif [ -f package-lock.json ]; then
    npm prune --omit=dev # dev tools aren't needed to run (Lambda caps the unzipped size)
  fi
  cp "$platform/autoinfra-env.mjs" .
fi
cp "$platform/run.sh" .
chmod +x run.sh

rm -f /tmp/api.zip
zip -qr /tmp/api.zip . -x '.git/*' '.autoinfra/*'
echo "Lambda package: $(du -h /tmp/api.zip | cut -f1)"
aws s3 cp /tmp/api.zip "s3://$ARTIFACTS_BUCKET/deploy/api.zip" --only-show-errors
aws lambda update-function-code --function-name "$FUNCTION_NAME" \
  --s3-bucket "$ARTIFACTS_BUCKET" --s3-key deploy/api.zip > /dev/null
aws lambda wait function-updated --function-name "$FUNCTION_NAME"
echo "Updated Lambda function $FUNCTION_NAME"
