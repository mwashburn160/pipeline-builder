#!/usr/bin/env bash
# Copyright 2026 Pipeline Builder Contributors
# SPDX-License-Identifier: Apache-2.0
#
# Sync Docker image tags in deploy/ files to the latest version published
# for each service.
#
# Source of truth: the `release/<svc>/<version>` git tags emitted by `nx
# release`. package.json is NOT used because nx resets it to 0.0.0 on every
# working copy and only bumps it momentarily in CI right before publish.
#
# Targets:
#   - deploy/minikube/k8s/*.yaml       (Kubernetes Deployment manifests)
#   - deploy/local/docker-compose.yml  (Docker Compose for local dev)
#   - deploy/aws/fargate/.env.example  (Fargate env defaults)
#
# Build-strategy suffixes on the plugin image (`-docker`, `-kaniko`) are
# preserved; only the version portion is rewritten.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Services to sync. Tag prefix is always `release/<svc>/`.
SERVICES=(
  billing
  compliance
  pipeline
  plugin
  quota
  message
  reporting
  image-registry
  platform
  frontend
)

FILES=(
  "$ROOT"/deploy/minikube/k8s/*.yaml
  "$ROOT"/deploy/aws/ec2/k8s/*.yaml
  "$ROOT/deploy/local/docker-compose.yml"
  "$ROOT/deploy/aws/fargate/.env.example"
)

# Cross-platform `sed -i` (BSD sed needs an explicit empty backup arg)
sed_i() {
  if sed --version >/dev/null 2>&1; then
    sed -E -i "$@"
  else
    sed -E -i '' "$@"
  fi
}

for svc in "${SERVICES[@]}"; do
  ver=$(git -C "$ROOT" tag --list "release/${svc}/*" --sort=-v:refname | head -1 | sed "s|release/${svc}/||")
  if [ -z "$ver" ]; then
    echo "WARN: no release tag for $svc — skipping"
    continue
  fi
  echo "→ $svc: $ver"

  # Match `ghcr.io/mwashburn160/<svc>:<old-version>[-<suffix>]` and replace
  # only the version. The version is `[A-Za-z0-9._-]+?` until either the end
  # of the tag or a `-<suffix>` (suffixes use letters only: `-docker`,
  # `-kaniko`). `latest` is also rewritten so all environments converge.
  for f in "${FILES[@]}"; do
    [ -f "$f" ] || continue
    sed_i "s|(ghcr\\.io/mwashburn160/${svc}:)[A-Za-z0-9._]+(-[a-z]+)?|\\1${ver}\\2|g" "$f"
  done
done

echo "Done. Review the diff with: git diff -- deploy/"
