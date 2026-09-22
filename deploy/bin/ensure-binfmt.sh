#!/usr/bin/env bash
# Ensure QEMU/binfmt is registered so the rootless buildkitd can build a foreign
# architecture (e.g. linux/amd64 plugin images on an arm64 host). Rootless
# buildkit can't register binfmt itself — it needs the host kernel's
# binfmt_misc, which Docker Desktop ships pre-registered but a plain Linux host
# (docker driver / CI) does not.
#
# Idempotent + non-fatal:
#   - skips when the host arch already matches the target (no emulation needed)
#   - skips when the QEMU handler is already registered (Linux fast path)
#   - otherwise installs via `tonistiigi/binfmt` (digest-pinned; a no-op on Docker Desktop,
#     a real install on a bare Linux host)
#   - never fails the caller: a missing emulator just means cross-arch builds
#     won't work until installed (or PUBLISH_PLATFORM is set to the host arch)
#
# Usage: ensure-binfmt.sh [TARGET_PLATFORM]   (default linux/amd64)
#
# SHELL OPTIONS — the missing `-e` is DELIBERATE, not an oversight. This script
# is best-effort by contract (see "never fails the caller" above): a host with
# no QEMU emulator available must leave the caller running, with cross-arch
# builds simply unavailable, rather than aborting a provision over an optional
# capability. `-u` and `pipefail` still apply — a typo'd variable or a broken
# pipe is a bug either way.
set -uo pipefail

TARGET_PLATFORM="${1:-linux/amd64}"
TARGET_ARCH="${TARGET_PLATFORM##*/}"   # linux/amd64 -> amd64

case "$(uname -m)" in
  x86_64|amd64)  HOST_ARCH=amd64 ;;
  aarch64|arm64) HOST_ARCH=arm64 ;;
  *)             HOST_ARCH="$(uname -m)" ;;
esac

if [ "$HOST_ARCH" = "$TARGET_ARCH" ]; then
  echo "  binfmt: host ($HOST_ARCH) matches target ($TARGET_ARCH) — no QEMU needed"
  exit 0
fi

# QEMU handler name for the target arch (emulator that runs on the host).
case "$TARGET_ARCH" in
  amd64) QEMU=qemu-x86_64 ;;
  arm64) QEMU=qemu-aarch64 ;;
  *)     QEMU="" ;;
esac

# Fast path on a Linux host: handler already in the (shared) kernel binfmt_misc.
# On Docker Desktop the host has no /proc/sys/fs/binfmt_misc — the install below
# is then a cheap no-op since QEMU is already registered in the VM.
if [ -n "$QEMU" ] && [ -e "/proc/sys/fs/binfmt_misc/$QEMU" ]; then
  echo "  binfmt: $QEMU already registered — skipping"
  exit 0
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "  binfmt: docker not found — skipping (set PUBLISH_PLATFORM=linux/$HOST_ARCH to build native)"
  exit 0
fi

# Pinned BY DIGEST (multi-arch index, so it still resolves per architecture) —
# this container runs --privileged and registers kernel binfmt handlers, so a
# floating `:latest` would be an unpinned privileged execution on every provision.
# Bump: `docker buildx imagetools inspect tonistiigi/binfmt:qemu-<ver>`.
BINFMT_IMAGE="${BINFMT_IMAGE:-tonistiigi/binfmt@sha256:400a4873b838d1b89194d982c45e5fb3cda4593fbfd7e08a02e76b03b21166f0}"  # tonistiigi/binfmt:qemu-v10.2.3

echo "  binfmt: registering QEMU for $TARGET_ARCH (host is $HOST_ARCH) via ${BINFMT_IMAGE%%@*}…"
if docker run --privileged --rm "$BINFMT_IMAGE" --install "$TARGET_ARCH" >/dev/null 2>&1; then
  echo "  binfmt: QEMU for $TARGET_ARCH ready"
else
  echo "  WARNING: binfmt install failed — cross-arch ($HOST_ARCH→$TARGET_ARCH) plugin builds may fail with 'exec format error'."
  echo "  WARNING:   fix: docker run --privileged --rm $BINFMT_IMAGE --install all"
  echo "  WARNING:   or:  set PUBLISH_PLATFORM=linux/$HOST_ARCH to build native (local images don't run on AWS)."
fi
exit 0
