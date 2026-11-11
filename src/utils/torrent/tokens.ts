/** Show-identifying words of a title, shared by the tier matcher and the AniList prequel lookup. */

/** Never show-identifying: articles, particles, honorifics, arc markers. */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'her', 'his', 'are', 'was', 'were', 'has', 'have', 'had',
  'who', 'what', 'when', 'where', 'why', 'how', 'all', 'any', 'one', 'two', 'season', 'episode', 'part', 'arc',
  'movie', 'film', 'ova', 'ona', 'special', 'cour',
  'hen', 'tan', 'boku', 'ore', 'kimi', 'sama', 'san', 'kun', 'chan', 'suru', 'naru', 'nani', 'desu', 'dake', 'made',
  'demo', 'inai', 'koi', 'ken', 'shi', 'dan', 'wa', 'ga', 'wo', 'ni', 'de',
]);

/** Lower-case words of 3+ letters/digits, minus stopwords and ordinals ("2nd"). */
export function significantTokens(title: string): string[] {
  return String(title || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 3 && !STOPWORDS.has(t) && !/^\d+(?:st|nd|rd|th)$/.test(t));
}
