#!/usr/bin/env bash
set -euo pipefail
# =============================================================================
# Run the EKS deploy in a container that has eksctl + AWS CLI + kubectl
# =============================================================================
# Builds the deploy/aws/eks/Dockerfile (eksctl + aws + kubectl + openssl +
# envsubst) and runs bin/setup.sh INSIDE it — so NO tools are needed on the host
# and the dockerized-eksctl "could not find authenticator command: aws" warning
# never happens (aws, kubectl and eksctl all live in the one container). Every
# argument is forwarded straight to setup.sh.
#
#   deploy/aws/eks/bin/deploy-docker.sh --domain pipeline-builder.com \
#       --hosted-zone-id Z123 --region us-east-1 --ghcr-token ghp_xxx
#
# Tear down instead of deploy:  PB_EKS_SCRIPT=shutdown.sh deploy/aws/eks/bin/deploy-docker.sh --yes
# Override the image tag:        PB_EKS_IMAGE=my-tag ...
# Only the host requirement is Docker (+ AWS creds in ~/.aws or the env).
# =============================================================================
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EKS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"             # deploy/aws/eks (Dockerfile lives here)
REPO_ROOT="$(cd "$EKS_DIR/../../.." && pwd)"        # repo root (bind-mounted so script paths resolve)
IMAGE="${PB_EKS_IMAGE:-pb-eks-tools}"
SCRIPT="${PB_EKS_SCRIPT:-setup.sh}"                 # setup.sh (default) | shutdown.sh

command -v docker >/dev/null 2>&1 || { echo "ERROR: Docker is required (it runs the toolbox image)." >&2; exit 1; }

echo "=== Building $IMAGE (eksctl + aws + kubectl + openssl + envsubst) ==="
docker build -t "$IMAGE" "$EKS_DIR"

# ~/.aws (creds) is read; ~/.kube is written by `aws eks update-kubeconfig`. Mount the
# repo at the SAME absolute path so the .env setup.sh generates persists on the host.
mkdir -p "$HOME/.kube" "$HOME/.aws"
echo "=== Running deploy/aws/eks/bin/$SCRIPT in $IMAGE ==="
exec docker run --rm -it \
  -v "$REPO_ROOT":"$REPO_ROOT" -w "$REPO_ROOT" \
  -v "$HOME/.aws:/root/.aws" -v "$HOME/.kube:/root/.kube" \
  -e AWS_PROFILE -e AWS_REGION -e AWS_DEFAULT_REGION \
  -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_SESSION_TOKEN \
  -e EKS_VERSION -e GHCR_TOKEN -e GHCR_USER \
  "$IMAGE" bash "deploy/aws/eks/bin/$SCRIPT" "$@"
