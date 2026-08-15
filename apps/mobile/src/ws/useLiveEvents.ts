import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { wsUrl } from "../api/client";
import { useAuthStore } from "../stores/auth";

export interface LiveEvent {
  type: string;
  payload: Record<string, unknown>;
  ts: number;
}

/**
 * Subscribes to the app WebSocket. Live events refresh related queries and
 * the most recent ones are exposed for the explanation panel / decision feed.
 */
export function useLiveEvents(): { lastEvent: LiveEvent | null; price: number | null; connected: boolean } {
  const accessToken = useAuthStore((s) => s.accessToken);
  const [lastEvent, setLastEvent] = useState<LiveEvent | null>(null);
  const [price, setPrice] = useState<number | null>(null);
  const [connected, setConnected] = useState(false);
  const qc = useQueryClient();
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!accessToken) return;
    let closed = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    function connect(): void {
      const ws = new WebSocket(wsUrl(accessToken!));
      wsRef.current = ws;

      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        if (!closed) retryTimer = setTimeout(connect, 3000);
      };
      ws.onmessage = (msg) => {
        try {
          const event = JSON.parse(String(msg.data)) as LiveEvent;
          setLastEvent(event);
          if (event.type === "market.tick") {
            setPrice(Number(event.payload.price));
          } else if (event.type === "market.candle") {
            void qc.invalidateQueries({ queryKey: ["candles"] });
          } else if (event.type.startsWith("trade.")) {
            void qc.invalidateQueries({ queryKey: ["demo-trades"] });
            void qc.invalidateQueries({ queryKey: ["dashboard"] });
          } else if (event.type.startsWith("backtest.")) {
            void qc.invalidateQueries({ queryKey: ["backtests"] });
          } else if (event.type === "engine.status" || event.type === "emergency.stop") {
            void qc.invalidateQueries({ queryKey: ["engine"] });
            void qc.invalidateQueries({ queryKey: ["dashboard"] });
          }
        } catch {
          // ignore malformed frames
        }
      };
    }

    connect();
    return () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      wsRef.current?.close();
    };
  }, [accessToken, qc]);

  return { lastEvent, price, connected };
}
