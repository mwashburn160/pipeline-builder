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
#   6. Cluster lifecycle unit (resume on boot, clean stop before halt)
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

# Shared helpers (preflight, mongo-keyfile). Sourcing common.sh cd's to /tmp (a
# world-readable cwd); harmless here since every path below is absolute.
# shellcheck source=/dev/null
. "$INSTALL_DIR/deploy/bin/common.sh"
# Fail fast on the ONE external tool needed immediately (secret + admin-password
# generation): openssl, present in the base AMI. docker/kubectl/minikube/yq are
# installed by this script (Phases 3-4), so they are intentionally NOT preflighted
# here — asserting them now would fail on a first boot before they're installed.
preflight openssl

DOMAIN="${DOMAIN:-}"
# Note: DEPLOY_MODE (public/private) flips the ALB scheme/subnets at the
# CloudFormation layer; the box runs identical plain-HTTP nginx behind the ALB
# either way. It IS written into .env (and passed to auto-init below) because in
# private mode the pipeline service needs PIPELINE_VPC_ID/PIPELINE_SUBNET_IDS to
# build VPC-attached CodeBuild projects. Exported by template.yaml UserData.
GHCR_TOKEN="${GHCR_TOKEN:-}"
GHCR_USER="${GHCR_USER:-mwashburn160}"
# Email (SES) — set by CloudFormation UserData. AWS_REGION is the ACTUAL deploy
# region; SES_REGION is pinned to it (the SES identity is regional, so the static
# .env default would break sends in any other region).
AWS_REGION="${AWS_REGION:-us-east-1}"
EMAIL_ENABLED="${EMAIL_ENABLED:-false}"
EMAIL_FROM="${EMAIL_FROM:-}"
# Config-set name comes from CloudFormation (stack-scoped); fall back to the
# default stack name's value if UserData didn't export it.
SES_CONFIGURATION_SET="${SES_CONFIGURATION_SET:-pipeline-builder-email}"
EMAIL_FROM_NAME="${EMAIL_FROM_NAME:-pipeline-builder}"

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

# kubectl, at PB_K8S_VERSION — the same version Phase 9's `minikube start`
# creates the cluster with, so client and server stay inside kubectl's supported
# ±1-minor skew (outside it, `apply --server-side` and CRD applies break).
#
# The version is pinned but the hash is not: verify against the .sha256 that
# dl.k8s.io publishes beside each binary, exactly as common.sh's ensure_kubectl
# does. fetch_verified fails closed on both a bad response and a bad digest —
# without that, a 404 body silently installs as the binary.
echo "  Installing kubectl..."
KUBECTL_VERSION="$PB_K8S_VERSION"
case "$KUBECTL_VERSION" in
  v[0-9]*) ;;
  *) echo "ERROR: PB_K8S_VERSION is '${KUBECTL_VERSION}', not a vX.Y.Z version" >&2; exit 1 ;;
esac
KUBECTL_URL="https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl"
KUBECTL_SHA256=$(curl -fsSL --retry 3 "${KUBECTL_URL}.sha256")
KUBECTL_TMP=$(mktemp)
fetch_verified "$KUBECTL_URL" "${KUBECTL_SHA256%% *}" "$KUBECTL_TMP"
install -o root -g root -m 0755 "$KUBECTL_TMP" /usr/local/bin/kubectl
rm -f "$KUBECTL_TMP"
echo "  kubectl ${KUBECTL_VERSION} installed (sha256 verified)"

# minikube — same treatment: `latest` floats, so verify against the .sha256
# published next to the release asset rather than installing whatever came back.
echo "  Installing minikube..."
MINIKUBE_URL="https://storage.googleapis.com/minikube/releases/latest/minikube-linux-amd64"
MINIKUBE_SHA256=$(curl -fsSL --retry 3 "${MINIKUBE_URL}.sha256")
MINIKUBE_TMP=$(mktemp)
fetch_verified "$MINIKUBE_URL" "${MINIKUBE_SHA256%% *}" "$MINIKUBE_TMP"
install -o root -g root -m 0755 "$MINIKUBE_TMP" /usr/local/bin/minikube
rm -f "$MINIKUBE_TMP"
echo "  minikube installed (sha256 verified)"

# NOTE: istioctl is NOT installed here — startup.sh (Phase 9) calls the shared
# ensure_istioctl, which auto-installs $ISTIO_VERSION to /usr/local/bin (as root
# here, so no sudo). Identical handling to the eks/minikube targets.

# conntrack + socat (required by minikube). jq is required by the auto-init
# path (init-platform builds the admin-register payload with it; load-templates
# and load-compliance parse JSON with it) and is NOT in the AL2023 base image, so
# install it here — otherwise Phase 10's `preflight … jq` would abort auto-init.
dnf install -y conntrack-tools socat jq

# yq — required by build-plugin-images.sh.
# Distro repos may have an old python-yq; install mikefarah's Go binary
# directly to /usr/local/bin so the version matches what plugin scripts expect.
echo "  Installing yq..."
# Pinned VERSION + per-arch SHA-256 (the SHA-256 column of the release's
# `checksums` file); fetch_verified fails closed on a mismatch.
YQ_VERSION="v4.45.1"
case "$(uname -m)" in
  x86_64)  YQ_ARCH=amd64 YQ_SHA256=654d2943ca1d3be2024089eb4f270f4070f491a0610481d128509b2834870049 ;;
  aarch64) YQ_ARCH=arm64 YQ_SHA256=ceea73d4c86f2e5c91926ee0639157121f5360da42beeb8357783d79c2cc6a1d ;;
  *) echo "  ERROR: no pinned yq for arch $(uname -m)" >&2; exit 1 ;;
esac
fetch_verified "https://github.com/mikefarah/yq/releases/download/${YQ_VERSION}/yq_linux_${YQ_ARCH}" \
  "$YQ_SHA256" /usr/local/bin/yq
chmod 0755 /usr/local/bin/yq
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

# Shared .env secret generator (deploy/bin/gen-env-secrets.sh).
. "$INSTALL_DIR/deploy/bin/gen-env-secrets.sh"

# Seed .env from the example + generate secrets ONCE. Guarding this (like the
# eks target) keeps a re-run of bootstrap from rotating DB passwords out from
# under existing data. The region/domain/VPC seds below stay unguarded — they're
# idempotent and keep an existing .env aligned with the instance's parameters.
if [ ! -f .env ]; then
  cp .env.example .env
  # Generated secrets common to every target (shared helper); then the ec2-specific keys.
  pb_gen_env_secrets .env "$GHCR_USER"
fi

# Bring an EXISTING .env up to date with keys added to .env.example since it was
# seeded (ADDITIVE ONLY — an existing value is never touched, so DB passwords
# stay matched to the data on the EBS volume). Without this an upgrade-in-place
# (git pull + re-run bootstrap) never gets a newly added key, and the bring-up
# dies deep in startup.sh with a bare `unbound variable` under `set -u`, or —
# worse — materialises an empty secret. Same call the docker/minikube targets make.
pb_sync_env_keys .env .env.example

# Replace domain placeholder. A domain is always set now (the ALB needs an
# ACM cert for it), so there's no IP fallback.
sed -i "s|YOUR_DOMAIN_HERE|${DOMAIN}|g" .env

# Inject GHCR token (GHCR_USER is handled by pb_gen_env_secrets).
# Anchored + guarded on a non-empty value: the unanchored `GHCR_TOKEN=` prefix
# would DOUBLE an already-present token on a bootstrap re-run (`ghp_xghp_x`),
# breaking private ghcr.io pulls with a 401. `^GHCR_TOKEN=.*` replaces the whole
# line so re-runs are idempotent (if/fi, not `&&`, so an empty token can't trip set -e).
if [ -n "${GHCR_TOKEN:-}" ]; then
  sed -i "s|^GHCR_TOKEN=.*|GHCR_TOKEN=${GHCR_TOKEN}|" .env
fi

# Ops-team Slack webhooks, from the stack parameters via Secrets Manager. Guarded
# on non-empty for the same reason as GHCR_TOKEN: a bootstrap RE-RUN must not wipe
# a URL an operator edited into .env by hand. An empty parameter therefore leaves
# whatever .env already says — on a first run that is the shipped empty value,
# which is the documented "no ops-team Slack" choice.
for _slack_key in SLACK_CRITICAL_WEBHOOK_URL SLACK_WARNING_WEBHOOK_URL; do
  eval "_slack_val=\${${_slack_key}:-}"
  if [ -n "$_slack_val" ]; then
    # `|` is safe as the sed delimiter here: the AllowedPattern on both stack
    # parameters admits only https://hooks.slack.com/services/... URLs.
    sed -i "s|^${_slack_key}=.*|${_slack_key}=${_slack_val}|" .env
  fi
done

# ALERT-DELIVERY PRE-FLIGHT, run HERE rather than inside startup.sh at Phase 9.
# It is a pure .env check with no dependency on Docker, minikube or the cluster,
# and a placeholder used to abort the boot only AFTER seven phases of installs —
# and then take Phases 10-12 (auto-init, backup timer, lifecycle unit) down with
# it, because this script is `set -e`. startup.sh keeps its own call for the
# standalone path; running it twice is free.
pb_check_alert_delivery "$DEPLOY_DIR/.env" "$DEPLOY_DIR/config/alertmanager/alertmanager.yml" || exit 1

# Deploy mode + VPC identity (exported by template.yaml UserData). In PRIVATE mode the
# pipeline service builds VPC-attached CodeBuild projects from PIPELINE_VPC_ID/SUBNET_IDS,
# and init-platform's private-mode prerequisite gate requires them; without this the
# blank .env.example values silently produce CodeBuild projects with no VPC config.
[ -n "${DEPLOY_MODE:-}" ]         && sed -i "s|^DEPLOY_MODE=.*|DEPLOY_MODE=${DEPLOY_MODE}|" .env
[ -n "${PIPELINE_VPC_ID:-}" ]     && sed -i "s|^PIPELINE_VPC_ID=.*|PIPELINE_VPC_ID=${PIPELINE_VPC_ID}|" .env
[ -n "${PIPELINE_SUBNET_IDS:-}" ] && sed -i "s|^PIPELINE_SUBNET_IDS=.*|PIPELINE_SUBNET_IDS=${PIPELINE_SUBNET_IDS}|" .env

# Pin AWS_REGION + SES_REGION to the ACTUAL deploy region (the SES identity is
# regional; the static .env.example default would break sends elsewhere), and
# apply the SES toggles from CloudFormation. EMAIL_FROM keeps its
# noreply@<domain> default (YOUR_DOMAIN_HERE already substituted) unless the
# CloudFormation EmailFrom param overrode it.
sed -i "s|^AWS_REGION=.*|AWS_REGION=${AWS_REGION}|" .env
sed -i "s|^SES_REGION=.*|SES_REGION=${AWS_REGION}|" .env
sed -i "s|^EMAIL_ENABLED=.*|EMAIL_ENABLED=${EMAIL_ENABLED}|" .env
[ -n "$EMAIL_FROM" ] && sed -i "s|^EMAIL_FROM=.*|EMAIL_FROM=${EMAIL_FROM}|" .env
sed -i "s|^EMAIL_FROM_NAME=.*|EMAIL_FROM_NAME=${EMAIL_FROM_NAME}|" .env
# --email implies the SES provider, and routes sends through the configuration
# set (template.yaml) so bounces/complaints publish to the SNS topic.
[ "$EMAIL_ENABLED" = "true" ] && sed -i "s|^EMAIL_PROVIDER=.*|EMAIL_PROVIDER=ses|" .env
[ "$EMAIL_ENABLED" = "true" ] && sed -i "s|^SES_CONFIGURATION_SET=.*|SES_CONFIGURATION_SET=${SES_CONFIGURATION_SET}|" .env
# Blank the static SES key placeholders so the platform signs with the EC2
# instance role (default credential chain). email.ts treats a non-empty
# SES_ACCESS_KEY_ID as "use static creds" — the dummy placeholder would override
# the role and break sending.
sed -i "s|^SES_ACCESS_KEY_ID=.*|SES_ACCESS_KEY_ID=|" .env
sed -i "s|^SES_SECRET_ACCESS_KEY=.*|SES_SECRET_ACCESS_KEY=|" .env

echo "  .env generated with auto-generated secrets"
echo "  Domain: ${DOMAIN}"
echo "  Region: ${AWS_REGION}  (email: ${EMAIL_ENABLED})"

# =============================================================================
# Phase 8: Setup iptables port forwarding
# =============================================================================
echo ""
echo "========================================"
echo "Phase 8: iptables port forwarding"
echo "========================================"

# Enable IP forwarding + raise inotify limits. The minikube docker-driver node
# shares this host's kernel (host user-namespace, no userns-remap), so these
# host sysctls apply inside the cluster. inotify: promtail creates one watch per
# tailed log file and the full stack's pod count blows past the default
# max_user_instances=128 ("failed to make file target manager: too many open
# files"); prometheus's TSDB is inotify/mmap-heavy too. Persisted so a reboot
# (sysctl -p on boot) keeps them.
cat > /etc/sysctl.d/99-pipeline-builder.conf <<'SYSCTL'
net.ipv4.ip_forward = 1
fs.inotify.max_user_instances = 512
fs.inotify.max_user_watches = 524288
SYSCTL
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

# startup.sh handles root-vs-minikube user internally via its `mk` wrapper,
# and sets up iptables when run as root, so we can call it directly.
export DOMAIN
export GHCR_TOKEN
export GHCR_USER
# LEAN passthrough (from UserData's `Lean` stack param); unset => startup.sh defaults off.
export LEAN

# PERSIST the effective LEAN into .env before the first run. It arrives from the
# CloudFormation UserData and lives nowhere else, so without this ANY later
# startup.sh — the boot-recovery unit from Phase 12, or an operator re-running it
# by hand — would default LEAN=0 and re-apply the FULL manifest set onto a box
# sized for lean. That is not a cosmetic difference: `ask-model` alone is ~52% of
# the LEAN memory footprint (see the note at startup.sh's manifest step), so a
# t3.xlarge would be pushed into OOM. Writing it here makes the shape of the
# deployment a property of the instance rather than of one shell's environment.
_lean_norm=0
case "${LEAN:-0}" in 1|true|TRUE|True|yes|y) _lean_norm=1 ;; esac
if grep -qE '^[[:space:]]*LEAN=' "${DEPLOY_DIR}/.env" 2>/dev/null; then
  sed -i -E "s|^[[:space:]]*LEAN=.*|LEAN=${_lean_norm}|" "${DEPLOY_DIR}/.env"
else
  printf '\n# Deployment shape, captured at provision time from the stack LEAN parameter.\n# 1 = drop the optional observability + admin services. Read by startup.sh on\n# every run, including the Phase 12 boot-recovery unit.\nLEAN=%s\n' "$_lean_norm" >> "${DEPLOY_DIR}/.env"
fi
echo "  LEAN=${_lean_norm} persisted to .env (survives reboots)"

bash "${DEPLOY_DIR}/bin/startup.sh"

# Ensure iptables-services is installed for persistence across reboots
dnf install -y iptables-services 2>/dev/null || true
systemctl enable iptables 2>/dev/null || true

# =============================================================================
# Phase 10: Optional auto-init (AUTO_INIT=true) — register + load everything
# =============================================================================
# Runs init-platform ON the box, as the minikube user (it owns the cluster +
# docker + jwt-secret). All init-platform prompts are env-gated, so the loads run
# non-interactively with everything = y. Never aborts the boot: a non-zero exit is
# logged, not fatal (the operator can re-run from the box). Long step — the plugin
# image builds dominate.
if [ "${AUTO_INIT:-false}" = "true" ]; then
  echo ""
  echo "========================================"
  echo "Phase 10: Auto-initialize platform (AUTO_INIT=true)"
  echo "========================================"
  # These are needed by init-platform (docker for the plugin image build + registry
  # login; jq for the register payload and the JSON loaders) and are installed by
  # now — fail fast with one clear error if any is missing. `aws` is intentionally
  # NOT required: bootstrap passes PLATFORM_BASE_URL explicitly (below), so
  # init-platform never hits its `aws cloudformation describe-stacks` fallback.
  preflight docker jq

  # Resolve the initial admin password. Prefer an operator-supplied value
  # (ADMIN_PASSWORD from the CloudFormation AdminPassword parameter, exported by
  # UserData); otherwise generate a strong RANDOM secret so the well-known dev
  # default is NEVER used on a real instance. Persist it to a root-only creds file
  # for retrieval via SSM — the password itself is never echoed to the logs.
  ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
  if [ -z "$ADMIN_PASSWORD" ]; then
    ADMIN_PASSWORD="$(openssl rand -base64 24 | tr -d '=+/' | cut -c1-32)"
    # Store in the minikube user's HOME, NOT under $PIPELINE_DATA_DIR: the data
    # dir is bind-mounted into the minikube node (--mount-string), so anything at
    # its root is reachable from the cluster's hostPath surface. /home/minikube is
    # on the root volume and never mounted into a pod, keeping the secret off that
    # surface. (Trade-off: it does not survive an instance/root-volume replacement
    # — but the admin account lives in Postgres on the EBS data volume, so a fresh
    # bootstrap regenerates, or reset the password.)
    CRED_FILE="/home/minikube/.admin-credentials"
    ( umask 177; printf 'identifier=%s\npassword=%s\n' "admin@internal" "$ADMIN_PASSWORD" > "$CRED_FILE" )
    chown minikube:minikube "$CRED_FILE" 2>/dev/null || true
    echo "  Generated a random initial admin password (identifier admin@internal)."
    echo "  Retrieve it (not logged): sudo cat $CRED_FILE"
  else
    echo "  Using the operator-supplied admin password (AdminPassword parameter)."
  fi

  # init-platform reads DEPLOY_MODE/PIPELINE_VPC_ID/PIPELINE_SUBNET_IDS from the
  # environment (not .env) for its private-mode prerequisite gate — pass them through.
  # PLATFORM_PASSWORD is passed explicitly (runuser does not carry the exported var).
  runuser -u minikube -- env \
    BUILD_BOOTSTRAP=y LOAD_PLUGINS=y LOAD_COMPLIANCE=y LOAD_TEMPLATES=y \
    PLATFORM_BASE_URL="https://${DOMAIN}" \
    PLATFORM_PASSWORD="$ADMIN_PASSWORD" \
    DEPLOY_MODE="${DEPLOY_MODE:-private}" \
    PIPELINE_VPC_ID="${PIPELINE_VPC_ID:-}" \
    PIPELINE_SUBNET_IDS="${PIPELINE_SUBNET_IDS:-}" \
    bash "${INSTALL_DIR}/deploy/bin/init-platform.sh" --continue-on-build-failure ec2 \
    || echo "WARNING: auto-init exited non-zero — re-run on the box: sudo -iu minikube; cd ${INSTALL_DIR}; PLATFORM_BASE_URL=https://${DOMAIN} ./deploy/bin/init-platform.sh ec2"
fi

# =============================================================================
# Phase 11: Daily backup timer (systemd)
# =============================================================================
# deploy/aws/ec2/bin/backup.sh wraps deploy/bin/backup.sh --connect k8s: it stands
# up short-lived `kubectl port-forward`s to postgres/mongodb/rustfs, rewrites the
# connection env to the local tunnels, dumps to S3, then tears the forwards down —
# so the in-cluster names in .env never need to be host-reachable. kubectl and a
# working kubeconfig already exist for the `minikube` user that runs the unit.
#
# The unit + timer are always installed; whether the timer is ENABLED is decided
# below from what is actually usable (dump clients present AND BACKUP_BUCKET set).
# Provisioning the bucket and granting the instance role s3:PutObject stay
# operator-owned. Guarded on backup.sh presence.
echo ""
echo "========================================"
echo "Phase 11: Install backup timer"
echo "========================================"
BACKUP_SH="${INSTALL_DIR}/deploy/aws/ec2/bin/backup.sh"
if [ -f "$BACKUP_SH" ]; then
  # --- Install backup client prereqs (best-effort; never fail the provision) ---
  # backup.sh needs pg_dump (postgresql client) + mongodump (mongodb-database-tools),
  # and rclone only for the optional object-storage mirror. Install them here so
  # the timer can actually run. Each install is NON-FATAL: if a repo is
  # unreachable the enable gate below re-checks `command -v` and simply leaves the
  # timer disabled, so a failed install never regresses a provision that previously
  # just shipped the timer disabled.
  echo "  Installing backup clients (pg_dump / mongodump / rclone)…"
  dnf install -y postgresql16 >/dev/null 2>&1 || dnf install -y postgresql15 >/dev/null 2>&1 \
    || echo "  WARN: could not install postgresql client (pg_dump) — backup timer will stay disabled"
  # mongodb-database-tools from MongoDB's AL2023 repo (provides mongodump).
  cat > /etc/yum.repos.d/mongodb-org-8.0.repo <<'MONGOREPO'
[mongodb-org-8.0]
name=MongoDB Repository
baseurl=https://repo.mongodb.org/yum/amazon/2023/mongodb-org/8.0/x86_64/
gpgcheck=1
enabled=1
gpgkey=https://pgp.mongodb.com/server-8.0.asc
MONGOREPO
  dnf install -y mongodb-database-tools >/dev/null 2>&1 \
    || echo "  WARN: could not install mongodb-database-tools (mongodump) — backup timer will stay disabled"
  # rclone (only needed when S3_BACKUP_TARGET_URL is set for the object-storage
  # mirror); install best-effort so a RustFS-configured backup works.
  ensure_rclone \
    || echo "  WARN: could not install rclone — object-storage mirror unavailable"

  cat > /etc/systemd/system/pipeline-backup.service <<BACKUPSVC
[Unit]
Description=Pipeline Builder DB backup (postgres + mongo) to S3
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=minikube
# Pulls BACKUP_BUCKET / POSTGRES_* / MONGODB_URI / AWS_REGION from the deploy .env.
# backup.sh rewrites the DB/RustFS HOST env to short-lived kubectl port-forwards.
EnvironmentFile=${DEPLOY_DIR}/.env
ExecStart=/usr/bin/env bash ${BACKUP_SH}
BACKUPSVC

  cat > /etc/systemd/system/pipeline-backup.timer <<'BACKUPTIMER'
[Unit]
Description=Run Pipeline Builder DB backup daily

[Timer]
OnCalendar=*-*-* 03:30:00
Persistent=true
RandomizedDelaySec=900

[Install]
WantedBy=timers.target
BACKUPTIMER

  systemctl daemon-reload

  # Enable the timer only when it can actually succeed: BACKUP_BUCKET set in the
  # deploy .env AND both dump clients present. Otherwise leave it DISABLED —
  # a nightly backup that cannot work is a false-red every night. This decides
  # enablement only; it never creates the bucket or touches IAM.
  BACKUP_ENV="${DEPLOY_DIR}/.env"
  backup_bucket="$(grep -E '^BACKUP_BUCKET=' "$BACKUP_ENV" 2>/dev/null | tail -n1 | cut -d= -f2-)"
  backup_bucket="${backup_bucket%\"}"; backup_bucket="${backup_bucket#\"}"   # strip double quotes
  backup_bucket="${backup_bucket%\'}"; backup_bucket="${backup_bucket#\'}"   # strip single quotes
  backup_bucket="$(printf '%s' "$backup_bucket" | tr -d '[:space:]')"
  if [ -n "$backup_bucket" ] && command -v pg_dump >/dev/null 2>&1 && command -v mongodump >/dev/null 2>&1; then
    systemctl enable --now pipeline-backup.timer
    echo "  ENABLED pipeline-backup.timer (BACKUP_BUCKET=${backup_bucket}; nightly 03:30 UTC)."
    echo "  Confirm the instance role grants s3:PutObject on that bucket, then TEST A RESTORE"
    echo "  (an untested backup is not a backup):"
    echo "    ${INSTALL_DIR}/deploy/aws/ec2/bin/restore.sh --confirm-destructive"
  else
    systemctl disable pipeline-backup.timer >/dev/null 2>&1 || true
    echo "  Installed pipeline-backup.{service,timer} (DISABLED)."
    if [ -z "$backup_bucket" ]; then
      echo "    Reason: BACKUP_BUCKET is not set in ${BACKUP_ENV}."
    else
      echo "    Reason: pg_dump/mongodump are not available on the host."
    fi
    echo "  Set BACKUP_BUCKET (+ grant the instance role s3:PutObject) and re-run, or enable manually:"
    echo "    sudo systemctl enable --now pipeline-backup.timer"
  fi
else
  echo "  backup.sh not found at $BACKUP_SH — skipping backup timer install"
fi

# =============================================================================
# Phase 12: Cluster lifecycle unit (systemd) — resume on boot, stop on halt
# =============================================================================
# WHY: minikube runs with --driver=docker, so the cluster node is a container,
# and nothing else ties its lifetime to the instance's.
#
#   On HALT, without this: `aws ec2 stop-instances`, an ASG terminate or a plain
#   `shutdown -h now` tears the box down with the cluster live — systemd stops
#   docker.service, docker SIGKILLs the node container after its own short grace
#   period, and postgres / mongodb / rustfs on the VM's /data disk are cut off
#   mid-write. `minikube stop` halts the VM cleanly and PRESERVES the disk.
#
#   On BOOT, without this: a stop/start leaves a profile whose node VM is
#   Stopped, and the ALB target stays 503 until someone SSHes in and runs
#   startup.sh by hand.
#
# ONE unit covers both, because a systemd service that is ACTIVE gets its
# ExecStop run when the system halts. Type=oneshot + RemainAfterExit=yes is what
# makes it stay active after ExecStart returns; there is no shutdown-only hook
# for an ordinary service.
#
# Both halves delegate to the scripts an operator already runs by hand, so the
# automatic path and the manual one cannot diverge — and the iptables DNAT
# teardown/rebuild comes along for free, which matters because the minikube node
# IP is not guaranteed to survive a restart and a stale rule restored from
# /etc/sysconfig/iptables would point at an address nothing answers on.
#
# ORDERING IS THE WHOLE POINT: `After=docker.service` puts this unit AFTER docker
# on the way up and therefore BEFORE it on the way down (shutdown order is the
# reverse of start order). Drop that line and docker may already be gone when
# `minikube stop` runs — the exact failure this phase exists to prevent.
echo ""
echo "========================================"
echo "Phase 12: Install cluster lifecycle unit"
echo "========================================"
BOOT_SH="${INSTALL_DIR}/deploy/aws/ec2/bin/boot-recover.sh"
SHUTDOWN_SH="${INSTALL_DIR}/deploy/aws/ec2/bin/shutdown.sh"
if [ -f "$BOOT_SH" ] && [ -f "$SHUTDOWN_SH" ]; then
  cat > /etc/systemd/system/pipeline-minikube.service <<LIFECYCLESVC
[Unit]
Description=Pipeline Builder minikube cluster (resume on boot, stop before halt)
Documentation=file://${BOOT_SH}
# AFTER docker on the way up == BEFORE it on the way down. See bootstrap Phase 12.
After=docker.service network-online.target
Wants=docker.service network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/bin/env bash ${BOOT_SH}
ExecStop=/usr/bin/env bash ${SHUTDOWN_SH}
# Resuming re-applies manifests and waits on pods, so allow room; the stop is
# bounded far tighter so a wedged \`minikube stop\` cannot hold the halt past the
# window EC2 allows before forcing the instance off (a partial stop beats none).
TimeoutStartSec=1800
TimeoutStopSec=120

[Install]
WantedBy=multi-user.target
LIFECYCLESVC

  systemctl daemon-reload
  # --now is deliberate: the unit must be ACTIVE for its ExecStop to fire at the
  # FIRST halt, not just at later ones. Starting it here is cheap — Phase 9 has
  # already brought the cluster up, and boot-recover.sh no-ops when the node VM
  # is already Running.
  systemctl enable --now pipeline-minikube.service
  echo "  ENABLED pipeline-minikube.service"
  echo "    halt  -> shutdown.sh     (minikube stop + iptables teardown)"
  echo "    boot  -> boot-recover.sh (resumes the cluster + rebuilds the DNAT bridge)"
  echo "    Verify:  systemctl is-enabled pipeline-minikube.service"
  echo "    Logs:    journalctl -u pipeline-minikube.service -b"
  echo "    An instance stop/start now comes back on its own; no SSH needed."
else
  [ -f "$BOOT_SH" ]      || echo "  boot-recover.sh not found at $BOOT_SH"
  [ -f "$SHUTDOWN_SH" ]  || echo "  shutdown.sh not found at $SHUTDOWN_SH"
  echo "  Skipping cluster lifecycle unit."
  echo "  WARNING: an instance stop will kill the cluster mid-write, and a start"
  echo "           will NOT bring it back without running startup.sh by hand."
fi

echo ""
echo "========================================"
echo "Bootstrap Complete"
echo "========================================"
echo "  Application URL: https://${DOMAIN}  (via the ALB; TLS at the ALB)"
echo "  Access: aws ssm start-session --target <this-instance-id>"
echo "  Logs: /var/log/user-data.log"
echo "  Pods: sudo -u minikube kubectl get pods -n pipeline-builder"
