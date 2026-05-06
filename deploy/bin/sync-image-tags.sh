#!/usr/bin/env bash
# Copyright 2026 Pipeline Builder Contributors
# SPDX-License-Identifier: Apache-2.0
#
# Sync Docker image tags in deploy/ files to match each service's
# package.json version.
#
# Hardcoded `image: ghcr.io/mwashburn160/<svc>:X.Y.Z[-suffix]` references
# drift from package.json on every release. Run this script after a version
# bump (or in CI before publishing manifests) to bring them back in sync.
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

# Service → path of its package.json (relative to repo root)
SERVICES=(
  "billing:api/billing"
  "compliance:api/compliance"
  "pipeline:api/pipeline"
  "plugin:api/plugin"
  "quota:api/quota"
  "message:api/message"
  "reporting:api/reporting"
  "image-registry:api/image-registry"
  "platform:platform"
  "frontend:frontend"
)

FILES=(
  "$ROOT"/deploy/minikube/k8s/*.yaml
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

for entry in "${SERVICES[@]}"; do
  svc="${entry%%:*}"
  pkg="$ROOT/${entry##*:}/package.json"
  [ -f "$pkg" ] || { echo "WARN: $pkg missing — skipping $svc"; continue; }

  ver=$(node -p "require('$pkg').version" 2>/dev/null || jq -r .version "$pkg")
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
