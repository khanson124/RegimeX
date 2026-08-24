import { loadConfig } from "@regimex/config";
import { startMt5BridgeServer } from "./server.js";

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
    commandTimeoutMs: config.MT5_COMMAND_TIMEOUT_MS
  });
  log("mt5-bridge listening", { host, port });
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
