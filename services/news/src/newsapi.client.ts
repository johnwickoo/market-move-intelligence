import { supabase } from "../../storage/src/db";

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
