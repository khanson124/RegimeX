import {
  createMailboxCleanupState,
  mailboxCleanupHealthy,
  runMailboxCleanupPass,
  type MailboxCleanupCounters,
  type MailboxCleanupConfig,
  type MailboxCleanupRuntimeState
} from "@regimex/trading-engine";

export interface MailboxCleanupSchedulerOptions {
  mailboxPath: string;
  config: MailboxCleanupConfig;
  intervalSeconds: number;
  enabled: boolean;
  getInFlightMailboxFileIds: () => ReadonlySet<string>;
  onPassComplete?: (result: { counters: MailboxCleanupCounters; error: string | null }) => void;
}

export interface MailboxCleanupScheduler {
  state: MailboxCleanupRuntimeState;
  runOnce: () => Promise<void>;
  start: () => void;
  stop: () => void;
}

export function createMailboxCleanupScheduler(
  options: MailboxCleanupSchedulerOptions
): MailboxCleanupScheduler {
  const state = createMailboxCleanupState();
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  const runOnce = async (): Promise<void> => {
    if (!options.enabled || running) return;
    running = true;
    state.lastRunAt = Date.now();
    try {
      const result = await runMailboxCleanupPass(
        options.mailboxPath,
        options.config,
        options.getInFlightMailboxFileIds(),
        state
      );
      state.lastCounters = result.counters;
      if (result.oldestProcessingAgeMs != null) {
        state.oldestProcessingAgeMs = result.oldestProcessingAgeMs;
      }
      if (result.error) {
        state.lastError = result.error;
        state.consecutiveFailures += 1;
      } else {
        state.lastError = null;
        state.lastSuccessAt = Date.now();
        state.consecutiveFailures = 0;
        if (result.counters.deletedProcessing + result.counters.deletedReplies + result.counters.deletedPending > 0) {
          options.onPassComplete?.({ counters: result.counters, error: null });
        }
      }
    } catch (err) {
      state.lastError = err instanceof Error ? err.message : String(err);
      state.consecutiveFailures += 1;
    } finally {
      running = false;
    }
  };

  return {
    state,
    runOnce,
    start() {
      if (!options.enabled || timer) return;
      setImmediate(() => {
        void runOnce();
      });
      timer = setInterval(() => {
        void runOnce();
      }, options.intervalSeconds * 1000);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    }
  };
}

export function mailboxCleanupReadySnapshot(
  scheduler: MailboxCleanupScheduler,
  intervalSeconds: number
): {
  cleanupLastRunAt: number | null;
  cleanupLastSuccessAt: number | null;
  cleanupDeletedProcessing: number;
  cleanupDeletedReplies: number;
  cleanupDeletedPending: number;
  oldestProcessingAgeMs: number | null;
  mailboxCleanupHealthy: boolean;
  cleanupLastError: string | null;
} {
  const counters = scheduler.state.lastCounters;
  return {
    cleanupLastRunAt: scheduler.state.lastRunAt,
    cleanupLastSuccessAt: scheduler.state.lastSuccessAt,
    cleanupDeletedProcessing: counters?.deletedProcessing ?? 0,
    cleanupDeletedReplies: counters?.deletedReplies ?? 0,
    cleanupDeletedPending: counters?.deletedPending ?? 0,
    oldestProcessingAgeMs: scheduler.state.oldestProcessingAgeMs,
    mailboxCleanupHealthy: mailboxCleanupHealthy(scheduler.state, intervalSeconds),
    cleanupLastError: scheduler.state.lastError
  };
}
