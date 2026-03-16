import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

import { assembleOpenVikingContext, createEmptyState } from "./assembler.js";
import { OpenVikingClient, localClientCache } from "./client.js";
import { compactOpenVikingSession } from "./compactor.js";
import { contextOpenVikingConfigSchema } from "./config.js";
import {
  IS_WIN,
  prepareLocalPort,
  resolvePythonCommand,
  waitForHealth,
} from "./process-manager.js";
import {
  readSessionFileMessages,
  saveContextState,
  syncSessionMessages,
} from "./session-mirror.js";
import { registerOpenVikingTools } from "./tools.js";
import type { ContextPluginState, MessageLike } from "./types.js";

const MAX_OPENVIKING_STDERR_LINES = 200;
const MAX_OPENVIKING_STDERR_CHARS = 256_000;

function coerceMessages(value: unknown): MessageLike[] {
  return Array.isArray(value) ? (value as MessageLike[]) : [];
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
    const sessionFileBySessionId = new Map<string, string>();

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

    registerOpenVikingTools({
      api,
      cfg,
      getClient,
      stateBySessionId,
    });

    api.registerContextEngine("context-openviking", () => ({
      info: {
        id: "context-openviking",
        name: "Context Engine (OpenViking)",
        ownsCompaction: true,
      },

      async bootstrap(params: { sessionId: string; sessionFile: string }) {
        try {
          sessionFileBySessionId.set(params.sessionId, params.sessionFile);
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
          sessionFileBySessionId.set(params.sessionId, params.sessionFile);
          const sourceMessages = params.messages.slice(params.prePromptMessageCount);
          const allMessages = await readSessionFileMessages(params.sessionFile);
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
        const sessionFile = sessionFileBySessionId.get(params.sessionId);
        const sessionMessages = sessionFile ? await readSessionFileMessages(sessionFile) : [];
        const assembled = await assembleOpenVikingContext({
          client: await getClient(),
          state: stateBySessionId.get(params.sessionId) ?? createEmptyState(),
          messages: coerceMessages(params.messages),
          sessionMessages,
          tokenBudget: params.tokenBudget,
          cfg,
          logger: api.logger,
        });

        return {
          messages: assembled.messages as typeof params.messages,
          estimatedTokens: assembled.estimatedTokens,
          systemPromptAddition: assembled.systemPromptAddition,
        };
      },

      async compact(params: {
        sessionId: string;
        sessionFile: string;
        tokenBudget?: number;
        currentTokenCount?: number;
        force?: boolean;
      }) {
        try {
          sessionFileBySessionId.set(params.sessionId, params.sessionFile);
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

          const sessionMessages = await readSessionFileMessages(params.sessionFile);
          const compacted = await compactOpenVikingSession({
            client,
            state,
            sessionMessages,
            currentTokenCount: params.currentTokenCount,
            tokenBudget: params.tokenBudget,
            keepTailMessages: cfg.freshTailMessages,
          });
          const nextState: ContextPluginState = compacted.nextState;
          await saveContextState(params.sessionFile, nextState);
          stateBySessionId.set(params.sessionId, nextState);

          return {
            ok: true,
            compacted: true,
            result: {
              summary: compacted.summary,
              tokensBefore: compacted.tokensBefore,
              tokensAfter: compacted.tokensAfter,
              details: compacted.result,
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
