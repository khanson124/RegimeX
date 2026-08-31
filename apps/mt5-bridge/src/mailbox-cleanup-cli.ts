#!/usr/bin/env node
/**
 * Dry-run or execute MT5 mailbox retention using the same rules as the bridge.
 *
 * Usage:
 *   pnpm --filter @regimex/mt5-bridge mailbox-cleanup -- --dry-run
 *   pnpm --filter @regimex/mt5-bridge mailbox-cleanup -- --execute
 */
import { loadConfig } from "@regimex/config";
import {
  createMailboxCleanupState,
  mailboxCleanupConfigFromEnv,
  planMailboxCleanup,
  runMailboxCleanupPass
} from "@regimex/trading-engine";

function parseArgs(argv: string[]): { dryRun: boolean; execute: boolean } {
  const dryRun = argv.includes("--dry-run");
  const execute = argv.includes("--execute");
  return { dryRun: dryRun || !execute, execute };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const mailboxPath = config.MT5_MAILBOX_PATH;
  const cleanupConfig = mailboxCleanupConfigFromEnv(config);

  if (args.dryRun) {
    const plan = await planMailboxCleanup(mailboxPath, cleanupConfig);
    const summary = {
      mailboxPath,
      retention: cleanupConfig,
      eligible: {
        processing: plan.totals.deletedProcessing,
        replies: plan.totals.deletedReplies,
        pending: plan.totals.deletedPending,
        total: plan.entries.length
      },
      scanned: {
        processing: plan.totals.scannedProcessing,
        replies: plan.totals.scannedReplies,
        pending: plan.totals.scannedPending
      }
    };
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    if (plan.entries.length > 0 && plan.entries.length <= 20) {
      process.stdout.write(`${JSON.stringify(plan.entries, null, 2)}\n`);
    } else if (plan.entries.length > 20) {
      process.stdout.write(
        `${JSON.stringify({ sample: plan.entries.slice(0, 10), note: "first 10 eligible files" }, null, 2)}\n`
      );
    }
    return;
  }

  const runtime = createMailboxCleanupState();
  const result = await runMailboxCleanupPass(mailboxPath, cleanupConfig, new Set(), runtime);
  process.stdout.write(
    `${JSON.stringify({
      deletedProcessing: result.counters.deletedProcessing,
      deletedReplies: result.counters.deletedReplies,
      deletedPending: result.counters.deletedPending,
      replyCountBefore: result.replyCountBefore,
      replyCountAfter: result.replyCountAfter,
      processingCountBefore: result.processingCountBefore,
      processingCountAfter: result.processingCountAfter,
      hardCapTriggeredReplies: result.hardCapTriggeredReplies,
      hardCapTriggeredProcessing: result.hardCapTriggeredProcessing,
      cleanupDurationMs: result.durationMs,
      counters: result.counters,
      error: result.error
    })}\n`
  );
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
