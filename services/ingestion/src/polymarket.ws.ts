import WebSocket = require("ws");

export function connectPolymarketWS(opts: {
  url: string;
  onMessage: (msg: any) => Promise<void> | void;
  subscriptions: Array<{ topic: string; type: string; filters?: string }>;
}) {
  let ws: WebSocket | null = null;
  let pingInterval: NodeJS.Timeout | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let backoffMs = 5_000;
  const maxBackoffMs = 60_000;

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

    // ping like the official client: send "ping" text
    pingInterval = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) ws.send("ping");
    }, 5000);

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
      if (text === "pong" || text === "ping") return;

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
      console.log("[ws] closed");
      backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
      scheduleReconnect("socket closed");
    });

    ws.on("error", (err: Error) => {
      console.error("[ws] error", err);
      backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
    });
  };

  connect();
  return ws;
}
