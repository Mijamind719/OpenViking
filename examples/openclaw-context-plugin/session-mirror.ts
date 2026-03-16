import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { OpenVikingClient } from "./client.js";
import type { ContextPluginState, MessageLike, SessionSyncResult } from "./types.js";
import { extractMessageRole, extractMessageText } from "./heuristics.js";

const EMPTY_STATE: ContextPluginState = {
  ovSessionId: null,
  mirroredMessageCount: 0,
  lastCommittedMessageCount: 0,
  updatedAt: new Date(0).toISOString(),
};

function stateFilePath(sessionFile: string): string {
  return `${sessionFile}.openviking-context.json`;
}

export async function loadContextState(sessionFile: string): Promise<ContextPluginState> {
  try {
    const raw = await readFile(stateFilePath(sessionFile), "utf-8");
    const parsed = JSON.parse(raw) as Partial<ContextPluginState>;
    const mirroredMessageCount =
      typeof parsed.mirroredMessageCount === "number" ? parsed.mirroredMessageCount : 0;
    const rawLastCommittedMessageCount =
      typeof parsed.lastCommittedMessageCount === "number" ? parsed.lastCommittedMessageCount : 0;
    return {
      ovSessionId: typeof parsed.ovSessionId === "string" ? parsed.ovSessionId : null,
      mirroredMessageCount,
      lastCommittedMessageCount: Math.max(0, Math.min(mirroredMessageCount, rawLastCommittedMessageCount)),
      updatedAt:
        typeof parsed.updatedAt === "string" && parsed.updatedAt
          ? parsed.updatedAt
          : EMPTY_STATE.updatedAt,
    };
  } catch {
    return { ...EMPTY_STATE };
  }
}

export async function saveContextState(
  sessionFile: string,
  state: ContextPluginState,
): Promise<void> {
  const safeMirroredMessageCount = Math.max(0, Math.floor(state.mirroredMessageCount));
  const safeLastCommittedMessageCount = Math.max(
    0,
    Math.min(safeMirroredMessageCount, Math.floor(state.lastCommittedMessageCount)),
  );
  await mkdir(dirname(sessionFile), { recursive: true });
  await writeFile(
    stateFilePath(sessionFile),
    JSON.stringify(
      {
        ...state,
        mirroredMessageCount: safeMirroredMessageCount,
        lastCommittedMessageCount: safeLastCommittedMessageCount,
      },
      null,
      2,
    ),
    "utf-8",
  );
}

export function parseSessionFileContent(content: string): MessageLike[] {
  const messages: MessageLike[] = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (parsed.type === "message" && parsed.message && typeof parsed.message === "object") {
        messages.push(parsed.message as Record<string, unknown>);
        continue;
      }
      if (typeof parsed.role === "string" || typeof parsed.content !== "undefined") {
        messages.push(parsed);
      }
    } catch {
      // ignore invalid lines
    }
  }
  return messages;
}

export async function readSessionFileMessages(sessionFile: string): Promise<MessageLike[]> {
  try {
    const raw = await readFile(sessionFile, "utf-8");
    return parseSessionFileContent(raw);
  } catch {
    return [];
  }
}

export async function ensureMirroredSession(
  client: OpenVikingClient,
  state: ContextPluginState,
): Promise<ContextPluginState> {
  if (state.ovSessionId) {
    return state;
  }
  const ovSessionId = await client.createSession();
  return {
    ...state,
    ovSessionId,
    updatedAt: new Date().toISOString(),
  };
}

export async function syncSessionMessages(params: {
  client: OpenVikingClient;
  sessionFile: string;
  sourceMessages?: MessageLike[];
}): Promise<SessionSyncResult> {
  const state0 = await loadContextState(params.sessionFile);
  const state1 = await ensureMirroredSession(params.client, state0);
  const messages = params.sourceMessages ?? (await readSessionFileMessages(params.sessionFile));
  const suffix = messages.slice(state1.mirroredMessageCount);

  let importedCount = 0;
  for (const message of suffix) {
    const text = extractMessageText(message);
    if (!text) {
      importedCount += 1;
      continue;
    }
    const role = extractMessageRole(message);
    await params.client.addSessionMessage(state1.ovSessionId!, role, text);
    importedCount += 1;
  }

  const state: ContextPluginState = {
    ...state1,
    mirroredMessageCount: messages.length,
    lastCommittedMessageCount: Math.min(state1.lastCommittedMessageCount, messages.length),
    updatedAt: new Date().toISOString(),
  };
  await saveContextState(params.sessionFile, state);
  return { state, importedCount };
}
