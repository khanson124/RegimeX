import { classifyBridgeFetchError, probeMt5BridgeLive } from "./bridgeHealth.js";
import {
  getSharedMt5BridgeCircuit,
  MT5_BRIDGE_UNHEALTHY,
  type Mt5BridgeCircuitBreaker
} from "./bridgeCircuit.js";
import { emitMt5Telemetry } from "./mt5RequestTelemetry.js";
import { type Mt5CommandType, type Mt5MailboxReply } from "./types.js";

export interface HttpMt5BridgeClientOptions {
  baseUrl: string;
  secret: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  circuit?: Mt5BridgeCircuitBreaker;
}

export class HttpMt5BridgeClient {
  constructor(private readonly options: HttpMt5BridgeClientOptions) {}

  private get circuit(): Mt5BridgeCircuitBreaker {
    return this.options.circuit ?? getSharedMt5BridgeCircuit();
  }

  async probeLive(timeoutMs = 2_000) {
    return probeMt5BridgeLive(this.options.baseUrl, timeoutMs, this.options.fetchImpl);
  }

  async request<T>(
    command: Mt5CommandType,
    payload: unknown,
    opts: { requestId: string; idempotencyKey: string }
  ): Promise<Mt5MailboxReply<T>> {
    if (!this.circuit.allowRequest()) {
      emitMt5Telemetry({
        event: "mt5_request_failed",
        phase: "worker",
        command,
        requestId: opts.requestId,
        idempotencyKey: opts.idempotencyKey,
        errorCode: MT5_BRIDGE_UNHEALTHY,
        durationMs: 0
      });
      return this.fail<T>(command, opts, MT5_BRIDGE_UNHEALTHY, "MT5 bridge circuit is open");
    }

    const url = `${this.options.baseUrl.replace(/\/$/, "")}/v1/command`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    const startedAt = Date.now();
    emitMt5Telemetry({
      event: "mt5_request_start",
      phase: "worker",
      command,
      requestId: opts.requestId,
      idempotencyKey: opts.idempotencyKey
    });
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
      const durationMs = Date.now() - startedAt;
      if (!res.ok && !body.command) {
        const errorCode =
          res.status === 401
            ? "MT5_BRIDGE_UNAUTHENTICATED"
            : res.status === 504
              ? (body.errorCode ?? "MT5_EA_TIMEOUT")
              : res.status === 503
                ? (body.errorCode ?? "MT5_MAILBOX_BACKLOG")
                : "MT5_BRIDGE_HTTP_ERROR";
        this.recordReply(errorCode);
        emitMt5Telemetry({
          event: "mt5_request_failed",
          phase: "worker",
          command,
          requestId: opts.requestId,
          idempotencyKey: opts.idempotencyKey,
          mailboxFileId: body.mailboxFileId,
          errorCode,
          durationMs,
          httpStatus: res.status
        });
        return this.fail<T>(command, opts, errorCode, body.error ?? `HTTP ${res.status}`, res.status === 504);
      }
      if (body.ok) {
        this.circuit.recordSuccess();
        emitMt5Telemetry({
          event: "mt5_request_end",
          phase: "worker",
          command,
          requestId: body.requestId ?? opts.requestId,
          idempotencyKey: body.idempotencyKey ?? opts.idempotencyKey,
          mailboxFileId: body.mailboxFileId,
          durationMs,
          ok: true
        });
      } else {
        this.recordReply(body.errorCode ?? "MT5_BRIDGE_HTTP_ERROR");
        emitMt5Telemetry({
          event: "mt5_request_failed",
          phase: "worker",
          command,
          requestId: body.requestId ?? opts.requestId,
          idempotencyKey: body.idempotencyKey ?? opts.idempotencyKey,
          mailboxFileId: body.mailboxFileId,
          errorCode: body.errorCode ?? "MT5_BRIDGE_HTTP_ERROR",
          durationMs,
          ok: false
        });
      }
      return body;
    } catch (err) {
      const errorCode = classifyBridgeFetchError(err);
      this.circuit.recordFailure(errorCode);
      emitMt5Telemetry({
        event: "mt5_request_failed",
        phase: "worker",
        command,
        requestId: opts.requestId,
        idempotencyKey: opts.idempotencyKey,
        errorCode,
        durationMs: Date.now() - startedAt,
        errorMessage: err instanceof Error ? err.message : String(err)
      });
      return this.fail<T>(
        command,
        opts,
        errorCode,
        err instanceof Error ? err.message : String(err),
        errorCode === "MT5_EA_TIMEOUT"
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private recordReply(errorCode: string): void {
    if (
      errorCode === "MT5_BRIDGE_UNAVAILABLE" ||
      errorCode === "MT5_BRIDGE_TIMEOUT" ||
      errorCode === "MT5_BRIDGE_UNHEALTHY" ||
      errorCode === "MT5_BRIDGE_UNREACHABLE" ||
      errorCode === "MT5_BRIDGE_HTTP_ERROR"
    ) {
      this.circuit.recordFailure(errorCode);
    } else {
      this.circuit.recordSuccess();
    }
  }

  private fail<T>(
    command: Mt5CommandType,
    opts: { requestId: string; idempotencyKey: string },
    errorCode: string,
    errorMessage: string,
    needsReconcile = true
  ): Mt5MailboxReply<T> {
    return {
      requestId: opts.requestId,
      mailboxFileId: "bridge-client",
      idempotencyKey: opts.idempotencyKey,
      command,
      ok: false,
      errorCode,
      errorMessage,
      needsReconcile,
      createdAt: new Date().toISOString(),
      authHmac: ""
    };
  }

  async close(): Promise<void> {
    /* http client is stateless */
  }
}
