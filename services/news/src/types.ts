export type NewsArticle = {
  title: string;
  description: string | null;
  source: { name: string };
  publishedAt: string;
  url: string;
};

export type NewsApiResponse = {
  status: string;
  totalResults: number;
  articles: NewsArticle[];
};

export type NewsCacheRow = {
  slug: string;
  hour_bucket: number;
  articles: NewsArticle[];
  article_count: number;
  query: string;
  fetched_at: string;
};

export type NewsResult = {
  score: number;
  articleCount: number;
  topHeadlines: string[];
  query: string;
  cached: boolean;
};
