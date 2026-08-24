import { randomUUID } from "node:crypto";

/** Conservative Windows/Wine mailbox token. No path separators, no `..`. */
export const SAFE_MAILBOX_FILE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,178}$/;

const WINDOWS_RESERVED_DEVICE = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i;
const WINDOWS_UNSAFE_CHARS = /[<>:"/\\|?*\u0000-\u001f]/;

/**
 * Physical mailbox identity. Independent from logical requestId.
 * Must be usable as a basename on Wine/NTFS (no colon, slash, etc.).
 */
export function isSafeMailboxFileId(value: string): boolean {
  if (typeof value !== "string" || value.length === 0 || value.length > 180) return false;
  if (value.includes("..")) return false;
  if (value.includes("/") || value.includes("\\")) return false;
  if (WINDOWS_UNSAFE_CHARS.test(value)) return false;
  if (!SAFE_MAILBOX_FILE_ID_RE.test(value)) return false;
  if (WINDOWS_RESERVED_DEVICE.test(value)) return false;
  return true;
}

export function assertSafeMailboxFileId(value: string): string {
  if (!isSafeMailboxFileId(value)) {
    throw new Error(`UNSAFE_MAILBOX_FILE_ID:${value}`);
  }
  return value;
}

/** Allowlisted command prefix; unknown input collapses to "cmd". */
export function safeMailboxCommandToken(command: string): string {
  const stripped = String(command ?? "")
    .replace(/[^A-Za-z0-9._-]+/g, "")
    .replace(/^\.+/, "")
    .slice(0, 40);
  if (stripped && isSafeMailboxFileId(stripped)) return stripped;
  return "cmd";
}

/**
 * Build a physical mailbox file id. Never uses the logical requestId as-is.
 * Example: createMailboxFileId("connect", "0292fcd7-6d7f-41f7-aacf-c2ac7a4841c6")
 * → "connect_0292fcd7-6d7f-41f7-aacf-c2ac7a4841c6"
 */
export function createMailboxFileId(command: string, uuid: string = randomUUID()): string {
  const cmd = safeMailboxCommandToken(command);
  const id = String(uuid ?? "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^\.+/, "")
    .replace(/\.{2,}/g, ".")
    .slice(0, 80);
  const token = id.length > 0 ? `${cmd}_${id}` : `${cmd}_${randomUUID()}`;
  return assertSafeMailboxFileId(token);
}

/** Stem of a .json mailbox filename, or null if unsafe / not a json file. */
export function mailboxFileIdFromFilename(name: string): string | null {
  const base = name.replace(/\\/g, "/").split("/").pop() ?? "";
  if (!base.endsWith(".json") || base.startsWith(".tmp-")) return null;
  const stem = base.slice(0, -".json".length);
  return isSafeMailboxFileId(stem) ? stem : null;
}

export function mailboxJsonFilename(mailboxFileId: string): string {
  return `${assertSafeMailboxFileId(mailboxFileId)}.json`;
}
