#!/usr/bin/env bash
# Copyright 2026 Pipeline Builder Contributors
# SPDX-License-Identifier: Apache-2.0
#
# Sync Docker image tags in deploy/ files to each service's package.json
# version. Run after a version bump (or in CI before publishing manifests).
#
# Source of truth: each service's package.json `version` field.
#
# Targets:
#   - deploy/minikube/k8s/*.yaml       (Kubernetes Deployment manifests)
#   - deploy/aws/ec2/k8s/*.yaml        (EC2 single-node k8s manifests)
#   - deploy/local/docker-compose.yml  (Docker Compose for local dev)
#   - deploy/aws/fargate/.env.example  (Fargate env defaults)
#   - deploy/aws/fargate/stacks/04-services.yaml
#
# Plugin image is a single target (no `-docker`/`-kaniko`/`-podman` suffix).
# Builds run on a rootless buildkitd sidecar across every deploy target.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Service name → path of its package.json (relative to repo root).
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
  "$ROOT"/deploy/aws/ec2/k8s/*.yaml
  "$ROOT/deploy/local/docker-compose.yml"
  "$ROOT/deploy/aws/fargate/.env.example"
  "$ROOT/deploy/aws/fargate/stacks/04-services.yaml"
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
  if [ ! -f "$pkg" ]; then
    echo "WARN: $pkg missing — skipping $svc"
    continue
  fi
  ver=$(node -p "require('$pkg').version" 2>/dev/null || jq -r .version "$pkg")
  if [ -z "$ver" ] || [ "$ver" = "null" ]; then
    echo "WARN: could not read version from $pkg — skipping $svc"
    continue
  fi
  echo "→ $svc: $ver"

  # Match `ghcr.io/mwashburn160/<svc>:<old-version>` and replace the version.
  # `latest` is also rewritten so all environments converge.
  for f in "${FILES[@]}"; do
    [ -f "$f" ] || continue
    sed_i "s|(ghcr\\.io/mwashburn160/${svc}:)[A-Za-z0-9._]+|\\1${ver}|g" "$f"
  done
done

echo "Done. Review the diff with: git diff -- deploy/"
