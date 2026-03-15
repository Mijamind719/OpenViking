import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { Socket } from "node:net";
import { platform, homedir } from "node:os";
import { join } from "node:path";

export const IS_WIN = platform() === "win32";

export type ProcessLogger = {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
};

export function waitForHealth(baseUrl: string, timeoutMs: number, intervalMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (Date.now() > deadline) {
        reject(new Error(`OpenViking health check timeout at ${baseUrl}`));
        return;
      }
      fetch(`${baseUrl}/health`)
        .then((response) => response.json())
        .then((body: { status?: string }) => {
          if (body?.status === "ok") {
            resolve();
            return;
          }
          setTimeout(tick, intervalMs);
        })
        .catch(() => setTimeout(tick, intervalMs));
    };
    tick();
  });
}

export async function quickHealthCheck(baseUrl: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/health`, { method: "GET", signal: controller.signal });
    if (!response.ok) {
      return false;
    }
    const body = (await response.json().catch(() => ({}))) as { status?: string };
    return body.status === "ok";
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function quickTcpProbe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    let done = false;
    const finish = (ok: boolean) => {
      if (done) {
        return;
      }
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    try {
      socket.connect(port, host);
    } catch {
      finish(false);
    }
  });
}

export async function prepareLocalPort(
  port: number,
  logger: ProcessLogger,
  maxRetries: number = 10,
): Promise<number> {
  const isOpenViking = await quickHealthCheck(`http://127.0.0.1:${port}`, 2000);
  if (isOpenViking) {
    logger.info?.(`context-openviking: killing stale OpenViking on port ${port}`);
    await killProcessOnPort(port, logger);
    return port;
  }

  const occupied = await quickTcpProbe("127.0.0.1", port, 500);
  if (!occupied) {
    return port;
  }

  logger.warn?.(`context-openviking: port ${port} is occupied, searching for a free port`);
  for (let candidate = port + 1; candidate <= port + maxRetries; candidate += 1) {
    if (candidate > 65535) {
      break;
    }
    const taken = await quickTcpProbe("127.0.0.1", candidate, 300);
    if (!taken) {
      logger.info?.(`context-openviking: using free port ${candidate} instead of ${port}`);
      return candidate;
    }
  }

  throw new Error(`context-openviking: port ${port} is occupied and no free port was found`);
}

function killProcessOnPort(port: number, logger: ProcessLogger): Promise<void> {
  return IS_WIN ? killProcessOnPortWin(port, logger) : killProcessOnPortUnix(port, logger);
}

async function killProcessOnPortWin(port: number, logger: ProcessLogger): Promise<void> {
  try {
    const output = execSync(
      `netstat -ano | findstr "LISTENING" | findstr ":${port}"`,
      { encoding: "utf-8", shell: "cmd.exe" },
    ).trim();
    if (!output) {
      return;
    }
    const pids = new Set<number>();
    for (const line of output.split(/\r?\n/)) {
      const match = line.trim().match(/\s(\d+)\s*$/);
      if (match?.[1]) {
        pids.add(Number(match[1]));
      }
    }
    for (const pid of pids) {
      if (pid > 0) {
        logger.info?.(`context-openviking: killing pid ${pid} on port ${port}`);
        try {
          execSync(`taskkill /PID ${pid} /F`, { shell: "cmd.exe" });
        } catch {
          // ignore
        }
      }
    }
    if (pids.size > 0) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  } catch {
    // ignore
  }
}

async function killProcessOnPortUnix(port: number, logger: ProcessLogger): Promise<void> {
  try {
    const lsofOut = execSync(`lsof -ti tcp:${port} -s tcp:listen 2>/dev/null || true`, {
      encoding: "utf-8",
      shell: "/bin/sh",
    }).trim();
    const pids = lsofOut
      ? lsofOut.split(/\s+/).map((value) => Number(value)).filter((value) => value > 0)
      : [];
    for (const pid of pids) {
      logger.info?.(`context-openviking: killing pid ${pid} on port ${port}`);
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // ignore
      }
    }
    if (pids.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  } catch {
    // ignore
  }
}

export function resolvePythonCommand(logger: ProcessLogger): string {
  const defaultPy = IS_WIN ? "python" : "python3";
  let pythonCmd = process.env.OPENVIKING_PYTHON;

  if (!pythonCmd) {
    if (IS_WIN) {
      const envBat = join(homedir(), ".openclaw", "openviking.env.bat");
      if (existsSync(envBat)) {
        try {
          const content = readFileSync(envBat, "utf-8");
          const match = content.match(/set\s+OPENVIKING_PYTHON=(.+)/i);
          if (match?.[1]) {
            pythonCmd = match[1].trim();
          }
        } catch {
          // ignore
        }
      }
    } else {
      const envFile = join(homedir(), ".openclaw", "openviking.env");
      if (existsSync(envFile)) {
        try {
          const content = readFileSync(envFile, "utf-8");
          const match = content.match(/OPENVIKING_PYTHON=['"]([^'"]+)['"]/);
          if (match?.[1]) {
            pythonCmd = match[1];
          }
        } catch {
          // ignore
        }
      }
    }
  }

  const resolved = pythonCmd || defaultPy;
  if (!process.env.OPENVIKING_PYTHON) {
    logger.info?.(`context-openviking: using Python command "${resolved}"`);
  }
  return resolved;
}
