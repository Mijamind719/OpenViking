# Implementation Plan: OpenViking OpenClaw Context Engine

- Status: Proposed
- Date: 2026-03-15
- Based on: `2026-03-15-openclaw-context-plugin-rfc.md`
- Scope: New `context-openviking` plugin for OpenClaw `contextEngine`

## 1. Overview

This plan turns the RFC into an implementation sequence that can be executed incrementally with working checkpoints.

The core delivery strategy is:

1. build a new context-engine plugin instead of mutating the old memory plugin in place
2. reuse local/remote OpenViking client and process-management pieces where possible
3. get lifecycle correctness first
4. ship direct context assembly before advanced agentic expansion
5. defer migration and deep subagent features

## 2. Deliverables

The implementation should produce:

- a new plugin package under `examples/openclaw-context-plugin/`
- working OpenClaw `contextEngine` registration
- session mirroring from OpenClaw to OpenViking
- OpenViking-driven compaction via session commit
- direct `assemble()` path with:
  - fresh tail
  - session continuity
  - durable memory
  - optional resource/skill recall
- explicit OpenViking tools:
  - `ov_recall`
  - `ov_commit_memory`
  - `ov_forget`
  - `ov_expand`
- integration tests and end-to-end validation docs

## 3. Out of Scope

The following are intentionally excluded from the first implementation cycle:

- migration from `memory-openviking`
- replacing or deleting the existing memory plugin
- SKILL.md interception
- fake automatic function-call injection
- `lossless-claw`-style DAG or local SQLite engine
- full delegated subagent expansion workflow

## 4. Proposed File Layout

Create a new plugin root:

```text
examples/openclaw-context-plugin/
  README.md
  INSTALL.md
  INSTALL-ZH.md
  package.json
  openclaw.plugin.json
  index.ts
  config.ts
  client.ts
  process-manager.ts
  context-engine.ts
  session-mirror.ts
  assembler.ts
  compactor.ts
  heuristics.ts
  formatters.ts
  tools.ts
  subagents.ts
  types.ts
  setup-helper/
  install.sh
  install.ps1
```

Reused logic from `examples/openclaw-memory-plugin/` should be copied only when shared extraction is not practical yet.

Longer term, common utilities can be moved into a shared internal package if both plugins remain supported.

## 5. Workstreams

## 5.1 Workstream A: Plugin Skeleton and Packaging

### Goal

Create a clean new plugin package that OpenClaw can install and select in the `contextEngine` slot.

### Tasks

- Add `package.json` for the new plugin.
- Add `openclaw.plugin.json` with:
  - plugin id
  - config schema
  - slot metadata for `contextEngine`
- Add `index.ts` entrypoint.
- Register the engine through `api.registerContextEngine()`.
- Add `README.md` with local and remote setup examples.

### Exit Criteria

- `openclaw plugins enable context-openviking` works
- `plugins.slots.contextEngine = "context-openviking"` is accepted
- engine can be resolved by OpenClaw without starting full logic yet

## 5.2 Workstream B: Shared Client and Runtime Boot

### Goal

Reuse the current plugin's local and remote OpenViking connectivity logic.

### Tasks

- Port `OpenVikingClient` patterns from the memory plugin.
- Port local process startup from `process-manager.ts`.
- Keep support for:
  - local mode
  - remote mode
  - api key
  - agent id
  - timeout
- Add any missing helper APIs for:
  - session creation
  - message append
  - session commit
  - session extract
  - find
  - read
  - filesystem ls if needed

### Candidate Source Files

- `examples/openclaw-memory-plugin/client.ts`
- `examples/openclaw-memory-plugin/process-manager.ts`
- `examples/openclaw-memory-plugin/config.ts`

### Exit Criteria

- plugin can connect to OpenViking in local and remote mode
- health check and startup logs are stable

## 5.3 Workstream C: Session Mapping and Mirror

### Goal

Mirror OpenClaw session state into OpenViking session storage reliably.

### Tasks

- Define runtime mapping between OpenClaw `sessionId/sessionKey` and OpenViking `session_id`.
- Implement `session-mirror.ts`.
- Implement reconciliation logic:
  - read OpenClaw session file
  - detect what has already been mirrored
  - append only missing suffix messages
- Normalize OpenClaw messages into OpenViking session message format.
- Decide how to store role and tool metadata.

### Open Questions to Resolve During Implementation

- whether to use a deterministic OpenViking session id derived from OpenClaw session id
- whether OpenViking session metadata needs a sidecar file in plugin state

### Exit Criteria

- `bootstrap()` can reconcile a partially mirrored session
- no duplicate message writes during repeated runs

## 5.4 Workstream D: Lifecycle Wiring

### Goal

Implement OpenClaw lifecycle methods with stable behavior.

### Tasks

- Implement `bootstrap()`
- Implement lightweight `ingest()`
- Implement `afterTurn()`
- Implement `compact()`
- Implement `assemble()`
- Add `dispose()` cleanup for local mode

### Lifecycle Policy

- `bootstrap()`
  - initialize runtime state
  - reconcile from session file
- `ingest()`
  - no-op or minimal append helper
- `afterTurn()`
  - append delta messages to OpenViking
- `compact()`
  - call OpenViking session commit
- `assemble()`
  - return final context directly

### Exit Criteria

- OpenClaw can complete a conversation using the new engine
- turns sync correctly
- compaction does not crash runtime

### Current Runtime Note

Current real-world validation shows that in the OpenClaw local-agent path,
`assemble()` may run before the newest user turn is available to the plugin.

Implementation consequence:

- first-turn automatic recall should be treated as best-effort
- immediate direct memory questions should rely on explicit `ov_recall`
- this behavior should be documented as a temporary runtime adaptation, not a
  final architectural choice

## 5.5 Workstream E: Assemble Pipeline

### Goal

Build deterministic assembled context without synthetic tool injection.

### Tasks

- Add `assembler.ts`
- Add explicit bucket builders:
  - profile bucket
  - session continuity bucket
  - durable memory bucket
  - optional resource/skill bucket
  - fresh tail bucket
- Add token budgeting logic
- Add stable formatting helpers in `formatters.ts`
- Add retrieval heuristics in `heuristics.ts`

### Initial Assembly Policy

- Always keep recent raw messages
- Default to `find()` for automatic retrieval
- Escalate to `search()` only when heuristics say it is worth the latency
- Use `systemPromptAddition` only for compact stable guidance
- Add explicit instruction telling the agent to prefer `ov_recall` for
  "what do you remember", preference, and prior-decision questions
- Avoid treating workspace `MEMORY.md` as the primary durable memory source when
  OpenViking tools are available

### Exit Criteria

- assembled context is stable across repeated identical runs
- recent turns are preserved
- old session continuity is recalled after compaction
- first-turn direct memory questions are handled acceptably through explicit
  `ov_recall` even when automatic assembly is one-turn late

## 5.6 Workstream F: Compaction and Memory Extraction

### Goal

Turn OpenViking session commit into the engine's main compaction path.

### Tasks

- Add `compactor.ts`
- Ensure `compact()`:
  - syncs latest message suffix first
  - calls OpenViking session commit
  - reports success/failure cleanly
- Parse commit result into OpenClaw `CompactResult`
- Record archive and extracted-memory counts in logs

### Exit Criteria

- manual compaction works
- overflow compaction works
- durable memory extraction happens at compaction time

## 5.7 Workstream G: Agent-Facing Tools

### Goal

Provide explicit tools for cases automatic assembly cannot cover.

### Tasks

- Add `tools.ts`
- Register:
  - `ov_recall`
  - `ov_commit_memory`
  - `ov_forget`
  - `ov_expand`
- Keep schemas narrow and predictable
- Reuse current memory tool behavior where applicable

### Suggested Tool Sequence

1. Implement `ov_recall`
2. Implement `ov_commit_memory`
3. Implement `ov_forget`
4. Implement `ov_expand`

### Exit Criteria

- agent can explicitly search and inspect OpenViking state
- explicit remember/forget works independently of auto assembly

## 5.8 Workstream H: Packaging and Installation

### Goal

Make the new plugin easy to install and test.

### Tasks

- Duplicate and adapt setup helper logic from the memory plugin
- Update shell and PowerShell installers
- Add `contextEngine` slot setup commands
- Keep memory plugin install flow untouched
- Add a separate README/INSTALL path for the context plugin

### Exit Criteria

- clean install in local mode
- clean install in remote mode
- clear separation from old memory plugin docs

## 6. Phase Plan

## Phase 1: Engine Bootstrap

### Scope

- Workstreams A, B, C

### Result

A plugin that can register, connect to OpenViking, and mirror OpenClaw sessions.

### Acceptance

- engine resolves
- bootstrap works
- afterTurn append works for simple sessions

## Phase 2: Assemble and Compact

### Scope

- Workstreams D, E, F

### Result

A fully functional context engine that can:

- assemble context
- compact old history
- extract durable memory

### Acceptance

- same-session continuity works after compaction
- agent stays within context budget
- engine degrades safely on retrieval failure

## Phase 3: Agent Tools and Packaging

### Scope

- Workstreams G, H

### Result

A usable developer-facing package with explicit OV tools and install docs.

### Acceptance

- tools work end-to-end
- docs are enough for external testing

## Phase 4: Advanced Enhancements

### Scope

- lightweight subagent lineage
- richer archive expansion
- optional search escalation refinement

### Acceptance

- not required for first external release

## 7. Detailed Task Breakdown

## 7.1 Concrete Initial File Creation

Phase 1 should create:

- `examples/openclaw-context-plugin/package.json`
- `examples/openclaw-context-plugin/openclaw.plugin.json`
- `examples/openclaw-context-plugin/index.ts`
- `examples/openclaw-context-plugin/config.ts`
- `examples/openclaw-context-plugin/client.ts`
- `examples/openclaw-context-plugin/process-manager.ts`
- `examples/openclaw-context-plugin/types.ts`
- `examples/openclaw-context-plugin/session-mirror.ts`

## 7.2 Concrete File Edits Likely Needed Later

- `README.md`
- `README_CN.md`
- `docs/design/openclaw-integration.md` or replace with RFC link
- plugin install scripts and helper docs

## 7.3 Suggested Dependency Reuse

Use existing memory-plugin code as source material for:

- local OpenViking process boot
- remote API client
- auth headers
- config parsing
- logging conventions
- install script patterns

Do not reuse old prompt-injection hooks as the main design.

## 8. Testing Plan

## 8.1 Unit Tests

Create tests for:

- config normalization
- session mapping
- bootstrap reconciliation
- new message delta detection
- retrieval heuristics
- assemble token budgeting
- compact result translation

Suggested location:

```text
examples/openclaw-context-plugin/test/
```

## 8.2 Integration Tests

Test against a live OpenViking server:

- create mapped session
- append turns
- compact
- recall from history
- explicit memory commit and recall

## 8.3 Manual E2E Scenarios

### Scenario 1: Simple continuity

1. start OpenClaw with `context-openviking`
2. talk for enough turns to trigger compaction
3. ask about earlier details
4. confirm continuity remains available

### Scenario 2: durable preference

1. tell the assistant a stable preference
2. compact
3. start a later turn or session
4. verify recall

### Scenario 3: resource-aware coding task

1. refer to a codebase or indexed resource
2. confirm automatic resource retrieval joins session and memory context

### Scenario 4: degraded mode

1. stop OpenViking
2. verify fresh-tail-only answering still works without catastrophic failure

## 9. Observability Tasks

Add structured logs for:

- `bootstrap_reconciled`
- `session_delta_synced`
- `assemble_started`
- `assemble_bucket_counts`
- `compact_started`
- `compact_completed`
- `compact_failed`
- `tool_ov_recall`
- `tool_ov_expand`

If possible, include JSON-style detail lines similar to the current memory plugin.

## 10. Risks and Mitigations

## Risk 1: OpenViking session mirror diverges from OpenClaw session file

Mitigation:

- treat OpenClaw session file as source of truth at bootstrap and compact time
- always reconcile suffix before commit

## Risk 2: `assemble()` becomes too slow

Mitigation:

- default to `find()`
- cap automatic recall per bucket
- add strict timeouts and degrade to fresh tail

## Risk 3: session continuity retrieval is weaker than `lossless-claw`

Mitigation:

- preserve L2 archive transcript
- add `ov_expand`
- add higher-level archive grouping later if needed

## Risk 4: code duplication with memory plugin grows

Mitigation:

- first ship by reuse or copy for speed
- refactor into shared internal utilities only after behavior stabilizes

## 11. Recommended Development Order

The recommended execution order for actual coding is:

1. package scaffold
2. config + client + process manager
3. session mirror
4. bootstrap + afterTurn
5. compact
6. assemble with fresh tail + durable memory
7. add session continuity retrieval
8. add resource/skill heuristics
9. agent-facing tools
10. installers and docs

This order keeps a runnable plugin available early and avoids overbuilding before the core lifecycle works.

## 12. Team Checkpoints

Suggested review checkpoints:

### Checkpoint A

After Phase 1:

- agree on session mapping
- agree on mirrored message normalization

### Checkpoint B

After Phase 2:

- evaluate answer quality vs current memory plugin
- compare same-session continuity with `lossless-claw`

### Checkpoint C

After Phase 3:

- validate installation UX
- decide whether old memory plugin remains recommended for any scenario

## 13. Definition of Done

This implementation plan is complete when:

- the new plugin exists and is installable
- OpenClaw can run it as the selected `contextEngine`
- recent context, session history, and durable memory all participate in assembly
- compaction archives to OpenViking and extracts memories
- explicit OV tools work
- tests cover the main lifecycle
- documentation is sufficient for another engineer to set up and validate the plugin
