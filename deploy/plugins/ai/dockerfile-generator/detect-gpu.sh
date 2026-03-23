#!/usr/bin/env bash
# Auto-detect GPU availability for Ollama
# Sets OLLAMA_NO_GPU=1 if no NVIDIA GPU is found, allowing CPU fallback.
# Can be overridden by explicitly setting OLLAMA_NO_GPU before container start.

set -e

if [ -z "${OLLAMA_NO_GPU:-}" ]; then
  if command -v nvidia-smi &>/dev/null && nvidia-smi &>/dev/null; then
    echo "[detect-gpu] NVIDIA GPU detected — using GPU acceleration"
    export OLLAMA_NO_GPU=0
  elif [ -d "/dev/dri" ] || [ -e "/dev/nvidia0" ]; then
    echo "[detect-gpu] GPU device found — using GPU acceleration"
    export OLLAMA_NO_GPU=0
  else
    echo "[detect-gpu] No GPU detected — running in CPU-only mode"
    export OLLAMA_NO_GPU=1
  fi
else
  echo "[detect-gpu] OLLAMA_NO_GPU explicitly set to ${OLLAMA_NO_GPU}"
fi

export OLLAMA_NO_GPU

exec "$@"
