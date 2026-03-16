#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
PROFILE="${PROFILE:-ov-e2e}"
PORT="${PORT:-19401}"
STATE_FILE="${STATE_FILE:-/tmp/context-openviking-e2e-state.json}"
SESSION_ID="${SESSION_ID:-e2e-context-openviking}"
BUILD_DIR="$(mktemp -d /tmp/context-openviking-build.XXXXXX)"
TURN1_FILE="$(mktemp /tmp/context-openviking-turn1.XXXXXX.json)"
COMPACT_FILE="$(mktemp /tmp/context-openviking-compact.XXXXXX.json)"
TURN2_FILE="$(mktemp /tmp/context-openviking-turn2.XXXXXX.json)"
TURN3_FILE="$(mktemp /tmp/context-openviking-turn3.XXXXXX.json)"
TURN4_FILE="$(mktemp /tmp/context-openviking-turn4.XXXXXX.json)"
LONG_MEMORY_MESSAGE="$(python3 - <<'PY'
filler = " ".join(["buffer"] * 600)
print(f"Remember that my favorite editor is neovim. {filler}")
PY
)"

rm -rf "$HOME/.openclaw-${PROFILE}" "$HOME/.openclaw/workspace-${PROFILE}"
rm -f "${STATE_FILE}" /tmp/context-openviking-e2e-server.log

python3 "${SCRIPT_DIR}/mock_stack.py" --port "${PORT}" --state-file "${STATE_FILE}" >"/tmp/context-openviking-e2e-server.log" 2>&1 &
SERVER_PID=$!
trap 'kill ${SERVER_PID} >/dev/null 2>&1 || true; wait ${SERVER_PID} 2>/dev/null || true; rm -rf "${BUILD_DIR}" "${TURN1_FILE}" "${COMPACT_FILE}" "${TURN2_FILE}" "${TURN3_FILE}" "${TURN4_FILE}"' EXIT
sleep 1

"${PLUGIN_DIR}/node_modules/.bin/tsc" -p "${PLUGIN_DIR}/tsconfig.json" --noEmit false --outDir "${BUILD_DIR}" >/dev/null

openclaw --profile "${PROFILE}" plugins install --link "${PLUGIN_DIR}" >/dev/null
openclaw --profile "${PROFILE}" config set plugins.enabled true --json >/dev/null
openclaw --profile "${PROFILE}" config set plugins.slots.contextEngine context-openviking >/dev/null
openclaw --profile "${PROFILE}" config set plugins.entries.context-openviking.enabled true --json >/dev/null
openclaw --profile "${PROFILE}" config set plugins.entries.context-openviking.config.mode remote >/dev/null
openclaw --profile "${PROFILE}" config set plugins.entries.context-openviking.config.baseUrl "http://127.0.0.1:${PORT}" >/dev/null
openclaw --profile "${PROFILE}" config set plugins.entries.context-openviking.config.freshTailMessages 1 --json >/dev/null
openclaw --profile "${PROFILE}" config set plugins.entries.context-openviking.config.recallScoreThreshold 0 --json >/dev/null
openclaw --profile "${PROFILE}" config set models.mode merge >/dev/null
openclaw --profile "${PROFILE}" config set models.providers.openai "{\"baseUrl\":\"http://127.0.0.1:${PORT}/v1\",\"api\":\"openai-completions\",\"models\":[{\"id\":\"mock-e2e\",\"name\":\"Mock E2E\",\"contextWindow\":200000,\"maxTokens\":4096,\"reasoning\":false}]}" --json >/dev/null
openclaw --profile "${PROFILE}" config set agents.defaults.model.primary openai/mock-e2e >/dev/null
openclaw --profile "${PROFILE}" config set auth.profiles '{"openai:default":{"provider":"openai","mode":"api_key"}}' --json >/dev/null

AUTH_DIR="$HOME/.openclaw-${PROFILE}/agents/main/agent"
mkdir -p "${AUTH_DIR}"
cat >"${AUTH_DIR}/auth-profiles.json" <<'JSON'
{
  "version": 1,
  "profiles": {
    "openai:default": {
      "type": "api_key",
      "provider": "openai",
      "key": "mock-e2e-key"
    }
  }
}
JSON

echo "=== turn 1: establish preference ==="
openclaw --profile "${PROFILE}" agent --local --session-id "${SESSION_ID}" --message "${LONG_MEMORY_MESSAGE}" --json >"${TURN1_FILE}"
cat "${TURN1_FILE}"

echo "=== compact via context engine ==="
node "${SCRIPT_DIR}/context_engine_driver.mjs" \
  --build-dir "${BUILD_DIR}" \
  --base-url "http://127.0.0.1:${PORT}" \
  --session-id "${SESSION_ID}" \
  --session-file "$HOME/.openclaw-${PROFILE}/agents/main/sessions/${SESSION_ID}.jsonl" >"${COMPACT_FILE}"
cat "${COMPACT_FILE}"

echo "=== turn 2: seed auto recall ==="
openclaw --profile "${PROFILE}" agent --local --session-id "${SESSION_ID}" --message "What is my favorite editor? Reply with the value only." --json >"${TURN2_FILE}"
cat "${TURN2_FILE}"

echo "=== turn 3: auto recall ==="
openclaw --profile "${PROFILE}" agent --local --session-id "${SESSION_ID}" --message "What is my favorite editor? Reply with the value only." --json >"${TURN3_FILE}"
cat "${TURN3_FILE}"

echo "=== turn 4: explicit ov_recall tool ==="
openclaw --profile "${PROFILE}" agent --local --session-id "${SESSION_ID}" --message "Use ov_recall to search for my editor preference and then answer with TOOL_OK plus the preference." --json >"${TURN4_FILE}"
cat "${TURN4_FILE}"

python3 - <<'PY' "${TURN1_FILE}" "${COMPACT_FILE}" "${TURN2_FILE}" "${TURN3_FILE}" "${TURN4_FILE}" "${STATE_FILE}"
import json
import sys

def load_json_loose(path):
    raw = open(path, "r", encoding="utf-8").read()
    start = raw.find("{")
    end = raw.rfind("}")
    if start < 0 or end < start:
        raise RuntimeError(f"Could not locate JSON payload in {path}")
    return json.loads(raw[start:end + 1])

turn1 = load_json_loose(sys.argv[1])
compact = load_json_loose(sys.argv[2])
turn2 = load_json_loose(sys.argv[3])
turn3 = load_json_loose(sys.argv[4])
turn4 = load_json_loose(sys.argv[5])
state = load_json_loose(sys.argv[6])

def payload_text(data):
    return "\n".join(
        payload.get("text", "")
        for payload in data.get("payloads", [])
        if isinstance(payload, dict)
    ).strip()

turn1_text = payload_text(turn1)
turn2_text = payload_text(turn2)
turn3_text = payload_text(turn3)
turn4_text = payload_text(turn4)

assert turn1_text == "Noted.", turn1_text
assert compact.get("result", {}).get("compacted") is True, compact
assert turn2_text == "unknown", turn2_text
assert turn3_text == "neovim", turn3_text
assert turn4_text == "TOOL_OK neovim", turn4_text
assert "viking://user/default/memories/preferences/editor.md" in state.get("memories", {}), state.get("memories", {})

print("E2E_OK")
PY

echo "=== state file ==="
cat "${STATE_FILE}"
