#!/usr/bin/env node
/**
 * Dry-run or execute bounded MT5 mailbox retention using the same rules as the bridge.
 *
 * Usage:
 *   pnpm --filter @regimex/mt5-bridge mailbox-cleanup -- --dry-run
 *   pnpm --filter @regimex/mt5-bridge mailbox-cleanup -- --execute --max-files 5000
 */
import { loadConfig } from "@regimex/config";
import {
  DEFAULT_MAILBOX_CLEANUP_CONFIG,
  planMailboxCleanup,
  runMailboxCleanupPass,
  createMailboxCleanupState
} from "@regimex/trading-engine";

function parseArgs(argv: string[]): { dryRun: boolean; execute: boolean; maxFiles: number; maxPasses: number } {
  const dryRun = argv.includes("--dry-run");
  const execute = argv.includes("--execute");
  const maxFilesArg = argv.find((a) => a.startsWith("--max-files="));
  const maxPassesArg = argv.find((a) => a.startsWith("--max-passes="));
  return {
    dryRun: dryRun || !execute,
    execute,
    maxFiles: maxFilesArg ? Number(maxFilesArg.split("=")[1]) : DEFAULT_MAILBOX_CLEANUP_CONFIG.maxFilesPerRun,
    maxPasses: maxPassesArg ? Number(maxPassesArg.split("=")[1]) : 200
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const mailboxPath = config.MT5_MAILBOX_PATH;
  const cleanupConfig = {
    processingRetentionMinutes: config.MT5_MAILBOX_PROCESSING_RETENTION_MINUTES,
    replyRetentionMinutes: config.MT5_MAILBOX_REPLY_RETENTION_MINUTES,
    orphanRetentionMinutes: config.MT5_MAILBOX_ORPHAN_RETENTION_MINUTES,
    maxFilesPerRun: config.MT5_MAILBOX_CLEANUP_MAX_FILES_PER_RUN
  };

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
  let totalDeleted = 0;
  const perPass = Math.min(args.maxFiles, cleanupConfig.maxFilesPerRun);
  for (let pass = 0; pass < args.maxPasses; pass++) {
    const result = await runMailboxCleanupPass(
      mailboxPath,
      { ...cleanupConfig, maxFilesPerRun: perPass },
      new Set(),
      runtime
    );
    const deleted =
      result.counters.deletedProcessing + result.counters.deletedReplies + result.counters.deletedPending;
    totalDeleted += deleted;
    process.stdout.write(
      `${JSON.stringify({
        pass: pass + 1,
        deleted,
        counters: result.counters,
        error: result.error
      })}\n`
    );
    if (deleted === 0) break;
  }
  process.stdout.write(`${JSON.stringify({ totalDeleted, passes: runtime.lastRunAt }, null, 2)}\n`);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
