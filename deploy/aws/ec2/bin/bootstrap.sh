#!/usr/bin/env bash
# =============================================================================
# Pipeline Builder - EC2 Bootstrap Script
# =============================================================================
# Runs as root on first boot via UserData. Handles:
#   1. System hardening (fail2ban, SSH lockdown, auto-updates)
#   2. Docker, minikube, kubectl installation
#   3. Environment configuration (.env generation)
#   4. iptables HTTP bridge (instance:30080 → minikube NodePort 30080)
#   5. Launch minikube startup
# TLS is terminated at the ALB (ACM cert) — no cert/certbot on this instance.
#
# Expected environment variables (set by CloudFormation UserData):
#   DOMAIN       - Fully qualified domain name
#   GHCR_TOKEN   - GitHub Container Registry token
#   GHCR_USER    - GitHub username (default: mwashburn160)
#   GIT_REPO     - Git repository URL (already cloned)
#   GIT_BRANCH   - Git branch (already checked out)
# =============================================================================
set -euo pipefail

# Ensure running as root
if [ "$(id -u)" != "0" ]; then
  echo "ERROR: bootstrap.sh must be run as root" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
INSTALL_DIR="$(cd "$DEPLOY_DIR/../../.." && pwd)"

DOMAIN="${DOMAIN:-}"
# Note: DEPLOY_MODE (public/private) is enforced at the CloudFormation/ALB
# layer (ALB scheme + subnets), not on the instance — the box behaves
# identically in both modes (plain-HTTP nginx behind the ALB), so it is not
# read here.
GHCR_TOKEN="${GHCR_TOKEN:-}"
GHCR_USER="${GHCR_USER:-mwashburn160}"

# Persistent-storage layout. PIPELINE_ROOT is the EBS mount (or a fallback
# root-volume dir when EBS is unavailable; see UserData in template.yaml).
# All runtime state lives under $PIPELINE_DATA_DIR; the .ephemeral sentinel
# at $PIPELINE_ROOT signals fallback mode to anything that checks it.
PIPELINE_ROOT="${PIPELINE_ROOT:-/opt/pipeline}"
PIPELINE_DATA_DIR="$PIPELINE_ROOT/pipeline-data"
mkdir -p "$PIPELINE_DATA_DIR"
if [ -f "$PIPELINE_ROOT/.ephemeral" ]; then
  echo "  NOTE: running on ephemeral storage ($PIPELINE_ROOT not EBS-backed)" >&2
fi

echo ""
echo "========================================"
echo "Phase 1: System Update"
echo "========================================"
dnf update -y

# =============================================================================
# Phase 2: System Hardening
# =============================================================================
echo ""
echo "========================================"
echo "Phase 2: System Hardening"
echo "========================================"

# --- fail2ban ---
echo "  Installing fail2ban..."
dnf install -y fail2ban
cat > /etc/fail2ban/jail.local << 'FAIL2BAN'
[DEFAULT]
bantime = 3600
findtime = 600
maxretry = 3

[sshd]
enabled = true
port = ssh
filter = sshd
logpath = /var/log/secure
maxretry = 3
bantime = 3600
FAIL2BAN
systemctl enable fail2ban
systemctl start fail2ban
echo "  fail2ban configured (SSH: 3 retries, 1hr ban)"

# --- SSH hardening ---
echo "  Hardening SSH..."
sed -i 's/#PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/#PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sed -i 's/PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
systemctl restart sshd
echo "  SSH: password auth disabled, root login disabled"

# --- Automatic security updates ---
echo "  Enabling automatic security updates..."
dnf install -y dnf-automatic
sed -i 's/apply_updates = no/apply_updates = yes/' /etc/dnf/automatic.conf
systemctl enable --now dnf-automatic-install.timer
echo "  dnf-automatic enabled"

# =============================================================================
# Phase 3: Install Docker
# =============================================================================
echo ""
echo "========================================"
echo "Phase 3: Install Docker"
echo "========================================"
dnf install -y docker

# Move Docker storage to the persistent volume to prevent root-disk exhaustion
# (prebuilt plugin images are large). Falls back to the root volume when
# $PIPELINE_ROOT is in ephemeral mode — services still start, but image
# storage doesn't survive instance replacement.
DOCKER_DATA_ROOT="$PIPELINE_DATA_DIR/docker"
if mountpoint -q "$PIPELINE_ROOT" 2>/dev/null; then
  mkdir -p "$DOCKER_DATA_ROOT"
  mkdir -p /etc/docker
  cat > /etc/docker/daemon.json <<DAEMONJSON
{
  "data-root": "$DOCKER_DATA_ROOT"
}
DAEMONJSON
  echo "  Docker data-root: $DOCKER_DATA_ROOT"
else
  echo "  WARNING: $PIPELINE_ROOT is not a mountpoint — Docker using root volume (/var/lib/docker)" >&2
  echo "  Prebuilt plugin images may exhaust root disk on a long-lived instance." >&2
fi

systemctl enable docker
systemctl start docker
echo "  Docker installed and running"

# =============================================================================
# Phase 4: Install minikube & kubectl
# =============================================================================
echo ""
echo "========================================"
echo "Phase 4: Install minikube & kubectl"
echo "========================================"

# kubectl
echo "  Installing kubectl..."
KUBECTL_VERSION=$(curl -L -s https://dl.k8s.io/release/stable.txt)
curl -LO "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl"
install -o root -g root -m 0755 kubectl /usr/local/bin/kubectl
rm -f kubectl
echo "  kubectl ${KUBECTL_VERSION} installed"

# minikube
echo "  Installing minikube..."
curl -LO https://storage.googleapis.com/minikube/releases/latest/minikube-linux-amd64
install minikube-linux-amd64 /usr/local/bin/minikube
rm -f minikube-linux-amd64
echo "  minikube installed"

# conntrack + socat (required by minikube)
dnf install -y conntrack-tools socat

# yq — required by build-plugin-images.sh and generate-plugins.sh.
# Distro repos may have an old python-yq; install mikefarah's Go binary
# directly to /usr/local/bin so the version matches what plugin scripts expect.
echo "  Installing yq..."
YQ_VERSION="v4.45.1"
ARCH=$(uname -m)
case "$ARCH" in
  x86_64)  YQ_ARCH=amd64 ;;
  aarch64) YQ_ARCH=arm64 ;;
  *) echo "  WARNING: unknown arch $ARCH, defaulting to amd64"; YQ_ARCH=amd64 ;;
esac
curl -fsSL "https://github.com/mikefarah/yq/releases/download/${YQ_VERSION}/yq_linux_${YQ_ARCH}" \
  -o /usr/local/bin/yq
chmod +x /usr/local/bin/yq
echo "  yq $(/usr/local/bin/yq --version)"

# =============================================================================
# Phase 5: TLS — handled by the ALB, NOT this instance
# =============================================================================
# The ALB terminates TLS with an ACM cert (DNS-validated, auto-rotated, issued
# by CloudFormation). There is no certbot / Let's Encrypt / renewal cron / cert
# on this box — nginx serves plain HTTP on its NodePort and the ALB forwards to
# it. Nothing to do here.
echo ""
echo "Phase 5: TLS terminated at the ALB (ACM) — no on-instance cert"

# =============================================================================
# Phase 6: Create minikube user
# =============================================================================
echo ""
echo "========================================"
echo "Phase 6: Create minikube user"
echo "========================================"
if ! id minikube &>/dev/null; then
  useradd -m -s /bin/bash -G docker minikube
  echo "  User 'minikube' created (docker group)"
else
  echo "  User 'minikube' already exists"
fi
# Ensure minikube user is in the docker group (idempotent — handles upgrades)
usermod -aG docker minikube
echo "  Ensured 'minikube' is in docker group"

# The interactive operator (typically ec2-user on Amazon Linux) also needs
# docker group membership so they can run build-plugin-images.sh and other
# scripts that talk to the host docker daemon without sudo. SUDO_USER is
# set when bootstrap is invoked via `sudo`; fall back to ec2-user (the AMI
# default) when bootstrap runs unattended at first boot.
OPERATOR_USER="${SUDO_USER:-ec2-user}"
if id "$OPERATOR_USER" &>/dev/null && [ "$OPERATOR_USER" != "root" ]; then
  usermod -aG docker "$OPERATOR_USER"
  echo "  Ensured '$OPERATOR_USER' is in docker group"
  echo "  NOTE: $OPERATOR_USER must log out and back in (or run 'newgrp docker') for the group to take effect"
fi

# Hand ownership of the persistent root to the minikube user so it can
# create subdirs without sudo. Whether $PIPELINE_ROOT is the EBS mount or
# the fallback dir, both code paths land here.
chown minikube:minikube "$PIPELINE_ROOT" "$PIPELINE_DATA_DIR"
# Hand the entire git checkout to the operator. UserData clones as root, so
# without this every script that writes under the tree (load-plugin-worker.sh
# creates plugin.zip, build-plugin-images.sh writes image.tar, etc.) hits
# EACCES. One recursive chown covers them all instead of cataloguing each
# write site. Takes a few seconds on a fresh tree.
chown -R minikube:minikube "$INSTALL_DIR"

# Plugin build artifacts. Lives on the persistent volume; previously this
# was a symlink from $INSTALL_DIR/deploy/plugins to a path on /mnt/data,
# but with $INSTALL_DIR itself now living on the EBS volume the symlink is
# redundant — point consumers at PLUGIN_ARTIFACTS_DIR via env instead.
PLUGIN_ARTIFACTS_DIR="$PIPELINE_DATA_DIR/plugin-artifacts"
mkdir -p "$PLUGIN_ARTIFACTS_DIR"
chown -R minikube:minikube "$PLUGIN_ARTIFACTS_DIR"
echo "  Plugin artifacts: $PLUGIN_ARTIFACTS_DIR"

# Plugin working directories (hostPath mounts for K8s plugin pod).
# UID 1000 matches the plugin container's user inside minikube.
mkdir -p "$PIPELINE_DATA_DIR"/plugins-data/{builds,uploads}
chown -R 1000:1000 "$PIPELINE_DATA_DIR/plugins-data"
echo "  Plugin working dirs: $PIPELINE_DATA_DIR/plugins-data/{builds,uploads}"

# (No gateway TLS material on the instance — the ALB terminates TLS with ACM.)

# =============================================================================
# Phase 7: Generate .env from template
# =============================================================================
echo ""
echo "========================================"
echo "Phase 7: Generate .env configuration"
echo "========================================"
cd "$DEPLOY_DIR"

cp .env.example .env

# Generate secrets — strip base64 special chars (+/=) to avoid sed delimiter conflicts
JWT_SECRET=$(openssl rand -base64 32 | tr -d '=+/')
REFRESH_SECRET=$(openssl rand -base64 32 | tr -d '=+/')
PG_PASSWORD=$(openssl rand -base64 24 | tr -d '=+/')
MONGO_PASSWORD=$(openssl rand -base64 24 | tr -d '=+/')
ME_PASSWORD=$(openssl rand -base64 16 | tr -d '=+/')
PGADMIN_PASSWORD=$(openssl rand -base64 16 | tr -d '=+/')
REGISTRY_TOKEN=$(openssl rand -base64 24 | tr -d '=+/')

# Replace domain placeholder. A domain is always set now (the ALB needs an
# ACM cert for it), so there's no IP fallback.
sed -i "s|YOUR_DOMAIN_HERE|${DOMAIN}|g" .env

# Replace CHANGE_ME secrets
sed -i "s|JWT_SECRET=CHANGE_ME_generate_with_openssl_rand_base64_32|JWT_SECRET=${JWT_SECRET}|" .env
sed -i "s|REFRESH_TOKEN_SECRET=CHANGE_ME_generate_with_openssl_rand_base64_32|REFRESH_TOKEN_SECRET=${REFRESH_SECRET}|" .env

# PostgreSQL passwords
sed -i "s|POSTGRES_PASSWORD=CHANGE_ME|POSTGRES_PASSWORD=${PG_PASSWORD}|" .env
sed -i "s|DB_PASSWORD=CHANGE_ME|DB_PASSWORD=${PG_PASSWORD}|" .env

# MongoDB passwords
sed -i "s|MONGO_INITDB_ROOT_PASSWORD=CHANGE_ME|MONGO_INITDB_ROOT_PASSWORD=${MONGO_PASSWORD}|" .env
sed -i "s|mongodb://mongo:CHANGE_ME@|mongodb://mongo:${MONGO_PASSWORD}@|g" .env
sed -i "s|ME_CONFIG_MONGODB_ADMINPASSWORD=CHANGE_ME|ME_CONFIG_MONGODB_ADMINPASSWORD=${MONGO_PASSWORD}|" .env

# Admin UI passwords
sed -i "s|ME_CONFIG_BASICAUTH_PASSWORD=CHANGE_ME|ME_CONFIG_BASICAUTH_PASSWORD=${ME_PASSWORD}|" .env
sed -i "s|PGADMIN_DEFAULT_PASSWORD=CHANGE_ME|PGADMIN_DEFAULT_PASSWORD=${PGADMIN_PASSWORD}|" .env

# Registry token
sed -i "s|IMAGE_REGISTRY_TOKEN=CHANGE_ME|IMAGE_REGISTRY_TOKEN=${REGISTRY_TOKEN}|" .env

# Inject GHCR credentials
sed -i "s|GHCR_TOKEN=|GHCR_TOKEN=${GHCR_TOKEN}|" .env
sed -i "s|GHCR_USER=mwashburn160|GHCR_USER=${GHCR_USER}|" .env

echo "  .env generated with auto-generated secrets"
echo "  Domain: ${DOMAIN}"

# =============================================================================
# Phase 8: Setup iptables port forwarding
# =============================================================================
echo ""
echo "========================================"
echo "Phase 8: iptables port forwarding"
echo "========================================"

# Enable IP forwarding
echo "net.ipv4.ip_forward = 1" > /etc/sysctl.d/99-pipeline-builder.conf
sysctl -p /etc/sysctl.d/99-pipeline-builder.conf

# Note: iptables DNAT rules are set AFTER minikube starts (in startup.sh)
# because we need the minikube IP address first.
echo "  IP forwarding enabled (iptables rules set after minikube starts)"

# =============================================================================
# Phase 9: Launch startup.sh as minikube user
# =============================================================================
echo ""
echo "========================================"
echo "Phase 9: Launch minikube startup"
echo "========================================"

# startup.sh now handles root-vs-minikube user internally via run_as_mk,
# and sets up iptables when run as root, so we can call it directly.
export DOMAIN
export GHCR_TOKEN
export GHCR_USER

bash "${DEPLOY_DIR}/bin/startup.sh"

# Ensure iptables-services is installed for persistence across reboots
dnf install -y iptables-services 2>/dev/null || true
systemctl enable iptables 2>/dev/null || true

echo ""
echo "========================================"
echo "Bootstrap Complete"
echo "========================================"
echo "  Application URL: https://${DOMAIN}  (via the ALB; TLS at the ALB)"
echo "  Access: aws ssm start-session --target <this-instance-id>"
echo "  Logs: /var/log/user-data.log"
echo "  Pods: sudo -u minikube kubectl get pods -n pipeline-builder"
