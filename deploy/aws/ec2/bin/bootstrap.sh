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
GHCR_TOKEN="${GHCR_TOKEN:-}"
GHCR_USER="${GHCR_USER:-mwashburn160}"

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

# Move Docker storage to dedicated data volume to prevent root disk exhaustion
DATA_MOUNT="/mnt/data"
DOCKER_DATA_ROOT="$DATA_MOUNT/docker"
if mountpoint -q "$DATA_MOUNT" 2>/dev/null; then
  mkdir -p "$DOCKER_DATA_ROOT"
  mkdir -p /etc/docker
  cat > /etc/docker/daemon.json <<DAEMONJSON
{
  "data-root": "$DOCKER_DATA_ROOT"
}
DAEMONJSON
  echo "  Docker data-root: $DOCKER_DATA_ROOT"
else
  echo "  WARNING: Data volume not mounted at $DATA_MOUNT — Docker using root volume (/var/lib/docker)" >&2
  echo "  Prebuilt plugin images may exhaust root disk. Attach a data volume and re-run bootstrap." >&2
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
  dnf install -y certbot

  echo "  Obtaining Let's Encrypt certificate for ${DOMAIN}..."
  if ! certbot certonly --standalone \
      --non-interactive \
      --agree-tos \
      --email "admin@${DOMAIN}" \
      -d "${DOMAIN}" \
      --preferred-challenges http; then
    echo "  ERROR: certbot failed to obtain certificate for ${DOMAIN}" >&2
    echo "  Common causes: domain not pointing to this instance, port 80 blocked, Let's Encrypt rate limit" >&2
    echo "  Falling back to self-signed certificate" >&2
    openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
      -keyout "$TLS_CERT_DIR/tls.key" -out "$TLS_CERT_DIR/tls.crt" \
      -subj "/CN=${DOMAIN}" -addext "subjectAltName=DNS:${DOMAIN}"
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
  echo "  No domain provided — generating self-signed certificate..."
  openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
    -keyout "$TLS_CERT_DIR/tls.key" \
    -out "$TLS_CERT_DIR/tls.crt" \
    -subj "/CN=pipeline-builder/O=pipeline-builder"
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

# Data directory on dedicated EBS volume (mounted by UserData at /mnt/data)
if mountpoint -q "/mnt/data" 2>/dev/null; then
  echo "  Using dedicated data volume at /mnt/data"
  chown minikube:minikube /mnt/data
else
  echo "  WARNING: No data volume at /mnt/data — using root volume"
  mkdir -p /mnt/data
  chown minikube:minikube /mnt/data
fi
chown -R minikube:minikube "$DEPLOY_DIR"
chown -R minikube:minikube "$INSTALL_DIR/deploy/bin"

# Move plugin build artifacts to data volume (image.tar + plugin.zip are large)
# Symlink keeps deploy/plugins/ path working while using data volume storage
PLUGIN_DATA_DIR="/mnt/data/plugin-artifacts"
PLUGIN_SRC_DIR="$INSTALL_DIR/deploy/plugins"
if mountpoint -q /mnt/data 2>/dev/null && [ ! -L "$PLUGIN_SRC_DIR" ]; then
  mkdir -p "$PLUGIN_DATA_DIR"
  if [ -d "$PLUGIN_SRC_DIR" ] && [ ! -L "$PLUGIN_SRC_DIR" ]; then
    # Move existing plugin files to data volume
    cp -a "$PLUGIN_SRC_DIR/." "$PLUGIN_DATA_DIR/"
    rm -rf "$PLUGIN_SRC_DIR"
  fi
  ln -sf "$PLUGIN_DATA_DIR" "$PLUGIN_SRC_DIR"
  chown -R minikube:minikube "$PLUGIN_DATA_DIR"
  echo "  Plugin artifacts: $PLUGIN_DATA_DIR (symlinked from deploy/plugins)"
else
  chown -R minikube:minikube "$PLUGIN_SRC_DIR"
fi

# Create plugin working directories on data volume (hostPath mounts for K8s)
# These back the plugin pod's /app/tmp and /app/uploads (dind uses emptyDir per-pod)
mkdir -p /mnt/data/plugins-data/builds /mnt/data/plugins-data/uploads
# UID 1000 matches the plugin container's user inside minikube
chown -R 1000:1000 /mnt/data/plugins-data
echo "  Plugin working dirs: /mnt/data/plugins-data/{builds,uploads}"

# Allow minikube user to read TLS certs
if [ -n "$DOMAIN" ]; then
  setfacl -R -m u:minikube:rx /etc/letsencrypt/live/ /etc/letsencrypt/archive/ 2>/dev/null || {
    # Copy certs to a separate dir rather than making LE privkeys world-readable
    cp "$LE_DIR/fullchain.pem" "$TLS_CERT_DIR/fullchain.pem"
    cp "$LE_DIR/privkey.pem" "$TLS_CERT_DIR/privkey.pem"
    chown minikube:minikube "$TLS_CERT_DIR/fullchain.pem" "$TLS_CERT_DIR/privkey.pem"
  }
fi
# Set cert files readable, private keys restricted
find "$TLS_CERT_DIR" -name '*.key' -o -name 'privkey.pem' | xargs -r chmod 640
find "$TLS_CERT_DIR" -name '*.crt' -o -name '*.pem' ! -name 'privkey.pem' ! -name '*.key' | xargs -r chmod 644
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
GRAFANA_PASSWORD=$(openssl rand -base64 16 | tr -d '=+/')
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
sed -i "s|GRAFANA_ADMIN_PASSWORD=CHANGE_ME|GRAFANA_ADMIN_PASSWORD=${GRAFANA_PASSWORD}|" .env
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
