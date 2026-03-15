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
cd examples/openclaw-context-plugin
openclaw --dev plugins install .
openclaw --dev config set plugins.enabled true --json
openclaw --dev config set plugins.slots.contextEngine context-openviking
```

Optional local checks:

```bash
npm install
npm run typecheck
```

Quick install helpers:

```bash
./install.sh
```

```powershell
./install.ps1
```

For remote mode:

```bash
openclaw --dev config set plugins.entries.context-openviking.config.mode remote
openclaw --dev config set plugins.entries.context-openviking.config.baseUrl "http://your-server:1933"
```

For local mode:

```bash
openclaw --dev config set plugins.entries.context-openviking.config.mode local
openclaw --dev config set plugins.entries.context-openviking.config.configPath "~/.openviking/ov.conf"
```

More detailed setup notes:

- English: `INSTALL.md`
- 中文: `INSTALL-ZH.md`
