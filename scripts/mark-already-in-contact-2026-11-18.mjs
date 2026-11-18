// One-off: move the three leads the send guard refused on Nov 18, 2026 to
// "blocked" (shown as "Already in contact") and log why. Sends no email and
// touches no other lead.
//
//   node scripts/mark-already-in-contact-2026-11-18.mjs
import fs from "node:fs";
import { createClient } from "@supabase/supabase-js";

const env = Object.fromEntries(
  fs
    .readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    }),
);
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const LEAD_IDS = [
  "5b4b2c52-719d-4280-adb5-acacb36ceecf", // ABA Washington Summit
  "52a7caa0-a3ef-4109-8e81-4789258ea860", // POSSIBLE 2027
  "dc2045e3-c391-446d-a0d8-5ba1a1e9703d", // CMA Shipping
];
const NOTE = "Already in a conversation (flagged by send guard Nov 18, 2026)";

for (const id of LEAD_IDS) {
  const { data: lead, error } = await db
    .from("leads")
    .select("id, name, status")
    .eq("id", id)
    .single();
  if (error || !lead) {
    console.log(`${id}: not found (${error?.message ?? "no row"})`);
    continue;
  }
  if (lead.status === "blocked") {
    console.log(`${lead.name}: already blocked, left as is`);
    continue;
  }
  const { data: moved, error: upErr } = await db
    .from("leads")
    .update({ status: "blocked" })
    .eq("id", id)
    .eq("status", lead.status)
    .select("id");
  if (upErr || !moved?.length) {
    console.log(`${lead.name}: update failed (${upErr?.message ?? "status changed underneath"})`);
    continue;
  }
  await db.from("interactions").insert({ lead_id: id, kind: "status_change", detail: NOTE });
}

const { data: after } = await db.from("leads").select("id, name, status").in("id", LEAD_IDS);
for (const l of after ?? []) console.log(`${l.status.padEnd(10)} ${l.name}  (${l.id})`);
