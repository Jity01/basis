#!/usr/bin/env bash
set -euo pipefail

MAC_IP="${1:?Usage: mount-context.sh <mac-tailscale-ip> [mac-username] [mount-point]}"
MAC_USER="${2:-$(whoami)}"
MOUNT_POINT="${3:-/mnt/context}"

if mountpoint -q "$MOUNT_POINT" 2>/dev/null; then
  echo "Already mounted at $MOUNT_POINT"
  exit 0
fi

if [ ! -d "$MOUNT_POINT" ]; then
  echo "Mount point $MOUNT_POINT does not exist. Run setup-ec2.sh first."
  exit 1
fi

sshfs "${MAC_USER}@${MAC_IP}:${HOME}/.context" "$MOUNT_POINT" \
  -o ro \
  -o reconnect \
  -o ServerAliveInterval=15 \
  -o ServerAliveCountMax=3 \
  -o follow_symlinks \
  -o cache=yes \
  -o kernel_cache \
  -o entry_timeout=5 \
  -o attr_timeout=5

echo "Mounted ${MAC_USER}@${MAC_IP}:~/.context at ${MOUNT_POINT} (read-only)"
