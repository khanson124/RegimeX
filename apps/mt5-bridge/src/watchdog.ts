import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";

export interface Mt5BridgeWatchdogOptions {
  port: number;
  parentPid: number;
  intervalMs?: number;
  timeoutMs?: number;
  failureThreshold?: number;
  kill?: (pid: number, signal: NodeJS.Signals) => boolean;
}

/**
 * Independent OS process that GET /health/live.
 * If the bridge event loop is wedged, this child can still run and SIGKILL the parent
 * so Docker `restart: unless-stopped` brings the container back.
 */
export function evaluateWatchdogTick(
  consecutiveFailures: number,
  probeOk: boolean,
  failureThreshold: number
): { consecutiveFailures: number; shouldTerminate: boolean } {
  if (probeOk) return { consecutiveFailures: 0, shouldTerminate: false };
  const next = consecutiveFailures + 1;
  return { consecutiveFailures: next, shouldTerminate: next >= failureThreshold };
}

export function probeLiveHttp(
  port: number,
  timeoutMs: number,
  host = "127.0.0.1"
): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: "/health/live", timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        resolve(res.statusCode === 200 && body.includes('"ok":true'));
      });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

export function createWatchdogLoop(options: {
  probe: () => Promise<boolean>;
  terminate: () => void;
  failureThreshold: number;
}): { tick: () => Promise<boolean> } {
  let failures = 0;
  let terminated = false;
  return {
    async tick() {
      if (terminated) return true;
      const ok = await options.probe();
      const next = evaluateWatchdogTick(failures, ok, options.failureThreshold);
      failures = next.consecutiveFailures;
      if (next.shouldTerminate) {
        terminated = true;
        options.terminate();
        return true;
      }
      return false;
    }
  };
}

export function startMt5BridgeWatchdog(options: Mt5BridgeWatchdogOptions): ChildProcess | null {
  if (process.env.MT5_BRIDGE_WATCHDOG_ENABLED === "false") return null;
  if (process.env.MT5_WATCHDOG_CHILD === "1") return null;

  const intervalMs = options.intervalMs ?? Number(process.env.MT5_BRIDGE_WATCHDOG_INTERVAL_MS ?? 5_000);
  const timeoutMs = options.timeoutMs ?? Number(process.env.MT5_BRIDGE_WATCHDOG_TIMEOUT_MS ?? 2_000);
  const failureThreshold =
    options.failureThreshold ?? Number(process.env.MT5_BRIDGE_WATCHDOG_FAILURES ?? 3);

  const script = `
    const http = require("node:http");
    const parentPid = ${options.parentPid};
    const port = ${options.port};
    const intervalMs = ${intervalMs};
    const timeoutMs = ${timeoutMs};
    const failureThreshold = ${failureThreshold};
    let failures = 0;
    let killing = false;
    function probe() {
      return new Promise((resolve) => {
        const req = http.get({ host: "127.0.0.1", port, path: "/health/live", timeout: timeoutMs }, (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            resolve(res.statusCode === 200 && body.includes('"ok":true'));
          });
        });
        req.on("timeout", () => { req.destroy(); resolve(false); });
        req.on("error", () => resolve(false));
      });
    }
    function terminate() {
      if (killing) return;
      killing = true;
      try { process.kill(parentPid, "SIGTERM"); } catch {}
      setTimeout(() => {
        try { process.kill(parentPid, "SIGKILL"); } catch {}
        process.exit(1);
      }, 2000);
    }
    setInterval(() => {
      probe().then((ok) => {
        if (ok) { failures = 0; return; }
        failures += 1;
        if (failures >= failureThreshold) terminate();
      });
    }, intervalMs);
  `;

  const child = spawn(process.execPath, ["-e", script], {
    stdio: ["ignore", "inherit", "inherit"],
    detached: false,
    env: { ...process.env, MT5_WATCHDOG_CHILD: "1" }
  });
  child.unref();
  return child;
}
