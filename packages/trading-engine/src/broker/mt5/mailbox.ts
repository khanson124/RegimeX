import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, openSync, renameSync, writeSync } from "node:fs";
import { mkdir, readdir, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  mailboxCanonical,
  signMailboxCanonical,
  stablePayloadJson,
  verifyMailboxHmac
} from "./hmac.js";
import {
  type Mt5CommandType,
  type Mt5MailboxEnvelope,
  type Mt5MailboxReply
} from "./types.js";

export const MAILBOX_DIRS = {
  pending: "commands/pending",
  processing: "commands/processing",
  replies: "replies",
  events: "events"
} as const;

export function mailboxPaths(root: string) {
  return {
    root,
    pending: join(root, MAILBOX_DIRS.pending),
    processing: join(root, MAILBOX_DIRS.processing),
    replies: join(root, MAILBOX_DIRS.replies),
    events: join(root, MAILBOX_DIRS.events)
  };
}

export async function ensureMailboxLayout(root: string): Promise<void> {
  const paths = mailboxPaths(root);
  await mkdir(paths.pending, { recursive: true });
  await mkdir(paths.processing, { recursive: true });
  await mkdir(paths.replies, { recursive: true });
  await mkdir(paths.events, { recursive: true });
}

/**
 * Crash-safe JSON write: temp file → fsync → atomic rename.
 * EA / readers MUST ignore files whose names start with `.tmp-`.
 */
export function atomicWriteJsonSync(targetPath: string, value: unknown): void {
  const dir = dirname(targetPath);
  const tmp = join(
    dir,
    `.tmp-${basename(targetPath)}-${process.pid}-${randomBytes(4).toString("hex")}`
  );
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

export function isPartialMailboxFile(name: string): boolean {
  return name.startsWith(".tmp-") || !name.endsWith(".json");
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
  }
): Promise<string> {
  await ensureMailboxLayout(root);
  const createdAt = new Date().toISOString();
  const envelope = signEnvelope(secret, {
    requestId: input.requestId,
    idempotencyKey: input.idempotencyKey,
    command: input.command,
    createdAt,
    payload: input.payload
  });
  const target = join(mailboxPaths(root).pending, `${input.requestId}.json`);
  atomicWriteJsonSync(target, envelope);
  return target;
}

export async function readReplyIfPresent(
  root: string,
  requestId: string
): Promise<Mt5MailboxReply | null> {
  const file = join(mailboxPaths(root).replies, `${requestId}.json`);
  try {
    const raw = await readFile(file, "utf8");
    return JSON.parse(raw) as Mt5MailboxReply;
  } catch {
    return null;
  }
}

export async function waitForReply(
  root: string,
  requestId: string,
  timeoutMs: number,
  pollMs = 50
): Promise<Mt5MailboxReply> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const reply = await readReplyIfPresent(root, requestId);
    if (reply) return reply;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  const error = new Error("MT5_EA_TIMEOUT");
  (error as Error & { code: string }).code = "MT5_EA_TIMEOUT";
  throw error;
}

/**
 * On bridge restart: processing commands without replies are NOT re-executed.
 * They are marked ambiguous so RegimeX queries MT5 before any resubmit.
 */
export async function listUnackedProcessing(root: string): Promise<string[]> {
  const dir = mailboxPaths(root).processing;
  try {
    const names = await readdir(dir);
    const ids: string[] = [];
    for (const name of names) {
      if (isPartialMailboxFile(name)) continue;
      const requestId = name.replace(/\.json$/, "");
      const reply = await readReplyIfPresent(root, requestId);
      if (!reply) ids.push(requestId);
    }
    return ids;
  } catch {
    return [];
  }
}

/** Test helper: atomically move pending → processing like the EA. */
export async function claimPendingForProcessing(root: string, requestId: string): Promise<string> {
  const from = join(mailboxPaths(root).pending, `${requestId}.json`);
  const to = join(mailboxPaths(root).processing, `${requestId}.json`);
  await rename(from, to);
  return to;
}

export async function writeReplyFile(root: string, secret: string, reply: Omit<Mt5MailboxReply, "authHmac">): Promise<void> {
  await ensureMailboxLayout(root);
  const signed = signReply(secret, reply);
  const target = join(mailboxPaths(root).replies, `${reply.requestId}.json`);
  atomicWriteJsonSync(target, signed);
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
