import { DerivAuthenticationError, DerivConnectionError } from "@regimex/shared";
import { type DerivAuthorizeInfo } from "./types.js";

const DEFAULT_REST_URL = "https://api.derivws.com";

export interface DerivOptionsAccount {
  accountId: string;
  accountType: string;
  currency: string;
  balance: number;
  isVirtual: boolean;
}

interface DerivRestErrorBody {
  errors?: Array<{ code?: string; message?: string }>;
  message?: string;
}

function restBaseUrl(restUrl?: string): string {
  return (restUrl ?? DEFAULT_REST_URL).replace(/\/$/, "");
}

async function parseRestJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!text) {
    throw new DerivConnectionError(`Deriv REST empty response (${res.status})`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    if (!res.ok) {
      if (res.status === 401) throw new DerivAuthenticationError(text);
      throw new DerivConnectionError(text, { status: res.status });
    }
    throw new DerivConnectionError(`Deriv REST returned non-JSON: ${text.slice(0, 200)}`);
  }
}

function restHeaders(appId: string, apiToken: string): Record<string, string> {
  return {
    "Deriv-App-ID": appId,
    Authorization: `Bearer ${apiToken}`,
    Accept: "application/json",
    "Content-Type": "application/json"
  };
}

function normalizeAccount(raw: Record<string, unknown>): DerivOptionsAccount | null {
  const accountId = String(raw.account_id ?? raw.accountId ?? raw.loginid ?? raw.id ?? "");
  if (!accountId) return null;

  const accountType = String(raw.account_type ?? raw.accountType ?? raw.type ?? "").toLowerCase();
  const isVirtual =
    accountType.includes("demo") ||
    accountType.includes("virtual") ||
    raw.is_virtual === 1 ||
    raw.is_virtual === true;

  return {
    accountId,
    accountType: accountType || (isVirtual ? "demo" : "real"),
    currency: String(raw.currency ?? "USD"),
    balance: Number(raw.balance ?? raw.amount ?? 0),
    isVirtual
  };
}

function unwrapAccounts(payload: unknown): DerivOptionsAccount[] {
  const root = payload as Record<string, unknown>;
  const list = (root.data ?? root.accounts ?? root) as unknown;
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => normalizeAccount(item as Record<string, unknown>))
    .filter((a): a is DerivOptionsAccount => a !== null);
}

export async function fetchOptionsAccounts(
  appId: string,
  apiToken: string,
  restUrl?: string
): Promise<DerivOptionsAccount[]> {
  const res = await fetch(`${restBaseUrl(restUrl)}/trading/v1/options/accounts`, {
    method: "GET",
    headers: restHeaders(appId, apiToken)
  });
  const body = await parseRestJson<unknown>(res);
  if (!res.ok) {
    const err = body as DerivRestErrorBody;
    const message = err.errors?.[0]?.message ?? err.message ?? `HTTP ${res.status}`;
    if (res.status === 401) throw new DerivAuthenticationError(message);
    throw new DerivConnectionError(message, { status: res.status });
  }
  return unwrapAccounts(body);
}

export async function fetchOtpWebSocketUrl(
  appId: string,
  apiToken: string,
  accountId: string,
  restUrl?: string
): Promise<string> {
  const res = await fetch(
    `${restBaseUrl(restUrl)}/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`,
    { method: "POST", headers: restHeaders(appId, apiToken) }
  );
  const body = await parseRestJson<{ data?: { url?: string }; url?: string }>(res);
  if (!res.ok) {
    const err = body as DerivRestErrorBody;
    const message = err.errors?.[0]?.message ?? err.message ?? `HTTP ${res.status}`;
    if (res.status === 401) throw new DerivAuthenticationError(message);
    throw new DerivConnectionError(message, { status: res.status });
  }
  const url = body.data?.url ?? body.url;
  if (!url) throw new DerivConnectionError("Deriv OTP response did not include a WebSocket URL");
  return url;
}

/** Verify a PAT/JWT against the Options REST API and return normalized demo account info. */
export async function verifyOptionsPatToken(
  appId: string,
  apiToken: string,
  restUrl?: string
): Promise<DerivAuthorizeInfo> {
  const accounts = await fetchOptionsAccounts(appId, apiToken, restUrl);
  if (accounts.length === 0) {
    throw new DerivAuthenticationError("No Deriv accounts found for this token");
  }
  const demo = accounts.find((a) => a.isVirtual) ?? accounts[0]!;
  if (!demo.isVirtual) {
    throw new DerivAuthenticationError("Only demo (virtual) account tokens are accepted");
  }
  return {
    loginId: demo.accountId,
    isVirtual: demo.isVirtual,
    currency: demo.currency,
    balance: demo.balance,
    email: null,
    landingCompany: null
  };
}
