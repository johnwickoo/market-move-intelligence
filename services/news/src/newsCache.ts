/**
 * News cache — keyed by (canonicalEntity + windowBucketStart + windowType).
 *
 * Uses the existing `news_cache` Supabase table but with a composite slug
 * that encodes entity + window type to get finer-grained caching.
 */

import { supabase } from "../../storage/src/db";
import type { NewsArticle } from "./types";

/**
 * Build a cache key slug from entity context and window type.
 * e.g. "Bitcoin__5m" or "Trump__event"
 */
export function buildCacheSlug(
  canonicalEntity: string,
  windowType: string
): string {
  const sanitized = canonicalEntity
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return `${sanitized}__${windowType}`;
}

export async function getCachedArticles(
  cacheSlug: string,
  bucketKey: number
): Promise<NewsArticle[] | null> {
  const { data } = await supabase
    .from("news_cache")
    .select("articles")
    .eq("slug", cacheSlug)
    .eq("hour_bucket", bucketKey)
    .maybeSingle();

  if (!data) return null;
  return (data.articles ?? []) as NewsArticle[];
}

export async function setCachedArticles(
  cacheSlug: string,
  bucketKey: number,
  articles: NewsArticle[],
  query: string
): Promise<void> {
  await supabase.from("news_cache").upsert(
    {
      slug: cacheSlug,
      hour_bucket: bucketKey,
      articles: JSON.parse(JSON.stringify(articles)),
      article_count: articles.length,
      query,
      fetched_at: new Date().toISOString(),
    },
    { onConflict: "slug,hour_bucket" }
  );
}
