import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OpenVikingClient } from "../client.js";
import { memoryOpenVikingConfigSchema } from "../config.js";
import { createMemoryOpenVikingContextEngine } from "../context-engine.js";
import plugin from "../index.js";

function makeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function readDiagnostics(logPath: string): Array<Record<string, unknown>> {
  const text = readFileSync(logPath, "utf-8").trim();
  if (!text) return [];
  return text.split("\n").map((line) => JSON.parse(line));
}

function makeDiagnosticsPath(): string {
  return join(mkdtempSync(join(tmpdir(), "ov-diag-")), "openviking-diagnostics.jsonl");
}

function configureDiagnostics(logPath: string): void {
  process.env.OPENVIKING_DIAGNOSTICS_ENABLED = "true";
  process.env.OPENVIKING_DIAGNOSTICS_PATH = logPath;
}

describe("OpenViking diagnostics", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    delete process.env.OPENVIKING_DIAGNOSTICS_ENABLED;
    delete process.env.OPENVIKING_DIAGNOSTICS_PATH;
    vi.unstubAllGlobals();
  });

  it("emits assemble diagnostics", async () => {
    const logPath = makeDiagnosticsPath();
    configureDiagnostics(logPath);

    const cfg = memoryOpenVikingConfigSchema.parse({
      mode: "remote",
      baseUrl: "http://127.0.0.1:1933",
      autoCapture: false,
      autoRecall: false,
      ingestReplyAssist: false,
    });
    const logger = makeLogger();
    const client = {
      getContextForAssemble: vi.fn().mockResolvedValue({
        archives: [
          {
            index: 1,
            overview: "# Session Summary\nUser likes concise answers.",
            abstract: "User likes concise answers.",
          },
        ],
        messages: [
          {
            id: "msg_1",
            role: "assistant",
            created_at: "2026-03-25T00:00:00Z",
            parts: [
              { type: "text", text: "I checked the latest context." },
            ],
          },
        ],
        estimatedTokens: 321,
        stats: {
          totalArchives: 1,
          includedArchives: 1,
          droppedArchives: 0,
          failedArchives: 0,
          activeTokens: 280,
          archiveTokens: 41,
        },
      }),
    } as unknown as OpenVikingClient;

    const engine = createMemoryOpenVikingContextEngine({
      id: "openviking",
      name: "Context Engine (OpenViking)",
      version: "test",
      cfg,
      logger,
      getClient: vi.fn().mockResolvedValue(client),
      resolveAgentId: vi.fn((sessionId: string) => `agent:${sessionId}`),
    });

    await engine.assemble({
      sessionId: "session-assemble",
      messages: [{ role: "user", content: "hello" }],
      tokenBudget: 4096,
    });

    const records = readDiagnostics(logPath);
    expect(records.map((record) => record.stage)).toEqual([
      "assemble_input",
      "context_assemble",
      "assemble_output",
    ]);
    expect(records[0]?.sessionId).toBe("session-assemble");
    expect((records[0]?.data as Record<string, unknown>).messagesCount).toBe(1);
    expect((records[1]?.data as Record<string, unknown>).archiveCount).toBe(1);
    expect((records[2]?.data as Record<string, unknown>).outputMessagesCount).toBeGreaterThan(0);
  });

  it("emits afterTurn capture diagnostics", async () => {
    const logPath = makeDiagnosticsPath();
    configureDiagnostics(logPath);

    const cfg = memoryOpenVikingConfigSchema.parse({
      mode: "remote",
      baseUrl: "http://127.0.0.1:1933",
      autoCapture: true,
      autoRecall: false,
      ingestReplyAssist: false,
      commitTokenThreshold: 100,
    });
    const logger = makeLogger();
    const client = {
      addSessionMessage: vi.fn().mockResolvedValue(undefined),
      getSession: vi.fn().mockResolvedValue({ pending_tokens: 240 }),
      commitSession: vi.fn().mockResolvedValue({
        session_id: "session-capture",
        status: "accepted",
        archived: true,
        task_id: "task-123",
      }),
    } as unknown as OpenVikingClient;

    const engine = createMemoryOpenVikingContextEngine({
      id: "openviking",
      name: "Context Engine (OpenViking)",
      version: "test",
      cfg,
      logger,
      getClient: vi.fn().mockResolvedValue(client),
      resolveAgentId: vi.fn((sessionId: string) => `agent:${sessionId}`),
    });

    await engine.afterTurn?.({
      sessionId: "session-capture",
      sessionFile: "session.md",
      prePromptMessageCount: 1,
      messages: [
        { role: "user", content: "old message" },
        { role: "user", content: "remember that I like coffee" },
        { role: "assistant", content: [{ type: "text", text: "Noted." }] },
      ],
      runtimeContext: {},
    });

    const records = readDiagnostics(logPath);
    expect(records.map((record) => record.stage)).toEqual([
      "afterTurn_entry",
      "capture_store",
      "capture_check",
      "capture_commit",
    ]);
    expect((records[0]?.data as Record<string, unknown>).newMessageCount).toBe(2);
    expect((records[1]?.data as Record<string, unknown>).stored).toBe(true);
    expect((records[2]?.data as Record<string, unknown>).shouldCapture).toBe(true);
    expect((records[3]?.data as Record<string, unknown>).taskId).toBe("task-123");
  });

  it("emits recall diagnostics from before_prompt_build", async () => {
    const logPath = makeDiagnosticsPath();
    configureDiagnostics(logPath);

    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/health") {
        return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      }
      if (url.pathname === "/api/v1/system/status") {
        return new Response(JSON.stringify({ status: "ok", result: { user: "default" } }), { status: 200 });
      }
      if (url.pathname === "/api/v1/fs/ls") {
        return new Response(JSON.stringify({ status: "ok", result: [] }), { status: 200 });
      }
      if (url.pathname === "/api/v1/search/find") {
        const body = JSON.parse(String(init?.body || "{}"));
        const targetUri = String(body.target_uri || "");
        if (targetUri.includes("viking://user/")) {
          return new Response(
            JSON.stringify({
              status: "ok",
              result: {
                memories: [
                  {
                    uri: "viking://user/default/memories/coffee",
                    level: 2,
                    abstract: "User likes coffee",
                    category: "preferences",
                    score: 0.92,
                  },
                ],
                total: 1,
              },
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ status: "ok", result: { memories: [], total: 0 } }), { status: 200 });
      }
      if (url.pathname === "/api/v1/content/read") {
        return new Response(JSON.stringify({ status: "ok", result: "User likes coffee and cafes." }), { status: 200 });
      }
      throw new Error(`Unhandled fetch: ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const hooks = new Map<string, (event: unknown, ctx?: Record<string, unknown>) => unknown>();
    plugin.register({
      pluginConfig: {
        mode: "remote",
        baseUrl: "http://127.0.0.1:1933",
        autoCapture: false,
        autoRecall: true,
        ingestReplyAssist: false,
        recallLimit: 3,
      },
      logger: makeLogger(),
      registerTool: () => {},
      registerService: () => {},
      registerContextEngine: () => {},
      on: (hookName, handler) => {
        hooks.set(hookName, handler);
      },
    });

    const beforePromptBuild = hooks.get("before_prompt_build");
    expect(beforePromptBuild).toBeTypeOf("function");

    const result = await beforePromptBuild?.(
      {
        messages: [{ role: "user", content: "remember my coffee preference" }],
      },
      { sessionId: "session-recall", agentId: "agent:test" },
    );

    expect(result).toMatchObject({
      prependContext: expect.stringContaining("<relevant-memories>"),
    });

    const records = readDiagnostics(logPath);
    expect(records.map((record) => record.stage)).toEqual([
      "recall_precheck",
      "recall_search",
      "recall_inject",
    ]);
    expect((records[2]?.data as Record<string, unknown>).injectedCount).toBe(1);
  });
});
