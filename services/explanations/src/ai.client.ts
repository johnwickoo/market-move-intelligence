import OpenAI from "openai";
import { buildTemplateExplanation } from "./buildExplanation";

const AI_TIMEOUT_MS = Number(process.env.AI_EXPLANATION_TIMEOUT_MS ?? 8000);
const AI_MODEL = process.env.AI_EXPLANATION_MODEL ?? "gpt-4o-mini";

let _client: OpenAI | null = null;

function getClient(): OpenAI | null {
  if (_client) return _client;
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  _client = new OpenAI({ apiKey: key });
  return _client;
}

const SYSTEM_PROMPT = `You are a quantitative analyst monitoring Polymarket prediction markets in real-time.
A movement detection system has flagged unusual activity. Write a 2-3 sentence explanation for a trader dashboard tooltip.

Guidelines:
- Lead with the most likely driver of the move
- Reference specific numbers (price %, volume ratios, velocity)
- If news headlines are provided, cite the most relevant one briefly
- If thin_liquidity is true, note the move may be exaggerated
- If classification is VELOCITY, emphasize speed/impulse nature
- Use plain English, no markdown, no bullets, no emojis
- Be concise: 2-3 sentences max`;

function safeNum(x: any, fallback = 0): number {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

function fmtPct(x: any): string {
  return (safeNum(x) * 100).toFixed(1) + "%";
}

function fmtRatio(x: any): string {
  return x == null || !Number.isFinite(Number(x))
    ? "n/a"
    : safeNum(x).toFixed(2) + "x";
}

function fmtPrice(x: any): string {
  return safeNum(x).toFixed(4);
}

function windowDuration(movement: any): string {
  const startMs = Date.parse(movement?.window_start ?? "");
  const endMs = Date.parse(movement?.window_end ?? "");
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return movement?.window_type ?? "unknown";
  }
  const mins = Math.round((endMs - startMs) / 60_000);
  if (mins < 60) return `${mins}min`;
  return `${Math.round(mins / 60)}h`;
}

export function formatMovementContext(
  movement: any,
  signal: any,
  marketTitle?: string
): string {
  const title = marketTitle || movement?.market_id || "unknown";
  const outcome = movement?.outcome ?? "Yes";
  const windowType = movement?.window_type ?? "";
  const duration = windowDuration(movement);

  const headlines: string[] = (movement as any)?.__newsHeadlines ?? [];
  const newsLine =
    headlines.length > 0
      ? headlines
          .slice(0, 3)
          .map((h: string) => (h.length > 80 ? h.slice(0, 77) + "..." : h))
          .join(" | ")
      : "none";

  return `MARKET: ${title}
OUTCOME: ${outcome}  |  WINDOW: ${windowType} (${duration})

PRICE: ${fmtPrice(movement?.start_price)} → ${fmtPrice(movement?.end_price)} (Δ ${fmtPct(movement?.pct_change)}), range ${fmtPct(movement?.range_pct)}
VOLUME: ${safeNum(movement?.volume_24h).toFixed(0)} (ratio: ${fmtRatio(movement?.volume_ratio)} baseline, hourly peak: ${fmtRatio(movement?.hourly_volume_ratio)})
VELOCITY: ${safeNum(movement?.velocity).toFixed(4)}  |  REASON: ${movement?.reason ?? ""}
LIQUIDITY: thin=${Boolean(movement?.thin_liquidity)}, trades=${safeNum(movement?.trades_count_24h)}, levels=${safeNum(movement?.unique_price_levels_24h)}

SCORES: capital=${safeNum(signal?.capital_score).toFixed(2)} info=${safeNum(signal?.info_score).toFixed(2)} velocity=${safeNum(signal?.velocity_score).toFixed(2)} news=${safeNum(signal?.news_score).toFixed(2)} time=${safeNum(signal?.time_score).toFixed(2)}
CLASSIFICATION: ${signal?.classification ?? ""} (confidence: ${safeNum(signal?.confidence).toFixed(2)})

NEWS: ${newsLine}`;
}

async function generateExplanation(
  movement: any,
  signal: any,
  marketTitle?: string
): Promise<string> {
  const client = getClient();
  if (!client) throw new Error("no OpenAI client");

  const userMessage = formatMovementContext(movement, signal, marketTitle);

  const response = await Promise.race([
    client.chat.completions.create({
      model: AI_MODEL,
      temperature: 0.3,
      max_tokens: 150,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
    }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("AI timeout")), AI_TIMEOUT_MS)
    ),
  ]);

  const text = response.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("empty AI response");
  return text;
}

export async function generateExplanationSafe(
  movement: any,
  signal: any,
  marketTitle?: string
): Promise<{ text: string; source: "ai" | "template" }> {
  try {
    const text = await generateExplanation(movement, signal, marketTitle);
    console.log("[explain-ai] generated AI explanation");
    return { text, source: "ai" };
  } catch (err: any) {
    console.log("[explain-ai] fallback to template:", err?.message);
    const text = buildTemplateExplanation(movement, signal);
    return { text, source: "template" };
  }
}
