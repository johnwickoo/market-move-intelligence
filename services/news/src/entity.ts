/**
 * Entity Grounding — deterministic entity/category derivation from market titles,
 * with AI fallback for unrecognized entities.
 *
 * Categories: crypto, geopolitics, elections, macro, sports, entertainment, other
 *
 * Pipeline:
 *   1. Deterministic regex matching (fast, no API call)
 *   2. If category === "other", AI extraction via Groq (async, cached)
 */

import OpenAI from "openai";

export type EntityCategory =
  | "crypto"
  | "geopolitics"
  | "elections"
  | "macro"
  | "sports"
  | "entertainment"
  | "other";

export type EntityContext = {
  entityTerms: string[];
  category: EntityCategory;
  canonicalEntity: string;
};

// ── Crypto entities ──────────────────────────────────────────────────

const CRYPTO_ENTITIES: [RegExp, string, string[]][] = [
  [/\bBTC\b|Bitcoin/i, "Bitcoin", ["BTC", "Bitcoin", "bitcoin"]],
  [/\bETH\b|Ethereum/i, "Ethereum", ["ETH", "Ethereum", "ethereum"]],
  [/\bSOL\b|Solana/i, "Solana", ["SOL", "Solana", "solana"]],
  [/\bXRP\b|Ripple/i, "XRP", ["XRP", "Ripple", "ripple"]],
  [/\bDOGE\b|Dogecoin/i, "Dogecoin", ["DOGE", "Dogecoin"]],
  [/\bADA\b|Cardano/i, "Cardano", ["ADA", "Cardano"]],
  [/\bAVAX\b|Avalanche/i, "Avalanche", ["AVAX", "Avalanche"]],
  [/\bLINK\b|Chainlink/i, "Chainlink", ["LINK", "Chainlink"]],
  [/\bMATIC\b|Polygon/i, "Polygon", ["MATIC", "Polygon"]],
  [/\bDOT\b|Polkadot/i, "Polkadot", ["DOT", "Polkadot"]],
  [/\bcrypto\b|cryptocurrency/i, "crypto", ["crypto", "cryptocurrency"]],
  [/\bETF\b/i, "ETF", ["ETF", "exchange-traded fund"]],
  [/\bDeFi\b|decentralized finance/i, "DeFi", ["DeFi", "decentralized finance"]],
  [/\bNFT\b/i, "NFT", ["NFT", "non-fungible token"]],
  [/\bstablecoin/i, "stablecoin", ["stablecoin", "USDT", "USDC"]],
];

// ── Macro / economy entities ─────────────────────────────────────────

const MACRO_ENTITIES: [RegExp, string, string[]][] = [
  [/\bCPI\b|consumer price/i, "CPI", ["CPI", "inflation", "consumer price index"]],
  [/\bFed\b|Federal Reserve/i, "Federal Reserve", ["Fed", "Federal Reserve", "interest rate"]],
  [/\binflation\b/i, "inflation", ["inflation", "CPI", "price index"]],
  [/\bGDP\b/i, "GDP", ["GDP", "gross domestic product", "economic growth"]],
  [/\binterest rate/i, "interest rates", ["interest rate", "Fed", "rate cut", "rate hike"]],
  [/\btariff/i, "tariffs", ["tariff", "trade war", "import duty"]],
  [/\brecession/i, "recession", ["recession", "economic downturn", "GDP"]],
  [/\bunemployment\b|jobs report/i, "unemployment", ["unemployment", "jobs report", "labor market"]],
  [/\bS&P|S&P 500|SPX\b/i, "S&P 500", ["S&P 500", "SPX", "stock market"]],
  [/\bNasdaq\b/i, "Nasdaq", ["Nasdaq", "tech stocks", "stock market"]],
  [/\bDow\b/i, "Dow Jones", ["Dow Jones", "DJIA", "stock market"]],
  [/\boil price|crude oil|brent|WTI\b/i, "oil", ["oil price", "crude oil", "WTI", "Brent"]],
  [/\bgold price\b|\bgold\b.*\$|\$.*\bgold\b/i, "gold", ["gold price", "gold", "precious metals"]],
];

// ── Elections / politics ─────────────────────────────────────────────

const ELECTIONS_ENTITIES: [RegExp, string, string[]][] = [
  [/\bTrump\b/i, "Trump", ["Trump", "Donald Trump", "president"]],
  [/\bBiden\b/i, "Biden", ["Biden", "Joe Biden", "president"]],
  [/\bHarris\b/i, "Harris", ["Kamala Harris", "Harris", "vice president"]],
  [/\bDeSantis\b/i, "DeSantis", ["DeSantis", "Ron DeSantis", "governor"]],
  [/\belection\b|presidential race/i, "election", ["election", "presidential race", "voting"]],
  [/\bCongress\b|Senate\b|House of Representatives/i, "Congress", ["Congress", "Senate", "House"]],
  [/\bgovernment shutdown/i, "government shutdown", ["government shutdown", "spending bill", "Congress"]],
  [/\bimpeach/i, "impeachment", ["impeachment", "impeach", "Congress"]],
  [/\bSupreme Court\b|SCOTUS/i, "Supreme Court", ["Supreme Court", "SCOTUS", "judicial"]],
];

// ── Geopolitics ──────────────────────────────────────────────────────

const GEOPOLITICS_ENTITIES: [RegExp, string, string[]][] = [
  [/\bUkraine\b|Kyiv\b|Zelensky\b/i, "Ukraine", ["Ukraine", "Zelensky", "Russia Ukraine"]],
  [/\bRussia\b|Putin\b|Kremlin\b/i, "Russia", ["Russia", "Putin", "Kremlin"]],
  [/\bChina\b|Beijing\b|Xi Jinping/i, "China", ["China", "Xi Jinping", "Beijing"]],
  [/\bTaiwan\b/i, "Taiwan", ["Taiwan", "China Taiwan", "strait"]],
  [/\bIran\b|Tehran\b/i, "Iran", ["Iran", "Tehran", "nuclear"]],
  [/\bNorth Korea\b|DPRK|Kim Jong/i, "North Korea", ["North Korea", "DPRK", "Kim Jong Un"]],
  [/\bIsrael\b|Gaza\b|Hamas\b/i, "Israel", ["Israel", "Gaza", "Hamas"]],
  [/\bNATO\b/i, "NATO", ["NATO", "alliance", "military"]],
  [/\bwar\b|conflict\b|invasion\b/i, "conflict", ["war", "conflict", "military"]],
  [/\bsanction/i, "sanctions", ["sanctions", "economic sanctions"]],
];

// ── Sports ───────────────────────────────────────────────────────────

const SPORTS_ENTITIES: [RegExp, string, string[]][] = [
  [/\bNBA\b|basketball/i, "NBA", ["NBA", "basketball"]],
  [/\bNFL\b|football/i, "NFL", ["NFL", "football"]],
  [/\bMLB\b|baseball/i, "MLB", ["MLB", "baseball"]],
  [/\bNHL\b|hockey/i, "NHL", ["NHL", "hockey"]],
  [/\bSuper Bowl\b/i, "Super Bowl", ["Super Bowl", "NFL", "football"]],
  [/\bWorld Cup\b/i, "World Cup", ["World Cup", "FIFA", "soccer"]],
  [/\bOlympics\b/i, "Olympics", ["Olympics", "Olympic Games"]],
  [/\bUFC\b|MMA\b/i, "UFC", ["UFC", "MMA", "fighting"]],
  [/\bF1\b|Formula 1/i, "Formula 1", ["F1", "Formula 1", "racing"]],
];

// ── Entertainment ────────────────────────────────────────────────────

const ENTERTAINMENT_ENTITIES: [RegExp, string, string[]][] = [
  [/\bOscar/i, "Oscars", ["Oscars", "Academy Awards", "film"]],
  [/\bGrammy/i, "Grammys", ["Grammys", "Grammy Awards", "music"]],
  [/\bEmmy/i, "Emmys", ["Emmys", "Emmy Awards", "television"]],
  [/\bbox office\b/i, "box office", ["box office", "movie", "film"]],
  [/\bstreaming\b.*war|Netflix|Disney\+/i, "streaming", ["streaming", "Netflix", "Disney"]],
];

// ── Category detection pipeline (ordered by priority) ────────────────

type CategoryDef = {
  category: EntityCategory;
  entities: [RegExp, string, string[]][];
};

const CATEGORIES: CategoryDef[] = [
  { category: "crypto", entities: CRYPTO_ENTITIES },
  { category: "macro", entities: MACRO_ENTITIES },
  { category: "elections", entities: ELECTIONS_ENTITIES },
  { category: "geopolitics", entities: GEOPOLITICS_ENTITIES },
  { category: "sports", entities: SPORTS_ENTITIES },
  { category: "entertainment", entities: ENTERTAINMENT_ENTITIES },
];

/**
 * Derive entity context from a market title and optional event slug.
 * Deterministic — no AI calls.
 */
export function deriveEntityContext(
  title: string,
  eventSlug?: string | null
): EntityContext {
  const text = `${title} ${(eventSlug ?? "").replace(/-/g, " ")}`;

  // Find all matching categories and collect terms
  let bestCategory: EntityCategory = "other";
  let bestCanonical = "";
  const allTerms: string[] = [];
  let bestMatchCount = 0;

  for (const { category, entities } of CATEGORIES) {
    let matchCount = 0;
    let firstCanonical = "";
    const categoryTerms: string[] = [];

    for (const [regex, canonical, terms] of entities) {
      if (regex.test(text)) {
        matchCount++;
        if (!firstCanonical) firstCanonical = canonical;
        for (const t of terms) {
          if (!categoryTerms.includes(t)) categoryTerms.push(t);
        }
      }
    }

    if (matchCount > bestMatchCount) {
      bestMatchCount = matchCount;
      bestCategory = category;
      bestCanonical = firstCanonical;
    }

    allTerms.push(...categoryTerms);
  }

  // Deduplicate terms
  const entityTerms = [...new Set(allTerms)];

  // If no entity matched, extract key terms from title
  if (entityTerms.length === 0) {
    const words = title
      .replace(/[?!.'"]+/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 2)
      .filter(
        (w) =>
          !STOP_WORDS.has(w.toLowerCase())
      )
      .slice(0, 5);
    entityTerms.push(...words);
    bestCanonical = words.join(" ");
  }

  return {
    entityTerms,
    category: bestCategory,
    canonicalEntity: bestCanonical || title.slice(0, 60),
  };
}

const STOP_WORDS = new Set([
  "will", "there", "be", "by", "the", "a", "an", "of", "in", "to",
  "and", "or", "is", "it", "its", "this", "that", "at", "for", "with",
  "from", "another", "on", "has", "have", "had", "do", "does", "did",
  "but", "not", "no", "so", "if", "up", "out", "are", "was", "were",
  "been", "being", "can", "could", "would", "should", "may", "might",
  "what", "when", "where", "who", "how", "which", "before", "after",
  "above", "below", "between", "over", "under", "about", "than", "more",
  "less", "much", "many", "each", "every", "any", "all", "most", "some",
]);

// ── AI entity extraction fallback ────────────────────────────────────

const AI_MODEL = process.env.AI_EXPLANATION_MODEL ?? "llama-3.3-70b-versatile";
const AI_BASE_URL = process.env.AI_BASE_URL ?? "https://api.groq.com/openai/v1";

let _aiClient: OpenAI | null = null;

function getAiClient(): OpenAI | null {
  if (_aiClient) return _aiClient;
  const key = process.env.GROQ_API_KEY ?? process.env.OPENAI_API_KEY;
  if (!key) return null;
  _aiClient = new OpenAI({ apiKey: key, baseURL: AI_BASE_URL });
  return _aiClient;
}

const ENTITY_EXTRACT_PROMPT = `You extract the primary entity and search terms from prediction market titles.
Given a market title, respond with ONLY a JSON object (no markdown, no explanation):
{"entity":"<primary entity name>","category":"<one of: crypto, geopolitics, elections, macro, sports, entertainment, other>","terms":["<search term 1>","<search term 2>","<search term 3>"]}

The terms should be 3-5 concise phrases a journalist would use when writing about this topic.
Example input: "Will Kanye release a new album before July?"
Example output: {"entity":"Kanye West","category":"entertainment","terms":["Kanye West","Kanye album","Ye music release"]}`;

// In-memory cache: title → AI result (keyed by hour bucket to auto-expire)
const aiEntityCache = new Map<
  string,
  { bucket: number; context: EntityContext }
>();

function hourBucket(ms: number): number {
  return Math.floor(ms / 3_600_000);
}

/**
 * AI-powered entity extraction for titles that didn't match any regex.
 * Returns null if AI is unavailable or fails — caller keeps the word-based fallback.
 */
async function aiExtractEntity(title: string): Promise<EntityContext | null> {
  const client = getAiClient();
  if (!client) return null;

  const bucket = hourBucket(Date.now());
  const cached = aiEntityCache.get(title);
  if (cached && cached.bucket === bucket) return cached.context;

  try {
    const response = await Promise.race([
      client.chat.completions.create({
        model: AI_MODEL,
        temperature: 0,
        max_tokens: 120,
        messages: [
          { role: "system", content: ENTITY_EXTRACT_PROMPT },
          { role: "user", content: title },
        ],
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("AI entity timeout")), 5000)
      ),
    ]);

    const text = response.choices?.[0]?.message?.content?.trim();
    if (!text) return null;

    const parsed = JSON.parse(text);
    if (!parsed.entity || !Array.isArray(parsed.terms)) return null;

    const validCategories: EntityCategory[] = [
      "crypto", "geopolitics", "elections", "macro",
      "sports", "entertainment", "other",
    ];
    const category: EntityCategory = validCategories.includes(parsed.category)
      ? parsed.category
      : "other";

    const context: EntityContext = {
      canonicalEntity: String(parsed.entity).slice(0, 80),
      category,
      entityTerms: parsed.terms
        .map((t: unknown) => String(t).trim())
        .filter((t: string) => t.length > 0)
        .slice(0, 6),
    };

    aiEntityCache.set(title, { bucket, context });
    console.log(
      `[entity-ai] extracted "${context.canonicalEntity}" (${context.category})`,
      context.entityTerms
    );
    return context;
  } catch (err: any) {
    console.log("[entity-ai] extraction failed:", err?.message);
    return null;
  }
}

/**
 * Async version of deriveEntityContext — tries deterministic first,
 * then falls back to AI for unrecognized entities.
 */
export async function deriveEntityContextAsync(
  title: string,
  eventSlug?: string | null
): Promise<EntityContext> {
  const deterministic = deriveEntityContext(title, eventSlug);

  // If deterministic matching found a known category, use it
  if (deterministic.category !== "other") return deterministic;

  // Try AI extraction for unknown entities
  const aiResult = await aiExtractEntity(title);
  if (aiResult) return aiResult;

  // AI unavailable or failed — keep the word-based fallback
  return deterministic;
}
