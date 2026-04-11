# 本地 Embedding 模型支持调研报告

> 调研日期：2026-04-10
> 相关讨论：[Discussion #601](https://github.com/volcengine/OpenViking/discussions/601)

## 1. 背景

当前 OpenViking 主干代码中的 embedding 功能依赖远程 API 服务，用户通常需要先准备 API Key 和模型配置才能使用，这对新用户体验是一道门槛。

本报告调研两个方向：
1. **QMD 方案**：Shopify 创始人 Tobi Lütke 开发的本地混合搜索引擎，采用 GGUF 量化小模型实现零配置本地推理
2. **LanceDB + sentence-transformers 方案**：LanceDB 内置 embedding 注册表支持 sentence-transformers 本地推理，字节 ArkClaw 的记忆系统基于 LanceDB 构建

## 2. QMD 方案分析

### 2.1 QMD 是什么

- **项目地址**：[github.com/tobi/qmd](https://github.com/tobi/qmd)
- **定位**：on-device 搜索引擎，支持 BM25 + 向量语义搜索 + LLM 重排序
- **运行环境**：Node.js / Bun，使用 `node-llama-cpp` 作为 GGUF 推理引擎
- **协议**：MIT

### 2.2 本地模型体系

QMD 使用三个本地 GGUF 模型，首次使用时自动从 HuggingFace 下载并缓存到 `~/.cache/qmd/models/`：

| 模型 | 用途 | 大小 | 下载触发 | HuggingFace 路径 |
|---|---|---|---|---|
| `embeddinggemma-300M-Q8_0` | 向量 embedding（默认） | ~300MB | 首次 `qmd embed` | `ggml-org/embeddinggemma-300M-GGUF` |
| `qwen3-reranker-0.6b-q8_0` | 重排序 | ~640MB | 首次 `qmd query` | `ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF` |
| `qmd-query-expansion-1.7B-q4_k_m` | 查询扩展（微调） | ~1.1GB | 首次 `qmd query` | `tobil/qmd-query-expansion-1.7B-gguf` |

总计约 **2.1GB**（embedding 模型仅 300MB）。

### 2.3 核心设计

#### 自动下载与缓存

模型以 HuggingFace URI 格式配置，首次调用时自动下载：

```
const DEFAULT_EMBED_MODEL = "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf";
```

#### 懒加载与生命周期管理

- embedding/reranking 上下文空闲 **5 分钟后释放**
- 下次请求时透明重建（约 1s 延迟，模型本身保持加载在内存）
- 显式 `close()` 释放所有模型和数据库连接

#### 模型切换

通过环境变量支持切换到其他 GGUF 模型：

```bash
# 切换到 Qwen3-Embedding（支持 119 种语言，含中日韩）
export QMD_EMBED_MODEL="hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf"
qmd embed -f  # 强制重新生成向量
```

支持两种模型家族：
- **embeddinggemma**（默认）：英文优化，300MB
- **Qwen3-Embedding**：多语言（119 种语言），MTEB 排名靠前

> 注意：切换模型后必须重新生成所有向量，因为向量不跨模型兼容。Prompt 格式会根据模型家族自动调整。

#### Embedding Prompt 格式

```
# 查询侧
"task: search result | query: {query}"

# 文档侧
"title: {title} | text: {content}"
```

### 2.4 CPU 性能表现

根据社区实测反馈：

| 场景 | 表现 |
|---|---|
| 模型下载 | 300MB embedding 模型约 10 秒（取决于网络） |
| CPU 推理 | 可工作，但速度明显慢于 GPU |
| CPU 占用 | embedding 进程可达 100% |
| 大批量处理 | 可能耗时数小时（ETA 4h+） |
| 定时 embed 任务 | CPU-only 硬件上可能出现超时 |

**结论**：本地 CPU embedding 对**小规模、低频查询**场景可用，但大批量索引构建和实时查询性能受限。

## 3. OpenViking 当前 Embedding 架构（按代码校验）

### 3.1 支持的 Provider

| Backend | 模式 | 实现类 |
|---|---|---|
| `volcengine` | Dense, Sparse, Hybrid | `VolcengineDenseEmbedder` 等 |
| `openai` | Dense | `OpenAIDenseEmbedder` |
| `vikingdb` | Dense, Sparse, Hybrid | `VikingDBDenseEmbedder` 等 |

以上三类均是**远程 API 调用**。当前仓库里没有 `jina` / `voyage` / `ollama` 专用 embedder；如果要接 OpenAI-compatible 本地服务，只能复用 `openai` backend 并自定义 `api_base`，这仍然属于“外部服务模式”，不是进程内本地推理。

### 3.2 类层次结构

```
EmbedderBase (ABC)
  +-- DenseEmbedderBase       → 返回 dense vectors (List[float])
  +-- SparseEmbedderBase      → 返回 sparse vectors (Dict[str, float])
  +-- HybridEmbedderBase      → 返回 dense + sparse
        +-- CompositeHybridEmbedder  → 组合 DenseEmbedderBase + SparseEmbedderBase
```

关键接口：

```python
class DenseEmbedderBase(EmbedderBase):
    def embed(self, text: str) -> EmbedResult: ...
    def embed_batch(self, texts: List[str]) -> List[EmbedResult]: ...
    def get_dimension(self) -> int: ...
```

> 重要补充：当前接口**没有**区分 query/document 两种编码路径，也没有 `embed_query()` / `embed_document()`。这对 E5、BGE、Qwen3-Embedding 这类依赖 instruction / prefix 的检索模型是一个真实设计缺口，不能在实现时忽略。

### 3.3 配置系统

配置定义在 `openviking/utils/config/embedding_config.py`，通过 Pydantic 模型验证：

```json
{
  "embedding": {
      "dense": {
        "backend": "volcengine",
        "model": "doubao-embedding-vision-250615",
        "api_key": "{your-api-key}",
        "dimension": 1024
    }
  }
}
```

Backend 注册通过 factory registry 映射 `(backend, type)` 到具体实现类。

### 3.4 数据流

```
资源导入 → SemanticProcessor 生成摘要
         → EmbeddingMsgConverter 从 Context 生成 EmbeddingMsg 并入队
         → QueueManager 消费 → TextEmbeddingHandler 调用 embedder.embed()
         → 向量写入 context collection（VikingVectorIndex backend）
         → HierarchicalRetriever 查询时复用同一 embedder
```

### 3.5 现有本地支持

OpenViking 目前**没有内置本地推理**能力（无 sentence-transformers、ONNX、llama-cpp 等依赖）。

间接支持方式：
1. **OpenAI-compatible 本地服务**：通过 `backend: "openai"` + 自定义 `api_base`，指向 Ollama / llama.cpp server / vLLM / text-embeddings-inference 等兼容接口
2. **自建 VikingDB embedding API**：通过 `backend: "vikingdb"` 走外部 embedding 服务

这两种方式都需要用户**额外部署和运维一个服务**，不是零配置体验。

### 3.6 现有代码约束（本报告补充）

以下约束在原始调研中没有展开，但对实现路线影响很大：

1. **backend 白名单是硬编码的**：当前校验只接受 `openai` / `volcengine` / `vikingdb`，因此本地推理不是“新增一个类”就能完成，而是要同步修改配置校验、工厂注册和文档。
2. **向量维度是配置期静态值**：context collection 的 schema 直接使用 `config.embedding.dimension` 建表，入库时也会严格校验返回向量长度。若模型切换导致维度变化，现有集合不能透明复用，必须设计重建或迁移流程。
3. **embedder 在 client 初始化阶段即实例化**：`AsyncOpenViking` 构造时会立即 `get_embedder()`。这意味着本地模型下载、权重检查、依赖缺失等问题会变成启动期问题，而不是首次查询时再暴露。
4. **当前写入链路按消息逐条 embedding**：`TextEmbeddingHandler.on_dequeue()` 处理的是单条 `EmbeddingMsg`，并未利用 `batch_size` 做批量编码。因此本地 CPU 索引构建吞吐会比“模型本身 benchmark”更差。
5. **当前 pyproject 没有本地推理依赖**：主干依赖中不存在 `sentence-transformers`、`transformers`、`torch`、`onnxruntime`、`fastembed`、`llama-cpp-python`。无论选哪条路线，都要考虑 optional extra、wheel 体积和跨平台安装体验。

## 4. Discussion #601 讨论倾向

### 主要建议

1. **默认使用本地 embedding 模型**：参考 QMD，零配置启动，无需 API Key
2. **解耦 embedding 和 reranker**：embedding 必需，reranker 可选
3. **模型配置策略**：未配置时默认使用本地模型（如 Qwen3-Embedding-0.6B）

### 维护者反馈

- **@ZaynJarvis**：先支持本地模型接入，后续根据 benchmark 结果决定定位（默认选项 vs 高级选项）
- **@MaojiaSheng**：关注首次模型下载的体验是否流畅
- 修正定位描述：OpenViking 定位是 **Agent 的上下文数据库**，OpenClaw 是其中之一

### 可选集成方向

- 检测 OpenClaw 配置，自动复用其 VLM 模型设置（addon feature，非核心路径）
- OpenClaw 的 QMD backend 不暴露模型配置，OpenViking 保持使用 `ov.conf` 管理

> 注：Discussion #601 目前更接近“方向讨论”，而非已经收敛的正式结论。维护者明确表达的是“先支持接入，再看 benchmark 决定定位”，因此文档里不宜直接把“默认本地 embedding”写成既定方案。

## 5. 可选实现路径对比

| 方案 | 推理引擎 | 模型格式 | 依赖量 | 跨平台 | 适合场景 |
|---|---|---|---|---|---|
| **llama-cpp-python** | llama.cpp (C++) | GGUF | 较重（需编译） | 好 | 兼容 QMD 模型生态 |
| **sentence-transformers** | PyTorch + Transformers | safetensors | 重（PyTorch） | 好 | 模型丰富，API 简单 |
| **ONNX Runtime** | ONNX Runtime | ONNX | 中等 | 好 | 推理快，依赖可控 |
| **fastembed** | ONNX Runtime | ONNX（内置） | 轻 | 好 | 开箱即用，内置小模型 |

### 候选 Embedding 模型

| 模型 | 维度 | 大小 | 多语言 | MTEB 表现 | 推荐场景 |
|---|---|---|---|---|---|
| `all-MiniLM-L6-v2` | 384 | ~80MB | 英文 | 良好 | 英文轻量 baseline |
| `embeddinggemma-300M` | 768 | ~300MB | 英文优化 | 良好 | QMD 默认 |
| `multilingual-e5-small` | 384 | ~470MB | 多语言 | 良好 | openclaw-mem 默认 |
| `Qwen3-Embedding-0.6B` | 1024 | ~640MB | 100+ 语言 | 优秀 | 高质量多语言候选 |
| `nomic-embed-text-v1.5` | 768 | ~274MB | 英文 | 良好 | Ollama 生态 |
| `bge-small-en-v1.5` | 384 | ~33MB | 英文 | 良好 | FastEmbed 默认 |
| `bge-micro-v2` | 384 | ~23MB | 英文 | 可用（极小） | 极端资源受限 |

## 6. 对 OpenViking 的关键启示

| 来源 | 做法 | OpenViking 可借鉴点 |
|---|---|---|
| QMD | GGUF 量化模型 + node-llama-cpp | 可借鉴的是“自动下载、懒加载、模型切换约束”；推理后端未必需要照搬 GGUF |
| QMD | 自动下载 + HuggingFace 缓存 | 实现模型自动下载到 `~/.cache/openviking/models/` |
| QMD | 懒加载 + 空闲释放 | 进程内保持模型，避免重复加载开销 |
| QMD | 环境变量切换模型 | OpenViking 可通过 `backend: "local"` + `model` 字段配置，但必须同时设计索引重建 |
| QMD | ~300MB 小模型起步 | 首次下载约 10 秒，可接受 |
| QMD | Prompt 格式自适应 | 对检索模型需要区分 query/document prompt；当前 OpenViking 接口尚未具备 |
| LanceDB | Embedding 注册表模式 | 可借鉴注册表思路，但 OpenViking 不使用 LanceDB，不能直接获得其 schema 自动联动能力 |
| LanceDB / FastEmbed | 小模型可快速启动 | 轻量模型适合作为入门候选，但不应据此直接假设适合作为默认多语言方案 |
| openclaw-mem | sentence-transformers 接入简单 | 接口成熟，但会引入 PyTorch / Transformers 级依赖 |
| openclaw-mem | 默认 multilingual-e5-small | 多语言场景的好选择，470MB 可接受 |
| 社区实测 | 小模型在小批量下 CPU 可能有优势 | 这类结论高度依赖 batch size、设备和 runtime，不宜作为通用前提 |
| OpenClaw | node-llama-cpp 可选依赖导致安装问题 | **避免 GGUF + C++ 原生编译方案**，优先选纯 Python / 预编译 wheel |

## 7. LanceDB + sentence-transformers 方案分析

### 7.1 LanceDB Embedding 注册表

LanceDB 提供了内置的 **Embedding Function Registry**，支持多种 embedding provider 开箱即用：

```python
import lancedb
from lancedb.embeddings import get_registry
from lancedb.pydantic import LanceModel, Vector

# 获取 sentence-transformers 的 embedding 函数
embedder = (
    get_registry()
    .get("sentence-transformers")
    .create(name="all-MiniLM-L6-v2", device="cpu")
)

# 定义 schema
class Documents(LanceModel):
    text: str = embedder.SourceField()
    vector: Vector(embedder.ndims()) = embedder.VectorField()

# 自动 embedding — 写入时自动生成向量
db = lancedb.connect("~/.lancedb")
table = db.create_table("docs", schema=Documents)
table.add([{"text": "hello world"}])

# 查询时自动 embedding
results = table.search("hello").limit(5).to_pandas()
```

**核心特点**：
- **透明集成**：写入和查询时自动调用 embedding 函数，用户无需手动管理向量化
- **多 provider 支持**：sentence-transformers、OpenAI、HuggingFace、Cohere 等
- **CPU 优先**：通过 `device="cpu"` 直接在 CPU 上推理，无需 GPU

### 7.2 默认本地模型：all-MiniLM-L6-v2

| 属性 | 值 |
|---|---|
| 维度 | 384 |
| 参数量 | 22M |
| 模型大小 | ~80MB |
| 语言 | 英文 |
| CPU 推理速度 | 较快（适合作为轻量 baseline） |

> **修正**：对于 all-MiniLM-L6-v2 这类小模型，在**小批量、消费级设备、MPS/核显等场景下**，CPU 可能与 GPU 持平甚至更快；但这不是通用定律，不能直接外推到批量索引构建或更大模型。

### 7.3 ArkClaw 与 LanceDB 记忆系统

**ArkClaw** 是字节跳动 / 火山引擎的云端 OpenClaw 托管服务。OpenClaw 的记忆系统使用 LanceDB 作为向量存储后端。

#### 官方 memory-lancedb 插件

OpenClaw 官方提供 `@openclaw/memory-lancedb` 插件，使用 **OpenAI API** 进行 embedding：

- **模型**：`text-embedding-3-small`（默认）或 `text-embedding-3-large`
- **推理方式**：通过 OpenAI API 远程调用，需要 API Key
- **依赖**：`import OpenAI from "openai"`，直接调用 `client.embeddings.create()`
- **Schema 限制**：configSchema 仅允许 `text-embedding-3-small` / `text-embedding-3-large` 两个模型

```json
{
  "memory": {
    "provider": "lancedb",
    "config": {
      "embedding": {
        "model": "text-embedding-3-small",
        "apiKey": "sk-..."
      }
    }
  }
}
```

> **注意**：社区存在使用 `bge-small-zh-v1.5` 的第三方项目（如 `jamesqin-cn/bge-small-zh-v1.5`），提供 OpenAI 兼容的本地 embedding HTTP 服务，但这不是 ArkClaw 官方默认行为。

社区强烈要求支持本地 embedding（相关 Issue：#23817、#21811、#8118、#36458）。

#### OpenClaw 内置 memorySearch（非 LanceDB）

OpenClaw 还内置了 memorySearch 功能（不依赖 LanceDB 插件），支持多种 embedding provider：

- **provider 选项**：`openai`、`gemini`、`voyage`、`mistral`、`bedrock`、`ollama`、`local`
- **local 模式**：默认模型 `embeddinggemma-300m-qat-Q8_0.gguf`（~0.6GB），通过 node-llama-cpp 本地 GGUF 推理
- **自动检测顺序**：local → openai → gemini → voyage → mistral → bedrock
- **fallback 链**：local (node-llama-cpp) → OpenAI Batch API → Gemini → BM25-only

##### node-llama-cpp 集成方式（非内置，可选依赖）

**关键发现**：`node-llama-cpp` **不是打包进 OpenClaw 的**，而是作为 optional dependency 存在，需要用户额外执行原生编译步骤：

```bash
pnpm approve-builds
pnpm rebuild node-llama-cpp
```

模型文件 `embeddinggemma-300m-qat-Q8_0.gguf` 是首次使用时自动从 HuggingFace 下载的。

**这种方式导致了大量安装问题**：

| 问题 | Issue |
|---|---|
| 普通 `npm install` 后 node-llama-cpp 缺失，local embedding 不可用 | [#47251](https://github.com/openclaw/openclaw/issues/47251) |
| 升级后 node-llama-cpp 静默丢失，memory search 被禁用 | [#46569](https://github.com/openclaw/openclaw/issues/46569) |
| Gateway 是 CommonJS，node-llama-cpp v3.x 是 ESM-only，模块不兼容 | [#49711](https://github.com/openclaw/openclaw/issues/49711) |
| Windows 上已禁用 node-llama-cpp 自动安装（防止安装失败） | yarn 包发布说明 |
| `openclaw doctor` 误报 local model file not found | [#28944](https://github.com/openclaw/openclaw/issues/28944) |
| NixOS 上 node-llama-cpp 编译失败 | 社区讨论 |

**教训**：GGUF + 原生 C++ 推理库的方案虽然性能好，但**安装体验是严重痛点**。OpenClaw 社区多次反映这个可选依赖机制不可靠。

```json
{
  "agents": {
    "defaults": {
      "memorySearch": {
        "provider": "local",
        "local": {
          "modelPath": "auto-downloaded"
        }
      }
    }
  }
}
```

#### 第三方本地方案

**方案一：memory-lancedb-local**（by 48Nauts-Operator）

为 memory-lancedb 添加本地 embedding 支持，通过 Ollama / LM Studio 等 OpenAI 兼容本地服务：

```json
{
  "memory": {
    "provider": "lancedb",
    "config": {
      "embeddingModel": "nomic-embed-text",
      "embeddingApiKey": "not-needed",
      "embeddingBaseUrl": "http://localhost:11434/v1"
    }
  }
}
```

仍需运行独立的 Ollama 进程，不是真正的零配置。

**方案二：openclaw-mem**（by kjaylee）

完整的本地优先 RAG 记忆系统，**内置 sentence-transformers**，无需任何外部服务：

- 默认模型：`intfloat/multilingual-e5-small`（384 维，~470MB，多语言）
- 搜索准确率：100%（测试集）
- 查询响应时间：0.38s
- 零配置：安装即用，无需 API Key
- 支持通过环境变量切换模型

### 7.4 方案全景对比

| 维度 | QMD（GGUF） | memory-lancedb 插件 | OpenClaw 内置 memorySearch |
|---|---|---|---|
| 推理引擎 | node-llama-cpp (C++) | OpenAI API（远程） | node-llama-cpp (C++) |
| 模型格式 | GGUF（量化） | N/A（远程 API） | GGUF（量化） |
| 默认模型 | embeddinggemma-300M (300MB) | text-embedding-3-small | embeddinggemma-300M (~0.6GB) |
| 本地推理 | 是 | **否** | 是（provider: "local"） |
| 需 API Key | 否 | **是** | 否（local 模式） |
| 依赖 | node-llama-cpp | openai npm | node-llama-cpp |

### 7.5 对 OpenViking 的启示

LanceDB 方案提供了一个重要参考：**小模型 + CPU 推理**有机会提供不错的零配置体验，但前提是模型选择、查询/文档 prompt、索引构建吞吐和安装依赖都处理得当。

- **all-MiniLM-L6-v2（80MB）**：首次下载快，适合作为英文 baseline，但不适合作为 OpenViking 的默认多语言模型
- **multilingual-e5-small（470MB）**：多语言支持，维度 384，CPU 性能可接受
- **sentence-transformers** 作为推理后端的 Python 生态最成熟，但 PyTorch 依赖较重
- **fastembed**（基于 ONNX Runtime）可以作为更轻量的替代，且原生支持 `query` / `passage` 前缀，比较贴近检索 embedding 场景

## 8. 风险与注意事项

1. **原生编译依赖的安装体验**（最高优先级）：OpenClaw 的 node-llama-cpp 实践证明，GGUF + C++ 原生推理库方案安装体验风险很高。Python 生态中的 `llama-cpp-python` 也存在类似风险。若目标是“开箱即用”，应优先考虑预编译 wheel 路线，如 `fastembed` 或 `sentence-transformers`。
2. **query/document 编码语义缺失**：E5、BGE、Qwen3-Embedding 这类模型通常需要 query/document prompt 或 instruction。当前 `embed(text)` 接口不足以表达该差异，这不是实现细节，而是 API 设计问题。
3. **向量维度与索引迁移**：当前 schema 维度来自配置并在建表时固定；切换模型不仅要“重新 embedding”，还要考虑 collection schema、索引重建和旧数据清理。
4. **批量构建性能**：当前队列链路按条处理消息，尚未利用批量编码。即便选了高性能本地模型，索引构建吞吐仍可能受限于框架层。
5. **模型下载体验**：首次使用需要下载模型，需良好的进度提示、失败重试、镜像源和离线缓存策略。
6. **内存与磁盘占用**：模型文件和常驻内存会明显增加资源消耗，尤其在长生命周期 agent 进程中需要有释放策略。

## 9. 修正后的结论

整体方向是**合理的**：OpenViking 补齐“本地 CPU embedding”能够显著降低首次使用门槛，也符合 Discussion #601 的讨论方向。

但原始文档有两个需要纠正的地方：

1. 它对当前 OpenViking 能力的描述略偏“理想化”，把一些仓库里尚未实现的 provider / 接口能力写成了既有事实。
2. 它对实现复杂度的估计偏乐观，低估了 query/document prompt、静态维度、索引迁移、批量吞吐和依赖打包这些代码层面的硬约束。

基于当前代码，推荐的实现顺序是：

1. **第一阶段**：引入 `backend: "local"`，优先采用 `fastembed` 这类预编译 wheel 路线，以 optional extra 形式提供，例如 `openviking[local-embed]`。
2. **第二阶段**：扩展 embedder 接口，显式区分 `embed_query` / `embed_document`，或至少在 `embed(..., is_query=...)` 层面补齐语义。
3. **第三阶段**：为 collection 持久化模型元数据（backend/model/dimension），模型变化时触发显式 rebuild，而不是依赖用户手工记忆。
4. **第四阶段**：补批量 embedding、下载进度、缓存目录和 benchmark，再决定“本地 embedding”是否应成为默认配置。

## 参考资料

- [QMD GitHub 仓库](https://github.com/tobi/qmd)
- [QMD README](https://github.com/tobi/qmd/blob/main/README.md)
- [OpenViking Discussion #601：参考 QMD 设计](https://github.com/volcengine/OpenViking/discussions/601)
- [QMD Issue #521：支持外部 API embedding provider](https://github.com/tobi/qmd/issues/521)
- [QMD Issue #489：远程 Ollama embedding 支持](https://github.com/tobi/qmd/issues/489)
- [OpenClaw Issue #17263：QMD embedding 配置说明](https://github.com/openclaw/openclaw/issues/17263)
- [OpenClaw Issue #20346：CPU-only 环境超时问题](https://github.com/openclaw/openclaw/issues/20346)
- [OpenClaw Issue #36458：本地 embedding 支持需求](https://github.com/openclaw/openclaw/issues/36458)
- [OpenClaw Issue #47251：memorySearch local 安装后 node-llama-cpp 缺失](https://github.com/openclaw/openclaw/issues/47251)
- [OpenClaw Issue #46569：升级后 node-llama-cpp 静默丢失](https://github.com/openclaw/openclaw/issues/46569)
- [OpenClaw Issue #49711：node-llama-cpp ESM/CommonJS 不兼容](https://github.com/openclaw/openclaw/issues/49711)
- [OpenClaw Issue #28944：openclaw doctor 误报 local model 缺失](https://github.com/openclaw/openclaw/issues/28944)
- [LanceDB Embedding Functions 文档](https://lancedb.github.io/lancedb/embeddings/)
- [LanceDB Embedding Registry](https://lancedb.github.io/lancedb/embeddings/default_embedding/)
- [memory-lancedb-local（第三方本地方案）](https://github.com/48Nauts-Operator/memory-lancedb-local)
- [openclaw-mem（第三方本地 RAG 记忆）](https://github.com/kjaylee/openclaw-mem)
- [OpenClaw Memory Config 官方文档](https://docs.openclaw.ai/reference/memory-config)
- [bge-small-zh-v1.5 第三方 embedding 服务](https://github.com/jamesqin-cn/bge-small-zh-v1.5)
