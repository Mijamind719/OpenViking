# OpenViking Development Workflow

OpenViking 项目开发工作流技能 - 用于功能开发、测试验证和 PR 提交。

## 触发条件

当用户请求以下任务时自动激活：
- 开发新功能
- 修复 Bug
- 代码重构
- 创建 PR
- 运行测试
- 代码检查

## 环境要求

- Python 3.10+
- uv 包管理器
- Go 1.25+ (可选，用于 AGFS)
- Rust (可选，用于 CLI)

## 项目结构

```
OpenViking/
├── openviking/          # 核心 Python SDK
├── openviking_cli/      # Python CLI 客户端
├── crates/ov_cli/       # Rust CLI
├── src/                 # C++ 扩展
├── tests/               # 测试套件
│   ├── client/          # 客户端测试
│   ├── server/          # 服务端测试
│   ├── session/         # 会话测试
│   ├── vectordb/        # 向量数据库测试
│   └── integration/     # 集成测试
├── pyproject.toml       # Python 项目配置
└── ov.conf              # 本地配置文件 (含 API Key)
```

## 开发工作流

### Phase 1: 环境初始化

```bash
# 安装依赖
uv sync --all-extras

# 设置配置文件路径
export OPENVIKING_CONFIG_FILE="/path/to/OpenViking/ov.conf"

# 验证环境
uv run python -c "import openviking; print('OK')"
uv run pytest tests/client/test_lifecycle.py -v --no-cov
```

### Phase 2: 功能开发

```bash
# 1. 创建功能分支
git checkout -b feature/xxx

# 2. 编写代码...

# 3. 运行相关测试
uv run pytest tests/client/ -v --no-cov

# 4. 代码格式化和检查
uv run ruff format openviking/
uv run ruff check openviking/ --fix
uv run mypy openviking/
```

### Phase 3: 提交代码

```bash
# 1. 查看变更
git status && git diff

# 2. 提交 (使用 Conventional Commits)
git add <files>
git commit -m "feat(scope): description"

# 3. 推送到 fork
git push -u <remote> feature/xxx

# 4. 创建 PR
gh pr create --title "feat: xxx" --body "..."
```

## Commit 规范

使用 Conventional Commits 格式：

| 类型 | 说明 |
|------|------|
| `feat` | 新功能 |
| `fix` | Bug 修复 |
| `docs` | 文档更新 |
| `refactor` | 代码重构 |
| `test` | 测试相关 |
| `chore` | 构建/工具 |

示例：
```
feat(retrieve): 添加混合检索支持
fix(client): 修复初始化时的竞态条件
docs: 更新 README 使用说明
```

## 测试命令

```bash
# 客户端测试
uv run pytest tests/client/ -v --no-cov

# 服务端测试
uv run pytest tests/server/ -v --no-cov

# 会话测试
uv run pytest tests/session/ -v --no-cov

# 完整测试 + 覆盖率
uv run pytest tests/ -v --cov=openviking --cov-report=html
```

## 代码质量命令

```bash
# 格式化
uv run ruff format openviking/ openviking_cli/

# Lint 检查
uv run ruff check openviking/ openviking_cli/ --fix

# 类型检查
uv run mypy openviking/

# 全部检查
uv run ruff format openviking/ && uv run ruff check openviking/ --fix && uv run mypy openviking/
```

## Shell 别名 (推荐添加到 ~/.zshrc)

```bash
# OpenViking 开发快捷命令
alias ov='cd /path/to/OpenViking'
alias ov-test='uv run pytest tests/ -v --no-cov'
alias ov-test-client='uv run pytest tests/client/ -v --no-cov'
alias ov-test-server='uv run pytest tests/server/ -v --no-cov'
alias ov-check='uv run ruff format openviking/ && uv run ruff check openviking/ --fix && uv run mypy openviking/'
alias ov-fmt='uv run ruff format openviking/'
alias ov-lint='uv run ruff check openviking/ --fix'
alias ov-sync='uv sync --all-extras'

# 配置文件路径
export OPENVIKING_CONFIG_FILE="/path/to/OpenViking/ov.conf"
export PATH="$HOME/.local/bin:$PATH"
```

## PR 检查清单

提交 PR 前确认：

- [ ] 代码通过 `ruff format` 格式化
- [ ] 代码通过 `ruff check` 检查
- [ ] 代码通过 `mypy` 类型检查
- [ ] 新功能有对应测试
- [ ] 测试覆盖率 >= 80%
- [ ] Commit 信息符合规范
- [ ] PR 描述清晰说明改动内容

## 分支策略

```
main               # 主分支，稳定代码
├── feature/xxx    # 功能开发分支
├── fix/xxx        # Bug 修复分支
├── refactor/xxx   # 重构分支
└── docs/xxx       # 文档更新分支
```

## 常见问题

### Q: 测试需要配置文件？
A: 设置环境变量 `export OPENVIKING_CONFIG_FILE="/path/to/ov.conf"`

### Q: pre-commit 钩子失败？
A: 运行 `uv run ruff format . && uv run ruff check . --fix` 修复后再提交

### Q: 如何跳过 pre-commit？
A: `git commit --no-verify -m "xxx"` (不推荐)
