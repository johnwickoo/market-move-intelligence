import WebSocket = require("ws");

export function connectPolymarketWS(opts: {
  url: string;
  onMessage: (msg: any) => Promise<void> | void;
  subscriptions: Array<{ topic: string; type: string; filters?: string }>;
}) {
  const ws = new WebSocket(opts.url);

  // ping like the official client: send "ping" text
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send("ping");
  }, 5000);

  ws.on("open", () => {
    console.log("[ws] connected");

    ws.send(
      JSON.stringify({
        action: "subscribe",
        subscriptions: opts.subscriptions,
      })
    );

    console.log("[ws] subscribed");
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
    clearInterval(pingInterval);
    console.log("[ws] closed");
  });

  ws.on("error", (err: Error) => console.error("[ws] error", err));

  return ws;
}
