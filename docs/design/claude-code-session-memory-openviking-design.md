# Claude Code Session Memory 调研与 OpenViking 工作记忆设计 v1

## 文档目标

这份文档用于沉淀 Claude Code 中 `session memory` 的实现原理，并基于当前调研结果，给出一个适合在 OpenViking 中以 openclaw 插件形式落地的“工作记忆”第一版设计。

本文重点回答 4 个问题：

1. Claude Code 里的 `session memory` 到底是什么
2. 它和 transcript 的边界是什么
3. 它如何参与 compact 和 resume
4. 如果在 OpenViking 里实现同类能力，最小可行版本和完整版应该怎么拆

本文是第一版设计文档，目标是帮助后续理解和迭代，不追求一次性定稿。

本文只讨论工作记忆，不展开 Claude Code 的 `MEMORY.md`、OpenViking 的 `user/agent memories` 这类长期记忆系统；它们只在必要处作为边界说明出现。

## Session Memory 设计原则

Claude Code 的 `session memory` 不是一个通用 memory 框架，而是一份“当前会话的工作笔记”。

它的核心作用不是“给模型记住所有历史”，而是：

- 把当前 session 中已经完成的大部分上下文整理成一份结构化摘要
- 在上下文接近上限时，用这份摘要替代旧消息
- 同时保留最近还需要继续工作的消息尾部
- 在 resume 时通过 transcript 中的边界元数据把“摘要 + 最近尾部”重新拼成可继续工作的链

一句话概括：

`session memory = transcript 之上的、面向 compact/resume 的结构化工作摘要层`

从设计上看，它依赖几个关键原则：

- `transcript` 永远是真相源，`summary.md` 只是派生出的工作摘要
- 工作记忆必须是固定结构、可持续修订的文档，而不是自由摘要
- 工作记忆要和 `lastSummarizedMessageId`、`preservedSegment` 这类边界元数据绑定，才能安全参与 compact
- 摘要不能单独工作，必须配合 recent tail 原文一起维持继续执行能力
- 这份工作记忆只能由主会话主线维护，不能混入并行代理的局部过程

## 工作记忆与原始历史必须分开理解

Claude Code 里最容易混淆的是两层东西：

### 1. Transcript

这是完整会话日志，是真相源。

- 持续写入 jsonl
- 记录 user / assistant / system / attachment 等消息
- 是 resume 的基础
- 即使生成了 session memory，也不会丢弃 transcript

关键位置：

- `src/QueryEngine.ts:436`
- `src/utils/sessionStorage.ts:1408`
- `src/utils/sessionStorage.ts:3472`

### 2. Session Memory

这是当前 session 专属的结构化工作摘要。

- 每个 `sessionId` 一份
- 文件路径为 `.../{sessionId}/session-memory/summary.md`
- 会被后台持续更新
- 主要用于 compact、resume 之后继续干活、away summary 等

关键位置：

- `src/utils/permissions/filesystem.ts:261`
- `src/services/SessionMemory/sessionMemory.ts:183`
- `src/services/compact/sessionMemoryCompact.ts:514`

这里顺手补一句边界：Claude Code 里另有一套跨 session 的长期记忆系统 `MEMORY.md`，但它不属于本文讨论范围，也不是 `session memory` 的实现主体。

## Session Memory 的真实定位

从实现上看，Claude Code 并不把 `summary.md` 当成“新的主历史”，而是把它当成：

- 对 transcript 的阶段性总结
- 对 compact 的输入
- 对 resume 后继续工作的辅助上下文

所以它不是：

- 每轮都注入系统 prompt 的固定 memory
- 当前会话的唯一历史来源
- 通用的知识库存储

它更像一份“活着的工作笔记”，会随着会话推进持续修订。

## Session Memory(summary.md)

默认模板定义在：

- `src/services/SessionMemory/prompts.ts:11-40`

模板原文如下：

```ts
export const DEFAULT_SESSION_MEMORY_TEMPLATE = `
# Session Title
_A short and distinctive 5-10 word descriptive title for the session. Super info dense, no filler_

# Current State
_What is actively being worked on right now? Pending tasks not yet completed. Immediate next steps._

# Task specification
_What did the user ask to build? Any design decisions or other explanatory context_

# Files and Functions
_What are the important files? In short, what do they contain and why are they relevant?_

# Workflow
_What bash commands are usually run and in what order? How to interpret their output if not obvious?_

# Errors & Corrections
_Errors encountered and how they were fixed. What did the user correct? What approaches failed and should not be tried again?_

# Codebase and System Documentation
_What are the important system components? How do they work/fit together?_

# Learnings
_What has worked well? What has not? What to avoid? Do not duplicate items from other sections_

# Key results
_If the user asked a specific output such as an answer to a question, a table, or other document, repeat the exact result here_

# Worklog
_Step by step, what was attempted, done? Very terse summary for each step_
`
```

这个设计说明了一件很重要的事：

Claude Code 并不想生成一段自由文本摘要，而是想维护一份“固定结构的状态文档”。

其中几个 section 的职责尤其关键：

- `Current State`
  记录现在正在做什么、下一步是什么。这是 compact 后恢复连续性的核心。
- `Files and Functions`
  记录重要文件、函数和为什么相关。
- `Errors & Corrections`
  记录踩坑、用户纠正、失败路径，避免重复犯错。
- `Worklog`
  记录过程，但要求很 terse，避免无限膨胀。

路径定义在：

- `src/utils/permissions/filesystem.ts:261`

具体形态：

`{projectDir}/{sessionId}/session-memory/summary.md`

这意味着：

- 它不是全局唯一的一份 summary
- 也不是按项目只有一份
- 而是“每个 session 一份”

所以更准确地说：

- 对单个 session 来说，`summary.md` 只有一份，并且会被持续更新
- 对整个项目来说，会有很多个 session 各自的 `summary.md`

初始化发生在：

- `src/setup.ts:293`
- `src/services/SessionMemory/sessionMemory.ts:357`

行为上有几个前提：

- 非 bare mode
- 非 remote mode
- auto compact 开启

这里已经能看出 Claude Code 的定位：

`session memory` 被设计成 compact 体系的一部分，而不是一个独立的“可有可无的摘要工具”。

## 只在主 REPL 线程跑这套逻辑

逻辑在：

- `src/services/SessionMemory/sessionMemory.ts:275`
- `src/services/SessionMemory/sessionMemory.ts:277`

这里会先检查当前 hook 的 `querySource`，只有 `querySource === 'repl_main_thread'` 才继续，其他来源直接返回。也就是说，只有用户当前正在进行的主对话主线能更新 `session memory`，subagent、teammate 和其他 forked flow 都不能改这份 `summary.md`。这样做主要是为了保证 `session memory` 只描述主会话状态，避免被旁路代理污染，同时避免并发写入和错误推进 `lastSummarizedMessageId`。

## Session Memory Update

触发逻辑在：

- `src/services/SessionMemory/sessionMemory.ts:134`
- `src/services/SessionMemory/sessionMemoryUtils.ts:32`

默认阈值：

- `minimumMessageTokensToInit = 10000`
- `minimumTokensBetweenUpdate = 5000`
- `toolCallsBetweenUpdates = 3`

更细一点地说，流程是：

1. 会话总上下文 token 先超过 `10000`
   这之前完全不做 session memory

2. 初始化后，每次判断“距离上次抽取，context 是否至少又增长了 `5000` token”

3. 同时还会统计自上次更新以来的 tool call 数量

4. 最后满足下面任一条件才触发：

- token 增长达到阈值，且 tool calls 达到阈值
- token 增长达到阈值，且最近一轮 assistant 没有 tool call

这个设计很有意思：

- token 增长阈值是硬门槛
- tool call 数量是辅助信号
- “最近一轮没有 tool call”被视作自然停顿点，适合做总结

也就是说，它不会每轮都更新，而是在“上下文足够长，并且出现比较自然的阶段性停顿”时更新。

主流程在：

- `src/services/SessionMemory/sessionMemory.ts:183`
- `src/services/SessionMemory/sessionMemory.ts:272`

可以拆成 6 步。

### 第一步：准备文件

`setupSessionMemoryFile()` 会：

- 创建 session-memory 目录
- 如果 `summary.md` 不存在，先写空文件再灌模板
- 用 `FileReadTool` 读出当前内容

关键位置：

- `src/services/SessionMemory/sessionMemory.ts:183`
- `src/services/SessionMemory/sessionMemory.ts:194`
- `src/services/SessionMemory/sessionMemory.ts:217`

### 第二步：清理读缓存，确保拿到真实文件内容

代码里会先清掉该文件的 `readFileState` 缓存，避免 FileReadTool 返回 `file_unchanged` stub。

关键位置：

- `src/services/SessionMemory/sessionMemory.ts:214`

说明作者非常明确地把这一步当成“真实状态同步”，而不是随便读一下。

### 第三步：构造更新 prompt

更新 prompt 里明确要求：

- 这条指令不是用户会话的一部分
- 只能用 Edit 更新 notes file
- 不许用其他工具
- 必须高密度记录实际工作信息
- 控制 section 长度；超总预算时还要整体压缩
- 不允许改 section header
- 不允许改每个 section 后面的斜体说明
- 只能改 section 内容
- 必须始终更新 Current State

源码出处：

- `src/services/SessionMemory/prompts.ts:43-80`

对应默认更新 prompt 完整原文如下：

```ts
function getDefaultUpdatePrompt(): string {
  return `IMPORTANT: This message and these instructions are NOT part of the actual user conversation. Do NOT include any references to "note-taking", "session notes extraction", or these update instructions in the notes content.

Based on the user conversation above (EXCLUDING this note-taking instruction message as well as system prompt, claude.md entries, or any past session summaries), update the session notes file.

The file {{notesPath}} has already been read for you. Here are its current contents:
<current_notes_content>
{{currentNotes}}
</current_notes_content>

Your ONLY task is to use the Edit tool to update the notes file, then stop. You can make multiple edits (update every section as needed) - make all Edit tool calls in parallel in a single message. Do not call any other tools.

CRITICAL RULES FOR EDITING:
- The file must maintain its exact structure with all sections, headers, and italic descriptions intact
-- NEVER modify, delete, or add section headers (the lines starting with '#' like # Task specification)
-- NEVER modify or delete the italic _section description_ lines (these are the lines in italics immediately following each header - they start and end with underscores)
-- The italic _section descriptions_ are TEMPLATE INSTRUCTIONS that must be preserved exactly as-is - they guide what content belongs in each section
-- ONLY update the actual content that appears BELOW the italic _section descriptions_ within each existing section
-- Do NOT add any new sections, summaries, or information outside the existing structure
- Do NOT reference this note-taking process or instructions anywhere in the notes
- It's OK to skip updating a section if there are no substantial new insights to add. Do not add filler content like "No info yet", just leave sections blank/unedited if appropriate.
- Write DETAILED, INFO-DENSE content for each section - include specifics like file paths, function names, error messages, exact commands, technical details, etc.
- For "Key results", include the complete, exact output the user requested (e.g., full table, full answer, etc.)
- Do not include information that's already in the CLAUDE.md files included in the context
- Keep each section under ~${MAX_SECTION_LENGTH} tokens/words - if a section is approaching this limit, condense it by cycling out less important details while preserving the most critical information
- Focus on actionable, specific information that would help someone understand or recreate the work discussed in the conversation
- IMPORTANT: Always update "Current State" to reflect the most recent work - this is critical for continuity after compaction

Use the Edit tool with file_path: {{notesPath}}

STRUCTURE PRESERVATION REMINDER:
Each section has TWO parts that must be preserved exactly as they appear in the current file:
1. The section header (line starting with #)
2. The italic description line (the _italicized text_ immediately after the header - this is a template instruction)

You ONLY update the actual content that comes AFTER these two preserved lines. The italic description lines starting and ending with underscores are part of the template structure, NOT content to be edited or removed.

REMEMBER: Use the Edit tool in parallel and stop. Do not continue after the edits. Only include insights from the actual user conversation, never from these note-taking instructions. Do not delete or change section headers or italic _section descriptions_.`
}
```

这段 prompt 的设计重点不是“让模型总结一下”，而是：

- 明确这是后台维护任务，不属于真实用户对话
- 把输出约束成单文件、固定结构、可持续修订的工作笔记
- 强制 `Current State` 保持最新，确保 compact 后仍能连续工作

### 第四步：用 forked agent 执行，而不是主线程自己执行

调用在：

- `src/services/SessionMemory/sessionMemory.ts:318`

核心参数：

- `querySource: 'session_memory'`
- `forkLabel: 'session_memory'`
- `cacheSafeParams: createCacheSafeParams(context)`

这说明后台摘要不是一个纯本地函数，而是又起了一个受限的代理流程。

### 第五步：forked agent 是隔离上下文，但继承 cache-safe prompt 前缀

关键代码：

- `src/utils/forkedAgent.ts:345`
- `src/utils/forkedAgent.ts:489`

这里的思路是：

- 复用主会话前缀，吃 prompt cache
- 又隔离 mutable state，避免污染主线程

这是 Claude Code 这套机制里很值得借鉴的一点。

### 第六步：严格限制权限，只准改这一份文件

限制逻辑在：

- `src/services/SessionMemory/sessionMemory.ts:321`

`createMemoryFileCanUseTool()` 只允许：

- `Edit`
- 且 `file_path` 必须等于当前 `summary.md`

这说明 session memory 抽取被当成“高约束后台维护任务”，而不是一般 agent。

### 第七步：更新 `lastSummarizedMessageId`

这是 session memory 和 compact 能接起来的关键状态。

定义和读写位置：

- `src/services/SessionMemory/sessionMemoryUtils.ts:43`
- `src/services/SessionMemory/sessionMemoryUtils.ts:58`
- `src/services/SessionMemory/sessionMemory.ts:346`

它的语义是：

`当前 summary.md 已经覆盖到了主会话中的哪条消息`

这个值一旦更新成功，后续 compact 就知道：

- 这条消息之前的历史，可以被 summary 替代
- 这条消息之后的历史，还要保留原文

没有这个边界，summary 只是“摘要文本”，无法安全参与上下文裁剪。

## Session Memory Compact

入口在：

- `src/commands/compact/compact.ts:55`
- `src/services/compact/autoCompact.ts:287`
- `src/services/compact/sessionMemoryCompact.ts:514`

Claude Code 的策略是：

- 手动 `/compact` 时，优先尝试 session memory compact
- 自动 compact 时，也优先尝试 session memory compact
- 只有这条路走不通，才回退到传统 compact summarization

这说明 session memory 在当前实现里不是辅助项，而是优先方案。下面就是这条优先路径的完整流程。

### 1. 等待后台抽取完成

为了避免正在更新 `summary.md` 时又拿它去 compact，会先等待正在进行的抽取结束。

关键位置：

- `src/services/SessionMemory/sessionMemoryUtils.ts:89`
- `src/services/compact/sessionMemoryCompact.ts:526`

### 2. 读取当前 summary.md

关键位置：

- `src/services/compact/sessionMemoryCompact.ts:529`

如果：

- 文件不存在
- 内容仍然只是模板

就直接回退到传统 compact。

关键位置：

- `src/services/compact/sessionMemoryCompact.ts:532`
- `src/services/compact/sessionMemoryCompact.ts:538`

### 3. 根据 `lastSummarizedMessageId` 确定“已摘要区”和“保留尾部”的边界

关键位置：

- `src/services/compact/sessionMemoryCompact.ts:545`

分两种情况：

#### 正常情况

有 `lastSummarizedMessageId`，就去当前消息列表里找对应索引。

#### Resume 后情况

没有 `lastSummarizedMessageId`，但 session memory 文件存在。

代码里会进入一种“保守模式”：

- 从尾部开始保留最近消息
- 向前扩展直到满足最小 token 和最小文本消息数

关键位置：

- `src/services/compact/sessionMemoryCompact.ts:561`

### 4. 计算最近要保留多少原始消息

不是简单“保留最后 N 条”，而是有一套约束：

- 至少保留一定 token
- 至少保留一定数量 text block messages
- 最多不超过上限
- 不能把 `tool_use / tool_result` 拆开
- 不能把同一 assistant streaming message 里的 thinking / tool_use 片段拆开

关键位置：

- `src/services/compact/sessionMemoryCompact.ts:232`
- `src/services/compact/sessionMemoryCompact.ts:324`

这是这套设计里最工程化、也最容易低估的部分。

如果只做“摘要 + 最后几条消息”，很容易在工具链、thinking block、assistant message merge 上炸掉。

### 5. 把 summary.md 包装成 compact summary message

这里不会直接把原始 `summary.md` 当系统 prompt 塞进去，而是生成一条 compact summary user message。

关键位置：

- `src/services/compact/sessionMemoryCompact.ts:464`
- `src/services/compact/prompt.ts:337`

这条 message 会告诉模型：

- 之前那部分会话已经被总结
- 如需旧细节，可以去读 transcript
- recent messages 仍然保留了原文

对应 compact 后主模型收到的提示词原文如下：

```ts
export function getCompactUserSummaryMessage(
  summary: string,
  suppressFollowUpQuestions?: boolean,
  transcriptPath?: string,
  recentMessagesPreserved?: boolean,
): string {
  const formattedSummary = formatCompactSummary(summary)

  let baseSummary = `This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.

${formattedSummary}`

if (transcriptPath) {
  baseSummary += `\n\nIf you need specific details from before compaction (like exact code snippets, error messages, or content you generated), read the full transcript at: ${transcriptPath}`
}

if (recentMessagesPreserved) {
  baseSummary += `\n\nRecent messages are preserved verbatim.`
}
```

如果 `suppressFollowUpQuestions` 为真，还会继续追加这段续接指令：

```ts
Continue the conversation from where it left off without asking the user any further questions. Resume directly — do not acknowledge the summary, do not recap what was happening, do not preface with "I'll continue" or similar. Pick up the last task as if the break never happened.
```

源码出处：

- `src/services/compact/prompt.ts:337-359`
- `src/services/compact/sessionMemoryCompact.ts:464-469`

这段 prompt 很关键，因为它说明 Claude Code 对“回溯原始消息”的设计不是自动重建旧上下文，而是显式告诉主模型：

- 先基于摘要继续工作
- 最近尾部原文还在
- 如果确实缺旧细节，再按 `transcriptPath` 回查完整 transcript

### 6. 构造 compact boundary 和 preservedSegment

关键位置：

- `src/services/compact/sessionMemoryCompact.ts:447`
- `src/services/compact/compact.ts:349`

这里会给 compact boundary 加上：

- `headUuid`
- `anchorUuid`
- `tailUuid`

这组 metadata 表示：

- recent tail 的起点
- recent tail 应该接到哪里
- recent tail 的终点

这不是展示信息，而是 resume 时恢复链路的必要元数据。

## Resume场景拼接逻辑

真正关键的恢复逻辑在：

- `src/utils/sessionStorage.ts:1839`
- `src/utils/sessionStorage.ts:3704`

`applyPreservedSegmentRelinks()` 会做这些事：

1. 找到最后一个有效 compact boundary
2. 读取它的 `preservedSegment`
3. 验证 tail 到 head 的链是否还能走通
4. 把保留的 recent messages 接到 compact summary 之后
5. 把 anchor 其他孩子重定向到 tail
6. 把保留旧消息上的 usage 清零，避免 resume 后立刻误判 context 爆了

这一步是 Claude Code 实现里最容易被忽视、但最重要的部分之一。

如果只模仿“生成 summary.md”，不做 boundary relink，那么实现出来的只是一个摘要插件，不是可参与上下文管理的工作记忆系统。

## 回溯原始消息

从实现上看，session memory 的主要使用时机是 compact，而不是每轮对话开始时自动注入主 prompt。

原因可能有几个：

1. 它是阶段性摘要，内容会频繁变化，不适合常驻缓存前缀
2. 常驻注入会增加每轮 prompt 成本
3. Transcript 仍然是事实底座，summary 更多是“压缩时替代旧消息”的材料
4. 它本身可能很长，还需要长度治理

对应长度治理在：

- `src/services/SessionMemory/prompts.ts:164`
- `src/services/SessionMemory/prompts.ts:256`

另一个值得注意的实现细节是，Claude Code 并没有为“回溯原始消息”单独设计一套复杂的 retrieval agent prompt。当前代码里更接近“两层轻提示”：

更准确地说，Claude Code 当前的“回溯提示词”不是一条独立的大 prompt，而是两层协作：

1. compact 运行时提示，负责“指路”
2. 一个可选的系统级检索提示，负责“教怎么找”

第一层是 compact 后的运行时提示，也就是上面 `getCompactUserSummaryMessage()` 里那句：

```ts
If you need specific details from before compaction
(like exact code snippets, error messages, or content you generated),
read the full transcript at: ${transcriptPath}
```

它的作用很直接：

- 默认先靠 `summary + recent tail` 继续工作
- 不要一上来就尝试恢复全量旧历史
- 只有当你缺的是“精确旧细节”时，才去读 transcript

第二层不是 compact 专用 prompt，而是一个可选的系统级检索提示：`buildSearchingPastContextSection()`。实现位于：

- `src/memdir/memdir.ts:373-404`

这段会在 feature gate 打开时，被拼进系统 prompt 的末尾；如果开关没开，这段根本不会出现。它在这里的作用只有一个：补充“如果要追溯旧上下文，具体该怎么搜 transcript”。和本文直接相关的核心原文就是这段：

```ts
export function buildSearchingPastContextSection(autoMemDir: string): string[] {
  ...
  return [
    '## Searching past context',
    '',
    'When looking for past context:',
    '1. Search topic files in your memory directory:',
    '```',
    memSearch,
    '```',
    '2. Session transcript logs (last resort — large files, slow):',
    '```',
    transcriptSearch,
    '```',
    'Use narrow search terms (error messages, file paths, function names) rather than broad keywords.',
    '',
  ]
}
```

相关代码会根据环境给出具体检索形式。例如在 embedded / REPL 场景下，它会直接建议：

```ts
const transcriptSearch = embedded
  ? `grep -rn "<search term>" ${projectDir}/ --include="*.jsonl"`
  : `${GREP_TOOL_NAME} with pattern="<search term>" path="${projectDir}/" glob="*.jsonl"`
```

源码出处：

- `src/memdir/memdir.ts:375-404`
- `src/memdir/memdir.ts:389-391`

所以这两层提示的分工可以概括成：

- `src/services/compact/prompt.ts`：运行时指路，告诉主模型“要旧细节就去读 transcript”
- `buildSearchingPastContextSection()`：系统级检索方法，告诉模型“如果要追溯旧上下文，就把 transcript 当最后手段，并且用窄关键词搜”

这说明 Claude Code 当前的“回溯原始消息”设计不是：

- 从 `summary` 自动映射回 source message ids
- 或专门起一个复杂 retrieval agent 去重建旧链

而是：

- 主路径靠 `summary + recent tail`
- 需要旧证据时，显式读取 transcript
- 如果系统 prompt 中启用了 `Searching past context`，再用那套检索方法去更高效地搜 transcript

## OpenViking-openclaw plugin 工作记忆设计思路

一句话判断：

如果按 OpenViking 的产品定位来设计，`archive` 不应该只是“归档后的历史摘要”，而应该被提升为 **working memory 的正式生成对象**。也就是说，OpenViking 里的正确主线应该是：

`当前 session 的 messages.jsonl -> commit / archive -> 生成 working memory object -> assemble 消费 -> 需要细节时再 expand`

本章默认的实现边界是：优先在 OpenViking 当前 `openclaw-plugin` 已有的 `assemble / afterTurn / compact` 生命周期内落地，不预设必须先修改 OpenClaw core API。

这里最关键的一点是：

OpenViking 当前已经有了当前 session 的 `messages.jsonl`、`commit/archive`、`L1:latest_archive_overview`、`L0:pre_archive_abstracts` 和 `ov_archive_expand`。缺的不是在 archive 旁边再维护一份独立摘要，而是把 archive 这条链路正式升级成 Claude Code `session memory` 对应的 working memory 生成链路。

### 先看 OpenViking 当前已经做到什么

这部分调研基于 OpenViking 仓库当前 `main` 分支下的 `examples/openclaw-plugin` 实现。

从当前 README 和代码看，这个插件已经不是一个单纯的 memory lookup 插件，而是一个围绕 OpenClaw 生命周期工作的集成层。源码和文档位置：

- `OpenViking/examples/openclaw-plugin/README_CN.md:19-24`
- `OpenViking/examples/openclaw-plugin/index.ts:1411-1561`
- `OpenViking/examples/openclaw-plugin/context-engine.ts:763-1125`

它当前已经具备 3 个非常重要的基础能力。

这里先说明一个边界：`before_prompt_build` 里的 `user/agent memories` recall 属于长期记忆层，不属于本文要设计的工作记忆主线，因此这里不展开。

#### 1. `assemble()` 已经在消费 archive 产物

当前 `assemble()` 会调用 `getSessionContext()`，然后把 OpenViking 返回的 session context 重新组装成 OpenClaw 可消费的消息：

- `latest_archive_overview` -> `[Session History Summary]`
- `pre_archive_abstracts` -> `[Archive Index]`
- 当前活跃消息 -> active messages
- tool part 会被还原成 `toolUse` / `toolResult`

对应实现：

- `OpenViking/examples/openclaw-plugin/context-engine.ts:705-740`
- `OpenViking/examples/openclaw-plugin/context-engine.ts:763-852`

它还会附带一段 `systemPromptAddition`，显式告诉模型：

- `[Session History Summary]` 是有损的
- 如果要精确旧细节，先看 `[Archive Index]`
- 再调用 `ov_archive_expand`

对应实现：

- `OpenViking/examples/openclaw-plugin/context-engine.ts:438-476`

这一步已经说明了一件事：OpenViking 当前已经在用 archive 产物参与工作上下文组装。只是今天这个 archive 产物还比较薄，更多是“summary + index”，还没有进化成更强的 working memory object。

#### 2. `afterTurn()` 已经在做原始消息的无损落盘和异步 commit

当前 `afterTurn()` 会：

- 用 `prePromptMessageCount` 切出本轮新增消息
- 提取结构化的 text / tool parts
- 清理掉 `<relevant-memories>` 这类注入噪音
- 追加写入 OpenViking session
- 当 `pending_tokens >= commitTokenThreshold` 时，触发 `commit(wait=false)`

对应实现：

- `OpenViking/examples/openclaw-plugin/context-engine.ts:867-1037`

这说明 OpenViking 当前已经有了 Claude Code 那里的“transcript / raw history 持续写入”对应物。虽然存储形态不是本地 jsonl，而是 OpenViking session，但语义上它已经是事实底座。

#### 3. `compact()` 已经在做同步 commit 和 summary 回读

当前 `compact()` 会：

- 调用 `commit(wait=true)`
- 等待 archive / memory extract 完成
- 再回读 `getSessionContext()`
- 取出 `latest_archive_overview` 作为 compact summary
- 返回 `tokensBefore / tokensAfter / latest archive id / summary`

对应实现：

- `OpenViking/examples/openclaw-plugin/context-engine.ts:1039-1125`
- `OpenViking/examples/openclaw-plugin/context-engine.ts:1185-1293`

所以，如果只从“有没有 compact 同步边界”和“有没有历史压缩后再回读”这两个角度看，OpenViking 当前已经比很多普通 memory plugin 更接近 Claude Code 的上下文链路了。

### 对照 Claude Code 之后，真正缺的是什么

如果把 Claude Code 的 `session memory` 模型套过来，OpenViking 当前已经具备这些对应项：

- `transcript` 真相源
  在 OpenViking 里更准确对应当前 session 的 `messages.jsonl`；归档后旧消息进入 `history/archive_x/messages.jsonl`
- compact 后可回看的旧历史
  在 OpenViking 里对应 `latest_archive_overview + pre_archive_abstracts + ov_archive_expand`
- compact 同步边界
  在 OpenViking 里对应 `compact() -> commit(wait=true)`

差的不是“能不能压缩历史”，而是“archive 产物能不能直接充当工作记忆”。按这个标准看，当前实现还缺 4 个关键能力。

#### 缺口 1：archive 产物还不够“工作态”

当前 `latest_archive_overview` 更像归档概述，不像工作交接文档。它至少还缺：

- `Current State`
- `Next Actions`
- `Errors & Corrections`
- `Important Files / Functions`
- 用户临时约束和当前任务状态

#### 缺口 2：archive 缺少明确的覆盖边界

Claude Code 里有 `lastSummarizedMessageId`。OpenViking 这里也需要明确表达两件事：

- 这份 archive-produced summary 已经覆盖到哪条 turn
- 从哪条 turn 之后必须保留原文

没有这个边界，archive 就只能提供“可读摘要”，不能安全接管 working context。

#### 缺口 3：archive 缺少 recent tail 的保留语义

当前 `assemble()` 拿到的是：

- archive overview
- archive index
- active messages

但 archive 本体没有显式描述“为什么这些 recent raw messages 还要保留”，例如：

- `headTurnId`
- `tailTurnId`
- `tailTokenEstimate`
- `why kept`

这会让 `assemble()` 更像是在拼“摘要 + 活跃消息”，而不是消费一份已经定义好边界的 working memory。

#### 缺口 4：assemble 消费的是 archive 摘要结果，不是 archive-working-memory object

当前主输入仍然是：

- OpenViking session context
- archive overview
- archive index

而不是：

- `archive-produced working summary`
- `recent raw messages`
- `archive expansion hints`

所以 OpenViking 现在已经是一个 `archive-aware context engine`，但还没有把 archive 提升成“工作记忆的正式输出物”。

### 技术方案：Archive 本体就是 Working Memory Object

把 archive 升级成 working memory object：

- 当前 session 的 `messages.jsonl` 仍然是真相源
- `archive` 则成为“当前 session 的工作记忆生成器和承载对象”

#### 1. 存储模型

archive 结果对象扩展为：  

```ts
type SessionArchiveWorkingMemory = {
  archiveId: string
  sessionId: string
  createdAt: string
  sourceTurnRange: {
    startTurnId: string
    endTurnId: string
    endSeq: number
  }
  workingSummary: {
    markdown: string
    sections: {
      currentState: string
      nextActions: string
      errorsAndCorrections: string
      importantContext: string
    }
  }
  preservedTail: {
    headTurnId: string
    tailTurnId: string
    turnCount: number
    tokenEstimate: number
  }
  expansion: {
    archiveIndex: Array<{ archiveId: string; abstract: string }>
    latestArchiveOverview?: string
    expandTool: 'ov_archive_expand'
  }
}
```

兼容现有返回形态时，第一阶段不改 archive 主表结构，而是让 `commit()` / `getSessionContext()` 额外返回一个 `working_memory` 字段；但语义上它仍然是 archive 产物，而不是平行 sidecar。

#### 2. 摘要模板

Claude Code 这里最值得借鉴的不是“有摘要”，而是“摘要必须固定结构”。`workingSummary.markdown` 至少包含：

- `Session Title`
- `Current State`
- `User Goal & Constraints`
- `Important Files / Modules / Resources`
- `Decisions & Why`
- `Errors / Failed Paths / User Corrections`
- `Workflow / Commands / Tools`
- `Next Actions`
- `Key Results`
- `Worklog`

其中最关键的是 `Current State`、`Errors / Failed Paths / User Corrections`、`Next Actions`，因为 compact 后还能不能连续工作，基本就看这三块。

#### 3. 更新提示词

archive-working-memory 生成 prompt 定义为：

```text
IMPORTANT: This instruction is not part of the user conversation.

Generate the archive working-memory object for the current OpenClaw session commit boundary.

You are given:
- the raw messages covered by this commit
- the previous archive working summary when available
- the current active tail that should remain uncompressed

Your task is to produce:
- a structured working summary for future continuation
- the covered turn boundary
- the preserved recent tail boundary

Rules:
- Preserve the fixed section structure exactly.
- Always refresh "Current State" and "Next Actions" first.
- Record concrete files, tools, commands, constraints, errors, and user corrections.
- Treat this archive as the next working-memory object for the session.
- Do not invent details that are not present in raw messages or archives.
- If the summary grows too large, condense Worklog and older details first; keep Current State and Errors detailed.
```

这个 prompt 的目标只有两个：一是让 archive 产物具备工作记忆语义，二是同时产出 coverage 和 preserved tail 元数据。

#### 4. 生命周期映射

##### `afterTurn()`

`afterTurn()` 保留当前的原始消息落盘逻辑，并在达到阈值时直接通过 `commit(wait=false)` 异步触发 archive working memory 生成：

1. 继续把本轮 raw messages 无损写入 OpenViking session
2. 判断是否需要触发 archive
3. 如果达到阈值，调用 `commit(wait=false)` 异步触发下一次 archive 生成

触发信号为：

- session context 初次超过某个阈值
- 距离上次 archive working memory 生成又新增了明显 token
- 最近几轮出现自然停顿点
- 或已经到达明确的 compact 预警线

这里不要阻塞主链路。`afterTurn()` 负责判断时机，真正的 working memory 生成由 `commit/archive` 承担。

##### `assemble()`

`assemble()` 直接消费 archive working memory，组装顺序为：

1. 最新 archive 的 `workingSummary`
2. `recent raw messages`
3. 必要时的 `archive index`
4. 必要时的 `archive overview`

也就是把当前的：

`archive overview + archive index + active messages`

收敛成：

`workingSummary + preserved recent raw messages + archive hints`

##### `compact()`

`compact()` 的职责是同步生成并返回最新的 archive working memory。

1. 调用 `commit(wait=true)`
2. 由 archive 流程同步生成新的 working memory object
3. 返回最新 archive 的 `workingSummary + preservedTail + expansion hints`
4. 必要时再返回 `archiveId / tokensBefore / tokensAfter`

compact 的结果不应该再只是 `latest_archive_overview`，而应该优先返回真正可继续工作的 `workingSummary + preservedTail + expansion hints`。

#### 5. OpenViking 版本的“resume 拼接”

这里和 Claude Code 的差异要直接讲清楚：OpenViking 不需要在客户端重接消息链，因为它的 session context 是服务端现组装的。它真正需要的是 archive object 上的边界字段：

- `sourceTurnRange.endTurnId`
- `preservedTail.headTurnId`
- `preservedTail.tailTurnId`

然后由 `getSessionContext()` 或增强版 working-context API 在服务端直接物化出 `workingSummary + recent raw messages + archive hints`。所以 OpenViking 的“resume 拼接”本质上是服务端重建 working context，不是本地 relink。

#### 6. 回溯旧历史的方式

这里不照搬 Claude Code 的 transcript 文件路径提示，因为 OpenViking 已经有现成入口 `ov_archive_expand`。回溯链路定义为：

1. 默认先靠最新 archive object 里的 `workingSummary + preservedTail`
2. 如果缺精确旧细节，优先根据 archive index 或 archiveId 调用 `ov_archive_expand`
3. 未来如果要更细粒度，再加 turn-level / range-level expand

对应的运行时提示写成：

- “If you need exact older details not present in the latest archive-produced working summary or recent tail, inspect the archive index and call `ov_archive_expand`.”

#### 7. 这一章的边界

本文只讨论当前 session 内的 working memory，因此这里明确两层就够了：

- `archive as working memory object`
  只管当前 session 的连续工作状态
- `messages.jsonl`
  只管原始消息事实层；当前消息在 session 根目录下，归档后旧消息进入 `history/archive_x/messages.jsonl`

这里最重要的边界是：

- archive 是“当前 session 的工作记忆产物”
- `messages.jsonl` 是“最终事实源”

### MVP 与完整版

落地分两步。

#### MVP：把 archive 结果扩成 working memory object

第一版只做 5 件事：

1. `commit()` / `getSessionContext()` 能返回 `workingSummary + sourceTurnRange + preservedTail`
2. `afterTurn()` 继续无损落盘，并按阈值异步触发 archive
3. `assemble()` 优先拼“最新 archive working memory object + recent raw messages”
4. `compact()` 同步等待 archive 完成，并返回 archive-working-memory-first 的结果
5. 缺精确旧细节时，继续用 `ov_archive_expand`

做到这一步，就已经能把当前任务状态从 `archive overview` 提升到真正的 working memory。

#### 完整版：服务端原生 archive-working-memory API

第二版再把这层完全收进 OpenViking 服务端：

1. `session.commit()` 直接产出标准 working memory object
2. `getSessionContext()` 或新 API 直接返回 archive-working-memory 视图
3. 由服务端维护 `sourceTurnRange` 和 `preservedTail`
4. `assemble()` 只消费 archive-working-memory 视图，不自己拼装
5. 后续再接更细粒度的 expand 和其他上下文增强能力

做到这一步，OpenViking-openclaw plugin 才算真正拥有了一个以 archive 为核心的 working memory 子系统。

### 最终建议

如果只保留一句最重要的话，这一章的结论是：

OpenViking 当前 `openclaw-plugin` 已经有了 session 真相源、archive summary 和 archive expand。下一步不该是在 archive 旁边再造一份 working memory sidecar，而应该直接把 archive 提升成 working memory object，让 `commit/archive` 成为正式的工作记忆生成边界，让 `assemble()` 和 `compact()` 统一消费 archive 产出的 `workingSummary + preservedTail + expansion hints`。这样才真正符合 OpenViking 的定位，也最接近 Claude Code `session memory` 的核心能力。
