/**
 * Titles worth searching torrent indexers with, best first. The host's title order varies: the display title may be a
 * 90-character romaji ("Magical★Explorer: Eroge no Yuujin Chara ni Tensei Shitakedo, …") that matches nothing, so take
 * up to three short ones, adding the part before a colon ("Magical★Explorer") as its own candidate, Latin script first
 * (release names are romanised / English).
 */
export function searchTitles(titles: string[]): string[] {
  const out: string[] = [];
  const add = (raw?: string) => {
    const t = (raw ?? '').replace(/\s+/g, ' ').trim();
    if (t.length < 3 || t.length > 60) return;
    if (!out.some(o => o.toLowerCase() === t.toLowerCase())) out.push(t);
  };
  for (const t of titles.slice(0, 8)) {
    add(t);
    const head = t.split(/[:：]/)[0];
    if (head !== t) add(head);
  }
  const latin = (t: string) => /^[\p{Script=Latin}\p{N}\p{P}\p{S}\s]+$/u.test(t);
  return [...out.filter(latin), ...out.filter(t => !latin(t))].slice(0, 3);
}

/** Run a single-title search with each of [`searchTitles`] until one returns something. */
export async function firstWithResults<T>(titles: string[], run: (title: string) => Promise<T[]>): Promise<T[]> {
  for (const t of searchTitles(titles)) {
    const r = await run(t);
    if (r.length > 0) return r;
  }
  return [];
}
