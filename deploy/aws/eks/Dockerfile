# =============================================================================
# EKS deploy toolbox — eksctl + AWS CLI + kubectl in ONE image
# =============================================================================
# Run bin/setup.sh (or bin/shutdown.sh) INSIDE this image and every tool the
# deploy needs is present in a single container — no host installs, and no
# "could not find authenticator command: aws" warning (that warning comes from
# the official eksctl image, which bundles eksctl only). aws + kubectl + eksctl
# all run in the same place, so the kubeconfig's `aws eks get-token` exec-auth
# resolves and `setup.sh`'s eksctl() wrapper uses the binary (no nested docker).
#
# Build (from the repo root):
#   docker build -t pb-eks-tools deploy/aws/eks
#
# Deploy (mounts the repo + your AWS creds + kubeconfig; forwards creds env):
#   docker run --rm -it \
#     -v "$PWD":/work -w /work \
#     -v "$HOME/.aws":/root/.aws -v "$HOME/.kube":/root/.kube \
#     -e AWS_PROFILE -e AWS_REGION -e AWS_DEFAULT_REGION \
#     -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_SESSION_TOKEN \
#     pb-eks-tools \
#     bash deploy/aws/eks/bin/setup.sh --domain pipeline-builder.com \
#       --hosted-zone-id Z123 --region us-east-1
#
# Teardown is the same with bin/shutdown.sh. (provision-docker.sh installs the
# same toolset at runtime if you'd rather not build/keep an image.)
# =============================================================================
FROM amazon/aws-cli:2

# aws is already here. Add the rest: openssl (registry keypair), gettext→envsubst
# (cluster.yaml + manifest token expansion), tar/gzip (extract eksctl), git + bash.
RUN dnf install -y tar gzip openssl gettext bash git findutils \
 && dnf clean all && rm -rf /var/cache/dnf

# eksctl (cluster create/delete) + kubectl (apply manifests) — latest, arch-aware.
RUN set -eux; \
    case "$(uname -m)" in \
      x86_64)  arch=amd64 ;; \
      aarch64) arch=arm64 ;; \
      *) echo "unsupported arch: $(uname -m)" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/eksctl-io/eksctl/releases/latest/download/eksctl_Linux_${arch}.tar.gz" \
      | tar -xz -C /usr/local/bin eksctl; \
    curl -fsSL "https://dl.k8s.io/release/$(curl -fsSL https://dl.k8s.io/release/stable.txt)/bin/linux/${arch}/kubectl" \
      -o /usr/local/bin/kubectl; \
    chmod +x /usr/local/bin/kubectl; \
    eksctl version && kubectl version --client=true && aws --version

# amazon/aws-cli sets ENTRYPOINT ["/usr/local/bin/aws"] — clear it so the image
# is a general toolbox (the run command above invokes bash setup.sh directly).
ENTRYPOINT []
WORKDIR /work
