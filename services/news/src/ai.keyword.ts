import OpenAI from "openai";

const AI_MODEL = process.env.AI_EXPLANATION_MODEL ?? "gpt-4o-mini";

let _client: OpenAI | null = null;

function getClient(): OpenAI | null {
  if (_client) return _client;
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  _client = new OpenAI({ apiKey: key });
  return _client;
}

const SYSTEM_PROMPT = `You generate concise news search queries for prediction markets.
Given a market title, output 3-5 search keywords or short phrases that would find relevant recent news. Return ONLY the keywords separated by OR. No explanation.
Example: "government shutdown" OR "spending bill" OR Congress budget`;

// Hourly cache to avoid repeated calls for the same market
const cache = new Map<string, { bucket: number; query: string }>();

function hourBucket(ms: number): number {
  return Math.floor(ms / 3_600_000);
}

export async function generateSearchKeywords(
  slug: string,
  title: string | null
): Promise<string | null> {
  const client = getClient();
  if (!client) return null;

  const input = title || slug;
  if (!input) return null;

  const bucket = hourBucket(Date.now());
  const cached = cache.get(slug);
  if (cached && cached.bucket === bucket) return cached.query;

  try {
    const response = await Promise.race([
      client.chat.completions.create({
        model: AI_MODEL,
        temperature: 0.2,
        max_tokens: 80,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: input },
        ],
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("AI keyword timeout")), 5000)
      ),
    ]);

    const text = response.choices?.[0]?.message?.content?.trim();
    if (!text) return null;

    cache.set(slug, { bucket, query: text });
    console.log(`[news-ai] keywords for "${slug}": ${text}`);
    return text;
  } catch (err: any) {
    console.log("[news-ai] keyword generation failed:", err?.message);
    return null;
  }
}
