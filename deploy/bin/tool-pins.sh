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
