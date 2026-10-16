#!/usr/bin/env bash
# Copyright 2026 Pipeline Builder Contributors
# SPDX-License-Identifier: Apache-2.0
#
# render-for-schema-check.sh <deploy/target-dir>
#
# Render a k8s target the way its deploy script applies it — `kubectl
# kustomize`, then the deploy-time token substitution — with REPRESENTATIVE
# values, so CI's schema check (kubeconform -strict) validates what a cluster
# actually receives. Prints the rendered YAML.
#
# WHY. The deploy scripts (eks bin/setup.sh, ec2 bin/startup.sh, minikube
# bin/setup.sh) sed `${TOKEN}` placeholders into the stream at apply time. CI
# validated the stream WITHOUT that step, so a token in a typed field reached the
# schema as a literal string: `suspend: ${ASK_SCHEDULE_SUSPEND}` is a string where
# CronJob.spec.suspend must be a boolean. Every change touching deploy/ failed
# "Render and schema-check every k8s target" from the day those tokens landed.
#
# WHAT IS SUBSTITUTED. Exactly the tokens the deploy scripts substitute
# (test/deploy-contracts render-for-schema-check-contract holds this list to
# theirs). Nothing else: `${NS}`, `${SUFFIX}`, `${HOSTNAME}`, … inside manifests
# are shell variables of scripts embedded in ConfigMaps/Jobs, expanded at RUN
# time inside the pod, and must reach the cluster verbatim.
#
# The values are realistic, not real: valid cron expressions, a boolean, a CIDR,
# an ARN shape — what the schema needs to see, never anything secret.
set -euo pipefail

target="${1:?usage: render-for-schema-check.sh <deploy/target-dir>}"

kubectl kustomize "$target/k8s" | sed \
  -e 's|[$]{ASK_SCHEDULE_UP}|45 7 * * 1-5|g' \
  -e 's|[$]{ASK_SCHEDULE_DOWN}|0 17 * * 1-5|g' \
  -e 's|[$]{ASK_SCHEDULE_SUSPEND}|false|g' \
  -e 's|[$]{BACKUP_SCHEDULE}|0 2 * * *|g' \
  -e 's|[$]{BACKUP_SUSPEND}|true|g' \
  -e 's|[$]{BACKUP_IMAGE_VERSION}|latest|g' \
  -e 's|[$]{BACKUP_IMAGE}|registry.example.com/backup:latest|g' \
  -e 's|: [$]{BACKUP_RETENTION_DAYS}$|: "7"|' \
  -e 's|[$]{BACKUP_RETENTION_DAYS}|7|g' \
  -e 's|[$]{BUILDKIT_MEMORY_LIMIT}|4Gi|g' \
  -e 's|[$]{DOMAIN}|pipeline.example.com|g' \
  -e 's|[$]{PLATFORM_FRONTEND_URL}|https://pipeline.example.com|g' \
  -e 's|[$]{ALB_SCHEME}|internet-facing|g' \
  -e 's|[$]{ACM_CERT_ARN}|arn:aws:acm:us-east-1:000000000000:certificate/00000000-0000-0000-0000-000000000000|g' \
  -e 's|[$]{EFS_FILESYSTEM_ID}|fs-0123456789abcdef0|g' \
  -e 's|[$]{VPC_CIDR}|10.0.0.0/16|g' \
  -e 's|[$]{DNS_CLUSTER_IP}|10.100.0.10|g'
