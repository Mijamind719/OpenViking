#!/bin/bash

set -euo pipefail

MODE="${MODE:-local}"
BASE_URL="${BASE_URL:-http://127.0.0.1:1933}"
CONFIG_PATH="${CONFIG_PATH:-$HOME/.openviking/ov.conf}"
PORT="${PORT:-1933}"
LINK_MODE="${LINK_MODE:-1}"
USE_DEV="${USE_DEV:-1}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPENCLAW_ARGS=()

if [[ "${USE_DEV}" == "1" ]]; then
  OPENCLAW_ARGS+=(--dev)
fi

INSTALL_ARGS=()
if [[ "${LINK_MODE}" == "1" ]]; then
  INSTALL_ARGS+=(--link)
fi

echo "[context-openviking] installing plugin from ${SCRIPT_DIR}"
openclaw "${OPENCLAW_ARGS[@]}" plugins install "${INSTALL_ARGS[@]}" "${SCRIPT_DIR}"
openclaw "${OPENCLAW_ARGS[@]}" config set plugins.enabled true --json
openclaw "${OPENCLAW_ARGS[@]}" config set plugins.slots.contextEngine context-openviking
openclaw "${OPENCLAW_ARGS[@]}" config set plugins.entries.context-openviking.config.mode "${MODE}"

if [[ "${MODE}" == "remote" ]]; then
  openclaw "${OPENCLAW_ARGS[@]}" config set plugins.entries.context-openviking.config.baseUrl "${BASE_URL}"
else
  openclaw "${OPENCLAW_ARGS[@]}" config set plugins.entries.context-openviking.config.configPath "${CONFIG_PATH}"
  openclaw "${OPENCLAW_ARGS[@]}" config set plugins.entries.context-openviking.config.port "${PORT}" --json
fi

echo "[context-openviking] installed"
echo "[context-openviking] verify with: openclaw ${OPENCLAW_ARGS[*]} plugins info context-openviking"
