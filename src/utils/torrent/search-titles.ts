import { significantTokens } from './tokens.js';

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
  // "Magical★Explorer" -> "Magical Explorer": release names drop decorative symbols, and nyaa matches words.
  const plain = (t: string) => t.replace(/[★☆♪♫♥♡◆◇●○■□△▽・×〜~!！?？]/g, ' ');
  for (const raw of titles.slice(0, 8)) {
    const t = stripTrailingYear(raw);
    const head = t.split(/[:：]/)[0];
    for (const v of [t, head]) {
      if (plain(v) !== v) add(plain(v));
      add(v);
    }
  }
  const latin = (t: string) => /^[\p{Script=Latin}\p{N}\p{P}\p{S}\s]+$/u.test(t);
  // A title that boils down to one generic word ("Monster #8" -> "monster", "Ore dake Level Up na Ken" -> "level")
  // drags in every show containing it; it goes last, and is still used when it is all there is.
  const ordered = [...out.filter(latin), ...out.filter(t => !latin(t))];
  return [...ordered.filter(t => !isDegenerate(t)), ...ordered.filter(isDegenerate)].slice(0, 3);
}

const GENERIC_QUERY_WORDS = new Set([
  'monster', 'level', 'hero', 'world', 'girl', 'boy', 'demon', 'devil', 'dragon', 'angel', 'king', 'queen', 'story',
  'magic', 'school', 'love', 'life', 'club', 'sword', 'blood', 'dark', 'light', 'night', 'master', 'star', 'moon',
  'witch', 'ghost', 'dead', 'zombie', 'idol', 'another',
]);

function isDegenerate(title: string): boolean {
  const toks = significantTokens(title);
  return toks.length <= 1 && ((toks[0] ?? '').length < 4 || GENERIC_QUERY_WORDS.has(toks[0] ?? ''));
}

/** "False Memory (2026)" -> "False Memory": nyaa requires every word, so the year hid every upload without it. */
export function stripTrailingYear(title: string): string {
  return title.replace(/\s*[(\[]\s*(?:19|20)\d{2}\s*[)\]]\s*$/, '').trim() || title;
}

// Shows whose releases use a name AniList does not list among its titles.
const TITLE_ALIASES: Record<number, string[]> = {
  21: ['One Piece'],
  235: ['Detective Conan', 'Meitantei Conan'],
  108632: ['Re Zero kara Hajimeru', 'ReZero Starting Life'],
  116674: ['Bleach Sennen Kessen-hen', 'Bleach Thousand-Year Blood War'],
  159322: ['Bleach Sennen Kessen-hen', 'Bleach Thousand-Year Blood War'],
  169755: ['Bleach Sennen Kessen-hen', 'Bleach Thousand-Year Blood War'],
  185874: ['Bleach Sennen Kessen-hen', 'Bleach Thousand-Year Blood War'],
};

/** Extra search names for an AniList id, tried only after the regular titles found nothing exact. */
export function aliasTitles(anilistId: number | undefined): string[] {
  return anilistId ? [...(TITLE_ALIASES[anilistId] ?? [])] : [];
}

/** Run a single-title search with each of [`searchTitles`] until one returns something. */
export async function firstWithResults<T>(titles: string[], run: (title: string) => Promise<T[]>): Promise<T[]> {
  for (const t of searchTitles(titles)) {
    const r = await run(t);
    if (r.length > 0) return r;
  }
  return [];
}

// ── Seasons ───────────────────────────────────────────────────────────────────
// AniList lists each season as its own title ("... Part 2", "... Season 2", "... 2nd Season", "第二幕"), while
// release names say "S02E03", "S2 - 03", "Season 2 - 03" or nothing at all. Searching with the bare title and
// filtering on the release's season keeps season 1 episode 3 out of a season 2 episode 3 request.

const KANJI_DIGITS: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const ROMAN: Record<string, number> = { II: 2, III: 3, IV: 4, V: 5, VI: 6 };

const TITLE_SEASON: Array<[RegExp, (m: RegExpMatchArray) => number]> = [
  [/\b(?:season|part|cour)\s*(\d{1,2})\b/i, m => parseInt(m[1], 10)],
  [/\b(\d{1,2})(?:st|nd|rd|th)\s+(?:season|cour|part)\b/i, m => parseInt(m[1], 10)],
  [/第\s*([0-9]{1,2}|[一二三四五六七八九十])\s*[期幕部]/, m => KANJI_DIGITS[m[1]] ?? parseInt(m[1], 10)],
  [/\s(II|III|IV|V|VI)$/, m => ROMAN[m[1]]],
];

/** Season the titles name (2 for "... Part 2"), or `null` when none does (season 1 or a single-season show). */
export function seasonOf(titles: string[]): number | null {
  for (const t of titles) {
    for (const [re, value] of TITLE_SEASON) {
      const m = t.trim().match(re);
      if (m) {
        const n = value(m);
        if (Number.isFinite(n) && n >= 1) return n;
      }
    }
  }
  return null;
}

/** The title without its season marker, for searching ("Foo Part 2" -> "Foo"). */
export function stripSeason(title: string): string {
  return title
    .replace(/\b(?:season|part|cour)\s*\d{1,2}\b/gi, ' ')
    .replace(/\b\d{1,2}(?:st|nd|rd|th)\s+(?:season|cour|part)\b/gi, ' ')
    .replace(/第\s*(?:[0-9]{1,2}|[一二三四五六七八九十])\s*[期幕部]/g, ' ')
    .replace(/\s(?:II|III|IV|V|VI)$/, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Season a release name states ("S02E03", "S2 - 03", "Season 2", "2nd Season"), or `null`. */
export function releaseSeason(name: string): number | null {
  const patterns = [
    /\bS(\d{1,2})\s*E\d{1,4}\b/i,
    /\bS(\d{1,2})\b(?=\s*[-–]\s*\d)/i,
    /\bSeason\s*(\d{1,2})\b/i,
    /\b(\d{1,2})(?:st|nd|rd|th)\s+Season\b/i,
    /\bPart\s*(\d{1,2})\b/i,
  ];
  for (const re of patterns) {
    const m = name.match(re);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

/** A release that explicitly belongs to another season than `wanted` (null = season 1). */
export function seasonMismatch(name: string, wanted: number | null): boolean {
  const s = releaseSeason(name);
  return s !== null && s !== (wanted ?? 1);
}
