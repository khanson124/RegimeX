import { chmod, mkdtemp, readdir, stat, utimes, writeFile } from "node:fs/promises";
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
  runMailboxCleanupPass,
  selectOldestMailboxFiles
} from "./mailboxCleanup.js";
import { ensureMailboxLayout, mailboxPaths } from "./mailbox.js";

const cfg = {
  ...DEFAULT_MAILBOX_CLEANUP_CONFIG,
  replyRetentionSeconds: 600,
  processingRetentionSeconds: 600,
  orphanRetentionSeconds: 86_400,
  maxReplies: 5_000,
  maxProcessing: 1_000
};

async function touchOld(path: string, ageSeconds: number): Promise<void> {
  const t = new Date(Date.now() - ageSeconds * 1_000);
  await utimes(path, t, t);
}

async function touchFresh(path: string): Promise<void> {
  const t = new Date();
  await utimes(path, t, t);
}

describe("mailbox cleanup decisions", () => {
  const processingRetentionMs = 600 * 1_000;
  const replyRetentionMs = 600 * 1_000;
  const orphanRetentionMs = 86_400 * 1_000;

  it("deletes stale processing after retention", () => {
    expect(
      decideProcessingCleanup({
        inFlight: false,
        ageMs: processingRetentionMs + 1,
        processingRetentionMs
      }).action
    ).toBe("delete");
  });

  it("preserves in-flight processing", () => {
    expect(
      decideProcessingCleanup({
        inFlight: true,
        ageMs: processingRetentionMs + 1,
        processingRetentionMs
      })
    ).toEqual({ action: "keep", reason: "in_flight" });
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

  it("preserves pending until orphan TTL", () => {
    expect(
      decidePendingCleanup({
        inFlight: false,
        ageMs: orphanRetentionMs - 1,
        orphanRetentionMs
      }).action
    ).toBe("keep");
    expect(
      decidePendingCleanup({
        inFlight: false,
        ageMs: orphanRetentionMs + 1,
        orphanRetentionMs
      }).action
    ).toBe("delete");
  });
});

describe("runMailboxCleanupPass", () => {
  it("deletes old replies and preserves fresh replies", async () => {
    const root = await mkdtemp(join(tmpdir(), "mt5-clean-replies-"));
    await ensureMailboxLayout(root);
    const oldId = "getQuote_old";
    const freshId = "getQuote_fresh";
    const oldPath = join(mailboxPaths(root).replies, `${oldId}.json`);
    const freshPath = join(mailboxPaths(root).replies, `${freshId}.json`);
    await writeFile(oldPath, "{}");
    await writeFile(freshPath, "{}");
    await touchOld(oldPath, 900);
    await touchFresh(freshPath);

    const runtime = createMailboxCleanupState();
    const result = await runMailboxCleanupPass(root, cfg, new Set(), runtime);
    expect(result.counters.deletedReplies).toBe(1);
    expect(await readdir(mailboxPaths(root).replies)).toEqual([`${freshId}.json`]);
    expect(result.replyCountBefore).toBe(2);
    expect(result.replyCountAfter).toBe(1);
  });

  it("deletes stale processing files", async () => {
    const root = await mkdtemp(join(tmpdir(), "mt5-clean-proc-"));
    await ensureMailboxLayout(root);
    const id = "getQuote_proc";
    const processingPath = join(mailboxPaths(root).processing, `${id}.json`);
    await writeFile(processingPath, "{}");
    await touchOld(processingPath, 900);

    const runtime = createMailboxCleanupState();
    const result = await runMailboxCleanupPass(root, cfg, new Set(), runtime);
    expect(result.counters.deletedProcessing).toBe(1);
    expect(await readdir(mailboxPaths(root).processing)).toHaveLength(0);
  });

  it("preserves pending commands under orphan TTL", async () => {
    const root = await mkdtemp(join(tmpdir(), "mt5-clean-pending-"));
    await ensureMailboxLayout(root);
    const id = "getQuote_pending";
    const pendingPath = join(mailboxPaths(root).pending, `${id}.json`);
    await writeFile(pendingPath, "{}");
    await touchOld(pendingPath, 300);

    const runtime = createMailboxCleanupState();
    const result = await runMailboxCleanupPass(root, cfg, new Set(), runtime);
    expect(result.counters.deletedPending).toBe(0);
    expect(await readdir(mailboxPaths(root).pending)).toContain(`${id}.json`);
  });

  it("enforces reply hard cap by deleting oldest first", async () => {
    const root = await mkdtemp(join(tmpdir(), "mt5-cap-replies-"));
    await ensureMailboxLayout(root);
    const smallCfg = { ...cfg, maxReplies: 3, replyRetentionSeconds: 86_400 };
    for (let i = 0; i < 5; i++) {
      const path = join(mailboxPaths(root).replies, `getQuote_cap${i}.json`);
      await writeFile(path, "{}");
      await touchOld(path, 100 - i);
    }

    const runtime = createMailboxCleanupState();
    const result = await runMailboxCleanupPass(root, smallCfg, new Set(), runtime);
    expect(result.hardCapTriggeredReplies).toBe(true);
    expect(result.replyCountAfter).toBeLessThanOrEqual(3);
    const remaining = await readdir(mailboxPaths(root).replies);
    expect(remaining).toHaveLength(3);
    expect(remaining).toContain("getQuote_cap4.json");
    expect(remaining).toContain("getQuote_cap3.json");
    expect(remaining).toContain("getQuote_cap2.json");
  });

  it("preserves in-flight mailbox file ids", async () => {
    const root = await mkdtemp(join(tmpdir(), "mt5-flight-"));
    await ensureMailboxLayout(root);
    const id = "getOpenPositions_flight";
    const p = join(mailboxPaths(root).processing, `${id}.json`);
    const r = join(mailboxPaths(root).replies, `${id}.json`);
    await writeFile(p, "{}");
    await writeFile(r, "{}");
    await touchOld(p, 900);
    await touchOld(r, 900);
    const runtime = createMailboxCleanupState();
    await runMailboxCleanupPass(root, cfg, new Set([id]), runtime);
    expect(await readdir(mailboxPaths(root).processing)).toContain(`${id}.json`);
    expect(await readdir(mailboxPaths(root).replies)).toContain(`${id}.json`);
  });

  it("handles missing mailbox root without crashing", async () => {
    const runtime = createMailboxCleanupState();
    const result = await runMailboxCleanupPass("/nonexistent-mailbox-root", cfg, new Set(), runtime);
    expect(result.error).toBeTruthy();
    expect(result.counters.errors).toBeGreaterThan(0);
  });

  it("survives filesystem errors during delete", async () => {
    const root = await mkdtemp(join(tmpdir(), "mt5-fs-err-"));
    await ensureMailboxLayout(root);
    const replyDir = mailboxPaths(root).replies;
    const replyPath = join(replyDir, "getQuote_err.json");
    await writeFile(replyPath, "{}");
    await touchOld(replyPath, 900);
    await chmod(replyDir, 0o555);

    const runtime = createMailboxCleanupState();
    const result = await runMailboxCleanupPass(root, cfg, new Set(), runtime);
    expect(result.error).toBeNull();

    await chmod(replyDir, 0o755);
  });

  it("preserves partial (.tmp-) mailbox files", async () => {
    const root = await mkdtemp(join(tmpdir(), "mt5-partial-"));
    await ensureMailboxLayout(root);
    const tmpPath = join(mailboxPaths(root).replies, ".tmp-getQuote_abc-1-deadbeef.json");
    await writeFile(tmpPath, "{}");
    await touchOld(tmpPath, 900);

    const runtime = createMailboxCleanupState();
    await runMailboxCleanupPass(root, cfg, new Set(), runtime);
    expect(await stat(tmpPath)).toBeTruthy();
  });
});

describe("selectOldestMailboxFiles at scale", () => {
  it("selects k oldest in O(n log k) without sorting entire directory", () => {
    const entries = Array.from({ length: 100_000 }, (_, i) => ({
      name: `f${i}.json`,
      path: `/tmp/f${i}.json`,
      mailboxFileId: `f${i}`,
      mtimeMs: i
    }));
    const oldest = selectOldestMailboxFiles(entries, 1_000);
    expect(oldest).toHaveLength(1_000);
    const maxMtime = Math.max(...oldest.map((e) => e.mtimeMs));
    expect(maxMtime).toBe(999);
    expect(oldest.every((e) => e.mtimeMs <= 999)).toBe(true);
  });
});

describe("planMailboxCleanup", () => {
  it("dry-run identifies stale replies", async () => {
    const root = await mkdtemp(join(tmpdir(), "mt5-plan-"));
    await ensureMailboxLayout(root);
    const id = "ping_old";
    const reply = join(mailboxPaths(root).replies, `${id}.json`);
    await writeFile(reply, "{}");
    await touchOld(reply, 900);
    const plan = await planMailboxCleanup(root, cfg);
    expect(plan.totals.deletedReplies).toBe(1);
    expect(plan.entries[0]?.reason).toBe("stale_reply");
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
