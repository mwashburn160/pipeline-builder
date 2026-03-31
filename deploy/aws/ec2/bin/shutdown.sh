#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Pipeline Builder - EC2 Shutdown
# =============================================================================
# Stops minikube and removes iptables rules. Must run as root (sudo).
# =============================================================================

PROFILE="pipeline-builder"

[ "$(id -u)" = "0" ] || { echo "ERROR: run as root (sudo)" >&2; exit 1; }

echo "=== Pipeline Builder EC2 Shutdown ==="

# -- Remove iptables rules ---------------------------------------------------

echo ""
echo "=== Removing iptables rules ==="
MINIKUBE_IP=$(sudo -u minikube minikube ip --profile="$PROFILE" 2>/dev/null || true)
IF=$(ip -o route get 8.8.8.8 2>/dev/null | sed -n 's/.*dev \([^ ]*\).*/\1/p')
IF="${IF:-eth0}"

if [ -n "$MINIKUBE_IP" ]; then
  for port_pair in "443:30443" "80:30080"; do
    EXT="${port_pair%%:*}"; INT="${port_pair##*:}"
    iptables -t nat -D PREROUTING -i "$IF" -p tcp --dport "$EXT" -j DNAT --to-destination "${MINIKUBE_IP}:${INT}" 2>/dev/null || true
    iptables -t nat -D PREROUTING -p tcp --dport "$EXT" -j DNAT --to-destination "${MINIKUBE_IP}:${INT}" 2>/dev/null || true
    iptables -D FORWARD -d "$MINIKUBE_IP" -p tcp --dport "$INT" -j ACCEPT 2>/dev/null || true
  done
  echo "  Rules removed for ${MINIKUBE_IP}"
else
  echo "  Unknown minikube IP — flushing NAT PREROUTING"
  iptables -t nat -F PREROUTING 2>/dev/null || true
fi

iptables-save > /etc/sysconfig/iptables 2>/dev/null || true

# -- Stop minikube ------------------------------------------------------------

echo ""
echo "=== Stopping Minikube ==="
sudo -u minikube minikube stop --profile="$PROFILE" || true

echo ""
echo "=== Shutdown complete ==="
echo "  Restart: sudo bash deploy/aws/ec2/bin/startup.sh"
