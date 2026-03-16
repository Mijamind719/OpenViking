import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";

import type { ContextOpenVikingConfig, RequiredContextOpenVikingConfig } from "./types.js";

const DEFAULT_PORT = 1933;
const DEFAULT_BASE_URL = "http://127.0.0.1:1933";
const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_FRESH_TAIL_MESSAGES = 16;
const DEFAULT_RECALL_LIMIT = 6;
const DEFAULT_RECALL_SCORE_THRESHOLD = 0.2;
const DEFAULT_LOCAL_CONFIG_PATH = join(homedir(), ".openviking", "ov.conf");
const DEFAULT_AGENT_ID = "default";

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
    const envValue = process.env[envVar];
    if (!envValue) {
      throw new Error(`Environment variable ${envVar} is not set`);
    }
    return envValue;
  });
}

function toNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: string[], label: string) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`);
  }
}

export const contextOpenVikingConfigSchema = {
  parse(value: unknown): RequiredContextOpenVikingConfig {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      value = {};
    }
    const cfg = value as Record<string, unknown>;
    assertAllowedKeys(
      cfg,
      [
        "mode",
        "configPath",
        "port",
        "baseUrl",
        "agentId",
        "apiKey",
        "timeoutMs",
        "freshTailMessages",
        "autoRecallEnabled",
        "resourceRecallEnabled",
        "searchEscalationEnabled",
        "recallLimit",
        "recallScoreThreshold",
      ],
      "context-openviking config",
    );

    const mode = cfg.mode === "remote" ? "remote" : "local";
    const port = Math.max(1, Math.min(65535, Math.floor(toNumber(cfg.port, DEFAULT_PORT))));
    const rawConfigPath =
      typeof cfg.configPath === "string" && cfg.configPath.trim()
        ? cfg.configPath.trim()
        : DEFAULT_LOCAL_CONFIG_PATH;
    const configPath = resolvePath(resolveEnvVars(rawConfigPath).replace(/^~/, homedir()));
    const localBaseUrl = `http://127.0.0.1:${port}`;
    const rawBaseUrl =
      mode === "local"
        ? localBaseUrl
        : typeof cfg.baseUrl === "string" && cfg.baseUrl.trim()
          ? cfg.baseUrl.trim()
          : process.env.OPENVIKING_BASE_URL || process.env.OPENVIKING_URL || DEFAULT_BASE_URL;

    const apiKey =
      typeof cfg.apiKey === "string" && cfg.apiKey.trim()
        ? resolveEnvVars(cfg.apiKey)
        : process.env.OPENVIKING_API_KEY || "";

    const agentId =
      typeof cfg.agentId === "string" && cfg.agentId.trim()
        ? cfg.agentId.trim()
        : DEFAULT_AGENT_ID;

    return {
      mode,
      configPath,
      port,
      baseUrl: resolveEnvVars(rawBaseUrl).replace(/\/+$/, ""),
      agentId,
      apiKey,
      timeoutMs: Math.max(1000, Math.floor(toNumber(cfg.timeoutMs, DEFAULT_TIMEOUT_MS))),
      freshTailMessages: Math.max(
        1,
        Math.min(128, Math.floor(toNumber(cfg.freshTailMessages, DEFAULT_FRESH_TAIL_MESSAGES))),
      ),
      autoRecallEnabled: cfg.autoRecallEnabled !== false,
      resourceRecallEnabled: cfg.resourceRecallEnabled !== false,
      searchEscalationEnabled: cfg.searchEscalationEnabled !== false,
      recallLimit: Math.max(1, Math.min(32, Math.floor(toNumber(cfg.recallLimit, DEFAULT_RECALL_LIMIT)))),
      recallScoreThreshold: Math.max(
        0,
        Math.min(1, toNumber(cfg.recallScoreThreshold, DEFAULT_RECALL_SCORE_THRESHOLD)),
      ),
    };
  },
  uiHints: {
    mode: {
      label: "Mode",
      help: "local = plugin starts OpenViking; remote = use an existing OpenViking server",
    },
    configPath: {
      label: "Config path (local)",
      placeholder: DEFAULT_LOCAL_CONFIG_PATH,
      help: "Path to ov.conf when mode is local",
    },
    port: {
      label: "Port (local)",
      placeholder: String(DEFAULT_PORT),
      help: "Port for local OpenViking server",
      advanced: true,
    },
    baseUrl: {
      label: "OpenViking Base URL (remote)",
      placeholder: DEFAULT_BASE_URL,
      help: "HTTP URL when mode is remote",
    },
    agentId: {
      label: "Agent ID",
      placeholder: DEFAULT_AGENT_ID,
      help: "Identifies this OpenClaw instance to OpenViking",
    },
    apiKey: {
      label: "OpenViking API Key",
      sensitive: true,
      placeholder: "${OPENVIKING_API_KEY}",
      help: "Optional API key for OpenViking server",
    },
    timeoutMs: {
      label: "Request Timeout (ms)",
      placeholder: String(DEFAULT_TIMEOUT_MS),
      advanced: true,
    },
    freshTailMessages: {
      label: "Fresh Tail Messages",
      placeholder: String(DEFAULT_FRESH_TAIL_MESSAGES),
      help: "Number of recent raw messages to keep in assembled context",
    },
    autoRecallEnabled: {
      label: "Auto Recall",
      help: "Automatically recall OpenViking session and memory context",
    },
    resourceRecallEnabled: {
      label: "Resource Recall",
      help: "Allow automatic resource and skill recall when heuristics say it is useful",
      advanced: true,
    },
    searchEscalationEnabled: {
      label: "Search Escalation",
      help: "Reserved for future escalation from find() to search()",
      advanced: true,
    },
    recallLimit: {
      label: "Recall Limit",
      placeholder: String(DEFAULT_RECALL_LIMIT),
      advanced: true,
    },
    recallScoreThreshold: {
      label: "Recall Score Threshold",
      placeholder: String(DEFAULT_RECALL_SCORE_THRESHOLD),
      advanced: true,
    },
  },
  jsonSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      mode: { type: "string" },
      configPath: { type: "string" },
      port: { type: "number" },
      baseUrl: { type: "string" },
      agentId: { type: "string" },
      apiKey: { type: "string" },
      timeoutMs: { type: "number" },
      freshTailMessages: { type: "number" },
      autoRecallEnabled: { type: "boolean" },
      resourceRecallEnabled: { type: "boolean" },
      searchEscalationEnabled: { type: "boolean" },
      recallLimit: { type: "number" },
      recallScoreThreshold: { type: "number" },
    },
  },
};

export type { ContextOpenVikingConfig, RequiredContextOpenVikingConfig };
