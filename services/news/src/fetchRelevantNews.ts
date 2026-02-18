/**
 * fetchRelevantNewsForMovement — the main entry point for the smarter news algorithm.
 *
 * Pipeline:
 *   1. Resolve slug + title for the market
 *   2. Derive entity context (deterministic)
 *   3. Compute time window alignment
 *   4. Check cache
 *   5. Generate search query (AI keywords OR fallback)
 *   6. Fetch from NewsAPI
 *   7. Filter by entity relevance
 *   8. Score and rank articles
 *   9. Cache results
 *  10. Compute aggregate score
 */

import type { NewsArticle } from "./types";
import { resolveSlugAndTitle } from "./newsapi.client";
import { deriveEntityContextAsync, type EntityContext } from "./entity";
import { computeNewsTimeRange } from "./timeWindow";
import { buildCacheSlug, getCachedArticles, setCachedArticles } from "./newsCache";
import {
  filterAndRankArticles,
  computeAggregateNewsScore,
} from "./relevance";
import { generateSearchKeywords } from "./ai.keyword";
import { buildSearchQuery } from "./keyword.builder";

export type RelevantNewsResult = {
  score: number;
  articleCount: number;
  topHeadlines: string[];
  query: string;
  cached: boolean;
  entityContext: EntityContext;
  rankedArticles: (NewsArticle & { relevanceScore: number })[];
};

const NEWSAPI_KEY = process.env.NEWSAPI_KEY ?? "";
const NEWSAPI_BASE = process.env.NEWSAPI_BASE_URL ?? "https://newsapi.org/v2";

/**
 * Query NewsAPI with entity-aware keywords and time-aligned window.
 */
async function queryNewsApiAligned(
  query: string,
  fromDate: string,
  toDate: string
): Promise<NewsArticle[]> {
  if (!NEWSAPI_KEY) return [];

  const params = new URLSearchParams({
    q: query,
    sortBy: "publishedAt",
    pageSize: "30",
    from: fromDate,
    to: toDate,
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

  const body = await res.json();
  if (body.status !== "ok" || !Array.isArray(body.articles)) return [];

  return body.articles.map((a: any) => ({
    title: a.title ?? "",
    description: a.description ?? null,
    source: { name: a.source?.name ?? "unknown" },
    publishedAt: a.publishedAt ?? "",
    url: a.url ?? "",
  }));
}

/**
 * Build search query incorporating entity terms.
 * Uses AI keywords first, then falls back to entity-enriched keyword builder.
 */
async function buildEntityAwareQuery(
  slug: string,
  title: string | null,
  entityContext: EntityContext
): Promise<string> {
  // Try AI-generated keywords first
  const aiQuery = await generateSearchKeywords(slug, title);
  if (aiQuery) return aiQuery;

  // Fallback: combine keyword builder output with top entity terms
  const baseQuery = buildSearchQuery(slug, title);
  const entityAdditions = entityContext.entityTerms
    .slice(0, 3)
    .filter((t) => !baseQuery.toLowerCase().includes(t.toLowerCase()));

  if (entityAdditions.length === 0) return baseQuery;

  // Add entity terms with OR to broaden the search
  const additions = entityAdditions.map((t) => `"${t}"`).join(" OR ");
  const combined = `${baseQuery} OR ${additions}`;
  return combined.slice(0, 250);
}

/**
 * Extract query keywords for relevance scoring (splits OR-separated phrases).
 */
function extractQueryKeywords(query: string): string[] {
  return query
    .split(/\bOR\b/i)
    .map((s) => s.replace(/["']/g, "").trim())
    .filter((s) => s.length > 0);
}

/**
 * Main entry point: fetch relevant news for a specific movement.
 */
export async function fetchRelevantNewsForMovement(
  marketId: string,
  windowEnd: string,
  windowType: string
): Promise<RelevantNewsResult> {
  const zero: RelevantNewsResult = {
    score: 0,
    articleCount: 0,
    topHeadlines: [],
    query: "",
    cached: false,
    entityContext: { entityTerms: [], category: "other", canonicalEntity: "" },
    rankedArticles: [],
  };

  if (!NEWSAPI_KEY) return zero;

  // 1. Resolve slug + title
  const { slug, title } = await resolveSlugAndTitle(marketId);
  if (!slug && !title) return zero;

  // 2. Entity grounding (deterministic first, AI fallback for unknowns)
  const entityContext = await deriveEntityContextAsync(
    title ?? slug ?? marketId,
    slug
  );

  // 3. Time window alignment
  const { fromDate, toDate, lookbackMs, bucketKey } = computeNewsTimeRange(
    windowEnd,
    windowType
  );

  // 4. Check cache
  const cacheSlug = buildCacheSlug(entityContext.canonicalEntity, windowType);
  const cached = await getCachedArticles(cacheSlug, bucketKey);

  let articles: NewsArticle[];
  let query: string;
  let isCached = false;

  if (cached !== null) {
    articles = cached;
    query = "(cached)";
    isCached = true;
  } else {
    // 5. Build entity-aware query
    query = await buildEntityAwareQuery(slug ?? marketId, title, entityContext);
    if (!query.trim()) return zero;

    // 6. Fetch from NewsAPI
    articles = await queryNewsApiAligned(query, fromDate, toDate);

    // 9. Cache results (even empty to avoid re-fetching)
    await setCachedArticles(cacheSlug, bucketKey, articles, query).catch(
      (err) => console.warn("[news] cache write failed", err?.message)
    );
  }

  // 7+8. Filter and rank by entity relevance
  const windowEndMs = Date.parse(windowEnd) || Date.now();
  const queryKeywords = extractQueryKeywords(query);
  const rankedArticles = filterAndRankArticles(
    articles,
    entityContext.entityTerms,
    queryKeywords,
    windowEndMs,
    lookbackMs
  );

  // 10. Compute aggregate score
  const score = computeAggregateNewsScore(rankedArticles);

  return {
    score,
    articleCount: rankedArticles.length,
    topHeadlines: rankedArticles.slice(0, 3).map((a) => a.title),
    query,
    cached: isCached,
    entityContext,
    rankedArticles,
  };
}
