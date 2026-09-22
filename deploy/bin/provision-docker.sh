#!/usr/bin/env bash
set -euo pipefail

# Run `pipeline-manager infra provision` inside an EPHEMERAL stock `node:24-slim`
# container, installing ONLY the tools the chosen target needs. No custom image
# to build or publish — the host's footprint stays just Docker (+ AWS creds for
# ec2/eks). Everything after the flags is passed straight to `infra provision`.
#
# Usage (args are forwarded verbatim to `pipeline-manager infra provision`):
#   deploy/bin/provision-docker.sh --target eks --repo --domain x.example.com \
#       --hosted-zone-id Z123 --execute --yes --admin-email a@x.com --admin-password "$PW"
#   deploy/bin/provision-docker.sh --target docker --repo --with-plugins --execute --yes
#
# Per-target install fingerprint (installed in the throwaway container, not the
# host) — this MUST cover every prerequisite `infra provision` checks for the target,
# or infra provision would block inside the container the same way it does on a bare host.
#   ec2           : git, curl, unzip, AWS CLI v2                       (mounts ~/.aws ro)
#   eks           : ec2 set + openssl + envsubst + eksctl + kubectl              (mounts ~/.aws + ~/.kube ro)
#   docker        : git, yq, openssl — Docker + Docker Compose are EXTERNAL (Docker
#                   Desktop provides both); reached via the mounted socket + host docker CLI.
#   minikube      : host-side cluster — run on the host instead.

CLI_PKG="@pipeline-builder/pipeline-manager@latest"
IMAGE="node:24-slim"
# The kubectl MINOR to install for --target eks. It is deliberately the version
# of the cluster this run is about to create, not upstream's newest: keep it in
# step with EKS_VERSION in deploy/aws/eks/bin/setup.sh. See the eks case below
# for why the patch level is resolved at download time instead of pinned.
EKS_VERSION="${EKS_VERSION:-1.36}"

# Discover --target/-t among the forwarded args (to pick minimal installs + mounts).
TARGET=""
prev=""
for a in "$@"; do
  case "$prev" in -t|--target) TARGET="$a" ;; esac
  # Also accept the `--target=eks` / `-t=eks` equals form (argparse-style).
  case "$a" in --target=*|-t=*) TARGET="${a#*=}" ;; esac
  prev="$a"
done

# Mount the workdir at the SAME path inside the container so docker-compose bind
# mounts (deploy/local/docker/data, certs) resolve identically on the shared host daemon.
mounts=( -v "$PWD:$PWD" -w "$PWD" )
# git is required by EVERY target (the `--repo` sparse clone); node:24-slim ships
# git 2.39, which clears the >=2.27 floor for cone sparse-checkout. curl/TLS roots
# are needed for the per-target downloads below.
apt="git ca-certificates curl"
extra=""                         # non-apt installs (AWS CLI / yq), run via eval

case "$TARGET" in
  ec2)
    apt="$apt unzip"
    extra='curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m).zip" -o /tmp/a.zip && unzip -q /tmp/a.zip -d /tmp && /tmp/aws/install && rm -rf /tmp/a.zip /tmp/aws'
    [ -d "$HOME/.aws" ] && mounts+=( -v "$HOME/.aws:/root/.aws:ro" )
    ;;
  eks)
    apt="$apt unzip openssl gettext-base"
    # eks setup.sh needs aws (deploy), eksctl (create the Auto Mode cluster), kubectl
    # (apply manifests), openssl (registry token keypair) and envsubst/gettext-base
    # (cluster.yaml + manifest token expansion). Mount ~/.aws + ~/.kube.
    # eksctl: pinned VERSION + SHA-256 (keep in step with EKSCTL_VERSION in
    # deploy/bin/common.sh).
    #
    # kubectl: resolved from the MINOR-scoped channel (dl.k8s.io/release/
    # stable-<EKS_VERSION>.txt), not `stable.txt`, and verified against the
    # .sha256 dl.k8s.io publishes beside the binary. This is deliberately not a
    # constant SHA like eksctl's, and it is no longer upstream's newest either:
    #   - a hard-pinned kubectl goes stale against a cluster whose version this
    #     script does not control, and the .sha256 already gives integrity, so
    #     a static hash would buy reproducibility at the cost of correctness;
    #   - `stable.txt` is upstream's latest (v1.37 today) while the cluster we
    #     are about to create is EKS_VERSION (1.36). That happens to be inside
    #     kubectl's +/-1 minor skew window right now and silently leaves it the
    #     moment upstream ships 1.38 — a floating version that breaks on a date
    #     nobody chose.
    # `stable-<minor>.txt` keeps the MINOR reproducible (it is pinned, here and
    # in eks/bin/setup.sh) while still picking up patch/CVE fixes, and it can
    # never skew from the cluster. `--eks-version latest` has no fixed minor, so
    # it falls back to `stable`.
    _kchan="stable-${EKS_VERSION}"
    [ "$EKS_VERSION" = latest ] && _kchan="stable"
    extra='curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m).zip" -o /tmp/a.zip && unzip -q /tmp/a.zip -d /tmp && /tmp/aws/install && rm -rf /tmp/a.zip /tmp/aws && a=$(dpkg --print-architecture) && case $a in amd64) s=a2060956f117c3065abafda5c1f681679b9c3716675d70ce4ffff46033b02c35 ;; arm64) s=21afe8a1e38f0e8153a1f27ff7af6b90e309a0411a1438139463dac2f866674d ;; *) echo "no pinned eksctl for $a" >&2; exit 1 ;; esac && curl -fsSL -o /tmp/eksctl.tgz "https://github.com/eksctl-io/eksctl/releases/download/v0.230.0/eksctl_Linux_${a}.tar.gz" && echo "$s  /tmp/eksctl.tgz" | sha256sum -c - && tar -xzf /tmp/eksctl.tgz -C /usr/local/bin eksctl && rm -f /tmp/eksctl.tgz && k=$(curl -fsSL "https://dl.k8s.io/release/'"$_kchan"'.txt") && curl -fsSL -o /usr/local/bin/kubectl "https://dl.k8s.io/release/${k}/bin/linux/${a}/kubectl" && echo "$(curl -fsSL "https://dl.k8s.io/release/${k}/bin/linux/${a}/kubectl.sha256")  /usr/local/bin/kubectl" | sha256sum -c - && chmod 0755 /usr/local/bin/kubectl'
    [ -d "$HOME/.aws" ] && mounts+=( -v "$HOME/.aws:/root/.aws:ro" )
    [ -d "$HOME/.kube" ] && mounts+=( -v "$HOME/.kube:/root/.kube:ro" )
    ;;
  docker)
    # Docker + Docker Compose are EXTERNAL (host) requirements — NOT installed in
    # the slim image (you already have Docker on the host; that's what runs this
    # container). The container reaches the host's Docker via the mounted socket +
    # the host's docker CLI and compose plugin. yq + openssl ARE added: setup.sh
    # needs yq (plugin/config generation) and openssl (the self-signed TLS cert +
    # the registry JWT key — mkcert isn't in the container, so it always falls back
    # to openssl). (Linux host: the CLI mount works as-is. macOS: the Docker Desktop
    # CLI is a mac binary that can't run in a Linux container — run local on the host.)
    apt="$apt openssl"
    # yq: pinned VERSION + SHA-256 (same pin as deploy/aws/ec2/bin/bootstrap.sh).
    extra='a=$(dpkg --print-architecture) && case $a in amd64) s=654d2943ca1d3be2024089eb4f270f4070f491a0610481d128509b2834870049 ;; arm64) s=ceea73d4c86f2e5c91926ee0639157121f5360da42beeb8357783d79c2cc6a1d ;; *) echo "no pinned yq for $a" >&2; exit 1 ;; esac && curl -fsSL -o /usr/local/bin/yq "https://github.com/mikefarah/yq/releases/download/v4.45.1/yq_linux_${a}" && echo "$s  /usr/local/bin/yq" | sha256sum -c - && chmod 0755 /usr/local/bin/yq'
    mounts+=( -v /var/run/docker.sock:/var/run/docker.sock --network host )
    docker_bin="$(command -v docker || true)"
    [ -n "$docker_bin" ] && mounts+=( -v "$docker_bin:/usr/bin/docker:ro" )
    [ -d "$HOME/.docker/cli-plugins" ] && mounts+=( -v "$HOME/.docker/cli-plugins:/root/.docker/cli-plugins:ro" )
    ;;
  minikube)
    echo "minikube runs a host-side cluster; run infra provision directly on the host (with minikube + kubectl)." >&2
    exit 1 ;;
  "")
    echo "Pass --target <docker|ec2|eks> so the right minimal tools are installed." >&2
    exit 1 ;;
  *)
    # Without this the unknown target fell through with no tools and no credential
    # mounts, and only failed much later inside the container.
    echo "Unknown --target '$TARGET' (expected docker|ec2|eks; minikube runs on the host)." >&2
    exit 1 ;;
esac

# `-t` only when stdin is a terminal: `docker run -it` fails outright with "the
# input device is not a TTY" under CI/cron, which is exactly how the documented
# non-interactive form (`--execute --yes`) is run. `-i` stays either way so the
# CLI can still read stdin.
tty_flags=( -i )
[ -t 0 ] && tty_flags+=( -t )

# Install the minimal toolset in the throwaway container, then exec the published
# CLI. Args are passed positionally (after the `_`) so quoting is preserved.
exec docker run --rm "${tty_flags[@]}" "${mounts[@]}" \
  -e CLI_PKG="$CLI_PKG" -e APT="$apt" -e EXTRA="$extra" \
  "$IMAGE" bash -c '
    set -e
    apt-get update -qq && apt-get install -y -qq --no-install-recommends $APT >/dev/null
    [ -n "$EXTRA" ] && eval "$EXTRA"
    exec npx -y "$CLI_PKG" infra provision "$@"
  ' _ "$@"
