import { createPublicClient } from "@/lib/supabase/public";
import { SiteEditor } from "@/components/SiteEditor";
import type { SiteImageRow } from "@/lib/site/types";

export const dynamic = "force-dynamic";

export default async function SiteEditorPage() {
  const supabase = createPublicClient();
  const { data } = await supabase
    .from("site_images")
    .select("image_key, storage_path, alt_text, subject")
    .order("image_key");
  const images = (data as SiteImageRow[]) ?? [];

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div>
        <h1 className="text-xl font-semibold text-zinc-900">Site editor</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Describe a change to jeffflake.com in plain language. You will see a
          preview before anything goes live.
        </p>
      </div>
      <SiteEditor images={images} />
    </div>
  );
}
