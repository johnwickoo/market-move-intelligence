import { supabase } from "../../storage/src/db";
import { buildSearchQuery } from "./keyword.builder";
import { generateSearchKeywords } from "./ai.keyword";
import type { NewsArticle, NewsApiResponse, NewsResult } from "./types";

const NEWSAPI_KEY = process.env.NEWSAPI_KEY ?? "";
const NEWSAPI_BASE = process.env.NEWSAPI_BASE_URL ?? "https://newsapi.org/v2";
const MIN_SCORE = Number(process.env.NEWS_MIN_SCORE ?? 0.15);

function clamp01(x: number) {
  return Math.max(0, Math.min(1, x));
}

function hourBucket(ms: number) {
  return Math.floor(ms / 3_600_000);
}

// ── slug / title resolution from trades ─────────────────────────────

function slugFromRaw(raw: any): string | null {
  const p = raw?.payload ?? raw;
  return p?.eventSlug ?? p?.slug ?? p?.marketSlug ?? p?.market_slug ?? null;
}

function titleFromRaw(raw: any): string | null {
  const p = raw?.payload ?? raw;
  return p?.title ?? p?.market_title ?? null;
}

export async function resolveSlugAndTitle(
  marketId: string
): Promise<{ slug: string | null; title: string | null }> {
  const { data } = await supabase
    .from("trades")
    .select("raw")
    .eq("market_id", marketId)
    .order("timestamp", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!data?.raw) return { slug: null, title: null };
  return { slug: slugFromRaw(data.raw), title: titleFromRaw(data.raw) };
}

// ── cache ───────────────────────────────────────────────────────────

async function getCached(
  slug: string,
  bucket: number
): Promise<NewsArticle[] | null> {
  const { data } = await supabase
    .from("news_cache")
    .select("articles")
    .eq("slug", slug)
    .eq("hour_bucket", bucket)
    .maybeSingle();

  if (!data) return null;
  return (data.articles ?? []) as NewsArticle[];
}

async function setCache(
  slug: string,
  bucket: number,
  articles: NewsArticle[],
  query: string
) {
  await supabase.from("news_cache").upsert(
    {
      slug,
      hour_bucket: bucket,
      articles: JSON.parse(JSON.stringify(articles)),
      article_count: articles.length,
      query,
      fetched_at: new Date().toISOString(),
    },
    { onConflict: "slug,hour_bucket" }
  );
}

// ── NewsAPI call ────────────────────────────────────────────────────

async function queryNewsApi(query: string): Promise<NewsArticle[]> {
  if (!NEWSAPI_KEY) return [];

  const fromDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  const params = new URLSearchParams({
    q: query,
    sortBy: "publishedAt",
    pageSize: "20",
    from: fromDate,
    language: "en",
    apiKey: NEWSAPI_KEY,
  });

  const res = await fetch(`${NEWSAPI_BASE}/everything?${params}`, {
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    console.warn(`[news] API error ${res.status}: ${await res.text()}`);
    return [];
  }

  const body = (await res.json()) as NewsApiResponse;
  if (body.status !== "ok" || !Array.isArray(body.articles)) return [];

  return body.articles.map((a) => ({
    title: a.title ?? "",
    description: a.description ?? null,
    source: { name: a.source?.name ?? "unknown" },
    publishedAt: a.publishedAt ?? "",
    url: a.url ?? "",
  }));
}

// ── score computation ───────────────────────────────────────────────

function computeScore(articles: NewsArticle[], nowMs: number): number {
  if (articles.length === 0) return 0;

  const countScore = clamp01(articles.length / 10);

  let recencySum = 0;
  const sources = new Set<string>();

  for (const a of articles) {
    sources.add(a.source.name);

    const pubMs = Date.parse(a.publishedAt);
    if (!Number.isFinite(pubMs)) {
      recencySum += 0.1;
      continue;
    }
    const ageMs = nowMs - pubMs;
    const sixHours = 6 * 60 * 60 * 1000;
    const oneDay = 24 * 60 * 60 * 1000;
    const threeDays = 72 * 60 * 60 * 1000;

    if (ageMs < sixHours) recencySum += 1.0;
    else if (ageMs < oneDay) recencySum += 0.7;
    else if (ageMs < threeDays) recencySum += 0.3;
    else recencySum += 0.1;
  }

  const recencyScore = recencySum / articles.length;
  const diversityScore = clamp01(sources.size / 5);

  const raw = 0.4 * countScore + 0.35 * recencyScore + 0.25 * diversityScore;
  return raw < MIN_SCORE ? 0 : clamp01(raw);
}

// ── public API ──────────────────────────────────────────────────────

export async function fetchNewsScore(marketId: string): Promise<NewsResult> {
  const zero: NewsResult = {
    score: 0,
    articleCount: 0,
    topHeadlines: [],
    query: "",
    cached: false,
  };

  if (!NEWSAPI_KEY) return zero;

  const { slug, title } = await resolveSlugAndTitle(marketId);
  if (!slug) return zero;

  const aiQuery = await generateSearchKeywords(slug, title);
  const query = aiQuery || buildSearchQuery(slug, title);
  if (!query.trim()) return zero;

  const nowMs = Date.now();
  const bucket = hourBucket(nowMs);

  // Check cache
  const cached = await getCached(slug, bucket);
  if (cached !== null) {
    const score = computeScore(cached, nowMs);
    return {
      score,
      articleCount: cached.length,
      topHeadlines: cached.slice(0, 3).map((a) => a.title),
      query,
      cached: true,
    };
  }

  // Fetch from API
  const articles = await queryNewsApi(query);

  // Cache result (even if empty, to avoid re-fetching)
  await setCache(slug, bucket, articles, query).catch((err) =>
    console.warn("[news] cache write failed", err?.message)
  );

  const score = computeScore(articles, nowMs);
  return {
    score,
    articleCount: articles.length,
    topHeadlines: articles.slice(0, 3).map((a) => a.title),
    query,
    cached: false,
  };
}
