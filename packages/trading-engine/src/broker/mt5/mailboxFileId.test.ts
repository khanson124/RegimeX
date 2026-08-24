import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertSafeMailboxFileId,
  createMailboxFileId,
  isSafeMailboxFileId,
  mailboxFileIdFromFilename,
  mailboxJsonFilename
} from "./mailboxFileId.js";
import {
  atomicWriteJsonSync,
  claimPendingForProcessing,
  ensureMailboxLayout,
  LEGACY_UNSAFE_MAILBOX_FILENAME,
  mailboxPaths,
  quarantineUnsafeMailboxFiles,
  readReplyIfPresent,
  waitForReply,
  writePendingCommand,
  writeReplyFile
} from "./mailbox.js";

const SECRET = "mailbox-secret-value-16";

const UNSAFE_REQUEST_IDS = [
  "connect:0292fcd7-6d7f-41f7-aacf-c2ac7a4841c6",
  "colon:here",
  "slash/name",
  "back\\slash",
  "question?",
  "asterisk*",
  "pipe|id",
  "quote\"id",
  "has space",
  "unicodé-id",
  "..",
  "../etc/passwd",
  "..\\windows\\system32",
  "/absolute/path",
  "C:\\Temp\\x"
];

describe("safeMailboxFileId", () => {
  it("accepts UUID-style and command_uuid ids", () => {
    expect(isSafeMailboxFileId("0292fcd7-6d7f-41f7-aacf-c2ac7a4841c6")).toBe(true);
    expect(isSafeMailboxFileId("connect_0292fcd7-6d7f-41f7-aacf-c2ac7a4841c6")).toBe(true);
    expect(isSafeMailboxFileId("ping_abc.def-1")).toBe(true);
  });

  it("rejects Windows-invalid and traversal tokens", () => {
    for (const raw of UNSAFE_REQUEST_IDS) {
      expect(isSafeMailboxFileId(raw), raw).toBe(false);
    }
    expect(isSafeMailboxFileId(".hidden")).toBe(false);
    expect(isSafeMailboxFileId("foo/bar")).toBe(false);
    expect(isSafeMailboxFileId("CON")).toBe(false);
    expect(() => assertSafeMailboxFileId("connect:abc")).toThrow(/UNSAFE_MAILBOX_FILE_ID/);
  });

  it("createMailboxFileId always returns an allowlisted token", () => {
    for (const raw of UNSAFE_REQUEST_IDS) {
      const id = createMailboxFileId("connect", raw);
      expect(id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
      expect(id.includes("..")).toBe(false);
      expect(id.includes(":")).toBe(false);
      expect(id.includes("/")).toBe(false);
      expect(id.includes("\\")).toBe(false);
      expect(isSafeMailboxFileId(id)).toBe(true);
    }
    expect(createMailboxFileId("ping", "0292fcd7-6d7f-41f7-aacf-c2ac7a4841c6")).toBe(
      "ping_0292fcd7-6d7f-41f7-aacf-c2ac7a4841c6"
    );
  });

  it("does not treat a filename stem as a requestId", () => {
    expect(mailboxFileIdFromFilename("connect:abc.json")).toBeNull();
    expect(mailboxFileIdFromFilename("connect_abc.json")).toBe("connect_abc");
    expect(mailboxJsonFilename("connect_abc")).toBe("connect_abc.json");
  });
});

describe("mailbox Windows-safe protocol", () => {
  it("keeps logical requestId unchanged while writing a safe physical file", async () => {
    const root = await mkdtemp(join(tmpdir(), "mt5-safe-"));
    for (const requestId of UNSAFE_REQUEST_IDS) {
      const written = await writePendingCommand(root, SECRET, {
        requestId,
        idempotencyKey: "k",
        command: "ping",
        payload: { n: 1 }
      });
      expect(isSafeMailboxFileId(written.mailboxFileId)).toBe(true);
      expect(written.mailboxFileId).not.toContain(":");
      expect(written.path).toBe(
        join(mailboxPaths(root).pending, `${written.mailboxFileId}.json`)
      );
      const envelope = JSON.parse(await readFile(written.path, "utf8"));
      expect(envelope.requestId).toBe(requestId);
      expect(envelope.mailboxFileId).toBe(written.mailboxFileId);
    }
  });

  it("correlates pending → processing → reply by mailboxFileId, not filename-as-requestId", async () => {
    const root = await mkdtemp(join(tmpdir(), "mt5-corr-"));
    const requestId = "connect:0292fcd7-6d7f-41f7-aacf-c2ac7a4841c6";
    const written = await writePendingCommand(root, SECRET, {
      requestId,
      idempotencyKey: "connect",
      command: "getAccount",
      payload: {}
    });
    expect(written.mailboxFileId.startsWith("getAccount_")).toBe(true);
    await claimPendingForProcessing(root, written.mailboxFileId);
    expect(await readdir(mailboxPaths(root).pending)).not.toContain(`${written.mailboxFileId}.json`);
    expect(await readdir(mailboxPaths(root).processing)).toContain(`${written.mailboxFileId}.json`);

    await writeReplyFile(root, SECRET, {
      requestId,
      mailboxFileId: written.mailboxFileId,
      idempotencyKey: "connect",
      command: "getAccount",
      ok: true,
      result: { pong: true },
      createdAt: new Date().toISOString()
    });
    const reply = await waitForReply(root, written.mailboxFileId, 200);
    expect(reply.requestId).toBe(requestId);
    expect(reply.mailboxFileId).toBe(written.mailboxFileId);
    expect(await readReplyIfPresent(root, written.mailboxFileId)).not.toBeNull();
  });

  it("still works for a plain UUID requestId", async () => {
    const root = await mkdtemp(join(tmpdir(), "mt5-uuid-"));
    const requestId = "0292fcd7-6d7f-41f7-aacf-c2ac7a4841c6";
    const written = await writePendingCommand(root, SECRET, {
      requestId,
      idempotencyKey: requestId,
      command: "ping",
      payload: {}
    });
    expect(isSafeMailboxFileId(written.mailboxFileId)).toBe(true);
    const envelope = JSON.parse(await readFile(written.path, "utf8"));
    expect(envelope.requestId).toBe(requestId);
  });

  it("atomic tmp → rename uses a safe temp name", async () => {
    const root = await mkdtemp(join(tmpdir(), "mt5-tmp-"));
    await ensureMailboxLayout(root);
    const dest = join(mailboxPaths(root).replies, "ping_ok.json");
    atomicWriteJsonSync(dest, { requestId: "logical:id", mailboxFileId: "ping_ok" });
    const names = await readdir(mailboxPaths(root).replies);
    expect(names).toEqual(["ping_ok.json"]);
    expect(names.some((n) => n.includes(":"))).toBe(false);
  });

  it("refuses path-traversal mailboxFileId", async () => {
    const root = await mkdtemp(join(tmpdir(), "mt5-trav-"));
    expect(() => mailboxJsonFilename("../etc/passwd")).toThrow(/UNSAFE_MAILBOX_FILE_ID/);
    expect(() => mailboxJsonFilename("..\\windows")).toThrow(/UNSAFE_MAILBOX_FILE_ID/);
    await expect(
      writePendingCommand(root, SECRET, {
        requestId: "ok",
        idempotencyKey: "ok",
        command: "ping",
        payload: {},
        mailboxFileId: "../etc/passwd"
      })
    ).rejects.toThrow(/UNSAFE_MAILBOX_FILE_ID/);
  });

  it("quarantines legacy unsafe pending filenames without executing them", async () => {
    const root = await mkdtemp(join(tmpdir(), "mt5-leg-"));
    await ensureMailboxLayout(root);
    await writeFile(
      join(mailboxPaths(root).pending, "connect:0292fcd7-6d7f-41f7-aacf-c2ac7a4841c6.json"),
      JSON.stringify({ requestId: "connect:0292fcd7-6d7f-41f7-aacf-c2ac7a4841c6", command: "ping" })
    );
    const { quarantined } = await quarantineUnsafeMailboxFiles(root);
    expect(quarantined.length).toBeGreaterThan(0);
    expect(quarantined[0]?.reason).toBe(LEGACY_UNSAFE_MAILBOX_FILENAME);
    const pending = await readdir(mailboxPaths(root).pending);
    expect(pending.some((n) => n.includes(":"))).toBe(false);
    const q = await readdir(mailboxPaths(root).quarantine);
    expect(q.some((n) => n.startsWith("legacy_"))).toBe(true);
  });
});
