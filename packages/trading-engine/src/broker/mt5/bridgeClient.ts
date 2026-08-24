import { type Mt5CommandType, type Mt5MailboxReply } from "./types.js";

export interface HttpMt5BridgeClientOptions {
  baseUrl: string;
  secret: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

export class HttpMt5BridgeClient {
  constructor(private readonly options: HttpMt5BridgeClientOptions) {}

  async request<T>(
    command: Mt5CommandType,
    payload: unknown,
    opts: { requestId: string; idempotencyKey: string }
  ): Promise<Mt5MailboxReply<T>> {
    const url = `${this.options.baseUrl.replace(/\/$/, "")}/v1/command`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const fetchFn = this.options.fetchImpl ?? fetch;
      const res = await fetchFn(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.options.secret}`
        },
        body: JSON.stringify({
          command,
          payload,
          requestId: opts.requestId,
          idempotencyKey: opts.idempotencyKey
        }),
        signal: controller.signal
      });
      const body = (await res.json()) as Mt5MailboxReply<T> & { error?: string };
      if (!res.ok && !body.command) {
        return {
          requestId: opts.requestId,
          mailboxFileId: "bridge-client",
          idempotencyKey: opts.idempotencyKey,
          command,
          ok: false,
          errorCode: res.status === 401 ? "MT5_BRIDGE_UNAUTHENTICATED" : "MT5_BRIDGE_HTTP_ERROR",
          errorMessage: body.error ?? `HTTP ${res.status}`,
          createdAt: new Date().toISOString(),
          authHmac: ""
        };
      }
      return body;
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      return {
        requestId: opts.requestId,
        mailboxFileId: "bridge-client",
        idempotencyKey: opts.idempotencyKey,
        command,
        ok: false,
        errorCode: aborted ? "MT5_EA_TIMEOUT" : "MT5_BRIDGE_UNREACHABLE",
        errorMessage: err instanceof Error ? err.message : String(err),
        needsReconcile: aborted,
        createdAt: new Date().toISOString(),
        authHmac: ""
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async close(): Promise<void> {
    /* http client is stateless */
  }
}
