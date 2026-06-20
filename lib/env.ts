// Lazy env access. Never read at module top-level for secrets so a missing
// var surfaces as a clear runtime error on the relevant request rather than
// crashing the build.

export function getEnv(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

export function requireEnv(name: string): string {
  const v = getEnv(name);
  if (!v) {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
        `Set it in .env.local (see .env.example).`,
    );
  }
  return v;
}

export function appUrl(): string {
  return (
    getEnv("NEXT_PUBLIC_APP_URL") ??
    (getEnv("VERCEL_URL") ? `https://${getEnv("VERCEL_URL")}` : undefined) ??
    "http://localhost:3000"
  );
}
