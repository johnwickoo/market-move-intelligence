import { supabase } from "../../storage/src/db";

// ── slug / title resolution from market_resolution ──────────────────

export async function resolveSlugAndTitle(
  marketId: string
): Promise<{ slug: string | null; title: string | null }> {
  const { data } = await supabase
    .from("market_resolution")
    .select("slug, title")
    .eq("market_id", marketId)
    .maybeSingle();

  return {
    slug: (data as any)?.slug ?? null,
    title: (data as any)?.title ?? null,
  };
}
