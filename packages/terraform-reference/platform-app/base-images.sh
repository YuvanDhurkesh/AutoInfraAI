#!/bin/bash
# Run by the buildspec before `docker build` with the repo's own Dockerfile:
# pulls its Docker Official base images (FROM node:20, python:3.12-slim...)
# from AWS's mirror and tags them with the Dockerfile's own names, so the
# build finds them locally -- Docker Hub refuses CodeBuild's shared addresses
# with 429 Too Many Requests. Best effort: an image the mirror doesn't have
# is left for docker build to pull as before.
# Usage: base-images.sh <Dockerfile>
set -uo pipefail
dockerfile="$1"
[ -f "$dockerfile" ] || exit 0

declare -A args=()
stages=" "
seen_from=false
while IFS= read -r line; do
  read -ra words <<< "$line"
  keyword="${words[0]:-}"
  # ARG defaults before the first FROM can name the base image (FROM node:${NODE_VERSION}).
  if [[ "${keyword^^}" == ARG && $seen_from == false && "${words[1]:-}" == *=* ]]; then
    value="${words[1]#*=}"
    args["${words[1]%%=*}"]="${value//\"/}"
    continue
  fi
  [[ "${keyword^^}" == FROM ]] || continue
  seen_from=true
  i=1
  while [[ "${words[i]:-}" == --* ]]; do i=$((i + 1)); done # --platform=...
  ref="${words[i]:-}"
  [[ "${words[i + 1]:-}" =~ ^[Aa][Ss]$ ]] && alias="${words[i + 2]:-}" || alias=""
  for name in "${!args[@]}"; do
    ref="${ref//\$\{$name\}/${args[$name]}}"
    ref="${ref//\$$name/${args[$name]}}"
  done
  lower="${ref,,}"
  if [[ -n "$ref" && "$ref" != *'$'* && "$ref" != *@* && "$lower" != scratch && "$stages" != *" $lower "* ]]; then
    image="${ref%%:*}"
    tag="${ref#*:}"
    [[ "$tag" == "$ref" ]] && tag=latest
    image="${image#docker.io/}"
    image="${image#library/}"
    # Only Docker Official Images (no namespace, no registry) are on the mirror.
    if [[ "$image" != */* ]]; then
      mirror="public.ecr.aws/docker/library/$image:$tag"
      if docker pull -q "$mirror" > /dev/null 2>&1 && docker tag "$mirror" "$ref"; then
        echo "Base image $ref: from AWS's mirror of Docker Official Images"
      fi
    fi
  fi
  [[ -n "$alias" ]] && stages="$stages${alias,,} "
done < "$dockerfile"
exit 0
