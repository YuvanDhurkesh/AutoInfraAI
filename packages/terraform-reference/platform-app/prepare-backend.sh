#!/bin/bash
# CodeBuild, before the backend is built: localhost URLs in its code -> this
# deployment's URL. A frontend dev server's (CORS allow-lists, redirects after
# login) becomes the live URL; the backend's own (links it builds to itself)
# goes through the API prefix like the frontend's calls. Only in the build's
# copy of the source; the repo is never changed.
set -euo pipefail
BE_DIR="${AUTOINFRA_BE_DIR:-.}"
prefix="${API_PATH_PREFIX:-/api}"
for origin in ${AUTOINFRA_BE_LOCALHOST_ORIGINS:-}; do
  re=$(printf '%s' "$origin" | sed 's/[.]/\\./g')
  suffix=""
  if [ "${origin##*:}" = "${AUTOINFRA_BE_PORT:-}" ]; then suffix="${AUTOINFRA_LOCALHOST_SUFFIX:-}"; fi
  grep -rlIF --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=venv \
    --exclude-dir=.venv --exclude-dir=__pycache__ -- "$origin" "$BE_DIR" 2>/dev/null |
    while IFS= read -r file; do
      sed -i -E \
        -e "s#${re}(${prefix})([^A-Za-z0-9_-]|\$)#${SITE_URL}\1\2#g" \
        -e "s#${re}([^0-9]|\$)#${SITE_URL}${suffix}\1#g" \
        "$file"
      echo "Rewrote ${origin} -> ${SITE_URL}${suffix} in ${file}"
    done
done
