#!/usr/bin/env bash
set -euo pipefail

MOUNT_POINT="${1:-/mnt/context}"

if ! mountpoint -q "$MOUNT_POINT" 2>/dev/null; then
  echo "Not mounted at $MOUNT_POINT"
  exit 0
fi

fusermount -u "$MOUNT_POINT" 2>/dev/null || umount "$MOUNT_POINT"
echo "Unmounted $MOUNT_POINT"
