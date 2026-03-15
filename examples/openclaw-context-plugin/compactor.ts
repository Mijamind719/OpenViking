import { estimateTokens, extractMessageText } from "./heuristics.js";
import type { OpenVikingClient } from "./client.js";
import type { ContextPluginState } from "./types.js";

type JsonObject = Record<string, unknown>;

function estimateSessionFileTokens(messages: Array<Record<string, unknown>>): number {
  return messages.reduce((sum, message) => sum + estimateTokens(extractMessageText(message)), 0);
}

function findNumericField(value: unknown, fieldName: string): number | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as JsonObject;
  if (typeof record[fieldName] === "number" && Number.isFinite(record[fieldName])) {
    return Number(record[fieldName]);
  }
  for (const nested of Object.values(record)) {
    const found = findNumericField(nested, fieldName);
    if (found !== null) {
      return found;
    }
  }
  return null;
}

function summarizeCommitResult(result: JsonObject): string {
  const archived = result.archived === true;
  const memoriesExtracted = findNumericField(result, "memories_extracted") ?? 0;
  const activeCountUpdated = findNumericField(result, "active_count_updated") ?? 0;

  const parts = ["OpenViking session commit completed"];
  if (archived) {
    parts.push("history archived");
  }
  parts.push(`${memoriesExtracted} memories extracted`);
  if (activeCountUpdated > 0) {
    parts.push(`${activeCountUpdated} active counts updated`);
  }
  return `${parts.join(", ")}.`;
}

export async function compactOpenVikingSession(params: {
  client: OpenVikingClient;
  state: ContextPluginState;
  sessionMessages: Array<Record<string, unknown>>;
  currentTokenCount?: number;
  tokenBudget?: number;
}): Promise<{
  result: JsonObject;
  nextState: ContextPluginState;
  summary: string;
  tokensBefore: number;
  tokensAfter: number;
}> {
  const commitResult = (await params.client.commitSession(params.state.ovSessionId!)) as JsonObject;
  const tokensBefore =
    typeof params.currentTokenCount === "number" && Number.isFinite(params.currentTokenCount)
      ? params.currentTokenCount
      : estimateSessionFileTokens(params.sessionMessages);
  const tokensAfter =
    typeof params.tokenBudget === "number" && Number.isFinite(params.tokenBudget)
      ? Math.min(tokensBefore, Math.max(0, params.tokenBudget))
      : 0;

  return {
    result: commitResult,
    nextState: {
      ...params.state,
      lastCommittedMessageCount: params.state.mirroredMessageCount,
      updatedAt: new Date().toISOString(),
    },
    summary: summarizeCommitResult(commitResult),
    tokensBefore,
    tokensAfter,
  };
}
