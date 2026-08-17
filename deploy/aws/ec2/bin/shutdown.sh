#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Pipeline Builder - EC2 Shutdown (graceful STOP; PRESERVES data)
# =============================================================================
# Removes the iptables DNAT rules, then `minikube stop` — which halts the VM but
# PRESERVES its persistent disk. All hostPath data (postgres / mongodb / minio on
# the VM's /data disk) AND the full cluster state are kept, so `startup.sh` brings
# everything back with no re-provisioning. It does NOT delete resources or the EC2
# instance. Must run as root (sudo).
#
# To WIPE the cluster instead: sudo -u minikube minikube delete --profile=pipeline-builder
# (the EC2 instance itself is torn down by deleting the CloudFormation stack).
# =============================================================================

PROFILE="pipeline-builder"

[ "$(id -u)" = "0" ] || { echo "ERROR: run as root (sudo)" >&2; exit 1; }

echo "=== Pipeline Builder EC2 Shutdown ==="

# -- Remove iptables rules ---------------------------------------------------

echo ""
echo "=== Removing iptables rules ==="
MINIKUBE_IP=$(sudo -u minikube minikube ip --profile="$PROFILE" 2>/dev/null || true)
# `|| true`: under set -e+pipefail a failing `ip` would abort before the eth0 fallback.
IF=$(ip -o route get 8.8.8.8 2>/dev/null | sed -n 's/.*dev \([^ ]*\).*/\1/p' || true)
IF="${IF:-eth0}"

if [ -n "$MINIKUBE_IP" ]; then
  # Remove the current ALB-target bridge (30080) plus any legacy 443/80 DNAT
  # rules from older deploys, so an upgrade-in-place leaves no stale rules.
  for port_pair in "30080:30080" "443:30443" "80:30080"; do
    EXT="${port_pair%%:*}"; INT="${port_pair##*:}"
    iptables -t nat -D PREROUTING -i "$IF" -p tcp --dport "$EXT" -j DNAT --to-destination "${MINIKUBE_IP}:${INT}" 2>/dev/null || true
    iptables -t nat -D PREROUTING -p tcp --dport "$EXT" -j DNAT --to-destination "${MINIKUBE_IP}:${INT}" 2>/dev/null || true
    iptables -D FORWARD -d "$MINIKUBE_IP" -p tcp --dport "$INT" -j ACCEPT 2>/dev/null || true
  done
  echo "  Rules removed for ${MINIKUBE_IP}"
else
  echo "  WARNING: Unknown minikube IP — cannot remove specific rules."
  echo "  Run 'iptables -t nat -L PREROUTING -n --line-numbers' to inspect manually."
fi

iptables-save > /etc/sysconfig/iptables 2>/dev/null || true

# -- Stop minikube ------------------------------------------------------------

echo ""
echo "=== Stopping Minikube (preserves the VM disk + cluster state) ==="
sudo -u minikube minikube stop --profile="$PROFILE" || true

echo ""
echo "=== Shutdown complete ==="
echo "  Data preserved on the minikube VM disk (postgres / mongodb / minio buckets)."
echo "  Restart: sudo bash deploy/aws/ec2/bin/startup.sh"
echo "  Wipe ALL data: sudo -u minikube minikube delete --profile=pipeline-builder"
