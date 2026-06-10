#!/usr/bin/env bash
set -euo pipefail

# Run `pipeline-manager provision` inside an EPHEMERAL stock `node:24-slim`
# container, installing ONLY the tools the chosen target needs. No custom image
# to build or publish — the host's footprint stays just Docker (+ AWS creds for
# ec2/fargate). Everything after the flags is passed straight to `provision`.
#
# Usage (args are forwarded verbatim to `pipeline-manager provision`):
#   deploy/bin/provision-docker.sh --target fargate --repo --domain x.example.com \
#       --hosted-zone-id Z123 --execute --yes --admin-email a@x.com --admin-password "$PW"
#   deploy/bin/provision-docker.sh --target local --repo --with-plugins --execute --yes
#
# Per-target install fingerprint (installed in the throwaway container, not the host):
#   ec2 | fargate : git, curl, unzip, AWS CLI v2        (mounts ~/.aws ro)
#   local         : git, yq, docker CLI                 (shares the host docker daemon)
#   minikube      : host-side cluster — run on the host instead.

CLI_PKG="@pipeline-builder/pipeline-manager@latest"
IMAGE="node:24-slim"

# Discover --target/-t among the forwarded args (to pick minimal installs + mounts).
TARGET=""
prev=""
for a in "$@"; do
  case "$prev" in -t|--target) TARGET="$a" ;; esac
  prev="$a"
done

# Mount the workdir at the SAME path inside the container so docker-compose bind
# mounts (deploy/local/data, certs) resolve identically on the shared host daemon.
mounts=( -v "$PWD:$PWD" -w "$PWD" )
# git is required by EVERY target (the `--repo` sparse clone); node:24-slim ships
# git 2.39, which clears the >=2.27 floor for cone sparse-checkout. curl/TLS roots
# are needed for the per-target downloads below.
apt="git ca-certificates curl"
extra=""                         # non-apt installs (AWS CLI / yq), run via eval

case "$TARGET" in
  ec2|fargate)
    apt="$apt unzip"
    extra='curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m).zip" -o /tmp/a.zip && unzip -q /tmp/a.zip -d /tmp && /tmp/aws/install && rm -rf /tmp/a.zip /tmp/aws'
    [ -d "$HOME/.aws" ] && mounts+=( -v "$HOME/.aws:/root/.aws:ro" )
    ;;
  local)
    apt="$apt docker.io"
    extra='curl -fsSL "https://github.com/mikefarah/yq/releases/latest/download/yq_linux_$(dpkg --print-architecture)" -o /usr/local/bin/yq && chmod +x /usr/local/bin/yq'
    mounts+=( -v /var/run/docker.sock:/var/run/docker.sock --network host )
    ;;
  minikube)
    echo "minikube runs a host-side cluster; run provision directly on the host (with minikube + kubectl)." >&2
    exit 1 ;;
  "")
    echo "Pass --target <local|ec2|fargate> so the right minimal tools are installed." >&2
    exit 1 ;;
esac

# Install the minimal toolset in the throwaway container, then exec the published
# CLI. Args are passed positionally (after the `_`) so quoting is preserved.
exec docker run --rm -it "${mounts[@]}" \
  -e CLI_PKG="$CLI_PKG" -e APT="$apt" -e EXTRA="$extra" \
  "$IMAGE" bash -c '
    set -e
    apt-get update -qq && apt-get install -y -qq --no-install-recommends $APT >/dev/null
    [ -n "$EXTRA" ] && eval "$EXTRA"
    exec npx -y "$CLI_PKG" provision "$@"
  ' _ "$@"
