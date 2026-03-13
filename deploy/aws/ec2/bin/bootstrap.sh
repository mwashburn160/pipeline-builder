#!/bin/bash
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
  certbot certonly --standalone \
    --non-interactive \
    --agree-tos \
    --email "admin@${DOMAIN}" \
    -d "${DOMAIN}" \
    --preferred-challenges http

  # Symlink to standard location
  ln -sf "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" "$TLS_CERT_DIR/tls.crt"
  ln -sf "/etc/letsencrypt/live/${DOMAIN}/privkey.pem" "$TLS_CERT_DIR/tls.key"

  echo "  Certificate obtained: /etc/letsencrypt/live/${DOMAIN}/"

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

# Create data directory and give minikube user access to the deployment directory
mkdir -p "$DEPLOY_DIR/data"
chown -R minikube:minikube "$DEPLOY_DIR"

# Allow minikube user to read TLS certs
if [ -n "$DOMAIN" ]; then
  setfacl -R -m u:minikube:rx /etc/letsencrypt/live/ /etc/letsencrypt/archive/ 2>/dev/null || {
    chmod -R o+rx /etc/letsencrypt/live/ /etc/letsencrypt/archive/
  }
fi
chmod -R o+rx "$TLS_CERT_DIR"

# =============================================================================
# Phase 7: Generate .env from template
# =============================================================================
echo ""
echo "========================================"
echo "Phase 7: Generate .env configuration"
echo "========================================"
cd "$DEPLOY_DIR"

cp .env.example .env

# Generate secrets
JWT_SECRET=$(openssl rand -base64 32)
REFRESH_SECRET=$(openssl rand -base64 32)
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
echo 1 > /proc/sys/net/ipv4/ip_forward
echo "net.ipv4.ip_forward = 1" >> /etc/sysctl.d/99-pipeline-builder.conf
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

# Export variables needed by startup.sh
export DOMAIN
export GHCR_TOKEN
export GHCR_USER

su - minikube -c "
  export DOMAIN='${DOMAIN}'
  export GHCR_TOKEN='${GHCR_TOKEN}'
  export GHCR_USER='${GHCR_USER}'
  cd '${DEPLOY_DIR}'
  bash bin/startup.sh
"

# =============================================================================
# Phase 10: Setup iptables DNAT rules (needs minikube IP)
# =============================================================================
echo ""
echo "========================================"
echo "Phase 10: iptables DNAT rules"
echo "========================================"

MINIKUBE_IP=$(su - minikube -c "minikube ip --profile=pipeline-builder" 2>/dev/null || true)
if [ -n "$MINIKUBE_IP" ]; then
  # Detect primary network interface (eth0, ens5, etc.)
  PRIMARY_IF=$(ip -o route get 8.8.8.8 2>/dev/null | sed -n 's/.*dev \([^ ]*\).*/\1/p')
  PRIMARY_IF="${PRIMARY_IF:-eth0}"

  # Forward external traffic only (-i $PRIMARY_IF) so minikube VM
  # outbound traffic to port 443 is not intercepted.
  iptables -t nat -A PREROUTING -i "$PRIMARY_IF" -p tcp --dport 443 -j DNAT --to-destination "${MINIKUBE_IP}:30443"
  iptables -t nat -A PREROUTING -i "$PRIMARY_IF" -p tcp --dport 80 -j DNAT --to-destination "${MINIKUBE_IP}:30080"
  # Allow DNAT'd packets through the FORWARD chain to reach minikube
  iptables -A FORWARD -d "$MINIKUBE_IP" -p tcp --dport 30443 -j ACCEPT
  iptables -A FORWARD -d "$MINIKUBE_IP" -p tcp --dport 30080 -j ACCEPT
  # Masquerade return traffic from minikube back to external clients
  iptables -t nat -A POSTROUTING -o "$PRIMARY_IF" -j MASQUERADE

  # Persist iptables rules across reboots
  dnf install -y iptables-services 2>/dev/null || true
  iptables-save > /etc/sysconfig/iptables
  systemctl enable iptables 2>/dev/null || true

  echo "  Interface: ${PRIMARY_IF}"
  echo "  443 → ${MINIKUBE_IP}:30443"
  echo "  80  → ${MINIKUBE_IP}:30080"
  echo "  Rules persisted to /etc/sysconfig/iptables"
else
  echo "  WARNING: Could not determine minikube IP — iptables rules not set"
  echo "  Run 'sudo bash ${DEPLOY_DIR}/bin/bootstrap.sh' to retry after minikube is running"
fi

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
