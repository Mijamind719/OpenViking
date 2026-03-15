# Install OpenViking Context Engine for OpenClaw

This plugin wires OpenViking into OpenClaw's `contextEngine` slot.

It is the lifecycle-oriented integration path and is intended to replace the
older memory-only integration when you want OpenViking to participate in:

- session bootstrap
- turn synchronization
- assembled context
- compaction

## Requirements

- OpenClaw `2026.3.7` or newer
- Node.js `>= 22`
- Python `>= 3.10` when using local OpenViking mode
- A working OpenViking deployment, either:
  - local: the plugin starts OpenViking
  - remote: the plugin connects to an existing OpenViking HTTP server

## Install From This Repository

```bash
cd /path/to/OpenViking/examples/openclaw-context-plugin
openclaw --dev plugins install .
```

The `--dev` profile is recommended for first verification because it isolates
state under `~/.openclaw-dev`.

Optional local check:

```bash
npm install
npm run typecheck
```

## Enable The Context Engine

```bash
openclaw --dev config set plugins.enabled true --json
openclaw --dev config set plugins.slots.contextEngine context-openviking
```

## Remote Mode

```bash
openclaw --dev config set plugins.entries.context-openviking.config.mode remote
openclaw --dev config set plugins.entries.context-openviking.config.baseUrl "http://127.0.0.1:1933"
openclaw --dev config set plugins.entries.context-openviking.config.apiKey "your-api-key"
openclaw --dev config set plugins.entries.context-openviking.config.agentId "openclaw-default"
```

## Local Mode

```bash
openclaw --dev config set plugins.entries.context-openviking.config.mode local
openclaw --dev config set plugins.entries.context-openviking.config.configPath "~/.openviking/ov.conf"
openclaw --dev config set plugins.entries.context-openviking.config.port 1933
```

When local mode is active, the plugin starts OpenViking on demand during plugin
service startup.

## Verify

```bash
openclaw --dev plugins info context-openviking
openclaw --dev plugins doctor
```

If the plugin is selected as the active context engine, OpenClaw will use it to
bootstrap, assemble, and compact session context.
