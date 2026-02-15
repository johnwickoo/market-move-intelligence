const STOP_WORDS = new Set([
  "will", "there", "be", "by", "the", "a", "an", "of", "in", "to",
  "and", "or", "is", "it", "its", "this", "that", "at", "for", "with",
  "from", "another", "on", "has", "have", "had", "do", "does", "did",
  "but", "not", "no", "so", "if", "up", "out", "are", "was", "were",
  "been", "being", "can", "could", "would", "should", "may", "might",
]);

const MAX_QUERY_LENGTH = 200;

export function buildSearchQuery(
  slug: string,
  title: string | null
): string {
  const source = title
    ? title.replace(/[?!.]+$/g, "").trim()
    : slug.replace(/-/g, " ");

  const words = source
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .filter((w) => !STOP_WORDS.has(w.toLowerCase()));

  if (words.length === 0) return slug.replace(/-/g, " ").slice(0, MAX_QUERY_LENGTH);

  const query = words.join(" ");
  return query.slice(0, MAX_QUERY_LENGTH);
}
