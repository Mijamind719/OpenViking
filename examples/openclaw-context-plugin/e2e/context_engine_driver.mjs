#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      args[key] = "true";
      continue;
    }
    args[key] = value;
    index += 1;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const buildDir = args["build-dir"];
const sessionId = args["session-id"];
const sessionFile = args["session-file"];
const baseUrl = args["base-url"];

if (!buildDir || !sessionId || !sessionFile || !baseUrl) {
  console.error("Missing required args: --build-dir --session-id --session-file --base-url");
  process.exit(2);
}

const moduleUrl = pathToFileURL(path.join(buildDir, "index.js")).href;
const { default: contextPlugin } = await import(moduleUrl);

let engineFactory = null;
let service = null;

const logger = {
  info(message) {
    process.stderr.write(`[driver] ${String(message)}\n`);
  },
  warn(message) {
    process.stderr.write(`[driver] WARN ${String(message)}\n`);
  },
};

const api = {
  pluginConfig: {
    mode: "remote",
    baseUrl,
    freshTailMessages: 1,
    recallScoreThreshold: 0,
  },
  runtime: {
    sessionId,
  },
  logger,
  registerTool() {},
  registerContextEngine(_id, factory) {
    engineFactory = factory;
  },
  registerService(definition) {
    service = definition;
  },
};

contextPlugin.register(api);
if (!engineFactory) {
  throw new Error("context engine factory was not registered");
}

await service?.start?.();
const engine = await engineFactory();

try {
  const bootstrap = await engine.bootstrap?.({
    sessionId,
    sessionFile,
  });
  const result = await engine.compact?.({
    sessionId,
    sessionFile,
    force: true,
    tokenBudget: 4096,
  });
  process.stdout.write(JSON.stringify({ bootstrap, result }, null, 2));
} finally {
  await engine.dispose?.();
  await service?.stop?.();
}
