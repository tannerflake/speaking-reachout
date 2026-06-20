/**
 * Robustly extract a JSON value from model text that may include code fences
 * or surrounding prose. Throws if no parseable JSON object/array is found.
 */
export function extractJson<T>(text: string): T {
  const cleaned = text.trim();

  // 1. Strip a fenced ```json ... ``` block if present.
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1].trim() : cleaned;

  // 2. Try a direct parse first.
  try {
    return JSON.parse(candidate) as T;
  } catch {
    // fall through to bracket scanning
  }

  // 3. Scan for the first balanced { } or [ ] region.
  const extracted = sliceBalanced(candidate);
  if (extracted) {
    try {
      return JSON.parse(extracted) as T;
    } catch {
      // fall through
    }
  }

  throw new Error("Could not parse JSON from model output.");
}

function sliceBalanced(text: string): string | null {
  const startObj = text.indexOf("{");
  const startArr = text.indexOf("[");
  let start = -1;
  let open = "{";
  let close = "}";

  if (startArr !== -1 && (startObj === -1 || startArr < startObj)) {
    start = startArr;
    open = "[";
    close = "]";
  } else if (startObj !== -1) {
    start = startObj;
  }
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}
