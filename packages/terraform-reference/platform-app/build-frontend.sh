#!/bin/bash
# CodeBuild: install and build a static frontend, then record which folder
# holds the built site (${AUTOINFRA_TMP:-/tmp}/autoinfra-frontend-out).
set -euo pipefail
FE_DIR="${AUTOINFRA_FE_DIR:-.}"
cd "$FE_DIR"

# Build-time variables from prepare-frontend.sh (NAME=value; values may hold '=').
if [ -f ${AUTOINFRA_TMP:-/tmp}/autoinfra-frontend.env ]; then
  while IFS='=' read -r name value; do
    [ -n "$name" ] && export "$name=$value"
  done < ${AUTOINFRA_TMP:-/tmp}/autoinfra-frontend.env
fi
# CI=true makes Create React App fail the build on lint warnings.
export CI=false
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=2560}"

if [ -z "${AUTOINFRA_FE_BUILD:-}" ]; then
  # Plain static site: published as-is.
  pwd > ${AUTOINFRA_TMP:-/tmp}/autoinfra-frontend-out
  exit 0
fi

echo "Installing frontend dependencies: $AUTOINFRA_FE_INSTALL"
eval "$AUTOINFRA_FE_INSTALL"
echo "Building the frontend: $AUTOINFRA_FE_BUILD"
eval "$AUTOINFRA_FE_BUILD"

# The expected folder first, then where common tools put their output.
out=""
for dir in "${AUTOINFRA_FE_OUT:-dist}" dist build out public/build .output/public dist/*/browser dist/*; do
  if [ -d "$dir" ] && [ -f "$dir/index.html" ]; then
    out="$dir"
    break
  fi
done
if [ -z "$out" ]; then
  echo "The frontend built, but no folder with an index.html was found (looked in ${AUTOINFRA_FE_OUT:-dist}, dist, build, out)."
  exit 1
fi
echo "Built site: $FE_DIR/$out"
(cd "$out" && pwd) > ${AUTOINFRA_TMP:-/tmp}/autoinfra-frontend-out
