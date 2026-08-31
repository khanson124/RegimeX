import { access, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { isPartialMailboxFile, mailboxPaths } from "./mailbox.js";
import { mailboxFileIdFromFilename } from "./mailboxFileId.js";

export interface MailboxCleanupConfig {
  /** Delete reply files older than this (seconds). */
  replyRetentionSeconds: number;
  /** Delete processing files older than this (seconds). */
  processingRetentionSeconds: number;
  /** Orphan pending files older than this (seconds) — not normal pending TTL. */
  orphanRetentionSeconds: number;
  maxReplies: number;
  maxProcessing: number;
}

export const DEFAULT_MAILBOX_CLEANUP_CONFIG: MailboxCleanupConfig = {
  replyRetentionSeconds: 600,
  processingRetentionSeconds: 600,
  orphanRetentionSeconds: 86_400,
  maxReplies: 5_000,
  maxProcessing: 1_000
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
  errors: number;
}

export interface MailboxCleanupPassResult {
  counters: MailboxCleanupCounters;
  replyCountBefore: number;
  replyCountAfter: number;
  processingCountBefore: number;
  processingCountAfter: number;
  hardCapTriggeredReplies: boolean;
  hardCapTriggeredProcessing: boolean;
  oldestProcessingAgeMs: number | null;
  durationMs: number;
  error: string | null;
}

export interface MailboxCleanupRuntimeState {
  lastRunAt: number | null;
  lastSuccessAt: number | null;
  lastError: string | null;
  lastCounters: MailboxCleanupCounters | null;
  lastPassResult: MailboxCleanupPassResult | null;
  oldestProcessingAgeMs: number | null;
  consecutiveFailures: number;
}

export function createMailboxCleanupState(): MailboxCleanupRuntimeState {
  return {
    lastRunAt: null,
    lastSuccessAt: null,
    lastError: null,
    lastCounters: null,
    lastPassResult: null,
    oldestProcessingAgeMs: null,
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

/** Processing: age-based delete only; never touch in-flight. */
export function decideProcessingCleanup(input: {
  inFlight: boolean;
  ageMs: number;
  processingRetentionMs: number;
}): MailboxCleanupDecision {
  if (input.inFlight) return { action: "keep", reason: "in_flight" };
  if (input.ageMs < input.processingRetentionMs) {
    return { action: "keep", reason: "young" };
  }
  return { action: "delete", reason: "stale_processing" };
}

/** Replies: age-based delete only; never touch in-flight. */
export function decideReplyCleanup(input: {
  inFlight: boolean;
  ageMs: number;
  replyRetentionMs: number;
}): MailboxCleanupDecision {
  if (input.inFlight) return { action: "keep", reason: "in_flight" };
  if (input.ageMs < input.replyRetentionMs) {
    return { action: "keep", reason: "young" };
  }
  return { action: "delete", reason: "stale_reply" };
}

/** Pending: orphan/abandoned only — do not age-delete active queue entries. */
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
    errors: 0
  };
}

interface MailboxFileEntry {
  name: string;
  path: string;
  mailboxFileId: string;
  mtimeMs: number;
}

async function yieldEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function scanMailboxJsonFiles(dir: string): Promise<MailboxFileEntry[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }

  const entries: MailboxFileEntry[] = [];
  for (let i = 0; i < names.length; i++) {
    const name = names[i]!;
    if (!name.endsWith(".json") || isPartialMailboxFile(name)) continue;
    const mailboxFileId = mailboxFileIdFromFilename(name);
    if (!mailboxFileId) continue;
    const path = join(dir, name);
    try {
      const st = await stat(path);
      entries.push({ name, path, mailboxFileId, mtimeMs: st.mtimeMs });
    } catch {
      /* skip vanished / unreadable */
    }
    if (i > 0 && i % 2_000 === 0) await yieldEventLoop();
  }
  return entries;
}

/**
 * Select `count` oldest entries using a bounded max-heap — O(n log k), not O(n log n).
 */
export function selectOldestMailboxFiles(
  entries: readonly MailboxFileEntry[],
  count: number
): MailboxFileEntry[] {
  if (count <= 0 || entries.length === 0) return [];
  if (entries.length <= count) {
    return [...entries].sort((a, b) => a.mtimeMs - b.mtimeMs);
  }

  const heap: MailboxFileEntry[] = [];
  const parent = (i: number) => Math.floor((i - 1) / 2);
  const left = (i: number) => i * 2 + 1;

  function siftUp(i: number): void {
    while (i > 0 && heap[parent(i)]!.mtimeMs < heap[i]!.mtimeMs) {
      const tmp = heap[parent(i)]!;
      heap[parent(i)] = heap[i]!;
      heap[i] = tmp;
      i = parent(i);
    }
  }

  function siftDown(i: number): void {
    while (left(i) < heap.length) {
      let largest = i;
      const l = left(i);
      const r = l + 1;
      if (l < heap.length && heap[l]!.mtimeMs > heap[largest]!.mtimeMs) largest = l;
      if (r < heap.length && heap[r]!.mtimeMs > heap[largest]!.mtimeMs) largest = r;
      if (largest === i) break;
      const tmp = heap[i]!;
      heap[i] = heap[largest]!;
      heap[largest] = tmp;
      i = largest;
    }
  }

  for (const entry of entries) {
    if (heap.length < count) {
      heap.push(entry);
      siftUp(heap.length - 1);
    } else if (entry.mtimeMs < heap[0]!.mtimeMs) {
      heap[0] = entry;
      siftDown(0);
    }
  }
  return heap;
}

interface DirectoryCleanupResult {
  before: number;
  after: number;
  hardCapTriggered: boolean;
}

async function cleanupMailboxDirectory(input: {
  dir: string;
  maxFiles: number;
  inFlightMailboxFileIds: ReadonlySet<string>;
  counters: MailboxCleanupCounters;
  kind: "replies" | "processing" | "pending";
  nowMs: number;
  decide: (entry: MailboxFileEntry) => MailboxCleanupDecision;
  onProcessingAge?: (ageMs: number) => void;
}): Promise<DirectoryCleanupResult> {
  const entries = await scanMailboxJsonFiles(input.dir);
  const before = entries.length;
  let hardCapTriggered = false;
  let deleted = 0;
  const survivors: MailboxFileEntry[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (input.kind === "processing") {
      input.counters.scannedProcessing += 1;
      const ageMs = input.nowMs - entry.mtimeMs;
      input.onProcessingAge?.(ageMs);
    } else if (input.kind === "replies") {
      input.counters.scannedReplies += 1;
    } else {
      input.counters.scannedPending += 1;
    }

    const inFlight = input.inFlightMailboxFileIds.has(entry.mailboxFileId);
    const decision = input.decide(entry);
    if (decision.action === "delete") {
      try {
        await unlink(entry.path);
        deleted += 1;
        if (input.kind === "processing") input.counters.deletedProcessing += 1;
        else if (input.kind === "replies") input.counters.deletedReplies += 1;
        else input.counters.deletedPending += 1;
      } catch {
        input.counters.errors += 1;
        survivors.push(entry);
      }
    } else {
      if (decision.reason === "in_flight") input.counters.keptInFlight += 1;
      else input.counters.keptYoung += 1;
      survivors.push(entry);
    }

    if (i > 0 && i % 500 === 0) await yieldEventLoop();
  }

  const capCandidates = survivors.filter((e) => !input.inFlightMailboxFileIds.has(e.mailboxFileId));
  if (capCandidates.length > input.maxFiles) {
    hardCapTriggered = true;
    const removeCount = capCandidates.length - input.maxFiles;
    const toDelete = selectOldestMailboxFiles(capCandidates, removeCount);
    for (const entry of toDelete) {
      try {
        await unlink(entry.path);
        deleted += 1;
        if (input.kind === "processing") input.counters.deletedProcessing += 1;
        else if (input.kind === "replies") input.counters.deletedReplies += 1;
        else input.counters.deletedPending += 1;
      } catch {
        input.counters.errors += 1;
      }
    }
  }

  return { before, after: before - deleted, hardCapTriggered };
}

/**
 * Full mailbox retention pass. Scans each managed directory once per run,
 * deletes by age then enforces hard caps (oldest non-in-flight first).
 */
export async function runMailboxCleanupPass(
  root: string,
  config: MailboxCleanupConfig,
  inFlightMailboxFileIds: ReadonlySet<string>,
  _runtime: MailboxCleanupRuntimeState,
  nowMs = Date.now()
): Promise<MailboxCleanupPassResult> {
  const started = Date.now();
  const counters = emptyCounters();
  const paths = mailboxPaths(root);
  const processingRetentionMs = config.processingRetentionSeconds * 1_000;
  const replyRetentionMs = config.replyRetentionSeconds * 1_000;
  const orphanRetentionMs = config.orphanRetentionSeconds * 1_000;
  let oldestProcessingAgeMs: number | null = null;
  let error: string | null = null;
  let replyBefore = 0;
  let replyAfter = 0;
  let processingBefore = 0;
  let processingAfter = 0;
  let hardCapTriggeredReplies = false;
  let hardCapTriggeredProcessing = false;

  try {
    await access(root);

    const replies = await cleanupMailboxDirectory({
      dir: paths.replies,
      maxFiles: config.maxReplies,
      inFlightMailboxFileIds,
      counters,
      kind: "replies",
      nowMs,
      decide: (entry) =>
        decideReplyCleanup({
          inFlight: inFlightMailboxFileIds.has(entry.mailboxFileId),
          ageMs: nowMs - entry.mtimeMs,
          replyRetentionMs
        })
    });
    replyBefore = replies.before;
    replyAfter = replies.after;
    hardCapTriggeredReplies = replies.hardCapTriggered;

    const processing = await cleanupMailboxDirectory({
      dir: paths.processing,
      maxFiles: config.maxProcessing,
      inFlightMailboxFileIds,
      counters,
      kind: "processing",
      nowMs,
      onProcessingAge: (ageMs) => {
        if (oldestProcessingAgeMs == null || ageMs > oldestProcessingAgeMs) {
          oldestProcessingAgeMs = ageMs;
        }
      },
      decide: (entry) =>
        decideProcessingCleanup({
          inFlight: inFlightMailboxFileIds.has(entry.mailboxFileId),
          ageMs: nowMs - entry.mtimeMs,
          processingRetentionMs
        })
    });
    processingBefore = processing.before;
    processingAfter = processing.after;
    hardCapTriggeredProcessing = processing.hardCapTriggered;

    await cleanupMailboxDirectory({
      dir: paths.pending,
      maxFiles: Number.MAX_SAFE_INTEGER,
      inFlightMailboxFileIds,
      counters,
      kind: "pending",
      nowMs,
      decide: (entry) =>
        decidePendingCleanup({
          inFlight: inFlightMailboxFileIds.has(entry.mailboxFileId),
          ageMs: nowMs - entry.mtimeMs,
          orphanRetentionMs
        })
    });
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    counters.errors += 1;
  }

  return {
    counters,
    replyCountBefore: replyBefore,
    replyCountAfter: replyAfter,
    processingCountBefore: processingBefore,
    processingCountAfter: processingAfter,
    hardCapTriggeredReplies,
    hardCapTriggeredProcessing,
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

/** Dry-run planner (no deletes). */
export async function planMailboxCleanup(
  root: string,
  config: MailboxCleanupConfig,
  inFlightMailboxFileIds: ReadonlySet<string> = new Set(),
  nowMs = Date.now()
): Promise<{ entries: MailboxCleanupPlanEntry[]; totals: MailboxCleanupCounters }> {
  const paths = mailboxPaths(root);
  const processingRetentionMs = config.processingRetentionSeconds * 1_000;
  const replyRetentionMs = config.replyRetentionSeconds * 1_000;
  const orphanRetentionMs = config.orphanRetentionSeconds * 1_000;
  const entries: MailboxCleanupPlanEntry[] = [];
  const totals = emptyCounters();

  await access(root);

  const processingEntries = await scanMailboxJsonFiles(paths.processing);
  for (const entry of processingEntries) {
    totals.scannedProcessing += 1;
    const ageMs = nowMs - entry.mtimeMs;
    const decision = decideProcessingCleanup({
      inFlight: inFlightMailboxFileIds.has(entry.mailboxFileId),
      ageMs,
      processingRetentionMs
    });
    if (decision.action === "delete") {
      entries.push({
        dir: "processing",
        name: entry.name,
        mailboxFileId: entry.mailboxFileId,
        ageMs,
        reason: decision.reason
      });
      totals.deletedProcessing += 1;
    }
  }

  const replyEntries = await scanMailboxJsonFiles(paths.replies);
  for (const entry of replyEntries) {
    totals.scannedReplies += 1;
    const ageMs = nowMs - entry.mtimeMs;
    const decision = decideReplyCleanup({
      inFlight: inFlightMailboxFileIds.has(entry.mailboxFileId),
      ageMs,
      replyRetentionMs
    });
    if (decision.action === "delete") {
      entries.push({
        dir: "replies",
        name: entry.name,
        mailboxFileId: entry.mailboxFileId,
        ageMs,
        reason: decision.reason
      });
      totals.deletedReplies += 1;
    }
  }

  const pendingEntries = await scanMailboxJsonFiles(paths.pending);
  for (const entry of pendingEntries) {
    totals.scannedPending += 1;
    const ageMs = nowMs - entry.mtimeMs;
    const decision = decidePendingCleanup({
      inFlight: inFlightMailboxFileIds.has(entry.mailboxFileId),
      ageMs,
      orphanRetentionMs
    });
    if (decision.action === "delete") {
      entries.push({
        dir: "pending",
        name: entry.name,
        mailboxFileId: entry.mailboxFileId,
        ageMs,
        reason: decision.reason
      });
      totals.deletedPending += 1;
    }
  }

  return { entries, totals };
}

/** Build cleanup config from env (seconds preferred; minutes are legacy fallback). */
export function mailboxCleanupConfigFromEnv(env: {
  MT5_MAILBOX_REPLY_RETENTION_SECONDS?: number;
  MT5_MAILBOX_PROCESSING_RETENTION_SECONDS?: number;
  MT5_MAILBOX_ORPHAN_RETENTION_SECONDS?: number;
  MT5_MAILBOX_REPLY_RETENTION_MINUTES?: number;
  MT5_MAILBOX_PROCESSING_RETENTION_MINUTES?: number;
  MT5_MAILBOX_ORPHAN_RETENTION_MINUTES?: number;
  MT5_MAILBOX_MAX_REPLIES?: number;
  MT5_MAILBOX_MAX_PROCESSING?: number;
}): MailboxCleanupConfig {
  return {
    replyRetentionSeconds:
      env.MT5_MAILBOX_REPLY_RETENTION_SECONDS ??
      (env.MT5_MAILBOX_REPLY_RETENTION_MINUTES != null
        ? env.MT5_MAILBOX_REPLY_RETENTION_MINUTES * 60
        : DEFAULT_MAILBOX_CLEANUP_CONFIG.replyRetentionSeconds),
    processingRetentionSeconds:
      env.MT5_MAILBOX_PROCESSING_RETENTION_SECONDS ??
      (env.MT5_MAILBOX_PROCESSING_RETENTION_MINUTES != null
        ? env.MT5_MAILBOX_PROCESSING_RETENTION_MINUTES * 60
        : DEFAULT_MAILBOX_CLEANUP_CONFIG.processingRetentionSeconds),
    orphanRetentionSeconds:
      env.MT5_MAILBOX_ORPHAN_RETENTION_SECONDS ??
      (env.MT5_MAILBOX_ORPHAN_RETENTION_MINUTES != null
        ? env.MT5_MAILBOX_ORPHAN_RETENTION_MINUTES * 60
        : DEFAULT_MAILBOX_CLEANUP_CONFIG.orphanRetentionSeconds),
    maxReplies: env.MT5_MAILBOX_MAX_REPLIES ?? DEFAULT_MAILBOX_CLEANUP_CONFIG.maxReplies,
    maxProcessing: env.MT5_MAILBOX_MAX_PROCESSING ?? DEFAULT_MAILBOX_CLEANUP_CONFIG.maxProcessing
  };
}
