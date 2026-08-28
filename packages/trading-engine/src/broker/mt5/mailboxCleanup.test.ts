import { mkdtemp, readdir, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createMailboxCleanupState,
  decidePendingCleanup,
  decideProcessingCleanup,
  decideReplyCleanup,
  DEFAULT_MAILBOX_CLEANUP_CONFIG,
  mailboxCleanupHealthy,
  planMailboxCleanup,
  runMailboxCleanupPass
} from "./mailboxCleanup.js";
import { ensureMailboxLayout, mailboxPaths } from "./mailbox.js";

const cfg = {
  ...DEFAULT_MAILBOX_CLEANUP_CONFIG,
  processingRetentionMinutes: 60,
  replyRetentionMinutes: 1440,
  orphanRetentionMinutes: 1440,
  maxFilesPerRun: 500
};

async function touchOld(path: string, ageMinutes: number): Promise<void> {
  const t = new Date(Date.now() - ageMinutes * 60_000);
  await utimes(path, t, t);
}

describe("mailbox cleanup decisions", () => {
  const processingRetentionMs = 60 * 60_000;
  const replyRetentionMs = 1440 * 60_000;
  const orphanRetentionMs = 1440 * 60_000;

  it("deletes completed processing after retention when reply exists", () => {
    expect(
      decideProcessingCleanup({
        hasReply: true,
        inFlight: false,
        ageMs: processingRetentionMs + 1,
        processingRetentionMs,
        orphanRetentionMs
      }).action
    ).toBe("delete");
  });

  it("preserves in-flight processing even with reply", () => {
    expect(
      decideProcessingCleanup({
        hasReply: true,
        inFlight: true,
        ageMs: processingRetentionMs + 1,
        processingRetentionMs,
        orphanRetentionMs
      })
    ).toEqual({ action: "keep", reason: "in_flight" });
  });

  it("preserves processing without reply until orphan TTL", () => {
    expect(
      decideProcessingCleanup({
        hasReply: false,
        inFlight: false,
        ageMs: orphanRetentionMs - 1,
        processingRetentionMs,
        orphanRetentionMs
      }).action
    ).toBe("keep");
    expect(
      decideProcessingCleanup({
        hasReply: false,
        inFlight: false,
        ageMs: orphanRetentionMs + 1,
        processingRetentionMs,
        orphanRetentionMs
      }).action
    ).toBe("delete");
  });

  it("deletes old replies and preserves recent ones", () => {
    expect(
      decideReplyCleanup({
        inFlight: false,
        ageMs: replyRetentionMs - 1,
        replyRetentionMs
      }).action
    ).toBe("keep");
    expect(
      decideReplyCleanup({
        inFlight: false,
        ageMs: replyRetentionMs + 1,
        replyRetentionMs
      }).action
    ).toBe("delete");
  });

  it("preserves in-flight replies", () => {
    expect(
      decideReplyCleanup({
        inFlight: true,
        ageMs: replyRetentionMs + 1,
        replyRetentionMs
      }).action
    ).toBe("keep");
  });
});

describe("runMailboxCleanupPass", () => {
  it("deletes completed processing after retention", async () => {
    const root = await mkdtemp(join(tmpdir(), "mt5-clean-"));
    await ensureMailboxLayout(root);
    const id = "getQuote_abc123";
    const processingPath = join(mailboxPaths(root).processing, `${id}.json`);
    const replyPath = join(mailboxPaths(root).replies, `${id}.json`);
    await writeFile(processingPath, "{}");
    await writeFile(replyPath, "{}");
    await touchOld(processingPath, 120);
    await touchOld(replyPath, 120);

    const runtime = createMailboxCleanupState();
    const result = await runMailboxCleanupPass(root, cfg, new Set(), runtime);
    expect(result.counters.deletedProcessing).toBe(1);
    expect(await readdir(mailboxPaths(root).processing)).toHaveLength(0);
  });

  it("respects cleanup batch cap", async () => {
    const root = await mkdtemp(join(tmpdir(), "mt5-cap-"));
    await ensureMailboxLayout(root);
    for (let i = 0; i < 10; i++) {
      const id = `getQuote_cap${i}`;
      const p = join(mailboxPaths(root).processing, `${id}.json`);
      const r = join(mailboxPaths(root).replies, `${id}.json`);
      await writeFile(p, "{}");
      await writeFile(r, "{}");
      await touchOld(p, 120);
    }
    const runtime = createMailboxCleanupState();
    const small = { ...cfg, maxFilesPerRun: 3 };
    const result = await runMailboxCleanupPass(root, small, new Set(), runtime);
    expect(result.counters.deletedProcessing).toBe(3);
    expect((await readdir(mailboxPaths(root).processing)).length).toBe(7);
  });

  it("preserves in-flight mailbox file ids", async () => {
    const root = await mkdtemp(join(tmpdir(), "mt5-flight-"));
    await ensureMailboxLayout(root);
    const id = "getOpenPositions_flight";
    const p = join(mailboxPaths(root).processing, `${id}.json`);
    await writeFile(p, "{}");
    await writeFile(join(mailboxPaths(root).replies, `${id}.json`), "{}");
    await touchOld(p, 120);
    const runtime = createMailboxCleanupState();
    await runMailboxCleanupPass(root, cfg, new Set([id]), runtime);
    expect(await readdir(mailboxPaths(root).processing)).toContain(`${id}.json`);
  });

  it("does not crash bridge on cleanup failure", async () => {
    const runtime = createMailboxCleanupState();
    const result = await runMailboxCleanupPass("/nonexistent-mailbox-root", cfg, new Set(), runtime);
    expect(result.error).toBeTruthy();
    expect(result.counters.errors).toBeGreaterThan(0);
  });
});

describe("planMailboxCleanup", () => {
  it("dry-run identifies stale completed processing", async () => {
    const root = await mkdtemp(join(tmpdir(), "mt5-plan-"));
    await ensureMailboxLayout(root);
    const id = "ping_old";
    await writeFile(join(mailboxPaths(root).processing, `${id}.json`), "{}");
    await writeFile(join(mailboxPaths(root).replies, `${id}.json`), "{}");
    await touchOld(join(mailboxPaths(root).processing, `${id}.json`), 2000);
    const plan = await planMailboxCleanup(root, cfg);
    expect(plan.totals.deletedProcessing).toBe(1);
    expect(plan.entries[0]?.reason).toBe("completed_processing");
  });
});

describe("mailboxCleanupHealthy", () => {
  it("marks unhealthy after consecutive failures", () => {
    const state = createMailboxCleanupState();
    state.lastSuccessAt = Date.now() - 60_000;
    state.consecutiveFailures = 2;
    expect(mailboxCleanupHealthy(state, 60)).toBe(false);
  });
});
