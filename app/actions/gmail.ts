"use server";

import { revalidatePath } from "next/cache";
import { clearGmailConnection } from "@/lib/gmail/connection";

export async function disconnectGmail(): Promise<void> {
  await clearGmailConnection();
  revalidatePath("/admin/settings/tailoring");
  revalidatePath("/admin/admin");
}
