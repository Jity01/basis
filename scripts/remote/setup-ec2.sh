#!/usr/bin/env bash
set -euo pipefail

echo "=== Context Manager EC2 Setup ==="
echo ""

# Install Tailscale
if ! command -v tailscale &>/dev/null; then
  echo "Installing Tailscale..."
  curl -fsSL https://tailscale.com/install.sh | sh
else
  echo "Tailscale already installed."
fi

# Install SSHFS
if ! command -v sshfs &>/dev/null; then
  echo "Installing SSHFS..."
  if command -v apt-get &>/dev/null; then
    sudo apt-get update && sudo apt-get install -y sshfs
  elif command -v yum &>/dev/null; then
    sudo yum install -y epel-release && sudo yum install -y fuse-sshfs
  elif command -v dnf &>/dev/null; then
    sudo dnf install -y fuse-sshfs
  else
    echo "Could not detect package manager. Install sshfs manually."
    exit 1
  fi
else
  echo "SSHFS already installed."
fi

# Create mount point
MOUNT_POINT="/mnt/context"
if [ ! -d "$MOUNT_POINT" ]; then
  echo "Creating mount point at $MOUNT_POINT..."
  sudo mkdir -p "$MOUNT_POINT"
  sudo chown "$(whoami)" "$MOUNT_POINT"
else
  echo "Mount point $MOUNT_POINT already exists."
fi

# Start Tailscale (interactive — opens auth URL)
echo ""
echo "Starting Tailscale..."
sudo tailscale up

echo ""
echo "Setup complete."
echo "  Tailscale IP: $(tailscale ip -4)"
echo ""
echo "Next steps:"
echo "  1. Make sure Tailscale is running on your Mac too"
echo "  2. Run: ./mount-context.sh <mac-tailscale-ip> <mac-username>"
