import { loadConfig } from "@regimex/config";
import { startMt5BridgeServer } from "./server.js";
import { startMt5BridgeWatchdog } from "./watchdog.js";

function log(message: string, extra?: Record<string, unknown>): void {
  process.stdout.write(
    `${JSON.stringify({ level: "info", msg: message, ...extra, time: new Date().toISOString() })}\n`
  );
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.MT5_BRIDGE_SECRET) {
    log("MT5_BRIDGE_SECRET unset — commands will 401 (fail closed). Paper CFD is unaffected.");
  }
  const host = process.env.MT5_BRIDGE_BIND_HOST || "0.0.0.0";
  const port = config.MT5_BRIDGE_PORT;
  const mailboxPath = config.MT5_MAILBOX_PATH;
  log("mt5-bridge starting", {
    host,
    port,
    mailboxPath,
    note: "Do not publish this port. Do not proxy via Nginx."
  });
  await startMt5BridgeServer({
    host,
    port,
    secret: config.MT5_BRIDGE_SECRET || "unconfigured-mt5-bridge",
    mailboxPath,
    commandTimeoutMs: config.MT5_COMMAND_TIMEOUT_MS,
    cleanup: {
      enabled: config.MT5_MAILBOX_CLEANUP_ENABLED,
      processingRetentionMinutes: config.MT5_MAILBOX_PROCESSING_RETENTION_MINUTES,
      replyRetentionMinutes: config.MT5_MAILBOX_REPLY_RETENTION_MINUTES,
      orphanRetentionMinutes: config.MT5_MAILBOX_ORPHAN_RETENTION_MINUTES,
      intervalSeconds: config.MT5_MAILBOX_CLEANUP_INTERVAL_SECONDS,
      maxFilesPerRun: config.MT5_MAILBOX_CLEANUP_MAX_FILES_PER_RUN
    }
  });
  const watchdog = startMt5BridgeWatchdog({ port, parentPid: process.pid });
  log("mt5-bridge listening", {
    host,
    port,
    watchdog: watchdog != null,
    healthcheck: "GET /health/live is event-loop liveness only"
  });
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
