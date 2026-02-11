import { pgPost } from "../../../lib/supabase";

export async function POST(req: Request) {
  try {
    const { slug } = (await req.json()) as { slug?: string };
    const trimmed = (slug ?? "").trim();
    if (!trimmed) {
      return Response.json({ error: "slug is required" }, { status: 400 });
    }

    const rows = await pgPost<{ slug: string }[]>("tracked_slugs", {
      slug: trimmed,
      active: true,
    });

    return Response.json({ ok: true, slug: rows[0]?.slug ?? trimmed });
  } catch (err: any) {
    return Response.json(
      { error: err?.message ?? "failed to register slug" },
      { status: 500 }
    );
  }
}
