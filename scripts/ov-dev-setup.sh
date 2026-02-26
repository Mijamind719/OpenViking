#!/bin/bash
# OpenViking 开发环境快速设置脚本
# 使用方法: source scripts/ov-dev-setup.sh

# 获取脚本所在目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# OpenViking 开发快捷命令
alias ov="cd $PROJECT_ROOT"
alias ov-test="uv run pytest tests/ -v --no-cov"
alias ov-test-client="uv run pytest tests/client/ -v --no-cov"
alias ov-test-server="uv run pytest tests/server/ -v --no-cov"
alias ov-test-session="uv run pytest tests/session/ -v --no-cov"
alias ov-check="uv run ruff format openviking/ && uv run ruff check openviking/ --fix && uv run mypy openviking/"
alias ov-fmt="uv run ruff format openviking/"
alias ov-lint="uv run ruff check openviking/ --fix"
alias ov-sync="uv sync --all-extras"

# 配置文件路径
export OPENVIKING_CONFIG_FILE="$PROJECT_ROOT/ov.conf"
export PATH="$HOME/.local/bin:$PATH"

echo "OpenViking 开发环境已设置"
echo "可用命令: ov, ov-test, ov-test-client, ov-test-server, ov-check, ov-fmt, ov-lint, ov-sync"
