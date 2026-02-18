import * as assert from "node:assert/strict";
import {
  isRelevantArticle,
  scoreArticleRelevance,
  filterAndRankArticles,
  computeAggregateNewsScore,
} from "../src/relevance";
import type { NewsArticle } from "../src/types";

const now = Date.parse("2026-02-17T12:00:00.000Z");
const lookbackMs = 60 * 60_000; // 1h lookback

function makeArticle(overrides: Partial<NewsArticle> = {}): NewsArticle {
  return {
    title: "Bitcoin hits new all-time high above $100k",
    description: "BTC surges past $100,000 as institutional demand grows",
    source: { name: "CoinDesk" },
    publishedAt: new Date(now - 30 * 60_000).toISOString(), // 30min ago
    url: "https://example.com/article",
    ...overrides,
  };
}

// ── isRelevantArticle ────────────────────────────────────────────────

{
  // Matches entity term
  const a = makeArticle();
  assert.ok(isRelevantArticle(a, ["Bitcoin", "BTC"]));
}

{
  // Does not match entity term
  const a = makeArticle({ title: "Fed raises rates", description: "Economy update" });
  assert.ok(!isRelevantArticle(a, ["Bitcoin", "BTC"]));
}

{
  // Empty entity terms = pass all
  const a = makeArticle();
  assert.ok(isRelevantArticle(a, []));
}

{
  // Stop-term-only title rejected
  const a = makeArticle({ title: "Breaking News Update", description: "Bitcoin" });
  // description has "Bitcoin" so it should still match
  assert.ok(isRelevantArticle(a, ["Bitcoin"]));
}

// ── scoreArticleRelevance ────────────────────────────────────────────

{
  const a = makeArticle();
  const score = scoreArticleRelevance(
    a,
    ["Bitcoin", "BTC"],
    ["bitcoin", "price"],
    now,
    lookbackMs
  );
  // Should be reasonably high: matches entities, recent, good source
  assert.ok(score > 0.5, `Expected >0.5, got ${score}`);
}

{
  // Old article — lower recency
  const a = makeArticle({
    publishedAt: new Date(now - 2 * 60 * 60_000).toISOString(), // 2h ago, beyond 1h lookback
  });
  const score = scoreArticleRelevance(
    a,
    ["Bitcoin", "BTC"],
    ["bitcoin"],
    now,
    lookbackMs
  );
  // Should still be > 0 (entity match) but lower recency
  assert.ok(score > 0, `Expected >0, got ${score}`);
  assert.ok(score < 0.7, `Expected <0.7 for old article, got ${score}`);
}

// ── filterAndRankArticles ────────────────────────────────────────────

{
  const articles = [
    makeArticle({ title: "Bitcoin surges", description: "BTC up 10%" }),
    makeArticle({ title: "Ethereum upgrade", description: "ETH news" }),
    makeArticle({ title: "Weather forecast today", description: "Rain" }),
  ];
  const ranked = filterAndRankArticles(
    articles,
    ["Bitcoin", "BTC"],
    ["bitcoin"],
    now,
    lookbackMs
  );
  // Only the Bitcoin article should pass
  assert.equal(ranked.length, 1);
  assert.ok(ranked[0].title.includes("Bitcoin"));
  assert.ok(ranked[0].relevanceScore > 0);
}

// ── computeAggregateNewsScore ────────────────────────────────────────

{
  // No articles = 0
  assert.equal(computeAggregateNewsScore([]), 0);
}

{
  // Multiple articles with decent scores
  const ranked = [
    { relevanceScore: 0.8, source: { name: "Reuters" } },
    { relevanceScore: 0.7, source: { name: "Bloomberg" } },
    { relevanceScore: 0.6, source: { name: "CoinDesk" } },
  ];
  const score = computeAggregateNewsScore(ranked);
  assert.ok(score > 0.3, `Expected >0.3, got ${score}`);
  assert.ok(score <= 1, `Expected <=1, got ${score}`);
}

{
  // Single article = lower count score
  const ranked = [{ relevanceScore: 0.9, source: { name: "Reuters" } }];
  const score = computeAggregateNewsScore(ranked);
  assert.ok(score > 0, `Expected >0, got ${score}`);
  assert.ok(score < 0.8, `Expected <0.8 for single article, got ${score}`);
}

console.log("relevance.test.ts: ok");
