#!/usr/bin/env bash
# =============================================================================
# Pipeline Builder - EC2 Shutdown Script
# =============================================================================
# Stops minikube and removes iptables forwarding rules.
# Run as root: sudo bash deploy/aws/ec2/bin/shutdown.sh
# =============================================================================
set -euo pipefail

PROFILE="pipeline-builder"

# Ensure running as root (iptables requires it)
if [ "$(id -u)" != "0" ]; then
  echo "ERROR: shutdown.sh must be run as root (sudo)" >&2
  exit 1
fi

echo "=== Pipeline Builder EC2 Shutdown ==="

# Remove iptables DNAT rules
echo ""
echo "=== Removing iptables forwarding rules ==="
MINIKUBE_IP=$(sudo -u minikube minikube ip --profile="$PROFILE" 2>/dev/null || true)
PRIMARY_IF=$(ip -o route get 8.8.8.8 2>/dev/null | sed -n 's/.*dev \([^ ]*\).*/\1/p')
PRIMARY_IF="${PRIMARY_IF:-eth0}"

if [ -n "$MINIKUBE_IP" ]; then
  # Remove PREROUTING DNAT rules
  iptables -t nat -D PREROUTING -i "$PRIMARY_IF" -p tcp --dport 443 -j DNAT --to-destination "${MINIKUBE_IP}:30443" 2>/dev/null || true
  iptables -t nat -D PREROUTING -i "$PRIMARY_IF" -p tcp --dport 80 -j DNAT --to-destination "${MINIKUBE_IP}:30080" 2>/dev/null || true
  # Also remove rules without -i flag (from manual iptables commands)
  iptables -t nat -D PREROUTING -p tcp --dport 443 -j DNAT --to-destination "${MINIKUBE_IP}:30443" 2>/dev/null || true
  iptables -t nat -D PREROUTING -p tcp --dport 80 -j DNAT --to-destination "${MINIKUBE_IP}:30080" 2>/dev/null || true
  # Remove FORWARD rules
  iptables -D FORWARD -d "$MINIKUBE_IP" -p tcp --dport 30443 -j ACCEPT 2>/dev/null || true
  iptables -D FORWARD -d "$MINIKUBE_IP" -p tcp --dport 30080 -j ACCEPT 2>/dev/null || true
  echo "  iptables PREROUTING + FORWARD rules removed"
else
  echo "  Could not determine minikube IP — flushing NAT PREROUTING chain"
  iptables -t nat -F PREROUTING 2>/dev/null || true
fi

# Save cleaned iptables
iptables-save > /etc/sysconfig/iptables 2>/dev/null || true

# Stop minikube
echo ""
echo "=== Stopping Minikube ==="
sudo -u minikube minikube stop --profile="$PROFILE" || true
echo "  Minikube stopped"

echo ""
echo "=== Shutdown complete ==="
echo "  To restart: sudo bash deploy/aws/ec2/bin/startup.sh"
