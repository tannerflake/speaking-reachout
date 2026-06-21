import { LoginForm } from "@/components/LoginForm";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;

  return (
    <main className="grid min-h-screen place-items-center p-6">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <h1 className="text-lg font-semibold text-zinc-900">
            Speaker Outreach CRM
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            Sign in to manage outreach for Jeff Flake.
          </p>
        </div>
        <div className="rounded-lg border border-zinc-200 bg-white p-6 shadow-sm">
          <LoginForm next={next ?? "/admin"} />
        </div>
      </div>
    </main>
  );
}
