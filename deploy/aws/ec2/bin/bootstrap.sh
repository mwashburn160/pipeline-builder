#!/usr/bin/env bash
# =============================================================================
# Pipeline Builder - EC2 Bootstrap Script
# =============================================================================
# Runs as root on first boot via UserData. Handles:
#   1. System hardening (fail2ban, SSH lockdown, auto-updates)
#   2. Docker, minikube, kubectl installation
#   3. Let's Encrypt certificate provisioning
#   4. Environment configuration (.env generation)
#   5. iptables port forwarding (443→30443, 80→30080)
#   6. Launch minikube startup
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
# Deployment posture: "public" (public ingress; Let's Encrypt via HTTP-01) or
# "internal" (inside-AWS-only; no public :80, so Let's Encrypt via DNS-01 over
# Route53). The cert is publicly trusted either way — required for AWS
# CodeBuild to pull plugin images over the gateway. See docs/aws-deployment.md.
# Defaults to "internal" (inside-AWS-only); export DEPLOY_MODE=public to open ingress.
DEPLOY_MODE="${DEPLOY_MODE:-internal}"
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
# Phase 5: TLS Certificate
# =============================================================================
echo ""
echo "========================================"
echo "Phase 5: TLS Certificate"
echo "========================================"

TLS_CERT_DIR="/etc/pipeline-builder/tls"
mkdir -p "$TLS_CERT_DIR"

if [ -n "$DOMAIN" ]; then
  # --- Let's Encrypt (domain provided) ---
  if [ "$DEPLOY_MODE" = "internal" ]; then
    # Inside-AWS-only: no public port 80, so validate via DNS-01 over Route53
    # instead of HTTP-01. Requires the dns-route53 plugin + an instance role
    # with Route53 change permissions on the domain's hosted zone. The cert is
    # still publicly trusted, so AWS CodeBuild can pull plugin images over the
    # gateway even though the endpoint is private.
    dnf install -y certbot python3-certbot-dns-route53
    # Give Route53 time to propagate the TXT challenge before Let's Encrypt
    # validates — the 10s default is often too short for a fresh zone, and a
    # timeout here would silently fall back to a self-signed cert (which
    # CodeBuild plugin pulls then reject).
    CERTBOT_CHALLENGE_ARGS="--dns-route53 --dns-route53-propagation-seconds 30"
  else
    dnf install -y certbot
    CERTBOT_CHALLENGE_ARGS="--standalone --preferred-challenges http"
  fi

  echo "  Obtaining Let's Encrypt certificate for ${DOMAIN} (${DEPLOY_MODE} mode)..."
  # shellcheck disable=SC2086  # intentional word-splitting of challenge args
  if ! certbot certonly $CERTBOT_CHALLENGE_ARGS \
      --non-interactive \
      --agree-tos \
      --email "admin@${DOMAIN}" \
      -d "${DOMAIN}"; then
    echo "  ERROR: certbot failed to obtain certificate for ${DOMAIN}" >&2
    echo "  Common causes: domain not pointing to this instance, port 80 blocked, Let's Encrypt rate limit" >&2
    echo "  Falling back to self-signed certificate" >&2
    # OpenSSL/RFC 6125: IP literals require `IP:` SAN, not `DNS:`. Without
    # this, verify fails when clients connect by IP.
    if printf '%s' "$DOMAIN" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
      SAN="IP:${DOMAIN}"
    else
      SAN="DNS:${DOMAIN}"
    fi
    openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
      -keyout "$TLS_CERT_DIR/tls.key" -out "$TLS_CERT_DIR/tls.crt" \
      -subj "/CN=${DOMAIN}" -addext "subjectAltName=${SAN}"
  else
    # Symlink to standard location
    ln -sf "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" "$TLS_CERT_DIR/tls.crt"
    ln -sf "/etc/letsencrypt/live/${DOMAIN}/privkey.pem" "$TLS_CERT_DIR/tls.key"
    echo "  Certificate obtained: /etc/letsencrypt/live/${DOMAIN}/"
  fi

  # Setup auto-renewal cron
  cat > /etc/cron.d/certbot-renew << CRON
# Certbot auto-renewal - runs daily at 3am
0 3 * * * root certbot renew --quiet --deploy-hook "${DEPLOY_DIR}/bin/update-tls-secret.sh"
CRON
  echo "  Auto-renewal cron configured"
else
  # --- Self-signed certificate (no domain) ---
  # CN=localhost + matching SAN: modern TLS clients (OpenSSL 3+, Go stdlib)
  # reject certs without a SAN entry that matches the connection target.
  # localhost is the only meaningful target when no domain is configured.
  echo "  No domain provided — generating self-signed certificate..."
  openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
    -keyout "$TLS_CERT_DIR/tls.key" \
    -out "$TLS_CERT_DIR/tls.crt" \
    -subj "/CN=localhost/O=pipeline-builder" \
    -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
  echo "  Self-signed certificate generated at ${TLS_CERT_DIR}/"
fi

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

# Allow minikube user to read TLS certs
if [ -n "$DOMAIN" ]; then
  LE_DIR="/etc/letsencrypt/live/${DOMAIN}"
  setfacl -R -m u:minikube:rx /etc/letsencrypt/live/ /etc/letsencrypt/archive/ 2>/dev/null || {
    # Copy certs to a separate dir rather than making LE privkeys world-readable
    cp "$LE_DIR/fullchain.pem" "$TLS_CERT_DIR/fullchain.pem"
    cp "$LE_DIR/privkey.pem" "$TLS_CERT_DIR/privkey.pem"
    chown minikube:minikube "$TLS_CERT_DIR/fullchain.pem" "$TLS_CERT_DIR/privkey.pem"
  }
fi
# Set cert files readable, private keys restricted. `-type f` skips the LE
# symlinks (tls.crt/tls.key → /etc/letsencrypt/...) so chmod doesn't follow
# them into the archive; the targets are handled by the setfacl/copy above.
# `\( ... \)` groups the -o predicates so the ! filters bind correctly, and
# `-exec +` avoids the find|xargs word-splitting (SC2038).
find "$TLS_CERT_DIR" -type f \( -name '*.key' -o -name 'privkey.pem' \) -exec chmod 640 {} +
find "$TLS_CERT_DIR" -type f \( -name '*.crt' -o -name '*.pem' \) ! -name 'privkey.pem' ! -name '*.key' -exec chmod 644 {} +
chown -R root:minikube "$TLS_CERT_DIR"

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

# Replace domain placeholder (use Elastic IP metadata if no domain)
if [ -n "$DOMAIN" ]; then
  sed -i "s|YOUR_DOMAIN_HERE|${DOMAIN}|g" .env
else
  # Fetch Elastic IP from instance metadata (IMDSv2)
  IMDS_TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600")
  PUBLIC_IP=$(curl -s -H "X-aws-ec2-metadata-token: $IMDS_TOKEN" http://169.254.169.254/latest/meta-data/public-ipv4 || echo "localhost")
  sed -i "s|YOUR_DOMAIN_HERE|${PUBLIC_IP}|g" .env
fi

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
if [ -n "$DOMAIN" ]; then
  echo "  Application URL: https://${DOMAIN}"
else
  echo "  Application URL: https://${PUBLIC_IP:-<elastic-ip>}"
  echo "  (self-signed TLS — browser will show certificate warning)"
fi
echo "  SSH: ssh ec2-user@<elastic-ip>"
echo "  Logs: /var/log/user-data.log"
echo "  Pods: sudo -u minikube kubectl get pods -n pipeline-builder"
