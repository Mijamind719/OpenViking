# 为 OpenClaw 安装 OpenViking Context Engine

这个插件把 OpenViking 接到 OpenClaw 的 `contextEngine` 槽位里。

和旧的 memory plugin 不同，它会直接参与：

- session bootstrap
- turn sync
- context assemble
- compaction

## 环境要求

- OpenClaw `2026.3.7` 或更新版本
- Node.js `>= 22`
- 本地模式下需要 Python `>= 3.10`
- 一个可用的 OpenViking 服务：
  - `local`：插件自动拉起本地 OpenViking
  - `remote`：插件连接已有 OpenViking HTTP 服务

## 从仓库安装

```bash
cd /path/to/OpenViking/examples/openclaw-context-plugin
openclaw --dev plugins install .
```

首次验证建议使用 `--dev`，这样会把状态隔离在 `~/.openclaw-dev` 下，不影响你当前主环境。

可选的本地静态检查：

```bash
npm install
npm run typecheck
```

## 启用 Context Engine

```bash
openclaw --dev config set plugins.enabled true --json
openclaw --dev config set plugins.slots.contextEngine context-openviking
```

## 远端模式

```bash
openclaw --dev config set plugins.entries.context-openviking.config.mode remote
openclaw --dev config set plugins.entries.context-openviking.config.baseUrl "http://127.0.0.1:1933"
openclaw --dev config set plugins.entries.context-openviking.config.apiKey "your-api-key"
openclaw --dev config set plugins.entries.context-openviking.config.agentId "openclaw-default"
```

## 本地模式

```bash
openclaw --dev config set plugins.entries.context-openviking.config.mode local
openclaw --dev config set plugins.entries.context-openviking.config.configPath "~/.openviking/ov.conf"
openclaw --dev config set plugins.entries.context-openviking.config.port 1933
```

本地模式下，插件会在 service 启动时按需拉起 OpenViking。

## 验证

```bash
openclaw --dev plugins info context-openviking
openclaw --dev plugins doctor
```

当 `plugins.slots.contextEngine` 指向 `context-openviking` 后，OpenClaw 就会把它作为会话上下文装配和压缩引擎来使用。
