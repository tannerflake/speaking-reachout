const HONORIFICS = new Set([
  "dr", "prof", "professor", "mr", "mrs", "ms", "miss", "rev", "fr", "sr",
  "jr", "ii", "iii", "iv", "phd", "md", "jd", "esq", "the", "hon",
]);

/** "Dr. Paul S. Edwards, PhD" -> "paul edwards" (first + last, lowercased). */
export function personKey(name: string): string {
  // Credentials come after a comma ("Gina Shipley, MPA"): drop them.
  const parts = name
    .split(",")[0]
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z\s'-]/g, " ")
    .split(/\s+/)
    .filter((p) => p && !HONORIFICS.has(p) && p.length > 1);
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1]}`;
}
