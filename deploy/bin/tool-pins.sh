#!/usr/bin/env bash
# Copyright 2026 Pipeline Builder Contributors
# SPDX-License-Identifier: Apache-2.0
#
# Version + checksum pins for tools the deploy INSTALLS, in one place, because
# more than one script installs the same tool and a pin that lives in two files
# is a pin that drifts.
#
# SOURCE this file. It is pure data: variable assignments only — no functions,
# no output, no `cd`, no `set`. That matters for provision-docker.sh, which
# needs these values but must NOT inherit common.sh's `cd /tmp` (it mounts the
# caller's $PWD into the container).
#
# Every assignment is `${VAR:-default}` so an operator can override one pin for
# a one-off run without editing the file.
#
# TO BUMP A TOOL: change the version and ALL of its hashes together, from the
# release's own checksum file. A version with a stale hash fails closed
# (fetch_verified / sha256sum -c), which is the point.

# ---- eksctl ----------------------------------------------------------------
# Installed by common.sh `ensure_eksctl` (the eks setup + shutdown scripts) and,
# for linux only, inside the throwaway container provision-docker.sh runs.
# Hashes come from the release's eksctl_checksums.txt.
EKSCTL_VERSION="${EKSCTL_VERSION:-v0.230.0}"
EKSCTL_SHA256_LINUX_AMD64="${EKSCTL_SHA256_LINUX_AMD64:-a2060956f117c3065abafda5c1f681679b9c3716675d70ce4ffff46033b02c35}"
EKSCTL_SHA256_LINUX_ARM64="${EKSCTL_SHA256_LINUX_ARM64:-21afe8a1e38f0e8153a1f27ff7af6b90e309a0411a1438139463dac2f866674d}"
EKSCTL_SHA256_DARWIN_AMD64="${EKSCTL_SHA256_DARWIN_AMD64:-9c169be56572dae079dc1e5e2a6efff83c4cc6fc8507e54d0a6e8f4ef14df312}"
EKSCTL_SHA256_DARWIN_ARM64="${EKSCTL_SHA256_DARWIN_ARM64:-1412b7ea32efab8141c4c7ccdf96690814d659accefdf72e4e6277ea5c87470c}"

# ---- rclone ------------------------------------------------------------------
# Installed by common.sh `ensure_rclone` (deploy/aws/ec2/bin/bootstrap.sh, for
# the optional object-storage mirror in backup.sh/restore.sh). Replaces the
# MinIO `mc` client, which this same mirror used until MinIO Inc. locked down
# every free distribution channel for it in 2025-2026 (dl.min.io's binary
# download now returns 410 Gone). Hashes come from the release's own
# SHA256SUMS, independently re-verified against a fresh download before
# pinning here.
RCLONE_VERSION="${RCLONE_VERSION:-v1.75.1}"
RCLONE_SHA256_LINUX_AMD64="${RCLONE_SHA256_LINUX_AMD64:-982b5aa772841168f8e380f139e9e787b2a105403e32b94da8676a0e1c0a13ab}"
RCLONE_SHA256_LINUX_ARM64="${RCLONE_SHA256_LINUX_ARM64:-03f2504174034b6d004152ed7369251c9a9ec1f7e0836eda420f5c7a5ec0dff9}"
RCLONE_SHA256_DARWIN_AMD64="${RCLONE_SHA256_DARWIN_AMD64:-29253d0288b8fbbac46baad6e5f6add6cb01d462c79f10805bbd4631c4cdf82c}"
RCLONE_SHA256_DARWIN_ARM64="${RCLONE_SHA256_DARWIN_ARM64:-c61d7a371c62bcbbe882c3423aa4b8bf63485c248dd0f692997b8f0c3f6d0c6f}"
