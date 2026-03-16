# OpenClaw Context Plugin (OpenViking)

This plugin adapts the previous hook-based OpenViking memory behavior to the OpenClaw ContextEngine lifecycle:

- `before_prompt_build`: auto-recall + ingest-reply-assist injection
- `assemble`: pass-through (kept minimal to avoid modifying original message context)
- `afterTurn`: auto-capture and memory extraction
- `compact`: delegates to OpenClaw legacy compact engine when available

Business logic is kept aligned with the old memory plugin. Only the integration surface is adapted to ContextEngine.

## Install

```bash
mkdir -p ~/.openclaw/extensions/openclaw-context-plugin
cp /data0/wlf/OpenViking/examples/openclaw-context-plugin/{index.ts,context-engine.ts,config.ts,client.ts,process-manager.ts,memory-ranking.ts,text-utils.ts,openclaw.plugin.json,package.json,tsconfig.json,.gitignore} \
  ~/.openclaw/extensions/openclaw-context-plugin/
cd ~/.openclaw/extensions/openclaw-context-plugin
npm install
```

## Configure

```bash
openclaw config set plugins.enabled true
openclaw config set plugins.slots.contextEngine openclaw-context-plugin
openclaw config set plugins.entries.openclaw-context-plugin.config.mode "local"
openclaw config set plugins.entries.openclaw-context-plugin.config.configPath "~/.openviking/ov.conf"
openclaw config set plugins.entries.openclaw-context-plugin.config.autoRecall true --json
openclaw config set plugins.entries.openclaw-context-plugin.config.autoCapture true --json
```

Remote mode example:

```bash
openclaw config set plugins.entries.openclaw-context-plugin.config.mode "remote"
openclaw config set plugins.entries.openclaw-context-plugin.config.baseUrl "http://your-openviking:1933"
openclaw config set plugins.entries.openclaw-context-plugin.config.apiKey "${OPENVIKING_API_KEY}"
```

## Notes

- Tools are preserved: `memory_recall`, `memory_store`, `memory_forget`.
- For local mode, the plugin starts OpenViking as a subprocess.
