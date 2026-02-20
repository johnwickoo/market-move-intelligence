import WebSocket = require("ws");

export function connectPolymarketWS(opts: {
  url: string;
  onMessage: (msg: any) => Promise<void> | void;
  subscriptions: Array<{ topic: string; type: string; filters?: string }>;
  staleMs?: number;
  staleCheckMs?: number;
}) {
  let ws: WebSocket | null = null;
  let pingInterval: NodeJS.Timeout | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let staleTimer: NodeJS.Timeout | null = null;
  let lastMessageAt = Date.now();
  let backoffMs = 5_000;
  const maxBackoffMs = 120_000;
  let rateLimited = false;
  const staleMs = opts.staleMs ?? Number(process.env.WS_STALE_MS ?? 60_000);
  const staleCheckMs = opts.staleCheckMs ?? Number(process.env.WS_STALE_CHECK_MS ?? 10_000);

  const scheduleReconnect = (reason: string) => {
    if (reconnectTimer) return;
    const jitter = Math.floor(Math.random() * 2_000);
    const delay = Math.min(backoffMs + jitter, maxBackoffMs);
    console.warn(`[ws] reconnecting in ${Math.round(delay / 1000)}s (${reason})`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  };

  const connect = () => {
    ws = new WebSocket(opts.url);
    lastMessageAt = Date.now();

    // ping like the official client: send "ping" text
    pingInterval = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) ws.send("ping");
    }, 5000);
    if (staleMs > 0 && staleCheckMs > 0) {
      staleTimer = setInterval(() => {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        const idleMs = Date.now() - lastMessageAt;
        if (idleMs > staleMs) {
          console.warn(`[ws] stale (${Math.round(idleMs / 1000)}s), reconnecting`);
          ws.close();
        }
      }, staleCheckMs);
    }

    ws.on("open", () => {
      console.log("[ws] connected");

      for (const s of opts.subscriptions) {
        ws?.send(
          JSON.stringify({
            action: "subscribe",
            subscriptions: [
              {
                topic: s.topic,
                type: s.type,
                ...(s.filters ? { filters: s.filters } : {}),
              },
            ],
          })
        );
      }

      console.log("[ws] subscribed");
      backoffMs = 5_000;
    });

    ws.on("message", async (data: WebSocket.RawData) => {
      const text = data.toString();

      // server may respond with "pong" or other non-json keepalives
      if (text === "pong" || text === "ping") {
        lastMessageAt = Date.now();
        return;
      }
      lastMessageAt = Date.now();

      try {
        const parsed = JSON.parse(text);
        await opts.onMessage(parsed);
      } catch {
        // ignore non-json messages
      }
    });

    ws.on("close", () => {
      if (pingInterval) clearInterval(pingInterval);
      pingInterval = null;
      if (staleTimer) clearInterval(staleTimer);
      staleTimer = null;
      console.log("[ws] closed");
      // Don't double-bump backoff — error handler already set it for 429
      if (!rateLimited) {
        backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
      }
      rateLimited = false;
      scheduleReconnect("socket closed");
    });

    ws.on("error", (err: any) => {
      const msg = String(err?.message ?? "");
      // 429 = rate limited at HTTP upgrade level — use longer backoff
      if (msg.includes("429")) {
        rateLimited = true;
        backoffMs = Math.min(Math.max(backoffMs * 2, 30_000), maxBackoffMs);
        console.warn(`[ws] rate limited (429) — backing off ${Math.round(backoffMs / 1000)}s`);
      } else {
        console.error("[ws] error", err);
        backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
      }
    });
  };

  connect();
  return ws;
}
