# Local Embedding Llama-cpp Design

Date: 2026-04-11
Status: approved for implementation

## Goal

Add built-in local dense embedding support to OpenViking with these product
behaviors:

- when the user does not explicitly configure `embedding`, OpenViking defaults
  to a local embedding backend
- the default local model is `bge-small-zh-v1.5-f16`
- local inference uses `llama-cpp-python` with a GGUF model
- installation risk is isolated from the main package by distributing local
  inference dependencies through an optional extra

The resulting system should be implementable without changing the user-facing
goal: "local embedding is the default behavior."

## Scope

In scope:

- new `embedding.backend = "local"` backend
- default implicit local embedding config when the user does not supply any
  embedding config
- `llama-cpp-python`-based dense embedder
- default model selection for `bge-small-zh-v1.5-f16`
- model path resolution, download, and cache directory behavior
- query/document embedding role separation
- collection metadata checks and rebuild requirements
- startup-time validation and error messages
- tests and benchmark scaffolding

Out of scope for the first implementation:

- local sparse embedding
- local hybrid embedding
- automatic silent fallback from local to remote providers
- background dependency installation at runtime
- replacing existing remote providers

## Decision Summary

OpenViking will adopt the following combined strategy:

1. Product default: if the user does not configure embedding, OpenViking
   implicitly selects a local embedding backend.
2. Dependency distribution: `llama-cpp-python` is not added to the main
   dependency set. Instead, local inference is distributed through an optional
   extra such as `openviking[local-embed]`.
3. Default local model: `bge-small-zh-v1.5-f16`.
4. Failure behavior: if default local embedding is selected but local
   dependencies or model assets are unavailable, OpenViking fails loudly with a
   precise recovery message. It does not silently fall back to a remote model.

This is intentionally different from copying QMD exactly. QMD can bind
`node-llama-cpp` as a main dependency because it is a Node CLI product. For
OpenViking, which is a Python SDK and service component, installation failure
of a native dependency would be too costly if it blocked the base package.

## Why This Design

The research and current codebase constraints point to the same conclusion:

- QMD validates the product direction: default local embedding is valuable.
- OpenClaw and ArkClaw validate that local GGUF-based memory search is useful.
- OpenViking's current architecture validates that dependency failures surface
  during startup, not later.
- Python packaging makes native dependency failures more expensive than in the
  QMD npm flow.

This design preserves the product behavior we want while reducing the blast
radius of native installation failures.

## User-Facing Behavior

### Default Behavior

If `embedding` is absent from configuration:

- OpenViking synthesizes an implicit local dense embedding config
- backend is set to `local`
- model is set to `bge-small-zh-v1.5-f16`
- dimension is set to the model dimension

The user should experience this as "local embedding is the default."

### Explicit Behavior

If the user explicitly configures `embedding`, that explicit config wins. This
includes:

- explicit `backend: "local"`
- explicit remote backends such as `openai`, `volcengine`, or `vikingdb`
- explicit `model_path`
- explicit `cache_dir`

No hidden rewriting should override explicit user configuration.

### Installation Experience

Base install:

```bash
pip install openviking
```

Local embedding install:

```bash
pip install "openviking[local-embed]"
```

If the user relies on the default local behavior but did not install the local
extra, startup must fail with an actionable error that includes:

- that OpenViking defaulted to local embedding
- that `llama-cpp-python` is missing
- the exact install command to enable local embedding
- how to explicitly switch to a remote backend instead

## Configuration Design

Add `local` as a valid embedding backend in `EmbeddingModelConfig`.

Supported fields for the local dense backend:

- `backend`: `"local"`
- `model`: logical model name, default `bge-small-zh-v1.5-f16`
- `model_path`: optional explicit GGUF path
- `cache_dir`: optional cache root, default `~/.cache/openviking/models/`
- `dimension`: optional but normally derived from the built-in model registry
- `batch_size`: retained for future batch embedding support

Proposed example:

```json
{
  "embedding": {
    "dense": {
      "backend": "local",
      "model": "bge-small-zh-v1.5-f16",
      "cache_dir": "~/.cache/openviking/models"
    }
  }
}
```

Explicit model path example:

```json
{
  "embedding": {
    "dense": {
      "backend": "local",
      "model": "bge-small-zh-v1.5-f16",
      "model_path": "/data/models/bge-small-zh-v1.5-f16.gguf"
    }
  }
}
```

## Architecture

### New Components

Add a new dense embedder implementation, for example:

- `openviking/models/embedder/local_embedders.py`
- `LocalDenseEmbedder`

Its responsibilities:

- validate `llama-cpp-python` availability
- resolve logical model name to a GGUF model spec
- resolve or download the model file
- initialize the llama embedding context
- implement query/document role-aware embedding methods
- report the model dimension
- clean up native resources on `close()`

### Factory and Config Changes

Update:

- `EmbeddingModelConfig.validate_config()` to accept `backend == "local"`
- `EmbeddingConfig._create_embedder()` to route `("local", "dense")`
- default config synthesis logic so missing embedding config becomes local dense

### Model Registry

Add an internal registry for built-in local models. First version can be a
simple mapping keyed by logical model name:

- logical model name
- GGUF download URL or HuggingFace locator
- expected dimension
- preferred prompt rules
- optional file name

Initial entry:

- `bge-small-zh-v1.5-f16`

## Query vs Document Encoding

This is a required part of the design, not an optional optimization.

Models in the BGE/E5 family are retrieval-oriented. They perform better when
the system distinguishes:

- query text: user search requests
- document text: stored memory or context chunks

OpenViking currently exposes only `embed(text)`. That is insufficient.

The design adds explicit role-aware APIs:

- `embed_query(text: str) -> EmbedResult`
- `embed_document(text: str) -> EmbedResult`

For compatibility, `embed(text)` may remain as a thin wrapper that defaults to
document mode or delegates through an explicit role flag internally. New code in
retrieval should call `embed_query()`. New code in indexing should call
`embed_document()`.

Role formatting rules must live inside the local embedder implementation rather
than being scattered across call sites.

## Model Resolution and Download Flow

### Resolution Order

1. If `model_path` is configured, use it directly.
2. Else resolve `model` through the built-in local model registry.
3. If the resolved file is absent, download it into `cache_dir`.
4. Initialize `llama-cpp-python` against that resolved GGUF file.

### Cache Directory

Default:

- `~/.cache/openviking/models/`

Behavior:

- create the directory when needed
- keep downloaded GGUF files there
- do not re-download if the resolved file already exists

### Download Policy

First version should support:

- visible, structured error reporting
- deterministic file naming
- retryable manual rerun after failure

First version does not need:

- resumable downloads
- multi-mirror fallback
- background downloader

## Startup and Failure Behavior

OpenViking currently initializes the embedder during client startup. The local
design preserves that behavior.

This means the following failures happen early and explicitly:

- local extra not installed
- `llama-cpp-python` import failure
- model file missing and download fails
- GGUF file exists but cannot be loaded
- collection metadata conflicts with the configured model

### Error Handling Rules

Missing local dependency:

- raise a clear configuration/runtime error
- include: missing package name, suggested install command, and how to choose a
  remote backend explicitly

Model download failure:

- raise an error with logical model name, resolved URL, cache dir, and original
  exception

Model load failure:

- raise an error indicating GGUF incompatibility, corruption, or unsupported
  build/runtime combination

Metadata mismatch:

- raise an error that current embedding settings are incompatible with the
  existing index and require rebuild

No silent fallback:

- the system must not silently switch to `openai`, `volcengine`, or `vikingdb`
  when local initialization fails

## Collection Metadata and Rebuild Rules

The current system validates only vector dimension at write time. That is not
enough once local models become the default.

Persist at least these metadata fields with the collection:

- `embedding_backend`
- `embedding_model`
- `embedding_dimension`
- `embedding_model_identity`

`embedding_model_identity` should distinguish models even when the visible model
name stays constant. It may be:

- resolved model path
- hash of resolved model path
- file hash if inexpensive enough

### Rebuild Rule

If any of the following changes:

- backend
- model
- dimension
- model identity

then the existing vectors are treated as incompatible. The system should either:

- stop startup with a rebuild-required error, or
- invoke an explicit rebuild flow when the user chooses to do so

The first implementation should prefer explicit rebuild over implicit migration.

## Data Flow Changes

### Indexing

Current flow:

- semantic processing produces text
- queue worker calls `embed()`

New flow:

- queue worker calls `embed_document()`
- local embedder applies document formatting rules
- resulting vectors are stored with metadata-consistent collection settings

### Retrieval

Current flow:

- retriever calls `embed()`

New flow:

- retriever calls `embed_query()`
- local embedder applies query formatting rules
- retriever searches against vectors produced from the matching document mode

## Batch Embedding Strategy

First version may ship with correct single-item behavior, but the design must
reserve a path for batch optimization.

Phase 1:

- implement `embed_batch()` in `LocalDenseEmbedder`
- allow queue code to keep using single-item processing if needed

Phase 2:

- add queue-side aggregation so multiple pending embedding messages can be
  encoded together

Without batch support, CPU indexing throughput will likely underperform model
benchmarks.

## Development Plan

1. Add `local` backend validation and factory wiring.
2. Add implicit default local embedding config when embedding is absent.
3. Implement `LocalDenseEmbedder` with `llama-cpp-python`.
4. Add built-in local model registry with `bge-small-zh-v1.5-f16`.
5. Add model path resolution, cache directory handling, and download logic.
6. Add role-aware APIs: `embed_query()` and `embed_document()`.
7. Persist collection embedding metadata and add mismatch detection.
8. Add rebuild-required error flow.
9. Add `embed_batch()` and initial benchmark hooks.
10. Update docs, examples, and install guidance.

## Test Plan

### Configuration Tests

- missing `embedding` yields implicit local dense config
- explicit remote config disables implicit local default
- `model_path` overrides logical model resolution
- `cache_dir` override is honored

### Dependency and Initialization Tests

- missing `llama-cpp-python` produces the expected startup error
- explicit local backend with installed dependency initializes successfully
- invalid GGUF path produces model load failure
- failed download produces actionable error text

### Embedding Behavior Tests

- `embed_query()` and `embed_document()` take different code paths
- returned vector dimension matches model dimension
- `embed_batch()` preserves order and cardinality

### Metadata and Rebuild Tests

- first startup creates metadata consistent with the configured local model
- changing model identity causes rebuild-required failure
- changing dimension causes rebuild-required failure

### Retrieval Regression Tests

- Chinese query retrieves Chinese document content with the local model
- query/document split does not regress existing retrieval pipeline semantics
- existing remote providers still behave unchanged

### Packaging Tests

- `pip install openviking` succeeds without local dependencies
- `pip install "openviking[local-embed]"` enables local import path
- missing extra + implicit local default produces a clear error instead of an
  ambiguous import failure

## Benchmarks

Record at least:

- startup time with installed dependency and cached model
- first-run time with model download
- single-item embedding latency
- batch embedding latency
- indexing throughput on a representative Chinese corpus

Benchmarks are required before deciding whether this default should remain
permanent for all environments.

## Operator Guidance

Recommended install commands:

```bash
pip install "openviking[local-embed]"
```

If the user wants remote embedding instead:

- explicitly configure `embedding.dense.backend`
- provide the corresponding provider credentials

## Risks

- native dependency installation failure
- incomplete wheel coverage across platforms
- GGUF compatibility issues across runtime versions
- startup failure surprise for users who expect zero additional setup
- index incompatibility after model changes
- indexing throughput lag without batch aggregation

## Deliverables

- local dense embedder implementation
- local backend config and factory integration
- built-in model registry
- startup error messages and install guidance
- collection metadata checks
- rebuild-required handling
- tests and benchmark scaffolding
- updated user documentation
