#!/usr/bin/env python3
"""
OpenClaw 记忆链路完整测试脚本

本脚本用于验证 OpenViking 记忆插件的完整链路是否符合
openclaw-context-engine-refactor.md 设计文档中的描述。

验证的关键链路:
1. afterTurn: 本轮消息无损写入 OpenViking session
2. assemble: 读取 profile/memories, 检索 user/agent memories, 组装上下文
3. compact: 调用 session.commit(), 归档消息, 提取长期记忆

测试流程:
Phase 1: 多轮对话 - 验证 afterTurn 写入
Phase 2: 查询 OpenViking 内部状态 - 验证数据持久化
Phase 3: 触发 Compact - 验证 commit 和记忆提取
Phase 4: 新会话验证 - 验证 assemble 召回能力

前提:
- OpenViking 服务已启动 (默认 http://127.0.0.1:8000)
- OpenClaw Gateway 已启动并配置了 OpenViking 插件

用法:
    python test-memory-chain.py
    python test-memory-chain.py --gateway http://127.0.0.1:18790 --openviking http://127.0.0.1:8000
    python test-memory-chain.py --phase chat        # 仅对话阶段
    python test-memory-chain.py --phase verify      # 仅验证阶段
    python test-memory-chain.py --phase inspect     # 仅检查 OpenViking 状态
    python test-memory-chain.py --verbose           # 详细输出

依赖:
    pip install requests rich
"""

import argparse
import json
import time
import uuid
from datetime import datetime
from typing import Any

import requests
from rich.console import Console
from rich.markdown import Markdown
from rich.panel import Panel
from rich.table import Table
from rich.tree import Tree

# ── 常量 ───────────────────────────────────────────────────────────────────

USER_ID = f"test-chain-{uuid.uuid4().hex[:8]}"
DISPLAY_NAME = "测试用户"
DEFAULT_GATEWAY = "http://127.0.0.1:18790"
DEFAULT_OPENVIKING = "http://127.0.0.1:8000"
AGENT_ID = "openclaw"

console = Console()

# ── 对话数据 ──────────────────────────────────────────────────────────────
# 设计为可触发 Compact 的对话量 (目标: 20轮或30k tokens)

CHAT_MESSAGES = [
    # 第1轮 — 建立身份和背景
    "你好，我是一个软件工程师，我叫张明，在一家科技公司工作。我主要负责后端服务开发，使用的技术栈是 Python 和 Go。最近我们在重构一个订单系统，遇到了不少挑战。",
    # 第2轮 — 技术细节1
    "关于订单系统的问题，主要是性能瓶颈。我们发现在高峰期，数据库连接池经常被耗尽。目前用的是 PostgreSQL，连接池大小设置的是100，但每秒峰值请求量有5000。你有什么建议吗？",
    # 第3轮 — 技术细节2
    "谢谢你的建议。我还想问一下，我们目前的缓存策略用的是 Redis，但缓存击穿的问题很严重。热点数据过期后，大量请求直接打到数据库。我们尝试过加互斥锁，但性能下降很多。",
    # 第4轮 — 项目偏好
    "对了，关于代码风格，我们团队更倾向于使用函数式编程的思想，尽量避免副作用。变量命名用 snake_case，文档用中文写。代码审查很严格，每个 PR 至少需要两人 review。",
    # 第5轮 — 日常工作
    "说到工作流程，我们每天早上9点站会，周三下午技术分享会。我一般上午写代码，下午处理 code review 和会议。晚上如果不加班，会看看技术书籍或者写写博客。",
    # 第6轮 — 学习偏好
    "我最近在学习分布式系统的设计，正在看《数据密集型应用系统设计》这本书。之前看完了《深入理解计算机系统》，收获很大。你有什么好的分布式系统学习资料推荐吗？",
    # 第7轮 — 项目进度
    "目前订单系统重构的进度大概完成了60%，还剩下支付模块和库存同步模块。支付模块比较复杂，需要对接多个支付渠道。我们打算用消息队列来解耦库存同步。",
    # 第8轮 — 技术选型
    "消息队列我们在 Kafka 和 RabbitMQ 之间犹豫。Kafka 吞吐量高，但运维复杂；RabbitMQ 功能丰富，但性能稍差。我们的消息量大概每天1000万条，你觉得选哪个好？",
    # 第9轮 — 团队信息
    "我们团队有8个人，3个后端、2个前端、1个测试、1个运维，还有1个产品经理。后端老王经验最丰富，遇到难题都找他。测试小李很细心，bug检出率很高。",
    # 第10轮 — 个人偏好
    "对了，跟我聊天的时候注意几点：我喜欢简洁直接的回答，不要太啰嗦；技术问题最好带代码示例；如果不确定的问题要说明，不要瞎编。谢谢！",
    # 第11轮 — 追加技术细节
    "补充一下，我们的监控用的是 Prometheus + Grafana，日志用 ELK Stack。最近在考虑引入链路追踪，OpenTelemetry 看起来不错，但不知道跟现有系统集成麻不麻烦。",
    # 第12轮 — 问题排查
    "昨天线上出了个诡异的 bug，某个接口偶发超时，但日志里看不出什么问题。后来发现是下游服务的连接数满了，但监控指标没配好，没报警。这种问题怎么预防比较好？",
]

VERIFY_QUESTIONS = [
    {
        "question": "我是做什么工作的？用什么技术栈？",
        "expected_keywords": ["软件工程师", "后端", "Python", "Go"],
        "test_hook": "assemble + memory recall",
    },
    {
        "question": "我们团队有什么工作习惯和代码规范？",
        "expected_keywords": ["函数式", "snake_case", "站会", "code review"],
        "test_hook": "assemble + memory recall",
    },
    {
        "question": "我最近在做什么项目？遇到了什么技术挑战？",
        "expected_keywords": ["订单系统", "性能瓶颈", "缓存击穿", "PostgreSQL"],
        "test_hook": "assemble + memory recall",
    },
    {
        "question": "跟我聊天有什么注意事项？",
        "expected_keywords": ["简洁", "代码示例", "不要瞎编"],
        "test_hook": "assemble + profile/preference recall",
    },
]


# ── OpenClaw Gateway API ──────────────────────────────────────────────────


def send_message(gateway_url: str, message: str, user_id: str) -> dict:
    """通过 OpenClaw Responses API 发送消息。"""
    resp = requests.post(
        f"{gateway_url}/v1/responses",
        json={"model": "openclaw", "input": message, "user": user_id},
        timeout=300,
    )
    resp.raise_for_status()
    return resp.json()


def extract_reply_text(data: dict) -> str:
    """从 Responses API 响应中提取助手回复文本。"""
    for item in data.get("output", []):
        if item.get("type") == "message" and item.get("role") == "assistant":
            for part in item.get("content", []):
                if part.get("type") in ("text", "output_text"):
                    return part.get("text", "")
    return "(无回复)"


# ── OpenViking API ────────────────────────────────────────────────────────


class OpenVikingInspector:
    """OpenViking 内部状态检查器"""

    def __init__(self, base_url: str, api_key: str = "", agent_id: str = AGENT_ID):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.agent_id = agent_id

    def _headers(self) -> dict:
        h = {"Content-Type": "application/json"}
        if self.api_key:
            h["X-API-Key"] = self.api_key
        if self.agent_id:
            h["X-OpenViking-Agent"] = self.agent_id
        return h

    def health_check(self) -> bool:
        """检查 OpenViking 服务健康状态"""
        try:
            resp = requests.get(f"{self.base_url}/health", timeout=5)
            return resp.status_code == 200
        except Exception:
            return False

    def get_session(self, session_id: str) -> dict | None:
        """获取 session 信息"""
        try:
            resp = requests.get(
                f"{self.base_url}/api/v1/sessions/{session_id}",
                headers=self._headers(),
                timeout=10,
            )
            if resp.status_code == 200:
                data = resp.json()
                return data.get("result", data)
            return None
        except Exception as e:
            console.print(f"[dim]获取 session 失败: {e}[/dim]")
            return None

    def get_session_messages(self, session_id: str) -> list | None:
        """获取 session 中的消息"""
        try:
            resp = requests.get(
                f"{self.base_url}/api/v1/sessions/{session_id}/messages",
                headers=self._headers(),
                timeout=10,
            )
            if resp.status_code == 200:
                data = resp.json()
                return data.get("result", data)
            return None
        except Exception as e:
            console.print(f"[dim]获取 session 消息失败: {e}[/dim]")
            return None

    def get_context_for_assemble(
        self, session_id: str, token_budget: int = 128000
    ) -> dict | None:
        """获取用于 assemble 的上下文"""
        try:
            resp = requests.get(
                f"{self.base_url}/api/v1/sessions/{session_id}/context-for-assemble?token_budget={token_budget}",
                headers=self._headers(),
                timeout=10,
            )
            if resp.status_code == 200:
                data = resp.json()
                return data.get("result", data)
            return None
        except Exception as e:
            console.print(f"[dim]获取 assemble 上下文失败: {e}[/dim]")
            return None

    def commit_session(self, session_id: str, wait: bool = True) -> dict | None:
        """手动触发 session commit"""
        try:
            resp = requests.post(
                f"{self.base_url}/api/v1/sessions/{session_id}/commit",
                headers=self._headers(),
                json={},
                timeout=120 if wait else 10,
            )
            if resp.status_code == 200:
                data = resp.json()
                result = data.get("result", data)

                if wait and result.get("task_id"):
                    task_id = result["task_id"]
                    deadline = time.time() + 120
                    while time.time() < deadline:
                        time.sleep(0.5)
                        task = self.get_task(task_id)
                        if task:
                            if task.get("status") == "completed":
                                result["status"] = "completed"
                                result["memories_extracted"] = task.get("result", {}).get(
                                    "memories_extracted", {}
                                )
                                return result
                            elif task.get("status") == "failed":
                                result["status"] = "failed"
                                result["error"] = task.get("error")
                                return result

                return result
            return None
        except Exception as e:
            console.print(f"[dim]commit session 失败: {e}[/dim]")
            return None

    def get_task(self, task_id: str) -> dict | None:
        """获取后台任务状态"""
        try:
            resp = requests.get(
                f"{self.base_url}/api/v1/tasks/{task_id}",
                headers=self._headers(),
                timeout=10,
            )
            if resp.status_code == 200:
                data = resp.json()
                return data.get("result", data)
            return None
        except Exception as e:
            console.print(f"[dim]获取任务状态失败: {e}[/dim]")
            return None

    def search_memories(
        self, query: str, target_uri: str = "viking://user/memories", limit: int = 10
    ) -> list:
        """搜索记忆"""
        try:
            resp = requests.post(
                f"{self.base_url}/api/v1/search/find",
                headers=self._headers(),
                json={"query": query, "target_uri": target_uri, "limit": limit},
                timeout=30,
            )
            if resp.status_code == 200:
                data = resp.json()
                result = data.get("result", data)
                return result.get("memories", [])
            return []
        except Exception as e:
            console.print(f"[dim]搜索记忆失败: {e}[/dim]")
            return []

    def list_fs(self, uri: str) -> list:
        """列出文件系统内容"""
        try:
            resp = requests.get(
                f"{self.base_url}/api/v1/fs/ls?uri={uri}&output=original",
                headers=self._headers(),
                timeout=10,
            )
            if resp.status_code == 200:
                data = resp.json()
                return data.get("result", data) if isinstance(data, dict) else data
            return []
        except Exception as e:
            console.print(f"[dim]列出 fs 失败: {e}[/dim]")
            return []


# ── 渲染函数 ──────────────────────────────────────────────────────────────


def render_reply(text: str, title: str = "回复"):
    """用 rich 渲染回复"""
    lines = text.split("\n")
    if len(lines) > 25:
        text = "\n".join(lines[:25]) + f"\n\n... (共 {len(lines)} 行，已截断)"
    console.print(Panel(Markdown(text), title=f"[green]{title}[/green]", border_style="green"))


def render_json(data: Any, title: str = "JSON"):
    """渲染 JSON 数据"""
    console.print(Panel(json.dumps(data, indent=2, ensure_ascii=False, default=str)[:2000], title=title))


def render_session_info(info: dict, title: str = "Session 信息"):
    """渲染 session 信息表格"""
    table = Table(title=title, show_header=True)
    table.add_column("属性", style="cyan")
    table.add_column("值", style="green")

    for key, value in info.items():
        if isinstance(value, dict):
            value = json.dumps(value, ensure_ascii=False)
        table.add_row(str(key), str(value))

    console.print(table)


def render_memories(memories: list, title: str = "记忆列表"):
    """渲染记忆列表"""
    if not memories:
        console.print(f"[dim]{title}: 无结果[/dim]")
        return

    table = Table(title=title, show_header=True)
    table.add_column("#", style="bold", width=3)
    table.add_column("URI", style="cyan", max_width=40)
    table.add_column("分类", style="yellow", width=12)
    table.add_column("分数", style="green", width=6)
    table.add_column("摘要", max_width=50)

    for i, mem in enumerate(memories[:10], 1):
        uri = mem.get("uri", "")
        category = mem.get("category", "-")
        score = f"{mem.get('score', 0):.2f}" if mem.get("score") else "-"
        abstract = (mem.get("abstract") or mem.get("overview") or "")[:50]
        table.add_row(str(i), uri[-40:] if len(uri) > 40 else uri, category, score, abstract)

    console.print(table)


# ── 测试阶段 ──────────────────────────────────────────────────────────────


def run_phase_chat(gateway_url: str, user_id: str, delay: float, verbose: bool):
    """Phase 1: 多轮对话 - 测试 afterTurn 写入"""
    console.print()
    console.rule(f"[bold]Phase 1: 多轮对话 ({len(CHAT_MESSAGES)} 轮) — 测试 afterTurn 写入[/bold]")
    console.print(f"[yellow]用户ID:[/yellow] {user_id}")
    console.print(f"[yellow]Gateway:[/yellow] {gateway_url}")
    console.print(f"[yellow]轮次间隔:[/yellow] {delay}s")
    console.print()
    console.print("[dim]根据设计文档 (3.2 afterTurn):[/dim]")
    console.print("[dim]- 每轮消息应无损写入 OpenViking session[/dim]")
    console.print("[dim]- Compact 触发条件: 75% budget / 30k tokens / 20 turns / 30min[/dim]")
    console.print()

    total = len(CHAT_MESSAGES)
    ok = fail = 0
    turn_times = []

    for i, msg in enumerate(CHAT_MESSAGES, 1):
        console.rule(f"[dim]Turn {i}/{total}[/dim]", style="dim")
        console.print(
            Panel(
                msg[:200] + ("..." if len(msg) > 200 else ""),
                title=f"[bold cyan]用户 [{i}/{total}][/bold cyan]",
                border_style="cyan",
            )
        )

        start_time = time.time()
        try:
            data = send_message(gateway_url, msg, user_id)
            elapsed = time.time() - start_time
            turn_times.append(elapsed)
            reply = extract_reply_text(data)
            render_reply(reply[:500] + ("..." if len(reply) > 500 else ""))
            ok += 1

            if verbose:
                console.print(f"[dim]响应时间: {elapsed:.2f}s[/dim]")

        except Exception as e:
            elapsed = time.time() - start_time
            turn_times.append(elapsed)
            console.print(f"[red][ERROR][/red] {e}")
            fail += 1

        if i < total:
            time.sleep(delay)

    console.print()
    avg_time = sum(turn_times) / len(turn_times) if turn_times else 0
    console.print(f"[yellow]对话完成:[/yellow] {ok} 成功, {fail} 失败")
    console.print(f"[yellow]平均响应时间:[/yellow] {avg_time:.2f}s")

    wait = max(delay * 2, 5)
    console.print(f"[yellow]等待 {wait:.0f}s 让 afterTurn 处理完成...[/yellow]")
    time.sleep(wait)

    return ok, fail


def run_phase_inspect(openviking_url: str, user_id: str, verbose: bool):
    """Phase 2: 检查 OpenViking 内部状态 - 验证数据持久化"""
    console.print()
    console.rule("[bold]Phase 2: 检查 OpenViking 内部状态 — 验证数据持久化[/bold]")

    inspector = OpenVikingInspector(openviking_url)

    # 健康检查
    console.print("\n[bold]2.1 健康检查[/bold]")
    if not inspector.health_check():
        console.print("[red]OpenViking 服务不可用![/red]")
        return False

    console.print("[green]OpenViking 服务正常[/green]")

    # Session 状态
    console.print("\n[bold]2.2 Session 状态检查[/bold]")
    session_info = inspector.get_session(user_id)
    if session_info:
        render_session_info(session_info, f"Session: {user_id}")
        console.print()
        console.print("[dim]验证点:[/dim]")
        console.print(
            f"  - message_count: {session_info.get('message_count', 0)} (期望 > 0 表示 afterTurn 写入成功)"
        )
        console.print(
            f"  - pending_tokens: {session_info.get('pending_tokens', 0)} (未 commit 的 token 数)"
        )
        console.print(
            f"  - commit_count: {session_info.get('commit_count', 0)} (已 commit 次数)"
        )
    else:
        console.print(f"[yellow]Session {user_id} 不存在或无法获取[/yellow]")

    # assemble 上下文
    console.print("\n[bold]2.3 Context-for-Assemble 检查[/bold]")
    ctx = inspector.get_context_for_assemble(user_id)
    if ctx:
        console.print(f"[dim]archives: {len(ctx.get('archives', []))} 个[/dim]")
        console.print(f"[dim]messages: {len(ctx.get('messages', []))} 条[/dim]")
        console.print(f"[dim]estimatedTokens: {ctx.get('estimatedTokens', 0)}[/dim]")
        if ctx.get("stats"):
            console.print(f"[dim]stats: {ctx['stats']}[/dim]")
    else:
        console.print("[yellow]无法获取 assemble 上下文[/yellow]")

    # 记忆搜索
    console.print("\n[bold]2.4 记忆搜索测试[/bold]")
    test_queries = ["后端开发 技术栈", "订单系统 性能优化", "代码规范 团队习惯"]

    for query in test_queries:
        console.print(f"\n[cyan]Query: {query}[/cyan]")
        memories = inspector.search_memories(query, "viking://user/memories", 5)
        render_memories(memories, f"user/memories 结果")

        if verbose:
            agent_memories = inspector.search_memories(query, "viking://agent/memories", 3)
            render_memories(agent_memories, f"agent/memories 结果")

    return True


def run_phase_compact(openviking_url: str, user_id: str, verbose: bool):
    """Phase 3: 手动触发 Compact - 验证 commit 和记忆提取"""
    console.print()
    console.rule("[bold]Phase 3: 手动触发 Compact — 验证 session.commit()[/bold]")
    console.print()
    console.print("[dim]根据设计文档 (3.4 compact):[/dim]")
    console.print("[dim]- 调用 session.commit() 触发归档和记忆提取[/dim]")
    console.print("[dim]- 应返回 archived=true, memories_extracted > 0[/dim]")
    console.print()

    inspector = OpenVikingInspector(openviking_url)

    # 触发 compact
    console.print("[bold]3.1 执行 session.commit()[/bold]")
    console.print(f"[dim]Session ID: {user_id}[/dim]")
    console.print("[dim]正在等待 commit 完成 (可能需要 1-2 分钟)...[/dim]")

    commit_result = inspector.commit_session(user_id, wait=True)

    if commit_result:
        render_json(commit_result, "Commit 结果")

        console.print("\n[bold]验证点:[/bold]")
        status = commit_result.get("status", "unknown")
        archived = commit_result.get("archived", False)
        memories = commit_result.get("memories_extracted", {})

        status_ok = status in ("completed", "accepted")
        console.print(f"  - status: {status} {'[green]✓[/green]' if status_ok else '[red]✗[/red]'}")
        console.print(f"  - archived: {archived} {'[green]✓[/green]' if archived else '[yellow]○[/yellow]'}")

        if memories:
            total_mem = sum(memories.values())
            console.print(f"  - memories_extracted: {total_mem} 条")
            for cat, count in memories.items():
                console.print(f"      - {cat}: {count}")
        else:
            console.print("  - memories_extracted: 0 条 [yellow](可能内容不足以提取)[/yellow]")
    else:
        console.print("[red]Commit 失败或超时[/red]")

    # 检查 commit 后的状态
    console.print("\n[bold]3.2 Commit 后状态检查[/bold]")
    session_info = inspector.get_session(user_id)
    if session_info:
        render_session_info(session_info, "Commit 后 Session 状态")

    return True


def run_phase_verify(gateway_url: str, user_id: str, delay: float, verbose: bool):
    """Phase 4: 新会话验证 - 验证 assemble 召回能力"""
    console.print()
    console.rule(
        f"[bold]Phase 4: 新会话验证 ({len(VERIFY_QUESTIONS)} 轮) — 测试 assemble 记忆召回[/bold]"
    )
    console.print()
    console.print("[dim]根据设计文档 (3.3 assemble):[/dim]")
    console.print("[dim]- 读取 profile / stable memories[/dim]")
    console.print("[dim]- 并行检索 viking://user/memories 与 viking://agent/memories[/dim]")
    console.print("[dim]- 组装成新的 messages 返回给 OpenClaw[/dim]")
    console.print()

    # 使用新的 user_id 确保是新会话
    verify_user = f"{user_id}-verify-{uuid.uuid4().hex[:4]}"
    console.print(f"[yellow]验证用户:[/yellow] {verify_user} (新 session，无对话历史)")
    console.print()

    results = []
    total = len(VERIFY_QUESTIONS)

    for i, item in enumerate(VERIFY_QUESTIONS, 1):
        q = item["question"]
        expected = item["expected_keywords"]
        hook = item["test_hook"]

        console.rule(f"[dim]验证 {i}/{total}[/dim]", style="dim")
        console.print(
            Panel(
                f"{q}\n\n[dim]期望关键词: {', '.join(expected)}[/dim]\n[dim]测试 Hook: {hook}[/dim]",
                title=f"[bold cyan]验证问题 [{i}/{total}][/bold cyan]",
                border_style="cyan",
            )
        )

        try:
            data = send_message(gateway_url, q, verify_user)
            reply = extract_reply_text(data)
            render_reply(reply)

            # 检查关键词命中
            reply_lower = reply.lower()
            hits = [kw for kw in expected if kw.lower() in reply_lower]
            miss = [kw for kw in expected if kw.lower() not in reply_lower]

            hit_rate = len(hits) / len(expected) if expected else 0
            success = hit_rate >= 0.5

            console.print(f"\n[dim]关键词检查:[/dim]")
            console.print(f"  命中: {', '.join(hits) if hits else '无'}")
            console.print(f"  未命中: {', '.join(miss) if miss else '无'}")
            console.print(
                f"  命中率: {hit_rate:.0%} {'[green]✓[/green]' if success else '[red]✗[/red]'}"
            )

            results.append(
                {
                    "question": q,
                    "expected": expected,
                    "hits": hits,
                    "miss": miss,
                    "hit_rate": hit_rate,
                    "success": success,
                }
            )
        except Exception as e:
            console.print(f"[red][ERROR][/red] {e}")
            results.append(
                {
                    "question": q,
                    "expected": expected,
                    "hits": [],
                    "miss": expected,
                    "hit_rate": 0,
                    "success": False,
                    "error": str(e),
                }
            )

        if i < total:
            time.sleep(delay)

    # 汇总
    console.print()
    console.rule("[bold]验证结果汇总[/bold]")

    table = Table(title="记忆召回验证结果")
    table.add_column("#", style="bold", width=3)
    table.add_column("状态", width=6)
    table.add_column("命中率", width=8)
    table.add_column("问题", max_width=40)
    table.add_column("期望关键词", max_width=30)

    for i, r in enumerate(results, 1):
        status = "[green]PASS[/green]" if r["success"] else "[red]FAIL[/red]"
        hit_rate = f"{r['hit_rate']:.0%}"
        table.add_row(
            str(i), status, hit_rate, r["question"][:40], ", ".join(r["expected"])[:30]
        )

    console.print(table)

    passed = sum(1 for r in results if r["success"])
    console.print(f"\n[yellow]通过: {passed}/{total}[/yellow]")

    return results


def run_full_test(
    gateway_url: str, openviking_url: str, user_id: str, delay: float, verbose: bool
):
    """运行完整测试流程"""
    console.print()
    console.print(Panel.fit(
        f"[bold]OpenClaw 记忆链路完整测试[/bold]\n\n"
        f"Gateway: {gateway_url}\n"
        f"OpenViking: {openviking_url}\n"
        f"User ID: {user_id}\n"
        f"时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
        title="测试信息",
    ))

    # 构建测试报告
    report = {
        "start_time": datetime.now().isoformat(),
        "user_id": user_id,
        "gateway_url": gateway_url,
        "openviking_url": openviking_url,
        "phases": {},
    }

    # Phase 1: 多轮对话
    chat_ok, chat_fail = run_phase_chat(gateway_url, user_id, delay, verbose)
    report["phases"]["chat"] = {"ok": chat_ok, "fail": chat_fail}

    # Phase 2: 检查内部状态
    inspect_ok = run_phase_inspect(openviking_url, user_id, verbose)
    report["phases"]["inspect"] = {"ok": inspect_ok}

    # Phase 3: 触发 Compact
    compact_ok = run_phase_compact(openviking_url, user_id, verbose)
    report["phases"]["compact"] = {"ok": compact_ok}

    # 等待记忆抽取完成
    console.print("\n[yellow]等待 10s 让记忆提取完全完成...[/yellow]")
    time.sleep(10)

    # Phase 4: 新会话验证
    verify_results = run_phase_verify(gateway_url, user_id, delay, verbose)
    report["phases"]["verify"] = {
        "results": verify_results,
        "passed": sum(1 for r in verify_results if r["success"]),
        "total": len(verify_results),
    }

    report["end_time"] = datetime.now().isoformat()

    # 最终报告
    console.print()
    console.rule("[bold]测试完成[/bold]")

    tree = Tree("[bold]测试报告[/bold]")

    chat_branch = tree.add(f"Phase 1: 多轮对话 - {'✓' if chat_fail == 0 else '✗'}")
    chat_branch.add(f"成功: {chat_ok}, 失败: {chat_fail}")

    inspect_branch = tree.add(f"Phase 2: 状态检查 - {'✓' if inspect_ok else '✗'}")

    compact_branch = tree.add(f"Phase 3: Compact - {'✓' if compact_ok else '✗'}")

    verify_branch = tree.add(
        f"Phase 4: 新会话验证 - {report['phases']['verify']['passed']}/{report['phases']['verify']['total']}"
    )
    for i, r in enumerate(verify_results, 1):
        status = "✓" if r["success"] else "✗"
        verify_branch.add(f"Q{i}: {status} ({r['hit_rate']:.0%})")

    console.print(tree)

    return report


# ── 入口 ───────────────────────────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(
        description="OpenClaw 记忆链路完整测试",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
    python test-memory-chain.py
    python test-memory-chain.py --gateway http://127.0.0.1:18790
    python test-memory-chain.py --phase chat
    python test-memory-chain.py --verbose
        """,
    )
    parser.add_argument(
        "--gateway",
        default=DEFAULT_GATEWAY,
        help=f"OpenClaw Gateway 地址 (默认: {DEFAULT_GATEWAY})",
    )
    parser.add_argument(
        "--openviking",
        default=DEFAULT_OPENVIKING,
        help=f"OpenViking 服务地址 (默认: {DEFAULT_OPENVIKING})",
    )
    parser.add_argument(
        "--user-id",
        default=USER_ID,
        help=f"测试用户ID (默认: 随机生成)",
    )
    parser.add_argument(
        "--phase",
        choices=["all", "chat", "inspect", "compact", "verify"],
        default="all",
        help="运行阶段: all=全部, chat=对话, inspect=检查状态, compact=触发compact, verify=验证召回 (默认: all)",
    )
    parser.add_argument(
        "--delay",
        type=float,
        default=2.0,
        help="轮次间等待秒数 (默认: 2)",
    )
    parser.add_argument(
        "--verbose", "-v",
        action="store_true",
        help="详细输出",
    )
    args = parser.parse_args()

    gateway_url = args.gateway.rstrip("/")
    openviking_url = args.openviking.rstrip("/")
    user_id = args.user_id

    console.print(f"[bold]OpenClaw 记忆链路测试[/bold]")
    console.print(f"[yellow]Gateway:[/yellow] {gateway_url}")
    console.print(f"[yellow]OpenViking:[/yellow] {openviking_url}")
    console.print(f"[yellow]User ID:[/yellow] {user_id}")

    if args.phase == "all":
        run_full_test(gateway_url, openviking_url, user_id, args.delay, args.verbose)
    elif args.phase == "chat":
        run_phase_chat(gateway_url, user_id, args.delay, args.verbose)
    elif args.phase == "inspect":
        run_phase_inspect(openviking_url, user_id, args.verbose)
    elif args.phase == "compact":
        run_phase_compact(openviking_url, user_id, args.verbose)
    elif args.phase == "verify":
        run_phase_verify(gateway_url, user_id, args.delay, args.verbose)

    console.print("\n[yellow]测试结束。[/yellow]")


if __name__ == "__main__":
    main()
