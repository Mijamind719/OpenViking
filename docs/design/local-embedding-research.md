# 本地 Embedding 模型支持调研报告

> 调研日期：2026-04-11
> 相关讨论：[Discussion #601](https://github.com/volcengine/OpenViking/discussions/601)

## 1. 背景

当前 OpenViking 主干代码中的 embedding 功能依赖远程 API 服务，用户通常需要先准备 API Key 和模型配置才能使用，这对新用户体验是一道门槛。

本报告主要参考两个外部方向：
1. **QMD 方案**：Shopify 创始人 Tobi Lütke 开发的本地混合搜索引擎，采用 GGUF 量化小模型实现零配置本地推理
2. **OpenClaw / ArkClaw memory 本地方案**：OpenClaw 官方 memorySearch 支持 `local` provider，ArkClaw 环境中的 `memory-lancedb-ultra` 也可配置本地 embedding

## 2. QMD 方案分析

### 2.1 QMD 是什么

- **项目地址**：[github.com/tobi/qmd](https://github.com/tobi/qmd)
- **定位**：on-device 搜索引擎，支持 BM25 + 向量语义搜索 + LLM 重排序
- **运行环境**：Node.js / Bun，使用 `node-llama-cpp` 作为 GGUF 推理引擎
- **协议**：MIT

### 2.2 本地模型体系

QMD 的关键点不是具体用了哪几个模型，而是它把 embedding、reranking、query expansion 都做成了**自动下载、自动缓存、按需加载**的本地能力。对 OpenViking 最值得参考的是：

- embedding 模型可单独工作，不必和 reranker 绑定交付
- 默认模型体积控制在几百 MB 级别，首次体验可接受
- 模型切换后明确要求重新生成向量，避免“悄悄不兼容”

### 2.3 核心设计

#### 自动下载与缓存

模型以 HuggingFace URI 格式配置，首次调用时自动下载。

#### 懒加载与生命周期管理

- embedding/reranking 上下文空闲 **5 分钟后释放**
- 下次请求时透明重建（约 1s 延迟，模型本身保持加载在内存）
- 显式 `close()` 释放所有模型和数据库连接

#### 模型切换

通过环境变量支持切换到其他 GGUF 模型，例如切换到多语言的 Qwen3-Embedding。

> 注意：切换模型后必须重新生成所有向量，因为向量不跨模型兼容。Prompt 格式会根据模型家族自动调整。

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

## 3. OpenClaw / ArkClaw Memory 本地推理方案

### 3.1 官方默认路径

OpenClaw 官方文档已经明确支持 `memorySearch.provider: "local"`。当 `memorySearch.local.modelPath` 已配置且文件存在时，自动检测顺序也会优先选择 `local`。这说明 OpenClaw 的官方 memory 能力本身已经支持本地 embedding，而不是只能依赖远程 API。

### 3.2 memorySearch 与 ArkClaw 插件配置

OpenClaw 内置的 `memorySearch` 走本地路线时，会使用 GGUF 模型，并在官方文档中要求 `node-llama-cpp` 的原生构建步骤。

你提供的 ArkClaw 配置进一步说明，除了框架级 `memorySearch`，ArkClaw 环境中的 `memory-lancedb-ultra` 也支持插件级本地 embedding。例如：

```json
{
  "slots": { "memory": "memory-lancedb-ultra" },
  "entries": {
    "memory-lancedb-ultra": {
      "enabled": true,
      "config": {
        "embedding": {
          "provider": "local",
          "localModelPath": "/root/.node-llama-cpp/models/hf_CompendiumLabs_bge-small-zh-v1.5-f16.gguf"
        }
      }
    }
  }
}
```

这段配置至少能确认三点：

1. ArkClaw 的 memory 插件路径已经支持 `embedding.provider: "local"`。
2. 本地模型可以通过 `localModelPath` 显式指定。
3. 当前实际使用的是本地 GGUF embedding 模型，且路径位于 `.node-llama-cpp` 缓存目录下。

因此，对 OpenClaw / ArkClaw 更准确的判断应当是：**本地 embedding 能力已经具备，主要风险在原生依赖和部署运维，而不是能力缺失。**

### 3.3 对 OpenViking 的启示

OpenClaw / ArkClaw 的经验说明了两件事：

1. “默认本地 embedding”在产品方向上是可行的，用户价值也明确。
2. 如果实现目标是“开箱即用”，应尽量避免把方案建立在原生编译依赖之上。

因此，OpenClaw / ArkClaw 更像是为 OpenViking 提供了**产品方向上的支持**和**工程风险上的反例**。

## 4. OpenViking 当前 Embedding 架构（按代码校验）

### 4.1 支持的 Provider

| Backend | 模式 | 实现类 |
|---|---|---|
| `volcengine` | Dense, Sparse, Hybrid | `VolcengineDenseEmbedder` 等 |
| `openai` | Dense | `OpenAIDenseEmbedder` |
| `vikingdb` | Dense, Sparse, Hybrid | `VikingDBDenseEmbedder` 等 |

以上三类均是**远程 API 调用**。当前仓库里没有 `jina` / `voyage` / `ollama` 专用 embedder；如果要接 OpenAI-compatible 本地服务，只能复用 `openai` backend 并自定义 `api_base`，这仍然属于“外部服务模式”，不是进程内本地推理。

### 4.2 类层次结构

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

### 4.3 配置系统

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

### 4.4 数据流

```
资源导入 → SemanticProcessor 生成摘要
         → EmbeddingMsgConverter 从 Context 生成 EmbeddingMsg 并入队
         → QueueManager 消费 → TextEmbeddingHandler 调用 embedder.embed()
         → 向量写入 context collection（VikingVectorIndex backend）
         → HierarchicalRetriever 查询时复用同一 embedder
```

### 4.5 现有本地支持

OpenViking 目前**没有内置本地推理**能力（无 sentence-transformers、ONNX、llama-cpp 等依赖）。

间接支持方式：
1. **OpenAI-compatible 本地服务**：通过 `backend: "openai"` + 自定义 `api_base`，指向 Ollama / llama.cpp server / vLLM / text-embeddings-inference 等兼容接口
2. **自建 VikingDB embedding API**：通过 `backend: "vikingdb"` 走外部 embedding 服务

这两种方式都需要用户**额外部署和运维一个服务**，不是零配置体验。

### 4.6 现有代码约束（本报告补充）

以下约束在原始调研中没有展开，但对实现路线影响很大：

1. **backend 白名单是硬编码的**：当前校验只接受 `openai` / `volcengine` / `vikingdb`，因此本地推理不是“新增一个类”就能完成，而是要同步修改配置校验、工厂注册和文档。
2. **向量维度是配置期静态值**：context collection 的 schema 直接使用 `config.embedding.dimension` 建表，入库时也会严格校验返回向量长度。若模型切换导致维度变化，现有集合不能透明复用，必须设计重建或迁移流程。
3. **embedder 在 client 初始化阶段即实例化**：`AsyncOpenViking` 构造时会立即 `get_embedder()`。这意味着本地模型下载、权重检查、依赖缺失等问题会变成启动期问题，而不是首次查询时再暴露。
4. **当前写入链路按消息逐条 embedding**：`TextEmbeddingHandler.on_dequeue()` 处理的是单条 `EmbeddingMsg`，并未利用 `batch_size` 做批量编码。因此本地 CPU 索引构建吞吐会比“模型本身 benchmark”更差。
5. **当前 pyproject 没有本地推理依赖**：主干依赖中不存在 `sentence-transformers`、`transformers`、`torch`、`onnxruntime`、`fastembed`、`llama-cpp-python`。无论选哪条路线，都要考虑 optional extra、wheel 体积和跨平台安装体验。

## 5. Discussion #601 讨论倾向

### 主要建议

1. **默认使用本地 embedding 模型**：参考 QMD，零配置启动，无需 API Key
2. **解耦 embedding 和 reranker**：embedding 必需，reranker 可选
3. **模型配置策略**：未配置时默认使用本地模型（如 Qwen3-Embedding-0.6B）

### 维护者反馈

- **@ZaynJarvis**：先支持本地模型接入，后续根据 benchmark 结果决定定位（默认选项 vs 高级选项）
- **@MaojiaSheng**：关注首次模型下载的体验是否流畅

## 6. 可选实现路径对比

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
| `multilingual-e5-small` | 384 | ~470MB | 多语言 | 良好 | 多语言轻量候选 |
| `Qwen3-Embedding-0.6B` | 1024 | ~640MB | 100+ 语言 | 优秀 | 高质量多语言候选 |
| `nomic-embed-text-v1.5` | 768 | ~274MB | 英文 | 良好 | Ollama 生态 |
| `bge-small-en-v1.5` | 384 | ~33MB | 英文 | 良好 | FastEmbed 默认 |
| `bge-micro-v2` | 384 | ~23MB | 英文 | 可用（极小） | 极端资源受限 |

## 7. 对 OpenViking 的关键启示

| 来源 | 做法 | OpenViking 可借鉴点 |
|---|---|---|
| QMD | GGUF 量化模型 + node-llama-cpp | 可借鉴的是“自动下载、懒加载、模型切换约束”；推理后端未必需要照搬 GGUF |
| QMD | 自动下载 + HuggingFace 缓存 | 实现模型自动下载到 `~/.cache/openviking/models/` |
| QMD | 懒加载 + 空闲释放 | 进程内保持模型，避免重复加载开销 |
| QMD | 环境变量切换模型 | OpenViking 可通过 `backend: "local"` + `model` 字段配置，但必须同时设计索引重建 |
| QMD | ~300MB 小模型起步 | 首次下载约 10 秒，可接受 |
| QMD | Prompt 格式自适应 | 对检索模型需要区分 query/document prompt；当前 OpenViking 接口尚未具备 |
| FastEmbed | 预编译 wheel + 轻量模型 | 轻量路线更贴近“开箱即用”的目标，可作为 `backend: "local"` 的优先实现方向 |
| E5 / BGE 一类检索模型 | query/document 前缀敏感 | 如果选这类模型，必须补齐 `embed_query` / `embed_document` 或等价语义接口 |
| 社区实测 | 小模型在小批量下 CPU 可能有优势 | 这类结论高度依赖 batch size、设备和 runtime，不宜作为通用前提 |
| OpenClaw | node-llama-cpp 可选依赖导致安装问题 | **避免 GGUF + C++ 原生编译方案**，优先选纯 Python / 预编译 wheel |

## 8. 风险与注意事项

1. **原生编译依赖的安装体验**（最高优先级）：OpenClaw 的 node-llama-cpp 实践证明，GGUF + C++ 原生推理库方案安装体验风险很高。Python 生态中的 `llama-cpp-python` 也存在类似风险。若目标是“开箱即用”，应优先考虑预编译 wheel 路线，如 `fastembed` 或 `sentence-transformers`。
2. **query/document 编码语义缺失**：E5、BGE、Qwen3-Embedding 这类模型通常需要 query/document prompt 或 instruction。当前 `embed(text)` 接口不足以表达该差异，这不是实现细节，而是 API 设计问题。
3. **向量维度与索引迁移**：当前 schema 维度来自配置并在建表时固定；切换模型不仅要“重新 embedding”，还要考虑 collection schema、索引重建和旧数据清理。
4. **批量构建性能**：当前队列链路按条处理消息，尚未利用批量编码。即便选了高性能本地模型，索引构建吞吐仍可能受限于框架层。
5. **模型下载体验**：首次使用需要下载模型，需良好的进度提示、失败重试、镜像源和离线缓存策略。
6. **内存与磁盘占用**：模型文件和常驻内存会明显增加资源消耗，尤其在长生命周期 agent 进程中需要有释放策略。

## 9. 实现顺序

整体方向是**合理的**：OpenViking 补齐“本地 CPU embedding”能够显著降低首次使用门槛，也符合 Discussion #601 的讨论方向。

基于当前代码，推荐的实现顺序是：

1. **第一阶段**：引入 `backend: "local"`，优先采用 `fastembed` 这类预编译 wheel 路线，以 optional extra 形式提供，例如 `openviking[local-embed]`。
2. **第二阶段**：扩展 embedder 接口，显式区分 `embed_query` / `embed_document`，或至少在 `embed(..., is_query=...)` 层面补齐语义。
3. **第三阶段**：为 collection 持久化模型元数据（backend/model/dimension），模型变化时触发显式 rebuild，而不是依赖用户手工记忆。
4. **第四阶段**：补批量 embedding、下载进度、缓存目录和 benchmark，再决定“本地 embedding”是否应成为默认配置。

## 10. 参考资料

- [QMD GitHub 仓库](https://github.com/tobi/qmd)
- [QMD README](https://github.com/tobi/qmd/blob/main/README.md)
- [OpenViking Discussion #601：参考 QMD 设计](https://github.com/volcengine/OpenViking/discussions/601)
- [FastEmbed 文档](https://qdrant.github.io/fastembed/)
- [OpenClaw Memory Config 官方文档](https://docs.openclaw.ai/reference/memory-config)
