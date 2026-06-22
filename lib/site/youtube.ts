/** Extract a YouTube video id from common URL shapes (or a bare id). */
export function youTubeId(input: string): string | null {
  const url = input.trim();
  if (!url) return null;
  if (/^[\w-]{11}$/.test(url)) return url;
  const patterns = [
    /[?&]v=([\w-]{11})/,
    /youtu\.be\/([\w-]{11})/,
    /youtube\.com\/embed\/([\w-]{11})/,
    /youtube\.com\/shorts\/([\w-]{11})/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}
