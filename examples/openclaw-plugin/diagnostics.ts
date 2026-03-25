import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

type AgentMessage = {
  role?: string;
  content?: unknown;
};

export interface DiagnosticEntry {
  ts: number;
  sessionId: string;
  stage: string;
  data: Record<string, unknown>;
}

function diagnosticsPath(): string {
  return process.env.OPENVIKING_DIAGNOSTICS_PATH || join(homedir(), ".openclaw", "openviking-diagnostics.jsonl");
}

function diagnosticsEnabled(): boolean {
  return process.env.OPENVIKING_DIAGNOSTICS_ENABLED !== "false";
}

let ensuredDir = false;

function ensureDir(): void {
  if (ensuredDir) return;
  try {
    mkdirSync(dirname(diagnosticsPath()), { recursive: true });
    ensuredDir = true;
  } catch (err) {
    console.error("[openviking-diag] ensureDir failed:", err);
  }
}

function trimText(text: string, maxLen: number): string {
  return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}

function basenamePath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || path;
}

function summarizeBlock(block: Record<string, unknown>): string {
  const type = typeof block.type === "string" ? block.type : "unknown";
  if (type === "text" && typeof block.text === "string") {
    return block.text;
  }
  if ((type === "toolUse" || type === "toolCall" || type === "tool_use") && typeof block.name === "string") {
    const input =
      block.input && typeof block.input === "object"
        ? (block.input as Record<string, unknown>)
        : block.arguments && typeof block.arguments === "object"
          ? (block.arguments as Record<string, unknown>)
          : {};
    if (typeof input.path === "string" && input.path) {
      return `[toolCall:${block.name}] ${basenamePath(input.path)}`;
    }
    if (typeof input.command === "string" && input.command) {
      return `[toolCall:${block.name}] ${input.command}`;
    }
    return `[toolCall:${block.name}]`;
  }
  if ((type === "toolResult" || type === "tool_result") && typeof block.toolCallId === "string") {
    return `[toolResult:${block.toolCallId}]`;
  }
  return `[${type}]`;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") return summarizeBlock(item as Record<string, unknown>);
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object") {
    return summarizeBlock(content as Record<string, unknown>);
  }
  return "";
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function messagePreview(msg: { role?: string; content?: unknown }, maxLen = 5000): string {
  const role = typeof msg.role === "string" ? msg.role : "?";
  const text = textFromContent(msg.content);
  return `[${role}] ${trimText(text, maxLen)}`;
}

export function messagesDigest(
  messages: AgentMessage[],
  maxPerMsg = 5000,
): Array<{ role: string; preview: string; tokens: number }> {
  return messages.map((message) => {
    const text = textFromContent(message?.content);
    return {
      role: typeof message?.role === "string" ? message.role : "?",
      preview: trimText(text, maxPerMsg),
      tokens: estimateTokens(text),
    };
  });
}

export function ovDiag(sessionId: string, stage: string, data: Record<string, unknown>): void {
  if (!diagnosticsEnabled()) return;
  ensureDir();
  const entry: DiagnosticEntry = {
    ts: Date.now(),
    sessionId: typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : "unknown",
    stage,
    data,
  };
  try {
    appendFileSync(diagnosticsPath(), JSON.stringify(entry) + "\n", "utf-8");
  } catch (err) {
    console.error("[openviking-diag] write failed:", err);
  }
}

export function clearDiagnostics(): void {
  try {
    writeFileSync(diagnosticsPath(), "", "utf-8");
  } catch {
    // ignore
  }
}
