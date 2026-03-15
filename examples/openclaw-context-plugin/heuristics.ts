import type { MessageLike } from "./types.js";

function toText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => toText(entry)).filter(Boolean).join("\n");
  }
  if (!value || typeof value !== "object") {
    return "";
  }
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") {
    return record.text;
  }
  if (typeof record.content === "string") {
    return record.content;
  }
  if (Array.isArray(record.content)) {
    return record.content.map((entry) => toText(entry)).filter(Boolean).join("\n");
  }
  if (record.message && typeof record.message === "object") {
    return toText(record.message);
  }
  return "";
}

export function extractMessageRole(message: MessageLike): string {
  if (typeof (message as { role?: unknown }).role === "string") {
    return String((message as { role?: unknown }).role);
  }
  if (
    typeof (message as { message?: { role?: unknown } }).message?.role === "string"
  ) {
    return String((message as { message?: { role?: unknown } }).message?.role);
  }
  return "user";
}

export function extractMessageText(message: MessageLike): string {
  if (typeof (message as { content?: unknown }).content !== "undefined") {
    return toText((message as { content?: unknown }).content).trim();
  }
  if ((message as { message?: unknown }).message) {
    return toText((message as { message?: unknown }).message).trim();
  }
  return toText(message).trim();
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function buildRecallQuery(messages: MessageLike[], maxUserMessages: number = 4): string {
  const userTexts = messages
    .filter((message) => extractMessageRole(message) === "user")
    .map((message) => extractMessageText(message))
    .filter(Boolean);

  return userTexts.slice(-maxUserMessages).join("\n").trim();
}

export function shouldAutoRecall(query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized || normalized.length < 4) {
    return false;
  }
  return !new Set(["hi", "hey", "hello", "你好", "在吗", "yo"]).has(normalized);
}

export function shouldRecallResources(query: string): boolean {
  const normalized = query.toLowerCase();
  return [
    "code",
    "repo",
    "repository",
    "document",
    "doc",
    "api",
    "skill",
    "workflow",
    "实现",
    "代码",
    "文档",
    "技能",
  ].some((token) => normalized.includes(token));
}

export function selectFreshTail<T>(items: T[], count: number): T[] {
  if (count <= 0) {
    return [];
  }
  return items.slice(-count);
}
