# OpenClaw + OpenViking Context Engine

Use OpenViking as an OpenClaw `contextEngine`.

This plugin is the new lifecycle-driven integration path. Unlike the legacy
memory plugin, it participates in:

- session bootstrap
- turn sync
- context assembly
- compaction

## Current Status

This is the first development cut of the plugin skeleton. It already aims to
support:

- local and remote OpenViking modes
- session mirroring into OpenViking sessions
- OpenViking-backed compaction via session commit
- assembled context with:
  - recent raw tail
  - session continuity
  - durable memory
- explicit tools:
  - `ov_recall`
  - `ov_commit_memory`
  - `ov_forget`
  - `ov_expand`

## Manual Dev Install

```bash
mkdir -p ~/.openclaw/extensions/context-openviking
cp examples/openclaw-context-plugin/{index.ts,config.ts,client.ts,process-manager.ts,heuristics.ts,formatters.ts,session-mirror.ts,types.ts,openclaw.plugin.json,package.json,README.md} \
  ~/.openclaw/extensions/context-openviking/
cd ~/.openclaw/extensions/context-openviking && npm install

openclaw plugins enable context-openviking
openclaw config set plugins.slots.contextEngine context-openviking
```

For remote mode:

```bash
openclaw config set plugins.entries.context-openviking.config.mode remote
openclaw config set plugins.entries.context-openviking.config.baseUrl "http://your-server:1933"
```

For local mode:

```bash
openclaw config set plugins.entries.context-openviking.config.mode local
openclaw config set plugins.entries.context-openviking.config.configPath "~/.openviking/ov.conf"
```
