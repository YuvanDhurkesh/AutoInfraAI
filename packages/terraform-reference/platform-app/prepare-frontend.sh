#!/bin/bash
# CodeBuild, before the frontend is built: everything the build needs that
# isn't in the repo. Writes NAME=value lines to ${AUTOINFRA_TMP:-/tmp}/autoinfra-frontend.env.
set -euo pipefail
FE_DIR="${AUTOINFRA_FE_DIR:-.}"
OUT=${AUTOINFRA_TMP:-/tmp}/autoinfra-frontend.env
: > "$OUT"

# 1. Public build-time variables the owner entered (VITE_*, NEXT_PUBLIC_*, ...).
#    Only these: they end up in the browser bundle anyway.
names=$(aws ssm describe-parameters \
  --parameter-filters "Key=Path,Option=OneLevel,Values=$SSM_PREFIX" \
  --query "Parameters[].Name" --output text 2>/dev/null || true)
public=()
for name in $names; do
  case "${name##*/}" in
    VITE_* | NEXT_PUBLIC_* | REACT_APP_* | VUE_APP_* | PUBLIC_*) public+=("$name") ;;
  esac
done
for ((i = 0; i < ${#public[@]}; i += 10)); do # get-parameters takes 10 names per call
  aws ssm get-parameters --with-decryption --names "${public[@]:i:10}" \
    --query "Parameters[].[Name,Value]" --output json |
    python3 -c '
import json, sys
for name, value in json.load(sys.stdin):
    print(name.rsplit("/", 1)[-1] + "=" + value.replace("\n", " "))
' >> "$OUT"
done

# 2. The API address: always this deployment's own URL. A value copied from a
#    local .env (http://localhost:5000) must never reach the build.
if [ -n "${AUTOINFRA_API_VAR:-}" ]; then
  grep -v "^${AUTOINFRA_API_VAR}=" "$OUT" > "$OUT.tmp" || true
  mv "$OUT.tmp" "$OUT"
  echo "${AUTOINFRA_API_VAR}=${SITE_URL}${AUTOINFRA_API_SUFFIX:-}" >> "$OUT"
fi

# 3. Backend URLs hardcoded for local development -> this deployment's URL.
#    Only in the build's copy of the source; the repo is never changed.
#    http://localhost:5000/api/... keeps its path; other paths get the API
#    prefix when the backend's routes lack it (CloudFront strips it again),
#    except on socket.io lines, whose own path is routed to the backend.
#    ws://localhost:5000 becomes wss://<site>.
prefix="${API_PATH_PREFIX:-/api}"
for origin in ${AUTOINFRA_LOCALHOST_ORIGINS:-}; do
  re=$(printf '%s' "$origin" | sed 's/[.]/\\./g')
  rules=()
  case "$origin" in
    ws://* | wss://*) target="wss://${SITE_URL#https://}" suffix="${AUTOINFRA_WS_SUFFIX:-}" ;;
    *)
      target="$SITE_URL" suffix="${AUTOINFRA_LOCALHOST_SUFFIX:-}"
      rules+=(-e "/\bio\(|socket/I s#${re}([^0-9]|\$)#${target}\1#g")
      ;;
  esac
  rules+=(
    -e "s#${re}(${prefix})([^A-Za-z0-9_-]|\$)#${target}\1\2#g"
    -e "s#${re}([^0-9]|\$)#${target}${suffix}\1#g"
  )
  grep -rlIF --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.next \
    --exclude-dir=dist --exclude-dir=build -- "$origin" "$FE_DIR" 2>/dev/null |
    while IFS= read -r file; do
      sed -i -E "${rules[@]}" "$file"
      echo "Rewrote ${origin} -> ${target}${suffix} in ${file}"
    done
done

echo "Frontend build variables: $(cut -d= -f1 "$OUT" | tr '\n' ' ')"
