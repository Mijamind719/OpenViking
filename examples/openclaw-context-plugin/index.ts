import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

import { OpenVikingClient, clampScore, dedupeByUri, isMemoryUri, localClientCache } from "./client.js";
import { contextOpenVikingConfigSchema } from "./config.js";
import { formatFindItems, summarizeContextItems, wrapContextBlock } from "./formatters.js";
import {
  buildRecallQuery,
  estimateTokens,
  extractMessageText,
  selectFreshTail,
  shouldAutoRecall,
  shouldRecallResources,
} from "./heuristics.js";
import {
  IS_WIN,
  prepareLocalPort,
  resolvePythonCommand,
  waitForHealth,
} from "./process-manager.js";
import { Schema } from "./schema.js";
import {
  readSessionFileMessages,
  saveContextState,
  syncSessionMessages,
} from "./session-mirror.js";
import type {
  ContextPluginState,
  FindResultItem,
  MessageLike,
  RecallScope,
  RequiredContextOpenVikingConfig,
} from "./types.js";

const MAX_OPENVIKING_STDERR_LINES = 200;
const MAX_OPENVIKING_STDERR_CHARS = 256_000;

type AssembleBucket = {
  tag: string;
  title: string;
  items: FindResultItem[];
};

function postProcessItems(
  items: FindResultItem[],
  limit: number,
  scoreThreshold: number,
): FindResultItem[] {
  return dedupeByUri(items)
    .filter((item) => clampScore(item.score) >= scoreThreshold)
    .sort((a, b) => clampScore(b.score) - clampScore(a.score))
    .slice(0, limit);
}

function buildInjectedMessages(buckets: AssembleBucket[]): Array<{ role: "user"; content: string }> {
  return buckets
    .filter((bucket) => bucket.items.length > 0)
    .map((bucket) => {
      const body = summarizeContextItems(bucket.items, bucket.title) ?? bucket.title;
      return {
        role: "user" as const,
        content: wrapContextBlock(bucket.tag, bucket.title, body),
      };
    });
}

function buildSystemPromptAddition(): string {
  return [
    "OpenViking context is available.",
    "Use automatic assembled context first.",
    "Use ov_recall for explicit search, ov_expand for deeper reads, and ov_commit_memory when the user explicitly asks you to remember something durable.",
  ].join("\n");
}

function coerceMessages(value: unknown): MessageLike[] {
  return Array.isArray(value) ? (value as MessageLike[]) : [];
}

async function fetchSessionContext(params: {
  client: OpenVikingClient;
  ovSessionId: string | null;
  query: string;
  cfg: RequiredContextOpenVikingConfig;
}): Promise<FindResultItem[]> {
  if (!params.ovSessionId || !params.query) {
    return [];
  }
  const historyUri = await params.client.getSessionHistoryUri(params.ovSessionId);
  const result = await params.client.find(params.query, {
    targetUri: historyUri,
    limit: Math.max(params.cfg.recallLimit * 2, 8),
    scoreThreshold: 0,
  });
  const all = [
    ...(result.memories ?? []),
    ...(result.resources ?? []),
    ...(result.skills ?? []),
  ];
  return postProcessItems(all, Math.min(params.cfg.recallLimit, 4), params.cfg.recallScoreThreshold);
}

async function fetchMemoryContext(params: {
  client: OpenVikingClient;
  query: string;
  cfg: RequiredContextOpenVikingConfig;
}): Promise<FindResultItem[]> {
  if (!params.query) {
    return [];
  }
  const [userResult, agentResult] = await Promise.allSettled([
    params.client.find(params.query, {
      targetUri: "viking://user/memories",
      limit: Math.max(params.cfg.recallLimit * 3, 12),
      scoreThreshold: 0,
    }),
    params.client.find(params.query, {
      targetUri: "viking://agent/memories",
      limit: Math.max(params.cfg.recallLimit * 3, 12),
      scoreThreshold: 0,
    }),
  ]);

  const merged = [
    ...(userResult.status === "fulfilled" ? userResult.value.memories ?? [] : []),
    ...(agentResult.status === "fulfilled" ? agentResult.value.memories ?? [] : []),
  ];
  return postProcessItems(merged, params.cfg.recallLimit, params.cfg.recallScoreThreshold);
}

async function fetchResourceContext(params: {
  client: OpenVikingClient;
  query: string;
  cfg: RequiredContextOpenVikingConfig;
}): Promise<FindResultItem[]> {
  if (!params.query || !shouldRecallResources(params.query)) {
    return [];
  }
  const [resourceResult, skillResult] = await Promise.allSettled([
    params.client.find(params.query, {
      targetUri: "viking://resources",
      limit: 6,
      scoreThreshold: 0,
    }),
    params.client.find(params.query, {
      targetUri: "viking://agent/skills",
      limit: 6,
      scoreThreshold: 0,
    }),
  ]);

  const merged = [
    ...(resourceResult.status === "fulfilled"
      ? [
          ...(resourceResult.value.memories ?? []),
          ...(resourceResult.value.resources ?? []),
          ...(resourceResult.value.skills ?? []),
        ]
      : []),
    ...(skillResult.status === "fulfilled"
      ? [
          ...(skillResult.value.memories ?? []),
          ...(skillResult.value.resources ?? []),
          ...(skillResult.value.skills ?? []),
        ]
      : []),
  ];
  return postProcessItems(merged, 4, Math.max(0.1, params.cfg.recallScoreThreshold));
}

const contextPlugin = {
  id: "context-openviking",
  name: "Context Engine (OpenViking)",
  description: "OpenViking-backed context engine with session mirroring and compaction",
  kind: "context-engine" as const,
  configSchema: contextOpenVikingConfigSchema,

  register(api: OpenClawPluginApi) {
    const cfg = contextOpenVikingConfigSchema.parse(api.pluginConfig);
    const localCacheKey = `${cfg.mode}:${cfg.baseUrl}:${cfg.configPath}:${cfg.apiKey}`;
    const stateBySessionId = new Map<string, ContextPluginState>();

    let clientPromise: Promise<OpenVikingClient>;
    let localProcess: ReturnType<typeof spawn> | null = null;
    let resolveLocalClient: ((client: OpenVikingClient) => void) | null = null;
    let rejectLocalClient: ((err: unknown) => void) | null = null;

    if (cfg.mode === "local") {
      const cached = localClientCache.get(localCacheKey);
      if (cached) {
        localProcess = cached.process;
        clientPromise = Promise.resolve(cached.client);
      } else {
        clientPromise = new Promise<OpenVikingClient>((resolve, reject) => {
          resolveLocalClient = resolve;
          rejectLocalClient = reject;
        });
      }
    } else {
      clientPromise = Promise.resolve(
        new OpenVikingClient(cfg.baseUrl, cfg.apiKey, cfg.agentId, cfg.timeoutMs),
      );
    }

    const getClient = (): Promise<OpenVikingClient> => clientPromise;

    api.registerTool(
      {
        name: "ov_recall",
        label: "OpenViking Recall",
        description: "Search OpenViking session, memory, resource, or skill context.",
        parameters: Schema.Object({
          query: Schema.String({ description: "Search query" }),
          scopes: Schema.Optional(
            Schema.Array(Schema.String({ description: "session | memory | resource | skill" })),
          ),
          limit: Schema.Optional(Schema.Number({ description: "Maximum results per scope" })),
          targetUri: Schema.Optional(Schema.String({ description: "Exact target URI override" })),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          const query = String(params.query ?? "").trim();
          const limit =
            typeof params.limit === "number" && Number.isFinite(params.limit)
              ? Math.max(1, Math.floor(params.limit))
              : cfg.recallLimit;
          const scopes = Array.isArray(params.scopes)
            ? (params.scopes.filter((value): value is RecallScope => {
                return typeof value === "string" &&
                  ["session", "memory", "resource", "skill"].includes(value);
              }) as RecallScope[])
            : (["memory"] as RecallScope[]);

          if (!query) {
            return {
              content: [{ type: "text", text: "Query is required." }],
              details: { count: 0 },
            };
          }

          const client = await getClient();
          const outputs: FindResultItem[] = [];

          if (typeof params.targetUri === "string" && params.targetUri.trim()) {
            const result = await client.find(query, {
              targetUri: params.targetUri,
              limit: Math.max(limit * 2, 8),
              scoreThreshold: 0,
            });
            outputs.push(
              ...(result.memories ?? []),
              ...(result.resources ?? []),
              ...(result.skills ?? []),
            );
          } else {
            for (const scope of scopes) {
              if (scope === "memory") {
                outputs.push(...(await fetchMemoryContext({ client, query, cfg })));
              } else if (scope === "resource") {
                outputs.push(...(await fetchResourceContext({ client, query, cfg })));
              } else if (scope === "skill") {
                const result = await client.find(query, {
                  targetUri: "viking://agent/skills",
                  limit: Math.max(limit * 2, 8),
                  scoreThreshold: 0,
                });
                outputs.push(
                  ...(result.memories ?? []),
                  ...(result.resources ?? []),
                  ...(result.skills ?? []),
                );
              } else if (
                scope === "session" &&
                typeof (api.runtime as { sessionId?: unknown }).sessionId === "string"
              ) {
                const runtimeSessionId = String((api.runtime as { sessionId?: unknown }).sessionId);
                const state = stateBySessionId.get(runtimeSessionId) ?? {
                  ovSessionId: null,
                  mirroredMessageCount: 0,
                  lastCommittedMessageCount: 0,
                  updatedAt: new Date(0).toISOString(),
                };
                outputs.push(...(await fetchSessionContext({
                  client,
                  ovSessionId: state.ovSessionId,
                  query,
                  cfg,
                })));
              }
            }
          }

          const items = postProcessItems(outputs, Math.max(limit * 2, 8), cfg.recallScoreThreshold);
          if (items.length === 0) {
            return {
              content: [{ type: "text", text: "No relevant OpenViking context found." }],
              details: { count: 0 },
            };
          }

          return {
            content: [{ type: "text", text: formatFindItems(items) }],
            details: { count: items.length, items },
          };
        },
      },
      { name: "ov_recall" },
    );

    api.registerTool(
      {
        name: "ov_commit_memory",
        label: "OpenViking Commit Memory",
        description: "Store durable memory in OpenViking when the user explicitly asks to remember something.",
        parameters: Schema.Object({
          content: Schema.String({ description: "Memory content to store" }),
          role: Schema.Optional(Schema.String({ description: "Session role, defaults to user" })),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          const text = String(params.content ?? "").trim();
          const role = typeof params.role === "string" && params.role.trim() ? params.role.trim() : "user";
          if (!text) {
            return {
              content: [{ type: "text", text: "Content is required." }],
              details: { stored: false },
            };
          }

          const client = await getClient();
          const sessionId = await client.createSession();
          try {
            await client.addSessionMessage(sessionId, role, text);
            const extracted = await client.extractSessionMemories(sessionId);
            return {
              content: [{ type: "text", text: `Stored memory source and extracted ${extracted.length} memories.` }],
              details: { stored: true, extractedCount: extracted.length, extracted },
            };
          } finally {
            await client.deleteSession(sessionId).catch(() => {});
          }
        },
      },
      { name: "ov_commit_memory" },
    );

    api.registerTool(
      {
        name: "ov_forget",
        label: "OpenViking Forget",
        description: "Delete a durable memory by URI or by high-confidence search match.",
        parameters: Schema.Object({
          uri: Schema.Optional(Schema.String({ description: "Exact memory URI to delete" })),
          query: Schema.Optional(Schema.String({ description: "Search query to locate memory" })),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          const client = await getClient();
          const uri = typeof params.uri === "string" ? params.uri.trim() : "";
          if (uri) {
            if (!isMemoryUri(uri)) {
              return {
                content: [{ type: "text", text: `Refusing to delete non-memory URI: ${uri}` }],
                details: { deleted: false },
              };
            }
            await client.deleteUri(uri);
            return {
              content: [{ type: "text", text: `Deleted ${uri}` }],
              details: { deleted: true, uri },
            };
          }

          const query = typeof params.query === "string" ? params.query.trim() : "";
          if (!query) {
            return {
              content: [{ type: "text", text: "Provide uri or query." }],
              details: { deleted: false },
            };
          }
          const candidates = await fetchMemoryContext({ client, query, cfg });
          const memoryCandidates = candidates.filter((item) => isMemoryUri(item.uri));
          if (memoryCandidates.length === 1 && clampScore(memoryCandidates[0]?.score) >= 0.85) {
            await client.deleteUri(memoryCandidates[0]!.uri);
            return {
              content: [{ type: "text", text: `Deleted ${memoryCandidates[0]!.uri}` }],
              details: { deleted: true, uri: memoryCandidates[0]!.uri },
            };
          }
          return {
            content: [{ type: "text", text: memoryCandidates.length ? formatFindItems(memoryCandidates) : "No matching durable memory found." }],
            details: { deleted: false, candidates: memoryCandidates },
          };
        },
      },
      { name: "ov_forget" },
    );

    api.registerTool(
      {
        name: "ov_expand",
        label: "OpenViking Expand",
        description: "Read an OpenViking URI directly for deeper detail.",
        parameters: Schema.Object({
          uri: Schema.String({ description: "OpenViking URI to read" }),
        }),
        async execute(_toolCallId: string, params: Record<string, unknown>) {
          const uri = String(params.uri ?? "").trim();
          if (!uri) {
            return {
              content: [{ type: "text", text: "URI is required." }],
              details: { ok: false },
            };
          }
          const content = await (await getClient()).read(uri);
          return {
            content: [{ type: "text", text: content }],
            details: { ok: true, uri },
          };
        },
      },
      { name: "ov_expand" },
    );

    api.registerContextEngine("context-openviking", () => ({
      info: {
        id: "context-openviking",
        name: "Context Engine (OpenViking)",
        ownsCompaction: true,
      },

      async bootstrap(params: { sessionId: string; sessionFile: string }) {
        try {
          const { importedCount, state } = await syncSessionMessages({
            client: await getClient(),
            sessionFile: params.sessionFile,
          });
          stateBySessionId.set(params.sessionId, state);
          return {
            bootstrapped: true,
            importedMessages: importedCount,
          };
        } catch (error) {
          api.logger.warn(`context-openviking: bootstrap failed: ${String(error)}`);
          return {
            bootstrapped: false,
            reason: String(error),
          };
        }
      },

      async ingest() {
        return { ingested: true };
      },

      async afterTurn(params: {
        sessionId: string;
        sessionFile: string;
        messages: MessageLike[];
        prePromptMessageCount: number;
      }) {
        try {
          const sourceMessages = params.messages.slice(params.prePromptMessageCount);
          const allMessages = params.messages.length > 0 ? params.messages : await readSessionFileMessages(params.sessionFile);
          const result = await syncSessionMessages({
            client: await getClient(),
            sessionFile: params.sessionFile,
            sourceMessages: allMessages,
          });
          stateBySessionId.set(params.sessionId, result.state);
          api.logger.info?.(
            `context-openviking: synced ${result.importedCount} messages after turn (delta=${sourceMessages.length})`,
          );
        } catch (error) {
          api.logger.warn(`context-openviking: afterTurn sync failed: ${String(error)}`);
        }
      },

      async assemble(params: { sessionId: string; messages: MessageLike[]; tokenBudget?: number }) {
        const state = stateBySessionId.get(params.sessionId) ?? {
          ovSessionId: null,
          mirroredMessageCount: 0,
          lastCommittedMessageCount: 0,
          updatedAt: new Date(0).toISOString(),
        };
        const allMessages = coerceMessages(params.messages);
        const committed = Math.min(state.lastCommittedMessageCount, allMessages.length);
        const rawSourceMessages = allMessages.slice(committed);
        const freshTail = selectFreshTail(rawSourceMessages, cfg.freshTailMessages);
        const query = buildRecallQuery(rawSourceMessages.length > 0 ? rawSourceMessages : allMessages);
        const buckets: AssembleBucket[] = [];

        if (cfg.autoRecallEnabled && shouldAutoRecall(query)) {
          try {
            const client = await getClient();
            const [sessionItems, memoryItems, resourceItems] = await Promise.all([
              fetchSessionContext({ client, ovSessionId: state.ovSessionId, query, cfg }),
              fetchMemoryContext({ client, query, cfg }),
              cfg.resourceRecallEnabled
                ? fetchResourceContext({ client, query, cfg })
                : Promise.resolve([]),
            ]);

            buckets.push(
              { tag: "openviking-session-context", title: "OpenViking Session Continuity", items: sessionItems },
              { tag: "openviking-durable-memory", title: "OpenViking Durable Memory", items: memoryItems },
              { tag: "openviking-resource-context", title: "OpenViking Resources and Skills", items: resourceItems },
            );
          } catch (error) {
            api.logger.warn(`context-openviking: assemble recall failed: ${String(error)}`);
          }
        }

        const injectedMessages = buildInjectedMessages(buckets);
        const assembledMessages = [...injectedMessages, ...freshTail];
        const estimatedTokens = assembledMessages.reduce((sum, message) => {
          return sum + estimateTokens(extractMessageText(message));
        }, 0);

        return {
          messages: assembledMessages as typeof params.messages,
          estimatedTokens,
          systemPromptAddition: buildSystemPromptAddition(),
        };
      },

      async compact(params: {
        sessionId: string;
        sessionFile: string;
        force?: boolean;
      }) {
        try {
          const client = await getClient();
          const sync = await syncSessionMessages({
            client,
            sessionFile: params.sessionFile,
          });
          const state = sync.state;
          stateBySessionId.set(params.sessionId, state);

          if (!state.ovSessionId) {
            return {
              ok: true,
              compacted: false,
              reason: "missing_openviking_session",
            };
          }
          if (!params.force && state.mirroredMessageCount <= state.lastCommittedMessageCount) {
            return {
              ok: true,
              compacted: false,
              reason: "no_new_messages",
            };
          }

          const result = await client.commitSession(state.ovSessionId);
          const nextState: ContextPluginState = {
            ...state,
            lastCommittedMessageCount: state.mirroredMessageCount,
            updatedAt: new Date().toISOString(),
          };
          await saveContextState(params.sessionFile, nextState);
          stateBySessionId.set(params.sessionId, nextState);

          return {
            ok: true,
            compacted: true,
            result: {
              summary: "OpenViking session commit completed.",
              tokensBefore: 0,
              tokensAfter: 0,
              details: result,
            },
          };
        } catch (error) {
          api.logger.warn(`context-openviking: compact failed: ${String(error)}`);
          return {
            ok: false,
            compacted: false,
            reason: String(error),
          };
        }
      },

      async dispose() {
        if (localProcess) {
          localProcess.kill("SIGTERM");
          localClientCache.delete(localCacheKey);
          localProcess = null;
        }
      },
    }));

    api.registerService({
      id: "context-openviking",
      start: async () => {
        if (cfg.mode !== "local" || !resolveLocalClient || !rejectLocalClient) {
          await (await getClient()).healthCheck().catch(() => {});
          api.logger.info?.(`context-openviking: initialized (${cfg.baseUrl})`);
          return;
        }

        const actualPort = await prepareLocalPort(cfg.port, api.logger);
        const baseUrl = `http://127.0.0.1:${actualPort}`;
        const pythonCmd = resolvePythonCommand(api.logger);
        const pathSep = IS_WIN ? ";" : ":";
        const env = {
          ...process.env,
          PYTHONUNBUFFERED: "1",
          PYTHONWARNINGS: "ignore::RuntimeWarning",
          OPENVIKING_CONFIG_FILE: cfg.configPath,
          OPENVIKING_START_CONFIG: cfg.configPath,
          OPENVIKING_START_HOST: "127.0.0.1",
          OPENVIKING_START_PORT: String(actualPort),
          ...(process.env.OPENVIKING_GO_PATH && {
            PATH: `${process.env.OPENVIKING_GO_PATH}${pathSep}${process.env.PATH || ""}`,
          }),
        };

        const runpyCode = `import sys,os,warnings; warnings.filterwarnings('ignore', category=RuntimeWarning, message='.*sys.modules.*'); sys.argv=['openviking.server.bootstrap','--config',os.environ['OPENVIKING_START_CONFIG'],'--host',os.environ.get('OPENVIKING_START_HOST','127.0.0.1'),'--port',os.environ['OPENVIKING_START_PORT']]; import runpy, importlib.util; spec=importlib.util.find_spec('openviking.server.bootstrap'); (runpy.run_path(spec.origin, run_name='__main__') if spec and getattr(spec,'origin',None) else runpy.run_module('openviking.server.bootstrap', run_name='__main__', alter_sys=True))`;
        const child = spawn(pythonCmd, ["-c", runpyCode], {
          env,
          cwd: IS_WIN ? tmpdir() : "/tmp",
          stdio: ["ignore", "pipe", "pipe"],
        });

        localProcess = child;
        const stderrChunks: string[] = [];
        let stderrChars = 0;
        const pushStderr = (chunk: string) => {
          if (!chunk) {
            return;
          }
          stderrChunks.push(chunk);
          stderrChars += chunk.length;
          while (
            stderrChunks.length > MAX_OPENVIKING_STDERR_LINES ||
            stderrChars > MAX_OPENVIKING_STDERR_CHARS
          ) {
            const dropped = stderrChunks.shift();
            if (!dropped) {
              break;
            }
            stderrChars -= dropped.length;
          }
        };

        child.stderr?.on("data", (chunk: Buffer) => {
          pushStderr(String(chunk).trim());
        });
        child.on("exit", () => {
          if (localProcess === child) {
            localProcess = null;
            localClientCache.delete(localCacheKey);
          }
        });

        try {
          await waitForHealth(baseUrl, 60000, 500);
          const client = new OpenVikingClient(baseUrl, cfg.apiKey, cfg.agentId, cfg.timeoutMs);
          localClientCache.set(localCacheKey, { client, process: child });
          resolveLocalClient?.(client);
          rejectLocalClient = null;
          api.logger.info?.(`context-openviking: local server started (${baseUrl})`);
        } catch (error) {
          child.kill("SIGTERM");
          localProcess = null;
          rejectLocalClient?.(error);
          rejectLocalClient = null;
          const extra = stderrChunks.length > 0 ? `\n[openviking stderr]\n${stderrChunks.join("\n")}` : "";
          throw new Error(`context-openviking startup failed: ${String(error)}${extra}`);
        }
      },
      stop: async () => {
        if (cfg.mode === "remote") {
          return;
        }
        if (localProcess) {
          localProcess.kill("SIGTERM");
          localClientCache.delete(localCacheKey);
          localProcess = null;
          api.logger.info?.("context-openviking: local server stopped");
        }
      },
    });
  },
};

export default contextPlugin;
