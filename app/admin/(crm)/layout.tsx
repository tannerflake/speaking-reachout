import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentUser } from "@/lib/auth/profile";
import { Nav } from "@/components/Nav";
import { SignOutButton } from "@/components/SignOutButton";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Defense in depth — the proxy already gates /admin, but guard here too.
  const me = await getCurrentUser();
  if (!me) redirect("/admin/login");

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-zinc-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-2.5">
          <div className="flex items-center gap-4">
            <Link href="/admin" className="text-sm font-semibold text-zinc-900">
              {me.role === "editor" ? "Site Editor" : "Speaker Outreach CRM"}
            </Link>
            <Nav role={me.role} />
          </div>
          <div className="flex items-center gap-3">
            <Link
              href="/"
              className="hidden text-xs text-zinc-400 hover:text-zinc-600 sm:inline"
            >
              View public site
            </Link>
            <span className="hidden text-xs text-zinc-400 sm:inline">
              {me.email}
            </span>
            <SignOutButton />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}
