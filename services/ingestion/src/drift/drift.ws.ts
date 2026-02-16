import WebSocket = require("ws");
import type { DriftRawTrade, DriftRawOrderbook } from "./drift.types";

type DriftWsOpts = {
  url?: string;
  onTrade: (msg: DriftRawTrade) => Promise<void> | void;
  onOrderbook: (msg: DriftRawOrderbook) => Promise<void> | void;
  reconnectMs?: number;
  maxBackoffMs?: number;
};

export type DriftWsHandle = {
  close: () => void;
  subscribe: (marketName: string) => void;
  unsubscribe: (marketName: string) => void;
  subscribedMarkets: () => string[];
};

const DEFAULT_URL = "wss://dlob.drift.trade/ws";
const HEARTBEAT_TIMEOUT_MS = 15_000;

export function connectDriftWS(opts: DriftWsOpts): DriftWsHandle {
  const wsUrl = opts.url ?? DEFAULT_URL;
  const reconnectBaseMs = opts.reconnectMs ?? 15_000;
  const maxBackoffMs = opts.maxBackoffMs ?? 120_000;

  let ws: WebSocket | null = null;
  let heartbeatCheck: NodeJS.Timeout | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let destroyed = false;
  let backoffMs = reconnectBaseMs;
  let lastConnectAt = 0;
  let lastHeartbeatAt = Date.now();

  const subscribedSet = new Set<string>();

  // ── Reconnection ────────────────────────────────────────────────
  const scheduleReconnect = (reason: string) => {
    if (destroyed || reconnectTimer) return;
    const jitter = Math.floor(Math.random() * 5_000);
    const delay = Math.min(backoffMs + jitter, maxBackoffMs + jitter);
    console.warn(
      `[drift-ws] reconnecting in ${Math.round(delay / 1000)}s (${reason})`
    );
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  };

  // ── Subscribe helper ────────────────────────────────────────────
  const sendSubscribe = (marketName: string) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(
      JSON.stringify({
        type: "subscribe",
        marketType: "perp",
        channel: "trades",
        market: marketName,
      })
    );
    ws.send(
      JSON.stringify({
        type: "subscribe",
        marketType: "perp",
        channel: "orderbook",
        market: marketName,
      })
    );
  };

  const sendUnsubscribe = (marketName: string) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(
      JSON.stringify({
        type: "unsubscribe",
        marketType: "perp",
        channel: "trades",
        market: marketName,
      })
    );
    ws.send(
      JSON.stringify({
        type: "unsubscribe",
        marketType: "perp",
        channel: "orderbook",
        market: marketName,
      })
    );
  };

  // ── Connection ──────────────────────────────────────────────────
  const connect = () => {
    if (destroyed) return;
    const now = Date.now();
    if (now - lastConnectAt < 1000) {
      scheduleReconnect("connect throttled");
      return;
    }
    lastConnectAt = now;
    lastHeartbeatAt = now;

    ws = new WebSocket(wsUrl);

    // Heartbeat monitoring — Drift sends heartbeats every 5s.
    // If we miss for 15s, force reconnect.
    if (heartbeatCheck) clearInterval(heartbeatCheck);
    heartbeatCheck = setInterval(() => {
      if (Date.now() - lastHeartbeatAt > HEARTBEAT_TIMEOUT_MS) {
        console.warn("[drift-ws] heartbeat timeout — reconnecting");
        try {
          ws?.close();
        } catch {}
      }
    }, 5_000);

    ws.on("open", () => {
      console.log(
        `[drift-ws] connected, subscribing to ${subscribedSet.size} markets`
      );
      backoffMs = reconnectBaseMs;
      for (const name of subscribedSet) {
        sendSubscribe(name);
      }
    });

    ws.on("message", async (data) => {
      const text = data.toString();

      let parsed: any;
      try {
        parsed = JSON.parse(text);
      } catch {
        return;
      }

      // Heartbeat
      if (parsed?.channel === "heartbeat") {
        lastHeartbeatAt = Date.now();
        return;
      }

      // Rate limit
      if (
        parsed?.message === "Too Many Requests" ||
        parsed?.error?.includes?.("rate")
      ) {
        backoffMs = Math.min(Math.max(backoffMs * 2, 30_000), maxBackoffMs);
        console.warn(
          `[drift-ws] rate limited — backing off ${Math.round(backoffMs / 1000)}s`
        );
        try {
          ws?.close();
        } catch {}
        scheduleReconnect("rate limit");
        return;
      }

      try {
        const channel = parsed?.channel as string | undefined;
        const msgData = parsed?.data;

        if (channel === "trades" && msgData) {
          // Trades channel can send single fill or array
          const fills = Array.isArray(msgData) ? msgData : [msgData];
          for (const fill of fills) {
            await opts.onTrade(fill as DriftRawTrade);
          }
        } else if (channel === "orderbook" && msgData) {
          await opts.onOrderbook(msgData as DriftRawOrderbook);
        }
      } catch (err: any) {
        console.error("[drift-ws] handler error:", err?.message ?? err);
      }
    });

    ws.on("close", () => {
      if (heartbeatCheck) {
        clearInterval(heartbeatCheck);
        heartbeatCheck = null;
      }
      console.log("[drift-ws] closed");
      if (!destroyed) scheduleReconnect("socket closed");
    });

    ws.on("error", (err: any) => {
      console.error("[drift-ws] error:", err?.message ?? err);
      if (err?.code === "ENOTFOUND" || err?.code === "ECONNREFUSED") {
        backoffMs = Math.min(Math.max(backoffMs * 2, 30_000), maxBackoffMs);
        try {
          ws?.close();
        } catch {}
      }
    });
  };

  // Start
  connect();

  return {
    close() {
      destroyed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (heartbeatCheck) {
        clearInterval(heartbeatCheck);
        heartbeatCheck = null;
      }
      try {
        ws?.close();
      } catch {}
    },

    subscribe(marketName: string) {
      if (subscribedSet.has(marketName)) return;
      subscribedSet.add(marketName);
      sendSubscribe(marketName);
      console.log(`[drift-ws] subscribed: ${marketName}`);
    },

    unsubscribe(marketName: string) {
      if (!subscribedSet.has(marketName)) return;
      subscribedSet.delete(marketName);
      sendUnsubscribe(marketName);
      console.log(`[drift-ws] unsubscribed: ${marketName}`);
    },

    subscribedMarkets() {
      return Array.from(subscribedSet);
    },
  };
}
