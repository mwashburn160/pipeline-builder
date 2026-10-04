#!/usr/bin/env bash
# Copyright 2026 Pipeline Builder Contributors
# SPDX-License-Identifier: Apache-2.0

# =============================================================================
# Pipeline Builder — EKS startup (re-apply config + workloads)
# =============================================================================
# Re-runs setup.sh phases 4-8 against an EXISTING cluster: secrets and
# ConfigMaps, SES/Pod-Identity IAM, KEDA + metrics-server + Istio, the workload
# manifests, and the Route 53 alias. It does NOT touch the cluster itself, the
# EFS filesystem or the ACM certificate — phases 1-3, the ~25 minutes of this
# deploy, which change rarely.
#
# This is the script to run after a config change, a new image tag or an edited
# manifest. It takes ~2 minutes instead of ~25.
#
# eks was the only target without a startup.sh:
#   aws/ec2         setup.sh  startup.sh  shutdown.sh
#   local/minikube  setup.sh  startup.sh  shutdown.sh
#   aws/eks         setup.sh  ←missing→   shutdown.sh
#
# The semantics differ slightly from minikube's, which RESUMES a stopped VM and
# deliberately does not re-apply manifests. An EKS cluster is never stopped, so
# the useful "startup" here is re-applying what a deploy actually changes —
# closer to ec2's startup.sh, which also brings workloads up on a running box.
#
# Safe to run repeatedly. Every phase it covers is written to be re-runnable:
#   * .env is generated ONCE (phase 4 guards on the file existing — regenerating
#     would rotate the DB passwords out from under the Retain'd pb-ebs volumes),
#     and key sync is strictly additive;
#   * secrets and ConfigMaps are rendered with `--dry-run=client` and applied;
#   * the phase 5 AWS calls each look the resource up before creating it;
#   * workloads are a kustomize apply, and the Route 53 change is an UPSERT.
#
# It does NOT run phase 9 (init-platform) or phase 10 (the smoke checks). Those
# are already separate scripts and are deliberately not implied by re-applying
# config:
#   deploy/bin/init-platform.sh eks          # admin user, plugins, templates
#   deploy/bin/post-provision-smoke.sh k8s --aws
#
# Every setup.sh flag is accepted and forwarded unchanged (--domain, --region,
# --cluster-name, --hosted-zone-id, …), because phases 4-8 need them: the domain
# goes into the manifests, the region into SES. Pass the same ones you passed to
# setup.sh. Values phases 1-3 would have computed (VPC, EFS id, certificate ARN)
# are looked up from AWS instead, and the run fails loudly if any is missing
# rather than rendering an empty string into a manifest.
#
# To re-run a narrower slice, call setup.sh directly:
#   bin/setup.sh --only-phase 7 --domain …      # just re-apply the workloads
#   bin/setup.sh --from-phase 6 --domain …      # operators + workloads + DNS
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

exec bash "$SCRIPT_DIR/setup.sh" --from-phase 4 --to-phase 8 "$@"
