# OpenViking OpenClaw Plugin Diagnostics Design

## Goal

Add a structured diagnostics channel to the OpenViking OpenClaw plugin so
`ai_toolbox/openclaw_capture_context_tool` can capture and render OpenViking
context-engine behavior with the same level of stability that it already has
for `lossless-claw`.

The new diagnostics must:

- preserve current plugin behavior
- keep existing human-readable `logger.info("openviking: ...")` logs
- add a machine-readable JSONL stream with stable stage names
- cover recall, assemble, and capture/afterTurn flows
- stay small enough to run continuously without becoming a second `cache_trace`

## Reference

This design follows the diagnostics pattern introduced in
`lossless-claw` after commit `8567da9f4d5fc54eeb2686ae264d81061ac24ed5`,
especially:

- dedicated diagnostics module
- environment-based enable/path control
- stable `ts / sessionId / stage / data` envelope
- message digest helpers
- explicit stage records for assemble and afterTurn pipelines

## Output Channel

Add `examples/openclaw-plugin/diagnostics.ts` with:

- `ovDiag(sessionId, stage, data)`
- `clearDiagnostics()`
- `messagePreview(...)`
- `messagesDigest(...)`

The diagnostics file path and switch are:

- `OPENVIKING_DIAGNOSTICS_ENABLED`
- `OPENVIKING_DIAGNOSTICS_PATH`

Default path:

- `~/.openclaw/openviking-diagnostics.jsonl`

Each record uses this envelope:

```json
{
  "ts": 1710000000000,
  "sessionId": "session-or-sessionKey",
  "stage": "assemble_input",
  "data": {}
}
```

## Stage Model

### Recall Path

Diagnostics emitted from `index.ts` in `before_prompt_build`:

- `recall_precheck`
  - query preview
  - query length
  - mode
  - baseUrl
  - precheck status
  - failure reason if any

- `recall_search`
  - query preview
  - candidate limit
  - user result count
  - agent result count
  - merged result count
  - leaf result count
  - filtered result count
  - selected result count

- `recall_inject`
  - injected count
  - estimated tokens
  - recall token budget
  - memory summaries
  - whether `prependContext` was produced

- `recall_error`
  - stage
  - error text

- `ingest_reply_assist`
  - applied
  - reason
  - speaker turns
  - chars

### Assemble Path

Diagnostics emitted from `context-engine.ts` in `assemble()`:

- `assemble_input`
  - messages count
  - input token estimate
  - token budget
  - messages digest

- `context_assemble`
  - archive count
  - active count
  - OV estimated tokens
  - assembled message count
  - assembled messages digest
  - passthrough flag
  - passthrough reason

- `assemble_output`
  - output message count
  - output estimated tokens
  - system prompt addition length
  - system prompt addition present flag

- `assemble_error`
  - error text
  - fallback to original flag

### Capture / afterTurn Path

Diagnostics emitted from `context-engine.ts` in `afterTurn()`:

- `afterTurn_entry`
  - total messages
  - prePromptMessageCount
  - new message count
  - sessionKey present flag
  - isHeartbeat if available

- `capture_store`
  - stored flag
  - stored chars
  - turn text preview
  - sanitized preview

- `capture_check`
  - shouldCapture
  - reason
  - captureMode
  - captureMaxLength

- `capture_skip`
  - reason
  - optional supporting values
  - reasons include:
    - `messages_empty`
    - `no_new_messages`
    - `sanitized_empty`
    - `decision_rejected`
    - `pending_tokens_below_threshold`

- `capture_commit`
  - pending tokens
  - commit threshold
  - status
  - archived
  - task id
  - extracted memories
  - captured turn preview

- `capture_error`
  - error text

## Data Size Rules

Diagnostics are not a full-fidelity transcript store.

Rules:

- digest messages instead of storing all raw message bodies by default
- keep previews capped to 5000 characters
- summarize recalled memories instead of storing full content
- keep large raw text in existing channels:
  - gateway logs
  - `cache_trace`
  - mitmproxy HTTP captures

This keeps diagnostics useful as an indexable, stable event stream without
duplicating the entire conversation payload.

## Compatibility With ai_toolbox

This work is intentionally split into two layers.

### Layer 1: Producer

OpenViking plugin gains structured diagnostics while preserving the current
`openviking: ...` text logs. This ensures no immediate regression in the
current capture UI.

### Layer 2: Consumer

`ai_toolbox` will later add an OpenViking diagnostics loader similar to the
existing `lcm-diagnostics.jsonl` loader and prefer JSONL diagnostics over
regex-parsed gateway logs when available.

Until that loader lands, current gateway-log-based OpenViking capture should
continue to work.

## Files To Change

Expected producer-side changes:

- `examples/openclaw-plugin/diagnostics.ts`
- `examples/openclaw-plugin/context-engine.ts`
- `examples/openclaw-plugin/index.ts`
- `examples/openclaw-plugin/config.ts` if UI hints or config validation need
  diagnostics-specific notes
- `examples/openclaw-plugin/__tests__/...`

## Testing

Add or update tests for:

- `assemble()` diagnostics emission
- `afterTurn()` diagnostics emission
- `before_prompt_build` recall diagnostics emission
- disabled diagnostics behavior
- custom diagnostics path behavior

Validation steps:

- `npm test` in `examples/openclaw-plugin`
- targeted verification that diagnostics JSONL records are written with stable
  stage names and expected fields

## Non-Goals

This change does not:

- replace existing textual plugin logs
- move diagnostics into OpenClaw core
- make OpenViking diagnostics byte-for-byte identical to `lossless-claw`
- fully migrate `ai_toolbox` consumption in the same patch unless it is needed
  for basic end-to-end verification
