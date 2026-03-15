import type { OpenVikingClient } from "./client.js";
import { clampScore, dedupeByUri } from "./client.js";
import { summarizeContextItems, wrapContextBlock } from "./formatters.js";
import {
  buildRecallQuery,
  estimateTokens,
  extractMessageText,
  selectFreshTail,
  shouldAutoRecall,
  shouldRecallResources,
} from "./heuristics.js";
import type {
  ContextPluginState,
  FindResultItem,
  MessageLike,
  RequiredContextOpenVikingConfig,
} from "./types.js";

export type AssembleBucket = {
  tag: string;
  title: string;
  items: FindResultItem[];
};

export type AssembleLogger = {
  warn?: (msg: string) => void;
};

export type AssembleContextResult = {
  messages: MessageLike[];
  estimatedTokens: number;
  systemPromptAddition: string;
  diagnostics: {
    query: string;
    rawTailCount: number;
    injectedBucketCount: number;
  };
};

export function createEmptyState(): ContextPluginState {
  return {
    ovSessionId: null,
    mirroredMessageCount: 0,
    lastCommittedMessageCount: 0,
    updatedAt: new Date(0).toISOString(),
  };
}

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

function estimateMessageTokens(messages: MessageLike[]): number {
  return messages.reduce((sum, message) => sum + estimateTokens(extractMessageText(message)), 0);
}

function fitMessagesToBudget(messages: MessageLike[], budget: number | undefined): MessageLike[] {
  if (typeof budget !== "number" || !Number.isFinite(budget) || budget <= 0) {
    return messages;
  }
  if (messages.length === 0) {
    return messages;
  }

  const output = [...messages];
  while (output.length > 1 && estimateMessageTokens(output) > budget) {
    output.shift();
  }
  return output;
}

function buildInjectedMessage(bucket: AssembleBucket): MessageLike | null {
  if (bucket.items.length === 0) {
    return null;
  }
  const body = summarizeContextItems(bucket.items, bucket.title) ?? bucket.title;
  return {
    role: "user",
    content: wrapContextBlock(bucket.tag, bucket.title, body),
  };
}

function fitBucketToBudget(
  bucket: AssembleBucket,
  remainingBudget: number | undefined,
): AssembleBucket | null {
  if (bucket.items.length === 0) {
    return null;
  }
  if (typeof remainingBudget !== "number" || !Number.isFinite(remainingBudget) || remainingBudget <= 0) {
    return bucket;
  }

  const fittedItems: FindResultItem[] = [];
  for (const item of bucket.items) {
    fittedItems.push(item);
    const maybeMessage = buildInjectedMessage({ ...bucket, items: fittedItems });
    if (!maybeMessage) {
      continue;
    }
    if (estimateMessageTokens([maybeMessage]) > remainingBudget) {
      fittedItems.pop();
      break;
    }
  }

  return fittedItems.length > 0 ? { ...bucket, items: fittedItems } : null;
}

function splitProfileItems(items: FindResultItem[]): {
  profileItems: FindResultItem[];
  durableItems: FindResultItem[];
} {
  const profileItems: FindResultItem[] = [];
  const durableItems: FindResultItem[] = [];

  for (const item of items) {
    const category = (item.category ?? "").toLowerCase();
    const uri = item.uri.toLowerCase();
    if (
      category.includes("profile") ||
      category.includes("preference") ||
      uri.includes("/profile") ||
      uri.includes("/preferences/")
    ) {
      profileItems.push(item);
      continue;
    }
    durableItems.push(item);
  }

  return { profileItems, durableItems };
}

export function buildSystemPromptAddition(): string {
  return [
    "OpenViking context is available.",
    "Use automatic assembled context first.",
    "Use ov_recall for explicit search, ov_expand for deeper reads, and ov_commit_memory when the user explicitly asks you to remember something durable.",
  ].join("\n");
}

export async function fetchSessionContext(params: {
  client: OpenVikingClient;
  ovSessionId: string | null;
  query: string;
  cfg: RequiredContextOpenVikingConfig;
}): Promise<FindResultItem[]> {
  if (!params.ovSessionId || !params.query) {
    return [];
  }

  const historyUris = await params.client.getSessionHistoryUris(params.ovSessionId);
  for (const historyUri of historyUris) {
    try {
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
      const processed = postProcessItems(
        all,
        Math.min(params.cfg.recallLimit, 4),
        params.cfg.recallScoreThreshold,
      );
      if (processed.length > 0) {
        return processed;
      }
    } catch {
      // Try the next URI form.
    }
  }

  return [];
}

export async function fetchMemoryContext(params: {
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

export async function fetchResourceContext(params: {
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

export async function assembleOpenVikingContext(params: {
  client: OpenVikingClient;
  state: ContextPluginState | undefined;
  messages: MessageLike[];
  tokenBudget?: number;
  cfg: RequiredContextOpenVikingConfig;
  logger?: AssembleLogger;
}): Promise<AssembleContextResult> {
  const state = params.state ?? createEmptyState();
  const committed = Math.min(state.lastCommittedMessageCount, params.messages.length);
  const rawSourceMessages = params.messages.slice(committed);
  const freshTailSource = selectFreshTail(
    rawSourceMessages.length > 0 ? rawSourceMessages : params.messages,
    params.cfg.freshTailMessages,
  );
  const freshTail = fitMessagesToBudget(freshTailSource, params.tokenBudget);
  const query = buildRecallQuery(rawSourceMessages.length > 0 ? rawSourceMessages : params.messages);
  const buckets: AssembleBucket[] = [];

  if (params.cfg.autoRecallEnabled && shouldAutoRecall(query)) {
    const [sessionResult, memoryResult, resourceResult] = await Promise.allSettled([
      fetchSessionContext({
        client: params.client,
        ovSessionId: state.ovSessionId,
        query,
        cfg: params.cfg,
      }),
      fetchMemoryContext({
        client: params.client,
        query,
        cfg: params.cfg,
      }),
      params.cfg.resourceRecallEnabled
        ? fetchResourceContext({
            client: params.client,
            query,
            cfg: params.cfg,
          })
        : Promise.resolve([]),
    ]);

    if (sessionResult.status === "fulfilled" && sessionResult.value.length > 0) {
      buckets.push({
        tag: "openviking-session-context",
        title: "OpenViking Session Continuity",
        items: sessionResult.value,
      });
    } else if (sessionResult.status === "rejected") {
      params.logger?.warn?.(`context-openviking: session recall failed: ${String(sessionResult.reason)}`);
    }

    if (memoryResult.status === "fulfilled" && memoryResult.value.length > 0) {
      const { profileItems, durableItems } = splitProfileItems(memoryResult.value);
      if (profileItems.length > 0) {
        buckets.push({
          tag: "openviking-user-profile",
          title: "OpenViking User Profile",
          items: profileItems,
        });
      }
      if (durableItems.length > 0) {
        buckets.push({
          tag: "openviking-durable-memory",
          title: "OpenViking Durable Memory",
          items: durableItems,
        });
      }
    } else if (memoryResult.status === "rejected") {
      params.logger?.warn?.(`context-openviking: memory recall failed: ${String(memoryResult.reason)}`);
    }

    if (resourceResult.status === "fulfilled" && resourceResult.value.length > 0) {
      buckets.push({
        tag: "openviking-resource-context",
        title: "OpenViking Resources and Skills",
        items: resourceResult.value,
      });
    } else if (resourceResult.status === "rejected") {
      params.logger?.warn?.(`context-openviking: resource recall failed: ${String(resourceResult.reason)}`);
    }
  }

  const assembledMessages: MessageLike[] = [];
  const freshTailTokens = estimateMessageTokens(freshTail);
  let remainingBudget =
    typeof params.tokenBudget === "number" && Number.isFinite(params.tokenBudget)
      ? Math.max(0, params.tokenBudget - freshTailTokens)
      : undefined;

  for (const bucket of buckets) {
    const fittedBucket = fitBucketToBudget(bucket, remainingBudget);
    if (!fittedBucket) {
      continue;
    }
    const injectedMessage = buildInjectedMessage(fittedBucket);
    if (!injectedMessage) {
      continue;
    }
    const messageTokens = estimateMessageTokens([injectedMessage]);
    assembledMessages.push(injectedMessage);
    if (typeof remainingBudget === "number" && Number.isFinite(remainingBudget)) {
      remainingBudget = Math.max(0, remainingBudget - messageTokens);
    }
  }

  assembledMessages.push(...freshTail);

  return {
    messages: assembledMessages,
    estimatedTokens: estimateMessageTokens(assembledMessages),
    systemPromptAddition: buildSystemPromptAddition(),
    diagnostics: {
      query,
      rawTailCount: freshTail.length,
      injectedBucketCount: Math.max(0, assembledMessages.length - freshTail.length),
    },
  };
}
