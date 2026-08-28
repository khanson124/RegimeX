import { access, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { isPartialMailboxFile, mailboxPaths } from "./mailbox.js";
import { mailboxFileIdFromFilename } from "./mailboxFileId.js";

export interface MailboxCleanupConfig {
  processingRetentionMinutes: number;
  replyRetentionMinutes: number;
  orphanRetentionMinutes: number;
  maxFilesPerRun: number;
}

export const DEFAULT_MAILBOX_CLEANUP_CONFIG: MailboxCleanupConfig = {
  processingRetentionMinutes: 60,
  replyRetentionMinutes: 1440,
  orphanRetentionMinutes: 1440,
  maxFilesPerRun: 500
};

export interface MailboxCleanupCounters {
  scannedProcessing: number;
  scannedReplies: number;
  scannedPending: number;
  deletedProcessing: number;
  deletedReplies: number;
  deletedPending: number;
  keptInFlight: number;
  keptYoung: number;
  keptNoReply: number;
  errors: number;
}

export interface MailboxCleanupPassResult {
  counters: MailboxCleanupCounters;
  oldestProcessingAgeMs: number | null;
  durationMs: number;
  error: string | null;
}

export interface MailboxCleanupRuntimeState {
  lastRunAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  lastCounters: MailboxCleanupCounters | null;
  oldestProcessingAgeMs: number | null;
  processingCursor: number;
  replyCursor: number;
  pendingCursor: number;
  consecutiveFailures: number;
}

export function createMailboxCleanupState(): MailboxCleanupRuntimeState {
  return {
    lastRunAt: null,
    lastSuccessAt: null,
    lastError: null,
    lastCounters: null,
    oldestProcessingAgeMs: null,
    processingCursor: 0,
    replyCursor: 0,
    pendingCursor: 0,
    consecutiveFailures: 0
  };
}

export function mailboxCleanupHealthy(
  state: MailboxCleanupRuntimeState,
  intervalSeconds: number,
  nowMs = Date.now()
): boolean {
  if (state.lastSuccessAt == null) return state.lastError == null;
  const maxAge = Math.max(intervalSeconds * 3_000, 180_000);
  return state.consecutiveFailures === 0 && nowMs - state.lastSuccessAt <= maxAge;
}

export type MailboxCleanupDecision =
  | { action: "keep"; reason: string }
  | { action: "delete"; reason: string };

/** Completed command: reply exists, past retention, not in-flight. */
export function decideProcessingCleanup(input: {
  hasReply: boolean;
  inFlight: boolean;
  ageMs: number;
  processingRetentionMs: number;
  orphanRetentionMs: number;
}): MailboxCleanupDecision {
  if (input.inFlight) return { action: "keep", reason: "in_flight" };
  if (input.hasReply) {
    if (input.ageMs < input.processingRetentionMs) {
      return { action: "keep", reason: "reply_exists_retention_window" };
    }
    return { action: "delete", reason: "completed_processing" };
  }
  if (input.ageMs < input.orphanRetentionMs) {
    return { action: "keep", reason: "orphan_retention_window" };
  }
  return { action: "delete", reason: "orphan_processing" };
}

export function decideReplyCleanup(input: {
  inFlight: boolean;
  ageMs: number;
  replyRetentionMs: number;
}): MailboxCleanupDecision {
  if (input.inFlight) return { action: "keep", reason: "in_flight" };
  if (input.ageMs < input.replyRetentionMs) {
    return { action: "keep", reason: "reply_retention_window" };
  }
  return { action: "delete", reason: "stale_reply" };
}

export function decidePendingCleanup(input: {
  inFlight: boolean;
  ageMs: number;
  orphanRetentionMs: number;
}): MailboxCleanupDecision {
  if (input.inFlight) return { action: "keep", reason: "in_flight" };
  if (input.ageMs < input.orphanRetentionMs) {
    return { action: "keep", reason: "pending_retention_window" };
  }
  return { action: "delete", reason: "stale_pending" };
}

function emptyCounters(): MailboxCleanupCounters {
  return {
    scannedProcessing: 0,
    scannedReplies: 0,
    scannedPending: 0,
    deletedProcessing: 0,
    deletedReplies: 0,
    deletedPending: 0,
    keptInFlight: 0,
    keptYoung: 0,
    keptNoReply: 0,
    errors: 0
  };
}

function jsonNames(names: string[]): string[] {
  return names.filter((n) => n.endsWith(".json") && !isPartialMailboxFile(n));
}

async function listJsonNames(dir: string): Promise<string[]> {
  try {
    return jsonNames(await readdir(dir));
  } catch {
    return [];
  }
}

function sliceBatch<T>(items: T[], cursor: number, max: number): { batch: T[]; nextCursor: number } {
  if (items.length === 0) return { batch: [], nextCursor: 0 };
  const start = cursor % items.length;
  const batch: T[] = [];
  for (let i = 0; i < max && i < items.length; i++) {
    batch.push(items[(start + i) % items.length]!);
  }
  return { batch, nextCursor: (start + batch.length) % items.length };
}

async function yieldEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * Bounded mailbox retention pass. Never scans/deletes the entire tree in one tick.
 * Correlates processing/replies by mailboxFileId (physical file stem).
 */
export async function runMailboxCleanupPass(
  root: string,
  config: MailboxCleanupConfig,
  inFlightMailboxFileIds: ReadonlySet<string>,
  runtime: MailboxCleanupRuntimeState,
  nowMs = Date.now()
): Promise<MailboxCleanupPassResult> {
  const started = Date.now();
  const counters = emptyCounters();
  const paths = mailboxPaths(root);
  const processingRetentionMs = config.processingRetentionMinutes * 60_000;
  const replyRetentionMs = config.replyRetentionMinutes * 60_000;
  const orphanRetentionMs = config.orphanRetentionMinutes * 60_000;
  let budget = config.maxFilesPerRun;
  let oldestProcessingAgeMs: number | null = null;
  let error: string | null = null;

  try {
    await access(root);
    const [processingNames, replyNames, pendingNames] = await Promise.all([
      listJsonNames(paths.processing),
      listJsonNames(paths.replies),
      listJsonNames(paths.pending)
    ]);
    const replySet = new Set(replyNames.map((n) => mailboxFileIdFromFilename(n)).filter(Boolean) as string[]);

    const processingBatch = sliceBatch(processingNames, runtime.processingCursor, budget);
    runtime.processingCursor = processingBatch.nextCursor;
    for (const name of processingBatch.batch) {
      if (budget <= 0) break;
      budget -= 1;
      counters.scannedProcessing += 1;
      const mailboxFileId = mailboxFileIdFromFilename(name);
      if (!mailboxFileId) continue;
      const filePath = join(paths.processing, name);
      try {
        const st = await stat(filePath);
        const ageMs = nowMs - st.mtimeMs;
        if (oldestProcessingAgeMs == null || ageMs > oldestProcessingAgeMs) {
          oldestProcessingAgeMs = ageMs;
        }
        const decision = decideProcessingCleanup({
          hasReply: replySet.has(mailboxFileId),
          inFlight: inFlightMailboxFileIds.has(mailboxFileId),
          ageMs,
          processingRetentionMs,
          orphanRetentionMs
        });
        if (decision.action === "delete") {
          await unlink(filePath);
          counters.deletedProcessing += 1;
        } else if (decision.reason === "in_flight") {
          counters.keptInFlight += 1;
        } else if (decision.reason === "orphan_retention_window") {
          counters.keptNoReply += 1;
        } else {
          counters.keptYoung += 1;
        }
      } catch {
        counters.errors += 1;
      }
      if (counters.scannedProcessing % 50 === 0) await yieldEventLoop();
    }

    const replyBatch = sliceBatch(replyNames, runtime.replyCursor, budget);
    runtime.replyCursor = replyBatch.nextCursor;
    for (const name of replyBatch.batch) {
      if (budget <= 0) break;
      budget -= 1;
      counters.scannedReplies += 1;
      const mailboxFileId = mailboxFileIdFromFilename(name);
      if (!mailboxFileId) continue;
      const filePath = join(paths.replies, name);
      try {
        const st = await stat(filePath);
        const decision = decideReplyCleanup({
          inFlight: inFlightMailboxFileIds.has(mailboxFileId),
          ageMs: nowMs - st.mtimeMs,
          replyRetentionMs
        });
        if (decision.action === "delete") {
          await unlink(filePath);
          counters.deletedReplies += 1;
        } else if (decision.reason === "in_flight") {
          counters.keptInFlight += 1;
        } else {
          counters.keptYoung += 1;
        }
      } catch {
        counters.errors += 1;
      }
      if (counters.scannedReplies % 50 === 0) await yieldEventLoop();
    }

    const pendingBatch = sliceBatch(pendingNames, runtime.pendingCursor, budget);
    runtime.pendingCursor = pendingBatch.nextCursor;
    for (const name of pendingBatch.batch) {
      if (budget <= 0) break;
      budget -= 1;
      counters.scannedPending += 1;
      const mailboxFileId = mailboxFileIdFromFilename(name);
      if (!mailboxFileId) continue;
      const filePath = join(paths.pending, name);
      try {
        const st = await stat(filePath);
        const decision = decidePendingCleanup({
          inFlight: inFlightMailboxFileIds.has(mailboxFileId),
          ageMs: nowMs - st.mtimeMs,
          orphanRetentionMs
        });
        if (decision.action === "delete") {
          await unlink(filePath);
          counters.deletedPending += 1;
        } else if (decision.reason === "in_flight") {
          counters.keptInFlight += 1;
        } else {
          counters.keptYoung += 1;
        }
      } catch {
        counters.errors += 1;
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    counters.errors += 1;
  }

  return {
    counters,
    oldestProcessingAgeMs,
    durationMs: Date.now() - started,
    error
  };
}

export interface MailboxCleanupPlanEntry {
  dir: "processing" | "replies" | "pending";
  name: string;
  mailboxFileId: string;
  ageMs: number;
  reason: string;
}

/** Dry-run planner for one-off host cleanup (no deletes). */
export async function planMailboxCleanup(
  root: string,
  config: MailboxCleanupConfig,
  inFlightMailboxFileIds: ReadonlySet<string> = new Set(),
  nowMs = Date.now()
): Promise<{ entries: MailboxCleanupPlanEntry[]; totals: MailboxCleanupCounters }> {
  const paths = mailboxPaths(root);
  const processingRetentionMs = config.processingRetentionMinutes * 60_000;
  const replyRetentionMs = config.replyRetentionMinutes * 60_000;
  const orphanRetentionMs = config.orphanRetentionMinutes * 60_000;
  const entries: MailboxCleanupPlanEntry[] = [];
  const totals = emptyCounters();

  await access(root);

  const processingNames = await listJsonNames(paths.processing);
  const replyNames = await listJsonNames(paths.replies);
  const replySet = new Set(replyNames.map((n) => mailboxFileIdFromFilename(n)).filter(Boolean) as string[]);

  for (const name of processingNames) {
    totals.scannedProcessing += 1;
    const mailboxFileId = mailboxFileIdFromFilename(name);
    if (!mailboxFileId) continue;
    const st = await stat(join(paths.processing, name));
    const ageMs = nowMs - st.mtimeMs;
    const decision = decideProcessingCleanup({
      hasReply: replySet.has(mailboxFileId),
      inFlight: inFlightMailboxFileIds.has(mailboxFileId),
      ageMs,
      processingRetentionMs,
      orphanRetentionMs
    });
    if (decision.action === "delete") {
      entries.push({ dir: "processing", name, mailboxFileId, ageMs, reason: decision.reason });
      totals.deletedProcessing += 1;
    }
  }

  for (const name of replyNames) {
    totals.scannedReplies += 1;
    const mailboxFileId = mailboxFileIdFromFilename(name);
    if (!mailboxFileId) continue;
    const st = await stat(join(paths.replies, name));
    const ageMs = nowMs - st.mtimeMs;
    const decision = decideReplyCleanup({
      inFlight: inFlightMailboxFileIds.has(mailboxFileId),
      ageMs,
      replyRetentionMs
    });
    if (decision.action === "delete") {
      entries.push({ dir: "replies", name, mailboxFileId, ageMs, reason: decision.reason });
      totals.deletedReplies += 1;
    }
  }

  const pendingNames = await listJsonNames(paths.pending);
  for (const name of pendingNames) {
    totals.scannedPending += 1;
    const mailboxFileId = mailboxFileIdFromFilename(name);
    if (!mailboxFileId) continue;
    const st = await stat(join(paths.pending, name));
    const ageMs = nowMs - st.mtimeMs;
    const decision = decidePendingCleanup({
      inFlight: inFlightMailboxFileIds.has(mailboxFileId),
      ageMs,
      orphanRetentionMs
    });
    if (decision.action === "delete") {
      entries.push({ dir: "pending", name, mailboxFileId, ageMs, reason: decision.reason });
      totals.deletedPending += 1;
    }
  }

  return { entries, totals };
}
