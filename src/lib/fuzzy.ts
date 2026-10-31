const BOUNDARY = /[\s/:._\-()]/;

function wordScore(word: string, text: string): number | null {
  const direct = text.indexOf(word);
  if (direct !== -1) {
    const atBoundary = direct === 0 || BOUNDARY.test(text[direct - 1]);
    return 1000 + (atBoundary ? 200 : 0) - direct;
  }
  let from = 0;
  let last = -2;
  let score = 0;
  for (const char of word) {
    const found = text.indexOf(char, from);
    if (found === -1) return null;
    score += found === last + 1 ? 5 : 1;
    if (found === 0 || BOUNDARY.test(text[found - 1])) score += 8;
    last = found;
    from = found + 1;
  }
  return score;
}

/**
 * How well `query` matches `text`, or null when it does not. Every word of the
 * query must appear, as a substring (best) or as letters in order.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;
  const haystack = text.toLowerCase();
  let total = 0;
  for (const word of words) {
    const score = wordScore(word, haystack);
    if (score === null) return null;
    total += score;
  }
  return total;
}
