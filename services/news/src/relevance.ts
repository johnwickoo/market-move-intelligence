/**
 * Entity-gated relevance filter + relevance scoring/ranking.
 *
 * Filter: An article passes if it contains at least one entity term
 * (case-insensitive) in its title or description, AND does not match stop terms.
 *
 * Scoring weights:
 *   entity:  0.45 — how many entity terms appear
 *   recency: 0.35 — how recent the article is relative to the window
 *   source:  0.10 — source diversity bonus
 *   keyword: 0.10 — bonus for matching the search query keywords
 */

import type { NewsArticle } from "./types";

// ── Stop terms — generic filler that shouldn't pass the gate ─────────
const STOP_TERMS = new Set([
  "breaking", "update", "latest", "news", "report", "today",
  "just in", "alert", "watch", "live", "click", "subscribe",
]);

/**
 * Check if an article is relevant to the entity terms.
 * Returns false if the article only matches stop terms.
 */
export function isRelevantArticle(
  article: NewsArticle,
  entityTerms: string[]
): boolean {
  if (entityTerms.length === 0) return true; // no entity = pass all

  const text = `${article.title} ${article.description ?? ""}`.toLowerCase();

  // Must match at least one entity term
  const hasEntity = entityTerms.some((term) =>
    text.includes(term.toLowerCase())
  );
  if (!hasEntity) return false;

  // Reject if both title AND description are ONLY stop terms (no substance)
  const allWords = `${article.title} ${article.description ?? ""}`
    .toLowerCase()
    .split(/\s+/);
  const nonStopWords = allWords.filter(
    (w) => w.length > 2 && !STOP_TERMS.has(w)
  );
  if (nonStopWords.length === 0) return false;

  return true;
}

/**
 * Score a single article's relevance (0..1).
 */
export function scoreArticleRelevance(
  article: NewsArticle,
  entityTerms: string[],
  queryKeywords: string[],
  windowEndMs: number,
  lookbackMs: number
): number {
  const text = `${article.title} ${article.description ?? ""}`.toLowerCase();

  // Entity score: fraction of entity terms that appear
  let entityHits = 0;
  for (const term of entityTerms) {
    if (text.includes(term.toLowerCase())) entityHits++;
  }
  const entityScore =
    entityTerms.length > 0 ? entityHits / entityTerms.length : 0.5;

  // Recency score: linear decay over lookback window
  const pubMs = Date.parse(article.publishedAt);
  let recencyScore = 0.5; // fallback
  if (Number.isFinite(pubMs)) {
    const ageMs = windowEndMs - pubMs;
    if (ageMs <= 0) {
      recencyScore = 1.0; // published after the window — very fresh
    } else if (ageMs >= lookbackMs) {
      recencyScore = 0.05; // outside lookback
    } else {
      recencyScore = 1.0 - ageMs / lookbackMs;
    }
  }

  // Keyword score: fraction of query keywords that appear
  let keywordHits = 0;
  for (const kw of queryKeywords) {
    if (text.includes(kw.toLowerCase())) keywordHits++;
  }
  const keywordScore =
    queryKeywords.length > 0 ? keywordHits / queryKeywords.length : 0;

  // Source quality bonus (well-known sources get a small boost)
  const sourceScore = QUALITY_SOURCES.has(
    article.source.name.toLowerCase()
  )
    ? 1.0
    : 0.5;

  return clamp01(
    0.45 * entityScore +
      0.35 * recencyScore +
      0.10 * sourceScore +
      0.10 * keywordScore
  );
}

/**
 * Filter and rank articles by relevance.
 * Returns articles sorted by relevance score (descending), with score attached.
 */
export function filterAndRankArticles(
  articles: NewsArticle[],
  entityTerms: string[],
  queryKeywords: string[],
  windowEndMs: number,
  lookbackMs: number,
  maxResults = 10
): (NewsArticle & { relevanceScore: number })[] {
  const results: (NewsArticle & { relevanceScore: number })[] = [];

  for (const article of articles) {
    if (!isRelevantArticle(article, entityTerms)) continue;

    const relevanceScore = scoreArticleRelevance(
      article,
      entityTerms,
      queryKeywords,
      windowEndMs,
      lookbackMs
    );

    results.push({ ...article, relevanceScore });
  }

  // Sort descending by relevance score
  results.sort((a, b) => b.relevanceScore - a.relevanceScore);

  return results.slice(0, maxResults);
}

/**
 * Compute an aggregate news score from ranked articles (0..1).
 *
 * Combines: article count, average relevance, source diversity.
 */
export function computeAggregateNewsScore(
  rankedArticles: { relevanceScore: number; source: { name: string } }[]
): number {
  if (rankedArticles.length === 0) return 0;

  // Count score: saturates at 8 articles
  const countScore = clamp01(rankedArticles.length / 8);

  // Average relevance of top articles
  const topN = rankedArticles.slice(0, 5);
  const avgRelevance =
    topN.reduce((s, a) => s + a.relevanceScore, 0) / topN.length;

  // Source diversity
  const sources = new Set(
    rankedArticles.map((a) => a.source.name.toLowerCase())
  );
  const diversityScore = clamp01(sources.size / 4);

  return clamp01(
    0.35 * avgRelevance + 0.40 * countScore + 0.25 * diversityScore
  );
}

// ── Helpers ──────────────────────────────────────────────────────────

function clamp01(x: number) {
  return Math.max(0, Math.min(1, x));
}

const QUALITY_SOURCES = new Set([
  "reuters", "associated press", "ap news", "bloomberg",
  "cnbc", "bbc news", "the wall street journal", "wsj",
  "the new york times", "financial times", "the guardian",
  "cnn", "politico", "axios", "coindesk", "the block",
  "decrypt", "cointelegraph", "espn", "the athletic",
]);
