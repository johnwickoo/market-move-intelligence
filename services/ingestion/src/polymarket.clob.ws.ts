import WebSocket = require("ws");

type ClobMarketOpts = {
  baseUrl?: string;              // default wss://ws-subscriptions-clob.polymarket.com
  assetIds: string[];            // YES token asset id + NO token asset id
  onTick: (msg: any) => Promise<void> | void;
  reconnectMs?: number;
  maxBackoffMs?: number;
};

export type ClobHandle = {
  close: () => void;
};

export function connectClobMarketWS(opts: ClobMarketOpts): ClobHandle {
  const base = opts.baseUrl ?? "wss://ws-subscriptions-clob.polymarket.com";
  const wsUrl = `${base}/ws/market`;
  const reconnectBaseMs = opts.reconnectMs ?? 15_000;
  const maxBackoffMs = opts.maxBackoffMs ?? 120_000;

  let ws: WebSocket | null = null;
  let pingInterval: NodeJS.Timeout | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let closedByRateLimit = false;
  let destroyed = false;
  let backoffMs = reconnectBaseMs;
  let lastConnectAt = 0;

  const scheduleReconnect = (reason: string) => {
    if (destroyed) return;
    if (reconnectTimer) return;
    const jitter = Math.floor(Math.random() * 5_000);
    const delay = Math.min(backoffMs + jitter, maxBackoffMs + jitter);
    console.warn(`[clob] reconnecting in ${Math.round(delay / 1000)}s (${reason})`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      closedByRateLimit = false;
      connect();
    }, delay);
  };

  const connect = () => {
    if (destroyed) return;
    const now = Date.now();
    if (now - lastConnectAt < 1000) {
      scheduleReconnect("connect throttled");
      return;
    }
    lastConnectAt = now;
    ws = new WebSocket(wsUrl);

    pingInterval = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) ws.send("PING");
    }, 30_000);

    ws.on("open", () => {
      // Market channel subscription format

      ws?.send(JSON.stringify({ assets_ids: opts.assetIds, type: "market" }));
      console.log("[clob] connected + subscribed", opts.assetIds.length);
      backoffMs = reconnectBaseMs;
    });

    ws.on("message", async (data) => {
      const text = data.toString();
      const lower = text.toLowerCase();
      if (lower === "pong" || lower === "ping") return;

      let parsed: any;
      try {
        parsed = JSON.parse(text);
      } catch {
        return;
      }

      // rate limit notice
      if (
        parsed?.message === "Too Many Requests" ||
        parsed?.body?.message?.includes("Too Many Requests")
      ) {
        closedByRateLimit = true;
        backoffMs = Math.min(Math.max(backoffMs * 2, 30_000), maxBackoffMs);
        console.warn(`[clob] rate limited — backing off ${Math.round(backoffMs / 1000)}s`);
        ws?.close();
        scheduleReconnect("rate limit");
        return;
      }

      try {
        await opts.onTick(parsed);
      } catch (err: any) {
        console.error("[clob] onTick error:", err?.message ?? err);
      }
    });

    ws.on("close", () => {
      if (pingInterval) clearInterval(pingInterval);
      pingInterval = null;
      console.log("[clob] closed");
      if (!destroyed && !closedByRateLimit) scheduleReconnect("socket closed");
    });

    ws.on("error", (err: any) => {
      console.error("[clob] error", err);
      if (err?.code === "ENOTFOUND") {
        backoffMs = Math.min(Math.max(backoffMs * 2, 30_000), maxBackoffMs);
        try {
          ws?.close();
        } catch {
          // ignore close errors
        }
      }
    });
  };

  connect();

  return {
    close() {
      destroyed = true;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
      try { ws?.close(); } catch { /* ignore */ }
    },
  };
}
