import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

import { clampScore, isMemoryUri } from "./client.js";
import {
  createEmptyState,
  fetchMemoryContext,
  fetchResourceContext,
  fetchSessionContext,
} from "./assembler.js";
import { formatFindItems } from "./formatters.js";
import { Schema } from "./schema.js";
import type {
  ContextPluginState,
  FindResultItem,
  RecallScope,
  RequiredContextOpenVikingConfig,
} from "./types.js";
import type { OpenVikingClient } from "./client.js";

function resolveSessionState(params: {
  api: OpenClawPluginApi;
  explicitSessionId?: string;
  stateBySessionId: Map<string, ContextPluginState>;
}): ContextPluginState {
  const runtimeSessionId =
    typeof params.api.runtime.sessionId === "string" ? String(params.api.runtime.sessionId) : null;
  const sessionId = params.explicitSessionId ?? runtimeSessionId;
  return sessionId ? (params.stateBySessionId.get(sessionId) ?? createEmptyState()) : createEmptyState();
}

function dedupeItems(items: FindResultItem[]): FindResultItem[] {
  return items.filter((item, index, array) => {
    return index === array.findIndex((candidate) => candidate.uri === item.uri);
  });
}

export function registerOpenVikingTools(params: {
  api: OpenClawPluginApi;
  cfg: RequiredContextOpenVikingConfig;
  getClient: () => Promise<OpenVikingClient>;
  stateBySessionId: Map<string, ContextPluginState>;
}) {
  const { api, cfg, getClient, stateBySessionId } = params;

  api.registerTool({
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
      sessionId: Schema.Optional(
        Schema.String({ description: "OpenClaw session id override for session-scope recall" }),
      ),
    }),
    async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
      const query = String(rawParams.query ?? "").trim();
      const limit =
        typeof rawParams.limit === "number" && Number.isFinite(rawParams.limit)
          ? Math.max(1, Math.floor(rawParams.limit))
          : cfg.recallLimit;
      const scopes = Array.isArray(rawParams.scopes)
        ? (rawParams.scopes.filter((value): value is RecallScope => {
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

      if (typeof rawParams.targetUri === "string" && rawParams.targetUri.trim()) {
        const result = await client.find(query, {
          targetUri: rawParams.targetUri.trim(),
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
            continue;
          }
          if (scope === "resource") {
            outputs.push(...(await fetchResourceContext({ client, query, cfg })));
            continue;
          }
          if (scope === "skill") {
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
            continue;
          }
          if (scope === "session") {
            const sessionState = resolveSessionState({
              api,
              explicitSessionId:
                typeof rawParams.sessionId === "string" && rawParams.sessionId.trim()
                  ? rawParams.sessionId.trim()
                  : undefined,
              stateBySessionId,
            });
            outputs.push(...(await fetchSessionContext({
              client,
              ovSessionId: sessionState.ovSessionId,
              query,
              cfg,
            })));
          }
        }
      }

      const items = dedupeItems(outputs)
        .sort((a, b) => clampScore(b.score) - clampScore(a.score))
        .slice(0, Math.max(limit * 2, 8));
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
  });

  api.registerTool({
    name: "ov_commit_memory",
    label: "OpenViking Commit Memory",
    description: "Store durable memory in OpenViking when the user explicitly asks to remember something.",
    parameters: Schema.Object({
      content: Schema.String({ description: "Memory content to store" }),
      role: Schema.Optional(Schema.String({ description: "Session role, defaults to user" })),
    }),
    async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
      const text = String(rawParams.content ?? "").trim();
      const role =
        typeof rawParams.role === "string" && rawParams.role.trim() ? rawParams.role.trim() : "user";
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
  });

  api.registerTool({
    name: "ov_forget",
    label: "OpenViking Forget",
    description: "Delete a durable memory by URI or by high-confidence search match.",
    parameters: Schema.Object({
      uri: Schema.Optional(Schema.String({ description: "Exact memory URI to delete" })),
      query: Schema.Optional(Schema.String({ description: "Search query to locate memory" })),
      minScore: Schema.Optional(Schema.Number({ description: "Minimum score for query-based deletion" })),
    }),
    async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
      const client = await getClient();
      const uri = typeof rawParams.uri === "string" ? rawParams.uri.trim() : "";
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

      const query = typeof rawParams.query === "string" ? rawParams.query.trim() : "";
      const minScore =
        typeof rawParams.minScore === "number" && Number.isFinite(rawParams.minScore)
          ? Math.max(0, Math.min(1, rawParams.minScore))
          : 0.85;
      if (!query) {
        return {
          content: [{ type: "text", text: "Provide uri or query." }],
          details: { deleted: false },
        };
      }
      const candidates = await fetchMemoryContext({ client, query, cfg });
      const memoryCandidates = candidates.filter((item) => isMemoryUri(item.uri));
      if (memoryCandidates.length === 1 && clampScore(memoryCandidates[0]?.score) >= minScore) {
        await client.deleteUri(memoryCandidates[0]!.uri);
        return {
          content: [{ type: "text", text: `Deleted ${memoryCandidates[0]!.uri}` }],
          details: { deleted: true, uri: memoryCandidates[0]!.uri },
        };
      }
      return {
        content: [
          {
            type: "text",
            text: memoryCandidates.length
              ? formatFindItems(memoryCandidates)
              : "No matching durable memory found.",
          },
        ],
        details: { deleted: false, candidates: memoryCandidates, minScore },
      };
    },
  });

  api.registerTool({
    name: "ov_expand",
    label: "OpenViking Expand",
    description: "Read an OpenViking URI directly for deeper detail.",
    parameters: Schema.Object({
      uri: Schema.String({ description: "OpenViking URI to read" }),
      maxChars: Schema.Optional(Schema.Number({ description: "Optional character limit for returned content" })),
    }),
    async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
      const uri = String(rawParams.uri ?? "").trim();
      const maxChars =
        typeof rawParams.maxChars === "number" && Number.isFinite(rawParams.maxChars)
          ? Math.max(200, Math.floor(rawParams.maxChars))
          : 12000;
      if (!uri) {
        return {
          content: [{ type: "text", text: "URI is required." }],
          details: { ok: false },
        };
      }
      const content = await (await getClient()).read(uri);
      const trimmedContent =
        content.length > maxChars
          ? `${content.slice(0, maxChars)}\n\n[truncated ${content.length - maxChars} chars]`
          : content;
      return {
        content: [{ type: "text", text: trimmedContent }],
        details: { ok: true, uri, truncated: trimmedContent !== content, fullLength: content.length },
      };
    },
  });
}
