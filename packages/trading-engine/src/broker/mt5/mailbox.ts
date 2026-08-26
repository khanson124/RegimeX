import { createHash, randomBytes, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, openSync, renameSync, writeSync } from "node:fs";
import { mkdir, open, readdir, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  mailboxCanonical,
  signMailboxCanonical,
  stablePayloadJson,
  verifyMailboxHmac
} from "./hmac.js";
import {
  assertSafeMailboxFileId,
  createMailboxFileId,
  isSafeMailboxFileId,
  mailboxFileIdFromFilename,
  mailboxJsonFilename
} from "./mailboxFileId.js";
import {
  type Mt5CommandType,
  type Mt5MailboxEnvelope,
  type Mt5MailboxReply
} from "./types.js";

export const MAILBOX_DIRS = {
  pending: "commands/pending",
  processing: "commands/processing",
  replies: "replies",
  events: "events",
  quarantine: "quarantine"
} as const;

export const LEGACY_UNSAFE_MAILBOX_FILENAME = "LEGACY_UNSAFE_MAILBOX_FILENAME";

export function mailboxPaths(root: string) {
  return {
    root,
    pending: join(root, MAILBOX_DIRS.pending),
    processing: join(root, MAILBOX_DIRS.processing),
    replies: join(root, MAILBOX_DIRS.replies),
    events: join(root, MAILBOX_DIRS.events),
    quarantine: join(root, MAILBOX_DIRS.quarantine)
  };
}

export async function ensureMailboxLayout(root: string): Promise<void> {
  const paths = mailboxPaths(root);
  await mkdir(paths.pending, { recursive: true });
  await mkdir(paths.processing, { recursive: true });
  await mkdir(paths.replies, { recursive: true });
  await mkdir(paths.events, { recursive: true });
  await mkdir(paths.quarantine, { recursive: true });
}

/**
 * Crash-safe JSON write: temp file → fsync → atomic rename.
 * EA / readers MUST ignore files whose names start with `.tmp-`.
 * Temp names are derived from the already-safe destination basename.
 *
 * Sync variant is for tests. The bridge MUST use atomicWriteJson so a hung
 * Wine/CIFS fsync cannot freeze the Node event loop.
 */
export function atomicWriteJsonSync(targetPath: string, value: unknown): void {
  const dir = dirname(targetPath);
  const destBase = basename(targetPath);
  if (!destBase.endsWith(".json") || destBase.startsWith(".tmp-")) {
    throw new Error(`UNSAFE_MAILBOX_TARGET:${destBase}`);
  }
  const stem = destBase.slice(0, -".json".length);
  assertSafeMailboxFileId(stem);
  const tmp = join(dir, `.tmp-${stem}-${process.pid}-${randomBytes(4).toString("hex")}`);
  const data = Buffer.from(JSON.stringify(value), "utf8");
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, targetPath);
}

function mailboxTempPath(targetPath: string): string {
  const dir = dirname(targetPath);
  const destBase = basename(targetPath);
  if (!destBase.endsWith(".json") || destBase.startsWith(".tmp-")) {
    throw new Error(`UNSAFE_MAILBOX_TARGET:${destBase}`);
  }
  const stem = destBase.slice(0, -".json".length);
  assertSafeMailboxFileId(stem);
  return join(dir, `.tmp-${stem}-${process.pid}-${randomBytes(4).toString("hex")}`);
}

/** Async atomic write. IO runs on the libuv threadpool so HTTP /health/live stays responsive. */
export async function atomicWriteJson(
  targetPath: string,
  value: unknown,
  timeoutMs = 5_000
): Promise<void> {
  const tmp = mailboxTempPath(targetPath);
  const data = Buffer.from(JSON.stringify(value), "utf8");
  const write = (async () => {
    const fh = await open(tmp, "w");
    try {
      await fh.write(data);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, targetPath);
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      write,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const err = new Error("MT5_MAILBOX_IO_TIMEOUT");
          (err as Error & { code: string }).code = "MT5_MAILBOX_IO_TIMEOUT";
          reject(err);
        }, timeoutMs);
      })
    ]);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function isPartialMailboxFile(name: string): boolean {
  return name.startsWith(".tmp-") || !name.endsWith(".json");
}

export function isUnsafePhysicalMailboxName(name: string): boolean {
  if (isPartialMailboxFile(name)) return false;
  return mailboxFileIdFromFilename(name) == null;
}

function joinMailboxFile(dir: string, mailboxFileId: string): string {
  return join(dir, mailboxJsonFilename(mailboxFileId));
}

export function signEnvelope(
  secret: string,
  envelope: Omit<Mt5MailboxEnvelope, "authHmac">
): Mt5MailboxEnvelope {
  const payloadJson = stablePayloadJson(envelope.payload);
  const canonical = mailboxCanonical({
    requestId: envelope.requestId,
    idempotencyKey: envelope.idempotencyKey,
    command: envelope.command,
    createdAt: envelope.createdAt,
    payloadJson
  });
  return { ...envelope, authHmac: signMailboxCanonical(secret, canonical) };
}

export function verifyEnvelope(secret: string, envelope: Mt5MailboxEnvelope): boolean {
  const canonical = mailboxCanonical({
    requestId: envelope.requestId,
    idempotencyKey: envelope.idempotencyKey,
    command: envelope.command,
    createdAt: envelope.createdAt,
    payloadJson: stablePayloadJson(envelope.payload)
  });
  return verifyMailboxHmac(secret, canonical, envelope.authHmac);
}

export function signReply(secret: string, reply: Omit<Mt5MailboxReply, "authHmac">): Mt5MailboxReply {
  const payloadJson = stablePayloadJson(reply.result ?? { errorCode: reply.errorCode });
  const canonical = mailboxCanonical({
    requestId: reply.requestId,
    idempotencyKey: reply.idempotencyKey,
    command: reply.command,
    createdAt: reply.createdAt,
    payloadJson
  });
  return { ...reply, authHmac: signMailboxCanonical(secret, canonical) };
}

export function verifyReply(secret: string, reply: Mt5MailboxReply): boolean {
  const canonical = mailboxCanonical({
    requestId: reply.requestId,
    idempotencyKey: reply.idempotencyKey,
    command: reply.command,
    createdAt: reply.createdAt,
    payloadJson: stablePayloadJson(reply.result ?? { errorCode: reply.errorCode })
  });
  return verifyMailboxHmac(secret, canonical, reply.authHmac);
}

export async function writePendingCommand(
  root: string,
  secret: string,
  input: {
    requestId: string;
    idempotencyKey: string;
    command: Mt5CommandType;
    payload: unknown;
    mailboxFileId?: string;
  }
): Promise<{ path: string; mailboxFileId: string; requestId: string }> {
  await ensureMailboxLayout(root);
  const mailboxFileId = input.mailboxFileId
    ? assertSafeMailboxFileId(input.mailboxFileId)
    : createMailboxFileId(input.command, randomUUID());
  const createdAt = new Date().toISOString();
  const envelope = signEnvelope(secret, {
    requestId: input.requestId,
    mailboxFileId,
    idempotencyKey: input.idempotencyKey,
    command: input.command,
    createdAt,
    payload: input.payload
  });
  const target = joinMailboxFile(mailboxPaths(root).pending, mailboxFileId);
  await atomicWriteJson(target, envelope);
  return { path: target, mailboxFileId, requestId: input.requestId };
}

export async function readReplyIfPresent(
  root: string,
  mailboxFileId: string
): Promise<Mt5MailboxReply | null> {
  const file = joinMailboxFile(mailboxPaths(root).replies, mailboxFileId);
  try {
    const raw = await readFile(file, "utf8");
    const reply = JSON.parse(raw) as Mt5MailboxReply;
    return reply;
  } catch {
    return null;
  }
}

export async function waitForReply(
  root: string,
  mailboxFileId: string,
  timeoutMs: number,
  pollMs = 100
): Promise<Mt5MailboxReply> {
  assertSafeMailboxFileId(mailboxFileId);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const reply = await readReplyIfPresent(root, mailboxFileId);
    if (reply) return reply;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  const error = new Error("MT5_EA_TIMEOUT");
  (error as Error & { code: string }).code = "MT5_EA_TIMEOUT";
  throw error;
}

async function readJsonIfPresent(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * On bridge restart: processing commands without replies are NOT re-executed.
 * Returns logical requestIds from JSON (never inferred from filename).
 */
export async function listUnackedProcessing(root: string): Promise<string[]> {
  const dir = mailboxPaths(root).processing;
  try {
    const names = await readdir(dir);
    const ids: string[] = [];
    for (const name of names) {
      if (isPartialMailboxFile(name)) continue;
      const mailboxFileId = mailboxFileIdFromFilename(name);
      if (!mailboxFileId) continue;
      const body = await readJsonIfPresent(join(dir, name));
      const logicalId = typeof body?.requestId === "string" ? body.requestId : null;
      const fileIdFromJson =
        typeof body?.mailboxFileId === "string" && isSafeMailboxFileId(body.mailboxFileId)
          ? body.mailboxFileId
          : mailboxFileId;
      const reply = await readReplyIfPresent(root, fileIdFromJson);
      if (!reply && logicalId) ids.push(logicalId);
    }
    return ids;
  } catch {
    return [];
  }
}

/** Test helper: atomically move pending → processing like the EA (physical id). */
export async function claimPendingForProcessing(root: string, mailboxFileId: string): Promise<string> {
  const from = joinMailboxFile(mailboxPaths(root).pending, mailboxFileId);
  const to = joinMailboxFile(mailboxPaths(root).processing, mailboxFileId);
  await rename(from, to);
  return to;
}

export async function writeReplyFile(
  root: string,
  secret: string,
  reply: Omit<Mt5MailboxReply, "authHmac">
): Promise<void> {
  await ensureMailboxLayout(root);
  const mailboxFileId = assertSafeMailboxFileId(reply.mailboxFileId);
  const signed = signReply(secret, { ...reply, mailboxFileId });
  const target = joinMailboxFile(mailboxPaths(root).replies, mailboxFileId);
  await atomicWriteJson(target, signed);
}

export async function removeStaleTempFiles(root: string): Promise<number> {
  const paths = mailboxPaths(root);
  let removed = 0;
  for (const dir of [paths.pending, paths.processing, paths.replies, paths.events]) {
    let names: string[] = [];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.startsWith(".tmp-")) continue;
      await unlink(join(dir, name)).catch(() => undefined);
      removed += 1;
    }
  }
  return removed;
}

/**
 * Move legacy physical names (colon, slash, etc.) out of pending/processing/replies/events.
 * Do not execute them — execution state is uncertain.
 */
export async function quarantineUnsafeMailboxFiles(root: string): Promise<{
  quarantined: Array<{ from: string; reason: string }>;
}> {
  await ensureMailboxLayout(root);
  const paths = mailboxPaths(root);
  const quarantined: Array<{ from: string; reason: string }> = [];
  for (const dir of [paths.pending, paths.processing, paths.replies, paths.events]) {
    let names: string[] = [];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (isPartialMailboxFile(name)) continue;
      if (!isUnsafePhysicalMailboxName(name)) continue;
      const hash = createHash("sha256").update(name).digest("hex").slice(0, 16);
      const destName = `legacy_${hash}.json`;
      const from = join(dir, name);
      const to = join(paths.quarantine, destName);
      try {
        await rename(from, to);
        quarantined.push({ from: name, reason: LEGACY_UNSAFE_MAILBOX_FILENAME });
      } catch {
        quarantined.push({ from: name, reason: `${LEGACY_UNSAFE_MAILBOX_FILENAME}:rename-failed` });
      }
    }
  }
  return { quarantined };
}

export async function prepareMailbox(root: string): Promise<{
  quarantined: Array<{ from: string; reason: string }>;
  removedTemps: number;
}> {
  await ensureMailboxLayout(root);
  const removedTemps = await removeStaleTempFiles(root);
  const { quarantined } = await quarantineUnsafeMailboxFiles(root);
  return { quarantined, removedTemps };
}

export async function mailboxDepthSnapshot(
  root: string
): Promise<{ pending: number; processing: number; replies: number }> {
  const paths = mailboxPaths(root);
  const count = async (dir: string) => {
    try {
      const names = await readdir(dir);
      return names.filter((n) => n.endsWith(".json") && !n.startsWith(".tmp-")).length;
    } catch {
      return -1;
    }
  };
  return {
    pending: await count(paths.pending),
    processing: await count(paths.processing),
    replies: await count(paths.replies)
  };
}
