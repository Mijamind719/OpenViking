# RFC: OpenViking as an OpenClaw Context Engine

- Status: Proposed
- Authors: Codex + OpenViking team discussion synthesis
- Date: 2026-03-15
- Related:
  - OpenClaw context engine support introduced in `2026.3.7`
  - OpenViking discussion `#525`
  - Existing `examples/openclaw-memory-plugin`
  - Reference implementation: `lossless-claw`

## 1. Summary

This RFC proposes a new OpenClaw plugin, `context-openviking`, that uses OpenViking as a first-class `contextEngine` rather than as a legacy `memory` plugin.

The design goal is not to clone `lossless-claw`'s SQLite + summary DAG architecture. Instead, the plugin should expose OpenViking's native strengths inside OpenClaw's context lifecycle:

- session archiving and session-level summaries
- long-term memory extraction and retrieval
- unified retrieval across memory, resource, and skill spaces
- layered context delivery via L0/L1/L2
- optional active recall tools for agent-driven expansion

The engine should own compaction, assemble model context directly, and treat OpenViking as the durable context plane behind OpenClaw sessions.

## 2. Motivation

OpenClaw's `contextEngine` interface allows plugins to take over:

- `bootstrap`
- `ingest`
- `assemble`
- `compact`
- `afterTurn`
- `prepareSubagentSpawn`
- `onSubagentEnded`

This is a better fit for OpenViking than the current memory plugin approach.

The existing memory plugin can:

- store memories
- auto-recall memories before a turn
- expose manual memory tools

But it cannot fully control how OpenClaw:

- decides what old context to keep
- compresses old turns
- mixes short-term continuity with long-term memory
- composes final model input

That limitation is exactly what the new `contextEngine` slot solves.

## 3. Problem Statement

We need an OpenClaw integration that:

- preserves recent turn continuity
- persists older session content into OpenViking
- extracts durable memories at the right time
- recalls the right blend of session history and long-term memory each turn
- leaves room for agent-driven deep retrieval when automatic recall is insufficient

We do not need, in v1, to solve:

- migration from old plugin versions
- full `lossless-claw`-style DAG expansion fidelity
- skill-file interception hacks
- exact replay of every historical tool block in the assembled prompt

### Current Runtime Constraint

In the current OpenClaw local-agent runtime, `contextEngine.assemble()` is
invoked before the newest user turn is available to the plugin.

Observed consequences:

- first-turn automatic recall can lag by one turn
- the plugin cannot depend on `assemble()` alone for immediate answers to new
  "what do you remember?" or "what is my preference?" questions

Short-term v1 policy:

- do not require upstream OpenClaw changes
- keep automatic assembled recall for continuity and next-turn recall
- bias the agent toward explicit `ov_recall` for direct memory questions
- treat OpenViking, not workspace `MEMORY.md`, as the primary durable memory source

## 4. Goals

### 4.1 Primary Goals

- Build `context-openviking` as an OpenClaw `contextEngine` plugin.
- Set `ownsCompaction = true` and move the main OpenViking integration path onto the context lifecycle.
- Use OpenViking session storage as the durable backing store for older OpenClaw turns.
- Use OpenViking memory extraction during compaction, not on every single message by default.
- Assemble prompt context directly from OpenViking, without relying on fake tool-call injection.
- Support both local and remote OpenViking deployment modes.

### 4.2 Secondary Goals

- Reuse as much of the current memory plugin infrastructure as possible.
- Keep optional manual tools for explicit memory commit, recall, forget, and expansion.
- Support future subagent-aware context lineage.

## 5. Non-Goals

- No backward migration design in this RFC.
- No requirement to preserve the exact behavior of the current `memory-openviking` auto-recall path.
- No `lossless-claw` DAG clone.
- No SKILL.md interception in v1.
- No requirement that all retrieval be represented as synthetic function-call traces.

## 6. Design Principles

1. OpenViking should remain OpenViking-native.
   The integration should map OpenClaw lifecycle events onto OpenViking's session, memory, retrieval, and layered-context model instead of rebuilding an alternate storage engine.

2. Compaction is the durable boundary.
   Durable memory extraction should happen mainly when old turns are compacted and archived.

3. Assembly should be explicit.
   The plugin should use `assemble()` to directly produce model context instead of relying on prompt mutation tricks as the main path.

4. Session continuity and long-term memory are different things.
   Session history recall and durable memory recall should be modeled separately, then merged during assembly.

5. Agentic recall is additive, not foundational.
   Automatic assembly should solve the common case. Tools should handle the hard case.

## 7. Comparison with `lossless-claw`

## 7.1 What `lossless-claw` does well

- Replaces OpenClaw compaction fully.
- Preserves every message in a dedicated local database.
- Builds a summary DAG optimized for deep in-session recall.
- Provides subagent-based expansion over compacted history.

## 7.2 Why we should not copy it directly

- It duplicates capabilities OpenViking already has in a different form.
- It is optimized for session-history compaction first, while OpenViking is optimized for a broader context plane:
  - session
  - memory
  - resource
  - skill
- A second local storage engine would split the product's architecture in two.
- A DAG-first design would delay shipping and create more maintenance burden than value for v1.

## 7.3 What we should borrow

- Treat `contextEngine` as the main integration point.
- Own compaction explicitly.
- Keep active recent turns separate from compressed older history.
- Provide an explicit path for deep, tool-driven recall when the default assembled context is insufficient.

## 8. Proposed Architecture

## 8.1 Plugin Identity

- Plugin id: `context-openviking`
- Plugin kind: `contextEngine`
- OpenClaw slot: `plugins.slots.contextEngine = "context-openviking"`
- Context engine info:
  - `id = "context-openviking"`
  - `name = "Context Engine (OpenViking)"`
  - `ownsCompaction = true`

## 8.2 Runtime Components

The plugin should contain these internal modules:

- `config.ts`
  - validates plugin config
- `client.ts`
  - OpenViking HTTP client and local-process bootstrap reuse
- `session-mirror.ts`
  - syncs OpenClaw session messages into OpenViking session storage
- `assembler.ts`
  - builds final `AssembleResult`
- `compactor.ts`
  - triggers OpenViking session commit/archive and compaction decisions
- `tools.ts`
  - optional agent-facing tools
- `subagents.ts`
  - parent-child session lineage helpers for future expansion

## 8.3 Context Sources

The engine assembles context from four sources:

1. Raw fresh tail from OpenClaw's active session
2. Archived session continuity from OpenViking session history
3. Durable user and agent memories from OpenViking memory spaces
4. Optional resource and skill context from OpenViking retrieval

## 9. Data Model

## 9.1 Session Mapping

Each OpenClaw session maps to one OpenViking session.

Recommended key mapping:

- OpenClaw `sessionId` or `sessionKey` -> OpenViking `session_id`
- Persist plugin metadata so the mapping is stable across process restarts

Required metadata:

- `openclaw_session_id`
- `openclaw_agent_id`
- `openclaw_user_id` if available
- `message_channel` if relevant

## 9.2 OpenViking Layout

The plugin should rely on existing OpenViking structures:

- `viking://session/<user-space>/<session-id>/messages.jsonl`
- `viking://session/<user-space>/<session-id>/history/archive_xxx/`
- `viking://user/<space>/memories/`
- `viking://agent/<space>/memories/`
- `viking://resources/`
- `viking://agent/<space>/skills/`

## 9.3 Archive Semantics

When compaction runs, OpenViking session archives become the primary durable representation for older conversation continuity.

Each archive should preserve:

- raw transcript at L2
- archive abstract at L0
- archive overview at L1

This gives us a tree-shaped, layered session history without introducing a new DAG store.

## 10. Lifecycle Design

## 10.1 `bootstrap()`

### Purpose

Initialize engine state for an OpenClaw session and reconcile any missed writes.

### Inputs

- `sessionId`
- `sessionFile`

### Behavior

1. Resolve or create the corresponding OpenViking session.
2. Read the OpenClaw session JSONL file.
3. Read the OpenViking mirrored session state.
4. Detect the last mirrored message boundary.
5. Import any missing suffix messages from OpenClaw into OpenViking.
6. Cache engine runtime state for this session.

### Result

- `bootstrapped = true` when initialization or reconciliation happened
- `importedMessages = N` when suffix backfill occurred

### Rationale

This gives us `lossless-claw`'s crash-recovery property without adding a new storage engine.

## 10.2 `ingest()`

### Purpose

Remain interface-compatible, but keep logic minimal.

### Decision

`ingest()` should be implemented as a lightweight no-op or append-only sync helper. The main synchronization point should be `afterTurn()`, not per-message ingest.

### Reason

OpenViking is more efficient when it receives a coherent turn batch instead of triggering extraction on every message.

## 10.3 `afterTurn()`

### Purpose

This is the main sync point for the current turn.

### Inputs

- `sessionId`
- `sessionFile`
- `messages`
- `prePromptMessageCount`
- `autoCompactionSummary`
- `tokenBudget`
- `runtimeContext`

### Behavior

1. Compute newly added messages since `prePromptMessageCount`.
2. Normalize them into OpenViking session message format.
3. Append them to the mirrored OpenViking session.
4. Record runtime usage metadata if available.
5. Optionally decide whether proactive compaction should be scheduled.
6. Do not extract durable memories here by default.

### Notes

- If a future mode wants near-real-time memory extraction, it can be added as an explicit option.
- Default behavior should keep `afterTurn()` cheap and deterministic.

## 10.4 `compact()`

### Purpose

Convert older session content into archived session history and durable memories.

### Inputs

- `sessionId`
- `sessionFile`
- `tokenBudget`
- `force`
- `currentTokenCount`
- `compactionTarget`
- `customInstructions`
- `runtimeContext`

### Behavior

1. Ensure the OpenViking mirror is synchronized with the latest session file.
2. Trigger OpenViking session `commit` for the mapped session.
3. Let OpenViking:
   - archive current message batch into `history/archive_xxx`
   - generate archive summary layers
   - extract durable long-term memories
4. Return a compact result indicating:
   - whether compaction ran
   - whether anything was archived
   - token estimates if available

### Working Memory Rule

Compaction may preserve a small working-memory block in the future, but v1 should not block on this.

### Key Design Choice

The compaction unit is not "summarize arbitrary message chunks into a separate LCM DAG." It is:

- archive old session content into OpenViking session history
- extract long-term durable memories at that boundary

## 10.5 `assemble()`

### Purpose

Build final model context directly.

### Inputs

- `sessionId`
- `messages`
- `tokenBudget`

### Output Shape

`AssembleResult` with:

- `messages`
- `estimatedTokens`
- optional `systemPromptAddition`

### High-Level Assembly Strategy

The assembled context should be built in this order:

1. `systemPromptAddition`
   - profile and operating hints
2. session continuity context
   - older conversation context from session history
3. durable memory context
   - user and agent memory
4. optional resource/skill context
   - only when triggered by heuristics
5. raw fresh tail
   - most recent OpenClaw messages

### Short-Term Runtime Policy

Because the current-turn user message may be unavailable during `assemble()`,
v1 should explicitly instruct the model to call `ov_recall` when the user asks:

- what the agent remembers
- what the user's preferences are
- what was previously said or decided

This is a deliberate short-term adaptation to current OpenClaw runtime order,
not the desired long-term architecture.

### Fresh Tail Rule

Always preserve the most recent raw turns uncompressed.

Initial config:

- `freshTailMessages = 16`

The exact value should remain configurable.

## 10.6 `prepareSubagentSpawn()` and `onSubagentEnded()`

### v1 Behavior

Implement lightweight lineage bookkeeping only.

Record:

- parent OpenClaw session
- child OpenClaw session
- mapped OpenViking session ids

This is enough to support future delegated expansion without making subagent logic a v1 blocker.

## 11. Assembly Algorithm

## 11.1 Context Buckets

`assemble()` should create four buckets:

### Bucket A: Profile

Injected via `systemPromptAddition`.

Sources:

- `profile.md`
- a small set of high-confidence durable memory summaries

Use only stable, reusable facts:

- user preferences
- communication style
- durable project constraints
- recurring agent preferences

For direct memory questions in v1, these buckets should be supplemented by an
agent-initiated `ov_recall` call when automatic assembly does not yet include
the current turn's question.

### Bucket B: Session Continuity

Primary source for "what happened earlier in this same conversation."

Query source:

- `viking://session/.../history`

Selection policy:

- start with L1 overviews for relevant archives
- expand to L2 archive transcript only when the retrieved overview is insufficient

### Bucket C: Durable Memory

Primary source for cross-session facts and preferences.

Query source:

- `viking://user/.../memories`
- `viking://agent/.../memories`

Selection policy:

- default to L0/L1
- expand to L2 leaf content only for top hits

### Bucket D: Resource and Skill

Only included when heuristics say the user task likely depends on external resources or skill knowledge.

Examples:

- codebase or document references
- "how do we usually do X"
- tool-specific operating knowledge

## 11.2 Retrieval Policy

### Default Retrieval Mode

Use `find()` first for low latency.

### Escalation Mode

Use `search()` only when:

- the user query is complex
- a multi-hop answer is likely needed
- the agent explicitly asks for deeper retrieval

### Query Construction

Default query material:

- latest user message
- optionally last 3 to 5 user messages

Do not blindly concatenate long recent history if it dilutes the search intent.

## 11.3 Heuristics

### Skip or minimize automatic retrieval when:

- the user says hello
- the message is too short to carry semantic intent
- the turn is clearly local and recent-tail-only

### Prefer session continuity retrieval when:

- the user says "earlier", "before", "you said", "we discussed"
- the question references the current ongoing thread

### Prefer durable memory retrieval when:

- the user asks about preferences, facts, prior decisions, or identity-like information

### Add resource/skill retrieval when:

- the prompt references a repo, document, tool workflow, or implementation pattern

## 11.4 Context Formatting

Automatic context should be injected as explicit context blocks, not fake tool-call traces.

Recommended formatting:

```text
<openviking-profile>
...
</openviking-profile>

<openviking-session-context>
...
</openviking-session-context>

<openviking-durable-memory>
...
</openviking-durable-memory>
```

This keeps assembly deterministic and avoids coupling core context delivery to tool-call emulation.

## 12. Agent-Facing Tools

Tools remain valuable, but they are not the primary assembly mechanism.

## 12.1 Required v1 Tools

### `ov_recall`

Search OpenViking across selected scopes:

- `session`
- `memory`
- `resource`
- `skill`

Parameters:

- `query`
- `scopes`
- `limit`
- `targetUri`
- `scoreThreshold`

### `ov_commit_memory`

Store explicit durable memory when the user clearly asks the agent to remember something.

Parameters:

- `content`
- `memoryType`
- `priority`
- `category`

### `ov_forget`

Delete or help identify a stored memory to delete.

### `ov_expand`

Expand a specific archive, memory, or resource from L0/L1 into richer L2 detail.

This is the OpenViking analogue to `lossless-claw`'s deeper recall path, but it should be implemented using OpenViking URIs instead of DAG node expansion.

## 12.2 Explicitly Deferred Tools

- SKILL.md read interception
- automatic tool-memory injection via prompt rewrites
- recursive delegated expansion toolchains

## 13. Configuration

## 13.1 Plugin Config Schema

Recommended initial config:

```json
{
  "mode": "remote",
  "baseUrl": "http://127.0.0.1:1933",
  "apiKey": "",
  "agentId": "",
  "timeoutMs": 10000,
  "freshTailMessages": 16,
  "profileEnabled": true,
  "autoRecallEnabled": true,
  "resourceRecallEnabled": true,
  "searchEscalationEnabled": true,
  "recallLimit": 8,
  "recallScoreThreshold": 0.35,
  "compactOnOverflow": true,
  "compactOnManual": true,
  "defaultSessionHistoryTargetUri": "viking://session",
  "defaultUserMemoryTargetUri": "viking://user/memories",
  "defaultAgentMemoryTargetUri": "viking://agent/memories"
}
```

## 13.2 Config Meaning

- `mode`
  - `local` or `remote`
- `freshTailMessages`
  - raw recent turns kept as-is
- `profileEnabled`
  - controls profile injection
- `autoRecallEnabled`
  - controls automatic session/memory recall in `assemble()`
- `resourceRecallEnabled`
  - allows resource/skill retrieval heuristics
- `searchEscalationEnabled`
  - allows escalation from `find()` to `search()`
- `recallLimit`
  - max items per retrieval bucket
- `recallScoreThreshold`
  - minimum score for automatic inclusion

## 14. OpenViking API Requirements

## 14.1 Existing APIs That Can Be Reused

Already available:

- `POST /api/v1/sessions`
- `GET /api/v1/sessions/{session_id}`
- `POST /api/v1/sessions/{session_id}/messages`
- `POST /api/v1/sessions/{session_id}/commit`
- `POST /api/v1/sessions/{session_id}/extract`
- `POST /api/v1/search/find`
- existing content read and filesystem APIs

These are enough to build v1.

## 14.2 Optional Follow-Up APIs

These are useful but not required before v1 development starts:

- a session-history-specific read/query helper
- an API that returns archive summaries plus token estimates
- a direct "expand this archive" endpoint
- a batched recall endpoint across session + memory scopes

## 15. Failure Handling

## 15.1 Bootstrap Failure

If OpenViking bootstrap fails:

- log clearly
- mark engine degraded
- fall back to minimal raw-tail assembly for the turn

Do not hard-crash the whole OpenClaw session unless configuration explicitly requires strict mode.

## 15.2 Retrieval Failure

If automatic retrieval fails:

- continue with fresh tail only
- omit OpenViking buckets
- keep the agent operational

## 15.3 Compaction Failure

If compaction fails:

- return `compacted = false`
- preserve raw session data
- allow a future retry

The plugin must never create a state where OpenClaw history is lost because OpenViking compaction failed.

## 16. Observability

The plugin should log structured events for:

- bootstrap reconciliation
- afterTurn sync count
- assemble bucket sizes
- retrieval scope and hit counts
- compaction start/finish/failure
- extracted durable memory counts
- subagent lineage creation and cleanup

Recommended log keys:

- `sessionId`
- `ovSessionId`
- `freshTailCount`
- `sessionContextCount`
- `memoryContextCount`
- `resourceContextCount`
- `estimatedTokens`
- `compactionReason`

## 17. Security and Isolation

- Reuse the existing local/remote API-key model from the current plugin.
- Preserve user/agent space isolation through OpenViking request context and URI scoping.
- Never issue unscoped cross-user retrieval.
- Subagent lineage must inherit only the minimum required context scope.

## 18. Testing Strategy

## 18.1 Unit Tests

- config validation
- session mapping logic
- bootstrap reconciliation suffix detection
- assemble bucket selection and budgeting
- retrieval heuristics
- compaction decision logic

## 18.2 Integration Tests

- local OpenViking mode startup
- remote mode connectivity
- session sync from OpenClaw to OpenViking
- compaction triggers archive creation and memory extraction
- assemble returns stable context with recent-tail preservation

## 18.3 End-to-End Tests

Scenarios:

1. Same-session continuity
   - earlier discussion can be recalled after compaction
2. Cross-session preference recall
   - explicit remembered preference appears in a later session
3. Resource-aware coding task
   - resource retrieval joins memory retrieval correctly
4. Degraded mode
   - OpenViking unavailable, agent still answers with fresh tail

## 19. Implementation Plan

## Phase 1: Plugin Skeleton and Session Mirror

Deliverables:

- `context-openviking` plugin scaffold
- local/remote client reuse
- session mapping
- `bootstrap()` reconciliation
- `afterTurn()` incremental sync

## Phase 2: Compaction and Assembly

Deliverables:

- `ownsCompaction = true`
- `compact()` -> OpenViking session commit
- `assemble()` with fresh-tail + session history + memory buckets
- profile injection via `systemPromptAddition`

## Phase 3: Agent Tools

Deliverables:

- `ov_recall`
- `ov_commit_memory`
- `ov_forget`
- `ov_expand`

## Phase 4: Subagent Lineage and Advanced Expansion

Deliverables:

- parent-child lineage tracking
- scoped archive expansion helpers
- optional `search()` escalation improvements

## 20. Acceptance Criteria

This RFC is considered implemented when all of the following are true:

1. OpenClaw can run with `plugins.slots.contextEngine = "context-openviking"`.
2. Recent turns remain available as raw context.
3. Older turns can be compacted into OpenViking session history.
4. Compaction extracts durable memories through OpenViking.
5. The engine assembles context directly without relying on fake tool-call injection.
6. The agent can actively recall and expand OpenViking context via explicit tools.
7. Local and remote deployment modes both work.

## 21. Open Questions

These should not block v1, but they should be tracked:

- Should session-history retrieval use only `find()` in v1, or allow `search()` for same-session recall?
- Should archive-level L1 overviews be further grouped into higher-level history overviews in v2?
- Should `ov_expand` return raw transcript slices, synthesized summaries, or both?
- Should we later preserve a compact working-memory block across compaction boundaries?

## 22. Final Recommendation

Proceed with `context-openviking` as a true OpenClaw context engine.

The implementation should:

- adopt OpenClaw's context lifecycle fully
- use OpenViking session history as the compressed continuity layer
- use OpenViking durable memory as the cross-session memory layer
- add optional explicit tools for deeper recall

It should not:

- remain centered on legacy memory-plugin hooks
- fake context assembly through synthetic tool traces
- reimplement `lossless-claw`'s storage engine

This keeps the design aligned with both OpenClaw's new plugin architecture and OpenViking's native context model.
