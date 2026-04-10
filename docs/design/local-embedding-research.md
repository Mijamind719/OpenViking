# 本地 Embedding 模型支持调研报告

> 调研日期：2026-04-10
> 相关讨论：[Discussion #601](https://github.com/volcengine/OpenViking/discussions/601)

## 1. 背景

当前 OpenViking 的 embedding 功能依赖远程 API 服务（Volcengine、OpenAI、Jina 等），新用户需要申请 API Key 并配置后才能使用。这对新用户体验是一道门槛。

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

## 3. OpenViking 当前 Embedding 架构

### 3.1 支持的 Provider

| Provider | 模式 | 实现类 |
|---|---|---|
| `volcengine` | Dense, Sparse, Hybrid | `VolcengineDenseEmbedder` 等 |
| `openai` | Dense | `OpenAIDenseEmbedder` |
| `jina` | Dense | `JinaDenseEmbedder` |
| `voyage` | Dense | `VoyageDenseEmbedder` |
| `vikingdb` | Dense, Sparse, Hybrid | `VikingDBDenseEmbedder` 等 |
| `ollama` | Dense（本地） | 复用 `OpenAIDenseEmbedder`，指向 localhost |

所有 provider 本质都是**远程 API 调用**。ollama 虽然是本地部署，但仍需启动独立的 Ollama 服务进程。

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
    def embed(self, text: str, is_query: bool = False) -> EmbedResult: ...
    def embed_batch(self, texts: List[str], is_query: bool = False) -> List[EmbedResult]: ...
    def get_dimension(self) -> int: ...
```

### 3.3 配置系统

配置定义在 `openviking_cli/utils/config/embedding_config.py`，通过 Pydantic 模型验证：

```json
{
  "embedding": {
    "dense": {
      "provider": "volcengine",
      "model": "doubao-embedding-vision-250615",
      "api_key": "{your-api-key}",
      "dimension": 1024
    }
  }
}
```

Provider 注册通过 factory_registry 映射 `(provider, type)` 到具体实现类。

### 3.4 数据流

```
资源导入 → SemanticProcessor 生成摘要
         → EmbeddingUtils 创建 Context → EmbeddingMsg 入队
         → QueueManager 消费 → TextEmbeddingHandler 调用 embedder.embed()
         → 向量写入 LocalCollectionAdapter（RocksDB）
         → HierarchicalRetriever 查询时复用同一 embedder
```

### 3.5 现有本地支持

OpenViking 目前**没有内置本地推理**能力（无 sentence-transformers、ONNX、llama-cpp 等依赖）。

间接支持方式：
1. **Ollama provider**：配置指向 `http://localhost:11434/v1`，使用 nomic-embed-text 等模型
2. **OpenAI-compatible 本地服务**：文档中提到可用 llama.cpp / vLLM 等部署 Jina GGUF 模型

这两种方式都需要用户**额外部署和运维一个服务**，不是零配置体验。

## 4. Discussion #601 社区共识

### 核心建议

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
| `all-MiniLM-L6-v2` | 384 | ~80MB | 英文 | 良好 | 极致轻量，LanceDB 默认 |
| `embeddinggemma-300M` | 768 | ~300MB | 英文优化 | 良好 | QMD 默认 |
| `multilingual-e5-small` | 384 | ~470MB | 多语言 | 良好 | openclaw-mem 默认 |
| `Qwen3-Embedding-0.6B` | 1024 | ~600MB | 119 种语言 | 优秀 | 多语言首选 |
| `nomic-embed-text-v1.5` | 768 | ~274MB | 英文 | 良好 | Ollama 生态 |
| `bge-small-en-v1.5` | 384 | ~33MB | 英文 | 良好 | ArkClaw memory-lancedb 默认 |
| `bge-micro-v2` | 384 | ~23MB | 英文 | 可用（极小） | 极端资源受限 |

## 6. 对 OpenViking 的关键启示

| 来源 | 做法 | OpenViking 可借鉴点 |
|---|---|---|
| QMD | GGUF 量化模型 + node-llama-cpp | Python 项目可选用 `llama-cpp-python` 或 `fastembed` |
| QMD | 自动下载 + HuggingFace 缓存 | 实现模型自动下载到 `~/.cache/openviking/models/` |
| QMD | 懒加载 + 空闲释放 | 进程内保持模型，避免重复加载开销 |
| QMD | 环境变量切换模型 | 通过 `ov.conf` 的 `provider: "local"` + `model` 字段配置 |
| QMD | ~300MB 小模型起步 | 首次下载约 10 秒，可接受 |
| QMD | Prompt 格式自适应 | 不同模型需要不同的 prompt 模板 |
| LanceDB | Embedding 注册表模式 | 可设计 `LocalEmbedderRegistry` 统一管理本地模型 |
| LanceDB | all-MiniLM-L6-v2 仅 80MB | **极致轻量选项**，首次下载极快，CPU 推理极快 |
| openclaw-mem | sentence-transformers 零配置 | `pip install sentence-transformers` 即可使用 |
| openclaw-mem | 默认 multilingual-e5-small | 多语言场景的好选择，470MB 可接受 |
| 社区实测 | 小模型 CPU > GPU | 22M 参数的模型在 CPU 上反而更快（无数据传输开销） |
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
| CPU 推理速度 | **极快**（小模型下 CPU 比 GPU 更快） |

> **性能关键发现**：对于 22M 参数的小模型（如 all-MiniLM-L6-v2），CPU 推理实际上比 MPS/GPU **更快**，因为数据传输到 GPU 的开销超过了计算节省。这在 LanceDB 社区实测中得到验证。

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

LanceDB 方案提供了一个重要的参考：**超小模型 + CPU 推理**可以提供足够好的零配置体验。

- **all-MiniLM-L6-v2（80MB）**：首次下载极快，CPU 推理极快，但仅英文、维度低（384）
- **multilingual-e5-small（470MB）**：多语言支持，维度 384，CPU 性能可接受
- **sentence-transformers** 作为推理后端的 Python 生态最成熟，但 PyTorch 依赖较重
- **fastembed**（基于 ONNX Runtime）可以作为更轻量的替代，提供类似的模型支持但依赖更少

## 8. 风险与注意事项

1. **原生编译依赖的安装体验**（最高优先级）：OpenClaw 的 node-llama-cpp 实践证明，GGUF + C++ 原生推理库方案**安装体验是严重痛点**——升级丢失、跨平台失败、模块系统不兼容。Python 生态中 `llama-cpp-python` 面临同样问题。**推荐优先选择纯 Python / 预编译 wheel 方案（fastembed / sentence-transformers）**。
2. **CPU 性能瓶颈**：本地 embedding 在 CPU 上速度有限，大批量索引构建可能很慢
3. **模型下载**：首次使用需要下载模型，需良好的进度提示和错误处理
4. **向量兼容性**：切换模型后需重新生成所有向量
5. **内存占用**：模型加载后常驻内存（300MB-1GB），对资源受限环境有影响

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
